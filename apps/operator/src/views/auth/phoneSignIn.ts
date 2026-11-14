import { ApiFailure, api } from '@ordo/client';
import { type AuthPinReq, type AuthPinRes, ROUTES } from '@ordo/protocol';
import { type FormatOptions, formatTime, t } from '../../i18n/index.ts';

/**
 * The sign-in goes through `@ordo/client`'s api(), which sends `x-ordo` (design/28 §4): written as a call so
 * apps/hub/test/phones-clients.test.ts, which reads the clients' sources, sees every POST below go through it.
 */
const viaApi = <T>(path: string, init: { method: 'POST'; json: AuthPinReq }): Promise<T> =>
  api<T>(path, init);

/**
 * A phone's sign-in request (design/28 §3.2 "How a phone gets light", "Never remembered"): never `remember`;
 * `cap: 'light'` when the hub's /auth/me lists the cap (`grantsLight`), nothing else for a hub that grants none.
 * A hub behind a stale /auth/me that refuses the field (400 `invalid` naming `cap`: the strict PinBody of an
 * older hub) is asked once more without it. Any other refusal is the caller's to show; nothing is retried.
 */
export type PinCall = <T>(path: string, init: { method: 'POST'; json: AuthPinReq }) => Promise<T>;

export async function phoneSignIn(
  pin: string,
  grantsLight: boolean,
  call: PinCall = viaApi,
): Promise<AuthPinRes> {
  if (!grantsLight) return call<AuthPinRes>(ROUTES.pin, { method: 'POST', json: { pin } });
  try {
    const req: AuthPinReq = { pin, cap: 'light' };
    return await call<AuthPinRes>(ROUTES.pin, { method: 'POST', json: req });
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 400 && e.code === 'invalid' && /\bcap\b/i.test(e.message))
      return call<AuthPinRes>(ROUTES.pin, { method: 'POST', json: { pin } });
    throw e;
  }
}

/**
 * What a phone's sign-in says when the hub refuses: a lockout (429) gives the time it ends, from
 * `details.retryAfterS`, and which bucket it is (`details.scope`: 'everyone' is the hub-wide one; 'network' or
 * none, an older hub's per-address one, which everyone on the same Wi-Fi may share); 401 is a wrong PIN;
 * anything else is the hub's own message.
 */
export function signInError(e: unknown, now: number, fmt: FormatOptions = {}): string {
  if (e instanceof ApiFailure && e.status === 429) {
    const s = Number(e.details?.retryAfterS);
    if (!Number.isFinite(s) || s <= 0 || s > 86_400) return t('signin.lockedSoon');
    const time = formatTime(now + s * 1000, fmt);
    return e.details?.scope === 'everyone'
      ? t('signin.lockedEveryone', { time })
      : t('signin.lockedNetwork', { time });
  }
  if (e instanceof ApiFailure && e.status === 401) return t('signin.wrong');
  return e instanceof Error ? e.message : String(e);
}

/** Safari on iOS, not from the home screen: the sign-in says the installed app keeps its own copy (§3.11). */
export function safariNotInstalled(
  nav: unknown = typeof navigator === 'undefined' ? undefined : navigator,
): boolean {
  return (
    !!nav &&
    typeof nav === 'object' &&
    'standalone' in nav &&
    (nav as { standalone?: unknown }).standalone !== true
  );
}
