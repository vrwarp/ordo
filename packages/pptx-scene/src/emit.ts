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
 *   fit, 4:3 decks centred). Boxes keep their rotation; a reflection (of the shape, of a group, or both) is
 *   `flipH` with the rotation that makes it exact (a vertical flip is a horizontal one turned half a turn),
 *   written on pictures and on shapes whose geometry or gradient it changes (M6).
 * - **Rich text** (default): one `TextObject` per body, `richtext.ts`, its box the shape's text rectangle
 *   (the preset's, turned a quarter for vertical text); insets and margins are written, not folded.
 * - **Legacy text** (`richText: false`): one `TextObject` per body in its dominant run's style (most
 *   characters): size (times a stored `normAutofit` fontScale), colour, bold, italic, the Latin typeface
 *   (the East Asian or complex-script one when the text is mostly in those scripts), caps, letter spacing.
 *   `algn` → align (justify → left, distribute → center), anchor → valign, line spacing → lineHeight
 *   (single = 1.2 × the font size, the office line model; a `lnSpcReduction` is subtracted), text outline
 *   → `outline` with width w/2 (ordo strokes twice the width under the fill), hollow text → alpha 0 plus
 *   the outline, the run's outer shadow (or the shape's, when the shape itself draws nothing) → `shadow`.
 * - **Text rectangle.** The geometry's text rectangle (M6: every preset of POI's table, a custom
 *   geometry's `a:rect`), placed through the shape's affine, so it is mirrored with a flipped shape.
 *   For legacy text `padding` is the smallest body inset and the difference to each other inset is folded
 *   into the box, so the text area is PowerPoint's exactly; `wrap="none"` widens the box on the side(s) the
 *   alignment grows into, so ordo never wraps it. `vert`/`vert270`/`eaVert` turn the box a quarter turn.
 * - **Shapes**: rect, roundRect (radius from its `adj`), ellipse as today's fields, and beside them since M6
 *   (`geom.ts`) the preset (`geom.preset`, `adj`) or custom geometry (`geom.paths`), the gradient, dash,
 *   arrowheads, flips and effects (outer shadow, glow, soft edge). Lines and straight connectors are one
 *   `line` object at any angle; bent and curved connectors one `line` object whose midline joins their ends
 *   (what an older build draws) with their route as `geom.paths`. Other presets' legacy is the nearest of
 *   rect and ellipse; a thin custom geometry's is a line (no fill). Fills' legacy colour: solid; a
 *   gradient's first stop; a pattern's blend (noted). A picture fill is an image clipped to the geometry.
 * - **Paragraph margins** (legacy text) fold into the text box, as `padding` does: the box is narrowed on
 *   the paragraphs' start side by the margin all of their text keeps clear of (`marL`; for a paragraph
 *   without a bullet, the first line's `marL + indent` when that is less), since a legacy `TextObject` has
 *   one left edge.
 * - **Pictures** (`p:pic` and picture fills) are stretched images. `a:fillRect` folds into the box (clipped
 *   to the shape) and, with `crop`, into the crop together with `a:srcRect`. roundRect and ellipse clips
 *   become `radius` (an ellipse is exact for a circle) for an older build, every clip geometry `mask` (M6);
 *   a picture outline is a stroke-only shape above it along the same geometry.
 *   An unrotated picture reaching past ±2× the canvas (the render clamp, design/27 §12) is cut there and
 *   the cut folded into the crop, so the clamp never squeezes it. A recoloured picture (duotone, clrChange,
 *   grayscl, biLevel, lum) and a tiled fill (one picture over the whole box) are baked (M6, `bake.ts`): their
 *   placeholder is `pptxmedia:bake<n>`, one per part and recipe, listed in `EmitResult.media` with it.
 * - **Geometry files** (M6 round 2): a geometry's paths of more than `GEOM_FILE_CHARS` on a slide (one
 *   geometry's JSON times the times the slide draws it), and then the largest others while the slide as the
 *   hub stores it is within 4 KB of `MAX_SLIDE_BYTES`, are written once in a geometry file (`ShapeGeom.ref`, placeholder
 *   `pptxgeom:<n>`, one per distinct file, listed in `EmitResult.geoms`) instead of in the slide. A slide
 *   still past it (its text formatting, or its objects with every path in files) is picture class.
 * - **SmartArt** drawn from its drawing cache (M6, `smartart.ts`): its objects are a locked group (origin
 *   role 'diagram'; text objects unlocked), and its text is never the lyric box.
 * - **Backgrounds**: a plain stretched picture known to be opaque whose aspect is known and matches a 16:9
 *   slide → `backgroundMediaId` (drawn cover-fit, on black); any other picture, one that may be transparent
 *   or of unknown size or alpha included (a spilled part without `ParseOptions.pictureSize`) → a bottom
 *   image stretched over the slide area, on white; solid,
 *   gradient (M6: its `gradient`, stops laid on white) and pattern → a bottom rect over the whole 1920x1080
 *   frame (`extendBackgrounds`, default) or
 *   the slide area; none → white, as PowerPoint shows it.
 * - **Video and sound** (`media.ts`): the first slide video plays in its poster's box (`ImageObject.play`),
 *   the first slide sound is `Slide.audio`, a looping muted full-slide video is the slide's motion background
 *   (`backgroundMediaId`); clips carry `pptxmedia:clip<n>` placeholders, listed in `EmittedSlide.clips`.
 * - **Tables** (M6, `tables.ts` `emitTable`): locked grid shapes (background, cell fills, lines) and one rich
 *   `TextObject` per cell, in one group; a table classed residual emits nothing (LibreOffice's art).
 * - **The object budget** (M6, `classify.ts`): on a slide past it, a run of z-adjacent shapes of one look
 *   (`ShapeElement.merge`) is one shape object of all their paths (`emitMerged`), and an element the budget
 *   sent to the art ('budget:shapes') emits nothing, as a residual table.
 * - **Lyric box** (design/27 §4 "Church mappings"): the slide's own body placeholder with the most
 *   characters; else the largest other text by characters × area (not title, date, footer, slide number);
 *   the title only when it is the only text. On a bilingual slide (the two boxes with the most text in
 *   different languages, of comparable length) the first of them in reading order.
 *
 * Owned by work item C (inherit-emit).
 */
import type {
  GeomFile,
  Gradient as OrdoGradient,
  ImageObject,
  Rgba as OrdoRgba,
  ShapeGeom,
  ShapeObject,
  Slide,
  SlideObject,
  TextObject,
} from '@ordo/domain';
import { EFFECT_COST, effectArea } from '@ordo/renderer/geom/cost.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from '@ordo/renderer/geom/ops.ts';
import { apply, boxPx, decompose, lenPx, multiply, ptPx, slideRect } from './frame.ts';
import { bakeKey, bakeOf, type PictureBake } from './bake.ts';
import { boundsOf, unionBox } from './classify.ts';
import {
  adjPairs,
  dashOf,
  endsOf,
  gradientOf,
  knownPreset,
  mergedPaths,
  pictureFillPlacement,
  presetRoute,
  type ShapePiece,
  shapePiece,
  textRectOf,
  transformedPaths,
} from './geom.ts';
import { artInfo } from './hybrid.ts';
import { isFooter, isTitle, masterClass } from './inherit.ts';
import { type EmittedClip, emitMedia } from './media.ts';
import type {
  Affine,
  ArtInfo,
  Classification,
  CustomPaths,
  DeckScene,
  Element,
  Fill,
  Frame,
  Insets,
  Line,
  Para,
  PictureElement,
  PictureFill,
  RectEmu,
  Rgba,
  RunStyle,
  Shadow,
  ShapeElement,
  SlideScene,
  TableElement,
  TextBody,
} from './ir.ts';
import { EMU_PER_PT } from './ir.ts';
import { noteList } from './log.ts';
import { scriptClasses } from './fontmap.ts';
import { BAKED_EFFECTS, extensionOf, METAFILE_EXTENSIONS } from './picture.ts';
import { richText } from './richtext.ts';
import { lockDiagram } from './smartart.ts';
import { emitTable } from './tables.ts';

/** The prefix of placeholder media ids. */
export const MEDIA_PREFIX = 'pptxmedia:';
/** The prefix of clip placeholders (`media.ts`): `pptxmedia:clip<n>`, one per clip part and trim. */
export const CLIP_PREFIX = `${MEDIA_PREFIX}clip`;
/**
 * The prefix of baked pictures' placeholders (M6, `bake.ts`): `pptxmedia:bake<n>`, one per picture part and
 * recipe, listed in `EmitResult.media` with their `bake`.
 */
export const BAKE_PREFIX = `${MEDIA_PREFIX}bake`;
/**
 * The prefix of geometry files' placeholders (M6 round 2, `ShapeGeom.ref`): `pptxgeom:<n>`, one per distinct
 * file, listed in `EmitResult.geoms` with its content; the hub stores each and names it by its SHA-256.
 */
export const GEOM_PREFIX = 'pptxgeom:';
/**
 * A geometry whose paths take more than this many characters of a slide's JSON (its own times the times the
 * slide draws it) is written in a geometry file (`ShapeGeom.ref`, M6 round 2). Smaller ones stay inline
 * unless the slide comes within 4 KB of `MAX_SLIDE_BYTES` with them: then the largest go to files too.
 */
export const GEOM_FILE_CHARS = 2_048;
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
/**
 * The note a slide gets when it is over `MAX_SLIDE_BYTES` as the hub stores it (`storedSlideBytes`) with
 * its large geometries in files (an importer that logs the budget itself drops it, as `SLIDE_BUDGET_NOTE`).
 */
export const SLIDE_BYTES_NOTE = `the slide is more than ${MAX_SLIDE_BYTES / 1024} KB as stored, with its shape outlines in files (picture class)`;
/** What `storedSlideBytes` adds for a slide's provenance (`Slide.pptx` without notes) and as a margin. */
const PROVENANCE_BYTES = 400;
/** Characters of an id as the hub writes it (a ULID) and of a geometry file's name (a SHA-256 in hex). */
const STORED_ID_CHARS = 26;
const STORED_REF_CHARS = 64;
/**
 * Geometries go to files until the slide is this far within `MAX_SLIDE_BYTES`: room for what the hub adds
 * that the converter does not know (speaker notes, timing, a transition).
 */
const SLIDE_BYTES_ROOM = 4 * 1024;
/** `"ref":"<64>"` and the two braces of a file's JSON (`{"paths":…}`) it no longer has around its paths. */
const REF_JSON_BYTES = 7 + STORED_REF_CHARS + 2;
/** The provenance notes the hub keeps per slide (`Slide.pptx.notes`), each cut to 200 characters. */
const STORED_NOTES = 16;
const STORED_NOTE_CHARS = 200;
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

const WHITE: OrdoRgba = { r: 255, g: 255, b: 255, a: 1 };

export interface EmitOptions {
  /** A new id for each slide and object; default: deterministic `pptx-<n>`. */
  newId?: () => string;
  /**
   * The media id of a picture part; default `pptxmedia:<n>`, numbered from 1 in first-use order (part names
   * can be long; a slide's ids must stay within the schema's 200 characters).
   */
  mediaId?: (part: string) => string;
  /**
   * The placeholder media id of a clip, by `media.ts` `clipKey` (its part and trim); default
   * `pptxmedia:clip<n>`, numbered from 1 in first-use order.
   */
  clipId?: (key: string) => string;
  /** 'Import transition sounds' (default false): a slide's transition sound becomes its sound. */
  transitionSounds?: boolean;
  /**
   * Write large geometries in geometry files (M6 round 2, `ShapeGeom.ref`; default true). With false every
   * geometry's paths stay in the slide (what the importer writes while the schema ships one release ahead
   * of it, §3.2), counted toward `MAX_SLIDE_BYTES` all the same.
   */
  geomFiles?: boolean;
  /**
   * The placeholder of a geometry file by its JSON (`GeomFile`); default `pptxgeom:<n>`, numbered from 1 in
   * first-use order. Asked once per distinct file.
   */
  geomId?: (json: string) => string;
  /**
   * The placeholder id of a baked picture (M6, `bake.ts`), by its source part and recipe; default
   * `pptxmedia:bake<n>`, numbered from 1 in first-use order. Asked once per part and recipe.
   */
  bakeId?: (part: string, bake: PictureBake) => string;
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
   * or the slide as the hub stores it did with its large geometries in files (`storedSlideBytes`), and it
   * would be native or hybrid otherwise. An importer counts and logs it exactly as its own slide budget
   * would (the hub: a compact picture slide, one warning), and drops `SLIDE_BUDGET_NOTE` and
   * `SLIDE_BYTES_NOTE`.
   */
  overBudget?: true;
  /** The clips the slide plays or names (`media.ts`): what the hub ingests and puts in place of placeholders. */
  clips?: EmittedClip[];
}

/** The placeholder media id of a metafile's object until it is converted (`EmittedSlide.metafiles`). */
export const METAFILE_MEDIA = 'pptxmedia:metafile';

export interface EmitResult {
  slides: EmittedSlide[];
  /**
   * Every picture part the objects reference, with its media id, in first-use order; then each baked picture
   * (M6, `BAKE_PREFIX` ids): its source part and the recipe that derives it (`bake.ts`). An importer that
   * cannot bake one maps it to the source part's picture (drawn without its effects or tiles).
   */
  media: { id: string; part: string; bake?: PictureBake }[];
  /** The deck's area in 1920x1080 logical px (`source.native.slideRect`). */
  slideRect: { x: number; y: number; w: number; h: number };
  notes: string[];
  /**
   * The geometry files the slides name (M6 round 2, `ShapeGeom.ref`), each once in first-use order: its
   * placeholder (`pptxgeom:<n>`) and content. An importer stores each and puts its name in place of the
   * placeholder (the hub: the file's SHA-256); one that cannot leaves the shape drawing its legacy form.
   */
  geoms: { id: string; file: GeomFile }[];
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
  /** The placeholder id of a baked picture (M6); undefined: nothing is baked. */
  bake?: (part: string, bake: PictureBake) => string;
  log: (msg: string) => void;
  /** Metafile pictures set aside, with the index in the slide's objects where each would go. */
  metafiles?: { part: string; object: ImageObject; at: number }[];
  /** UTF-8 bytes of the slide's rich text objects so far (`MAX_SLIDE_BYTES`). */
  textBytes: number;
  clipId: (key: string) => string;
  transitionSounds: boolean;
  /** The slide's clips (`media.ts`). */
  clips?: EmittedClip[];
}

export function emitDeck(scene: DeckScene, opts: EmitOptions = {}): EmitResult {
  let n = 0;
  const newId = opts.newId ?? (() => `pptx-${++n}`);
  const media = new Map<string, string>();
  const mediaId = opts.mediaId ?? (() => `${MEDIA_PREFIX}${media.size + 1}`);
  const clips = new Map<string, string>();
  const clipId = (key: string) => {
    let id = clips.get(key);
    if (id === undefined) {
      id = opts.clipId ? opts.clipId(key) : `${CLIP_PREFIX}${clips.size + 1}`;
      clips.set(key, id);
    }
    return id;
  };
  const bakes = new Map<string, { id: string; part: string; bake: PictureBake }>();
  const bake = (part: string, recipe: PictureBake) => {
    const key = bakeKey(part, recipe);
    let b = bakes.get(key);
    if (!b) {
      b = {
        id: opts.bakeId ? opts.bakeId(part, recipe) : `${BAKE_PREFIX}${bakes.size + 1}`,
        part,
        bake: recipe,
      };
      bakes.set(key, b);
    }
    return b.id;
  };
  const files = new Map<string, { id: string; file: GeomFile }>();
  const geomRef =
    opts.geomFiles === false
      ? undefined
      : (json: string, file: GeomFile) => {
          let f = files.get(json);
          if (!f) {
            f = { id: opts.geomId ? opts.geomId(json) : `${GEOM_PREFIX}${files.size + 1}`, file };
            files.set(json, f);
          }
          return f.id;
        };
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
      bake,
      log,
      textBytes: 0,
      clipId,
      transitionSounds: opts.transitionSounds ?? false,
    };
    const spans: [number, number][] = [];
    ctx.metafiles = [];
    ctx.clips = [];
    const slide = emitSlide(ctx, s, spans);
    const overText = ctx.textBytes > MAX_SLIDE_BYTES;
    // The slide's whole JSON as the hub stores it, its large geometries in files (design/27 §3.4).
    const overBytes = !overText && fitBytes(slide, notes, geomRef) > MAX_SLIDE_BYTES;
    if (overBytes) log(SLIDE_BYTES_NOTE);
    const over = overText || overBytes;
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
      classification: over ? overBudget(s.classification, overText) : s.classification,
      digest: digestOf(slide.objects),
      notes,
      ms: performance.now() - t0,
      ...(art ? { art } : {}),
      ...(metafiles.length ? { metafiles } : {}),
      ...(over && s.classification.class !== 'picture' ? { overBudget: true as const } : {}),
      ...(ctx.clips.length ? { clips: ctx.clips } : {}),
    };
  });
  return {
    slides,
    media: [
      ...[...media].map(([part, id]) => ({ id, part })),
      ...[...bakes.values()].map((b) => ({ id: b.id, part: b.part, bake: b.bake })),
    ],
    slideRect: slideRect(scene.frame),
    notes: [...scene.notes],
    geoms: [...files.values()],
  };
}

