import type { Box, Rgba, Shadow, TextPara } from '@ordo/domain';

/*
 * Types of ordo's text engine (design/27 §6). The first block is the public contract every drawer uses; the
 * rest is shared between the pipeline stages (README.md says which stage owns which file).
 *
 * Units: every length is in logical px (the 1920x1080 slide), never device px, so 960, 1920 and 3840 wide
 * drawers, the editor and thumbnails break lines identically. Offsets are UTF-16 offsets into
 * `TextObject.text`, the canonical text (never into a case-mapped or joiner-augmented copy).
 */

// ---- Public contract (design/27 §6 "Entry points") ----

/**
 * Measures text at logical size. `font` is a CSS font string for `ctx.font` (from `FontEnv.font`), `dir`
 * and `lang` are set as `ctx.direction` and `ctx.lang`, `spacingPx` as `ctx.letterSpacing`. The result is
 * the advance of `text` without the letter spacing Canvas adds after its last character: a segment that
 * follows on the same line starts `spacingPx` further on.
 */
export interface Measurer {
  width(font: string, dir: 'ltr' | 'rtl', lang: string, spacingPx: number, text: string): number;
}

/**
 * One drawn segment of a line: a maximal substring with one style run, one bidi level and no break
 * opportunity inside (§6 step 4).
 */
export type Seg = {
  /** [start, end) in `TextObject.text`. The drawn string is `segText(...)` of it (segments.ts). */
  start: number;
  end: number;
  /** Left edge, absolute logical x (box rotation not applied), justification included. */
  x: number;
  /** Advance of the drawn string at `sizePx`, trailing whitespace included (it hangs at a line end). */
  w: number;
  /** Index into the (clamped) `TextObject.runs`, or -1 for text outside every run (the box style). */
  run: number;
  /** UAX#9 embedding level: even = left to right, odd = right to left. */
  level: number;
  /** CSS font string for `ctx.font`, at `sizePx` (logical). Measuring and painting use the same string. */
  font: string;
  /** Logical font size drawn: after autofit, and 0.58 × for a raised or lowered run (§6 step 7). */
  sizePx: number;
  /** Baseline offset from the line's baseline, logical px, positive downwards (a superscript is negative). */
  shift: number;
};

export type LaidLine = {
  /** Paragraph index: `text.split('\n')[para]`, `paras[para]`. */
  para: number;
  /** Absolute logical y of the line box's top. */
  top: number;
  /** Absolute logical y of the baseline. */
  baseline: number;
  /** Line pitch (logical px). */
  height: number;
  /** Left edge of the line's content after alignment (bullet excluded), absolute logical x. */
  x: number;
  /** Width of the content without hanging trailing whitespace. */
  w: number;
  /** Segments in visual order, left to right. */
  segs: Seg[];
  /** Justification: extra px after each inter-segment space (already included in the segments' x). */
  extraPerSpace: number;
  /**
   * The paragraph's bullet or number, on its first line only. `x` is the left edge of `text`, drawn in the
   * paragraph's direction `dir` and its first run's `lang`; `run` is that run (index into the clamped
   * `runs`, -1 the box style), whose shadow and outline the bullet takes.
   */
  bullet?: {
    text: string;
    x: number;
    font: string;
    sizePx: number;
    color: Rgba;
    dir?: 'ltr' | 'rtl';
    lang?: string;
    run?: number;
  };
};

export type RichLayout = {
  lines: LaidLine[];
  /** Autofit result (§6 step 10): font and spacing scale actually used; 1 and 1 when not shrunk. */
  fontScale: number;
  spacingScale: number;
  /** The text does not fit the box after autofit (the editor's dashed red edge, §11). */
  overflow: boolean;
  /** Union of the laid lines (logical, rotation 0); the text fill box is it grown by the insets. */
  ink: Box;
};

/** What the font resolver needs to build a CSS font string (design/27 §10). */
export type FaceRequest = {
  /** The run's family: the exact library face comes first. */
  family: string;
  /** `style.fallbackFonts`, in order (metric substitute, ea/cs family, script fallbacks). */
  fallbacks: readonly string[];
  weight: number;
  italic: boolean;
  smallCaps: boolean;
  /** Logical px. */
  sizePx: number;
  /** ISO 15924 code of the segment's script when it needs a script fallback face ('Hebr', 'Arab', ...), else ''. */
  script: string;
};

/**
 * The font environment of a drawer (asset worker, thumbnail worker, editor): turns a face request into a
 * CSS font string built from loaded internal family names (§10).
 */
export interface FontEnv {
  font(req: FaceRequest): string;
  /** Changes whenever a face finishes loading or the face set changes: memoised layouts of an older one are stale. */
  readonly generation: number;
  /**
   * Whether text asked for in `family`, with these `fallbackFonts`, is drawn with the family's own face or a
   * metric-compatible one (Carlito for Calibri), so its lines break where PowerPoint broke them. Only then
   * does PowerPoint's stored autofit scale (`TextStyle.fitScale`) hold; otherwise the text is fitted again
   * from full size, as LibreOffice fits it (§6 step 10, §10). Absent: assumed true (the stored scale is
   * kept). Its answer changes only together with `generation`.
   */
  metricMatch?(family: string, fallbacks: readonly string[]): boolean;
}

