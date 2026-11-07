import { z } from 'zod';

/**
 * Bounds (design/25 "validate at entry"): every string, array, record and number has a limit far above any
 * real use, so a damaged or hostile record is refused at the boundary instead of reaching a renderer. The
 * render plan clamps further at the point of use.
 */
const MAX = {
  id: 200,
  name: 500,
  text: 20_000,
  long: 200_000,
  coord: 100_000,
  ms: 86_400_000,
} as const;
const name = () => z.string().max(MAX.name);
/** A record with at most `n` keys. */
function bounded<T extends z.ZodType>(schema: T, n: number): T {
  return schema.refine((o) => Object.keys(o as object).length <= n, { message: `at most ${n} entries` }) as T;
}

/** ULID string identifiers for every stored entity. */
export const Id = z.string().min(1).max(MAX.id);
export type Id = z.infer<typeof Id>;

/** Logical canvas is 1920x1080; outputs scale. */
export const LOGICAL_WIDTH = 1920;
export const LOGICAL_HEIGHT = 1080;

/*
 * Media playing in place (design/27 §3.1, §8). Enums inside these new fields use .catch(default), so a
 * value a later release adds degrades instead of failing Slide.safeParse. Trims are baked into the clip at
 * ingest, so there are no trim fields.
 */

export const MediaOnEnd = z.enum(['hold', 'black', 'advance']);
export type MediaOnEnd = z.infer<typeof MediaOnEnd>;

/** The clip an ImageObject plays in its box; `ImageObject.mediaId` stays the poster an older build draws. */
export const Play = z.object({
  mediaId: Id,
  /** click: goes live paused at 0, and F8 plays it. */
  start: z.enum(['auto', 'click']).catch('auto').optional(),
  loop: z.boolean().optional(),
  /** 'black' is PowerPoint's "Rewind after playing": the poster shows again. */
  onEnd: MediaOnEnd.catch('hold').optional(),
  /** 20·log10(vol/100000) of PowerPoint's volume. */
  gainDb: z.number().min(-100).max(100).optional(),
  muted: z.boolean().optional(),
  /** false: PowerPoint's "Hide while not playing" (no poster). */
  showWhenStopped: z.boolean().optional(),
});
export type Play = z.infer<typeof Play>;

/** One sound per slide (PowerPoint's embedded audio). */
export const SlideSound = z.object({
  mediaId: Id,
  start: z.enum(['auto', 'click']).catch('auto').optional(),
  loop: z.boolean().optional(),
  gainDb: z.number().min(-100).max(100).optional(),
  muted: z.boolean().optional(),
  /** PowerPoint's numSld: plays across this many shown slides of the same playlist item. */
  slides: z.number().int().min(1).max(999).optional(),
});
export type SlideSound = z.infer<typeof SlideSound>;

const channel = z.number().min(0).max(255);
export const Rgba = z.object({ r: channel, g: channel, b: channel, a: z.number().min(0).max(1) });
export type Rgba = z.infer<typeof Rgba>;

const coord = z.number().min(-MAX.coord).max(MAX.coord);
const length = z.number().min(0).max(MAX.coord);
export const Box = z.object({
  x: coord,
  y: coord,
  w: coord,
  h: coord,
  rotation: z.number().min(-36_000).max(36_000).default(0),
});
export type Box = z.infer<typeof Box>;

/** A drop shadow: offset, blur and colour (TextStyle, runs, and later shapes and pictures). */
export const Shadow = z.object({ dx: coord, dy: coord, blur: length, color: Rgba });
export type Shadow = z.infer<typeof Shadow>;
/** A glow around text (a blurred copy with no offset). */
export const Glow = z.object({ radius: length, color: Rgba });
export type Glow = z.infer<typeof Glow>;

/** A signed share of a length, -1..1 (design/27 §3.1). */
const frac = z.number().min(-1).max(1);

/*
 * Shape geometry and paint (design/27 §3.1, §15 M6). An older build strips these fields and draws the legacy
 * values written beside them: `ShapeObject.shape` (rect, ellipse or line) with `fill` as a solid colour (the
 * first gradient stop), `TextStyle.color`, the whole picture.
 */

/**
 * A linear or radial gradient over a box (a shape's fill, gradient text). Stops are sorted by `at`.
 * - linear: `angle` is OOXML's `a:lin ang` in degrees, clockwise from left→right (90 = top→bottom); the
 *   stops run across the box's projection on that direction, from corner to corner. `scaled` (OOXML
 *   `scaled="1"`) takes the angle in a square and stretches it with the box, so 45° runs corner to corner.
 * - radial (OOXML path gradients): `at` 0 is the focus, 1 the farthest corner of the box, on an ellipse of
 *   the box's aspect; `center` is the focus in box fractions from the top-left corner (absent: the centre,
 *   0.5, 0.5; OOXML's fillToRect l t r b gives ((1 + l − r)/2, (1 + t − b)/2)).
 */
