import { z } from 'zod';
import { chartSchemas } from './chart.ts';
import { BEVEL_PRESETS, CAMERA_PRESETS, LIGHT_DIRECTIONS, LIGHT_RIGS, MATERIALS } from './three-names.ts';

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
  /**
   * Adjust values past `adj`'s ±1e7 (M9): the angles of arc, pie, chord, blockArc and circularArrow go to
   * 21,599,999 (60,000ths of a degree). A build that reads it prefers a pair here over the pair of the same
   * name in `adj`; `adj` beside it holds the value clamped to ±1e7, which an older build draws.
   */
  adjWide: z
    .array(z.tuple([z.string().max(16), z.number().min(-21_600_000).max(21_600_000)]))
    .max(10)
    .optional()
    .catch(undefined),
});
export type ShapeGeom = z.infer<typeof ShapeGeom>;

/**
 * A geometry file (`ShapeGeom.ref`, M6 round 2): one geometry's paths, the JSON the content store holds under
 * its SHA-256 (`application/json`, at most `GEOM_FILE_MAX_BYTES`). Each path is bounded as an inline path is
 * and re-tokenised by every reader. M9 widens a file to 64 paths (262,144 points), a traced outline too large
 * for 8: a file is not part of a slide, so the inline `ShapeGeom.paths` keeps its 8, and an older build that
 * refuses a widened file draws the inline paths, else the legacy shape.
 */
export const GeomFile = z.object({ paths: z.array(ShapeGeomPath).min(1).max(64) });
export type GeomFile = z.infer<typeof GeomFile>;

