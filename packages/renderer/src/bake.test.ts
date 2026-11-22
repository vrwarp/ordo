import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Slide } from '@ordo/domain';
import { PRERENDER_FRAME } from '@ordo/domain/prerender.ts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BAKE_DEADLINE_MAX_MS,
  BAKE_DEADLINE_MS,
  BAKE_FRAME,
  BAKE_MAX_PICTURE_BYTES,
  BAKE_SIZES,
  BAKE_UPLOAD_ORDER,
  type BakeEnv,
  type BakeFailure,
  type BakeReason,
  bakeDeadline,
  bakeScale,
  bakeSlide,
  failureText,
  readPictureHeader,
  tileOrigins,
} from './bake.ts';
import { picture, slideOf, square, squares, textBox } from './frame.test-util.ts';
import { clearGeomFiles } from './geom/stored.ts';
import { FontResolver, installFontEnv, LEGACY_FONT_ENV } from './text/fonts.ts';
import { clearUnits } from './units.ts';

/*
 * The contracts of bake.ts that need no canvas (the drawing and the encoders are in bake.browser.test.ts): the
 * constants held equal to the hub's and the domain's, the failure text, the option clamps, the picture header
 * reader, the round trip's tiles, and the refusals that come before any drawing (single flight, the profile, the
 * object count, an animated object, a file not read).
 */

const root = join(import.meta.dirname, '../../..');

describe('constants held equal to the hub and the domain', () => {
  it("BAKE_FRAME is the domain's PRERENDER_FRAME", () => {
    expect(BAKE_FRAME).toEqual(PRERENDER_FRAME);
  });

  it("BAKE_SIZES and the file bound are the hub's (read as text: the renderer must not import hub code)", () => {
    const hub = readFileSync(join(root, 'apps/hub/src/prerenders.ts'), 'utf8');
    const sizes = [...hub.matchAll(/^\s*(\d+): \[(\d+), (\d+)\],?$/gm)].map((m) => [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
    ]);
    expect(sizes.map((s) => s[0]).sort((a, b) => b! - a!)).toEqual([...BAKE_SIZES]);
    for (const [w, ww, hh] of sizes) {
      expect(ww).toBe(w);
      expect(hh).toBe(Math.round((w! * 9) / 16));
    }
    const max = /export const PICTURE_MAX_BYTES = (\d+) \* 1024 \* 1024;/.exec(hub);
    expect(max, 'the hub names its picture bound').not.toBeNull();
    expect(BAKE_MAX_PICTURE_BYTES).toBe(Number(max![1]) * 1024 * 1024);
  });

  it('the upload order is 1920, 3840, 640 and holds every size once', () => {
    expect([...BAKE_UPLOAD_ORDER]).toEqual([1920, 3840, 640]);
    expect([...BAKE_UPLOAD_ORDER].sort()).toEqual([...BAKE_SIZES].sort());
  });

  it('the deadline is 60 s, at most 180 s (Q38.a)', () => {
    expect(BAKE_DEADLINE_MS).toBe(60_000);
    expect(BAKE_DEADLINE_MAX_MS).toBe(180_000);
  });
});

describe('failureText', () => {
  it('is the reason and its detail, at most 200 characters', () => {
    expect(failureText({ reason: 'coverage', detail: '€☃' })).toBe('coverage: €☃');
    expect(failureText({ reason: 'blank', detail: '' })).toBe('blank');
    const long = failureText({ reason: 'font', detail: 'x'.repeat(5000) });
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.startsWith('font: xxx')).toBe(true);
  });
});

describe('option clamps', () => {
  it('the deadline defaults to 60 s, is at least 1 ms and never above 180 s', () => {
    expect(bakeDeadline(undefined)).toBe(BAKE_DEADLINE_MS);
    expect(bakeDeadline(5_000)).toBe(5_000);
    expect(bakeDeadline(10 * 60_000)).toBe(BAKE_DEADLINE_MAX_MS);
    expect(bakeDeadline(0)).toBe(1);
    expect(bakeDeadline(-5)).toBe(1);
    expect(bakeDeadline(Number.NaN)).toBe(BAKE_DEADLINE_MS);
  });

  it('the scale defaults to 2, is positive and at most 4', () => {
    expect(bakeScale(undefined)).toBe(2);
    expect(bakeScale(1)).toBe(1);
    expect(bakeScale(9)).toBe(4);
    expect(bakeScale(0)).toBe(2);
    expect(bakeScale(-1)).toBe(2);
    expect(bakeScale(Number.POSITIVE_INFINITY)).toBe(2);
  });
});

