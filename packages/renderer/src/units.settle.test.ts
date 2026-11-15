import type { ShapeObject, Slide } from '@ordo/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clampSlide } from './clamp.ts';
import { drawableContent } from './content.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { traceCtx } from './trace.test-util.ts';
import { effectsSlide, PANEL_SHADOW, softFrame } from './units.effects.test-util.ts';
import { clearUnits, type GeomUnit, makeUnit, slideUnits, unitReady } from './units.ts';

/*
 * A unit's step is its own time (design/14 "Effect units"): Chromium records a 2D context's calls and draws them
 * when something reads the canvas (a pixel read back, a copy of it onto another canvas, a transfer), so a step
 * that only records (a full-frame body, a soft edge's multiply over a band) would be drawn by a later step, and
 * the copy that ends an effect unit paid for them all at once (three full-slide soft edges at 4K: a 102 ms turn
 * on a 50 ms task, bench '(bounded, M6 finish)'). Every canvas a step drew on is drawn before the next one starts.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterEach(() => {
  clearUnits();
  vi.unstubAllGlobals();
  vi.stubGlobal('Path2D', RecPath);
});

const objectsOf = (s: Slide) => drawableContent(clampSlide(s)).objects;

/** The context calls that record drawing on the canvas (what a later read, copy or transfer draws). */
const DRAWS = new Set([
  'fill',
  'stroke',
  'fillRect',
  'strokeRect',
  'clearRect',
  'drawImage',
  'putImageData',
  'fillText',
  'strokeText',
]);

/**
 * An OffscreenCanvas of a trace context that counts what it recorded since it was last drawn: a pixel read
 * (`getImageData`), a copy of it onto another canvas (`drawImage` of it: Chromium draws the source first) or a
 * transfer draws it.
 */
class RecordingCanvas {
  static made: RecordingCanvas[] = [];
  readonly width: number;
  readonly height: number;
  readonly ctx: CanvasRenderingContext2D;
  pending = 0;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    const t = traceCtx(w, h);
    const self = this;
    this.ctx = new Proxy(t, {
      get(target, name) {
        if (name === 'canvas') return self;
        if (name === 'getImageData')
          return () => {
            self.pending = 0;
            return { data: new Uint8ClampedArray(4) };
          };
        const v = Reflect.get(target, name) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          if (name === 'drawImage' && args[0] instanceof RecordingCanvas) args[0].pending = 0;
          if (DRAWS.has(String(name))) self.pending++;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
      set(target, name, value) {
        return Reflect.set(target, name, value);
      },
    });
    RecordingCanvas.made.push(this);
  }
  getContext() {
    return this.ctx;
  }
  transferToImageBitmap() {
    this.pending = 0;
    return { width: this.width, height: this.height, close() {} };
  }
}

/**
 * Makes `u`, checking at every reading of the clock (`makeUnit` reads it as a turn starts and after each step)
 * that no canvas holds recorded drawing; `undrawn`: the readings that found some.
 */
async function makeChecked(u: GeomUnit): Promise<{ readings: number; undrawn: number[] }> {
  let clock = 0;
  let readings = -1;
  const undrawn: number[] = [];
  const made = await makeUnit(u, {
    slice: async (fn) => fn(),
    check: () => {},
    now: () => {
      readings++;
      const left = RecordingCanvas.made.reduce((a, c) => a + c.pending, 0);
      if (left > 0) undrawn.push(readings);
      return clock++;
    },
  });
  expect(made).toBeDefined();
  expect(unitReady(u)).toBeDefined();
  return { readings, undrawn };
}

describe('effect units in steps', () => {
  it('draws what each step recorded before the next one: layers, whole, translucent and soft-edged units', async () => {
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const translucent = effectsSlide();
    translucent.objects = translucent.objects.map((o, i) => (i >= 10 ? { ...o, opacity: 0.8 } : o));
    const soft = (id: string, i: number, extra: Partial<ShapeObject> = {}): ShapeObject => ({
      ...softFrame(),
      id,
      fill: { r: 250 - i * 40, g: 236, b: 200, a: 1 },
      ...extra,
    });
    const slides: Slide[] = [
      effectsSlide(),
      { ...translucent, id: 'translucent' },
      // Full-slide soft edges: the budget keeps one; the next is a whole unit (its body cut by its mask).
      { id: 'soft-edges', objects: [soft('s0', 0), soft('s1', 1), soft('s2', 2)] },
      // A soft edge with a shadow: drawn alone, cut, then copied over its layer.
      { id: 'soft-shadow', objects: [soft('t0', 0), soft('t1', 1, { shadow: PANEL_SHADOW })] },
    ];
    const kinds: string[] = [];
    for (const slide of slides) {
      const units = slideUnits(objectsOf(slide), 2);
      expect(units.length, slide.id).toBeGreaterThan(0);
      for (const u of units) {
        RecordingCanvas.made = [];
        const { readings, undrawn } = await makeChecked(u);
        kinds.push(`${slide.id} ${u.kind}`);
        // The clock is read once a turn and after every step: many steps, none leaving drawing recorded.
        expect(readings, `${slide.id} ${u.object.id}`).toBeGreaterThan(4);
        expect(undrawn, `${slide.id} ${u.object.id}: readings after recorded drawing`).toEqual([]);
      }
    }
    expect(new Set(kinds)).toEqual(
      new Set(['effects layers', 'translucent whole', 'soft-edges whole', 'soft-shadow whole']),
    );
  });
});
