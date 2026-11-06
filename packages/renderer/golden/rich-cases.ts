import {
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  type Look,
  type Rgba,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextPara,
  type TextRun,
  type TextStyle,
} from '@ordo/domain';
import { rasterSlide } from '../src/raster.ts';
import { isRichText } from '../src/text/rich.ts';
import { fillColor } from '../src/text2d.ts';

/**
 * Rich text cases of the golden-image test (design/27 §14 item 4): every one goes through the rich text
 * engine (`drawObject` → `drawRichText`: itemize, UAX#9 and UAX#14, segments, lines, the line models,
 * autofit, bullets and the paint passes) with the drawers' font resolver installed, as the asset worker,
 * the thumbnail worker and the editor draw. Faces (golden/run.ts): 'Golden' is DejaVu Sans (Latin, Hebrew,
 * Arabic), 'Golden Serif' FreeSerif (Tamil), 'Golden CJK' IPAGothic (kanji and kana).
 *
 * Each text box has a thin grey frame (a shape object) so alignment, insets and overflow show.
 */

export const W = 960;
export const H = 540;
export const SCALE = W / 1920;

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const GOLD: Rgba = { r: 255, g: 200, b: 60, a: 1 };
const SKY: Rgba = { r: 120, g: 200, b: 255, a: 1 };
const BG: Rgba = { r: 18, g: 24, b: 38, a: 1 };

/** A rich style: 'Golden' at 48 px, top left, no padding, the office line model unless overridden. */
export function style(over: Partial<TextStyle> = {}): TextStyle {
  return {
    fontFamily: 'Golden',
    fontWeight: 400,
    fontStyle: 'normal',
    fontSizePx: 48,
    color: WHITE,
    align: 'left',
    valign: 'top',
    lineHeight: 1.2,
    letterSpacing: 0,
    transform: 'none',
    padding: 0,
    lineModel: 'office',
    ...over,
  };
}

type Box = { x: number; y: number; w: number; h: number };

export function text(
  id: string,
  box: Box,
  body: string,
  st: TextStyle,
  rich: { runs?: TextRun[]; paras?: (TextPara | null)[] } = {},
): TextObject {
  const o: TextObject = { id, type: 'text', box: { ...box, rotation: 0 }, text: body, style: st, opacity: 1 };
  if (rich.runs) o.runs = rich.runs;
  if (rich.paras) o.paras = rich.paras;
  return o;
}

function frame(id: string, b: Box): SlideObject {
  return {
    id: `${id}-frame`,
    type: 'shape',
    box: { ...b, rotation: 0 },
    shape: 'rect',
    stroke: { width: 2, color: { r: 110, g: 110, b: 130, a: 1 } },
    opacity: 1,
    radius: 0,
  };
}

/** A slide of text objects, each over its frame. */
function slide(id: string, objects: TextObject[]): Slide {
  return { id, objects: objects.flatMap((o) => [frame(o.id, o.box), o]) };
}

/** `[start, end)` of the `n`th occurrence of `part` in `s` (n from 0), with the run's other fields. */
function at(s: string, part: string, run: Omit<TextRun, 'start' | 'end'>, n = 0): TextRun {
  let i = -1;
  for (let k = 0; k <= n; k++) {
    i = s.indexOf(part, i + 1);
    if (i < 0) throw new Error(`'${part}' not in '${s}'`);
  }
  return { start: i, end: i + part.length, ...run };
}

function draw(ctx: OffscreenCanvasRenderingContext2D, s: Slide, look: Look = LOOK_MAIN): void {
  fillColor(ctx, BG, W, H);
  rasterSlide(ctx, s, look, SCALE, () => undefined, { isSong: true });
}

// ---- Runs: weight, slant, colour, size, underline, strike, highlight, spacing, shadow, outline, glow ----

const RUNS_A = 'Welcome to Grace Church\nSunday worship at 10:30, all are welcome. Bring a friend!';
const RUNS_B = 'Shadow, outline and glow\nper run: this word has none';

