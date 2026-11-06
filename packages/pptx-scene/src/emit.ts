/**
 * IR → ordo objects (design/27 §1 `emit.ts`, §3.2 "The importer always writes the closest legacy values").
 *
 * It emits today's objects (`TextObject`, `ImageObject`, `ShapeObject`), plus `ImageObject.crop` (design/27
 * §3.1; on unless `EmitOptions.crop` is false) and, since M2, rich text: `TextObject.runs`, `paras` and the
 * office box fields (`richtext.ts`; `EmitOptions.richText: false` writes the M1 text described below).
 * Pictures carry placeholder media ids, `pptxmedia:<n>` by default (numbered in first-use order; the part
 * each stands for is listed in `EmitResult.media`), which the harness (and later the hub) maps to real media.
 *
 * - **Placement.** Every element's affine is mapped to the 1920x1080 logical canvas (`frame.ts`: contain-
 *   fit, 4:3 decks centred). Boxes keep their rotation; flips of symmetric shapes need nothing, a flipped
 *   picture is drawn unflipped (M3) and noted.
 * - **Rich text** (default): one `TextObject` per body, `richtext.ts`, its box the shape's text rectangle
 *   (the preset's, turned a quarter for vertical text); insets and margins are written, not folded.
 * - **Legacy text** (`richText: false`): one `TextObject` per body in its dominant run's style (most
 *   characters): size (times a stored `normAutofit` fontScale), colour, bold, italic, the Latin typeface
 *   (the East Asian or complex-script one when the text is mostly in those scripts), caps, letter spacing.
 *   `algn` → align (justify → left, distribute → center), anchor → valign, line spacing → lineHeight
 *   (single = 1.2 × the font size, the office line model; a `lnSpcReduction` is subtracted), text outline
 *   → `outline` with width w/2 (ordo strokes twice the width under the fill), hollow text → alpha 0 plus
 *   the outline, the run's outer shadow (or the shape's, when the shape itself draws nothing) → `shadow`.
 * - **Text rectangle.** The shape's box, narrowed to the preset's text rectangle for roundRect and ellipse.
 *   For legacy text `padding` is the smallest body inset and the difference to each other inset is folded
 *   into the box, so the text area is PowerPoint's exactly; `wrap="none"` widens the box on the side(s) the
 *   alignment grows into, so ordo never wraps it. `vert`/`vert270`/`eaVert` turn the box a quarter turn.
 * - **Shapes**: rect, roundRect (radius from its `adj`), ellipse; lines and connectors as one `line` object
 *   per straight segment at any angle. Other presets are drawn as the nearest of these (noted). Fills as
 *   their legacy colour: solid; a gradient's first stop; a pattern's blend. A picture fill is an image.
 * - **Paragraph margins** (legacy text) fold into the text box, as `padding` does: the box is narrowed on
 *   the paragraphs' start side by the margin all of their text keeps clear of (`marL`; for a paragraph
 *   without a bullet, the first line's `marL + indent` when that is less), since a legacy `TextObject` has
 *   one left edge.
 * - **Pictures** (`p:pic` and picture fills) are stretched images. `a:fillRect` folds into the box (clipped
 *   to the shape) and, with `crop`, into the crop together with `a:srcRect`. roundRect and ellipse clips
 *   become `radius` (an ellipse is exact for a circle); a picture outline is a stroke-only shape above it.
 *   An unrotated picture reaching past ±2× the canvas (the render clamp, design/27 §12) is cut there and
 *   the cut folded into the crop, so the clamp never squeezes it.
 * - **Backgrounds**: a plain stretched picture known to be opaque whose aspect is known and matches a 16:9
 *   slide → `backgroundMediaId` (drawn cover-fit, on black); any other picture, one that may be transparent
 *   or of unknown size or alpha included (a spilled part without `ParseOptions.pictureSize`) → a bottom
 *   image stretched over the slide area, on white; solid,
 *   gradient and pattern → a bottom rect over the whole 1920x1080 frame (`extendBackgrounds`, default) or
 *   the slide area; none → white, as PowerPoint shows it.
 * - **Lyric box** (design/27 §4 "Church mappings"): the slide's own body placeholder with the most
 *   characters; else the largest other text by characters × area (not title, date, footer, slide number);
 *   the title only when it is the only text. On a bilingual slide (the two boxes with the most text in
 *   different languages, of comparable length) the first of them in reading order.
 *
 * Owned by work item C (inherit-emit).
 */
import type {
  ImageObject,
  Rgba as OrdoRgba,
  ShapeObject,
  Slide,
  SlideObject,
  TextObject,
} from '@ordo/domain';
import { apply, boxPx, decompose, lenPx, multiply, ptPx, slideRect } from './frame.ts';
import { artInfo } from './hybrid.ts';
import { isFooter, isTitle, masterClass } from './inherit.ts';
import type {
  Affine,
  ArtInfo,
  Classification,
  DeckScene,
  Element,
  Fill,
  Frame,
  Insets,
  Para,
  PictureElement,
  PictureFill,
  Rgba,
  RunStyle,
  ShapeElement,
  SlideScene,
  TextBody,
} from './ir.ts';
import { EMU_PER_PT } from './ir.ts';
import { noteList } from './log.ts';
import { scriptClasses } from './fontmap.ts';
import { richText } from './richtext.ts';

/** The prefix of placeholder media ids. */
export const MEDIA_PREFIX = 'pptxmedia:';
/** Longest text an ordo `TextObject` holds (`@ordo/domain` MAX.text). */
export const MAX_TEXT = 20_000;
/** Stored font sizes in logical px (design/27 §4 "Sizes"). */
export const MIN_FONT_PX = 4;
export const MAX_FONT_PX = 1_000;
/** Objects one ordo slide holds (`Slide.objects` in `@ordo/domain`). */
export const MAX_OBJECTS = 1_000;
/**
 * A slide's JSON budget (design/27 §3.4: hard 64 KB, else picture class). Rich text formatting (runs and
 * paragraph styles) is written while the slide's text objects stay within it; past it, the slide's further
 * text is written without its formatting and the slide is classed picture, so a deck whose layouts repeat
 * thousands of formatted runs on every slide never builds megabytes the hub would discard.
 */
