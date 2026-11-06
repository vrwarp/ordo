/**
 * Pictures: `p:pic` and every `a:blipFill` (design/27 §4 "Pictures").
 *
 * - The blip's part is resolved through the relationships of the part that holds the XML (slide, layout,
 *   master or theme). `a:blip r:embed` is the raster: an `asvg:svgBlip` beside it is ignored (its PNG
 *   fallback is drawn) and an `a14:imgProps` layer is PowerPoint's already-corrected result, drawn as is.
 * - Linked (External) pictures are never fetched: logged with their host only.
 * - EMF/WMF are residual (LibreOffice converts them in M3); other formats a browser cannot decode are noted.
 * - A picture's pixel size is read from its header (PNG, JPEG, GIF, BMP, WebP) when its bytes are present,
 *   else asked of the caller (`SlideCtx.pictureSize`, for parts spilled to disk), so a background whose
 *   aspect differs from the slide is not cover-fitted.
 * - Video and audio posters (`a:videoFile`, `a:audioFile`, `p14:media`) keep their poster; the media is
 *   recorded for M5.
 *
 * Owned by work item C (inherit-emit).
 */
import type { BlipReader } from './color.ts';
import { partOf, type SlideCtx, type Source } from './context.ts';
import { chainOf, geometryOf } from './inherit.ts';
import type { ElementBase, Insets, PictureElement, PictureFill, ResidualElement } from './ir.ts';
import { externalHost } from './opc.ts';
import { child, num, path, type XNode } from './xml.ts';

/** Picture formats LibreOffice converts (M3): drawn by nothing in a browser, residual until then. */
export const METAFILE_EXTENSIONS: ReadonlySet<string> = new Set(['emf', 'wmf', 'emz', 'wmz', 'pict', 'pct']);
/** Raster formats a browser does not decode: picture preparation converts them (M3). */
export const PREPARED_EXTENSIONS: ReadonlySet<string> = new Set(['tif', 'tiff', 'wdp', 'hdp', 'jxr']);

/** Blip children that are not recolouring or effects. */
const NOT_EFFECTS = new Set(['#text', 'a:alphaModFix', 'a:extLst']);

/** A blip effect that changes nothing: `<a:lum/>` without brightness or contrast (PowerPoint writes it often). */
function noOp(fx: XNode): boolean {
  return fx.name === 'a:lum' && !num(fx.attrs.bright) && !num(fx.attrs.contrast);
}

/** `a:srcRect`/`a:fillRect` fractions; undefined when absent or all zero. */
export function readInsets(n: XNode | undefined): Insets | undefined {
  if (!n) return undefined;
  const f = (k: string) => {
    const v = (num(n.attrs[k]) ?? 0) / 100_000;
    return Math.min(1, Math.max(-1, v));
  };
  const out = { l: f('l'), t: f('t'), r: f('r'), b: f('b') };
  return out.l || out.t || out.r || out.b ? out : undefined;
}

/** The lower-case extension of a part name ('' when none). */
export function extensionOf(part: string): string {
  const slash = part.lastIndexOf('/');
  const dot = part.lastIndexOf('.');
  return dot > slash ? part.slice(dot + 1).toLowerCase() : '';
}

/** An `a:blipFill` of the part `source` as a picture fill, or undefined when its picture is missing. */
export function readBlipFill(ctx: SlideCtx, blipFill: XNode, source: string): PictureFill | undefined {
  const blip = child(blipFill, 'a:blip');
  const id = blip?.attrs['r:embed'] ?? blip?.attrs['r:link'];
  if (!blip || !id) return undefined;
  const rel = ctx.pkg.rel(source, id);
  if (!rel || rel.external || !ctx.pkg.has(rel.target)) {
    ctx.log(
      rel?.external
        ? `a linked picture (${externalHost(rel.target)}) was not imported`
        : 'a picture part is missing',
    );
    return undefined;
  }
  const out: PictureFill = { part: rel.target };
  const crop = readInsets(child(blipFill, 'a:srcRect'));
  if (crop) out.crop = crop;
  const fillRect = readInsets(child(child(blipFill, 'a:stretch'), 'a:fillRect'));
  if (fillRect) out.fillRect = fillRect;
  const tile = child(blipFill, 'a:tile');
  if (tile)
    out.tile = {
      tx: num(tile.attrs.tx) ?? 0,
      ty: num(tile.attrs.ty) ?? 0,
      sx: (num(tile.attrs.sx) ?? 100_000) / 100_000,
      sy: (num(tile.attrs.sy) ?? 100_000) / 100_000,
      flip: (tile.attrs.flip ?? 'none').slice(0, 10),
      algn: (tile.attrs.algn ?? 'tl').slice(0, 10),
    };
  const alpha = num(child(blip, 'a:alphaModFix')?.attrs.amt);
  if (alpha !== undefined) out.alpha = Math.min(1, Math.max(0, alpha / 100_000));
  const effects = effectsOf(blip);
  if (effects.length) out.effects = effects;
  const bytes = ctx.pkg.bytes(rel.target);
  const px = bytes?.length ? pictureSize(bytes) : ctx.pictureSize?.(rel.target);
  if (px) out.px = px;
  return out;
}

