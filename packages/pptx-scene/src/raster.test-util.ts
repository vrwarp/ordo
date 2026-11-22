/**
 * Synthetic IR for the tests of the shape pictures (`raster-plan.test.ts`, `raster-emit.test.ts`): elements the walk
 * would leave on a slide, built by hand so that no deck is parsed. `shapeEl` is a plain shape, `candEl` a
 * custom-path shape with the candidate record the walk (step 5 of the track) writes. Shared by the tests of the
 * planner and of the emitter: add helpers, keep the existing ones' output stable.
 *
 * One inch is 144 logical px on the default 16:9 slide (12,192,000 x 6,858,000 EMU); every box below is in inches.
 */
import { frameOf } from './frame.ts';
import type { CustomPaths, Element, Frame, PictureElement, ShapeElement } from './ir.ts';
import type { RasterCandidate, RasterElement } from './raster-plan.ts';
import { custGeom } from './test-util.ts';
import { parseXml, type XNode } from './xml.ts';

export const IN = 914_400;
export const FRAME: Frame = frameOf(12_192_000, 6_858_000);

/** One `a:path` of `cost` points (a moveTo, `cost - 2` lnTo, a close) in a 100 x 100 space, as XML. */
export function polyPathXml(cost: number, phase = 0): string {
  const pt = (i: number) => {
    const a = (2 * Math.PI * i) / Math.max(1, cost - 1) + phase * 0.01;
    return `<a:pt x="${Math.round(50 + 50 * Math.cos(a))}" y="${Math.round(50 + 50 * Math.sin(a))}"/>`;
  };
  let d = `<a:moveTo>${pt(0)}</a:moveTo>`;
  for (let i = 1; i <= cost - 2; i++) d += `<a:lnTo>${pt(i)}</a:lnTo>`;
  return `<a:path w="100" h="100">${d}<a:close/></a:path>`;
}

const nodes = new Map<string, XNode>();
/**
 * An `a:custGeom` node of one path of `cost` points (the planner never reads or changes a node, so one is shared by
 * every shape of the same cost: a test of 20,000 candidates builds one).
 */
export function custNode(cost: number, phase = 0): XNode {
  const key = `${cost}:${phase}`;
  let n = nodes.get(key);
  if (!n)
    nodes.set(key, (n = parseXml(custGeom({ paths: polyPathXml(cost, phase) }), 'raster.test-util')[0]!));
  return n;
}

/** Affine of a box in inches: the unit square to slide EMU. */
export function xfOf(
  x: number,
  y: number,
  w: number,
  h: number,
): [number, number, number, number, number, number] {
  return [w * IN, 0, 0, h * IN, x * IN, y * IN];
}

let nextId = 2;
/** Restart the ids a test gives its shapes (ids repeat across slides; a test sets them when it matters). */
export function resetIds(first = 2): void {
  nextId = first;
}

/** A plain shape element: a preset rect, a solid fill, no text, native. */
export function shapeEl(
  o: Partial<ShapeElement> & { box?: [number, number, number, number] } = {},
): ShapeElement {
  const { box, ...rest } = o;
  const [x, y, w, h] = box ?? [1, 1, 0.5, 0.5];
  return {
    kind: 'shape',
    shapeId: nextId++,
    name: '',
    xf: xfOf(x, y, w, h),
    from: 'slide',
    support: 'native',
    geom: 'rect',
    fill: { kind: 'solid', color: { r: 40, g: 120, b: 200, a: 1 } },
    ...rest,
  };
}

/** What `customPaths` gives a shape drawn natively: one stored path, `points` points. */
export function builtCustom(points: number, over = false): CustomPaths {
  return {
    paths: over ? [] : [{ d: 'M 0 0 L 100 0 L 100 100 L 0 100 Z', w: 100, h: 100 }],
    points,
    text: [0, 0, 1, 1],
    sites: [],
    notes: [],
    ink: 1,
    ...(over ? { over: true } : {}),
  };
}

/**
 * A custom-path shape over 128 points the way the walk leaves it (C-SR2): a candidate record with its raw cost,
 * the `a:custGeom` node and what the converter gives it today. `reasons` and `support` are the walk's for a
 * shape past a limit (residual, 'custGeom') when `limit`, native otherwise.
 */
export function candEl(
  o: Partial<RasterElement> & {
    box?: [number, number, number, number];
    cost?: number;
    why?: RasterCandidate['why'];
    todayPoints?: number;
    times?: number;
    limit?: boolean;
    node?: XNode;
  } = {},
): RasterElement {
  const { box, cost = 300, why = 'points', todayPoints, times = 1, limit = false, node, ...rest } = o;
  const [x, y, w, h] = box ?? [1, 1, 0.5, 0.5];
  const today = builtCustom(todayPoints ?? Math.min(cost, 4_096), limit);
  const el: RasterElement = {
    ...shapeEl({
      box: [x, y, w, h],
      geom: 'custom',
      ...(limit ? { support: 'residual' as const, reasons: ['custGeom'] } : {}),
    }),
    custom: today,
    rasterOf: {
      raw: cost,
      why: limit ? 'limit' : why,
      times,
      today,
      node: node ?? custNode(Math.min(cost, 2_000)),
    },
    ...rest,
  };
  return el;
}

/** A small custom-path shape (128 points or fewer): no candidate record, its stored paths built. */
export function smallEl(
  o: Partial<ShapeElement> & { box?: [number, number, number, number]; points?: number } = {},
) {
  const { points = 30, ...rest } = o;
  return shapeEl({ geom: 'custom', custom: builtCustom(points), ...rest });
}

/** A text body with one paragraph of `words`. */
export function textBody(words: string): NonNullable<ShapeElement['text']> {
  const style = {
    sizePt: 24,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    fill: { kind: 'solid' as const, color: { r: 0, g: 0, b: 0, a: 1 } },
    baseline: 0,
    spacingPt: 0,
    caps: 'none' as const,
  };
  return {
    paras: [
      {
        runs: [{ kind: 'text', text: words, style }],
        align: 'left',
        level: 0,
        marL: 0,
        indent: 0,
        rtl: false,
        end: style,
      },
    ],
    insets: { l: 91_440, t: 45_720, r: 91_440, b: 45_720 },
    anchor: 'top',
    wrap: true,
    autofit: { kind: 'none' },
  };
}

/** A plain picture element (`p:pic`), native. */
export function pictureEl(
  o: Partial<PictureElement> & { box?: [number, number, number, number] } = {},
): PictureElement {
  const { box, ...rest } = o;
  const [x, y, w, h] = box ?? [1, 1, 0.5, 0.5];
  return {
    kind: 'picture',
    shapeId: nextId++,
    name: '',
    xf: xfOf(x, y, w, h),
    from: 'slide',
    support: 'native',
    picture: { part: 'ppt/media/image1.png' },
    geom: 'rect',
    ...rest,
  };
}

/** A row of `n` neighbouring candidates, each 0.4 in wide in a row at `y`, `gap` inches apart. */
export function row(
  n: number,
  y = 1,
  opts: { cost?: number; gap?: number; x?: number } = {},
): RasterElement[] {
  const gap = opts.gap ?? 0.1;
  return Array.from({ length: n }, (_, k) =>
    candEl({ box: [(opts.x ?? 0.2) + k * (0.4 + gap), y, 0.4, 0.4], cost: opts.cost ?? 300 }),
  );
}

/** Every element of a list as the IR's `Element`. */
export const asElements = (list: readonly RasterElement[] | readonly Element[]): Element[] =>
  [...list] as Element[];
