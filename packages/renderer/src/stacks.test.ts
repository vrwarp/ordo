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

  it('does not let the next arm evict the content of a scheduled flip', () => {
    const { ls, offer } = setup();
    ls.requestFlip('A', 1000, 0, 900);
    offer('A');
    offer('B'); // next cue armed before A's flip time
    expect(ls.heldKeys()).toEqual({ live: '', armed: 'A', queued: 'B' });
    expect(ls.tick(1000, F)).toBe(true);
    // A cut: the queued arm is promoted right after the swap.
    expect(ls.heldKeys()).toEqual({ live: 'A', armed: 'B', queued: '' });
  });

  it('marks itself dirty when held keys change', () => {
    const { ls, offer } = setup();
    ls.dirty = false;
    offer('A');
    expect(ls.dirty).toBe(true);
  });
});

describe('LayerStack: an in-place refresh that fades in (design/14 "Late units", r2b units-live)', () => {
  /** A live 'A' (its first copy a1) and an armed 'B'. */
  function live() {
    const t = setup();
    const bmp = (id: string): B => ({ id, closed: false });
    t.ls.offer({ key: 'A', kind: SRC_BITMAP, bitmap: bmp('a1') });
    t.ls.requestFlip('A', 0, 0, 0);
    t.ls.tick(0, F);
    t.offer('B');
    const refresh = (id: string, fadeMs = 300) =>
      t.ls.offer({ key: 'A', kind: SRC_BITMAP, bitmap: bmp(id), refresh: true, refreshFadeMs: fadeMs });
    return { ...t, refresh };
  }

  it('an in-place refresh at mid-fade blends both copies, keeping the old one until the fade ends', () => {
    const { ls, released, refresh } = live();
    refresh('a2');
    // Nothing flips; the held keys stay; the old copy is kept and the new one fades in over it.
    expect(ls.heldKeys()).toEqual({ live: 'A', armed: 'B', queued: '' });
    expect(ls.tick(1000, F)).toBe(false);
    expect(ls.refading).toBe(true);
    expect((ls.liveStack.bitmap as B).id).toBe('a1');
    expect((ls.incoming.bitmap as B).id).toBe('a2');
    expect(ls.refadeWeight(1150)).toBe(0.5);
    expect(released).toEqual([]);
    // At its end the new copy is the live one and the old one is let go.
    ls.tick(1300, F);
    expect(ls.refading).toBe(false);
    expect((ls.liveStack.bitmap as B).id).toBe('a2');
    expect(ls.hasIncoming).toBe(false);
    expect(released).toEqual(['a1']);
    expect(ls.flips).toBe(1);
  });

  it('a GO in the middle of an in-place fade ends it and flips at once', () => {
    const { ls, released, refresh } = live();
    refresh('a2');
    ls.tick(1000, F);
    expect(ls.refading).toBe(true);
    ls.requestFlip('B', 1100, 300, 1090);
    expect(ls.tick(1100, F)).toBe(true);
    expect(ls.liveStack.key).toBe('B');
    expect(ls.refading).toBe(false);
    expect(ls.hasIncoming).toBe(false);
    // The slide that leaves fades out as its new copy.
    expect((ls.armedStack.bitmap as B).id).toBe('a2');
    expect(released).toEqual(['a1']);
    expect(ls.lateFlips).toBe(0);
  });

  it('waits for the new copy to be uploaded before fading; a GO before then flips at once and drops it', () => {
    const { ls, released, refresh } = live();
    ls.gated = true;
    refresh('a2');
    expect(ls.incoming.ready).toBe(false);
    ls.tick(1000, F);
    expect(ls.refading).toBe(false);
    ls.incoming.ready = true;
    ls.tick(1016, F);
    expect(ls.refading).toBe(true);
    expect(ls.refadeWeight(1016)).toBe(0);
    // A second copy before the first one was uploaded replaces it.
    const t = live();
    t.ls.gated = true;
    t.refresh('a2');
    t.refresh('a3');
    expect((t.ls.incoming.bitmap as B).id).toBe('a3');
    expect(t.released).toEqual(['a2']);
    t.ls.requestFlip('B', 1100, 300, 1090);
    expect(t.ls.tick(1100, F)).toBe(true);
    expect(t.ls.hasIncoming).toBe(false);
    expect(t.released).toEqual(['a2', 'a3']);
    expect((t.ls.armedStack.bitmap as B).id).toBe('a1');
    void released;
  });

  it('a refresh without a fade, during a flip fade, or of the armed cue swaps in place as before', () => {
    const { ls, released, refresh } = live();
    refresh('a2', 0);
    expect(ls.hasIncoming).toBe(false);
    expect((ls.liveStack.bitmap as B).id).toBe('a2');
    expect(released).toEqual(['a1']);
    // The armed cue's late parts: its copy is replaced, silently.
    ls.offer({ key: 'B', kind: SRC_BITMAP, bitmap: { id: 'b2', closed: false }, refresh: true });
    expect((ls.armedStack.bitmap as B).id).toBe('b2');
    expect(ls.hasIncoming).toBe(false);
    // While a GO's crossfade runs, a refresh of the incoming live content swaps in place.
    ls.requestFlip('B', 2000, 300, 1990);
    ls.tick(2000, F);
    expect(ls.fading).toBe(true);
    ls.offer({
      key: 'B',
      kind: SRC_BITMAP,
      bitmap: { id: 'b3', closed: false },
      refresh: true,
      refreshFadeMs: 300,
    });
    expect(ls.hasIncoming).toBe(false);
    expect((ls.liveStack.bitmap as B).id).toBe('b3');
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