const runs = slide('runs', [
  text('a', { x: 80, y: 60, w: 1760, h: 420 }, RUNS_A, style({ fontSizePx: 64 }), {
    runs: [
      at(RUNS_A, 'Welcome', { fontWeight: 700, color: GOLD }),
      at(RUNS_A, 'Grace', { sizeScale: 1.4, fontStyle: 'italic', underline: true }),
      at(RUNS_A, 'Church', { fontStyle: 'italic', underline: true }),
      at(RUNS_A, 'Sunday', { letterSpacing: 8, color: SKY }),
      at(RUNS_A, '10:30', { highlight: GOLD, color: { r: 0, g: 0, b: 0, a: 1 }, fontWeight: 700 }),
      at(RUNS_A, 'all are welcome', { strike: true }),
      at(RUNS_A, 'Bring a friend!', { underline: true, color: { r: 140, g: 255, b: 160, a: 1 } }),
    ],
    paras: [{ spaceAfterPx: 24 }],
  }),
  text(
    'b',
    { x: 80, y: 540, w: 1760, h: 460 },
    RUNS_B,
    style({
      fontSizePx: 88,
      fontWeight: 700,
      align: 'center',
      valign: 'middle',
      lineModel: 'ordo',
      outline: { width: 4, color: { r: 20, g: 40, b: 120, a: 1 } },
      shadow: { dx: 6, dy: 6, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.8 } },
      glow: { radius: 18, color: { r: 255, g: 120, b: 0, a: 0.7 } },
      fill: { color: { r: 60, g: 20, b: 80, a: 0.6 }, radius: 24 },
      padding: 20,
    }),
    { runs: [at(RUNS_B, 'this word', { shadow: null, outline: null, color: GOLD })] },
  ),
]);

// ---- Verse superscripts (and a subscript) ----

const VERSES =
  '16 For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life. 17 For God sent not his Son into the world to condemn the world; but that the world through him might be saved.\nWater is H2O; the 3rd day.';

const verses = slide('verses', [
  text('v', { x: 100, y: 80, w: 1720, h: 920 }, VERSES, style({ fontSizePx: 60 }), {
    runs: [
      at(VERSES, '16', { baseline: 0.3, fontWeight: 700, color: GOLD }),
      at(VERSES, '17', { baseline: 0.3, fontWeight: 700, color: GOLD }),
      at(VERSES, '2', { baseline: -0.25 }),
      at(VERSES, 'rd', { baseline: 0.3 }),
    ],
    paras: [{ lineSpacing: 1.1, spaceAfterPx: 30 }],
  }),
]);

// ---- Justify and distribute ----

const BEATITUDES =
  'Blessed are the poor in spirit: for theirs is the kingdom of heaven. Blessed are they that mourn: for they shall be comforted. Blessed are the meek.';
const HEB_JUSTIFY = 'אַשְׁרֵי הָאִישׁ אֲשֶׁר לֹא הָלַךְ בַּעֲצַת רְשָׁעִים וּבְדֶרֶךְ חַטָּאִים לֹא עָמָד וּבְמוֹשַׁב לֵצִים לֹא יָשָׁב.';

const justify = slide('justify', [
  text('j', { x: 60, y: 60, w: 880, h: 600 }, BEATITUDES, style({ fontSizePx: 52, justify: true })),
  text('d', { x: 980, y: 60, w: 880, h: 600 }, BEATITUDES, style({ fontSizePx: 52 }), {
    paras: [{ align: 'distribute' }],
  }),
  text('h', { x: 60, y: 700, w: 1800, h: 320 }, HEB_JUSTIFY, style({ fontSizePx: 56, justify: true })),
]);

// ---- Bullets and numbering ----

const BULLETS = [
  'Announcements',
  'Prayer meeting on Wednesday',
  'Youth group on Friday evening, with a longer line that wraps under its text',
  'Bring a friend',
  '',
  'Children upstairs',
].join('\n');
/** Wingdings 0xD8 as PowerPoint stores it (U+F0D8, private use): drawn as U+27A2. */
const WINGDINGS_ARROW = String.fromCharCode(0xf0d8);
const dot = { char: '\u25cf', color: GOLD, sizePct: 0.8 };
const NUMBERS = [
  'First reading',
  'Psalm',
  'Gospel',
  'Verse one',
  'Verse two',
  'Roman',
  'Roman',
  'Alpha',
  'Circled',
].join('\n');

