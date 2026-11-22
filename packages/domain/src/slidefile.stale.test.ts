import { describe, expect, it } from 'vitest';
import type { Presentation, Slide, SlideObject } from './schemas.ts';
import { staleStandIns } from './slidefile.ts';

/*
 * `staleStandIns` (import-files step 1(c), C-IF5): the slides of a presentation whose stand-in was changed beside its
 * slide file. A stand-in edited while its file stays leaves the key and the picture unchanged (the key is computed
 * from the FILE), so the screens would show the old content: the editor and the hub refuse such a change. Slide-level
 * fields (notes, timing, transition, hidden, MIDI cues, sound, the bottom-third words) are not objects and stay
 * editable.
 */

const REF = 'a'.repeat(64);
const REF2 = 'b'.repeat(64);

const box = { x: 0, y: 0, w: 100, h: 20, rotation: 0 };
const rect = (id: string, x = 0): SlideObject =>
  ({
    id,
    type: 'shape',
    box: { ...box, x },
    shape: 'rect',
    fill: { r: 1, g: 2, b: 3, a: 1 },
    opacity: 1,
    radius: 0,
  }) as SlideObject;

/** A file-form slide: a stand-in of `n` objects with a record that names its file. */
function fileSlide(id: string, n = 3, ref = REF): Slide {
  return {
    id,
    objects: Array.from({ length: n }, (_, i) => rect(`${id}-${i}`, i)),
    prerender: { why: ['count'], file: { ref, bytes: 1000 }, live: [] },
  } as Slide;
}
const plainSlide = (id: string): Slide => ({ id, objects: [rect(`${id}-0`)] }) as Slide;

