import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShapeObject } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { apply } from './frame.ts';
import { convertDeck, parseDeck } from './index.ts';
import type { Frame, TableElement, TableLine } from './ir.ts';
import { gridObjects } from './tables.ts';
import type { GridCase, GridResult } from './tables.page.test-util.ts';
import { buildDeck, solid, tableFrame, tc, withTableStyles } from './test-util.ts';
import { findChromium } from '../../../tools/find-chromium.ts';

/**
 * A table's lines as one object per look (fidelity round 2) drawn by the renderer in headless Chromium,
 * against one legacy line object per run, as tables were drawn before. drawGeom strokes the sub-paths with
 * flat caps at the same places, so a look's object drawn one run at a time is the legacy lines pixel for
 * pixel; stroked together, as one path, Skia rasterises the stroke as a path and not as a lone segment's
 * rect, so edge pixels differ by a few levels (at most `AA` of 255; `CROSSING` where runs of the one
 * object cross) while the ink stays the same, in the runs' order and in the old order alike (vertical
 * lines still over the horizontal ones they cross).
 * Bundles tables.page.test-util.ts; skipped when no Chromium is found (ORDO_TEST_CHROMIUM, Playwright's,
 * or the system's Google Chrome), as the renderer's browser tests are.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

type Esbuild = {
  build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

/** esbuild is not a dependency of this package; vite (apps/output) depends on it, so resolve it through vite. */
async function loadEsbuild(): Promise<Esbuild> {
  const name = 'esbuild';
  try {
    return (await import(name)) as Esbuild;
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    return (await import(createRequire(fromOutput.resolve('vite')).resolve(name))) as Esbuild;
  }
}

const IN = 914_400;
const ln = (w: number, color: string) =>
  `<a:ln w="${w}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln>`;
const STYLE_ID = '{33333333-4444-5555-6666-777777777777}';
/** A thick dark outline, thin grey lines inside and a red line under the first row. */
const STYLES =
  `<a:tblStyle styleId="${STYLE_ID}" styleName="Chart"><a:wholeTbl><a:tcStyle><a:tcBdr>` +
  ['left', 'right', 'top', 'bottom'].map((k) => `<a:${k}>${ln(38_100, '203040')}</a:${k}>`).join('') +
  ['insideH', 'insideV'].map((k) => `<a:${k}>${ln(9_525, '909090')}</a:${k}>`).join('') +
  `</a:tcBdr></a:tcStyle></a:wholeTbl><a:firstRow><a:tcStyle><a:tcBdr><a:bottom>${ln(28_575, 'C00000')}</a:bottom></a:tcBdr>` +
  `<a:fill>${solid('DDEEFF')}</a:fill></a:tcStyle></a:firstRow></a:tblStyle>`;

const ONE_ID = '{44444444-5555-6666-7777-888888888888}';
/** Every edge one 1.5 pt line: the horizontal and vertical runs in one object. */
const ONE = `<a:tblStyle styleId="${ONE_ID}" styleName="One"><a:wholeTbl><a:tcStyle><a:tcBdr>${['left', 'right', 'top', 'bottom', 'insideH', 'insideV'].map((k) => `<a:${k}>${ln(19_050, '304050')}</a:${k}>`).join('')}</a:tcBdr></a:tcStyle></a:wholeTbl></a:tblStyle>`;
/** Edge pixels of a look stroked as one path differ from its runs stroked one by one by at most this. */
const AA = 12;
/**
 * Where two runs of one object cross (a table of one look), an edge pixel both cover was composited twice
 * by separate lines, up to a quarter more ink (coverage a + b - ab of what is a for the path); the path
 * covers it once.
 */
const CROSSING = 64;

