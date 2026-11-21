import {
  DEFAULT_LYRIC_STYLE,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  type Look,
  type Slide,
  type SlideObject,
} from '@ordo/domain';
import {
  type AssetJob,
  type AssetToRender,
  type FromAsset,
  PLANE_FLAGS,
  PLANE_FLOATS,
  PLANE_HAS_OVER,
  PLANE_UV,
  clampSlide,
  SRC_BITMAP,
  SRC_SCENE,
  planeSample,
  preparedKey,
} from '@ordo/renderer';
import {
  clearFrameWork,
  frameProgress,
  frameStats,
  frameWorkKeys,
  framesInProgress,
  splitFrame,
} from '@ordo/renderer/frame.ts';
import {
  effectUnits,
  putUnit,
  UNIT_CACHE_BYTES,
  unitCache,
  unitReady,
  unitsOfSlide,
  unitWork,
} from '@ordo/renderer/units.ts';
import { lineArtSlide } from '@ordo/renderer/units.test-util.ts';
import { cappedSlide } from '@ordo/renderer/decor/test-util.ts';
// The decoration drawer, as the worker's drawers step loads it before a decorated slide's units are planned.
import '@ordo/renderer/decor/index.ts';
import { CONTENT_CASES, contentCase } from '@ordo/domain/content.test-util.ts';
import { RecPath } from '@ordo/renderer/geom/path2d.test-util.ts';
import { geomFile } from '@ordo/renderer/geom/stored.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The asset worker with fakes (design/27 §7.2, SCENE.md item E): its global scope, OffscreenCanvas,
 * createImageBitmap and the hub's file route are stand-ins, the render and link ports are recorders. A
 * picture records what was drawn on its canvas since the last one was taken, so the base and over of a
 * scene can be told apart. Every canvas has its own record: the worker prepares each picture a slide draws
 * on a canvas of its own (`preparePicture`, design/27 §7.1), and a picture prepared that way keeps the tag
 * of the file it was made from. Drawing a closed bitmap throws, as in Chromium.
 */

type FakeBitmap = {
  /** What was drawn on the canvas it was taken from. */
  ops: string[];
  /** The bitmaps drawn on that canvas, in order. */
  drawn: FakeBitmap[];
  /** The file a decode, reduction or prepared picture shows. */
  tag?: string;
  width: number;
  height: number;
  closed: boolean;
  close(): void;
};

const W = 960;
const H = 540;

/**
 * The worker's clock in the tests that time unit making (`performance.now` while `on`): only unit steps move it
 * (`stepMs` each, `fakeCtx`), so how long units take, and when a picture is sent, depends on no real time.
 */
const clock: {
  on: boolean;
  t: number;
  stepMs: number;
  /** Each fill or stroke call on any canvas takes this long of the clock while `on` (0: none). */
  paintMs?: number;
  at?: { t: number; fn: () => void };
} = {
  on: false,
  t: 0,
  stepMs: 0,
};
/** Fill and stroke calls made on every canvas so far (the work a raster or a unit step drew). */
let paints = 0;
const realNow = performance.now.bind(performance);
/** Geometry files the fake hub serves, by hash, and one it does not have. */
const GEOM_READ = 'a'.repeat(64);
const GEOM_GONE = 'b'.repeat(64);
/** One only a warm job reads first. */
const GEOM_WARM = 'c'.repeat(64);
const GEOM_FILES = new Map([
  [GEOM_READ, JSON.stringify({ paths: [{ d: 'M 0 0 L 10 0 L 10 10 Z', w: 10, h: 10 }] })],
  [GEOM_WARM, JSON.stringify({ paths: [{ d: 'M 0 0 L 10 0 L 0 10 Z', w: 10, h: 10 }] })],
]);
/** Geometry files the hub serves only once their gate opens (a slow read: a job reading one waits there). */
const slowGeoms = new Map<string, Promise<void>>();

