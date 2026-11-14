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
import { EDIT_PIN, OPERATE_PIN, startHub, type TestHub, tempDir } from './helpers.ts';

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
