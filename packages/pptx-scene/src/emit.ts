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
 *   still past it (its text formatting, or its objects with every path in files) keeps its class and is
 *   flagged `overBudget` for the importer's budget ladder (M9; it was picture class before).
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
 *   sent to the art ('budget:shapes') emits nothing, as a residual table; so does a shape without text the
 *   drawing budget sent there ('custGeom:complex', 'geom:complex', `walk.ts`).
 * - **Lyric box** (design/27 §4 "Church mappings"): the slide's own body placeholder with the most
 *   characters; else the largest other text by characters × area (not title, date, footer, slide number);
 *   the title only when it is the only text. On a bilingual slide (the two boxes with the most text in
 *   different languages, of comparable length) the first of them in reading order.
 * - **Origin** (`ObjectOrigin`, design/27 §3.1; since the M4 scaffold): every object carries the shape it came
 *   from, its placeholder, its role and its group (`originOf`), so the editor selects a flattened group or a
 *   shape with its text together, restyles similar boxes, and a re-import tells imported objects from the
 *   operator's own. The M1 emission (`richText: false`) writes none.
 * - **M9 seams** (design/27 §15 M9, `conv-seams`). The emitter is split so that each M9 area owns its part:
 *   `emit-ctx.ts` (the context, the M9 field gate and the box and colour helpers), `emit-text.ts` (text
 *   bodies; `text-conv`), `emit-budget.ts` (the slide's JSON budget; `ladder`), `emit-table.ts` (tables;
 *   `tables-conv`), and this module (the slide, backgrounds, shapes, pictures, origin, lyric box). Each new
 *   stored field is written by a dispatch stub its area fills: `emitTableObject` (`emit-table.ts`),
 *   `emitChart` (`chart.ts`), `emitDecor` (`decor.ts`), `look3dOf` (`three3d.ts`), `warpOf` and `writingOf`
 *   (`emit-text.ts`), each only for a field `EmitOptions.m9Writes` names (`M9_FIELDS`; default all), each
 *   writing nothing yet. `EmitOptions.libreoffice: false` (a hub without LibreOffice) plans no art and no
 *   metafile conversion on any slide: what they would draw is listed in `EmittedSlide.missing`, and the
 *   notes say 'not drawn' where they would name LibreOffice (`hybrid.ts`).
 *
 * Owned by work item C (inherit-emit).
 */
import type {
  DecorFile,
  GeomFile,
  Gradient as OrdoGradient,
  ImageObject,
  ObjectOrigin,
  Rgba as OrdoRgba,
  ShapeGeom,
  ShapeObject,
  Slide,
  SlideObject,
  TextObject,
} from '@ordo/domain';
import { drawnBounds } from '@ordo/renderer/geom/bounds.ts';
import { geometryAt, legacyGeometry } from '@ordo/renderer/geom/built.ts';
import {
  EFFECT_COST,
  effectArea,
  type LegacyPart,
  objectCost,
  type Rated,
  slidePlan,
  withoutPart,
} from '@ordo/renderer/geom/cost.ts';
import { CMD_CLOSE, CMD_CUBIC, CMD_LINE, CMD_MOVE, CMD_QUAD } from '@ordo/renderer/geom/ops.ts';
import { outlineOf } from '@ordo/renderer/geom/outline.ts';
import { apply, boxPx, decompose, lenPx, multiply, slideRect } from './frame.ts';
import { bakeKey, bakeOf, type PictureBake, type SheetBake, sheetKey } from './bake.ts';
import { emitChart } from './chart.ts';
import { boundsOf, unionBox } from './classify.ts';
import { DECOR_PREFIX, decorFiles, emitDecor, type PlatePlan, platePlan } from './decor.ts';
import { slideBudget } from './emit-budget.ts';
import {
  ALL_M9_FIELDS,
  BOX_FACTOR,
  type Box,
  bound,
  boxOf,
  CANVAS_H,
  CANVAS_W,
  clampBox,
  type EmitCtx,
  legacyColor,
  type M9Field,
  MAX_COORD,
  ordo,
  shape,
  visibleChars,
} from './emit-ctx.ts';
import { emitTableOf } from './emit-table.ts';
import { textObject } from './emit-text.ts';
import {
  adjPairs,
  dashOf,
  endsOf,
  gradientOf,
  knownPreset,
  lineWidthPx,
  mergedPaths,
  pictureFillPlacement,
  presetRoute,
  type ShapePiece,
  shapePiece,
  transformedPaths,
} from './geom.ts';
import { artInfo, noteWithoutLibreOffice, withoutLibreOffice } from './hybrid.ts';
import { isFooter, isTitle, masterClass } from './inherit.ts';
import { type EmittedClip, emitMedia } from './media.ts';
import type {
  Affine,
  ArtInfo,
  Classification,
  CustomPaths,
  DeckScene,
  Element,
  Insets,
  Line,
  PictureElement,
  PictureFill,
  RectEmu,
  Shadow,
  ShapeElement,
  SlideScene,
} from './ir.ts';
import { type Log, noteList } from './log.ts';
import { scriptClasses } from './fontmap.ts';
import { BAKED_EFFECTS, extensionOf, METAFILE_EXTENSIONS } from './picture.ts';
import { atlasSlide, emitComposite, type EmittedSheet, SHEET_PREFIX } from './sheet.ts';
import { lockDiagram } from './smartart.ts';
import { look3dOf } from './three3d.ts';

