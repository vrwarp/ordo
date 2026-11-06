/**
 * The three-way merge on a 409 save (design/27 §11 item 17; M4 item H, `views/editor/merge.ts`): two volunteers
 * editing different slides, or different objects of one slide, both keep their work; the same object changed
 * on both sides is a conflict named by its slide number; added slides stay, deleted ones go unless the other
 * side changed them; orders follow the side that changed them. Property tests check the identities (a side
 * that changed nothing takes the other side whole) and that edits to different slides always merge.
 */
import { DEFAULT_THEME, Presentation, type Section, type Slide, type TextObject } from '@ordo/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  describe as describeObject,
  diff3,
  mergeOrder,
  mergeSet,
  mergeThreeWay,
  prepareMerge,
  same,
} from '../src/views/editor/merge.ts';
import {
  addSection,
  deleteObject,
  deleteSection,
  deleteSlide,
  moveSlide,
  renameSection,
  reorderObject,
  updateObject,
  updateSlide,
} from '../src/views/editor/ops.ts';

const box = { x: 100, y: 100, w: 800, h: 300, rotation: 0 };
const text = (id: string, t: string): TextObject => ({
  id,
  type: 'text',
  box,
  text: t,
  style: { ...DEFAULT_THEME.textBoxDefaults },
  opacity: 1,
});

/** Five slides in two sections: a welcome, an announcement (date and place boxes), a verse, two songs. */
const deck = (): Presentation => ({
  id: 'p1',
  rev: 4,
  title: 'Sunday',
  kind: 'slides',
  meta: { author: 'Office', tags: ['sunday'] },
  sections: [
    {
      id: 'sec1',
      label: 'Welcome',
      short: 'W',
      slides: [
        { id: 's1', objects: [text('t1', 'Welcome to Morning Worship')], notes: 'Greet people.' },
        {
          id: 's2',
          objects: [
            text('date', 'Potluck on Sunday 12 May'),
            text('place', 'In the hall'),
            text('logo', 'Logo'),
          ],
          lyricObjectId: 'date',
        },
        { id: 's3', objects: [text('verse', 'For God so loved the world')] },
      ],
    },
    {
      id: 'sec2',
      label: 'Songs',
      short: 'S',
      slides: [
        { id: 's4', objects: [text('song1', 'Amazing grace')] },
        { id: 's5', objects: [text('song2', 'How sweet the sound')] },
      ],
    },
  ],
  arrangements: [{ id: 'arr', name: 'Default', sectionIds: ['sec1', 'sec2'] }],
  archived: false,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-05T10:00:00Z',
});

const setText = (p: Presentation, slideId: string, objectId: string, t: string) =>
  updateObject(p, slideId, objectId, (o) => ({ ...o, text: t }) as TextObject);
const slideIds = (p: Presentation) => p.sections.map((s) => s.slides.map((sl) => sl.id));
const slideOf = (p: Presentation, id: string) => p.sections.flatMap((s) => s.slides).find((s) => s.id === id);
/** Theirs as the hub sends it: saved once more (rev + 1), parsed from JSON (keys in schema order). */
const saved = (p: Presentation): Presentation =>
  Presentation.parse(JSON.parse(JSON.stringify({ ...p, rev: p.rev + 1, updatedAt: '2026-11-06T09:00:00Z' })));
const merged = (base: Presentation, mine: Presentation, theirs: Presentation) => {
  const r = mergeThreeWay(base, mine, theirs);
  expect(r.conflicts).toEqual([]);
  return r.merged!;
};
const whats = (base: Presentation, mine: Presentation, theirs: Presentation) => {
  const r = mergeThreeWay(base, mine, theirs);
  expect(r.merged).toBeUndefined();
  return r.conflicts.map((c) => c.what);
};