export const MAX_SLIDE_BYTES = 64 * 1024;
/** The note a slide gets when it passes `MAX_SLIDE_BYTES` (an importer that logs the budget itself drops it). */
export const SLIDE_BUDGET_NOTE = `the slide has more than ${MAX_SLIDE_BYTES / 1024} KB of text formatting: its further text is written without it (picture class)`;
/** Single line spacing in the office line model: 1.2 × the font size (`pptx-render/src/page.ts`). */
export const SINGLE_LINE = 1.2;
/** Logical coordinates are bounded by the schema (`coord`). */
const MAX_COORD = 100_000;
/** The render clamp keeps box edges within ±2× the logical canvas (`@ordo/renderer` `CLAMP.boxFactor`). */
const CANVAS_W = 1_920;
const CANVAS_H = 1_080;
const BOX_FACTOR = 2;
/** How far a `wrap="none"` box grows on the side its alignment extends to, in logical px. */
const NO_WRAP_GROWTH = 1_920;
/**
 * Custom geometry is drawn as its legacy rect only when its paths fill at least this share of the box: a
 * rect over a thin silhouette or swoosh is further from it than nothing (M6 draws the paths).
 */
export const MIN_RECT_COVERAGE = 0.5;
/** A roundRect's default corner (`adj` 16,667 of the shorter side, /100,000). */
const ROUND_RECT_ADJ = 16_667;
/** The ellipse's text rectangle inset on each side, as a share of the box (POI: hc − wd2·cos 45°). */
const ELLIPSE_TEXT_INSET = 0.5 - 0.5 * Math.SQRT1_2;
/** The roundRect's text rectangle inset as a share of its corner radius (POI: 29,289/100,000). */
const ROUND_RECT_TEXT_INSET = 0.29289;

const WHITE: OrdoRgba = { r: 255, g: 255, b: 255, a: 1 };

export interface EmitOptions {
  /** A new id for each slide and object; default: deterministic `pptx-<n>`. */
  newId?: () => string;
  /**
   * The media id of a picture part; default `pptxmedia:<n>`, numbered from 1 in first-use order (part names
   * can be long; a slide's ids must stay within the schema's 200 characters).
   */
  mediaId?: (part: string) => string;
  /** Solid backgrounds cover the whole 1920x1080 frame instead of the slide area (default true). */
  extendBackgrounds?: boolean;
  /**
   * Write `ImageObject.crop` (design/27 §3.1: `a:srcRect` fractions, negative values pad with transparency)
   * and fold `a:fillRect` into it. Default true. With false, pictures are stretched and uncropped (the
   * legacy value an older build draws), and each cropped picture is noted.
   */
  crop?: boolean;
  /**
   * Write rich text (design/27 §3.1, M2; `richtext.ts`): runs, paragraph styles and the office box fields,
   * the box being the shape's text rectangle. Default true. With false, each body is written as M1 wrote
   * it, in today's fields only (the dominant run's style, insets and paragraph margins folded into the box,
   * a `wrap="none"` box widened): what the importer writes while the schema ships one release ahead of it
   * (§3.2).
   */
  richText?: boolean;
  /**
   * For the fidelity harness only (`--lo-compat`, design/27 §14.1): write text with LibreOffice 24.2's
   * policies where they differ from PowerPoint's (`RichOptions.lo` in `richtext.ts`), so the native column
   * compares like for like with LibreOffice's pictures. Never set by the hub.
   */
  loCompat?: boolean;
}

/** An image object with the crop of design/27 §3.1 (now `ImageObject.crop` in `@ordo/domain`). */
export type CroppedImage = ImageObject;

export interface EmittedSlide {
  index: number;
  shown?: number;
  hidden: boolean;
  /** An ordinary ordo slide: `Slide.parse` accepts it. */
  slide: Slide;
  classification: Classification;
  /** A digest of the objects written (the "unedited" test of design/27 §5). */
  digest: string;
  notes: string[];
  /** Time spent emitting this slide, in ms. */
  ms: number;
  /** Hybrid slides: what the art holds, for the LibreOffice follow-up (M3 item D). */
  art?: ArtInfo;
  /**
   * Metafile pictures, left out of `slide` until LibreOffice converts them (M3 item D): each as the image
   * object it becomes (`mediaId` `METAFILE_MEDIA`, replaced by the converted picture's) and the object it
   * goes just under (absent: on top). The shape of the hub's `PptxLoSlide.metafileObjects`.
   */
  metafiles?: { part: string; object: ImageObject; before?: string }[];
  /**
   * Classed picture by the slide budget alone (design/27 §3.4): its text formatting passed `MAX_SLIDE_BYTES`,
   * and it would be native or hybrid otherwise. The slide's JSON is then over 64 KB too (its objects hold
   * that text), so an importer counts and logs it exactly as its own slide budget would (the hub: a compact
   * picture slide, one warning), and drops `SLIDE_BUDGET_NOTE`.
   */
  overBudget?: true;
}

/** The placeholder media id of a metafile's object until it is converted (`EmittedSlide.metafiles`). */
export const METAFILE_MEDIA = 'pptxmedia:metafile';

export interface EmitResult {
  slides: EmittedSlide[];
  /** Every picture part the objects reference, with its media id, in first-use order. */
  media: { id: string; part: string }[];
  /** The deck's area in 1920x1080 logical px (`source.native.slideRect`). */
  slideRect: { x: number; y: number; w: number; h: number };
  notes: string[];
}

/** What one slide's emission needs. */
interface EmitCtx {
  frame: Frame;
  newId: () => string;
  mediaId: (part: string) => string;
  extend: boolean;
  crop: boolean;
  rich: boolean;
  lo: boolean;
  media: Map<string, string>;
  log: (msg: string) => void;
  /** Metafile pictures set aside, with the index in the slide's objects where each would go. */
  metafiles?: { part: string; object: ImageObject; at: number }[];
  /** UTF-8 bytes of the slide's rich text objects so far (`MAX_SLIDE_BYTES`). */
  textBytes: number;
}