// ── Geometry files and the slide's JSON budget (M6 round 2, design/27 §3.4) ───────────────────────────────

/** A geometry in a slide's objects: its owner's field (`ShapeObject.geom`, `ImageObject.mask`) and its JSON. */
type GeomSite = { o: SlideObject; key: 'geom' | 'mask'; g: ShapeGeom; json: string };

/**
 * What a slide's JSON is as the hub stores it (`planImportSizes`'s size): its objects with ids of a ULID's
 * length and geometry files named by SHA-256, an origin on every object, and its provenance (`Slide.pptx`
 * with up to 16 of `notes`). An estimate a few hundred bytes over the hub's own, never under it.
 */
export function storedSlideBytes(slide: Slide, notes: readonly string[]): number {
  let n = utf8Bytes(JSON.stringify(slide)) + PROVENANCE_BYTES;
  const id = (v: unknown) => (typeof v === 'string' ? Math.max(0, STORED_ID_CHARS - v.length) : 0);
  n += id(slide.id) + id(slide.lyricObjectId);
  for (const o of slide.objects) {
    n += id(o.id);
    if (!o.origin) n += 24; // ,"origin":{"src":"pptx"}
    const g = o.type === 'shape' ? o.geom : o.type === 'image' ? o.mask : undefined;
    if (typeof g?.ref === 'string') n += Math.max(0, STORED_REF_CHARS - g.ref.length);
  }
  if (notes.length)
    n +=
      10 + utf8Bytes(JSON.stringify(notes.slice(0, STORED_NOTES).map((t) => t.slice(0, STORED_NOTE_CHARS))));
  return n;
}