function presentationOf(...slides: Slide[]): Presentation {
  return {
    id: 'p',
    rev: 1,
    title: 'T',
    sections: [{ id: 'sec', label: 'Slides', short: 'S', slides }],
  } as unknown as Presentation;
}
/** A copy with no object shared with the original: what the hub's parse of the stored copy is to a PUT body. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const withSlide = (p: Presentation, i: number, fn: (s: Slide) => Slide): Presentation => ({
  ...p,
  sections: [{ ...p.sections[0]!, slides: p.sections[0]!.slides.map((s, j) => (j === i ? fn(s) : s)) }],
});

describe('staleStandIns (ST1-ST8)', () => {
  it('ST1 lists nothing for an unchanged presentation (the same objects, and a deep copy)', () => {
    const p = presentationOf(fileSlide('a'), plainSlide('b'), fileSlide('c', 5, REF2));
    expect(staleStandIns(p, p)).toEqual([]);
    expect(staleStandIns(p, clone(p))).toEqual([]);
    expect(staleStandIns(undefined, p)).toEqual([]);
  });

  it('ST2 lists a file-form slide whose stand-in has one moved object, by slide id, once', () => {
    const p = presentationOf(fileSlide('a'), plainSlide('b'));
    const moved = withSlide(p, 0, (s) => ({
      ...s,
      objects: s.objects.map((o, i) => (i === 1 ? { ...o, box: { ...o.box, x: 99 } } : o)),
    }));
    expect(staleStandIns(p, moved)).toEqual([{ slideId: 'a' }]);
    expect(staleStandIns(p, clone(moved))).toEqual([{ slideId: 'a' }]);
    // a deleted object and an added one are changes of the stand-in too
    expect(
      staleStandIns(
        p,
        withSlide(p, 0, (s) => ({ ...s, objects: s.objects.slice(1) })),
      ),
    ).toEqual([{ slideId: 'a' }]);
    expect(
      staleStandIns(
        p,
        withSlide(p, 0, (s) => ({ ...s, objects: [...s.objects, rect('new')] })),
      ),
    ).toEqual([{ slideId: 'a' }]);
  });

  it('ST3 does not list a slide whose file ref changed together with its objects (a new file was made for it)', () => {
    const p = presentationOf(fileSlide('a'));
    const next = withSlide(p, 0, () => fileSlide('a', 4, REF2));
    expect(staleStandIns(p, next)).toEqual([]);
  });

  it('ST4 does not list a slide whose file link was removed (it is an ordinary slide now)', () => {
    const p = presentationOf(fileSlide('a'));
    const next = withSlide(p, 0, (s) => {
      const { prerender: _p, ...rest } = s;
      return { ...rest, objects: [rect('only')] } as Slide;
    });
    expect(staleStandIns(p, next)).toEqual([]);
  });

  it('ST5 does not list changed notes, durationMs, transition, hidden, midiCues, audio or bottomThirdText', () => {
    const p = presentationOf(fileSlide('a'));
    const edited = withSlide(p, 0, (s) => ({
      ...s,
      notes: 'a new note',
      durationMs: 5000,
      transition: { kind: 'crossfade', ms: 300 },
      hidden: true,
      midiCues: [],
      audio: { mediaId: 'sound' },
      bottomThirdText: 'Welcome',
    })) as Presentation;
    expect(staleStandIns(p, edited)).toEqual([]);
    expect(staleStandIns(p, clone(edited))).toEqual([]);
  });

  it('ST6 does not list a new file-form slide, nor a slide that has no file in the stored copy', () => {
    const p = presentationOf(plainSlide('b'));
    const added = presentationOf(plainSlide('b'), fileSlide('new'));
    expect(staleStandIns(p, added)).toEqual([]);
    // an ordinary slide that gains a file link in the same save is not a stale stand-in either
    const linked = presentationOf({ ...fileSlide('b', 9) });
    expect(staleStandIns(p, linked)).toEqual([]);
  });

  it('ST7 lists a slide whose objects were only reordered', () => {
    const p = presentationOf(fileSlide('a', 4));
    const reordered = withSlide(p, 0, (s) => ({ ...s, objects: [...s.objects].reverse() }));
    expect(staleStandIns(p, reordered)).toEqual([{ slideId: 'a' }]);
    expect(staleStandIns(p, clone(reordered))).toEqual([{ slideId: 'a' }]);
  });

  it('ST8 compares 200 slides of 200 objects each fast, as a deep copy and as the same objects (time printed)', () => {
    const slides = Array.from({ length: 200 }, (_, i) => fileSlide(`s${i}`, 200, REF));
    const p = presentationOf(...slides);
    const copy = clone(p);
    const t0 = performance.now();
    const same = staleStandIns(p, p);
    const t1 = performance.now();
    const deep = staleStandIns(p, copy);
    const t2 = performance.now();
    expect(same).toEqual([]);
    expect(deep).toEqual([]);
    // the one slide among 200 that changed is the one listed
    const changed = withSlide(copy, 120, (s) => ({
      ...s,
      objects: s.objects.map((o, i) => (i === 199 ? { ...o, opacity: 0.5 } : o)),
    }));
    expect(staleStandIns(p, changed)).toEqual([{ slideId: 's120' }]);
    console.log(
      `ST8: 200 slides x 200 objects: same objects ${(t1 - t0).toFixed(2)} ms, deep copy ${(t2 - t1).toFixed(2)} ms`,
    );
  });

  it('is not fooled by key order or an undefined key (a stored document is JSON)', () => {
    const p = presentationOf(fileSlide('a'));
    const reorderKeys = (o: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(o).reverse());
    const next = withSlide(p, 0, (s) => ({
      ...s,
      objects: s.objects.map(
        (o) => ({ ...reorderKeys(o as never), locked: undefined }) as unknown as SlideObject,
      ),
    }));
    expect(staleStandIns(p, next)).toEqual([]);
  });

  it('copes with a slide id used twice and with a slide in another section', () => {
    const p = presentationOf(fileSlide('a'), fileSlide('a'));
    expect(staleStandIns(p, p)).toEqual([]);
    const moved: Presentation = {
      ...p,
      sections: [
        { id: 'one', label: 'One', short: 'O', slides: [p.sections[0]!.slides[0]!] },
        {
          id: 'two',
          label: 'Two',
          short: 'T',
          slides: [{ ...p.sections[0]!.slides[1]!, objects: [rect('changed')] }],
        },
      ],
    } as Presentation;
    // the first copy equals its stored twin, the second was changed beside the file: the id is listed, once
    expect(staleStandIns(p, moved)).toEqual([{ slideId: 'a' }]);
  });
});