// The parts split out of this module in M9 (`conv-seams`), under the names they always had here.
export {
  compactRuns,
  GEOM_FILE_CHARS,
  MAX_SLIDE_BYTES,
  SLIDE_BUDGET_NOTE,
  SLIDE_BYTES_NOTE,
  storedSlideBytes,
  TEXT_BUDGET_BYTES,
} from './emit-budget.ts';
export { ALL_M9_FIELDS, insetBox, legacyColor, M9_FIELDS, type M9Field } from './emit-ctx.ts';
export {
  dominant,
  legacyText,
  MAX_FONT_PX,
  MAX_TEXT,
  marginOf,
  MIN_FONT_PX,
  SINGLE_LINE,
} from './emit-text.ts';

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
/** Objects one ordo slide holds (`Slide.objects` in `@ordo/domain`). */
export const MAX_OBJECTS = 1_000;
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
  /**
   * M9 (`decor-conv`): the placeholder of a decoration file (`DecorData.ref`) by its JSON (`DecorFile`);
   * default `pptxdecor:<n>`, numbered from 1 in first-use order. Asked once per distinct file. With
   * `geomFiles: false`, or without 'decorFile' in `m9Writes`, decorations keep their parts in the slide.
   */
  decorId?: (json: string) => string;
  /**
   * M9 (`decor-conv`, `sheet.ts`): the placeholder media id of a sheet (a composite or an atlas) by its recipe;
   * default `pptxmedia:sheet<n>`, numbered from 1 in first-use order. Asked once per distinct recipe.
   */
  sheetId?: (bake: SheetBake) => string;
  /**
   * M9 (`decor-conv`): draw pictures from sheets where the slide budgets plan them (composites and atlases,
   * `EmitResult.sheets`; default true). With false every picture is its own object, as an importer that
   * cannot make sheets needs (the slide may then hold more than 150 objects and 12 pictures, within the
   * render clamp's 200 and 16 as planned by the budgets' guard).
   */
  sheets?: boolean;
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
  /**
   * M9: whether LibreOffice can draw what ordo does not (default true: the art of a hybrid slide and the
   * metafile pictures are planned for the follow-up, `EmittedSlide.art` and `.metafiles`). With false (a hub
   * without LibreOffice, design/27 §15 M9) neither is planned on any slide, a picture-class one's included:
   * the slide keeps what version 1 draws, what the art or the conversion would have drawn is listed in
   * `EmittedSlide.missing`, and the notes never name LibreOffice (`hybrid.ts` `withoutLibreOffice`,
   * `noteWithoutLibreOffice`).
   */
  libreoffice?: boolean;
  /**
   * M9: the stored fields the converter may write (`M9_FIELDS`; default every one, the hub's `M9_WRITES`), a
   * kill switch per field: without one, the converter writes what an older build draws for it (§3.2).
   */
  m9Writes?: ReadonlySet<M9Field>;
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
  /** Hybrid slides: what the art holds, for the LibreOffice follow-up (M3 item D). Never without LibreOffice. */
  art?: ArtInfo;
  /**
   * Metafile pictures, left out of `slide` until LibreOffice converts them (M3 item D): each as the image
   * object it becomes (`mediaId` `METAFILE_MEDIA`, replaced by the converted picture's) and the object it
   * goes just under (absent: on top). The shape of the hub's `PptxLoSlide.metafileObjects`. Never without
   * LibreOffice.
   */
  metafiles?: { part: string; object: ImageObject; before?: string }[];
  /**
   * Over the slide budget (design/27 §3.4): its text formatting passed `TEXT_BUDGET_BYTES` (its further text
   * written plain), or the slide as the hub stores it is over `MAX_SLIDE_BYTES` with its large geometries in
   * files (`storedSlideBytes`). Its class is not changed (M9: no budget makes a picture); an importer fits it
   * with its own budget ladder (`@ordo/domain` `fitSlideBudget`), logs that itself and drops
   * `SLIDE_BUDGET_NOTE` and `SLIDE_BYTES_NOTE`.
   */
  overBudget?: true;
  /** The clips the slide plays or names (`media.ts`): what the hub ingests and puts in place of placeholders. */
  clips?: EmittedClip[];
  /**
   * M9, `EmitOptions.libreoffice: false` only: what nothing draws on this slide (`Slide.pptx.missing`
   * entries: '<kind>' of `@ordo/domain` `MISSING_KINDS`), the art and the metafiles left unplanned. The
   * slide is then class hybrid with a `missing:<kind>` reason per kind (`hybrid.ts`).
   */
  missing?: string[];
  /** M9, `EmitOptions.libreoffice: false` only: the text of what the art would have drawn (`Slide.pptx.artText`). */
  artText?: string;
  /**
   * M9 (`decor-conv`, `sheet.ts`): the sheets the slide draws pictures from (`pptxmedia:sheet<n>`), each with
   * the objects drawn from it and those objects as they are without it, which an importer that cannot make
   * the sheet puts back (`EmitResult.sheets` has each recipe once).
   */
  sheets?: EmittedSheet[];
  /**
   * M9 (`decor-conv`, decisions.md "Slow-to-draw elements"): what the client bakes into the slide's
   * decoration plates (`decor.ts` `platePlan`: the static decoration stack and the objects above it with
   * effect layers), and `pastBudget`, the objects the slide's drawing budgets draw live past them (as their
   * legacy shapes or without their effects, `geom/cost.ts` `slidePlan`) until a plate holds them. Kept whole:
   * the converter never flattens, drops or leaves to LibreOffice what is only slow to draw.
   */
  plate?: PlatePlan & { pastBudget: string[] };
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
  /**
   * M9 (`decor-conv`): the decoration files the slides name (`DecorData.ref`, `pptxdecor:<n>`), each once in
   * first-use order. An importer stores each as it stores geometry files (`decor-render`) and puts its name in
   * place of the placeholder; one that cannot leaves the decoration drawing nothing.
   */
  decors: { id: string; file: DecorFile }[];
  /**
   * M9 (`decor-conv`, `sheet.ts`): the sheets the slides draw pictures from, each recipe once in first-use
   * order with its placeholder media id (`pptxmedia:sheet<n>`): pictures made of the cells' parts
   * (`bake.ts` `applySheet`). An importer that cannot make one puts back the objects
   * `EmittedSlide.sheets` lists for it.
   */
  sheets: { id: string; bake: SheetBake }[];
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
  const decorFileList = new Map<string, { id: string; file: DecorFile }>();
  // M9: decoration files only where the importer stores them (the 'decorFile' field): a placeholder no one
  // names would be stored as it is, and the decoration would draw nothing.
  const decorRef =
    opts.geomFiles === false || !(opts.m9Writes ?? ALL_M9_FIELDS).has('decorFile')
      ? undefined
      : (json: string, file: DecorFile) => {
          let f = decorFileList.get(json);
          if (!f) {
            f = { id: opts.decorId ? opts.decorId(json) : `${DECOR_PREFIX}${decorFileList.size + 1}`, file };
            decorFileList.set(json, f);
          }
          return f.id;
        };
  const sheets = new Map<string, { id: string; bake: SheetBake }>();
  const sheet = (recipe: SheetBake) => {
    const key = sheetKey(recipe);
    let b = sheets.get(key);
    if (!b) {
      b = { id: opts.sheetId ? opts.sheetId(recipe) : `${SHEET_PREFIX}${sheets.size + 1}`, bake: recipe };
      sheets.set(key, b);
    }
    return b.id;
  };
  // What a placeholder media id stands for (the sheets' cells name parts and recipes).
  const mediaPart = (id: string): { part: string; bake?: PictureBake } | undefined => {
    for (const b of bakes.values()) if (b.id === id) return { part: b.part, bake: b.bake };
    for (const [part, m] of media) if (m === id) return { part };
    return undefined;
  };
  const slides = scene.slides.map((s) => {
    const t0 = performance.now();
    const { notes, log: put } = noteList();
    // M9: a hub without LibreOffice says what is not drawn, never that LibreOffice draws it.
    const log: Log =
      opts.libreoffice === false
        ? (msg) => {
            const note = noteWithoutLibreOffice(msg);
            if (note !== undefined) put(note);
          }
        : put;
    for (const note of s.notes) log(note);
    const ctx: EmitCtx = {
      frame: scene.frame,
      newId,
      mediaId,
      extend: opts.extendBackgrounds ?? true,
      crop: opts.crop ?? true,
      rich: opts.richText ?? true,
      lo: opts.loCompat === true,
      libreoffice: opts.libreoffice !== false,
      m9: opts.m9Writes ?? ALL_M9_FIELDS,
      media,
      bake,
      log,
      textBytes: 0,
      clipId,
      transitionSounds: opts.transitionSounds ?? false,
      ...(opts.sheets === false ? {} : { sheet, sheets: [] }),
      mediaPart,
    };
    const spans: [number, number][] = [];
    ctx.metafiles = [];
    ctx.clips = [];
    const slide = emitSlide(ctx, s, spans);
    // M9 (`decor-conv`): large decorations in decoration files first, so the slide's budget below counts
    // them as stored (`storedSlideBytes`), as its large geometries go to geometry files there.
    decorFiles(slide, decorRef);
    // The slide's whole JSON as the hub stores it, its large geometries in files (design/27 §3.4); one still
    // over the budget keeps its class and is fitted by the importer (M9 `ladder`).
    const { over } = slideBudget(ctx, slide, notes, geomRef);
    let art = artInfo(s, scene.frame, spans, slide.objects);
    let metafiles = ctx.metafiles.map(({ part, object, at }) => {
      const before = slide.objects[at]?.id;
      return { part, object, ...(before !== undefined ? { before } : {}) };
    });
    let classification = s.classification;
    // M9: without LibreOffice nothing draws the art or converts the metafiles: neither is planned, on any
    // slide, and what they would draw is listed as missing (a picture-class slide's by the importer).
    const gaps = ctx.libreoffice
      ? undefined
      : withoutLibreOffice(s, classification, art, metafiles.length, log);
    if (!ctx.libreoffice) {
      art = undefined;
      metafiles = [];
    }
    if (gaps) classification = gaps.classification;
    // M9: what the slide budgets' guard left out (`budget.ts`), whatever draws the rest.
    const left = s.classification.missing ?? [];
    const missing = [...new Set([...left, ...(gaps?.missing ?? [])])];
    const plate = ctx.plate;
    ctx.plate = undefined;
    return {
      index: s.index,
      ...(s.shown !== undefined ? { shown: s.shown } : {}),
      hidden: s.hidden,
      slide,
      classification,
      digest: digestOf(slide.objects),
      notes,
      ms: performance.now() - t0,
      ...(art ? { art } : {}),
      ...(metafiles.length ? { metafiles } : {}),
      ...(over && s.classification.class !== 'picture' ? { overBudget: true as const } : {}),
      ...(ctx.clips.length ? { clips: ctx.clips } : {}),
      ...(missing.length ? { missing } : {}),
      ...(gaps?.artText ? { artText: gaps.artText } : {}),
      ...(ctx.sheets?.length ? { sheets: ctx.sheets } : {}),
      ...(plate ? { plate } : {}),
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
    decors: [...decorFileList.values()],
    sheets: [...sheets.values()],
  };
}

// ── Geometry files and the slide's JSON budget (M6 round 2, design/27 §3.4) ───────────────────────────────

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
  // Where each object came from (`originOf`); the M1 emission (`richText: false`) writes only the fields of
  // the release before design/27, as it always did.
  const marks = ctx.rich;
  if (marks) for (const o of objects) o.origin = { src: ORIGIN_SRC, role: 'bg' };
  const texts: Emitted[] = [];
  // Pairs (a shape and its text, a picture and its outline) get group numbers past the deck's groups.
  let pairs = 0;
  for (const e of s.elements) pairs = Math.max(pairs, e.group ?? 0);
  // Runs of shapes of one look (`classify.ts` `shapeRuns`): one object, emitted at the run's first element.
  const runs = new Map<number, ShapeElement[]>();
  s.elements.forEach((e) => {
    if (e.kind !== 'shape' || e.merge === undefined || e.hidden) return;
    const run = runs.get(e.merge) ?? [];
    run.push(e);
    runs.set(e.merge, run);
  });
  // M9 (`decor-conv`): runs drawn as one decoration (`ElementBase.decor`), written at the run's first
  // element when `emitDecor` writes it; otherwise each member is emitted as below.
  const decors = new Map<number, Element[]>();
  s.elements.forEach((e) => {
    if (e.decor === undefined || e.hidden) return;
    const run = decors.get(e.decor) ?? [];
    run.push(e);
    decors.set(e.decor, run);
  });
  const decorated = new Set<number>();
  // M9 (`decor-conv`): runs of plain pictures drawn as one composite picture (`ElementBase.sheet`, `sheet.ts`).
  const sheetRuns = new Map<number, Element[]>();
  s.elements.forEach((e) => {
    if (e.sheet === undefined || e.hidden) return;
    const run = sheetRuns.get(e.sheet) ?? [];
    run.push(e);
    sheetRuns.set(e.sheet, run);
  });
  const composited = new Set<number>();
  // A member of a decoration or a composite, as the single-element emitter writes it.
  const emitOne = (x: Element, sink: SlideObject[]) => emitElement(ctx, x, sink, texts);
  s.elements.forEach((e, i) => {
    const at = objects.length;
    const mf = ctx.metafiles?.length ?? 0;
    const decor = e.decor !== undefined && !e.hidden ? decors.get(e.decor) : undefined;
    if (decor && e.decor === i && emitDecor(ctx, decor, objects, emitOne)) decorated.add(i);
    const sheet = e.sheet !== undefined && !e.hidden ? sheetRuns.get(e.sheet) : undefined;
    if (sheet && e.sheet === i && emitComposite(ctx, sheet, objects, emitOne)) composited.add(i);
    if (decor && e.decor !== undefined && decorated.has(e.decor)) {
      // Drawn by its run's decoration.
    } else if (sheet && e.sheet !== undefined && composited.has(e.sheet)) {
      // Drawn by its run's composite.
    } else if (e.kind === 'shape' && e.merge !== undefined && !e.hidden) {
      const run = runs.get(i);
      if (e.merge === i && run) emitMerged(ctx, run, objects, texts);
    } else if (!e.hidden && !pastBudget(e)) emitElement(ctx, e, objects, texts);
    spans.push([at, objects.length]);
    if (marks) {
      const made = objects.length - at;
      const group = e.group ?? (made > 1 && pairs < MAX_GROUP ? ++pairs : undefined);
      // A table's cells and grid come with their own origin (roles 'cell' and 'grid', `tables.ts`).
      for (let k = at; k < objects.length; k++) objects[k]!.origin ??= originOf(e, objects[k]!, group);
      for (const m of ctx.metafiles?.slice(mf) ?? []) m.object.origin = originOf(e, m.object, e.group);
    }
    // M6: a SmartArt drawing's objects are a locked group with editable text (`smartart.ts`).
    if (e.diagram !== undefined) lockDiagram(e, objects, at);
  });
  const media = emitMedia(ctx, s, slide, spans);
  for (const o of objects) if (o.type === 'image' && o.play && o.origin) o.origin.role = 'poster';
  ctx.clips?.push(...media.clips);
  if (media.remove.size) leaveOut(ctx, slide, spans, media.remove);
  if (objects.length > MAX_OBJECTS) {
    ctx.log(`more than ${MAX_OBJECTS} objects: the top ones are not drawn`);
    objects.length = MAX_OBJECTS;
  }
  // M9 (`decor-conv`): the slide's picture budget, its fewest smallest pictures in one atlas (`sheet.ts`).
  if (s.classification.atlas?.length) atlasSlide(ctx, objects, s.classification.atlas);
  // A composite's members as they are without it carry the origin it has.
  for (const sh of ctx.sheets ?? []) {
    const at = objects.find((o) => o.id === sh.uses[0]);
    if (at?.origin) for (const o of sh.objects) o.origin ??= { ...at.origin };
  }
  // M9: what is only slow to draw is kept whole (decisions.md "Slow-to-draw elements"): the drawing budgets
  // choose how it is drawn, from a decoration plate or live, never whether (`fitEffects`, `fitDrawing`).
  const slow = new Set([...fitEffects(ctx, objects), ...fitDrawing(ctx, objects)]);
  const plan = platePlan(slide);
  if (plan.stack.length || plan.effects.length || slow.size)
    ctx.plate = { ...plan, pastBudget: objects.filter((o) => slow.has(o.id)).map((o) => o.id) };
  // A SmartArt node's text is a fragment of a diagram, never the lyric box.
  const lyric = lyricOf(texts.filter((t) => objects.includes(t.o) && t.e.diagram === undefined));
  if (lyric) slide.lyricObjectId = lyric.id;
  return slide;
}