/** Effects kept per blip (names only). */
const MAX_EFFECTS = 16;
/** The effects of each blip read so far: an inherited picture fill is read for every inheriting shape. */
const effectsCache = new WeakMap<XNode, string[]>();

/** The recolouring and effect elements of a blip, in order (at most `MAX_EFFECTS`). Memoised per node. */
function effectsOf(blip: XNode): string[] {
  let out = effectsCache.get(blip);
  if (out) return out;
  out = [];
  for (const c of blip.children) {
    if (NOT_EFFECTS.has(c.name) || noOp(c)) continue;
    out.push(c.name.slice(0, 40));
    if (out.length >= MAX_EFFECTS) break;
  }
  effectsCache.set(blip, out);
  return out;
}

/**
 * A `p:pic` as a picture element, given the fields every element shares (placement, identity, chain), or
 * undefined when its picture cannot be found (logged). A metafile is a residual element, since nothing draws
 * it before M3 converts it, but its support is approx (design/27 §5: residual only when conversion fails).
 */
export function readPicture(
  ctx: SlideCtx,
  el: XNode,
  base: ElementBase,
): PictureElement | ResidualElement | undefined {
  const source = partOf(ctx, base.from);
  const blipFill = child(el, 'p:blipFill');
  const picture = blipFill && source !== undefined ? readBlipFill(ctx, blipFill, source) : undefined;
  if (!picture) return undefined;
  const ext = extensionOf(picture.part);
  if (METAFILE_EXTENSIONS.has(ext)) {
    ctx.log(`a ${ext} picture is not drawn yet (LibreOffice converts it in M3)`);
    return { ...base, kind: 'residual', what: 'metafile', support: 'approx', reasons: ['metafile'] };
  }
  // A picture placeholder takes its clip geometry from the layout or master when it has none.
  const { geom, adj } = geometryOf(chainOf(ctx, el, base.from));
  const out: PictureElement = { ...base, kind: 'picture', picture, geom, ...(adj ? { adj } : {}) };
  const reasons: string[] = [];
  if (PREPARED_EXTENSIONS.has(ext)) reasons.push(`pic:${ext}`);
  if (geom !== 'rect' && geom !== 'roundRect' && geom !== 'ellipse')
    reasons.push(`mask:${geom.slice(0, 30)}`);
  if (picture.effects?.length) reasons.push('recolor');
  if (reasons.length) {
    out.support = 'approx';
    out.reasons = reasons;
  }
  const media = mediaOf(ctx, el, source!);
  if (media) out.media = media;
  return out;
}

/** The video or audio a picture is the poster of (`a:videoFile`, `a:audioFile`, `p14:media`): M5. */
function mediaOf(ctx: SlideCtx, el: XNode, source: string): PictureElement['media'] {
  const nvPr = path(el, 'p:nvPicPr', 'p:nvPr');
  if (!nvPr) return undefined;
  const video = child(nvPr, 'a:videoFile');
  const audio = child(nvPr, 'a:audioFile') ?? child(nvPr, 'a:wavAudioFile');
  let media: XNode | undefined;
  for (const ext of path(nvPr, 'p:extLst')?.children ?? [])
    media ??= ext.children.find((c) => c.name === 'p14:media');
  if (!video && !audio && !media) return undefined;
  const out: NonNullable<PictureElement['media']> = { kind: video ? 'video' : audio ? 'audio' : 'video' };
  const rid = media?.attrs['r:embed'] ?? (video ?? audio)?.attrs['r:link'];
  const rel = rid === undefined ? undefined : ctx.pkg.rel(source, rid);
  if (rel?.external) out.external = externalHost(rel.target);
  else if (rel) out.part = rel.target;
  return out;
}

/** A blip reader for fills of the given source part (`color.ts` `readFill`). */
export function blipReader(ctx: SlideCtx, from: Source): BlipReader {
  const source = partOf(ctx, from);
  return (blipFill) => (source === undefined ? undefined : readBlipFill(ctx, blipFill, source));
}

/** A blip reader for fills in another part (a theme's bgFillStyleLst). */
export function blipReaderOf(ctx: SlideCtx, source: string | undefined): BlipReader {
  return (blipFill) => (source === undefined ? undefined : readBlipFill(ctx, blipFill, source));
}

/** JPEG markers read before giving up on finding the frame header. */
const MAX_JPEG_MARKERS = 4_096;
/** PNG chunks, or GIF blocks, read before the image data while looking for transparency. */
const MAX_HEADER_CHUNKS = 256;
/** Picture sides are bounded (design/27 §12: prepared pictures ≤ 8,192 px; headers can say anything). */
const MAX_SIDE_PX = 1_000_000;

