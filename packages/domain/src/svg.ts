/*
 * SVG media (design/12 "Media pipeline", design/14 "Pictures"). Outputs draw pictures in a worker with
 * `createImageBitmap`, which cannot decode an SVG, and a canvas draw of an SVG is one still frame anyway. So an
 * SVG is shown on the screens as a still raster: the uploading client draws it through an `<img>` into a canvas
 * and uploads a PNG with it (its `delivery`, validated by the hub), and an output that meets an SVG without one
 * (a library from before) rasterises it on its main thread. Both use `svgRasterSize`, so the two agree.
 *
 * Pure and bounded: everything here reads at most `SVG_HEAD_BYTES` of text and never throws on hostile input.
 */

export const SVG_MIME = 'image/svg+xml';

/** Whether a mime (a `FileRef.mime`) names an SVG. */
export function isSvgMime(mime: unknown): boolean {
  return typeof mime === 'string' && mime.split(';')[0]!.trim().toLowerCase() === SVG_MIME;
}

/** Bytes of an SVG's text read for its root element: its size attributes are near the top. */
export const SVG_HEAD_BYTES = 64 * 1024;

/**
 * Whether a file's first bytes are an SVG document: `<svg` within its first 512 bytes, as the hub sniffs an
 * upload (apps/hub/src/store.ts `sniff`), so an output recognises every SVG the hub accepted.
 */
export function looksLikeSvg(head: Uint8Array): boolean {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, 512));
  return /<svg[\s>]/i.test(text);
}

/**
 * Raster bounds. An SVG is a vector, so it is drawn at least `minLong` px on its longer side (crisp at any size
 * on a 1080p screen: a 200x80 logo is drawn at 1920x768), at most `maxWidth` wide like any delivered picture
 * (hub `MAX_IMAGE_WIDTH`) and at most `maxPixels` (iOS Safari's canvas limit, 4096²) and `maxSide` high.
 */
export const SVG_RASTER = {
  minLong: 1920,
  maxWidth: 3840,
  maxSide: 16384,
  maxPixels: 4096 * 4096,
} as const;

/**
 * What an SVG's root element declares: its size in CSS px (`width` and `height` in absolute units, one of them
 * completed from the viewBox's ratio), its viewBox's size (the user units it was designed in) and its aspect
 * ratio.
 */
export type SvgSize = {
  width?: number;
  height?: number;
  viewBox?: { width: number; height: number };
  ratio?: number;
};

const UNIT_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
};

/** A length attribute in CSS px; undefined for percentages, font-relative units or anything malformed. */
function lengthPx(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const m = /^\s*\+?(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm)?\s*$/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]) * UNIT_PX[(m[2] ?? '').toLowerCase()]!;
  return Number.isFinite(n) && n > 0 && n < 1e7 ? n : undefined;
}

/**
 * The root element's attributes (names lower-cased) when the root element is an `<svg>` (any prefix), else
 * undefined. A single forward scan: comments, processing instructions and a doctype before it are skipped,
 * and an unterminated one ends the scan, so hostile text costs linear time.
 */
function rootAttributes(text: string): Map<string, string> | undefined {
  const n = text.length;
  let i = 0;
  for (;;) {
    i = text.indexOf('<', i);
    if (i < 0 || i + 1 >= n) return undefined;
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      if (e < 0) return undefined;
      i = e + 3;
    } else if (text[i + 1] === '?' || text[i + 1] === '!') {
      const e = text.indexOf('>', i + 2);
      if (e < 0) return undefined;
      i = e + 1;
    } else break;
  }
  // The root element's name, then its attributes up to the tag's end.
  let j = i + 1;
  while (j < n && !/[\s/>]/.test(text[j]!)) j++;
  const name = text.slice(i + 1, j).toLowerCase();
  if (name !== 'svg' && !/^[a-z_][\w.-]*:svg$/.test(name)) return undefined;
  const attrs = new Map<string, string>();
  for (let count = 0; count < 256; count++) {
    while (j < n && /\s/.test(text[j]!)) j++;
    if (j >= n || text[j] === '>' || text[j] === '/') break;
    const a = j;
    while (j < n && !/[\s=/>]/.test(text[j]!)) j++;
    const key = text.slice(a, j).toLowerCase();
    while (j < n && /\s/.test(text[j]!)) j++;
    if (text[j] !== '=') {
      if (j === a) break;
      continue; // an attribute without a value (not XML): skipped
    }
    j++;
    while (j < n && /\s/.test(text[j]!)) j++;
    const q = text[j];
    if (q !== '"' && q !== "'") break;
    const e = text.indexOf(q, j + 1);
    if (e < 0) break;
    if (key && !attrs.has(key)) attrs.set(key, text.slice(j + 1, e));
    j = e + 1;
  }
  return attrs;
}

/**
 * The size an SVG's root element declares (`width`, `height` in absolute units, else the `viewBox`), read from
 * the first `SVG_HEAD_BYTES` of its text. A side given with the viewBox's ratio gives the other; a percentage
 * or font-relative size counts as none (the browser then sizes it from the ratio). Empty when nothing is
 * declared or the text is not an SVG.
 */
