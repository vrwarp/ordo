import type { Slide } from '@ordo/domain';
import { compositeOverPlate, hasTransparency } from './png.ts';
import type { BoxMae, Pro7FeatureTag, RgbaImage, SlideScore } from './types.ts';

export const SSIM_WIDTH = 960;
export const SSIM_HEIGHT = 540;

const C1 = (0.01 * 255) ** 2; // 6.5025
const C2 = (0.03 * 255) ** 2; // 58.5225

function toLuminanceGrid(img: RgbaImage, dstW: number, dstH: number): Float64Array {
  const { width: srcW, height: srcH, data } = img;
  const lum = new Float64Array(dstW * dstH);

  if (srcW === dstW && srcH === dstH) {
    for (let i = 0; i < lum.length; i++) {
      const o = i * 4;
      lum[i] = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
    }
    return lum;
  }

  if (srcW === dstW * 2 && srcH === dstH * 2) {
    for (let y = 0; y < dstH; y++) {
      const sy = y * 2;
      const row0 = sy * srcW * 4;
      const row1 = (sy + 1) * srcW * 4;
      const dRow = y * dstW;
      for (let x = 0; x < dstW; x++) {
        const sx = x * 2;
        const o00 = row0 + sx * 4;
        const o01 = row0 + (sx + 1) * 4;
        const o10 = row1 + sx * 4;
        const o11 = row1 + (sx + 1) * 4;
        const y00 = 0.299 * data[o00]! + 0.587 * data[o00 + 1]! + 0.114 * data[o00 + 2]!;
        const y01 = 0.299 * data[o01]! + 0.587 * data[o01 + 1]! + 0.114 * data[o01 + 2]!;
        const y10 = 0.299 * data[o10]! + 0.587 * data[o10 + 1]! + 0.114 * data[o10 + 2]!;
        const y11 = 0.299 * data[o11]! + 0.587 * data[o11 + 1]! + 0.114 * data[o11 + 2]!;
        lum[dRow + x] = 0.25 * (y00 + y01 + y10 + y11);
      }
    }
    return lum;
  }

  // General area box downsampling
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const sy0 = dy * scaleY;
    const sy1 = (dy + 1) * scaleY;
    const yStart = Math.floor(sy0);
    const yEnd = Math.min(srcH, Math.ceil(sy1));

    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = dx * scaleX;
      const sx1 = (dx + 1) * scaleX;
      const xStart = Math.floor(sx0);
      const xEnd = Math.min(srcW, Math.ceil(sx1));

      let sum = 0;
      let weightSum = 0;

      for (let sy = yStart; sy < yEnd; sy++) {
        const yWeight = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        const rowOffset = sy * srcW * 4;
        for (let sx = xStart; sx < xEnd; sx++) {
          const xWeight = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          const w = xWeight * yWeight;
          const o = rowOffset + sx * 4;
          const yVal = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
          sum += yVal * w;
          weightSum += w;
        }
      }
      lum[dy * dstW + dx] = weightSum > 0 ? sum / weightSum : 0;
    }
  }

  return lum;
}

