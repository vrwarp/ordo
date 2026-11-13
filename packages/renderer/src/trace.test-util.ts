import { createHash } from 'node:crypto';

/*
 * A 2D context for Node tests that logs everything a drawer does to it, in order: every method call with its
 * arguments and every property assigned, so that two drawers whose logs are equal draw the same pixels on
 * any canvas (the M9 seams' "no behaviour change" tests pin the log of the code before a seam by its digest).
 * Not shipped: vitest only runs *.test.ts files.
 */

/** One entry of a trace: a call `['call', name, ...args]` or an assignment `['set', name, value]`. */
export type TraceEntry = readonly [kind: 'call' | 'set', name: string, ...rest: unknown[]];

export type TraceCtx = CanvasRenderingContext2D & {
  readonly trace: TraceEntry[];
  /** The canvas the context draws on (width and height only). */
  readonly canvas: { width: number; height: number };
};

type Matrix = [number, number, number, number, number, number];

/** A gradient the trace context made: its arguments and colour stops, logged as they are added. */
class TraceGradient {
  readonly stops: [number, string][] = [];
  readonly kind: 'linear' | 'radial';
  readonly args: number[];
  constructor(kind: 'linear' | 'radial', args: number[]) {
    this.kind = kind;
    this.args = args;
  }
  addColorStop(at: number, color: string): void {
    this.stops.push([at, color]);
  }
}

/** A value as it goes into the log: numbers rounded to 1e-9 (float noise of equal arithmetic is none). */
function loggable(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e9) / 1e9 : String(v);
  if (Array.isArray(v)) return v.map(loggable);
  if (v instanceof TraceGradient) return { gradient: v.kind, args: v.args.map(loggable), stops: v.stops };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.ops)) return { path: o.ops };
    if (typeof o.width === 'number' && typeof o.height === 'number')
      return { image: [o.width, o.height, o.id ?? ''] };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, loggable(x)]));
  }
  return v;
}

/**
 * A logging context of `width` x `height`. `measureText` gives `em` × the font's px size per code point (plus
 * the letter spacing after each), so layouts are deterministic; `getTransform` follows the transform calls.
 */
export function traceCtx(width = 1920, height = 1080, em = 0.5): TraceCtx {
  const trace: TraceEntry[] = [];
  const state: Record<string, unknown> = {
    font: '10px sans-serif',
    letterSpacing: '0px',
    globalAlpha: 1,
  };
  const stack: { state: Record<string, unknown>; m: Matrix }[] = [];
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const mul = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    const [A, B, C, D, E, F] = m;
    m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  };
  const log = (name: string, args: unknown[]) => trace.push(['call', name, ...args.map(loggable)]);
  const own: Record<string, (...a: never[]) => unknown> = {
    save: () => {
      log('save', []);
      stack.push({ state: { ...state }, m: [...m] });
    },
    restore: () => {
      log('restore', []);
      const s = stack.pop();
      if (!s) return;
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, s.state);
      m = s.m;
    },
    scale: (x: number, y: number) => {
      log('scale', [x, y]);
      mul(x, 0, 0, y, 0, 0);
    },
    translate: (x: number, y: number) => {
      log('translate', [x, y]);
      mul(1, 0, 0, 1, x, y);
    },
    rotate: (r: number) => {
      log('rotate', [r]);
      mul(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0);
    },
    transform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      log('transform', [a, b, c, d, e, f]);
      mul(a, b, c, d, e, f);
    },
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      log('setTransform', [a, b, c, d, e, f]);
      m = [a, b, c, d, e, f];
    },
    resetTransform: () => {
      log('resetTransform', []);
      m = [1, 0, 0, 1, 0, 0];
    },
    getTransform: () => {
      const [a, b, c, d, e, f] = m;
      return { a, b, c, d, e, f, is2D: true };
    },
    measureText: (text: string) => {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 10);
      const spacing = Number.parseFloat(String(state.letterSpacing)) || 0;
      const width = [...text].length * (em * size + spacing);
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        actualBoundingBoxAscent: size * 0.8,
        actualBoundingBoxDescent: size * 0.2,
        fontBoundingBoxAscent: size * 0.9,
        fontBoundingBoxDescent: size * 0.3,
      } as TextMetrics;
    },
    createLinearGradient: (...a: number[]) => {
      log('createLinearGradient', a);
      return new TraceGradient('linear', a);
    },
    createRadialGradient: (...a: number[]) => {
      log('createRadialGradient', a);
      return new TraceGradient('radial', a);
    },
    createPattern: (...a: unknown[]) => {
      log('createPattern', a);
      return { pattern: true };
    },
    getLineDash: () => (state.lineDash as number[] | undefined) ?? [],
    setLineDash: (d: number[]) => {
      log('setLineDash', [d]);
      state.lineDash = [...d];
    },
  };
  const target = { trace, canvas: { width, height } };
  return new Proxy(target, {
    get(t, k) {
      if (typeof k !== 'string') return undefined;
      if (k === 'trace') return t.trace;
      if (k === 'canvas') return t.canvas;
      const f = own[k];
      if (f) return f;
      if (k in state) return state[k];
      // Any other method: logged with its arguments.
      if (
        /^(fill|stroke|clear|draw|put|begin|close|move|line|bezier|quadratic|arc|ellipse|rect|round|clip)/.test(
          k,
        )
      )
        return (...a: unknown[]) => log(k, a);
      return undefined;
    },
    set(_t, k, v) {
      if (typeof k !== 'string') return false;
      trace.push(['set', k, loggable(v)]);
      state[k] = v;
      return true;
    },
    has(_t, k) {
      return typeof k === 'string' && (k in own || k in state || k === 'canvas');
    },
  }) as unknown as TraceCtx;
}

/** The sha-256 (first 16 hex digits) of a trace: what a "draws today's pixels" test pins. */
export function traceDigest(trace: readonly TraceEntry[]): string {
  return createHash('sha256').update(JSON.stringify(trace)).digest('hex').slice(0, 16);
}
