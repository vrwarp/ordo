import type { ShapeObject, Slide } from '@ordo/domain';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clampSlide } from './clamp.ts';
import { drawableContent } from './content.ts';
import './decor/index.ts';
import { cappedSlide } from './decor/test-util.ts';
import { EFFECT_STEP_PIXELS } from './effects.ts';
import { RecPath } from './geom/path2d.test-util.ts';
import { type TraceCtx, traceCtx } from './trace.test-util.ts';
import { effectsSlide, loneChain, PANEL_SHADOW, softFrame } from './units.effects.test-util.ts';
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
  /** What was drawn on it, in order (the trace context's log). */
  readonly trace: TraceCtx['trace'];
  pending = 0;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    const t = traceCtx(w, h);
    this.trace = t.trace;
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

describe('a unit copied out of the frame', () => {
  it('copies a unit drawn on the frame in bands of rows within EFFECT_STEP_PIXELS, and not one that is its whole canvas', async () => {
    // A full-frame copy at 4K is one 33 MB draw and a 33 MB canvas (15-38 ms on the bench machine, the longest turn
    // of a capped decoration's unit when it was drawn on the frame): a unit of the whole frame is the canvas it was
    // drawn on, and any other is copied a band of rows a step, as an effect unit's copy is.
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const soft = { ...softFrame(), id: 's1', fill: { r: 200, g: 120, b: 60, a: 1 } };
    // The lone chain over the whole slide with an outline of its box: its unit is the whole frame.
    const chain = loneChain();
    const geom = chain.geom as { paths: { d: string; w: number; h: number }[] };
    const { w: gw, h: gh } = geom.paths[0]!;
    const framed = {
      ...chain,
      id: 'framed',
      box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
      geom: { paths: [...geom.paths, { d: `M 0 0 L ${gw} 0 L ${gw} ${gh} L 0 ${gh} Z`, w: gw, h: gh }] },
    } as ShapeObject;
    const slides: Slide[] = [
      { id: 'chain', objects: [loneChain()] },
      { id: 'chain-frame', objects: [framed] },
      { id: 'soft-edges', objects: [softFrame(), soft] },
    ];
    const seen: string[] = [];
    for (const slide of slides) {
      const [u] = slideUnits(objectsOf(slide), 2);
      expect(u, slide.id).toBeDefined();
      RecordingCanvas.made = [];
      const { undrawn } = await makeChecked(u!);
      expect(undrawn, slide.id).toEqual([]);
      const whole = u!.rect.w === 3840 && u!.rect.h === 2160;
      seen.push(`${slide.id} ${u!.kind} ${u!.of}${whole ? ' whole frame' : ''}`);
      const sized = RecordingCanvas.made.filter((c) => c.width === u!.rect.w && c.height === u!.rect.h);
      if (whole) {
        // The canvas it was drawn on is the unit: one canvas of the frame, never copied.
        expect(sized, slide.id).toHaveLength(1);
        const copied = RecordingCanvas.made.flatMap((c) =>
          c.trace.filter(
            (e) => e[0] === 'call' && e[1] === 'drawImage' && (e[2] as { image: number[] }).image[0] === 3840,
          ),
        );
        expect(copied, slide.id).toEqual([]);
        continue;
      }
      const unit = sized.at(-1)!;
      const copies = unit.trace.filter((e) => e[0] === 'call' && e[1] === 'drawImage');
      expect(copies.length, slide.id).toBeGreaterThan(1);
      let rows = 0;
      for (const c of copies) {
        // drawImage(scratch, sx, sy, sw, sh, dx, dy, dw, dh): 1:1, whole rows of the unit, in order.
        const [sx, sy, sw, sh, dx, dy, dw, dh] = c.slice(3) as number[];
        expect([sw, sh], slide.id).toEqual([dw, dh]);
        expect(sw! * sh!, slide.id).toBeLessThanOrEqual(EFFECT_STEP_PIXELS);
        expect([sx, sy, dx, dy], slide.id).toEqual([u!.rect.x, u!.rect.y + rows, 0, rows]);
        rows += sh!;
      }
      expect(rows, slide.id).toBe(u!.rect.h);
    }
    expect(seen).toEqual([
      'chain sliced shape',
      'chain-frame sliced shape whole frame',
      'soft-edges whole shape whole frame',
    ]);
  });
});

describe('a decoration unit on its own canvas', () => {
  it('draws a decoration unit on a canvas of its rect at a whole-pixel offset, never on one of the frame', async () => {
    // A canvas of the frame for every decoration unit (33 MB at 4K) cost a slide of 18 of them (wake 20) about
    // 350 ms of its cold arm: a decoration is drawn on a canvas of its rect, which is the unit.
    vi.stubGlobal('OffscreenCanvas', RecordingCanvas);
    const [u] = slideUnits(objectsOf({ ...cappedSlide(), id: 'capped' }), 2);
    expect(u).toMatchObject({ kind: 'whole', of: 'decor' });
    const { x, y, w, h } = u!.rect;
    expect(w * h).toBeLessThan(3840 * 2160);
    RecordingCanvas.made = [];
    const { undrawn } = await makeChecked(u!);
    expect(undrawn).toEqual([]);
    expect(RecordingCanvas.made.filter((c) => c.width === 3840 && c.height === 2160)).toEqual([]);
    const own = RecordingCanvas.made.filter((c) => c.width === w && c.height === h);
    expect(own).toHaveLength(1);
    expect(own[0]!.trace.find((e) => e[0] === 'call')).toEqual(['call', 'setTransform', 1, 0, 0, 1, -x, -y]);
  });
});
