import type { LiveEvent, LiveState, Media, Presentation, ResolvedPlaylist, Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { actionToEvent } from './actions.ts';
import { initialState, reduce, reduceAll } from './index.ts';
import { checkInvariants } from './invariants.ts';

/**
 * Item-entry effects (review 2026-11-13): entering a playlist item clears the running background when the
 * item has none (unless it keeps it) and starts the item's service countdown, on whichever cue the GO enters
 * the item by: a hidden first slide skipped by Next, Next item, a go-to-item key or MIDI jump, a click on a
 * later slide, Prev back into an earlier item, a loop started part-way. Moving within the item does neither.
 */

const f = { hash: 'h', bytes: 1, mime: 'x', path: 'p' };
const media = (id: string): Media => ({
  id,
  rev: 1,
  name: id,
  tags: [],
  kind: 'image',
  original: f,
  delivery: f,
  state: 'ready',
  loop: false,
  isBackground: true,
});
const shown = (id: string, over: Partial<Slide> = {}): Slide => ({ id, objects: [], ...over });
const hidden = (id: string): Slide => ({ id, objects: [], hidden: true });
function deck(id: string, slides: Slide[], over: Partial<Presentation> = {}): Presentation {
  return {
    id,
    rev: 1,
    title: id,
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: `${id}-s`, label: 'S', short: 'S', slides }],
    arrangements: [],
    archived: false,
    ...over,
  };
}
const COUNTDOWN = { kind: 'countdownTo' as const, timeOfDay: '10:00', label: 'Service starts in' };

/**
 * Cues:
 *   0 a/a1  1 a/a2  2 a/a3            item 'A': song with background 'bg'
 *   3 b/h*  4 b/b1  5 b/b2  6 b/b3    item 'B': no background, hidden first slide, countdown
 *   7 c/c1  8 c/c2                    item 'C': background 'bg2', keeps nothing special
 *   9 l/l1 10 l/l2 11 l/l3            item 'L': a loop, no background, countdown
 */
function fixture(): ResolvedPlaylist {
  const a = deck('a', [shown('a1'), shown('a2'), shown('a3')], { backgroundMediaId: 'bg' });
  const b = deck('b', [hidden('h'), shown('b1'), shown('b2'), shown('b3')]);
  const c = deck('c', [shown('c1'), shown('c2')], { backgroundMediaId: 'bg2' });
  const l = deck('l', [shown('l1'), shown('l2'), shown('l3')], {
    kind: 'loop',
    loop: { defaultSlideMs: 5000 },
  });
  return {
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'Sunday',
      items: [
        { id: 'A', kind: 'presentation', presentationId: 'a' },
        { id: 'B', kind: 'presentation', presentationId: 'b', countdownTimer: COUNTDOWN },
        { id: 'C', kind: 'presentation', presentationId: 'c' },
        { id: 'L', kind: 'presentation', presentationId: 'l', countdownTimer: COUNTDOWN },
      ],
    },
    presentations: { a, b, c, l },
    media: { bg: media('bg'), bg2: media('bg2') },
    fonts: [],
    looks: [],
    files: [],
    manifestId: 'm',
  };
}

function live(...events: LiveEvent[]): LiveState {
  const s = reduceAll(reduce(initialState(), { k: 'goLive', resolved: fixture() }), events);
  expect(checkInvariants(s)).toEqual([]);
  return s;
}
const bg = (s: LiveState) => s.layers.background.content?.mediaId ?? null;
const countdown = (s: LiveState) => s.props.countdownTimerId;
const action = (s: LiveState, id: string, arg?: number, at = 50): LiveEvent => {
  const e = actionToEvent(s, arg === undefined ? { id: id as never } : { id: id as never, arg }, at);
  if (!e) throw new Error(`no event for ${id}`);
  return e;
};

