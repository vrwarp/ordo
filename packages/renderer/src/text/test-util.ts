import type { Measurer } from './types.ts';

/*
 * Test helpers for the text engine (not shipped code; vitest only runs *.test.ts).
 */

/** Zero-width characters: joiners, marks of the bidi algorithm, the word joiner. */
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff]);

export type TestMeasurer = Measurer & {
  /** Calls of `width` so far. */
  calls: number;
  /** Every measured string, in order. */
  texts: string[];
};

/**
 * A deterministic Measurer: every code point is `em` × the font size wide (the size is the `<n>px` of the
 * font string), or `advance(ch, sizePx)` when given; joiners are zero wide. Letter spacing adds `spacingPx`
 * between characters (not after the last, as the Measurer contract says).
 */
export function testMeasurer(
  opts: { em?: number; advance?: (ch: string, sizePx: number) => number } = {},
): TestMeasurer {
  const em = opts.em ?? 0.5;
  const out: TestMeasurer = {
    calls: 0,
    texts: [],
    width(font, _dir, _lang, spacingPx, text) {
      out.calls++;
      out.texts.push(text);
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
      let w = 0;
      let n = 0;
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (ZERO_WIDTH.has(cp)) continue;
        w += opts.advance ? opts.advance(ch, size) : em * size;
        n++;
      }
      return n ? w + spacingPx * (n - 1) : 0;
    },
  };
  return out;
}

/** One recorded call on a `RecordingCtx`. */
export type CtxOp = { op: string; args: unknown[]; font: string; fillStyle: unknown; transform: number[] };

export type RecordingCtx = CanvasRenderingContext2D & { ops: CtxOp[] };

/**
 * A 2D context that records drawing calls with the font, fill style and transform in effect (enough to
 * test what the text paths draw where, without a canvas). `measureText` uses `em` × the font size per
 * code point, like `testMeasurer`, plus the letter spacing after every character, as Canvas does.
 */
export function recordingCtx(em = 0.5): RecordingCtx {
  const ops: CtxOp[] = [];
  const stack: Record<string, unknown>[] = [];
  let m = [1, 0, 0, 1, 0, 0];
  const state: Record<string, unknown> = {
    font: '10px sans-serif',
    fillStyle: '#000',
    strokeStyle: '#000',
    globalAlpha: 1,
    direction: 'inherit',
    letterSpacing: '0px',
    lang: 'inherit',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      ops.push({ op, args, font: String(state.font), fillStyle: state.fillStyle, transform: [...m] });
    };
  const mul = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    const [A, B, C, D, E, F] = m as [number, number, number, number, number, number];
    m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  };
  const ctx = {
    ops,
    save: () => stack.push({ ...state, m: [...m] }),
    restore: () => {
      const s = stack.pop();
      if (!s) return;
      m = s.m as number[];
      delete s.m;
      Object.assign(state, s);
    },
    scale: (x: number, y: number) => mul(x, 0, 0, y, 0, 0),
    translate: (x: number, y: number) => mul(1, 0, 0, 1, x, y),
    rotate: (r: number) => mul(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      m = [a, b, c, d, e, f];
    },
    measureText: (text: string) => {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 10);
      const spacing = Number.parseFloat(String(state.letterSpacing)) || 0;
      // Canvas adds the letter spacing after every character, the last one included.
      return { width: [...text].length * (em * size + spacing) } as TextMetrics;
    },
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    fillRect: record('fillRect'),
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    beginPath: record('beginPath'),
    rect: record('rect'),
    roundRect: record('roundRect'),
    ellipse: record('ellipse'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    fill: record('fill'),
    stroke: record('stroke'),
    clip: record('clip'),
  };
  return new Proxy(ctx, {
    get: (t, k) => (k in t ? t[k as keyof typeof t] : state[k as string]),
    set: (_t, k, v) => {
      state[k as string] = v;
      return true;
    },
    has: (t, k) => k in t || k in state,
  }) as unknown as RecordingCtx;
}