/** The geometry an emitted object draws at its box (`geombudget.ts` `drawnGeometry`) and its stored points. */
function geometryOf(o: SlideObject) {
  if (o.type === 'shape')
    return (
      geometryAt(o.geom, o.box.w, o.box.h) ?? {
        built: legacyGeometry(o.shape, o.radius ?? 0, o.box.w, o.box.h),
        points: 0,
      }
    );
  if (o.type === 'image' && o.mask) return geometryAt(o.mask, o.box.w, o.box.h);
  return undefined;
}

/**
 * What an emitted shape's effects weigh (renderer `effectArea`): their layers over what it draws (`bounds.ts`
 * `drawnBounds`: its geometry's points, past its box included, grown by its outline), as every drawer makes
 * them (`shape.ts`, `effects.ts`) and sizes them (`geombudget.ts`).
 */
function effectAreaOf(o: SlideObject): number {
  if (o.type !== 'shape' || !(o.shadow || o.glow || o.softEdge)) return 0;
  const g = geometryOf(o);
  return effectArea(o, g ? drawnBounds(g.built, outlineOf(o)) : undefined);
}

/**
 * The slide's effect budget (renderer `geom/cost.ts` `EFFECT_COST`, design/27 §12 drawing cost): shapes keep
 * their shadow, glow and soft edge, bottom first, while the area of their layers stays within it. The
 * corpus's most effected slides use 7.7 of its 10 slide areas. Since M9 (`decor-conv`, decisions.md
 * "Slow-to-draw elements") the shapes past it keep their effects too: the slide's decoration plate holds
 * their effect layers (`platePlan`), and until it is made the renderer draws them without, as every drawer
 * does past the budget (`geombudget.ts`). Returns their ids, with a note.
 */