export function emitDeck(scene: DeckScene, opts: EmitOptions = {}): EmitResult {
  let n = 0;
  const newId = opts.newId ?? (() => `pptx-${++n}`);
  const media = new Map<string, string>();
  const mediaId = opts.mediaId ?? (() => `${MEDIA_PREFIX}${media.size + 1}`);
  const slides = scene.slides.map((s) => {
    const t0 = performance.now();
    const { notes, log } = noteList();
    for (const note of s.notes) log(note);
    const ctx: EmitCtx = {
      frame: scene.frame,
      newId,
      mediaId,
      extend: opts.extendBackgrounds ?? true,
      crop: opts.crop ?? true,
      rich: opts.richText ?? true,
      lo: opts.loCompat === true,
      media,
      log,
      textBytes: 0,
    };
    const spans: [number, number][] = [];
    ctx.metafiles = [];
    const slide = emitSlide(ctx, s, spans);
    const over = ctx.textBytes > MAX_SLIDE_BYTES;
    const art = artInfo(s, scene.frame, spans, slide.objects);
    const metafiles = ctx.metafiles.map(({ part, object, at }) => {
      const before = slide.objects[at]?.id;
      return { part, object, ...(before !== undefined ? { before } : {}) };
    });
    return {
      index: s.index,
      ...(s.shown !== undefined ? { shown: s.shown } : {}),
      hidden: s.hidden,
      slide,
      classification: over ? overBudget(s.classification) : s.classification,
      digest: digestOf(slide.objects),
      notes,
      ms: performance.now() - t0,
      ...(art ? { art } : {}),
      ...(metafiles.length ? { metafiles } : {}),
      ...(over && s.classification.class !== 'picture' ? { overBudget: true as const } : {}),
    };
  });
  return {
    slides,
    media: [...media].map(([part, id]) => ({ id, part })),
    slideRect: slideRect(scene.frame),
    notes: [...scene.notes],
  };
}

/** A text object with the element it came from, for the lyric box. */
interface Emitted {
  o: TextObject;
  e: ShapeElement;
  area: number;
}

/** `spans` receives, per element, the range of `objects` it emitted (the art of a hybrid slide, `hybrid.ts`). */
function emitSlide(ctx: EmitCtx, s: SlideScene, spans: [number, number][] = []): Slide {
  const objects: SlideObject[] = [];
  const slide: Slide = { id: ctx.newId(), objects };
  if (s.error) return slide;
  emitBackground(ctx, s, slide);
  const texts: Emitted[] = [];
  for (const e of s.elements) {
    const at = objects.length;
    if (!e.hidden) emitElement(ctx, e, objects, texts);
    spans.push([at, objects.length]);
  }
  if (objects.length > MAX_OBJECTS) {
    ctx.log(`more than ${MAX_OBJECTS} objects: the top ones are not drawn`);
    objects.length = MAX_OBJECTS;
  }
  const lyric = lyricOf(texts.filter((t) => objects.includes(t.o)));
  if (lyric) slide.lyricObjectId = lyric.id;
  return slide;
}

// ── Lyric box ───────────────────────────────────────────────────────────────────────────────────────────

function visibleChars(s: string): number {
  let n = 0;
  for (const ch of s) if (ch.trim()) n++;
  return n;
}

/** A lyric box candidate with its visible characters counted once. */
interface Candidate {
  t: Emitted;
  chars: number;
}

function lyricOf(texts: Emitted[]): TextObject | undefined {
  const own: Candidate[] = [];
  for (const t of texts) {
    if (t.e.from !== 'slide') continue;
    const chars = visibleChars(t.o.text);
    if (chars > 0) own.push({ t, chars });
  }
  const best = (list: Candidate[], score: (c: Candidate) => number) => {
    let top: Candidate | undefined;
    let topScore = Number.NEGATIVE_INFINITY;
    for (const c of list) {
      const v = score(c);
      if (v > topScore) {
        top = c;
        topScore = v;
      }
    }
    return top?.t.o;
  };
  const chars = (c: Candidate) => c.chars;
  const body = own.filter((c) => c.t.e.ph && masterClass(c.t.e.ph.type) === 'body');
  if (body.length) return bilingual(body) ?? best(body, chars);
  const other = own.filter((c) => !isTitle(c.t.e.ph) && !isFooter(c.t.e.ph));
  if (other.length) return bilingual(other) ?? best(other, (c) => c.chars * Math.max(1, c.t.area));
  return best(
    own.filter((c) => isTitle(c.t.e.ph)),
    chars,
  );
}

/** Two candidate boxes count as one per language when the smaller holds at least this share of the text. */
const BILINGUAL_SHARE = 0.5;
/**
 * What a Han, Kana or Hangul character weighs against a Latin one when comparing lengths: the same line in
 * Korean, Chinese or Japanese takes a quarter to a half of the characters it takes in English.
 */
const WIDE_SCRIPT_WEIGHT = 2.5;
const WIDE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * A bilingual slide (design/27 §4 "Church mappings"): when the two candidates with the most text (Han, Kana
 * and Hangul weighed as `WIDE_SCRIPT_WEIGHT` Latin characters) are in different languages and of
 * comparable length, the lyric box is the first of them in reading order: the left one of two side by side,
 * else the upper one.
 */
function bilingual(list: Candidate[]): TextObject | undefined {
  if (list.length < 2) return undefined;
  const weighed = list.map((c) => ({ c, n: textWeight(c.t.o.text) })).sort((x, y) => y.n - x.n);
  const [a, b] = weighed;
  if (!a || !b || b.n < BILINGUAL_SHARE * a.n || sameLanguage(a.c.t.o, b.c.t.o)) return undefined;
  const A = a.c.t.o.box;
  const B = b.c.t.o.box;
  const overlap = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
  const sideBySide = overlap > 0.5 * Math.min(A.h, B.h);
  const aFirst = sideBySide ? A.x <= B.x : A.y <= B.y;
  return (aFirst ? a : b).c.t.o;
}

/** The length of a text for comparing two languages: visible characters, wide scripts weighed more. */
function textWeight(s: string): number {
  let n = 0;
  for (const ch of s) if (ch.trim()) n += WIDE_SCRIPT.test(ch) ? WIDE_SCRIPT_WEIGHT : 1;
  return n;
}

/**
 * Whether two text objects are in the same language, comparing like with like: they differ when most of
 * their text is in different script classes (Latin, East Asian, complex), or when both carry a language
 * and the primary subtags differ. A box without a language is taken to match one with it in its script.
 */
function sameLanguage(a: TextObject, b: TextObject): boolean {
  if (scriptClassOf(a.text) !== scriptClassOf(b.text)) return false;
  const la = primaryLang(a);
  const lb = primaryLang(b);
  return !la || !lb || la === lb;
}

