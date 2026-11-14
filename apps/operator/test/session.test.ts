/**
 * The session's cap as the client reads it (design/28 §3.2; state/session.ts), defensively until the protocol
 * carries the fields, and the one sign-out of a phone's pre-upgrade uncapped session (owner question 12): on a
 * phone, from a hub that grants caps, once only; never on a tablet, the venue PC or a capped session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let phone = true;
vi.mock('../src/lib/layout.ts', () => ({ thisIsPhone: () => phone }));
const calls: string[] = [];
let me: Record<string, unknown> = {};
vi.mock('@ordo/client', async (orig) => ({
  ...(await orig<typeof import('@ordo/client')>()),
  api: vi.fn(async (path: string) => {
    calls.push(path);
    return path === '/auth/me' ? me : {};
  }),
}));

const { capOf, hubGrants, phoneMustSignInAgain, refreshSession, RESIGN_KEY, useSession } = await import(
  '../src/state/session.ts'
);
type Me = Parameters<typeof capOf>[0];
const asMe = (x: Record<string, unknown>) => x as unknown as Me;
const CAPS = ['full', 'light', 'view'];

describe('capOf and hubGrants', () => {
  it('reads cap: absent is full, an unknown value is view', () => {
    expect(capOf(undefined)).toBe('full');
    expect(capOf(asMe({ role: 'edit' }))).toBe('full');
    expect(capOf(asMe({ role: 'edit', cap: 'light' }))).toBe('light');
    expect(capOf(asMe({ role: 'edit', cap: 'view' }))).toBe('view');
    expect(capOf(asMe({ role: 'edit', cap: 'full' }))).toBe('full');
    expect(capOf(asMe({ role: 'edit', cap: 'admin' }))).toBe('view');
    expect(capOf(asMe({ role: 'edit', cap: 42 }))).toBe('view');
  });

  it('reads caps: a list that names the cap; anything else grants none', () => {
    expect(hubGrants(asMe({ caps: CAPS }), 'light')).toBe(true);
    expect(hubGrants(asMe({ caps: ['full'] }), 'light')).toBe(false);
    expect(hubGrants(asMe({}), 'light')).toBe(false);
    expect(hubGrants(asMe({ caps: 'light' }), 'light')).toBe(false);
    expect(hubGrants(asMe({ caps: Array.from({ length: 100 }, () => 'light') }), 'light')).toBe(false);
    expect(hubGrants(undefined, 'light')).toBe(false);
  });
});

describe('phoneMustSignInAgain', () => {
  const uncapped = asMe({ role: 'operate', caps: CAPS });
  it('a phone with an uncapped session from a hub that grants caps', () => {
    expect(phoneMustSignInAgain(uncapped, true, null)).toBe(true);
    expect(phoneMustSignInAgain(asMe({ role: 'edit', caps: CAPS }), true, null)).toBe(true);
  });
  it('never twice, never a tablet or the venue PC, never a capped session, an older hub or no session', () => {
    expect(phoneMustSignInAgain(uncapped, true, 'signed-out')).toBe(false);
    expect(phoneMustSignInAgain(uncapped, true, 'done')).toBe(false);
    expect(phoneMustSignInAgain(uncapped, false, null)).toBe(false);
    expect(phoneMustSignInAgain(asMe({ role: 'edit', cap: 'light', caps: CAPS }), true, null)).toBe(false);
    expect(phoneMustSignInAgain(asMe({ role: 'operate' }), true, null)).toBe(false);
    expect(phoneMustSignInAgain(asMe({ role: null, caps: CAPS }), true, null)).toBe(false);
    expect(phoneMustSignInAgain(undefined, true, null)).toBe(false);
  });
});

describe('refreshSession signs a pre-upgrade phone out once', () => {
  const session = new Map<string, string>();
  const reload = vi.fn();
  beforeEach(() => {
    session.clear();
    calls.length = 0;
    reload.mockClear();
    const g = globalThis as Record<string, unknown>;
    g.sessionStorage = {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
    };
    g.localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    g.location = { hash: '', reload };
  });
  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    delete g.sessionStorage;
    delete g.localStorage;
    delete g.location;
  });

  it('signs out (POST /auth/logout, reload) the first time, then keeps the session as it is', async () => {
    phone = true;
    me = { role: 'operate', setupRequired: false, version: '0.6.0', domain: 'x', caps: CAPS };
    await refreshSession();
    expect(calls).toEqual(['/auth/me', '/auth/logout']);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(session.get(RESIGN_KEY)).toBe('signed-out');
    calls.length = 0;
    await refreshSession();
    expect(calls).toEqual(['/auth/me']);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(useSession.getState().me?.role).toBe('operate');
  });

  it('never on a tablet, never with a capped session, never where sessionStorage is blocked', async () => {
    me = { role: 'operate', setupRequired: false, version: '0.6.0', domain: 'x', caps: CAPS };
    phone = false;
    await refreshSession();
    phone = true;
    me = { ...me, role: 'edit', cap: 'light' };
    await refreshSession();
    me = { role: 'operate', setupRequired: false, version: '0.6.0', domain: 'x', caps: CAPS };
    (globalThis as Record<string, unknown>).sessionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    await refreshSession();
    expect(calls).toEqual(['/auth/me', '/auth/me', '/auth/me']);
    expect(reload).not.toHaveBeenCalled();
  });
});
