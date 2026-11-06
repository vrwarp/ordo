import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { LiveEvent, LiveState, Media, Presentation, ResolvedPlaylist, Slide } from '@ordo/domain';
import { actionToEvent } from './actions.ts';
import { autoAdvance, initialState, reduce, reduceAll } from './index.ts';
import { checkInvariants } from './invariants.ts';

/**
 * Hidden PowerPoint slides in the reducer (design/27 §9, §14.8): their cues are flagged `hidden`; Next,
 * Prev, the cue a GO arms, auto-advance, onEnd 'advance', Next item, Previous item and section keys skip
 * them; a GO with their index shows them.
 */

const f = { hash: 'h', bytes: 1, mime: 'x', path: 'p' };
const media = (id: string, kind: Media['kind']): Media => ({
  id,
  rev: 1,
  name: id,
  tags: [],
  kind,
  original: f,
  delivery: f,
  state: 'ready',
  loop: false,
  isBackground: false,
});
const shown = (id: string, over: Partial<Slide> = {}): Slide => ({ id, objects: [], ...over });
const hidden = (id: string, over: Partial<Slide> = {}): Slide => ({ id, objects: [], hidden: true, ...over });
function deck(id: string, sections: Slide[][], over: Partial<Presentation> = {}): Presentation {
  return {
    id,
    rev: 1,
    title: id,
    kind: 'slides',
    meta: { tags: [] },
    sections: sections.map((slides, i) => ({ id: `${id}-s${i}`, label: `S${i}`, short: `S${i}`, slides })),
    arrangements: [],
    archived: false,
    ...over,
  };
}
function resolved(items: ResolvedPlaylist['playlist']['items'], ...ps: Presentation[]): ResolvedPlaylist {
  return {
    playlist: { id: 'pl', rev: 1, name: 'Sunday', items },
    presentations: Object.fromEntries(ps.map((p) => [p.id, p])),
    media: { vid: media('vid', 'video'), song: media('song', 'audio') },
    fonts: [],
    looks: [],
    files: [],
    manifestId: 'm',
  };
}
const item = (i: number, presentationId: string) => ({
  id: `i${i}`,
  kind: 'presentation' as const,
  presentationId,
});

/**
 * Cues (hidden ones starred):
 *   0 d/a   1 d/h1*  2 d/b   3 d/h2*     section S0
 *   4 d/x1* 5 d/x2*                     section S1, every slide hidden
 *   6 d/h3* 7 d/c                       section S2
 *   8 media 'vid' (onEnd advance)
 *   9 z/z1* 10 z/z2*                    an item whose slides are all hidden
 *  11 e/h4* 12 e/e1 13 e/e2
 *  14 l/l1 15 l/lh* 16 l/l2            a loop
 */
function fixture(): ResolvedPlaylist {
  const d = deck('d', [
    [shown('a'), hidden('h1'), shown('b'), hidden('h2')],
    [hidden('x1'), hidden('x2')],
    [hidden('h3'), shown('c')],
  ]);
  const z = deck('z', [[hidden('z1'), hidden('z2')]]);
  const e = deck('e', [[hidden('h4'), shown('e1'), shown('e2')]]);
  const l = deck('l', [[shown('l1'), hidden('lh'), shown('l2')]], {
    kind: 'loop',
    loop: { defaultSlideMs: 5000 },
  });
  return resolved(
    [
      item(0, 'd'),
      { id: 'i1', kind: 'media', mediaId: 'vid', onEnd: 'advance' },
      item(2, 'z'),
      item(3, 'e'),
      item(4, 'l'),
    ],
    d,
    z,
    e,
    l,
  );
}

const live = (r = fixture()) => reduce(initialState(), { k: 'goLive', resolved: r });
const go = (s: LiveState, cueIndex: number, at = 1) => reduce(s, { k: 'go', cueIndex, at });
const ok = (s: LiveState) => expect(checkInvariants(s)).toEqual([]);

