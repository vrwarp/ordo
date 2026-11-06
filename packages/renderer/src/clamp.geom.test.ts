import { geomSlide } from '@ordo/domain/geom.test-util.ts';
import { describe, expect, it } from 'vitest';
import { clampGeom, clampGradient, clampObject, clampSlide, clampStyle } from './clamp.ts';

/**
 * The render plan's clamps of the M6 fields (design/27 §3.2 "clampObject rules", §12 "Rendering"): every
 * field re-bounded, path strings re-tokenised, enums to their defaults, and a legacy shape or picture clamped to
 * exactly the fields it had.
 */

const white = { r: 255, g: 255, b: 255, a: 1 };
const shape = { id: 's', type: 'shape', box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 }, shape: 'rect' };

describe('clampGeom', () => {
  it('keeps a preset of letters and digits and at most 10 finite adjust pairs', () => {
    expect(clampGeom({ preset: 'star5', adj: [['adj', 19_098]] })).toEqual({
      preset: 'star5',
      adj: [['adj', 19_098]],
    });
    expect(clampGeom({ preset: 'star 5;<x>' })).toEqual({ preset: 'star5x' });
    const adj = clampGeom({ preset: 'rect', adj: [...Array(20)].map((_, i) => [`a${i}`, i]) })!.adj!;
    expect(adj).toHaveLength(10);
    expect(clampGeom({ preset: 'rect', adj: [['a', Number.NaN], ['b', 1e12], 'x', [1, 2]] })!.adj).toEqual([
      ['b', 1e7],
    ]);
  });

  it('re-tokenises path strings (only M L Q C Z and numbers) and bounds their space', () => {
    const g = clampGeom({
      paths: [
        { d: 'M0,0 L 10 0 A 1 1 0 0 1 5 5', w: -5, h: 1e12, fill: 'sparkle', stroke: 'yes' },
        { d: 'garbage', w: 1, h: 1 },
        { d: 42, w: 1, h: 1 },
      ],
    });
    expect(g).toEqual({ paths: [{ d: 'M 0 0 L 10 0', w: 0, h: 1e9, fill: 'norm' }] });
  });

  it('keeps at most 8 paths and 4,096 points per path', () => {
    const d = `M 0 0 ${'L 1 1 '.repeat(5000)}`;
    const g = clampGeom({ paths: Array(12).fill({ d, w: 1, h: 1 }) })!;
    expect(g.paths).toHaveLength(8);
    expect(g.paths![0]!.d.split('L').length - 1).toBe(4095);
  });

  it('is undefined for garbage or a geometry with nothing usable', () => {
    for (const v of [undefined, null, 'star5', [], {}, { preset: '' }, { paths: [{ d: '' }] }])
      expect(clampGeom(v)).toBeUndefined();
  });
});

