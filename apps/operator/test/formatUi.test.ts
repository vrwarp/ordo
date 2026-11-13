/**
 * The editor's format UI (M4 item C; design/27 §11 items 2-4): the format bar, the paragraph strip, the text
 * box options of TextStyleEditor, the overflow test and the canvas guides. The patches each control sends
 * are pure functions tested here; the components are split into a store-bound wrapper and a props-only
 * view rendered to markup (as `pptxImportUi.test.ts` does); `e2e/editor-format.spec.ts` drives them in the
 * real editor over item A's ops.
 */
import {
  DEFAULT_THEME,
  type Presentation,
  type Rgba,
  type SlideObject,
  type TextObject,
  type TextStyle,
  type Theme,
} from '@ordo/domain';
import { LEGACY_FONT_ENV } from '@ordo/renderer';
import { recordingCtx, testMeasurer } from '@ordo/renderer/text/test-util.ts';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  insetsOf,
  TextStyleEditor,
  withFallback,
  withField,
  withInset,
} from '../src/components/TextStyleEditor.tsx';
import { useLibrary } from '../src/state/library.ts';
import {
  barsOutside,
  CanvasGuides,
  deckArea,
  guideMarks,
  OVERFLOW_STROKE,
} from '../src/views/editor/CanvasGuides.tsx';
import { openPresentation, selectObject, selectSlide, useEditor } from '../src/views/editor/editorStore.ts';
import {
  barState,
  DECK_SWATCHES,
  deckColors,
  FormatBarView,
  HIGHLIGHTS,
  SIZE_STEP,
  STANDARD_COLORS,
  SUBSCRIPT,
  SUPERSCRIPT,
  shortcutOf,
  togglePatch,
  validLang,
  valuePatch,
} from '../src/views/editor/FormatBar.tsx';
import { CLEAR_FORMATTING, type SelectionParas, type SelectionStyle } from '../src/views/editor/ops/text.ts';
import {
  alignOf,
  alignPatch,
  BULLET_CHARS,
  dirOf,
  dirPatch,
  hangFor,
  INDENT_STEP,
  lineMode,
  lineModePatch,
  lineStart,
  listChoice,
  listPatch,
  MAX_LEVEL,
  NUMBERINGS,
  ParagraphStripView,
  paraSteps,
  startAtPatch,
  touchedHeads,
} from '../src/views/editor/ParagraphStrip.tsx';
import { fitMessage, overflowingText, textOverflows } from '../src/views/editor/textFit.ts';

// ---- fixtures ------------------------------------------------------------------------------------------

const red: Rgba = { r: 200, g: 40, b: 40, a: 1 };
const navy: Rgba = { r: 31, g: 78, b: 121, a: 1 };
const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const box = { x: 100, y: 100, w: 800, h: 300, rotation: 0 };
const style = (s: Partial<TextStyle> = {}): TextStyle => ({ ...DEFAULT_THEME.textBoxDefaults, ...s });
const text = (o: Partial<TextObject> = {}): TextObject => ({
  id: 't1',
  type: 'text',
  box,
  text: 'Potluck on Sunday 12 May',
  style: style({ fontSizePx: 40, color: white }),
  opacity: 1,
  ...o,
});
/** A selection's style as item A's `selectionStyle` resolves it (box values filled in). */
const sel = (style: SelectionStyle['style'] = {}, mixed: SelectionStyle['mixed'] = []): SelectionStyle => ({
  style,
  mixed,
});
const paras = (para: SelectionParas['para'] = {}, mixed: SelectionParas['mixed'] = []): SelectionParas => ({
  para,
  mixed,
});
const noop = () => undefined;
const html = (el: ReactElement) => renderToStaticMarkup(el);
/** Markup as text: tags removed, entities decoded, spaces collapsed. */
const plain = (h: string) =>
  h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
/** The opening tag of the first element with `attr` (e.g. `aria-label="Bold"`). */
const tag = (h: string, attr: string) => {
  const m = new RegExp(`<[a-z]+ [^>]*${attr.replace(/[()[\]?+*.]/g, '\\$&')}[^>]*>`).exec(h);
  if (!m) throw new Error(`no element with ${attr}`);
  return m[0];
};

// ---- the overflow test (textFit.ts) --------------------------------------------------------------------

