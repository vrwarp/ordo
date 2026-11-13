/**
 * Pictures baked at import (design/27 §4 "Pictures", §15 M6 "Recolour and tile bakes"): a blip's colour
 * effects and a tiled picture fill become a derived picture, an ordinary media item an older build draws too,
 * so these pictures are native instead of drawn without their effects or stretched.
 *
 * - **The recipe** (`PictureBake`) is what the converter knows: the colour effects in document order
 *   (`PictureFill.recolor`, colours resolved) and, for a tiled fill (`a:tile`), the tile grid as shares of the
 *   box it fills. `bakeOf` builds it for one use of a picture; `EmitResult.media` lists each distinct
 *   (part, recipe) once with its own placeholder id (`emit.ts`).
 * - **The pixels** (`applyBake`) are the hub's pool task `pptx-bake` and the fidelity harness's: a decoded
 *   source (RGBA, straight alpha) in, the derived picture out. Pure arithmetic, linear in the pixels of the
 *   source and the output, bounded by the caller (`BAKE_LIMITS`).
 *
 * The effects follow ECMA-376 §20.1.8 with LibreOffice's arithmetic, its pictures being the fidelity
 * reference: the luminance is (76·R + 151·G + 29·B) / 256; `grayscl` sets every channel to it; `biLevel`
 * makes a pixel white when it reaches the threshold (128 at PowerPoint's 50 %), else black; `duotone` maps it
 * linearly from the first colour (luminance 0) to the second (255); `clrChange` gives the pixels within a
 * tolerance of `clrFrom` (per channel, by the picture's format, `CLR_CHANGE_TOLERANCE`) the colour and alpha
 * of `clrTo`; `lum` is PowerPoint's brightness and contrast (half the brightness before the contrast, half
 * after). Alpha is kept, except by `clrChange`. A tile's top-left corner follows `a:tile algn` and the
 * `tx`/`ty` offsets, its size the picture's at its stated resolution (96 dpi when none) times `sx`/`sy`, and
 * `flip` mirrors every other tile.
 */
import { EMU_PER_INCH, type Insets, type PictureFill, type Recolor } from './ir.ts';

/** A tiled fill (`a:tile`) as shares of the box it fills (M6). */
export interface TileBake {
  /** The box's height over its width: the output's aspect. */
  aspect: number;
  /** One tile's size as shares of the box's width and height. */
  w: number;
  h: number;
  /** Where one tile's top-left corner lies, as shares of the box (the grid repeats from there both ways). */
  x: number;
  y: number;
  /** `a:tile flip`: every other tile mirrored horizontally (`x`), vertically (`y`) or both. */
  flip: 'none' | 'x' | 'y' | 'xy';
  /** The part of the picture one tile shows (`a:srcRect`, positive shares only). */
  crop?: Insets;
}

/** What a derived picture is made of: the source part's picture with these applied, in this order. */
export interface PictureBake {
  /** Colour effects, in document order (`PictureFill.recolor`). */
  recolor?: Recolor[];
  /** A tiled fill: the output is the box, the (recoloured) picture repeated over it. */
  tile?: TileBake;
}