describe('item-entry effects on whichever cue enters the item', () => {
  it('Next past a hidden first slide clears the background and starts the countdown', () => {
    const s = live({ k: 'go', cueIndex: 2, at: 10 }, { k: 'next', at: 20 });
    expect(s.live).toBe(4);
    expect(bg(s)).toBeNull();
    expect(countdown(s)).toBe('B-timer');
    expect(s.timers['B-timer']).toMatchObject({ running: true, startedAt: 20 });
  });

  it('Next item and a go-to-item key (a Stream Deck or MIDI jump) do too', () => {
    const before = live({ k: 'go', cueIndex: 1, at: 10 });
    for (const e of [
      { k: 'nextItem', at: 20 } as LiveEvent,
      // A Stream Deck key, or a MIDI pad whose velocity is the item number (paramSource 'velocity').
      action(before, 'goToItem', 2, 20),
    ]) {
      const s = reduce(before, e);
      expect(s.live).toBe(4);
      expect(bg(s)).toBeNull();
      expect(countdown(s)).toBe('B-timer');
    }
  });

  it('a click on a later slide of the item (the continuous grid) does too', () => {
    const s = live({ k: 'go', cueIndex: 0, at: 10 }, { k: 'go', cueIndex: 6, at: 20 });
    expect(bg(s)).toBeNull();
    expect(countdown(s)).toBe('B-timer');
    expect(s.timers['B-timer']?.startedAt).toBe(20);
  });

  it('Prev back into an earlier item does too', () => {
    // From C (background bg2) back into B's last slide: B has no background and starts its countdown again.
    const s = live({ k: 'go', cueIndex: 7, at: 10 }, { k: 'prev', at: 20 });
    expect(s.live).toBe(6);
    expect(bg(s)).toBeNull();
    expect(countdown(s)).toBe('B-timer');
    // Back into the first item, which has its own background: it is shown again.
    const back = reduce(live({ k: 'go', cueIndex: 4, at: 10 }), { k: 'prev', at: 30 });
    expect(back.live).toBe(2);
    expect(bg(back)).toBe('bg');
    // Leaving B for A clears B's countdown, as leaving the item always did.
    expect(countdown(back)).toBeUndefined();
  });

  it('a loop started part-way shows its countdown', () => {
    const s = live({ k: 'go', cueIndex: 7, at: 10 }, { k: 'go', cueIndex: 10, at: 20 });
    expect(bg(s)).toBeNull();
    expect(countdown(s)).toBe('L-timer');
    // The loop wraps back to its first slide inside the item: the countdown keeps its start.
    const wrapped = reduceAll(s, [
      { k: 'next', at: 30 },
      { k: 'go', cueIndex: 9, at: 40 },
    ]);
    expect(wrapped.timers['L-timer']?.startedAt).toBe(20);
    expect(countdown(wrapped)).toBe('L-timer');
  });

  it('moving within an item clears nothing and does not restart the countdown', () => {
    let s = live({ k: 'go', cueIndex: 4, at: 10 });
    expect(s.timers['B-timer']?.startedAt).toBe(10);
    // The operator starts a background by hand within B (the clear on entry is past).
    s = {
      ...s,
      layers: {
        ...s.layers,
        background: { content: { kind: 'background', mediaId: 'bg' }, at: 15, seq: s.seq },
      },
    };
    s = reduceAll(s, [
      { k: 'next', at: 20 },
      { k: 'go', cueIndex: 3, at: 30 },
      { k: 'go', cueIndex: 6, at: 40 },
    ]);
    expect(bg(s)).toBe('bg');
    expect(s.timers['B-timer']?.startedAt).toBe(10);
  });

  it('an item that keeps the running background never clears it, whichever cue enters it', () => {
    const r = fixture();
    r.playlist.items[1] = { ...r.playlist.items[1]!, keepBackground: true } as (typeof r.playlist.items)[1];
    let s = reduce(initialState(), { k: 'goLive', resolved: r });
    s = reduceAll(s, [
      { k: 'go', cueIndex: 0, at: 10 },
      { k: 'go', cueIndex: 5, at: 20 },
    ]);
    expect(bg(s)).toBe('bg');
    expect(countdown(s)).toBe('B-timer');
  });
});
