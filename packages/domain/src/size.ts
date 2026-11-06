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
import type { Presentation, Section, Slide, SlideObject } from './schemas.ts';

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
  /**
   * The operator refuses to send `live.adopt` (or a `preview`) above this instead of tripping the socket
   * cap: the hub would close the socket, the operator reconnect and try again, forever.
   */
  adoptMax: 15 * MiB,
  /** The hub closes a socket whose `preview` or `live.adopt` message is larger (`ws.ts`). */
  socketMax: 16 * MiB,
  /** The hub's HTTP body limit (`http.ts`), PUT /presentations included. */
  putMax: 32 * MiB,
  /** A year of weekly sermon decks (52 imports of 17 slides, with their pictures) keeps the library snapshot below this (tested). */
  librarySnapshotYear: 6_000_000,
  /**
   * Hub health reports the library snapshot's size; past this the hub logs that a venue needs summary-only
   * snapshots (bodies fetched on open), the follow-up design/27 §3.4 leaves out.
   */
  librarySnapshotWarn: 32 * MiB,
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

/** A size for people: "13.2 MiB", "640 KiB", "512 bytes". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < KiB) return `${Math.max(0, Math.round(n) || 0)} bytes`;
  if (n < MiB) return `${Math.round(n / KiB)} KiB`;
  return `${(Math.floor((n / MiB) * 10) / 10).toFixed(1)} MiB`;
}

// ── Import ──────────────────────────────────────────────────────────────────────────────────────────────

/** The compact size `planImportSizes` assumes for a slide when no estimate is given. */
export const COMPACT_SLIDE_BYTES = 512;
/**
 * What `planImportSizes` keeps free of slides by default: the presentation's own fields, its sections and
 * arrangement, and the import log (`source.log`, at most 200,000 characters).
 */
export const IMPORT_RESERVE_BYTES = 256 * KiB;
/** The longest `pptx.artText` a compact slide keeps (the schema's text bound). */
const ART_TEXT_MAX = 20_000;

/** Why the import plan made a slide compact: over `slideMax` on its own, or the presentation's budget. */
export type ImportCompactReason = 'slide' | 'presentation';

export type ImportSizePlan = {
  /** One flag per slide: true = compact picture class. */
  compact: boolean[];
  /** Why each compact slide is compact; null for a slide that keeps its objects. */
  reasons: (ImportCompactReason | null)[];
  /** The presentation's slides' JSON size after the plan (compact slides at their compact size), reserve excluded. */
  total: number;
  /** Slides compact because they alone are over `slideMax`. */
  oversized: number;
  /** Slides compact because of the presentation budget: the tail the import card reports. */
  tail: number;
  /** The first slide of that tail (every later slide is compact too); -1 when there is none. */
  tailFrom: number;
  /** False only when even an all-compact presentation (with the reserve) is over `presentationMax`. */
  fits: boolean;
};

/**
 * The import budget of design/27 §3.4: which slides keep their objects and which use the compact picture
 * class. `sizes[i]` is slide i's JSON size as it would be stored with its objects; `compactBytes` is the size
 * of a compact slide (its provenance, page text and later page picture, no objects), one number for every
 * slide or one per slide (`compactSlideBytes`). `reserve` is what the presentation holds besides its
 * slides (fields, sections, arrangements, `source.log`).
 *
 * A slide over `slideMax` is compact on its own. Otherwise a slide keeps its objects while the running
 * total has not passed `presentationCompact` and the slides after it would still fit within
 * `presentationMax - reserve` as compact slides. The first slide that fails either test starts the tail:
 * it and every later slide are compact, so the import card can say "slide n and later". The presentation is
 * within `presentationMax` whenever an all-compact one is (`fits`).
 */
export function planImportSizes(
  sizes: readonly number[],
  compactBytes: number | readonly number[] = COMPACT_SLIDE_BYTES,
  reserve: number = IMPORT_RESERVE_BYTES,
): ImportSizePlan {
  const n = sizes.length;
  const clean = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const compactOf = (i: number) =>
    typeof compactBytes === 'number' ? clean(compactBytes) : clean(compactBytes[i] ?? COMPACT_SLIDE_BYTES);
  const max = SIZE_BUDGETS.presentationMax - clean(reserve);
  // after[i]: the slides after i, all compact.
  const after = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) after[i] = after[i + 1]! + compactOf(i);
  const plan: ImportSizePlan = {
    compact: [],
    reasons: [],
    total: 0,
    oversized: 0,
    tail: 0,
    tailFrom: -1,
    fits: after[0]! <= max,
  };
  let closed = false;
  for (let i = 0; i < n; i++) {
    const size = clean(sizes[i]);
    const over = size > SIZE_BUDGETS.slideMax;
    // An oversized slide is compact whatever the total, so only its compact size counts here.
    closed ||=
      plan.total > SIZE_BUDGETS.presentationCompact ||
      plan.total + (over ? compactOf(i) : size) + after[i + 1]! > max;
    let reason: ImportCompactReason | null = null;
    if (over) reason = 'slide';
    else if (closed) reason = 'presentation';
    if (reason === 'presentation' && plan.tailFrom < 0) plan.tailFrom = i;
    if (reason === 'slide') plan.oversized++;
    if (reason === 'presentation') plan.tail++;
    plan.compact.push(reason !== null);
    plan.reasons.push(reason);
    plan.total += reason ? compactOf(i) : size;
  }
  return plan;
}

function isText(o: SlideObject): o is Extract<SlideObject, { type: 'text' }> {
  return o.type === 'text';
}

