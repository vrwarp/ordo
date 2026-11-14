/**
 * Capped sessions (design/28 §3.2): a phone's session is role 'edit' with cap 'light' whatever PIN matched,
 * one hour sliding, never remembered, kept in `capped_sessions` (a side table, so a downgraded hub never
 * finds it), and ended by a change of the PIN it signed in with.
 */
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { Auth, capAtLeast, readCap, SESSION_MS, sha256 } from '../src/auth.ts';
import { MIGRATIONS, migrate, openDb } from '../src/db.ts';
import { client, EDIT_PIN, login, OPERATE_PIN, startHub, type TestHub, tempDir } from './helpers.ts';
import { refusal } from './phones-helpers.ts';

const pinPost = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/auth/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

describe('capped sessions: storage', () => {
  let hub: TestHub | undefined;
  afterEach(async () => {
    await hub?.cleanup();
    hub = undefined;
  });

  it('a capped principal is role edit with its cap; a sessions row is full', async () => {
    hub = await startHub();
    const t = hub.auth.createSession('edit', 'phone', false, Date.now(), { cap: 'light', pin: 'operate' });
    const p = hub.auth.principal({ cookie: t });
    expect(p).toMatchObject({ kind: 'session', role: 'edit', cap: 'light', sessionId: sha256(t) });
    const full = hub.auth.createSession('operate', 'pc', true);
    expect(hub.auth.principal({ cookie: full })).toMatchObject({ role: 'operate', cap: 'full' });
    // The token's hash is in the side table only.
    expect(hub.db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sha256(t))).toBeUndefined();
    expect(hub.db.prepare(`SELECT role, cap, pin FROM capped_sessions WHERE id = ?`).get(sha256(t))).toEqual({
      role: 'edit',
      cap: 'light',
      pin: 'operate',
    });
  });

  it('slides for an hour, ends on sign-out, and an unknown stored cap reads as view', async () => {
    hub = await startHub();
    const now = Date.now();
    const t = hub.auth.createSession('edit', 'phone', false, now, { cap: 'light', pin: 'edit' });
    const id = sha256(t);
    expect(hub.auth.session(t, now + SESSION_MS - 1000)).toMatchObject({ cap: 'light' });
    // Slid at that read: alive past the first hour.
    expect(hub.auth.session(t, now + SESSION_MS + 60_000)).toMatchObject({ cap: 'light' });
    expect(hub.auth.touchSession(id, now + 2 * SESSION_MS)).toBe(true);
    expect(hub.auth.session(t, now + 2 * SESSION_MS + 30_000)).toBeTruthy();
    // Unused for more than an hour: gone.
    expect(hub.auth.session(t, now + 4 * SESSION_MS)).toBeNull();
    expect(hub.db.prepare(`SELECT 1 FROM capped_sessions WHERE id = ?`).get(id)).toBeUndefined();
    const t2 = hub.auth.createSession('edit', 'phone', false, now, { cap: 'light', pin: 'edit' });
    hub.auth.endSession(t2);
    expect(hub.auth.session(t2)).toBeNull();
    const t3 = hub.auth.createSession('edit', 'phone', false, Date.now(), { cap: 'light', pin: 'edit' });
    hub.db.prepare(`UPDATE capped_sessions SET cap = 'admin' WHERE id = ?`).run(sha256(t3));
    expect(hub.auth.session(t3)).toMatchObject({ cap: 'view' });
    expect(readCap('light')).toBe('light');
    expect(readCap('full')).toBe('view');
    expect(readCap(undefined)).toBe('view');
  });

  it('prunes expired capped rows on the next capped sign-in', async () => {
    hub = await startHub();
    const old = Date.now() - 3 * SESSION_MS;
    hub.auth.createSession('edit', 'phone', false, old, { cap: 'light', pin: 'edit' });
    hub.auth.createSession('edit', 'phone', false, old, { cap: 'light', pin: 'operate' });
    expect(hub.db.prepare(`SELECT COUNT(*) n FROM capped_sessions`).get()).toEqual({ n: 2 });
    hub.auth.createSession('edit', 'phone', false, Date.now(), { cap: 'light', pin: 'edit' });
    expect(hub.db.prepare(`SELECT COUNT(*) n FROM capped_sessions`).get()).toEqual({ n: 1 });
  });

  it('a PIN change ends the phones that signed in with that PIN, and only those', async () => {
    hub = await startHub();
    const viaOperate = hub.auth.createSession('edit', 'p1', false, Date.now(), {
      cap: 'light',
      pin: 'operate',
    });
    const viaEdit = hub.auth.createSession('edit', 'p2', false, Date.now(), { cap: 'light', pin: 'edit' });
    const pc = hub.auth.createSession('operate', 'pc', true);
    await hub.auth.changePin('operate', '333333', hub.auth.session(pc)!.id);
    expect(hub.auth.session(viaOperate)).toBeNull();
    expect(hub.auth.session(viaEdit)).toMatchObject({ cap: 'light' });
    expect(hub.auth.session(pc)).toMatchObject({ role: 'operate' });
    await hub.auth.changePin('edit', '444444');
    expect(hub.auth.session(viaEdit)).toBeNull();
    expect(await hub.auth.matchPin('333333')).toBe('operate');
    expect(await hub.auth.matchPin(OPERATE_PIN)).toBeNull();
    expect(await hub.auth.matchPin(EDIT_PIN)).toBeNull();
  });

  it('caps order view < light < full', () => {
    expect(capAtLeast('full', 'light')).toBe(true);
    expect(capAtLeast('light', 'light')).toBe(true);
    expect(capAtLeast('light', 'full')).toBe(false);
    expect(capAtLeast('view', 'light')).toBe(false);
    expect(capAtLeast('view', 'view')).toBe(true);
  });
});

