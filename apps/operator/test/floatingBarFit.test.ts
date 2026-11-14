/**
 * The floating bar fits its pane (design/15 "Floating bar"): styles.css caps the bar at the pane's
 * width less 16 px (a wider row wraps) and SlideCanvas feeds `floatingBarSpot` that measured size, so the bar
 * never starts past the pane's left edge, never ends past its right edge and never leaves it vertically,
 * whatever the object, zoom or pane (the drawer open at 1024 px leaves a 484 px pane).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { floatingBarSpot } from '../src/views/editor/touchGeometry.ts';

/** The stage as SlideCanvas sizes it: Fit × zoom, centred in the pane. */
function stageIn(pane: { w: number; h: number }, zoom: number) {
  const fit = Math.min((pane.w - 24) / 1920, (pane.h - 48) / 1080);
  const w = Math.max(160, 1920 * fit * zoom);
  const h = Math.max(90, 1080 * fit * zoom);
  return { scale: w / 1920, stage: { x: (pane.w - w) / 2, y: (pane.h - h) / 2, w, h } };
}

describe('floatingBarSpot with a measured, pane-capped bar', () => {
  it('keeps a wrapped two-row bar inside a narrow pane (the drawer open at 1024 px)', () => {
    const pane = { w: 484, h: 640 };
    const bar = { w: pane.w - 16, h: 66 };
    const { scale, stage } = stageIn(pane, 1);
    const announcement = { x: 115, y: 216, w: 1685, h: 432, rotation: 0 };
    const at = floatingBarSpot(announcement, scale, stage, pane, bar);
    expect(at.x).toBe(8);
    expect(at.x + bar.w).toBeLessThanOrEqual(pane.w - 8);
    expect(at.y).toBeGreaterThanOrEqual(2);
    expect(at.y + bar.h).toBeLessThanOrEqual(pane.h - 2);
  });

  it('keeps the bar in the pane for an object dragged off the slide', () => {
    const pane = { w: 740, h: 600 };
    const bar = { w: 600, h: 34 };
    const { scale, stage } = stageIn(pane, 1);
    for (const box of [
      { x: 400, y: 1500, w: 300, h: 200, rotation: 0 },
      { x: -900, y: -700, w: 300, h: 200, rotation: 0 },
      { x: 2600, y: 400, w: 300, h: 200, rotation: 0 },
    ]) {
      const at = floatingBarSpot(box, scale, stage, pane, bar);
      expect(at.x).toBeGreaterThanOrEqual(8);
      expect(at.x + bar.w).toBeLessThanOrEqual(pane.w - 8);
      expect(at.y).toBeGreaterThanOrEqual(2);
      expect(at.y + bar.h).toBeLessThanOrEqual(pane.h - 2);
    }
  });

  it('any object, zoom and pane: the bar lies inside the pane (property)', () => {
    fc.assert(
      fc.property(
        fc.record({
          pw: fc.integer({ min: 300, max: 2400 }),
          ph: fc.integer({ min: 200, max: 1400 }),
          zoom: fc.constantFrom(1, 0.75, 0.5),
          x: fc.integer({ min: -3000, max: 5000 }),
          y: fc.integer({ min: -3000, max: 5000 }),
          w: fc.integer({ min: 1, max: 4000 }),
          h: fc.integer({ min: 1, max: 4000 }),
          rotation: fc.integer({ min: -360, max: 360 }),
          bw: fc.integer({ min: 40, max: 2000 }),
          rows: fc.integer({ min: 1, max: 3 }),
          rotate: fc.boolean(),
          editing: fc.boolean(),
        }),
        (r) => {
          const pane = { w: r.pw, h: r.ph };
          const bar = { w: Math.min(r.bw, pane.w - 16), h: Math.min(34 * r.rows, pane.h - 16) };
          const { scale, stage } = stageIn(pane, r.zoom);
          const at = floatingBarSpot(
            { x: r.x, y: r.y, w: r.w, h: r.h, rotation: r.rotation },
            scale,
            stage,
            pane,
            bar,
            {
              hasRotateHandle: r.rotate,
              avoidInsideTop: r.editing,
            },
          );
          expect(at.x).toBeGreaterThanOrEqual(8);
          expect(at.x + bar.w).toBeLessThanOrEqual(pane.w - 8);
          expect(at.y).toBeGreaterThanOrEqual(2);
          expect(at.y + bar.h).toBeLessThanOrEqual(pane.h - 2);
        },
      ),
      { numRuns: 500 },
    );
  });
});