describe('hidden slides keep flagged cues (design/27 §9)', () => {
  it('flags exactly the hidden slides, with their labels unchanged', () => {
    const s = live();
    expect(s.cues.filter((c) => c.hidden).map((c) => c.index)).toEqual([1, 3, 4, 5, 6, 9, 10, 11, 15]);
    expect(s.cues[1]).toMatchObject({ kind: 'slide', slideId: 'h1', label: 'S0 2', hidden: true });
    ok(s);
  });

  it('arms the first cue that is not hidden at goLive, and nothing when every cue is hidden', () => {
    const r = resolved([item(0, 'e')], deck('e', [[hidden('h4'), shown('e1')]]));
    expect(live(r).armed).toBe(1);
    const all = resolved([item(0, 'z')], deck('z', [[hidden('z1'), hidden('z2')]]));
    const s = live(all);
    expect(s.armed).toBeUndefined();
    // Next has nowhere to go; a GO with an index still shows a hidden slide.
    expect(reduce(s, { k: 'next', at: 1 }).live).toBeUndefined();
    expect(go(s, 1).live).toBe(1);
  });
});

describe('Next and Prev skip hidden cues; a GO with an index reaches them', () => {
  it('Next walks the shown cues only, across items, and arms the next shown one', () => {
    let s = live();
    const walk: [number | undefined, number | undefined][] = [];
    for (let i = 0; i < 11; i++) {
      s = reduce(s, { k: 'next', at: 10 * (i + 1) });
      walk.push([s.live, s.armed]);
      ok(s);
    }
    expect(walk).toEqual([
      [0, 2],
      [2, 7],
      [7, 8],
      [8, 12],
      [12, 13],
      [13, 14],
      [14, 16],
      [16, undefined],
      [16, undefined],
      [16, undefined],
      [16, undefined],
    ]);
  });

  it('Prev walks back over the shown cues only and stops at the first', () => {
    let s = go(live(), 16);
    const walk: (number | undefined)[] = [];
    for (let i = 0; i < 9; i++) {
      s = reduce(s, { k: 'prev', at: 10 * (i + 2) });
      walk.push(s.live);
      ok(s);
    }
    expect(walk).toEqual([14, 13, 12, 8, 7, 2, 0, 0, 0]);
  });

  it('a GO shows a hidden slide (a click in the grid); Next and Prev go on from it', () => {
    let s = go(live(), 1);
    expect(s.live).toBe(1);
    expect(s.layers.slide.content).toMatchObject({ cueIndex: 1, slideId: 'h1' });
    // Arming the next slide that is not hidden: what the outputs preload.
    expect(s.armed).toBe(2);
    expect(reduce(s, { k: 'next', at: 2 }).live).toBe(2);
    expect(reduce(s, { k: 'prev', at: 2 }).live).toBe(0);
    s = go(s, 3);
    expect(s.armed).toBe(7);
    ok(s);
  });

  it("selecting a hidden slide arms it, and GO (the surfaces' 'go') shows it", () => {
    let s = reduce(live(), { k: 'select', cueIndex: 4 });
    expect(s.armed).toBe(4);
    const ev = actionToEvent(s, { id: 'go' }, 5);
    expect(ev).toEqual({ k: 'go', cueIndex: 4, at: 5 });
    s = reduce(s, ev!);
    expect(s.live).toBe(4);
    expect(s.armed).toBe(7);
    // Before the first GO, Next takes the armed cue, hidden or not: the operator picked it.
    expect(reduce(reduce(live(), { k: 'select', cueIndex: 1 }), { k: 'next', at: 1 }).live).toBe(1);
    ok(s);
  });

  it('a slide key (goToSlide) counts hidden slides and shows them', () => {
    const s = go(live(), 0);
    expect(actionToEvent(s, { id: 'goToSlide', arg: 2 }, 3)).toEqual({ k: 'go', cueIndex: 1, at: 3 });
    expect(actionToEvent(s, { id: 'goToSlide', arg: 4 }, 3)).toEqual({ k: 'go', cueIndex: 3, at: 3 });
  });
});

