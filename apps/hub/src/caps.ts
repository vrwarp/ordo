/**
 * Session caps at the hub's doors (design/28 §3.2, §3.3): what a capped session (a phone: role `edit`, cap
 * `light`; a `view` session) may call. Routes declare the lowest cap they accept beside their access role
 * (`routeFn`, http.ts checks at startup); a route that declares none needs `full` at run time.
 */
import type { SessionCap } from '@ordo/protocol';
import { capAtLeast, type Principal } from './auth.ts';
import { HttpError } from './errors.ts';

/** What a capped session is told when a route needs more than it has (the client shows it as it is). */
export const CAP_MESSAGES: Record<Exclude<SessionCap, 'view'>, string> = {
  light: 'This phone can look but not change.',
  full: 'Phones cannot do this. Use the venue PC or an iPad.',
};

/**
 * The 403 `cap` refusal for a principal below `need` (absent: `full`, the fail-closed default), or undefined.
 * Only session principals have a cap: tokens and anonymous callers are never refused here (their access role
 * decides), and a full session never is.
 */
export function capRefusal(p: Principal | null, need: SessionCap | undefined): HttpError | undefined {
  if (p?.kind !== 'session' || p.cap === 'full') return undefined;
  const n = need ?? 'full';
  if (capAtLeast(p.cap, n)) return undefined;
  const at = n === 'light' ? 'light' : 'full';
  return new HttpError(403, 'cap', CAP_MESSAGES[at], { need: at });
}