describe('clampGradient', () => {
  it('sorts stops, bounds them and the angle and centre, and keeps at most 16', () => {
    const g = clampGradient({
      kind: 'radial',
      angle: 1e9,
      scaled: true,
      center: { x: 7, y: Number.NaN },
      stops: [
        { at: 1, color: white },
        { at: -3, color: { r: 900, g: 0, b: 0, a: 2 } },
      ],
    });
    expect(g).toEqual({
      kind: 'radial',
      angle: 36_000,
      scaled: true,
      center: { x: 1, y: 0.5 },
      stops: [
        { at: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
        { at: 1, color: white },
      ],
    });
    const many = clampGradient({ kind: 'linear', stops: Array(40).fill({ at: 0.5, color: white }) })!;
    expect(many.stops).toHaveLength(16);
    expect(
      clampGradient({
        kind: 'conic',
        stops: [
          { at: 0, color: white },
          { at: 1, color: white },
        ],
      })!.kind,
    ).toBe('linear');
  });

  it('is undefined with fewer than two stops', () => {
    expect(clampGradient({ kind: 'linear', stops: [{ at: 0, color: white }] })).toBeUndefined();
    expect(clampGradient({ kind: 'linear', stops: 'x' })).toBeUndefined();
    expect(clampGradient(null)).toBeUndefined();
  });
});

describe('clampObject: shapes and pictures', () => {
  it('copies every M6 shape field, bounded', () => {
    const o = clampObject({
      ...shape,
      geom: { preset: 'chevron' },
      gradient: {
        kind: 'linear',
        stops: [
          { at: 0, color: white },
          { at: 1, color: white },
        ],
      },
      dash: 'longDashDot',
      ends: { head: { type: 'stealth', w: 'lg', len: 'enormous' }, tail: { type: 'none' } },
      flipH: true,
      flipV: 'yes',
      shadow: { dx: 1e9, dy: 3, blur: -1, color: white },
      glow: { radius: 9e9, color: white },
      softEdge: 1e9,
    });
    expect(o).toMatchObject({
      geom: { preset: 'chevron' },
      dash: 'longDashDot',
      ends: { head: { type: 'stealth', w: 'lg', len: 'med' } },
      flipH: true,
      shadow: { dx: 500, dy: 3, blur: 0, color: white },
      glow: { radius: 500 },
      softEdge: 500,
    });
    expect(o).not.toHaveProperty('flipV');
    expect((o as { ends: object }).ends).not.toHaveProperty('tail');
  });

  it('drops what draws nothing: a solid dash, no arrowheads, a zero glow or soft edge, an unknown dash', () => {
    const o = clampObject({
      ...shape,
      dash: 'solid',
      ends: { head: { type: 'harpoon' } },
      glow: { radius: 0, color: white },
      softEdge: 0,
    });
    for (const k of ['dash', 'ends', 'glow', 'softEdge']) expect(o).not.toHaveProperty(k);
    expect(clampObject({ ...shape, dash: 'wavy' })).not.toHaveProperty('dash');
  });

  it('clamps a legacy shape and picture to exactly the fields they had', () => {
    expect(clampObject({ ...shape, fill: white, opacity: 1, radius: 4 })).toEqual({
      id: 's',
      type: 'shape',
      box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      shape: 'rect',
      fill: white,
      opacity: 1,
      radius: 4,
    });
    const img = { id: 'i', type: 'image', box: shape.box, mediaId: 'm', fit: 'cover', opacity: 1, radius: 0 };
    expect(Object.keys(clampObject(img)!).sort()).toEqual([
      'box',
      'fit',
      'id',
      'mediaId',
      'opacity',
      'radius',
      'type',
    ]);
  });

  it('copies a picture mask and flips', () => {
    const img = { id: 'i', type: 'image', box: shape.box, mediaId: 'm', fit: 'stretch' };
    const o = clampObject({ ...img, flipH: true, flipV: true, mask: { preset: 'ellipse', paths: 'x' } });
    expect(o).toMatchObject({ flipH: true, flipV: true, mask: { preset: 'ellipse' } });
    expect(clampObject({ ...img, mask: { preset: '' } })).not.toHaveProperty('mask');
  });

  it('copies gradient text', () => {
    const s = clampStyle({
      fontFamily: 'Inter',
      fontSizePx: 40,
      color: white,
      paint: {
        kind: 'linear',
        angle: 90,
        stops: [
          { at: 0, color: white },
          { at: 1, color: white },
        ],
      },
    });
    expect(s.paint).toEqual({
      kind: 'linear',
      angle: 90,
      stops: [
        { at: 0, color: white },
        { at: 1, color: white },
      ],
    });
    expect(
      clampStyle({ fontFamily: 'Inter', fontSizePx: 40, color: white, paint: { stops: [] } }),
    ).not.toHaveProperty('paint');
  });

  it('clamps the M6 compatibility slide to what it stores', () => {
    const s = geomSlide();
    const c = clampSlide(s);
    expect(c.objects.map((o) => o.type)).toEqual(['shape', 'shape', 'image', 'text']);
    expect(c.objects[0]).toMatchObject({ geom: s.objects[0]!.type === 'shape' ? s.objects[0]!.geom : {} });
    expect(c.objects[1]).toMatchObject({ geom: { paths: [{ d: 'M 0 0 C 30 0 70 100 100 100' }] } });
  });
});