function fitEffects(ctx: EmitCtx, objects: readonly SlideObject[]): string[] {
  let area = 0;
  const past: string[] = [];
  for (const o of objects) {
    if (o.type !== 'shape') continue;
    const a = effectAreaOf(o);
    if (!a) continue;
    if (area + a <= EFFECT_COST.slide * 0.98) {
      area += a;
      continue;
    }
    past.push(o.id);
  }
  if (past.length)
    ctx.log(
      `the effects of ${past.length} shape(s) past the slide's effect budget are drawn from its decoration plate`,
    );
  return past;
}

/**
 * The slide's drawing budget (renderer `geom/cost.ts` `slidePlan`, design/27 §12 drawing cost) on the objects
 * as emitted, exactly as every drawer applies it (`geombudget.ts`): which objects a drawer draws past it, as
 * their legacy shapes or without their effects. Since M9 (`decor-conv`, decisions.md "Slow-to-draw
 * elements", the wave 1 re-review) they are stored whole, never flattened to their legacy copy (their
 * gradient, geometry, dash and ends kept, so the editor still edits them and a centre-white radial glow
 * stays a glow): the slide's decoration plate holds them (`platePlan`), and until it is made each drawer
 * draws them as its budget allows. Returns their ids, with a note.
 */
function fitDrawing(ctx: EmitCtx, objects: readonly SlideObject[]): string[] {
  const rate = (o: SlideObject, part?: LegacyPart): Rated => {
    const x = part ? withoutPart(o, part) : o;
    const at = geometryOf(x);
    return { est: objectCost(x, at?.built), points: at?.points ?? 0 };
  };
  const parts = slidePlan(objects, rate, effectAreaOf);
  const past: string[] = [];
  parts.forEach((part, i) => {
    const o = objects[i]!;
    // A stored geometry too costly to fill at once is drawn as its legacy shape by every drawer, whatever
    // the slide's budget (`stored.ts`, past `GEOM_COST.geometry`): the plate holds it too.
    const g = o.type === 'shape' ? o.geom : o.type === 'image' ? o.mask : undefined;
    const costly = !!g?.paths?.length && g.ref === undefined && !geometryAt(g, o.box.w, o.box.h);
    if (part || costly) past.push(o.id);
  });
  if (past.length)
    ctx.log(
      `${past.length} object(s) past the slide's drawing budget are drawn from its decoration plate (as their legacy shapes until it is made)`,
    );
  return past;
}

