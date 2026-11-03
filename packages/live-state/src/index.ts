import {
  type Cue,
  type LayerState,
  type LiveEvent,
  type LiveState,
  type ActionId,
  expandCues,
  itemStarts,
  sectionsOfItem,
} from '@ordo/domain';

const MAX_MESSAGES = 10;

function emptyLayer<T>(at = 0, seq = 0): LayerState<T> {
  return { content: null, at, seq };
}

export function initialState(): LiveState {
  return {
    seq: 0,
    mode: 'idle',
    cues: [],
    layers: {
      background: emptyLayer(),
      slide: emptyLayer(),
      lowerThird: emptyLayer(),
      media: emptyLayer(),
    },
    props: { logo: false, at: 0, seq: 0 },
    audio: emptyLayer(),
    timers: {},
    messages: [],
    black: false,
  };
}

/**
 * The single live-state reducer, run identically by hub, operator and every output.
 * Pure: never reads a clock or random source. Every event increments `seq`, even a no-op,
 * so that all clients agree on sequence numbers.
 */
export function reduce(prev: LiveState, e: LiveEvent): LiveState {
  const seq = prev.seq + 1;
  const s: LiveState = { ...prev, seq };
  switch (e.k) {
    case 'goLive': {
      const base = initialState();
      const cues = expandCues(e.resolved);
      return { ...base, seq, mode: 'live', resolved: e.resolved, cues, armed: cues.length ? 0 : undefined };
    }
    case 'endService': {
      const base = initialState();
      return {
        ...base,
        seq,
        layers: {
          background: emptyLayer(e.at, seq),
          slide: emptyLayer(e.at, seq),
          lowerThird: emptyLayer(e.at, seq),
          media: emptyLayer(e.at, seq),
        },
        props: { logo: false, at: e.at, seq },
        audio: emptyLayer(e.at, seq),
      };
    }
    case 'select':
      if (!s.cues[e.cueIndex]) return s;
      return { ...s, armed: e.cueIndex };
    case 'go':
      return goTo(s, e.cueIndex, e.at);
    case 'next': {
      const target = s.live === undefined ? (s.armed ?? 0) : s.live + 1;
      return goTo(s, target, e.at);
    }
    case 'prev':
      if (s.live === undefined || s.live <= 0) return s;
      return goTo(s, s.live - 1, e.at);
    case 'nextItem': {
      const starts = itemStarts(s.cues);
      const cur = s.live ?? -1;
      const target = starts.find((x) => x > cur);
      return target === undefined ? s : goTo(s, target, e.at);
    }
    case 'prevItem': {
      const starts = itemStarts(s.cues);
      if (s.live === undefined) return s;
      const curStart = [...starts].reverse().find((x) => x <= s.live!) ?? 0;
      const prevStart = [...starts].reverse().find((x) => x < curStart);
      return goTo(s, prevStart ?? curStart, e.at);
    }
    case 'goToSection': {
      const ref = s.live ?? s.armed;
      if (ref === undefined) return s;
      const sec = sectionsOfItem(s.cues, ref)[e.sectionIndex];
      return sec ? goTo(s, sec.first, e.at) : s;
    }
    case 'clear':
      return clear(s, e.layer, e.at);
    case 'logo':
      return { ...s, black: false, props: { ...s.props, logo: !s.props.logo, at: e.at, seq } };
    case 'lowerThird':
      return {
        ...s,
        layers: {
          ...s.layers,
          lowerThird: { content: e.text.trim() ? { kind: 'lowerThird', text: e.text } : null, at: e.at, seq },
        },
      };
    case 'media.play':
    case 'media.pause':
    case 'media.restart':
      return mediaTransport(s, e.k, e.at);
    case 'media.ended': {
      const m = s.layers.media.content;
      if (!m || m.cueIndex !== e.cueIndex || m.loop) return s;
      if (m.onEnd === 'black')
        return { ...s, layers: { ...s.layers, media: { content: null, at: e.at, seq } } };
      const ended: LiveState = {
        ...s,
        layers: {
          ...s.layers,
          media: { ...s.layers.media, content: { ...m, state: 'ended', positionMs: e.at - m.startedAt } },
        },
      };
      if (m.onEnd === 'advance' && s.live === e.cueIndex) return goTo(ended, e.cueIndex + 1, e.at);
      return ended;
    }
    case 'audio.stop':
      return { ...s, audio: { content: null, at: e.at, seq } };
    case 'audio.ended': {
      const a = s.audio.content;
      if (!a || a.cueIndex !== e.cueIndex || a.loop) return s;
      return { ...s, audio: { content: null, at: e.at, seq } };
    }
    case 'timer.start': {
      const existing = s.timers[e.timerId];
      const spec = e.spec ?? existing?.spec ?? { kind: 'elapsed' as const };
      const timers = { ...s.timers, [e.timerId]: { id: e.timerId, spec, running: true, startedAt: e.at } };
      const props =
        spec.kind === 'countdownTo' ? { ...s.props, countdownTimerId: e.timerId, at: e.at, seq } : s.props;
      return { ...s, timers, props };
    }
    case 'timer.stop': {
      const t = s.timers[e.timerId];
      if (!t || !t.running) return s;
      const elapsedMs = t.startedAt !== undefined ? e.at - t.startedAt : 0;
      const props =
        s.props.countdownTimerId === e.timerId
          ? { ...s.props, countdownTimerId: undefined, at: e.at, seq }
          : s.props;
      return { ...s, props, timers: { ...s.timers, [e.timerId]: { ...t, running: false, elapsedMs } } };
    }
    case 'timer.reset': {
      const t = s.timers[e.timerId];
      if (!t) return s;
      const props =
        s.props.countdownTimerId === e.timerId
          ? { ...s.props, countdownTimerId: undefined, at: e.at, seq }
          : s.props;
      return {
        ...s,
        props,
        timers: { ...s.timers, [e.timerId]: { ...t, running: false, startedAt: undefined, elapsedMs: 0 } },
      };
    }
    case 'message.send': {
      const messages = [
        { id: e.id, text: e.text, sentAt: e.at, expiresAt: e.ttlMs ? e.at + e.ttlMs : undefined },
        ...s.messages.filter((m) => m.id !== e.id),
      ].slice(0, MAX_MESSAGES);
      return { ...s, messages };
    }
    case 'message.dismiss':
      return { ...s, messages: s.messages.filter((m) => m.id !== e.id) };
    case 'message.clear':
      return { ...s, messages: [] };
  }
}

