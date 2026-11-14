import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { Output } from '@ordo/domain';
import type { Logger } from 'pino';
import type { DB } from './db.ts';
import { badRequest, HttpError } from './errors.ts';

/** What Auth reads besides the sessions table: the PIN hashes and the output tokens. The Library fits. */
export type AuthStore = {
  getInternal<T>(key: string): T | undefined;
  putInternal(key: string, value: unknown): void;
  getSetting(key: 'outputs'): Output[];
};

export type SessionRole = 'operate' | 'edit';
export type Principal =
  | { kind: 'session'; role: SessionRole; sessionId: string }
  | { kind: 'token'; role: 'output' | 'stage'; outputId: string; output: Output };

export const SESSION_MS = 3600_000;
export const REMEMBERED_SESSION_MS = 12 * 3600_000;
export const DEVICE_MS = 365 * 86400_000;
export const RATE_WINDOW_MS = 15 * 60_000;
export const RATE_PER_IP = 5;
export const RATE_GLOBAL = 50;

type PinHashes = { operate: string; edit: string };
type SessionRow = {
  id: string;
  role: SessionRole;
  ua_hash: string;
  remembered: number;
  last_seen: number;
  expires_at: number;
};

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function validPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{6,12}$/.test(pin);
}

export class Auth {
  private db: DB;
  private lib: AuthStore;
  private log: Logger;
  /**
   * `shared`: the live process's connection to the library's ordo.db. Session reads work as usual;
   * the sliding writes are best effort (skipped when the library process holds the write lock), so a
   * busy library can never stall or fail a request in the live process.
   */
  private opts: { shared?: boolean };
  constructor(db: DB, lib: AuthStore, log: Logger, opts: { shared?: boolean } = {}) {
    this.db = db;
    this.lib = lib;
    this.log = log;
    this.opts = opts;
  }

  /** Run a session-table write; in shared mode a failure (SQLITE_BUSY) is logged and skipped. */
  private write(fn: () => void): void {
    if (!this.opts.shared) {
      fn();
      return;
    }
    try {
      fn();
    } catch (e) {
      this.log.debug({ err: (e as Error).message }, 'session write skipped');
    }
  }

  pins(): PinHashes | undefined {
    return this.lib.getInternal<PinHashes>('_auth.pins');
  }
  setupRequired(): boolean {
    return !this.pins();
  }

  async setPins(operatePin: string, editPin: string): Promise<void> {
    if (!validPin(operatePin) || !validPin(editPin))
      throw badRequest('PINs must be 6 to 12 digits', 'weak_pin');
    if (operatePin === editPin) throw badRequest('Operate and edit PINs must differ', 'same_pin');
    this.lib.putInternal('_auth.pins', {
      operate: await argonHash(operatePin),
      edit: await argonHash(editPin),
    });
  }

  async changePin(role: SessionRole, pin: string, keepSessionId?: string): Promise<void> {
    const cur = this.pins();
    if (!cur) throw badRequest('Run setup first');
    if (!validPin(pin)) throw badRequest('PINs must be 6 to 12 digits', 'weak_pin');
    const other = role === 'operate' ? cur.edit : cur.operate;
    if (await argonVerify(other, pin)) throw badRequest('Operate and edit PINs must differ', 'same_pin');
    this.lib.putInternal('_auth.pins', { ...cur, [role]: await argonHash(pin) });
    // Changing a PIN ends every other session of that role.
    this.db.prepare(`DELETE FROM sessions WHERE role = ? AND id != ?`).run(role, keepSessionId ?? '');
  }

  /** `operate[:edit]`. Without an edit part the edit PIN is the operate PIN reversed (or +9 if a palindrome). */
  async devSetup(spec: string): Promise<void> {
    if (!this.setupRequired()) return;
    const [op, ed] = spec.split(':');
    let edit = ed ?? [...(op ?? '')].reverse().join('');
    if (edit === op) edit = `${op}9`;
    await this.setPins(op ?? '', edit);
    this.log.warn('PINs set from ORDO_DEV_PIN (development only)');
  }

  // ---- rate limit ----
  /** Throws 429 when the IP or the hub as a whole is locked out. */
  checkRate(ip: string, now = Date.now()): void {
    const since = now - RATE_WINDOW_MS;
    const ipFails = this.db
      .prepare(`SELECT at FROM auth_attempts WHERE ip = ? AND ok = 0 AND at > ? ORDER BY at DESC`)
      .all(ip, since) as { at: number }[];
    if (ipFails.length >= RATE_PER_IP) {
      const until = ipFails[0]!.at + RATE_WINDOW_MS;
      throw lockout(until, now);
    }
    const global = this.db
      .prepare(`SELECT COUNT(*) n, MAX(at) last FROM auth_attempts WHERE ok = 0 AND at > ?`)
      .get(since) as { n: number; last: number | null };
    if (global.n >= RATE_GLOBAL) throw lockout((global.last ?? now) + RATE_WINDOW_MS, now);
  }

  recordAttempt(ip: string, ok: boolean, now = Date.now()): void {
    this.db.prepare(`INSERT INTO auth_attempts (ip, at, ok) VALUES (?, ?, ?)`).run(ip, now, ok ? 1 : 0);
    this.db.prepare(`DELETE FROM auth_attempts WHERE at < ?`).run(now - 7 * 86400_000);
    if (!ok) {
      const n = (
        this.db
          .prepare(`SELECT COUNT(*) n FROM auth_attempts WHERE ip = ? AND ok = 0 AND at > ?`)
          .get(ip, now - RATE_WINDOW_MS) as { n: number }
      ).n;
      if (n >= RATE_PER_IP) this.log.warn({ ip }, 'PIN lockout for IP');
      else this.log.info({ ip, failures: n }, 'wrong PIN');
    }
  }