export function computeSsim(a: RgbaImage, b: RgbaImage): number {
  let dstW = SSIM_WIDTH;
  let dstH = SSIM_HEIGHT;

  if (a.width < SSIM_WIDTH || a.height < SSIM_HEIGHT) {
    if (a.width === b.width && a.height === b.height) {
      dstW = a.width;
      dstH = a.height;
    } else {
      dstW = a.width;
      dstH = a.height;
    }
  } else if (b.width < SSIM_WIDTH || b.height < SSIM_HEIGHT) {
    dstW = SSIM_WIDTH;
    dstH = SSIM_HEIGHT;
  }

  const lumA = toLuminanceGrid(a, dstW, dstH);
  const lumB = toLuminanceGrid(b, dstW, dstH);

  if (dstW < 8 || dstH < 8) {
    const N = dstW * dstH;
    if (N < 2) return lumA[0] === lumB[0] ? 1 : 0;

    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < N; i++) {
      sumX += lumA[i]!;
      sumY += lumB[i]!;
    }
    const muX = sumX / N;
    const muY = sumY / N;

    let varX = 0;
    let varY = 0;
    let covXY = 0;
    for (let i = 0; i < N; i++) {
      const dx = lumA[i]! - muX;
      const dy = lumB[i]! - muY;
      varX += dx * dx;
      varY += dy * dy;
      covXY += dx * dy;
    }
    const sigX2 = varX / (N - 1);
    const sigY2 = varY / (N - 1);
    const sigXY = covXY / (N - 1);

    const num = (2 * muX * muY + C1) * (2 * sigXY + C2);
    const den = (muX * muX + muY * muY + C1) * (sigX2 + sigY2 + C2);
    return Math.max(0, Math.min(1, num / den));
  }

  const blocksX = Math.floor(dstW / 8);
  const blocksY = Math.floor(dstH / 8);
  let totalSsim = 0;

  for (let by = 0; by < blocksY; by++) {
    const startY = by * 8;
    for (let bx = 0; bx < blocksX; bx++) {
      const startX = bx * 8;

      let sumX = 0;
      let sumY = 0;
      for (let dy = 0; dy < 8; dy++) {
        const row = (startY + dy) * dstW;
        for (let dx = 0; dx < 8; dx++) {
          const idx = row + startX + dx;
          sumX += lumA[idx]!;
          sumY += lumB[idx]!;
        }
      }
      const muX = sumX / 64;
      const muY = sumY / 64;

      let varX = 0;
      let varY = 0;
      let covXY = 0;
      for (let dy = 0; dy < 8; dy++) {
        const row = (startY + dy) * dstW;
        for (let dx = 0; dx < 8; dx++) {
          const idx = row + startX + dx;
          const diffX = lumA[idx]! - muX;
          const diffY = lumB[idx]! - muY;
          varX += diffX * diffX;
          varY += diffY * diffY;
          covXY += diffX * diffY;
        }
      }
      const sigX2 = varX / 63;
      const sigY2 = varY / 63;
      const sigXY = covXY / 63;

      const num = (2 * muX * muY + C1) * (2 * sigXY + C2);
      const den = (muX * muX + muY * muY + C1) * (sigX2 + sigY2 + C2);
      totalSsim += num / den;
    }
  }

  return Math.max(0, Math.min(1, totalSsim / (blocksX * blocksY)));
}

function scaleImageTo(src: RgbaImage, dstW: number, dstH: number): RgbaImage {
  if (src.width === dstW && src.height === dstH) return src;
  const out = new Uint8Array(dstW * dstH * 4);
  const sx = src.width / dstW;
  const sy = src.height / dstH;
  for (let y = 0; y < dstH; y++) {
    const srcY = Math.min(src.height - 1, Math.floor(y * sy));
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(src.width - 1, Math.floor(x * sx));
      const srcOff = (srcY * src.width + srcX) * 4;
      const dstOff = (y * dstW + x) * 4;
      out[dstOff] = src.data[srcOff]!;
      out[dstOff + 1] = src.data[srcOff + 1]!;
      out[dstOff + 2] = src.data[srcOff + 2]!;
      out[dstOff + 3] = src.data[srcOff + 3]!;
    }
  }
  return { width: dstW, height: dstH, data: out };
}