const bullets = slide('bullets', [
  text('b', { x: 60, y: 60, w: 900, h: 960 }, BULLETS, style({ fontSizePx: 48 }), {
    runs: [at(BULLETS, 'Announcements', { fontWeight: 700, sizeScale: 1.2 })],
    paras: [
      { spaceAfterPx: 12 },
      { bullet: dot, indentPx: 60, firstLinePx: -50 },
      { bullet: dot, indentPx: 60, firstLinePx: -50 },
      { bullet: { char: '\u2013' }, level: 1, indentPx: 140, firstLinePx: -40 },
      { bullet: dot, indentPx: 60, firstLinePx: -50 },
      {
        bullet: { char: WINGDINGS_ARROW, fontFamily: 'Wingdings', color: SKY },
        indentPx: 60,
        firstLinePx: -50,
      },
    ],
  }),
  text('n', { x: 1000, y: 60, w: 860, h: 960 }, NUMBERS, style({ fontSizePx: 48 }), {
    paras: [
      { bullet: { auto: 'arabicPeriod' }, indentPx: 70, firstLinePx: -70 },
      { bullet: { auto: 'arabicPeriod' }, indentPx: 70, firstLinePx: -70 },
      { bullet: { auto: 'arabicPeriod' }, indentPx: 70, firstLinePx: -70 },
      { bullet: { auto: 'arabicParenBoth', startAt: 17, color: GOLD }, indentPx: 120, firstLinePx: -120 },
      { bullet: { auto: 'arabicParenBoth', startAt: 17, color: GOLD }, indentPx: 120, firstLinePx: -120 },
      { bullet: { auto: 'romanUcPeriod', startAt: 3 }, indentPx: 100, firstLinePx: -100 },
      { bullet: { auto: 'romanUcPeriod', startAt: 3 }, indentPx: 100, firstLinePx: -100 },
      { bullet: { auto: 'alphaLcParenR' }, indentPx: 100, firstLinePx: -100 },
      { bullet: { auto: 'circleNumDbPlain', startAt: 9 }, indentPx: 100, firstLinePx: -100 },
    ],
  }),
]);

// ---- Autofit: LibreOffice's search, a stored fitScale that still fits, the 'ordo' model ----

const LONG =
  'Come, thou fount of every blessing, tune my heart to sing thy grace; streams of mercy, never ceasing, call for songs of loudest praise. Here I raise my Ebenezer; hither by thy help I come.';

const autofit = slide('autofit', [
  text('s', { x: 60, y: 60, w: 880, h: 440 }, LONG, style({ fontSizePx: 72, autofit: 'shrink' })),
  text(
    'f',
    { x: 980, y: 60, w: 880, h: 440 },
    LONG,
    style({ fontSizePx: 72, autofit: 'shrink', fitScale: { font: 0.55, spacing: 0.9 } }),
  ),
  text(
    'o',
    { x: 60, y: 560, w: 880, h: 440 },
    LONG,
    style({ fontSizePx: 72, autofit: 'shrink', lineModel: 'ordo', align: 'center', valign: 'middle' }),
  ),
  text('n', { x: 980, y: 560, w: 880, h: 440 }, LONG, style({ fontSizePx: 72, autofit: 'none' })),
]);

// ---- Hebrew and Arabic (and the legacy direction rule) ----

const GEN_HE = 'בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ׃ (בראשית א, 1)';
const GEN_AR = 'في البدء خلق الله السماوات والأرض. (تكوين ١:١)';
const LEGACY_HE = 'שלום עולם!\nברוכים הבאים.';

const rtl = slide('rtl', [
  text('he', { x: 60, y: 60, w: 1800, h: 260 }, GEN_HE, style({ fontSizePx: 64, align: 'right' })),
  text('ar', { x: 60, y: 360, w: 1100, h: 400 }, GEN_AR, style({ fontSizePx: 64, align: 'right' }), {
    runs: [at(GEN_AR, 'الله', { color: GOLD, fontWeight: 700 })],
  }),
  {
    // A legacy object (no rich field): drawText sets the paragraph's direction from its first strong
    // character, so the punctuation sits at the left end.
    id: 'legacy',
    type: 'text',
    box: { x: 1200, y: 360, w: 660, h: 400, rotation: 0 },
    text: LEGACY_HE,
    style: { ...style({ fontSizePx: 64, align: 'right' }), lineModel: undefined },
    opacity: 1,
  },
  text('ar2', { x: 60, y: 800, w: 1800, h: 220 }, 'سلام لكم!', style({ fontSizePx: 80, align: 'left' })),
]);

