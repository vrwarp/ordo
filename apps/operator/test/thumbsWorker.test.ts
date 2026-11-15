/**
 * The thumbnail worker on first use (design/28 §7; services/thumbs.ts): the font list no longer starts it, a
 * thumbnail request or warm() does, and a worker started later gets the fonts before any render. The worker's
 * own set-up messages (wave r2a's `{ t: 'init', finePointer }`, posted first) are not fonts or renders, so they
 * are left out of what these tests compare: the contract is "no font message before the worker starts, then
 * the fonts before any render".
 */
import type { Font, Slide } from '@ordo/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWorker {
  static made: FakeWorker[] = [];
  posted: { t: string }[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor() {
    FakeWorker.made.push(this);
  }
  postMessage(msg: { t: string }): void {
    this.posted.push(msg);
  }
  terminate(): void {}
}

const font: Font = {
  id: 'f1',
  family: 'Hymnal',
  weight: 400,
  style: 'normal',
  file: { hash: 'abc', bytes: 10, mime: 'font/ttf', path: 'files/abc' },
} as unknown as Font;
const slide = { id: 's1', objects: [] } as unknown as Slide;

/** What a worker was sent, its set-up messages (anything but fonts and renders) left out. */
const sent = (w: FakeWorker) => w.posted.map((m) => m.t).filter((t) => t === 'fonts' || t === 'render');

async function freshThumbs() {
  vi.resetModules();
  return (await import('../src/services/thumbs.ts')).thumbs;
}

beforeEach(() => {
  FakeWorker.made = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('OffscreenCanvas', class {});
  vi.stubGlobal('location', { href: 'https://op.example.test/' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the thumbnail worker starts on first use', () => {
  it('setFonts constructs no worker; the first request does, and posts the fonts first', async () => {
    const thumbs = await freshThumbs();
    thumbs.setFonts([font]);
    expect(FakeWorker.made).toHaveLength(0);
    void thumbs.get({ slide, isSong: true, images: {}, width: 320, height: 180 });
    expect(FakeWorker.made).toHaveLength(1);
    const types = sent(FakeWorker.made[0]!);
    expect(types[0]).toBe('fonts');
    expect(types).toContain('render');
    expect(types.indexOf('fonts')).toBeLessThan(types.indexOf('render'));
  });

  it('a set-up message the worker gets first (r2a’s init) changes nothing of the contract', async () => {
    const thumbs = await freshThumbs();
    thumbs.setFonts([font]);
    void thumbs.get({ slide, isSong: true, images: {}, width: 320, height: 180 });
    const w = FakeWorker.made[0]!;
    // As wave r2a's wire() does: an init before the stored fonts.
    w.posted.unshift({ t: 'init' });
    expect(sent(w)[0]).toBe('fonts');
    expect(sent(w)).toContain('render');
  });

  it('warm() constructs it (the regular layout, at Shell mount); later fonts go to the running worker', async () => {
    const thumbs = await freshThumbs();
    thumbs.warm();
    expect(FakeWorker.made).toHaveLength(1);
    thumbs.warm();
    expect(FakeWorker.made).toHaveLength(1);
    thumbs.setFonts([font]);
    expect(sent(FakeWorker.made[0]!)).toEqual(['fonts']);
    thumbs.setFonts([font]);
    expect(sent(FakeWorker.made[0]!)).toEqual(['fonts']);
  });
});