function goTo(s: LiveState, index: number, at: number): LiveState {
  const cue = s.cues[index];
  if (!cue) return s;
  const seq = s.seq;
  const next = s.cues[index + 1] ? index + 1 : undefined;
  let out: LiveState = { ...s, live: index, armed: next, black: false };
  switch (cue.kind) {
    case 'slide': {
      const layers = { ...out.layers };
      layers.slide = {
        content: {
          kind: 'slide',
          cueIndex: index,
          presentationId: cue.presentationId!,
          slideId: cue.slideId!,
        },
        at,
        seq,
        transition: cue.transition,
      };
      if (cue.backgroundMediaId && layers.background.content?.mediaId !== cue.backgroundMediaId) {
        layers.background = {
          content: { kind: 'background', mediaId: cue.backgroundMediaId },
          at,
          seq,
          transition: cue.transition,
        };
      }
      if (layers.media.content) layers.media = { content: null, at, seq };
      out = { ...out, layers, props: out.props.logo ? { ...out.props, logo: false, at, seq } : out.props };
      return out;
    }
    case 'media': {
      if (cue.mediaKind === 'audio') {
        return {
          ...out,
          audio: {
            content: {
              cueIndex: index,
              mediaId: cue.mediaId!,
              loop: !!cue.loop,
              state: 'playing',
              startedAt: at,
              positionMs: 0,
              pairId: cue.audio?.pairId,
              gainDb: cue.audio?.gainDb,
            },
            at,
            seq,
          },
        };
      }
      return {
        ...out,
        props: out.props.logo ? { ...out.props, logo: false, at, seq } : out.props,
        layers: {
          ...out.layers,
          media: {
            content: {
              kind: 'media',
              cueIndex: index,
              mediaId: cue.mediaId!,
              mediaKind: cue.mediaKind === 'image' ? 'image' : 'video',
              loop: !!cue.loop,
              onEnd: cue.onEnd ?? 'hold',
              state: 'playing',
              startedAt: at,
              positionMs: 0,
            },
            at,
            seq,
          },
        },
      };
    }
    case 'timer': {
      const spec = cue.timer!;
      const id = cue.timerId!;
      return {
        ...out,
        timers: { ...out.timers, [id]: { id, spec, running: true, startedAt: at } },
        props: spec.kind === 'countdownTo' ? { ...out.props, countdownTimerId: id, at, seq } : out.props,
      };
    }
    case 'action':
      return applyAction(out, cue.action!, at);
  }
}

function applyAction(s: LiveState, action: ActionId, at: number): LiveState {
  switch (action) {
    case 'clearSlide':
      return clear(s, 'slide', at);
    case 'clearAll':
      return clear(s, 'all', at);
    case 'clearLowerThird':
      return clear(s, 'lowerThird', at);
    case 'clearProps':
      return clear(s, 'props', at);
    case 'clearMedia':
      return clear(s, 'media', at);
    case 'clearBackground':
      return clear(s, 'background', at);
    case 'logo':
      return { ...s, props: { ...s.props, logo: true, at, seq: s.seq } };
    default:
      return s;
  }
}

