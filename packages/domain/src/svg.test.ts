import { describe, expect, it } from 'vitest';
import {
  isSvgMime,
  looksLikeSvg,
  pngSize,
  SVG_RASTER,
  svgIntrinsicSize,
  svgRasterProblem,
  svgRasterSize,
  svgRasterSizeFor,
} from './svg.ts';
import { budgetMs } from './timing.test-util.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const svg = (attrs: string, body = '') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b[24] = 8;
  b[25] = 6;
  return b;
}

describe('svg media helpers', () => {
  it('recognises SVG mimes and heads as the hub sniffs them', () => {
    expect(isSvgMime('image/svg+xml')).toBe(true);
    expect(isSvgMime('Image/SVG+XML; charset=utf-8')).toBe(true);
    expect(isSvgMime('image/png')).toBe(false);
    expect(isSvgMime(undefined)).toBe(false);
    expect(looksLikeSvg(enc('<?xml version="1.0"?>\n<svg width="1">'))).toBe(true);
    expect(looksLikeSvg(enc(`<!-- ${'x'.repeat(600)} --><svg>`))).toBe(false);
    expect(looksLikeSvg(enc('<svgx>'))).toBe(false);
    expect(looksLikeSvg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });

  it('reads the root element size, not a child stroke-width or a percentage', () => {
    expect(svgIntrinsicSize(svg('width="200" height="80"'))).toEqual({ width: 200, height: 80, ratio: 2.5 });
    // Review R13: the old regex took `stroke-width=` or `100%` as the width.
    expect(svgIntrinsicSize(svg('stroke-width="4" viewBox="0 0 1600 900"'))).toEqual({
      viewBox: { width: 1600, height: 900 },
      ratio: 16 / 9,
    });
    expect(svgIntrinsicSize(svg('width="100%" height="100%" viewBox="0 0 16 9"'))).toEqual({
      viewBox: { width: 16, height: 9 },
      ratio: 16 / 9,
    });
    expect(svgIntrinsicSize(svg('viewBox="0,0,1920,1080"', '<rect width="5" height="5"/>'))).toEqual({
      viewBox: { width: 1920, height: 1080 },
      ratio: 1920 / 1080,
    });
    expect(svgIntrinsicSize(svg('width="400" viewBox="0 0 16 9"'))).toEqual({
      width: 400,
      height: 225,
      viewBox: { width: 16, height: 9 },
      ratio: 16 / 9,
    });
    expect(svgIntrinsicSize(svg('viewBox="0 0 0 9"'))).toEqual({});
    expect(svgIntrinsicSize(svg('width="10cm" height="5cm"'))).toMatchObject({ ratio: 2 });
    expect(svgIntrinsicSize(svg('width="10cm" height="5cm"')).width).toBeCloseTo(377.95, 1);
    expect(svgIntrinsicSize(svg('width="10em" height="5em"'))).toEqual({});
    expect(svgIntrinsicSize(svg(''))).toEqual({});
    expect(svgIntrinsicSize('<html><body>no svg</body></html>')).toEqual({});
  });

  it('skips comments, the declaration and quoted > before the root element', () => {
    const t = `<?xml version="1.0"?>\n<!-- <svg width="1" height="1"> -->\n<!DOCTYPE svg>\n<svg data-x="a>b" width='640' height='360'>`;
    expect(svgIntrinsicSize(t)).toEqual({ width: 640, height: 360, ratio: 640 / 360 });
    expect(
      svgIntrinsicSize('<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="3" height="1"/>'),
    ).toEqual({
      width: 3,
      height: 1,
      ratio: 3,
    });
  });

  it('rasterises at least 1920 px on the longer side, at most 3840 wide and 16.7 MP', () => {
    expect(svgRasterSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(svgRasterSize(200, 80)).toEqual({ width: 1920, height: 768 });
    expect(svgRasterSize(80, 200)).toEqual({ width: 768, height: 1920 });
    expect(svgRasterSize(3840, 2160)).toEqual({ width: 3840, height: 2160 });
    expect(svgRasterSize(7680, 4320)).toEqual({ width: 3840, height: 2160 });
    const square = svgRasterSize(5000, 5000);
    expect(square.width * square.height).toBeLessThanOrEqual(SVG_RASTER.maxPixels);
    expect(square).toEqual({ width: 3840, height: 3840 });
    const tall = svgRasterSize(100, 100_000);
    expect(tall.height).toBeLessThanOrEqual(SVG_RASTER.maxSide);
    expect(tall.width).toBeGreaterThanOrEqual(1);
    expect(svgRasterSize(Number.NaN, 5)).toEqual({ width: 1920, height: 1080 });
    expect(svgRasterSize(-1, 0)).toEqual({ width: 1920, height: 1080 });
  });

  it('sizes from the declaration first, then the viewBox, then the browser natural size', () => {
    const vb = (w: number, h: number) => ({ viewBox: { width: w, height: h }, ratio: w / h });
    expect(svgRasterSizeFor(vb(160, 90), { width: 267, height: 150 })).toEqual({ width: 1920, height: 1080 });
    expect(svgRasterSizeFor(vb(9, 16))).toEqual({ width: 1080, height: 1920 });
    expect(svgRasterSizeFor(vb(3840, 2160))).toEqual({ width: 3840, height: 2160 });
    expect(svgRasterSizeFor({ width: 200, height: 80, ratio: 2.5 }, { width: 1, height: 1 })).toEqual({
      width: 1920,
      height: 768,
    });
    expect(svgRasterSizeFor({}, { width: 300, height: 150 })).toEqual({ width: 1920, height: 960 });
    expect(svgRasterSizeFor({})).toEqual({ width: 1920, height: 1080 });
  });

  it('reads a PNG header and refuses anything else', () => {
    expect(pngSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(pngSize(png(0, 1080))).toBeUndefined();
    expect(pngSize(enc('<svg width="1">'))).toBeUndefined();
    const bad = png(10, 10);
    bad[15] = 0x41; // not IHDR
    expect(pngSize(bad)).toBeUndefined();
    expect(pngSize(new Uint8Array(4))).toBeUndefined();
  });

  it('accepts a raster of the declared shape within the caps', () => {
    expect(svgRasterProblem({ ratio: 16 / 9 }, { width: 1920, height: 1080 })).toBeUndefined();
    expect(svgRasterProblem({ ratio: 16 / 9 }, { width: 1920, height: 1078 })).toBeUndefined();
    expect(svgRasterProblem({}, { width: 1920, height: 300 })).toBeUndefined();
    expect(svgRasterProblem({ ratio: 16 / 9 }, { width: 1080, height: 1920 })).toMatch(/shape/);
    expect(svgRasterProblem({}, { width: 3841, height: 10 })).toMatch(/limit/);
    expect(svgRasterProblem({}, { width: 3840, height: 16384 })).toMatch(/limit/);
    expect(svgRasterProblem({}, { width: 0, height: 10 })).toMatch(/no size/);
  });

  it('never throws and stays fast on hostile text', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const parts = [
      '<svg',
      ' width="',
      '"',
      "'",
      '>',
      '<!--',
      '-->',
      'viewBox="',
      '1e309',
      '-3',
      ',',
      ' ',
      '<',
    ];
    const t0 = Date.now();
    for (let i = 0; i < 400; i++) {
      let s = '';
      for (let k = 0; k < 200; k++) s += parts[Math.floor(rnd() * parts.length)];
      const r = svgIntrinsicSize(s);
      for (const v of [r.width, r.height, r.ratio])
        if (v !== undefined) expect(Number.isFinite(v) && v > 0).toBe(true);
      const size = svgRasterSizeFor(r);
      expect(size.width * size.height).toBeLessThanOrEqual(SVG_RASTER.maxPixels);
    }
    // A huge unterminated tag and a megabyte of quotes are cut at the head.
    svgIntrinsicSize(`<svg ${'a="'.repeat(300_000)}`);
    svgIntrinsicSize(`<svg ${"x='>' ".repeat(200_000)}`);
    svgIntrinsicSize(`<!--${'-'.repeat(1_000_000)}`);
    // Many unterminated starts: a backtracking tag pattern would scan the rest of the head from each one.
    for (const s of [
      '<svg '.repeat(14_000),
      '<svg a '.repeat(10_000),
      '<!--'.repeat(20_000),
      '<?'.repeat(30_000),
    ])
      expect(svgIntrinsicSize(s)).toEqual({});
    expect(Date.now() - t0).toBeLessThan(budgetMs(2000));
  });
});