/** The largest geometry or decoration file a reader parses: 64 paths of 40,000 characters and their fields. */
export const GEOM_FILE_MAX_BYTES = 2_600_000;

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
 * PowerPoint 3-D (design/27 M9, `look3d` on shapes, pictures and text objects): the bevelled, extruded and
 * turned look of `a:scene3d` and `a:sp3d`, in degrees and logical px, names from `three-names.ts`. An older
 * build strips it and draws the object flat (LibreOffice's own look for most worship 3-D); the converter folds
 * a front camera's `rev` into `box.rotation`, so the flat object keeps its turn in the plane.
 */

/** Degrees, a turn on any axis (OOXML 60,000ths of a degree ÷ 60,000). */
const deg = z.number().min(-36_000).max(36_000);

export const BevelPreset = z.enum(BEVEL_PRESETS);
export type BevelPreset = z.infer<typeof BevelPreset>;

/** A bevel: its profile and its width and height in logical px (OOXML's default 76,200 EMU is 12 px). */
export const Bevel = z.object({
  prst: BevelPreset.catch('circle'),
  w: z.number().min(0).max(1_000),
  h: z.number().min(0).max(1_000),
});
export type Bevel = z.infer<typeof Bevel>;

export const Camera3d = z.object({
  prst: z.enum(CAMERA_PRESETS).catch('orthographicFront'),
  /** Degrees (OOXML fov ÷ 60,000). */
  fov: z.number().min(0).max(180).optional(),
  /** lat, lon, rev in degrees: replaces the preset's angles. */
  rot: z.tuple([deg, deg, deg]).optional(),
  zoom: z.number().min(0.01).max(100).optional(),
});
export type Camera3d = z.infer<typeof Camera3d>;

export const Light3d = z.object({
  rig: z.enum(LIGHT_RIGS).catch('threePt'),
  dir: z.enum(LIGHT_DIRECTIONS).catch('t').optional(),
  rot: z.tuple([deg, deg, deg]).optional(),
});
export type Light3d = z.infer<typeof Light3d>;

export const Look3d = z.object({
  /** bevelT: the lit rim of the front face. */
  bevel: Bevel.optional(),
  /** bevelB: seen only past a quarter turn. */
  back: Bevel.optional(),
  /** extrusionH, logical px. */
  depth: z.number().min(0).max(1_000).optional(),
  /** sp3d z: towards the camera (seen with a perspective camera only). */
  lift: z.number().min(-1_000).max(1_000).optional(),
  contour: z.object({ width: z.number().min(0).max(500), color: Rgba }).optional(),
  /** extrusionClr, resolved; absent: the line colour, else the fill colour. */
  side: Rgba.optional(),
  material: z.enum(MATERIALS).catch('warmMatte').optional(),
  /** Absent: threePt from the top. */
  light: Light3d.optional(),
  /** Absent: orthographicFront. */
  camera: Camera3d.optional(),
  /** The silhouette's edge lies this far outside the object's own edge (a picture under its frame). */
  grow: z.number().min(0).max(500).optional(),
  /** Text: a:flatTx, stays flat on a turned shape. */
  flat: z.boolean().optional(),
});
export type Look3d = z.infer<typeof Look3d>;

/*
 * Rich text and PowerPoint fields (design/27 §3). Every new field is optional and bounded, and enums inside
 * new fields use .catch(default), so a value a later release adds degrades instead of failing
 * Slide.safeParse in this one. An older build strips them all and draws the legacy values beside them.
 */

export const TextLineMask = z.object({
  style: z.enum(['fullWidth', 'lineWidth', 'maxLineWidth']).catch('fullWidth'),
  heightOffsetPx: z.number().min(-2000).max(2000).optional(),
  vOffsetPx: z.number().min(-2000).max(2000).optional(),
  widthOffsetPx: z.number().min(-4000).max(4000).optional(),
  hOffsetPx: z.number().min(-4000).max(4000).optional(),
  fill: Rgba.optional(),
  gradient: Gradient.optional(),
});
export type TextLineMask = z.infer<typeof TextLineMask>;

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
  /** ProPresenter line-fill mask: paints per-line backing straps with `fill` or `gradient` over the box. */
  lineMask: TextLineMask.optional(),
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

/*
 * Looks of a text object that live on the object, never on `TextStyle` (design/27 M9): a style is also a
 * theme's, a text box default, a look's band and stage style and a prop's, and none of those may warp, turn
 * or stand text up. So themes, bands and 'apply style to similar' never carry them.
 */

/** ECMA-376 ST_TextShapeType without textNoShape: the 40 WordArt warps (presetTextWarpDefinitions). */
export const TEXT_WARPS = [
  'textPlain',
  'textStop',
  'textTriangle',
  'textTriangleInverted',
  'textChevron',
  'textChevronInverted',
  'textRingInside',
  'textRingOutside',
  'textArchUp',
  'textArchDown',
  'textCircle',
  'textButton',
  'textArchUpPour',
  'textArchDownPour',
  'textCirclePour',
  'textButtonPour',
  'textCurveUp',
  'textCurveDown',
  'textCanUp',
  'textCanDown',
  'textWave1',
  'textWave2',
  'textDoubleWave1',
  'textWave4',
  'textInflate',
  'textDeflate',
  'textInflateBottom',
  'textDeflateBottom',
  'textInflateTop',
  'textDeflateTop',
  'textDeflateInflate',
  'textDeflateInflateDeflate',
  'textFadeRight',
  'textFadeLeft',
  'textFadeUp',
  'textFadeDown',
  'textSlantUp',
  'textSlantDown',
  'textCascadeUp',
  'textCascadeDown',
] as const;
export type TextWarpPreset = (typeof TEXT_WARPS)[number];

/**
 * A WordArt warp (`a:bodyPr/a:prstTxWarp`): the text is drawn bent to the preset's shape at raster time, so
 * it stays canonical and editable. An unknown name still warps, stretched to the box (textPlain). `adj` are
 * the preset's adjust values by name (pairs: no deck string is a key), angles in 60,000ths of a degree.
 * An older build strips it and draws plain rich text; the converter writes beside an affine or envelope warp
 * the style an unwarped box best fills.
 */
export const TextWarp = z.object({
  preset: z.enum(TEXT_WARPS).catch('textPlain'),
  adj: z
    .array(z.tuple([z.string().max(16), z.number().min(-21_600_000).max(21_600_000)]))
    .max(4)
    .optional(),
});
export type TextWarp = z.infer<typeof TextWarp>;

/**
 * Vertical text in a box turned a quarter (`a:bodyPr vert`): which clusters stand upright (none: every glyph
 * turns with the box, mongolianVert; cjk: UAX #50 upright clusters stand, eaVert; all: every grapheme stands,
 * stacked, wordArtVert), and `reverse`: lines advance the other way across the turned box (left to right on
 * the slide). An older build strips it and draws horizontal text in the turned box.
 */
export const Writing = z.object({
  upright: z.enum(['none', 'cjk', 'all']).catch('cjk'),
  reverse: z.boolean().optional(),
});
export type Writing = z.infer<typeof Writing>;

/** Where an object came from (an imported PowerPoint shape), for grouping, re-import and 'apply to similar'. */
export const ObjectOrigin = z.object({
  /** 'pptx' */
  src: z.string().max(16),
  /** p:cNvPr id */
  shapeId: z.number().int().min(0).max(2_147_483_647).optional(),
  /** 'title' | 'body' | 'body:2' | 'subTitle' ... */
  ph: z.string().max(40).optional(),
  /**
   * title|body|text|picture|shape|bg|deco|poster|cell|grid|art|table|chart|decor|ole|ink|math (a string: the
   * list can grow). cell: a table cell's text; grid: a table's locked fills and lines (M6); table, chart: the
   * object carries `table` or `chart` (M9); decor: a decoration (`ShapeObject.decor`); ole, ink, math: the
   * deck's own fallback picture of an embedded object, ink or an equation, locked.
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
  /** M9: the text drawn bent to a WordArt shape. */
  warp: TextWarp.optional().catch(undefined),
  /** M9: vertical text in its quarter-turned box. */
  writing: Writing.optional().catch(undefined),
  /**
   * M9, PowerPoint anchorCtr: the text block, as wide as its widest line, is centred in the box and the
   * paragraphs align inside it. Older builds draw the lines at their own alignment.
   */
  centerBlock: z.boolean().optional().catch(undefined),
  /** M9: the text's 3-D look (with its shape's, unless `flat`). */
  look3d: Look3d.optional().catch(undefined),
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
  shadow: Shadow.optional(),
  softEdge: length.optional(),
  /** M9: the picture's 3-D look (a bevelled or turned picture frame). */
  look3d: Look3d.optional().catch(undefined),
  /**
   * M9: the families the text of a vector picture uses (an EMF or WMF the hub converted, `VECTOR_MIME`):
   * shipped and awaited like text fonts. Older builds strip it; they do not draw vector pictures.
   */
  vectorFonts: z.array(z.string().max(300)).max(8).optional().catch(undefined),
  ...common,
});
export type ImageObject = z.infer<typeof ImageObject>;

/** A palette index below `n` (tables, charts, decorations: `palette.ts`). */
const ix = (n: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(n - 1);

/*
 * A table drawn and edited by ordo (design/27 M9, `ShapeObject.table`, origin.role 'table'). Cells sit
 * row-major, each at the next grid slot no earlier cell covers (as in OOXML and HTML); a span is cut where it
 * would reach a covered slot or the grid's edge, and cells past the grid are dropped. Indices refer to the
 * table's own palettes (`styles`, `runStyles`, `fills`, `lineStyles`), whose entries hold only what differs
 * from `base`. An older build strips `table` and draws the shape's legacy fields: a rect filled with the
 * table's background (decision 4 of M9: no legacy group is written).
 */
export const TABLE_LIMITS = {
  rows: 256,
  cols: 64,
  /** Grid slots, rows × columns. */
  grid: 4_096,
  /** Characters of one cell's text (the render clamp's per-cell bound) and of all the table's cells. */
  cellText: 10_000,
  tableText: 60_000,
  cellRuns: 2_000,
  tableRuns: 8_000,
  cellParas: 1_000,
  tableParas: 8_000,
  cellStyles: 64,
  runStyles: 256,
  fills: 64,
  lineStyles: 32,
  /** Edge segments, `h` and `v` each. */
  edges: 8_192,
} as const;

/** A row or column edge index (0 .. rows), or a column or row index of a segment's ends. */
const edge = z.number().int().min(0).max(TABLE_LIMITS.rows);

/** A cell's text box style, sparse over `TableData.base`: an absent field is the base's. */
export const CellStyle = z.object({
  fontFamily: z.string().max(300).optional(),
  fontWeight: z.number().int().min(1).max(1000).optional(),
  fontSizePx: z.number().min(1).max(1_000).optional(),
  color: Rgba.optional(),
  /** a:tcPr marL, marT, marR, marB. */
  insets: z.object({ l: length, t: length, r: length, b: length }).optional(),
  lang: z.string().max(35).optional(),
  fallbackFonts: z.array(z.string().max(300)).max(8).optional(),
  fontStyle: z.enum(['normal', 'italic']).catch('normal').optional(),
  align: z.enum(['left', 'center', 'right', 'justify']).catch('left').optional(),
  /** a:tcPr anchor */
  valign: z.enum(['top', 'middle', 'bottom']).catch('top').optional(),
  direction: z.enum(['auto', 'ltr', 'rtl']).catch('auto').optional(),
  /** a:tcPr vert: drawn by the vertical text engine. */
  vert: z.enum(['horz', 'vert', 'vert270', 'eaVert']).catch('horz').optional(),
});
export type CellStyle = z.infer<typeof CellStyle>;

/** A run's formatting without its range: what `TextRun` holds besides start and end. */
export const TableRunStyle = TextRun.omit({ start: true, end: true });
export type TableRunStyle = z.infer<typeof TableRunStyle>;

/** [start, end, runStyle] over the cell's text (UTF-16 offsets), sorted and not overlapping, as `TextRun`. */
export const TableRun = z.tuple([
  z.number().int().min(0).max(TABLE_LIMITS.cellText),
  z.number().int().min(0).max(TABLE_LIMITS.cellText),
  ix(TABLE_LIMITS.runStyles),
]);
export type TableRun = z.infer<typeof TableRun>;

/** A fill: `color` is the solid colour, or a gradient's first stop. */
export const TableFill = z.object({ color: Rgba, gradient: Gradient.optional() });
export type TableFill = z.infer<typeof TableFill>;

export const TableLineStyle = z.object({
  width: length,
  color: Rgba,
  dash: LineDash.catch('solid').optional(),
});
export type TableLineStyle = z.infer<typeof TableLineStyle>;

/** A drawn cell. */
export const TableCell = z.object({
  /** Absent: an empty cell. */
  text: z.string().max(TABLE_LIMITS.cellText).optional(),
  runs: z.array(TableRun).max(TABLE_LIMITS.cellRuns).optional(),
  /** As `TextObject.paras`: paras[i] styles text.split('\n')[i]. */
  paras: z.array(TextPara.nullable()).max(TABLE_LIMITS.cellParas).optional(),
  /** Into `styles`; absent: the base alone. */
  style: ix(TABLE_LIMITS.cellStyles).optional(),
  /** Into `fills`; absent: no fill. */
  fill: ix(TABLE_LIMITS.fills).optional(),
  colSpan: z.number().int().min(1).max(TABLE_LIMITS.cols).optional(),
  rowSpan: z.number().int().min(1).max(TABLE_LIMITS.rows).optional(),
  /** a:lnTlToBr (down) and a:lnBlToTr (up), into `lineStyles`. */
  diag: z
    .object({ down: ix(TABLE_LIMITS.lineStyles).optional(), up: ix(TABLE_LIMITS.lineStyles).optional() })
    .optional(),
});
export type TableCell = z.infer<typeof TableCell>;

export const TableData = z.object({
  /** Column widths, drawn scaled to box.w. */
  cols: z.array(length).min(1).max(TABLE_LIMITS.cols),
  /** Minimum row heights (a:tr h), drawn scaled by box.h ÷ their sum. */
  rows: z.array(length).min(1).max(TABLE_LIMITS.rows),
  cells: z.array(TableCell).max(TABLE_LIMITS.grid),
  /** The cells' text box style: the office line model, wrapping, no autofit. */
  base: TextStyle,
  styles: z.array(CellStyle).max(TABLE_LIMITS.cellStyles).optional(),
  runStyles: z.array(TableRunStyle).max(TABLE_LIMITS.runStyles).optional(),
  fills: z.array(TableFill).max(TABLE_LIMITS.fills).optional(),
  lineStyles: z.array(TableLineStyle).max(TABLE_LIMITS.lineStyles).optional(),
  /** Horizontal edge segments: [row edge 0..rows, from column, to column (exclusive), line style]. */
  h: z
    .array(z.tuple([edge, edge, edge, ix(TABLE_LIMITS.lineStyles)]))
    .max(TABLE_LIMITS.edges)
    .optional(),
  /** Vertical edge segments: [column edge 0..cols, from row, to row (exclusive), line style]. */
  v: z
    .array(z.tuple([edge, edge, edge, ix(TABLE_LIMITS.lineStyles)]))
    .max(TABLE_LIMITS.edges)
    .optional(),
  /** a:tblPr's fill, else the table style's tblBg, into `fills`. */
  background: ix(TABLE_LIMITS.fills).optional(),
  /** a:tblPr rtl: column 0 on the right. */
  rtl: z.boolean().optional(),
  /** fixed: rows as stored, never grown (the fidelity harness's LibreOffice rows). */
  rowRule: z.enum(['grow', 'fixed']).catch('grow').optional(),
});
export type TableData = z.infer<typeof TableData>;

/* A chart drawn by ordo (design/27 M9, `ShapeObject.chart`, origin.role 'chart'): `chart.ts`. */
const charts = chartSchemas({ Rgba, length, Gradient, LineDash, TextRun, TextPara });
export const ChartFill = charts.ChartFill;
export type ChartFill = z.infer<typeof ChartFill>;
export const ChartLine = charts.ChartLine;
export type ChartLine = z.infer<typeof ChartLine>;
export const ChartText = charts.ChartText;
export type ChartText = z.infer<typeof ChartText>;
export const ChartBox = charts.ChartBox;
export type ChartBox = z.infer<typeof ChartBox>;
export const ChartLabels = charts.ChartLabels;
export type ChartLabels = z.infer<typeof ChartLabels>;
export const ChartMarker = charts.ChartMarker;
export type ChartMarker = z.infer<typeof ChartMarker>;
export const ChartPoint = charts.ChartPoint;
export type ChartPoint = z.infer<typeof ChartPoint>;
export const ChartSeries = charts.ChartSeries;
export type ChartSeries = z.infer<typeof ChartSeries>;
export const ChartGroup = charts.ChartGroup;
export type ChartGroup = z.infer<typeof ChartGroup>;
export const ChartTitle = charts.ChartTitle;
export type ChartTitle = z.infer<typeof ChartTitle>;
export const ChartAxis = charts.ChartAxis;
export type ChartAxis = z.infer<typeof ChartAxis>;
export const ChartData = charts.ChartData;
export type ChartData = z.infer<typeof ChartData>;

/*
 * A decoration (design/27 M9, `ShapeObject.decor`, origin.role 'decor', locked): a z-run of plain PowerPoint
 * shapes drawn as one object, each part a path in the decoration's own `w × h` space with one of its paints.
 * Older builds strip it and draw the object's legacy fields, a line with no stroke: nothing. `ref` names a
 * decoration file (`DecorFile`), stored, named, collected and shipped as geometry files are (`pptxdecor:<n>`
 * from the converter, a SHA-256 from the hub); while it is read, its parts are drawn and `parts` is ignored.
 */
export const DECOR_LIMITS = {
  paints: 64,
  parts: 256,
  /** Path points of all its parts. */
  points: 16_384,
  /** Source shapes with a shadow (each is its own sprite). */
  shadowed: 24,
} as const;

/** One look of a decoration: what one PowerPoint shape drew. */
export const DecorPaint = z.object({
  /** A solid fill; alpha allowed. */
  fill: Rgba.optional(),
  /** Over `fill`, laid on each part's `frame`. */
  gradient: Gradient.optional(),
  stroke: z.object({ width: length, color: Rgba }).optional(),
  dash: LineDash.catch('solid').optional(),
  /** Under each source shape of this paint. */
  shadow: Shadow.optional(),
});
export type DecorPaint = z.infer<typeof DecorPaint>;

/** One path of a decoration, in its `w × h` space; parts are drawn in order. */
export const DecorPart = z.object({
  /** M L C Q Z and numbers (`cleanPathData`), at most 4,096 points. */
  d: z.string().max(40_000),
  /** Paint index; one out of the palette is not drawn. */
  p: ix(DECOR_LIMITS.paints),
  /** The first part of a source shape: its unit of shadow and stroke. */
  s: z.literal(1).optional(),
  /** A preset path's own fill mode. */
  fill: PathFillMode.catch('norm').optional(),
  /** false: not stroked (preset paths that only fill). */
  stroke: z.boolean().optional(),
  /** Continues the part before it (one path stored in pieces), as `ShapeGeomPath.cont`. */
  cont: z.boolean().optional().catch(undefined),
  /** The gradient frame: the source shape's x, y, w, h and rotation in the decoration's space. */
  frame: z.tuple([coord, coord, length, length, z.number().min(-360).max(360)]).optional(),
});
export type DecorPart = z.infer<typeof DecorPart>;

export const DecorData = z.object({
  w: z.number().min(0).max(1e9),
  h: z.number().min(0).max(1e9),
  paints: z.array(DecorPaint).min(1).max(DECOR_LIMITS.paints),
  /** Ignored while the file `ref` names is read (as `ShapeGeom.paths` beside `ShapeGeom.ref`). */
  parts: z.array(DecorPart).max(DECOR_LIMITS.parts),
  ref: z.string().min(1).max(100).optional().catch(undefined),
});
export type DecorData = z.infer<typeof DecorData>;

/** A decoration file (`DecorData.ref`): its parts, JSON of at most `GEOM_FILE_MAX_BYTES` in the content store. */
export const DecorFile = z.object({ parts: z.array(DecorPart).min(1).max(DECOR_LIMITS.parts) });
export type DecorFile = z.infer<typeof DecorFile>;

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
  /*
   * M9: what the shape draws instead of its geometry. A drawer keeps at most one, in this order (table,
   * chart, decor), and draws no `look3d` with any of them; an older build draws the legacy fields above.
   */
  table: TableData.optional().catch(undefined),
  chart: ChartData.optional().catch(undefined),
  decor: DecorData.optional().catch(undefined),
  /** M9: the shape's 3-D look. */
  look3d: Look3d.optional().catch(undefined),
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
  /**
   * M9: PowerPoint elements on this slide that nothing draws (no ordo drawing, no fallback picture in the deck,
   * no LibreOffice): '<kind>' or '<kind>:<subtype>' with a kind of `MISSING_KINDS` ('chart:surface', 'ole').
   * Such a slide is class hybrid; its notes say what is left out and `artText` keeps the elements' text.
   */
  missing: z.array(z.string().max(40)).max(16).optional().catch(undefined),
  /** What every drawer shows: the objects (default) or the reference picture (`refMediaId`). */
  show: z.enum(['objects', 'picture']).catch('objects').optional(),
});
export type SlidePptx = z.infer<typeof SlidePptx>;

