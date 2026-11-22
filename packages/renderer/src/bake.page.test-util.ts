import type { ImageObject, ShapeObject, Slide, SlideObject, TextObject } from '@ordo/domain';
import { DEFAULT_LYRIC_STYLE, slideContent } from '@ordo/domain';
import { drawnPart, pictureSource } from '@ordo/domain/prerender.ts';
import {
  type BakeMade,
  type BakeOptions,
  type BakeResult,
  bakeSlide,
  bakeSlides,
  createBakeEnv,
  encodePicture,
  failureText,
  readPictureHeader,
  tileOrigins,
  verifyPicture,
} from './bake.ts';
import { clampSlide } from './clamp.ts';
import {
  clearFrameWork,
  type FramePictures,
  frameStats,
  frameUnit,
  frameWorkBytes,
  framesInProgress,
  splitFrame,
  underFrame,
  wholeSplit,
} from './frame.ts';
import { picture, slideOf, square, squares, textBox } from './frame.test-util.ts';
import { BASE, gridTable, tableShape } from './table/test-util.ts';
import { drawObject, drawSlide2D } from './text2d.ts';
import { boxFont } from './text/blankface.ts';
import { type FontFile, FontResolver, installFontEnv, LEGACY_FONT_ENV } from './text/fonts.ts';
import { loneChain, panel } from './units.effects.test-util.ts';
import { clearUnits, setUnitMedia, unitCache } from './units.ts';

/*
 * Browser side of bake.browser.test.ts: the bake and the encoders in headless Chromium on software canvases, with
 * faces built in memory (`boxFont`: box glyphs for chosen code points), so coverage is exact and no system font is
 * needed. Each scenario resets the module state it touches and returns plain data.
 */

// ── Faces and environments ───────────────────────────────────────────────────────────────────────────────

const ASCII: [number, number, number][] = [
  [0x20, 0x20, 2],
  [0x21, 0x7e, 1],
];
const FACES: Record<string, { ranges: [number, number, number][] }> = {
  Inter: { ranges: [...ASCII, [0x2022, 0x2022, 1]] },
  Acme: { ranges: ASCII },
  Zed: { ranges: ASCII },
  'Noto Sans SC': { ranges: [[0x4e00, 0x4e1f, 1]] },
};

const bytesOf = new Map<string, ArrayBuffer>();
function faceBytes(family: string): ArrayBuffer {
  const hash = `h-${family}`;
  let b = bytesOf.get(hash);
  if (!b) {
    const u = boxFont({
      family,
      glyphs: [
        { advance: 500, box: [50, 0, 450, 700] },
        { advance: 600, box: [60, 0, 540, 700] },
        { advance: 300 },
      ],
      ranges: FACES[family]!.ranges,
    });
    b = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
    bytesOf.set(hash, b);
  }
  return b;
}

const fileOf = (family: string): FontFile => ({ family, weight: 400, style: 'normal', hash: `h-${family}` });

export type EnvOptions = {
  /** Families that are not in the library. */
  omit?: string[];
  /** Families whose file cannot be read. */
  fail?: string[];
};

type Setup = {
  env: ReturnType<typeof createBakeEnv>;
  files: FontFile[];
  inputs: Parameters<typeof pictureSource>[2];
};

async function newEnv(o: EnvOptions = {}): Promise<Setup> {
  clearUnits();
  clearFrameWork();
  setUnitMedia(undefined);
  const failing = new Set((o.fail ?? []).map((f) => `h-${f}`));
  const files = Object.keys(FACES)
    .filter((f) => !(o.omit ?? []).includes(f))
    .map(fileOf);
  const env = createBakeEnv({
    set: document.fonts,
    async data(f) {
      if (failing.has(f.hash)) throw new Error('file unavailable');
      return faceBytes(f.family);
    },
    retry: { firstMs: 3_600_000, maxMs: 3_600_000 },
    timeoutMs: 20_000,
  });
  const synced = await env.fonts.sync(files);
  const expected = failing.size;
  if (synced.failed.length !== expected) throw new Error(`faces failed to load: ${synced.failed.join('; ')}`);
  if (!(await env.ready())) throw new Error('the blank face did not load');
  const inputs = {
    mediaFile: (id: string) => `file-${id}`,
    fonts: files.map((f) => ({ family: f.family, file: { hash: f.hash } })),
  };
  return { env, files, inputs };
}

async function withEnv<T>(o: EnvOptions, fn: (s: Setup) => Promise<T>): Promise<T> {
  const s = await newEnv(o);
  try {
    return await fn(s);
  } finally {
    s.env.dispose();
    installFontEnv(LEGACY_FONT_ENV);
    clearUnits();
    clearFrameWork();
  }
}

// ── Pictures ─────────────────────────────────────────────────────────────────────────────────────────────

function canvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('2D context unavailable');
  return c;
}

function flat(w: number, h: number, rgb: string): OffscreenCanvas {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d')!;
  x.fillStyle = rgb;
  x.fillRect(0, 0, w, h);
  x.fillStyle = 'rgb(255,255,255)';
  x.fillRect(0, 0, w / 4, h / 4);
  return c;
}

