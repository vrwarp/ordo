import type { Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { makePng } from './png.ts';
import { SSIM_HEIGHT, SSIM_WIDTH, computeSsim, scoreSlideImages } from './score.ts';

describe('computeSsim', () => {
  it('exports canonical SSIM_WIDTH and SSIM_HEIGHT constants', () => {
    expect(SSIM_WIDTH).toBe(960);
    expect(SSIM_HEIGHT).toBe(540);
  });

  it('returns 1.0 for identical images at 1920x1080', () => {
    const img = makePng(1920, 1080, (x, y) => [(x * 7) % 256, (y * 13) % 256, (x + y) % 256, 255]);
    const score = computeSsim(img, img);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('returns low score for completely different images (white vs black)', () => {
    const white = makePng(1920, 1080, () => [255, 255, 255, 255]);
    const black = makePng(1920, 1080, () => [0, 0, 0, 255]);
    const score = computeSsim(white, black);
    expect(score).toBeLessThan(0.01);
  });

  it('supports smaller images natively', () => {
    const img1 = makePng(64, 64, (x, y) => [(x * 3) % 256, (y * 5) % 256, 128, 255]);
    const img2 = makePng(64, 64, (x, y) => [(x * 3) % 256, (y * 5) % 256, 128, 255]);
    expect(computeSsim(img1, img2)).toBeCloseTo(1.0, 5);
  });
});

describe('scoreSlideImages', () => {
  const defaultStyle = {
    fontFamily: 'sans-serif',
    fontWeight: 400,
    fontStyle: 'normal' as const,
    fontSizePx: 20,
    color: { r: 255, g: 255, b: 255, a: 1 },
    align: 'center' as const,
    valign: 'middle' as const,
    lineHeight: 1.2,
    letterSpacing: 0,
    padding: 0,
    transform: 'none' as const,
  };

  const dummySlide = (objects: Slide['objects'] = []): Slide => ({
    id: 'test-slide-id',
    objects,
  });

  it('evaluates identical opaque images with ssim 1.0 and zero MAEs', () => {
    const img = makePng(100, 100, (x, y) => [(x * 2) % 256, (y * 3) % 256, 50, 255]);
    const slide = dummySlide([
      {
        id: 'obj-1',
        type: 'text',
        box: { x: 10, y: 10, w: 30, h: 30, rotation: 0 },
        text: 'hello',
        style: defaultStyle,
        opacity: 1,
      },
    ]);

    const res = scoreSlideImages({
      n: 1,
      ref: img,
      cand: img,
      slide,
      features: [],
      refPngPath: '/ref/1.png',
      ordoPngPath: '/ordo/1.png',
    });

    expect(res.ssim).toBeCloseTo(1.0, 5);
    expect(res.transparentRef).toBe(false);
    expect(res.ssimBlack).toBeUndefined();
    expect(res.ssimWhite).toBeUndefined();
    expect(res.overallMae).toBe(0);
    expect(res.backgroundMae).toBe(0);
    expect(res.alphaMae).toBe(0);
    expect(res.boxMaes).toHaveLength(1);
    expect(res.boxMaes[0]!.mae).toBe(0);
  });

  it('fails white-text-on-transparent vs empty-transparent on black plate', () => {
    // 200x200 canvas with white box in center
    const ref = makePng(200, 200, (x, y) => {
      if (x >= 50 && x < 150 && y >= 50 && y < 150) {
        return [255, 255, 255, 255];
      }
      return [0, 0, 0, 0];
    });

    // cand is completely transparent
    const cand = makePng(200, 200, () => [0, 0, 0, 0]);

    const res = scoreSlideImages({
      n: 1,
      ref,
      cand,
      slide: dummySlide(),
      features: ['transparentPlate'],
      refPngPath: '/ref/1.png',
      ordoPngPath: '/ordo/1.png',
    });

    expect(res.transparentRef).toBe(true);
    expect(res.ssimBlack).toBeDefined();
    expect(res.ssimWhite).toBeDefined();

    // On white plate, white text over white plate is identical to empty transparent over white plate
    expect(res.ssimWhite!).toBeCloseTo(1.0, 4);

    // On black plate, white text stands out vs black, so ssimBlack is much lower
    expect(res.ssimBlack!).toBeLessThan(0.85);

    // Final SSIM is min(ssimBlack, ssimWhite)
    expect(res.ssim).toBe(res.ssimBlack);
    expect(res.overallMae).toBeGreaterThan(0);
  });

  it('fails black-text-on-transparent vs empty-transparent on white plate', () => {
    // 200x200 canvas with black box in center
    const ref = makePng(200, 200, (x, y) => {
      if (x >= 50 && x < 150 && y >= 50 && y < 150) {
        return [0, 0, 0, 255];
      }
      return [0, 0, 0, 0];
    });

    // cand is completely transparent
    const cand = makePng(200, 200, () => [0, 0, 0, 0]);

    const res = scoreSlideImages({
      n: 2,
      ref,
      cand,
      slide: dummySlide(),
      features: ['transparentPlate'],
      refPngPath: '/ref/2.png',
      ordoPngPath: '/ordo/2.png',
    });

    expect(res.transparentRef).toBe(true);
    // On black plate, black text over black plate matches empty transparent over black plate
    expect(res.ssimBlack!).toBeCloseTo(1.0, 4);

    // On white plate, black text stands out against white plate, so ssimWhite drops
    expect(res.ssimWhite!).toBeLessThan(0.85);

    // Final SSIM is min(ssimBlack, ssimWhite)
    expect(res.ssim).toBe(res.ssimWhite);
  });

  it('localizes boxMae cleanly to modified objects without polluting backgroundMae', () => {
    const W = 100;
    const H = 100;

    const ref = makePng(W, H, () => [100, 100, 100, 255]);
    // cand only differs inside obj-1's box [10..30, 10..30]
    const cand = makePng(W, H, (x, y) => {
      if (x >= 10 && x < 30 && y >= 10 && y < 30) {
        return [200, 200, 200, 255];
      }
      return [100, 100, 100, 255];
    });

    const slide = dummySlide([
      {
        id: 'obj-1',
        type: 'text',
        box: { x: 10, y: 10, w: 20, h: 20, rotation: 0 },
        text: 'lyrics',
        style: { ...defaultStyle, fontSizePx: 16 },
        opacity: 1,
      },
      {
        id: 'obj-2',
        type: 'shape',
        box: { x: 60, y: 60, w: 20, h: 20, rotation: 0 },
        shape: 'rect',
        fill: { r: 255, g: 0, b: 0, a: 1 },
        opacity: 1,
        radius: 0,
      },
    ]);

    const res = scoreSlideImages({
      n: 3,
      ref,
      cand,
      slide,
      features: [],
      refPngPath: '/ref/3.png',
      ordoPngPath: '/ordo/3.png',
    });

    expect(res.boxMaes).toHaveLength(2);
    expect(res.boxMaes[0]!.objectId).toBe('obj-1');
    expect(res.boxMaes[0]!.mae).toBeGreaterThan(0.05);

    expect(res.boxMaes[1]!.objectId).toBe('obj-2');
    expect(res.boxMaes[1]!.mae).toBe(0);

    expect(res.backgroundMae).toBe(0);
    expect(res.overallMae).toBeGreaterThan(0);
  });
});