function primaryLang(o: TextObject): string {
  return o.style.lang?.split('-')[0]?.toLowerCase() ?? '';
}

/** The script class most of a text's visible characters are in (fontmap.ts `scriptClasses`). */
function scriptClassOf(text: string): 'latin' | 'ea' | 'cs' {
  const n = { latin: 0, ea: 0, cs: 0 };
  const classes = scriptClasses(text);
  for (let i = 0; i < classes.length; i++) if (text.charCodeAt(i) > 0x20) n[classes[i]!]++;
  return n.ea > n.latin && n.ea >= n.cs ? 'ea' : n.cs > n.latin ? 'cs' : 'latin';
}

/** A slide over `MAX_SLIDE_BYTES`: picture class (design/27 §3.4), with why. */
function overBudget(c: Classification): Classification {
  const reason = `more than ${MAX_SLIDE_BYTES / 1024} KB of text formatting`;
  return { ...c, class: 'picture', reasons: [...c.reasons.filter((r) => r !== reason), reason] };
}

/** UTF-8 length of `s`. */
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 2 : 3; // a pair counts 2 + 2
  }
  return n;
}

// ── Backgrounds ─────────────────────────────────────────────────────────────────────────────────────────

function emitBackground(ctx: EmitCtx, s: SlideScene, slide: Slide): void {
  const fill = s.background.fill;
  const rect = { ...slideRect(ctx.frame), rotation: 0 };
  const area = ctx.extend ? { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 } : rect;
  if (fill.kind === 'picture') {
    const p = fill.picture;
    const slideAspect = ctx.frame.cx / ctx.frame.cy;
    const sixteenNine = Math.abs(slideAspect - 16 / 9) < (16 / 9) * 0.01;
    // An unknown size is not taken for the slide's aspect: cover-fitting a 4:3 photo would cut it.
    const sameAspect = p.px !== undefined && Math.abs(p.px.w / p.px.h - slideAspect) <= slideAspect * 0.01;
    const plain = !p.crop && !p.fillRect && !p.tile && p.alpha === undefined && !p.effects?.length;
    // The slide background is drawn on black: a picture that may be transparent stays on white.
    if (sixteenNine && sameAspect && plain && p.px?.alpha === false) {
      slide.backgroundMediaId = mediaOf(ctx, p.part);
      return;
    }
    if (p.tile) ctx.log('a tiled background is drawn stretched (M3 pre-tiles it)');
    if (p.effects?.length) ctx.log('a recoloured background picture is drawn without its recolouring');
    // PowerPoint and LibreOffice lay the background on white: a translucent picture, its transparent pixels
    // and the parts of the slide it leaves uncovered show white, not the frame's black.
    slide.objects.push(shape(ctx, rect, 'rect', WHITE));
    const unit: Affine = [ctx.frame.cx, 0, 0, ctx.frame.cy, 0, 0];
    const img = pictureObject(ctx, unit, p.tile ? { ...p, crop: undefined, fillRect: undefined } : p);
    if (img) slide.objects.push(img);
    return;
  }
  if (fill.kind === 'gradient') ctx.log('a gradient background is drawn as its first colour (M6)');
  if (fill.kind === 'pattern') ctx.log('a pattern background is drawn as its blended colour (M6)');
  const color = legacyColor(fill);
  slide.objects.push(shape(ctx, area, 'rect', color ? overWhite(color) : WHITE));
}

/** A colour laid on white, as a slide background is: opaque. */
export function overWhite(c: OrdoRgba): OrdoRgba {
  const a = bound(c.a, 0, 1);
  const mix = (v: number) => Math.round(v * a + 255 * (1 - a));
  return { r: mix(c.r), g: mix(c.g), b: mix(c.b), a: 1 };
}

// ── Elements ────────────────────────────────────────────────────────────────────────────────────────────

function emitElement(ctx: EmitCtx, e: Element, out: SlideObject[], texts: Emitted[]): void {
  if (e.kind === 'residual') {
    if (e.picture) {
      // A metafile: the object it becomes once converted, set aside (its part stays out of `EmitResult.media`).
      const object = pictureObject(
        { ...ctx, media: new Map(), mediaId: () => METAFILE_MEDIA },
        e.xf,
        e.picture,
        e.geom,
        e.adj,
      );
      if (object) ctx.metafiles?.push({ part: e.picture.part, object, at: out.length });
      return;
    }
    ctx.log(`${e.what} drawn by LibreOffice as a picture`);
    return;
  }
  if (e.kind === 'picture') {
    emitPicture(ctx, e, out);
    return;
  }
  emitShape(ctx, e, out, texts);
}

function emitPicture(ctx: EmitCtx, e: PictureElement, out: SlideObject[]): void {
  if (decompose(e.xf).flipH) ctx.log('a flipped picture is drawn unflipped (M3)');
  if (e.reasons?.some((r) => r.startsWith('mask:')))
    ctx.log(`a picture clipped to ${e.geom} is drawn as a rect (M3)`);
  if (e.picture.effects?.length) ctx.log('a recoloured picture is drawn without its recolouring (M3)');
  if (e.media) ctx.log(`a ${e.media.kind} is drawn as its poster (M5)`);
  const img = pictureObject(ctx, e.xf, e.picture, e.geom, e.adj);
  if (img) out.push(img);
  const stroke = e.line ? legacyColor(e.line.fill) : undefined;
  if (e.line && stroke) {
    const box = boxOf(ctx, e.xf);
    const kind = e.geom === 'ellipse' ? 'ellipse' : 'rect';
    const o = shape(ctx, box, kind, undefined);
    o.stroke = { width: strokeWidth(ctx, e.line.width), color: stroke };
    if (e.geom === 'roundRect') o.radius = cornerRadius(box, e.adj);
    out.push(o);
  }
}