export const Gradient = z.object({
  kind: z.enum(['linear', 'radial']).catch('linear'),
  angle: z.number().min(-36_000).max(36_000).optional(),
  scaled: z.boolean().optional(),
  stops: z
    .array(z.object({ at: z.number().min(0).max(1), color: Rgba }))
    .min(2)
    .max(16),
  center: z.object({ x: frac, y: frac }).optional(),
});
export type Gradient = z.infer<typeof Gradient>;

/** How a geometry path is filled: 'none' unfilled; the shaded modes blend the fill towards white or black. */
export const PathFillMode = z.enum(['norm', 'none', 'lighten', 'lightenLess', 'darken', 'darkenLess']);
export type PathFillMode = z.infer<typeof PathFillMode>;

/**
 * One stored path of a geometry (`ShapeGeom.paths`, `GeomFile.paths`). `d` uses only M, L, C, Q and Z with
 * numbers (the render plan re-tokenises it, at most 4,096 points per path) in the path's own space `w` x `h`,
 * scaled to the box; a side of 0 means the box's own logical px on that axis.
 * `cont` (M6): the path continues the one before it, so the two are drawn as one path (one even-odd fill,
 * stroked together; the first path's fill mode and stroke flag): a traced outline whose holes all sit
 * inside it, too long for one path, is stored in pieces cut at its sub-paths' starts. A build without
 * `cont` fills each piece on its own (holes filled where a piece has no outline); `cont` on the first
 * path means nothing.
 */
export const ShapeGeomPath = z.object({
  d: z.string().max(40_000),
  w: z.number().min(0).max(1e9),
  h: z.number().min(0).max(1e9),
  fill: PathFillMode.catch('norm').optional(),
  stroke: z.boolean().optional(),
  cont: z.boolean().optional().catch(undefined),
});
export type ShapeGeomPath = z.infer<typeof ShapeGeomPath>;

/**
 * A DrawingML geometry: a preset by name (POI's table, evaluated at draw time, so a resize keeps the corners
 * and adjust values; `adj` pairs override the preset's adjust values by name, pairs so no deck string is a
 * key), or the paths of a custGeom, already evaluated (`ShapeGeomPath`). A known preset wins over `paths`; an
 * unknown one with no paths draws the legacy shape.
 * `ref` (M6 round 2): the paths are stored once in a geometry file (`GeomFile`), named here by the SHA-256 of
 * its JSON in the content store (`/files/<ref>`), and read like a picture: a traced decoration of 100-1,000 KB
 * of path text, which a layout repeats on every slide and a slide at several sizes, travels once per library
 * instead of inside every slide. While the file is read, its paths are drawn and `paths` beside it (if any)
 * is ignored; without it (not read yet, missing, an older build that strips `ref`) the geometry is `paths`,
 * else the legacy shape. The converter writes placeholders (`pptxgeom:<n>`) that the hub replaces.
 */
export const ShapeGeom = z.object({
  preset: z.string().max(40).optional(),
  adj: z
    .array(z.tuple([z.string().max(16), z.number().min(-1e7).max(1e7)]))
    .max(10)
    .optional(),
  paths: z.array(ShapeGeomPath).max(8).optional(),
  ref: z.string().min(1).max(100).optional().catch(undefined),
});
export type ShapeGeom = z.infer<typeof ShapeGeom>;

/**
 * A geometry file (`ShapeGeom.ref`, M6 round 2): one geometry's paths, the JSON the content store holds under
 * its SHA-256 (`application/json`, at most `GEOM_FILE_MAX_BYTES`). Bounded as `ShapeGeom.paths` is, and
 * re-tokenised by every reader as inline paths are.
 */
export const GeomFile = z.object({ paths: z.array(ShapeGeomPath).min(1).max(8) });
export type GeomFile = z.infer<typeof GeomFile>;

/** The largest geometry file a reader parses: 8 paths of 40,000 characters and their fields. */
export const GEOM_FILE_MAX_BYTES = 400_000;

/** A geometry file's name in the content store (`ShapeGeom.ref` as the hub writes it): a SHA-256 in hex. */
export function isGeomFileRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.length === 64 && /^[0-9a-f]{64}$/.test(ref);
}

/** A line's dash pattern (OOXML prstDash; 'long…' are lgDash…), relative to the line width. */
export const LineDash = z.enum([
  'solid',
  'dot',
  'dash',
  'dashDot',
  'longDash',
  'longDashDot',
  'longDashDotDot',
  'sysDot',
  'sysDash',
  'sysDashDot',
  'sysDashDotDot',
]);
export type LineDash = z.infer<typeof LineDash>;

/**
 * A line's joins (OOXML `a:round`, `a:bevel`, `a:miter` of `a:ln`) and caps (`a:ln cap`: flat, rnd, sq);
 * M6 repair. Absent: miter joins (limit 8) and flat caps, what every build drew before.
 */
export const LineJoin = z.enum(['miter', 'round', 'bevel']);
export type LineJoin = z.infer<typeof LineJoin>;
export const LineCap = z.enum(['flat', 'round', 'square']);
export type LineCap = z.infer<typeof LineCap>;