/**
 * Moves a slide's large geometries into geometry files (`ref`, through `geomRef`; none without it): first
 * every geometry whose paths take more than `GEOM_FILE_CHARS` of the slide (its JSON times the times the
 * slide draws it), then, while the slide as stored (`storedSlideBytes`) passes `MAX_SLIDE_BYTES` less
 * `SLIDE_BYTES_ROOM`, the largest of the others whose paths are longer than a ref. Returns the slide's
 * stored size after it.
 */
function fitBytes(
  slide: Slide,
  notes: readonly string[],
  geomRef: ((json: string, file: GeomFile) => string) | undefined,
): number {
  if (!geomRef) return storedSlideBytes(slide, notes);
  const sites: GeomSite[] = [];
  const times = new Map<string, number>();
  for (const o of slide.objects) {
    const key = o.type === 'shape' ? 'geom' : o.type === 'image' ? 'mask' : undefined;
    const g = key ? (o as { geom?: ShapeGeom; mask?: ShapeGeom })[key] : undefined;
    if (!key || !g?.paths?.length || g.ref !== undefined) continue;
    const json = JSON.stringify({ paths: g.paths });
    sites.push({ o, key, g, json });
    times.set(json, (times.get(json) ?? 0) + 1);
  }
  const toFile = (site: GeomSite) => {
    const { paths, ...rest } = site.g;
    const ref = geomRef(site.json, { paths: paths! });
    (site.o as { geom?: ShapeGeom; mask?: ShapeGeom })[site.key] = { ...rest, ref };
  };
  const rest: GeomSite[] = [];
  for (const site of sites)
    if (site.json.length * times.get(site.json)! > GEOM_FILE_CHARS) toFile(site);
    else rest.push(site);
  let bytes = storedSlideBytes(slide, notes);
  const target = MAX_SLIDE_BYTES - SLIDE_BYTES_ROOM;
  if (bytes <= target) return bytes;
  // `"ref":"<64>"` takes the place of `"paths":[…]` (the file's JSON less its braces): only longer paths
  // are worth a file. Counted as it goes, then measured once more.
  rest.sort((a, b) => b.json.length - a.json.length);
  let moved = false;
  for (const site of rest) {
    if (bytes <= target || site.json.length <= REF_JSON_BYTES + 16) break;
    toFile(site);
    bytes -= site.json.length - REF_JSON_BYTES;
    moved = true;
  }
  return moved ? storedSlideBytes(slide, notes) : bytes;
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
  // Runs of shapes of one look (`classify.ts` `shapeRuns`): one object, emitted at the run's first element.
  const runs = new Map<number, ShapeElement[]>();
  s.elements.forEach((e) => {
    if (e.kind !== 'shape' || e.merge === undefined || e.hidden) return;
    const run = runs.get(e.merge) ?? [];
    run.push(e);
    runs.set(e.merge, run);
  });
  s.elements.forEach((e, i) => {
    const at = objects.length;
    if (e.kind === 'shape' && e.merge !== undefined && !e.hidden) {
      const run = runs.get(i);
      if (e.merge === i && run) emitMerged(ctx, run, objects, texts);
    } else if (!e.hidden && !pastBudget(e)) emitElement(ctx, e, objects, texts);
    // M6: a SmartArt drawing's objects are a locked group with editable text (`smartart.ts`).
    if (e.diagram !== undefined) lockDiagram(e, objects, at);
    spans.push([at, objects.length]);
  });
  const media = emitMedia(ctx, s, slide, spans);
  ctx.clips?.push(...media.clips);
  if (media.remove.size) leaveOut(ctx, slide, spans, media.remove);
  if (objects.length > MAX_OBJECTS) {
    ctx.log(`more than ${MAX_OBJECTS} objects: the top ones are not drawn`);
    objects.length = MAX_OBJECTS;
  }
  fitEffects(ctx, objects);
  // A SmartArt node's text is a fragment of a diagram, never the lyric box.
  const lyric = lyricOf(texts.filter((t) => objects.includes(t.o) && t.e.diagram === undefined));
  if (lyric) slide.lyricObjectId = lyric.id;
  return slide;
}

