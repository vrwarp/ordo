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
   * transparent colour); undefined when the header did not tell.
   */
  px?: { w: number; h: number; alpha?: boolean };
}

export interface Line {
  /** Line width in EMU (`a:ln w`; 12,700 = 1 pt). */
  width: Emu;
  fill: Fill;
  /** `a:prstDash val`, when not solid. */
  dash?: string;
  head?: string;
  tail?: string;
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
  | { kind: 'char'; char: string; font?: string; color?: Rgba; sizePct?: number }
  | { kind: 'auto'; scheme: string; startAt: number; font?: string; color?: Rgba; sizePct?: number }
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
    | { kind: 'shrink'; fontScale: number; lnSpcReduction: number };
  /** `vert` when not horizontal (residual until M8). */
  vert?: string;
  numCol?: number;
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
}

/** A `p:pic` (or a picture placeholder filled with one). */
export interface PictureElement extends ElementBase {
  kind: 'picture';
  picture: PictureFill;
  /** The clip geometry (`a:prstGeom` of the picture), 'rect' when none. */
  geom: string;
  line?: Line;
  /** Media the picture is the poster of (`a:videoFile`, `a:audioFile`, `p14:media`): M5. */
  media?: { kind: 'video' | 'audio'; part?: string; external?: string };
  /** `a:avLst` guide values of the clip geometry (a roundRect's corner), as `ShapeElement.adj`. */
  adj?: [string, number][];
}

/** Something ordo does not draw natively (chart, table, SmartArt, OLE, maths, ink, 3D, …). */
export interface ResidualElement extends ElementBase {
  kind: 'residual';
  /** 'chart', 'table', 'smartart', 'ole', 'math', 'ink', 'graphicFrame', 'shear', … */
  what: string;
}

export type Element = ShapeElement | PictureElement | ResidualElement;

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
}