type ProviderOptions = {
  missing?: string[];
  broken?: string[];
  delayMs?: number;
  onAcquire?: (n: number) => void;
};

function provider(o: ProviderOptions = {}) {
  const media: Record<string, OffscreenCanvas> = {};
  const src = (id: string) =>
    (media[id] ??= flat(200, 150, `rgb(${(id.length * 37 + id.charCodeAt(id.length - 1)) % 255},90,160)`));
  const state = { held: 0, maxHeld: 0, acquired: 0 };
  const p: FramePictures = {
    async acquire(obj) {
      state.acquired++;
      o.onAcquire?.(state.acquired);
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      if (o.missing?.includes(obj.mediaId))
        return { lookup: () => undefined, release: () => undefined, missing: `media:${obj.mediaId}` };
      state.held++;
      state.maxHeld = Math.max(state.maxHeld, state.held);
      const lookup = o.broken?.includes(obj.mediaId)
        ? () => ({ width: 100, height: 100 }) as never
        : (id: string) => src(id);
      return {
        lookup: lookup as never,
        release: () => {
          state.held--;
        },
      };
    },
  };
  return { p, state, lookup: (id: string) => src(id) };
}

// ── Subjects ─────────────────────────────────────────────────────────────────────────────────────────────

const importedSquare = (): ShapeObject => ({ ...square(7000), id: 'imp', origin: { src: 'pptx' } });

/** The subjects of the exactness and parity tests (the brief's P1 to P5). */
function subject(name: string): Slide {
  switch (name) {
    case 'p1': {
      const pics = Array.from({ length: 6 }, (_, i) =>
        picture(`pic${i}`, `photo${i}`, { x: 100 + i * 290, y: 700, w: 270, h: 200 }),
      );
      return slideOf(
        [
          ...squares(300),
          ...pics,
          textBox('a', 'Alpha', 100, 100),
          textBox('b', 'Beta', 100, 250),
          textBox('c', 'Gamma'),
          textBox('d', 'Delta'),
        ],
        'p1',
      );
    }
    case 'p2': {
      const panels: SlideObject[] = [];
      for (let i = 0; i < 4; i++) panels.push(panel(`pa${i}`, 100 + i * 330, 80 + (i % 2) * 40, 600, 380, i));
      return slideOf([loneChain(), ...panels, ...squares(300)], 'p2');
    }
    case 'p3':
      return {
        ...slideOf([importedSquare(), textBox('own', 'Mine', 200, 300), square(1)], 'p3'),
        pptx: { show: 'picture', refMediaId: 'refpic' } as never,
      };
    case 'p4':
      return {
        ...slideOf([textBox('own', 'Mine', 200, 300), square(2)], 'p4'),
        imported: { fileId: 'f', page: 0, imageMediaId: 'pagepic' } as never,
      };
    default:
      return slideOf([square(3)], 'p5');
  }
}

/** The slide's objects drawn one after the other onto a transparent canvas, after its own picture. */
function reference(
  slide: Slide,
  scale: number,
  lookup: (id: string) => OffscreenCanvas,
): OffscreenCanvasRenderingContext2D {
  const w = Math.round(1920 * scale);
  const h = Math.round(1080 * scale);
  const c = canvas(w, h);
  const bake = clampSlide(slide, 'bake');
  drawSlide2D(c as never, { ...bake, objects: [] }, { scale, images: lookup as never });
  for (const o of slideContent(bake).objects) drawObject(c as never, o, scale, lookup as never);
  return c;
}

type Diff = { maxDiff: number; over1: number; over2: number; painted: number; pixels: number };

function diff(a: OffscreenCanvas, b: OffscreenCanvas): Diff {
  const w = a.width;
  const h = a.height;
  const da = a.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const db = b.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  let maxDiff = 0;
  let over1 = 0;
  let over2 = 0;
  let painted = 0;
  for (let i = 0; i < da.length; i += 4) {
    let m = 0;
    for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(da[i + k]! - db[i + k]!));
    if (m > maxDiff) maxDiff = m;
    if (m > 1) over1++;
    if (m > 2) over2++;
    if (da[i + 3]! > 0) painted++;
  }
  return { maxDiff, over1, over2, painted, pixels: w * h };
}

type Leftovers = { inProgress: number; workBytes: number; cacheBytes: number };
const leftovers = (): Leftovers => ({
  inProgress: framesInProgress(),
  workBytes: frameWorkBytes(),
  cacheBytes: unitCache.bytes('unit'),
});

type Summary = {
  ok: boolean;
  reason?: string;
  detail?: string;
  text?: string;
  standIns?: readonly string[];
  opaque?: boolean;
  width?: number;
  height?: number;
  leftovers: Leftovers;
  held: number;
  maxHeld: number;
  acquired: number;
  ms?: Record<string, number>;
  objects?: number;
};

