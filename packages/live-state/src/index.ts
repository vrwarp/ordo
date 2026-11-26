import {
  type AudioContent,
  type Cue,
  DRAW_OVERRIDE_MAX,
  type LayerState,
  type LiveEvent,
  type LiveState,
  type MediaContent,
  PRERENDERED_MAX,
  type ResolvedPlaylist,
  type ActionId,
  expandCues,
  isHiddenCue,
  isSkippedCue,
  nextShownCue,
  prevShownCue,
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
 *
 * Hidden cues (design/27 §9, `Cue.hidden`) and skipped items (ADR 0015, `Cue.skipped`): `next`, `prev`,
 * the cue a GO arms, onEnd 'advance', `nextItem` and `prevItem` skip them (`autoAdvance` too); `goToSection`
 * lands on its section's first cue that is not hidden; `go` and `select` reach any cue (and `go` into a
 * skipped item auto-unskips it).
 */
export function reduce(prev: LiveState, e: LiveEvent): LiveState {
  const seq = prev.seq + 1;
  const s: LiveState = { ...prev, seq };
  switch (e.k) {
    case 'goLive': {
      const base = initialState();
      const cues = expandCues(e.resolved);
      return { ...base, seq, mode: 'live', resolved: e.resolved, cues, armed: nextShownCue(cues, -1) };
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
      // Before the first GO, the armed cue (which `select` may have set to a hidden one).
      // While a loop is live, Next fires the armed standby cue (custom-selected or default next item).
      let target: number | undefined;
      if (s.live === undefined) {
        target = s.armed ?? nextShownCue(s.cues, -1);
      } else if (
        s.cues[s.live]?.autoAdvanceMs !== undefined &&
        s.armed !== undefined &&
        s.cues[s.armed] !== undefined &&
        !isHiddenCue(s.cues[s.armed]) &&
        !isSkippedCue(s.cues[s.armed])
      ) {
        target = s.armed;
      } else {
        target = nextManualCue(s.cues, s.live);
      }
      return target === undefined ? s : goTo(s, target, e.at);
    }
    case 'prev': {
      if (s.live === undefined) return s;
      const target = prevManualCue(s.cues, s.live);
      return target === undefined ? s : goTo(s, target, e.at);
    }
    case 'nextItem': {
      // The first cue that is neither hidden nor skipped of the next item that has one.
      const cur = s.live === undefined ? undefined : s.cues[s.live]?.itemIndex;
      const target = s.cues.find(
        (c) => (cur === undefined || c.itemIndex > cur) && !isHiddenCue(c) && !isSkippedCue(c),
      );
      return target === undefined ? s : goTo(s, target.index, e.at);
    }
    case 'prevItem': {
      // The first cue that is neither hidden nor skipped of the previous item that has one, else of the live item.
      if (s.live === undefined) return s;
      const cur = s.cues[s.live]?.itemIndex;
      if (cur === undefined) return s;
      const before = prevShownCue(
        s.cues,
        s.cues.findIndex((c) => c.itemIndex === cur),
      );
      const item = before === undefined ? cur : s.cues[before]!.itemIndex;
      const target = s.cues.find((c) => c.itemIndex === item && !isHiddenCue(c) && !isSkippedCue(c));
      return target === undefined ? s : goTo(s, target.index, e.at);
    }
    case 'goToSection': {
      const ref = s.live ?? s.armed;
      if (ref === undefined) return s;
      const sec = sectionsOfItem(s.cues, ref)[e.sectionIndex];
      return sec ? goTo(s, sec.entry, e.at) : s;
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
      if (m.onEnd === 'advance' && s.live === e.cueIndex) {
        const target = nextShownCue(s.cues, e.cueIndex);
        return target === undefined ? ended : goTo(ended, target, e.at);
      }
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
    case 'prerender.add': {
      // The hub's, for a picture of a key of the live service (design/29 §1.7); `resolved` is never changed.
      if (s.mode !== 'live' || !s.resolved?.prerenderKeys?.includes(e.key)) return s;
      if (!slideFor(s, e.presentationId, e.slideId)) return s;
      const { k: _, ...pic } = e;
      const same = (p: typeof pic) =>
        p.presentationId === pic.presentationId &&
        p.slideId === pic.slideId &&
        p.key === pic.key &&
        p.size === pic.size;
      const prerendered = [...(s.prerendered ?? []).filter((p) => !same(p)), pic].slice(-PRERENDERED_MAX);
      return { ...s, prerendered };
    }
    case 'prerender.use': {
      // The operator's "Use the picture for this slide during this service" (design/29 §1.7), until End service.
      if (s.mode !== 'live' || !slideFor(s, e.presentationId, e.slideId)) return s;
      const list = s.drawOverride ?? [];
      if (list.length >= DRAW_OVERRIDE_MAX) return s;
      if (list.some((d) => d.presentationId === e.presentationId && d.slideId === e.slideId)) return s;
      return { ...s, drawOverride: [...list, { presentationId: e.presentationId, slideId: e.slideId }] };
    }
    case 'item.skip':
      return applyItemSkip(s, e.itemId, e.skipped);
    case 'item.arrange':
      return applyItemArrange(s, e.itemId, e.sections);
    case 'item.hideSlides':
      return applyItemHideSlides(s, e.itemId, e.hiddenSlides);
    case 'slide.editText':
      return applySlideEditText(s, e.presentationId, e.slideId, e.objectId, e.text);
  }
}

/** Whether any active layer or live cursor currently points into playlist item `itemIndex`. */
function isItemActive(s: LiveState, itemIndex: number): boolean {
  if (s.live !== undefined && s.cues[s.live]?.itemIndex === itemIndex) return true;
  if (s.layers.slide.content && s.cues[s.layers.slide.content.cueIndex]?.itemIndex === itemIndex) return true;
  if (s.layers.media.content && s.cues[s.layers.media.content.cueIndex]?.itemIndex === itemIndex) return true;
  if (s.audio.content && s.cues[s.audio.content.cueIndex]?.itemIndex === itemIndex) return true;
  return false;
}

/**
 * The next cue for manual `next` and auto-arming after `from`.
 * For a loop cue (`autoAdvanceMs !== undefined`), manual navigation treats the whole loop as one step and
 * targets the first non-hidden, non-skipped cue of a later playlist item (`undefined` if the loop is the
 * last item, e.g. a post-service loop). Otherwise returns `nextShownCue(cues, from)`.
 */
function nextManualCue(cues: readonly Cue[], from: number): number | undefined {
  const cur = cues[from];
  if (cur?.autoAdvanceMs !== undefined) {
    for (let i = from + 1; i < cues.length; i++) {
      const c = cues[i]!;
      if (c.itemIndex > cur.itemIndex && !isHiddenCue(c) && !isSkippedCue(c)) return i;
    }
    return undefined;
  }
  return nextShownCue(cues, from);
}

/**
 * The previous cue for manual `prev` from `from`.
 * Treats loop items (`autoAdvanceMs !== undefined`) as a single unit:
 * - From inside a loop, jumps to the previous playlist item (or restarts the loop's first shown slide if first).
 * - Stepping back into a loop lands on the loop's first shown slide instead of its last.
 */
function prevManualCue(cues: readonly Cue[], from: number): number | undefined {
  const cur = cues[from];
  if (!cur) return undefined;
  let prev: number | undefined;
  if (cur.autoAdvanceMs !== undefined) {
    const firstOfItem = cues.findIndex((c) => c.itemIndex === cur.itemIndex);
    prev = prevShownCue(cues, firstOfItem);
    if (prev === undefined) {
      return cues.find((c) => c.itemIndex === cur.itemIndex && !isHiddenCue(c) && !isSkippedCue(c))?.index;
    }
  } else {
    prev = prevShownCue(cues, from);
    if (prev === undefined) return undefined;
  }
  const prevCue = cues[prev]!;
  if (prevCue.autoAdvanceMs !== undefined) {
    return (
      cues.find((c) => c.itemIndex === prevCue.itemIndex && !isHiddenCue(c) && !isSkippedCue(c))?.index ??
      prev
    );
  }
  return prev;
}

function applyItemSkip(s: LiveState, itemId: string, skipped: boolean): LiveState {
  if (s.mode !== 'live' || !s.resolved) return s;
  const items = s.resolved.playlist.items;
  const itemIndex = items.findIndex((it) => it.id === itemId);
  if (itemIndex < 0) return s;
  if (skipped && isItemActive(s, itemIndex)) return s;
  const cur = items[itemIndex]!;
  if (Boolean(cur.skipped) === skipped) return s;
  const nextItem = skipped ? { ...cur, skipped: true } : { ...cur, skipped: undefined };
  if (!skipped) delete nextItem.skipped;
  const nextResolved: ResolvedPlaylist = {
    ...s.resolved,
    playlist: {
      ...s.resolved.playlist,
      items: items.map((it, i) => (i === itemIndex ? nextItem : it)),
    },
  };
  const cues = expandCues(nextResolved);
  const armed =
    s.armed !== undefined && cues[s.armed]?.skipped
      ? s.live !== undefined
        ? nextManualCue(cues, s.live)
        : nextShownCue(cues, -1)
      : s.armed;
  return { ...s, resolved: nextResolved, cues, armed };
}

function applyItemArrange(s: LiveState, itemId: string, sections: string[] | null): LiveState {
  if (s.mode !== 'live' || !s.resolved) return s;
  const items = s.resolved.playlist.items;
  const itemIndex = items.findIndex((it) => it.id === itemId);
  if (itemIndex < 0) return s;
  const cur = items[itemIndex]!;
  if (cur.kind !== 'presentation') return s;
  if (!s.resolved.presentations[cur.presentationId]) return s;
  if (isItemActive(s, itemIndex)) return s;
  const nextItem = sections === null ? { ...cur, sections: undefined } : { ...cur, sections: [...sections] };
  if (sections === null) delete nextItem.sections;
  const nextResolved: ResolvedPlaylist = {
    ...s.resolved,
    playlist: {
      ...s.resolved.playlist,
      items: items.map((it, i) => (i === itemIndex ? nextItem : it)),
    },
  };
  const newCues = expandCues(nextResolved);
  const oldCount = s.cues.filter((c) => c.itemIndex === itemIndex).length;
  const newCount = newCues.filter((c) => c.itemIndex === itemIndex).length;
  const delta = newCount - oldCount;
  const remap = (idx: number): number => {
    const oldItem = s.cues[idx]?.itemIndex;
    if (oldItem === undefined || oldItem < itemIndex) return idx;
    return idx + delta;
  };
  const live = s.live !== undefined ? remap(s.live) : undefined;
  const armed =
    s.armed !== undefined && s.cues[s.armed]?.itemIndex !== itemIndex
      ? remap(s.armed)
      : live !== undefined
        ? nextManualCue(newCues, live)
        : nextShownCue(newCues, -1);
  const slideContent = s.layers.slide.content
    ? { ...s.layers.slide.content, cueIndex: remap(s.layers.slide.content.cueIndex) }
    : null;
  const mediaContent = s.layers.media.content
    ? { ...s.layers.media.content, cueIndex: remap(s.layers.media.content.cueIndex) }
    : null;
  const audioContent = s.audio.content
    ? {
        ...s.audio.content,
        cueIndex: remap(s.audio.content.cueIndex),
        ...(s.audio.content.untilCue !== undefined ? { untilCue: remap(s.audio.content.untilCue) } : {}),
      }
    : null;
  return {
    ...s,
    resolved: nextResolved,
    cues: newCues,
    live,
    armed,
    layers: {
      ...s.layers,
      slide: slideContent ? { ...s.layers.slide, content: slideContent } : s.layers.slide,
      media: mediaContent ? { ...s.layers.media, content: mediaContent } : s.layers.media,
    },
    audio: audioContent ? { ...s.audio, content: audioContent } : s.audio,
  };
}

function applyItemHideSlides(s: LiveState, itemId: string, hiddenSlides: string[]): LiveState {
  if (s.mode !== 'live' || !s.resolved) return s;
  const items = s.resolved.playlist.items;
  const itemIndex = items.findIndex((it) => it.id === itemId);
  if (itemIndex < 0) return s;
  const cur = items[itemIndex]!;
  if (cur.kind !== 'presentation') return s;
  // Avoid shifting slide-owned audio untilCue while that item's slide sound is playing.
  if (s.audio.content?.slideOwned && s.cues[s.audio.content.cueIndex]?.itemIndex === itemIndex) return s;
  const nextItem = hiddenSlides.length
    ? { ...cur, hiddenSlides: [...hiddenSlides] }
    : { ...cur, hiddenSlides: undefined };
  if (!hiddenSlides.length) delete nextItem.hiddenSlides;
  const nextResolved: ResolvedPlaylist = {
    ...s.resolved,
    playlist: {
      ...s.resolved.playlist,
      items: items.map((it, i) => (i === itemIndex ? nextItem : it)),
    },
  };
  const cues = expandCues(nextResolved);
  const armed =
    s.armed !== undefined && cues[s.armed]?.hidden
      ? s.live !== undefined
        ? nextManualCue(cues, s.live)
        : nextShownCue(cues, -1)
      : s.armed;
  return { ...s, resolved: nextResolved, cues, armed };
}

function applySlideEditText(
  s: LiveState,
  presentationId: string,
  slideId: string,
  objectId: string,
  text: string,
): LiveState {
  if (s.mode !== 'live' || !s.resolved) return s;
  // Never mutate a slide that is currently on air.
  if (
    s.layers.slide.content?.presentationId === presentationId &&
    s.layers.slide.content?.slideId === slideId
  )
    return s;
  if (
    s.live !== undefined &&
    s.cues[s.live]?.presentationId === presentationId &&
    s.cues[s.live]?.slideId === slideId
  )
    return s;
  const pres = s.resolved.presentations[presentationId];
  if (!pres) return s;
  let found = false;
  const sections = pres.sections.map((sec) => {
    let secChanged = false;
    const slides = sec.slides.map((sl) => {
      if (sl.id !== slideId) return sl;
      if (sl.pptx?.class === 'picture') return sl;
      const objIdx = sl.objects.findIndex((o) => o.id === objectId && o.type === 'text');
      if (objIdx < 0) return sl;
      found = true;
      secChanged = true;
      const objects = sl.objects.map((o, idx) => {
        if (idx !== objIdx || o.type !== 'text') return o;
        const { paras: _p, ...rest } = o;
        return { ...rest, text };
      });
      return { ...sl, objects };
    });
    return secChanged ? { ...sec, slides } : sec;
  });
  if (!found) return s;
  const nextResolved: ResolvedPlaylist = {
    ...s.resolved,
    presentations: {
      ...s.resolved.presentations,
      [presentationId]: { ...pres, sections },
    },
  };
  const cues = expandCues(nextResolved);
  return { ...s, resolved: nextResolved, cues };
}

function goTo(s: LiveState, index: number, at: number): LiveState {
  let base = s;
  let cue = base.cues[index];
  if (!cue) return s;
  // Explicitly jumping into a skipped item auto-unskips it so sequential Next continues cleanly (ADR 0015).
  if (cue.skipped && base.resolved) {
    const items = base.resolved.playlist.items;
    const cur = items[cue.itemIndex];
    if (cur?.skipped) {
      const unskipped = { ...cur, skipped: undefined };
      delete unskipped.skipped;
      const nextResolved: ResolvedPlaylist = {
        ...base.resolved,
        playlist: {
          ...base.resolved.playlist,
          items: items.map((it, i) => (i === cue!.itemIndex ? unskipped : it)),
        },
      };
      const cues = expandCues(nextResolved);
      base = { ...base, resolved: nextResolved, cues };
      cue = cues[index]!;
    }
  }
  const seq = base.seq;
  const prevCue = base.live !== undefined ? base.cues[base.live] : undefined;
  const sameLoopItem =
    cue.autoAdvanceMs !== undefined && prevCue !== undefined && prevCue.itemIndex === cue.itemIndex;
  const keepArmed =
    sameLoopItem &&
    base.armed !== undefined &&
    base.armed !== index &&
    base.cues[base.armed] !== undefined &&
    !isHiddenCue(base.cues[base.armed]) &&
    !isSkippedCue(base.cues[base.armed]);
  let out: LiveState = {
    ...base,
    live: index,
    armed: keepArmed ? base.armed : nextManualCue(base.cues, index),
    black: false,
    audio: keepSlideAudio(base.audio, index, at, seq),
  };
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
      // Entry effects (the background clear, the item's countdown) apply on whichever cue enters the item:
      // its first slide may be hidden, or the operator may click further in, jump to it, or step back into it.
      const enteringItem = s.live === undefined || s.cues[s.live]?.itemId !== cue.itemId;
      if (cue.clearBackground || (cue.clearOnEntry && enteringItem)) {
        // The slide clears the running background (its own playlist item or presentation background
        // would otherwise have been in backgroundMediaId; a clear wins only over what is running).
        if (layers.background.content)
          layers.background = { content: null, at, seq, transition: cue.transition };
      } else if (cue.backgroundMediaId && layers.background.content?.mediaId !== cue.backgroundMediaId) {
        layers.background = {
          content: { kind: 'background', mediaId: cue.backgroundMediaId },
          at,
          seq,
          transition: cue.transition,
        };
      }
      layers.media = slideMediaLayer(layers.media, cue, index, at, seq);
      let nextProps = out.props.logo ? { ...out.props, logo: false, at, seq } : out.props;
      let nextTimers = out.timers;
      if (cue.timer && cue.timerId && enteringItem) {
        nextTimers = {
          ...nextTimers,
          [cue.timerId]: { id: cue.timerId, spec: cue.timer, running: true, startedAt: at },
        };
        if (cue.timer.kind === 'countdownTo') {
          nextProps = { ...nextProps, countdownTimerId: cue.timerId, at, seq };
        }
      } else if (shouldAutoClearCountdown(s, cue, nextProps.countdownTimerId)) {
        nextProps = { ...nextProps, countdownTimerId: undefined, at, seq };
      }
      out = {
        ...out,
        layers,
        audio: slideAudioLayer(out.audio, cue, index, at, seq),
        props: nextProps,
        timers: nextTimers,
      };
      return out;
    }
    case 'media': {
      let nextProps = out.props;
      if (shouldAutoClearCountdown(s, cue, nextProps.countdownTimerId)) {
        nextProps = { ...nextProps, countdownTimerId: undefined, at, seq };
      }
      if (cue.mediaKind === 'audio') {
        return {
          ...out,
          props: nextProps,
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
      if (nextProps.logo) nextProps = { ...nextProps, logo: false, at, seq };
      return {
        ...out,
        props: nextProps,
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

function shouldAutoClearCountdown(s: LiveState, nextCue: Cue, activeTimerId: string | undefined): boolean {
  if (!activeTimerId || s.live === undefined) return false;
  const prevCue = s.cues[s.live];
  if (!prevCue || prevCue.itemId === nextCue.itemId) return false;
  if (prevCue.kind === 'timer') return false;
  const prevItemStartedIt = s.cues.some(
    (c) => c.itemId === prevCue.itemId && c.kind === 'slide' && c.timerId === activeTimerId,
  );
  if (prevItemStartedIt) return true;
  const prevPres = prevCue.presentationId ? s.resolved?.presentations[prevCue.presentationId] : undefined;
  const nextPres = nextCue.presentationId ? s.resolved?.presentations[nextCue.presentationId] : undefined;
  return prevPres?.kind === 'loop' && nextPres?.kind !== 'loop';
}

/**
 * The media layer as slide cue `index` goes live (design/27 §8 "Reducer"): the slide's own video in its
 * object's box, restarted on every entry as PowerPoint does, paused at 0 for a click start (F8 plays it). It
 * changes with the slide's transition, so the outgoing clip plays on through the fade. A slide without one
 * clears the layer, as every slide always has.
 */
function slideMediaLayer(
  media: LayerState<MediaContent>,
  cue: Cue,
  index: number,
  at: number,
  seq: number,
): LayerState<MediaContent> {
  if (cue.mediaObjectId && cue.mediaId && cue.mediaKind === 'video') {
    return {
      content: {
        kind: 'media',
        cueIndex: index,
        mediaId: cue.mediaId,
        mediaKind: 'video',
        objectId: cue.mediaObjectId,
        loop: !!cue.loop,
        onEnd: cue.onEnd ?? 'hold',
        state: cue.mediaStart === 'click' ? 'paused' : 'playing',
        startedAt: at,
        positionMs: 0,
      },
      at,
      seq,
      transition: cue.transition,
    };
  }
  if (!media.content) return media;
  return media.content.objectId
    ? { content: null, at, seq, transition: cue.transition }
    : { content: null, at, seq };
}

/**
 * The audio slot as slide cue `index` goes live (design/27 §8 "Reducer"):
 * - A slide-owned sound with the same media that is still playing, with `index` inside its
 *   `[cueIndex, untilCue]`, plays on: a loop that wraps back to its slide, an operator stepping back, or an
 *   arrangement that repeats the slide inside the range never restarts it. Its range grows to cover the
 *   repeat's own range.
 * - An autoplay sound replaces what plays (a playlist audio cue included).
 * - A click-start sound waits for F8 (`pendingSlideSound`) and leaves the slot as it is, so playlist audio
 *   or another slide's sound plays on until F8 starts it.
 * Without a sound of its own the slot is left as it is: playlist audio plays on under slides
 * (`keepSlideAudio` has already stopped a slide sound whose range was left).
 */
function slideAudioLayer(
  audio: LayerState<AudioContent>,
  cue: Cue,
  index: number,
  at: number,
  seq: number,
): LayerState<AudioContent> {
  const sound = cue.slideAudio;
  if (!sound) return audio;
  const a = audio.content;
  if (
    a?.slideOwned &&
    a.mediaId === sound.mediaId &&
    a.state === 'playing' &&
    index >= a.cueIndex &&
    index <= (a.untilCue ?? a.cueIndex)
  ) {
    const until = Math.max(a.untilCue ?? a.cueIndex, sound.untilCue);
    return until === a.untilCue ? audio : { ...audio, content: { ...a, untilCue: until } };
  }
  if (sound.start === 'click') return audio;
  return { content: slideSound(sound, index, at), at, seq };
}

/** A slide's own sound starting at `at` from cue `index`. */
function slideSound(sound: NonNullable<Cue['slideAudio']>, index: number, at: number): AudioContent {
  return {
    cueIndex: index,
    mediaId: sound.mediaId,
    loop: sound.loop,
    state: 'playing',
    startedAt: at,
    positionMs: 0,
    ...(sound.gainDb !== undefined ? { gainDb: sound.gainDb } : {}),
    slideOwned: true,
    untilCue: Math.max(index, sound.untilCue),
  };
}

/**
 * The live slide's click-start sound while it waits for F8 (design/27 §8): the slide layer shows the live
 * slide cue, its sound starts on click, and the audio slot does not hold it (not started yet, stopped, or
 * ended). A slide-owned sound of the same media still in range counts as started.
 */
export function pendingSlideSound(
  s: LiveState,
): { cueIndex: number; sound: NonNullable<Cue['slideAudio']> } | undefined {
  const index = s.live;
  if (index === undefined || s.layers.slide.content?.cueIndex !== index) return undefined;
  const sound = s.cues[index]?.slideAudio;
  if (sound?.start !== 'click') return undefined;
  const a = s.audio.content;
  if (
    a?.slideOwned &&
    a.mediaId === sound.mediaId &&
    index >= a.cueIndex &&
    index <= (a.untilCue ?? a.cueIndex)
  )
    return undefined;
  return { cueIndex: index, sound };
}

/** `s` with the live slide's waiting click-start sound started at `at`, or undefined when none waits. */
export function startSlideSound(s: LiveState, at: number): LiveState | undefined {
  const pending = pendingSlideSound(s);
  if (!pending) return undefined;
  return { ...s, audio: { content: slideSound(pending.sound, pending.cueIndex, at), at, seq: s.seq } };
}

/**
 * What F8 (`media.play`) acts on (design/27 §8): the live slide's waiting click-start sound, unless the
 * media layer's video is paused (a click-start video waiting for its click, or one the operator paused),
 * which F8 plays first; else the media layer's video; else the audio slot. Shift+F8 (`media.restart`)
 * restarts the video when there is one, else starts the waiting sound, else restarts the audio slot.
 */
export function mediaPlayTarget(s: LiveState): 'video' | 'slideSound' | 'audio' | undefined {
  const m = s.layers.media.content;
  const video = m?.mediaKind === 'video' ? m : undefined;
  if (video?.state !== 'paused' && pendingSlideSound(s)) return 'slideSound';
  if (video) return 'video';
  return s.audio.content ? 'audio' : undefined;
}

/** A slide's own sound stops once the live cue leaves [its cue, untilCue] (design/27 §8). */
function keepSlideAudio(
  audio: LayerState<AudioContent>,
  index: number,
  at: number,
  seq: number,
): LayerState<AudioContent> {
  const a = audio.content;
  if (!a?.slideOwned) return audio;
  return index >= a.cueIndex && index <= (a.untilCue ?? a.cueIndex) ? audio : { content: null, at, seq };
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
    case 'slide':
      // The slide's own video and sound go with it (design/27 §8).
      return {
        ...s,
        layers: {
          ...s.layers,
          slide: empty,
          media: s.layers.media.content?.objectId ? empty : s.layers.media,
        },
        audio: s.audio.content?.slideOwned ? empty : s.audio,
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
  const video = m?.mediaKind === 'video' ? m : undefined;
  if ((k === 'media.play' && mediaPlayTarget(s) === 'slideSound') || (k === 'media.restart' && !video)) {
    const started = startSlideSound(s, at);
    if (started) return started;
  }
  if (video) {
    let c = video;
    if (k === 'media.restart' || (k === 'media.play' && video.state === 'ended'))
      c = { ...video, state: 'playing', startedAt: at, positionMs: 0 };
    else if (k === 'media.play' && video.state === 'paused')
      c = { ...video, state: 'playing', startedAt: at - video.positionMs };
    else if (k === 'media.pause' && video.state === 'playing')
      c = { ...video, state: 'paused', positionMs: at - video.startedAt };
    else if (k === 'media.play' && video.state === 'playing')
      c = { ...video, state: 'paused', positionMs: at - video.startedAt };
    if (c === video) return s;
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
 * For loop presentations: when the live slide should auto-advance and to which cue: the next cue of the item
 * that is not hidden, wrapping within the item (a hidden slide a click showed advances too). Returns null
 * when the live cue does not auto-advance, the slide layer is not showing it, or every cue of the item is
 * hidden.
 */
export function autoAdvance(s: LiveState): { dueAt: number; target: number } | null {
  if (s.live === undefined) return null;
  const cue = s.cues[s.live];
  if (!cue?.autoAdvanceMs) return null;
  const slide = s.layers.slide.content;
  if (!slide || slide.cueIndex !== s.live) return null;
  const sameItem = s.cues.filter((c) => c.itemIndex === cue.itemIndex);
  const pos = sameItem.findIndex((c) => c.index === cue.index);
  for (let k = 1; k <= sameItem.length; k++) {
    const c = sameItem[(pos + k) % sameItem.length]!;
    if (!isHiddenCue(c)) return { dueAt: s.layers.slide.at + cue.autoAdvanceMs, target: c.index };
  }
  return null;
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

// ---- Guards against malformed input (hub journal corruption, a stale client, a hostile peer) ----

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
function isLayer(x: unknown): boolean {
  return (
    isObj(x) && 'content' in x && isNum(x.at) && isNum(x.seq) && (x.content === null || isObj(x.content))
  );
}
function isIndex(x: unknown): boolean {
  return x === undefined || (isNum(x) && Number.isInteger(x) && x >= 0);
}

/**
 * Cheap structural check of a LiveState (every field the reducer and renderers dereference without a guard).
 * Not a full schema validation: cue and content internals are not inspected.
 */
export function isLiveStateShape(x: unknown): x is LiveState {
  if (!isObj(x)) return false;
  if (!isNum(x.seq) || (x.mode !== 'idle' && x.mode !== 'live')) return false;
  if (!Array.isArray(x.cues) || !isIndex(x.live) || !isIndex(x.armed)) return false;
  const layers = x.layers;
  if (!isObj(layers)) return false;
  for (const k of ['background', 'slide', 'lowerThird', 'media'] as const)
    if (!isLayer(layers[k])) return false;
  const props = x.props;
  if (!isObj(props) || typeof props.logo !== 'boolean' || !isNum(props.at) || !isNum(props.seq)) return false;
  if (!isLayer(x.audio)) return false;
  if (!isObj(x.timers) || !Array.isArray(x.messages) || typeof x.black !== 'boolean') return false;
  if (x.prerendered !== undefined && !Array.isArray(x.prerendered)) return false;
  if (x.drawOverride !== undefined && !Array.isArray(x.drawOverride)) return false;
  if (x.resolved !== undefined) {
    const r = x.resolved;
    if (!isObj(r) || !isObj(r.playlist) || !Array.isArray(r.playlist.items)) return false;
    if (!isObj(r.presentations) || !isObj(r.media)) return false;
  }
  return true;
}

/** Cheap structural check of a LiveEvent: a known kind and the fields the reducer dereferences. */
export function isLiveEventShape(x: unknown): x is LiveEvent {
  if (!isObj(x) || typeof x.k !== 'string') return false;
  const needsAt =
    x.k !== 'goLive' &&
    x.k !== 'select' &&
    x.k !== 'message.dismiss' &&
    x.k !== 'message.clear' &&
    x.k !== 'prerender.add' &&
    x.k !== 'prerender.use' &&
    x.k !== 'item.skip' &&
    x.k !== 'item.arrange' &&
    x.k !== 'item.hideSlides' &&
    x.k !== 'slide.editText';
  if (needsAt && !isNum(x.at)) return false;
  switch (x.k) {
    case 'goLive': {
      const r = x.resolved;
      return (
        isObj(r) &&
        isObj(r.playlist) &&
        Array.isArray(r.playlist.items) &&
        isObj(r.presentations) &&
        isObj(r.media)
      );
    }
    case 'select':
    case 'go':
    case 'media.ended':
    case 'audio.ended':
      return isNum(x.cueIndex);
    case 'goToSection':
      return isNum(x.sectionIndex);
    case 'clear':
      return typeof x.layer === 'string';
    case 'lowerThird':
      return typeof x.text === 'string';
    case 'timer.start':
    case 'timer.stop':
    case 'timer.reset':
      return typeof x.timerId === 'string';
    case 'message.send':
      return typeof x.id === 'string' && typeof x.text === 'string';
    case 'message.dismiss':
      return typeof x.id === 'string';
    case 'prerender.add':
      return (
        typeof x.presentationId === 'string' &&
        typeof x.slideId === 'string' &&
        typeof x.key === 'string' &&
        typeof x.file === 'string' &&
        isNum(x.size)
      );
    case 'prerender.use':
      return typeof x.presentationId === 'string' && typeof x.slideId === 'string';
    case 'item.skip':
      return typeof x.itemId === 'string' && typeof x.skipped === 'boolean';
    case 'item.arrange':
      return typeof x.itemId === 'string' && (x.sections === null || Array.isArray(x.sections));
    case 'item.hideSlides':
      return typeof x.itemId === 'string' && Array.isArray(x.hiddenSlides);
    case 'slide.editText':
      return (
        typeof x.presentationId === 'string' &&
        typeof x.slideId === 'string' &&
        typeof x.objectId === 'string' &&
        typeof x.text === 'string'
      );
    case 'endService':
    case 'next':
    case 'prev':
    case 'nextItem':
    case 'prevItem':
    case 'logo':
    case 'media.play':
    case 'media.pause':
    case 'media.restart':
    case 'audio.stop':
    case 'message.clear':
      return true;
    default:
      return false;
  }
}

export type ReduceErrorHandler = (error: unknown, event: unknown) => void;

/**
 * `reduce` that never throws: a malformed event, or one the reducer cannot apply, is reported through
 * `onError` and the previous state is returned unchanged. Hub, outputs and the operator use this on every
 * message that arrives over the wire; the pure `reduce` stays for code that owns its inputs.
 */
export function safeReduce(prev: LiveState, event: unknown, onError?: ReduceErrorHandler): LiveState {
  try {
    if (!isLiveEventShape(event)) throw new TypeError(`malformed live event: ${describe(event)}`);
    const next = reduce(prev, event);
    if (!isLiveStateShape(next)) throw new TypeError('reducer produced a malformed state');
    return next;
  } catch (e) {
    onError?.(e, event);
    return prev;
  }
}

function describe(x: unknown): string {
  try {
    const s = JSON.stringify(x);
    return s === undefined ? String(x) : s.length > 120 ? `${s.slice(0, 119)}…` : s;
  } catch {
    return String(x);
  }
}

/** Pending-event rebasing for optimistic clients. */
export class OptimisticState {
  confirmed: LiveState;
  /** Called when a message could not be applied (malformed event or state); the state is left unchanged. */
  onError?: ReduceErrorHandler;
  private pending: { id: string; event: LiveEvent }[] = [];
  constructor(initial: LiveState = initialState()) {
    this.confirmed = initial;
  }
  get view(): LiveState {
    return this.pending.reduce((st, p) => safeReduce(st, p.event, this.onError), this.confirmed);
  }
  get pendingCount(): number {
    return this.pending.length;
  }
  propose(id: string, event: LiveEvent): void {
    this.pending.push({ id, event });
  }
  /**
   * A hub delta arrived. Returns false on a sequence gap or an event this client could not apply (the hub
   * did, so the states diverged): the caller must resync either way.
   */
  applyDelta(fromSeq: number, event: LiveEvent, ackId?: string): boolean {
    if (fromSeq !== this.confirmed.seq) return false;
    let failed = false;
    const next = safeReduce(this.confirmed, event, (e, ev) => {
      failed = true;
      this.onError?.(e, ev);
    });
    if (failed) return false;
    this.confirmed = next;
    if (ackId) this.pending = this.pending.filter((p) => p.id !== ackId);
    return true;
  }
  ack(id: string): void {
    this.pending = this.pending.filter((p) => p.id !== id);
  }
  reject(id: string): void {
    this.pending = this.pending.filter((p) => p.id !== id);
  }
  /** Replace the confirmed state (full state from the hub). A malformed state is reported and ignored. */
  replace(state: LiveState): boolean {
    if (!isLiveStateShape(state)) {
      this.onError?.(new TypeError('malformed live state'), state);
      return false;
    }
    this.confirmed = state;
    this.pending = [];
    return true;
  }
}
export * from './actions.ts';
export * from './invariants.ts';