// ---- Shared between the pipeline stages ----

/** Style of one style run: the box style with a TextRun's overrides, resolved (itemize.ts). */
export type RunStyle = {
  family: string;
  fallbacks: readonly string[];
  weight: number;
  italic: boolean;
  /** style.fontSizePx × run.sizeScale, within 4-1,000 px; autofit scales it later. */
  sizePx: number;
  color: Rgba;
  highlight: Rgba | null;
  underline: boolean;
  strike: boolean;
  /** Raise (+) or lower (-) as a share of the size: OOXML baseline/100000. */
  baseline: number;
  letterSpacing: number;
  /** 'all' also covers the box's `transform: 'uppercase'`. */
  caps: 'none' | 'all' | 'small';
  outline: { width: number; color: Rgba } | null;
  shadow: Shadow | null;
  /** BCP 47 tag, '' when none. */
  lang: string;
};

/** Paragraph style: `paras[i]` over the box defaults (itemize.ts). */
export type ParaStyle = {
  /** `paras[i].align`, else 'justify' when `style.justify`, else `style.align`. */
  align: 'left' | 'center' | 'right' | 'justify' | 'distribute';
  level: number;
  indentPx: number;
  firstLinePx: number;
  spaceBeforePx: number;
  spaceAfterPx: number;
  /** × single spacing, or null for the box's line spacing. */
  lineSpacing: number | null;
  /** Exact pitch, or null. */
  lineSpacingPx: number | null;
  /** As stored: undefined = not set (no bullet), null = explicitly none, else the bullet. */
  bullet: TextPara['bullet'];
  /** `paras[i].rtl` when set, else `style.direction`, else 'auto' (first strong character). */
  dir: 'ltr' | 'rtl' | 'auto';
  /** Laid out but not painted (M8 split reveal). */
  hidden: boolean;
};

/** A maximal range of one paragraph with one resolved style. */
export type StyleRun = {
  start: number;
  end: number;
  /** Index into `TextObject.runs`, or -1 (box style). */
  run: number;
  style: RunStyle;
};

/** One paragraph after itemizing (§6 step 1). */
export type ItemPara = {
  /** Paragraph index: `text.split('\n')[index]`, `paras[index]`. */
  index: number;
  /** [start, end) in `TextObject.text`, the '\n' excluded. */
  start: number;
  end: number;
  /** PowerPoint a:br: continues the previous paragraph (no bullet, no space before). */
  soft: boolean;
  style: ParaStyle;
  /**
   * Style runs covering [start, end) in order. An empty paragraph has exactly one empty run [start, start)
   * carrying its end-mark style (its size makes the empty line's height).
   */
  runs: StyleRun[];
};

export type Itemized = {
  /** `TextObject.text`. */
  text: string;
  paras: ItemPara[];
};

/** UAX#9 result for one paragraph (bidi.ts). */
export type BidiPara = {
  /** Paragraph embedding level, 'auto' resolved: 0 = LTR, 1 = RTL (where its lines start, §6 step 8). */
  level: 0 | 1;
  /** Level per UTF-16 unit of the paragraph (index = offset - para.start), or null when every unit is at `level`. */
  levels: Uint8Array | null;
};

/** A segment before it is measured and placed (segments.ts). */
export type Piece = {
  start: number;
  end: number;
  /** Where the trailing whitespace begins (`end` when there is none): it hangs at a line end. */
  trail: number;
  /** Index into `ItemPara.runs`. */
  sr: number;
  level: number;
  /** A line may break after this piece. False inside a word (a style or level cut): only an emergency break. */
  breakAfter: boolean;
  /** ISO 15924 code when the piece needs a script fallback face (FaceRequest.script), else ''. */
  script: string;
};

/** One paragraph ready for line breaking (segments.ts `prepare`). */
export type PreparedPara = {
  para: ItemPara;
  bidi: BidiPara;
  /** Logical order. Empty for an empty paragraph. */
  pieces: Piece[];
  /** Style cuts that fell inside a cluster and moved to its end (§6 step 4), for the drawers to report. */
  movedCuts?: number;
};

/** A paragraph's bullet or number before layout (bullets.ts); lines.ts sizes and places it. */
export type BulletSpec = {
  text: string;
  family: string;
  fallbacks: readonly string[];
  weight: number;
  italic: boolean;
  /** × the paragraph's main size F (after autofit). */
  sizePct: number;
  color: Rgba;
  /** The paragraph's first run's language: the label is measured and drawn in it. */
  lang: string;
  /** The paragraph's first run (index into `TextObject.runs`, -1 the box style): shadow and outline. */
  run: number;
};
