import type { Slide, SlideObject, TextObject } from '@ordo/domain';
import { DEFAULT_LYRIC_STYLE } from '@ordo/domain';
import { BAKE_DEADLINE_MS, bakeSlide, createBakeEnv, encodePicture } from '../src/bake.ts';
import type { FramePictures } from '../src/frame.ts';
import { clearFrameWork } from '../src/frame.ts';
import { picture, slideOf, square, textBox } from '../src/frame.test-util.ts';
import { clearUnits, setUnitMedia } from '../src/units.ts';
import { BUILDERS } from './frame.page.ts';

/*
 * Browser side of bench:bake (bake-render, sub-wave 3): one bake of a synthetic slide on a software 3840x2160 canvas
 * (this machine draws on the CPU: a venue PC decides the 4K figures), timed by phase, with the bytes of the three
 * pictures. One case on one fresh page per run: the runner samples the browser's memory around it. The collages
 * decode real JPEG files (60 distinct ones, each used by five tiles, and 300 distinct ones) made here from gradients,
 * so the decode cost is real; every other picture is a flat canvas standing for a decoded file.
 */

export type BakeBenchCase = {
  name: string;
  scale: number;
  objects: number;
  ok: boolean;
  reason?: string;
  detail?: string;
  /** Milliseconds by phase: draw, compose, alpha, png3840, copy1920, png1920, webp640, verify, total (bake + encode). */
  ms: Record<string, number>;
  bytes: { png3840?: number; png1920?: number; webp640?: number };
  opaque?: boolean;
  longestTurn: number;
  wallMs: number;
  /** Distinct files decoded and decodes made (collages). */
  decodes: number;
};

const NAMES = [
  'collage300',
  'collage300x',
  'crowded340',
  'objects1000',
  'objects1357',
  'objects20000',
  'text',
  'shadows20',
  'photo-bg',
  'photo-full',
] as const;

/** A JPEG file of about 1600x1200: a gradient with a few rectangles, so it compresses as a photo might. */
async function jpeg(seed: number): Promise<Blob> {
  const c = new OffscreenCanvas(1600, 1200);
  const x = c.getContext('2d')!;
  const g = x.createLinearGradient(0, 0, 1600, 1200);
  g.addColorStop(0, `hsl(${(seed * 47) % 360}, 70%, 40%)`);
  g.addColorStop(1, `hsl(${(seed * 47 + 120) % 360}, 70%, 60%)`);
  x.fillStyle = g;
  x.fillRect(0, 0, 1600, 1200);
  for (let i = 0; i < 60; i++) {
    x.fillStyle = `hsla(${(seed * 13 + i * 29) % 360}, 60%, ${30 + ((i * 7) % 40)}%, 0.6)`;
    x.fillRect(
      (seed * 97 + i * 131) % 1500,
      (seed * 53 + i * 71) % 1100,
      40 + ((i * 17) % 160),
      30 + ((i * 11) % 120),
    );
  }
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}

function gridPictures(n: number, files: number): SlideObject[] {
  return Array.from({ length: n }, (_, i) =>
    picture(
      `pic${i}`,
      `file${i % files}`,
      { x: 20 + (i % 20) * 94, y: 130 + Math.floor(i / 20) * 62, w: 90, h: 60 },
      { fit: 'cover' },
    ),
  );
}

const title = (): TextObject =>
  ({
    ...textBox('title', 'Collage', 100, 20, 1720, 90),
    style: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Inter', fontSizePx: 64 },
  }) as TextObject;

