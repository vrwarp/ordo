import { pictureTarget } from '@ordo/renderer';
import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  type DecoderDeps,
  type ImageDecoderCtor,
  MAX_SCALED_EIGHTHS,
  createDecoder,
  cropRect,
  jpegInfo,
  scaledPlan,
} from './decode.ts';

/*
 * The asset worker's decoder with fakes (design/27 §7.5 crop-aware decode): JPEG headers built here, an
 * ImageDecoder that "decodes" at the eighth Chromium would pick (at or below the size asked for), and a
 * createImageBitmap that records what it was asked to cut. The geometry against real pixels is checked in
 * headless Chromium (asset.lanes.browser.test.ts).
 */

/** A JPEG's first bytes: SOI, optionally an APP1 Exif segment with an orientation, an APP0 and SOF0. */
function jpeg(w: number, h: number, orientation?: number, le = false): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  const seg = (mk: number, body: number[]) =>
    out.push(0xff, mk, (body.length + 2) >> 8, (body.length + 2) & 255, ...body);
  seg(0xe0, [...'JFIF\0'].map((c) => c.charCodeAt(0)).concat([1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (orientation !== undefined) {
    const u16 = (v: number) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
    const u32 = (v: number) => (le ? [v & 255, (v >> 8) & 255, 0, 0] : [0, 0, (v >> 8) & 255, v & 255]);
    const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1)];
    tiff.push(...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0));
    seg(0xe1, [...'Exif\0\0'].map((c) => c.charCodeAt(0)).concat(tiff));
  }
  seg(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  out.push(0xff, 0xda, 0, 2);
  return new Uint8Array(out);
}

const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