/**
 * The slide's effect budget (renderer `geom/cost.ts` `EFFECT_COST`, design/27 §12 drawing cost): shapes keep
 * their shadow, glow and soft edge, bottom first, while the area of their layers stays within it; later ones
 * lose them, with a note, as the renderer would draw them (`geombudget.ts`). The corpus's most effected
 * slides use 7.7 of its 10 slide areas.
 */
function fitEffects(ctx: EmitCtx, objects: SlideObject[]): void {
  let area = 0;
  let dropped = 0;
  for (const o of objects) {
    if (o.type !== 'shape') continue;
    const a = effectArea(o);
    if (!a) continue;
    if (area + a <= EFFECT_COST.slide * 0.98) {
      area += a;
      continue;
    }
    delete o.shadow;
    delete o.glow;
    delete o.softEdge;
    dropped++;
  }
  if (dropped) ctx.log(`the effects of ${dropped} shape(s) past the slide's effect budget are not drawn`);
}

/**
 * An element the object budget sent to the art (`classify.ts` `fitShapes`, 'budget:shapes'): like a residual
 * table it emits nothing, so version 1 stays within the budget (and the render clamp's 200 objects) with the
 * slide's own text drawn, until the art replaces what it draws.
 */
function pastBudget(e: Element): boolean {
  return e.support === 'residual' && e.reasons?.includes('budget:shapes') === true;
}

