import { describe, expect, it } from 'vitest';
import type { Box, ImageCrop, SlideObject } from '@ordo/domain';
import { drawImageFit, drawObject } from './text2d.ts';

/** A 2D context that records the calls drawImageFit makes. */
function recorder() {
  const calls: { op: string; args: number[] }[] = [];
  const rec =
    (op: string) =>
    (...args: unknown[]) =>
      calls.push({ op, args: args.filter((a): a is number => typeof a === 'number') });
  const ctx = {
    globalAlpha: 1,
    save: rec('save'),
    restore: rec('restore'),
    beginPath: rec('beginPath'),
    rect: rec('rect'),
    roundRect: rec('roundRect'),
    clip: rec('clip'),
    translate: rec('translate'),
    rotate: rec('rotate'),
    drawImage: rec('drawImage'),
  } as unknown as CanvasRenderingContext2D;
  const draws = () => calls.filter((c) => c.op === 'drawImage').map((c) => c.args);
  return { ctx, calls, draws };
}

const img = { width: 800, height: 600 } as unknown as CanvasImageSource;
const box: Box = { x: 100, y: 50, w: 400, h: 300, rotation: 0 };

function close(got: number[] | undefined, want: number[]): void {
  expect(got).toHaveLength(want.length);
  for (let i = 0; i < want.length; i++) expect(got![i]).toBeCloseTo(want[i]!, 9);
}

describe('drawImageFit crop (design/27 §3.1)', () => {
  it('draws exactly as before without a crop, or with one that cuts nothing', () => {
    for (const crop of [undefined, { l: 0, t: 0, r: 0, b: 0 }]) {
      const r = recorder();
      drawImageFit(r.ctx, img, box, 2, 'contain', 1, 0, crop);
      expect(r.draws()).toEqual([[200, 100, 800, 600]]);
    }
  });

  it('draws the cropped source rect with the 9-argument drawImage, stretched over the box', () => {
    const r = recorder();
    drawImageFit(r.ctx, img, box, 1, 'stretch', 1, 0, { l: 0.25, t: 0.1, r: 0.25, b: 0.2 });
    close(r.draws()[0], [200, 60, 400, 420, 100, 50, 400, 300]);
  });

  it('fits the cropped rect, not the whole picture', () => {
    // The right half of the picture is 400x600: contain in 400x300 gives 200x300, centred.
    const r = recorder();
    drawImageFit(r.ctx, img, box, 1, 'contain', 1, 0, { l: 0.5, t: 0, r: 0, b: 0 });
    close(r.draws()[0], [400, 0, 400, 600, 200, 50, 200, 300]);
    // Cover scales it to 400x600 and the box clip keeps the middle.
    const c = recorder();
    drawImageFit(c.ctx, img, box, 1, 'cover', 1, 0, { l: 0.5, t: 0, r: 0, b: 0 });
    close(c.draws()[0], [400, 0, 400, 600, 100, -100, 400, 600]);
  });

  it('pads negative shares with transparency: only the picture part is drawn, smaller', () => {
    // 25 % padding left and right, 50 % on top: the cropped rect is 1200x900 picture px.
    const r = recorder();
    drawImageFit(r.ctx, img, box, 1, 'stretch', 1, 0, { l: -0.25, t: -0.5, r: -0.25, b: 0 });
    const k = 400 / 1200;
    close(r.draws()[0], [0, 0, 800, 600, 100 + 200 * k, 50 + 300 * (300 / 900), 800 * k, 600 * (300 / 900)]);
  });

  it('mixes padding and cutting on one axis', () => {
    // From x = -400 to 600: the drawn part is picture x 0-600, landing at 40 % of the box width.
    const r = recorder();
    drawImageFit(r.ctx, img, box, 1, 'stretch', 1, 0, { l: -0.5, t: 0, r: 0.25, b: 0 });
    close(r.draws()[0], [0, 0, 600, 600, 100 + 160, 50, 240, 300]);
  });

  it('draws nothing when the crop leaves nothing, or only padding', () => {
    for (const crop of [
      { l: 0.6, t: 0, r: 0.5, b: 0 },
      { l: 0, t: 1, r: 0, b: 0 },
      { l: -1, t: 0, r: 1, b: 0 },
    ]) {
      const r = recorder();
      drawImageFit(r.ctx, img, box, 1, 'stretch', 1, 0, crop);
      expect(r.draws()).toEqual([]);
    }
  });

  it('re-bounds a hostile crop instead of throwing', () => {
    const r = recorder();
    const crop = { l: Number.NaN, t: -1e9, r: Number.POSITIVE_INFINITY, b: 0.5 } as ImageCrop;
    drawImageFit(r.ctx, img, box, 1, 'stretch', 1, 0, crop);
    // l and r read as 0 and t as -1: the cropped rect is 1.5 picture heights (a full height of padding on
    // top, the lower half cut), so the picture's upper half fills the lower third of the box.
    close(r.draws()[0], [0, 0, 800, 300, 100, 50 + 300 * (600 / 900), 400, 300 * (300 / 900)]);
  });

  it('keeps rotation and the round clip, and drawObject passes the crop through', () => {
    const r = recorder();
    const o: SlideObject = {
      id: 'i',
      type: 'image',
      box: { ...box, rotation: 30 },
      mediaId: 'm',
      fit: 'stretch',
      opacity: 0.5,
      radius: 20,
      crop: { l: 0.5, t: 0, r: 0, b: 0 },
    };
    drawObject(r.ctx, o, 1, () => img);
    const ops = r.calls.map((c) => c.op);
    expect(ops).toContain('rotate');
    expect(r.calls.find((c) => c.op === 'roundRect')?.args).toEqual([100, 50, 400, 300, 20]);
    expect(ops.indexOf('clip')).toBeLessThan(ops.indexOf('drawImage'));
    close(r.draws()[0], [400, 0, 400, 600, 100, 50, 400, 300]);
  });
});
