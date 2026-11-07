import type { Gradient } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { type RecordedGradient, recordingCtx } from '../text/test-util.ts';
import type { GeomSpacePaint } from './draw.ts';
import { gradientStyle } from './paint.ts';

/** Gradients over a box (design/27 §3.1 Gradient): OOXML angles, scaled, path gradients, shaded stops. */

const black = { r: 0, g: 0, b: 0, a: 1 };
const white = { r: 255, g: 255, b: 255, a: 1 };
const linear = (angle: number, scaled?: boolean): Gradient => ({
  kind: 'linear',
  angle,
  ...(scaled ? { scaled } : {}),
  stops: [
    { at: 0, color: black },
    { at: 1, color: white },
  ],
});

const ctx = recordingCtx();
const lin = (g: Gradient, w: number, h: number) => gradientStyle(ctx, g, w, h) as unknown as RecordedGradient;
const near = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i]!, 9);
};

describe('gradientStyle', () => {
  it('runs a linear gradient across the box from the corner where it starts', () => {
    near(lin(linear(0), 200, 100).args, [0, 50, 200, 50]);
    near(lin(linear(90), 200, 100).args, [100, 0, 100, 100]);
    near(lin(linear(180), 200, 100).args, [200, 50, 0, 50]);
    // 45° on the page across a 200 x 100 box: the projection of the box on (1, 1)/√2, from the top-left.
    const g = lin(linear(45), 200, 100).args;
    const half = 150 / Math.SQRT2;
    near(g, [
      100 - half / Math.SQRT2,
      50 - half / Math.SQRT2,
      100 + half / Math.SQRT2,
      50 + half / Math.SQRT2,
    ]);
  });

  it('stretches a scaled angle with the box: 45° then runs corner to corner', () => {
    const [x0, y0, x1, y1] = lin(linear(45, true), 200, 100).args as [number, number, number, number];
    // The isolines are parallel to the other diagonal, (200, -100): the direction is perpendicular to it.
    const dx = x1 - x0;
    const dy = y1 - y0;
    expect(dx * 200 + dy * -100).toBeCloseTo(0, 9);
    // The start isoline passes through the top-left corner, the end one through the bottom-right.
    expect((0 - x0) * dx + (0 - y0) * dy).toBeCloseTo(0, 6);
    expect((200 - x1) * dx + (100 - y1) * dy).toBeCloseTo(0, 6);
  });

  it('adds every stop, shaded for the path brightness', () => {
    const g = gradientStyle(ctx, linear(0), 10, 10, -0.4) as unknown as RecordedGradient;
    expect(g.stops).toEqual([
      [0, 'rgba(0,0,0,1)'],
      [1, 'rgba(153,153,153,1)'],
    ]);
  });

  it('draws a radial gradient from the focus to the farthest corner, on an ellipse of the box', () => {
    const r: Gradient = { kind: 'radial', stops: linear(0).stops };
    const square = gradientStyle(ctx, r, 100, 100) as unknown as RecordedGradient;
    near(square.args, [50, 50, 0, 50, 50, Math.hypot(50, 50)]);
    const corner = gradientStyle(
      ctx,
      { ...r, center: { x: 1, y: 0 } },
      100,
      100,
    ) as unknown as RecordedGradient;
    near(corner.args, [100, 0, 0, 100, 0, Math.hypot(100, 100)]);
    // A wide box: a circle in a space squeezed by w/h, mapped back by the paint's transform.
    const wide = gradientStyle(ctx, r, 200, 100) as GeomSpacePaint;
    expect(wide.transform).toEqual([1, 0, 0, 0.5, 0, 0]);
    near((wide.style as unknown as RecordedGradient).args, [100, 100, 0, 100, 100, Math.hypot(100, 100)]);
    // For text: a circle in box space, at the box's origin.
    const text = gradientStyle(ctx, r, 200, 100, 0, { x0: 10, y0: 20 }) as unknown as RecordedGradient;
    near(text.args, [110, 70, 0, 110, 70, Math.hypot(100, 50)]);
  });
});
