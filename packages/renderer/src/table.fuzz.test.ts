import { DEFAULT_LYRIC_STYLE, type ShapeObject, TABLE_LIMITS } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { clampObject } from './clamp.ts';
import type { Ctx2D } from './ctx.ts';
import { drawShape } from './text2d.ts';
import './table/index.ts';
import { clearTableCache, layoutTable } from './table/layout.ts';
import { tableHit } from './table/hit.ts';
import { measurerFor } from './text/measure.ts';
import { LEGACY_FONT_ENV } from './text/fonts.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

/*
 * Hostile tables (design/27 M9, tables-object.md §4.8, plan §9: tables fuzzed within 2 s): random tables and
 * hand-made hostile ones (NaN, 1e300, negative and huge spans, 4,096 cells of 10,000 characters, every palette
 * index out of range, '__proto__' strings, overlapping spans, edges past the grid) are clamped, laid out, hit
 * tested and drawn without a throw, in bounded time.
 */

/** A context that draws nothing and measures 0.5 em a character (enough for layout and the draw path). */
function nullCtx(): Ctx2D {
  const state: Record<string, unknown> = { font: '10px sans-serif', globalAlpha: 1 };
  const noop = () => {};
  const target: Record<string, unknown> = {
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    transform: noop,
    setTransform: noop,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    beginPath: noop,
    rect: noop,
    roundRect: noop,
    moveTo: noop,
    lineTo: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    fillText: noop,
    strokeText: noop,
    clip: noop,
    setLineDash: noop,
    drawImage: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: (s: string) => {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 10);
      return { width: s.length * size * 0.5 } as TextMetrics;
    },
  };
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k as string] : state[k as string]),
    set: (_t, k, v) => {
      state[k as string] = v;
      return true;
    },
  }) as unknown as Ctx2D;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WILD: unknown[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  -1,
  0,
  1.5,
  1e300,
  -1e300,
  '__proto__',
  'constructor',
  null,
  undefined,
  {},
  [],
  true,
  64,
  4096,
  2 ** 31,
];

function shape(table: unknown, box: Partial<ShapeObject['box']> = {}): unknown {
  return {
    id: 'fuzz',
    type: 'shape',
    box: { x: 10, y: 20, w: 900, h: 500, rotation: 0, ...box },
    shape: 'rect',
    fill: { r: 1, g: 2, b: 3, a: 1 },
    opacity: 1,
    radius: 0,
    table,
  };
}

function randomTable(r: () => number): unknown {
  const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)]!;
  const wild = () => (r() < 0.15 ? pick(WILD) : undefined);
  // Mostly bulletin-sized grids; one in twenty past the bounds (300 rows, 80 columns).
  const large = r() < 0.05;
  const R = 1 + Math.floor(r() * (large ? 300 : 8));
  const C = 1 + Math.floor(r() * (large ? 80 : 8));
  const n = Math.floor(r() * R * C * 1.5);
  const cells = [...Array(Math.min(n, 5_000))].map(() => ({
    text: r() < 0.8 ? 'word '.repeat(Math.floor(r() * (large ? 3 : 12))) : wild(),
    runs:
      r() < 0.3
        ? [...Array(Math.floor(r() * 6))].map(() => [
            Math.floor(r() * 40) - 5,
            Math.floor(r() * 50),
            Math.floor(r() * 6) - 1,
          ])
        : wild(),
    paras: r() < 0.2 ? [{ align: pick(['left', 'center', 'x']), indentPx: wild() ?? 10 }, null, 'p'] : wild(),
    style: r() < 0.5 ? Math.floor(r() * 6) - 1 : wild(),
    fill: r() < 0.5 ? Math.floor(r() * 6) - 1 : wild(),
    colSpan: r() < 0.2 ? Math.floor(r() * 12) - 2 : wild(),
    rowSpan: r() < 0.2 ? Math.floor(r() * 12) - 2 : wild(),
    diag: r() < 0.1 ? { down: Math.floor(r() * 4) - 1, up: wild() } : undefined,
  }));
  const edges = (count: number, max: number) =>
    [...Array(count)].map(() =>
      r() < 0.1
        ? pick(WILD)
        : [
            Math.floor(r() * (max + 3)) - 1,
            Math.floor(r() * 10) - 1,
            Math.floor(r() * 12),
            Math.floor(r() * 4) - 1,
          ],
    );
  return {
    cols: [...Array(C)].map(() => (r() < 0.1 ? pick(WILD) : r() * 300)),
    rows: [...Array(R)].map(() => (r() < 0.1 ? pick(WILD) : r() * 100)),
    cells,
    base:
      r() < 0.05 ? pick(WILD) : { ...DEFAULT_LYRIC_STYLE, fontSizePx: r() < 0.1 ? pick(WILD) : 4 + r() * 60 },
    styles: [...Array(Math.floor(r() * 5))].map(() =>
      r() < 0.2
        ? pick(WILD)
        : {
            fontSizePx: wild() ?? 30,
            valign: pick(['top', 'middle', 'bottom', 'x']),
            fontFamily: pick(['A', '__proto__', '']),
          },
    ),
    runStyles: [...Array(Math.floor(r() * 5))].map(() =>
      r() < 0.2 ? pick(WILD) : { fontWeight: wild() ?? 700, sizeScale: wild() ?? 2 },
    ),
    fills: [...Array(Math.floor(r() * 5))].map(() =>
      r() < 0.2
        ? pick(WILD)
        : {
            color: { r: 1, g: 2, b: 3, a: wild() ?? 1 },
            gradient: r() < 0.3 ? { kind: 'radial', stops: wild() } : undefined,
          },
    ),
    lineStyles: [...Array(Math.floor(r() * 4))].map(() =>
      r() < 0.2
        ? pick(WILD)
        : { width: wild() ?? 2, color: { r: 0, g: 0, b: 0, a: 1 }, dash: pick(['dot', 'x', undefined]) },
    ),
    h: r() < 0.1 ? pick(WILD) : edges(Math.floor(r() * 40), R),
    v: r() < 0.1 ? pick(WILD) : edges(Math.floor(r() * 40), C),
    background: r() < 0.5 ? Math.floor(r() * 6) - 1 : wild(),
    rtl: r() < 0.2 ? true : wild(),
    rowRule: pick(['grow', 'fixed', 'x', undefined]),
  };
}

