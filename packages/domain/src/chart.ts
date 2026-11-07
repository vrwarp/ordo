import { z } from 'zod';
import type { Gradient, LineDash, Rgba, TextPara, TextRun } from './schemas.ts';

/*
 * A chart drawn by ordo (design/27 M9, `ShapeObject.chart`): the series, axes, titles, legend and labels of a
 * PowerPoint chart, with every colour and text style resolved at import, laid out by the renderer at draw
 * time. Indices refer to the chart's own palettes (`fills`, `lines`, `texts`, `fmts`).
 *
 * `schemas.ts` imports this file (the chart is a field of `ShapeObject`), so this file cannot import the
 * schemas it builds on; `chartSchemas` takes them from `schemas.ts` instead, and the schemas are exported
 * from there (`ChartData`, `ChartSeries`, …). Every enum `.catch`es to its default, and every array, string
 * and number is bounded.
 */

export const CHART_LIMITS = {
  /** Schema bounds; the converter writes at most 32 series of 512 points and 2,048 cells. */
  series: 64,
  points: 1_024,
  cells: 4_096,
  groups: 4,
  axes: 4,
  /** Characters of a series name, a category, an axis label. */
  label: 255,
  /** Characters of a title. */
  title: 1_000,
  fills: 128,
  lines: 64,
  texts: 16,
  fmts: 16,
  /** Per-point formatting overrides of one series (`c:dPt`, `c:dLbl`). */
  overrides: 1_024,
} as const;

/** The stored schemas a chart is built from, as `schemas.ts` defines them. */
export type ChartParts = {
  Rgba: typeof Rgba;
  /** A logical px length, 0 .. 100,000. */
  length: z.ZodNumber;
  Gradient: typeof Gradient;
  LineDash: typeof LineDash;
  TextRun: typeof TextRun;
  TextPara: typeof TextPara;
};