/** Lines and connectors drawn as straight segments, in the shape's unit square. */
function segmentsOf(geom: string, adj: [string, number][] | undefined): [number, number][] | undefined {
  if (geom === 'line' || geom === 'straightConnector1' || geom.startsWith('curvedConnector')) {
    return [
      [0, 0],
      [1, 1],
    ];
  }
  if (geom === 'bentConnector2')
    return [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
  if (geom.startsWith('bentConnector')) {
    const x = Math.min(10, Math.max(-10, adjOf(adj, 'adj1', 50_000) / 100_000));
    return [
      [0, 0],
      [x, 0],
      [x, 1],
      [1, 1],
    ];
  }
  return undefined;
}

/** Presets drawn as an ellipse, and as a rect with fully rounded ends. */
const ELLIPTIC = new Set([
  'ellipse',
  'flowChartConnector',
  'flowChartOr',
  'flowChartSummingJunction',
  'pie',
  'chord',
  'teardrop',
  'cloud',
  'smileyFace',
]);
const ROUNDED = new Set(['roundRect', 'flowChartAlternateProcess']);

function emitShape(ctx: EmitCtx, e: ShapeElement, out: SlideObject[], texts: Emitted[]): void {
  const box = boxOf(ctx, e.xf);
  if (e.fill.kind === 'picture') {
    const img = pictureObject(ctx, e.xf, e.fill.picture, e.geom, e.adj);
    if (img) out.push(img);
  }
  const fill = e.fill.kind === 'picture' ? undefined : legacyColor(e.fill);
  const stroke = e.line ? legacyColor(e.line.fill) : undefined;
  // PowerPoint casts a shape's shadow on its text only when the shape itself shows nothing.
  const visible = e.fill.kind === 'picture' || fill !== undefined || stroke !== undefined;
  const segments = segmentsOf(e.geom, e.adj);
  if (segments) {
    if (stroke && e.line) {
      for (let i = 1; i < segments.length; i++)
        out.push(
          lineObject(ctx, e.xf, segments[i - 1]!, segments[i]!, strokeWidth(ctx, e.line.width), stroke),
        );
      if (e.line.head || e.line.tail) ctx.log('arrowheads are not drawn yet (M6)');
    }
  } else if (e.geom === 'custom' && e.coverage !== undefined && e.coverage < MIN_RECT_COVERAGE) {
    if (fill || stroke) ctx.log('custom geometry that fills little of its box is not drawn (M6)');
  } else if (fill || stroke) {
    const kind = ELLIPTIC.has(e.geom) ? 'ellipse' : 'rect';
    const o = shape(ctx, box, kind, fill);
    if (stroke && e.line) o.stroke = { width: strokeWidth(ctx, e.line.width), color: stroke };
    if (ROUNDED.has(e.geom)) o.radius = cornerRadius(box, e.adj);
    else if (e.geom === 'flowChartTerminator') o.radius = Math.min(box.w, box.h) / 2;
    const approx = (e.reasons ?? []).filter((r) => r !== 'vert' && r !== 'warp' && r !== 'numCol');
    if (approx.length) ctx.log(`${approx.join(', ')} drawn as ${kind}`);
    out.push(o);
  }
  if (e.line?.dash) ctx.log('dashed lines are drawn solid (M6)');
  if (e.text) {
    const t = textObject(ctx, e, box, visible);
    if (t) {
      out.push(t);
      texts.push({ o: t, e, area: box.w * box.h });
    }
  }
}

function lineObject(
  ctx: EmitCtx,
  xf: Affine,
  a: [number, number],
  b: [number, number],
  width: number,
  color: OrdoRgba,
): ShapeObject {
  const f = ctx.frame;
  const [x0, y0] = apply(xf, a[0], a[1]);
  const [x1, y1] = apply(xf, b[0], b[1]);
  const px0 = f.x0 + x0 * f.s;
  const py0 = f.y0 + y0 * f.s;
  const px1 = f.x0 + x1 * f.s;
  const py1 = f.y0 + y1 * f.s;
  const len = Math.hypot(px1 - px0, py1 - py0);
  const rot = len > 0 ? (Math.atan2(py1 - py0, px1 - px0) * 180) / Math.PI : 0;
  const cx = (px0 + px1) / 2;
  const cy = (py0 + py1) / 2;
  const o = shape(
    ctx,
    clampBox({ x: cx - len / 2, y: cy, w: len, h: 0, rotation: Math.abs(rot) < 1e-9 ? 0 : rot }),
    'line',
    undefined,
  );
  o.stroke = { width, color };
  return o;
}

/** A line width in logical px: PowerPoint draws a zero-width line one device pixel wide. */
function strokeWidth(ctx: EmitCtx, w: number): number {
  return bound(Math.max(lenPx(ctx.frame, w), 0.5), 0, 500);
}

function adjOf(adj: [string, number][] | undefined, name: string, dflt: number): number {
  for (const [k, v] of adj ?? []) if (k === name) return v;
  return dflt;
}

/** A roundRect's corner radius: `adj` (0-50,000) of the shorter side. */
function cornerRadius(box: Box, adj: [string, number][] | undefined): number {
  const a = Math.min(50_000, Math.max(0, adjOf(adj, 'adj', ROUND_RECT_ADJ)));
  return bound((Math.min(box.w, box.h) * a) / 100_000, 0, MAX_COORD);
}

// ── Pictures ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a picture lands in its shape's unit square and what of it shows: `a:fillRect` places the (cropped)
 * picture inside the box and the box clips it, so the visible part becomes the placement and the crop
 * grows by what the clip removes. Undefined when nothing of it shows.
 */
export function placePicture(
  p: PictureFill,
): { rect: [number, number, number, number]; crop?: Insets } | undefined {
  const c = p.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const f = p.fillRect ?? { l: 0, t: 0, r: 0, b: 0 };
  const axis = (cl: number, cr: number, fl: number, fr: number) => {
    const span = 1 - fl - fr; // the picture's share of the box
    const used = 1 - cl - cr; // the source's share used
    if (!(span > 1e-9) || !(used > 1e-9)) return undefined;
    const lo = Math.max(0, fl);
    const hi = Math.min(1, 1 - fr);
    if (!(hi > lo)) return undefined;
    const u = (x: number) => cl + ((x - fl) / span) * used;
    // Where the box does not clip, the source crop stays exactly as written.
    return { lo, hi, cl: lo === fl ? cl : u(lo), cr: hi === 1 - fr ? cr : 1 - u(hi) };
  };
  const x = axis(c.l, c.r, f.l, f.r);
  const y = axis(c.t, c.b, f.t, f.b);
  if (!x || !y) return undefined;
  const crop = { l: x.cl, t: y.cl, r: x.cr, b: y.cr };
  const any =
    Math.abs(crop.l) > 1e-9 || Math.abs(crop.t) > 1e-9 || Math.abs(crop.r) > 1e-9 || Math.abs(crop.b) > 1e-9;
  return { rect: [x.lo, y.lo, x.hi, y.hi], ...(any ? { crop } : {}) };
}

function pictureObject(
  ctx: EmitCtx,
  xf: Affine,
  p: PictureFill,
  geom = 'rect',
  adj?: [string, number][],
): CroppedImage | undefined {
  const placed = placePicture(ctx.crop ? p : { ...p, crop: undefined });
  if (!placed) return undefined;
  const [x0, y0, x1, y1] = placed.rect;
  let box = boxPx(ctx.frame, multiply(xf, [x1 - x0, 0, 0, y1 - y0, x0, y0]));
  let crop = ctx.crop ? placed.crop : undefined;
  if (outsideClamp(box)) {
    if (box.rotation === 0 && geom === 'rect' && ctx.crop) {
      const cut = cutToClamp(box, crop);
      if (!cut) return undefined;
      box = cut.box;
      crop = cut.crop;
    } else ctx.log('a picture reaching far past the slide is drawn squeezed into the render bounds');
  }
  box = clampBox(box);
  const o: CroppedImage = {
    id: ctx.newId(),
    type: 'image',
    box,
    mediaId: mediaOf(ctx, p.part),
    fit: 'stretch',
    opacity: bound(p.alpha ?? 1, 0, 1),
    radius: 0,
  };
  if (geom === 'roundRect') o.radius = cornerRadius(box, adj);
  else if (geom === 'ellipse') o.radius = bound(Math.min(box.w, box.h) / 2, 0, MAX_COORD);
  if (crop) {
    const c = (v: number) => bound(v, -1, 1);
    o.crop = { l: c(crop.l), t: c(crop.t), r: c(crop.r), b: c(crop.b) };
  } else if (!ctx.crop && p.crop) ctx.log('a cropped picture is drawn uncropped');
  return o;
}

/** Whether a box reaches past the render clamp's bounds (±2× the canvas), where it would be squeezed. */
function outsideClamp(b: Box): boolean {
  const W = BOX_FACTOR * CANVAS_W;
  const H = BOX_FACTOR * CANVAS_H;
  return b.x < -W || b.y < -H || b.x + b.w > W || b.y + b.h > H;
}

/**
 * An unrotated picture box cut to the render clamp's bounds, the part cut off folded into its crop (shares
 * of the source, `ImageObject.crop`). Undefined when nothing of it is left inside.
 */
export function cutToClamp(box: Box, crop: Insets | undefined): { box: Box; crop?: Insets } | undefined {
  const W = BOX_FACTOR * CANVAS_W;
  const H = BOX_FACTOR * CANVAS_H;
  const c = crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const axis = (at: number, len: number, lo: number, hi: number, cl: number, cr: number) => {
    const a = Math.max(at, lo);
    const b = Math.min(at + len, hi);
    if (!(len > 0) || !(b > a)) return undefined;
    const used = 1 - cl - cr; // the source's share the box shows
    return { at: a, len: b - a, cl: cl + ((a - at) / len) * used, cr: cr + ((at + len - b) / len) * used };
  };
  const x = axis(box.x, box.w, -W, W, c.l, c.r);
  const y = axis(box.y, box.h, -H, H, c.t, c.b);
  if (!x || !y) return undefined;
  const out = { l: x.cl, t: y.cl, r: x.cr, b: y.cr };
  const any = [out.l, out.t, out.r, out.b].some((v) => Math.abs(v) > 1e-9);
  return { box: { x: x.at, y: y.at, w: x.len, h: y.len, rotation: 0 }, ...(any ? { crop: out } : {}) };
}

function mediaOf(ctx: EmitCtx, part: string): string {
  let id = ctx.media.get(part);
  if (id === undefined) {
    id = ctx.mediaId(part);
    ctx.media.set(part, id);
  }
  return id;
}

// ── Text ────────────────────────────────────────────────────────────────────────────────────────────────

/** The text of a body as `TextObject.text`: paragraphs and breaks as '\n', tabs as spaces. */
export function legacyText(body: TextBody): string {
  return body.paras
    .map((p) => p.runs.map((r) => (r.kind === 'break' ? '\n' : r.text.replaceAll('\t', ' '))).join(''))
    .join('\n');
}

/** A key for "the same look" when counting characters per style. */
function styleKey(s: RunStyle): string {
  const f =
    s.fill.kind === 'solid'
      ? `${s.fill.color.r},${s.fill.color.g},${s.fill.color.b},${s.fill.color.a}`
      : s.fill.kind;
  return [
    s.sizePt,
    s.bold,
    s.italic,
    s.latin ?? '',
    f,
    s.caps,
    s.spacingPt,
    s.outline ? s.outline.width : '',
    s.shadow ? 1 : 0,
  ].join('|');
}

/** The dominant run style (most characters) and the paragraph holding most of the text. */
export function dominant(body: TextBody): { style: RunStyle; para: Para; text: string } | undefined {
  const count = new Map<string, { n: number; style: RunStyle; text: string }>();
  let top: { n: number; style: RunStyle; text: string } | undefined;
  let para: Para | undefined;
  let paraChars = -1;
  for (const p of body.paras) {
    let pc = 0;
    for (const r of p.runs) {
      if (r.kind === 'break') continue;
      const n = visibleChars(r.text);
      pc += n;
      if (!n) continue;
      const k = styleKey(r.style);
      let c = count.get(k);
      if (!c) count.set(k, (c = { n: 0, style: r.style, text: '' }));
      c.n += n;
      if (c.text.length < 400) c.text += r.text;
      if (!top || c.n > top.n) top = c;
    }
    if (pc > paraChars) {
      para = p;
      paraChars = pc;
    }
  }
  if (!para) return undefined;
  return { style: top?.style ?? para.end, para, text: top?.text ?? '' };
}

/** Text mostly in East Asian scripts, or in complex scripts (Arabic, Hebrew, Indic, Thai). */
function scriptOf(text: string): 'latin' | 'ea' | 'cs' {
  let ea = 0;
  let cs = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x2e80 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7af) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xffef) ||
      c >= 0x20000
    )
      ea++;
    else if (
      (c >= 0x0590 && c <= 0x08ff) ||
      (c >= 0x0900 && c <= 0x0e7f) ||
      (c >= 0xfb1d && c <= 0xfdff) ||
      (c >= 0xfe70 && c <= 0xfeff)
    )
      cs++;
    else if (ch.trim()) other++;
  }
  return ea > other && ea >= cs ? 'ea' : cs > other ? 'cs' : 'latin';
}