/**
 * Leave the objects at `remove` out of the slide, keeping `spans` and the metafiles' places pointing at the
 * same objects (an element whose objects all went keeps an empty span where they were).
 */
function leaveOut(ctx: EmitCtx, slide: Slide, spans: [number, number][], remove: Set<number>): void {
  const before: number[] = []; // before[k]: objects kept below index k
  let kept = 0;
  for (let k = 0; k <= slide.objects.length; k++) {
    before.push(kept);
    if (k < slide.objects.length && !remove.has(k)) kept++;
  }
  const at = (k: number) => before[Math.min(k, before.length - 1)]!;
  // In place: the slide's object array is the emitter's.
  let n = 0;
  for (let k = 0; k < slide.objects.length; k++) if (!remove.has(k)) slide.objects[n++] = slide.objects[k]!;
  slide.objects.length = n;
  for (const span of spans) {
    span[0] = at(span[0]);
    span[1] = at(span[1]);
  }
  for (const m of ctx.metafiles ?? []) m.at = at(m.at);
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

/** A slide over `MAX_SLIDE_BYTES` (its text formatting, else its JSON as stored): picture class (design/27 §3.4), with why. */
function overBudget(c: Classification, text = true): Classification {
  const reason = text
    ? `more than ${MAX_SLIDE_BYTES / 1024} KB of text formatting`
    : `more than ${MAX_SLIDE_BYTES / 1024} KB as stored`;
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
    if (p.tile && !(p.px && ctx.bake)) ctx.log('a tiled background of unknown size is drawn stretched');
    if (p.effects?.some((name) => !BAKED_EFFECTS.has(name)))
      ctx.log('a background picture is drawn without some of its effects');
    // PowerPoint and LibreOffice lay the background on white: a translucent picture, its transparent pixels
    // and the parts of the slide it leaves uncovered show white, not the frame's black.
    slide.objects.push(shape(ctx, rect, 'rect', WHITE));
    const unit: Affine = [ctx.frame.cx, 0, 0, ctx.frame.cy, 0, 0];
    const img = pictureObject(ctx, unit, p);
    if (img) slide.objects.push(img);
    return;
  }
  if (fill.kind === 'pattern') ctx.log('a pattern background is drawn as its blended colour');
  const color = legacyColor(fill);
  const bg = shape(ctx, area, 'rect', color ? overWhite(color) : WHITE);
  // M6: a gradient over the background area, each stop laid on white (the first stop is the legacy colour).
  const gradient = gradientOf(fill, 0, ctx.log, overWhite);
  const framed = area.w !== rect.w || area.h !== rect.h || area.x !== rect.x || area.y !== rect.y;
  if (gradient && framed && gradient.kind === 'radial') {
    // Extended past a slide of another aspect: the slide's own gradient over the slide (a radial one is an
    // ellipse of the slide's aspect, which the frame's could not be), the frame around it in the colour the
    // gradient ends in (where the slide's gradient would carry on).
    const outer = gradient.stops.reduce((a, b) => (b.at >= a.at ? b : a)).color;
    bg.fill = outer;
    slide.objects.push(bg);
    const inner = shape(ctx, rect, 'rect', color ? overWhite(color) : WHITE);
    inner.gradient = gradient;
    slide.objects.push(inner);
    return;
  }
  if (gradient) bg.gradient = framed ? linearOverFrame(gradient, rect, area) : gradient;
  slide.objects.push(bg);
}

/**
 * A linear gradient laid over the slide area `rect` (as the slide defines it), expressed over the larger
 * `area` it is drawn on (the 16:9 frame of a slide of another aspect, `extendBackgrounds`): the same direction
 * in px (a `scaled` angle taken at the slide's aspect), the stops moved to where they fall on the frame's
 * gradient line, so that inside the slide it is the slide's gradient and the frame around it carries its end
 * colours on (the drawer pads past the stops).
 */
export function linearOverFrame(
  g: OrdoGradient,
  rect: { x: number; y: number; w: number; h: number },
  area: { x: number; y: number; w: number; h: number },
): OrdoGradient {
  const th = ((g.angle ?? 0) * Math.PI) / 180;
  let nx = g.scaled ? rect.h * Math.cos(th) : Math.cos(th);
  let ny = g.scaled ? rect.w * Math.sin(th) : Math.sin(th);
  const len = Math.hypot(nx, ny) || 1;
  nx /= len;
  ny /= len;
  const line = (b: { x: number; y: number; w: number; h: number }) => {
    const half = (Math.abs(b.w * nx) + Math.abs(b.h * ny)) / 2 || 0.5;
    const centre = (b.x + b.w / 2) * nx + (b.y + b.h / 2) * ny;
    return { from: centre - half, len: 2 * half };
  };
  const s = line(rect);
  const f = line(area);
  const at = (v: number) => Math.min(1, Math.max(0, (s.from + v * s.len - f.from) / f.len));
  const angle = ((((Math.atan2(ny, nx) * 180) / Math.PI) % 360) + 360) % 360;
  const { scaled: _scaled, ...rest } = g;
  return {
    ...rest,
    angle: Math.round(angle * 1e6) / 1e6,
    stops: g.stops.map((st) => ({ ...st, at: Math.round(at(st.at) * 1e6) / 1e6 })),
  };
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
        { ...ctx, media: new Map(), mediaId: () => METAFILE_MEDIA, bake: undefined },
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
  if (e.kind === 'table') {
    emitTableOf(ctx, e, out);
    return;
  }
  emitShape(ctx, e, out, texts);
}

/**
 * A table (`tables.ts`): its cells' text is rich text in the slide's budget like any other (written plain
 * past it), drawn with the harness's LibreOffice policies when asked; the legacy text emission has no
 * table of its own and writes the same cells.
 */