export function svgIntrinsicSize(text: string): SvgSize {
  const attrs = rootAttributes(text.slice(0, SVG_HEAD_BYTES));
  if (!attrs) return {};
  let width = lengthPx(attrs.get('width'));
  let height = lengthPx(attrs.get('height'));
  let ratio: number | undefined;
  let viewBox: SvgSize['viewBox'];
  const vb = attrs
    .get('viewbox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    vb?.length === 4 &&
    vb.every(Number.isFinite) &&
    vb[2]! > 0 &&
    vb[3]! > 0 &&
    vb[2]! < 1e7 &&
    vb[3]! < 1e7
  ) {
    viewBox = { width: vb[2]!, height: vb[3]! };
    ratio = vb[2]! / vb[3]!;
  }
  if (width !== undefined && height !== undefined) ratio = width / height;
  else if (width !== undefined && ratio !== undefined) height = width / ratio;
  else if (height !== undefined && ratio !== undefined) width = height * ratio;
  else {
    width = undefined;
    height = undefined;
  }
  return {
    ...(width !== undefined && height !== undefined ? { width, height } : {}),
    ...(viewBox ? { viewBox } : {}),
    ...(ratio !== undefined && Number.isFinite(ratio) && ratio > 0 ? { ratio } : {}),
  };
}

/**
 * The pixel size to rasterise an SVG of `width` x `height` (CSS px) at: scaled up so its longer side is at least
 * `SVG_RASTER.minLong`, then down to the width, height and pixel caps, keeping its ratio. A size that is not a
 * positive number counts as 1920x1080.
 */
export function svgRasterSize(width: number, height: number): { width: number; height: number } {
  const ok = (n: number) => Number.isFinite(n) && n > 0;
  let w = ok(width) && ok(height) ? width : 1920;
  let h = ok(width) && ok(height) ? height : 1080;
  const R = SVG_RASTER;
  const up = Math.max(1, R.minLong / Math.max(w, h));
  w *= up;
  h *= up;
  const down = Math.min(1, R.maxWidth / w, R.maxSide / h, Math.sqrt(R.maxPixels / (w * h)));
  w *= down;
  h *= down;
  let rw = Math.min(R.maxWidth, Math.round(w));
  let rh = Math.min(R.maxSide, Math.round(h));
  if (rw * rh > R.maxPixels) {
    rw = Math.floor(w);
    rh = Math.floor(h);
  }
  return { width: Math.max(1, rw), height: Math.max(1, rh) };
}

/**
 * The raster size for an SVG: the size its root element declares (`svgIntrinsicSize`), else its viewBox's
 * (the units it was designed in), else its natural size in a browser (an `<img>`'s naturalWidth/Height: 300x150
 * when nothing is declared), else 1920x1080; then `svgRasterSize`'s floor and caps. The uploading client, the
 * hub and an output rasterising on its main thread all use it, so they agree.
 */
export function svgRasterSizeFor(
  declared: SvgSize,
  natural?: { width: number; height: number },
): { width: number; height: number } {
  if (declared.width !== undefined && declared.height !== undefined)
    return svgRasterSize(declared.width, declared.height);
  if (declared.viewBox) return svgRasterSize(declared.viewBox.width, declared.viewBox.height);
  if (natural) return svgRasterSize(natural.width, natural.height);
  return svgRasterSize(1920, 1080);
}

/** The size a browser gives an SVG that declares none (the CSS default object size). */
export const SVG_DEFAULT_SIZE = { width: 300, height: 150 } as const;

/** A PNG's size from its header (signature and IHDR), or undefined for anything else. */
export function pngSize(b: Uint8Array): { width: number; height: number } | undefined {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !SIG.every((x, i) => b[i] === x)) return undefined;
  // The first chunk must be IHDR, 13 bytes long.
  if (b[8] !== 0 || b[9] !== 0 || b[10] !== 0 || b[11] !== 13) return undefined;
  if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') return undefined;
  const u32 = (o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  const width = u32(16);
  const height = u32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Why a raster cannot be an SVG's delivery, or undefined when it can: within `SVG_RASTER`'s caps, and of the
 * ratio the SVG declares (when it declares one) to within a pixel or 1 %.
 */
export function svgRasterProblem(
  declared: SvgSize,
  raster: { width: number; height: number },
): string | undefined {
  const { width: w, height: h } = raster;
  const R = SVG_RASTER;
  if (!(w > 0 && h > 0)) return 'the picture has no size';
  if (w > R.maxWidth || h > R.maxSide || w * h > R.maxPixels)
    return `the picture is ${w}x${h}; the limit is ${R.maxWidth} px wide and ${Math.round(R.maxPixels / 1e6)} MP`;
  if (declared.ratio !== undefined) {
    const want = h * declared.ratio;
    if (Math.abs(w - want) > Math.max(1.5, 0.01 * w))
      return `the picture is ${w}x${h}, not the shape the SVG declares`;
  }
  return undefined;
}