// ---- Mixed bidi ----

const MIX_LTR = 'The word שָׁלוֹם (shalom) means peace, said 3 times.';
const MIX_RTL = 'השיר “Amazing Grace” נכתב בשנת 1772, עמוד 42.';
const MIX_AR = 'ترنيمة Amazing Grace رقم 42 (الصفحة 7).';

const bidi = slide('bidi', [
  text('l', { x: 60, y: 60, w: 1800, h: 280 }, MIX_LTR, style({ fontSizePx: 60 })),
  text('r', { x: 60, y: 380, w: 1800, h: 280 }, MIX_RTL, style({ fontSizePx: 60, align: 'right' }), {
    runs: [at(MIX_RTL, 'Amazing Grace', { fontStyle: 'italic', color: SKY })],
  }),
  text('a', { x: 60, y: 700, w: 1800, h: 300 }, MIX_AR, style({ fontSizePx: 60, align: 'right' }), {
    paras: [{ rtl: true }],
  }),
]);

// ---- The Arabic joining split: a style cut inside a word keeps the medial and final forms ----

const ZWJ_WORDS = 'محبة السلام';

const zwj = slide('zwj', [
  text('plain', { x: 60, y: 60, w: 1800, h: 300 }, ZWJ_WORDS, style({ fontSizePx: 150, align: 'center' })),
  text('split', { x: 60, y: 380, w: 1800, h: 300 }, ZWJ_WORDS, style({ fontSizePx: 150, align: 'center' }), {
    runs: [at(ZWJ_WORDS, 'مح', { color: GOLD }), at(ZWJ_WORDS, 'سل', { color: SKY, fontWeight: 700 })],
  }),
  text('caps', { x: 60, y: 720, w: 1800, h: 300 }, 'لا إله', style({ fontSizePx: 150, align: 'center' }), {
    runs: [{ start: 1, end: 2, color: GOLD }],
  }),
]);

// ---- Tamil: emergency breaks between clusters, never inside 'க்ஷி' ----

const TAMIL_LONG = 'க்ஷிக்ஷிக்ஷிக்ஷிக்ஷிக்ஷிக்ஷிக்ஷிக்ஷிக்ஷிக்ஷிக்ஷி';
const TAMIL_PSALM = 'கர்த்தர் என் மேய்ப்பராயிருக்கிறார்; நான் தாழ்ச்சியடையேன்.';

const tamil = slide('tamil', [
  text(
    'long',
    { x: 60, y: 60, w: 520, h: 940 },
    TAMIL_LONG,
    style({ fontSizePx: 72, fallbackFonts: ['Golden Serif'] }),
  ),
  text(
    'psalm',
    { x: 640, y: 60, w: 1220, h: 600 },
    TAMIL_PSALM,
    style({ fontSizePx: 64, fallbackFonts: ['Golden Serif'] }),
    { runs: [at(TAMIL_PSALM, 'கர்த்தர்', { color: GOLD })] },
  ),
]);

// ---- CJK: breaks between ideographs; '。' and '、' never start a line ----

const CJK =
  '主は私の羊飼い。私は、乏しいことがありません。主は私を緑の牧場に伏させ、いこいの水のほとりに伴われます。';

const cjk = slide('cjk', [
  text(
    'ja',
    { x: 60, y: 60, w: 1000, h: 940 },
    CJK,
    style({ fontSizePx: 64, fallbackFonts: ['Golden CJK'] }),
  ),
  text(
    'mix',
    { x: 1120, y: 60, w: 740, h: 940 },
    `Psalm 23: ${CJK.slice(0, 22)}`,
    style({ fontSizePx: 64, fallbackFonts: ['Golden CJK'] }),
    { runs: [{ start: 0, end: 9, color: GOLD }] },
  ),
]);

