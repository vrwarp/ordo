/**
 * The Lyric Script (songScript.ts, SongReflowEditor.tsx; design/15 "Lyric Script"): each slide's field shows
 * its lyric object's own text and writes it back through `editText`, so typing never writes the automatic
 * numbers into the text again and again ('1. 1. Amazing grace') and bold and italic stay on their letters.
 * Every split (Split at Cursor and Alt+Enter, Auto-Split, '---' and Enter) cuts that same raw text through
 * the domain's slide split, so both halves keep their runs and paragraph styles.
 */
import { DEFAULT_THEME, firstText, type Presentation, type Slide, type TextObject } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { getSlide, splitSlide, splitSlidePieces } from '../src/views/editor/ops.ts';
import {
  caretPieces,
  markerPieces,
  scriptLines,
  scriptTarget,
  scriptText,
  splitScript,
  twoLinePieces,
  typeScript,
  withScriptText,
} from '../src/views/editor/songScript.ts';

const LYRIC = 'Amazing grace\nHow sweet the sound';

function slide(extra: Partial<TextObject> = {}, text = LYRIC): Slide {
  return {
    id: 's1',
    lyricObjectId: 'lyric',
    notes: 'G C D',
    objects: [
      {
        id: 'note',
        type: 'text',
        box: { x: 0, y: 0, w: 400, h: 100, rotation: 0 },
        text: 'A note',
        style: { ...DEFAULT_THEME.textBoxDefaults },
        opacity: 1,
      },
      {
        id: 'lyric',
        type: 'text',
        box: { ...DEFAULT_THEME.lyricBox },
        text,
        style: { ...DEFAULT_THEME.text },
        opacity: 1,
        // Numbered paragraphs, 'sweet' bold.
        paras: text.split('\n').map(() => ({ bullet: { auto: 'arabicPeriod' } })),
        runs: [{ start: 18, end: 23, fontWeight: 700 }],
        ...extra,
      } as TextObject,
    ],
  } as Slide;
}

function song(s: Slide = slide()): Presentation {
  return {
    id: 'p1',
    rev: 1,
    title: 'Amazing Grace',
    kind: 'song',
    sections: [{ id: 'v1', label: 'Verse 1', short: 'V1', slides: [s, { id: 's2', objects: [] } as Slide] }],
    arrangements: [],
  } as unknown as Presentation;
}

/** The field's edit: `at` replaced by `insert` in what the field shows, the caret after it. */
function typeInto(s: Slide, at: number, insert: string, del = 0): Slide {
  const shown = scriptText(s);
  const next = shown.slice(0, at) + insert + shown.slice(at + del);
  return withScriptText(s, next, DEFAULT_THEME, at + insert.length);
}

const lyricOf = (s: Slide) => scriptTarget(s) as TextObject;
const bold = (o: TextObject) =>
  (o.runs ?? []).filter((r) => r.fontWeight === 700).map((r) => o.text.slice(r.start, r.end));
const slidesOf = (p: Presentation) => p.sections.flatMap((sec) => sec.slides);
const lyrics = (p: Presentation) => slidesOf(p).map((s) => scriptText(s));

