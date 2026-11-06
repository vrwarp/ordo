/**
 * Pictures: `p:pic` and every `a:blipFill` (design/27 §4 "Pictures").
 *
 * Owned by work item C (inherit-emit). The scaffold resolves the blip's part and reads srcRect, fillRect,
 * tile and alphaModFix. Still to do: `svgBlip` → its PNG fallback, `a14:imgProps` layers drawn as is,
 * recolour effects listed for M3, metafiles (EMF/WMF) noted for LibreOffice, external (linked) pictures
 * logged with their host, video/audio posters (M5).
 */
import type { BlipReader } from './color.ts';
import { partOf, type SlideCtx, type Source } from './context.ts';
import type { Insets, PictureElement, PictureFill } from './ir.ts';
import { child, num, type XNode } from './xml.ts';

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

/** An `a:blipFill` of the part `source` as a picture fill, or undefined when its picture is missing. */
export function readBlipFill(ctx: SlideCtx, blipFill: XNode, source: string): PictureFill | undefined {
  const blip = child(blipFill, 'a:blip');
  const id = blip?.attrs['r:embed'];
  if (!blip || !id) return undefined;
  const rel = ctx.pkg.rel(source, id);
  if (!rel || rel.external || !ctx.pkg.has(rel.target)) {
    ctx.log(rel?.external ? 'a linked picture was not imported' : 'a picture part is missing');
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
      flip: tile.attrs.flip ?? 'none',
      algn: tile.attrs.algn ?? 'tl',
    };
  const alpha = num(child(blip, 'a:alphaModFix')?.attrs.amt);
  if (alpha !== undefined) out.alpha = Math.min(1, Math.max(0, alpha / 100_000));
  const effects = blip.children
    .filter((c) => c.name !== '#text' && c.name !== 'a:alphaModFix')
    .map((c) => c.name);
  if (effects.length) out.effects = effects;
  return out;
}

/**
 * A `p:pic` as a picture element, given the fields every element shares (placement, identity, chain), or
 * undefined when its picture cannot be found (logged).
 */
export function readPicture(
  ctx: SlideCtx,
  el: XNode,
  base: Omit<PictureElement, 'kind' | 'picture' | 'geom'>,
): PictureElement | undefined {
  const source = partOf(ctx, base.from);
  const blipFill = child(el, 'p:blipFill');
  const picture = blipFill && source !== undefined ? readBlipFill(ctx, blipFill, source) : undefined;
  if (!picture) return undefined;
  const geom = child(child(el, 'p:spPr'), 'a:prstGeom')?.attrs.prst ?? 'rect';
  return { ...base, kind: 'picture', picture, geom };
}

/** A blip reader for fills of the given source part (`color.ts` `readFill`). */
export function blipReader(ctx: SlideCtx, from: Source): BlipReader {
  const source = partOf(ctx, from);
  return (blipFill) => (source === undefined ? undefined : readBlipFill(ctx, blipFill, source));
}
