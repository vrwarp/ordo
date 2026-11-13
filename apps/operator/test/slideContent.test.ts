import { LOOK_MAIN, type Media, type Presentation, type Slide, slideContent } from '@ordo/domain';
import { CONTENT_CASES, type ContentCase, contentCase } from '@ordo/domain/content.test-util.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { previewMedia } from '../src/lib/preview.ts';
import { slideImages } from '../src/services/thumbs.ts';
import { canvasContent } from '../src/views/editor/canvasContent.ts';
import { lookPreviewJob } from '../src/views/editor/LookPreviews.tsx';
import type { ThumbIn, ThumbJob, ThumbOut } from '../src/workers/thumb.worker.ts';

/**
 * The operator's drawers follow the outputs' one fallback rule (design/27 §5 "One rule for every drawer",
 * §7.4): thumbnails (the job's pictures and the worker's drawing), look previews, the editor canvas and
 * previews sent to an output, for every slide class and show mode of the shared fixtures.
 */

const picture = (id: string): Media => ({
  id,
  rev: 1,
  name: id,
  tags: [],
  kind: 'image',
  original: { hash: `${id}-file`, bytes: 10, mime: 'image/png', path: `files/${id}-file` },
  state: 'ready',
  loop: false,
  isBackground: false,
});
const library = new Map(
  ['page', 'ref', 'art', 'photo', 'photo2', 'mine', 'bg'].map((id) => [id, picture(id)]),
);
const media = (id: string) => library.get(id);
const files = (c: ContentCase) => Object.fromEntries(c.pictures.map((id) => [id, `${id}-file`]));

const deck = (slides: Slide[]): Presentation => ({
  id: 'deck',
  rev: 1,
  title: 'Deck',
  kind: 'slides',
  meta: { tags: [] },
  sections: [{ id: 's', label: 'Slides', short: 'S', slides }],
  arrangements: [],
  archived: false,
  backgroundMediaId: 'bg',
});

describe('thumbnails, look previews, the editor canvas and previews draw what the screens draw', () => {
  for (const c of CONTENT_CASES)
    it(c.name, () => {
      // Thumbnail jobs carry exactly the pictures the slide draws.
      expect(slideImages(c.slide, media)).toEqual(files(c));
      // Look previews are thumbnail jobs of the same slide, under each look.
      const job = lookPreviewJob({
        look: LOOK_MAIN,
        presentation: deck([c.slide]),
        slide: c.slide,
        media,
        width: 480,
      });
      expect(job.images).toEqual(files(c));
      expect(job.bg).toBe('bg-file');
      // The editor canvas: the picture under the objects the screens draw (and the only ones it selects).
      const canvas = canvasContent(c.slide, media);
      expect(canvas.pictureMediaId).toBe(c.picture);
      expect(canvas.pictureHash).toBe(c.picture ? `${c.picture}-file` : undefined);
      expect(canvas.objects).toEqual(slideContent(c.slide).objects);
      expect(canvas.objects.flatMap((o) => (o.type === 'text' ? [o.text] : []))).toEqual(c.texts);
      // A preview sends the presentation's background and the pictures the slide draws.
      expect(previewMedia(deck([c.slide]), c.slide.id, media).map((m) => m.id)).toEqual([
        'bg',
        ...c.pictures,
      ]);
    });

  it('the editor canvas shows no picture whose file the library does not have', () => {
    const c = canvasContent(contentCase('ref').slide, () => undefined);
    expect(c.pictureMediaId).toBe('ref');
    expect(c.pictureHash).toBeUndefined();
  });
});

/**
 * The thumbnail worker with fakes, as the output's asset worker is tested: its scope, OffscreenCanvas,
 * createImageBitmap and the file route are stand-ins; a canvas records what is drawn on it (pictures by
 * their file hash, text by its string) and its blob is that record.
 */
describe('thumbnail worker: what it draws follows slideContent', () => {
  type Drawn = { ops: string[] };
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
        if (k in t) return t[k];
        return (...args: unknown[]) => {
          if (k === 'fillText') ops.push(`text:${args[0]}`);
          else if (k === 'drawImage') ops.push(`image:${(args[0] as { tag?: string }).tag}`);
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
    public width: number;
    public height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return this.ctx;
    }
    async convertToBlob(): Promise<Drawn> {
      return { ops: this.ops };
    }
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    vi.stubGlobal('self', scope);
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('fetch', async (url: string) => {
      const hash = /files\/([^?]+)/.exec(url)?.[1] ?? '';
      return { ok: true, blob: async () => ({ hash }) };
    });
    vi.stubGlobal('createImageBitmap', async (b: { hash: string }) => ({
      tag: b.hash,
      width: 640,
      height: 360,
      close: () => undefined,
    }));
    scope.postMessage = (m) => {
      if (m.t === 'done') done.set(m.id, m);
    };
    await import('../src/workers/thumb.worker.ts');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  let nextId = 1;
  async function render(job: ThumbJob): Promise<string[]> {
    const id = nextId++;
    scope.onmessage!({ data: { t: 'render', id, job } });
    await vi.waitFor(() => expect(done.has(id)).toBe(true));
    const out = done.get(id)!;
    if (out.t !== 'done' || !out.blob) throw new Error(out.t === 'done' ? out.error : 'no blob');
    return (out.blob as unknown as Drawn).ops;
  }

  for (const c of CONTENT_CASES)
    it(`${c.name}: the picture, then the objects drawn`, async () => {
      // Given every picture any case names, the worker still draws only the slide's own.
      const images = Object.fromEntries([...library.keys()].map((id) => [id, `${id}-file`]));
      const ops = await render({ slide: c.slide, isSong: false, images, width: 320, height: 180 });
      expect(ops.filter((o) => o.startsWith('image:'))).toEqual(c.pictures.map((id) => `image:${id}-file`));
      expect(ops.filter((o) => o.startsWith('text:'))).toEqual(c.texts.map((t) => `text:${t}`));
    });

  it('draws the hybrid art at its place in the z order, over the background', async () => {
    const c = contentCase('hybrid');
    const ops = await render({
      slide: c.slide,
      isSong: false,
      images: files(c),
      bg: 'bg-file',
      width: 320,
      height: 180,
    });
    expect(ops).toEqual(['image:bg-file', 'text:Under', 'image:art-file', 'image:photo2-file', 'text:Over']);
  });
});