function textObject(
  ctx: EmitCtx,
  e: ShapeElement,
  shapeBox: Box,
  shapeVisible: boolean,
): TextObject | undefined {
  if (ctx.rich) return richTextObject(ctx, e, shapeBox, shapeVisible);
  const body = e.text!;
  let text = legacyText(body);
  if (!text.trim()) return undefined;
  if (text.length > MAX_TEXT) {
    ctx.log(`a text box was cut to ${MAX_TEXT} characters`);
    text = text.slice(0, MAX_TEXT);
  }
  const dom = dominant(body);
  if (!dom) return undefined;
  const st = dom.style;
  const f = ctx.frame;
  const fit = body.autofit.kind === 'shrink' ? body.autofit : undefined;
  const fontPx = bound(ptPx(f, st.sizePt * (fit?.fontScale ?? 1)), MIN_FONT_PX, MAX_FONT_PX);

  // The text rectangle: the preset's, minus the insets; padding is the smallest inset, the rest is folded.
  let box = textRect(e, shapeBox);
  const ins = body.insets;
  const l = lenPx(f, ins.l);
  const t = lenPx(f, ins.t);
  const r = lenPx(f, ins.r);
  const b = lenPx(f, ins.b);
  const pad = Math.min(l, t, r, b);
  box = insetBox(box, l - pad, t - pad, r - pad, b - pad);
  const margin = marginOf(body);
  if (margin.l || margin.r) box = insetBox(box, lenPx(f, margin.l), 0, lenPx(f, margin.r), 0);
  const para = dom.para;
  const align =
    para.align === 'center' || para.align === 'distribute'
      ? 'center'
      : para.align === 'right'
        ? 'right'
        : 'left';
  if (para.align === 'justify' || para.align === 'distribute')
    ctx.log(`${para.align} text is drawn ${align}-aligned (M2)`);
  if (!body.wrap) {
    const g = NO_WRAP_GROWTH;
    box =
      align === 'left'
        ? insetBox(box, 0, 0, -g, 0)
        : align === 'right'
          ? insetBox(box, -g, 0, 0, 0)
          : insetBox(box, -g / 2, 0, -g / 2, 0);
  }
  if (
    body.vert === 'vert' ||
    body.vert === 'eaVert' ||
    body.vert === 'mongolianVert' ||
    body.vert === 'vert270'
  )
    box = quarterTurn(box, body.vert === 'vert270' ? -90 : 90);
  if (body.vert || body.warp || body.numCol)
    ctx.log('vertical, warped or multi-column text is drawn as plain text (M8)');

  const face = scriptOf(dom.text);
  const family = (face === 'ea' ? st.ea : face === 'cs' ? st.cs : undefined) ?? st.latin ?? 'Calibri';
  let color = legacyColor(st.fill);
  if (st.fill.kind === 'none') color = { r: 0, g: 0, b: 0, a: 0 }; // hollow: only the outline shows
  const style: TextObject['style'] = {
    fontFamily: family.slice(0, 300),
    fontWeight: st.bold ? 700 : 400,
    fontStyle: st.italic ? 'italic' : 'normal',
    fontSizePx: fontPx,
    color: color ?? { r: 0, g: 0, b: 0, a: 1 },
    align,
    valign: body.anchor,
    lineHeight: lineHeightOf(para, fontPx, f, fit?.lnSpcReduction ?? 0),
    letterSpacing: bound(ptPx(f, st.spacingPt), -1000, 1000),
    padding: bound(pad, 0, MAX_COORD),
    transform: st.caps === 'none' ? 'none' : 'uppercase',
  };
  const outline = st.outline && st.outline.fill.kind === 'solid' ? ordo(st.outline.fill.color) : undefined;
  if (st.outline && outline)
    style.outline = { width: bound(lenPx(f, st.outline.width) / 2, 0, 500), color: outline };
  const shadow = st.shadow ?? (shapeVisible ? undefined : e.shadow);
  if (shadow) {
    const dir = (shadow.dir * Math.PI) / 180;
    const dist = lenPx(f, shadow.dist);
    style.shadow = {
      dx: bound(dist * Math.cos(dir), -500, 500),
      dy: bound(dist * Math.sin(dir), -500, 500),
      blur: bound(lenPx(f, shadow.blur), 0, 500),
      color: ordo(shadow.color),
    };
  }
  if (st.caps === 'small') ctx.log('small caps are drawn as capitals (M2)');
  return { id: ctx.newId(), type: 'text', box: clampBox(box), text, style, opacity: 1 };
}

