import { describe, expect, it } from 'vitest';
import { RenderEngine } from './engine.ts';
import { PLANE_FLOATS } from './scene.ts';
import { LAYER_INDEX, SRC_SCENE } from './stacks.ts';

/** Slot generations of video frames and scene offers (design/27 §7.2). */

function engine(): RenderEngine {
  return new RenderEngine(
    {
      canvas: {} as OffscreenCanvas,
      width: 1920,
      height: 1080,
      testPixel: false,
      clear: { r: 0, g: 0, b: 0, a: 1 },
      clockOffset: 0,
    },
    { raf: () => 0, wallNow: () => 0 },
  );
}

const frame = () => {
  const f = { closed: false, close: () => (f.closed = true) };
  return f;
};

describe('RenderEngine video generations', () => {
  it('records the generation each frame was loaded under and forgets it on clear', () => {
    const e = engine();
    expect([...e.video.gen]).toEqual([-1, -1, -1, -1]);
    const a = frame();
    e.setVideoFrame(2, a as unknown as VideoFrame, 5);
    expect(e.video.gen[2]).toBe(5);
    const b = frame();
    e.setVideoFrame(2, b as unknown as VideoFrame, 6);
    expect(a.closed).toBe(true);
    expect(e.video.gen[2]).toBe(6);
    e.setVideoFrame(2, null);
    expect(b.closed).toBe(true);
    expect(e.video.gen[2]).toBe(-1);
    const c = frame();
    e.setVideoFrame(9, c as unknown as VideoFrame, 1);
    expect(c.closed).toBe(true);
  });

  it('closes both bitmaps of a scene offered to an unknown layer, and holds one offered to the slide layer', () => {
    const e = engine();
    const bmp = () => {
      const b = { closed: false, close: () => (b.closed = true) };
      return b;
    };
    const base = bmp();
    const over = bmp();
    const c = {
      key: 'S',
      kind: SRC_SCENE,
      bitmap: base as unknown as ImageBitmap,
      over: over as unknown as ImageBitmap,
      plane: new Float32Array(PLANE_FLOATS),
      videoSlot: 2,
      videoGen: 1,
    };
    e.offer(99, c);
    expect(base.closed && over.closed).toBe(true);
    e.offer(LAYER_INDEX.slide, { ...c, bitmap: bmp() as unknown as ImageBitmap, over: null });
    expect(e.layers[LAYER_INDEX.slide]!.armedStack.kind).toBe(SRC_SCENE);
  });
});
