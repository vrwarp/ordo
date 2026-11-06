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
  constructor(
    public width: number,
    public height: number,
  ) {}
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
    return { status: 200, ok: true, blob: async () => ({ hash }) };
  });
  // A decode of a file, or a reduction of a decoded picture (`downscaleFor`), keeps the tag.
  vi.stubGlobal(
    'createImageBitmap',
    async (b: { hash?: string; tag?: string }, o?: { resizeWidth: number; resizeHeight: number }) => {
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