/**
 * A body as a rich `TextObject` (`richtext.ts`): the box is the shape's text rectangle (the preset's, turned
 * a quarter for vertical text), the insets and paragraph margins are written as they are.
 */
function richTextObject(
  ctx: EmitCtx,
  e: ShapeElement,
  shapeBox: Box,
  shapeVisible: boolean,
): TextObject | undefined {
  const body = e.text!;
  // Past the slide's budget the text is written without runs and paragraph styles (picture class anyway).
  const over = ctx.textBytes > MAX_SLIDE_BYTES;
  const rich = richText(body, {
    frame: ctx.frame,
    ...(shapeVisible || !e.shadow ? {} : { shapeShadow: e.shadow }),
    log: ctx.log,
    ...(ctx.lo ? { lo: true } : {}),
    ...(over ? { plain: true } : {}),
  });
  if (!rich) return undefined;
  let box = textRect(e, shapeBox);
  if (
    body.vert === 'vert' ||
    body.vert === 'eaVert' ||
    body.vert === 'mongolianVert' ||
    body.vert === 'vert270'
  )
    box = quarterTurn(box, body.vert === 'vert270' ? -90 : 90);
  if (body.vert || body.warp || body.numCol)
    ctx.log('vertical, warped or multi-column text is drawn as plain text (M8)');
  const o: TextObject = {
    id: ctx.newId(),
    type: 'text',
    box: clampBox(box),
    text: rich.text,
    style: rich.style,
    opacity: 1,
  };
  if (rich.runs) o.runs = rich.runs;
  if (rich.paras) o.paras = rich.paras;
  if (!over) {
    ctx.textBytes += utf8Bytes(JSON.stringify(o));
    if (ctx.textBytes > MAX_SLIDE_BYTES) ctx.log(SLIDE_BUDGET_NOTE);
  }
  return o;
}