describe('readPictureHeader', () => {
  const png = (w: number, h: number, colorType: number, extra: number[][] = []) => {
    const b = new Uint8Array(33 + extra.reduce((n, c) => n + c.length, 0));
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const dv = new DataView(b.buffer);
    dv.setUint32(16, w);
    dv.setUint32(20, h);
    b[24] = 8;
    b[25] = colorType;
    let o = 33;
    for (const c of extra) {
      b.set(c, o);
      o += c.length;
    }
    return b;
  };

  it("reads a PNG's size and colour type: 2 is opaque, 6 has alpha", () => {
    expect(readPictureHeader(png(3840, 2160, 2))).toMatchObject({
      format: 'png',
      width: 3840,
      height: 2160,
      alpha: false,
      colorType: 2,
    });
    expect(readPictureHeader(png(1920, 1080, 6))).toMatchObject({
      format: 'png',
      width: 1920,
      height: 1080,
      alpha: true,
      colorType: 6,
    });
  });

  it('a tRNS chunk before the data makes an RGB PNG transparent, as the hub reads it', () => {
    const trns = [0, 0, 0, 6, 0x74, 0x52, 0x4e, 0x53, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(readPictureHeader(png(10, 10, 2, [trns]))?.alpha).toBe(true);
  });

  it('reads the three WebP forms and refuses anything else', () => {
    const riff = (chunk: string, body: number[]) => {
      const b = new Uint8Array(30);
      b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
      b.set(
        [...chunk].map((c) => c.charCodeAt(0)),
        12,
      );
      b.set(body, 20);
      return b;
    };
    const x = riff('VP8X', [0x10, 0, 0, 0, 0x7f, 0x02, 0, 0x67, 0x01, 0]);
    expect(readPictureHeader(x)).toMatchObject({ format: 'webp', width: 640, height: 360, alpha: true });
    const lossy = riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0x68, 0x01]);
    expect(readPictureHeader(lossy)).toMatchObject({ format: 'webp', width: 640, height: 360, alpha: false });
    expect(readPictureHeader(new Uint8Array(40))).toBeUndefined();
    expect(readPictureHeader(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe('tileOrigins: the tiles the round trip compares', () => {
  it("64 tiles at 3840x2160: the corners, a 9x6 grid and six from the file's length, all inside", () => {
    const t = tileOrigins(3840, 2160, 123_456);
    expect(t).toHaveLength(64);
    expect(t.slice(0, 4)).toEqual([
      { x: 0, y: 0 },
      { x: 3712, y: 0 },
      { x: 0, y: 2032 },
      { x: 3712, y: 2032 },
    ]);
    for (const { x, y } of t) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(3712);
      expect(y).toBeLessThanOrEqual(2032);
    }
    expect(tileOrigins(3840, 2160, 123_456)).toEqual(t);
    expect(tileOrigins(3840, 2160, 99)).not.toEqual(t);
  });

  it('a canvas smaller than a tile still gets tiles inside it', () => {
    for (const { x, y } of tileOrigins(50, 40, 7)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + 40).toBeLessThanOrEqual(50);
      expect(y + 40).toBeLessThanOrEqual(40);
    }
  });
});

/** An environment that passes the first checks without a canvas: a bake resolver, installed, and a blank face that says ready. */
function stubEnv(): BakeEnv {
  const blank = { family: '"o-blank-00000000"', ready: true, loaded: Promise.resolve(true) };
  const fonts = new FontResolver(undefined, { profile: 'bake', blank: { family: blank.family } });
  installFontEnv(fonts);
  return { fonts, coverage: {} as never, blank, ready: async () => true, dispose: () => undefined };
}

const pictures = { acquire: async () => ({ lookup: () => undefined, release: () => undefined }) };
const reason = (r: Awaited<ReturnType<typeof bakeSlide>>): BakeReason | 'ok' =>
  r.ok ? 'ok' : (r as BakeFailure).reason;

afterEach(() => {
  installFontEnv(LEGACY_FONT_ENV);
  clearUnits();
  clearGeomFiles();
});

describe('what a bake refuses before it draws anything', () => {
  it("profile: the installed font environment is not the env's bake resolver", async () => {
    const env = stubEnv();
    installFontEnv(LEGACY_FONT_ENV);
    const r = await bakeSlide(slideOf([square(0)]), { env, pictures });
    expect(reason(r)).toBe('profile');
    installFontEnv(new FontResolver());
    expect(reason(await bakeSlide(slideOf([square(0)]), { env, pictures }))).toBe('profile');
  });

  it('profile: the coverage probe is not ready', async () => {
    const env = stubEnv();
    const r = await bakeSlide(slideOf([square(0)]), {
      env: { ...env, blank: { ...env.blank, ready: false } },
      pictures,
    });
    expect(reason(r)).toBe('profile');
    expect((r as BakeFailure).detail).toMatch(/probe/);
  });

  it('busy: a second call while one is in flight is refused at once, and the next one is not', async () => {
    const env = stubEnv();
    const slide = slideOf([square(0)]);
    const first = bakeSlide(slide, { env, pictures });
    const second = bakeSlide(slide, { env, pictures });
    expect(reason(await second)).toBe('busy');
    await first;
    // no canvas in node: the single flight is released and the next call reaches that point
    expect(reason(await bakeSlide(slide, { env, pictures }))).toBe('canvas');
  });

  it('cut: a raw slide of 20,001 objects', async () => {
    const r = await bakeSlide(slideOf(squares(20_001)), { env: stubEnv(), pictures });
    expect(reason(r)).toBe('cut');
    expect((r as BakeFailure).detail).toMatch(/20001/);
    expect(r.stats.objects).toBe(0);
  });

  it('animated: a playing picture, and a text with a hidden paragraph; both allowed when in the live set', async () => {
    const env = stubEnv();
    const playing = slideOf([
      square(0),
      { ...picture('vid', 'm', { x: 0, y: 0, w: 100, h: 100 }), play: { mediaId: 'clip' } as never },
    ]);
    expect(reason(await bakeSlide(playing, { env, pictures }))).toBe('animated');
    const hidden = slideOf([{ ...textBox('t', 'one\ntwo'), paras: [{}, { hidden: true }] as never }]);
    const r = await bakeSlide(hidden, { env, pictures });
    expect(reason(r)).toBe('animated');
    expect((r as BakeFailure).detail).toMatch(/hidden paragraph \(t\)/);
    // an animated object whose id is in the live set is not drawn and not refused (the hook of Q24.a): the bake goes on
    // to the first thing that needs a canvas
    expect(reason(await bakeSlide(hidden, { env, pictures, live: ['t'] }))).toBe('canvas');
    expect(
      reason(
        await bakeSlide(
          { ...hidden, prerender: { why: 'count', file: 'f', live: ['t'], uses: [] } as never } as Slide,
          { env, pictures },
        ),
      ),
    ).toBe('canvas');
    expect(reason(await bakeSlide(playing, { env, pictures, live: ['vid'] }))).toBe('canvas');
  });

  it('files: an object waits for a geometry file that is not read yet', async () => {
    const slide = slideOf([
      square(0),
      { ...square(1), id: 'g', geom: { ref: 'b'.repeat(64), w: 10, h: 10 } as never },
    ]);
    const r = await bakeSlide(slide, { env: stubEnv(), pictures });
    expect(reason(r)).toBe('files');
  });

  it('every refusal is a plain result with at most 200 characters of text, never a throw', async () => {
    const env = stubEnv();
    for (const slide of [
      slideOf(squares(20_001)),
      slideOf([]),
      {} as Slide,
      { id: 's', objects: 'no' } as never as Slide,
    ]) {
      const r = await bakeSlide(slide, { env, pictures });
      expect(r.ok).toBe(false);
      expect(failureText(r as BakeFailure).length).toBeLessThanOrEqual(200);
    }
  });
});