describe('the Lyric Script field', () => {
  it('shows the lyric object’s stored text, without the automatic numbers the screens add', () => {
    const s = slide();
    expect(firstText(s)).toBe('1.\u00a0Amazing grace\n2.\u00a0How sweet the sound');
    expect(scriptText(s)).toBe(LYRIC);
    expect(scriptTarget(s)?.id).toBe('lyric');
  });

  it('typing never writes the numbers into the text, however many keystrokes', () => {
    let s = slide();
    for (const ch of [' ', 'o', 'h']) s = typeInto(s, scriptText(s).indexOf('\n'), ch);
    expect(lyricOf(s).text).toBe('Amazing grace oh\nHow sweet the sound');
    // The numbering stays a paragraph style, one per paragraph.
    expect(lyricOf(s).paras).toEqual(lyricOf(slide()).paras);
    expect(firstText(s)).toBe('1.\u00a0Amazing grace oh\n2.\u00a0How sweet the sound');
  });

  it('keeps bold on the letters it was on when a line is added in front', () => {
    const s = typeInto(slide(), 0, 'Verse one\n');
    const o = lyricOf(s);
    expect(o.text).toBe(`Verse one\n${LYRIC}`);
    expect(bold(o)).toEqual(['sweet']);
    // Enter copies the paragraph's style: three numbered paragraphs.
    expect(o.paras).toHaveLength(3);
  });

  it('keeps italic on its word when a typo before it is fixed', () => {
    const s0 = slide({ runs: [{ start: 24, end: 27, fontStyle: 'italic' }] });
    const italic = (o: TextObject) =>
      (o.runs ?? []).filter((r) => r.fontStyle === 'italic').map((r) => o.text.slice(r.start, r.end));
    expect(italic(lyricOf(s0))).toEqual(['the']);
    const typo = typeInto(s0, 20, 'e');
    expect(italic(lyricOf(typo))).toEqual(['the']);
    const fixed = typeInto(typo, 20, '', 1);
    expect(lyricOf(fixed).text).toBe(LYRIC);
    expect(lyricOf(fixed).runs).toEqual([{ start: 24, end: 27, fontStyle: 'italic' }]);
  });

  it('a plain song (no runs, no paragraph styles) stays plain', () => {
    const s = typeInto(slide({ runs: undefined, paras: undefined }), 0, 'O ');
    expect(lyricOf(s).text).toBe(`O ${LYRIC}`);
    expect(lyricOf(s).runs).toBeUndefined();
    expect(lyricOf(s).paras).toBeUndefined();
  });

  it('a slide without a text object gets a lyric object in the theme’s lyric box', () => {
    const empty: Slide = { id: 's2', objects: [] } as unknown as Slide;
    expect(scriptText(empty)).toBe('');
    expect(withScriptText(empty, '', DEFAULT_THEME, 0)).toBe(empty);
    const s = withScriptText(empty, 'New words', DEFAULT_THEME, 9);
    const o = s.objects[0] as TextObject;
    expect(s.lyricObjectId).toBe(o.id);
    expect(o.text).toBe('New words');
    expect(o.box).toEqual(DEFAULT_THEME.lyricBox);
  });

  it('an unchanged value records no undo step: the slide and the presentation are returned as they are', () => {
    const s = slide();
    expect(withScriptText(s, LYRIC, DEFAULT_THEME, 3)).toBe(s);
    const p = song(s);
    expect(typeScript(p, 's1', LYRIC, DEFAULT_THEME, 3)).toBe(p);
    expect(typeScript(p, 'nope', 'x', DEFAULT_THEME, 1)).toBe(p);
    expect(typeScript(p, 's1', `${LYRIC}!`, DEFAULT_THEME, LYRIC.length + 1)).not.toBe(p);
  });
});

describe('Split at Cursor and Alt+Enter (caretPieces)', () => {
  it('cuts at the caret, without the line break at the cut', () => {
    expect(caretPieces(LYRIC, 14)).toEqual([
      [0, 13],
      [14, LYRIC.length],
    ]);
    expect(caretPieces(LYRIC, 13)).toEqual([
      [0, 13],
      [14, LYRIC.length],
    ]);
    // Inside a word: the volunteer chose that place.
    expect(caretPieces(LYRIC, 4)).toEqual([
      [0, 4],
      [4, LYRIC.length],
    ]);
  });

  it('at the end gives an empty next slide; at the start or without a caret, nothing (never a midpoint cut)', () => {
    expect(caretPieces(LYRIC, LYRIC.length)).toEqual([
      [0, LYRIC.length],
      [LYRIC.length, LYRIC.length],
    ]);
    expect(caretPieces(`${LYRIC}\n\n`, LYRIC.length + 1)).toEqual([
      [0, LYRIC.length],
      [LYRIC.length + 2, LYRIC.length + 2],
    ]);
    expect(caretPieces(LYRIC, 0)).toBeNull();
    expect(caretPieces(`\n\n${LYRIC}`, 1)).toBeNull();
    expect(caretPieces(LYRIC, undefined)).toBeNull();
    expect(caretPieces('', 0)).toBeNull();
    expect(caretPieces(LYRIC, Number.NaN)).toBeNull();
  });

  it('keeps bold on its word and numbering on both halves, and never writes "1. 1."', () => {
    const p = song();
    const out = splitScript(p, 's1', (t) => caretPieces(t, 14), DEFAULT_THEME);
    expect(out.ids).toHaveLength(1);
    expect(lyrics(out.p)).toEqual(['Amazing grace', 'How sweet the sound', '']);
    const [a, b] = slidesOf(out.p);
    expect(a!.id).toBe('s1');
    expect(firstText(a!)).toBe('1.\u00a0Amazing grace');
    expect(firstText(b!)).toBe('1.\u00a0How sweet the sound');
    expect(bold(lyricOf(b!))).toEqual(['sweet']);
    expect(bold(lyricOf(a!))).toEqual([]);
    for (const s of slidesOf(out.p)) expect(scriptText(s)).not.toMatch(/\d\.[\s\u00a0]/);
    // The new slide is a copy of the slide (its other objects, fresh ids), as 'Split lyrics' makes it.
    expect(b!.id).toBe(out.ids[0]);
    expect(b!.objects.map((o) => o.type)).toEqual(['text', 'text']);
    expect(b!.objects.some((o) => o.id === 'lyric' || o.id === 'note')).toBe(false);
    expect(b!.lyricObjectId).toBe(lyricOf(b!).id);
  });

  it('a cut inside a bold word leaves each half of it bold', () => {
    const out = splitScript(song(), 's1', (t) => caretPieces(t, 20), DEFAULT_THEME);
    const [a, b] = slidesOf(out.p);
    expect(scriptText(a!)).toBe('Amazing grace\nHow sw');
    expect(bold(lyricOf(a!))).toEqual(['sw']);
    expect(scriptText(b!)).toBe('eet the sound');
    expect(bold(lyricOf(b!))).toEqual(['eet']);
  });

  it('nothing to split leaves the presentation itself (no undo step)', () => {
    const p = song();
    expect(splitScript(p, 's1', (t) => caretPieces(t, 0), DEFAULT_THEME)).toEqual({ p, ids: [] });
    expect(splitScript(p, 's2', (t) => caretPieces(t, 3), DEFAULT_THEME).p).toBe(p);
  });
});

