import { t } from '../i18n/index.ts';

/**
 * The compact layout's Live now strip (design/28 §2.2, decision 12; §10 item 9): the live plan's name and how
 * many presentations it locks, never a cue label or slide text. Its input is the plan's name and its locked
 * presentation ids only (a type with no field for a cue, so a caller cannot pass one through), the state of
 * the source that feeds it (P0: the 8 s `/live/summary` poll, lib/venueLive.ts; P1: the `venue` push) and
 * whether the phone is online. Pure.
 */
export type LiveStripPlan = { readonly playlistName: string; readonly presentationIds: readonly string[] };

export type LiveStripInput = {
  /** What the venue runs (undefined when idle or not known yet). */
  live: LiveStripPlan | undefined;
  /** The source: 'unknown' until its first answer, 'ok', or 'failing' after two failed polls. */
  status: 'unknown' | 'ok' | 'failing';
  /** navigator.onLine. */
  online: boolean;
  /** The session started offline (the hub was unreachable at load). */
  sessionOffline: boolean;
};

export type LiveStrip =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'live'; readonly text: string; readonly name: string; readonly locked: number }
  | { readonly kind: 'unknown'; readonly text: string; readonly reason: 'offline' | 'unreachable' };

/** The longest plan name the strip shows (hub data; the strip ellipsizes long names anyway). */
const MAX_NAME = 200;

/**
 * What the strip shows: hidden while the venue is idle or before the first answer; "Live at the venue:
 * Sunday Service · 6 locked" during a service; "Live status unknown: offline" when the phone is offline, and
 * "Live status unknown: can't reach ordo" when the source keeps failing.
 */
export function liveStrip(input: LiveStripInput): LiveStrip {
  if (!input.online || input.sessionOffline)
    return { kind: 'unknown', text: t('live.unknownOffline'), reason: 'offline' };
  if (input.status === 'failing')
    return { kind: 'unknown', text: t('live.unknownUnreachable'), reason: 'unreachable' };
  if (input.status !== 'ok' || !input.live) return { kind: 'hidden' };
  const name = String(input.live.playlistName ?? '').slice(0, MAX_NAME);
  const locked = Array.isArray(input.live.presentationIds) ? input.live.presentationIds.length : 0;
  return { kind: 'live', text: t('live.strip', { name, n: locked }), name, locked };
}

/** The Live sheet's text for a strip (what the volunteer reads after tapping it). */
export function liveSheetText(strip: LiveStrip): string {
  if (strip.kind === 'live') return t('live.sheet', { name: strip.name, n: strip.locked });
  return t('live.sheetUnknown');
}
