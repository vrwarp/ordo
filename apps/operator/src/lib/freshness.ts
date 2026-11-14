import '../i18n/compactStrings.ts';
import { type FormatOptions, formatDayTime, t } from '../i18n/index.ts';

/**
 * The compact layout's freshness line (design/28 §2.2, §2.12 "Offline"): how old the library copy on this phone
 * may be while it cannot reach the hub. Hidden while connected; "Offline · copy from Thu 21:14" when the phone
 * is offline (or the session started offline), "Can't reach ordo · copy from Thu 21:14" when it is online but
 * the hub link is down; "· copy on this phone" when the time of the last contact is not known. A drop shows
 * after a 5 s grace, so a short blip never flashes the line. The last contact is kept in localStorage
 * (`ordo.op.lastContact`, ms since the epoch): written when the hub link goes down and on pagehide while
 * connected, read on an offline start; P1's 14-day expiry reads the same key. Pure, apart from the storage
 * helpers, which take the storage and never throw.
 */
export const LAST_CONTACT_KEY = 'ordo.op.lastContact';
export const FRESHNESS_GRACE_MS = 5000;

export type FreshnessInput = {
  /** navigator.onLine is false, or the session started offline. */
  offline: boolean;
  /** Online, but the hub link is down (it was up before). */
  hubDown: boolean;
  /** The last contact with the hub (ms), when known. */
  lastContact: number | undefined;
};

/** The line, or undefined while connected. */
export function freshnessText(input: FreshnessInput, fmt: FormatOptions = {}): string | undefined {
  if (!input.offline && !input.hubDown) return undefined;
  const when = input.lastContact !== undefined ? formatDayTime(input.lastContact, fmt) : '';
  if (input.offline) return when ? t('fresh.offlineAt', { when }) : t('fresh.offlineHere');
  return when ? t('fresh.unreachableAt', { when }) : t('fresh.unreachableHere');
}

/**
 * Whether a line that has been due since `downSince` shows at `now`: at once on an offline start (no grace
 * for a phone that never reached the hub in this page), after the grace on a drop.
 */
export function freshnessShown(
  downSince: number | undefined,
  now: number,
  offlineStart: boolean,
  graceMs = FRESHNESS_GRACE_MS,
): boolean {
  if (downSince === undefined) return false;
  return offlineStart || now - downSince >= graceMs;
}

/** A stored last contact: a whole number of ms, after 2020 and not more than a day ahead of `now`. */
export function parseLastContact(raw: string | null | undefined, now: number): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 20 || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < Date.UTC(2020, 0, 1) || n > now + 86_400_000) return undefined;
  return n;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function globalStorage(): Store | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The last contact this phone stored, or undefined (none, unreadable or blocked storage). */
export function readLastContact(
  now: number,
  storage: Store | undefined = globalStorage(),
): number | undefined {
  try {
    return parseLastContact(storage?.getItem(LAST_CONTACT_KEY), now);
  } catch {
    return undefined;
  }
}

/** Store the last contact (a no-op where storage is blocked or full). */
export function writeLastContact(at: number, storage: Store | undefined = globalStorage()): void {
  if (!Number.isSafeInteger(at) || at <= 0) return;
  try {
    storage?.setItem(LAST_CONTACT_KEY, String(at));
  } catch {
    /* storage unavailable */
  }
}