/** The chart schemas over `schemas.ts`'s own pieces (called once, there). */
export function chartSchemas({ Rgba, length, Gradient, LineDash, TextRun, TextPara }: ChartParts) {
  const ix = (n: number) =>
    z
      .number()
      .int()
      .min(0)
      .max(n - 1);
  /** Manual layout: fractions of the chart box. */
  const at = z.number().min(-1).max(2);
  /** A finite number (zod 4 numbers are finite). */
  const num = z.number().min(-1e300).max(1e300);
  /** A value; null = no point (`blanks` decides how it draws). */
  const pt = num.nullable();

  /** A fill: `color` is the solid colour, or a gradient's first stop. */
  const ChartFill = z.object({ color: Rgba, gradient: Gradient.optional() });
  const ChartLine = z.object({
    width: length,
    color: Rgba,
    dash: LineDash.catch('solid').optional(),
    cap: z.enum(['flat', 'round', 'square']).catch('flat').optional(),
    join: z.enum(['round', 'bevel', 'miter']).catch('round').optional(),
  });
  /** A text style, resolved (txPr chain, then the chart space's txPr, then the style defaults); logical px. */
  const ChartText = z.object({
    fontFamily: z.string().max(300),
    fontSizePx: z.number().min(1).max(1_000),
    fontWeight: z.number().min(0).max(1000).optional(),
    fontStyle: z.enum(['normal', 'italic']).catch('normal').optional(),
    color: Rgba,
    underline: z.boolean().optional(),
    fallbackFonts: z.array(z.string().max(300)).max(8).optional(),
    lang: z.string().max(35).optional(),
    /** Degrees (a:bodyPr rot / 60,000) when the deck sets one. */
    rot: z.number().min(-90).max(90).optional(),
  });
  const ChartBox = z.object({
    fill: ix(CHART_LIMITS.fills).optional(),
    line: ix(CHART_LIMITS.lines).optional(),
  });
  /** Data labels (`c:dLbls`) of a group, a series or a point. */
  const ChartLabels = z.object({
    show: z.array(z.enum(['value', 'percent', 'category', 'series', 'size']).catch('value')).max(5),
    pos: z
      .enum(['bestFit', 'ctr', 'inEnd', 'inBase', 'outEnd', 't', 'b', 'l', 'r'])
      .catch('bestFit')
      .optional(),
    sep: z.string().max(16).optional(),
    /** showLegendKey */
    key: z.boolean().optional(),
    fmt: ix(CHART_LIMITS.fmts).optional(),
    text: ix(CHART_LIMITS.texts).optional(),
    box: ChartBox.optional(),
  });
  const ChartMarker = z.object({
    symbol: z
      .enum(['none', 'circle', 'square', 'diamond', 'triangle', 'x', 'star', 'dash', 'dot', 'plus'])
      .catch('square'),
    /** Points, as c:size (× `ChartData.unit` px). */
    size: z.number().int().min(2).max(72),
    fill: ix(CHART_LIMITS.fills).optional(),
    line: ix(CHART_LIMITS.lines).optional(),
  });
  /** A point's own formatting (`c:dPt`) and label (`c:dLbl`): sparse, sorted by point index. */
  const ChartPoint = z.tuple([
    z
      .number()
      .int()
      .min(0)
      .max(CHART_LIMITS.points - 1),
    z.object({
      fill: ix(CHART_LIMITS.fills).optional(),
      line: ix(CHART_LIMITS.lines).optional(),
      explode: z.number().min(0).max(4).optional(),
      marker: ChartMarker.optional(),
      /** null: this point's label is deleted. */
      labels: ChartLabels.nullable().optional(),
    }),
  ]);
  const ChartSeries = z.object({
    name: z.string().max(CHART_LIMITS.label).optional(),
    values: z.array(pt).max(CHART_LIMITS.points),
    /** Scatter and bubble x values. */
    x: z.array(pt).max(CHART_LIMITS.points).optional(),
    /** Bubble sizes. */
    size: z.array(pt).max(CHART_LIMITS.points).optional(),
    fill: ix(CHART_LIMITS.fills).optional(),
    line: ix(CHART_LIMITS.lines).optional(),
    marker: ChartMarker.optional(),
    smooth: z.boolean().optional(),
    /** c:explosion / 100 */
    explode: z.number().min(0).max(4).optional(),
    invertNeg: z.boolean().optional(),
    points: z.array(ChartPoint).max(CHART_LIMITS.overrides).optional(),
    labels: ChartLabels.optional(),
    /** The value cache's formatCode. */
    fmt: ix(CHART_LIMITS.fmts).optional(),
    /** 1: on the secondary axes. */
    set: z.number().int().min(0).max(1).optional(),
    /** false: a c:legendEntry deletes it from the legend. */
    legend: z.boolean().optional(),
  });
  const ChartGroup = z.object({
    kind: z
      .enum(['bar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'radar', 'bubble', 'stock'])
      .catch('bar'),
    dir: z.enum(['col', 'bar']).catch('col').optional(),
    grouping: z.enum(['clustered', 'stacked', 'percent', 'standard']).catch('standard').optional(),
    /** c:gapWidth (default 150) */
    gap: z.number().min(0).max(500).optional(),
    overlap: z.number().min(-100).max(100).optional(),
    /** A doughnut's hole, % of the radius (c:holeSize). */
    hole: z.number().min(0).max(90).optional(),
    firstAngle: z.number().min(0).max(360).optional(),
    vary: z.boolean().optional(),
    /** Scatter and radar. */
    style: z.enum(['line', 'marker', 'smooth', 'filled', 'none']).catch('marker').optional(),
    /** The 2.5-D depth of pie3D and bar3D (view3D). */
    depth: z.number().min(0).max(2).optional(),
    extras: z
      .array(z.enum(['dropLines', 'hiLow', 'upDown']).catch('dropLines'))
      .max(3)
      .optional(),
    series: z.array(ChartSeries).min(1).max(CHART_LIMITS.series),
    labels: ChartLabels.optional(),
  });
  /** Rich text as a TextObject has it. */
  const ChartTitle = z.object({
    text: z.string().max(CHART_LIMITS.title),
    runs: z.array(TextRun).max(64).optional(),
    paras: z.array(TextPara.nullable()).max(16).optional(),
    style: ix(CHART_LIMITS.texts),
    box: ChartBox.optional(),
    /** The manual top-left (edge mode). */
    at: z.object({ x: at, y: at }).optional(),
    overlay: z.boolean().optional(),
  });
  const tick = z.enum(['none', 'in', 'out', 'cross']).catch('none').optional();
  const ChartAxis = z.object({
    dim: z.enum(['x', 'y']).catch('y'),
    set: z.number().int().min(0).max(1).optional(),
    kind: z.enum(['cat', 'val', 'date']).catch('val'),
    pos: z.enum(['b', 'l', 'r', 't']).catch('l'),
    /** c:delete (its gridlines are still drawn). */
    hidden: z.boolean().optional(),
    min: num.optional(),
    max: num.optional(),
    major: num.optional(),
    minor: num.optional(),
    log: z.number().min(2).max(1000).optional(),
    /** orientation maxMin */
    reverse: z.boolean().optional(),
    crosses: z.enum(['autoZero', 'min', 'max']).catch('autoZero').optional(),
    crossesAt: num.optional(),
    /** crossBetween between (false: midCat). */
    between: z.boolean().optional(),
    labels: z.enum(['nextTo', 'low', 'high', 'none']).catch('nextTo').optional(),
    majorTick: tick,
    minorTick: tick,
    grid: ix(CHART_LIMITS.lines).optional(),
    minorGrid: ix(CHART_LIMITS.lines).optional(),
    line: ix(CHART_LIMITS.lines).optional(),
    text: ix(CHART_LIMITS.texts).optional(),
    fmt: ix(CHART_LIMITS.fmts).optional(),
    /** c:tickLblSkip */
    skip: z.number().int().min(1).max(1000).optional(),
    /** The display units' divisor. */
    units: num.optional(),
    title: ChartTitle.optional(),
  });
  const ChartData = z.object({
    /** Logical px per point at import (2 on 16:9 and 4:3 decks): converts LibreOffice's layout lengths. */
    unit: z.number().min(0.01).max(100),
    categories: z.array(z.string().max(CHART_LIMITS.label)).max(CHART_LIMITS.points).optional(),
    /** A second category level: [first category index, label]. */
    outer: z
      .array(
        z.tuple([
          z
            .number()
            .int()
            .min(0)
            .max(CHART_LIMITS.points - 1),
          z.string().max(CHART_LIMITS.label),
        ]),
      )
      .max(CHART_LIMITS.points)
      .optional(),
    groups: z.array(ChartGroup).min(1).max(CHART_LIMITS.groups),
    axes: z.array(ChartAxis).max(CHART_LIMITS.axes).optional(),
    title: ChartTitle.optional(),
    legend: z
      .object({
        pos: z.enum(['r', 'l', 't', 'b', 'tr']).catch('r'),
        overlay: z.boolean().optional(),
        at: z.object({ x: at, y: at, w: at.optional(), h: at.optional() }).optional(),
        text: ix(CHART_LIMITS.texts),
        box: ChartBox.optional(),
      })
      .optional(),
    plot: z
      .object({
        at: z.object({ x: at, y: at, w: at, h: at, inner: z.boolean() }).optional(),
        box: ChartBox.optional(),
      })
      .optional(),
    /** The chart space's own fill and line. */
    area: ChartBox.optional(),
    /** c:roundedCorners */
    rounded: z.boolean().optional(),
    blanks: z.enum(['gap', 'zero', 'span']).catch('gap').optional(),
    /** A data table under the plot (c:dTable). */
    table: z.object({ h: z.boolean(), v: z.boolean(), outline: z.boolean(), keys: z.boolean() }).optional(),
    fills: z.array(ChartFill).max(CHART_LIMITS.fills),
    lines: z.array(ChartLine).max(CHART_LIMITS.lines),
    /** [0] is the chart's base text style. */
    texts: z.array(ChartText).min(1).max(CHART_LIMITS.texts),
    /** Number format codes. */
    fmts: z.array(z.string().max(64)).max(CHART_LIMITS.fmts).optional(),
    /** c:lang: the decimal and group separators. */
    lang: z.string().max(35).optional(),
    date1904: z.boolean().optional(),
  });
  return {
    ChartFill,
    ChartLine,
    ChartText,
    ChartBox,
    ChartLabels,
    ChartMarker,
    ChartPoint,
    ChartSeries,
    ChartGroup,
    ChartTitle,
    ChartAxis,
    ChartData,
  };
}