export const MidiCueType = z.enum(['noteOn', 'noteOff', 'cc', 'programChange']);
export type MidiCueType = z.infer<typeof MidiCueType>;

export const MidiCue = z.object({
  id: Id,
  deviceName: z.string().max(500).optional(),
  channel: z.number().int().min(1).max(16).default(1),
  type: MidiCueType.default('noteOn'),
  number: z.number().int().min(0).max(127).default(0),
  value: z.number().int().min(0).max(127).default(127),
  delayMs: z.number().int().min(0).max(60_000).optional(),
});
export type MidiCue = z.infer<typeof MidiCue>;

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
  bottomThirdText: z.string().max(MAX.long).optional(),
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
  /** Outgoing MIDI cues to fire when this slide goes live. */
  midiCues: z.array(MidiCue).max(32).optional(),
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
  rev: z.number().int().min(0).optional(),
  updatedAt: z.string().max(100).optional(),
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
  'firstSlide',
  'lastSlide',
  'nextItem',
  'prevItem',
  'goToSection',
  'goToSlide',
  'goToItem',
  'goToSlideItem',
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
    keepBackground: z.boolean().optional(),
    audioMediaId: Id.optional(),
    countdownTimer: TimerSpec.optional(),
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

export const MidiParamSource = z.enum(['static', 'velocity', 'ccValue']).default('static');
export type MidiParamSource = z.infer<typeof MidiParamSource>;

export const MidiMapping = z.object({
  id: Id,
  deviceName: z.string().max(500).optional(),
  kind: z.enum(['note', 'cc', 'programChange']),
  number: z.number().int().min(0).max(127),
  channel: z.number().int().min(1).max(16).optional(),
  threshold: z.number().int().min(0).max(127).default(64),
  action: z.object({ id: ActionId, arg: ActionArg.optional() }),
  paramSource: MidiParamSource.optional(),
});
export type MidiMapping = z.infer<typeof MidiMapping>;

export const SurfaceSettings = z.object({
  streamDeckPages: z.array(StreamDeckPage).max(100).default([]),
  midi: z.array(MidiMapping).max(1000).default([]),
  midiEnabled: z.boolean().default(false),
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
