import { describe, expect, it } from 'vitest';
import { FIT_CONTAIN, FIT_COVER, LayerStack, SRC_BITMAP, fitRect } from './stacks.ts';

type B = { id: string; closed: boolean };
const F = 1000 / 60;

function setup() {
  const released: string[] = [];
  const ls = new LayerStack<B>((b) => {
    b.closed = true;
    released.push(b.id);
  });
  const bmp = (id: string): B => ({ id, closed: false });
  const offer = (key: string) => ls.offer({ key, kind: SRC_BITMAP, bitmap: bmp(key) });
  return { ls, released, offer };
}

describe('LayerStack', () => {
  it('arms into the armed stack and flips at the scheduled time with a crossfade', () => {
    const { ls, offer } = setup();
    offer('A');
    ls.requestFlip('A', 1000, 300, 900);
    expect(ls.tick(900, F)).toBe(false);
    expect(ls.tick(1000, F)).toBe(true);
    expect(ls.liveStack.key).toBe('A');
    expect(ls.fading).toBe(true);
    expect(ls.weight(1150)).toBe(0.5);
    ls.tick(1300, F);
    expect(ls.fading).toBe(false);
    expect(ls.weight(1300)).toBe(1);
    expect(ls.lateFlips).toBe(0);
  });

  it('holds the previous content until an unarmed cue arrives, then flips ASAP', () => {
    const { ls, offer } = setup();
    offer('A');
    ls.requestFlip('A', 0, 0, 0);
    ls.tick(0, F);
    ls.requestFlip('B', 1000, 0, 900);
    expect(ls.tick(1000, F)).toBe(false);
    expect(ls.liveStack.key).toBe('A');
    offer('B');
    expect(ls.tick(1100, F)).toBe(true);
    expect(ls.liveStack.key).toBe('B');
    expect(ls.lateFlips).toBe(1);
  });

  it('queues an arm during a fade and promotes it when the fade ends', () => {
    const { ls, offer, released } = setup();
    offer('A');
    ls.requestFlip('A', 0, 0, 0);
    ls.tick(0, F);
    offer('B');
    ls.requestFlip('B', 1000, 300, 900);
    ls.tick(1000, F);
    // Next cue arrives during the fade: the armed stack is the outgoing A, so C waits.
    offer('C');
    expect(ls.heldKeys()).toEqual({ live: 'B', armed: 'A', queued: 'C' });
    ls.tick(1310, F);
    expect(ls.heldKeys()).toEqual({ live: 'B', armed: 'C', queued: '' });
    expect(released).toContain('A');
  });

  it('a GO during a fade to the queued cue ends the fade and flips', () => {
    const { ls, offer } = setup();
    offer('A');
    ls.requestFlip('A', 0, 0, 0);
    ls.tick(0, F);
    offer('B');
    ls.requestFlip('B', 1000, 300, 900);
    ls.tick(1000, F);
    offer('C');
    ls.requestFlip('C', 1100, 300, 1050);
    expect(ls.tick(1100, F)).toBe(true);
    expect(ls.liveStack.key).toBe('C');
    expect(ls.armedStack.key).toBe('B');
    expect(ls.fading).toBe(true);
  });

  it('flips to empty without arming and fades the old content out', () => {
    const { ls, offer } = setup();
    offer('A');
    ls.requestFlip('A', 0, 0, 0);
    ls.tick(0, F);
    ls.requestFlip('', 500, 200, 400);
    expect(ls.tick(500, F)).toBe(true);
    expect(ls.liveStack.key).toBe('');
    expect(ls.armedStack.key).toBe('A');
    expect(ls.weight(600)).toBe(0.5);
  });

  it('ignores a flip to what is already live and drops duplicate arms', () => {
    const { ls, offer, released } = setup();
    offer('A');
    ls.requestFlip('A', 0, 0, 0);
    ls.tick(0, F);
    offer('A');
    expect(released).toContain('A');
    ls.requestFlip('A', 100, 300, 50);
    expect(ls.tick(200, F)).toBe(false);
    expect(ls.flips).toBe(1);
  });

  it('replacing the armed content releases the old bitmap', () => {
    const { ls, offer, released } = setup();
    offer('A');
    offer('B');
    expect(released).toEqual(['A']);
    expect(ls.armedStack.key).toBe('B');
  });

  it('marks itself dirty when held keys change', () => {
    const { ls, offer } = setup();
    ls.dirty = false;
    offer('A');
    expect(ls.dirty).toBe(true);
  });
});

describe('fitRect', () => {
  it('covers and contains', () => {
    const out = new Float32Array(4);
    fitRect(1000, 1000, 1920, 1080, FIT_COVER, out);
    expect([...out]).toEqual([0, -420, 1920, 1920]);
    fitRect(1000, 1000, 1920, 1080, FIT_CONTAIN, out);
    expect([...out]).toEqual([420, 0, 1080, 1080]);
    fitRect(0, 0, 1920, 1080, FIT_CONTAIN, out);
    expect([...out]).toEqual([0, 0, 1920, 1080]);
  });
});
