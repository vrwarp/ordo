import { api, ApiFailure } from '@ordo/client';
import { type AuthMeRes, ROUTES } from '@ordo/protocol';
import { create } from 'zustand';
import { thisIsPhone } from '../lib/layout.ts';

const LAST_ROLE = 'ordo.op.lastRole';

/**
 * A session's cap (design/28 §3.2): 'full' (as today: the venue PC, an iPad), 'light' (a phone) or 'view'.
 * The hub lane adds `cap` and `caps` to GET /auth/me; until the integrator switches to the protocol's types
 * they are read here defensively: no cap is 'full' (an older hub, or an uncapped session), an unknown one is
 * 'view' (the narrowest).
 */
export type SessionCap = 'full' | 'light' | 'view';

export function capOf(me: AuthMeRes | undefined | null): SessionCap {
  const cap = (me as { cap?: unknown } | undefined | null)?.cap;
  if (cap === undefined || cap === null) return 'full';
  return cap === 'full' || cap === 'light' || cap === 'view' ? cap : 'view';
}

/** The hub grants this cap on sign-in (`caps` lists it; absent or malformed: an older hub that grants none). */
export function hubGrants(me: AuthMeRes | undefined | null, cap: SessionCap): boolean {
  const caps = (me as { caps?: unknown } | undefined | null)?.caps;
  if (!Array.isArray(caps) || caps.length > 16) return false;
  return caps.includes(cap);
}

/**
 * Pre-upgrade phones (design/28 owner question 12): a phone that signed in before caps holds an uncapped session
 * (12 h, often with a remembered device) that its polls keep alive. Signed in, on a phone, with a hub that grants
 * `light` and an uncapped session: sign out once, so the next sign-in asks for the cap. `flag` is the
 * sessionStorage mark of RESIGN_KEY: once set, never again in this tab (no loop if the sign-out did not take).
 */
export function phoneMustSignInAgain(
  me: AuthMeRes | undefined | null,
  phone: boolean,
  flag: string | null,
): boolean {
  if (!phone || flag !== null || !me) return false;
  if (me.role !== 'operate' && me.role !== 'edit') return false;
  return hubGrants(me, 'light') && capOf(me) === 'full';
}

/** sessionStorage: 'signed-out' after the one sign-out (the sign-in says why), 'done' once signed in again. */
export const RESIGN_KEY = 'ordo.op.phoneSignIn';

export function readResignFlag(): string | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(RESIGN_KEY);
  } catch {
    return null;
  }
}

/** Store the mark; false where sessionStorage is unavailable (then the phone is never signed out: no loop). */
export function writeResignFlag(value: 'signed-out' | 'done'): boolean {
  try {
    sessionStorage.setItem(RESIGN_KEY, value);
    return sessionStorage.getItem(RESIGN_KEY) === value;
  } catch {
    return false;
  }
}

type SessionState = {
  status: 'loading' | 'ready' | 'offline' | 'error';
  me?: AuthMeRes;
  error?: string;
  /** Role used when the hub is unreachable at startup (fallback after an operator reload). */
  offlineRole?: 'operate' | 'edit';
};

export const useSession = create<SessionState>(() => ({ status: 'loading' }));

export function currentRole(): 'operate' | 'edit' | null {
  const s = useSession.getState();
  const r = s.me?.role ?? s.offlineRole ?? null;
  return r === 'operate' || r === 'edit' ? r : null;
}

export async function refreshSession(): Promise<void> {
  try {
    const me = await api<AuthMeRes>(ROUTES.me);
    if (phoneMustSignInAgain(me, thisIsPhone(), readResignFlag()) && writeResignFlag('signed-out')) {
      await logout();
      return;
    }
    if (me.role === 'operate' || me.role === 'edit') {
      try {
        localStorage.setItem(LAST_ROLE, me.role);
      } catch {
        /* storage unavailable */
      }
    }
    useSession.setState({ status: 'ready', me, error: undefined, offlineRole: undefined });
  } catch (e) {
    if (e instanceof ApiFailure && e.status > 0 && e.status < 500) {
      useSession.setState({ status: 'error', error: e.message });
      return;
    }
    // Hub unreachable. If this device was signed in before, continue offline from the local cache.
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_ROLE);
    } catch {
      /* ignore */
    }
    if (last === 'operate' || last === 'edit') useSession.setState({ status: 'offline', offlineRole: last });
    else useSession.setState({ status: 'error', error: 'The hub is unreachable. Retrying…' });
  }
}

export async function logout(): Promise<void> {
  try {
    await api(ROUTES.logout, { method: 'POST' });
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(LAST_ROLE);
  } catch {
    /* ignore */
  }
  location.hash = '#/live';
  location.reload();
}
