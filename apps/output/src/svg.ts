import {
  SVG_HEAD_BYTES,
  SVG_MIME,
  SVG_SCREEN_MAX_BYTES,
  svgIntrinsicSize,
  svgRasterSizeFor,
} from '@ordo/domain';

/**
 * An SVG drawn by the output's window for its asset worker (design/14 "Pictures"): `createImageBitmap` cannot
 * decode an SVG, and only a window can draw one, through an `<img>` (no script runs in an image; an animation
 * shows its first frame). Drawn at `svgRasterSizeFor`, the size the uploading client draws a still at, into a
 * CPU-backed canvas (`willReadFrequently`), so the bitmap belongs to the worker it is handed to. A canvas the
 * SVG taints (a `foreignObject`) is refused rather than handed on, and one over `SVG_SCREEN_MAX_BYTES` is not
 * drawn at all: this thread also runs the hub link and the video slots.
 */
export async function svgBitmap(blob: Blob, timeoutMs = 10_000): Promise<ImageBitmap> {
  if (blob.size > SVG_SCREEN_MAX_BYTES)
    throw new Error(
      `an SVG of ${Math.round(blob.size / 1024)} KB without a still: screens draw one of at most ${SVG_SCREEN_MAX_BYTES / 1024 ** 2} MB themselves`,
    );
  const declared = svgIntrinsicSize(await blob.slice(0, SVG_HEAD_BYTES).text());
  const url = URL.createObjectURL(new Blob([blob], { type: SVG_MIME }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const img = new Image();
    img.src = url;
    await Promise.race([
      img.decode(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      }),
    ]);
    const size = svgRasterSizeFor(declared, { width: img.naturalWidth, height: img.naturalHeight });
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2D context');
    ctx.drawImage(img, 0, 0, size.width, size.height);
    ctx.getImageData(0, 0, 1, 1); // throws on a tainted canvas
    return canvas.transferToImageBitmap();
  } finally {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  }
}