describe('capped sessions: the database', () => {
  it('migrating twice is a no-op, and an older hub (migrations to 10) opens this database and starts', () => {
    const file = join(tempDir(), 'ordo.db');
    const db = openDb(file);
    const v = db.pragma('user_version', { simple: true }) as number;
    expect(v).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
    expect(migrate(db)).toBe(v);
    db.prepare(
      `INSERT INTO capped_sessions (id, role, cap, pin, ua_hash, created_at, last_seen, expires_at) VALUES ('x', 'edit', 'light', 'edit', 'u', 0, 0, ?)`,
    ).run(Date.now() + SESSION_MS);
    db.close();
    // The previous release's list stops at 10: it skips everything above its own and starts.
    const older = new Database(file);
    expect(
      migrate(
        older,
        MIGRATIONS.filter((m) => m.version <= 10),
      ),
    ).toBe(v);
    // Its session lookup reads `sessions` only: a capped cookie is unknown there (401, fail closed).
    expect(older.prepare(`SELECT * FROM sessions WHERE id = 'x'`).get()).toBeUndefined();
    older.close();
  });

  it('the live process on a database not yet migrated to 11 reads a capped cookie as no session (401)', () => {
    const file = join(tempDir(), 'ordo.db');
    const db = new Database(file);
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version <= 10),
    );
    const store = { getInternal: () => undefined, putInternal: () => undefined, getSetting: () => [] };
    const auth = new Auth(db, store, pino({ level: 'silent' }), { shared: true });
    const full = auth.createSession('operate', 'pc', false);
    expect(auth.principal({ cookie: full })).toMatchObject({ role: 'operate', cap: 'full' });
    expect(auth.principal({ cookie: 'a-phone-cookie' })).toBeNull();
    expect(auth.touchSession('no-such-id')).toBe(true);
    db.close();
  });
});

