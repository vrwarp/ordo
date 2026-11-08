import { describe, expect, it } from 'vitest';
import { readZip } from '../../../../packages/importers/src/zip.ts';
import { presetGeometry } from '../../../../packages/renderer/src/geom/path.ts';
import { PRESET_GEOMS } from '../../../../packages/renderer/src/geom/presets.gen.ts';
import { parseDeck } from '../../../../packages/pptx-scene/src/index.ts';
import {
  BOX_H,
  BOX_W,
  CELL_H,
  CELL_W,
  EMU_PER_PX,
  OUTLINE_PX,
  probeDeck,
  probeFill,
  probeLayout,
  probeParts,
  SLIDE_H,
  SLIDE_W,
  slideCount,
  zipStore,
} from './probe.ts';

const names = [...PRESET_GEOMS.keys()].sort();
const shapes = probeLayout(names);

describe('probe layout', () => {
  it('puts every preset in its own cell, six to a slide, with a distinct fill', () => {
    expect(shapes.length).toBe(187);
    expect(slideCount(shapes)).toBe(32);
    const cells = new Set(shapes.map((s) => `${s.slide} ${s.cell.x} ${s.cell.y}`));
    expect(cells.size).toBe(shapes.length);
    for (const s of shapes) {
      expect(s.cell.x + s.cell.w).toBeLessThanOrEqual(SLIDE_W);
      expect(s.cell.y + s.cell.h).toBeLessThanOrEqual(SLIDE_H);
      expect([s.box.w, s.box.h]).toEqual([BOX_W, BOX_H]);
      expect(s.box.x).toBeGreaterThan(s.cell.x);
      expect(s.box.y).toBeGreaterThan(s.cell.y);
    }
    const fills = new Set(shapes.map((s) => `${s.fill.r},${s.fill.g},${s.fill.b}`));
    expect(fills.size).toBe(shapes.length);
    for (let i = 0; i < 187; i++) {
      const f = probeFill(i);
      for (const v of [f.r, f.g, f.b]) expect(Number.isInteger(v) && v >= 0 && v <= 255).toBe(true);
    }
  });

  it('keeps every preset, outline and leader lines included, inside its cell', () => {
    for (const s of shapes) {
      const g = presetGeometry(s.name, s.box.w, s.box.h)!;
      let x0 = 0;
      let y0 = 0;
      let x1 = BOX_W;
      let y1 = BOX_H;
      // Control points bound the curves.
      for (const p of g.paths)
        for (let i = 0; i < p.pts.length; i += 2) {
          x0 = Math.min(x0, p.pts[i]!);
          x1 = Math.max(x1, p.pts[i]!);
          y0 = Math.min(y0, p.pts[i + 1]!);
          y1 = Math.max(y1, p.pts[i + 1]!);
        }
      const m = OUTLINE_PX;
      // heart's control points reach far outside its box; its curve does not.
      if (s.name === 'heart') continue;
      expect(s.box.x + x0 - m, s.name).toBeGreaterThanOrEqual(s.cell.x);
      expect(s.box.y + y0 - m, s.name).toBeGreaterThanOrEqual(s.cell.y);
      expect(s.box.x + x1 + m, s.name).toBeLessThanOrEqual(s.cell.x + CELL_W);
      expect(s.box.y + y1 + m, s.name).toBeLessThanOrEqual(s.cell.y + CELL_H);
    }
  });
});

describe('probe deck', () => {
  it('is a deck the converter reads back: every preset at its box with its fill and outline', async () => {
    const parts = await readZip(probeDeck(shapes));
    const scene = parseDeck(parts);
    expect(scene.slides.length).toBe(32);
    expect(scene.frame).toMatchObject({ cx: SLIDE_W * EMU_PER_PX, cy: SLIDE_H * EMU_PER_PX });
    const read = scene.slides.flatMap((slide, i) =>
      slide.elements.map((e) => {
        if (e.kind !== 'shape') throw new Error(`slide ${i + 1}: a ${e.kind}`);
        return { slide: i, e };
      }),
    );
    expect(read.length).toBe(shapes.length);
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i]!;
      const { slide, e } = read[i]!;
      expect(slide).toBe(s.slide);
      expect(e.geom).toBe(s.name);
      expect(e.adj ?? []).toEqual([]);
      // The unit square maps to the box in EMU.
      expect(e.xf).toEqual([
        s.box.w * EMU_PER_PX,
        0,
        0,
        s.box.h * EMU_PER_PX,
        s.box.x * EMU_PER_PX,
        s.box.y * EMU_PER_PX,
      ]);
      expect(e.fill).toEqual({ kind: 'solid', color: { ...s.fill, a: 1 } });
      expect(e.line?.width).toBe(OUTLINE_PX * EMU_PER_PX);
      expect(e.line?.dash).toBeUndefined();
    }
  });

  it('writes the same bytes every time, as a zip of the parts', async () => {
    const a = probeDeck(shapes);
    expect(probeDeck(shapes)).toEqual(a);
    const parts = await readZip(a);
    const want = probeParts(shapes);
    expect([...parts.keys()].sort()).toEqual(want.map(([n]) => n).sort());
    for (const [name, xml] of want) expect(new TextDecoder().decode(parts.get(name))).toBe(xml);
  });

  it('stores files in a zip any reader opens', async () => {
    const files: [string, Uint8Array][] = [
      ['a.txt', new TextEncoder().encode('hello')],
      ['dir/empty.bin', new Uint8Array()],
      ['dir/b.bin', new Uint8Array([0, 1, 2, 255])],
    ];
    const back = await readZip(zipStore(files));
    expect([...back.entries()].map(([k, v]) => [k, [...v]])).toEqual(files.map(([k, v]) => [k, [...v]]));
  });
});