/** An RGBA raster, 8 bits a channel, straight alpha, rows top to bottom. */
export interface BakeRaster {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Bounds of a bake (design/27 §12): what a caller decodes and allocates for one. */
export const BAKE_LIMITS = {
  /** Largest side of a source or an output, in px (the prepared pictures' limit). */
  side: 8_192,
  /** Largest source or output, in pixels: 64 MB of RGBA each. */
  pixels: 16 * 1024 * 1024,
  /** Colour effects applied per picture (`picture.ts` reads at most 16 effects). */
  effects: 16,
} as const;

/**
 * `clrChange`'s tolerance per channel (0-255) by the source's format, as LibreOffice guesses it: a JPEG's
 * colours vary around the one meant, a PNG's or TIFF's barely, a BMP's not at all.
 */
export const CLR_CHANGE_TOLERANCE: Readonly<Record<string, number>> = Object.freeze({
  jpeg: 15,
  png: 1,
  tiff: 1,
  bmp: 0,
  other: 9,
});

/** The resolution a picture's size is taken at when its header states none. */
export const DEFAULT_DPI = 96;
/** Shares a tile may have of its box: smaller tiles are sub-pixel noise, larger ones a stretched picture. */
const MIN_TILE_SHARE = 1e-4;
const MAX_TILE_SHARE = 1e4;

const TILE_ALIGN: ReadonlyMap<string, [number, number]> = new Map([
  ['tl', [0, 0]],
  ['t', [0.5, 0]],
  ['tr', [1, 0]],
  ['l', [0, 0.5]],
  ['ctr', [0.5, 0.5]],
  ['r', [1, 0.5]],
  ['bl', [0, 1]],
  ['b', [0.5, 1]],
  ['br', [1, 1]],
]);

const finite = (v: number) => Number.isFinite(v);

/**
 * The tile grid of a tiled picture fill over a box of `boxW` x `boxH` EMU, or undefined when it cannot be
 * known (no pixel size, a degenerate box or tile).
 */
export function tileBakeOf(p: PictureFill, boxW: number, boxH: number): TileBake | undefined {
  const t = p.tile;
  if (!t || !p.px || !(boxW > 0 && boxH > 0) || !finite(boxW) || !finite(boxH)) return undefined;
  const c = p.crop;
  const crop =
    c && (c.l > 0 || c.t > 0 || c.r > 0 || c.b > 0)
      ? { l: Math.max(0, c.l), t: Math.max(0, c.t), r: Math.max(0, c.r), b: Math.max(0, c.b) }
      : undefined;
  const keptW = crop ? 1 - crop.l - crop.r : 1;
  const keptH = crop ? 1 - crop.t - crop.b : 1;
  if (!(keptW > 1e-6 && keptH > 1e-6)) return undefined;
  const dpiX = p.px.dpi?.x ?? DEFAULT_DPI;
  const dpiY = p.px.dpi?.y ?? DEFAULT_DPI;
  // One tile in EMU: the (cropped) picture at its resolution, scaled.
  const tw = ((p.px.w * keptW) / dpiX) * EMU_PER_INCH * Math.abs(t.sx);
  const th = ((p.px.h * keptH) / dpiY) * EMU_PER_INCH * Math.abs(t.sy);
  const w = tw / boxW;
  const h = th / boxH;
  const ok = (v: number) => finite(v) && v >= MIN_TILE_SHARE && v <= MAX_TILE_SHARE;
  if (!ok(w) || !ok(h)) return undefined;
  const [ax, ay] = TILE_ALIGN.get(t.algn) ?? [0, 0];
  const x = ax * (1 - w) + (finite(t.tx) ? t.tx : 0) / boxW;
  const y = ay * (1 - h) + (finite(t.ty) ? t.ty : 0) / boxH;
  if (!finite(x) || !finite(y) || Math.abs(x) > MAX_TILE_SHARE || Math.abs(y) > MAX_TILE_SHARE)
    return undefined;
  const flip = t.flip === 'x' || t.flip === 'y' || t.flip === 'xy' ? t.flip : 'none';
  return { aspect: boxH / boxW, w, h, x, y, flip, ...(crop ? { crop } : {}) };
}

/**
 * The bake of one use of a picture: its colour effects, and its tile grid when it is a tiled fill of a box of
 * `boxW` x `boxH` EMU (the box it is stretched over otherwise). Undefined when nothing is baked.
 */
export function bakeOf(p: PictureFill, box?: { w: number; h: number }): PictureBake | undefined {
  const recolor = p.recolor?.length ? p.recolor.slice(0, BAKE_LIMITS.effects) : undefined;
  const tile = p.tile && box ? tileBakeOf(p, box.w, box.h) : undefined;
  if (!recolor && !tile) return undefined;
  return { ...(recolor ? { recolor } : {}), ...(tile ? { tile } : {}) };
}

/** A stable key of a bake (with its part, the identity of the derived picture). */
export function bakeKey(part: string, bake: PictureBake): string {
  return JSON.stringify([part, bake]);
}

// ── Pixels ──────────────────────────────────────────────────────────────────────────────────────────────

/** LibreOffice's luminance of a pixel (`Color::GetLuminance`): 0-255. */
export function luminance(r: number, g: number, b: number): number {
  return (b * 29 + g * 151 + r * 76) >> 8;
}

const clamp255 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** A 256-entry channel map for PowerPoint's brightness and contrast (shares -1..1). */
function lumMap(bright: number, contrast: number): Uint8Array {
  const c = Math.max(-100, Math.min(100, contrast * 100));
  const m = c >= 0 ? 128 / (128 - 1.27 * c) : (128 + 1.27 * c) / 128;
  const off = Math.max(-100, Math.min(100, bright * 100)) * 2.55;
  const map = new Uint8Array(256);
  for (let v = 0; v < 256; v++) map[v] = clamp255((v + off / 2 - 128) * m + 128 + off / 2);
  return map;
}

/** Apply colour effects to a raster in place. `tolerance`: `clrChange`'s, per channel (0-255). */
export function recolorRaster(img: BakeRaster, effects: readonly Recolor[], tolerance: number): void {
  const d = img.data;
  const n = img.width * img.height * 4;
  for (const fx of effects.slice(0, BAKE_LIMITS.effects)) {
    switch (fx.kind) {
      case 'grayscale':
        for (let i = 0; i < n; i += 4) {
          const l = luminance(d[i]!, d[i + 1]!, d[i + 2]!);
          d[i] = d[i + 1] = d[i + 2] = l;
        }
        break;
      case 'biLevel': {
        // PowerPoint's 50 % is LibreOffice's black-and-white mode, whose threshold is 128.
        const t = Math.abs(fx.threshold - 0.5) < 1e-9 ? 128 : Math.floor(fx.threshold * 255);
        for (let i = 0; i < n; i += 4) {
          const v = luminance(d[i]!, d[i + 1]!, d[i + 2]!) >= t ? 255 : 0;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
        break;
      }
      case 'duotone': {
        const a = fx.dark;
        const b = fx.light;
        for (let i = 0; i < n; i += 4) {
          const l = luminance(d[i]!, d[i + 1]!, d[i + 2]!);
          const k = 255 - l;
          d[i] = Math.floor((a.r * k) / 255) + Math.floor((b.r * l) / 255);
          d[i + 1] = Math.floor((a.g * k) / 255) + Math.floor((b.g * l) / 255);
          d[i + 2] = Math.floor((a.b * k) / 255) + Math.floor((b.b * l) / 255);
        }
        break;
      }
      case 'clrChange': {
        const f = fx.from;
        const t = fx.to;
        const tol = Math.max(0, Math.min(255, tolerance));
        const alpha = Math.max(0, Math.min(1, finite(t.a) ? t.a : 1));
        for (let i = 0; i < n; i += 4) {
          if (
            Math.abs(d[i]! - f.r) > tol ||
            Math.abs(d[i + 1]! - f.g) > tol ||
            Math.abs(d[i + 2]! - f.b) > tol
          )
            continue;
          d[i] = clamp255(t.r);
          d[i + 1] = clamp255(t.g);
          d[i + 2] = clamp255(t.b);
          d[i + 3] = clamp255(d[i + 3]! * alpha);
        }
        break;
      }
      case 'lum': {
        const map = lumMap(fx.bright, fx.contrast);
        for (let i = 0; i < n; i += 4) {
          d[i] = map[d[i]!]!;
          d[i + 1] = map[d[i + 1]!]!;
          d[i + 2] = map[d[i + 2]!]!;
        }
        break;
      }
    }
  }
}

/** Whether a raster has any pixel that is not opaque. */
export function hasAlpha(img: BakeRaster): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** The checks of a raster's size; throws on anything outside `BAKE_LIMITS`. */
export function checkSize(w: number, h: number, what: string): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1)
    throw new Error(`the ${what} has an invalid size`);
  if (w > BAKE_LIMITS.side || h > BAKE_LIMITS.side || w * h > BAKE_LIMITS.pixels)
    throw new Error(`the ${what} is larger than a bake may be`);
}

