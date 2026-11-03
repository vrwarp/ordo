import { type ActionId, type LiveEvent, type LiveState, MANUAL_ELAPSED_TIMER_ID, sectionsOfItem } from '@ordo/domain';

export type ActionContext = {
  messagePresets?: string[];
  newId?: () => string;
};

/**
 * Map a surface action to a live event. Returns null for actions that are not live events
 * (audio, launch, relaunch) or that have no effect in the current state. `clearAll` confirmation is the
 * caller's job. Section indices are 0-based; slide numbers (goToSlide) are 1-based within the live section.
 */
export function actionToEvent(
  s: LiveState,
  action: { id: ActionId; arg?: number | string },
  at: number,
  ctx: ActionContext = {},
): LiveEvent | null {
  switch (action.id) {
    case 'go':
      if (s.armed !== undefined) return { k: 'go', cueIndex: s.armed, at };
      return { k: 'next', at };
    case 'next':
      return { k: 'next', at };
    case 'prev':
      return { k: 'prev', at };
    case 'nextItem':
      return { k: 'nextItem', at };
    case 'prevItem':
      return { k: 'prevItem', at };
    case 'goToSection': {
      const idx = Number(action.arg ?? 0);
      return Number.isFinite(idx) ? { k: 'goToSection', sectionIndex: idx, at } : null;
    }
    case 'goToSlide': {
      const n = Number(action.arg ?? 1);
      const ref = s.live ?? s.armed;
      if (ref === undefined) return null;
      const cur = s.cues[ref];
      if (!cur) return null;
      const sameSection = s.cues.filter((c) => c.itemIndex === cur.itemIndex && c.arrangementPos === cur.arrangementPos);
      const target = sameSection[n - 1];
      if (!target) {
        // Not a slide presentation: fall back to the Nth section.
        const secs = sectionsOfItem(s.cues, ref);
        const sec = secs[n - 1];
        return sec ? { k: 'go', cueIndex: sec.first, at } : null;
      }
      return { k: 'go', cueIndex: target.index, at };
    }
    case 'clearSlide':
      return { k: 'clear', layer: 'slide', at };
    case 'clearAll':
      return { k: 'clear', layer: 'all', at };
    case 'clearLowerThird':
      return { k: 'clear', layer: 'lowerThird', at };
    case 'clearProps':
      return { k: 'clear', layer: 'props', at };
    case 'clearMedia':
      return { k: 'clear', layer: 'media', at };
    case 'clearBackground':
      return { k: 'clear', layer: 'background', at };
    case 'logo':
      return { k: 'logo', at };
    case 'mediaPlayPause':
      return { k: 'media.play', at };
    case 'mediaRestart':
      return { k: 'media.restart', at };
    case 'timerStart': {
      const id = String(action.arg ?? MANUAL_ELAPSED_TIMER_ID);
      return { k: 'timer.start', timerId: id, spec: s.timers[id]?.spec ?? { kind: 'elapsed', label: 'Elapsed' }, at };
    }
    case 'timerStop':
      return { k: 'timer.stop', timerId: String(action.arg ?? MANUAL_ELAPSED_TIMER_ID), at };
    case 'timerReset':
      return { k: 'timer.reset', timerId: String(action.arg ?? MANUAL_ELAPSED_TIMER_ID), at };
    case 'messagePreset': {
      const text = ctx.messagePresets?.[Number(action.arg ?? 0)];
      if (!text || !ctx.newId) return null;
      return { k: 'message.send', id: ctx.newId(), text, at };
    }
    case 'messageDismiss': {
      const m = s.messages[0];
      return m ? { k: 'message.dismiss', id: m.id } : null;
    }
    default:
      return null;
  }
}
