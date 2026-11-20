import type { ShapeObject, Slide, SlideObject } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { clampSlide } from './clamp.ts';
import { frameKey, type FrameSplit, setFrames, splitFrame } from './frame.ts';
import { picture, slideOf, squares, textBox } from './frame.test-util.ts';
import { clearGeomFiles, putGeomFile } from './geom/stored.ts';
import { clearUnits, setUnitMedia } from './units.ts';

/*
 * The frame's key (design 29 R1, frame.ts `frameKey`): everything the under objects draw, their positions, the
 * pictures as their files, which of them wait for a file, the font epoch and the scale; nothing that only names
 * or places an object in the editor.
 */

afterEach(() => {
  clearUnits();
  clearGeomFiles();
  setUnitMedia(undefined);
  setFrames(true);
});

/** 300 objects: the bottom 100 are the frame; `edit` changes the object at `index` (a clamped copy). */
function split(edit?: (o: SlideObject) => SlideObject, index = 0, scale = 1): FrameSplit {
  const objs: SlideObject[] = [
    ...squares(298),
    picture('pic', 'photo', { x: 10, y: 10, w: 300, h: 200 }),
    textBox('t', 'Hi'),
  ];
  // an object the clamp keeps is changed before it is clamped
  if (edit) objs[index] = edit(objs[index]!);
  const f = splitFrame(slideOf(objs, 's'), scale);
  expect(f, 'a crowded slide is split').toBeDefined();
  expect(f!.under.length).toBeGreaterThan(index);
  return f!;
}

const key = (f: FrameSplit, epoch = 0) => frameKey(f, epoch);

describe('frameKey', () => {
  it('is stable for the same split and changes with the scale', () => {
    const a = split();
    expect(key(a)).toBe(key(a));
    expect(key(split(undefined, 0, 1))).toBe(key(split(undefined, 0, 1)));
    expect(key(split(undefined, 0, 2))).not.toBe(key(split(undefined, 0, 1)));
  });

  it('changes with any drawn field of any under object', () => {
    const base = key(split());
    for (const i of [0, 7, 99]) {
      expect(key(split((o) => ({ ...o, opacity: 0.5 }), i)), `opacity of ${i}`).not.toBe(base);
      expect(
        key(split((o) => ({ ...o, fill: { r: 1, g: 2, b: 3, a: 1 } }) as ShapeObject, i)),
        `fill of ${i}`,
      ).not.toBe(base);
    }
    expect(key(split((o) => ({ ...o, radius: 9 }) as ShapeObject, 3))).not.toBe(base);
    expect(
      key(
        split(
          (o) =>
            ({ ...o, shadow: { dx: 4, dy: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.5 } } }) as ShapeObject,
          5,
        ),
      ),
    ).not.toBe(base);
  });

  it('changes with a position change (a frame is placed)', () => {
    const base = key(split());
    expect(key(split((o) => ({ ...o, box: { ...o.box, x: o.box.x + 1 } }), 2))).not.toBe(base);
    expect(key(split((o) => ({ ...o, box: { ...o.box, w: o.box.w + 1 } }), 2))).not.toBe(base);
  });

  it('changes with the font epoch', () => {
    const f = split();
    expect(key(f, 0)).not.toBe(key(f, 1));
    expect(key(f, 1)).toBe(key(f, 1));
  });

  it('does not change with an object id, origin or lock', () => {
    const base = key(split());
    expect(key(split((o) => ({ ...o, id: 'renamed' }), 4))).toBe(base);
    expect(key(split((o) => ({ ...o, origin: { src: 'pptx', role: 'x' } }) as SlideObject, 4))).toBe(base);
    expect(key(split((o) => ({ ...o, locked: true }) as SlideObject, 4))).toBe(base);
  });

  it('keys a picture by its file: a media that resolves, or one that changes file, gives a new key', () => {
    const under = (): FrameSplit => {
      const objs: SlideObject[] = [
        picture('pic', 'photo', { x: 10, y: 10, w: 300, h: 200 }),
        ...squares(300),
      ];
      return splitFrame(slideOf(objs, 'p'), 1)!;
    };
    const unresolved = (() => {
      setUnitMedia(() => undefined);
      return key(under());
    })();
    setUnitMedia((id) => (id === 'photo' ? 'hash-a' : undefined));
    const a = key(under());
    expect(a).not.toBe(unresolved);
    setUnitMedia((id) => (id === 'photo' ? 'hash-b' : undefined));
    const b = key(under());
    expect(b).not.toBe(a);
    // the same file under another media id keys alike
    setUnitMedia((id) => (id === 'photo' ? 'hash-b' : undefined));
    expect(key(under())).toBe(b);
  });

  it('changes when a geometry file the frame waits for arrives', () => {
    const awaiting: ShapeObject = {
      ...(squares(1)[0] as ShapeObject),
      id: 'g',
      geom: { ref: 'f'.repeat(64), w: 100, h: 100 } as never,
    };
    const mk = () => splitFrame(slideOf([awaiting, ...squares(300)], 'g'), 1)!;
    const before = key(mk());
    putGeomFile('f'.repeat(64), { paths: [{ d: 'M0 0L10 0L10 10Z', w: 10, h: 10 }] } as never);
    const after = key(mk());
    expect(after).not.toBe(before);
    expect(key(mk())).toBe(after);
  });

  it('is the same for the same slide read back (canonical JSON: key order never matters)', () => {
    const objs = [...squares(300)];
    const a = splitFrame(slideOf(objs, 'r'), 1)!;
    const reordered = objs.map((o) =>
      JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(o).reverse()))),
    );
    const s: Slide = { id: 'r2', objects: reordered };
    const b = splitFrame(s, 1)!;
    expect(key(b)).toBe(key(a));
    expect(clampSlide(s, 'bake').objects).toHaveLength(300);
  });
});