describe('sign-in with a cap (POST /auth/pin { pin, cap })', () => {
  let hub: TestHub | undefined;
  afterEach(async () => {
    await hub?.cleanup();
    hub = undefined;
  });

  it("the operate PIN with cap 'light' is an edit session, one hour, never remembered", async () => {
    hub = await startHub();
    // Before P0 the key was refused: 400 invalid "Unrecognized key: cap".
    const res = await pinPost(hub.url, { pin: OPERATE_PIN, cap: 'light', remember: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: 'edit', cap: 'light' });
    const session = cookieOf(res, 'ordo_session')!;
    expect(session).toMatch(/Max-Age=3600/);
    expect(session).toMatch(/Path=\//);
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).not.toMatch(/Domain=/i);
    expect(session).not.toMatch(/Secure/);
    // remember is ignored: the device cookie is cleared, never set.
    const device = cookieOf(res, 'ordo_device')!;
    expect(device).toMatch(/^ordo_device=;/);
    expect(device).toMatch(/Max-Age=0/);
    expect(device).toMatch(/Path=\//);
    expect(hub.db.prepare(`SELECT COUNT(*) n FROM devices`).get()).toEqual({ n: 0 });
    const token = session.split(';')[0]!.slice('ordo_session='.length);
    expect(
      hub.db.prepare(`SELECT role, cap, pin FROM capped_sessions WHERE id = ?`).get(sha256(token)),
    ).toEqual({ role: 'edit', cap: 'light', pin: 'operate' });
    const me = await client(hub.url, `ordo_session=${token}`).json('/auth/me');
    expect(me).toMatchObject({ role: 'edit', cap: 'light', caps: ['full', 'light', 'view'] });
  });

  it('clears an existing device cookie and forgets its row; Secure behind https', async () => {
    hub = await startHub({ trustedProxies: ['127.0.0.1/32'] });
    const remembered = await pinPost(hub.url, { pin: EDIT_PIN, remember: true });
    const device = cookieOf(remembered, 'ordo_device')!.split(';')[0]!;
    expect(hub.db.prepare(`SELECT COUNT(*) n FROM devices`).get()).toEqual({ n: 1 });
    const res = await pinPost(
      hub.url,
      { pin: EDIT_PIN, cap: 'light' },
      { cookie: device, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' },
    );
    expect(res.status).toBe(200);
    expect(cookieOf(res, 'ordo_device')).toMatch(/Max-Age=0/);
    expect(cookieOf(res, 'ordo_session')).toMatch(/Secure/);
    expect(cookieOf(res, 'ordo_session')).toMatch(/Max-Age=3600/);
    expect(hub.db.prepare(`SELECT COUNT(*) n FROM devices`).get()).toEqual({ n: 0 });
  });

  it("no cap or cap 'full' signs in as before; a bad cap and a cap at setup are refused", async () => {
    hub = await startHub();
    const full = await pinPost(hub.url, { pin: OPERATE_PIN, cap: 'full', remember: true });
    expect(await full.json()).toEqual({ role: 'operate' });
    expect(cookieOf(full, 'ordo_session')).toMatch(/Max-Age=43200/);
    expect(cookieOf(full, 'ordo_device')).toMatch(/^ordo_device=[^;]+;/);
    const none = await pinPost(hub.url, { pin: EDIT_PIN });
    expect(await none.json()).toEqual({ role: 'edit' });
    expect(none.headers.getSetCookie().some((c) => c.startsWith('ordo_device='))).toBe(false);
    const bogus = await pinPost(hub.url, { pin: EDIT_PIN, cap: 'bogus' });
    expect(bogus.status).toBe(400);
    expect((await refusal(bogus)).code).toBe('invalid');
    expect(hub.db.prepare(`SELECT COUNT(*) n FROM capped_sessions`).get()).toEqual({ n: 0 });
  });

  it('GET /auth/me lists the caps signed out and signed in; full sessions carry no cap', async () => {
    hub = await startHub();
    const out = await client(hub.url).json('/auth/me');
    expect(out).toMatchObject({ role: null, caps: ['full', 'light', 'view'] });
    expect(out).not.toHaveProperty('cap');
    const op = await login(hub.url, OPERATE_PIN);
    const me = await op.json('/auth/me');
    expect(me).toMatchObject({ role: 'operate', caps: ['full', 'light', 'view'] });
    expect(me).not.toHaveProperty('cap');
  });

  it('a cap at /auth/setup is refused (the compact layout never calls it)', async () => {
    hub = await startHub({ devPin: undefined });
    const res = await fetch(`${hub.url}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatePin: '135790', editPin: '246802', cap: 'light' }),
    });
    expect(res.status).toBe(400);
    expect(hub.auth.setupRequired()).toBe(true);
  });
});