/**
 * The paragraph margin to fold into a legacy text box, in EMU, on the start side of the paragraphs: the
 * least that every paragraph with text keeps clear of (`marL`, or the first line's `marL + indent` when a
 * paragraph has no bullet and that is less; bullets are not drawn in M1, so text starts at `marL`). Left
 * for left-to-right paragraphs, right for right-to-left ones; none when they are mixed.
 */
export function marginOf(body: TextBody): { l: number; r: number } {
  let least = Number.POSITIVE_INFINITY;
  let ltr = false;
  let rtl = false;
  for (const p of body.paras) {
    if (!p.runs.some((r) => r.kind !== 'break' && r.text.trim())) continue;
    const m = p.bullet ? p.marL : Math.min(p.marL, p.marL + p.indent);
    least = Math.min(least, Math.max(0, m));
    if (p.rtl) rtl = true;
    else ltr = true;
  }
  if (!Number.isFinite(least) || least <= 0 || (ltr && rtl)) return { l: 0, r: 0 };
  return rtl ? { l: 0, r: least } : { l: least, r: 0 };
}

/** `TextStyle.lineHeight` (a multiple of the font size) from the paragraph's line spacing. */
function lineHeightOf(p: Para, fontPx: number, f: Frame, reduction: number): number {
  const ls = p.lineSpacing;
  let h: number;
  if (ls && 'pts' in ls) h = (ls.pts * EMU_PER_PT * f.s) / fontPx;
  else h = SINGLE_LINE * Math.max(0, (ls?.pct ?? 1) - reduction);
  return bound(h, 0.1, 10);
}

/** The preset's text rectangle in the shape's box (rect for presets M1 does not know). */
function textRect(e: ShapeElement, box: Box): Box {
  if (ELLIPTIC.has(e.geom) && e.geom !== 'pie' && e.geom !== 'chord') {
    const dx = box.w * ELLIPSE_TEXT_INSET;
    const dy = box.h * ELLIPSE_TEXT_INSET;
    return insetBox(box, dx, dy, dx, dy);
  }
  if (ROUNDED.has(e.geom)) {
    const d = cornerRadius(box, e.adj) * ROUND_RECT_TEXT_INSET;
    return insetBox(box, d, d, d, d);
  }
  return box;
}

// ── Boxes and colours ───────────────────────────────────────────────────────────────────────────────────

type Box = { x: number; y: number; w: number; h: number; rotation: number };

/** `v` within [lo, hi]; NaN and infinities become `lo` clamped to 0. */
function bound(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : Math.min(hi, Math.max(lo, 0));
}

function clampBox(b: Box): Box {
  const c = (v: number) => bound(v, -MAX_COORD, MAX_COORD);
  return {
    x: c(b.x),
    y: c(b.y),
    w: bound(b.w, 0, MAX_COORD),
    h: bound(b.h, 0, MAX_COORD),
    rotation: bound(b.rotation, -36_000, 36_000),
  };
}

function boxOf(ctx: EmitCtx, xf: Affine): Box {
  return clampBox(boxPx(ctx.frame, xf));
}

/**
 * A box narrowed by `l`, `t`, `r`, `b` along its own (rotated) axes; negative values grow it. The size never
 * goes below zero.
 */
export function insetBox(box: Box, l: number, t: number, r: number, b: number): Box {
  const w = Math.max(0, box.w - l - r);
  const h = Math.max(0, box.h - t - b);
  const lx = (l - r) / 2;
  const ly = (t - b) / 2;
  const a = (box.rotation * Math.PI) / 180;
  const cx = box.x + box.w / 2 + lx * Math.cos(a) - ly * Math.sin(a);
  const cy = box.y + box.h / 2 + lx * Math.sin(a) + ly * Math.cos(a);
  return { x: cx - w / 2, y: cy - h / 2, w, h, rotation: box.rotation };
}

/** The same centre, the sides swapped and turned by `deg` (vertical text laid out along the long side). */
function quarterTurn(box: Box, deg: number): Box {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let rotation = box.rotation + deg;
  if (rotation > 180) rotation -= 360;
  if (rotation <= -180) rotation += 360;
  return { x: cx - box.h / 2, y: cy - box.w / 2, w: box.h, h: box.w, rotation };
}

function ordo(c: Rgba): OrdoRgba {
  const ch = (v: number) => (Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : 0);
  return { r: ch(c.r), g: ch(c.g), b: ch(c.b), a: Number.isFinite(c.a) ? Math.min(1, Math.max(0, c.a)) : 1 };
}

/** The share of the foreground in a `pctNN` pattern; 0.5 for the others. */
function patternShare(preset: string): number {
  const m = /^pct(\d{1,2})$/.exec(preset);
  return m ? Number(m[1]) / 100 : 0.5;
}

/**
 * The legacy solid colour of a fill (design/27 §3.2): solid as it is, a gradient's first stop, a pattern's
 * foreground and background blended by coverage. Undefined for none, pictures and group fills.
 */
export function legacyColor(f: Fill): OrdoRgba | undefined {
  switch (f.kind) {
    case 'solid':
      return ordo(f.color);
    case 'gradient': {
      let first = f.stops[0];
      for (const s of f.stops) if (first && s.at < first.at) first = s;
      return first ? ordo(first.color) : undefined;
    }
    case 'pattern': {
      const k = patternShare(f.preset);
      const mix = (a: number, b: number) => a * k + b * (1 - k);
      return ordo({
        r: mix(f.fg.r, f.bg.r),
        g: mix(f.fg.g, f.bg.g),
        b: mix(f.fg.b, f.bg.b),
        a: mix(f.fg.a, f.bg.a),
      });
    }
    default:
      return undefined;
  }
}

function shape(ctx: EmitCtx, box: Box, kind: ShapeObject['shape'], fill: OrdoRgba | undefined): ShapeObject {
  return {
    id: ctx.newId(),
    type: 'shape',
    box: clampBox(box),
    shape: kind,
    ...(fill ? { fill } : {}),
    opacity: 1,
    radius: 0,
  };
}

/** FNV-1a over the objects' JSON, two 32-bit lanes: 16 hex digits. */
export function digestOf(objects: readonly SlideObject[]): string {
  const s = JSON.stringify(objects);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
