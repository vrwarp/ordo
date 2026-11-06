/**
 * The hub-internal scene IR (design/27 §1, §4): what `parseDeck` reads out of a deck, before `emitSlides`
 * turns it into ordinary ordo objects. The IR is never stored.
 *
 * - Geometry is in EMU (914,400 per inch, 12,700 per point) in the slide's own space, with full affine
 *   transforms; `frame.ts` maps it to ordo's 1920x1080 logical px.
 * - Colours are resolved (`Rgba`): scheme colours, clrMap/clrMapOvr and modifiers are already applied.
 * - Inheritance is resolved: every value here is the effective one (own → layout → master → defaults).
 * - Text keeps paragraphs and runs even where M1 emits only the dominant run's style, so the rich model of
 *   M2 needs no new reader.
 *
 * Growing the IR: add optional fields or new union members; do not rename or remove fields others use.
 */
import type { XNode } from './xml.ts';

/** English Metric Units. */
export type Emu = number;
export const EMU_PER_PT = 12_700;
export const EMU_PER_INCH = 914_400;

/** An RGBA colour: channels 0-255, alpha 0-1 (the shape of `@ordo/domain` `Rgba`). */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * A 2D affine transform `[a, b, c, d, e, f]` in Canvas/DOMMatrix order:
 * `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 */
export type Affine = readonly [number, number, number, number, number, number];

/** A rectangle in EMU, unrotated. */
export interface RectEmu {
  x: Emu;
  y: Emu;
  cx: Emu;
  cy: Emu;
}

/**
 * The mapping from the deck's slide (EMU) to ordo's logical 1920x1080 canvas: contain-fit and centred,
 * one scale for both axes (`frame.ts`). `px = x0 + emu·s` horizontally, `py = y0 + emu·s` vertically.
 */
export interface Frame {
  /** Slide size in EMU (`p:sldSz`). */
  cx: Emu;
  cy: Emu;
  /** Logical px per EMU. */
  s: number;
  /** Where the slide's top-left corner lands in logical px (the bars of a 4:3 deck). */
  x0: number;
  y0: number;
}

/** Fractions of a box cut from each side (`a:srcRect`/100,000). Negative values pad with transparency. */
export interface Insets {
  l: number;
  t: number;
  r: number;
  b: number;
}

// ── Paint ───────────────────────────────────────────────────────────────────────────────────────────────

export interface GradientStop {
  /** Position 0-1 (`pos`/100,000). */
  at: number;
  color: Rgba;
}

/** A fill, resolved: theme references (fillRef, bgRef) and phClr already applied. */
export type Fill =
  | { kind: 'none' }
  | { kind: 'solid'; color: Rgba }
  | {
      kind: 'gradient';
      stops: GradientStop[];
      /** Linear angle in degrees clockwise from left→right (`a:lin ang`/60,000). */
      angle?: number;
      /** `a:path path` (circle, rect, shape) for path gradients. */
      path?: string;
      /** `a:path/a:fillToRect`: the focus rectangle as insets of the box (fractions, ±1). */
      focus?: Insets;
      /** `a:lin scaled="1"`: the angle is taken in the unit square and scaled with the box (M6). */
      scaled?: boolean;
      /** `rotWithShape="0"`: the gradient keeps its angle on the slide when the shape turns (M6). */
      fixed?: boolean;
    }
  | { kind: 'picture'; picture: PictureFill }
  | { kind: 'pattern'; preset: string; fg: Rgba; bg: Rgba }
  /** `a:grpFill`: the enclosing group's fill (resolved by the walk when it can be). */
  | { kind: 'group' };

/** A picture used as a fill (`a:blipFill`): of a `p:pic`, of a shape, or of a background. */
export interface PictureFill {
  /** The image part, e.g. `ppt/media/image1.png` (resolved through the relationships). */
  part: string;
  /** `a:srcRect`: the part of the picture that is used. */
  crop?: Insets;
  /** `a:stretch/a:fillRect`: where the (cropped) picture lands inside the box. */
  fillRect?: Insets;
  /** `a:tile`, raw (M1 does not draw tiles; `background.ts` reports them). */
  tile?: { tx: Emu; ty: Emu; sx: number; sy: number; flip: string; algn: string };
  /** `a:alphaModFix amt`/100,000. */
  alpha?: number;
  /** Recolouring or effects on the blip (duotone, clrChange, grayscl, biLevel, lum, …): their element names. */
  effects?: string[];
  /**
   * The picture's size in pixels, read from its header when the part's bytes were present (not spilled),
   * else given by the caller. `alpha` (M3): the picture may have transparent pixels (an alpha channel or a
   * transparent colour); undefined when the header did not tell. `dpi` (M6): the resolution its header
   * states (PNG `pHYs`, JPEG JFIF), which sizes a tile; undefined when it states none.
   */
  px?: { w: number; h: number; alpha?: boolean; dpi?: { x: number; y: number } };
  /**
   * The blip's colour effects ordo bakes into a derived picture (M6, `bake.ts`), in document order, colours
   * resolved: what `effects` names that a bake reproduces. Effects it does not reproduce stay in `effects`
   * only (the picture is approx).
   */
  recolor?: Recolor[];
}

/**
 * One colour effect of a blip (`a:blip` children, ECMA-376 §20.1.8), as the bake applies it (M6, `bake.ts`).
 * Colours are resolved; shares are 0-1.
 */
export type Recolor =
  /** `a:grayscl`: every pixel its luminance. */
  | { kind: 'grayscale' }
  /** `a:biLevel thresh`: white where the luminance reaches `threshold`, else black. */
  | { kind: 'biLevel'; threshold: number }
  /** `a:duotone`: the luminance mapped from the first colour (black) to the second (white). */
  | { kind: 'duotone'; dark: Rgba; light: Rgba }
  /** `a:clrChange`: pixels of colour `from` (within a tolerance) become `to`, its alpha included. */
  | { kind: 'clrChange'; from: Rgba; to: Rgba }
  /** `a:lum bright contrast`: brightness and contrast, -1..1 each. */
  | { kind: 'lum'; bright: number; contrast: number };

export interface Line {
  /** Line width in EMU (`a:ln w`; 12,700 = 1 pt). */
  width: Emu;
  fill: Fill;
  /** `a:prstDash val`, when not solid. */
  dash?: string;
  head?: string;
  tail?: string;
  /** `a:custDash`: dash and space lengths in line widths (`a:ds d`, `sp` / 100,000), pairs flattened (M6). */
  custDash?: number[];
  /** Arrowhead sizes (`w`, `len`: sm, med, lg) when not medium (M6). */
  headSize?: { w: string; len: string };
  tailSize?: { w: string; len: string };
  /** `a:round`, `a:bevel` or `a:miter` (M6); undefined when the line sets none. */
  join?: 'round' | 'bevel' | 'miter';
  /** `cap`: flat, rnd or sq (M6); undefined when the line sets none. */
  cap?: 'flat' | 'round' | 'square';
}

/** An outer shadow (`a:outerShdw`). */
export interface Shadow {
  /** Distance and blur radius in EMU. */
  dist: Emu;
  blur: Emu;
  /** Direction in degrees clockwise from the x axis (`dir`/60,000). */
  dir: number;
  color: Rgba;
}

// ── Text ────────────────────────────────────────────────────────────────────────────────────────────────

/** Effective character properties of a run, the whole chain resolved (design/27 §4 "Run properties"). */
export interface RunStyle {
  /** Points (`sz`/100), clamped to 1-4,000. */
  sizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fill: Fill;
  /** Typefaces with theme references (`+mn-lt`, `+mj-ea`, …) resolved; the deck's own family names. */
  latin?: string;
  ea?: string;
  cs?: string;
  sym?: string;
  /** `baseline`/100,000: +0.3 is a superscript. */
  baseline: number;
  /** Extra space between characters in points (`spc`/100). */
  spacingPt: number;
  caps: 'none' | 'all' | 'small';
  /** A text outline (`a:ln` in the run properties). */
  outline?: Line;
  shadow?: Shadow;
  lang?: string;
  /** `a:highlight`. */
  highlight?: Rgba;
}

export interface Run {
  /** `text`: an `a:r`; `field`: an `a:fld` (its stored text); `break`: an `a:br` (text '\n'). */
  kind: 'text' | 'field' | 'break';
  /** The characters (`a:t`); `a:tab` kept as '\t'. */
  text: string;
  style: RunStyle;
}

/** `a:spcPts` (points) or `a:spcPct` (a share of the line, 1 = 100 %). */
export type Spacing = { pts: number } | { pct: number };

export type Bullet =
  | {
      kind: 'char';
      char: string;
      font?: string;
      color?: Rgba;
      sizePct?: number;
      /** `a:buSzPts`: the bullet's size in points (M2). */
      sizePt?: number;
    }
  | {
      kind: 'auto';
      scheme: string;
      startAt: number;
      font?: string;
      color?: Rgba;
      sizePct?: number;
      /** `a:buSzPts`: the bullet's size in points (M2). */
      sizePt?: number;
    }
  | { kind: 'picture' };

export interface Para {
  runs: Run[];
  align: 'left' | 'center' | 'right' | 'justify' | 'distribute';
  /** Outline level 0-8 (`lvl`). */
  level: number;
  /** `marL` and `indent` in EMU. */
  marL: Emu;
  indent: Emu;
  spaceBefore?: Spacing;
  spaceAfter?: Spacing;
  lineSpacing?: Spacing;
  /** The effective bullet; undefined = none (`a:buNone`, or nothing sets one). */
  bullet?: Bullet;
  rtl: boolean;
  /** The end-of-paragraph mark's properties (`a:endParaRPr`), resolved: an empty paragraph's size. */
  end: RunStyle;
  /** The nearest bullet setting is an explicit `a:buNone` (`bullet` is then undefined). M2. */
  bulletNone?: boolean;
}

export interface TextBody {
  paras: Para[];
  /** `lIns` `tIns` `rIns` `bIns` in EMU (defaults 91,440 / 45,720). */
  insets: { l: Emu; t: Emu; r: Emu; b: Emu };
  anchor: 'top' | 'middle' | 'bottom';
  /** `wrap="square"` (true) or `"none"`. */
  wrap: boolean;
  autofit:
    | { kind: 'none' }
    | { kind: 'shape' }
    | {
        kind: 'shrink';
        fontScale: number;
        lnSpcReduction: number;
        /** The shape's own `a:bodyPr` says so, not a layout or master placeholder's (M2). */
        own?: boolean;
      };
  /** `vert` when not horizontal (residual until M8). */
  vert?: string;
  numCol?: number;
  /**
   * `anchorCtr` along the bodyPr chain: true when it moves text (residual until M8), false when it changes
   * nothing because every paragraph that draws something is centred (`text.ts`); absent when not set.
   */
  anchorCtr?: boolean;
  /** `a:prstTxWarp prst` when not `textNoShape` (residual). */
  warp?: string;
}

// ── Elements ────────────────────────────────────────────────────────────────────────────────────────────

/** How well ordo reproduces an element (design/27 §5). */
export type Support = 'native' | 'approx' | 'residual';

export interface ElementBase {
  /** `p:cNvPr id` (0 when missing). */
  shapeId: number;
  name: string;
  /** Maps the element's unit square (0..1 × 0..1) to slide EMU, groups composed (`frame.ts`). */
  xf: Affine;
  /** Where the element comes from: the slide itself, or a layout/master decoration. */
  from: 'slide' | 'layout' | 'master';
  /** The placeholder, when it is one (`p:nvPr/p:ph`); type defaults to 'obj' in OOXML when only idx is set. */
  ph?: { type: string; idx?: string };
  /** Flattened group: a number shared by the members of one top-level group on the slide. */
  group?: number;
  /** `cNvPr hidden="1"`: kept for completeness, not drawn. */
  hidden?: boolean;
  support: Support;
  /** Why the element is approximated or residual (short words, e.g. 'gradFill', 'preset:star5'). */
  reasons?: string[];
  /**
   * Part of a SmartArt drawing drawn natively (M6, `smartart.ts`): every element of one graphic frame's
   * drawing has the same number (one per frame among the elements of its `from`, from 1), and the frame's
   * `shapeId`. The elements are a locked group and are drawn natively or by LibreOffice as a whole.
   */
  diagram?: number;
}

/** A `p:sp` or `p:cxnSp`: geometry with a fill and a line, and maybe text. */
export interface ShapeElement extends ElementBase {
  kind: 'shape';
  /** `a:prstGeom prst` ('rect', 'roundRect', 'ellipse', 'line', …), or 'custom' for `a:custGeom`. */
  geom: string;
  /** `a:avLst` guide values (name, value) in the deck's units. */
  adj?: [string, number][];
  fill: Fill;
  line?: Line;
  shadow?: Shadow;
  text?: TextBody;
  /** The XML node, for later milestones (custom geometry, effects). Do not keep it past emission. */
  node?: XNode;
  /**
   * Custom geometry only: the share of the box its paths fill (0-1, curves taken by their end points),
   * when every point could be read. M1 draws the legacy rect only when most of the box is filled.
   */
  coverage?: number;
  /** Custom geometry built (M6, `geom.ts`): its paths, text rectangle and connection sites. */
  custom?: CustomPaths;
  /** `a:glow` (M6): radius in EMU. */
  glow?: { radius: Emu; color: Rgba };
  /** `a:softEdge rad` in EMU (M6). */
  softEdge?: Emu;
  /** A connector's ends glued to shapes (`a:stCxn`, `a:endCxn`; M6): their `cNvPr id` and site index. */
  cxn?: { start?: CxnRef; end?: CxnRef };
}

/** One end of a connector glued to a shape's connection site. */
export interface CxnRef {
  id: number;
  idx: number;
}

/**
 * A custom geometry (`a:custGeom`) built for one shape (M6, `geom.ts`): each path as an SVG-like string in its
 * own space (the deck's `w`/`h`, else the shape's box in logical px), the text rectangle and connection
 * sites in unit-square fractions of the box.
 */
export interface CustomPaths {
  paths: {
    d: string;
    w: number;
    h: number;
    fill?: 'norm' | 'none' | 'lighten' | 'lightenLess' | 'darken' | 'darkenLess';
    stroke?: boolean;
  }[];
  /** Points of all paths (an arc counts its cubic segments' points). */
  points: number;
  /** `a:rect` as fractions of the box: l, t, r, b. */
  text: [number, number, number, number];
  /** `a:cxnLst` as fractions of the box, with the angle a connector leaves at (degrees clockwise). */
  sites: { x: number; y: number; angle: number }[];
  /** The geometry lost parts to its bounds (or a path string over the schema's length): not drawn natively. */
  over?: boolean;
  /** What compiling replaced by 0 or dropped (cleaned, short). */
  notes: string[];
}

/** A `p:pic` (or a picture placeholder filled with one). */
export interface PictureElement extends ElementBase {
  kind: 'picture';
  picture: PictureFill;
  /** The clip geometry (`a:prstGeom` of the picture), 'rect' when none. */
  geom: string;
  line?: Line;
  /** Media the picture is the poster of (`a:videoFile`, `a:audioFile`, `p14:media`; `media.ts`). */
  media?: MediaRef;
  /** `a:avLst` guide values of the clip geometry (a roundRect's corner), as `ShapeElement.adj`. */
  adj?: [string, number][];
  /** A custom clip geometry built (M6, `geom.ts`). */
  custom?: CustomPaths;
}

/**
 * How a clip plays, from the slide's `p:timing` (design/27 §8 "p:timing mapping"; `timing.ts`). Read only for
 * the slide's own media: a clip on a layout or master is shown as its poster.
 */
export interface MediaTiming {
  /**
   * `auto`: a `mediacall` effect starts it after or with the previous one, before the first click of the main
   * sequence; `click`: a click effect, a trigger (`interactiveSeq`), or a play effect after the first click.
   * Undefined when nothing in the timing tree starts it (PowerPoint then shows play controls: a click).
   */
  start?: 'auto' | 'click';
  /** `repeatCount="indefinite"` on the media node. */
  loop: boolean;
  /** "Rewind after playing": the media node's `fill="remove"` (the poster shows again at the end). */
  rewind: boolean;
  /** `p:cMediaNode vol`, 0-100,000, when written. */
  vol?: number;
  /** `mute="1"`. */
  muted: boolean;
  /** `showWhenStopped` (default true; false is PowerPoint's "Hide while not playing"). */
  showWhenStopped: boolean;
  /** `numSld` when more than one: the sound plays on across this many slides (1-999). */
  slides?: number;
  /** `p:video fullScrn="1"`. */
  fullScreen: boolean;
  /** `p:audio isNarration="1"`. */
  narration: boolean;
  /** The media node's element: `p:video` or `p:audio`. */
  kind?: 'video' | 'audio';
}

/** `p14:trim`: milliseconds cut from the start and from the end of the clip (`st`, `end`). */
export interface ClipTrim {
  startMs: number;
  /** PowerPoint stores how much is cut from the end, not where the kept part ends (verified on real decks). */
  endCutMs: number;
}

/** A video or sound a picture is the poster of (design/27 §4 "Media", `media.ts`). */
export interface MediaRef {
  /**
   * What it is: the caller's sniff of the part's bytes when given (`ParseOptions.mediaKind`; pptxgenjs writes
   * sounds under `a:videoFile`), else the element (`a:videoFile`, `a:audioFile`), else the timing node.
   */
  kind: 'video' | 'audio';
  /** The embedded part (a relationship inside the package to a part that exists). */
  part?: string;
  /** A linked clip (`TargetMode="External"`): its host only. It is never fetched. */
  external?: string;
  trim?: ClipTrim;
  /** The slide's timing for it (slide elements only). */
  timing?: MediaTiming;
}

/** Something ordo does not draw natively (chart, table, SmartArt, OLE, maths, ink, 3D, …). */
export interface ResidualElement extends ElementBase {
  kind: 'residual';
  /** 'chart', 'table', 'smartart', 'ole', 'math', 'ink', 'graphicFrame', 'shear', … */
  what: string;
  /**
   * A metafile (`what` 'metafile'): its picture and clip geometry, so the emitter can describe the image
   * object it becomes once LibreOffice has converted it (M3 item D, `EmittedSlide.metafiles`).
   */
  picture?: PictureFill;
  geom?: string;
  adj?: [string, number][];
}

/**
 * A table (`a:tbl` in a `p:graphicFrame`, M6; `tables.ts`): a grid of cells, each with its fill and text,
 * and the lines along the grid. Geometry is in table space: `xf` maps the whole grid (the sum of `cols`
 * by the sum of `rows`) to the slide. A table read as residual is a `ResidualElement` ('table').
 */
export interface TableElement extends ElementBase {
  kind: 'table';
  /** Column widths and row heights in EMU; rows are as tall as their text needs (`tables.ts`). */
  cols: Emu[];
  rows: Emu[];
  /** The fill behind every cell (`a:tblPr`'s own fill, else the style's `a:tblBg`). */
  background?: Fill;
  /** The cells drawn, row by row: each merge once, at its first cell. */
  cells: TableCell[];
  /** The lines along the grid, consecutive pieces of the same look joined. */
  lines: TableLine[];
  /** The ordo objects the table emits (`classify.ts` `slideCost`). */
  objects: number;
}

/** One drawn cell of a table: a merge counts once. */
export interface TableCell {
  row: number;
  col: number;
  /** Rows and columns it spans (`rowSpan`, `gridSpan`), at least 1, inside the grid. */
  rows: number;
  cols: number;
  /** Its fill, the table style and the cell's own resolved (none: the background shows). */
  fill: Fill;
  /** Its text: margins as `insets`, `anchor`; shrinks to fit (`autofit`); no visible text is an empty box. */
  text: TextBody;
}

/** A border line along the grid: a row edge (`h`, edge `at` from column edge `from` to `to`) or a column edge. */
export interface TableLine {
  dir: 'h' | 'v';
  /** The row edge (0 = top) of an `h` line, the column edge (0 = left) of a `v` line. */
  at: number;
  /** Where it starts and ends, in edges across it. */
  from: number;
  to: number;
  line: Line;
}

export type Element = ShapeElement | PictureElement | ResidualElement | TableElement;

// ── Slides and the deck ─────────────────────────────────────────────────────────────────────────────────

/** A slide background, looked up slide → layout → master (design/27 §4 "Backgrounds"). */
export interface Background {
  fill: Fill;
  from: 'slide' | 'layout' | 'master' | 'none';
}

/** Per-slide coverage tiers of the census (design/27 "Why this design", §5). */
export type Tier = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'fallback';
export type SlideClass = 'native' | 'hybrid' | 'picture';

export interface Classification {
  tier: Tier;
  class: SlideClass;
  /** The features that keep the slide out of a lower tier, and anything that made it hybrid or picture. */
  reasons: string[];
  /** Hybrid slides: the art range and what the art holds (design/27 §5 "Slide class"). Added by F. */
  art?: ArtRange;
}

/**
 * The art of a hybrid slide (design/27 §5): one locked, transparent LibreOffice picture placed in the
 * z-order at `from`. Indexes are into `SlideScene.elements` (bottom first).
 */
export interface ArtRange {
  /** Rmin and Rmax: the lowest and the highest residual element. */
  from: number;
  to: number;
  /**
   * The elements baked into the art, bottom first: every residual, and every other element of the range
   * that overlaps an art element above it. Other elements of the range stay native, just above the art;
   * play videos are never in the art.
   */
  elements: number[];
  /** The bounding box of those elements in slide EMU: the art's box. */
  box: RectEmu;
}

export interface SlideScene {
  /** Position in `p:sldIdLst` order (hidden slides included). */
  index: number;
  /** Position among the shown slides; undefined for a hidden slide. */
  shown?: number;
  hidden: boolean;
  /** The slide part, e.g. `ppt/slides/slide3.xml`. */
  part: string;
  layoutPart?: string;
  masterPart?: string;
  background: Background;
  /** Bottom first: master decorations, layout decorations, then the slide's own shapes. */
  elements: Element[];
  classification: Classification;
  /** What was approximated or skipped on this slide (sanitised, short). */
  notes: string[];
  /** Set when the slide could not be read: it is quarantined (class 'picture'), never the deck. */
  error?: string;
  /** Time spent reading this slide, in ms. */
  ms: number;
  /** The transition's sound (`p:transition/p:sndAc/p:stSnd`): imported only with the import option. */
  transitionSound?: { part?: string; external?: string; loop: boolean };
  /** Sounds of animation effects (`p:sndTgt`): never imported (counted for a note). */
  animationSounds?: number;
}

/** A `p14:sectionLst` section. */
export interface SectionInfo {
  name: string;
  /**
   * The slides' places in the deck's order (`SlideScene.index`). Without `ParseOptions.range` these are also
   * indexes into `DeckScene.slides`.
   */
  slides: number[];
}

export interface DeckScene {
  frame: Frame;
  slides: SlideScene[];
  sections: SectionInfo[];
  /** Deck-level notes (sanitised log lines). */
  notes: string[];
}

// ── Hub follow-up (M3) ──────────────────────────────────────────────────────────────────────────────────

/**
 * An element named so that a later step finds it again in the deck without the IR: the render copy keeps
 * exactly the art's elements, the version-2 patch knows what the art replaces (design/27 §5).
 */
export interface ElementRef {
  from: ElementBase['from'];
  /** `p:cNvPr id`. */
  shapeId: number;
  /** Ids repeat in real decks: the place among the elements of `from` with this id, bottom first, from 0. */
  nth: number;
}

/**
 * What a hybrid slide's art holds once the slide is emitted (design/27 §5 "Slide class"): everything the
 * LibreOffice follow-up needs, without the IR. Added by M3 item D (`hybrid.ts`).
 */
export interface ArtInfo {
  /** The elements baked into the art: every residual and the overlapped elements of the range, bottom first. */
  elements: ElementRef[];
  /** The art object's box in logical px (the elements' bounding box). */
  box: { x: number; y: number; w: number; h: number };
  /** Where the art object goes in `Slide.objects` in version 2. */
  at: number;
  /** Ids of the version-1 objects the art replaces (the non-residual elements it bakes in). */
  replaces: string[];
  /** Text of the text bodies baked into the art (`Slide.pptx.artText`, search only). */
  text: string;
  /**
   * The object the art goes just under in version 2 (the first object at or after `at` that it does not
   * replace); absent when the art goes on top. Found by id, so objects added or left out below it by the
   * import do not move the art.
   */
  before?: string;
}