/** A 2D context that logs fillText and drawImage on `rec` (every glyph is 10 device px wide). */
function fakeCtx(rec: { ops: string[]; drawn: FakeBitmap[] }) {
  const state: Record<string | symbol, unknown> = {
    font: '10px x',
    letterSpacing: '0px',
    globalAlpha: 1,
    // The transform these fakes never move (a decoration's drawer reads it to place its sprite).
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  return new Proxy(state, {
    get(t, k) {
      if (k === 'measureText') return (s: string) => ({ width: s.length * 10 });
      // Nothing drawn reaches a pixel of these fakes: a tight sprite's edge ring reads transparent.
      if (k === 'getImageData')
        return (_x: number, _y: number, w: number, h: number) => {
          // A unit step's flush (a one-pixel read) takes `clock.stepMs` of the test's clock while it runs.
          if (clock.on && w === 1 && h === 1) {
            clock.t += clock.stepMs;
            // Something that happens at a time of the clock (a GO), between two steps.
            const due = clock.at;
            if (due && clock.t >= due.t) {
              clock.at = undefined;
              due.fn();
            }
          }
          return { data: new Uint8ClampedArray(w * h * 4) };
        };
      if (k in t) return t[k];
      return (...args: unknown[]) => {
        if (k === 'fill' || k === 'stroke') {
          paints++;
          if (clock.on && clock.paintMs) clock.t += clock.paintMs;
        }
        if (k === 'fillText') rec.ops.push(`text:${args[0]}`);
        else if (k === 'drawImage') {
          const img = args[0] as FakeBitmap;
          if (img.closed) throw new Error('The image source is detached');
          rec.ops.push(`image:${img.tag}`);
          rec.drawn.push(img);
        }
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
  private readonly rec = { ops: [] as string[], drawn: [] as FakeBitmap[] };
  private ctx = fakeCtx(this.rec);
  private w: number;
  private h: number;
  /** Every size a surface was set to (the asset worker sizes it to each tight sprite). */
  static sizes: [number, number][] = [];
  /** While true, a canvas made has no 2D context (an allocation refused under memory pressure). */
  static refuse2d = false;
  private readonly refused: boolean;
  constructor(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.refused = FakeOffscreenCanvas.refuse2d;
  }
  // Setting a size clears the canvas, as in Chromium.
  get width(): number {
    return this.w;
  }
  set width(v: number) {
    this.w = v;
    this.reset();
  }
  get height(): number {
    return this.h;
  }
  set height(v: number) {
    this.h = v;
    this.reset();
  }
  private reset(): void {
    this.rec.ops.length = 0;
    this.rec.drawn.length = 0;
    FakeOffscreenCanvas.sizes.push([this.w, this.h]);
  }
  getContext() {
    return this.refused ? null : this.ctx;
  }
  transferToImageBitmap(): FakeBitmap {
    const ops = this.rec.ops.splice(0);
    const drawn = this.rec.drawn.splice(0);
    const b: FakeBitmap = {
      ops,
      drawn,
      // A picture prepared from one file shows that file.
      tag: drawn.length === 1 ? drawn[0]!.tag : undefined,
      width: this.width,
      height: this.height,
      closed: false,
      close() {
        b.closed = true;
      },
    };
    return b;
  }
}

const scope: { postMessage: (m: unknown) => void; onmessage: ((ev: { data: unknown }) => void) | null } = {
  postMessage: () => undefined,
  onmessage: null,
};
/**
 * Pictures sent to the renderer, with the units made on the thread, the fill and stroke calls drawn so far and
 * the test's clock when each was sent.
 */
const rendered: {
  msg: AssetToRender;
  transfer: unknown[];
  made: number;
  steps: number;
  paints: number;
  at: number;
}[] = [];
/** Files decoded (createImageBitmap of a fetched file). */
const decoded: string[] = [];
const replies: FromAsset[] = [];
const link: {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(m: FromAsset): void;
  close(): void;
} = {
  onmessage: null,
  postMessage: (m) => replies.push(m),
  close: () => undefined,
};
const render = {
  postMessage: (msg: AssetToRender, transfer: unknown[]) =>
    rendered.push({ msg, transfer, made: unitWork().made, steps: unitWork().steps, paints, at: clock.t }),
  close: () => undefined,
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  vi.spyOn(performance, 'now').mockImplementation(() => (clock.on ? clock.t : realNow()));
  vi.stubGlobal('self', scope);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  // Pictures arrive from the hub's file route, tagged with their hash; the poster is 4:3. Geometry files
  // (`ShapeGeom.ref`) are JSON; one the hub does not have is a 404.
  vi.stubGlobal('fetch', async (url: string) => {
    const hash = /files\/([^?]+)/.exec(url)?.[1] ?? '';
    if (hash === GEOM_GONE) return { status: 404, ok: false, blob: async () => ({}) };
    const gate = slowGeoms.get(hash);
    if (gate) await gate;
    const json = gate ? GEOM_FILES.get(GEOM_READ) : GEOM_FILES.get(hash);
    if (json)
      return { status: 200, ok: true, blob: async () => ({ size: json.length, text: async () => json }) };
    // A file's head (opaque.ts reads it): a .jpg starts with the JPEG marker, anything else is unknown.
    const head = hash.endsWith('.jpg') ? new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) : new Uint8Array(4);
    const slice = () => ({ arrayBuffer: async () => head.buffer });
    return { status: 200, ok: true, blob: async () => ({ hash, size: 4, slice }) };
  });
  vi.stubGlobal('Path2D', RecPath);
  // A decode of a file, or a reduction of a decoded picture (`downscaleFor`), keeps the tag.
  vi.stubGlobal(
    'createImageBitmap',
    async (b: { hash?: string; tag?: string }, o?: { resizeWidth: number; resizeHeight: number }) => {
      if (b.hash) decoded.push(b.hash);
      const tag = b.hash ?? b.tag;
      const bmp = {
        tag,
        width: o?.resizeWidth ?? (tag === 'poster.jpg' ? 400 : 1920),
        height: o?.resizeHeight ?? (tag === 'poster.jpg' ? 300 : 1080),
        closed: false,
        close: () => {
          bmp.closed = true;
        },
      };
      return bmp;
    },
  );
  await import('./asset.worker.ts');
  scope.onmessage!({ data: { t: 'init', width: W, height: H, token: '', apiPrefix: '/api/v1' } });
  scope.onmessage!({ data: { t: 'ports', render, link } });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Send a job and wait for the worker's answer to the link. */
async function run(job: AssetJob): Promise<{ msg?: AssetToRender; transfer?: unknown[]; reply: FromAsset }> {
  rendered.length = 0;
  replies.length = 0;
  link.onmessage!({ data: { t: 'job', job } });
  await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
  return { msg: rendered[0]?.msg, transfer: rendered[0]?.transfer, reply: replies[0]! };
}

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });
const text = (id: string, t: string, b: ReturnType<typeof box>): SlideObject => ({
  id,
  type: 'text',
  box: b,
  text: t,
  style: {
    ...DEFAULT_LYRIC_STYLE,
    fontSizePx: 60,
    padding: 0,
    valign: 'top',
    outline: undefined,
    shadow: undefined,
  },
  opacity: 1,
});
const clip = {
  id: 'vid',
  type: 'image',
  box: box(400, 300, 800, 450),
  mediaId: 'vposter',
  fit: 'contain',
  opacity: 1,
  radius: 0,
  play: { mediaId: 'clip' },
} as SlideObject;
const slide: Slide = {
  id: 's1',
  objects: [
    clip,
    text('title', 'Title', box(500, 250, 600, 120)),
    text('footer', 'Footer', box(100, 900, 400, 100)),
  ],
  imported: { fileId: 'deck', page: 0, imageMediaId: 'page' },
};

function slideJob(over: Partial<Extract<AssetJob, { kind: 'slide' }>> = {}): AssetJob {
  return {
    kind: 'slide',
    layer: 1,
    key: 'sl|3|s1',
    cueIndex: 3,
    slide,
    isSong: false,
    look: LOOK_MAIN,
    images: { vposter: 'poster.jpg', page: 'page.png' },
    video: { objectId: 'vid', slot: 2, gen: 7 },
    ...over,
  };
}

describe('asset worker: slide jobs whose video plays in its box', () => {
  it('answers SRC_SCENE under the unchanged key: base, over, plane, slot and generation', async () => {
    const { msg, transfer, reply } = await run(slideJob({ refresh: true }));
    expect(reply).toMatchObject({ t: 'done', layer: 1, key: 'sl|3|s1' });
    expect(msg).toMatchObject({
      t: 'content',
      layer: 1,
      key: 'sl|3|s1',
      kind: SRC_SCENE,
      cueIndex: 3,
      refresh: true,
      videoSlot: 2,
      videoGen: 7,
    });
    const base = msg!.bitmap as unknown as FakeBitmap;
    const over = msg!.over as unknown as FakeBitmap;
    // The page picture, the poster and the footer are in base; the title over the video is in over.
    expect(base.ops).toEqual(['image:page.png', 'image:poster.jpg', 'text:Footer']);
    expect(over.ops).toEqual(['text:Title']);
    expect(transfer).toEqual([base, over]);
    // The plane at this output's scale (960 / 1920): the box centre is the middle of the clip.
    const plane = msg!.plane!;
    expect(plane).toHaveLength(PLANE_FLOATS);
    expect(plane[PLANE_FLAGS]).toBe(PLANE_HAS_OVER);
    const s = [0, 0, 0];
    planeSample(plane, 400, 262.5, s);
    expect(s[0]).toBeCloseTo(0.5, 5);
    expect(s[1]).toBeCloseTo(0.5, 5);
    expect(s[2]).toBe(1);
  });

  it("fits the video with the clip's size from the job, not the poster's", async () => {
    // The poster is 4:3 (400x300); a 16:9 clip fills the 16:9 box, a 4:3 one is pillarboxed.
    const wide = (await run(slideJob({ video: { objectId: 'vid', slot: 2, gen: 7, w: 1920, h: 1080 } }))).msg;
    expect(wide!.plane![PLANE_UV]).toBeCloseTo(0, 5);
    expect(wide!.plane![PLANE_UV + 2]).toBeCloseTo(1, 5);
    const poster = (await run(slideJob())).msg;
    expect(poster!.plane![PLANE_UV]).toBeCloseTo(-1 / 6, 5);
  });

  it('sends no over when nothing above the video overlaps it', async () => {
    const lone = { ...slide, objects: [clip, slide.objects[2]!] };
    const { msg, transfer } = await run(slideJob({ slide: lone }));
    expect(msg?.kind).toBe(SRC_SCENE);
    expect(msg?.over).toBeNull();
    expect(msg!.plane![PLANE_FLAGS]).toBe(0);
    expect(transfer).toEqual([msg!.bitmap]);
  });

  it('draws one bitmap, the poster included, when the job has no video or the slide is not a scene', async () => {
    const lyric: Look = LOOK_LOWER_THIRD;
    for (const job of [
      slideJob({ video: undefined }),
      slideJob({ video: { objectId: 'gone', slot: 2, gen: 7 } }),
      slideJob({ look: lyric }),
    ]) {
      const { msg, transfer } = await run(job);
      expect(msg?.kind).toBe(SRC_BITMAP);
      expect(msg).not.toHaveProperty('over');
      expect(msg).not.toHaveProperty('plane');
      expect(transfer).toEqual([msg!.bitmap]);
    }
    const { msg } = await run(slideJob({ video: undefined }));
    expect((msg!.bitmap as unknown as FakeBitmap).ops).toEqual([
      'image:page.png',
      'image:poster.jpg',
      'text:Title',
      'text:Footer',
    ]);
  });

  it('draws in base and over the very prepared pictures the slide drawn as one bitmap draws', async () => {
    // A badge above the video that overlaps it goes to over with the title; the poster's size fits the plane.
    const badge = {
      id: 'badge',
      type: 'image',
      box: box(1100, 650, 200, 200),
      mediaId: 'badge',
      fit: 'cover',
      opacity: 1,
      radius: 0,
    } as SlideObject;
    const images = { vposter: 'poster.jpg', page: 'page.png', badge: 'badge.png' };
    for (const stopped of [true, false]) {
      const play = stopped
        ? clip
        : ({ ...clip, play: { mediaId: 'clip', showWhenStopped: false } } as SlideObject);
      const s: Slide = { ...slide, objects: [play, slide.objects[1]!, badge, slide.objects[2]!] };
      const flat = (await run(slideJob({ slide: s, images, video: undefined }))).msg!
        .bitmap as unknown as FakeBitmap;
      // As one bitmap every picture is a 1:1 copy of the one prepared for its box at this output's size.
      expect(flat.drawn.map((b) => [b.tag, b.width, b.height])).toEqual([
        ['page.png', 960, 540],
        ['poster.jpg', 400, 225],
        ['badge.png', 100, 100],
      ]);
      expect(flat.drawn.every((b) => preparedKey(b as unknown as CanvasImageSource))).toBe(true);
      const { msg } = await run(slideJob({ slide: s, images }));
      expect(msg?.kind).toBe(SRC_SCENE);
      const base = msg!.bitmap as unknown as FakeBitmap;
      const over = msg!.over as unknown as FakeBitmap;
      expect(base.ops).toEqual([
        ...(stopped ? ['image:page.png', 'image:poster.jpg'] : ['image:page.png']),
        'text:Footer',
      ]);
      expect(over.ops).toEqual(['text:Title', 'image:badge.png']);
      // The same bitmaps (the prepared ones, from the cache), less the poster when it is hidden while stopped.
      const scene = [...base.drawn, ...over.drawn];
      const expected = stopped ? flat.drawn : flat.drawn.filter((b) => b.tag !== 'poster.jpg');
      expect(scene).toHaveLength(expected.length);
      for (const [i, b] of scene.entries()) expect(b).toBe(expected[i]);
      // The clip's size is unknown: the plane is fitted with the 4:3 poster's own size, pillarboxed.
      expect(msg!.plane![PLANE_UV]).toBeCloseTo(-1 / 6, 5);
    }
  });
});

describe('asset worker: what a slide job draws follows slideContent (design/27 §5)', () => {
  // The link sends the pictures a slide draws (link-core.test.ts); here every picture any case names is
  // available, so what is drawn is the worker's own choice.
  const images: Record<string, string> = { vposter: 'poster.jpg' };
  for (const id of ['page', 'ref', 'art', 'photo', 'photo2', 'mine']) images[id] = `${id}.png`;
  const ops = (c: (typeof CONTENT_CASES)[number]) => [
    ...c.pictures.map((id) => `image:${id}.png`),
    ...c.texts.map((t) => `text:${t}`),
  ];

  for (const c of CONTENT_CASES)
    it(`${c.name}: one bitmap with the picture, then the objects drawn`, async () => {
      const { msg } = await run(
        slideJob({ slide: c.slide, images, video: undefined, key: `sl|${c.slide.id}` }),
      );
      expect(msg?.kind).toBe(SRC_BITMAP);
      const drawn = (msg!.bitmap as unknown as FakeBitmap).ops;
      // Pictures in drawing order, texts in theirs (each case draws its pictures under its texts or keeps
      // them in z order; the renderer's tests check the interleaving).
      expect(drawn.filter((o) => o.startsWith('image:'))).toEqual(
        ops(c).filter((o) => o.startsWith('image:')),
      );
      expect(drawn.filter((o) => o.startsWith('text:'))).toEqual(ops(c).filter((o) => o.startsWith('text:')));
    });

  it('the hybrid art is drawn at its place in the z order', async () => {
    const { msg } = await run(
      slideJob({ slide: contentCase('hybrid').slide, images, video: undefined, key: 'sl|hybrid' }),
    );
    expect((msg!.bitmap as unknown as FakeBitmap).ops).toEqual([
      'text:Under',
      'image:art.png',
      'image:photo2.png',
      'text:Over',
    ]);
  });

  it('on a slide showing its PowerPoint picture an added clip plays in its box, an imported one does not', async () => {
    const ref = contentCase('ref').slide;
    const added: Slide = { ...ref, objects: [...ref.objects, clip] };
    const scene = await run(slideJob({ slide: added, images, key: 'sl|ref-added' }));
    expect(scene.msg?.kind).toBe(SRC_SCENE);
    expect((scene.msg!.bitmap as unknown as FakeBitmap).ops).toEqual([
      'image:ref.png',
      'image:mine.png',
      'text:Added',
      'image:poster.jpg',
    ]);
    const imported: Slide = {
      ...ref,
      objects: [...ref.objects, { ...clip, origin: { src: 'pptx', role: 'poster' } } as SlideObject],
    };
    const flat = await run(slideJob({ slide: imported, images, key: 'sl|ref-imported' }));
    expect(flat.msg?.kind).toBe(SRC_BITMAP);
    expect((flat.msg!.bitmap as unknown as FakeBitmap).ops).toEqual([
      'image:ref.png',
      'image:mine.png',
      'text:Added',
    ]);
  });
});

describe('asset worker: tight sprites and opaque layers (design/27 §7.3, M7)', () => {
  it('draws a lower third as a tight sprite at its offset', async () => {
    const { msg, transfer } = await run({
      kind: 'lowerThird',
      layer: 2,
      key: 'lt|x',
      text: 'Pastor Anna',
      look: LOOK_MAIN,
    });
    const b = msg!.bitmap as unknown as FakeBitmap;
    expect(msg!.kind).toBe(SRC_BITMAP);
    expect(b.width * b.height).toBeLessThan(W * H * 0.8);
    expect(msg!.x).toBeGreaterThanOrEqual(0);
    expect(msg!.y).toBeGreaterThan(H / 2);
    expect(b.ops).toEqual(['text:Pastor Anna']);
    expect(msg).not.toHaveProperty('opaque');
    expect(transfer).toEqual([msg!.bitmap]);
  });

  it('draws a lyric-only band as a sprite, and a slide covering the frame full-frame', async () => {
    const band = (await run(slideJob({ video: undefined, look: LOOK_LOWER_THIRD, isSong: true }))).msg!;
    expect(band.y).toBeGreaterThan(0);
    expect((band.bitmap as unknown as FakeBitmap).height).toBeLessThan(H);
    // The slide's page picture covers the frame: one full-frame bitmap, no offset.
    const page = (await run(slideJob({ video: undefined }))).msg!;
    expect(page).not.toHaveProperty('x');
    expect((page.bitmap as unknown as FakeBitmap).width).toBe(W);
  });

  it('marks a cover-fitted JPEG opaque, and neither a contained one nor another file', async () => {
    const job = (hash: string, fit: 'cover' | 'contain'): AssetJob => ({
      kind: 'image',
      layer: 0,
      key: `img|${hash}|${fit}`,
      hash,
      fit,
    });
    const cover = (await run(job('photo.jpg', 'cover'))).msg!;
    expect(cover.opaque).toBe(true);
    expect(cover).not.toHaveProperty('x');
    const contain = (await run(job('photo.jpg', 'contain'))).msg!;
    expect(contain).not.toHaveProperty('opaque');
    const png = (await run(job('art.png', 'cover'))).msg!;
    expect(png).not.toHaveProperty('opaque');
  });
});

describe('asset worker: raster lanes (design/27 §7.5)', () => {
  const send = (m: unknown) => link.onmessage!({ data: m });

  it('reports the lane and the timing of each job with its result', async () => {
    const { reply } = await run(slideJob({ video: undefined, key: 'sl|timed' }));
    expect(reply).toMatchObject({ t: 'done', key: 'sl|timed', lane: 'interactive' });
    const done = reply as Extract<FromAsset, { t: 'done' }>;
    expect(done.waitMs).toBeGreaterThanOrEqual(0);
    expect(done.busyMs).toBeGreaterThanOrEqual(0);
    expect(done.longestMs).toBeLessThanOrEqual(done.busyMs! + 1e-9);
    // The draw is one of the job's slices.
    expect(done.rasterMs!).toBeLessThanOrEqual(done.busyMs! + 1e-9);
  });

  it('a cancelled job sends nothing, to the renderer or to the link', async () => {
    rendered.length = 0;
    replies.length = 0;
    // Two jobs of one layer: the second waits behind the first, and is cancelled there.
    send({ t: 'job', job: slideJob({ video: undefined, key: 'sl|first' }), role: 'armed' });
    send({ t: 'job', job: slideJob({ video: undefined, key: 'sl|superseded' }), role: 'armed' });
    send({ t: 'cancel', keys: ['sl|superseded'] });
    send({ t: 'job', job: slideJob({ video: undefined, key: 'sl|after' }), role: 'armed' });
    await vi.waitFor(() => expect(replies.map((r) => (r as { key: string }).key)).toContain('sl|after'));
    expect(replies.map((r) => (r as { key: string }).key)).toEqual(['sl|first', 'sl|after']);
    expect(rendered.map((r) => r.msg.key)).toEqual(['sl|first', 'sl|after']);
  });

  it('runs a live job ahead of an armed one queued before it on the same layer', async () => {
    rendered.length = 0;
    replies.length = 0;
    send({ t: 'job', job: slideJob({ video: undefined, key: 'sl|running' }), role: 'armed' });
    send({ t: 'job', job: slideJob({ video: undefined, key: 'sl|armed' }), role: 'armed' });
    send({ t: 'job', job: slideJob({ video: undefined, key: 'sl|live' }), role: 'live' });
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(rendered.map((r) => r.msg.key)).toEqual(['sl|running', 'sl|live', 'sl|armed']);
  });

  it('a warm job prepares the next cue’s pictures and sends no content; arming it then decodes nothing', async () => {
    rendered.length = 0;
    replies.length = 0;
    decoded.length = 0;
    const next: Slide = {
      id: 'next',
      objects: [
        {
          id: 'photo',
          type: 'image',
          box: box(0, 0, 1920, 1080),
          mediaId: 'bgphoto',
          fit: 'cover',
          opacity: 1,
          radius: 0,
        } as SlideObject,
      ],
    };
    const images = { bgphoto: 'warm-photo.jpg' };
    send({
      t: 'warm',
      warm: { key: 'wm|next', slide: next, look: LOOK_MAIN, images, sources: ['warm-bg.jpg'] },
    });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ t: 'warmed', key: 'wm|next', decodes: 2 });
    expect(rendered).toHaveLength(0);
    expect(decoded.sort()).toEqual(['warm-bg.jpg', 'warm-photo.jpg']);
    decoded.length = 0;
    const { msg } = await run(slideJob({ slide: next, images, video: undefined, key: 'sl|next' }));
    expect(msg?.kind).toBe(SRC_BITMAP);
    expect(decoded).toEqual([]);
    await run({ kind: 'image', layer: 0, key: 'im|bg', hash: 'warm-bg.jpg', fit: 'cover' });
    expect(decoded).toEqual([]);
  });
});

describe('asset worker: what health reads from a result (design/27 §13, M7)', () => {
  it("reports the draw on the worker's thread apart from the job's whole time", async () => {
    for (const job of [
      slideJob({ video: undefined }),
      slideJob(),
      { kind: 'lowerThird', layer: 2, key: 'lt|x', text: 'Pastor Jo', look: LOOK_LOWER_THIRD } as AssetJob,
    ]) {
      const { reply } = await run(job);
      expect(reply.t).toBe('done');
      if (reply.t !== 'done') continue;
      expect(reply.rasterMs).toBeGreaterThanOrEqual(0);
      expect(reply.rasterMs!).toBeLessThanOrEqual(reply.ms + 0.01);
      // No face is loaded here: text in an unloaded family is a font fallback, never probed glyph by glyph.
      expect(reply.uncovered).toBeUndefined();
    }
  });
});

describe('asset worker: geometry files (ShapeGeom.ref)', () => {
  const shape = (id: string, ref: string): SlideObject =>
    ({
      id,
      type: 'shape',
      box: box(100, 100, 400, 300),
      shape: 'rect',
      fill: { r: 255, g: 0, b: 0, a: 1 },
      opacity: 1,
      radius: 0,
      geom: { ref },
    }) as SlideObject;

  it('reads the files a slide draws before drawing it, and reports one the hub lacks with the missing images', async () => {
    const s: Slide = { id: 'g', objects: [shape('a', GEOM_READ), shape('b', GEOM_GONE)] };
    const { reply } = await run(slideJob({ slide: s, images: {}, video: undefined, key: 'sl|geoms' }));
    expect(reply).toMatchObject({ t: 'done', key: 'sl|geoms', missingImages: [GEOM_GONE] });
    expect(geomFile(GEOM_READ)).toEqual(JSON.parse(GEOM_FILES.get(GEOM_READ)!));
    expect(geomFile(GEOM_GONE)).toBeUndefined();
  });

  it("a warm job reads the next cue's geometry files, so its masked pictures are prepared cut to them", async () => {
    replies.length = 0;
    const next: Slide = {
      id: 'warm-geom',
      objects: [
        {
          id: 'm',
          type: 'image',
          box: box(0, 0, 400, 300),
          mediaId: 'photo',
          fit: 'cover',
          opacity: 1,
          radius: 0,
          mask: { ref: GEOM_WARM },
        } as SlideObject,
      ],
    };
    expect(geomFile(GEOM_WARM)).toBeUndefined();
    link.onmessage!({
      data: { t: 'warm', warm: { key: 'wm|geom', slide: next, look: LOOK_MAIN, images: { photo: 'w.jpg' } } },
    });
    await vi.waitFor(() => expect(replies.some((r) => (r as { key?: string }).key === 'wm|geom')).toBe(true));
    expect(geomFile(GEOM_WARM)).toEqual(JSON.parse(GEOM_FILES.get(GEOM_WARM)!));
  });
});

describe('asset worker: geometry units (M9 Slow-to-draw, Runtime)', () => {
  const send = (m: unknown) => link.onmessage!({ data: m });
  /**
   * Line art past the slide's drawing budget, without gradients (these fakes make none), moved by `dx` (units are
   * keyed by what they draw: each test's slide asks for units of its own).
   */
  const busy = (id: string, dx: number): Slide => {
    const art = lineArtSlide().objects.filter((o) => o.type === 'shape' && !('gradient' in o && o.gradient));
    const last = art.at(-1)!;
    const again = { ...last.box, x: last.box.x - 300, w: last.box.w / 2, h: last.box.h / 2 };
    const objects = [...art, { ...last, id: `${last.id}-again`, box: again }];
    return { id, objects: objects.map((o) => ({ ...o, box: { ...o.box, x: o.box.x + dx } })) };
  };
  const unitsOf = (s: Slide) => unitsOfSlide(s, W / 1920, LOOK_MAIN);
  /** `n` copies of a line art, each moved a little: past the budget, several units within one frame. */
  const many = (id: string, n: number): Slide => {
    const art = lineArtSlide().objects.find((o) => o.type === 'shape')!;
    const objects = Array.from({ length: n }, (_, i) => ({
      ...art,
      id: `${art.id}-${i}`,
      // A sub-pixel phase each (i / 16 px at scale 0.5): copies at one phase would share one unit.
      box: { x: 20 + i * 30 + i / 8, y: 20 + i * 20, w: 600, h: 400, rotation: 0 },
    }));
    return { id, objects };
  };
  /** Send a job with its role and wait for its answer. */
  async function runAs(job: AssetJob, role: 'live' | 'armed' | 'late') {
    rendered.length = 0;
    replies.length = 0;
    send({ t: 'job', job, role });
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    return { msg: rendered[0]?.msg, reply: replies[0]! };
  }
  /** The unit pictures a drawn bitmap copied (a unit's picture holds the frame scratch it was copied from). */
  const unitCopies = (b: FakeBitmap) =>
    b.drawn.filter((d) => d.width < W || d.height < H || d.drawn.length > 0);

  it('arming a cue past the budget makes its units; its GO (a live job of the slide) does no unit work', async () => {
    const s = busy('arm-then-go', 0);
    const units = unitsOf(s);
    expect(units.length).toBeGreaterThanOrEqual(2);
    const before = unitWork();
    const armed = await runAs(
      slideJob({ slide: s, images: {}, video: undefined, key: 'sl|armed-units' }),
      'armed',
    );
    expect(armed.reply, JSON.stringify(armed.reply)).toMatchObject({ t: 'done' });
    expect(unitWork().made - before.made).toBe(units.length);
    // Each unit is copied where its legacy copy would be drawn.
    expect(unitCopies(armed.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(units.length);
    const after = unitWork();
    const live = await runAs(
      slideJob({ slide: s, images: {}, video: undefined, key: 'sl|live-units' }),
      'live',
    );
    expect(live.reply.t).toBe('done');
    expect(unitWork()).toEqual(after);
    expect(unitCopies(live.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(units.length);
  });

  it('a warm job makes the next cue’s units, kept pinned: arming it then makes none', async () => {
    const s = busy('warm-units', 7);
    const units = unitsOf(s);
    replies.length = 0;
    const before = unitWork();
    send({ t: 'warm', warm: { key: 'wm|units', slide: s, look: LOOK_MAIN, images: {} } });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ t: 'warmed', key: 'wm|units' });
    expect(unitWork().made - before.made).toBe(units.length);
    for (const u of units) expect(unitReady(u)).toBeDefined();
    const after = unitWork();
    await runAs(slideJob({ slide: s, images: {}, video: undefined, key: 'sl|warmed-units' }), 'armed');
    expect(unitWork()).toEqual(after);
  });

  /** Re-send the worker's init with these drawing switches (the asset init's `drawing`). */
  const init = (drawing: Record<string, unknown> = {}) =>
    scope.onmessage!({ data: { t: 'init', width: W, height: H, token: '', apiPrefix: '/api/v1', drawing } });
  /** The test's clock on, each unit step `stepMs` long; off again after the test. */
  const timed = (stepMs: number) => {
    clock.on = true;
    clock.t = 0;
    clock.stepMs = stepMs;
  };
  afterEach(() => {
    clock.on = false;
    clock.stepMs = 0;
    clock.paintMs = 0;
    clock.at = undefined;
    FakeOffscreenCanvas.refuse2d = false;
    init();
  });
  const ready = () =>
    replies.filter((r) => r.t === 'unitsReady') as Extract<FromAsset, { t: 'unitsReady' }>[];

  it('a jump to a cue neither armed nor warmed is sent at once; its units are made late and reported (r2b units-live)', async () => {
    // Each test's slide at a sub-pixel phase of its own (at this frame's scale 0.5): units are keyed by what
    // they draw and its phase, not where (r2b effect units), so a whole-pixel move would find earlier units made.
    const s = busy('jump', 13.5);
    const units = unitsOf(s);
    // Each unit step takes 40 ms of the clock: the slide's units take several hundred ms of turns.
    timed(40);
    const before = unitWork();
    rendered.length = 0;
    replies.length = 0;
    send({
      t: 'job',
      job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|jump' }),
      role: 'live',
    });
    await vi.waitFor(() => expect(rendered.length).toBeGreaterThan(0));
    // Sent before any unit was made, within the plan's turn: the units not ready are drawn as their legacy copies.
    expect(rendered[0]!.made).toBe(before.made);
    expect(rendered[0]!.at).toBe(0);
    expect(unitCopies(rendered[0]!.msg.bitmap as unknown as FakeBitmap)).toHaveLength(0);
    await vi.waitFor(() => expect(replies.find((r) => r.t === 'done')).toBeDefined());
    expect(replies.find((r) => r.t === 'done')).toMatchObject({ key: 'sl|jump', unitsLeft: units.length });
    // The late job makes them all and says so once (made within 300 ms of each other at most: one report).
    await vi.waitFor(() => expect(ready().reduce((n, r) => n + r.keys.length, 0)).toBe(units.length));
    expect(ready().at(-1)).toMatchObject({ layer: 1, slideKey: 'sl|jump', left: 0 });
    expect(unitWork().made - before.made).toBe(units.length);
    for (const u of units) expect(unitReady(u)).toBeDefined();
    // The re-draw the link sends then copies them, and fades in on screen.
    const again = await runAs(
      slideJob({ slide: s, images: {}, video: undefined, key: 'sl|jump', refresh: true, refreshFadeMs: 300 }),
      'late',
    );
    expect(unitCopies(again.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(units.length);
    expect(again.msg).toMatchObject({ refresh: true, refreshFadeMs: 300 });
  });

  it('a jump to a slide with a capped decoration is sent at once without it, and it fades in once made (C2b)', async () => {
    // The largest decoration allowed (`cappedSlide`, past DECOR_SPRITE): drawn at once it is one task of about
    // 100-115 ms at 3840. Each fill or stroke takes 0.4 ms of the clock here, each unit step 1 ms.
    const s = cappedSlide();
    const units = unitsOf(s);
    expect(units.map((u) => u.of)).toEqual(['decor']);
    timed(1);
    clock.paintMs = 0.4;
    rendered.length = 0;
    replies.length = 0;
    const p0 = paints;
    send({
      t: 'job',
      job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|capped' }),
      role: 'live',
    });
    await vi.waitFor(() => expect(rendered.length).toBeGreaterThan(0));
    // Sent in the raster's own turn, the decoration left out (its unit is not made): nothing of it drawn, so
    // no task near 50 ms of the clock (drawn directly it would be several hundred calls).
    expect(rendered[0]!.paints - p0).toBe(0);
    expect(rendered[0]!.at).toBeLessThan(50);
    await vi.waitFor(() => expect(replies.find((r) => r.t === 'done')).toBeDefined());
    expect(replies.find((r) => r.t === 'done')).toMatchObject({ key: 'sl|capped', unitsLeft: 1 });
    // The late job makes it in turns and says so; the re-draw the link sends copies it and fades in.
    await vi.waitFor(() =>
      expect(ready().find((r) => r.slideKey === 'sl|capped' && r.left === 0)).toBeDefined(),
    );
    expect(ready().flatMap((r) => r.keys)).toEqual([units[0]!.key]);
    expect(unitReady(units[0]!)).toBeDefined();
    const p1 = paints;
    const again = await runAs(
      slideJob({
        slide: s,
        images: {},
        video: undefined,
        key: 'sl|capped',
        refresh: true,
        refreshFadeMs: 300,
      }),
      'late',
    );
    expect(unitCopies(again.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(1);
    expect(rendered[0]!.paints - p1).toBe(0);
    expect(again.msg).toMatchObject({ refresh: true, refreshFadeMs: 300 });
  });

  it('a harness or arm path still waits: an armed job makes every unit before it is sent', async () => {
    const s = busy('arm-waits', 17.25);
    timed(40);
    const before = unitWork();
    const { msg } = await runAs(
      slideJob({ slide: s, images: {}, video: undefined, key: 'sl|arm-waits' }),
      'armed',
    );
    expect(unitWork().made - before.made).toBe(unitsOf(s).length);
    expect(unitCopies(msg!.bitmap as unknown as FakeBitmap)).toHaveLength(unitsOf(s).length);
    expect(ready().filter((r) => r.slideKey === 'sl|arm-waits')).toEqual([]);
  });

  it('a GO 20 ms after the arm hurries the armed job: it is sent within the lead, its units made late', async () => {
    const s = busy('hurry', 23.75);
    const units = unitsOf(s);
    // 60 ms a step: more than 300 ms of unit turns for the slide.
    timed(60);
    rendered.length = 0;
    replies.length = 0;
    let goAt = -1;
    clock.at = {
      t: 20,
      fn: () => {
        goAt = clock.t;
        expect(rendered).toHaveLength(0);
        send({ t: 'hurry', keys: ['sl|hurry'] });
      },
    };
    send({
      t: 'job',
      job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|hurry' }),
      role: 'armed',
    });
    await vi.waitFor(() => expect(rendered.length).toBeGreaterThan(0));
    expect(goAt).toBeGreaterThanOrEqual(20);
    // The lead is 33 ms: the unit being made is abandoned at its next turn (one step at most).
    expect(rendered[0]!.at - goAt).toBeLessThanOrEqual(33);
    expect(units.length * 3 * 60).toBeGreaterThan(300);
    await vi.waitFor(() => expect(replies.find((r) => r.t === 'done')).toBeDefined());
    expect((replies.find((r) => r.t === 'done') as { unitsLeft?: number }).unitsLeft).toBeGreaterThan(0);
    await vi.waitFor(() => expect(ready().at(-1)?.left).toBe(0));
    for (const u of units) expect(unitReady(u)).toBeDefined();
  });

  it('a hurried job cancelled before it ends is not hurried when its key is sent again', async () => {
    const s = busy('hurry-cancel', 29.125);
    const units = unitsOf(s);
    timed(60);
    replies.length = 0;
    const before = unitWork();
    // A GO to the warmed cue hurries its warm job, then the next GO moves the warm work on: it is cancelled.
    clock.at = {
      t: 20,
      fn: () => {
        send({ t: 'hurry', keys: ['wm|again'] });
        send({ t: 'cancel', keys: ['wm|again'] });
        // The operator comes back: the same cue is the one after the armed one again.
        send({ t: 'warm', warm: { key: 'wm|again', slide: s, look: LOOK_MAIN, images: {} } });
      },
    };
    send({ t: 'warm', warm: { key: 'wm|again', slide: s, look: LOOK_MAIN, images: {} } });
    await vi.waitFor(() => expect(replies.filter((r) => r.t === 'warmed')).toHaveLength(1));
    // Sent again, it waits for its units as any warm job does.
    expect(unitWork().made - before.made).toBe(units.length);
    for (const u of units) expect(unitReady(u)).toBeDefined();
  });

  it('reports late units at most once per 300 ms while some remain, then once all are made', async () => {
    const s = many('coalesce', 10);
    const units = unitsOf(s);
    expect(units.length).toBeGreaterThanOrEqual(3);
    // 40 ms a step, three steps a unit: one unit every 120 ms of the clock.
    timed(40);
    rendered.length = 0;
    replies.length = 0;
    const at: number[] = [];
    const record = link.postMessage;
    link.postMessage = (m) => {
      if (m.t === 'unitsReady') at.push(clock.t);
      record(m);
    };
    try {
      send({
        t: 'job',
        job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|co' }),
        role: 'live',
      });
      await vi.waitFor(() => expect(ready().at(-1)?.left).toBe(0));
    } finally {
      link.postMessage = record;
    }
    const r = ready();
    expect(r.reduce((n, x) => n + x.keys.length, 0)).toBe(units.length);
    expect(r.length).toBeLessThan(units.length);
    for (let i = 1; i < at.length - 1; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(300);
  });

  it("with ?late=next the late units are made but not reported: the slide's next draw copies them", async () => {
    init({ late: 'next' });
    const s = busy('next', 31.375);
    const units = unitsOf(s);
    const before = unitWork();
    rendered.length = 0;
    replies.length = 0;
    send({
      t: 'job',
      job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|next' }),
      role: 'live',
    });
    await vi.waitFor(() => expect(unitWork().made - before.made).toBe(units.length));
    await new Promise((r) => setTimeout(r, 20));
    expect(ready().filter((x) => x.slideKey === 'sl|next')).toEqual([]);
    expect(unitCopies(rendered[0]!.msg.bitmap as unknown as FakeBitmap)).toHaveLength(0);
    // The next arm of the slide copies them.
    const armed = await runAs(
      slideJob({ slide: s, images: {}, video: undefined, key: 'sl|next-again' }),
      'armed',
    );
    expect(unitCopies(armed.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(units.length);
  });

  it('a jump to another slide drops the late units of the one that left the screen', async () => {
    const a = busy('left-a', 37.0625);
    const b = busy('left-b', 41.1875);
    timed(40);
    replies.length = 0;
    // The jump to b comes while a's late job makes its first unit.
    clock.at = {
      t: 80,
      fn: () =>
        send({
          t: 'job',
          job: slideJob({ slide: b, images: {}, video: undefined, key: 'sl|b' }),
          role: 'live',
        }),
    };
    send({ t: 'job', job: slideJob({ slide: a, images: {}, video: undefined, key: 'sl|a' }), role: 'live' });
    await vi.waitFor(() => expect(ready().find((r) => r.slideKey === 'sl|b' && r.left === 0)).toBeDefined());
    expect(ready().filter((r) => r.slideKey === 'sl|a' && r.left === 0)).toEqual([]);
    expect(unitsOf(a).filter((u) => unitReady(u)).length).toBeLessThan(unitsOf(a).length);
  });

  /** The largest decoration allowed (`cappedSlide`) at a sub-pixel phase of its own (a unit of its own). */
  const cappedAt = (id: string, dx: number): Slide => {
    const base = cappedSlide();
    const o = base.objects[0]!;
    return { ...base, id, objects: [{ ...o, box: { ...o.box, x: o.box.x + dx } }] };
  };
  const readyOf = (key: string) => ready().filter((r) => r.slideKey === key);
  /**
   * `many` moved by `dx` logical px: units of its own (`many` alone gives every test the same units). Its first
   * eight copies get units (one frame's area), at phases i / 16 + dx / 2 device px: two slides share none while
   * their `dx` differ by other than a multiple of 1/8 (repair 4's slides: odd multiples of 1/256).
   */
  const manyAt = (id: string, n: number, dx: number): Slide => {
    const s = many(id, n);
    return { ...s, objects: s.objects.map((o) => ({ ...o, box: { ...o.box, x: o.box.x + dx } })) };
  };

  it('a late job whose rounds run out goes on while it makes parts: every part comes, its last report ends it (repair 3)', async () => {
    const s = manyAt('rounds', 10, 0.03125);
    const units = unitsOf(s);
    // 400 ms a step on the clock: one unit a round of UNIT_WAIT_MS, so LATE_ROUNDS (4) rounds make 4 of them.
    expect(units.length).toBeGreaterThan(4);
    timed(400);
    rendered.length = 0;
    replies.length = 0;
    send({
      t: 'job',
      job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|rounds' }),
      role: 'live',
    });
    await vi.waitFor(() => expect(readyOf('sl|rounds').at(-1)?.left).toBe(0), { timeout: 10_000 });
    expect(units.filter((u) => unitReady(u)).length).toBe(units.length);
    const r = readyOf('sl|rounds');
    expect(r.flatMap((x) => x.keys).sort()).toEqual(units.map((u) => u.key).sort());
    // One report ends the late job (the link lets a held re-draw go on it), and it is the last.
    expect(r.filter((x) => x.ended)).toHaveLength(1);
    expect(r.at(-1)).toMatchObject({ left: 0, ended: true });
  });

  it('a decoration whose unit cannot be made is drawn directly by the next draw: its late job ends and names it, once (repair 3)', async () => {
    const s = cappedAt('unmade', 0.375);
    const [u] = unitsOf(s);
    expect(u?.of).toBe('decor');
    rendered.length = 0;
    replies.length = 0;
    const p0 = paints;
    // The unit's canvas gets no 2D context (memory pressure): it cannot be made.
    FakeOffscreenCanvas.refuse2d = true;
    send({
      t: 'job',
      job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|unmade' }),
      role: 'live',
    });
    await vi.waitFor(() => expect(readyOf('sl|unmade').length).toBeGreaterThan(0));
    FakeOffscreenCanvas.refuse2d = false;
    // Shown at once without it ...
    expect(rendered[0]!.paints - p0).toBe(0);
    expect(replies.find((r) => r.t === 'done')).toMatchObject({ key: 'sl|unmade', unitsLeft: 1 });
    // ... its late job could not make it: it ends, naming the part the next draw draws differently.
    expect(readyOf('sl|unmade')).toEqual([
      { t: 'unitsReady', layer: 1, slideKey: 'sl|unmade', keys: [u!.key], left: 0, ended: true },
    ]);
    expect(unitReady(u!)).toBeUndefined();
    // The re-draw the link sends draws it directly (one long task, never dropped) and leaves nothing late.
    const p1 = paints;
    const again = await runAs(
      slideJob({
        slide: s,
        images: {},
        video: undefined,
        key: 'sl|unmade',
        refresh: true,
        refreshFadeMs: 300,
      }),
      'late',
    );
    expect(rendered[0]!.paints - p1).toBeGreaterThan(200);
    expect(again.reply).toMatchObject({ t: 'done', key: 'sl|unmade' });
    expect((again.reply as { unitsLeft?: number }).unitsLeft).toBeUndefined();
    // Nothing loops: no late job tries it again, nothing more is reported.
    const w0 = unitWork();
    await new Promise((r) => setTimeout(r, 50));
    expect(readyOf('sl|unmade')).toEqual([]);
    expect(unitWork()).toEqual(w0);
  });

  it('with ?late=next nothing is left out: a capped decoration is drawn at once, its unit made for the next draw (repair 3)', async () => {
    init({ late: 'next' });
    const s = cappedAt('next-decor', 0.625);
    const [u] = unitsOf(s);
    rendered.length = 0;
    replies.length = 0;
    const p0 = paints;
    send({
      t: 'job',
      job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|next-decor' }),
      role: 'live',
    });
    await vi.waitFor(() => expect(rendered.length).toBeGreaterThan(0));
    // No fade comes with ?late=next: a decoration left out would stay off the screen while the slide is shown.
    expect(rendered[0]!.paints - p0).toBeGreaterThan(200);
    await vi.waitFor(() => expect(unitReady(u!)).toBeDefined());
    expect(readyOf('sl|next-decor')).toEqual([]);
  });

  it('a late job pins what it makes with the slide’s last draw: parts made after a re-draw are not evicted before theirs (repair 3)', async () => {
    const s = manyAt('pinned', 10, 0.046875);
    const units = unitsOf(s);
    expect(units.length).toBeGreaterThanOrEqual(3);
    // 100 ms of real time after each unit turn (a unit is one turn here): the first report, 300 ms after the job
    // starts, comes while it still makes parts.
    init({ unitTurnMs: 100 });
    rendered.length = 0;
    replies.length = 0;
    // At the first report the link draws the slide again (as late work); the late job goes on meanwhile.
    const record = link.postMessage;
    let redrawn = false;
    link.postMessage = (m) => {
      record(m);
      if (m.t === 'unitsReady' && !redrawn) {
        redrawn = true;
        send({
          t: 'job',
          job: slideJob({
            slide: s,
            images: {},
            video: undefined,
            key: 'sl|pin',
            refresh: true,
            refreshFadeMs: 300,
          }),
          role: 'late',
        });
      }
    };
    try {
      send({
        t: 'job',
        job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|pin' }),
        role: 'live',
      });
      await vi.waitFor(() => expect(readyOf('sl|pin').at(-1)?.left).toBe(0), { timeout: 10_000 });
      await vi.waitFor(() =>
        expect(replies.filter((r) => r.t === 'done' && r.key === 'sl|pin')).toHaveLength(2),
      );
    } finally {
      link.postMessage = record;
    }
    // The re-draw came while parts were still being made.
    expect(readyOf('sl|pin').length).toBeGreaterThan(1);
    // Every part reported stays pinned while the slide is live: memory pressure (or other slides' units) cannot
    // take one before the re-draw that fades it in copies it.
    unitCache.clear('unit');
    expect(units.filter((x) => !unitReady(x)).map((x) => x.key)).toEqual([]);
  });

  it('a part evicted before its re-draw is made again and reported, also while the late job still runs (repair 3)', async () => {
    const s = manyAt('evicted', 10, 0.078125);
    const units = unitsOf(s);
    init({ unitTurnMs: 100 });
    rendered.length = 0;
    replies.length = 0;
    const record = link.postMessage;
    let gone = '';
    link.postMessage = (m) => {
      record(m);
      // At the first report its first part is evicted, and the re-draw for it comes while the late job runs.
      if (m.t === 'unitsReady' && !gone) {
        gone = m.keys[0]!;
        unitCache.delete('unit', gone);
        send({
          t: 'job',
          job: slideJob({
            slide: s,
            images: {},
            video: undefined,
            key: 'sl|ev',
            refresh: true,
            refreshFadeMs: 300,
          }),
          role: 'late',
        });
      }
    };
    try {
      send({
        t: 'job',
        job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|ev' }),
        role: 'live',
      });
      await vi.waitFor(() => expect(readyOf('sl|ev').at(-1)?.left).toBe(0), { timeout: 10_000 });
      await vi.waitFor(() =>
        expect(replies.filter((r) => r.t === 'done' && r.key === 'sl|ev')).toHaveLength(2),
      );
    } finally {
      link.postMessage = record;
    }
    const redraw = replies.filter((r) => r.t === 'done' && r.key === 'sl|ev')[1] as { unitsLeft?: number };
    expect(redraw.unitsLeft).toBeGreaterThan(0);
    // The evicted part is reported again after that re-draw, so the next re-draw fades it in.
    const reports = readyOf('sl|ev');
    expect(reports.length).toBeGreaterThan(1);
    expect(reports.slice(1).flatMap((r) => r.keys)).toContain(gone);
    expect(reports.at(-1)).toMatchObject({ left: 0, ended: true });
    for (const u of units) expect(unitReady(u)).toBeDefined();
  });

  it('after an asset worker restart, `units` makes a held slide’s parts again without drawing it, and reports them (repair 3)', async () => {
    const s = busy('remake', 47.4375);
    const units = unitsOf(s);
    rendered.length = 0;
    replies.length = 0;
    send({
      t: 'units',
      job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|remake' }),
      role: 'live',
    });
    await vi.waitFor(() => expect(readyOf('sl|remake').at(-1)?.ended).toBe(true));
    // Nothing is drawn: the renderer's copy stays on screen until the link draws the slide with them.
    expect(rendered).toEqual([]);
    expect(replies.filter((r) => r.t === 'done')).toEqual([]);
    expect(
      readyOf('sl|remake')
        .flatMap((r) => r.keys)
        .sort(),
    ).toEqual(units.map((u) => u.key).sort());
    expect(readyOf('sl|remake').at(-1)).toMatchObject({ left: 0, ended: true });
    for (const u of units) expect(unitReady(u)).toBeDefined();
    // Found made already (by the warm-up, say): reported at once, so the slide is drawn with them.
    replies.length = 0;
    send({
      t: 'units',
      job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|remade' }),
      role: 'armed',
    });
    await vi.waitFor(() => expect(readyOf('sl|remade').at(-1)?.ended).toBe(true));
    expect(readyOf('sl|remade')).toHaveLength(1);
    expect(readyOf('sl|remade')[0]!.keys.sort()).toEqual(units.map((u) => u.key).sort());
    expect(rendered).toEqual([]);
  });

  /** Units of other slides pinned (their holds), as fillers: the cache keeps room for `share` of `units`' bytes. */
  const fillers: string[] = [];
  const pressure = (units: readonly { bytes: number }[], share = 0.6) => {
    const total = units.reduce((n, u) => n + u.bytes, 0);
    const each = (UNIT_CACHE_BYTES - Math.round(total * share)) / 3;
    for (let i = 0; i < 3; i++) {
      const k = `filler-${fillers.length}`;
      fillers.push(k);
      unitCache.pin('unit', k);
      unitCache.set('unit', k, {
        source: {} as CanvasImageSource,
        w: 1,
        h: 1,
        bytes: each,
        close: () => undefined,
      } as never);
    }
  };
  afterEach(() => {
    for (const k of fillers.splice(0)) {
      unitCache.unpin('unit', k);
      unitCache.delete('unit', k);
    }
  });
  /** A live job of another slide on layer 1: it drops every late job of the layer (a test that failed leaves none). */
  const dropLate = (id: string) =>
    send({
      t: 'job',
      job: slideJob({
        slide: { id, objects: [] },
        images: {},
        video: undefined,
        key: `sl|${id}`,
        cueIndex: 9,
      }),
      role: 'live',
    });
  const madeSince = (w0: number) => unitWork().made - w0;
  const doneOf = (key: string) => replies.filter((r) => r.t === 'done' && r.key === key);

  it('a hurried GO away stops the late job of the slide that left the screen, under cache pressure too: it ends, makes no part twice, and bulk work gets its turn (repair 4)', async () => {
    const s = manyAt('gone', 20, 0.00390625);
    const units = unitsOf(s);
    expect(units.length).toBeGreaterThanOrEqual(8);
    // The other slides' units pinned leave room for 60% of this slide's: once its hold is let go, each unit its
    // late job made would evict an earlier one, which a round made again (36f06d2: 70,000 units in 6 s, no end).
    pressure(units);
    // 120 ms of the clock a unit step: a round of UNIT_WAIT_MS makes a few units.
    timed(120);
    rendered.length = 0;
    replies.length = 0;
    const w0 = unitWork().made;
    try {
      // The slide goes live by a jump: drawn at once, its parts left to its late job ...
      send({
        t: 'job',
        job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|gone' }),
        role: 'live',
      });
      // ... and the operator GOes on to the next cue while its arm runs: the link hurries it (no live job is
      // sent), and the hurried job holds the layer's live units now.
      const next: Slide = { id: 'gone-next', objects: [] };
      send({
        t: 'job',
        job: slideJob({ slide: next, images: {}, video: undefined, key: 'sl|gone-next' }),
        role: 'armed',
      });
      send({ t: 'hurry', keys: ['sl|gone-next'] });
      await vi.waitFor(() => expect(readyOf('sl|gone').some((r) => r.ended)).toBe(true), { timeout: 10_000 });
      const made = madeSince(w0);
      // It stopped with parts left, which the slide's next draw makes (the link sends one if the slide is on
      // screen all the same); none was made twice.
      expect(readyOf('sl|gone').at(-1)).toMatchObject({ ended: true, stopped: true });
      expect(readyOf('sl|gone').at(-1)!.left).toBeGreaterThan(0);
      expect(made).toBeLessThanOrEqual(units.length);
      await new Promise((r) => setTimeout(r, 100));
      expect(madeSince(w0)).toBe(made);
      // Bulk work gets its turn: the pictures of the cue after the armed one (36f06d2: no answer in 8 s).
      send({
        t: 'warm',
        warm: { key: 'wm|after-gone', slide: { id: 'after', objects: [] }, look: LOOK_MAIN, images: {} },
      });
      await vi.waitFor(
        () => expect(replies.some((r) => r.t === 'warmed' && r.key === 'wm|after-gone')).toBe(true),
        { timeout: 2_000 },
      );
    } finally {
      dropLate('gone-stop');
    }
  }, 30_000);

  it('the next arm lets go of the hold of a slide whose late job runs (it may be on screen by a GO to its armed cue): the job keeps it and makes each part once, under cache pressure too (repair 4)', async () => {
    // These slides pass one frame of unit area (20 line-art units): with the underlay frame the slide is split and its first units
    // are one frame unit; this test is about the late job's holds on separate units, so it runs with the frame off (`?frame=off`).
    init({ frame: 'off' });
    const s = manyAt('armed-away', 20, 0.01171875);
    const units = unitsOf(s);
    pressure(units);
    timed(120);
    rendered.length = 0;
    replies.length = 0;
    const w0 = unitWork().made;
    const key = 'sl|armed-away';
    try {
      // The slide armed: its arm waits UNIT_WAIT_MS and is drawn with the rest left to its late job.
      send({ t: 'job', job: slideJob({ slide: s, images: {}, video: undefined, key }), role: 'armed' });
      // A GO to it (drawn already: the worker is told nothing) and the next cue armed at once: the layer's armed
      // units are that cue's now, and no re-draw of the slide has come yet.
      const next: Slide = { id: 'armed-away-next', objects: [] };
      send({
        t: 'job',
        job: slideJob({ slide: next, images: {}, video: undefined, key: 'sl|armed-away-next' }),
        role: 'armed',
      });
      await vi.waitFor(() => expect([...doneOf(key), ...doneOf('sl|armed-away-next')]).toHaveLength(2), {
        timeout: 5_000,
      });
      const left = (doneOf(key)[0] as { unitsLeft?: number }).unitsLeft;
      expect(left).toBeGreaterThan(0);
      await vi.waitFor(() => expect(readyOf(key).some((r) => r.ended)).toBe(true), { timeout: 10_000 });
      // Every part made, each once (none evicted while the job ran), and reported: its re-draw fades them in.
      expect(readyOf(key).at(-1)).toMatchObject({ left: 0, ended: true });
      expect(madeSince(w0)).toBe(units.length);
      expect(readyOf(key).flatMap((r) => r.keys).length).toBe(left);
      // Its hold let go at its end, the pressure takes the parts before that re-draw copies them: the re-draw
      // leaves them again and its late job makes them, pinned with it while the slide is live; nothing more.
      replies.length = 0;
      send({
        t: 'job',
        job: slideJob({ slide: s, images: {}, video: undefined, key, refresh: true, refreshFadeMs: 300 }),
        role: 'late',
      });
      await vi.waitFor(() => expect(readyOf(key).some((r) => r.ended)).toBe(true), { timeout: 10_000 });
      expect((doneOf(key)[0] as { unitsLeft?: number }).unitsLeft).toBeGreaterThan(0);
      expect(readyOf(key).at(-1)).toMatchObject({ left: 0, ended: true });
      expect(madeSince(w0)).toBeLessThanOrEqual(2 * units.length);
      unitCache.clear('unit');
      expect(units.filter((u) => !unitReady(u)).map((u) => u.key)).toEqual([]);
    } finally {
      dropLate('armed-away-stop');
    }
  }, 30_000);

  it('a stopped late job replaced by a new draw of its slide (shown again) says nothing more; the new one makes the parts (repair 4)', async () => {
    const s = manyAt('again', 10, 0.07421875);
    const units = unitsOf(s);
    const busyOther = manyAt('again-other', 20, 0.08203125);
    // A late job of another layer's slide keeps the late lane busy (60 ms of real time after each unit turn),
    // so the slide's own late job is still queued when it stops.
    init({ unitTurnMs: 60 });
    rendered.length = 0;
    replies.length = 0;
    try {
      send({
        t: 'job',
        job: slideJob({ slide: busyOther, images: {}, video: undefined, key: 'sl|again-other', layer: 2 }),
        role: 'live',
      });
      await vi.waitFor(() => expect(doneOf('sl|again-other')).toHaveLength(1));
      send({
        t: 'job',
        job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|again' }),
        role: 'live',
      });
      await vi.waitFor(() => expect(doneOf('sl|again')).toHaveLength(1));
      // A GO away (the next cue's arm hurried) stops its late job, still queued; a jump back draws it again.
      const next: Slide = { id: 'again-next', objects: [] };
      send({
        t: 'job',
        job: slideJob({ slide: next, images: {}, video: undefined, key: 'sl|again-next' }),
        role: 'armed',
      });
      send({ t: 'hurry', keys: ['sl|again-next'] });
      await vi.waitFor(() => expect(doneOf('sl|again-next')).toHaveLength(1));
      send({
        t: 'job',
        job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|again' }),
        role: 'live',
      });
      await vi.waitFor(() => expect(readyOf('sl|again').some((r) => r.ended)).toBe(true), {
        timeout: 15_000,
      });
      // One end only, the new job's, with every part.
      expect(readyOf('sl|again').filter((r) => r.ended)).toEqual([
        expect.objectContaining({ left: 0, ended: true }),
      ]);
      expect(readyOf('sl|again').some((r) => r.stopped)).toBe(false);
      expect(
        readyOf('sl|again')
          .flatMap((r) => r.keys)
          .sort(),
      ).toEqual(units.map((u) => u.key).sort());
    } finally {
      dropLate('again-stop');
      send({
        t: 'job',
        job: slideJob({
          slide: { id: 'again-l2', objects: [] },
          images: {},
          video: undefined,
          key: 'sl|again-l2',
          layer: 2,
        }),
        role: 'live',
      });
    }
  }, 30_000);

  it('a hold a late job kept itself is let go when the job is dropped: nothing of it stays pinned (repair 4)', async () => {
    const s = manyAt('owned-drop', 20, 0.08984375);
    const units = unitsOf(s);
    const key = 'sl|owned-drop';
    timed(120);
    init({ unitTurnMs: 60 });
    rendered.length = 0;
    replies.length = 0;
    // Armed, its parts left late; the next cue armed (the job keeps the hold); then a jump to another slide.
    send({ t: 'job', job: slideJob({ slide: s, images: {}, video: undefined, key }), role: 'armed' });
    await vi.waitFor(() => expect(doneOf(key)).toHaveLength(1), { timeout: 5_000 });
    expect((doneOf(key)[0] as { unitsLeft?: number }).unitsLeft).toBeGreaterThan(0);
    send({
      t: 'job',
      job: slideJob({
        slide: { id: 'owned-next', objects: [] },
        images: {},
        video: undefined,
        key: 'sl|owned-next',
      }),
      role: 'armed',
    });
    await vi.waitFor(() => expect(doneOf('sl|owned-next')).toHaveLength(1));
    dropLate('owned-jump');
    await vi.waitFor(() => expect(doneOf('sl|owned-jump')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(readyOf(key).some((r) => r.ended)).toBe(false);
    // Its units are no longer pinned: a clear takes every one of them.
    unitCache.clear('unit');
    expect(units.filter((u) => unitReady(u)).map((u) => u.key)).toEqual([]);
  }, 30_000);

  it('a re-draw of the slide takes over the hold its late job kept: what it made stays pinned while the slide is live (repair 4)', async () => {
    const s = manyAt('kept', 20, 0.01953125);
    const units = unitsOf(s);
    const key = 'sl|kept';
    // The arm's wait runs on the test's clock (120 ms a step); 60 ms of real time after each unit turn keeps the
    // late job making parts when the re-draw comes.
    timed(120);
    init({ unitTurnMs: 60, frame: 'off' });
    rendered.length = 0;
    replies.length = 0;
    const record = link.postMessage;
    let next = false;
    let redrawn = false;
    link.postMessage = (m) => {
      record(m);
      // Armed and drawn: a GO to it (the worker is told nothing), then the next cue armed.
      if (m.t === 'done' && m.key === key && !next) {
        next = true;
        send({
          t: 'job',
          job: slideJob({
            slide: { id: 'kept-next', objects: [] },
            images: {},
            video: undefined,
            key: 'sl|kept-next',
          }),
          role: 'armed',
        });
      }
      // On screen: its first report draws it again with a fade, as the link does.
      if (m.t === 'unitsReady' && m.slideKey === key && !redrawn) {
        redrawn = true;
        send({
          t: 'job',
          job: slideJob({ slide: s, images: {}, video: undefined, key, refresh: true, refreshFadeMs: 300 }),
          role: 'late',
        });
      }
    };
    try {
      send({ t: 'job', job: slideJob({ slide: s, images: {}, video: undefined, key }), role: 'armed' });
      await vi.waitFor(() => expect(readyOf(key).some((r) => r.ended)).toBe(true), { timeout: 15_000 });
      await vi.waitFor(() => expect(doneOf(key)).toHaveLength(2));
      expect(redrawn).toBe(true);
      expect((doneOf(key)[0] as { unitsLeft?: number }).unitsLeft).toBeGreaterThan(0);
      // Memory pressure clears what is not pinned: the slide's parts stay for its next re-draw.
      unitCache.clear('unit');
      expect(units.filter((u) => !unitReady(u)).map((u) => u.key)).toEqual([]);
    } finally {
      link.postMessage = record;
      dropLate('kept-stop');
    }
  }, 30_000);

  /** `manyAt`'s slide with a shape whose geometry file the hub serves only once `open` is called. */
  const slowSlide = (id: string, dx: number, hash: string) => {
    let open: () => void = () => undefined;
    slowGeoms.set(
      hash,
      new Promise<void>((r) => {
        open = r;
      }),
    );
    const s = manyAt(id, 10, dx);
    const geom = {
      id: `${id}-geom`,
      type: 'shape',
      box: box(100, 100, 40, 30),
      shape: 'rect',
      fill: { r: 255, g: 0, b: 0, a: 1 },
      opacity: 1,
      radius: 0,
      geom: { ref: hash },
    } as SlideObject;
    return { slide: { ...s, objects: [geom, ...s.objects] }, open: () => open() };
  };

  it('a live job of another slide drops a restart’s `units` job still queued or planning: it makes nothing, the new slide’s units stay pinned (repair 4)', async () => {
    const a = manyAt('remake-a', 10, 0.02734375);
    const b = manyAt('remake-b', 10, 0.03515625);
    const ub = unitsOf(b);
    rendered.length = 0;
    replies.length = 0;
    // After a restart the link asks the new worker to make the live slide's parts ...
    send({
      t: 'units',
      job: slideJob({ slide: a, images: {}, video: undefined, key: 'sl|ra' }),
      role: 'live',
    });
    // ... and the operator jumps to another slide at once.
    send({ t: 'job', job: slideJob({ slide: b, images: {}, video: undefined, key: 'sl|rb' }), role: 'live' });
    await vi.waitFor(() => expect(readyOf('sl|rb').some((r) => r.ended)).toBe(true), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100));
    // 36f06d2: the first slide's parts were made and reported after it left, and its `units` job took the live
    // slide's hold, so a clear left none of the new slide's parts.
    expect(readyOf('sl|ra')).toEqual([]);
    unitCache.clear('unit');
    expect(ub.filter((u) => !unitReady(u)).map((u) => u.key)).toEqual([]);
  }, 30_000);

  it('a restart’s `units` job for the live slide makes nothing once another slide holds the layer’s live units: a GO hurried its arm meanwhile (repair 4)', async () => {
    // The GO to another slide hurries that slide's arm while the `units` job reads a geometry file.
    const a = slowSlide('remake-slow-a', 0.04296875, 'd'.repeat(64));
    const b = manyAt('remake-slow-b', 10, 0.05078125);
    const ub = unitsOf(b);
    rendered.length = 0;
    replies.length = 0;
    send({
      t: 'units',
      job: slideJob({ slide: a.slide, images: {}, video: undefined, key: 'sl|rsa' }),
      role: 'live',
    });
    send({
      t: 'job',
      job: slideJob({ slide: b, images: {}, video: undefined, key: 'sl|rsb' }),
      role: 'armed',
    });
    send({ t: 'hurry', keys: ['sl|rsb'] });
    // Drawn, it holds the layer's live units; then the geometry file comes.
    await vi.waitFor(() => expect(doneOf('sl|rsb')).toHaveLength(1));
    a.open();
    await vi.waitFor(() => expect(readyOf('sl|rsb').some((r) => r.ended)).toBe(true), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(readyOf('sl|rsa')).toEqual([]);
    unitCache.clear('unit');
    expect(ub.filter((u) => !unitReady(u)).map((u) => u.key)).toEqual([]);
  }, 30_000);

  it('a restart’s `units` job for the armed slide, the next cue armed meanwhile: it makes and reports the parts with a hold of its own (the slide may be on screen by a GO), and the armed cue’s units stay pinned (repair 4)', async () => {
    const c = slowSlide('remake-slow-c', 0.05859375, 'e'.repeat(64));
    const d = manyAt('remake-slow-d', 10, 0.06640625);
    const uc = unitsOf(c.slide);
    const ud = unitsOf(d);
    replies.length = 0;
    send({
      t: 'units',
      job: slideJob({ slide: c.slide, images: {}, video: undefined, key: 'sl|rsc' }),
      role: 'armed',
    });
    await runAs(slideJob({ slide: d, images: {}, video: undefined, key: 'sl|rsd' }), 'armed');
    replies.length = 0;
    c.open();
    await vi.waitFor(() => expect(readyOf('sl|rsc').some((r) => r.ended)).toBe(true), { timeout: 10_000 });
    expect(readyOf('sl|rsc').at(-1)).toMatchObject({ left: 0, ended: true });
    expect(
      readyOf('sl|rsc')
        .flatMap((r) => r.keys)
        .sort(),
    ).toEqual(uc.map((u) => u.key).sort());
    unitCache.clear('unit');
    expect(ud.filter((u) => !unitReady(u)).map((u) => u.key)).toEqual([]);
  }, 30_000);

  it('a jump while another cue stays armed does not wait for that arm: its unit wait stops, it draws with what is ready, its parts come late with its hold on the armed chain (integrate-1b)', async () => {
    // The armed cue: more units than its arm can make in UNIT_WAIT_MS at 150 ms of real time a unit turn.
    const t = manyAt('jump-armed', 20, 0.09765625);
    const units = unitsOf(t);
    expect(units.length).toBeGreaterThanOrEqual(8);
    init({ unitTurnMs: 150, frame: 'off' });
    rendered.length = 0;
    replies.length = 0;
    try {
      // The operator armed cue 10 (its arm waits for its units) and, 150 ms later, jumps to cue 9: the cue after
      // the jump's target is still cue 10, so nothing cancels or hurries its arm.
      send({
        t: 'job',
        job: slideJob({ slide: t, images: {}, video: undefined, key: 'sl|jump-armed', cueIndex: 10 }),
        role: 'armed',
      });
      await new Promise((r) => setTimeout(r, 150));
      const t0 = realNow();
      send({
        t: 'job',
        job: slideJob({
          slide: { id: 'jump-target', objects: [] },
          images: {},
          video: undefined,
          key: 'sl|jump-target',
          cueIndex: 9,
        }),
        role: 'live',
      });
      await vi.waitFor(() => expect(doneOf('sl|jump-target')).toHaveLength(1), { timeout: 10_000 });
      // Answered within a unit turn or two, not after the arm's UNIT_WAIT_MS.
      expect(realNow() - t0).toBeLessThan(2 * 150);
      // The arm drew at once with what was ready, its parts left to its late job.
      const armed = doneOf('sl|jump-armed');
      expect(armed).toHaveLength(1);
      expect((armed[0] as { unitsLeft?: number }).unitsLeft).toBeGreaterThan(0);
      // Its cue is not live: the jump's slide holds the layer's live units, the arm keeps the armed chain's, so
      // its late job is not stopped and makes every part, each once.
      await vi.waitFor(() => expect(readyOf('sl|jump-armed').some((r) => r.ended)).toBe(true), {
        timeout: 15_000,
      });
      expect(readyOf('sl|jump-armed').some((r) => r.stopped)).toBe(false);
      expect(readyOf('sl|jump-armed').at(-1)).toMatchObject({ left: 0, ended: true });
      const made = readyOf('sl|jump-armed').flatMap((r) => r.keys);
      expect([...made].sort()).toEqual(units.map((u) => u.key).sort());
      // Pinned with the armed cue: a GO to it does no unit work.
      unitCache.clear('unit');
      expect(units.filter((u) => !unitReady(u)).map((u) => u.key)).toEqual([]);
    } finally {
      dropLate('jump-armed-stop');
      send({
        t: 'job',
        job: slideJob({
          slide: { id: 'jump-armed-next', objects: [] },
          images: {},
          video: undefined,
          key: 'sl|jump-armed-next',
        }),
        role: 'armed',
      });
      await vi.waitFor(() => expect(doneOf('sl|jump-armed-next')).toHaveLength(1));
    }
  }, 30_000);

  it('the drawing switches of the asset init reach the worker; ?unitTurnMs waits after each unit turn', async () => {
    init({ late: 'next', warm: false, effects: 'base', unitTurnMs: 30, other: 'ignored' });
    replies.length = 0;
    scope.onmessage!({ data: { t: 'ports', render, link } });
    expect(replies.at(-1)).toEqual({
      t: 'drawing',
      switches: { late: 'next', warm: false, effects: 'base', unitTurnMs: 30 },
    });
    // `?effects=base` turns effect units off in the worker (C6): a capped decoration gets no unit, and is drawn
    // as 62a1c3a drew it; the next init without it turns them on again.
    expect(effectUnits()).toBe(false);
    expect(unitsOf(cappedSlide())).toEqual([]);
    init({});
    expect(effectUnits()).toBe(true);
    expect(unitsOf(cappedSlide()).map((u) => u.of)).toEqual(['decor']);
    // Each unit turn of a late job is followed by a 30 ms wait (real time).
    init({ unitTurnMs: 30 });
    const s = busy('turn-wait', 43.3125);
    const t0 = realNow();
    send({ t: 'job', job: slideJob({ slide: s, images: {}, video: undefined, key: 'sl|tw' }), role: 'live' });
    await vi.waitFor(
      () => expect(ready().find((r) => r.slideKey === 'sl|tw' && r.left === 0)).toBeDefined(),
      {
        timeout: 10_000,
      },
    );
    expect(realNow() - t0).toBeGreaterThanOrEqual(30 * unitsOf(s).length);
  });
});

describe('asset worker: warming the live playlist’s units (r2b units-live)', () => {
  const send = (m: unknown) => link.onmessage!({ data: m });
  const busy = (id: string, dx: number): Slide => {
    const art = lineArtSlide().objects.filter((o) => o.type === 'shape' && !('gradient' in o && o.gradient));
    return { id, objects: art.map((o) => ({ ...o, box: { ...o.box, x: o.box.x + dx } })) };
  };
  const unitsOf = (s: Slide) => unitsOfSlide(s, W / 1920, LOOK_MAIN);
  const warmed = () =>
    replies.filter((r) => r.t === 'unitsWarmed') as Extract<FromAsset, { t: 'unitsWarmed' }>[];
  afterEach(() => {
    clock.on = false;
    clock.stepMs = 0;
    clock.at = undefined;
    scope.onmessage!({ data: { t: 'init', width: W, height: H, token: '', apiPrefix: '/api/v1' } });
  });

  it('makes the units of the slides it is sent, in their order, unpinned, and says so per cue', async () => {
    const slides = [5, 6, 7].map((cueIndex) => ({
      cueIndex,
      slide: busy(`warm-${cueIndex}`, 50 + cueIndex / 16),
    }));
    replies.length = 0;
    const pinned = unitCache.pinned;
    send({ t: 'warmUnits', warm: { key: 'wu|a', slides, look: LOOK_MAIN } });
    await vi.waitFor(() => expect(warmed().at(-1)?.stopped).toBe('done'));
    expect(warmed().map((w) => w.cueIndex)).toEqual([5, 6, 7]);
    for (const w of warmed()) expect(w.ready).toBe(w.units);
    for (const { slide } of slides) for (const u of unitsOf(slide)) expect(unitReady(u)).toBeDefined();
    expect(unitCache.pinned).toBe(pinned);
  });

  it('carries the units this worker has made so far with each cue it warms, so the health count does not wait for a slide job', async () => {
    // The link counts `unitsMade` from the worker's reports; a slide job's `done` carried it, a warm-up's
    // `unitsWarmed` did not, so after the last `done` the count stayed behind what the warm-up made ahead.
    const slides = [3, 4].map((cueIndex) => ({
      cueIndex,
      slide: busy(`warm-made-${cueIndex}`, 110 + cueIndex / 16),
    }));
    const fresh = new Set(
      slides.flatMap(({ slide }) =>
        unitsOf(slide)
          .filter((u) => !unitReady(u))
          .map((u) => u.key),
      ),
    );
    expect(fresh.size).toBeGreaterThan(0);
    replies.length = 0;
    const before = unitWork().made;
    send({ t: 'warmUnits', warm: { key: 'wu|made', slides, look: LOOK_MAIN } });
    await vi.waitFor(() => expect(warmed().at(-1)?.stopped).toBe('done'));
    const made = warmed().map((w) => w.unitsMade);
    expect(made).toHaveLength(2);
    expect(made.every((n) => typeof n === 'number')).toBe(true);
    expect(made[0]!).toBeGreaterThan(before);
    expect(made[1]!).toBeGreaterThanOrEqual(made[0]!);
    expect(made.at(-1)).toBe(unitWork().made);
    expect(unitWork().made - before).toBe(fresh.size);
  });

  it('stops at two thirds of the unit cache', async () => {
    // Two stand-in units of 65 MiB: past 128 MiB, two thirds of 192.
    const big = (k: string) => ({ key: k, rect: { x: 0, y: 0, w: 1, h: 1 }, bytes: 65 * 1024 * 1024 });
    const fake = { width: 1, height: 1, close() {} } as unknown as CanvasImageSource;
    expect(putUnit(big('big-1') as never, fake)).toBe(true);
    expect(putUnit(big('big-2') as never, fake)).toBe(true);
    expect(unitCache.bytes('unit')).toBeGreaterThanOrEqual((UNIT_CACHE_BYTES * 2) / 3);
    try {
      replies.length = 0;
      const before = unitWork();
      const slides = [{ cueIndex: 1, slide: busy('warm-full', 70.5) }];
      send({ t: 'warmUnits', warm: { key: 'wu|full', slides, look: LOOK_MAIN } });
      await vi.waitFor(() => expect(warmed().at(-1)?.stopped).toBe('full'));
      expect(unitWork().made).toBe(before.made);
    } finally {
      unitCache.delete('unit', 'big-1');
      unitCache.delete('unit', 'big-2');
    }
  });

  it('a GO preempts it within one lane turn, and it goes on afterwards', async () => {
    const slides = [1, 2, 3, 4].map((cueIndex) => ({
      cueIndex,
      slide: busy(`warm-go-${cueIndex}`, 80 + (16 + cueIndex) / 32),
    }));
    clock.on = true;
    clock.t = 0;
    clock.stepMs = 20;
    replies.length = 0;
    rendered.length = 0;
    let goAt = -1;
    let goSteps = -1;
    clock.at = {
      t: 40,
      fn: () => {
        goAt = clock.t;
        goSteps = unitWork().steps;
        send({ t: 'job', job: slideJob({ video: undefined, key: 'sl|go-during-warm' }), role: 'live' });
      },
    };
    send({ t: 'warmUnits', warm: { key: 'wu|go', slides, look: LOOK_MAIN } });
    await vi.waitFor(() => expect(rendered.length).toBeGreaterThan(0));
    expect(goAt).toBeGreaterThanOrEqual(40);
    // No unit step after the one running when it arrived.
    expect(rendered[0]!.at - goAt).toBeLessThanOrEqual(20);
    expect(rendered[0]!.steps - goSteps).toBeLessThanOrEqual(1);
    await vi.waitFor(() => expect(warmed().at(-1)?.stopped).toBe('done'));
    expect(warmed().map((w) => w.cueIndex)).toEqual([1, 2, 3, 4]);
  });

  it('?warm=off makes nothing ahead', async () => {
    scope.onmessage!({
      data: { t: 'init', width: W, height: H, token: '', apiPrefix: '/api/v1', drawing: { warm: false } },
    });
    replies.length = 0;
    const before = unitWork();
    send({
      t: 'warmUnits',
      warm: { key: 'wu|off', slides: [{ cueIndex: 1, slide: busy('warm-off', 91) }], look: LOOK_MAIN },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(warmed()).toEqual([]);
    expect(unitWork().made).toBe(before.made);
  });
});

describe('asset worker: the underlay frame (design 29 R1)', () => {
  const send = (m: unknown) => link.onmessage!({ data: m });
  const init = (drawing: Record<string, unknown> = {}) =>
    scope.onmessage!({ data: { t: 'init', width: W, height: H, token: '', apiPrefix: '/api/v1', drawing } });
  const timed = (stepMs: number, paintMs = 0) => {
    clock.on = true;
    clock.t = 0;
    clock.stepMs = stepMs;
    clock.paintMs = paintMs;
  };
  afterEach(() => {
    clock.on = false;
    clock.stepMs = 0;
    clock.paintMs = 0;
    clock.at = undefined;
    init();
    clearFrameWork();
  });
  const ready = () =>
    replies.filter((r) => r.t === 'unitsReady') as Extract<FromAsset, { t: 'unitsReady' }>[];

  /** `n` squares in their own colours (each one fill), `distinct` making each slide's frame a key of its own. */
  const squareSlide = (id: string, n: number, distinct: number): Slide => ({
    id,
    objects: Array.from({ length: n }, (_, i) => ({
      id: `sq${i}`,
      type: 'shape',
      box: { x: 20 + (i % 20) * 90, y: 20 + Math.floor(i / 20) * 60, w: 80, h: 50, rotation: 0 },
      shape: 'rect',
      fill: { r: i % 256, g: distinct % 256, b: (i * 13) % 256, a: 1 },
      opacity: 1,
      radius: 0,
    })) as SlideObject[],
  });
  /** `n` text boxes of text of their own, so which of them a bitmap holds shows in its ops. */
  let saltOf = 0;
  const textSlide = (id: string, n: number, salt = ++saltOf): Slide => ({
    id,
    objects: Array.from({ length: n }, (_, i) =>
      text(`t${i}`, `L${salt}-${i}`, box(20, 20 + (i % 40) * 12, 300, 10)),
    ),
  });
  /** Job of `slide` with its uncut form (`full`) the way the link sends a crowded slide. */
  const crowdedJob = (s: Slide, key: string, extra: Partial<Extract<AssetJob, { kind: 'slide' }>> = {}) =>
    slideJob({
      slide: clampSlide(s),
      full: clampSlide(s, 'bake'),
      images: {},
      video: undefined,
      key,
      ...extra,
    });
  async function runAs(job: AssetJob, role: 'live' | 'armed' | 'late') {
    rendered.length = 0;
    replies.length = 0;
    send({ t: 'job', job, role });
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
    return { msg: rendered[0]?.msg, reply: replies[0]! };
  }
  const textsOf = (b: FakeBitmap) => b.ops.filter((o) => o.startsWith('text:')).length;
  const copiesOf = (b: FakeBitmap, w = W, h = H) => b.drawn.filter((d) => d.width === w && d.height === h);

  it('a jump to a crowded slide shows its direct part at once, the frame fading in once made', async () => {
    const s = textSlide('crowd-jump', 260);
    timed(1);
    const key = 'sl|crowd-jump';
    rendered.length = 0;
    replies.length = 0;
    const made0 = unitWork().made;
    send({ t: 'job', job: crowdedJob(s, key), role: 'live' });
    await vi.waitFor(() => expect(rendered.length).toBeGreaterThan(0));
    // Sent before any frame work: the top 200 objects, none of the 60 under them, no frame copied.
    const first = rendered[0]!.msg.bitmap as unknown as FakeBitmap;
    expect(textsOf(first)).toBe(200);
    expect(copiesOf(first)).toHaveLength(0);
    expect(rendered[0]!.made).toBe(made0);
    await vi.waitFor(() => expect(replies.find((r) => r.t === 'done')).toBeDefined());
    expect(replies.find((r) => r.t === 'done')).toMatchObject({ key, unitsLeft: 1 });
    // The late job makes the frame and reports it (its one key); the re-draw the link sends copies it.
    await vi.waitFor(() => expect(ready().find((r) => r.slideKey === key && r.left === 0)).toBeDefined());
    expect(ready().flatMap((r) => r.keys)).toHaveLength(1);
    expect(unitWork().made - made0).toBe(1);
    const again = await runAs(crowdedJob(s, key, { refresh: true, refreshFadeMs: 300 }), 'late');
    const second = again.msg!.bitmap as unknown as FakeBitmap;
    expect(textsOf(second)).toBe(200);
    expect(copiesOf(second)).toHaveLength(1);
    // the frame holds the 60 objects under the direct part (its canvas drew their text)
    expect(textsOf(copiesOf(second)[0]!)).toBe(60);
    expect(again.msg).toMatchObject({ refresh: true, refreshFadeMs: 300 });
  });

  it('arming a crowded slide makes its frame before it is sent; its GO does no frame work', async () => {
    const s = textSlide('crowd-arm', 260);
    timed(1);
    const made0 = unitWork().made;
    const armed = await runAs(crowdedJob(s, 'sl|crowd-arm-a'), 'armed');
    expect(armed.reply).toMatchObject({ t: 'done' });
    expect(unitWork().made - made0).toBe(1);
    expect(copiesOf(armed.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(1);
    const after = unitWork();
    const live = await runAs(crowdedJob(s, 'sl|crowd-arm-b'), 'live');
    expect(live.reply).toMatchObject({ t: 'done' });
    expect(unitWork()).toEqual(after);
    expect(copiesOf(live.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(1);
    expect(textsOf(live.msg!.bitmap as unknown as FakeBitmap)).toBe(200);
  });

  it('a GO that hurries a half-made frame loses no step: a later job finishes it, each step made once', async () => {
    const s = squareSlide('crowd-hurry', 340, 77);
    // One fill is a millisecond of the clock: the frame's 140 squares are a few dozen turns of 5 ms.
    timed(1, 1);
    const key = 'sl|crowd-hurry';
    let progress = 0;
    clock.at = {
      t: 40,
      fn: () => {
        const k = frameWorkKeys()[0];
        progress = (k && frameProgress(k)?.done) || 0;
        send({ t: 'hurry', keys: [key] });
      },
    };
    rendered.length = 0;
    replies.length = 0;
    const p0 = paints;
    send({ t: 'job', job: crowdedJob(s, key), role: 'armed' });
    await vi.waitFor(() => expect(rendered.length).toBeGreaterThan(0));
    // Hurried part-way: some steps done and kept in the work state, the frame not in the cache.
    expect(progress).toBeGreaterThan(5);
    expect(progress).toBeLessThan(140);
    // Its late job goes on from the step it stopped at, and reports the frame.
    await vi.waitFor(() => expect(ready().find((r) => r.slideKey === key && r.left === 0)).toBeDefined());
    expect(frameStats().resumed).toBeGreaterThanOrEqual(1);
    expect(framesInProgress()).toBe(0);
    expect(ready().flatMap((r) => r.keys)).toHaveLength(1);
    // The armed raster's 200 direct squares and the frame's 140: no step was drawn twice.
    expect(paints - p0).toBe(340);
  });

  it('?frame=off draws a crowded slide cut as before: 200 objects, no frame', async () => {
    init({ frame: 'off' });
    const s = textSlide('crowd-off', 260);
    const made0 = unitWork().made;
    const r = await runAs(crowdedJob(s, 'sl|crowd-off'), 'armed');
    const bmp = r.msg!.bitmap as unknown as FakeBitmap;
    expect(textsOf(bmp)).toBe(200);
    expect(copiesOf(bmp)).toHaveLength(0);
    expect(unitWork().made).toBe(made0);
    expect((r.reply as Extract<FromAsset, { t: 'done' }>).unitsLeft).toBeUndefined();
  });

  it('?effects=base implies ?frame=off', async () => {
    init({ effects: 'base' });
    const r = await runAs(crowdedJob(textSlide('crowd-base', 260), 'sl|crowd-base'), 'armed');
    expect(textsOf(r.msg!.bitmap as unknown as FakeBitmap)).toBe(200);
    expect(copiesOf(r.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(0);
  });

  it('draws an ordinary slide as it always was: no frame work, whole objects', async () => {
    const made0 = unitWork().made;
    const r = await runAs(
      slideJob({ slide: textSlide('calm', 30), images: {}, video: undefined, key: 'sl|calm' }),
      'armed',
    );
    expect(textsOf(r.msg!.bitmap as unknown as FakeBitmap)).toBe(30);
    expect(unitWork().made).toBe(made0);
    expect(frameStats().made).toBe(0);
  });

  it('a warm job makes the frame of the next crowded cue, kept pinned: arming it then makes none', async () => {
    const s = textSlide('crowd-warm', 260);
    replies.length = 0;
    const made0 = unitWork().made;
    send({
      t: 'warm',
      warm: {
        key: 'wm|crowd',
        slide: clampSlide(s),
        full: clampSlide(s, 'bake'),
        look: LOOK_MAIN,
        images: {},
      },
    });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ t: 'warmed', key: 'wm|crowd' });
    expect(unitWork().made - made0).toBe(1);
    const after = unitWork();
    const armed = await runAs(crowdedJob(s, 'sl|crowd-warm'), 'armed');
    expect(unitWork()).toEqual(after);
    expect(copiesOf(armed.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(1);
  });

  // The three hold tests of the geometry-units describe run with `frame: 'off'` (they are about separate units); these are
  // their counterparts with the frame on: the same subjects (the next arm lets go of a slide's hold, a re-draw takes over
  // the hold its late job kept, a jump while another cue stays armed) through the frame unit, which goes through the same
  // pin, hold and outstanding machinery by its key.
  const nextArm = (id: string) =>
    runAs(slideJob({ slide: { id, objects: [] }, images: {}, video: undefined, key: `sl|${id}` }), 'armed');

  it('the next arm lets go of a crowded slide’s hold: its GO did no frame work, and under cache pressure its re-draw makes the frame again, once, and ends (frame on)', async () => {
    const s = textSlide('hold-away', 260);
    const key = 'sl|hold-away';
    timed(1);
    const made0 = unitWork().made;
    const armed = await runAs(crowdedJob(s, key), 'armed');
    expect(unitWork().made - made0).toBe(1);
    expect(copiesOf(armed.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(1);
    // A GO to it (drawn already: the worker is told nothing) and the next cue armed at once: the layer's armed units
    // are that cue's now. Memory pressure then takes what nothing holds.
    await nextArm('hold-away-next');
    expect(unitWork().made - made0).toBe(1);
    unitCache.clear('unit');
    // The re-draw of the slide never waits for the frame: the direct part at once, the frame made by its late job.
    const again = await runAs(crowdedJob(s, key, { refresh: true, refreshFadeMs: 300 }), 'late');
    expect(textsOf(again.msg!.bitmap as unknown as FakeBitmap)).toBe(200);
    await vi.waitFor(() =>
      expect(ready().some((r) => r.slideKey === key && r.ended && r.left === 0)).toBe(true),
    );
    expect(unitWork().made - made0).toBe(2);
    expect(framesInProgress()).toBe(0);
    // And it stays: pinned with the slide, a later re-draw copies it and makes nothing.
    const made1 = unitWork().made;
    const third = await runAs(crowdedJob(s, key, { refresh: true, refreshFadeMs: 300 }), 'late');
    expect(copiesOf(third.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(1);
    expect(unitWork().made).toBe(made1);
  });

  it('a re-draw of a crowded slide takes over the hold its late job kept: the frame stays pinned while the slide is live, pressure or not (frame on)', async () => {
    const s = textSlide('hold-kept', 260);
    const key = 'sl|hold-kept';
    timed(1);
    const made0 = unitWork().made;
    rendered.length = 0;
    replies.length = 0;
    // A jump: the direct part at once, the frame made by its late job, then reported.
    send({ t: 'job', job: crowdedJob(s, key), role: 'live' });
    await vi.waitFor(() =>
      expect(ready().some((r) => r.slideKey === key && r.ended && r.left === 0)).toBe(true),
    );
    expect(unitWork().made - made0).toBe(1);
    // On screen: its re-draw copies the frame and takes the hold over from the late job that made it.
    const redraw = await runAs(crowdedJob(s, key, { refresh: true, refreshFadeMs: 300 }), 'late');
    expect(copiesOf(redraw.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(1);
    // Memory pressure takes what is not pinned: the slide's frame stays for the next re-draw.
    unitCache.clear('unit');
    const made1 = unitWork().made;
    const next = await runAs(crowdedJob(s, key, { refresh: true, refreshFadeMs: 300 }), 'late');
    expect(copiesOf(next.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(1);
    expect(unitWork().made).toBe(made1);
  });

  it('a jump while another crowded cue stays armed draws at once: the armed cue keeps its frame on the armed chain and makes it once (frame on)', async () => {
    const armedSlide = textSlide('jump-armed-c', 260);
    const armedKey = 'sl|jump-armed-c';
    timed(1);
    const made0 = unitWork().made;
    rendered.length = 0;
    replies.length = 0;
    send({ t: 'job', job: crowdedJob(armedSlide, armedKey, { cueIndex: 10 }), role: 'armed' });
    send({
      t: 'job',
      job: slideJob({
        slide: { id: 'jump-target-c', objects: [] },
        images: {},
        video: undefined,
        key: 'sl|jump-target-c',
        cueIndex: 9,
      }),
      role: 'live',
    });
    await vi.waitFor(() => {
      expect(replies.some((r) => r.t === 'done' && r.key === 'sl|jump-target-c')).toBe(true);
      expect(replies.some((r) => r.t === 'done' && r.key === armedKey)).toBe(true);
    });
    // Its frame is made once, whichever of the two went first, and nothing is left in progress.
    await vi.waitFor(() => expect(framesInProgress()).toBe(0));
    expect(unitWork().made - made0).toBe(1);
    expect(replies.some((r) => r.t === 'unitsReady' && r.stopped)).toBe(false);
    // Pinned with the armed cue: a GO to it does no frame work.
    unitCache.clear('unit');
    const made1 = unitWork().made;
    const go = await runAs(crowdedJob(armedSlide, armedKey), 'live');
    expect(go.reply).toMatchObject({ t: 'done' });
    expect(textsOf(go.msg!.bitmap as unknown as FakeBitmap)).toBe(200);
    expect(copiesOf(go.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(1);
    expect(unitWork().made).toBe(made1);
  });

  /** `n` copies of a line art, each moved a little (units are keyed by what they draw: `dx` is the test's own). */
  const artSlide = (id: string, n: number, dx: number): Slide => {
    const art = lineArtSlide().objects.find((o) => o.type === 'shape')!;
    return {
      id,
      objects: Array.from({ length: n }, (_, i) => ({
        ...art,
        id: `${art.id}-${i}`,
        box: { x: 20 + i * 30 + i / 8 + dx, y: 20 + i * 20, w: 600, h: 400, rotation: 0 },
      })),
    };
  };

  it('a jump to a slide past one frame of unit area only is drawn as it always was; its late job makes the whole split off the GO path (rule e)', async () => {
    const s = artSlide('area-jump', 20, 0.2109375);
    const key = 'sl|area-jump';
    const scale = W / 1920;
    const bake = clampSlide(s, 'bake');
    // Within the counts and past one frame of area only: the whole split has a frame, the one by the counts none.
    const whole = splitFrame(bake, scale)!;
    expect(whole.why.area).toBe(true);
    expect(splitFrame(bake, scale, { area: false })).toBeUndefined();
    const plan = unitsOfSlide(s, scale, LOOK_MAIN);
    const kept = unitsOfSlide(whole.direct, scale, LOOK_MAIN);
    expect(plan.length).toBeGreaterThan(0);
    timed(1);
    rendered.length = 0;
    replies.length = 0;
    const frames0 = frameStats().made;
    send({ t: 'job', job: crowdedJob(s, key), role: 'live' });
    await vi.waitFor(() => expect(replies.find((r) => r.t === 'done')).toBeDefined());
    // The slide as it always was: all its objects drawn (past the drawing budget as the base's draw of it, `heavy`; the
    // direct part of the whole split is 12 of 20), every unit of its plan left to the late job, nothing copied.
    expect(replies.find((r) => r.t === 'done')).toMatchObject({ key, heavy: true, unitsLeft: plan.length });
    expect(copiesOf(rendered[0]!.msg.bitmap as unknown as FakeBitmap)).toHaveLength(0);
    // Its late job works the whole split out: the frame and the units of the direct part, reported once made.
    await vi.waitFor(() => expect(ready().find((r) => r.slideKey === key && r.left === 0)).toBeDefined(), {
      timeout: 10_000,
    });
    expect(frameStats().made - frames0).toBe(1);
    expect(ready().flatMap((r) => r.keys)).toHaveLength(kept.length + 1);
    // The re-draw the link sends is the whole split's: the frame copied, nothing left.
    const again = await runAs(crowdedJob(s, key, { refresh: true, refreshFadeMs: 300 }), 'late');
    expect(copiesOf(again.msg!.bitmap as unknown as FakeBitmap)).toHaveLength(1);
    expect((again.reply as Extract<FromAsset, { t: 'done' }>).unitsLeft ?? 0).toBe(0);
  });

  it('the live playlist warm-up makes the frame of a crowded raw slide', async () => {
    const s = textSlide('crowd-wu', 260);
    replies.length = 0;
    const made0 = unitWork().made;
    send({ t: 'warmUnits', warm: { key: 'wu|crowd', slides: [{ cueIndex: 1, slide: s }], look: LOOK_MAIN } });
    await vi.waitFor(() =>
      expect(replies.find((r) => r.t === 'unitsWarmed' && r.stopped === 'done')).toBeDefined(),
    );
    const w = replies.find((r) => r.t === 'unitsWarmed') as Extract<FromAsset, { t: 'unitsWarmed' }>;
    expect(w).toMatchObject({ units: 1, ready: 1 });
    expect(unitWork().made - made0).toBe(1);
    // its job after: the same frame key, nothing made
    const after = unitWork();
    await runAs(crowdedJob(s, 'sl|crowd-wu'), 'armed');
    expect(unitWork()).toEqual(after);
  });
});
