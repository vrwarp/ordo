import { fileUrl } from '@ordo/client';
import {
  type Box,
  isSvgMime,
  type Media,
  SVG_HEAD_BYTES,
  type SvgSize,
  svgIntrinsicSize,
} from '@ordo/domain';

/*
 * The box a picture starts in when it is inserted or pasted into a slide: its pixel size, at most the slide's
 * width, centred. An SVG's media size is its still's, drawn at least 1,920 px on its longer side
 * (`SVG_RASTER.minLong`), so it starts at the size its root element declares instead (a 200 x 80 logo starts at
 * 200 x 80, not slide-wide: the 2026-11-13 review), or half the slide's width at its ratio when it declares
 * only a viewBox (its units say nothing of a size on the slide).
 */

/** The insert box of `m`; `declared` is an SVG's own size (`svgDeclared`). */
export function insertBox(m: Pick<Media, 'width' | 'height'>, declared?: SvgSize): Box {
  let sw = m.width;
  let sh = m.height;
  const ok = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (declared && ok(declared.width) && ok(declared.height)) {
    sw = declared.width;
    sh = declared.height;
  } else if (declared?.viewBox && ok(declared.viewBox.width) && ok(declared.viewBox.height)) {
    sw = 960;
    sh = (960 * declared.viewBox.height) / declared.viewBox.width;
  }
  const sized = ok(sw) && ok(sh);
  const w = sized ? Math.min(1920, sw!) : 960;
  const h = sized ? (w * sh!) / sw! : 540;
  return {
    x: Math.round((1920 - w) / 2),
    y: Math.max(0, Math.round((1080 - h) / 2)),
    w: Math.round(w),
    h: Math.min(1080, Math.round(h)),
    rotation: 0,
  };
}

/** The first `SVG_HEAD_BYTES` of a stored file, as text. */
async function storedHead(hash: string): Promise<string> {
  const res = await fetch(fileUrl(hash), { headers: { range: `bytes=0-${SVG_HEAD_BYTES - 1}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new TextDecoder().decode((await res.arrayBuffer()).slice(0, SVG_HEAD_BYTES));
}

/**
 * The size an SVG media item's root element declares (`svgIntrinsicSize` over its original's first bytes);
 * undefined for any other picture, or when they cannot be read (the insert then uses the media size).
 */
export async function svgDeclared(
  m: Pick<Media, 'original'>,
  read: (hash: string) => Promise<string> = storedHead,
): Promise<SvgSize | undefined> {
  if (!isSvgMime(m.original.mime)) return undefined;
  try {
    return svgIntrinsicSize(await read(m.original.hash));
  } catch {
    return undefined;
  }
}
