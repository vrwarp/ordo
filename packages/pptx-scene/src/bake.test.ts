import { describe, expect, it } from 'vitest';
import {
  applyBake,
  BAKE_LIMITS,
  type BakeRaster,
  bakeKey,
  bakeOf,
  hasAlpha,
  luminance,
  recolorRaster,
  tileBakeOf,
  tileSourceSize,
} from './bake.ts';
import { BAKE_PREFIX, convertDeck, emitSlides, parseDeck } from './index.ts';
import type { PictureFill } from './ir.ts';
import { buildDeck, imageRel, pic, pngHeader, sp } from './test-util.ts';

const IN = 914_400;

/** A raster of `w` x `h` pixels, every pixel `px(x, y)`. */
function raster(w: number, h: number, px: (x: number, y: number) => number[]): BakeRaster {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
const at = (r: BakeRaster, x: number, y: number) => [
  ...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4),
];

describe('colour effects (LibreOffice arithmetic)', () => {
  it('measures luminance as LibreOffice does', () => {
    expect(luminance(255, 255, 255)).toBe(255);
    expect(luminance(255, 0, 0)).toBe(75);
    expect(luminance(0, 255, 0)).toBe(150);
    expect(luminance(0, 0, 255)).toBe(28);
  });

  it('greys, thresholds and maps the luminance between two colours, keeping alpha', () => {
    const src = () => raster(2, 1, (x) => (x ? [255, 0, 0, 128] : [255, 255, 255, 255]));
    const g = src();
    recolorRaster(g, [{ kind: 'grayscale' }], 0);
    expect(at(g, 1, 0)).toEqual([75, 75, 75, 128]);
    const b = src();
    recolorRaster(b, [{ kind: 'biLevel', threshold: 0.5 }], 0);
    expect(at(b, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(at(b, 1, 0)).toEqual([0, 0, 0, 128]); // 75 < 128
    const t = src();
    recolorRaster(t, [{ kind: 'biLevel', threshold: 0.25 }], 0);
    expect(at(t, 1, 0)).toEqual([255, 255, 255, 128]); // 75 >= 63
    const d = src();
    recolorRaster(
      d,
      [{ kind: 'duotone', dark: { r: 0, g: 0, b: 100, a: 1 }, light: { r: 200, g: 255, b: 0, a: 1 } }],
      0,
    );
    expect(at(d, 0, 0)).toEqual([200, 255, 0, 255]); // white → the light colour
    // luminance 75: 0·180/255 + 200·75/255, 0 + 255·75/255, 100·180/255 + 0, each rounded down
    expect(at(d, 1, 0)).toEqual([58, 75, 70, 128]);
  });

  it('changes a colour within the tolerance, alpha included', () => {
    const r = raster(
      3,
      1,
      (x) =>
        [
          [250, 250, 250, 255],
          [240, 240, 240, 255],
          [0, 0, 0, 255],
        ][x]!,
    );
    recolorRaster(
      r,
      [{ kind: 'clrChange', from: { r: 255, g: 255, b: 255, a: 1 }, to: { r: 255, g: 255, b: 255, a: 0 } }],
      9,
    );
    expect(at(r, 0, 0)).toEqual([255, 255, 255, 0]);
    expect(at(r, 1, 0)).toEqual([240, 240, 240, 255]); // 15 away: kept
    expect(hasAlpha(r)).toBe(true);
  });

  it('applies brightness and contrast as PowerPoint does (half the brightness on each side)', () => {
    const r = raster(
      3,
      1,
      (x) =>
        [
          [0, 128, 255, 255],
          [64, 64, 64, 255],
          [200, 200, 200, 255],
        ][x]!,
    );
    recolorRaster(r, [{ kind: 'lum', bright: 0.2, contrast: 0 }], 0);
    expect(at(r, 0, 0)).toEqual([51, 179, 255, 255]);
    const c = raster(1, 1, () => [64, 128, 192, 255]);
    recolorRaster(c, [{ kind: 'lum', bright: 0, contrast: 0.5 }], 0);
    // slope 128 / (128 − 63.5): 64 → 128 − 64·1.9845 = 1, 192 → 255
    expect(at(c, 0, 0)).toEqual([1, 128, 255, 255]);
  });

  it('applies effects in document order', () => {
    const a = raster(1, 1, () => [255, 0, 0, 255]);
    recolorRaster(a, [{ kind: 'grayscale' }, { kind: 'biLevel', threshold: 0.2 }], 0);
    expect(at(a, 0, 0)).toEqual([255, 255, 255, 255]);
    const b = raster(1, 1, () => [255, 0, 0, 255]);
    recolorRaster(b, [{ kind: 'biLevel', threshold: 0.5 }, { kind: 'grayscale' }], 0);
    expect(at(b, 0, 0)).toEqual([0, 0, 0, 255]);
  });
});

describe('tiles', () => {
  const fill = (o: Partial<PictureFill> = {}): PictureFill => ({
    part: 'ppt/media/t.png',
    tile: { tx: 0, ty: 0, sx: 1, sy: 1, flip: 'none', algn: 'tl' },
    px: { w: 96, h: 48 },
    ...o,
  });

  it('sizes a tile by the picture at its resolution (96 dpi when the header states none)', () => {
    // 96 x 48 px at 96 dpi = 1 x 0.5 in, over a 4 x 2 in box.
    expect(tileBakeOf(fill(), 4 * IN, 2 * IN)).toEqual({
      aspect: 0.5,
      w: 0.25,
      h: 0.25,
      x: 0,
      y: 0,
      flip: 'none',
    });
    const hi = tileBakeOf(fill({ px: { w: 96, h: 48, dpi: { x: 192, y: 192 } } }), 4 * IN, 2 * IN)!;
    expect(hi.w).toBeCloseTo(0.125, 9);
    const scaled = tileBakeOf(
      fill({ tile: { tx: IN, ty: 0, sx: 2, sy: 0.5, flip: 'xy', algn: 'ctr' } }),
      4 * IN,
      2 * IN,
    )!;
    expect(scaled.w).toBeCloseTo(0.5, 9);
    expect(scaled.h).toBeCloseTo(0.125, 9);
    // centred: the tile's centre on the box's, then 1 in (a quarter of the box) to the right
    expect(scaled.x).toBeCloseTo(0.25 + 0.25, 9);
    expect(scaled.flip).toBe('xy');
  });

  it('is not baked without the picture size or with a degenerate tile', () => {
    expect(tileBakeOf(fill({ px: undefined }), IN, IN)).toBeUndefined();
    expect(
      tileBakeOf(fill({ tile: { tx: 0, ty: 0, sx: 0, sy: 1, flip: 'none', algn: 'tl' } }), IN, IN),
    ).toBeUndefined();
    expect(bakeOf(fill({ px: undefined }), { w: IN, h: IN })).toBeUndefined();
  });

  it('repeats the picture over the output, mirroring every other tile when flipped', () => {
    const src = raster(2, 1, (x) => (x ? [0, 0, 255, 255] : [255, 0, 0, 255])); // red | blue
    const out = applyBake(
      src,
      { tile: { aspect: 1, w: 0.25, h: 0.5, x: 0, y: 0, flip: 'none' } },
      { width: 8, height: 2 },
    );
    expect([0, 1, 2, 3, 4].map((x) => at(out, x, 0)[0])).toEqual([255, 0, 255, 0, 255]);
    const flipped = applyBake(
      raster(2, 1, (x) => (x ? [0, 0, 255, 255] : [255, 0, 0, 255])),
      { tile: { aspect: 1, w: 0.25, h: 0.5, x: 0, y: 0, flip: 'x' } },
      { width: 8, height: 2 },
    );
    // tile 0: red blue; tile 1 mirrored: blue red
    expect([0, 1, 2, 3].map((x) => at(flipped, x, 0)[0])).toEqual([255, 0, 0, 255]);
  });

  it('offsets the grid and keeps it repeating before its first tile', () => {
    const src = raster(2, 1, (x) => (x ? [0, 0, 255, 255] : [255, 0, 0, 255]));
    const out = applyBake(
      src,
      { tile: { aspect: 1, w: 0.5, h: 1, x: 0.25, y: 0, flip: 'none' } },
      { width: 4, height: 1 },
    );
    // the tile starts at x = 1: [blue | red blue | red]
    expect([0, 1, 2, 3].map((x) => at(out, x, 0)[2])).toEqual([255, 0, 255, 0]);
  });

  it('decodes a tile at the size it is shown, within the limits', () => {
    const t = { aspect: 1, w: 0.25, h: 0.5, x: 0, y: 0, flip: 'none' as const };
    expect(tileSourceSize(t, { width: 800, height: 400 })).toEqual({ width: 200, height: 200 });
    expect(tileSourceSize({ ...t, crop: { l: 0.5, t: 0, r: 0, b: 0 } }, { width: 800, height: 400 })).toEqual(
      {
        width: 400,
        height: 200,
      },
    );
    const huge = tileSourceSize({ ...t, w: 100, h: 100 }, { width: 8000, height: 8000 });
    expect(huge.width * huge.height).toBeLessThanOrEqual(BAKE_LIMITS.pixels);
  });

  it('refuses rasters past the limits', () => {
    const src = raster(1, 1, () => [0, 0, 0, 255]);
    expect(() =>
      applyBake(
        src,
        { tile: { aspect: 1, w: 1, h: 1, x: 0, y: 0, flip: 'none' } },
        { width: 9000, height: 1 },
      ),
    ).toThrow(/larger/);
    expect(() =>
      applyBake({ width: 2, height: 2, data: new Uint8Array(4) }, { recolor: [{ kind: 'grayscale' }] }),
    ).toThrow(/too few/);
  });
});

describe('emitted bakes (EmitResult.media)', () => {
  const opaque = pngHeader(96, 48, true);

  it('gives a recoloured picture its own placeholder, listed with its recipe', () => {
    const parts = buildDeck({
      slides: [
        {
          rels: [imageRel('rId2', 'image1.png')],
          shapes:
            pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2', blip: '<a:grayscl/>' }) +
            pic({ id: 3, x: IN, y: 0, cx: IN, cy: IN, rId: 'rId2', blip: '<a:grayscl/>' }) +
            pic({ id: 4, x: 2 * IN, y: 0, cx: IN, cy: IN, rId: 'rId2', srcRect: 'l="10000"' }),
        },
      ],
      media: { 'ppt/media/image1.png': opaque },
    });
    const out = emitSlides(parseDeck(parts));
    const imgs = out.slides[0]!.slide.objects.filter((o) => o.type === 'image');
    expect(imgs.map((o) => o.type === 'image' && o.mediaId)).toEqual([
      `${BAKE_PREFIX}1`,
      `${BAKE_PREFIX}1`,
      'pptxmedia:1',
    ]);
    expect(out.media).toEqual([
      { id: 'pptxmedia:1', part: 'ppt/media/image1.png' },
      { id: `${BAKE_PREFIX}1`, part: 'ppt/media/image1.png', bake: { recolor: [{ kind: 'grayscale' }] } },
    ]);
    expect(out.slides[0]!.classification.class).toBe('native');
    expect(out.slides[0]!.notes.join(' ')).not.toMatch(/recolour|effects/);
    expect(bakeKey('ppt/media/image1.png', { recolor: [{ kind: 'grayscale' }] })).toBe(
      '["ppt/media/image1.png",{"recolor":[{"kind":"grayscale"}]}]',
    );
  });

  it('numbers bakes across the slides of a batch, each part and recipe once (convertDeck)', () => {
    const slide = (blip: string) => ({
      rels: [imageRel('rId2', 'image1.png')],
      shapes: pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2', blip }),
    });
    const parts = buildDeck({
      slides: [slide('<a:grayscl/>'), slide('<a:biLevel thresh="50000"/>'), slide('<a:grayscl/>')],
      media: { 'ppt/media/image1.png': opaque },
    });
    const out = convertDeck(parts);
    const ids = out.slides.map((s) => s.slide.objects.find((o) => o.type === 'image')?.mediaId);
    expect(ids).toEqual([`${BAKE_PREFIX}1`, `${BAKE_PREFIX}2`, `${BAKE_PREFIX}1`]);
    expect(out.media.map((m) => m.id)).toEqual([`${BAKE_PREFIX}1`, `${BAKE_PREFIX}2`]);
    expect(out.media).toEqual(emitSlides(parseDeck(parts)).media);
  });

  it('bakes a tiled shape fill over its whole box, uncropped', () => {
    const tiled =
      '<a:blipFill><a:blip r:embed="rId2"/><a:srcRect l="50000"/><a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/></a:blipFill>';
    const parts = buildDeck({
      slides: [
        {
          rels: [imageRel('rId2', 'image1.png')],
          shapes: sp({ id: 2, x: IN, y: IN, cx: 4 * IN, cy: 2 * IN, fill: tiled }),
        },
      ],
      media: { 'ppt/media/image1.png': opaque },
    });
    const out = emitSlides(parseDeck(parts));
    const img = out.slides[0]!.slide.objects.find((o) => o.type === 'image');
    expect(img?.type === 'image' && img.crop).toBeUndefined();
    expect(img?.box.w).toBeCloseTo(4 * (1920 / (12_192_000 / IN)), 6);
    const bake = out.media.find((m) => m.bake)?.bake;
    // half of the 96 px picture (48 x 48 px = 0.5 in) over a 4 x 2 in box
    expect(bake?.tile).toMatchObject({ aspect: 0.5, x: 0, y: 0, crop: { l: 0.5, t: 0, r: 0, b: 0 } });
    expect(bake?.tile?.w).toBeCloseTo(0.125, 9);
    expect(bake?.tile?.h).toBeCloseTo(0.25, 9);
  });

  it('bakes a tiled background as a picture over the slide', () => {
    const parts = buildDeck({
      slides: [
        {
          rels: [imageRel('rId2', 'image1.png')],
          bg: '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId2"/><a:tile tx="0" ty="0" sx="50000" sy="50000" flip="none" algn="tl"/></a:blipFill><a:effectLst/></p:bgPr></p:bg>',
        },
      ],
      media: { 'ppt/media/image1.png': opaque },
    });
    const out = emitSlides(parseDeck(parts));
    const s = out.slides[0]!;
    expect(s.slide.backgroundMediaId).toBeUndefined();
    const img = s.slide.objects.find((o) => o.type === 'image');
    expect(img?.type === 'image' && img.mediaId).toBe(`${BAKE_PREFIX}1`);
    expect(out.media[0]?.bake?.tile?.aspect).toBeCloseTo(6_858_000 / 12_192_000, 9);
    expect(s.notes.join(' ')).not.toMatch(/stretched/);
  });

  it('leaves a tile of unknown size stretched and a metafile unbaked', () => {
    const parts = buildDeck({
      slides: [
        {
          rels: [imageRel('rId2', 'image1.png'), imageRel('rId3', 'image2.emf')],
          shapes:
            sp({
              id: 2,
              x: 0,
              y: 0,
              cx: IN,
              cy: IN,
              fill: '<a:blipFill><a:blip r:embed="rId2"/><a:tile/></a:blipFill>',
            }) + pic({ id: 3, x: IN, y: 0, cx: IN, cy: IN, rId: 'rId3', blip: '<a:grayscl/>' }),
        },
      ],
      media: { 'ppt/media/image1.png': new Uint8Array(0), 'ppt/media/image2.emf': new Uint8Array(4) },
    });
    const out = emitSlides(parseDeck(parts));
    expect(out.media.some((m) => m.bake)).toBe(false);
    expect(out.slides[0]!.metafiles?.[0]?.object.mediaId).toBe('pptxmedia:metafile');
  });
});