/** The size of an arrowhead's width or length (OOXML sm, med, lg), relative to the line width. */
const ArrowSize = z.enum(['sm', 'med', 'lg']);

/** An arrowhead at one end of an open path (OOXML headEnd at its start, tailEnd at its end). */
export const ArrowEnd = z.object({
  type: z.enum(['none', 'triangle', 'stealth', 'arrow', 'oval', 'diamond']).catch('none'),
  w: ArrowSize.catch('med').optional(),
  len: ArrowSize.catch('med').optional(),
});
export type ArrowEnd = z.infer<typeof ArrowEnd>;

/*
 * Rich text and PowerPoint fields (design/27 §3). Every new field is optional and bounded, and enums inside
 * new fields use .catch(default), so a value a later release adds degrades instead of failing
 * Slide.safeParse in this one. An older build strips them all and draws the legacy values beside them.
 */

export const TextStyle = z.object({
  fontFamily: z.string().max(300),
  fontWeight: z.number().min(0).max(1000).default(400),
  fontStyle: z.enum(['normal', 'italic']).default('normal'),
  fontSizePx: z.number().min(0).max(5000),
  color: Rgba,
  align: z.enum(['left', 'center', 'right']).default('center'),
  valign: z.enum(['top', 'middle', 'bottom']).default('middle'),
  lineHeight: z.number().min(0).max(100).default(1.2),
  letterSpacing: z.number().min(-1000).max(1000).default(0),
  padding: coord.default(0),
  outline: z.object({ width: length, color: Rgba }).optional(),
  shadow: Shadow.optional(),
  fill: z.object({ color: Rgba, radius: length.default(0) }).optional(),
  /** Applied when drawn; the text itself keeps its authored casing (ProPresenter's ALL CAPS). */
  transform: z.enum(['none', 'uppercase']).default('none'),
  /** How lines are spaced: ordo's (`lineHeight` × size) or LibreOffice/PowerPoint's (design/27 §6). */
  lineModel: z.enum(['ordo', 'office']).catch('ordo').optional(),
  /** Space between the box and the text on each side; replaces `padding` when present. */
  insets: z.object({ l: length, t: length, r: length, b: length }).optional(),
  /** false: lines never wrap (PowerPoint wrap="none"); they grow from their alignment. */
  wrap: z.boolean().optional(),
  /** shrink: smaller text and spacing until the text fits the box. */
  autofit: z.enum(['none', 'shrink']).catch('none').optional(),
  /**
   * The shrink scale in use: PowerPoint's stored normAutofit, or the last fit. Kept by edits while the text
   * still fits at it (design/27 §11).
   */
  fitScale: z.object({ font: z.number().min(0.01).max(1), spacing: z.number().min(0).max(1) }).optional(),
  /** Justify every paragraph of the box (`align` is never widened). */
  justify: z.boolean().optional(),
  /** Base direction of paragraphs that set none; auto takes it from the first strong character. */
  direction: z.enum(['ltr', 'rtl', 'auto']).catch('auto').optional(),
  /** BCP 47 language tag (line breaking, shaping, hyphenation). */
  lang: z.string().max(35).optional(),
  /** Families tried after `fontFamily`: metric substitute, east Asian/complex-script fonts, script fallbacks. */
  fallbackFonts: z.array(z.string().max(300)).max(8).optional(),
  underline: z.boolean().optional(),
  glow: Glow.optional(),
  /** Gradient text: the glyphs of runs without their own colour are painted with it, over the box. */
  paint: Gradient.optional(),
});
export type TextStyle = z.infer<typeof TextStyle>;

/**
 * A sparse style annotation over `TextObject.text`, by UTF-16 offsets [start, end). Runs are sorted and do
 * not overlap; text outside every run takes the box style. Unset fields take the box style too.
 */
export const TextRun = z.object({
  start: z.number().int().min(0).max(MAX.text),
  end: z.number().int().min(0).max(MAX.text),
  fontFamily: z.string().max(300).optional(),
  fontWeight: z.number().min(0).max(1000).optional(),
  fontStyle: z.enum(['normal', 'italic']).catch('normal').optional(),
  /** × style.fontSizePx, so the box size (and a theme) scales every run. */
  sizeScale: z.number().min(0.01).max(50).optional(),
  color: Rgba.optional(),
  highlight: Rgba.optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  /** Raised (+) or lowered (-) by this share of the size: OOXML baseline/100000; +0.3 = superscript. */
  baseline: z.number().min(-1).max(1).optional(),
  letterSpacing: z.number().min(-1000).max(1000).optional(),
  caps: z.enum(['none', 'all', 'small']).catch('none').optional(),
  /** null = no outline here, whatever the box style says. */
  outline: z.object({ width: length, color: Rgba }).nullable().optional(),
  /** null = no shadow here, whatever the box style says. */
  shadow: Shadow.nullable().optional(),
  lang: z.string().max(35).optional(),
});
export type TextRun = z.infer<typeof TextRun>;