function emitTableOf(ctx: EmitCtx, e: TableElement, out: SlideObject[]): void {
  const texts = emitTable(
    {
      frame: ctx.frame,
      newId: ctx.newId,
      log: ctx.log,
      color: legacyColor,
      ...(ctx.lo ? { lo: true } : {}),
      cellText: (body) =>
        richText(body, {
          frame: ctx.frame,
          log: ctx.log,
          ...(ctx.lo ? { lo: true } : {}),
          ...(ctx.textBytes > MAX_SLIDE_BYTES ? { plain: true } : {}),
        }),
    },
    e,
    out,
  );
  for (const o of texts) {
    if (ctx.textBytes > MAX_SLIDE_BYTES) break;
    ctx.textBytes += utf8Bytes(JSON.stringify(o));
    if (ctx.textBytes > MAX_SLIDE_BYTES) ctx.log(SLIDE_BUDGET_NOTE);
  }
}

function emitPicture(ctx: EmitCtx, e: PictureElement, out: SlideObject[]): void {
  if (e.reasons?.some((r) => r.startsWith('mask:')))
    ctx.log(`a picture clipped to ${e.geom} is drawn as a rect`);
  if (e.picture.effects?.some((name) => !BAKED_EFFECTS.has(name)))
    ctx.log('a picture is drawn without some of its effects');
  const img = pictureObject(ctx, e.xf, e.picture, e.geom, e.adj, e.custom);
  if (img) out.push(img);
  const stroke = e.line ? legacyColor(e.line.fill) : undefined;
  if (e.line && stroke) {
    // The outline: a stroke-only shape above the picture, along the same geometry (M6).
    const box = boxOf(ctx, e.xf);
    const kind = e.geom === 'ellipse' ? 'ellipse' : 'rect';
    const o = shape(ctx, box, kind, undefined);
    o.stroke = { width: strokeWidth(ctx, e.line.width), color: stroke };
    if (e.geom === 'roundRect') o.radius = cornerRadius(box, e.adj);
    const geom = geomOf(e);
    if (geom) o.geom = geom;
    if (geom && decompose(e.xf).flipH) o.flipH = true;
    const dash = dashOf(e.line, ctx.log);
    if (dash) o.dash = dash;
    joinsOf(o, e.line);
    out.push(o);
  }
}

/** Geometries the rectangle's mirrors and half turns leave as they are (at any adjust values). */
const SYMMETRIC: ReadonlySet<string> = new Set(['rect', 'roundRect', 'ellipse']);

function isIdentity(t: Affine): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  return near(t[0], 1) && near(t[1], 0) && near(t[2], 0) && near(t[3], 1) && near(t[4], 0) && near(t[5], 0);
}

/**
 * The `ShapeGeom` of an element's geometry (M6): a custom geometry's paths, else the preset with its adjust
 * values. None for a rect, an ellipse (today's fields draw them exactly), a preset the table does not know
 * (drawn as its rect) or a custom geometry past the bounds.
 */
function geomOf(e: { geom: string; adj?: [string, number][]; custom?: CustomPaths }): ShapeGeom | undefined {
  if (e.custom) return e.custom.over ? undefined : { paths: e.custom.paths.map((p) => ({ ...p })) };
  if (e.geom === 'rect' || e.geom === 'ellipse' || e.geom === 'custom' || !knownPreset(e.geom))
    return undefined;
  const adj = adjPairs(e.adj);
  return { preset: e.geom, ...(adj ? { adj } : {}) };
}

/** A shadow in logical px (`Shadow`: offset from distance and direction, blur radius). */
function shadowPx(ctx: EmitCtx, shadow: Shadow): NonNullable<ShapeObject['shadow']> {
  const dir = (shadow.dir * Math.PI) / 180;
  const dist = lenPx(ctx.frame, shadow.dist);
  return {
    dx: bound(dist * Math.cos(dir), -500, 500),
    dy: bound(dist * Math.sin(dir), -500, 500),
    blur: bound(lenPx(ctx.frame, shadow.blur), 0, 500),
    color: ordo(shadow.color),
  };
}

/**
 * A line's joins and caps (`a:round`/`a:bevel`/`a:miter`, `cap`) on a stroked shape object, when they are
 * not the defaults (miter, flat), as LibreOffice draws them (M6 repair).
 */
function joinsOf(o: ShapeObject, line: Line): void {
  if (line.join === 'round' || line.join === 'bevel') o.lineJoin = line.join;
  if (line.cap === 'round' || line.cap === 'square') o.lineCap = line.cap;
}

/**
 * The M6 fields of a shape object (design/27 §3.1): its geometry, gradient, dash, arrowheads, flips and
 * effects. The legacy fields beside them stay what an older build draws.
 */
function styleShape(ctx: EmitCtx, o: ShapeObject, e: ShapeElement, geom: ShapeGeom | undefined): void {
  if (geom) o.geom = geom;
  const mirrored = decompose(e.xf).flipH;
  const gradient = gradientOf(e.fill, o.box.rotation, ctx.log, undefined, mirrored, {
    h: e.ownFlipH,
    v: e.ownFlipV,
  });
  if (gradient && o.fill) o.gradient = gradient;
  if ((o.geom || o.gradient) && mirrored) o.flipH = true;
  if (o.stroke && e.line) {
    const dash = dashOf(e.line, ctx.log);
    if (dash) o.dash = dash;
    joinsOf(o, e.line);
    const ends = endsOf(e.line);
    if (ends) o.ends = ends;
  }
  if (e.shadow) o.shadow = shadowPx(ctx, e.shadow);
  if (e.glow) o.glow = { radius: bound(lenPx(ctx.frame, e.glow.radius), 0, 500), color: ordo(e.glow.color) };
  if (e.softEdge) o.softEdge = bound(lenPx(ctx.frame, e.softEdge), 0, 500);
}

