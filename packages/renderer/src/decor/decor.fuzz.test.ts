import { DECOR_LIMITS, type ShapeObject } from '@ordo/domain';
import { m9Decor } from '@ordo/domain/m9.test-util.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clampDecorData as clampDecor } from './clamp.ts';
import { RecPath } from '../geom/path2d.test-util.ts';
import { drawShape } from '../text2d.ts';
import { traceCtx } from '../trace.test-util.ts';
import { decorCost, decorReach, decorShapes, drawDecorRange } from './draw.ts';
import { clearDecorFiles, putDecorFile, readDecorFiles } from './files.ts';
// Registers the drawer with the shape dispatch.
import './index.ts';

/*
 * Fuzz test of decorations (design/27 M9, plan §9: 1.5 s on a developer machine, `budgetMs`): mutated and
 * random decorations, valid ones made hostile field by field, through the clamp, the shape builder, the cost,
 * the reach, the drawer and its ranges; and hostile decoration files through the files' store. Nothing throws,
 * every clamped decoration stays within DECOR_LIMITS, and the run stays within its time.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterAll(() => vi.unstubAllGlobals());

/** A small deterministic generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY: unknown[] = [
  undefined,
  null,
  0,
  -1,
  1e308,
  -1e308,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  '',
  'M',
  'M 1e999 0 L 0 0',
  'M 0 0 C 1 2 3',
  'Z Z Z',
  [],
  {},
  [1, 2, 3, 4, 5],
  { length: 1e9 },
  'x'.repeat(50_000),
  true,
  { r: 300, g: -5, b: 'x', a: 9 },
];

function path(r: () => number, n: number): string {
  let s = `M ${Math.round(r() * 2000 - 500)} ${Math.round(r() * 1200 - 100)}`;
  for (let i = 0; i < n; i++) {
    const k = r();
    const p = () => `${Math.round(r() * 2000 - 500)} ${Math.round(r() * 1200 - 100)}`;
    s += k < 0.5 ? ` L ${p()}` : k < 0.8 ? ` C ${p()} ${p()} ${p()}` : k < 0.95 ? ` Q ${p()} ${p()}` : ' Z';
  }
  return s;
}

function randomDecor(r: () => number): unknown {
  const paints = Array.from({ length: 1 + Math.floor(r() * 80) }, () => {
    const p: Record<string, unknown> = {};
    if (r() < 0.6) p.fill = { r: r() * 255, g: r() * 255, b: r() * 255, a: r() };
    if (r() < 0.3)
      p.gradient = {
        kind: r() < 0.5 ? 'radial' : 'linear',
        angle: r() * 720 - 360,
        stops: [
          { at: r(), color: { r: 0, g: 0, b: 0, a: 1 } },
          { at: r(), color: { r: 255, g: 255, b: 255, a: r() } },
        ],
      };
    if (r() < 0.4) p.stroke = { width: r() * 10, color: { r: 0, g: 0, b: 0, a: 1 } };
    if (r() < 0.2) p.dash = r() < 0.5 ? 'sysDot' : 'dash';
    if (r() < 0.2)
      p.shadow = { dx: r() * 10, dy: r() * 10, blur: r() * 20, color: { r: 0, g: 0, b: 0, a: 0.5 } };
    if (r() < 0.05) return NASTY[Math.floor(r() * NASTY.length)];
    return p;
  });
  const parts = Array.from({ length: Math.floor(r() * (r() < 0.1 ? 300 : 60)) }, () => {
    const p: Record<string, unknown> = { d: path(r, Math.floor(r() * 40)), p: Math.floor(r() * 90) };
    if (r() < 0.5) p.s = 1;
    if (r() < 0.2) p.cont = true;
    if (r() < 0.1) p.fill = r() < 0.5 ? 'none' : 'darken';
    if (r() < 0.1) p.stroke = false;
    if (r() < 0.2) p.frame = [r() * 100, r() * 100, r() * 500, r() * 500, r() * 720 - 360];
    if (r() < 0.05) p[['d', 'p', 's', 'frame'][Math.floor(r() * 4)]!] = NASTY[Math.floor(r() * NASTY.length)];
    return p;
  });
  const d: Record<string, unknown> = { w: r() * 2000, h: r() * 1200, paints, parts };
  if (r() < 0.1)
    d[['w', 'h', 'paints', 'parts'][Math.floor(r() * 4)]!] = NASTY[Math.floor(r() * NASTY.length)];
  if (r() < 0.1) d.ref = r() < 0.5 ? 'a'.repeat(64) : NASTY[Math.floor(r() * NASTY.length)];
  return d;
}

function asShape(decor: unknown, r: () => number): ShapeObject {
  return {
    id: 'f',
    type: 'shape',
    box: { x: r() * 1000 - 200, y: r() * 600 - 100, w: r() * 2000, h: r() * 1200, rotation: r() * 720 - 360 },
    shape: 'line',
    opacity: r(),
    radius: 0,
    decor,
    ...(r() < 0.2 ? { flipH: true } : {}),
  } as ShapeObject;
}

describe('decoration fuzz (M9 decor-render)', () => {
  it('never throws, stays within the limits and runs within 1.5 s', () => {
    const r = rng(0x5eed);
    const t0 = performance.now();
    let drawn = 0;
    let iterations = 0;
    putDecorFile('a'.repeat(64), { parts: m9Decor().parts });
    // A valid decoration mutated field by field, then random ones, until the time is half spent.
    while (performance.now() - t0 < 700) {
      iterations++;
      const raw =
        iterations % 3 === 0
          ? { ...m9Decor(), [Object.keys(m9Decor())[iterations % 4]!]: NASTY[iterations % NASTY.length] }
          : randomDecor(r);
      const c = clampDecor(raw);
      if (c) {
        expect(c.paints.length).toBeLessThanOrEqual(DECOR_LIMITS.paints);
        expect(c.parts.length).toBeLessThanOrEqual(DECOR_LIMITS.parts);
        const g = decorShapes(c);
        expect(g.points).toBeLessThanOrEqual(DECOR_LIMITS.points);
        expect(g.shadowed).toBeLessThanOrEqual(DECOR_LIMITS.shadowed);
        expect(Number.isFinite(decorCost(asShape(c, r)).est)).toBe(true);
      }
      const o = asShape(raw, r);
      const reach = decorReach(o);
      if (reach) expect([reach.x, reach.y, reach.w, reach.h].every(Number.isFinite)).toBe(true);
      const ctx = traceCtx(960, 540);
      drawShape(ctx, o, r() * 4);
      drawDecorRange(ctx, o, r() * 4, Math.floor(r() * 10) - 2, Math.floor(r() * 40));
      drawn++;
    }
    clearDecorFiles();
    expect(drawn).toBeGreaterThan(50);
    expect(performance.now() - t0).toBeLessThan(budgetMs(1_500));
  });

  it('reads hostile decoration files without throwing: kept only when something drawable is left', async () => {
    const r = rng(0xf11e);
    const texts: unknown[] = [
      '',
      'null',
      '[]',
      '{}',
      '{"parts":null}',
      '{"parts":{"length":1e9}}',
      '{"parts":[{"d":"M 0 0 L 1e999 0","p":0}]}',
      `{"parts":[${'{"d":"M 0 0 L 1 1 Z","p":0},'.repeat(400)}{"d":"M 0 0","p":0}]}`,
      '{"__proto__":{"parts":[1]},"parts":[{"d":"M 0 0 L 9 9 Z","p":63,"s":1}]}',
      `{"parts":[{"d":"${'L 1 1 '.repeat(10_000)}","p":0}]}`,
      '{"parts":[{"d":"M 0 0 L 9 9 Z","p":64}]}',
      42,
      null,
      undefined,
    ];
    for (let i = 0; i < 40; i++)
      texts.push(JSON.stringify({ parts: (randomDecor(r) as { parts?: unknown }).parts }));
    const refs = texts.map((_, i) => `f${i}`);
    const out = await readDecorFiles(refs, async (ref) => {
      const t = texts[Number(ref.slice(1))];
      if (t === 42) throw new Error('hostile');
      return t as string | null | undefined;
    });
    for (const [ref, why] of out) expect(['missing', 'invalid'], ref).toContain(why);
    // Kept: the one past the part cap (its first 256), the one naming the last paint, and random ones.
    expect(out.has('f7')).toBe(false);
    expect(out.has('f8')).toBe(false);
    expect(out.get('f10')).toBe('invalid');
    expect(out.get('f11')).toBe('missing');
    expect(out.get('f12')).toBe('invalid');
    expect(
      putDecorFile('x', {
        get parts(): never {
          throw new Error('hostile');
        },
      }),
    ).toBe(false);
    clearDecorFiles();
  });
});