describe('item and section jumps land on the first cue that is not hidden', () => {
  it('Next item skips hidden cues and an item whose slides are all hidden', () => {
    let s = live();
    const walk: (number | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      s = reduce(s, { k: 'nextItem', at: i + 1 });
      walk.push(s.live);
      ok(s);
    }
    expect(walk).toEqual([0, 8, 12, 14, 14, 14]);
    // From a hidden slide of an item, to the next item's first shown cue.
    expect(reduce(go(live(), 6), { k: 'nextItem', at: 9 }).live).toBe(8);
  });

  it('Previous item skips them the same way, and restarts the first item at its first shown cue', () => {
    let s = go(live(), 16);
    const walk: (number | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      s = reduce(s, { k: 'prevItem', at: i + 2 });
      walk.push(s.live);
      ok(s);
    }
    expect(walk).toEqual([12, 8, 0, 0, 0]);
    // From the all-hidden item's slide a click showed, to the item before it.
    expect(reduce(go(live(), 10), { k: 'prevItem', at: 9 }).live).toBe(8);
    // With no item before it, an item whose first slide is hidden restarts at its first shown slide.
    const one = resolved([item(0, 'e')], deck('e', [[hidden('h4'), shown('e1'), shown('e2')]]));
    expect(reduce(go(live(one), 2), { k: 'prevItem', at: 9 }).live).toBe(1);
  });

  it("goToSection lands on the section's first shown cue, or its first cue when all are hidden", () => {
    const s = go(live(), 2);
    expect(reduce(s, { k: 'goToSection', sectionIndex: 0, at: 3 }).live).toBe(0);
    expect(reduce(s, { k: 'goToSection', sectionIndex: 2, at: 3 }).live).toBe(7);
    // The operator named a section whose slides are all hidden: show its first.
    const extras = reduce(s, { k: 'goToSection', sectionIndex: 1, at: 3 });
    expect(extras.live).toBe(4);
    expect(extras.armed).toBe(7);
    ok(extras);
  });
});

describe('auto-advance and onEnd advance skip hidden cues', () => {
  it('a loop advances past its hidden slide and wraps to its first shown one', () => {
    const s = go(live(), 14, 1000);
    expect(autoAdvance(s)).toEqual({ dueAt: 6000, target: 16 });
    expect(autoAdvance(go(s, 16, 2000))).toEqual({ dueAt: 7000, target: 14 });
    // A hidden loop slide a click showed advances too.
    expect(autoAdvance(go(s, 15, 3000))).toEqual({ dueAt: 8000, target: 16 });
  });

  it('wraps to itself when it is the only shown slide, and stops when every slide is hidden', () => {
    const loop = (slides: Slide[]) =>
      live(resolved([item(0, 'l')], deck('l', [slides], { kind: 'loop', loop: { defaultSlideMs: 5000 } })));
    expect(autoAdvance(go(loop([hidden('h'), shown('a'), hidden('k')]), 1))?.target).toBe(1);
    expect(autoAdvance(go(loop([hidden('h'), hidden('k')]), 0))).toBeNull();
  });

  it("onEnd 'advance' goes to the next shown cue, past a whole hidden item", () => {
    let s = go(live(), 8, 100);
    expect(s.layers.media.content).toMatchObject({ cueIndex: 8, onEnd: 'advance' });
    s = reduce(s, { k: 'media.ended', cueIndex: 8, at: 5000 });
    expect(s.live).toBe(12);
    expect(s.armed).toBe(13);
    ok(s);
  });

  it("onEnd 'advance' with only hidden cues after it holds the ended clip", () => {
    const r = resolved(
      [{ id: 'i0', kind: 'media', mediaId: 'vid', onEnd: 'advance' }, item(1, 'z')],
      deck('z', [[hidden('z1')]]),
    );
    let s = go(live(r), 0, 100);
    expect(s.armed).toBeUndefined();
    s = reduce(s, { k: 'media.ended', cueIndex: 0, at: 5000 });
    expect(s.live).toBe(0);
    expect(s.layers.media.content?.state).toBe('ended');
  });
});