// ---- 'Dieu !': no line breaks on either side of a no-break space ----

/** U+00A0 and U+202F, written out: they look like spaces. */
const NBSP = String.fromCharCode(0xa0);
const NNBSP = String.fromCharCode(0x202f);
const DIEU = `Gloire à Dieu${NBSP}! Alléluia${NBSP}!`;

const nbsp = slide('nbsp', [
  // 'Gloire à Dieu' fits in 548 px at 80 px, 'Gloire à Dieu !' does not: 'Dieu !' moves down whole.
  text('n1', { x: 60, y: 60, w: 548, h: 300 }, DIEU, style({ fontSizePx: 80 })),
  {
    // The same text in a legacy object: drawText splits words at every white space, U+00A0 included.
    id: 'legacy',
    type: 'text',
    box: { x: 700, y: 60, w: 548, h: 300, rotation: 0 },
    text: DIEU,
    style: { ...style({ fontSizePx: 80 }), lineModel: undefined },
    opacity: 1,
  },
  // Everything up to the last '!' fits, the closing guillemet does not: 'Alléluia ! »' moves down whole.
  text('n2', { x: 60, y: 420, w: 1060, h: 300 }, `«${NBSP}${DIEU}${NBSP}»`, style({ fontSizePx: 80 })),
  // U+202F between a number and its unit.
  text(
    'n3',
    { x: 1300, y: 420, w: 380, h: 600 },
    `Prix${NBSP}: 10${NNBSP}€ ; ${DIEU}`,
    style({ fontSizePx: 80 }),
  ),
]);

// ---- A Hebrew lyric-only band: punctuation at the left end ----

const HEB_SONG = 'הַלְלוּיָהּ, שִׁירוּ לַה׳ שִׁיר חָדָשׁ!\nתְּהִלָּתוֹ בִּקְהַל חֲסִידִים.';

const hebrewSong: Slide = {
  id: 'he-song',
  objects: [
    {
      id: 'he-lyric',
      type: 'text',
      box: { x: 160, y: 160, w: 1600, h: 760, rotation: 0 },
      text: HEB_SONG,
      // A song imported without any rich field: the band finds the right-to-left text itself.
      style: { ...style({ fontSizePx: 84, align: 'center', valign: 'middle' }), lineModel: undefined },
      opacity: 1,
    },
  ],
  lyricObjectId: 'he-lyric',
};

function lowerThird(): Look {
  const l: Look = JSON.parse(JSON.stringify(LOOK_LOWER_THIRD));
  if (l.layers.slide.mode === 'lyricOnly')
    l.layers.slide.style = { ...l.layers.slide.style, fontFamily: 'Golden' };
  return l;
}

export const RICH_CASES: Record<string, (ctx: OffscreenCanvasRenderingContext2D) => void> = {
  'rich-runs': (ctx) => draw(ctx, runs),
  'rich-verses': (ctx) => draw(ctx, verses),
  'rich-justify': (ctx) => draw(ctx, justify),
  'rich-bullets': (ctx) => draw(ctx, bullets),
  'rich-autofit': (ctx) => draw(ctx, autofit),
  'rich-hebrew-arabic': (ctx) => draw(ctx, rtl),
  'rich-mixed-bidi': (ctx) => draw(ctx, bidi),
  'rich-arabic-zwj': (ctx) => draw(ctx, zwj),
  'rich-tamil': (ctx) => draw(ctx, tamil),
  'rich-cjk': (ctx) => draw(ctx, cjk),
  'rich-nbsp': (ctx) => draw(ctx, nbsp),
  'band-hebrew': (ctx) => {
    const look = lowerThird();
    fillColor(ctx, look.clearColor, W, H);
    rasterSlide(ctx, hebrewSong, look, SCALE, () => undefined, { isSong: true });
  },
};

/** Text objects for the line-break invariance check (golden/page.ts): every script and feature above. */
export function invarianceObjects(): TextObject[] {
  const out: TextObject[] = [];
  for (const s of [runs, verses, justify, bullets, autofit, rtl, bidi, zwj, tamil, cjk, nbsp])
    for (const o of s.objects) if (o.type === 'text' && isRichText(o)) out.push(o);
  return out;
}
