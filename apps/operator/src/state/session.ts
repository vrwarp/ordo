import { api, ApiFailure } from '@ordo/client';
import { type AuthMeRes, ROUTES } from '@ordo/protocol';
import { create } from 'zustand';

const LAST_ROLE = 'ordo.op.lastRole';

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