describe('jpegInfo', () => {
  it('reads the size from the frame header and the EXIF orientation, both byte orders', () => {
    expect(jpegInfo(jpeg(6000, 4000))).toEqual({ width: 6000, height: 4000 });
    expect(jpegInfo(jpeg(6000, 4000, 6))).toEqual({ width: 6000, height: 4000, orientation: 6 });
    expect(jpegInfo(jpeg(640, 480, 1, true))).toEqual({ width: 640, height: 480, orientation: 1 });
  });

  it('says nothing for other formats, malformed headers and a frame header past the bytes given', () => {
    expect(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    const j = jpeg(100, 100);
    expect(jpegInfo(j.subarray(0, j.length - 18))).toBeUndefined(); // cut inside the frame header
    const bad = j.slice();
    bad[2] = 0x00;
    expect(jpegInfo(bad)).toBeUndefined();
  });
});

describe('scaledPlan and cropRect', () => {
  const frame = pictureTarget({ box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, fit: 'cover' }, 1)!;
  const frame4k = pictureTarget({ box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, fit: 'cover' }, 2)!;

  it('asks for the eighth at or above what the uses need, up to four eighths', () => {
    // A 4K-prepared photo on a 1080p output: exactly half.
    expect(scaledPlan(3840, 2160, { targets: [frame] })).toMatchObject({ eighths: 4, w: 1920, h: 1080 });
    // 6000x4000 covering 1080p needs 0.32: three eighths, 2250x1500.
    expect(scaledPlan(6000, 4000, { targets: [frame] })).toMatchObject({ eighths: 3, w: 2250, h: 1500 });
    // The same at 4K needs 0.64: decoded whole.
    expect(scaledPlan(6000, 4000, { targets: [frame4k] })).toBeUndefined();
    expect(MAX_SCALED_EIGHTHS).toBe(4);
    // The source covering the output needs the whole picture: no region.
    const cover = scaledPlan(6000, 4000, { cover: { w: 1920, h: 1080 } })!;
    expect(cover).toMatchObject({ eighths: 3 });
    expect(cover.region).toBeUndefined();
    expect(scaledPlan(0, 10, { cover: { w: 1, h: 1 } })).toBeUndefined();
  });

  it('keeps the visible crop with a margin, unless that is more than half the frame', () => {
    const cropped = pictureTarget(
      {
        box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
        fit: 'stretch',
        crop: { l: 0.7, t: 0.7, r: 0.05, b: 0.05 },
      },
      1,
    )!;
    const p = scaledPlan(8000, 6000, { targets: [cropped] })!;
    // 2000 x 1500 picture px shown at 0.96 x 0.72: eight eighths. Too much for the scaled path...
    expect(p).toBeUndefined();
    // ...but at a quarter of the box it needs 0.24: two eighths, and only the crop is kept.
    const small = pictureTarget(
      {
        box: { x: 0, y: 0, w: 480, h: 270, rotation: 0 },
        fit: 'stretch',
        crop: { l: 0.7, t: 0.7, r: 0.05, b: 0.05 },
      },
      1,
    )!;
    const q = scaledPlan(8000, 6000, { targets: [small] })!;
    expect(q).toMatchObject({ eighths: 2, w: 2000, h: 1500 });
    const c = cropRect(q.region!, q.need, 2000, 1500, 8000, 6000)!;
    // The region is x 5600..7600, y 4200..5700 of the picture: 1400..1900, 1050..1425 at a quarter, plus a
    // margin of 5 px (twice the 1.04 footprint of the reduction to 0.24, rounded up, and 2).
    expect(c).toEqual({ x: 1395, y: 1045, w: 510, h: 385 });
    // A region over half the frame keeps the frame.
    expect(cropRect({ x: 0, y: 0, w: 6000, h: 3000 }, 0.5, 3000, 2000, 6000, 4000)).toBeUndefined();
  });
});

/** Fakes for the decoder's platform: bitmaps that know what they were made from. */
function platform(o: { refuseSmall?: boolean; fail?: 'scaled' | 'all' } = {}) {
  type Fake = { width: number; height: number; what: string; close(): void; closed: boolean };
  const made: Fake[] = [];
  const asked: { w?: number; h?: number }[] = [];
  const fake = (width: number, height: number, what: string): Fake => {
    const f: Fake = { width, height, what, closed: false, close: () => void (f.closed = true) };
    made.push(f);
    return f;
  };
  class FakeImageDecoder {
    constructor(
      private init: { data: unknown; type: string; desiredWidth?: number; desiredHeight?: number },
    ) {
      asked.push({ w: init.desiredWidth, h: init.desiredHeight });
    }
    async decode() {
      if (o.fail) throw new Error('decoder failed');
      const { w = 6000 } = { w: this.init.desiredWidth };
      // Chromium's pick: the largest eighth at or below the size asked for (one below it when refusing).
      const iw = 6000;
      const ih = 4000;
      let m = Math.max(1, Math.floor((8 * (w ?? iw)) / iw));
      if (o.refuseSmall) m = Math.max(1, m - 1);
      const f = fake(Math.ceil((iw * m) / 8), Math.ceil((ih * m) / 8), `frame ${m}/8`);
      return {
        image: { displayWidth: f.width, displayHeight: f.height, close: f.close } as unknown as VideoFrame,
      };
    }
    close() {}
  }
  const cib = async (src: unknown, ...args: unknown[]) => {
    if (o.fail === 'all') throw new Error('not an image');
    if (src instanceof Blob) return fake(6000, 4000, 'full') as unknown as ImageBitmap;
    const s = src as { displayWidth?: number; width?: number; height?: number; displayHeight?: number };
    if (typeof args[0] === 'number') {
      const [x, y, w, h] = args as number[];
      return fake(w!, h!, `crop ${x},${y}`) as unknown as ImageBitmap;
    }
    const opts = args[0] as { resizeWidth?: number; resizeHeight?: number } | undefined;
    if (opts?.resizeWidth)
      return fake(opts.resizeWidth, opts.resizeHeight!, 'reduced') as unknown as ImageBitmap;
    return fake(
      s.displayWidth ?? s.width!,
      s.displayHeight ?? s.height!,
      'frame bitmap',
    ) as unknown as ImageBitmap;
  };
  const deps = (bytes: Uint8Array, withDecoder = true): DecoderDeps => ({
    read: async () => ({ blob: blobOf(bytes), source: 'opfs' }),
    createImageBitmap: cib as DecoderDeps['createImageBitmap'],
    ImageDecoder: withDecoder ? (FakeImageDecoder as unknown as ImageDecoderCtor) : undefined,
  });
  return { made, asked, deps };
}

describe('createDecoder: the crop-aware decode', () => {
  const target = pictureTarget({ box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 }, fit: 'cover' }, 1)!;

  it('decodes a large JPEG at the eighth its uses need and lays targets out from the picture', async () => {
    const p = platform();
    const d = createDecoder(p.deps(jpeg(6000, 4000)));
    const bmp = await d.decode('h', { targets: [target] });
    expect(p.asked).toEqual([{ w: 2250, h: 1500 }]);
    expect([bmp.width, bmp.height]).toEqual([2250, 1500]);
    expect((bmp as unknown as { what: string }).what).toBe('frame bitmap');
    expect(d.partial!(bmp)).toBe(false); // the whole picture, smaller
    expect(d.stats).toEqual({ full: 0, scaled: 1, cropped: 0, refused: 0, svg: 0 });
    // The frame is closed once its bitmap is made.
    expect(p.made.find((m) => m.what.startsWith('frame 3'))!.closed).toBe(true);
  });

  it('keeps only the visible crop of a picture cut by its crop', async () => {
    const p = platform();
    const d = createDecoder(p.deps(jpeg(6000, 4000)));
    const t = pictureTarget(
      {
        box: { x: 0, y: 0, w: 480, h: 270, rotation: 0 },
        fit: 'stretch',
        crop: { l: 0.6, t: 0.6, r: 0, b: 0 },
      },
      1,
    )!;
    const bmp = await d.decode('h', { targets: [t] });
    expect((bmp as unknown as { what: string }).what).toMatch(/^crop /);
    expect(d.partial!(bmp)).toBe(true);
    expect(d.stats.cropped).toBe(1);
  });

  it('decodes the whole file for an orientation, another format, a small frame, a failure, or 5/8 and more', async () => {
    const cases: [Uint8Array, ReturnType<typeof platform>, object][] = [
      [jpeg(6000, 4000, 6), platform(), { targets: [target] }],
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), platform(), { targets: [target] }],
      [jpeg(6000, 4000), platform({ refuseSmall: true }), { targets: [target] }],
      [jpeg(6000, 4000), platform({ fail: 'scaled' }), { targets: [target] }],
      [jpeg(6000, 4000), platform(), { cover: { w: 3840, h: 2160 } }],
    ];
    for (const [bytes, p, want] of cases) {
      const d = createDecoder(p.deps(bytes));
      const bmp = await d.decode('h', want);
      expect((bmp as unknown as { what: string }).what).toBe('full');
      expect(d.stats.full).toBe(1);
    }
    // Without ImageDecoder (no secure context) every decode is whole.
    const p = platform();
    const d = createDecoder(p.deps(jpeg(6000, 4000), false));
    expect(((await d.decode('h', { targets: [target] })) as unknown as { what: string }).what).toBe('full');
  });

  it('an SVG it cannot decode is drawn by the window, once per decode; other files are not', async () => {
    const svg = new TextEncoder().encode(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="4">',
    );
    const asked: string[] = [];
    const p = platform({ fail: 'all' });
    const rasterSvg = async (hash: string, blob: Blob) => {
      asked.push(`${hash} ${blob.size}`);
      return { width: 1920, height: 1080, what: 'window', close() {} } as unknown as ImageBitmap;
    };
    const d = createDecoder({ ...p.deps(svg), rasterSvg });
    const bmp = await d.decode('svghash', { targets: [target] });
    expect((bmp as unknown as { what: string }).what).toBe('window');
    expect(asked).toEqual([`svghash ${svg.length}`]);
    expect(d.stats).toMatchObject({ full: 0, svg: 1 });
    // A JPEG that does not decode is not sent to the window.
    const j = createDecoder({ ...platform({ fail: 'all' }).deps(jpeg(64, 48)), rasterSvg });
    expect(await j.decode('jpeg', undefined).catch((e) => e)).toBeInstanceOf(DecodeError);
    expect(asked).toHaveLength(1);
    // The window failing to draw it is a decode error of that file (the link retries, then quarantines).
    const f = createDecoder({
      ...platform({ fail: 'all' }).deps(svg),
      rasterSvg: async () => {
        throw new Error('tainted');
      },
    });
    const err = await f.decode('bad', undefined).catch((e) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect(err.message).toMatch(/SVG bad could not be drawn: tainted/);
    // Without a window to ask (rasterSvg absent) it fails as before.
    const n = createDecoder(platform({ fail: 'all' }).deps(svg));
    expect(await n.decode('none', undefined).catch((e) => e)).toBeInstanceOf(DecodeError);
  });

  it('a file that does not decode fails with where it was read from', async () => {
    const p = platform({ fail: 'all' });
    const d = createDecoder(p.deps(jpeg(6000, 4000)));
    const err = await d.decode('abcdef0123', { targets: [target] }).catch((e) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect(err).toMatchObject({ hash: 'abcdef0123', source: 'opfs' });
  });
});