describe('the overflow test: laid out as the drawers lay it out', () => {
  // Every character is 0.5 em wide: at 40 px, 20 px; an 800 px box holds 40 characters a line.
  const probe = { measurer: testMeasurer({ em: 0.5 }), ctx: recordingCtx(0.5), env: LEGACY_FONT_ENV };
  const long = 'Amazing grace how sweet the sound that saved a wretch like me '.repeat(8).trim();

  it('rich text overflows a box too small for it, and fits a box large enough', () => {
    const rich = text({ text: long, runs: [], box: { ...box, h: 120 } });
    expect(textOverflows(rich, probe)).toBe(true);
    expect(textOverflows({ ...rich, box: { ...box, h: 1000 } }, probe)).toBe(false);
  });

  it('a shrink-to-fit box overflows only past the smallest fit', () => {
    const shrink = text({
      text: long,
      runs: [],
      box: { ...box, h: 180 },
      style: style({ fontSizePx: 40, autofit: 'shrink' }),
    });
    expect(textOverflows(shrink, probe)).toBe(false);
    const tiny = { ...shrink, box: { ...box, h: 20 }, text: long.repeat(6) };
    expect(textOverflows(tiny, probe)).toBe(true);
  });

  it('a line wider than a box that does not wrap overflows', () => {
    const line = text({
      text: 'A line far wider than its box',
      style: style({ fontSizePx: 40, wrap: false }),
      box: { ...box, w: 200 },
    });
    expect(textOverflows(line, probe)).toBe(true);
    expect(textOverflows({ ...line, box: { ...box, w: 1200 } }, probe)).toBe(false);
  });

  it('legacy text: lines taller than the box less its padding', () => {
    // 40 px at line height 1.2: 48 px a line; 2 lines in 100 px fit, 3 do not; padding counts.
    const legacy = text({
      text: 'one\ntwo',
      box: { ...box, h: 100 },
      style: style({ fontSizePx: 40, lineHeight: 1.2, padding: 0 }),
    });
    expect(textOverflows(legacy, probe)).toBe(false);
    expect(textOverflows({ ...legacy, text: 'one\ntwo\nthree' }, probe)).toBe(true);
    expect(textOverflows({ ...legacy, style: { ...legacy.style, padding: 10 } }, probe)).toBe(true);
  });

  it('blank text never overflows, and the default probe needs a canvas (none in node)', () => {
    expect(textOverflows(text({ text: '  \n ', box: { ...box, h: 1 } }), probe)).toBe(false);
    expect(textOverflows(text({ text: long, runs: [], box: { ...box, h: 10 } }))).toBe(false);
  });

  it('the Object panel says what to do', () => {
    const over = text({ text: long, runs: [], box: { ...box, h: 60 } });
    expect(fitMessage(over, probe)).toBe('Text does not fit: turn on Shrink text to fit or enlarge the box.');
    const shrunk = {
      ...over,
      text: long.repeat(6),
      box: { ...box, h: 20 },
      style: style({ autofit: 'shrink' }),
    };
    expect(fitMessage(shrunk, probe)).toBe(
      'Text does not fit, even shrunk: enlarge the box or shorten the text.',
    );
    expect(fitMessage({ ...over, box: { ...box, h: 2000 } }, probe)).toBeUndefined();
  });

  it('only text objects are tested', () => {
    const shape: SlideObject = { id: 's', type: 'shape', box, shape: 'rect', opacity: 1, radius: 0 };
    const over = text({ id: 'over', text: long, runs: [], box: { ...box, h: 60 } });
    const fits = text({ id: 'fits', text: 'Amen', runs: [] });
    expect(overflowingText([shape, over, fits], probe).map((o) => o.id)).toEqual(['over']);
  });
});

// ---- the canvas guides ---------------------------------------------------------------------------------

describe('the canvas guides: the overflow edge and the 4:3 guide', () => {
  const probe = { measurer: testMeasurer({ em: 0.5 }), ctx: recordingCtx(0.5), env: LEGACY_FONT_ENV };

  it('a 4:3 deck: its area outlined, the bars at its sides shaded; a 16:9 deck none', () => {
    const fourThree = { x: 240, y: 0, w: 1440, h: 1080 };
    expect(deckArea(fourThree)).toEqual(fourThree);
    expect(barsOutside(fourThree)).toEqual([
      { x: 0, y: 0, w: 240, h: 1080 },
      { x: 1680, y: 0, w: 240, h: 1080 },
    ]);
    expect(deckArea({ x: 0, y: 0, w: 1920, h: 1080 })).toBeUndefined();
    expect(deckArea({ x: 0.2, y: 0, w: 1919.7, h: 1080 })).toBeUndefined();
    expect(deckArea(undefined)).toBeUndefined();
    expect(deckArea({ x: Number.NaN, y: 0, w: 10, h: 10 })).toBeUndefined();
    expect(deckArea({ x: 0, y: 0, w: 0, h: 1080 })).toBeUndefined();
    // A wide deck (16:10 letterboxed) has bars above and below; a rect past the frame is cut to it.
    expect(barsOutside({ x: 0, y: 60, w: 1920, h: 960 })).toEqual([
      { x: 0, y: 0, w: 1920, h: 60 },
      { x: 0, y: 1020, w: 1920, h: 60 },
    ]);
    expect(deckArea({ x: -100, y: 0, w: 1200, h: 1080 })).toEqual({ x: 0, y: 0, w: 1100, h: 1080 });
  });

  it('marks the boxes whose text does not fit, rotation kept', () => {
    const over = text({
      id: 'over',
      text: 'word '.repeat(200),
      runs: [],
      box: { ...box, h: 50, rotation: 12 },
    });
    const g = guideMarks([over, text({ id: 'ok', text: 'Amen', runs: [] })], undefined, probe);
    expect(g).toEqual({ overflow: [{ id: 'over', box: over.box }], frame: undefined, bars: [] });
  });

  it('draws nothing without anything to show, and a group of guides otherwise', () => {
    expect(CanvasGuides({ objects: [], scale: 0.5 })).toBeNull();
    expect(CanvasGuides({ objects: [], scale: 0.5, slideRect: { x: 0, y: 0, w: 1920, h: 1080 } })).toBeNull();
    const el = CanvasGuides({ objects: [], scale: 0.5, slideRect: { x: 240, y: 0, w: 1440, h: 1080 } });
    expect(el).not.toBeNull();
    const kids = (el!.props as { children: unknown[] }).children.flat().filter(Boolean) as ReactElement[];
    const names = kids.map((k) => (k.props as { name: string }).name);
    expect(names).toEqual(['deck-bar', 'deck-bar', 'deck-area']);
    // Line widths are in screen px: 1.5 at any zoom.
    expect((kids[2]!.props as { strokeWidth: number }).strokeWidth).toBe(3);
    expect((kids[0]!.props as { listening: boolean }).listening).toBe(false);
    expect(OVERFLOW_STROKE).toBe('#ef4444');
  });
});

