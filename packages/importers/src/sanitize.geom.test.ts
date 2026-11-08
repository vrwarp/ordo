import { describe, expect, it } from 'vitest';
import { Presentation, type Slide } from '@ordo/domain';
import { geomSlide } from '@ordo/domain/geom.test-util.ts';
import { sanitizeGeom, sanitizeGradient, sanitizePresentation } from './sanitize.ts';

/**
 * sanitizePresentation and the M6 fields (design/27 §3.2, §12 "Saving"): an importer's geometry, gradients,
 * effects, picture masks and gradient text are bounded, and stored path strings re-tokenised, so the saved
 * presentation validates and no reader ever sees an untokenised path.
 */

function deck(slide: Slide): Presentation {
  return Presentation.parse({
    id: 'p',
    title: 'Deck',
    kind: 'slides',
    sections: [{ id: 's', label: 'Slides', short: 'S', slides: [slide] }],
  });
}

const objects = (p: Presentation) => p.sections[0]!.slides[0]!.objects;
const white = { r: 255, g: 255, b: 255, a: 1 };

describe('sanitizePresentation and the M6 fields', () => {
  it('carries a valid slide through unchanged', () => {
    const p = sanitizePresentation(deck(geomSlide()));
    expect(objects(p)).toEqual(geomSlide().objects);
    expect(Presentation.safeParse(p).success).toBe(true);
  });

  it('bounds raw values an importer may hand over so the saved presentation validates', () => {
    const p = deck(geomSlide());
    const star = objects(p)[0] as Record<string, unknown>;
    star.geom = {
      preset: 'x'.repeat(100),
      adj: [...Array(20)].map((_, i) => [`a${'x'.repeat(30)}`, i * 1e9]),
      paths: [...Array(12)].map(() => ({ d: `M 0 0 L 1e999 2 A 1 1 0 0 0 3 3`, w: -4, h: Number.NaN })),
    };
    star.gradient = {
      kind: 'linear',
      angle: 1e12,
      stops: [...Array(30)].map((_, i) => ({ at: 1 - i / 29, color: white })),
    };
    star.shadow = { dx: 1e6, dy: -1e6, blur: -5, color: { r: 300, g: 0, b: 0, a: 9 } };
    star.glow = { radius: Number.POSITIVE_INFINITY, color: white };
    star.softEdge = 1e9;
    const photo = objects(p)[2] as Record<string, unknown>;
    photo.mask = {
      paths: [
        { d: 'M 0 0 L 1 0 L 0 1 Z', w: 1, h: 1 },
        { d: 'nothing', w: 1, h: 1 },
      ],
    };
    const title = objects(p)[3] as { style: Record<string, unknown> };
    title.style.paint = {
      kind: 'radial',
      center: { x: 5, y: -5 },
      stops: [
        { at: 7, color: white },
        { at: 0, color: white },
      ],
    };
    const out = sanitizePresentation(p);
    expect(Presentation.safeParse(out).success).toBe(true);
    const s = objects(out)[0] as Extract<Slide['objects'][number], { type: 'shape' }>;
    expect(s.geom!.preset).toHaveLength(40);
    expect(s.geom!.adj).toHaveLength(10);
    expect(s.geom!.adj![0]![1]).toBe(0);
    expect(s.geom!.adj![1]![1]).toBe(1e7);
    expect(s.geom!.paths).toHaveLength(8);
    expect(s.geom!.paths![0]).toEqual({ d: 'M 0 0 L 1000000000 2', w: 0, h: 0 });
    expect(s.gradient!.stops).toHaveLength(16);
    expect(s.gradient!.stops[0]!.at).toBeLessThan(s.gradient!.stops[15]!.at);
    expect(s.gradient!.angle).toBe(36_000);
    expect(s.shadow).toEqual({ dx: 500, dy: -500, blur: 0, color: { r: 255, g: 0, b: 0, a: 1 } });
    expect(s.glow!.radius).toBe(0);
    expect(s.softEdge).toBe(500);
    const i = objects(out)[2] as Extract<Slide['objects'][number], { type: 'image' }>;
    expect(i.mask).toEqual({ paths: [{ d: 'M 0 0 L 1 0 L 0 1 Z', w: 1, h: 1 }] });
    const t = objects(out)[3] as Extract<Slide['objects'][number], { type: 'text' }>;
    expect(t.style.paint!.center).toEqual({ x: 1, y: -1 });
    expect(t.style.paint!.stops.map((x) => x.at)).toEqual([0, 1]);
  });

  it('keeps cont (a path stored in pieces) only when it is true', () => {
    const g = sanitizeGeom({
      paths: [
        { d: 'M 0 0 L 9 0 L 9 9 Z', w: 9, h: 9 },
        { d: 'M 2 2 L 2 7 L 7 7 Z', w: 9, h: 9, cont: true },
        { d: 'M 0 0 L 1 1', w: 1, h: 1, cont: 'yes' as never },
      ],
    })!;
    expect(g.paths!.map((p) => p.cont)).toEqual([undefined, true, undefined]);
    expect(g.paths![2]).not.toHaveProperty('cont');
  });

  it('keeps a geometry file ref (M6 round 2), alone or beside paths, unless it is not a printable string', () => {
    const ref = 'a'.repeat(64);
    expect(sanitizeGeom({ ref })).toEqual({ ref });
    expect(sanitizeGeom({ ref, paths: [{ d: 'M 0 0 L 1 1', w: 1, h: 1 }] })).toEqual({
      ref,
      paths: [{ d: 'M 0 0 L 1 1', w: 1, h: 1 }],
    });
    for (const bad of ['', 'x'.repeat(101), 'a\u0007b', 5 as never])
      expect(sanitizeGeom({ ref: bad })).toBeUndefined();
    const p = deck(geomSlide());
    (objects(p)[2] as Record<string, unknown>).mask = { ref };
    expect(objects(sanitizePresentation(p))[2]).toHaveProperty('mask', { ref });
  });

  it('drops a geometry, gradient or mask with nothing usable left', () => {
    expect(sanitizeGeom({ paths: [{ d: 'garbage', w: 1, h: 1 }] })).toBeUndefined();
    expect(sanitizeGradient({ kind: 'linear', stops: [{ at: 0, color: white }] } as never)).toBeUndefined();
    const p = deck(geomSlide());
    (objects(p)[2] as Record<string, unknown>).mask = { paths: [{ d: 'Q', w: 1, h: 1 }] };
    (objects(p)[0] as Record<string, unknown>).gradient = { kind: 'linear', stops: [] };
    const out = sanitizePresentation(p);
    expect(objects(out)[2]).not.toHaveProperty('mask');
    expect(objects(out)[0]).not.toHaveProperty('gradient');
    expect(Presentation.safeParse(out).success).toBe(true);
  });

  it('leaves legacy shapes and pictures exactly as they were', () => {
    const legacy: Slide = {
      id: 'l',
      objects: [
        {
          id: 'r',
          type: 'shape',
          box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
          shape: 'rect',
          fill: white,
          opacity: 1,
          radius: 2,
        },
        {
          id: 'i',
          type: 'image',
          box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
          mediaId: 'm',
          fit: 'cover',
          opacity: 1,
          radius: 0,
        },
      ],
    };
    expect(objects(sanitizePresentation(deck(legacy)))).toEqual(legacy.objects);
  });
});
