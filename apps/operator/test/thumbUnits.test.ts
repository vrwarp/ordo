import type { Slide } from '@ordo/domain';
import { clearUnits, unitsOfSlide, unitWork } from '@ordo/renderer';
import { RecPath } from '@ordo/renderer/geom/path2d.test-util.ts';
import { lineArtSlide } from '@ordo/renderer/units.test-util.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ThumbIn, ThumbJob, ThumbOut } from '../src/workers/thumb.worker.ts';

/**
 * Thumbnails of a slide past its drawing budget (design/27 §12-13, M9 "Slow-to-draw elements", Runtime): with a
 * fine pointer (a desktop) the thumbnail worker draws its shapes whole from geometry units, as the outputs do;
 * with a coarse one (a phone, a tablet) it keeps their legacy copies and makes nothing. The page tells it which
 * (`init`, from lib/capabilities.ts `coarsePointer`).
 */
describe('thumbnail worker: geometry units only for a fine pointer', () => {
  const scope: { postMessage: (m: ThumbOut) => void; onmessage: ((ev: { data: ThumbIn }) => void) | null } = {
    postMessage: () => undefined,
    onmessage: null,
  };
  const done = new Map<number, ThumbOut>();

  function fakeCtx(ops: string[]) {
    const state: Record<string | symbol, unknown> = { font: '10px x', letterSpacing: '0px', globalAlpha: 1 };
    return new Proxy(state, {
      get(t, k) {
        if (k === 'measureText') return (s: string) => ({ width: s.length * 10 });
        if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        if (k in t) return t[k];
        return (...args: unknown[]) => {
          if (k === 'drawImage') ops.push(`image:${(args[0] as { tag?: string }).tag ?? ''}`);
          else if (k === 'fill' || k === 'fillRect') ops.push(String(k));
        };
      },
      set(t, k, v) {
        t[k] = v;
        return true;
      },
      has: () => true,
    });
  }
  class FakeOffscreenCanvas {
    ops: string[] = [];
    private ctx = fakeCtx(this.ops);
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return this.ctx;
    }
    transferToImageBitmap() {
      return { tag: 'unit', width: this.width, height: this.height, close() {} };
    }
    async convertToBlob(): Promise<{ ops: string[] }> {
      return { ops: this.ops };
    }
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    vi.stubGlobal('self', scope);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('Path2D', RecPath);
    vi.stubGlobal('fetch', async () => ({ ok: false }));
    scope.postMessage = (m) => {
      if (m.t === 'done') done.set(m.id, m);
    };
    await import('../src/workers/thumb.worker.ts');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearUnits();
  });

  let nextId = 1;
  async function render(job: ThumbJob): Promise<string[]> {
    const id = nextId++;
    scope.onmessage!({ data: { t: 'render', id, job } });
    await vi.waitFor(() => expect(done.has(id)).toBe(true));
    const out = done.get(id)!;
    if (out.t !== 'done' || !out.blob) throw new Error(out.t === 'done' ? out.error : 'no blob');
    return (out.blob as unknown as { ops: string[] }).ops;
  }

  /** Line art past the budget without gradients (these fakes make none). */
  const slide: Slide = {
    ...lineArtSlide(),
    objects: lineArtSlide().objects.filter((o) => !('gradient' in o && o.gradient)),
  };
  slide.objects.push({
    ...slide.objects[3]!,
    id: 'again',
    box: { ...slide.objects[3]!.box, x: 400, w: 500, h: 380 },
  });
  const job: ThumbJob = { slide, isSong: false, images: {}, width: 640, height: 360 };

  it('a coarse pointer (and a worker the page has not told yet) makes no unit and draws the legacy copies', async () => {
    const units = unitsOfSlide(slide, 640 / 1920);
    expect(units.length).toBeGreaterThan(0);
    const before = unitWork();
    expect((await render(job)).filter((o) => o === 'image:unit')).toEqual([]);
    scope.onmessage!({ data: { t: 'init', finePointer: false } });
    expect((await render(job)).filter((o) => o === 'image:unit')).toEqual([]);
    expect(unitWork()).toEqual(before);
  });

  it('a fine pointer makes the units and draws the shapes whole from them', async () => {
    scope.onmessage!({ data: { t: 'init', finePointer: true } });
    const units = unitsOfSlide(slide, 640 / 1920);
    const before = unitWork();
    const ops = await render(job);
    expect(unitWork().made - before.made).toBe(units.length);
    expect(ops.filter((o) => o === 'image:unit')).toHaveLength(units.length);
  });
});
