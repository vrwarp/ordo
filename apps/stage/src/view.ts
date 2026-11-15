/**
 * The stage view model (design/16): what the stage draws, as a pure function of the live state, the
 * displayed slide, the layout and the time. Computed in the link worker; the host only renders it.
 */
import {
  adaptStageRegions,
  formatClock,
  type GeneralSettings,
  type LiveState,
  type SlideContent,
} from '@ordo/domain';
import {
  activeMessages,
  buildLecternSlides,
  countdownDisplay,
  currentText,
  elapsedDisplay,
  mediaRemainingDisplay,
  nextNotesText,
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
  const nextNotes = layout.notes ? safe(() => nextNotesText(state, i.shown), null) : null;
  const messages = layout.messages
    ? safe(() => activeMessages(state.messages, now), []).map((m) => ({ id: m.id, text: m.text }))
    : [];

  let activeLayout = layout;
  if (layout.notes && !layout.hasCustomNotesStyle) {
    const adapted = adaptStageRegions({
      preset: layout.stagePreset,
      notesScale: layout.notesScale,
      isSong,
      hasNotes: Boolean(notes),
      notesEnabled: true,
      hasCustomNotesStyle: false,
      current: layout.current,
      next: layout.next,
      notes: layout.notes,
      messagesBox: layout.messages?.box ?? null,
      hasActiveMessages: messages.length > 0,
    });
    activeLayout = {
      ...layout,
      current: adapted.current,
      next: adapted.next,
      notes: adapted.notes,
    };
  } else if (layout.notes && layout.hasCustomNotesStyle && messages.length > 0 && layout.messages) {
    // Keep custom notes box clear of active flash messages when overlapping at the bottom
    const msgTop = layout.messages.box.y - 12;
    const nb = layout.notes.box;
    if (nb.y < msgTop && nb.y + nb.h > msgTop) {
      activeLayout = {
        ...layout,
        notes: { ...layout.notes, box: { ...nb, h: Math.max(60, msgTop - nb.y) } },
      };
    }
  }

  // Add slide position ("3/12") onto non-song current slide kickers so preachers have deck progress
  const current = safe(() => currentText(state, i.shown, activeLayout), null);
  const lecternSlides = safe(() => buildLecternSlides(state, i.shown), []);
  if (current && !isSong && lecternSlides.length > 1 && i.shown?.slideId && !current.position) {
    const idx = lecternSlides.findIndex((s) => s.slideId === i.shown?.slideId);
    if (idx >= 0) {
      current.label = current.label ?? p?.title ?? 'Slide';
      current.position = `${idx + 1}/${lecternSlides.length}`;
    }
  }

  return {
    ready: i.ready,
    bus: i.bus,
    layout: activeLayout,
    current,
    next: safe(() => nextText(state, i.shown, activeLayout), null),
    notes,
    nextNotes,
    activeSlideId: i.shown?.slideId,
    presentationTitle: p?.title,
    isSong,
    lecternSlides,
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