/** At most `n` UTF-16 units of `s`, never ending inside a surrogate pair. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/**
 * The compact picture-class form of an imported slide, as version 1 stores it (design/27 §5, README of
 * `apps/hub/src/pptx`): no objects, LibreOffice work pending, and the slide's text in `pptx.artText` for
 * search and labels, followed by the text already baked into art (`artText`, else the slide's own
 * `pptx.artText`: a hybrid slide's art is part of the page too). Everything else (speaker notes, timing,
 * background, hidden, transition, provenance) is kept. A slide without provenance only loses its objects.
 */
export function compactSlide(slide: Slide, artText?: string): Slide {
  const { lyricObjectId: _lyric, ...rest } = slide;
  if (!slide.pptx) return { ...rest, objects: [] };
  const own = slide.objects.filter(isText).map((o) => o.text);
  const baked = artText ?? slide.pptx.artText ?? '';
  const text = cut([...own, baked].filter(Boolean).join('\n'), ART_TEXT_MAX);
  const { artText: _art, ...pptx } = slide.pptx;
  return {
    ...rest,
    objects: [],
    pptx: { ...pptx, class: 'picture', pending: true, ...(text ? { artText: text } : {}) },
  };
}

/**
 * The JSON size of an imported slide once compact, after the LibreOffice follow-up too: `compactSlide`
 * plus version 2's `imported` record (the page picture and one text box per text object, keyed by shown
 * slide). This is the estimate `planImportSizes` takes per slide.
 */
export function compactSlideBytes(slide: Slide, artText?: string): number {
  const c = compactSlide(slide, artText);
  const imported = {
    fileId: c.pptx?.fileId || 'x'.repeat(64),
    page: c.pptx?.shown ?? c.pptx?.index ?? 0,
    imageMediaId: 'x'.repeat(26),
    textBoxes: slide.objects
      .filter(isText)
      .slice(0, 1000)
      .map((o) => ({ text: o.text, box: o.box, fontSizePx: o.style.fontSizePx })),
    textAligned: true,
  };
  return jsonBytes({ ...c, imported });
}

// ── Preview ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What "Send to preview" sends (design/27 §3.4): the presentation-level fields with only the previewed
 * slide's section, so a preview stays far below the socket cap however large the presentation is. The slide
 * after it travels too, for the look's next-slide band (`planPreview` takes the first shown slide after it in
 * section order, hidden slides skipped as Next skips them): in its own section when it is in a later one. Without `slideId` the first slide is previewed, as
 * `planPreview` does; an unknown `slideId` leaves no slides (the output shows its idle frame).
 *
 * Arrangements, chords and the import log are left out (an output never reads them). A section over `max`
 * is cut to the previewed slide and the one after it, and that pair to the slide alone; a single slide over
 * `max` is still sent (the caller checks the socket cap).
 */
export function previewSlice(
  p: Presentation,
  slideId?: string,
  max: number = SIZE_BUDGETS.previewMax,
): Presentation {
  const sections = p.sections;
  let si = -1;
  let k = -1;
  for (let i = 0; i < sections.length && si < 0; i++) {
    const slides = sections[i]!.slides;
    const j = slideId === undefined ? (slides.length ? 0 : -1) : slides.findIndex((s) => s.id === slideId);
    if (j >= 0) {
      si = i;
      k = j;
    }
  }
  const head: Presentation = { ...p, sections: [], arrangements: [] };
  if (p.source) {
    const { log: _log, ...source } = p.source;
    head.source = source;
  }
  if (si < 0) return head;
  const bare = (s: Section): Section => {
    const { chords: _chords, ...rest } = s;
    return { ...rest, slides: [] };
  };
  const sec = sections[si]!;
  const slide = sec.slides[k]!;
  // The next slide as Next goes (`planPreview`, the live planner's `nextShownCue`): hidden slides skipped.
  const shown = (x: Slide) => x.hidden !== true;
  let next = sec.slides.slice(k + 1).find(shown);
  let nextSec: Section | undefined;
  for (let i = si + 1; i < sections.length && !next; i++) {
    next = sections[i]!.slides.find(shown);
    if (next) nextSec = sections[i]!;
  }
  const own = bare(sec);
  const tail = nextSec && next ? [{ ...bare(nextSec), slides: [next] }] : [];
  const sized = (slides: Slide[]) => ({ ...head, sections: [{ ...own, slides }, ...tail] });
  // The whole section when it fits; counted slide by slide, so a huge section is never serialised whole.
  let room = max - jsonBytes(sized([]));
  for (const s of sec.slides) {
    room -= slideBytes(s) + 1;
    if (room < 0) break;
  }
  if (room >= 0) return sized(sec.slides);
  const pair = sized(nextSec || !next ? [slide] : [slide, next]);
  if (jsonBytes(pair) <= max) return pair;
  return { ...head, sections: [{ ...own, slides: [slide] }] };
}

// ── Resolved playlists ──────────────────────────────────────────────────────────────────────────────────

/**
 * The `degraded` warning of a resolved playlist above `resolvedWarn` (design/27 §3.4), or undefined. The
 * operator PC carries a service it took over in its whole live state, and hands it back to the hub in one
 * `live.adopt` message, which the socket caps; above the warning that hand-back may be refused.
 */
export function resolvedSizeWarning(bytes: number): string | undefined {
  if (!(bytes > SIZE_BUDGETS.resolvedWarn)) return undefined;
  return (
    `This service is ${formatBytes(bytes)}, too large for an operator takeover (over ${formatBytes(SIZE_BUDGETS.resolvedWarn)}): ` +
    'if the hub is lost during the service, this PC keeps the outputs running but may only hand the service back after End service. ' +
    'Fewer or smaller presentations in the playlist keep it below.'
  );
}