describe('Auto-Split (2 lines) and the stream tag', () => {
  const FOUR = 'One\nTwo\n\nThree\nFour\nFive';

  it('counts and groups the raw lines that hold words', () => {
    expect(scriptLines(FOUR).map(([a, b]) => FOUR.slice(a, b))).toEqual([
      'One',
      'Two',
      'Three',
      'Four',
      'Five',
    ]);
    expect(scriptLines('  \n\n')).toEqual([]);
    expect(twoLinePieces('One\nTwo')).toBeNull();
    expect(twoLinePieces(FOUR)?.map(([a, b]) => FOUR.slice(a, b))).toEqual([
      'One\nTwo',
      'Three\nFour',
      'Five',
    ]);
  });

  it('keeps numbering and bold on the right lines of every slide it makes', () => {
    const text = 'Amazing grace\nHow sweet the sound\nThat saved\nA wretch like me';
    const p = song(slide({}, text));
    const out = splitScript(p, 's1', twoLinePieces, DEFAULT_THEME);
    expect(out.ids).toHaveLength(1);
    const [a, b] = slidesOf(out.p);
    expect(scriptText(a!)).toBe('Amazing grace\nHow sweet the sound');
    expect(scriptText(b!)).toBe('That saved\nA wretch like me');
    expect(bold(lyricOf(a!))).toEqual(['sweet']);
    expect(bold(lyricOf(b!))).toEqual([]);
    expect(firstText(b!)).toBe('1.\u00a0That saved\n2.\u00a0A wretch like me');
  });
});

describe("'---' and Enter (markerPieces)", () => {
  it('finds the typed splits, an empty piece at the end being an empty slide', () => {
    const t = 'One\nTwo\n---\nThree';
    expect(markerPieces(t)?.map(([a, b]) => t.slice(a, b))).toEqual(['One\nTwo', 'Three']);
    const end = 'One\n---\n';
    expect(markerPieces(end)?.map(([a, b]) => end.slice(a, b))).toEqual(['One', '']);
    expect(markerPieces('One\n---')).toBeNull();
    expect(markerPieces('One --- two')).toBeNull();
  });

  it('stores the typed value through editText first, then splits it with its formatting', () => {
    const p = song();
    const typed = 'Amazing grace\n---\nHow sweet the sound';
    const out = splitScript(p, 's1', markerPieces, DEFAULT_THEME, { text: typed, caret: 18 });
    const [a, b] = slidesOf(out.p);
    expect(scriptText(a!)).toBe('Amazing grace');
    expect(scriptText(b!)).toBe('How sweet the sound');
    expect(bold(lyricOf(b!))).toEqual(['sweet']);
    expect(firstText(b!)).toBe('1.\u00a0How sweet the sound');
  });
});

describe('the domain slide split (splitSlidePieces)', () => {
  it('is what Split lyrics uses: the same slides as before for a line cut', () => {
    const p = song();
    const a = splitSlide(p, 's1', 1);
    expect(lyrics(a)).toEqual(['Amazing grace', 'How sweet the sound', '']);
    expect(bold(lyricOf(slidesOf(a)[1]!))).toEqual(['sweet']);
  });

  it('keeps a section within the schema’s 5,000 slides: the last pieces stay together', () => {
    const many: Slide[] = Array.from(
      { length: 4997 },
      (_, i) => ({ id: `x${i}`, objects: [] }) as unknown as Slide,
    );
    const p = song();
    const full = {
      ...p,
      sections: [{ ...p.sections[0]!, slides: [...p.sections[0]!.slides, ...many] }],
    } as Presentation;
    const out = splitSlidePieces(full, 's1', [
      [0, 3],
      [4, 8],
      [9, LYRIC.length],
    ]);
    expect(out.ids).toHaveLength(1);
    expect(out.p.sections[0]!.slides).toHaveLength(5000);
    expect(scriptText(getSlide(out.p, 's1')!)).toBe(LYRIC.slice(0, 3));
    expect(scriptText(getSlide(out.p, out.ids[0]!)!)).toBe(LYRIC.slice(4));
  });
});
