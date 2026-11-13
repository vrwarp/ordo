/**
 * The slide and presentation ops of the editor for churches (M4 item E; design/27 §11 items 6-11, §14 item
 * 9): find and replace keeping formatting, hide and unhide, the background replace (this slide or every
 * slide using it, never distorted), 'Apply to similar boxes', 'New slide like this' and 'Use as
 * background', with the store actions that apply them (one undo step each).
 */
import {
  DEFAULT_THEME,
  editText,
  type ImageObject,
  Presentation,
  type ShapeObject,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextRun,
} from '@ordo/domain';
import { importPro7, pro7Type } from '@ordo/importers';
import fc from 'fast-check';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { useLibrary } from '../src/state/library.ts';
import * as actions from '../src/views/editor/actions.ts';
import { BackgroundReplaceView, ReplaceOnAllSlidesView } from '../src/views/editor/BackgroundReplace.tsx';
import {
  FindReplaceView,
  type FindReplaceViewProps,
  findRows,
  goToMatch,
  LIST_LIMIT,
  matchSummary,
  replacedMessage,
  unseenSlides,
} from '../src/views/editor/FindReplaceDialog.tsx';
import { ObjectSlideOpsView, similarQuestion } from '../src/views/editor/ObjectSlideOps.tsx';
import { HIDDEN_DIM, HideSlideToggle } from '../src/views/editor/SlidesPanel.tsx';
import {
  openPresentation,
  selectObject,
  selectSlide,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import { getSlide } from '../src/views/editor/ops.ts';
import {
  applyStyleToSimilar,
  changedPart,
  coversSlide,
  deckBackground,
  findReplace,
  findText,
  hideSlide,
  MAX_PARAS,
  MAX_SECTION_SLIDES,
  MAX_TEXT,
  matchesIn,
  newSlideLike,
  replaceBackground,
  replaceBackgroundOf,
  replacePicture,
  similarObjects,
  slideBackground,
  slidesUsingBackground,
  useAsBackground,
} from '../src/views/editor/ops/index.ts';

// ---- fixtures ------------------------------------------------------------------------------------------

const RED = { r: 192, g: 0, b: 0, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const style = (x: Partial<TextObject['style']> = {}): TextObject['style'] => ({
  ...DEFAULT_THEME.textBoxDefaults,
  ...x,
});
const text = (id: string, t: string, x: Partial<TextObject> = {}): TextObject => ({
  id,
  type: 'text',
  box: { x: 100, y: 100, w: 1700, h: 400, rotation: 0 },
  text: t,
  style: style(),
  opacity: 1,
  ...x,
});
const image = (id: string, mediaId: string, x: Partial<ImageObject> = {}): ImageObject => ({
  id,
  type: 'image',
  box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
  mediaId,
  fit: 'stretch',
  opacity: 1,
  radius: 0,
  ...x,
});
const shape = (id: string, x: Partial<ShapeObject> = {}): ShapeObject => ({
  id,
  type: 'shape',
  box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
  shape: 'rect',
  fill: WHITE,
  opacity: 1,
  radius: 0,
  ...x,
});
const bg = { src: 'pptx', role: 'bg' };
const slide = (id: string, objects: SlideObject[] = [], x: Partial<Slide> = {}): Slide => ({
  id,
  objects,
  ...x,
});
const deck = (slides: Slide[], x: Partial<Presentation> = {}): Presentation =>
  Presentation.parse({
    id: 'p1',
    rev: 3,
    title: 'Sunday',
    kind: 'slides',
    sections: [
      { id: 'a', label: 'Welcome', short: 'W', slides: slides.slice(0, 2) },
      { id: 'b', label: 'Notices', short: 'N', slides: slides.slice(2) },
    ],
    arrangements: [{ id: 'arr', name: 'Default', sectionIds: ['a', 'b'] }],
    ...x,
  });
const sl = (p: Presentation, id: string) => getSlide(p, id)!;
const obj = <T extends SlideObject = SlideObject>(p: Presentation, s: string, o: string) =>
  sl(p, s).objects.find((x) => x.id === o) as T;

/** "Potluck lunch on Sunday 12 May in the hall": the date bold and red, a centred first paragraph. */
const announcement = () =>
  text('t1', 'Potluck lunch on Sunday 12 May in the hall\nBring a dish to share', {
    style: style({ autofit: 'shrink', fitScale: { font: 0.85, spacing: 0.9 } }),
    runs: [{ start: 17, end: 30, fontWeight: 700, color: RED }],
    paras: [{ align: 'center' }, { spaceBeforePx: 12 }],
  });

/** The style a run gives character `i` (the fields set by the run covering it). */
function charStyle(o: TextObject, i: number): Omit<TextRun, 'start' | 'end'> {
  const r = o.runs?.find((x) => x.start <= i && i < x.end);
  if (!r) return {};
  const { start: _s, end: _e, ...rest } = r;
  return rest;
}

function wellFormed(o: TextObject): void {
  let at = 0;
  for (const r of o.runs ?? []) {
    expect(r.start).toBeGreaterThanOrEqual(at);
    expect(r.end).toBeGreaterThan(r.start);
    expect(r.end).toBeLessThanOrEqual(o.text.length);
    at = r.end;
  }
  expect((o.paras ?? []).length).toBeLessThanOrEqual(o.text.split('\n').length);
}

// ---- find ----------------------------------------------------------------------------------------------

describe('matchesIn: what Find finds', () => {
  it('folds case unless asked, and never overlaps', () => {
    expect(matchesIn('Sunday sunday SUNDAY', 'sunday')).toEqual([
      [0, 6],
      [7, 13],
      [14, 20],
    ]);
    expect(matchesIn('Sunday sunday SUNDAY', 'sunday', { case: true })).toEqual([[7, 13]]);
    expect(matchesIn('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ]);
    expect(matchesIn('anything', '')).toEqual([]);
    expect(matchesIn('', 'a')).toEqual([]);
  });

  it('whole words: letters, marks and digits are word characters, punctuation is not', () => {
    expect(matchesIn('God so loved, love is', 'love', { wholeWord: true })).toEqual([[14, 18]]);
    expect(matchesIn('John 3:16 and 13:16', '3:16', { wholeWord: true })).toEqual([[5, 9]]);
    expect(matchesIn("God's love", 'God', { wholeWord: true })).toEqual([[0, 3]]);
    expect(matchesIn('Sunday Sun', 'Sun', { wholeWord: true })).toEqual([[7, 10]]);
    // A Hebrew word with its vowel points is one word: the bare letters inside it are not a whole word.
    expect(matchesIn('שָׁלוֹם שלום', 'שלום', { wholeWord: true })).toEqual([[8, 12]]);
    // Accented letters are word characters.
    expect(matchesIn('café cafe', 'caf', { wholeWord: true })).toEqual([]);
  });

  it('takes the find text literally, also with characters a pattern would read', () => {
    expect(matchesIn('Cost: $5 (or more) [a+b]?', '$5 (or')).toEqual([[6, 12]]);
    expect(matchesIn('Cost: $5 (or more) [a+b]?', '[a+b]?')).toEqual([[19, 25]]);
    expect(matchesIn('a.b axb', 'a.b')).toEqual([[0, 3]]);
    expect(matchesIn('1+1=2', '1+1')).toEqual([[0, 3]]);
    expect(matchesIn('back\\slash', '\\')).toEqual([[4, 5]]);
  });

  it('a typed space also finds a no-break space (imported text keeps them)', () => {
    expect(matchesIn('Dieu ! 12 May', 'Dieu !')).toEqual([[0, 6]]);
    expect(matchesIn('Sunday 12 May', 'Sunday 12 May')).toEqual([[0, 13]]);
  });

  it('keeps offsets in UTF-16 units around astral characters', () => {
    const t = '🎉 Party 🎉 party';
    const m = matchesIn(t, 'party');
    expect(m.map(([a, b]) => t.slice(a, b))).toEqual(['Party', 'party']);
    expect(matchesIn('🎉x', 'x', { wholeWord: true })).toEqual([[2, 3]]);
  });
});

describe('findText (design/27 §11 item 8)', () => {
  const p = deck([
    slide('s1', [text('t1', 'Sunday service'), image('i1', 'photo')]),
    slide('s2', [text('t2', 'Sunday school and Sunday lunch')], { hidden: true }),
    slide('s3', [text('t3', 'Sunday', { locked: true }), text('t4', 'Monday')]),
  ]);

  it('lists matches in authoring order, hidden slides included, locked objects left out', () => {
    expect(findText(p, 'sunday')).toEqual([
      { slideId: 's1', objectId: 't1', start: 0, end: 6 },
      { slideId: 's2', objectId: 't2', start: 0, end: 6 },
      { slideId: 's2', objectId: 't2', start: 18, end: 24 },
    ]);
    expect(findText(p, '')).toEqual([]);
    expect(findText(p, 'day', {}, 2)).toHaveLength(2);
  });

  it('searches the text the field shows, not the automatic numbers', () => {
    const q = deck([
      slide('s1', [text('t1', 'For God so loved', { paras: [{ bullet: { auto: 'arabicPeriod' } }] })]),
    ]);
    expect(findText(q, '1.')).toEqual([]);
  });
});

describe('findReplace keeps formatting (design/27 §11 item 8)', () => {
  it('changes the announcement date inside its bold red run, the run, paragraphs and fit kept', () => {
    const p = deck([slide('s1', [announcement()]), slide('s2', [text('t2', 'See you on Sunday 12 May')])]);
    const r = findReplace(p, '12 May', '19 May');
    expect(r.replaced).toBe(2);
    const t = obj<TextObject>(r.p, 's1', 't1');
    expect(t.text).toBe('Potluck lunch on Sunday 19 May in the hall\nBring a dish to share');
    expect(t.runs).toEqual([{ start: 17, end: 30, fontWeight: 700, color: RED }]);
    expect(t.paras).toEqual(announcement().paras);
    expect(t.style).toEqual(announcement().style);
    // A legacy object (no runs or paragraph styles) gets its new text and nothing else.
    const legacy = obj<TextObject>(r.p, 's2', 't2');
    expect(legacy.text).toBe('See you on Sunday 19 May');
    expect('runs' in legacy || 'paras' in legacy).toBe(false);
  });

  it('a longer or shorter replacement takes the style of the text it replaces', () => {
    const p = deck([slide('s1', [announcement()])]);
    const t = obj<TextObject>(findReplace(p, 'Sunday 12 May', 'Saturday 1 June').p, 's1', 't1');
    expect(t.text.slice(17, 32)).toBe('Saturday 1 June');
    expect(t.runs).toEqual([{ start: 17, end: 32, fontWeight: 700, color: RED }]);
    const gone = obj<TextObject>(findReplace(p, 'Sunday 12 May ', '').p, 's1', 't1');
    expect(gone.text).toBe('Potluck lunch on in the hall\nBring a dish to share');
    expect(gone.runs).toEqual([]);
  });

  it('replaces every match of an object, case and whole words as asked', () => {
    const p = deck([
      slide('s1', [text('t1', 'Sun sun SUN Sunday', { runs: [{ start: 4, end: 7, strike: true }] })]),
    ]);
    const all = findReplace(p, 'sun', 'Moon');
    expect(obj<TextObject>(all.p, 's1', 't1').text).toBe('Moon Moon Moon Moonday');
    expect(all.replaced).toBe(4);
    expect(obj<TextObject>(all.p, 's1', 't1').runs).toEqual([{ start: 5, end: 9, strike: true }]);
    const whole = findReplace(p, 'sun', 'Moon', { wholeWord: true, case: true });
    expect(obj<TextObject>(whole.p, 's1', 't1').text).toBe('Sun Moon SUN Sunday');
    expect(whole.replaced).toBe(1);
  });

  it('changes nothing (the same presentation) when nothing matches or a match is already the replacement', () => {
    const p = deck([slide('s1', [announcement()])]);
    expect(findReplace(p, 'Christmas', 'Easter')).toEqual({ p, replaced: 0 });
    expect(findReplace(p, '', 'x')).toEqual({ p, replaced: 0 });
    expect(findReplace(p, 'potluck', 'Potluck')).toEqual({ p, replaced: 0 });
    // Case folded: 'POTLUCK' finds 'Potluck' and changes it.
    expect(findReplace(p, 'potluck', 'POTLUCK').replaced).toBe(1);
  });

  it('leaves locked objects and a result past the schema bound alone', () => {
    const big = 'a '.repeat(5000);
    const p = deck([slide('s1', [text('t1', big), text('t2', 'a', { locked: true })])]);
    const r = findReplace(p, 'a', 'aaaaa');
    expect(big.length + 5000 * 4).toBeGreaterThan(MAX_TEXT);
    expect(r).toEqual({ p, replaced: 0 });
  });

  it('property: runs stay well formed and the text outside each match keeps its style', () => {
    const alphabet = fc.constantFrom('a', 'b', 'A', ' ', '\n', 'é');
    const arb = fc.record({
      text: fc.array(alphabet, { maxLength: 40 }).map((c) => c.join('')),
      cuts: fc.array(fc.nat(40), { maxLength: 8 }),
      find: fc
        .array(fc.constantFrom('a', 'b', 'A', ' '), { minLength: 1, maxLength: 3 })
        .map((c) => c.join('')),
      repl: fc.array(fc.constantFrom('x', 'Y', ' ', '\n'), { maxLength: 4 }).map((c) => c.join('')),
      case: fc.boolean(),
      wholeWord: fc.boolean(),
    });
    fc.assert(
      fc.property(arb, (c) => {
        // Runs from sorted cut points, alternately bold and red.
        const cuts = [...new Set(c.cuts.map((x) => Math.min(x, c.text.length)))].sort((a, b) => a - b);
        const runs: TextRun[] = [];
        for (let i = 0; i + 1 < cuts.length; i++)
          if (cuts[i]! < cuts[i + 1]!)
            runs.push(
              i % 2
                ? { start: cuts[i]!, end: cuts[i + 1]!, color: RED }
                : { start: cuts[i]!, end: cuts[i + 1]!, fontWeight: 700 },
            );
        const o = text('t1', c.text, { runs, paras: [] });
        const p = deck([slide('s1', [o])]);
        const opts = { case: c.case, wholeWord: c.wholeWord };
        const ms = matchesIn(c.text, c.find, opts);
        const r = findReplace(p, c.find, c.repl, opts);
        const t = obj<TextObject>(r.p, 's1', 't1');
        // The text is the old one with each match replaced.
        let expected = '';
        let at = 0;
        for (const [a, b] of ms) {
          expected += c.text.slice(at, a) + c.repl;
          at = b;
        }
        expected += c.text.slice(at);
        expect(t.text).toBe(expected);
        wellFormed(t);
        // Every character outside the matches keeps its style, at its shifted offset.
        let shift = 0;
        let k = 0;
        for (let i = 0; i < c.text.length; i++) {
          while (k < ms.length && i >= ms[k]![1]) {
            shift += c.repl.length - (ms[k]![1] - ms[k]![0]);
            k++;
          }
          if (k < ms.length && i >= ms[k]![0]) continue;
          expect(charStyle(t, i + shift)).toEqual(charStyle(o, i));
        }
        // The same runs and paragraph styles as typing each change in the text field (last match first, the
        // caret after the typed replacement): a replacement keeps the style of each character it keeps.
        let typed: TextObject = o;
        for (let i = ms.length - 1; i >= 0; i--) {
          const [a, b] = ms[i]!;
          typed = editText(typed, typed.text.slice(0, a) + c.repl + typed.text.slice(b), a + c.repl.length);
        }
        expect(t.text).toBe(typed.text);
        expect(t.runs).toEqual(typed.runs);
        expect(t.paras).toEqual(typed.paras);
      }),
      { numRuns: 4000 },
    );
  });

  it('only the part that differs is replaced: the words around a bold red date keep their own style', () => {
    const p = deck([slide('s1', [announcement()])]);
    // The match runs past the date into plain words: "in the hall" stays plain.
    const hall = obj<TextObject>(findReplace(p, '12 May in the hall', '19 May in the hall').p, 's1', 't1');
    expect(hall.runs).toEqual([{ start: 17, end: 30, fontWeight: 700, color: RED }]);
    // The match starts in plain words: 'Saturday' takes the bold red of 'Sunday' (what it replaces).
    const sat = obj<TextObject>(findReplace(p, 'on Sunday', 'on Saturday').p, 's1', 't1');
    expect(sat.text.slice(0, 26)).toBe('Potluck lunch on Saturday ');
    expect(sat.runs).toEqual([{ start: 17, end: 32, fontWeight: 700, color: RED }]);
    // Both are what typing the same change gives.
    const typed = editText(announcement(), sat.text, 'Potluck lunch on Satur'.length);
    expect(typed.runs).toEqual(sat.runs);
  });

  it('changedPart trims the common start and end, never inside a surrogate pair', () => {
    expect(changedPart('on Sunday', 'on Saturday')).toEqual({ k: 4, j: 3 });
    expect(changedPart('12 May', '19 May')).toEqual({ k: 1, j: 4 });
    expect(changedPart('ab', 'abab')).toEqual({ k: 2, j: 0 });
    // '😀' and '😃' share their high surrogate: the whole pair is replaced.
    expect(changedPart('x😀', 'x😃')).toEqual({ k: 1, j: 0 });
  });
});

// ---- hide ----------------------------------------------------------------------------------------------

describe('hideSlide (design/27 §11 item 9)', () => {
  it('sets and removes Slide.hidden, the same presentation when it is so already', () => {
    const p = deck([slide('s1'), slide('s2', [], { hidden: true })]);
    const h = hideSlide(p, 's1', true);
    expect(sl(h, 's1').hidden).toBe(true);
    expect(hideSlide(h, 's1', true)).toBe(h);
    const shown = hideSlide(p, 's2', false);
    expect('hidden' in sl(shown, 's2')).toBe(false);
    expect(hideSlide(p, 's1', false)).toBe(p);
    expect(hideSlide(p, 'gone', true)).toBe(p);
    expect(sl(h, 's2')).toBe(sl(p, 's2'));
  });
});

// ---- backgrounds ---------------------------------------------------------------------------------------

const SERIES = { id: 'series', width: 1920, height: 1080 };
const SQUARE = { id: 'square', width: 1000, height: 1000 };
const PORTRAIT = { id: 'portrait', width: 1080, height: 1920 };

describe('slideBackground and the slides using it', () => {
  const p = deck(
    [
      slide('s1', [shape('w', { origin: bg }), image('b', 'art', { origin: bg }), text('t', 'Hi')], {
        backgroundMediaId: 'bars',
      }),
      slide('s2', [], { backgroundMediaId: 'own' }),
      slide('s3', [shape('solid', { origin: bg, fill: RED })]),
      slide('s4', [image('b4', 'art', { origin: bg })]),
    ],
    { backgroundMediaId: 'default' },
  );

  it('a role bg picture over any backgroundMediaId, then the slide own, then the presentation', () => {
    expect(slideBackground(p, sl(p, 's1'))).toEqual({ mediaId: 'art', from: 'object', objectId: 'b' });
    expect(slideBackground(p, sl(p, 's2'))).toEqual({ mediaId: 'own', from: 'slide' });
    expect(slideBackground(p, sl(p, 's3'))).toEqual({ mediaId: 'default', from: 'presentation' });
    const none = { ...p, backgroundMediaId: undefined };
    expect(slideBackground(none, sl(p, 's3'))).toBeUndefined();
  });

  it('a locked or playing picture is not a background picture', () => {
    const q = deck([
      slide('s1', [image('b', 'art', { origin: bg, locked: true })], { backgroundMediaId: 'x' }),
    ]);
    expect(slideBackground(q, sl(q, 's1'))?.from).toBe('slide');
  });

  it('counts the slides showing a picture, and finds the deck background', () => {
    expect(slidesUsingBackground(p, 'art')).toEqual(['s1', 's4']);
    expect(slidesUsingBackground(p, 'default')).toEqual(['s3']);
    expect(deckBackground(p)).toBe('default');
    expect(deckBackground({ ...p, backgroundMediaId: undefined })).toBe('art');
    expect(deckBackground(deck([slide('s1')]))).toBeUndefined();
    expect(
      slidesUsingBackground(deck([slide('s1'), slide('s2', [], { backgroundMediaId: 'x' })]), undefined),
    ).toEqual(['s1']);
  });
});

describe('replaceBackground: backgroundMediaId (cover-fit, never distorted)', () => {
  /** A 16:9 deck whose slides share the presentation's background, one with its own copy of it. */
  const p = deck(
    [
      slide('s1', [text('t1', 'Welcome')]),
      slide('s2', [text('t2', 'Notices')], { backgroundMediaId: 'old' }),
      slide('s3', [text('t3', 'Prayer')], { backgroundMediaId: 'other' }),
      slide('s4', [text('t4', 'Bye')]),
    ],
    { backgroundMediaId: 'old' },
  );

  it("scope 'all' rewrites every use of the picture: the presentation's and the slides' own", () => {
    const q = replaceBackground(p, 's1', SQUARE, 'all');
    expect(q.backgroundMediaId).toBe('square');
    expect(sl(q, 's2').backgroundMediaId).toBe('square');
    expect(sl(q, 's3')).toBe(sl(p, 's3'));
    expect(sl(q, 's1')).toBe(sl(p, 's1'));
    expect(slidesUsingBackground(q, 'square')).toEqual(['s1', 's2', 's4']);
  });

  it("scope 'slide' gives only this slide its own background", () => {
    const q = replaceBackground(p, 's1', SQUARE, 'slide');
    expect(q.backgroundMediaId).toBe('old');
    expect(sl(q, 's1').backgroundMediaId).toBe('square');
    expect(sl(q, 's4')).toBe(sl(p, 's4'));
    const own = replaceBackground(p, 's2', SQUARE, 'slide');
    expect(sl(own, 's2').backgroundMediaId).toBe('square');
    expect(own.backgroundMediaId).toBe('old');
  });

  it('is the same presentation when the slide shows that picture already or is missing', () => {
    expect(replaceBackground(p, 's1', { id: 'old' }, 'all')).toBe(p);
    expect(replaceBackground(p, 's3', { id: 'other' }, 'slide')).toBe(p);
    expect(replaceBackground(p, 'gone', SQUARE, 'all')).toBe(p);
    expect(replaceBackground(p, 's1', { id: '' }, 'all')).toBe(p);
  });

  it('a slide with a solid PowerPoint background takes the picture, the bg shape that would hide it removed', () => {
    const q = deck([
      slide('s1', [shape('solid', { origin: bg, fill: RED }), text('t1', 'Hi')]),
      slide('s2', [shape('solid2', { origin: bg }), text('t2', 'There')]),
      slide('s3', [shape('mine', { fill: RED }), text('t3', 'Mine')]),
      slide('s4', [image('b', 'art', { origin: bg })]),
    ]);
    const one = replaceBackground(q, 's1', SERIES, 'slide');
    expect(sl(one, 's1')).toEqual({ id: 's1', objects: [text('t1', 'Hi')], backgroundMediaId: 'series' });
    expect(sl(one, 's2')).toBe(sl(q, 's2'));
    const all = replaceBackground(q, 's1', SERIES, 'all');
    expect(all.backgroundMediaId).toBe('series');
    expect(sl(all, 's1').objects.map((o) => o.id)).toEqual(['t1']);
    expect(sl(all, 's2').objects.map((o) => o.id)).toEqual(['t2']);
    // The operator's own shape is not a PowerPoint background; a slide with a picture keeps it.
    expect(sl(all, 's3')).toBe(sl(q, 's3'));
    expect(sl(all, 's4')).toBe(sl(q, 's4'));
  });

  it('a video becomes the motion background, replacing role bg pictures and their white', () => {
    const q = deck([
      slide('s1', [shape('w', { origin: bg }), image('b', 'art', { origin: bg }), text('t1', 'Hi')]),
      slide('s2', [shape('w2', { origin: bg }), image('b2', 'art', { origin: bg })]),
    ]);
    const v = replaceBackground(q, 's1', { id: 'loop', width: 1280, height: 720, kind: 'video' }, 'all');
    expect(sl(v, 's1')).toEqual({ id: 's1', objects: [text('t1', 'Hi')], backgroundMediaId: 'loop' });
    expect(sl(v, 's2')).toEqual({ id: 's2', objects: [], backgroundMediaId: 'loop' });
    const one = replaceBackground(q, 's2', { id: 'loop', kind: 'video' }, 'slide');
    expect(sl(one, 's2').backgroundMediaId).toBe('loop');
    expect(sl(one, 's1')).toBe(sl(q, 's1'));
  });

  it("replaceBackgroundOf: the Presentation panel's 'Replace on all slides'", () => {
    expect(replaceBackgroundOf(p, 'old', SQUARE)).toEqual(replaceBackground(p, 's1', SQUARE, 'all'));
    const none = deck([
      slide('s1', [shape('solid', { origin: bg })]),
      slide('s2', [], { backgroundMediaId: 'x' }),
    ]);
    const r = replaceBackgroundOf(none, undefined, SERIES);
    expect(r.backgroundMediaId).toBe('series');
    expect(sl(r, 's1').objects).toEqual([]);
    expect(sl(r, 's2')).toBe(sl(none, 's2'));
    expect(replaceBackgroundOf(p, 'old', { id: 'old' })).toBe(p);
  });
});

describe("replaceBackground on an imported ProPresenter song (its colour is the slide's backdrop)", () => {
  /** A ProPresenter song on its presentation's background colour, one slide on a colour of its own. */
  function proSong(): Presentation {
    const enc = new TextEncoder();
    const rtf = (t: string) =>
      enc.encode(
        `{\\rtf1\\ansi{\\fonttbl\\f0\\fnil Helvetica;}{\\colortbl;\\red255\\green255\\blue255;}\\f0\\fs96\\cf1 ${t}}`,
      );
    const cue = (id: string, words: string, own?: { red: number; green: number; blue: number }) => ({
      uuid: { string: id },
      isEnabled: true,
      actions: [
        {
          uuid: { string: `A-${id}` },
          type: 'ACTION_TYPE_PRESENTATION_SLIDE',
          isEnabled: true,
          slide: {
            presentation: {
              baseSlide: {
                size: { width: 1920, height: 1080 },
                ...(own ? { drawsBackgroundColor: true, backgroundColor: { ...own, alpha: 1 } } : {}),
                elements: [
                  {
                    element: {
                      uuid: { string: `E-${id}` },
                      bounds: { origin: { x: 100, y: 150 }, size: { width: 1720, height: 780 } },
                      opacity: 1,
                      text: { rtfData: rtf(words) },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    });
    const t = pro7Type('rv.data.Presentation');
    const doc = t
      .encode(
        t.fromObject({
          uuid: { string: 'P-SONG' },
          name: 'Holy Holy Holy',
          background: { isEnabled: true, color: { red: 0.1, green: 0.2, blue: 0.5, alpha: 1 } },
          cues: [
            cue('C1', 'Holy, holy, holy'),
            cue('C2', 'Lord God almighty', { red: 0, green: 0, blue: 0 }),
          ],
        }),
      )
      .finish();
    const r = importPro7(new Map([['Holy Holy Holy.pro', doc]]));
    return r.presentations[0]!;
  }
  const drawn = (p: Presentation, id: string) => {
    const s = sl(p, id);
    // What the slide shows: its objects, over its own background picture or the presentation's.
    return { objects: s.objects.map((o) => o.type), background: s.backgroundMediaId ?? p.backgroundMediaId };
  };

  it('this slide: the picture shows, no longer hidden by the colour the slide was imported on', () => {
    const p = proSong();
    const [s1, s2] = p.sections.flatMap((x) => x.slides);
    expect(drawn(p, s1!.id)).toEqual({ objects: ['shape', 'text'], background: undefined });
    expect(s1!.objects[0]!.origin).toEqual({ src: 'pro7', role: 'bg' });
    const q = replaceBackground(p, s1!.id, SERIES, 'slide');
    expect(drawn(q, s1!.id)).toEqual({ objects: ['text'], background: 'series' });
    // The other slide (its own black) is as imported.
    expect(sl(q, s2!.id)).toBe(sl(p, s2!.id));
  });

  it("every slide: the picture becomes the presentation's background and every backdrop goes", () => {
    const p = proSong();
    const ids = p.sections.flatMap((x) => x.slides).map((s) => s.id);
    const q = replaceBackground(p, ids[0]!, SERIES, 'all');
    expect(q.backgroundMediaId).toBe('series');
    for (const id of ids) expect(drawn(q, id)).toEqual({ objects: ['text'], background: 'series' });
  });
});

describe('replaceBackground: role bg pictures go through the picture replace rule', () => {
  /** An imported 4:3 deck: every slide's background a stretched bottom picture over the slide area. */
  const area = { x: 240, y: 0, w: 1440, h: 1080, rotation: 0 };
  const p = deck(
    [
      slide('s1', [
        shape('w1', { origin: bg, box: area }),
        image('b1', 'old', { origin: bg, box: area }),
        text('t1', 'A'),
      ]),
      slide('s2', [shape('w2', { origin: bg, box: area }), image('b2', 'old', { origin: bg, box: area })]),
      slide('s3', [
        shape('w3', { origin: bg, box: area }),
        image('b3', 'another', { origin: bg, box: area }),
      ]),
    ],
    {
      source: {
        kind: 'pptx',
        fileId: 'f',
        native: { version: 1, slides: 3, native: 3, hybrid: 0, picture: 0, slideRect: area },
      },
    },
  );

  it('each picture of the old background is what replacePicture makes of it, others untouched', () => {
    const q = replaceBackground(p, 's1', SERIES, 'all');
    expect(obj(q, 's1', 'b1')).toEqual(replacePicture(obj<ImageObject>(p, 's1', 'b1'), SERIES));
    expect(obj(q, 's2', 'b2')).toEqual(replacePicture(obj<ImageObject>(p, 's2', 'b2'), SERIES));
    expect(sl(q, 's3')).toBe(sl(p, 's3'));
    // The white the picture is laid on stays under it.
    expect(sl(q, 's1').objects.map((o) => o.id)).toEqual(['w1', 'b1', 't1']);
    const one = replaceBackground(p, 's2', SERIES, 'slide');
    expect(sl(one, 's1')).toBe(sl(p, 's1'));
    expect(obj(one, 's2', 'b2')).toEqual(replacePicture(obj<ImageObject>(p, 's2', 'b2'), SERIES));
  });

  it('a picture of another aspect is cover-cropped to the box, never distorted', () => {
    const q = replaceBackground(p, 's1', SERIES, 'all');
    for (const id of ['b1', 'b2'] as const) {
      const o = obj<ImageObject>(q, id === 'b1' ? 's1' : 's2', id);
      expect(o.mediaId).toBe('series');
      const c = o.crop ?? { l: 0, t: 0, r: 0, b: 0 };
      const shown = ((1 - c.l - c.r) * SERIES.width) / ((1 - c.t - c.b) * SERIES.height);
      expect(shown).toBeCloseTo(area.w / area.h, 6);
    }
    expect(slidesUsingBackground(q, 'series')).toEqual(['s1', 's2']);
  });

  it('property: no distortion across aspects, on every slide using the picture', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 1920 }),
        fc.integer({ min: 50, max: 1080 }),
        fc.integer({ min: 10, max: 8000 }),
        fc.integer({ min: 10, max: 8000 }),
        fc.constantFrom<'slide' | 'all'>('slide', 'all'),
        (w, h, mw, mh, scope) => {
          // Pictures up to 20 times wider or taller than the box (a crop keeps at least 1% of a picture).
          const ratio = mw / mh / (w / h);
          fc.pre(ratio <= 20 && ratio >= 1 / 20);
          const box = { x: 0, y: 0, w, h, rotation: 0 };
          const q = deck([
            slide('s1', [image('b1', 'old', { origin: bg, box })]),
            slide('s2', [image('b2', 'old', { origin: bg, box })]),
          ]);
          const media = { id: 'new', width: mw, height: mh };
          const r = replaceBackground(q, 's1', media, scope);
          for (const [s, id] of [
            ['s1', 'b1'],
            ['s2', 'b2'],
          ] as const) {
            const o = obj<ImageObject>(r, s, id);
            if (scope === 'slide' && s === 's2') {
              expect(o.mediaId).toBe('old');
              continue;
            }
            expect(o.mediaId).toBe('new');
            const c = o.crop ?? { l: 0, t: 0, r: 0, b: 0 };
            const shown = ((1 - c.l - c.r) * mw) / ((1 - c.t - c.b) * mh);
            expect(Math.abs(shown / (w / h) - 1)).toBeLessThan(1e-3);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---- similar boxes -------------------------------------------------------------------------------------

describe("similarObjects and 'Apply to similar boxes' (design/27 §11 item 10)", () => {
  const title = (id: string, t: string, x: Partial<TextObject> = {}) =>
    text(id, t, { origin: { src: 'pptx', shapeId: 2, ph: 'title', role: 'title' }, ...x });
  const blue = { r: 30, g: 60, b: 200, a: 1 };
  const styled = () =>
    title('src', 'Men’s breakfast\nSaturday 8 am\n  at the hall', {
      style: style({
        color: blue,
        fontSizePx: 72,
        fontFamily: 'Aptos',
        autofit: 'shrink',
        fitScale: { font: 0.7, spacing: 1 },
      }),
      paras: [
        { align: 'left', spaceAfterPx: 8 },
        { level: 1, indentPx: 40, bullet: { char: '•' } },
      ],
      runs: [{ start: 0, end: 3, fontWeight: 700 }],
    });
  const p = deck([
    slide('s1', [
      styled(),
      text('own', 'Picture caption', { origin: { src: 'pptx', shapeId: 3, role: 'text' } }),
    ]),
    slide('s2', [
      title('t2', 'Choir practice\nThursday', {
        style: style({ fitScale: { font: 0.9, spacing: 1 } }),
        runs: [{ start: 0, end: 5, fontStyle: 'italic' }],
        paras: [null, { level: 1, bullet: { auto: 'arabicPeriod', startAt: 4 } }],
      }),
      text('cap2', 'Another caption', { origin: { src: 'pptx', shapeId: 3, role: 'text' } }),
    ]),
    slide('s3', [
      title('t3', 'Locked', { locked: true }),
      title('t3b', 'Youth night', { origin: { src: 'pptx', ph: 'title' } }),
    ]),
    slide('s4', [
      text('mine', 'Operator box'),
      title('body', 'x', { origin: { src: 'pptx', ph: 'body:1', role: 'body' } }),
    ]),
  ]);

  it('matches the placeholder, never a slide own box by its shape id, never locked or the same slide', () => {
    expect(similarObjects(p, 's1', 'src')).toEqual([
      { slideId: 's2', objectId: 't2' },
      { slideId: 's3', objectId: 't3b' },
    ]);
    expect(similarObjects(p, 's1', 'own')).toEqual([]);
    expect(similarObjects(p, 's4', 'mine')).toEqual([]);
    expect(similarObjects(p, 'gone', 'src')).toEqual([]);
  });

  it('matches master and layout shapes by their shape id', () => {
    const deco = (id: string, shapeId: number) =>
      text(id, 'First Church', { origin: { src: 'pptx', role: 'deco', shapeId } });
    const q = deck([
      slide('s1', [deco('d1', 7)]),
      slide('s2', [deco('d2', 7)]),
      slide('s3', [deco('d3', 8)]),
    ]);
    expect(similarObjects(q, 's1', 'd1')).toEqual([{ slideId: 's2', objectId: 'd2' }]);
  });

  it('every similar box takes the style and paragraph styles by level, keeping its text and runs', () => {
    const r = applyStyleToSimilar(p, 's1', 'src');
    expect(r.changed).toBe(2);
    const t2 = obj<TextObject>(r.p, 's2', 't2');
    expect(t2.text).toBe('Choir practice\nThursday');
    expect(t2.runs).toEqual([{ start: 0, end: 5, fontStyle: 'italic' }]);
    // The box style is the source's; its fit was another text's, and the size changed, so it is fitted again.
    const { fitScale: _f, ...want } = styled().style;
    expect(t2.style).toEqual(want);
    // Level 0 takes the first paragraph's style, level 1 the level-1 bullet; its own numbering start kept
    // only for its own numbering (the source bullet is a character).
    expect(t2.paras).toEqual([
      { align: 'left', spaceAfterPx: 8 },
      { level: 1, indentPx: 40, bullet: { char: '•' } },
    ]);
    const t3b = obj<TextObject>(r.p, 's3', 't3b');
    expect(t3b.paras).toEqual([{ align: 'left', spaceAfterPx: 8 }]);
    expect(sl(r.p, 's4')).toBe(sl(p, 's4'));
    expect(obj(r.p, 's3', 't3')).toBe(obj(p, 's3', 't3'));
  });

  it('a box differing only in colour or alignment keeps its fit; one already alike is not counted', () => {
    const a = title('a', 'One', {
      style: style({ color: blue, autofit: 'shrink', fitScale: { font: 0.8, spacing: 1 } }),
    });
    const b = title('b', 'Two', {
      style: style({ autofit: 'shrink', align: 'left', fitScale: { font: 0.6, spacing: 0.9 } }),
    });
    const c = title('c', 'Three', {
      style: style({ color: blue, autofit: 'shrink', fitScale: { font: 0.5, spacing: 1 } }),
    });
    const q = deck([slide('s1', [a]), slide('s2', [b]), slide('s3', [c])]);
    const r = applyStyleToSimilar(q, 's1', 'a');
    expect(r.changed).toBe(1);
    expect(obj<TextObject>(r.p, 's2', 'b').style).toEqual(
      style({ color: blue, autofit: 'shrink', fitScale: { font: 0.6, spacing: 0.9 } }),
    );
    expect(sl(r.p, 's3')).toBe(sl(q, 's3'));
    expect(applyStyleToSimilar(r.p, 's1', 'a')).toEqual({ p: r.p, changed: 0 });
  });

  it('keeps soft lines and hidden lines, and the numbering start of a numbered paragraph', () => {
    const a = title('a', 'One', { paras: [{ bullet: { auto: 'arabicPeriod', startAt: 1 }, indentPx: 30 }] });
    const b = title('b', 'Sixteen\nsoft\nSeventeen', {
      paras: [{ bullet: { auto: 'arabicPeriod', startAt: 16 } }, { soft: true }, { hidden: true }],
    });
    const q = deck([slide('s1', [a]), slide('s2', [b])]);
    const t = obj<TextObject>(applyStyleToSimilar(q, 's1', 'a').p, 's2', 'b');
    expect(t.paras).toEqual([
      { bullet: { auto: 'arabicPeriod', startAt: 16 }, indentPx: 30 },
      { bullet: { auto: 'arabicPeriod' }, indentPx: 30, soft: true },
      { bullet: { auto: 'arabicPeriod' }, indentPx: 30, hidden: true },
    ]);
  });

  it('marks the theme overrides of a themed lyric box it changes', () => {
    const a = title('a', 'One', { style: style({ color: blue }) });
    const b = title('b', 'Two');
    const q = deck([slide('s1', [a]), slide('s2', [b], { lyricObjectId: 'b' })], { themeId: 'theme' });
    const r = applyStyleToSimilar(q, 's1', 'a');
    expect(sl(r.p, 's2').overrides).toEqual(['style.color']);
    const plain = applyStyleToSimilar({ ...q, themeId: undefined }, 's1', 'a');
    expect(sl(plain.p, 's2').overrides).toBeUndefined();
  });
});

// ---- new slide like this -------------------------------------------------------------------------------

describe('the slide ops keep the schema bounds', () => {
  it("'Apply to similar boxes' onto a box of more than 5,000 paragraphs writes at most 5,000 styles", () => {
    const src = text('src', 'Verse', { origin: { src: 'pptx', ph: 'body' }, paras: [{ align: 'left' }] });
    const dst = text('dst', 'a\n'.repeat(5_500), { origin: { src: 'pptx', ph: 'body' } });
    const p = deck([slide('s1', [src]), slide('s2', [dst])]);
    const r = applyStyleToSimilar(p, 's1', 'src');
    expect(r.changed).toBe(1);
    expect(obj<TextObject>(r.p, 's2', 'dst').paras).toHaveLength(MAX_PARAS);
    expect(Presentation.safeParse(r.p).success).toBe(true);
  });

  it("'New slide like this' adds none to a section of 5,000 slides", () => {
    const p = deck([slide('s1', [text('t1', 'Verse 1')])]);
    const many = Array.from({ length: MAX_SECTION_SLIDES }, (_, i) => slide(`x${i}`));
    const full: Presentation = {
      ...p,
      sections: [{ ...p.sections[0]!, slides: many }, ...p.sections.slice(1)],
    };
    expect(newSlideLike(full, 'x0')).toEqual({ p: full, full: true });
    expect(newSlideLike(p, 's1').id).toBeDefined();
  });
});

describe("'New slide like this' (design/27 §11 item 11)", () => {
  const verse = text('v', '16 For God so loved the world\n17 For God sent not his Son', {
    runs: [
      { start: 0, end: 2, baseline: 0.3, sizeScale: 0.6 },
      { start: 30, end: 32, baseline: 0.3, sizeScale: 0.6 },
    ],
    paras: [{ align: 'left', spaceAfterPx: 10 }, { align: 'left' }],
    style: style({ autofit: 'shrink', fitScale: { font: 0.8, spacing: 1 } }),
  });
  const heading = text('h', 'SUNDAY\nPotluck lunch', {
    runs: [{ start: 0, end: 6, fontWeight: 700, sizeScale: 1.5, color: RED, strike: true, outline: null }],
    style: style({ fontSizePx: 40, outline: { width: 2, color: WHITE } }),
  });
  const p = deck([
    slide(
      's1',
      [image('pic', 'photo', { box: { x: 0, y: 0, w: 400, h: 300, rotation: 0 } }), verse, heading],
      {
        notes: 'Read slowly',
        hidden: true,
        lyricObjectId: 'v',
        durationMs: 8000,
        scripture: {
          ref: { translation: 'WEB', book: 'John', chapter: 3, verseFrom: 16, verseTo: 17 },
          text: 'x',
          fetchedAt: '',
          provider: 'x',
        },
        pptx: {
          fileId: 'deck',
          index: 3,
          class: 'native',
          version: 1,
          digest: 'abc',
          refMediaId: 'ref',
          show: 'picture',
        },
      },
    ),
    slide('s2'),
  ]);

  it('inserts a copy right after it with fresh ids, the text cleared and the look kept', () => {
    const r = newSlideLike(p, 's1');
    expect(r.id).toBeDefined();
    const sec = r.p.sections[0]!;
    expect(sec.slides.map((s) => s.id)).toEqual(['s1', r.id, 's2']);
    const n = sec.slides[1]!;
    expect(n.objects.map((o) => o.type)).toEqual(['image', 'text', 'text']);
    expect(n.objects.every((o, i) => o.id !== sl(p, 's1').objects[i]!.id)).toBe(true);
    expect(n.lyricObjectId).toBe(n.objects[1]!.id);
    expect(n.objects[0]).toMatchObject({ mediaId: 'photo' });
    const v = n.objects[1] as TextObject;
    expect(v.text).toBe('');
    expect(v.runs).toEqual([]);
    expect(v.paras).toEqual([{ align: 'left', spaceAfterPx: 10 }]);
    // The raised verse number is an accent, not the box's look; the stored fit is kept (same size verses).
    expect(v.style).toEqual(verse.style);
    expect(n.durationMs).toBe(8000);
  });

  it('a run styling the whole first paragraph is folded into the box style for what is typed', () => {
    const h = newSlideLike(p, 's1').p.sections[0]!.slides[1]!.objects[2] as TextObject;
    expect(h.text).toBe('');
    expect(h.style).toMatchObject({ fontWeight: 700, fontSizePx: 60, color: RED });
    expect(h.style.outline).toBeUndefined();
    expect(h.runs).toEqual([]);
    expect('paras' in h).toBe(false);
  });

  it('leaves out the notes, the hidden flag, the scripture reference, the digest and the PowerPoint picture', () => {
    const n = newSlideLike(p, 's1').p.sections[0]!.slides[1]!;
    expect(n.notes).toBeUndefined();
    expect(n.hidden).toBeUndefined();
    expect(n.scripture).toBeUndefined();
    expect(n.pptx).toEqual({ fileId: 'deck', index: 3, class: 'native', version: 1 });
    expect(Presentation.safeParse(newSlideLike(p, 's1').p).success).toBe(true);
  });

  it('keeps locked text, and is a no-op for a missing slide', () => {
    const q = deck([slide('s1', [text('art', 'Chart title', { locked: true })])]);
    const n = newSlideLike(q, 's1').p.sections[0]!.slides[1]!;
    expect((n.objects[0] as TextObject).text).toBe('Chart title');
    expect(newSlideLike(q, 'gone')).toEqual({ p: q });
  });
});

// ---- use as background ---------------------------------------------------------------------------------

describe("'Use as background' (design/27 §11 item 6)", () => {
  it('moves a full-slide picture to backgroundMediaId, the PowerPoint background under it removed', () => {
    const p = deck([
      slide('s1', [
        shape('solid', { origin: bg }),
        shape('mine'),
        image('full', 'photo', { crop: { l: 0.1, t: 0, r: 0, b: 0 } }),
        text('t', 'Hi'),
      ]),
    ]);
    const q = useAsBackground(p, 's1', 'full');
    expect(sl(q, 's1')).toEqual({
      id: 's1',
      objects: [shape('mine'), text('t', 'Hi')],
      backgroundMediaId: 'photo',
    });
  });

  it('only for an unlocked, unrotated picture covering the whole frame (also on a 4:3 deck)', () => {
    const p = deck([
      slide('s1', [image('small', 'a', { box: { x: 0, y: 0, w: 1920, h: 1000, rotation: 0 } })]),
    ]);
    expect(useAsBackground(p, 's1', 'small')).toBe(p);
    const f = (x: Partial<ImageObject>) => image('i', 'a', x);
    expect(coversSlide(p, f({}))).toBe(true);
    expect(coversSlide(p, f({ box: { x: -10, y: 1, w: 1931, h: 1080, rotation: 0 } }))).toBe(true);
    expect(coversSlide(p, f({ box: { x: 1920, y: 1080, w: -1920, h: -1080, rotation: 360 } }))).toBe(true);
    expect(coversSlide(p, f({ box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 90 } }))).toBe(false);
    expect(coversSlide(p, f({ locked: true }))).toBe(false);
    expect(coversSlide(p, f({ play: { mediaId: 'clip' } }))).toBe(false);
    expect(coversSlide(p, text('t', 'x', { box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 } }))).toBe(
      false,
    );
    const area = { x: 240, y: 0, w: 1440, h: 1080 };
    const four3 = deck([slide('s1', [f({ box: { ...area, rotation: 0 } })])], {
      source: {
        kind: 'pptx',
        fileId: 'f',
        native: { version: 1, slides: 1, native: 1, hybrid: 0, picture: 0, slideRect: area },
      },
    });
    // On a 4:3 deck a picture covering only the slide area stays a picture: as a background (cover-fit over
    // the whole frame) it would grow into the bars and lose a quarter of its height.
    expect(coversSlide(four3, f({ box: { ...area, rotation: 0 } }))).toBe(false);
    expect(coversSlide(four3, f({}))).toBe(true);
    expect(coversSlide(p, f({ box: { ...area, rotation: 0 } }))).toBe(false);
    expect(useAsBackground(four3, 's1', 'i')).toBe(four3);
  });
});

// ---- the actions ---------------------------------------------------------------------------------------

describe('the actions: one undo step each, saved with the presentation', () => {
  const p = () =>
    deck(
      [
        slide('s1', [announcement(), image('full', 'photo')]),
        slide('s2', [
          text('t2', 'Sunday 12 May again', {
            origin: { src: 'pptx', ph: 'title' },
            style: style({ color: RED }),
          }),
        ]),
        slide('s3', [text('t3', 'Title', { origin: { src: 'pptx', ph: 'title' } })]),
      ],
      { backgroundMediaId: 'old' },
    );
  beforeEach(() => {
    openPresentation(p());
    selectSlide('s1');
  });
  const draft = () => useEditor.getState().draft!;

  it('find and replace: the count, one undo step back to the original', () => {
    expect(actions.findAndReplace('12 May', '19 May')).toBe(2);
    expect(useEditor.getState()).toMatchObject({ dirty: true, canUndo: true });
    expect(obj<TextObject>(draft(), 's2', 't2').text).toBe('Sunday 19 May again');
    undo();
    expect(draft()).toEqual(p());
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it('hide, the background replace (both scopes) and replace on all slides', () => {
    actions.setSlideHidden('s3', true);
    expect(sl(draft(), 's3').hidden).toBe(true);
    actions.replaceBackgroundWith('s2', SQUARE, 'slide');
    expect(sl(draft(), 's2').backgroundMediaId).toBe('square');
    actions.replaceBackgroundWith('s1', PORTRAIT, 'all');
    expect(draft().backgroundMediaId).toBe('portrait');
    actions.replaceDeckBackground('portrait', SERIES);
    expect(draft().backgroundMediaId).toBe('series');
    for (let i = 0; i < 4; i++) undo();
    expect(draft()).toEqual(p());
  });

  it("'Apply to similar boxes' counts, 'New slide like this' opens the new slide", () => {
    expect(actions.applyToSimilar('t1')).toBe(0);
    expect(useEditor.getState().canUndo).toBe(false);
    selectSlide('s2');
    actions.addSlideLike('s2');
    const ed = useEditor.getState();
    const ids = ed.draft!.sections.flatMap((s) => s.slides.map((x) => x.id));
    expect(ids).toHaveLength(4);
    expect(ed.slideId).toBe(ids[2]);
    // The new slide's title has the look of slide 2's: applied to the similar boxes, only slide 3's changes.
    expect(actions.applyToSimilar(sl(ed.draft!, ids[2]!).objects[0]!.id)).toBe(1);
    expect(obj<TextObject>(draft(), 's3', 't3').style.color).toEqual(RED);
    undo();
    undo();
    expect(draft()).toEqual(p());
  });

  it("'Use as background' deselects the picture it moved", () => {
    selectObject('full');
    actions.pictureToBackground('full');
    expect(sl(draft(), 's1').backgroundMediaId).toBe('photo');
    expect(useEditor.getState()).toMatchObject({ objectId: undefined, objectIds: [] });
    selectObject('t1');
    actions.pictureToBackground('t1');
    expect(useEditor.getState().objectId).toBe('t1');
  });
});

// ---- the UI --------------------------------------------------------------------------------------------

const noop = () => undefined;
const html = (el: ReactElement) => renderToStaticMarkup(el);
/** Markup as text: tags removed, entities decoded, spaces collapsed. */
const textOf = (h: string) =>
  h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
/**
 * Server rendering reads a zustand store's initial state (useSyncExternalStore's server snapshot), so the
 * component tests seed it there as well as in the live state.
 */
function seed<T extends object>(
  store: { getInitialState: () => T; setState: (p: Partial<T>) => void },
  p: Partial<T>,
) {
  Object.assign(store.getInitialState(), p);
  store.setState(p);
}

describe("Find's match rows open the match for inline editing (goToMatch)", () => {
  const p = deck([
    slide('s1', [text('t1', 'Welcome')]),
    slide('s2', [announcement(), text('art', 'Sunday 12 May', { locked: true })]),
  ]);
  beforeEach(() => openPresentation(p));
  const row = (objectId: string, unseen = false) =>
    ({ ...findRows(p, findText(p, '12 May')).find((r) => r.objectId === objectId)!, unseen }) as Parameters<
      typeof goToMatch
    >[0];

  it('opens the slide, selects the match and starts inline editing on the canvas with it selected', () => {
    const r = row(announcement().id);
    expect(goToMatch(r, false)).toBe(true);
    const st = useEditor.getState();
    expect(st).toMatchObject({ slideId: 's2', objectId: r.objectId, inlineEditingId: r.objectId });
    expect(st.textRange).toEqual({ start: r.start, end: r.end, caret: r.end });
  });

  it('only highlights the match when it cannot be edited: live-locked, a locked box, not drawn', () => {
    for (const [r, ro] of [
      [row(announcement().id), true],
      // A locked box (Find leaves PowerPoint art out; a row for one would still only highlight).
      [{ ...row(announcement().id), objectId: 'art', start: 7, end: 13 }, false],
      [row(announcement().id, true), false],
    ] as const) {
      openPresentation(p);
      expect(goToMatch(r, ro)).toBe(false);
      const st = useEditor.getState();
      expect(st.objectId).toBe(r.objectId);
      expect(st.textRange).toMatchObject({ start: r.start, end: r.end });
      expect(st.inlineEditingId).toBeUndefined();
    }
  });
});

describe('the Find and replace dialog', () => {
  const p = deck([
    slide('s1', [text('t1', 'Welcome')]),
    slide('s2', [announcement()]),
    slide('s3', [text('t3', 'Sunday\nlunch on Sunday 12 May', {})], { hidden: true }),
  ]);
  const view = (x: Partial<FindReplaceViewProps> = {}) => {
    const matches = findText(p, x.find ?? '12 May');
    return html(
      createElement(FindReplaceView, {
        find: '12 May',
        repl: '19 May',
        opts: {},
        rows: findRows(p, matches),
        total: matches.length,
        summary: matchSummary(x.find ?? '12 May', matches),
        readOnly: false,
        onFind: noop,
        onRepl: noop,
        onOpts: noop,
        onReplace: noop,
        onGo: noop,
        onClose: noop,
        ...x,
      }),
    );
  };

  it('numbers slides across sections and shows the text around each match', () => {
    const rows = findRows(p, findText(p, 'sunday'));
    expect(rows.map((r) => [r.slide, r.before, r.match, r.after, r.hidden])).toEqual([
      [2, 'Potluck lunch on ', 'Sunday', ' 12 May in the hall ⏎ Brin…', false],
      [3, '', 'Sunday', ' ⏎ lunch on Sunday 12 May', true],
      [3, 'Sunday ⏎ lunch on ', 'Sunday', ' 12 May', true],
    ]);
    expect(matchSummary('sunday', findText(p, 'sunday'))).toBe('3 matches on 2 slides.');
    expect(matchSummary('x', [])).toBe('No matches.');
    expect(matchSummary('', [])).toBe('Type the text to find.');
    const many = Array.from({ length: LIST_LIMIT + 5 }, (_, i) => ({
      slideId: 's1',
      objectId: 't1',
      start: i % 7,
      end: (i % 7) + 1,
    }));
    expect(findRows(p, many)).toHaveLength(LIST_LIMIT);
  });

  it('labels its fields, keeps check boxes in their labels and announces the count', () => {
    const out = view();
    expect(out).toContain('role="dialog"');
    expect(out).toMatch(/<label class="field"><span>Find<\/span><input[^>]*value="12 May"/);
    expect(out).toMatch(/<label class="field"><span>Replace with<\/span><input[^>]*value="19 May"/);
    expect(out).toMatch(/<label class="check"><input type="checkbox"[^>]*\/>Match case<\/label>/);
    expect(out).toMatch(/<label class="check"><input type="checkbox"[^>]*\/>Whole words<\/label>/);
    expect(out).toMatch(/role="status" aria-live="polite"[^>]*>2 matches on 2 slides\.</);
    expect(textOf(out)).toContain('Slide 2 Potluck lunch on Sunday 12 May in the hall');
    expect(out).toContain('<mark>12 May</mark>');
    expect(out.match(/data-find-row/g)).toHaveLength(2);
    expect(out).toContain('<span class="tag">Hidden</span>');
    expect(out).toMatch(/aria-label="Open slide 3: [^"]*12 May"/);
    expect(out).toMatch(/<button type="button" class="primary">Replace all<\/button>/);
  });

  it('marks a match the screens do not show: its slide shows the PowerPoint picture', () => {
    const imported = text('t9', 'Potluck on Sunday 12 May', { origin: { src: 'pptx', shapeId: 4 } });
    const mine = text('t10', 'Also 12 May');
    const q = deck([
      slide('s1', [imported, mine], {
        pptx: { fileId: 'f', index: 0, class: 'native', version: 1, refMediaId: 'ref', show: 'picture' },
      }),
      slide('s2', [text('t2', 'See you on 12 May')]),
    ]);
    const matches = findText(q, '12 May');
    expect(findRows(q, matches).map((r) => [r.objectId, r.unseen])).toEqual([
      ['t9', true],
      ['t10', false],
      ['t2', false],
    ]);
    expect(unseenSlides(q, matches)).toBe(1);
    const out = html(
      createElement(FindReplaceView, {
        find: '12 May',
        repl: '19 May',
        opts: {},
        rows: findRows(q, matches),
        total: matches.length,
        summary: matchSummary('12 May', matches),
        readOnly: false,
        onFind: noop,
        onRepl: noop,
        onOpts: noop,
        onReplace: noop,
        onGo: noop,
        onClose: noop,
      }),
    );
    expect(out.match(/Shown as the PowerPoint picture/g)).toHaveLength(1);
    expect(replacedMessage(3, 2, 1)).toBe(
      "Replaced 3 matches on 2 slides. 1 of those slides shows its PowerPoint picture on the screens, so the change does not show there ('Show the objects instead' on the PowerPoint card shows it). Undo puts them back.",
    );
    expect(replacedMessage(1, 1, 1)).toContain(
      'Replaced 1 match on 1 slide. That slide shows its PowerPoint picture',
    );
    expect(replacedMessage(2, 2, 0)).toBe('Replaced 2 matches on 2 slides. Undo puts them back.');
    expect(replacedMessage(0, 0, 0)).toBe('Nothing was replaced.');
  });

  it('Replace all is disabled with nothing found or while the presentation is locked', () => {
    expect(view({ find: 'Christmas' })).toMatch(
      /<button type="button" class="primary" disabled="">Replace all/,
    );
    const locked = view({ readOnly: true });
    expect(locked).toMatch(/class="primary" disabled="">Replace all/);
    expect(locked).toMatch(/<input[^>]*disabled=""[^>]*data-replace-input/);
    expect(view({ done: 'Replaced 2 matches on 2 slides. Undo puts them back.' })).toContain(
      'data-find-done',
    );
  });
});

describe('the background sections', () => {
  const props = {
    name: 'Series art',
    from: 'object' as const,
    scope: 'slide' as const,
    count: 3,
    ownBackground: false,
    hasDefault: false,
    readOnly: false,
    onScope: noop,
    onReplace: noop,
    onRemove: noop,
  };

  it('shows the picture, where it comes from, Replace and the scope as a radio group', () => {
    const out = html(createElement(BackgroundReplaceView, props));
    expect(textOf(out)).toContain('Background Series art From PowerPoint Replace…');
    expect(out).toMatch(/<fieldset[^>]*><legend[^>]*>Replace on<\/legend>/);
    const radios = out.match(/<input type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain('checked');
    expect(radios[1]).not.toContain('checked');
    expect(textOf(out)).toContain('This slide');
    expect(textOf(out)).toContain('All 3 slides using it');
    expect(out.match(/<label class="check">/g)).toHaveLength(2);
    expect(out).not.toContain('None');
  });

  it("offers 'None' or 'Use the default' for the slide's own background, and locks with the presentation", () => {
    const own = html(
      createElement(BackgroundReplaceView, { ...props, from: 'slide', ownBackground: true, scope: 'all' }),
    );
    expect(textOf(own)).toContain('This slide only');
    expect(own).toContain('>None</button>');
    expect((own.match(/<input type="radio"[^>]*>/g) ?? [])[1]).toContain('checked');
    const dflt = html(
      createElement(BackgroundReplaceView, {
        ...props,
        from: 'slide',
        ownBackground: true,
        hasDefault: true,
      }),
    );
    expect(dflt).toContain('>Use the default</button>');
    const none = html(
      createElement(BackgroundReplaceView, { ...props, name: 'None', from: undefined, count: 1 }),
    );
    expect(textOf(none)).toContain('No background picture');
    expect(textOf(none)).toContain('All 1 slide without a background picture');
    const locked = html(createElement(BackgroundReplaceView, { ...props, readOnly: true }));
    expect(locked).toMatch(/<button type="button" class="small" disabled="">Replace…/);
    expect(locked).toMatch(/<fieldset[^>]*disabled=""/);
  });

  it("'Replace on all slides' says what it replaces", () => {
    const out = html(
      createElement(ReplaceOnAllSlidesView, {
        name: 'Series art',
        count: 12,
        readOnly: false,
        onReplace: noop,
      }),
    );
    expect(textOf(out)).toBe('Series art is the background of 12 slides. Replace on all slides…');
    const none = html(createElement(ReplaceOnAllSlidesView, { count: 0, readOnly: false, onReplace: noop }));
    expect(none).toMatch(/disabled="">Replace on all slides/);
  });
});

describe('the Object panel and slide list actions', () => {
  it("'Apply to similar boxes…' and 'Use as background', only where they apply", () => {
    const base = {
      similar: 0,
      similarSlides: 0,
      covers: false,
      readOnly: false,
      onApply: noop,
      onBackground: noop,
    };
    expect(html(createElement(ObjectSlideOpsView, base))).toBe('');
    const both = html(
      createElement(ObjectSlideOpsView, { ...base, similar: 12, similarSlides: 11, covers: true }),
    );
    expect(textOf(both)).toContain('Apply to similar boxes… 12 boxes on 11 other slides come from the same');
    expect(textOf(both)).toContain('Use as background');
    expect(similarQuestion(12, 12)).toMatch(/^Apply to 12 boxes on 12 slides\?/);
    expect(similarQuestion(1, 1)).toMatch(/^Apply to 1 box on 1 slide\?/);
  });

  it("'Hidden' is a toggle button", () => {
    const on = html(createElement(HideSlideToggle, { hidden: true, onToggle: noop }));
    expect(on).toMatch(
      /<button type="button" class="small ed-vis-pill is-hidden" aria-pressed="true"[^>]*>Hidden in service<\/button>/,
    );
    expect(on).toContain('Next skips this slide; a click in the slide grid shows it.');
    const off = html(createElement(HideSlideToggle, { hidden: false, onToggle: noop }));
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('Visible in service');
  });

  const ui = deck(
    [
      slide('s1', [
        text('title', 'Welcome', { origin: { src: 'pptx', ph: 'title' } }),
        image('full', 'photo'),
      ]),
      slide('s2', [text('t2', 'Notices', { origin: { src: 'pptx', ph: 'title' } })], { hidden: true }),
      slide('s3', [shape('solid', { origin: bg })]),
    ],
    { backgroundMediaId: 'series' },
  );
  const open = (slideId: string, objectId?: string) => {
    seed(useEditor, {
      id: ui.id,
      draft: ui,
      base: ui,
      slideId,
      objectId,
      objectIds: objectId ? [objectId] : [],
    });
  };

  it('the slide list dims a hidden slide and offers New slide like this and Hidden for the selected one', async () => {
    open('s2');
    const { SlidesPanel } = await import('../src/views/editor/SlidesPanel.tsx');
    const out = html(createElement(SlidesPanel, { p: ui, readOnly: false }));
    const items = out.match(/<div[^>]*data-slide-id="[^"]*"[^>]*>/g) ?? [];
    expect(items).toHaveLength(3);
    expect(items.map((x) => x.includes('hidden-slide'))).toEqual([false, true, false]);
    expect(HIDDEN_DIM.opacity).toBeLessThan(1);
    expect(out).toContain('opacity:0.4');
    expect(out).toContain('data-new-slide-like');
    expect(out).toMatch(/aria-pressed="true"[^>]*data-hide-slide/);
  });

  it('the Slide panel has the background section, the Presentation panel Replace on all slides', async () => {
    seed(useLibrary, { data: { ...useLibrary.getState().data, media: [] } });
    open('s1');
    const { SlidePanel } = await import('../src/views/editor/SlidePanel.tsx');
    const sp = html(createElement(SlidePanel, { slide: sl(ui, 's1'), p: ui, readOnly: false }));
    expect(sp).toContain('data-slide-background');
    expect(textOf(sp)).toContain("The presentation's default");
    // Slide 3's solid PowerPoint background lies over the default, which it still uses.
    expect(textOf(sp)).toContain('All 3 slides using it');
    const { PresentationPanel } = await import('../src/views/editor/PresentationPanel.tsx');
    const pp = html(createElement(PresentationPanel, { p: ui, readOnly: false }));
    expect(textOf(pp)).toContain('Missing media is the background of 3 slides. Replace on all slides…');
  });

  it('the Object panel offers the actions for a placeholder box and a full-slide picture', async () => {
    const { ObjectPanel } = await import('../src/views/editor/ObjectPanel.tsx');
    open('s1', 'title');
    const t = html(createElement(ObjectPanel, { o: obj(ui, 's1', 'title'), readOnly: false }));
    expect(textOf(t)).toContain('Apply to similar boxes… 1 box on 1 other slide');
    expect(t).not.toContain('Use as background');
    open('s1', 'full');
    const i = html(createElement(ObjectPanel, { o: obj(ui, 's1', 'full'), readOnly: false }));
    expect(i).toContain('Use as background');
    expect(i).not.toContain('Apply to similar boxes');
  });

  it("the editor toolbar has 'Find…'", async () => {
    open('s1');
    const { EditorView } = await import('../src/views/editor/EditorView.tsx');
    const out = html(createElement(EditorView, { id: ui.id }));
    expect(out).toMatch(/<button type="button"[^>]*title="Find and replace \(Ctrl\+F\)">Find…<\/button>/);
  });
});