describe('JSON equality', () => {
  it('ignores key order and keys holding undefined, and treats null and undefined alike in arrays', () => {
    expect(same({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(same({ a: 1, x: undefined }, { a: 1 })).toBe(true);
    expect(same([undefined, 1], [null, 1])).toBe(true);
    expect(same({ a: null }, {})).toBe(false);
    expect(same([1, 2], [2, 1])).toBe(false);
    expect(same({ a: [1] }, { a: { 0: 1 } })).toBe(false);
    expect(same(0, -0)).toBe(true);
    expect(same('1', 1)).toBe(false);
  });
});

describe('two volunteers, different slides', () => {
  it('keeps both edits, on theirs’ revision', () => {
    const base = deck();
    const mine = setText(base, 's2', 'date', 'Potluck on Sunday 19 May');
    const theirs = saved(setText(base, 's4', 'song1', 'Amazing grace, how sweet'));
    const out = merged(base, mine, theirs);
    expect(out.rev).toBe(5);
    expect(out.updatedAt).toBe('2026-11-06T09:00:00Z');
    expect(out.createdAt).toBe(base.createdAt);
    expect((slideOf(out, 's2')!.objects[0] as TextObject).text).toBe('Potluck on Sunday 19 May');
    expect((slideOf(out, 's4')!.objects[0] as TextObject).text).toBe('Amazing grace, how sweet');
    expect(slideIds(out)).toEqual(slideIds(base));
    expect(Presentation.safeParse(out).success).toBe(true);
  });

  it('keeps mine’s own objects (by reference) where theirs did not change them', () => {
    const base = deck();
    const mine = setText(base, 's2', 'date', 'Potluck on Sunday 19 May');
    const theirs = saved(base);
    const out = merged(base, mine, theirs);
    expect(slideOf(out, 's2')).toBe(slideOf(mine, 's2'));
    expect(same(out.sections, mine.sections)).toBe(true);
  });

  it('merges a slide object by object: different boxes of one slide both change', () => {
    const base = deck();
    const mine = setText(base, 's2', 'date', 'Potluck on Sunday 19 May');
    const theirs = saved(setText(base, 's2', 'place', 'In the church hall'));
    const s2 = slideOf(merged(base, mine, theirs), 's2')!;
    expect(s2.objects.map((o) => (o as TextObject).text)).toEqual([
      'Potluck on Sunday 19 May',
      'In the church hall',
      'Logo',
    ]);
  });

  it('merges slide fields field by field: notes on one side, hidden on the other', () => {
    const base = deck();
    const mine = updateSlide(base, 's3', (s) => ({ ...s, notes: 'Read slowly.' }));
    const theirs = saved(updateSlide(base, 's3', (s) => ({ ...s, hidden: true })));
    const s3 = slideOf(merged(base, mine, theirs), 's3')!;
    expect(s3.notes).toBe('Read slowly.');
    expect(s3.hidden).toBe(true);
  });

  it('merges presentation fields field by field, meta per field and its tags as a set', () => {
    const base = deck();
    const mine = { ...base, title: 'Sunday 19 May', meta: { ...base.meta, tags: ['sunday', 'potluck'] } };
    const theirs = saved({
      ...base,
      meta: { ...base.meta, author: 'Pastor', tags: ['sunday', 'communion'] },
    });
    const out = merged(base, mine, theirs);
    expect(out.title).toBe('Sunday 19 May');
    expect(out.meta).toEqual({ author: 'Pastor', tags: ['sunday', 'potluck', 'communion'] });
    // A tag one side removed goes.
    const gone = merged(
      base,
      { ...base, meta: { ...base.meta, tags: [] } },
      saved({ ...base, title: 'Sun' }),
    );
    expect(gone.meta.tags).toEqual([]);
    expect(gone.title).toBe('Sun');
  });

  it('merges a slide’s theme overrides as a set', () => {
    const base = updateSlide(deck(), 's2', (s) => ({ ...s, overrides: ['box'] }));
    const mine = updateSlide(base, 's2', (s) => ({
      ...s,
      overrides: ['box', 'style.fontSizePx'],
      notes: 'n',
    }));
    const theirs = saved(updateSlide(base, 's2', (s) => ({ ...s, overrides: ['box', 'style.color'] })));
    expect(slideOf(merged(base, mine, theirs), 's2')!.overrides).toEqual([
      'box',
      'style.fontSizePx',
      'style.color',
    ]);
  });

  it('merges the PowerPoint card per field', () => {
    const pptx = { fileId: 'deck', index: 1, class: 'native' as const, version: 1, pending: true };
    const base = updateSlide(deck(), 's2', (s) => ({ ...s, pptx }));
    const mine = updateSlide(base, 's2', (s) => ({ ...s, pptx: { ...pptx, show: 'objects' as const } }));
    const theirs = saved(
      updateSlide(base, 's2', (s) => ({ ...s, pptx: { ...pptx, pending: undefined, refMediaId: 'ref' } })),
    );
    expect(slideOf(merged(base, mine, theirs), 's2')!.pptx).toEqual({
      fileId: 'deck',
      index: 1,
      class: 'native',
      version: 1,
      show: 'objects',
      refMediaId: 'ref',
    });
  });

  it('takes a version two volunteers changed the same way', () => {
    const base = deck();
    const mine = setText(base, 's2', 'date', 'Potluck on Sunday 19 May');
    const theirs = saved(mine);
    expect(same(merged(base, mine, theirs).sections, mine.sections)).toBe(true);
  });
});

describe('conflicts, by slide number', () => {
  it('the same object changed differently on both sides', () => {
    const base = deck();
    const mine = setText(base, 's2', 'date', 'Potluck on Sunday 19 May');
    const theirs = saved(setText(base, 's2', 'date', 'Potluck on Saturday 18 May'));
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.merged).toBeUndefined();
    expect(r.conflicts).toEqual([
      {
        level: 'object',
        key: 'date',
        slideId: 's2',
        objectId: 'date',
        what: 'Slide 2: both changed the text box “Potluck on Sunday 12 May”',
      },
    ]);
  });

  it('a slide field changed differently on both sides', () => {
    const base = deck();
    const mine = updateSlide(base, 's5', (s) => ({ ...s, notes: 'Mine' }));
    const theirs = saved(updateSlide(base, 's5', (s) => ({ ...s, notes: 'Theirs' })));
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.conflicts).toEqual([
      { level: 'slide', key: 's5.notes', slideId: 's5', what: 'Slide 5: both changed the notes' },
    ]);
  });

  it('a presentation field changed differently on both sides', () => {
    const base = deck();
    const r = mergeThreeWay(base, { ...base, title: 'A' }, saved({ ...base, title: 'B' }));
    expect(r.conflicts).toEqual([
      { level: 'presentation', key: 'title', what: 'Presentation: both changed the title' },
    ]);
    expect(
      whats(
        base,
        { ...base, meta: { ...base.meta, author: 'A' } },
        saved({ ...base, meta: { ...base.meta, author: 'B' } }),
      ),
    ).toEqual(['Presentation: both changed the author']);
  });

  it('an object deleted on one side and changed on the other', () => {
    const base = deck();
    const mine = deleteObject(base, 's2', 'place');
    const theirs = saved(setText(base, 's2', 'place', 'In the church hall'));
    expect(whats(base, mine, theirs)).toEqual([
      'Slide 2: you deleted the text box “In the hall” and they changed it',
    ]);
    expect(whats(base, theirs, saved(mine))).toEqual([
      'Slide 2: they deleted the text box “In the hall” and you changed it',
    ]);
  });

  it('a slide deleted on one side and changed on the other', () => {
    const base = deck();
    const mine = deleteSlide(base, 's3');
    const theirs = saved(setText(base, 's3', 'verse', 'For God so loved the world, that he gave'));
    expect(whats(base, mine, theirs)).toEqual(['Slide 3: you deleted it and they changed it']);
  });

  it('a section deleted on one side and renamed on the other, or given a slide', () => {
    const base = deck();
    const mine = deleteSection(base, 'sec2');
    expect(whats(base, mine, saved(renameSection(base, 'sec2', 'Hymns', 'H')))).toEqual([
      'Section “Hymns”: you deleted it and they changed it',
    ]);
    const added = updateSlide(base, 's5', (s) => s);
    const withSlide = {
      ...added,
      sections: added.sections.map((s) =>
        s.id === 'sec2' ? { ...s, slides: [...s.slides, { id: 'new', objects: [] }] } : s,
      ),
    };
    expect(whats(base, mine, saved(withSlide))).toEqual([
      'Slide 6: they put it in the section “Songs”, which you deleted',
    ]);
    // Changed slides of the deleted section say so.
    expect(whats(base, mine, saved(setText(base, 's4', 'song1', 'Amazing grace!')))).toEqual([
      'Slide 4: you deleted it with its section “Songs” and they changed it',
    ]);
  });

  it('both reordering the same list differently', () => {
    const base = deck();
    const mine = moveSlide(base, 's3', 'sec1', 0);
    const theirs = saved(moveSlide(base, 's1', 'sec1', 2));
    expect(whats(base, mine, theirs)).toEqual(['Section “Welcome”: both changed the order of its slides']);
    const zMine = reorderObject(base, 's2', 'date', 'front');
    const zTheirs = saved(reorderObject(base, 's2', 'logo', 'back'));
    expect(
      whats(base, setText(zMine, 's2', 'place', 'x'), saved(setText(zTheirs, 's2', 'date', 'y'))),
    ).toEqual(['Slide 2: both changed which object is in front of which']);
    const three = addSection(base, 'Sending', 'X', DEFAULT_THEME);
    const [a, b, c] = three.sections as [Section, Section, Section];
    expect(whats(three, { ...three, sections: [c, a, b] }, saved({ ...three, sections: [b, a, c] }))).toEqual(
      ['Both changed the order of the sections'],
    );
  });

  it('a slide moved to different sections on both sides', () => {
    const base = addSection(deck(), 'Sending', 'X', DEFAULT_THEME);
    const third = base.sections[2]!.id;
    const mine = moveSlide(base, 's3', 'sec2', 0);
    const theirs = saved(moveSlide(base, 's3', third, 0));
    expect(whats(base, mine, theirs)).toEqual(['Slide 3: both moved it, to different sections']);
  });

  it('a presentation with a repeated id is not merged', () => {
    const base = deck();
    const twice = updateSlide(base, 's1', (s) => ({ ...s, objects: [...s.objects, s.objects[0]!] }));
    expect(mergeThreeWay(base, twice, saved(base)).conflicts[0]!.what).toMatch(/repeats/);
  });

  it('a merge that would not be a valid presentation is not merged', () => {
    const base = deck();
    const many = (side: string, n: number) =>
      updateSlide(base, 's3', (s) => ({
        ...s,
        objects: [...s.objects, ...Array.from({ length: n }, (_, i) => text(`${side}${i}`, 'x'))],
      }));
    expect(mergeThreeWay(base, many('m', 600), saved(many('t', 600))).conflicts[0]!.what).toMatch(
      /too large/,
    );
  });
});

describe('structure', () => {
  it('keeps slides added on both sides; mine’s after theirs’ at the same place', () => {
    const base = deck();
    const ins = (p: Presentation, after: string, id: string) => ({
      ...p,
      sections: p.sections.map((s) => {
        const i = s.slides.findIndex((x) => x.id === after);
        if (i < 0) return s;
        const slides = [...s.slides];
        slides.splice(i + 1, 0, { id, objects: [text(`${id}-t`, id)] });
        return { ...s, slides };
      }),
    });
    const out = merged(base, ins(base, 's1', 'mine'), saved(ins(ins(base, 's1', 'theirs'), 's5', 'end')));
    expect(slideIds(out)).toEqual([
      ['s1', 'theirs', 'mine', 's2', 's3'],
      ['s4', 's5', 'end'],
    ]);
  });

  it('deletes a slide one side deleted and the other did not change (a move is not a change)', () => {
    const base = deck();
    const out = merged(base, deleteSlide(base, 's3'), saved(moveSlide(base, 's3', 'sec1', 0)));
    expect(slideIds(out)).toEqual([
      ['s1', 's2'],
      ['s4', 's5'],
    ]);
  });

  it('a slide moved to another section on one side and changed on the other keeps both', () => {
    const base = deck();
    const mine = moveSlide(base, 's3', 'sec2', 1);
    const theirs = saved(setText(base, 's3', 'verse', 'For God so loved the world, that he gave'));
    const out = merged(base, mine, theirs);
    expect(slideIds(out)).toEqual([
      ['s1', 's2'],
      ['s4', 's3', 's5'],
    ]);
    expect((slideOf(out, 's3')!.objects[0] as TextObject).text).toMatch(/that he gave/);
  });

  it('follows the side that reordered: slides on one side, sections on the other', () => {
    const base = deck();
    const mine = moveSlide(base, 's1', 'sec1', 2);
    const theirs = saved({ ...base, sections: [...base.sections].reverse() });
    expect(slideIds(merged(base, mine, theirs))).toEqual([
      ['s4', 's5'],
      ['s2', 's3', 's1'],
    ]);
  });

  it('keeps objects added on both sides, mine on top', () => {
    const base = deck();
    const add = (p: Presentation, id: string) =>
      updateSlide(p, 's2', (s) => ({ ...s, objects: [...s.objects, text(id, id)] }));
    const out = merged(base, add(base, 'mine'), saved(add(base, 'theirs')));
    expect(slideOf(out, 's2')!.objects.map((o) => o.id)).toEqual(['date', 'place', 'logo', 'theirs', 'mine']);
  });

  it('a z-order change on one side and a text change on the other', () => {
    const base = deck();
    const out = merged(
      base,
      reorderObject(base, 's2', 'date', 'front'),
      saved(setText(base, 's2', 'logo', 'Our logo')),
    );
    expect(slideOf(out, 's2')!.objects.map((o) => `${o.id}:${(o as TextObject).text}`)).toEqual([
      'place:In the hall',
      'logo:Our logo',
      'date:Potluck on Sunday 12 May',
    ]);
  });

  it('clears a lyric box that went', () => {
    const base = deck();
    const mine = updateSlide(base, 's2', (s) => ({ ...s, lyricObjectId: 'place' }));
    const theirs = saved(deleteObject(base, 's2', 'place'));
    const s2 = slideOf(merged(base, mine, theirs), 's2')!;
    expect(s2.objects.map((o) => o.id)).toEqual(['date', 'logo']);
    expect(s2.lyricObjectId).toBeUndefined();
  });

  it('two sections added at once both stay, in the sections and the default arrangement', () => {
    const base = deck();
    const mine = addSection(base, 'Offering', 'O', DEFAULT_THEME);
    const theirs = saved(addSection(base, 'Sending', 'X', DEFAULT_THEME));
    const out = merged(base, mine, theirs);
    const [o, x] = [mine.sections[2]!.id, theirs.sections[2]!.id];
    expect(out.sections.map((s) => s.id)).toEqual(['sec1', 'sec2', x, o]);
    expect(out.arrangements[0]!.sectionIds).toEqual(['sec1', 'sec2', x, o]);
  });

  it('a deleted section leaves the arrangements', () => {
    const base = deck();
    const arr2 = {
      ...base,
      arrangements: [...base.arrangements, { id: 'arr2', name: 'Short', sectionIds: ['sec2'] }],
    };
    const mine = deleteSection(arr2, 'sec2');
    const theirs = saved({
      ...arr2,
      arrangements: [
        arr2.arrangements[0]!,
        { id: 'arr2', name: 'Short', sectionIds: ['sec2', 'sec1', 'sec2'] },
      ],
    });
    // Theirs changed 'Short'; mine dropped sec2 from it: both changed it differently.
    expect(whats(arr2, mine, theirs)).toEqual(['Arrangement “Short”: both changed its sections']);
    const out = merged(arr2, mine, saved({ ...arr2, title: 'Sunday 19 May' }));
    expect(out.arrangements).toEqual([
      { id: 'arr', name: 'Default', sectionIds: ['sec1'] },
      { id: 'arr2', name: 'Short', sectionIds: [] },
    ]);
  });

  it('an arrangement renamed on one side and reordered on the other', () => {
    const base = deck();
    const mine = { ...base, arrangements: [{ id: 'arr', name: 'Sunday', sectionIds: ['sec1', 'sec2'] }] };
    const theirs = saved({
      ...base,
      arrangements: [{ id: 'arr', name: 'Default', sectionIds: ['sec1', 'sec2', 'sec1'] }],
    });
    expect(merged(base, mine, theirs).arrangements).toEqual([
      { id: 'arr', name: 'Sunday', sectionIds: ['sec1', 'sec2', 'sec1'] },
    ]);
  });
});

describe('the list merges', () => {
  it('mergeOrder follows the side that reordered and places additions after their neighbour', () => {
    const keep = (...ids: string[]) => new Set(ids);
    // Theirs added d after c; mine moved c to the front: d stays after c.
    expect(
      mergeOrder(['a', 'b', 'c'], ['c', 'a', 'b'], ['a', 'b', 'c', 'd'], keep('a', 'b', 'c', 'd')),
    ).toEqual(['c', 'd', 'a', 'b']);
    expect(mergeOrder(['a', 'b'], ['a', 'x', 'b'], ['b', 'a'], keep('a', 'b', 'x'))).toEqual(['b', 'a', 'x']);
    expect(mergeOrder(['a', 'b'], ['x', 'a', 'b'], ['y', 'a', 'b'], keep('a', 'b', 'x', 'y'))).toEqual([
      'y',
      'x',
      'a',
      'b',
    ]);
    expect(mergeOrder(['a', 'b', 'c'], ['b', 'a', 'c'], ['a', 'c', 'b'], keep('a', 'b', 'c'))).toBeNull();
    expect(mergeOrder(['a', 'b', 'c'], ['b', 'a', 'c'], ['b', 'a', 'c'], keep('a', 'b', 'c'))).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('diff3 merges sequences with repeats', () => {
    expect(diff3(['v', 'c'], ['v', 'c', 'v', 'c'], ['i', 'v', 'c'])).toEqual(['i', 'v', 'c', 'v', 'c']);
    expect(diff3(['v', 'c'], ['v', 'c', 'x'], ['v', 'c', 'y'])).toEqual(['v', 'c', 'y', 'x']);
    expect(diff3(['v', 'c', 'b'], ['v', 'b'], ['v', 'c', 'b', 'c'])).toEqual(['v', 'b', 'c']);
    expect(diff3(['v', 'c'], ['v', 'x'], ['v', 'y'])).toBeNull();
    expect(diff3(['v'], ['v'], ['v'])).toEqual(['v']);
    expect(diff3([], ['a'], [])).toEqual(['a']);
  });

  it('mergeSet adds what either side added and drops what either removed', () => {
    expect(mergeSet(['a', 'b'], ['a', 'b', 'c'], ['b', 'd'])).toEqual(['b', 'c', 'd']);
  });
});

describe('what the volunteer is told', () => {
  it('names objects as they are seen', () => {
    expect(describeObject(text('t', '\n  Welcome   to\tworship \nsecond'))).toBe(
      'the text box “Welcome to worship”',
    );
    expect(describeObject(text('t', ''))).toBe('an empty text box');
    expect(describeObject(text('t', 'x'.repeat(50)))).toBe(`the text box “${'x'.repeat(31)}…”`);
    const pic = { id: 'i', type: 'image', box, mediaId: 'm', fit: 'cover', opacity: 1, radius: 0 } as const;
    expect(describeObject(pic)).toBe('the picture');
    expect(describeObject({ ...pic, origin: { src: 'pptx', role: 'bg' } })).toBe('the background picture');
    expect(describeObject({ ...pic, play: { mediaId: 'v' } } as never)).toBe('the video');
    expect(describeObject({ id: 's', type: 'shape', box, shape: 'ellipse', opacity: 1, radius: 0 })).toBe(
      'the ellipse',
    );
  });
});

// ---- properties ----------------------------------------------------------------------------------------------

/** An edit a volunteer makes, by position (taken modulo what is there). */
type Edit =
  | { k: 'text'; slide: number; obj: number; text: string }
  | { k: 'notes'; slide: number; text: string }
  | { k: 'addObject'; slide: number }
  | { k: 'deleteObject'; slide: number; obj: number }
  | { k: 'addSlide'; section: number; at: number }
  | { k: 'deleteSlide'; slide: number }
  | { k: 'moveSlide'; slide: number; section: number; at: number }
  | { k: 'front'; slide: number; obj: number }
  | { k: 'rename'; section: number; text: string }
  | { k: 'title'; text: string };

const word = fc.constantFrom('grace', 'hope', 'peace', 'joy', '', 'Sunday 19 May');
const editArb: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({ k: fc.constant('text' as const), slide: fc.nat(20), obj: fc.nat(5), text: word }),
  fc.record({ k: fc.constant('notes' as const), slide: fc.nat(20), text: word }),
  fc.record({ k: fc.constant('addObject' as const), slide: fc.nat(20) }),
  fc.record({ k: fc.constant('deleteObject' as const), slide: fc.nat(20), obj: fc.nat(5) }),
  fc.record({ k: fc.constant('addSlide' as const), section: fc.nat(3), at: fc.nat(6) }),
  fc.record({ k: fc.constant('deleteSlide' as const), slide: fc.nat(20) }),
  fc.record({ k: fc.constant('moveSlide' as const), slide: fc.nat(20), section: fc.nat(3), at: fc.nat(6) }),
  fc.record({ k: fc.constant('front' as const), slide: fc.nat(20), obj: fc.nat(5) }),
  fc.record({ k: fc.constant('rename' as const), section: fc.nat(3), text: word }),
  fc.record({ k: fc.constant('title' as const), text: word }),
);

const allSlides = (p: Presentation): Slide[] => p.sections.flatMap((s) => s.slides);

/**
 * Apply edits as the editor's ops do; `side` names the ids it adds (never the other side's), `only` limits
 * the slides it may touch (by base id; slides it added are its own).
 */
function apply(
  p: Presentation,
  edits: readonly Edit[],
  side: string,
  only?: (id: string) => boolean,
): Presentation {
  let n = 0;
  const fresh = () => `${side}#${n++}`;
  const own = (id: string) => !only || only(id) || id.startsWith(side);
  for (const e of edits) {
    const slides = allSlides(p).filter((s) => own(s.id));
    const sl = 'slide' in e && slides.length ? slides[e.slide % slides.length] : undefined;
    const obj = sl && 'obj' in e && sl.objects.length ? sl.objects[e.obj % sl.objects.length] : undefined;
    switch (e.k) {
      case 'text':
        if (sl && obj?.type === 'text') p = setText(p, sl.id, obj.id, `${obj.text} ${e.text}`.trim() || side);
        break;
      case 'notes':
        if (sl) p = updateSlide(p, sl.id, (s) => ({ ...s, notes: `${side} ${e.text}` }));
        break;
      case 'addObject':
        if (sl) p = updateSlide(p, sl.id, (s) => ({ ...s, objects: [...s.objects, text(fresh(), side)] }));
        break;
      case 'deleteObject':
        if (sl && obj) p = deleteObject(p, sl.id, obj.id);
        break;
      case 'addSlide': {
        if (!p.sections.length) break;
        const si = e.section % p.sections.length;
        const id = fresh();
        p = {
          ...p,
          sections: p.sections.map((s, i) => {
            if (i !== si) return s;
            const slides = [...s.slides];
            slides.splice(e.at % (slides.length + 1), 0, { id, objects: [text(fresh(), id)] });
            return { ...s, slides };
          }),
        };
        break;
      }
      case 'deleteSlide':
        if (sl) p = deleteSlide(p, sl.id);
        break;
      case 'moveSlide':
        if (sl && p.sections.length)
          p = moveSlide(p, sl.id, p.sections[e.section % p.sections.length]!.id, e.at);
        break;
      case 'front':
        if (sl && obj) p = reorderObject(p, sl.id, obj.id, 'front');
        break;
      case 'rename':
        if (!only && p.sections.length) {
          const s = p.sections[e.section % p.sections.length]!;
          p = renameSection(p, s.id, `${s.label} ${e.text}`.trim(), s.short);
        }
        break;
      case 'title':
        if (!only) p = { ...p, title: `${side} ${e.text}` };
        break;
    }
  }
  return p;
}

const content = (p: Presentation) => {
  const { rev: _r, createdAt: _c, updatedAt: _u, ...rest } = p;
  return rest;
};
/** The slides by id, each with its objects by id: content regardless of order. */
const bySlide = (p: Presentation) =>
  new Map(
    allSlides(p).map((s) => [s.id, { ...s, objects: [...s.objects].sort((a, b) => (a.id < b.id ? -1 : 1)) }]),
  );
const slideRecord = (p: Presentation) => Object.fromEntries(bySlide(p));
const editsArb = fc.array(editArb, { maxLength: 8 });
const RUNS = 1500;

describe('merge properties', () => {
  it('a side that changed nothing takes the other whole; both changed the same way keeps it', () => {
    fc.assert(
      fc.property(editsArb, (edits) => {
        const base = deck();
        const x = apply(base, edits, 'x');
        expect(same(content(merged(base, x, saved(base))), content(x))).toBe(true);
        expect(same(content(merged(base, base, saved(x))), content(saved(x)))).toBe(true);
        expect(same(content(merged(base, x, saved(x))), content(x))).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('edits to different slides always merge, each slide as the side that changed it', () => {
    const base = deck();
    const ids = allSlides(base).map((s) => s.id);
    const mineOnly = (id: string) => ids.indexOf(id) % 2 === 0;
    const theirsOnly = (id: string) => ids.indexOf(id) % 2 === 1;
    const noMoves = fc.array(
      editArb.filter((e) => e.k !== 'moveSlide' && e.k !== 'front'),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(noMoves, noMoves, (em, et) => {
        const mine = apply(base, em, 'm', mineOnly);
        const theirs = saved(apply(base, et, 't', theirsOnly));
        const out = merged(base, mine, theirs);
        expect(Presentation.safeParse(out).success).toBe(true);
        const m = bySlide(mine);
        const t = bySlide(theirs);
        const o = bySlide(out);
        for (const id of ids) {
          const want = mineOnly(id) ? m.get(id) : t.get(id);
          expect(same(o.get(id), want), id).toBe(true);
        }
        for (const id of [...m.keys(), ...t.keys()].filter((id) => !ids.includes(id)))
          expect(same(o.get(id), m.get(id) ?? t.get(id)), id).toBe(true);
        // Each side's own order of its slides holds in the merge.
        for (const side of [mine, theirs]) {
          const order = allSlides(side).map((s) => s.id);
          const kept = allSlides(out)
            .map((s) => s.id)
            .filter((id) => order.includes(id));
          expect(kept).toEqual(order.filter((id) => o.has(id)));
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('merges the same whichever side is mine, valid and without repeated ids', () => {
    fc.assert(
      fc.property(editsArb, editsArb, (em, et) => {
        const base = deck();
        const mine = apply(base, em, 'm');
        const theirs = apply(base, et, 't');
        const a = mergeThreeWay(base, mine, saved(theirs));
        const b = mergeThreeWay(base, theirs, saved(mine));
        expect(!!a.merged).toBe(!!b.merged);
        if (!a.merged || !b.merged) {
          expect(a.conflicts.length).toBeGreaterThan(0);
          return;
        }
        expect(Presentation.safeParse(a.merged).success).toBe(true);
        const ids = allSlides(a.merged).map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(same(slideRecord(a.merged), slideRecord(b.merged))).toBe(true);
        expect(
          same(a.merged.sections.map((s) => s.id).sort(), b.merged.sections.map((s) => s.id).sort()),
        ).toBe(true);
        // Every slide either side added is kept.
        const baseIds = new Set(allSlides(base).map((s) => s.id));
        for (const s of [...allSlides(mine), ...allSlides(theirs)])
          if (!baseIds.has(s.id)) expect(ids).toContain(s.id);
      }),
      { numRuns: RUNS },
    );
  });

  it('a prepared merge gives what a fresh one does, draft after draft', () => {
    fc.assert(
      fc.property(editsArb, fc.array(editsArb, { minLength: 1, maxLength: 4 }), (et, drafts) => {
        const base = deck();
        const theirs = saved(apply(base, et, 't'));
        const prepared = prepareMerge(base, theirs);
        let mine = base;
        for (const edits of drafts) {
          mine = apply(mine, edits, `m${drafts.indexOf(edits)}-`);
          const fresh = mergeThreeWay(base, mine, theirs);
          const again = prepared(mine);
          expect(again.conflicts).toEqual(fresh.conflicts);
          expect(same(again.merged, fresh.merged)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});