  /** Verify a PIN against both hashes. */
  async matchPin(pin: string): Promise<SessionRole | null> {
    const p = this.pins();
    if (!p || typeof pin !== 'string' || pin.length > 64) return null;
    if (await argonVerify(p.operate, pin)) return 'operate';
    if (await argonVerify(p.edit, pin)) return 'edit';
    return null;
  }

  // ---- sessions ----
  createSession(role: SessionRole, ua: string, remembered: boolean, now = Date.now()): string {
    const token = randomBytes(32).toString('base64url');
    const ttl = remembered ? REMEMBERED_SESSION_MS : SESSION_MS;
    this.db
      .prepare(
        `INSERT INTO sessions (id, role, ua_hash, remembered, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256(token), role, sha256(ua), remembered ? 1 : 0, now, now, now + ttl);
    this.db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
    return token;
  }

  /** Resolve a session cookie; slides the expiry forward on activity. */
  session(token: string | undefined, now = Date.now()): { id: string; role: SessionRole } | null {
    if (!token) return null;
    const id = sha256(token);
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    if (!row) return null;
    if (row.expires_at < now) {
      this.write(() => this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id));
      return null;
    }
    if (now - row.last_seen > 30_000) {
      const ttl = row.remembered ? REMEMBERED_SESSION_MS : SESSION_MS;
      this.write(() =>
        this.db
          .prepare(`UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?`)
          .run(now, now + ttl, id),
      );
    }
    return { id, role: row.role };
  }

  /**
   * Slide a session on WebSocket activity (item 24: an operator who only uses the keyboard never makes
   * an HTTP call). Takes the session id (the cookie's hash, as in the principal). Returns false when
   * the session no longer exists or has expired, so the socket can be closed.
   */
  touchSession(id: string, now = Date.now()): boolean {
    let row: SessionRow | undefined;
    try {
      row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
    } catch (e) {
      // Shared mode with ordo.db unreadable for a moment: keep the socket rather than guess.
      if (this.opts.shared) return true;
      throw e;
    }
    if (!row) return false;
    if (row.expires_at < now) {
      this.write(() => this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id));
      return false;
    }
    const ttl = row.remembered ? REMEMBERED_SESSION_MS : SESSION_MS;
    this.write(() =>
      this.db
        .prepare(`UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?`)
        .run(now, now + ttl, id),
    );
    return true;
  }

  endSession(token: string | undefined): void {
    if (token) this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sha256(token));
  }

  // ---- remembered devices ----
  createDevice(ua: string, now = Date.now()): string {
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare(`INSERT INTO devices (id, ua_hash, created_at, last_seen) VALUES (?, ?, ?, ?)`)
      .run(sha256(token), sha256(ua), now, now);
    return token;
  }
  /** A device cookie is valid only with the same user agent and within a year of last use. */
  deviceValid(token: string | undefined, ua: string, now = Date.now()): boolean {
    if (!token) return false;
    const row = this.db.prepare(`SELECT * FROM devices WHERE id = ?`).get(sha256(token)) as
      | { ua_hash: string; last_seen: number }
      | undefined;
    if (!row || row.ua_hash !== sha256(ua) || now - row.last_seen > DEVICE_MS) return false;
    this.db.prepare(`UPDATE devices SET last_seen = ? WHERE id = ?`).run(now, sha256(token));
    return true;
  }

  // ---- output tokens ----
  outputForToken(token: string | undefined): Output | undefined {
    if (!token || token.length > 200) return undefined;
    const want = createHash('sha256').update(token).digest();
    for (const o of this.lib.getSetting('outputs')) {
      if (!o.token) continue;
      const have = createHash('sha256').update(o.token).digest();
      if (timingSafeEqual(want, have)) return o;
    }
    return undefined;
  }

  principal(opts: { cookie?: string; token?: string }): Principal | null {
    if (opts.token) {
      const o = this.outputForToken(opts.token);
      if (o)
        return { kind: 'token', role: o.kind === 'stage' ? 'stage' : 'output', outputId: o.id, output: o };
    }
    let s: { id: string; role: SessionRole } | null = null;
    try {
      s = this.session(opts.cookie);
    } catch (e) {
      if (!this.opts.shared) throw e;
      this.log.warn({ err: (e as Error).message }, 'sessions unreadable');
    }
    if (s) return { kind: 'session', role: s.role, sessionId: s.id };
    return null;
  }
}

function lockout(until: number, now: number): HttpError {
  const min = Math.max(1, Math.ceil((until - now) / 60_000));
  return new HttpError(
    429,
    'locked_out',
    `Too many wrong PINs. Try again in ${min} minute${min === 1 ? '' : 's'}.`,
    { retryAfterS: Math.ceil((until - now) / 1000) },
  );
}

/** Access levels a route can declare. */
export type Access = 'public' | 'edit' | 'operate' | 'token' | 'live' | 'any';

/** Does a principal satisfy an access level? `operate` includes `edit`. */
export function allowed(access: Access, p: Principal | null): boolean {
  if (access === 'public') return true;
  if (!p) return false;
  switch (access) {
    case 'edit':
      return p.kind === 'session';
    case 'operate':
      return p.kind === 'session' && p.role === 'operate';
    case 'token':
      return p.kind === 'token';
    case 'live':
      return p.kind === 'token' || p.role === 'operate';
    case 'any':
      return true;
  }
}
