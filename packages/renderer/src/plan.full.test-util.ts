import {
  type LiveState,
  type Presentation,
  type ResolvedPlaylist,
  type Slide,
  type SlideObject,
  expandCues,
} from '@ordo/domain';
import { liveState, resolved } from './fixtures.test-util.ts';
import { picture, seeded, square, textBox } from './frame.test-util.ts';

/*
 * Slides for the descriptor equality test (plan.full.test.ts): the same generator ran on the base build (r2b2-base)
 * to record the digests of what it planned, so a change to the planner shows on any ordinary slide.
 */

/** 100 ordinary slides: up to 200 objects and 16 distinct pictures, a seeded mix of texts, squares and pictures. */
export function ordinarySlides(): Slide[] {
  const rnd = seeded(7_031_977);
  const out: Slide[] = [];
  for (let k = 0; k < 100; k++) {
    const n = k < 10 ? 200 : 1 + Math.floor(rnd() * 60);
    const media = k >= 10 && k < 15 ? 16 : 1 + Math.floor(rnd() * 8);
    const objs: SlideObject[] = [];
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (r < 0.1 || (k >= 10 && k < 15 && i < 16))
        objs.push(
          picture(`p${i}`, `m${k >= 10 && k < 15 ? i % 16 : Math.floor(rnd() * media)}`, {
            x: Math.floor(rnd() * 1500),
            y: Math.floor(rnd() * 800),
            w: 60 + Math.floor(rnd() * 400),
            h: 60 + Math.floor(rnd() * 300),
          }),
        );
      else if (r < 0.6) objs.push(square(i));
      else objs.push(textBox(`t${i}`, `Line ${i} of slide ${k}`, 40, 40 + (i % 20) * 50, 1500, 45));
    }
    out.push({ id: `ord${k}`, objects: objs, lyricObjectId: objs.find((o) => o.type === 'text')?.id });
  }
  return out;
}

/** The live state with `slide` live in a presentation of its own. */
export function stateOf(slide: Slide): LiveState {
  const pres: Presentation = {
    id: 'crowd',
    rev: 1,
    title: 'Crowd',
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: 'm', label: 'Main', short: 'M', slides: [slide] }],
    arrangements: [],
    archived: false,
  };
  const r: ResolvedPlaylist = {
    ...resolved,
    playlist: { ...resolved.playlist, items: [{ id: 'i1', kind: 'presentation', presentationId: 'crowd' }] },
    presentations: { crowd: pres },
  };
  const cues = expandCues(r);
  const base = liveState({ resolved: r, cues });
  return {
    ...base,
    live: 0,
    layers: {
      ...base.layers,
      slide: {
        content: { kind: 'slide' as const, cueIndex: 0, presentationId: 'crowd', slideId: slide.id },
        at: 1,
        seq: 1,
      },
    },
  };
}