function clear(
  s: LiveState,
  layer: 'slide' | 'lowerThird' | 'props' | 'media' | 'background' | 'audio' | 'all',
  at: number,
): LiveState {
  const seq = s.seq;
  const empty = { content: null, at, seq };
  switch (layer) {
    case 'props':
      return { ...s, props: { logo: false, countdownTimerId: undefined, at, seq } };
    case 'audio':
      return { ...s, audio: empty };
    case 'all':
      return {
        ...s,
        black: true,
        layers: { background: empty, slide: empty, lowerThird: empty, media: empty },
        props: { logo: false, countdownTimerId: undefined, at, seq },
        audio: empty,
      };
    default:
      return { ...s, layers: { ...s.layers, [layer]: empty } };
  }
}

function mediaTransport(
  s: LiveState,
  k: 'media.play' | 'media.pause' | 'media.restart',
  at: number,
): LiveState {
  const seq = s.seq;
  const m = s.layers.media.content;
  if (m && m.mediaKind === 'video') {
    let c = m;
    if (k === 'media.restart' || (k === 'media.play' && m.state === 'ended'))
      c = { ...m, state: 'playing', startedAt: at, positionMs: 0 };
    else if (k === 'media.play' && m.state === 'paused')
      c = { ...m, state: 'playing', startedAt: at - m.positionMs };
    else if (k === 'media.pause' && m.state === 'playing')
      c = { ...m, state: 'paused', positionMs: at - m.startedAt };
    else if (k === 'media.play' && m.state === 'playing')
      c = { ...m, state: 'paused', positionMs: at - m.startedAt };
    if (c === m) return s;
    return { ...s, layers: { ...s.layers, media: { content: c, at, seq } } };
  }
  const a = s.audio.content;
  if (a) {
    let c = a;
    if (k === 'media.restart' || (k === 'media.play' && a.state === 'ended'))
      c = { ...a, state: 'playing', startedAt: at, positionMs: 0 };
    else if (k === 'media.play' && a.state === 'paused')
      c = { ...a, state: 'playing', startedAt: at - a.positionMs };
    else if ((k === 'media.pause' || k === 'media.play') && a.state === 'playing')
      c = { ...a, state: 'paused', positionMs: at - a.startedAt };
    if (c === a) return s;
    return { ...s, audio: { content: c, at, seq } };
  }
  return s;
}

/** Apply many events. */
export function reduceAll(s: LiveState, events: LiveEvent[]): LiveState {
  return events.reduce(reduce, s);
}

/**
 * For loop presentations: when the live slide should auto-advance and to which cue (wrapping within the item).
 * Returns null when the live cue does not auto-advance or the slide layer is not showing it.
 */
export function autoAdvance(s: LiveState): { dueAt: number; target: number } | null {
  if (s.live === undefined) return null;
  const cue = s.cues[s.live];
  if (!cue?.autoAdvanceMs) return null;
  const slide = s.layers.slide.content;
  if (!slide || slide.cueIndex !== s.live) return null;
  const sameItem = s.cues.filter((c) => c.itemIndex === cue.itemIndex);
  const pos = sameItem.findIndex((c) => c.index === cue.index);
  const target = sameItem[(pos + 1) % sameItem.length]!.index;
  return { dueAt: s.layers.slide.at + cue.autoAdvanceMs, target };
}

/** The cue that is live, if any. */
export function liveCue(s: LiveState): Cue | undefined {
  return s.live === undefined ? undefined : s.cues[s.live];
}

/** Resolve a cue's slide object from the resolved playlist. */
export function slideFor(s: LiveState, presentationId: string, slideId: string) {
  const p = s.resolved?.presentations[presentationId];
  if (!p) return undefined;
  for (const sec of p.sections) for (const sl of sec.slides) if (sl.id === slideId) return sl;
  return undefined;
}

/** Pending-event rebasing for optimistic clients. */
export class OptimisticState {
  confirmed: LiveState;
  private pending: { id: string; event: LiveEvent }[] = [];
  constructor(initial: LiveState = initialState()) {
    this.confirmed = initial;
  }
  get view(): LiveState {
    return this.pending.reduce((st, p) => reduce(st, p.event), this.confirmed);
  }
  get pendingCount(): number {
    return this.pending.length;
  }
  propose(id: string, event: LiveEvent): void {
    this.pending.push({ id, event });
  }
  /** A hub delta arrived. Returns false on a sequence gap (caller must resync). */
  applyDelta(fromSeq: number, event: LiveEvent, ackId?: string): boolean {
    if (fromSeq !== this.confirmed.seq) return false;
    this.confirmed = reduce(this.confirmed, event);
    if (ackId) this.pending = this.pending.filter((p) => p.id !== ackId);
    return true;
  }
  ack(id: string): void {
    this.pending = this.pending.filter((p) => p.id !== id);
  }
  reject(id: string): void {
    this.pending = this.pending.filter((p) => p.id !== id);
  }
  replace(state: LiveState): void {
    this.confirmed = state;
    this.pending = [];
  }
}