/** Clamps, lays out, hit tests and draws one candidate; never throws. */
function exercise(raw: unknown, ctx: Ctx2D): void {
  const o = clampObject(raw) as ShapeObject | undefined;
  expect(o).toBeDefined();
  drawShape(ctx, o!, 2);
  // The layout the draw made (the same measurer and fonts: memoised).
  const l = o!.table ? layoutTable(measurerFor(ctx), o!, LEGACY_FONT_ENV) : undefined;
  if (l) {
    expect(Number.isFinite(l.height)).toBe(true);
    expect(l.cells.length).toBeLessThanOrEqual(TABLE_LIMITS.grid);
    tableHit(l, l.width / 2, l.height / 2);
    tableHit(l, Number.NaN, -1);
  }
}

describe('table fuzz (M9)', () => {
  it('random and hostile tables are clamped, laid out and drawn within 2 s, never throwing', () => {
    clearTableCache();
    const ctx = nullCtx();
    const t0 = performance.now();
    const r = rng(9_042);
    for (let i = 0; i < 120; i++) exercise(shape(randomTable(r), { rotation: r() * 720 - 360 }), ctx);
    const big = 'x'.repeat(TABLE_LIMITS.cellText);
    // 4,096 cells of 10,000 characters: the table's 60,000 are laid out, the rest are empty.
    exercise(
      shape({
        cols: Array(64).fill(10),
        rows: Array(64).fill(10),
        cells: [...Array(4_096)].map(() => ({ text: big })),
        base: DEFAULT_LYRIC_STYLE,
      }),
      ctx,
    );
    // Every index out of range, spans that overlap and pass the grid, edges past it.
    exercise(
      shape({
        cols: [100, 100, 100],
        rows: [50, 50],
        cells: [
          {
            text: 'a',
            rowSpan: 2,
            colSpan: 3,
            style: 63,
            fill: 63,
            runs: [[0, 1, 255]],
            diag: { down: 31, up: 31 },
          },
          { text: 'b', rowSpan: 256, colSpan: 64 },
          { text: 'c' },
        ],
        base: DEFAULT_LYRIC_STYLE,
        background: 63,
        h: [[256, 0, 256, 31]],
        v: [[256, 0, 256, 31]],
      }),
      ctx,
    );
    // Degenerate boxes and numbers.
    for (const box of [
      { w: 0, h: 0 },
      { w: 1e300, h: Number.NaN },
      { x: -1e9, y: 1e9 },
    ])
      exercise(
        shape(
          {
            cols: [1e300, Number.NaN],
            rows: [-1, 1e300],
            cells: [{ text: 'long words '.repeat(500) }],
            base: DEFAULT_LYRIC_STYLE,
          },
          box,
        ),
        ctx,
      );
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(budgetMs(2_000));
  });
});