/** Style of paragraph i, the i-th piece of `text.split('\n')`. A null entry takes the box defaults. */
export const TextPara = z.object({
  align: z.enum(['left', 'center', 'right', 'justify', 'distribute']).catch('left').optional(),
  /** PowerPoint a:br: a line break that continues the previous paragraph (no bullet, no space before). */
  soft: z.boolean().optional(),
  level: z.number().int().min(0).max(8).optional(),
  /** Left margin of the paragraph's lines (marL). */
  indentPx: coord.optional(),
  /** Extra indent of the first line (indent); negative = a hanging bullet. */
  firstLinePx: coord.optional(),
  spaceBeforePx: length.optional(),
  spaceAfterPx: length.optional(),
  /** × single spacing (single = 1.2 × size in the office model). */
  lineSpacing: z.number().min(0).max(13.2).optional(),
  /** Exact line pitch. */
  lineSpacingPx: length.optional(),
  /** null = explicitly no bullet (PowerPoint buNone). */
  bullet: z
    .object({
      /** Unicode (Wingdings and Symbol codes are mapped at import). */
      char: z.string().min(1).max(8).optional(),
      /** OOXML autonumber scheme: 'arabicPeriod', 'arabicParenBoth', ...; unknown → arabicPeriod. */
      auto: z.string().max(40).optional(),
      startAt: z.number().int().min(1).max(32_767).optional(),
      fontFamily: z.string().max(300).optional(),
      color: Rgba.optional(),
      sizePct: z.number().min(0.1).max(4).optional(),
    })
    .nullable()
    .optional(),
  rtl: z.boolean().optional(),
  /** Laid out but not drawn (a split reveal keeps revealed lines in place). */
  hidden: z.boolean().optional(),
});
export type TextPara = z.infer<typeof TextPara>;

/** Where an object came from (an imported PowerPoint shape), for grouping, re-import and 'apply to similar'. */
export const ObjectOrigin = z.object({
  /** 'pptx' */
  src: z.string().max(16),
  /** p:cNvPr id */
  shapeId: z.number().int().min(0).max(2_147_483_647).optional(),
  /** 'title' | 'body' | 'body:2' | 'subTitle' ... */
  ph: z.string().max(40).optional(),
  /**
   * title|body|text|picture|shape|bg|deco|poster|cell|grid|art (a string: the list can grow). cell: a
   * table cell's text; grid: a table's locked fills and lines.
   */
  role: z.string().max(20).optional(),
  /** A flattened group or a shape+text pair: selected together. */
  group: z.number().int().min(0).max(100_000).optional(),
});
export type ObjectOrigin = z.infer<typeof ObjectOrigin>;

/** Fields every slide object has. `locked`: move, resize, delete and z-order only. */
const common = { origin: ObjectOrigin.optional(), locked: z.boolean().optional() };

export const TextObject = z.object({
  id: Id,
  type: z.literal('text'),
  box: Box,
  text: z.string().max(MAX.text),
  style: TextStyle,
  opacity: z.number().min(0).max(1).default(1),
  runs: z.array(TextRun).max(2000).optional(),
  paras: z.array(TextPara.nullable()).max(5000).optional(),
  ...common,
});
export type TextObject = z.infer<typeof TextObject>;

/**
 * The share of the source picture cut from each side (PowerPoint's `a:srcRect`/100,000), applied before
 * `fit`: what is left is the picture `fit` places in the box. A negative share extends the picture past
 * that side instead, and the extension draws transparent (design/27 §3.1).
 */
export const ImageCrop = z.object({ l: frac, t: frac, r: frac, b: frac });
export type ImageCrop = z.infer<typeof ImageCrop>;

export const ImageObject = z.object({
  id: Id,
  type: z.literal('image'),
  box: Box,
  mediaId: Id,
  /** The clip this object plays in its box, at its z-order (design/27 §7.2); `mediaId` is its poster. */
  play: Play.optional(),
  fit: z.enum(['contain', 'cover', 'stretch']).default('contain'),
  opacity: z.number().min(0).max(1).default(1),
  radius: length.default(0),
  /** Absent in older builds, which strip it and draw the whole picture (design/27 §3.2). */
  crop: ImageCrop.optional(),
  /**
   * Mirrored about the box's centre before the box's rotation, crop and mask included (PowerPoint's
   * `flipH`/`flipV`; a crop share keeps naming the source's side). Older builds draw the picture unflipped.
   */
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  /**
   * The picture is cut to this geometry in its box (the union of its filled paths); `radius` applies only
   * without one (design/27 §3.1).
   */
  mask: ShapeGeom.optional(),
  ...common,
});
export type ImageObject = z.infer<typeof ImageObject>;

/**
 * `shape` stays rect, ellipse or line and `fill` a solid colour: what an older build draws. The M6 fields
 * (design/27 §3.1) draw the PowerPoint shape: its geometry, a gradient instead of `fill`, the line's dash and
 * arrowheads, flips about the box's centre (before the rotation) and the effects: an outer shadow, a glow
 * and a soft edge (the shape's edges fading out over that many logical px).
 */