/**
 * A picture's header facts: its pixel size, and `alpha`, whether it may have transparent pixels (an alpha
 * channel or a transparent colour; undefined when the bytes given end before the header tells).
 */
export interface PictureHeader {
  w: number;
  h: number;
  alpha?: boolean;
}

/**
 * A picture's pixel size from its header (PNG, JPEG, GIF, BMP, WebP), with whether it may be transparent
 * (`PictureHeader.alpha`), or undefined.
 */
export function pictureSize(b: Uint8Array): PictureHeader | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ok = (o: number, n: number) => o >= 0 && o + n <= b.length;
  const size = (w: number, h: number, alpha: boolean | undefined): PictureHeader | undefined =>
    w > 0 && h > 0 && w <= MAX_SIDE_PX && h <= MAX_SIDE_PX
      ? { w, h, ...(alpha !== undefined ? { alpha } : {}) }
      : undefined;
  if (ok(0, 24) && dv.getUint32(0) === 0x89504e47)
    return size(dv.getUint32(16), dv.getUint32(20), pngAlpha(b, dv));
  if (ok(0, 4) && dv.getUint16(0) === 0xffd8) {
    let o = 2;
    for (let n = 0; ok(o, 4) && n < MAX_JPEG_MARKERS; n++) {
      if (b[o] !== 0xff) return undefined;
      const m = b[o + 1]!;
      if (m === 0xff) {
        o++; // fill byte
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = dv.getUint16(o + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return ok(o + 5, 4) ? size(dv.getUint16(o + 7), dv.getUint16(o + 5), false) : undefined;
      if (len < 2) return undefined;
      o += 2 + len;
    }
    return undefined;
  }
  if (ok(0, 10) && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return size(dv.getUint16(6, true), dv.getUint16(8, true), gifAlpha(b));
  if (ok(0, 26) && b[0] === 0x42 && b[1] === 0x4d)
    return size(
      Math.abs(dv.getInt32(18, true)),
      Math.abs(dv.getInt32(22, true)),
      ok(28, 2) ? dv.getUint16(28, true) === 32 : undefined, // 32 bits a pixel may carry alpha
    );
  if (ok(0, 30) && dv.getUint32(0) === 0x52494646 && dv.getUint32(8) === 0x57454250) {
    const chunk = dv.getUint32(12);
    if (chunk === 0x56503820 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
      return size(dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff, false); // VP8
    if (chunk === 0x5650384c && b[20] === 0x2f) {
      const bits = dv.getUint32(21, true); // VP8L: 14 bits each, minus one, then alpha_is_used
      return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, ((bits >>> 28) & 1) === 1);
    }
    if (chunk === 0x56503858) {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)); // VP8X: 24 bits each, minus one
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return size(w, h, (b[20]! & 0x10) !== 0); // the alpha flag
    }
  }
  return undefined;
}

/**
 * Whether a PNG may be transparent: an alpha channel (grey or colour with alpha), else a `tRNS` chunk before
 * the image data. Undefined when the bytes end, or too many chunks come, before `IDAT`.
 */
function pngAlpha(b: Uint8Array, dv: DataView): boolean | undefined {
  if (b.length < 26) return undefined;
  const colorType = b[25]!;
  if (colorType === 4 || colorType === 6) return true;
  let o = 33; // after the signature and IHDR
  for (let n = 0; n < MAX_HEADER_CHUNKS && o + 8 <= b.length; n++) {
    const type = dv.getUint32(o + 4);
    if (type === 0x49444154) return false; // IDAT
    if (type === 0x74524e53) return true; // tRNS
    o += 12 + dv.getUint32(o);
  }
  return undefined;
}

/**
 * Whether a GIF's first frame may be transparent: its graphic control extension sets the transparent
 * colour flag. Undefined when the bytes end, or too many blocks come, before the first image.
 */
function gifAlpha(b: Uint8Array): boolean | undefined {
  if (b.length < 13) return undefined;
  const flags = b[10]!;
  let o = 13 + (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0); // after the global colour table
  for (let n = 0; n < MAX_HEADER_CHUNKS && o < b.length; n++) {
    const block = b[o]!;
    if (block === 0x2c || block === 0x3b) return false; // an image, or the end
    if (block !== 0x21 || o + 2 > b.length) return undefined;
    if (b[o + 1] === 0xf9) return o + 3 < b.length ? (b[o + 3]! & 1) === 1 : undefined;
    o += 2; // an extension: skip its sub-blocks
    for (let k = 0; k < MAX_HEADER_CHUNKS && o < b.length && b[o] !== 0; k++) o += 1 + b[o]!;
    if (b[o] !== 0) return undefined;
    o++;
  }
  return undefined;
}