describe('a slide sound across a hidden slide (design/27 §8, §9)', () => {
  // 0 a (sound across 2 shown slides: until cue 2), 1 h*, 2 b, 3 c
  const r = () =>
    resolved(
      [item(0, 'd')],
      deck('d', [
        [shown('a', { audio: { mediaId: 'song', slides: 2 } }), hidden('h'), shown('b'), shown('c')],
      ]),
    );

  it('plays on over the shown slides Next reaches, and stops after them', () => {
    let s = go(live(r()), 0, 10);
    expect(s.audio.content).toMatchObject({ mediaId: 'song', cueIndex: 0, untilCue: 2, startedAt: 10 });
    s = reduce(s, { k: 'next', at: 20 });
    expect(s.live).toBe(2);
    expect(s.audio.content).toMatchObject({ mediaId: 'song', startedAt: 10 });
    s = reduce(s, { k: 'next', at: 30 });
    expect(s.audio.content).toBeNull();
    ok(s);
  });

  it('keeps playing when a click shows the hidden slide inside its range', () => {
    let s = go(live(r()), 0, 10);
    s = go(s, 1, 20);
    expect(s.audio.content).toMatchObject({ mediaId: 'song', startedAt: 10 });
    s = reduce(s, { k: 'next', at: 30 });
    expect(s.live).toBe(2);
    expect(s.audio.content).toMatchObject({ mediaId: 'song', startedAt: 10 });
    ok(s);
  });
});

describe('sequential navigation never lands on a hidden cue (property)', () => {
  const r = fixture();
  const at = fc.integer({ min: 0, max: 1e6 });
  const ev: fc.Arbitrary<LiveEvent> = fc.oneof(
    at.map((a) => ({ k: 'next' as const, at: a })),
    at.map((a) => ({ k: 'prev' as const, at: a })),
    at.map((a) => ({ k: 'nextItem' as const, at: a })),
    at.map((a) => ({ k: 'prevItem' as const, at: a })),
    fc.record({ cueIndex: fc.integer({ min: 0, max: 16 }), at }).map((x) => ({ k: 'go' as const, ...x })),
    fc.record({ cueIndex: fc.integer({ min: 0, max: 16 }) }).map((x) => ({ k: 'select' as const, ...x })),
    fc
      .record({ sectionIndex: fc.integer({ min: 0, max: 3 }), at })
      .map((x) => ({ k: 'goToSection' as const, ...x })),
    fc
      .record({ cueIndex: fc.integer({ min: 0, max: 16 }), at })
      .map((x) => ({ k: 'media.ended' as const, ...x })),
  );

  it('Next, Prev, Next item, Previous item and onEnd advance land on shown cues; GO arms a shown one', () => {
    fc.assert(
      fc.property(fc.array(ev, { maxLength: 60 }), (events) => {
        let s = reduce(initialState(), { k: 'goLive', resolved: r });
        for (const e of events) {
          const before = s;
          s = reduce(s, e);
          expect(checkInvariants(s)).toEqual([]);
          if (s.live === before.live) continue;
          // Whatever moved the live cue armed the next shown one.
          if (s.armed !== undefined) expect(s.cues[s.armed]?.hidden).toBeUndefined();
          const sequential =
            e.k === 'prev' ||
            e.k === 'nextItem' ||
            e.k === 'prevItem' ||
            e.k === 'media.ended' ||
            (e.k === 'next' && before.live !== undefined);
          if (sequential) expect(s.cues[s.live!]?.hidden).toBeUndefined();
          const auto = autoAdvance(s);
          if (auto) expect(s.cues[auto.target]?.hidden).toBeUndefined();
        }
      }),
      { numRuns: 300 },
    );
  });

  it('reduceAll agrees with stepping', () => {
    const events: LiveEvent[] = [
      { k: 'next', at: 1 },
      { k: 'go', cueIndex: 5, at: 2 },
      { k: 'next', at: 3 },
      { k: 'nextItem', at: 4 },
    ];
    const s = reduceAll(live(r), events);
    expect([s.live, s.armed]).toEqual([8, 12]);
  });
});
