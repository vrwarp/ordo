/**
 * The stage view model (design/16): what the stage draws, as a pure function of the live state, the
 * displayed slide, the layout and the time. Computed in the link worker; the host only renders it.
 */
import { formatClock, type GeneralSettings, type LiveState, type SlideContent } from '@ordo/domain';
import {
  activeMessages,
  countdownDisplay,
  currentText,
  elapsedDisplay,
  mediaRemainingDisplay,
  nextText,
  notesText,
  type StageLayout,
} from './model.ts';
import type { Bus, StageView } from './protocol.ts';

export type ViewInput = {
  state: LiveState;
  ready: boolean;
  shown: SlideContent | null;
  layout: StageLayout;
  general: Pick<GeneralSettings, 'timeZone' | 'clock24h'>;
  bus: Bus;
  now: number;
  title?: string;
  clockOffset: number;
  clockFallback: boolean;
};

/** Never throws: a bad time zone or a malformed state yields an empty region, not a dead stage. */
export function buildView(i: ViewInput): StageView {
  const { state, layout, now } = i;
  const safe = <T>(fn: () => T, def: T): T => {
    try {
      return fn();
    } catch {
      return def;
    }
  };
  const p = i.shown ? state.resolved?.presentations[i.shown.presentationId] : undefined;
  const isSong = p?.kind === 'song';
  const notes = layout.notes ? safe(() => notesText(state, i.shown), null) : null;
  const messages = layout.messages
    ? safe(() => activeMessages(state.messages, now), []).map((m) => ({ id: m.id, text: m.text }))
    : [];
  let activeLayout = layout;
  // Non-song presentation with speaker notes on the default cramped bottom strip: adapt layout to give
  // preacher notes primary space while staying clear of any active stage flash messages.
  if (
    !isSong &&
    notes &&
    layout.notes &&
    layout.current &&
    layout.notes.box.y >= 900 &&
    layout.notes.box.h <= 140
  ) {
    const notesBottom =
      messages.length > 0 && layout.messages ? Math.max(550, layout.messages.box.y - 12) : 1064;
    activeLayout = {
      ...layout,
      current: {
        ...layout.current,
        style: { ...layout.current.style, fontSizePx: Math.min(layout.current.style.fontSizePx, 44) },
        box: { x: layout.current.box.x, y: 140, w: layout.current.box.w, h: 180, rotation: 0 },
      },
      next: layout.next
        ? {
            ...layout.next,
            style: { ...layout.next.style, fontSizePx: Math.min(layout.next.style.fontSizePx, 32) },
            box: { x: layout.next.box.x, y: 330, w: layout.next.box.w, h: 110, rotation: 0 },
          }
        : null,
      notes: {
        ...layout.notes,
        box: { x: layout.current.box.x, y: 450, w: layout.current.box.w, h: notesBottom - 450, rotation: 0 },
      },
    };
  }
  return {
    ready: i.ready,
    bus: i.bus,
    layout: activeLayout,
    current: safe(() => currentText(state, i.shown, activeLayout), null),
    next: safe(() => nextText(state, i.shown, activeLayout), null),
    notes,
    clock: activeLayout.clock
      ? safe(
          () => formatClock(now, i.general.timeZone, i.general.clock24h),
          safe(() => formatClock(now, 'UTC', i.general.clock24h), ''),
        )
      : '',
    countdown: activeLayout.countdown
      ? safe(() => countdownDisplay(state, now, i.general.timeZone), null)
      : null,
    elapsed: activeLayout.elapsed ? safe(() => elapsedDisplay(state, now), null) : null,
    remaining: activeLayout.mediaRemaining ? safe(() => mediaRemainingDisplay(state, now), null) : null,
    messages,
    title: i.title,
    clockOffset: i.clockOffset,
    clockFallback: i.clockFallback,
  };
}

/** Change detection for posting: a cheap structural signature. */
export function viewSignature(v: StageView): string {
  return JSON.stringify(v);
}