export const ShapeObject = z.object({
  id: Id,
  type: z.literal('shape'),
  box: Box,
  shape: z.enum(['rect', 'ellipse', 'line']),
  fill: Rgba.optional(),
  stroke: z.object({ width: length, color: Rgba }).optional(),
  opacity: z.number().min(0).max(1).default(1),
  radius: length.default(0),
  geom: ShapeGeom.optional(),
  gradient: Gradient.optional(),
  dash: LineDash.catch('solid').optional(),
  lineJoin: LineJoin.catch('miter').optional(),
  lineCap: LineCap.catch('flat').optional(),
  ends: z.object({ head: ArrowEnd.optional(), tail: ArrowEnd.optional() }).optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  shadow: Shadow.optional(),
  glow: Glow.optional(),
  softEdge: length.optional(),
  ...common,
});
export type ShapeObject = z.infer<typeof ShapeObject>;

export const SlideObject = z.discriminatedUnion('type', [TextObject, ImageObject, ShapeObject]);
export type SlideObject = z.infer<typeof SlideObject>;

export const ExtractedText = z.object({
  text: z.string().max(MAX.text),
  box: Box,
  fontSizePx: z.number().min(0).max(5000).optional(),
});
export type ExtractedText = z.infer<typeof ExtractedText>;

export const ScriptureRef = z.object({
  translation: z.string().max(200),
  book: z.string().max(200),
  chapter: z.number().int().min(0).max(10_000),
  verseFrom: z.number().int().min(0).max(10_000),
  verseTo: z.number().int().min(0).max(10_000).optional(),
});
export type ScriptureRef = z.infer<typeof ScriptureRef>;

export const ScriptureSlideSource = z.object({
  ref: ScriptureRef,
  text: z.string().max(MAX.text),
  fetchedAt: z.string().max(100),
  provider: z.string().max(200),
});
export type ScriptureSlideSource = z.infer<typeof ScriptureSlideSource>;

export const Transition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cut') }),
  z.object({ kind: z.literal('crossfade'), ms: z.number().min(0).max(10000) }),
]);
export type Transition = z.infer<typeof Transition>;

/**
 * Where a slide came from in a PowerPoint deck (design/27 §3.1, M3): provenance only, never drawable
 * content. `artText` is the one exception, kept for search and labels. Enums use .catch(default), so a value
 * a later release adds degrades instead of failing Slide.safeParse.
 */
export const SlidePptx = z.object({
  /** The stored deck: its SHA-256, the `files` row (`Presentation.source.fileId`). */
  fileId: Id,
  /** Position in the deck's slide order (`p:sldIdLst`), hidden slides counted. */
  index: z.number().int().min(0).max(100_000),
  /** Position among the shown slides (the LibreOffice page); absent for a hidden slide. */
  shown: z.number().int().min(0).max(100_000).optional(),
  /** native: every element is an ordo object; hybrid: plus one locked art picture; picture: a page picture. */
  class: z.enum(['native', 'hybrid', 'picture']).catch('native'),
  /** The converter version that wrote the slide. */
  version: z.number().int().min(1).max(1_000_000),
  /** Digest of the objects the converter wrote: the slide is unedited while its objects still match it. */
  digest: z.string().max(100).optional(),
  /** LibreOffice work for this slide (art, metafiles, page picture) is still to come. */
  pending: z.boolean().optional(),
  /** LibreOffice could not draw (part of) this slide: it shows what version 1 had; goLive names it. */
  failed: z.boolean().optional(),
  /** What was approximated or left out, shown in the editor. */
  notes: z.array(z.string().max(200)).max(16).optional(),
  /** Text of the text bodies baked into the art or page picture: search and labels only. */
  artText: z.string().max(MAX.text).optional(),
  /** LibreOffice picture of the whole slide, made on demand ('Show PowerPoint picture'). */
  refMediaId: Id.optional(),
  /** What every drawer shows: the objects (default) or the reference picture (`refMediaId`). */
  show: z.enum(['objects', 'picture']).catch('objects').optional(),
});
export type SlidePptx = z.infer<typeof SlidePptx>;

export const Slide = z.object({
  id: Id,
  objects: z.array(SlideObject).max(1000).default([]),
  lyricObjectId: Id.optional(),
  backgroundMediaId: Id.optional(),
  /**
   * Showing this slide clears the running background (a ProPresenter slide with a clear action). Ignored
   * when the slide has a background of its own.
   */
  clearBackground: z.boolean().optional(),
  durationMs: z.number().min(0).max(MAX.ms).optional(),
  notes: z.string().max(MAX.long).optional(),
  overrides: z.array(z.string().max(200)).max(1000).optional(),
  /**
   * A hidden PowerPoint slide (design/27 §9): its cue is flagged `hidden`, so Next, Prev, auto-advance and
   * onEnd 'advance' skip it, while a click in the slide grid (a GO with its index) shows it.
   */
  hidden: z.boolean().optional(),
  /** The slide's own transition: a cue uses `item ?? slide ?? presentation` (design/27 §9). */
  transition: Transition.optional().catch(undefined),
  pptx: SlidePptx.optional(),
  imported: z
    .object({
      fileId: Id,
      page: z.number().int().min(0).max(100_000),
      imageMediaId: Id,
      textBoxes: z.array(ExtractedText).max(1000).optional(),
      /**
       * The text boxes are this page's (keyed by shown slide, uniform mapping): text readers may fall back
       * to them (design/27 §11). Legacy boxes, matched by list index, are not trusted.
       */
      textAligned: z.boolean().optional(),
    })
    .optional(),
  scripture: ScriptureSlideSource.optional(),
  /** The slide's own sound (design/27 §8); it can play on across `slides` shown slides. */
  audio: SlideSound.optional(),
});
export type Slide = z.infer<typeof Slide>;