/** The checks of a raster a bake reads; throws on anything outside `BAKE_LIMITS`. */
export function checkRaster(img: BakeRaster, what: string): void {
  checkSize(img.width, img.height, what);
  if (!(img.data instanceof Uint8Array) || img.data.length < img.width * img.height * 4)
    throw new Error(`the ${what} has too few pixels`);
}

/**
 * The size a tiled fill's picture is decoded at for an output of `out` px: the whole picture at the scale
 * that makes its kept part one tile (so the output samples it close to 1:1), within `BAKE_LIMITS`.
 */
export function tileSourceSize(
  t: TileBake,
  out: { width: number; height: number },
): { width: number; height: number } {
  const c = t.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const keptW = Math.max(1e-6, 1 - c.l - c.r);
  const keptH = Math.max(1e-6, 1 - c.t - c.b);
  let w = Math.max(1, Math.round((t.w * out.width) / keptW));
  let h = Math.max(1, Math.round((t.h * out.height) / keptH));
  const k = Math.min(1, BAKE_LIMITS.side / Math.max(w, h), Math.sqrt(BAKE_LIMITS.pixels / (w * h)));
  if (k < 1) {
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
  return { width: w, height: h };
}

/**
 * The derived picture: `src` (the source part decoded, RGBA) with the bake's colour effects, then, for a tile,
 * repeated over an output of `out` px (the box at the size it is shown). Without a tile the output is the
 * recoloured source, of the source's size. `format` is the source's (`CLR_CHANGE_TOLERANCE`). `src` is
 * changed in place by the colour effects.
 */
export function applyBake(
  src: BakeRaster,
  bake: PictureBake,
  out?: { width: number; height: number },
  format = 'other',
): BakeRaster {
  checkRaster(src, 'source picture');
  if (bake.recolor?.length)
    recolorRaster(src, bake.recolor, CLR_CHANGE_TOLERANCE[format] ?? CLR_CHANGE_TOLERANCE.other!);
  const t = bake.tile;
  if (!t) return src;
  const size = out ?? { width: src.width, height: src.height };
  checkSize(size.width, size.height, 'tiled picture');
  const dst: BakeRaster = {
    width: size.width,
    height: size.height,
    data: new Uint8Array(4 * size.width * size.height),
  };
  const W = dst.width;
  const H = dst.height;
  const c = t.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const keptW = Math.max(1e-6, 1 - c.l - c.r);
  const keptH = Math.max(1e-6, 1 - c.t - c.b);
  // Source column of each output column, and source row of each output row: tiles are separable.
  const cols = new Int32Array(W);
  for (let x = 0; x < W; x++)
    cols[x] = sourceIndex((x + 0.5) / W, t.x, t.w, t.flip === 'x' || t.flip === 'xy', c.l, keptW, src.width);
  const s = src.data;
  const d = dst.data;
  for (let y = 0; y < H; y++) {
    const sy = sourceIndex(
      (y + 0.5) / H,
      t.y,
      t.h,
      t.flip === 'y' || t.flip === 'xy',
      c.t,
      keptH,
      src.height,
    );
    const row = sy * src.width * 4;
    let o = y * W * 4;
    for (let x = 0; x < W; x++, o += 4) {
      const i = row + cols[x]! * 4;
      d[o] = s[i]!;
      d[o + 1] = s[i + 1]!;
      d[o + 2] = s[i + 2]!;
      d[o + 3] = s[i + 3]!;
    }
  }
  return dst;
}

/**
 * The source pixel (along one axis) an output position `u` (a share of the box) shows: the position in its
 * tile, mirrored in every other tile when flipped, then mapped into the source's kept part.
 */
function sourceIndex(
  u: number,
  at: number,
  size: number,
  flip: boolean,
  cropStart: number,
  kept: number,
  n: number,
): number {
  const q = (u - at) / size;
  const k = Math.floor(q);
  let f = q - k;
  if (flip && (k & 1) !== 0) f = 1 - f;
  const v = Math.floor((cropStart + f * kept) * n);
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

// ── Sheets: pictures made of several pictures (M9, `sheet.ts`) ───────────────────────────────────────────

/**
 * One picture of a sheet (M9, design/27 §15 M9, `budget-decorations.md` §3.4): a source part as one object
 * shows it, placed in the sheet. The caller decodes `part` with `crop` applied (shares of the source; a
 * negative share pads that side with transparency, as `ImageObject.crop`), recoloured by `recolor`, at the
 * cell's size before its turn (`cellSourceSize`: `w` x `h`, or `h` x `w` for an odd `quarter`, or `src` for a
 * picture turned by any other angle); `applySheet` mirrors and turns it by index arithmetic (no resampling)
 * or, for `rotation`, by sampling it as Canvas draws a turned picture (bilinear), and lays it over the sheet
 * at (`x`, `y`) with `alpha`.
 */
export interface SheetCell {
  /** The source picture part. */
  part: string;
  /** `ImageObject.crop`: the share of the source cut from each side (negative: transparent padding). */
  crop?: Insets;
  /** The picture's own colour effects (`PictureFill.recolor`), applied to the cell. */
  recolor?: Recolor[];
  /** The cell in the sheet, whole px, as drawn (after its turn). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Mirrored about the picture's own centre before its turn (`ImageObject.flipH`, `flipV`). */
  flipH?: boolean;
  flipV?: boolean;
  /** Quarter turns clockwise (`ImageObject.box.rotation` / 90; composites only). */
  quarter?: 0 | 1 | 2 | 3;
  /**
   * Any other turn, degrees clockwise about the picture's centre (composites only, without `quarter`): the
   * cell is the turned picture's bounding box, and the source is decoded at `src`, the unturned picture.
   */
  rotation?: number;
  src?: { w: number; h: number };
  /** The picture's opacity (`ImageObject.opacity`, PowerPoint's `alphaModFix`; composites only). */
  alpha?: number;
}

/**
 * A sheet (M9): one picture made of several. A **composite** is a z-run of plain pictures drawn as one picture
 * over their union box, cells in z-order laid over each other; an **atlas** packs the fewest smallest of a
 * slide's distinct pictures past its 12 into one, each object keeping its box and showing its cell through
 * its crop (`ImageObject.crop`, drawn by every build since M1).
 */
export interface SheetBake {
  w: number;
  h: number;
  cells: SheetCell[];
  layout: 'composite' | 'atlas';
}

/** Bounds of a sheet (design/27 §12, `BAKE_LIMITS`): what a caller decodes and allocates for one. */
export const SHEET_LIMITS = {
  /** Cells of one sheet. */
  cells: 64,
  /** Largest side of the sheet, px. */
  side: BAKE_LIMITS.side,
  /** Pixels of the sheet (64 MB of RGBA). */
  pixels: BAKE_LIMITS.pixels,
  /** Pixels decoded for all its cells together. */
  decoded: 32 * 1024 * 1024,
} as const;

/**
 * The size a cell's source is decoded at: the cell's, its sides swapped by an odd quarter turn; a cell turned
 * by any other angle, its `src`.
 */
export function cellSourceSize(cell: SheetCell): { width: number; height: number } {
  if (cell.rotation !== undefined && cell.src) return { width: cell.src.w, height: cell.src.h };
  const odd = (cell.quarter ?? 0) % 2 === 1;
  return { width: odd ? cell.h : cell.w, height: odd ? cell.w : cell.h };
}

/**
 * Throws when a sheet is outside `SHEET_LIMITS` or a cell outside the sheet: what a caller checks before it
 * decodes anything for it.
 */
export function checkSheet(bake: SheetBake): void {
  checkSize(bake.w, bake.h, 'sheet');
  if (!Array.isArray(bake.cells) || bake.cells.length < 1 || bake.cells.length > SHEET_LIMITS.cells)
    throw new Error('the sheet has too many or no cells');
  let decoded = 0;
  for (const c of bake.cells) {
    checkSize(c.w, c.h, 'sheet cell');
    if (!Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.y < 0)
      throw new Error('a sheet cell lies outside the sheet');
    if (c.x + c.w > bake.w || c.y + c.h > bake.h) throw new Error('a sheet cell lies outside the sheet');
    if (c.rotation !== undefined && !(Number.isFinite(c.rotation) && c.src && c.quarter === undefined))
      throw new Error('a turned sheet cell has no source size');
    const src = cellSourceSize(c);
    checkSize(src.width, src.height, 'sheet cell source');
    decoded += src.width * src.height;
  }
  if (decoded > SHEET_LIMITS.decoded) throw new Error('the sheet decodes more pixels than a sheet may');
}

/**
 * The sheet's pixels (RGBA, straight alpha): each cell's decoded source (`raster`, at `cellSourceSize`, its
 * crop applied) recoloured (`format`: the source's, `CLR_CHANGE_TOLERANCE`), mirrored and turned by index
 * arithmetic and laid "over" what the cells before it left, times its `alpha`; transparent where no cell is.
 * A raster of the wrong size, or a sheet outside its limits, throws. Rasters are changed in place by the
 * colour effects. Linear in the cells' pixels.
 */
export function applySheet(
  bake: SheetBake,
  cells: readonly { cell: SheetCell; raster: BakeRaster; format?: string }[],
): BakeRaster {
  checkSheet(bake);
  const W = bake.w;
  const out: BakeRaster = { width: W, height: bake.h, data: new Uint8Array(4 * W * bake.h) };
  const d = out.data;
  for (const { cell, raster, format } of cells) {
    const want = cellSourceSize(cell);
    checkRaster(raster, 'sheet cell');
    if (raster.width !== want.width || raster.height !== want.height)
      throw new Error('a sheet cell was decoded at the wrong size');
    if (cell.recolor?.length)
      recolorRaster(
        raster,
        cell.recolor,
        CLR_CHANGE_TOLERANCE[format ?? 'other'] ?? CLR_CHANGE_TOLERANCE.other!,
      );
    const a = Math.max(0, Math.min(1, finite(cell.alpha ?? 1) ? (cell.alpha ?? 1) : 1));
    if (a <= 0) continue;
    if (cell.rotation !== undefined) {
      turnedCell(d, W, cell, raster, a);
      continue;
    }
    const sw = raster.width;
    const sh = raster.height;
    const s = raster.data;
    const q = cell.quarter ?? 0;
    for (let y = 0; y < cell.h; y++) {
      let o = ((cell.y + y) * W + cell.x) * 4;
      for (let x = 0; x < cell.w; x++, o += 4) {
        // The source pixel this cell pixel shows: undo the turn (clockwise), then the mirrors.
        let u: number;
        let v: number;
        if (q === 0) {
          u = x;
          v = y;
        } else if (q === 1) {
          u = y;
          v = sh - 1 - x;
        } else if (q === 2) {
          u = sw - 1 - x;
          v = sh - 1 - y;
        } else {
          u = sw - 1 - y;
          v = x;
        }
        if (cell.flipH) u = sw - 1 - u;
        if (cell.flipV) v = sh - 1 - v;
        const i = (v * sw + u) * 4;
        const sa = (s[i + 3]! / 255) * a;
        if (sa <= 0) continue;
        const da = d[o + 3]! / 255;
        const oa = sa + da * (1 - sa);
        for (let k = 0; k < 3; k++) d[o + k] = clamp255((s[i + k]! * sa + d[o + k]! * da * (1 - sa)) / oa);
        d[o + 3] = clamp255(oa * 255);
      }
    }
  }
  return out;
}

/**
 * Lay a cell turned by any angle over the sheet `d` (`W` px wide): each cell pixel's centre mapped back
 * through the turn (about the cell's centre) and the mirrors into the source, sampled bilinearly with
 * premultiplied alpha (transparent outside it), as Canvas draws a turned picture, then "over" times `a`.
 */
function turnedCell(d: Uint8Array, W: number, cell: SheetCell, src: BakeRaster, a: number): void {
  const th = ((cell.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  // A source pixel premultiplied, transparent outside the source.
  const px = (u: number, v: number, k: number) => {
    if (u < 0 || v < 0 || u >= sw || v >= sh) return 0;
    const i = (v * sw + u) * 4;
    return k === 3 ? s[i + 3]! : (s[i + k]! * s[i + 3]!) / 255;
  };
  const rgba = [0, 0, 0, 0];
  for (let y = 0; y < cell.h; y++) {
    let o = ((cell.y + y) * W + cell.x) * 4;
    for (let x = 0; x < cell.w; x++, o += 4) {
      const dx = x + 0.5 - cell.w / 2;
      const dy = y + 0.5 - cell.h / 2;
      let u = dx * cos + dy * sin + sw / 2;
      let v = -dx * sin + dy * cos + sh / 2;
      if (cell.flipH) u = sw - u;
      if (cell.flipV) v = sh - v;
      u -= 0.5;
      v -= 0.5;
      if (u <= -1 || v <= -1 || u >= sw || v >= sh) continue;
      const u0 = Math.floor(u);
      const v0 = Math.floor(v);
      const fu = u - u0;
      const fv = v - v0;
      for (let k = 0; k < 4; k++)
        rgba[k] =
          (px(u0, v0, k) * (1 - fu) + px(u0 + 1, v0, k) * fu) * (1 - fv) +
          (px(u0, v0 + 1, k) * (1 - fu) + px(u0 + 1, v0 + 1, k) * fu) * fv;
      const sa = (rgba[3]! / 255) * a;
      if (sa <= 0) continue;
      const da = d[o + 3]! / 255;
      const oa = sa + da * (1 - sa);
      // The premultiplied source times `a`, over the straight destination.
      for (let k = 0; k < 3; k++) d[o + k] = clamp255((rgba[k]! * a + d[o + k]! * da * (1 - sa)) / oa);
      d[o + 3] = clamp255(oa * 255);
    }
  }
}

/** A stable key of a sheet: the identity of the picture it makes (its cells' parts and the recipe). */
export function sheetKey(bake: SheetBake): string {
  return JSON.stringify(bake);
}