function build(name: string): { slide: Slide; files: number } {
  switch (name) {
    case 'collage300':
      return {
        slide: slideOf(
          [
            {
              ...square(0),
              box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
              fill: { r: 30, g: 30, b: 40, a: 1 },
            },
            title(),
            ...gridPictures(300, 60),
          ],
          name,
        ),
        files: 60,
      };
    case 'collage300x':
      return {
        slide: slideOf(
          [
            {
              ...square(0),
              box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
              fill: { r: 30, g: 30, b: 40, a: 1 },
            },
            title(),
            ...gridPictures(300, 300),
          ],
          name,
        ),
        files: 300,
      };
    case 'objects1357': {
      const shapes = Array.from({ length: 1300 }, (_, i) => ({
        ...square(i),
        box: { x: 20 + (i % 50) * 37, y: 130 + Math.floor(i / 50) * 34, w: 33, h: 30, rotation: 0 },
      }));
      const legend = Array.from({ length: 56 }, (_, i) => ({
        ...textBox(`lg${i}`, `Item ${i}`, 20 + (i % 8) * 230, 40 + Math.floor(i / 8) * 12, 220, 10),
        style: { ...DEFAULT_LYRIC_STYLE, fontFamily: 'Inter', fontSizePx: 9 },
      }));
      return { slide: slideOf([title(), ...legend, ...shapes], name), files: 0 };
    }
    case 'text': {
      const words = 'the quick brown fox jumps over the lazy dog and sings of grace ';
      const long = (id: string, y: number): TextObject =>
        ({
          ...textBox(id, words.repeat(160).slice(0, 10_000), 60, y, 1800, 480),
          style: {
            ...DEFAULT_LYRIC_STYLE,
            fontFamily: 'Inter',
            fontSizePx: 20,
            align: 'left',
            valign: 'top',
          },
        }) as TextObject;
      return { slide: slideOf([long('a', 20), long('b', 540)], name), files: 0 };
    }
    case 'photo-bg':
      // a plain own background picture and a title and text (its picture is sparse and has alpha: the background is not baked)
      return {
        slide: {
          ...slideOf([title(), { ...textBox('t', 'A short line of text', 100, 400) }], name),
          backgroundMediaId: 'file0',
        },
        files: 1,
      };
    case 'photo-full':
      // a full-bleed 3840x2160 photo as a picture object, with a title over it (opaque, the big case)
      return {
        slide: slideOf(
          [picture('photo', 'file0', { x: 0, y: 0, w: 1920, h: 1080 }, { fit: 'cover' }), title()],
          name,
        ),
        files: 1,
      };
    default: {
      const b = BUILDERS[name];
      if (!b) throw new Error(`no case ${name}`);
      return { slide: b(), files: 0 };
    }
  }
}

export async function runBake(
  name: string,
  scale: number,
  font: ArrayBuffer,
  deadlineMs?: number,
): Promise<BakeBenchCase> {
  clearUnits();
  clearFrameWork();
  setUnitMedia(undefined);
  const { slide, files } = build(name);
  const blobs: Blob[] = [];
  for (let i = 0; i < files; i++) blobs.push(await jpeg(i));
  const flat: Record<string, OffscreenCanvas> = {};
  let decodes = 0;
  const pictures: FramePictures = {
    async acquire(o, s) {
      if (!files) {
        const src = (flat[o.mediaId] ??= (() => {
          const c = new OffscreenCanvas(64 + (o.mediaId.length % 7) * 40, 48 + (o.mediaId.length % 7) * 30);
          const x = c.getContext('2d')!;
          x.fillStyle = `rgb(${(o.mediaId.length * 37) % 255}, 90, 160)`;
          x.fillRect(0, 0, c.width, c.height);
          return c;
        })());
        return { lookup: (() => src) as never, release: () => undefined };
      }
      const blob = blobs[Number(o.mediaId.replace('file', '')) % files]!;
      const bmp = await createImageBitmap(blob, {
        resizeWidth: Math.max(1, Math.round(o.box.w * s)),
        resizeHeight: Math.max(1, Math.round(o.box.h * s)),
        resizeQuality: 'high',
      });
      decodes++;
      return { lookup: (() => bmp) as never, release: () => bmp.close() };
    },
  };
  const env = createBakeEnv({ set: document.fonts, data: async () => font });
  await env.fonts.sync([{ family: 'Inter', weight: 400, style: 'normal', hash: 'bench-face' }]);
  await env.ready();
  const t0 = performance.now();
  try {
    const r = await bakeSlide(slide, { env, pictures, scale, deadlineMs: deadlineMs ?? BAKE_DEADLINE_MS });
    const out: BakeBenchCase = {
      name,
      scale,
      objects: slide.objects.length,
      ok: r.ok,
      ms: { ...r.stats.ms },
      bytes: {},
      longestTurn: r.stats.longestTurn,
      wallMs: 0,
      decodes,
    };
    if (!r.ok) {
      out.reason = r.reason;
      out.detail = r.detail;
    } else {
      out.opaque = r.opaque;
      const e = await encodePicture(r);
      if (e.ok) {
        Object.assign(out.ms, e.stats.ms);
        for (const p of e.pictures)
          out.bytes[p.type === 'image/webp' ? 'webp640' : p.size === 1920 ? 'png1920' : 'png3840'] = p.bytes;
      } else {
        out.ok = false;
        out.reason = e.reason;
        out.detail = e.detail;
      }
    }
    out.wallMs = Math.round(performance.now() - t0);
    out.ms.total = out.wallMs;
    return out;
  } finally {
    env.dispose();
  }
}

(globalThis as unknown as { __bakeBench: typeof runBake }).__bakeBench = runBake;
export { NAMES };