export const Section = z.object({
  id: Id,
  label: z.string().max(MAX.name),
  short: z.string().max(100),
  slides: z.array(Slide).max(5000).default([]),
  /** Chords per lyric line, kept from ChordPro imports for a future chord view. */
  chords: z.array(z.string().max(2000)).max(20_000).optional(),
});
export type Section = z.infer<typeof Section>;

export const Arrangement = z.object({ id: Id, name: name(), sectionIds: z.array(Id).max(10_000) });
export type Arrangement = z.infer<typeof Arrangement>;

export const PresentationKind = z.enum(['song', 'slides', 'loop']);
export type PresentationKind = z.infer<typeof PresentationKind>;

/** What draws a PowerPoint's slides into pictures on import (design/20 "PPTX and PDF"). */
export const PptxRenderer = z.enum(['libreoffice', 'pptx-preview']);
export type PptxRenderer = z.infer<typeof PptxRenderer>;

/** What a native PowerPoint import made of the deck (design/27 §3.1, M3): converter version and class counts. */
export const PptxNativeSource = z.object({
  version: z.number().int().min(1).max(1_000_000),
  slides: z.number().int().min(0).max(100_000),
  native: z.number().int().min(0).max(100_000),
  hybrid: z.number().int().min(0).max(100_000),
  picture: z.number().int().min(0).max(100_000),
  /** The deck's area in the 1920x1080 frame (a 4:3 deck leaves bars), the editor's guide. */
  slideRect: z.object({ x: coord, y: coord, w: length, h: length }).optional(),
});
export type PptxNativeSource = z.infer<typeof PptxNativeSource>;

export const Presentation = z.object({
  id: Id,
  rev: z.number().int().min(0).default(1),
  title: z.string().max(1000),
  kind: PresentationKind,
  meta: z
    .object({
      author: z.string().max(2000).optional(),
      ccli: z.string().max(200).optional(),
      copyright: z.string().max(5000).optional(),
      key: z.string().max(50).optional(),
      tempo: z.number().min(0).max(10_000).optional(),
      tags: z.array(z.string().max(200)).max(200).default([]),
    })
    .default({ tags: [] }),
  folderId: Id.optional(),
  themeId: Id.optional(),
  backgroundMediaId: Id.optional(),
  transition: Transition.optional(),
  sections: z.array(Section).max(2000).default([]),
  arrangements: z.array(Arrangement).max(500).default([]),
  loop: z.object({ defaultSlideMs: z.number().min(0).max(MAX.ms) }).optional(),
  linesPerSlide: z.number().int().min(1).max(12).optional(),
  source: z
    .object({
      kind: z.enum(['pro7', 'songselect', 'pptx', 'pdf', 'manual', 'paste']),
      fileId: Id.optional(),
      /** What drew a PowerPoint's slide pictures (design/20 "PPTX and PDF"). */
      renderer: PptxRenderer.optional(),
      log: z.string().max(MAX.long).optional(),
      /** Set by the native PowerPoint import; `renderer` stays unset (it is never widened, design/27 §3.2). */
      native: PptxNativeSource.optional(),
    })
    .optional(),
  archived: z.boolean().default(false),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
});
export type Presentation = z.infer<typeof Presentation>;

export const Theme = z.object({
  id: Id,
  name: name(),
  lyricBox: Box,
  text: TextStyle,
  textBoxDefaults: TextStyle,
});
export type Theme = z.infer<typeof Theme>;

export const FileRef = z.object({
  hash: z.string().max(128),
  bytes: z.number().int().min(0),
  mime: z.string().max(200),
  path: z.string().max(1000),
});
export type FileRef = z.infer<typeof FileRef>;

export const MediaKind = z.enum(['video', 'image', 'audio']);
export type MediaKind = z.infer<typeof MediaKind>;

/**
 * The part of the original a media item keeps, baked into its delivery at ingest (PowerPoint's trim,
 * design/27 §8 "Hub"). Two items made from the same file with different trims are different clips.
 */
export const MediaTrim = z.object({
  startMs: z.number().int().min(0).max(MAX.ms),
  endMs: z.number().int().min(0).max(MAX.ms),
});
export type MediaTrim = z.infer<typeof MediaTrim>;