// ---- the format bar ------------------------------------------------------------------------------------

describe('the format bar: what each control applies', () => {
  const plainBox = text();
  const boldBox = text({ style: style({ fontWeight: 700, fontStyle: 'italic', underline: true }) });

  it('reads the box style where the selection says nothing (a stub or a plain run)', () => {
    const st = barState(plainBox, sel());
    expect(st).toMatchObject({
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      superscript: false,
      subscript: false,
      caps: 'none',
      color: white,
      highlight: 'none',
      font: plainBox.style.fontFamily,
      sizePx: 40,
      letterSpacing: plainBox.style.letterSpacing,
      outline: false,
      shadow: false,
      lang: '',
    });
    expect(barState(boldBox, sel())).toMatchObject({ bold: true, italic: true, underline: true });
    expect(barState(text({ style: style({ transform: 'uppercase' }) }), sel()).caps).toBe('all');
  });

  it('shows the selection: pressed, values, and mixed fields', () => {
    const st = barState(
      plainBox,
      sel({ fontWeight: 700, baseline: 0.3, color: red, sizeScale: 0.5, highlight: navy, caps: 'small' }, [
        'fontStyle',
        'fontFamily',
        'letterSpacing',
        'lang',
      ]),
    );
    expect(st).toMatchObject({
      bold: true,
      italic: 'mixed',
      superscript: true,
      subscript: false,
      caps: 'small',
      color: red,
      highlight: navy,
      sizePx: 20,
      font: undefined,
      letterSpacing: undefined,
      lang: undefined,
    });
    const mixed = barState(
      plainBox,
      sel({}, ['fontWeight', 'baseline', 'color', 'highlight', 'sizeScale', 'caps']),
    );
    expect(mixed).toMatchObject({
      bold: 'mixed',
      superscript: 'mixed',
      subscript: 'mixed',
      color: undefined,
      highlight: 'mixed',
      sizePx: undefined,
      caps: 'mixed',
    });
  });

  it('Bold, Italic and Underline: on over a plain box, off over a formatted one, no override where the box agrees', () => {
    const off = barState(plainBox, sel());
    expect(togglePatch('bold', plainBox, off)).toEqual({ fontWeight: 700 });
    expect(togglePatch('bold', plainBox, { ...off, bold: true })).toEqual({ fontWeight: undefined });
    expect(togglePatch('bold', plainBox, { ...off, bold: 'mixed' })).toEqual({ fontWeight: 700 });
    const on = barState(boldBox, sel());
    expect(togglePatch('bold', boldBox, on)).toEqual({ fontWeight: 400 });
    expect(togglePatch('bold', boldBox, { ...on, bold: false })).toEqual({ fontWeight: undefined });
    expect(togglePatch('italic', plainBox, off)).toEqual({ fontStyle: 'italic' });
    expect(togglePatch('italic', boldBox, on)).toEqual({ fontStyle: 'normal' });
    expect(togglePatch('underline', plainBox, off)).toEqual({ underline: true });
    expect(togglePatch('underline', boldBox, on)).toEqual({ underline: false });
    expect(togglePatch('strike', plainBox, off)).toEqual({ strike: true });
    expect(togglePatch('strike', plainBox, { ...off, strike: true })).toEqual({ strike: undefined });
  });

  it('Superscript and Subscript raise and lower verse numbers, and come back', () => {
    const off = barState(plainBox, sel());
    expect(togglePatch('superscript', plainBox, off)).toEqual({ baseline: SUPERSCRIPT });
    expect(SUPERSCRIPT).toBe(0.3);
    expect(togglePatch('subscript', plainBox, off)).toEqual({ baseline: SUBSCRIPT });
    expect(SUBSCRIPT).toBe(-0.25);
    const raised = barState(plainBox, sel({ baseline: 0.3 }));
    expect(togglePatch('superscript', plainBox, raised)).toEqual({ baseline: undefined });
    // Subscript over a raised number lowers it instead.
    expect(togglePatch('subscript', plainBox, raised)).toEqual({ baseline: SUBSCRIPT });
  });

  it('values equal to the box remove the override; Clear formatting removes every field', () => {
    expect(valuePatch.color(plainBox, white)).toEqual({ color: undefined });
    expect(valuePatch.color(plainBox, red)).toEqual({ color: red });
    expect(valuePatch.color(plainBox, undefined)).toEqual({ color: undefined });
    expect(valuePatch.highlight(navy)).toEqual({ highlight: navy });
    expect(valuePatch.font(plainBox, plainBox.style.fontFamily)).toEqual({ fontFamily: undefined });
    expect(valuePatch.font(plainBox, 'Gentium')).toEqual({ fontFamily: 'Gentium' });
    expect(valuePatch.caps(plainBox, 'none')).toEqual({ caps: undefined });
    expect(valuePatch.caps(text({ style: style({ transform: 'uppercase' }) }), 'none')).toEqual({
      caps: 'none',
    });
    expect(valuePatch.letterSpacing(plainBox, plainBox.style.letterSpacing)).toEqual({
      letterSpacing: undefined,
    });
    expect(valuePatch.letterSpacing(plainBox, 2)).toEqual({ letterSpacing: 2 });
    expect(valuePatch.outline(plainBox, true).outline).toMatchObject({ width: 3 });
    expect(valuePatch.outline(plainBox, false)).toEqual({ outline: undefined });
    const outlined = text({
      style: style({ outline: { width: 2, color: red }, shadow: { dx: 1, dy: 1, blur: 2, color: red } }),
    });
    expect(valuePatch.outline(outlined, false)).toEqual({ outline: null });
    expect(valuePatch.outline(outlined, true)).toEqual({ outline: undefined });
    expect(valuePatch.shadow(outlined, false)).toEqual({ shadow: null });
    expect(valuePatch.shadow(plainBox, true).shadow).toMatchObject({ blur: 12 });
    expect(valuePatch.lang(plainBox, 'he')).toEqual({ lang: 'he' });
    expect(valuePatch.lang(plainBox, '')).toEqual({ lang: undefined });
    expect(Object.keys(CLEAR_FORMATTING).length).toBeGreaterThan(10);
  });

  it('language tags as the schema bounds them', () => {
    for (const ok of ['he', 'ar', 'en-GB', 'zh-Hant-TW']) expect(validLang(ok)).toBe(true);
    for (const bad of ['', 'h', 'english language', '<b>', 'a'.repeat(36), 'en_GB'])
      expect(validLang(bad)).toBe(false);
  });

  it('Ctrl (or ⌘) + B, I, U in the text field', () => {
    const k = (
      key: string,
      m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
    ) => shortcutOf({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });
    expect(k('b', { ctrlKey: true })).toBe('bold');
    expect(k('I', { metaKey: true })).toBe('italic');
    expect(k('u', { ctrlKey: true })).toBe('underline');
    expect(k('b')).toBeUndefined();
    expect(k('b', { ctrlKey: true, shiftKey: true })).toBeUndefined();
    expect(k('b', { ctrlKey: true, altKey: true })).toBeUndefined();
    expect(k('s', { ctrlKey: true })).toBeUndefined();
  });

  it("swatches: the theme's colour, then the deck's most used, then the standard ones it does not use", () => {
    const deck = (objects: SlideObject[]): Presentation => ({
      id: 'p',
      rev: 1,
      title: 'Deck',
      kind: 'slides',
      meta: { tags: [] },
      sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 's', objects }] }],
      arrangements: [],
      archived: false,
    });
    const p = deck([
      text({ id: 'a', style: style({ color: navy }) }),
      text({
        id: 'b',
        style: style({ color: white }),
        runs: [
          { start: 0, end: 3, color: red },
          { start: 5, end: 7, color: red },
        ],
      }),
      text({ id: 'c', style: style({ color: white }) }),
      { id: 'sh', type: 'shape', box, shape: 'rect', opacity: 1, radius: 0, fill: navy },
      { id: 'sh2', type: 'shape', box, shape: 'rect', opacity: 1, radius: 0, fill: navy },
    ]);
    const sw = deckColors(p);
    expect(sw.slice(0, 3).map((s) => s.color)).toEqual([navy, white, red]);
    expect(sw[0]!.name).toBe('Deck colour #1f4e79');
    // White is the deck's already: the standard list does not repeat it.
    expect(sw.filter((s) => s.color.r === 255 && s.color.g === 255 && s.color.b === 255)).toHaveLength(1);
    expect(sw.length).toBe(3 + STANDARD_COLORS.length - 1);
    const theme: Theme = { ...DEFAULT_THEME, text: { ...DEFAULT_THEME.text, color: red } };
    const themed = deckColors(p, theme);
    expect(themed[0]).toEqual({ color: red, name: 'Theme colour #c82828' });
    expect(themed.slice(1, 3).map((s) => s.color)).toEqual([navy, white]);
    // At most DECK_SWATCHES of the deck's own.
    const many = deck(
      Array.from({ length: 20 }, (_, i) =>
        text({ id: `t${i}`, style: style({ color: { r: i, g: 0, b: 0, a: 1 } }) }),
      ),
    );
    const own = deckColors(many).filter((s) => s.name.startsWith('Deck colour'));
    expect(own).toHaveLength(DECK_SWATCHES);
    expect(deckColors(undefined)).toEqual([...STANDARD_COLORS]);
  });
});