/**
 * An element the object budget sent to the art (`classify.ts` `fitShapes`, 'budget:shapes', only behind
 * `ParseOptions.budgetArt`, the harness's A/B): like a residual table it emits nothing, so version 1 stays
 * within the budget with the slide's own text drawn, until the art replaces what it draws. Since M9 nothing
 * else is left to the art for a budget, and nothing at all for being slow to draw (`walk.ts`).
 */
function pastBudget(e: Element): boolean {
  return e.support === 'residual' && !!e.reasons?.includes('budget:shapes');
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

// ── Origin ──────────────────────────────────────────────────────────────────────────────────────────────

/** `ObjectOrigin.src` of every object the converter writes. */
const ORIGIN_SRC = 'pptx';
/** `ObjectOrigin.group` is at most 100,000 (the schema's bound). */
const MAX_GROUP = 100_000;

/**
 * Where an object came from (design/27 §3.1 `ObjectOrigin`; the editor groups, locks, restyles similar
 * boxes and re-imports by it): the shape's `p:cNvPr` id, its placeholder (`title`, `body:1`, ...: the type and
 * idx, letters and digits only, since both are deck strings), its role, and the flattened group or shape and
 * text pair it belongs to. Roles: `bg` (the background), `deco` (a layout or master decoration), `title` and
 * `body` (placeholder text), `text` (other text), `picture`, `poster` (a picture that plays a video, set
 * after `emitMedia`), `shape`; the hub adds `art`.
 */
function originOf(e: Element, o: SlideObject, group: number | undefined): ObjectOrigin {
  const out: ObjectOrigin = { src: ORIGIN_SRC, role: roleOf(e, o) };
  if (Number.isInteger(e.shapeId) && e.shapeId > 0) out.shapeId = Math.min(2_147_483_647, e.shapeId);
  const ph = phKey(e.ph);
  if (ph) out.ph = ph;
  if (group !== undefined && Number.isInteger(group) && group >= 0) out.group = Math.min(MAX_GROUP, group);
  return out;
}

function roleOf(e: Element, o: SlideObject): string {
  if (e.from !== 'slide') return 'deco';
  if (o.type === 'image') return 'picture';
  if (o.type === 'shape') return 'shape';
  if (!e.ph) return 'text';
  return e.ph.type === 'title' || e.ph.type === 'ctrTitle' ? 'title' : 'body';
}

/** A placeholder as `ObjectOrigin.ph`: its type, and `:idx` when it has one; at most 40 characters. */
function phKey(ph: Element['ph']): string | undefined {
  if (!ph) return undefined;
  const type = ph.type.replace(/[^A-Za-z]/g, '').slice(0, 24) || 'obj';
  const idx = ph.idx?.replace(/[^0-9]/g, '').slice(0, 10);
  return idx ? `${type}:${idx}` : type;
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
  if (e.kind === 'chart') {
    emitChart(ctx, e, out);
    return;
  }
  emitShape(ctx, e, out, texts);
}

function emitPicture(ctx: EmitCtx, e: PictureElement, out: SlideObject[]): void {
  if (e.reasons?.some((r) => r.startsWith('mask:')))
    ctx.log(`a picture clipped to ${e.geom} is drawn as a rect`);
  if (e.picture.effects?.some((name) => !BAKED_EFFECTS.has(name)))
    ctx.log('a picture is drawn without some of its effects');
  const img = pictureObject(ctx, e.xf, e.picture, e.geom, e.adj, e.custom);
  if (img) {
    // M9 (`three-model`): the picture's 3-D.
    const look3d = look3dOf(ctx, e.look3d, img.box);
    if (look3d) img.look3d = look3d;
    out.push(img);
  }
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
  // M9 (`three-model`): the shape's 3-D.
  const look3d = look3dOf(ctx, e.look3d, o.box);
  if (look3d) o.look3d = look3d;
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

/** A line width in logical px: PowerPoint draws a zero-width line one device pixel wide (`lineWidthPx`). */
function strokeWidth(ctx: EmitCtx, w: number): number {
  return lineWidthPx(ctx.frame, w);
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
  // A mirrored picture: `flipH` about the box's centre (the box's rotation carries a vertical flip).
  const flipH = decompose(m).flipH;
  let crop = ctx.crop ? placed.crop : undefined;
  if (outsideClamp(box)) {
    if (box.rotation === 0 && geom === 'rect' && ctx.crop) {
      // The crop names the source's sides; a mirrored box cuts its left side from the source's right.
      const cut = cutToClamp(box, flipH ? mirrorX(crop) : crop);
      if (!cut) return undefined;
      box = cut.box;
      crop = flipH ? mirrorX(cut.crop) : cut.crop;
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
  // The mask (M6: any geometry, mirrored and clipped in its box), with the legacy `radius` an older build
  // draws beside it (design/27 §3.2).
  if (geom === 'roundRect') o.radius = cornerRadius(box, adj);
  else if (geom === 'ellipse') o.radius = bound(Math.min(box.w, box.h) / 2, 0, MAX_COORD);
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

/** A crop with its left and right shares swapped (the crop of a mirrored picture seen from its box). */
function mirrorX(c: Insets | undefined): Insets | undefined {
  return c && { l: c.r, t: c.t, r: c.l, b: c.b };
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

// ── Boxes and colours ───────────────────────────────────────────────────────────────────────────────────
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
