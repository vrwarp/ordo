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
import type { MissingKind } from './missing.ts';
import { formatPathData, PATH_DATA_LIMITS, parsePathData } from './pathdata.ts';
import type {
  Box,
  DecorData,
  Presentation,
  Section,
  ShapeGeom,
  ShapeObject,
  Slide,
  SlideObject,
  TableData,
  TextObject,
} from './schemas.ts';

const KiB = 1024;
const MiB = 1024 * KiB;

export const SIZE_BUDGETS = {
  /** A typical imported slide (measured 3.4 KB). */
  slideTypical: 8 * KiB,
  /**
   * An imported slide is kept within this: past it, the budget ladder (`fitSlideBudget`, M9) re-grids its
   * outlines, then drops text formatting, then decorations, never making it a picture (logged).
   */
  slideMax: 64 * KiB,
  /**
   * Once an import's running total passes this, the remaining slides are stored minimal: their text, pictures
   * and background (`minimalSlide`; the compact picture class before M9).
   */
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
  /** One flag per slide: true = stored in its compact form (M9: minimal, `minimalSlide`). */
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
 * The import budget of design/27 §3.4: which slides keep their objects and which take their compact form.
 * `sizes[i]` is slide i's JSON size as it would be stored with its objects; `compactBytes` is the size of its
 * compact form, one number for every slide or one per slide. Since M9 (`ladder`) the compact form is the
 * minimal native slide (`minimalSlide`: its text, pictures and background), never a picture: the hub passes
 * each slide's size after `fitSlideBudget` and its minimal form's size. (Before M9 it was the picture slide of
 * `compactSlideBytes`.) `reserve` is what the presentation holds besides its slides (fields, sections,
 * arrangements, `source.log`).
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
 * The compact picture-class form of an imported slide, as version 1 stored it before M9 (design/27 §5, README
 * of `apps/hub/src/pptx`; the native import stores `minimalSlide` instead since M9's budget ladder): no objects, LibreOffice work pending, and the slide's text in `pptx.artText` for
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

// ── The budget ladder (design/27 §3.4, M9 `ladder`) ─────────────────────────────────────────────────────

/**
 * The levels of `fitSlideBudget`, richest first: as given; outlines re-gridded (lossless on screen); text
 * formatting dropped; decorations left out. None makes a picture.
 */
export type BudgetLevel = 'full' | 'grid' | 'plain' | 'minimal';
export const BUDGET_LEVELS: readonly BudgetLevel[] = ['full', 'grid', 'plain', 'minimal'];

/**
 * The grid of the `grid` level, in logical px: a stored point moves at most half of it (1/32 px). Measured on
 * the worship set with every inline outline re-gridded: a quarter-pixel grid (lo-dependencies §4.5) moved the
 * anti-aliasing of thin full-width rules enough to cost three slides 0.004-0.009 SSIM; at 1/16 px no slide
 * moves by more than the exit's 0.002, and float coordinates still shrink to short integers.
 */
export const GRID_PX = 1 / 16;

/**
 * Measurements `fitSlideBudget` takes per level before it drops the rest of a level's candidates at once: a
 * slide of 1,000 objects costs a bounded number of `size` calls, whatever the caller's measure costs.
 */
const MAX_MEASURES = 24;

export type BudgetFit = {
  /** The slide at `level` (the input itself at 'full'; never mutated). */
  slide: Slide;
  level: BudgetLevel;
  /** Its size as the caller's `size` measures it. */
  bytes: number;
  /** Objects left out ('minimal'): shapes, the largest first; never text, pictures or tables. */
  dropped: number;
  /** Text objects and tables written without their runs and paragraph styles ('plain', 'minimal'). */
  plain: number;
  /** What the left-out objects drew, as `Slide.pptx.missing` kinds ('decoration', 'chart'), each once. */
  missing: MissingKind[];
};

export type FitOptions = {
  /**
   * The slide's size as its store counts it (the hub: sanitized, parsed, with its provenance); default
   * `slideBytes`. A measure that throws or answers a non-finite number counts as `slideBytes`.
   */
  size?: (slide: Slide) => number;
};

/**
 * The richest form of an imported slide within `max` bytes (design/27 §3.4, M9; plan decision 3, step 4):
 *
 * 1. **full**: the slide as it is.
 * 2. **grid**: every inline outline (a shape's `geom.paths`, a picture's `mask.paths`, a decoration's inline
 *    parts) re-expressed on an integer grid of `GRID_PX` of its box (`gridSlide`): no point moves more than
 *    1/32 logical px (1/16 device px at 4K). Applied only past the budget.
 * 3. **plain**: the grid form with the runs and paragraph styles of its text objects and tables dropped, the
 *    largest formatting first, until it fits (text and box style kept, so search and the lyric box read the
 *    same text).
 * 4. **minimal**: the grid form with its shapes left out, the largest first (a table never: it holds text,
 *    nor the slide's background drawn as a shape, origin role 'bg': `isBackground`), then, if still over, its
 *    formatting dropped as in `plain`. Text objects, pictures and the background stay: every text survives,
 *    on the page it was written for. A slide whose text alone passes `max` is returned minimal and over it.
 *
 * Pure and deterministic; never throws, and never mutates `slide`.
 */
export function fitSlideBudget(
  slide: Slide,
  max: number = SIZE_BUDGETS.slideMax,
  opts: FitOptions = {},
): BudgetFit {
  const limit = Number.isFinite(max) && max > 0 ? max : SIZE_BUDGETS.slideMax;
  const size = (s: Slide): number => {
    try {
      const n = opts.size ? opts.size(s) : slideBytes(s);
      return Number.isFinite(n) && n >= 0 ? n : slideBytes(s);
    } catch {
      return slideBytes(s);
    }
  };
  const fit = (s: Slide, level: BudgetLevel, bytes: number, extra: Partial<BudgetFit> = {}): BudgetFit => ({
    slide: s,
    level,
    bytes,
    dropped: 0,
    plain: 0,
    missing: [],
    ...extra,
  });
  const full = size(slide);
  if (full <= limit) return fit(slide, 'full', full);
  const grid = gridSlide(slide);
  const gridBytes = size(grid);
  if (gridBytes <= limit) return fit(grid, 'grid', gridBytes);
  const plain = shed(grid, formattingCandidates(objectsOf(grid)), limit, gridBytes, size);
  if (plain.bytes <= limit) return fit(plain.slide, 'plain', plain.bytes, { plain: plain.applied.length });
  // Minimal: from the grid form, so a slide whose shapes alone pass the budget keeps its formatting.
  const bare = shed(grid, dropCandidates(objectsOf(grid)), limit, gridBytes, size);
  const left =
    bare.bytes <= limit
      ? undefined
      : shed(bare.slide, formattingCandidates(objectsOf(bare.slide)), limit, bare.bytes, size);
  const missing: MissingKind[] = [];
  for (const c of bare.applied) {
    const k = c.kind ?? 'decoration';
    if (!missing.includes(k)) missing.push(k);
  }
  const out = left ?? bare;
  return fit(withLyric(out.slide), 'minimal', out.bytes, {
    dropped: bare.applied.length,
    plain: left?.applied.length ?? 0,
    missing,
  });
}

/**
 * The smallest form of a slide that keeps every text and picture (`fitSlideBudget`'s minimal level with
 * everything it may drop dropped): its shapes left out (tables kept), every text object and table without
 * runs and paragraph styles, and the background kept: `backgroundMediaId`, and a background drawn as a shape
 * (origin role 'bg', the converter's page colour or the white under a background picture with alpha) as the
 * slide's background colour alone (`plainBackground`: the bottom one, a plain rect in its colour, about 200
 * bytes), so dark text is never drawn on the output's black. What the presentation's tail is stored as
 * (`planImportSizes`, which counts those bytes), and what an import keeps of a slide the schema refuses.
 * `page: false` leaves that shape out too: the hub's last resort for a deck that does not fit 4 MiB even
 * minimal with its pages (about 2,000 slides), where 200 bytes a slide would cut every slide's text. Pure.
 */
export function minimalSlide(slide: Slide, opts: { page?: boolean } = {}): Slide {
  const objects: SlideObject[] = [];
  let page = opts.page === false;
  for (const o of objectsOf(slide)) {
    if (o.type === 'shape') {
      if (o.table) objects.push(plainTable(o));
      else if (!page && isBackground(o)) {
        const bg = plainBackground(o);
        if (bg) {
          objects.push(bg);
          page = true;
        }
      }
      continue;
    }
    objects.push(o.type === 'text' ? plainText(o) : o);
  }
  return withLyric({ ...slide, objects });
}

/**
 * A background drawn as a shape as its colour alone: a plain rect over its box in its fill (else its
 * gradient's first stop, the colour an older build draws), at its opacity, keeping its id, origin and lock;
 * undefined when it paints nothing.
 */
function plainBackground(o: Extract<SlideObject, { type: 'shape' }>): SlideObject | undefined {
  const fill = o.fill ?? (Array.isArray(o.gradient?.stops) ? o.gradient.stops[0]?.color : undefined);
  if (!fill) return undefined;
  return {
    id: o.id,
    type: 'shape',
    box: o.box,
    shape: 'rect',
    fill,
    opacity: o.opacity ?? 1,
    radius: 0,
    ...(o.origin ? { origin: o.origin } : {}),
    ...(o.locked ? { locked: true } : {}),
  };
}

/**
 * The slide with every inline outline on an integer grid of `GRID_PX` of its object's box (the `grid`
 * level): a path in its `w × h` space is redrawn in `ceil(box.w / GRID_PX) × ceil(box.h / GRID_PX)` with
 * every coordinate rounded, so a point drawn at `x · box.w / w` moves at most `GRID_PX / 2`. A path is kept
 * as it is when the grid's form is not shorter, or its space is not a positive size. Outlines in geometry
 * files (`ref`) are not in the slide and stay as they are. Pure: objects without inline outlines are shared.
 */
export function gridSlide(slide: Slide): Slide {
  let changed = false;
  const objects = objectsOf(slide).map((o) => {
    const g = gridObject(o);
    if (g !== o) changed = true;
    return g;
  });
  return changed ? { ...slide, objects } : slide;
}

/**
 * The slide's background drawn as an object (an importer's solid or extended background, or the white under a
 * background picture with alpha: origin role 'bg'). The minimal level of `fitSlideBudget` keeps it as it keeps
 * `backgroundMediaId`: left out, a slide's dark text would be drawn on the output's black.
 */
function isBackground(o: SlideObject): boolean {
  return o.origin?.role === 'bg';
}

function objectsOf(slide: Slide): SlideObject[] {
  return Array.isArray(slide?.objects) ? slide.objects : [];
}

/** A slide whose lyric box names an object it no longer has loses the reference. */
function withLyric(slide: Slide): Slide {
  if (!slide.lyricObjectId || objectsOf(slide).some((o) => o.id === slide.lyricObjectId)) return slide;
  const { lyricObjectId: _, ...rest } = slide;
  return rest;
}

/** One step a level may take: object `index` replaced by `next` (null: left out), saving about `saving` bytes. */
type Candidate = { index: number; saving: number; next: SlideObject | null; kind?: MissingKind };

/**
 * Take `candidates`, the largest saving first, until `size` says the slide fits `limit`: savings are counted
 * as they go and the slide measured each time the count says it fits (at most `MAX_MEASURES` times; then
 * every remaining candidate is taken at once). Returns the slide, its size and the candidates taken.
 */
function shed(
  slide: Slide,
  candidates: Candidate[],
  limit: number,
  bytes: number,
  size: (s: Slide) => number,
): { slide: Slide; bytes: number; applied: Candidate[] } {
  if (!candidates.length) return { slide, bytes, applied: [] };
  const order = [...candidates].sort((a, b) => b.saving - a.saving || a.index - b.index);
  const objects: (SlideObject | null)[] = [...objectsOf(slide)];
  const build = () => ({ ...slide, objects: objects.filter((o): o is SlideObject => o !== null) });
  const applied: Candidate[] = [];
  let estimate = bytes;
  let measured = bytes;
  let measures = 0;
  for (let i = 0; i < order.length; i++) {
    const c = order[i]!;
    objects[c.index] = c.next;
    applied.push(c);
    estimate -= c.saving;
    if (estimate > limit && i < order.length - 1) continue;
    if (++measures > MAX_MEASURES) {
      for (const rest of order.slice(i + 1)) {
        objects[rest.index] = rest.next;
        applied.push(rest);
      }
      const all = build();
      return { slide: all, bytes: size(all), applied };
    }
    const s = build();
    measured = size(s);
    if (measured <= limit) return { slide: s, bytes: measured, applied };
    estimate = measured;
  }
  const s = build();
  return { slide: s, bytes: applied.length ? measured : bytes, applied };
}

/** Text objects and tables with formatting, each as the candidate that drops it. */
function formattingCandidates(objects: readonly SlideObject[]): Candidate[] {
  const out: Candidate[] = [];
  objects.forEach((o, index) => {
    if (o.type === 'text' && (o.runs !== undefined || o.paras !== undefined)) {
      const next = plainText(o);
      out.push({ index, next, saving: jsonBytes(o) - jsonBytes(next) });
    } else if (o.type === 'shape' && o.table && tableFormatted(o.table)) {
      const next = plainTable(o);
      out.push({ index, next, saving: jsonBytes(o) - jsonBytes(next) });
    }
  });
  return out;
}

/** Shapes other than tables, each as the candidate that leaves it out, with what it drew. */
function dropCandidates(objects: readonly SlideObject[]): Candidate[] {
  const out: Candidate[] = [];
  objects.forEach((o, index) => {
    if (o.type !== 'shape' || o.table || isBackground(o)) return;
    out.push({ index, next: null, saving: jsonBytes(o) + 1, kind: o.chart ? 'chart' : 'decoration' });
  });
  return out;
}

/** A text object without runs and paragraph styles (its text and box style kept). */
function plainText(o: TextObject): TextObject {
  if (o.runs === undefined && o.paras === undefined) return o;
  const { runs: _runs, paras: _paras, ...rest } = o;
  return rest;
}

function tableFormatted(t: TableData): boolean {
  if (t.runStyles !== undefined) return true;
  return Array.isArray(t.cells) && t.cells.some((c) => c?.runs !== undefined || c?.paras !== undefined);
}

/** A table without its run styles and its cells' runs and paragraph styles (cell text and styles kept). */
function plainTable(o: ShapeObject): ShapeObject {
  const t = o.table;
  if (!t || !tableFormatted(t)) return o;
  const { runStyles: _, ...table } = t;
  const cells = (Array.isArray(t.cells) ? t.cells : []).map((c) => {
    if (c?.runs === undefined && c?.paras === undefined) return c;
    const { runs: _runs, paras: _paras, ...cell } = c;
    return cell;
  });
  return { ...o, table: { ...table, cells } };
}

/** The grid side of a box side: `ceil(|side| / GRID_PX)`, at least 1. */
function gridSide(side: number): number {
  const v = Math.abs(side);
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(PATH_DATA_LIMITS.coord, Math.ceil(v / GRID_PX)));
}

function gridObject(o: SlideObject): SlideObject {
  if (o.type === 'shape') {
    let out: ShapeObject = o;
    const geom = o.geom ? gridGeom(o.geom, o.box) : undefined;
    if (geom && geom !== o.geom) out = { ...out, geom };
    const decor = o.decor ? gridDecor(o.decor, o.box) : undefined;
    if (decor && decor !== o.decor) out = { ...out, decor };
    return out;
  }
  if (o.type === 'image' && o.mask) {
    const mask = gridGeom(o.mask, o.box);
    return mask === o.mask ? o : { ...o, mask };
  }
  return o;
}

function gridGeom(g: ShapeGeom, box: Box): ShapeGeom {
  if (!Array.isArray(g.paths) || !g.paths.length) return g;
  const gw = gridSide(box?.w);
  const gh = gridSide(box?.h);
  let changed = false;
  const paths = g.paths.map((p) => {
    const w = p?.w;
    const h = p?.h;
    if (!(typeof w === 'number' && w > 0 && Number.isFinite(w))) return p;
    if (!(typeof h === 'number' && h > 0 && Number.isFinite(h))) return p;
    const d = gridPath(p.d, gw / w, gh / h);
    if (d === undefined || d.length >= p.d.length) return p;
    changed = true;
    return { ...p, d, w: gw, h: gh };
  });
  return changed ? { ...g, paths } : g;
}

function gridDecor(dec: DecorData, box: Box): DecorData {
  if (!Array.isArray(dec.parts) || !dec.parts.length) return dec;
  const { w, h } = dec;
  if (!(typeof w === 'number' && w > 0 && Number.isFinite(w))) return dec;
  if (!(typeof h === 'number' && h > 0 && Number.isFinite(h))) return dec;
  const gw = gridSide(box?.w);
  const gh = gridSide(box?.h);
  const kx = gw / w;
  const ky = gh / h;
  let before = 0;
  let after = 0;
  const parts = dec.parts.map((p) => {
    const d = typeof p?.d === 'string' ? (gridPath(p.d, kx, ky) ?? p.d) : p?.d;
    before += typeof p?.d === 'string' ? p.d.length : 0;
    after += typeof d === 'string' ? d.length : 0;
    if (!Array.isArray(p?.frame)) return d === p?.d ? p : { ...p, d };
    const [x, y, fw, fh, rot] = p.frame;
    const side = (v: number, k: number) => (v > 0 ? Math.max(1, Math.round(v * k)) : v);
    const frame: typeof p.frame = [Math.round(x * kx), Math.round(y * ky), side(fw, kx), side(fh, ky), rot];
    return { ...p, d, frame };
  });
  // One space for every part: the grid's only where it is shorter overall.
  return after < before ? { ...dec, w: gw, h: gh, parts } : dec;
}

/** Path data scaled by `kx`, `ky` with every coordinate rounded, as every reader parses it; undefined for none. */
function gridPath(d: unknown, kx: number, ky: number): string | undefined {
  const parsed = parsePathData(d);
  if (!parsed.cmds.length) return undefined;
  const pts = parsed.pts;
  for (let i = 0; i < pts.length; i += 2) {
    pts[i] = Math.round(pts[i]! * kx);
    pts[i + 1] = Math.round(pts[i + 1]! * ky);
  }
  return formatPathData(parsed);
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