/** A chart table at a place that is no whole pixel: merges, a fill, uneven columns. */
function chart(x: number, y: number, style = STYLE_ID): string {
  const cols = [1.37 * IN, 0.91 * IN, 1.13 * IN, 0.77 * IN];
  const cell = (r: number, c: number) =>
    r === 2 && c === 1
      ? tc('wide', { attrs: 'gridSpan="2"' })
      : r === 2 && c === 2
        ? tc('', { attrs: 'hMerge="1"' })
        : r === 3 && c === 0
          ? tc('tall', { attrs: 'rowSpan="2"' })
          : r === 4 && c === 0
            ? tc('', { attrs: 'vMerge="1"' })
            : tc(`${r}${c}`);
  const rows = Array.from({ length: 5 }, (_, r) => ({
    h: 0.413 * IN,
    cells: cols.map((_, c) => cell(r, c)),
  }));
  return tableFrame({
    id: 7,
    x: Math.round(x),
    y: Math.round(y),
    cols: cols.map(Math.round),
    rows: rows.map((r) => ({ ...r, h: Math.round(r.h) })),
    tblPr: `<a:tblPr firstRow="1"><a:tableStyleId>${style}</a:tableStyleId></a:tblPr>`,
  });
}

const turned = (rot: number, inner: string) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm rot="${rot}"><a:off x="0" y="0"/><a:ext cx="${8 * IN}" cy="${4 * IN}"/><a:chOff x="0" y="0"/><a:chExt cx="${8 * IN}" cy="${4 * IN}"/></a:xfrm></p:grpSpPr>${inner}</p:grpSp>`;

/**
 * The table's lines as they were drawn before round 2: a legacy 'line' object per run (the removed
 * `lineShape`), from `a` to `b` stretched by half the widest line it meets at each end, in `runs`' order.
 */
function lineObjects(f: Frame, e: TableElement, runs: readonly TableLine[], stroke: ShapeObject['stroke']) {
  const W = e.cols.reduce((s, w) => s + w, 0);
  const H = e.rows.reduce((s, h) => s + h, 0);
  const xs = [0];
  for (const w of e.cols) xs.push(xs[xs.length - 1]! + w);
  const ys = [0];
  for (const h of e.rows) ys.push(ys[ys.length - 1]! + h);
  return runs.map((l, i): ShapeObject => {
    const across = (k: number) => {
      let w = 0;
      for (const o of e.lines)
        if (o.dir !== l.dir && o.at === k && o.from <= l.at && l.at <= o.to) w = Math.max(w, o.line.width);
      return w;
    };
    const a = l.dir === 'h' ? [xs[l.from]! / W, ys[l.at]! / H] : [xs[l.at]! / W, ys[l.from]! / H];
    const b = l.dir === 'h' ? [xs[l.to]! / W, ys[l.at]! / H] : [xs[l.at]! / W, ys[l.to]! / H];
    const [x0, y0] = apply(e.xf, a[0]!, a[1]!);
    const [x1, y1] = apply(e.xf, b[0]!, b[1]!);
    let px0 = f.x0 + x0 * f.s;
    let py0 = f.y0 + y0 * f.s;
    let px1 = f.x0 + x1 * f.s;
    let py1 = f.y0 + y1 * f.s;
    const len = Math.hypot(px1 - px0, py1 - py0);
    const ux = (px1 - px0) / len;
    const uy = (py1 - py0) / len;
    px0 -= (ux * across(l.from) * f.s) / 2;
    py0 -= (uy * across(l.from) * f.s) / 2;
    px1 += (ux * across(l.to) * f.s) / 2;
    py1 += (uy * across(l.to) * f.s) / 2;
    const full = Math.hypot(px1 - px0, py1 - py0);
    const rot = (Math.atan2(py1 - py0, px1 - px0) * 180) / Math.PI;
    return {
      id: `l${i}`,
      type: 'shape',
      box: {
        x: (px0 + px1) / 2 - full / 2,
        y: (py0 + py1) / 2,
        w: full,
        h: 0,
        rotation: Math.abs(rot) < 1e-9 ? 0 : rot,
      },
      shape: 'line',
      stroke: stroke!,
      opacity: 1,
      radius: 0,
    };
  });
}

/** The grid line objects of a one-table slide, and the same lines as one legacy object per run. */
function linesBothWays(shapes: string): {
  grouped: ShapeObject[];
  perRun: ShapeObject[];
  oldOrder: ShapeObject[];
  oneByOne: ShapeObject[];
} {
  const parts = withTableStyles(buildDeck({ slides: [{ shapes }] }), STYLES + ONE);
  const scene = parseDeck(parts);
  const e = scene.slides[0]!.elements.find((x): x is TableElement => x.kind === 'table')!;
  const out = convertDeck(withTableStyles(buildDeck({ slides: [{ shapes }] }), STYLES + ONE));
  const grouped = out.slides[0]!.slide.objects.filter(
    (o): o is ShapeObject => o.type === 'shape' && o.stroke !== undefined && o.geom !== undefined,
  );
  const groups = gridObjects(e.cells, e.lines).lines;
  expect(groups).toHaveLength(grouped.length);
  const perRun = groups.flatMap((g, k) =>
    lineObjects(
      scene.frame,
      e,
      g.paths.flatMap((p) => p.runs),
      grouped[k]!.stroke,
    ),
  );
  const strokeOf = new Map(groups.map((g, k) => [JSON.stringify(g.line), grouped[k]!.stroke]));
  const oldOrder = e.lines.flatMap((l) =>
    lineObjects(scene.frame, e, [l], strokeOf.get(JSON.stringify(l.line))),
  );
  // Each look's sub-paths as objects of one sub-path each, in its order.
  const oneByOne = grouped.flatMap((o) =>
    o.geom!.paths!.flatMap((p) =>
      p.d
        .split('M ')
        .filter(Boolean)
        .map((d, i) => ({
          ...o,
          id: `${o.id}-${i}`,
          geom: { paths: [{ ...p, d: `M ${d.trim()}`, cont: false }] },
        })),
    ),
  );
  return { grouped, perRun, oldOrder, oneByOne };
}

const executablePath = await findChromium();

describe.skipIf(!executablePath)('table grid objects in headless Chromium', () => {
  it('draws opaque lines as one line object per run did: pixel for pixel run by run, edges within AA', async () => {
    const sets = [
      ['flat', linesBothWays(chart(0.613 * IN, 0.287 * IN))],
      ['turned 25°', linesBothWays(turned(1_500_000, chart(2.1 * IN, 0.9 * IN)))],
      ['one look', linesBothWays(chart(0.613 * IN, 0.287 * IN, ONE_ID))],
    ] as const;
    // The outline and the inside lines both ways, then the first row's line: five objects; one for one look.
    expect(sets.map(([, s]) => s.grouped.length)).toEqual([5, 5, 1]);
    const cases: GridCase[] = [];
    for (const [what, set] of sets)
      for (const scale of [1, 2, 0.5]) {
        const w = Math.ceil(1_000 * scale);
        const h = Math.ceil(700 * scale);
        const at = { w, h, scale };
        cases.push({ what: `${what} at ${scale}: run by run`, ...at, a: set.oneByOne, b: set.perRun });
        cases.push({ what: `${what} at ${scale}: as the runs`, ...at, a: set.grouped, b: set.perRun });
        cases.push({ what: `${what} at ${scale}: in the old order`, ...at, a: set.grouped, b: set.oldOrder });
      }
    const esbuild = await loadEsbuild();
    const built = await esbuild.build({
      entryPoints: [join(here, 'tables.page.test-util.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2022',
      absWorkingDir: root,
      logLevel: 'silent',
    });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath });
    let results: GridResult[];
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({ content: built.outputFiles[0]!.text });
      results = await page.evaluate(
        (c) => (globalThis as unknown as { __tableGrid: (c: GridCase[]) => GridResult[] }).__tableGrid(c),
        cases,
      );
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
    for (const r of results) expect(r.inked, r.what).toBeGreaterThan(1_000);
    const report = (r: GridResult) => `${r.what}: ${r.differing} px, ±${r.maxDelta}`;
    // Run by run: the same pixels (a turned table's within 3 levels: its box is placed by a rotation).
    expect(
      results
        .filter((r) => r.what.includes('run by run') && r.maxDelta > (r.what.startsWith('turned') ? 3 : 0))
        .map(report),
    ).toEqual([]);
    // Stroked together: only edge pixels move, by a few levels (and where runs of one look cross, by what
    // drawing them twice added), and the ink is the same within 1 %.
    expect(
      results
        .filter(
          (r) =>
            r.maxDelta > (r.what.startsWith('one look') ? CROSSING : AA) ||
            Math.abs(r.inkA - r.inkB) > 0.01 * r.inkB,
        )
        .map((r) => `${report(r)}, ink ${r.inkA} against ${r.inkB}`),
    ).toEqual([]);
  }, 120_000);
});
