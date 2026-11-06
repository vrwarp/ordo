/**
 * JSON size estimates and budgets (design/27 §3.4, M3). Whole presentations travel in goLive (to every
 * client, the journal, snapshots and cached bundles), `preview` and `live.adopt` (16 MiB: the socket is
 * closed above it), PUT (32 MiB), library snapshots and revisions. Imported PowerPoint slides are about ten
 * times larger than picture slides, so every path that carries them checks its budget here.
 *
 * Sizes are UTF-8 bytes of `JSON.stringify`, what a socket message or an HTTP body carries. Pure; usable in
 * the hub, the operator and workers.
 */
import type { ResolvedPlaylist } from './live.ts';
import type { Presentation, Slide } from './schemas.ts';

const KiB = 1024;
const MiB = 1024 * KiB;

export const SIZE_BUDGETS = {
  /** A typical imported slide (measured 3.4 KB). */
  slideTypical: 8 * KiB,
  /** An imported slide larger than this becomes picture class (logged). */
  slideMax: 64 * KiB,
  /** Once an import's running total passes this, the remaining slides use the compact picture class. */
  presentationCompact: 3 * MiB,
  /** An import stays within this; the editor warns above it but still saves (PUT allows `putMax`). */
  presentationMax: 4 * MiB,
  /** A `preview` message: only the previewed slide's section is sent (`previewSlice`). */
  previewMax: 1 * MiB,
  /** `resolvePlaylist` adds a `degraded` warning above this: too large for an operator takeover. */
  resolvedWarn: 12 * MiB,
  /** The operator refuses `live.adopt` locally above this instead of tripping the socket cap. */
  adoptMax: 15 * MiB,
  /** The hub closes a socket whose `preview` or `live.adopt` message is larger (`ws.ts`). */
  socketMax: 16 * MiB,
  /** The hub's HTTP body limit (`http.ts`), PUT /presentations included. */
  putMax: 32 * MiB,
} as const;

/** UTF-8 length of a string (JSON.stringify never leaves a lone surrogate: it escapes them). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** UTF-8 bytes of `JSON.stringify(v)`; 0 when `v` has no JSON form (undefined, a function). */
export function jsonBytes(v: unknown): number {
  const s = JSON.stringify(v);
  return s === undefined ? 0 : utf8Bytes(s);
}

export function slideBytes(s: Slide): number {
  return jsonBytes(s);
}

export function presentationBytes(p: Presentation): number {
  return jsonBytes(p);
}

/** The size of a resolved playlist as goLive, `live.adopt` and the journal carry it. */
export function resolvedBytes(r: ResolvedPlaylist): number {
  return jsonBytes(r);
}

/**
 * The import budget of design/27 §3.4: which slides keep their objects and which use the compact picture
 * class. `sizes[i]` is slide i's JSON size with its objects; a compact slide is counted as `compactBytes`
 * (its picture, provenance and bounded text, no objects). A slide keeps its objects while it is within
 * `slideMax`, the running total has not passed `presentationCompact`, and the slides after it still fit
 * within `presentationMax` as compact slides; once the total passes `presentationCompact`, every later
 * slide is compact. Returns one flag per slide (true = compact) and the resulting total.
 */
export function planImportSizes(
  sizes: readonly number[],
  compactBytes = 512,
): { compact: boolean[]; total: number } {
  const compact: boolean[] = [];
  let total = 0;
  let closed = false;
  for (let i = 0; i < sizes.length; i++) {
    const raw = sizes[i]!;
    const size = Number.isFinite(raw) && raw > 0 ? raw : 0;
    const after = (sizes.length - i - 1) * compactBytes;
    closed ||= total > SIZE_BUDGETS.presentationCompact;
    const keep =
      !closed && size <= SIZE_BUDGETS.slideMax && total + size + after <= SIZE_BUDGETS.presentationMax;
    compact.push(!keep);
    total += keep ? size : compactBytes;
  }
  return { compact, total };
}