function summary(r: BakeResult, pv: ReturnType<typeof provider>): Summary {
  const base = {
    leftovers: leftovers(),
    held: pv.state.held,
    maxHeld: pv.state.maxHeld,
    acquired: pv.state.acquired,
  };
  if (r.ok)
    return {
      ...base,
      ok: true,
      opaque: r.opaque,
      width: r.width,
      height: r.height,
      standIns: r.standIns,
      ms: r.stats.ms,
      objects: r.stats.objects,
    };
  return {
    ...base,
    ok: false,
    reason: r.reason,
    detail: r.detail,
    text: failureText(r),
    standIns: r.standIns,
    ms: r.stats.ms,
  };
}

async function bake(
  s: Setup,
  slide: Slide,
  pv: ReturnType<typeof provider>,
  extra: Partial<BakeOptions> = {},
): Promise<BakeResult> {
  return bakeSlide(slide, { env: s.env, pictures: pv.p, scale: 1, ...extra });
}

// ── Scenarios ────────────────────────────────────────────────────────────────────────────────────────────

/** T1: the bake against the same objects drawn one after the other. */
async function exactness(a: { subject: string; scale: number }) {
  return withEnv({}, async (s) => {
    const pv = provider();
    const slide = subject(a.subject);
    const made = await bake(s, slide, pv, { scale: a.scale });
    if (!made.ok) return { ok: false as const, reason: made.reason, detail: made.detail };
    const ref = reference(slide, a.scale, pv.lookup);
    const d = diff(made.canvas, ref.canvas as OffscreenCanvas);
    made.canvas.width = 0;
    return { ok: true as const, ...d, opaque: made.opaque, maxHeld: pv.state.maxHeld };
  });
}

/** T2 and T6: the bake against the production live whole draw (frame plus direct part). */
async function liveWhole(a: { subject: string; scale: number }) {
  return withEnv({}, async (s) => {
    const pv = provider();
    const slide = subject(a.subject);
    const made = await bake(s, slide, pv, { scale: a.scale });
    if (!made.ok) return { ok: false as const, reason: made.reason, detail: made.detail };
    clearUnits();
    clearFrameWork();
    const w = Math.round(1920 * a.scale);
    const h = Math.round(1080 * a.scale);
    const live = canvas(w, h);
    const sp = splitFrame(slide, a.scale);
    if (sp) {
      await frameUnit(sp, { pictures: pv.p }).make({ slice: async (fn) => fn(), check: () => undefined });
      drawSlide2D(live as never, sp.direct, {
        scale: a.scale,
        images: pv.lookup as never,
        under: underFrame(sp),
      });
    } else drawSlide2D(live as never, slide, { scale: a.scale, images: pv.lookup as never });
    const d = diff(made.canvas, live.canvas as OffscreenCanvas);
    made.canvas.width = 0;
    return { ok: true as const, ...d, split: !!sp };
  });
}

const FONT_RE = /^(?:(?:italic|oblique|small-caps|bold|normal|\d+) )*[\d.]+px (.*)$/;

/** Every CSS font string assigned to a context while `fn` draws, recorded at each text call. */
async function recordFonts<T>(fn: () => Promise<T>): Promise<{ result: T; strings: string[] }> {
  const proto = OffscreenCanvasRenderingContext2D.prototype as unknown as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  const fill = proto.fillText!;
  const stroke = proto.strokeText!;
  const seen = new Set<string>();
  proto.fillText = function (this: { font: string }, ...a: unknown[]) {
    seen.add(this.font);
    return fill.apply(this, a);
  };
  proto.strokeText = function (this: { font: string }, ...a: unknown[]) {
    seen.add(this.font);
    return stroke.apply(this, a);
  };
  try {
    const result = await fn();
    return { result, strings: [...seen] };
  } finally {
    proto.fillText = fill;
    proto.strokeText = stroke;
  }
}

const familiesOf = (font: string): string[] =>
  (FONT_RE.exec(font)?.[1] ?? font)
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

