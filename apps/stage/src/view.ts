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
  return {
    ready: i.ready,
    bus: i.bus,
    layout,
    current: safe(() => currentText(state, i.shown, layout), null),
    next: safe(() => nextText(state, i.shown, layout), null),
    clock: layout.clock
      ? safe(
          () => formatClock(now, i.general.timeZone, i.general.clock24h),
          safe(() => formatClock(now, 'UTC', i.general.clock24h), ''),
        )
      : '',
    countdown: layout.countdown ? safe(() => countdownDisplay(state, now, i.general.timeZone), null) : null,
    elapsed: layout.elapsed ? safe(() => elapsedDisplay(state, now), null) : null,
    remaining: layout.mediaRemaining ? safe(() => mediaRemainingDisplay(state, now), null) : null,
    messages: layout.messages
      ? safe(() => activeMessages(state.messages, now), []).map((m) => ({ id: m.id, text: m.text }))
      : [],
    title: i.title,
    clockOffset: i.clockOffset,
    clockFallback: i.clockFallback,
  };
}

/** Change detection for posting: a cheap structural signature. */
export function viewSignature(v: StageView): string {
  return JSON.stringify(v);
}