describe('the format bar markup', () => {
  const o = text({ runs: [{ start: 11, end: 24, fontWeight: 700, color: red }] });
  const view = (range: { start: number; end: number }, s: SelectionStyle, more = false, readOnly = false) =>
    html(
      createElement(FormatBarView, {
        o,
        range,
        readOnly,
        sel: s,
        swatches: deckColors(undefined),
        onFormat: noop,
        onResize: noop,
        moreOpen: more,
      }),
    );

  it('a toolbar labelled Text format, its toggles pressed by the selection', () => {
    const h = view({ start: 11, end: 24 }, sel({ fontWeight: 700, color: red }));
    expect(h).toContain('role="toolbar"');
    expect(h).toContain('aria-label="Text format"');
    expect(tag(h, 'aria-label="Bold"')).toContain('aria-pressed="true"');
    expect(tag(h, 'aria-label="Bold"')).toContain('class="small on"');
    expect(tag(h, 'aria-label="Italic"')).toContain('aria-pressed="false"');
    for (const name of ['Underline', 'Strikethrough', 'Superscript', 'Subscript'])
      expect(tag(h, `aria-label="${name}"`)).toContain('aria-pressed="false"');
    expect(plain(h)).toContain('Clear formatting');
    expect(plain(h)).toContain('Size −');
    expect(plain(h)).toContain('40 px');
    expect(tag(h, 'aria-label="Size − (smaller text)"')).toContain('type="button"');
    expect(tag(h, 'aria-label="Size + (larger text)"')).toContain('type="button"');
    // Enabled for a selection; no note.
    expect(h).not.toMatch(/<fieldset disabled/);
    expect(plain(h)).not.toContain('Select text to format it.');
  });

  it('a mixed selection shows as mixed', () => {
    const h = view({ start: 0, end: 24 }, sel({}, ['fontWeight', 'color', 'sizeScale', 'caps']));
    expect(tag(h, 'aria-label="Bold"')).toContain('aria-pressed="mixed"');
    expect(plain(h)).toContain('Mixed');
    expect(h).toMatch(/<option value="mixed" disabled="" selected="">Mixed<\/option>/);
    // No colour swatch is pressed.
    expect(h.match(/aria-label="Deck colour[^"]*" aria-pressed="true"/g)).toBeNull();
  });

  it('colours: the automatic choice, the swatches by name, another colour; highlights with None', () => {
    const h = view({ start: 11, end: 24 }, sel({ color: red }));
    expect(h).toContain('aria-label="Text colour"');
    expect(tag(h, 'aria-label="Auto (the box colour)"')).toContain('aria-pressed="false"');
    expect(tag(h, 'aria-label="White"')).toContain('aria-pressed="false"');
    expect(tag(h, 'aria-label="Other text colour"')).toContain('type="button"');
    expect(h).toContain('aria-label="Highlight"');
    expect(tag(h, 'aria-label="None (no highlight)"')).toContain('aria-pressed="true"');
    for (const s of HIGHLIGHTS) expect(h).toContain(`aria-label="${s.name}"`);
    const boxColour = view({ start: 0, end: 4 }, sel({ color: white }));
    expect(tag(boxColour, 'aria-label="Auto (the box colour)"')).toContain('aria-pressed="true"');
    expect(tag(boxColour, 'aria-label="White"')).toContain('aria-pressed="true"');
  });

  it('a caret disables the controls and says to select text; read-only disables them without the note', () => {
    const h = view({ start: 3, end: 3 }, sel());
    expect(h).toMatch(/<fieldset disabled=""/);
    expect(plain(h)).toContain('Select text to format it.');
    const ro = view({ start: 0, end: 4 }, sel(), false, true);
    expect(ro).toMatch(/<fieldset disabled=""/);
    expect(plain(ro)).not.toContain('Select text to format it.');
  });

  it("the advanced controls are behind 'More'", () => {
    const closed = view({ start: 0, end: 4 }, sel());
    expect(closed).toMatch(/aria-expanded="false"[^>]*>More<\/button>/);
    expect(plain(closed)).not.toContain('Letter spacing');
    const open = view({ start: 0, end: 4 }, sel(), true);
    expect(tag(open, 'aria-expanded="true"')).toBeTruthy();
    expect(open).toContain('aria-label="More text formatting"');
    for (const t of ['Letter spacing', 'Language (for example he, ar, en-GB)'])
      expect(plain(open)).toContain(t);
    expect(tag(open, 'aria-label="Outline"')).toContain('aria-pressed="false"');
    expect(tag(open, 'aria-label="Shadow"')).toContain('aria-pressed="false"');
  });

  it('Size ± steps come back to the box size', () => {
    expect(SIZE_STEP * (1 / SIZE_STEP)).toBeCloseTo(1, 12);
  });
});

// ---- the paragraph strip -------------------------------------------------------------------------------

describe('the paragraph strip: what each control applies', () => {
  const verses = text({
    text: '16 For God so loved the world\n17 For God did not send his Son',
    style: style({ fontSizePx: 88 }),
  });

  it('reads a bullet as its List choice', () => {
    expect(listChoice(undefined)).toBe('none');
    expect(listChoice(null)).toBe('none');
    expect(listChoice({ char: '■' })).toBe('char:■');
    expect(listChoice({})).toBe('char:•');
    expect(listChoice({ auto: 'arabicPeriod', startAt: 17 })).toBe('auto:arabicPeriod');
    expect(BULLET_CHARS).toEqual(['•', '●', '■', '▪', '➢', '✓']);
    expect(NUMBERINGS.map((n) => n.auto)).toEqual([
      'arabicPeriod',
      'arabicParenBoth',
      'arabicParenR',
      'alphaLcPeriod',
      'romanLcPeriod',
    ]);
  });

  it('a list started without an indent gets a hanging one wide enough for its labels', () => {
    const all = { start: 0, end: verses.text.length };
    const bullet = listPatch(verses, all, paras(), 'char:•');
    expect(bullet).toEqual({ bullet: { char: '•' }, indentPx: 66, firstLinePx: -66 });
    // Numbers from 17 for two paragraphs: '18.' is the longest label (3 characters and a space).
    const numbered = listPatch(
      verses,
      all,
      paras({ bullet: { auto: 'arabicPeriod', startAt: 17 } }),
      'auto:arabicParenBoth',
    );
    expect(numbered).toEqual({ bullet: { auto: 'arabicParenBoth', startAt: 17 } });
    const fresh = listPatch(verses, all, paras(), 'auto:arabicPeriod');
    // From 1 for two paragraphs: '2.' and a space, 0.6 em each.
    expect(fresh).toEqual({ bullet: { auto: 'arabicPeriod' }, indentPx: 158, firstLinePx: -158 });
    expect(hangFor(verses, { auto: 'arabicPeriod', startAt: 17 }, 2)).toBe(Math.round(88 * 0.6 * 4));
    expect(hangFor(text({ style: style({ fontSizePx: 40 }) }), { char: '•' }, 1)).toBe(54);
    // Indented paragraphs keep their indent; the bullet's colour and size stay when its kind changes.
    const indented = listPatch(
      verses,
      all,
      paras({ indentPx: 40, bullet: { char: '•', color: red, sizePct: 0.8, fontFamily: 'Symbol' } }),
      'char:✓',
    );
    expect(indented).toEqual({ bullet: { char: '✓', color: red, sizePct: 0.8 } });
    expect(listPatch(verses, all, paras({ bullet: { char: '•' } }), 'none')).toEqual({ bullet: undefined });
  });

  it("'Start at' is kept on the bullet, 1 not stored", () => {
    const s = paras({ bullet: { auto: 'arabicPeriod', color: red } });
    expect(startAtPatch(s, 17)).toEqual({ bullet: { auto: 'arabicPeriod', color: red, startAt: 17 } });
    expect(startAtPatch(paras({ bullet: { auto: 'arabicPeriod', startAt: 17 } }), 1)).toEqual({
      bullet: { auto: 'arabicPeriod' },
    });
    expect(startAtPatch(s, 99_999).bullet).toMatchObject({ startAt: 32_767 });
  });

  it('the paragraphs a selection touches: whole PowerPoint paragraphs, soft lines with theirs', () => {
    const o = text({ text: 'one\ntwo\nthree\nfour', paras: [null, null, { soft: true }] });
    expect(touchedHeads(o, { start: 0, end: 0 })).toEqual([0]);
    expect(touchedHeads(o, { start: 5, end: 5 })).toEqual([1]);
    expect(touchedHeads(o, { start: 9, end: 9 })).toEqual([1]);
    expect(touchedHeads(o, { start: 0, end: o.text.length })).toEqual([0, 1, 3]);
    expect([0, 1, 2, 3, 9].map((i) => lineStart(o.text, i))).toEqual([0, 4, 8, 14, o.text.length]);
  });

  it('level and indent move each paragraph from its own value, within bounds', () => {
    const o = text({ text: 'a\nb\nc', paras: [null, { level: 2, indentPx: 144 }, { level: MAX_LEVEL }] });
    const all = { start: 0, end: o.text.length };
    expect(paraSteps(o, all, 'level', 1)).toEqual([
      { at: 0, patch: { level: 1 } },
      { at: 2, patch: { level: 3 } },
    ]);
    expect(paraSteps(o, all, 'level', -1)).toEqual([
      { at: 2, patch: { level: 1 } },
      { at: 4, patch: { level: 7 } },
    ]);
    expect(paraSteps(o, { start: 2, end: 2 }, 'indentPx', -INDENT_STEP)).toEqual([
      { at: 2, patch: { indentPx: 72 } },
    ]);
    expect(paraSteps(o, { start: 2, end: 2 }, 'indentPx', -2 * INDENT_STEP)).toEqual([
      { at: 2, patch: { indentPx: undefined } },
    ]);
    expect(paraSteps(o, { start: 0, end: 0 }, 'indentPx', -INDENT_STEP)).toEqual([]);
  });

  it('line spacing: as the box, a multiple of single, or exactly', () => {
    expect(lineMode(paras())).toBe('box');
    expect(lineMode(paras({ lineSpacing: 1.5 }))).toBe('multiple');
    expect(lineMode(paras({ lineSpacingPx: 90 }))).toBe('exact');
    expect(lineMode(paras({}, ['lineSpacing']))).toBe('mixed');
    expect(lineModePatch(verses, 'box')).toEqual({ lineSpacing: undefined, lineSpacingPx: undefined });
    expect(lineModePatch(verses, 'multiple')).toEqual({ lineSpacing: 1, lineSpacingPx: undefined });
    expect(lineModePatch(verses, 'exact')).toEqual({ lineSpacing: undefined, lineSpacingPx: 106 });
  });

  it('align and direction: the box default stores nothing', () => {
    const o = text({ style: style({ align: 'center' }) });
    expect(alignOf(o, paras())).toBe('center');
    expect(alignOf(o, paras({ align: 'right' }))).toBe('right');
    expect(alignOf(o, paras({}, ['align']))).toBeUndefined();
    expect(alignOf(text({ style: style({ justify: true }) }), paras())).toBe('justify');
    expect(alignPatch(o, 'center')).toEqual({ align: undefined });
    expect(alignPatch(o, 'right')).toEqual({ align: 'right' });
    expect(dirOf(paras())).toBe('auto');
    expect(dirOf(paras({ rtl: true }))).toBe('rtl');
    expect(dirOf(paras({ rtl: false }))).toBe('ltr');
    expect(dirOf(paras({}, ['rtl']))).toBeUndefined();
    expect(dirPatch('auto')).toEqual({ rtl: undefined });
    expect(dirPatch('rtl')).toEqual({ rtl: true });
    expect(dirPatch('ltr')).toEqual({ rtl: false });
  });
});

describe('the paragraph strip markup', () => {
  const o = text({ text: 'one\ntwo' });
  const view = (s: SelectionParas, readOnly = false) =>
    html(
      createElement(ParagraphStripView, {
        o,
        range: { start: 0, end: 0 },
        readOnly,
        sel: s,
        onParas: noop,
        onStep: noop,
      }),
    );

  it('a group labelled Paragraph with radio groups for the alignment and the direction', () => {
    const h = view(paras({ align: 'right' }));
    expect(h).toContain('role="group" aria-label="Paragraph"');
    expect(h).toContain('role="radiogroup" aria-label="Align"');
    expect(h).toContain('role="radiogroup" aria-label="Direction"');
    const radios = h.match(/<button[^>]*role="radio"[^>]*>[^<]*/g)!;
    expect(radios.map((r) => r.replace(/.*>/, ''))).toEqual([
      'Left',
      'Centre',
      'Right',
      'Justify',
      'Auto',
      'Left to right',
      'Right to left',
    ]);
    const checked = radios.filter((r) => r.includes('aria-checked="true"')).map((r) => r.replace(/.*>/, ''));
    expect(checked).toEqual(['Right', 'Auto']);
    // One tab stop per group: the checked choice.
    expect(radios.filter((r) => r.includes('tabindex="0"')).map((r) => r.replace(/.*>/, ''))).toEqual([
      'Right',
      'Auto',
    ]);
    for (const t of [
      'List',
      'Level −',
      'Level 1',
      'Level +',
      'Indent −',
      'Indent 0 px',
      'Indent +',
      'Space before',
      'Space after',
      'Line spacing',
    ])
      expect(plain(h)).toContain(t);
    expect(plain(h)).not.toContain('Start at');
    expect(h).not.toMatch(/<fieldset disabled/);
  });

  it('mixed paragraphs check no radio and say Mixed; numbering shows Start at', () => {
    const h = view(
      paras({ bullet: { auto: 'arabicPeriod', startAt: 17 } }, ['align', 'rtl', 'spaceBeforePx', 'level']),
    );
    expect(h).not.toContain('aria-checked="true"');
    expect(h).toContain('placeholder="Mixed"');
    expect(plain(h)).toContain('Levels mixed');
    expect(plain(h)).toContain('Start at');
    expect(h).toMatch(/<option value="auto:arabicPeriod" selected="">Numbers 1\. 2\. 3\.<\/option>/);
    expect(h).toContain('value="17"');
  });

  it('a bullet from PowerPoint the list does not offer is shown as itself', () => {
    const h = view(paras({ bullet: { char: '❖' } }));
    expect(h).toMatch(/<option value="char:❖" selected="">Bullet ❖<\/option>/);
  });

  it('read-only disables every control', () => {
    expect(view(paras(), true)).toMatch(/<fieldset disabled=""/);
  });
});

// ---- the text box options of TextStyleEditor -----------------------------------------------------------

describe('TextStyleEditor: the text box options', () => {
  const base = style({ padding: 12 });

  it('style fields set, or removed for their default', () => {
    expect(withField(base, 'autofit', 'shrink').autofit).toBe('shrink');
    expect('autofit' in withField({ ...base, autofit: 'shrink' }, 'autofit', undefined)).toBe(false);
    expect(withField(base, 'autofit', undefined)).toBe(base);
  });

  it('insets replace the padding; the padding keeps the smallest (an older build draws inside the box)', () => {
    expect(insetsOf(base)).toEqual({ l: 12, t: 12, r: 12, b: 12 });
    const s = withInset(base, 'l', 30);
    expect(s.insets).toEqual({ l: 30, t: 12, r: 12, b: 12 });
    expect(s.padding).toBe(12);
    const t = withInset(s, 't', 4);
    expect(t.insets).toEqual({ l: 30, t: 4, r: 12, b: 12 });
    expect(t.padding).toBe(4);
    expect(withInset(base, 'r', -5).insets!.r).toBe(0);
  });

  it('the fallback font is the first of fallbackFonts', () => {
    const s = { ...base, fallbackFonts: ['Noto Sans Hebrew', 'Carlito'] };
    expect(withFallback(s, 'Noto Sans Arabic').fallbackFonts).toEqual(['Noto Sans Arabic', 'Carlito']);
    expect(withFallback(s, '').fallbackFonts).toEqual(['Carlito']);
    expect('fallbackFonts' in withFallback({ ...base, fallbackFonts: ['X'] }, '')).toBe(false);
    expect(withFallback(base, 'Noto Sans Hebrew').fallbackFonts).toEqual(['Noto Sans Hebrew']);
    expect(withFallback(s, 'Carlito').fallbackFonts).toEqual(['Carlito']);
  });

  it('only where they apply: themes and looks keep the editor as it was', () => {
    const h = html(createElement(TextStyleEditor, { value: base, onChange: noop }));
    expect(plain(h)).toContain('Padding');
    expect(plain(h)).not.toContain('Shrink text to fit');
    expect(plain(h)).not.toContain('Fallback font');
  });

  it('a slide text box: shrink, wrap, four insets, direction, line model, fallback font', () => {
    const h = html(createElement(TextStyleEditor, { value: base, onChange: noop, box: true }));
    expect(h).toContain('role="group" aria-label="Text box"');
    for (const t of [
      'Shrink text to fit',
      'Wrap lines',
      'Inset left',
      'Inset top',
      'Inset right',
      'Inset bottom',
      'Direction',
      'Line spacing model',
      'Fallback font',
    ])
      expect(plain(h)).toContain(t);
    expect(plain(h)).not.toContain('Padding');
    expect(plain(h)).not.toContain('Re-fit text');
    expect(h).toMatch(/<option value="" selected="">None<\/option>/);
  });

  it("'Re-fit text' for a shrink-to-fit box with a stored scale", () => {
    const fitted = { ...base, autofit: 'shrink' as const, fitScale: { font: 0.9, spacing: 1 } };
    const h = html(
      createElement(TextStyleEditor, { value: fitted, onChange: noop, box: true, onRefit: noop }),
    );
    const btn = /<button[^>]*>Re-fit text<\/button>/.exec(h)![0];
    expect(btn).not.toContain('disabled');
    expect(plain(h)).toContain('Shrunk to 90 %, kept while the text fits.');
    // Read-only (no onRefit) or no stored scale: disabled.
    const ro = html(createElement(TextStyleEditor, { value: fitted, onChange: noop, box: true }));
    expect(/<button[^>]*>Re-fit text<\/button>/.exec(ro)![0]).toContain('disabled');
    const free = html(
      createElement(TextStyleEditor, {
        value: { ...base, autofit: 'shrink' },
        onChange: noop,
        box: true,
        onRefit: noop,
      }),
    );
    expect(/<button[^>]*>Re-fit text<\/button>/.exec(free)![0]).toContain('disabled');
  });
});

// ---- the Object panel with the stores ------------------------------------------------------------------

describe('the Object panel of a text box', () => {
  const o = text({
    runs: [{ start: 11, end: 24, fontWeight: 700, color: red }],
    paras: [{ align: 'center' }],
  });
  const p: Presentation = {
    id: 'p1',
    rev: 3,
    title: 'Announcements',
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 's1', objects: [o] }] }],
    arrangements: [{ id: 'a', name: 'Default', sectionIds: ['sec'] }],
    archived: false,
  };
  beforeEach(() => {
    useLibrary.setState({ data: { ...useLibrary.getState().data } });
    openPresentation(p);
    selectSlide('s1');
    selectObject('t1');
  });

  it('has the unified scope-aware typography bar over the text field, the paragraph strip under it and the box options', async () => {
    const { ObjectPanel } = await import('../src/views/editor/ObjectPanel.tsx');
    const { FloatingContextBar } = await import('../src/views/editor/FloatingContextBar.tsx');
    const { setTextRange } = await import('../src/views/editor/editorStore.ts');
    const ed = useEditor.getState();
    expect(ed.objectId).toBe('t1');
    const h = html(createElement(ObjectPanel, { o, readOnly: false }));
    const bar = h.indexOf('aria-label="Typography"');
    const field = h.indexOf('id="ordo-text-editor"');
    const strip = h.indexOf('aria-label="Paragraph"');
    const boxOpts = h.indexOf('aria-label="Text box"');
    expect(bar).toBeGreaterThan(0);
    expect(field).toBeGreaterThan(bar);
    expect(strip).toBeGreaterThan(field);
    expect(boxOpts).toBeGreaterThan(strip);
    // With a collapsed caret, UnifiedTypography edits Whole Box without duplicating Font/Size/Align below.
    expect(plain(h)).toContain('Whole Box');
    expect(h).toContain('<div role="status"></div>');

    // Selecting characters automatically switches UnifiedTypography and FloatingContextBar to Selection scope.
    setTextRange(0, 5);
    Object.assign(useEditor.getInitialState(), {
      draft: p,
      slideId: 's1',
      objectId: 't1',
      objectIds: ['t1'],
      textRange: { start: 0, end: 5 },
    });
    const selMarkup = html(createElement(ObjectPanel, { o, readOnly: false }));
    expect(plain(selMarkup)).toContain('Selection');
    expect(selMarkup).toContain('Clear formatting');
    expect(selMarkup).toContain('aria-label="Add highlight"');

    const floating = html(
      createElement(FloatingContextBar, {
        readOnly: false,
        drawerOpen: false,
        onToggleDrawer: () => undefined,
      }),
    );
    expect(plain(floating)).toContain('Selection');
    expect(floating).toContain('aria-label="Bold"');
    expect(floating).toContain('More…');
    setTextRange(0, 0);
    Object.assign(useEditor.getInitialState(), {
      draft: undefined,
      slideId: undefined,
      objectId: undefined,
      objectIds: [],
      textRange: { start: 0, end: 0 },
    });
  });
});
