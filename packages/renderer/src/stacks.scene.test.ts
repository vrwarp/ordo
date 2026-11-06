import { describe, expect, it } from 'vitest';
import { PLANE_FLOATS } from './scene.ts';
import { LayerStack, SRC_BITMAP, SRC_SCENE, SRC_VIDEO, type StackContent } from './stacks.ts';

/** Scene stacks (design/27 §7.2): base, over, plane and video generation travel with the content. */

type B = { id: string; closed: boolean };
const F = 1000 / 60;

function setup() {
  const released: string[] = [];
  const ls = new LayerStack<B>((b) => {
    b.closed = true;
    released.push(b.id);
  });
  const bmp = (id: string): B => ({ id, closed: false });
  const plane = (v: number) => new Float32Array(PLANE_FLOATS).fill(v);
  const scene = (key: string, v = 1, over = true): StackContent<B> => ({
    key,
    kind: SRC_SCENE,
    bitmap: bmp(`${key}.base`),
    over: over ? bmp(`${key}.over`) : null,
    plane: plane(v),
    videoSlot: 2,
    videoGen: 7,
    cueIndex: 3,
  });
  return { ls, released, bmp, scene };
}

describe('LayerStack scene content', () => {
  it('copies the plane into the stack and keeps base, over, slot and generation', () => {
    const { ls, scene } = setup();
    const c = scene('S', 0.5);
    ls.offer(c);
    const s = ls.armedStack;
    expect(s.kind).toBe(SRC_SCENE);
    expect(s.bitmap?.id).toBe('S.base');
    expect(s.over?.id).toBe('S.over');
    expect(s.videoSlot).toBe(2);
    expect(s.videoGen).toBe(7);
    expect(s.plane).not.toBe(c.plane);
    expect([...s.plane]).toEqual([...c.plane!]);
    c.plane!.fill(9);
    expect(s.plane[0]).toBe(0.5);
  });

  it('releases the over bitmap with its base when content is replaced, cleared or a duplicate', () => {
    const { ls, released, scene, bmp } = setup();
    ls.offer(scene('S'));
    ls.offer({ key: 'T', kind: SRC_BITMAP, bitmap: bmp('T') });
    expect(released).toEqual(['S.base', 'S.over']);
    expect(ls.armedStack.over).toBeNull();
    expect(ls.armedStack.videoGen).toBe(-1);
    expect([...ls.armedStack.plane].every((x) => x === 0)).toBe(true);
    ls.requestFlip('T', 0, 0, 0);
    ls.tick(0, F);
    ls.offer(scene('U'));
    ls.requestFlip('U', 100, 0, 50);
    ls.tick(100, F);
    // A duplicate arm of the live scene is dropped with both its bitmaps.
    ls.offer(scene('U'));
    expect(released.slice(-2)).toEqual(['U.base', 'U.over']);
    ls.reset();
    expect(released).toContain('T');
    expect(ls.liveStack.over).toBeNull();
  });

  it('promotes a queued scene after a crossfade with its plane and over', () => {
    const { ls, scene, bmp } = setup();
    ls.offer({ key: 'A', kind: SRC_BITMAP, bitmap: bmp('A') });
    ls.requestFlip('A', 0, 0, 0);
    ls.tick(0, F);
    ls.offer({ key: 'B', kind: SRC_BITMAP, bitmap: bmp('B') });
    ls.requestFlip('B', 100, 300, 50);
    ls.tick(100, F);
    expect(ls.fading).toBe(true);
    ls.offer(scene('C', 0.25));
    expect(ls.hasQueued).toBe(true);
    ls.tick(400, F);
    const a = ls.armedStack;
    expect(a.key).toBe('C');
    expect(a.kind).toBe(SRC_SCENE);
    expect(a.over?.id).toBe('C.over');
    expect(a.plane[3]).toBe(0.25);
    expect(a.videoGen).toBe(7);
    expect(ls.queued.over).toBeNull();
  });

  it('leaves non-scene content with no over, a zero plane and no generation', () => {
    const { ls } = setup();
    ls.offer({ key: 'V', kind: SRC_VIDEO, videoSlot: 2 });
    expect(ls.armedStack.over).toBeNull();
    expect(ls.armedStack.videoGen).toBe(-1);
    expect([...ls.armedStack.plane].every((x) => x === 0)).toBe(true);
  });
});