export const Media = z.object({
  id: Id,
  rev: z.number().int().min(0).default(1),
  name: name(),
  tags: z.array(z.string().max(200)).max(200).default([]),
  kind: MediaKind,
  original: FileRef,
  delivery: FileRef.optional(),
  poster: FileRef.optional(),
  state: z.enum(['uploaded', 'processing', 'ready', 'failed']),
  error: z.string().max(5000).optional(),
  durationMs: z
    .number()
    .min(0)
    .max(10 * MAX.ms)
    .optional(),
  width: z.number().min(0).max(MAX.coord).optional(),
  height: z.number().min(0).max(MAX.coord).optional(),
  hasAlpha: z.boolean().optional(),
  loop: z.boolean().default(false),
  isBackground: z.boolean().default(false),
  audio: z
    .object({
      pairId: Id.optional(),
      gainDb: z.number().min(-100).max(100).default(0),
      loudnessLufs: z.number().min(-200).max(100).optional(),
    })
    .optional(),
  trim: MediaTrim.optional(),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
});
export type Media = z.infer<typeof Media>;

export const Font = z.object({
  id: Id,
  family: z.string().max(300),
  weight: z.number().min(0).max(1000),
  style: z.enum(['normal', 'italic']),
  file: FileRef,
  source: z.enum(['upload', 'google', 'bundled']),
  /** CSS `unicode-range` of a subset face (a Google Fonts subset), passed to `FontFace` (design/27 §10). */
  unicodeRange: z.string().max(4000).optional(),
});
export type Font = z.infer<typeof Font>;

export const TimerSpec = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('countdownTo'),
    /** HH:MM in the venue's time zone. */
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/),
    label: z.string().max(200).optional(),
  }),
  z.object({ kind: z.literal('elapsed'), label: z.string().max(200).optional() }),
]);
export type TimerSpec = z.infer<typeof TimerSpec>;

export const ActionId = z.enum([
  'go',
  'next',
  'prev',
  'nextItem',
  'prevItem',
  'goToSection',
  'goToSlide',
  'clearSlide',
  'clearAll',
  'clearLowerThird',
  'clearProps',
  'clearMedia',
  'clearBackground',
  'logo',
  'mediaPlayPause',
  'mediaRestart',
  'timerStart',
  'timerStop',
  'timerReset',
  'messagePreset',
  'messageDismiss',
  'audioMute',
  'audioMasterUp',
  'audioMasterDown',
  'audioFadeOut',
  'launchOutputs',
  'relaunchOutputs',
]);
export type ActionId = z.infer<typeof ActionId>;

export const PlaylistItem = z.discriminatedUnion('kind', [
  z.object({
    id: Id,
    kind: z.literal('presentation'),
    presentationId: Id,
    arrangementId: Id.optional(),
    transition: Transition.optional(),
    backgroundMediaId: Id.optional(),
  }),
  z.object({
    id: Id,
    kind: z.literal('media'),
    mediaId: Id,
    loop: z.boolean().optional(),
    onEnd: MediaOnEnd.optional(),
    audio: z.object({ pairId: Id.optional(), gainDb: z.number().min(-100).max(100).optional() }).optional(),
  }),
  z.object({ id: Id, kind: z.literal('timer'), timer: TimerSpec }),
  z.object({ id: Id, kind: z.literal('action'), action: ActionId }),
]);
export type PlaylistItem = z.infer<typeof PlaylistItem>;

export const Playlist = z.object({
  id: Id,
  rev: z.number().int().min(0).default(1),
  name: name(),
  serviceDate: z.string().max(100).optional(),
  items: z.array(PlaylistItem).max(5000).default([]),
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
});
export type Playlist = z.infer<typeof Playlist>;

export const LayerName = z.enum(['background', 'slide', 'lowerThird', 'media', 'props']);
export type LayerName = z.infer<typeof LayerName>;
export const LAYER_ORDER: readonly LayerName[] = ['background', 'slide', 'lowerThird', 'media', 'props'];

export const LayerRule = z.object({ visible: z.boolean() });
export type LayerRule = z.infer<typeof LayerRule>;

export const SlideRule = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('authored') }),
  z.object({
    mode: z.literal('lyricOnly'),
    style: TextStyle,
    band: Box,
    nextSlide: z.object({ style: TextStyle, band: Box }).optional(),
    nonSong: z.enum(['text', 'none']).default('text'),
  }),
  z.object({ mode: z.literal('hidden') }),
]);
export type SlideRule = z.infer<typeof SlideRule>;

export const PropBox = TextStyle.extend({ box: Box });
export type PropBox = z.infer<typeof PropBox>;