/** Straight lines: one `line` object from the start (0, 0) of the unit square to its end (1, 1). */
const STRAIGHT: ReadonlySet<string> = new Set(['line', 'straightConnector1']);
/** Connector presets drawn as their route (`routeObject`). */
const isRoute = (geom: string) => /^(bent|curved)Connector[2-5]$/.test(geom);

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
    // A shape's picture fill is never mirrored, and is drawn square to the nearest quarter turn of the shape
    // (`geom.ts` `pictureFillPlacement`, LibreOffice's drawing, verified with probe decks); the picture is
    // clipped to the shape's geometry as it lies in that box.
    const fit = pictureFillPlacement(e.xf);
    const shape = boxOf(ctx, e.xf);
    const img = pictureObject(ctx, fit.xf, e.fill.picture, e.geom, e.adj, e.custom, {
      t: fit.t,
      w: shape.w,
      h: shape.h,
    });
    if (img) out.push(img);
  }
  const fill = e.fill.kind === 'picture' ? undefined : legacyColor(e.fill);
  const stroke = e.line ? legacyColor(e.line.fill) : undefined;
  // PowerPoint casts a shape's shadow on its text only when the shape itself shows nothing.
  const visible = e.fill.kind === 'picture' || fill !== undefined || stroke !== undefined;
  const geom = geomOf(e);
  const thin = e.geom === 'custom' && e.coverage !== undefined && e.coverage < MIN_RECT_COVERAGE;
  if (STRAIGHT.has(e.geom) || isRoute(e.geom)) {
    if (stroke && e.line) {
      const width = strokeWidth(ctx, e.line.width);
      const o = isRoute(e.geom)
        ? routeObject(ctx, e, width, stroke)
        : lineObject(ctx, e.xf, [0, 0], [1, 1], width, stroke);
      if (o) {
        const dash = dashOf(e.line, ctx.log);
        if (dash) o.dash = dash;
        joinsOf(o, e.line);
        const ends = endsOf(e.line);
        if (ends) o.ends = ends;
        if (e.shadow) o.shadow = shadowPx(ctx, e.shadow);
        if (e.glow)
          o.glow = { radius: bound(lenPx(ctx.frame, e.glow.radius), 0, 500), color: ordo(e.glow.color) };
        out.push(o);
      }
    }
  } else if (e.geom === 'custom' && !geom && thin) {
    if (fill || stroke) ctx.log('custom geometry that fills little of its box is not drawn');
  } else if (fill || stroke) {
    // A thin custom geometry's legacy is a line (its midline outline at most): a rect over a swoosh is
    // further from it than nothing.
    const kind = geom && thin ? 'line' : ELLIPTIC.has(e.geom) ? 'ellipse' : 'rect';
    const o = shape(ctx, box, kind, fill);
    if (stroke && e.line) o.stroke = { width: strokeWidth(ctx, e.line.width), color: stroke };
    if (ROUNDED.has(e.geom)) o.radius = cornerRadius(box, e.adj);
    else if (e.geom === 'flowChartTerminator') o.radius = Math.min(box.w, box.h) / 2;
    styleShape(ctx, o, e, geom);
    const approx = (e.reasons ?? []).filter(
      (r) => r !== 'vert' && r !== 'warp' && r !== 'numCol' && r !== 'pattFill' && r !== 'shear',
    );
    if (approx.length) ctx.log(`${approx.join(', ')} drawn as ${kind}`);
    if (e.fill.kind === 'pattern') ctx.log('a pattern fill is drawn as its blended colour');
    out.push(o);
  }
  if (e.text) {
    const t = textObject(ctx, e, visible);
    if (t) {
      out.push(t);
      texts.push({ o: t, e, area: box.w * box.h });
    }
  }
}

/**
 * A run of z-adjacent shapes of one look as one object (M6, `classify.ts` `shapeRuns`, only on a slide over
 * the object budget): each shape's paths in z-order, its rotation and flips in their points, in the union of
 * their boxes (unrotated), with their common fill and line. Drawn path by path as the shapes are, it looks as
 * they do. Its legacy shape is a line, as a thin custom geometry's is: an older build draws no filled union
 * rectangle, only the line's midline when the shapes have an outline. A run whose geometry cannot be read
 * again is emitted shape by shape.
 */