/** A text-heavy slide: Latin with fallbacks, Han with a script fallback, runs in other families, a bullet, a table cell, shadow and glow, gradient text. */
function textHeavy(): Slide {
  const style = { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Acme', fontSizePx: 40, fallbackFonts: ['Zed'] };
  const objs: SlideObject[] = [
    { ...textBox('latin', 'Hello world 123', 100, 60, 800, 80), style } as TextObject,
    { ...textBox('han', '一丁 and Latin', 100, 160, 800, 80), style } as TextObject,
    {
      ...textBox('runs', 'plain and other', 100, 260, 800, 80),
      style,
      runs: [{ start: 10, end: 15, fontFamily: 'Zed' }],
    } as TextObject,
    {
      ...textBox('bullet', 'one\ntwo', 100, 360, 800, 160),
      style,
      paras: [{ bullet: { char: '•', fontFamily: 'Inter' } }, { bullet: { char: '•' } }],
    } as never,
    {
      ...textBox('glow', 'Glow and shadow', 100, 560, 800, 80),
      style: {
        ...style,
        shadow: { dx: 4, dy: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.6 } },
        glow: { radius: 10, color: { r: 255, g: 200, b: 0, a: 1 } },
      },
    } as TextObject,
    {
      ...textBox('paint', 'Gradient text', 100, 660, 800, 80),
      style: {
        ...style,
        paint: {
          kind: 'linear',
          angle: 0,
          stops: [
            { at: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
            { at: 1, color: { r: 0, g: 0, b: 255, a: 1 } },
          ],
        },
      },
    } as TextObject,
    tableShape(gridTable(2, 2, { base: { ...BASE, fontFamily: 'Acme' } }), { x: 1000, y: 100 }),
  ];
  return slideOf(objs, 'text-heavy');
}

/** T3: only registered faces. */
async function onlyRegistered() {
  const live = await withEnv({}, async (s) => {
    // The control: the LIVE profile (and the legacy chain) over the same faces.
    const resolver = new FontResolver();
    for (const f of s.files) resolver.loaded({ family: f.family, internal: s.env.fonts.nameOf(f.family)! });
    installFontEnv(resolver);
    const c = canvas(1920, 1080);
    const slide = clampSlide(
      { ...textHeavy(), objects: textHeavy().objects.filter((o) => o.type === 'text') },
      'bake',
    );
    const rec = await recordFonts(async () => {
      for (const o of slide.objects) drawObject(c as never, o, 1);
    });
    return rec.strings;
  });
  return withEnv({}, async (s) => {
    const pv = provider();
    const slide = textHeavy();
    const rec = await recordFonts(() => bake(s, slide, pv));
    const r = rec.result;
    const internal = /^o[0-9a-f]{8}$/;
    const blank = /^o-blank-[0-9a-f]{8}$/;
    const names = rec.strings.flatMap(familiesOf);
    const stray = names.filter((n) => !internal.test(n) && !blank.test(n));
    // The library families the internal names stand for, and the families the key's chain holds.
    const libraryFamilies = Object.keys(FACES).filter((f) => names.includes(s.env.fonts.nameOf(f) ?? '-'));
    const faces = pictureSource(slide, [], s.inputs).fonts.faces;
    const chainKeys = Object.keys(faces);
    const report = s.env.fonts.bakeReport();
    if (r.ok) r.canvas.width = 0;
    return {
      ok: r.ok,
      reason: r.ok ? undefined : r.reason,
      detail: r.ok ? undefined : r.detail,
      strings: rec.strings.length,
      stray,
      libraryFamilies: libraryFamilies.map((f) => f.toLowerCase()),
      chainKeys,
      reportChain: report.chain,
      liveStrings: live,
      liveFamilies: live.flatMap(familiesOf),
    };
  });
}

type AbortCase = {
  slide: Slide;
  env?: EnvOptions;
  provider?: ProviderOptions;
  options?: Partial<BakeOptions>;
  before?: (s: Setup) => void;
};

const richStyle = { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Acme', fontSizePx: 40 };
const textWith = (id: string, text: string, extra: Partial<TextObject['style']> = {}): TextObject =>
  ({ ...textBox(id, text, 100, 100, 800, 120), style: { ...richStyle, ...extra } }) as TextObject;

function pictures(n: number): ImageObject[] {
  return Array.from({ length: n }, (_, i) =>
    picture(`pic${i}`, `photo${i}`, {
      x: 40 + (i % 10) * 180,
      y: 300 + Math.floor(i / 10) * 140,
      w: 170,
      h: 130,
    }),
  );
}

function abortCase(name: string): AbortCase {
  const gradient = {
    kind: 'linear' as const,
    angle: 0,
    stops: [
      { at: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
      { at: 1, color: { r: 0, g: 0, b: 255, a: 1 } },
    ],
  };
  switch (name) {
    case 'coverage-plain':
      return { slide: slideOf([square(0), textWith('t', 'price €5')], 'c1') };
    case 'coverage-shadow-glow':
      return {
        slide: slideOf(
          [
            square(0),
            textWith('t', 'glow €', {
              shadow: { dx: 4, dy: 4, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.6 } },
              glow: { radius: 10, color: { r: 255, g: 200, b: 0, a: 1 } },
            }),
          ],
          'c2',
        ),
      };
    case 'coverage-table':
      return {
        slide: slideOf(
          [
            square(0),
            tableShape(
              gridTable(2, 2, {
                base: { ...BASE, fontFamily: 'Acme' },
                cells: [{ text: 'r0c0' }, { text: 'r0c1 €' }, { text: 'r1c0' }, { text: 'r1c1' }],
              }),
            ),
          ],
          'c3',
        ),
      };
    case 'coverage-gradient':
      return { slide: slideOf([square(0), textWith('t', 'paint €', { paint: gradient })], 'c4') };
    case 'font-failed':
      return { slide: slideOf([square(0), textWith('t', 'plain words')], 'f1'), env: { fail: ['Acme'] } };
    case 'font-empty':
      return {
        slide: slideOf([square(0), textWith('t', 'plain words')], 'f2'),
        env: { omit: ['Acme', 'Inter'] },
      };
    case 'standin':
      return {
        slide: slideOf([square(0), textWith('t', 'plain words', { fontFamily: 'Garamond' })], 'f3'),
      };
    case 'standin-abort':
      return {
        slide: slideOf([square(0), textWith('t', 'plain words', { fontFamily: 'Garamond' })], 'f4'),
        options: { standIns: 'abort' },
      };
    case 'media':
      return { slide: slideOf([...squares(3), ...pictures(4)], 'm1'), provider: { missing: ['photo2'] } };
    case 'files':
      return {
        slide: slideOf(
          [square(0), { ...square(1), id: 'g', geom: { ref: 'a'.repeat(64), w: 100, h: 100 } as never }],
          'files',
        ),
      };
    case 'draw':
      return { slide: slideOf([...squares(3), ...pictures(3)], 'd1'), provider: { broken: ['photo1'] } };
    case 'cut':
      return { slide: slideOf(squares(20_001), 'cut') };
    case 'animated-play':
      return {
        slide: slideOf(
          [
            square(0),
            {
              ...picture('vid', 'photo0', { x: 10, y: 10, w: 200, h: 100 }),
              play: { mediaId: 'clip' } as never,
            },
          ],
          'a1',
        ),
      };
    case 'animated-hidden':
      return {
        slide: slideOf(
          [square(0), { ...textWith('t', 'one\ntwo'), paras: [{}, { hidden: true }] as never }],
          'a2',
        ),
      };
    case 'animated-live':
      return {
        slide: slideOf(
          [square(0), { ...textWith('t', 'one\ntwo'), paras: [{}, { hidden: true }] as never }],
          'a3',
        ),
        options: { live: ['t'] },
      };
    case 'cancelled':
      return { slide: slideOf([...squares(3), ...pictures(30)], 'x1') };
    case 'time':
      return { slide: slideOf([...squares(3), ...pictures(12)], 't1') };
    case 'fonts':
      return { slide: slideOf([...squares(3), ...pictures(6)], 'n1') };
    case 'blank':
      return {
        slide: slideOf(
          [
            { ...square(0), opacity: 0 },
            { ...square(1), opacity: 0 },
          ],
          'b1',
        ),
      };
    case 'frame':
      return { slide: slideOf([square(0), square(1)], 'fr') };
    default:
      return { slide: slideOf([square(0)], 'ok') };
  }
}

/** T4: one abort, and what it leaves behind. */
async function abort(a: { name: string }) {
  const c = abortCase(a.name);
  return withEnv(c.env ?? {}, async (s) => {
    const opts: { -readonly [K in keyof BakeOptions]?: BakeOptions[K] } = { ...c.options };
    let acquired = 0;
    const po: ProviderOptions = { ...c.provider };
    if (a.name === 'cancelled') {
      po.onAcquire = (n) => {
        acquired = n;
      };
      opts.cancelled = () => acquired >= 3;
    }
    if (a.name === 'time') {
      let t = 0;
      opts.now = () => (t += 10);
      opts.deadlineMs = 200;
    }
    if (a.name === 'fonts')
      po.onAcquire = (n) => {
        if (n === 2) s.env.fonts.loaded({ family: 'Later', internal: 'o99999999' });
      };
    const pv = provider(po);
    let restore: (() => void) | undefined;
    if (a.name === 'frame') {
      const real = globalThis.OffscreenCanvas;
      (globalThis as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
        constructor() {
          throw new Error('no canvas');
        }
      };
      restore = () => {
        (globalThis as { OffscreenCanvas: unknown }).OffscreenCanvas = real;
      };
    }
    try {
      const r = await bake(s, c.slide, pv, opts);
      const out = summary(r, pv);
      if (r.ok) r.canvas.width = 0;
      return out;
    } finally {
      restore?.();
    }
  });
}

/** `profile`: the installed environment is not the bake resolver, so nothing is drawn. */
async function profileRefusal() {
  return withEnv({}, async (s) => {
    const pv = provider();
    const out: Record<string, Summary> = {};
    installFontEnv(LEGACY_FONT_ENV);
    out.legacy = summary(await bake(s, slideOf([...squares(2), ...pictures(2)], 'p'), pv), pv);
    const live = new FontResolver();
    installFontEnv(live);
    out.live = summary(await bake(s, slideOf([...squares(2), ...pictures(2)], 'p'), pv), pv);
    return out;
  });
}

/** `busy`: a second concurrent call. */
async function busy() {
  return withEnv({}, async (s) => {
    const pv = provider({ delayMs: 5 });
    const slide = slideOf([...squares(3), ...pictures(3)], 'busy');
    const a = bake(s, slide, pv);
    const b = bake(s, slide, pv);
    const [ra, rb] = await Promise.all([a, b]);
    const after = await bake(s, slide, provider());
    const out = { first: summary(ra, pv), second: summary(rb, pv), after: after.ok };
    if (ra.ok) ra.canvas.width = 0;
    if (after.ok) after.canvas.width = 0;
    return out;
  });
}

/** T5: one picture at a time. */
async function oneAtATime() {
  return withEnv({}, async (s) => {
    const pv = provider();
    const slide = slideOf(
      [...squares(5), ...pictures(300).map((p, i) => ({ ...p, mediaId: `photo${i % 40}` }))],
      'many',
    );
    const r = await bake(s, slide, pv);
    if (r.ok) r.canvas.width = 0;
    return { ok: r.ok, maxHeld: pv.state.maxHeld, acquired: pv.state.acquired, held: pv.state.held };
  });
}

/** T7: the live set. */
async function liveSet() {
  return withEnv({}, async (s) => {
    const pv = provider();
    const full = slideOf(
      [...squares(6), textBox('a', 'Alpha', 100, 100), textBox('b', 'Beta', 100, 400)],
      'live',
    );
    const without = slideOf(
      full.objects.filter((o) => o.id !== 'sq2' && o.id !== 'b'),
      'live-without',
    );
    const withLive = await bake(s, full, pv, { live: ['sq2', 'b'] });
    const plain = await bake(s, without, pv);
    let d: Diff | undefined;
    if (withLive.ok && plain.ok) d = diff(withLive.canvas, plain.canvas);
    if (withLive.ok) withLive.canvas.width = 0;
    if (plain.ok) plain.canvas.width = 0;
    const drawn = drawnPart(full, ['sq2', 'b']).objects.length;
    const under = wholeSplit(full, 1, { live: ['sq2', 'b'] }).under.length;
    // the record default: a slide that carries its live set bakes without it
    const withRecord: Slide = {
      ...full,
      prerender: { why: 'count', file: 'f', live: ['sq2', 'b'], uses: [] } as never,
    };
    const viaRecord = await bake(s, withRecord, pv);
    let d2: Diff | undefined;
    const again = await bake(s, without, pv);
    if (viaRecord.ok && again.ok) d2 = diff(viaRecord.canvas, again.canvas);
    if (viaRecord.ok) viaRecord.canvas.width = 0;
    if (again.ok) again.canvas.width = 0;
    return { ok: withLive.ok && plain.ok, maxDiff: d?.maxDiff, drawn, under, recordMaxDiff: d2?.maxDiff };
  });
}

/** T8: no cache across bakes. */
async function noCache() {
  return withEnv({}, async (s) => {
    const pv = provider();
    const slide = subject('p1');
    const before = frameStats().made;
    const a = await bake(s, slide, pv);
    const cacheAfterFirst = unitCache.bytes('unit');
    const b = await bake(s, slide, pv);
    const made = frameStats().made - before;
    let d: Diff | undefined;
    if (a.ok && b.ok) d = diff(a.canvas, b.canvas);
    if (a.ok) a.canvas.width = 0;
    if (b.ok) b.canvas.width = 0;
    return { ok: a.ok && b.ok, made, cacheAfterFirst, maxDiff: d?.maxDiff, left: leftovers() };
  });
}

/** The first bake of a slide, then the same slide object baked again after the font set lost a face: the report is complete either way (the layouts are not cached across bakes). */
async function reportAfterCache() {
  return withEnv({}, async (s) => {
    const pv = provider();
    const slide = slideOf([square(0), textWith('t', 'plain words', { fontFamily: 'Garamond' })], 'cached');
    const first = await bake(s, slide, pv);
    const second = await bake(s, slide, pv);
    if (first.ok) first.canvas.width = 0;
    if (second.ok) second.canvas.width = 0;
    return { first: first.ok ? first.standIns : null, second: second.ok ? second.standIns : null };
  });
}

/** The own background is not baked (E8): the picture does not change with `backgroundMediaId`. */
async function ownBackground() {
  return withEnv({}, async (s) => {
    const pv = provider();
    const base = slideOf([...squares(5), textBox('a', 'Alpha')], 'bg');
    const variants: (string | undefined)[] = [undefined, 'photo0', 'photo1', 'a-video'];
    const out: { opaque: boolean; bytes: number[]; keys: string[] }[] = [];
    const pics: Uint8Array[] = [];
    const opaque: boolean[] = [];
    const keys: string[] = [];
    for (const v of variants) {
      const slide = v ? { ...base, backgroundMediaId: v } : base;
      const made = await bake(s, slide, pv);
      if (!made.ok) throw new Error(`bake failed: ${made.reason}`);
      opaque.push(made.opaque);
      const enc = await encodePicture(made);
      if (!enc.ok) throw new Error(`encode failed: ${enc.reason}`);
      pics.push(new Uint8Array(await enc.pictures.find((p) => p.size === 1920)!.blob.arrayBuffer()));
      keys.push(JSON.stringify(drawnPart(slide).objects.length) + pictureSource(slide, [], s.inputs).slide);
    }
    void out;
    const same = pics.every((p) => p.length === pics[0]!.length && p.every((b, i) => b === pics[0]![i]));
    return { same, opaque, sameKey: new Set(keys).size === 1, sizes: pics.map((p) => p.length) };
  });
}

// ── Encoders ─────────────────────────────────────────────────────────────────────────────────────────────

async function bytesOfBlob(b: Blob, n = 64): Promise<Uint8Array> {
  return new Uint8Array(await b.slice(0, n).arrayBuffer());
}

/** A bake at scale 2 encoded: sizes, types, headers, opacity, hygiene. */
async function encode(a: { subject: string; translucent?: boolean; maxBytes?: number }) {
  return withEnv({}, async (s) => {
    const pv = provider();
    const slide = a.translucent
      ? slideOf(
          [{ ...square(0), box: { x: 100, y: 100, w: 600, h: 400, rotation: 0 }, opacity: 0.5 }],
          'translucent',
        )
      : a.subject === 'opaque'
        ? slideOf(
            [
              {
                ...square(0),
                box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
                fill: { r: 20, g: 60, b: 120, a: 1 },
              },
              textBox('t', 'Alpha beta'),
              ...squares(30),
            ],
            'opaque',
          )
        : subject(a.subject);
    const made = await bake(s, slide, pv, { scale: 2 });
    if (!made.ok) return { ok: false as const, reason: made.reason, detail: made.detail };
    const canvases: OffscreenCanvas[] = [];
    const r = await encodePicture(made, { canvases, ...(a.maxBytes ? { maxBytes: a.maxBytes } : {}) });
    const hygiene = canvases.map((c) => c.width);
    if (!r.ok)
      return { ok: false as const, reason: r.reason, detail: r.detail, hygiene, madeOpaque: made.opaque };
    const pics = [];
    for (const p of r.pictures) {
      const head = readPictureHeader(await bytesOfBlob(p.blob, 4096));
      const bytes = await bytesOfBlob(p.blob, 32);
      pics.push({
        size: p.size,
        type: p.type,
        bytes: p.bytes,
        head,
        riff: String.fromCharCode(...bytes.slice(8, 12)),
        webpFlags: p.type === 'image/webp' ? bytes[20] : undefined,
        png: p.type === 'image/png' ? bytes[25] : undefined,
        mime: p.blob.type,
      });
    }
    return { ok: true as const, opaque: r.opaque, madeOpaque: made.opaque, pics, hygiene, ms: r.stats.ms };
  });
}

/** E3: the 1920 copy against a live 1080p draw of the same slide (mean SSIM over the text boxes' rectangles). */
async function copySsim() {
  return withEnv({}, async (s) => {
    const pv = provider();
    const slide = slideOf(
      [
        {
          ...square(0),
          box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
          fill: { r: 20, g: 60, b: 120, a: 1 },
        },
        ...squares(30),
        textBox('a', 'Alpha beta gamma', 100, 100, 900, 120),
        textBox('b', 'Delta epsilon', 100, 400, 900, 120),
      ],
      'ssim',
    );
    const made = await bake(s, slide, pv, { scale: 2 });
    if (!made.ok) return { ok: false as const, reason: made.reason };
    const enc = await encodePicture(made);
    if (!enc.ok) return { ok: false as const, reason: enc.reason, detail: enc.detail };
    const half = enc.pictures.find((p) => p.size === 1920)!;
    const bmp = await createImageBitmap(half.blob);
    const got = canvas(1920, 1080);
    got.drawImage(bmp, 0, 0);
    bmp.close();
    const liveCanvas = canvas(1920, 1080);
    drawSlide2D(liveCanvas as never, slide, { scale: 1, images: pv.lookup as never });
    const scores = [
      ssimRect(got, liveCanvas, 100, 100, 900, 120),
      ssimRect(got, liveCanvas, 100, 400, 900, 120),
    ];
    return { ok: true as const, scores, mean: scores.reduce((x, y) => x + y, 0) / scores.length };
  });
}

/** Mean SSIM over 8x8 luma windows of a rectangle. */
function ssimRect(
  a: OffscreenCanvasRenderingContext2D,
  b: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const da = a.getImageData(x, y, w, h).data;
  const db = b.getImageData(x, y, w, h).data;
  const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let sum = 0;
  let n = 0;
  for (let wy = 0; wy + 8 <= h; wy += 8)
    for (let wx = 0; wx + 8 <= w; wx += 8) {
      let ma = 0;
      let mb = 0;
      for (let j = 0; j < 8; j++)
        for (let i = 0; i < 8; i++) {
          const k = ((wy + j) * w + wx + i) * 4;
          ma += luma(da, k);
          mb += luma(db, k);
        }
      ma /= 64;
      mb /= 64;
      let va = 0;
      let vb = 0;
      let cv = 0;
      for (let j = 0; j < 8; j++)
        for (let i = 0; i < 8; i++) {
          const k = ((wy + j) * w + wx + i) * 4;
          const la = luma(da, k) - ma;
          const lb = luma(db, k) - mb;
          va += la * la;
          vb += lb * lb;
          cv += la * lb;
        }
      va /= 63;
      vb /= 63;
      cv /= 63;
      sum += ((2 * ma * mb + c1) * (2 * cv + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      n++;
    }
  return sum / Math.max(1, n);
}

/** E4: the round trip passes a fresh picture and fails a truncated one, a foreign one and a changed row. */
async function roundTrip() {
  return withEnv({}, async (s) => {
    const pv = provider();
    const make = async (slide: Slide) => {
      const made = await bake(s, slide, pv, { scale: 2 });
      if (!made.ok) throw new Error(made.reason);
      return made;
    };
    const slide = slideOf(
      [
        {
          ...square(0),
          box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
          fill: { r: 20, g: 60, b: 120, a: 1 },
        },
        ...squares(40),
      ],
      'rt',
    );
    const made = await make(slide);
    const rgb = new OffscreenCanvas(made.width, made.height);
    const x = rgb.getContext('2d', { alpha: false })!;
    x.drawImage(made.canvas, 0, 0);
    made.canvas.width = 0;
    const png = await rgb.convertToBlob({ type: 'image/png' });
    const out: Record<string, unknown> = {};
    out.fresh = await verifyPicture(png, rgb, { opaque: true });
    out.truncated = await verifyPicture(png.slice(0, Math.floor(png.size * 0.9), 'image/png'), rgb, {
      opaque: true,
    });
    const other = await make(
      slideOf(
        [
          {
            ...square(5),
            box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
            fill: { r: 200, g: 20, b: 20, a: 1 },
          },
        ],
        'other',
      ),
    );
    const otherRgb = new OffscreenCanvas(other.width, other.height);
    otherRgb.getContext('2d', { alpha: false })!.drawImage(other.canvas, 0, 0);
    other.canvas.width = 0;
    out.foreign = await verifyPicture(await otherRgb.convertToBlob({ type: 'image/png' }), rgb, {
      opaque: true,
    });
    // a changed row inside a sampled tile
    const tiles = tileOrigins(rgb.width, rgb.height, png.size);
    const t = tiles[10]!;
    const changed = new OffscreenCanvas(rgb.width, rgb.height);
    const cx = changed.getContext('2d', { alpha: false })!;
    cx.drawImage(rgb, 0, 0);
    const row = cx.getImageData(t.x, t.y + 5, 128, 1);
    for (let i = 0; i < row.data.length; i += 4) row.data[i] = (row.data[i]! + 40) % 256;
    cx.putImageData(row, t.x, t.y + 5);
    out.changedRow = await verifyPicture(await changed.convertToBlob({ type: 'image/png' }), rgb, {
      opaque: true,
    });
    out.tiles = tiles.length;
    rgb.width = 0;
    otherRgb.width = 0;
    changed.width = 0;
    return out;
  });
}

/** E7: the decoded bitmap of the round trip is closed. */
async function bitmapClosed() {
  return withEnv({}, async (s) => {
    const pv = provider();
    const made = await bake(s, slideOf([...squares(10)], 'bc'), pv, { scale: 2 });
    if (!made.ok) return { ok: false };
    const real = globalThis.createImageBitmap;
    const made_: ImageBitmap[] = [];
    let closed = 0;
    (globalThis as { createImageBitmap: unknown }).createImageBitmap = async (...a: unknown[]) => {
      const b = await (real as (...x: unknown[]) => Promise<ImageBitmap>)(...a);
      const close = b.close.bind(b);
      b.close = () => {
        closed++;
        close();
      };
      made_.push(b);
      return b;
    };
    try {
      const r = await encodePicture(made);
      return { ok: r.ok, decoded: made_.length, closed };
    } finally {
      (globalThis as { createImageBitmap: unknown }).createImageBitmap = real;
    }
  });
}

/** E6 and G17: two bakes in one browser give identical bytes. */
async function determinism() {
  return withEnv({}, async (s) => {
    const out: Record<string, number[][]> = {};
    for (const name of ['p1', 'text']) {
      const slides = name === 'text' ? textHeavy() : subject('p1');
      const runs: number[][] = [];
      for (let i = 0; i < 2; i++) {
        const pv = provider();
        const made = await bake(s, slides, pv, { scale: 2 });
        if (!made.ok) throw new Error(`${name}: ${made.reason} ${made.detail}`);
        const enc = await encodePicture(made);
        if (!enc.ok) throw new Error(`${name}: encode ${enc.reason}`);
        const sums: number[] = [];
        for (const p of enc.pictures) {
          const u = new Uint8Array(await p.blob.arrayBuffer());
          let h = 2166136261;
          for (let k = 0; k < u.length; k++) h = Math.imul(h ^ u[k]!, 16777619);
          sums.push(h >>> 0, u.length);
        }
        runs.push(sums);
      }
      out[name] = runs;
    }
    return out;
  });
}

// ── The slides of bakeSlides ─────────────────────────────────────────────────────────────────────────────

async function prepareSlides() {
  const slide = subject('p1');
  const r = bakeSlides(slide);
  return { objects: r.slide.objects.length, under: r.under.map((u) => u.objects.length) };
}

export const SCENARIOS = {
  exactness,
  liveWhole,
  onlyRegistered,
  abort,
  profileRefusal,
  busy,
  oneAtATime,
  liveSet,
  noCache,
  reportAfterCache,
  ownBackground,
  encode,
  copySsim,
  roundTrip,
  bitmapClosed,
  determinism,
  prepareSlides,
};

export type ScenarioName = keyof typeof SCENARIOS;

(globalThis as unknown as { __bake: (name: string, args?: unknown) => Promise<unknown> }).__bake = async (
  name,
  args,
) => (SCENARIOS as Record<string, (a?: unknown) => Promise<unknown>>)[name]!(args);

export type { BakeMade };
