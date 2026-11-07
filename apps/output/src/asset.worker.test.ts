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
  SRC_BITMAP,
  SRC_SCENE,
  planeSample,
  preparedKey,
} from '@ordo/renderer';
import { CONTENT_CASES, contentCase } from '@ordo/domain/content.test-util.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

/** A 2D context that logs fillText and drawImage on `rec` (every glyph is 10 device px wide). */
function fakeCtx(rec: { ops: string[]; drawn: FakeBitmap[] }) {
  const state: Record<string | symbol, unknown> = { font: '10px x', letterSpacing: '0px', globalAlpha: 1 };
  return new Proxy(state, {
    get(t, k) {
      if (k === 'measureText') return (s: string) => ({ width: s.length * 10 });
      // Nothing drawn reaches a pixel of these fakes: a tight sprite's edge ring reads transparent.
      if (k === 'getImageData')
        return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (k in t) return t[k];
      return (...args: unknown[]) => {
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
  constructor(width: number, height: number) {
    this.w = width;
    this.h = height;
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
    return this.ctx;
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
const rendered: { msg: AssetToRender; transfer: unknown[] }[] = [];
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
  postMessage: (msg: AssetToRender, transfer: unknown[]) => rendered.push({ msg, transfer }),
  close: () => undefined,
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  vi.stubGlobal('self', scope);
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  // Pictures arrive from the hub's file route, tagged with their hash; the poster is 4:3.
  vi.stubGlobal('fetch', async (url: string) => {
    const hash = /files\/([^?]+)/.exec(url)?.[1] ?? '';
    // A file's head (opaque.ts reads it): a .jpg starts with the JPEG marker, anything else is unknown.
    const head = hash.endsWith('.jpg') ? new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) : new Uint8Array(4);
    const slice = () => ({ arrayBuffer: async () => head.buffer });
    return { status: 200, ok: true, blob: async () => ({ hash, size: 4, slice }) };
  });
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