export const PropsRule = z.object({
  logo: z.boolean().default(false),
  countdown: z.boolean().default(false),
  clock: z.boolean().default(false),
  messages: z.boolean().default(false),
  elapsed: z.boolean().default(false),
  /**
   * Stage look: show the remaining time of the live video. Optional so stored looks need no migration;
   * absent means "follow `elapsed`".
   */
  mediaRemaining: z.boolean().optional(),
  style: bounded(z.record(z.string().max(100), PropBox), 100).default({}),
  /**
   * Stage look: show the live slide's notes (`Slide.notes`) for the preacher, drawn in `style['notes']`
   * (design/27 §11 item 13). Optional so stored looks need no migration; absent means off.
   */
  notes: z.boolean().optional(),
});
export type PropsRule = z.infer<typeof PropsRule>;

export const Look = z.object({
  id: Id,
  name: name(),
  kind: z.enum(['main', 'stage', 'lowerThird', 'stream', 'custom']).default('custom'),
  layers: z.object({
    background: LayerRule,
    slide: SlideRule,
    lowerThird: LayerRule,
    media: LayerRule,
    props: PropsRule,
  }),
  /** Fill drawn under everything: black, or the key colour for the stream look. */
  clearColor: Rgba,
  /** Optional holding slide image shown when the background layer is hidden (lobby). */
  holdingMediaId: Id.optional(),
  transition: Transition,
});
export type Look = z.infer<typeof Look>;

export const ScreenRef = z.object({
  label: z.string().max(500),
  left: coord,
  top: coord,
  width: length,
  height: length,
});
export type ScreenRef = z.infer<typeof ScreenRef>;

export const OutputKind = z.enum(['output', 'stage']);
export const Output = z.object({
  id: Id,
  name: name(),
  kind: OutputKind.default('output'),
  /** out<k> hostname index; 0 for stage. */
  hostIndex: z.number().int().min(0).max(6),
  lookId: Id,
  screen: ScreenRef.optional(),
  enabled: z.boolean().default(true),
  audioMaster: z.boolean().default(false),
  /** Plain token is only returned to the operate role; stored hashed at rest is not required for the prototype. */
  token: z.string().max(200).optional(),
});
export type Output = z.infer<typeof Output>;

export const AudioPair = z.object({
  id: Id,
  name: name(),
  left: z.number().int().min(0).max(1024),
  right: z.number().int().min(0).max(1024),
});
export type AudioPair = z.infer<typeof AudioPair>;

export const AudioSettings = z.object({
  houseDeviceId: z.string().max(1000).optional(),
  houseDeviceLabel: z.string().max(1000).optional(),
  previewDeviceId: z.string().max(1000).optional(),
  previewDeviceLabel: z.string().max(1000).optional(),
  pairs: z.array(AudioPair).max(256).default([]),
  defaultPairId: Id.optional(),
  masterDb: z.number().min(-100).max(100).default(0),
});
export type AudioSettings = z.infer<typeof AudioSettings>;

/** A surface action's argument: a cue/section number or a short string (a message preset). */
const ActionArg = z.union([z.number().min(-1_000_000).max(1_000_000), z.string().max(500)]);
export const KeyMap = bounded(
  z.record(z.string().max(100), z.object({ id: ActionId, arg: ActionArg.optional() })),
  1000,
);
export type KeyMap = z.infer<typeof KeyMap>;

export const StreamDeckKey = z.object({
  action: z.object({ id: ActionId, arg: ActionArg.optional() }).optional(),
  /** Dynamic keys bind to live state instead of a fixed action. */
  dynamic: z.enum(['section', 'nextItem']).optional(),
  dynamicIndex: z.number().int().min(0).max(10_000).optional(),
  label: z.string().max(200).optional(),
  color: z.string().max(100).optional(),
});
export type StreamDeckKey = z.infer<typeof StreamDeckKey>;

export const StreamDeckPage = z.object({
  name: z.string().max(200),
  keys: bounded(z.record(z.string().max(20), StreamDeckKey), 200),
});
export type StreamDeckPage = z.infer<typeof StreamDeckPage>;

export const MidiMapping = z.object({
  id: Id,
  deviceName: z.string().max(500).optional(),
  kind: z.enum(['note', 'cc']),
  number: z.number().int().min(0).max(127),
  channel: z.number().int().min(1).max(16).optional(),
  threshold: z.number().int().min(0).max(127).default(64),
  action: z.object({ id: ActionId, arg: ActionArg.optional() }),
});
export type MidiMapping = z.infer<typeof MidiMapping>;

export const SurfaceSettings = z.object({
  streamDeckPages: z.array(StreamDeckPage).max(100).default([]),
  midi: z.array(MidiMapping).max(1000).default([]),
  messagePresets: z.array(z.string().max(500)).max(200).default([]),
});
export type SurfaceSettings = z.infer<typeof SurfaceSettings>;

export const GeneralSettings = z.object({
  venueName: z.string().max(200).default('ordo'),
  timeZone: z.string().max(100).default('UTC'),
  clock24h: z.boolean().default(false),
  logoMediaId: Id.optional(),
  defaultThemeId: Id.optional(),
  defaultLinesPerSlide: z.number().int().min(0).max(100).default(2),
  defaultPreRollMs: z.number().int().min(0).max(60_000).default(33),
});
export type GeneralSettings = z.infer<typeof GeneralSettings>;