export function scoreSlideImages(opts: {
  n: number;
  ref: RgbaImage;
  cand: RgbaImage;
  slide: Slide;
  features: Pro7FeatureTag[];
  refPngPath: string;
  ordoPngPath: string;
  ms1920?: number;
}): SlideScore {
  const transparentRef = hasTransparency(opts.ref);

  let ssim: number;
  let ssimBlack: number | undefined;
  let ssimWhite: number | undefined;

  if (transparentRef) {
    const refBlack = compositeOverPlate(opts.ref, [0, 0, 0]);
    const candBlack = compositeOverPlate(opts.cand, [0, 0, 0]);
    ssimBlack = computeSsim(refBlack, candBlack);

    const refWhite = compositeOverPlate(opts.ref, [255, 255, 255]);
    const candWhite = compositeOverPlate(opts.cand, [255, 255, 255]);
    ssimWhite = computeSsim(refWhite, candWhite);

    ssim = Math.min(ssimBlack, ssimWhite);
  } else {
    const candBlack = compositeOverPlate(opts.cand, [0, 0, 0]);
    ssim = computeSsim(opts.ref, candBlack);
  }

  // MAE computations at cand resolution
  const W = opts.cand.width;
  const H = opts.cand.height;
  const refScaled = scaleImageTo(opts.ref, W, H);
  const refData = refScaled.data;
  const candData = opts.cand.data;
  const totalPixels = W * H;

  // Premultiplied diff buffer per pixel: (|dr| + |dg| + |db| + |da|)
  const pixelDiffs = new Float32Array(totalPixels);
  let totalDiff = 0;
  let totalAlphaDiff = 0;

  for (let i = 0; i < totalPixels; i++) {
    const o = i * 4;
    const rA = refData[o]!;
    const gA = refData[o + 1]!;
    const bA = refData[o + 2]!;
    const aA = refData[o + 3]!;

    const rB = candData[o]!;
    const gB = candData[o + 1]!;
    const bB = candData[o + 2]!;
    const aB = candData[o + 3]!;

    // Premultiplied RGB values
    const prA = (rA * aA) / 255;
    const pgA = (gA * aA) / 255;
    const pbA = (bA * aA) / 255;

    const prB = (rB * aB) / 255;
    const pgB = (gB * aB) / 255;
    const pbB = (bB * aB) / 255;

    const da = Math.abs(aA - aB);
    const d = Math.abs(prA - prB) + Math.abs(pgA - pgB) + Math.abs(pbA - pbB) + da;
    pixelDiffs[i] = d;
    totalDiff += d;
    totalAlphaDiff += da;
  }

  const overallMae = totalPixels > 0 ? totalDiff / (totalPixels * 4 * 255) : 0;
  const alphaMae = totalPixels > 0 ? totalAlphaDiff / (totalPixels * 255) : 0;

  // Box MAEs
  const boxMask = new Uint8Array(totalPixels);
  const boxMaes: BoxMae[] = [];

  for (const obj of opts.slide.objects) {
    const x0 = Math.max(0, Math.min(W, Math.round(obj.box.x)));
    const y0 = Math.max(0, Math.min(H, Math.round(obj.box.y)));
    const x1 = Math.max(0, Math.min(W, Math.round(obj.box.x + obj.box.w)));
    const y1 = Math.max(0, Math.min(H, Math.round(obj.box.y + obj.box.h)));

    const count = (x1 - x0) * (y1 - y0);
    let boxDiff = 0;
    if (count > 0) {
      for (let y = y0; y < y1; y++) {
        const row = y * W;
        for (let x = x0; x < x1; x++) {
          const idx = row + x;
          boxDiff += pixelDiffs[idx]!;
          boxMask[idx] = 1;
        }
      }
    }
    const mae = count > 0 ? boxDiff / (count * 4 * 255) : 0;
    boxMaes.push({
      objectId: obj.id,
      type: obj.type,
      box: { x: obj.box.x, y: obj.box.y, w: obj.box.w, h: obj.box.h },
      mae,
    });
  }

  // Background MAE (outside all boxes)
  let bgDiff = 0;
  let bgCount = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (boxMask[i] === 0) {
      bgDiff += pixelDiffs[i]!;
      bgCount++;
    }
  }
  const backgroundMae = bgCount > 0 ? bgDiff / (bgCount * 4 * 255) : 0;

  return {
    n: opts.n,
    ssim,
    ssimBlack,
    ssimWhite,
    transparentRef,
    overallMae,
    backgroundMae,
    alphaMae,
    boxMaes,
    features: opts.features,
    refPngPath: opts.refPngPath,
    ordoPngPath: opts.ordoPngPath,
    ms1920: opts.ms1920,
  };
}