function emitMerged(ctx: EmitCtx, run: ShapeElement[], out: SlideObject[], texts: Emitted[]): void {
  const f = ctx.frame;
  const list: { xf: Affine; piece: ShapePiece }[] = [];
  let box: RectEmu | undefined;
  for (const e of run) {
    const piece = shapePiece(e, f.s);
    if (!piece) {
      for (const each of run) emitShape(ctx, each, out, texts);
      return;
    }
    list.push({ xf: e.xf, piece });
    box = box ? unionBox(box, boundsOf(e)) : boundsOf(e);
  }
  const first = run[0];
  if (!first || !box) return;
  const o = shape(
    ctx,
    { x: f.x0 + box.x * f.s, y: f.y0 + box.y * f.s, w: box.cx * f.s, h: box.cy * f.s, rotation: 0 },
    'line',
    legacyColor(first.fill),
  );
  const stroke = first.line ? legacyColor(first.line.fill) : undefined;
  if (first.line && stroke) {
    o.stroke = { width: strokeWidth(ctx, first.line.width), color: stroke };
    const dash = dashOf(first.line, ctx.log);
    if (dash) o.dash = dash;
    joinsOf(o, first.line);
  }
  o.geom = { paths: mergedPaths(list, box, f.s) };
  out.push(o);
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

/**
 * A bent or curved connector as one object (M6): its preset's route (through the connector's affine, its
 * ends glued to shapes already placed by the walk) as a path in a box whose midline runs from the route's
 * start to its end, so an older build, which draws `line` along the midline, draws the straight line between
 * the two ends.
 */
function routeObject(ctx: EmitCtx, e: ShapeElement, width: number, color: OrdoRgba): ShapeObject | undefined {
  const route = presetRoute(e.geom, e.adj, e.xf);
  if (!route?.length) return undefined;
  const f = ctx.frame;
  const pts = route.map((r) => r.pts.map((v, i) => (i % 2 === 0 ? f.x0 : f.y0) + v * f.s));
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (first.length < 2 || last.length < 2) return undefined;
  const p0: [number, number] = [first[0]!, first[1]!];
  const p1: [number, number] = [last[last.length - 2]!, last[last.length - 1]!];
  const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const u: [number, number] = chord > 1e-9 ? [(p1[0] - p0[0]) / chord, (p1[1] - p0[1]) / chord] : [1, 0];
  const v: [number, number] = [-u[1], u[0]];
  let reach = 0;
  for (const list of pts)
    for (let i = 0; i < list.length; i += 2) {
      const b = (list[i]! - p0[0]) * v[0] + (list[i + 1]! - p0[1]) * v[1];
      reach = Math.max(reach, Math.abs(b));
    }
  const len = Math.max(chord, 1);
  const H = Math.max(2 * reach, 1);
  const n = (x: number) => fmtPx(x);
  const parts: string[] = [];
  route.forEach((r, k) => {
    const list = pts[k]!;
    let at = 0;
    for (const op of r.cmds) {
      const pairs = op === CMD_QUAD ? 2 : op === CMD_CUBIC ? 3 : op === CMD_CLOSE ? 0 : 1;
      let s =
        op === CMD_MOVE ? 'M' : op === CMD_LINE ? 'L' : op === CMD_QUAD ? 'Q' : op === CMD_CUBIC ? 'C' : 'Z';
      for (let j = 0; j < pairs; j++, at += 2) {
        const dx = list[at]! - p0[0];
        const dy = list[at + 1]! - p0[1];
        s += ` ${n(dx * u[0] + dy * u[1])} ${n(dx * v[0] + dy * v[1] + H / 2)}`;
      }
      parts.push(s);
    }
  });
  const rot = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  const cx = p0[0] + (u[0] * chord) / 2;
  const cy = p0[1] + (u[1] * chord) / 2;
  const o = shape(
    ctx,
    clampBox({ x: cx - len / 2, y: cy - H / 2, w: len, h: H, rotation: Math.abs(rot) < 1e-9 ? 0 : rot }),
    'line',
    undefined,
  );
  o.stroke = { width, color };
  o.geom = { paths: [{ d: parts.join(' '), w: len, h: H, fill: 'none' }] };
  return o;
}

/** A logical px coordinate with two decimals, never `-0`. */
function fmtPx(v: number): string {
  const r = Number(v.toFixed(2)) + 0;
  return Object.is(r, -0) ? '0' : String(r);
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
  custom?: CustomPaths,
  maskIn?: { t: Affine; w: number; h: number },
): CroppedImage | undefined {
  // M6: a tiled fill becomes one picture of the whole box, the tiles baked into it (`bake.ts`): its stretch
  // rectangle does not apply and its crop is the tile's. Without the picture's size it is drawn stretched.
  const bake = pictureBake(ctx, xf, p);
  if (p.tile) p = { ...p, crop: undefined, fillRect: undefined };
  const placed = placePicture(ctx.crop ? p : { ...p, crop: undefined });
  if (!placed) return undefined;
  const [x0, y0, x1, y1] = placed.rect;
  const m = multiply(xf, [x1 - x0, 0, 0, y1 - y0, x0, y0]);
  let box = boxPx(ctx.frame, m);
  const flipH = decompose(m).flipH;
  let crop = ctx.crop ? placed.crop : undefined;
  if (outsideClamp(box)) {
    // The cut is folded into the crop on the box's sides: only while the picture is drawn unmirrored.
    if (box.rotation === 0 && geom === 'rect' && ctx.crop && !flipH) {
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
    mediaId: bake && ctx.bake ? ctx.bake(p.part, bake) : mediaOf(ctx, p.part),
    fit: 'stretch',
    opacity: bound(p.alpha ?? 1, 0, 1),
    radius: 0,
  };
  if (geom === 'roundRect') o.radius = cornerRadius(box, adj);
  else if (geom === 'ellipse') o.radius = bound(Math.min(box.w, box.h) / 2, 0, MAX_COORD);
  // M6: mirrored in its box, and clipped to its geometry (an older build draws `radius`).
  if (flipH) o.flipH = true;
  let mask: ShapeGeom | undefined =
    geom === 'ellipse' ? { preset: 'ellipse' } : geomOf({ geom, adj, custom });
  if (mask && maskIn && !SYMMETRIC.has(geom) && !isIdentity(maskIn.t)) {
    const paths = transformedPaths(mask, maskIn.w, maskIn.h, maskIn.t, box.w, box.h);
    mask = paths ? { paths } : undefined;
  }
  if (mask) {
    o.mask = mask;
    if (x0 !== 0 || y0 !== 0 || x1 !== 1 || y1 !== 1)
      ctx.log('a clipped picture with a fill rectangle is clipped in its own box');
  }
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

/**
 * The bake of a picture used in the unit square of `xf` (M6, `bake.ts`): its colour effects, and its tile grid
 * when it is a tiled fill whose size is known (over the whole box). None for a metafile (LibreOffice converts
 * it as the deck draws it) or when the emitter keeps no bakes.
 */
function pictureBake(ctx: EmitCtx, xf: Affine, p: PictureFill): PictureBake | undefined {
  if (!ctx.bake || METAFILE_EXTENSIONS.has(extensionOf(p.part))) return undefined;
  const d = decompose(xf);
  return bakeOf(p, { w: d.w, h: d.h });
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

function textObject(ctx: EmitCtx, e: ShapeElement, shapeVisible: boolean): TextObject | undefined {
  if (ctx.rich) return richTextObject(ctx, e, shapeVisible);
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
  let box = textBox(ctx, e);
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
function richTextObject(ctx: EmitCtx, e: ShapeElement, shapeVisible: boolean): TextObject | undefined {
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
  let box = textBox(ctx, e);
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

/**
 * The shape's text rectangle as a box (M6): its geometry's `a:rect` (every preset of POI's table, a custom
 * geometry's own) placed through the shape's affine, so a flipped shape's rectangle is mirrored with it
 * (and its text turned half a turn by a vertical flip, as PowerPoint draws it); the whole box for a rect or
 * a preset the table does not know.
 */
function textBox(ctx: EmitCtx, e: ShapeElement): Box {
  const [l, t, r, b] = textRectOf(e);
  if (l === 0 && t === 0 && r === 1 && b === 1) return boxOf(ctx, e.xf);
  return boxOf(ctx, multiply(e.xf, [Math.max(0, r - l), 0, 0, Math.max(0, b - t), l, t]));
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
