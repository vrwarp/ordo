/**
 * `--before hub` (design/27 §15 M9's exit, the M9 plan §6.2): the score of what a hub with LibreOffice
 * showed of each slide before M9, next to the native column's own score (`nativeSsim`: residual elements
 * draw nothing, so a hybrid slide's art box is blank). Written as `perSlide.beforeHubSsim`.
 *
 * - A slide the hub stores as a picture (`census.ts` `hubClasses`: the converter's picture class, or the
 *   hub's §3.4 budgets) shows LibreOffice's page: it scores 1 against LibreOffice by construction.
 * - A hybrid slide shows its native objects with LibreOffice's art over the art box (version 2), and a slide
 *   with metafile pictures shows them as LibreOffice converts them. Both are approximated by pasting
 *   LibreOffice's pixels inside those boxes (grown by 2 px before and 3 px after, as the M6 scratch scorer
 *   did) over the native page, then scoring the result as the native page is scored. Inside a box the paste
 *   also takes LibreOffice's background and whatever else it drew there, so the score is an upper bound of
 *   the hub's real version 2, which draws only the art's elements.
 * - Any other slide shows what the native column drew: its own score.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pngSize, ssim } from './ssim.ts';

const run = promisify(execFile);

export type Box = { x: number; y: number; w: number; h: number; rotation?: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** What the hub showed of a slide before M9: its class there, the art box and the pending metafiles. */
export type HubBefore = {
  hub: 'native' | 'hybrid' | 'picture';
  art?: Box;
  metafiles?: readonly Box[];
};

/** Regions pasted in one picture at most; past it, their bounding box is pasted. */
export const MAX_PASTES = 32;
/** px a region is grown by before (left, top) and after (right, bottom) its box, at the page's scale. */
const GROW_BEFORE = 2;
const GROW_AFTER = 3;

/** The axis-aligned bounds of a box turned by its rotation (degrees) about its centre. */
export function boundsOf(b: Box): Rect {
  const r = ((b.rotation ?? 0) * Math.PI) / 180;
  if (!r) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  const w = b.w * c + b.h * s;
  const h = b.w * s + b.h * c;
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
}

/** The logical regions LibreOffice's pixels are pasted in for a slide (none: the native page as drawn). */
export function pasteRegions(s: HubBefore): Rect[] {
  if (s.hub === 'picture') return [];
  const out: Rect[] = [];
  if (s.hub === 'hybrid' && s.art) out.push(boundsOf(s.art));
  for (const m of s.metafiles ?? []) out.push(boundsOf(m));
  const ok = out.filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0);
  if (ok.length <= MAX_PASTES) return ok;
  const x0 = Math.min(...ok.map((r) => r.x));
  const y0 = Math.min(...ok.map((r) => r.y));
  const x1 = Math.max(...ok.map((r) => r.x + r.w));
  const y1 = Math.max(...ok.map((r) => r.y + r.h));
  return [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }];
}

/** A whole-pixel region of a page. */
export type PxRect = { x: number; y: number; w: number; h: number };

/**
 * A logical region in the px of a page `w` x `h` that shows the slide area `rect` (scale: the page's height
 * over the area's, or its width over the area's where that is smaller, as LibreOffice rounds a page up by a
 * pixel), grown and cut to the page. Undefined when nothing of it is on the page.
 */
export function pagePx(r: Rect, rect: Rect, w: number, h: number): PxRect | undefined {
  const s = Math.min(w / rect.w, h / rect.h);
  if (!(s > 0)) return undefined;
  const x0 = Math.max(0, Math.trunc((r.x - rect.x) * s) - GROW_BEFORE);
  const y0 = Math.max(0, Math.trunc((r.y - rect.y) * s) - GROW_BEFORE);
  const x1 = Math.min(w, Math.trunc((r.x + r.w - rect.x) * s) + GROW_AFTER);
  const y1 = Math.min(h, Math.trunc((r.y + r.h - rect.y) * s) + GROW_AFTER);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

/**
 * Write `dest` (PNG): the page `native` with LibreOffice's pixels of each region (logical px of the slide
 * area `rect`) pasted over it, LibreOffice's page scaled to the native page's where their sizes differ.
 * False, with nothing written, when no region is on the page.
 */
export async function pasteLibreOffice(
  native: string,
  lo: string,
  regions: readonly Rect[],
  rect: Rect,
  dest: string,
): Promise<boolean> {
  const n = await pngSize(native);
  const l = await pngSize(lo);
  if (!n || !l) throw new Error('not a PNG');
  const pastes: { at: PxRect; from: PxRect }[] = [];
  for (const r of regions) {
    const at = pagePx(r, rect, n.w, n.h);
    if (!at) continue;
    // The same region in LibreOffice's px: the native page's px back to the slide area, then onto LibreOffice's.
    const k = Math.min(l.w / n.w, l.h / n.h);
    const fx = Math.min(l.w - 1, Math.max(0, Math.round(at.x * k)));
    const fy = Math.min(l.h - 1, Math.max(0, Math.round(at.y * k)));
    const from = {
      x: fx,
      y: fy,
      w: Math.max(1, Math.min(l.w - fx, Math.round(at.w * k))),
      h: Math.max(1, Math.min(l.h - fy, Math.round(at.h * k))),
    };
    pastes.push({ at, from });
  }
  if (!pastes.length) return false;
  // [c0] the native page; each paste is cut from LibreOffice's page, scaled, and laid over the last result.
  const lo1 = (i: number) => (pastes.length > 1 ? `[s${i}]` : '[1:v]');
  const chains = [
    ...(pastes.length > 1 ? [`[1:v]split=${pastes.length}${pastes.map((_, i) => `[s${i}]`).join('')}`] : []),
    '[0:v]format=rgb24[c0]',
    ...pastes.flatMap((p, i) => [
      `${lo1(i)}crop=${p.from.w}:${p.from.h}:${p.from.x}:${p.from.y},scale=${p.at.w}:${p.at.h}:flags=bicubic,format=rgb24[p${i}]`,
      `[c${i}][p${i}]overlay=${p.at.x}:${p.at.y}:format=rgb[c${i + 1}]`,
    ]),
  ];
  await run(
    'ffmpeg',
    [
      ...['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', native, '-i', lo],
      ...['-filter_complex', chains.join(';'), '-map', `[c${pastes.length}]`, '-frames:v', '1', dest],
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  return true;
}

/**
 * The before-hub score of one slide against LibreOffice's page `lo` (see the module comment): 1 for a hub
 * picture slide, `nativeSsim` when there is nothing to paste, else the SSIM of the pasted page (written to
 * `scratch`, which the caller deletes).
 */
export async function beforeHubSsim(
  s: HubBefore,
  page: { lo: string; native: string; nativeSsim: number; rect: Rect; scratch: string },
): Promise<number> {
  if (s.hub === 'picture') return 1;
  const regions = pasteRegions(s);
  if (!regions.length) return page.nativeSsim;
  if (!(await pasteLibreOffice(page.native, page.lo, regions, page.rect, page.scratch)))
    return page.nativeSsim;
  return ssim(page.lo, page.scratch);
}
