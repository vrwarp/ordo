/**
 * 'Re-import from PowerPoint' (design/27 §11 "Round trip and migration", §15 M4; M4 item F,
 * apps/operator/src/views/editor/M4.md). The light `pptx-reimport` job runs the native import again on the
 * presentation's stored deck (`Presentation.source.fileId`, read through `deckParts.ts` and the
 * `pptx-scene` pool task exactly as `nativeJob.ts` reads it: the deck is untrusted, design/27 §12) and merges
 * the fresh slides into the stored presentation as one new revision (`savedBy` 'pptx-reimport'), which
 * History can restore:
 * - slides are matched by deck position (`Slide.pptx.index`; legacy picture slides by page, with the text
 *   repair's page rule `storedPagesOf`; a made-editable slide by the page its picture was named after
 *   ('<title> – N'), else by the deck slide whose text bodies its text boxes repeat);
 * - a native slide is regenerated only while its objects still match `Slide.pptx.digest` (or when it is in
 *   `reset`); an edited one is kept as it is. Objects added in ordo (no `origin`) do not make a slide
 *   edited: they are kept on top. A slide the converter would write again as it is (the same converter
 *   version, its LibreOffice work done) is left as it is, so a re-import that changes nothing saves nothing;
 * - kept from the stored presentation: slide ids, sections, arrangements, notes (unless empty), durations,
 *   per-slide backgrounds, transitions, hidden flags, sounds, the PowerPoint reference picture, and the
 *   operator's own objects (no `origin`), kept on top. On a legacy slide only what the operator set is kept
 *   (a legacy import wrote no notes, timings or transitions), the rest comes from the deck;
 * - legacy picture slides (`imported`) become the native slide; made-editable slides (no `imported`, in a
 *   pptx-sourced presentation, the bottom object a full-frame ImageObject whose media is tagged 'document')
 *   lose that page picture and every text object whose text equals an extracted box, unless in `keep`, so
 *   no content is doubled. A made-editable slide with a text box on an extracted box's place but with
 *   another text (the volunteer corrected it) is kept as it is and counted as edited, unless in `reset`
 *   (then the box is replaced too): the rebuild would bring the deck's old wording back. A legacy slide whose
 *   deck slide converts to a picture again stays as it is;
 * - the lyric box the volunteer chose stays chosen (an imported one mapped to the fresh object of the same
 *   PowerPoint shape), and the digest covers only the import's objects (`digest.ts`), so objects added in
 *   ordo never make a slide edited, before or after a re-import;
 * - any other slide is kept as it is;
 * - pictures go through `storePictures` (prepared, deduplicated by hash), hybrid and picture slides queue
 *   the `pptx-lo` follow-up as the first import does, reusing the art, page and metafile pictures earlier
 *   follow-ups stored for the same slide (same deck, same art), so LibreOffice runs only for what is new.
 * Refused while the presentation is live-locked (the route answers 423; a queued job defers itself, as the
 * follow-ups do, and never writes during a service: ADR 0007). 'Make editable' on one legacy slide is this
 * job with `slideIds: [that slide]` (`imports.ts` `makeEditableNative`). The presentation becomes a native
 * import (`source.native`, counted over its slides), so the follow-ups and the editor treat it as one.
 *
 * `planReimport` and `mergeReimport` are pure, so most of this is unit-tested without a hub
 * (`apps/hub/test/pptx-reimport.test.ts`).
 */
import {
  type Box,
  formatBytes,
  type ImageObject,
  type Presentation,
  Presentation as PresentationSchema,
  presentationBytes,
  SIZE_BUDGETS,
  Slide,
  type SlideObject,
  slideBytes,
} from '@ordo/domain';
import type {
  Job,
  PptxReimportAction,
  PptxReimportKind,
  PptxReimportPlan,
  PptxReimportPlanSlide,
  PptxReimportReq,
  PptxReimportResult,
} from '@ordo/protocol';
import { errorMessage, HttpError, notFound } from '../errors.ts';
import { digestMatches, importDigest } from './digest.ts';
import { type JobCtx, JobDeferred, type JobHandler } from '../jobs.ts';
import { deferDelay } from './fallback.ts';
import { buildNative, type NativeBuild, type NativeJobEnv } from './nativeJob.ts';
import { logSafe, SOURCE_LOG_CHARS } from './report.ts';
import {
  CONVERTER_VERSION,
  enqueuePptx,
  PPTX_JOBS,
  type PptxDeps,
  type PptxImportOptions,
  type PptxLoPayload,
  type PptxLoSlide,
  type PptxNativePayload,
  type PptxReimportPayload,
} from './shared.ts';
import { storedPagesOf } from './textRepair.ts';

/** `savedBy` of the revisions a re-import writes. */
export const REIMPORT_BY = 'pptx-reimport';

/** The media tags `planReimport` reads ('document' marks a legacy page picture). */
export type MediaTags = (mediaId: string) => readonly string[] | undefined;
/** A media item's name (a legacy page picture is named '<title> – <page>'). */
export type MediaNames = (mediaId: string) => string | undefined;

/** The stored deck a presentation was imported from, if it is a PowerPoint import. */
export function deckOf(p: Pick<Presentation, 'source'>): string | undefined {
  return p.source?.kind === 'pptx' ? p.source.fileId || undefined : undefined;
}

/**
 * Whether a native slide's imported objects are as the hub last wrote them (`Slide.pptx.digest`, over the
 * objects with an `origin`, `digest.ts`): objects added in ordo, before or after a re-import kept them on
 * top, never count as an edit. A slide without a digest (a copy) counts as edited.
 */
export function unedited(slide: Pick<Slide, 'objects' | 'pptx'>): boolean {
  return digestMatches(slide.objects, slide.pptx?.digest);
}

/** How far a made-editable slide's page picture may be from the full 1920x1080 frame. */
const FRAME_SLACK_PX = 2;

/** A made-editable slide's page picture: its bottom object, a full-frame picture tagged 'document'. */
function pagePicture(sl: Pick<Slide, 'objects'>, tags: MediaTags): ImageObject | undefined {
  const o = sl.objects[0];
  if (o?.type !== 'image') return undefined;
  const b = o.box;
  const near = (v: number, want: number) => Math.abs(v - want) <= FRAME_SLACK_PX;
  if (!near(b.x, 0) || !near(b.y, 0) || !near(b.w, 1920) || !near(b.h, 1080) || b.rotation) return undefined;
  return tags(o.mediaId)?.includes('document') ? o : undefined;
}

function kindOf(sl: Slide, deck: string | undefined, tags: MediaTags): PptxReimportKind {
  if (!deck) return 'other';
  if (sl.pptx) return sl.pptx.fileId === deck ? 'native' : 'other';
  if (sl.imported) return sl.imported.fileId === deck ? 'page' : 'other';
  return pagePicture(sl, tags) ? 'made-editable' : 'other';
}

/**
 * Which kind of slide each slide of `p` is for a re-import, in authoring order (design/27 §11; the kinds of
 * `PptxReimportKind`). `tags` gives a media item's tags (a made-editable slide's bottom picture is tagged
 * 'document').
 */
export function reimportKinds(p: Presentation, tags: MediaTags): PptxReimportKind[] {
  const deck = deckOf(p);
  return p.sections.flatMap((s) => s.slides.map((sl) => kindOf(sl, deck, tags)));
}

/** What a re-import does to one slide of a kind (before the deck is read). */
function actionOf(
  sl: Slide,
  kind: PptxReimportKind,
  req: { scope?: Set<string>; reset: Set<string>; keep: Set<string> },
): PptxReimportAction {
  if (req.scope && !req.scope.has(sl.id)) return 'keep';
  if (kind === 'native') return req.reset.has(sl.id) || unedited(sl) ? 'regenerate' : 'keep-edited';
  if (kind === 'page') return 'replace';
  if (kind === 'made-editable') return req.keep.has(sl.id) ? 'keep' : 'replace';
  return 'keep';
}

/**
 * Objects the operator added in ordo that a re-import keeps on top: those without `origin` on a native
 * slide, every object on a legacy page; on a made-editable slide those that are not the page picture or a
 * text box (text boxes that repeat the deck's text are replaced, which only the deck tells: at least these).
 */
function userCount(sl: Slide, kind: PptxReimportKind): number {
  if (kind === 'native') return sl.objects.filter((o) => !o.origin).length;
  if (kind === 'page') return sl.objects.length;
  if (kind === 'made-editable') return sl.objects.slice(1).filter((o) => o.type !== 'text').length;
  return 0;
}

function requestSets(req: PptxReimportReq) {
  return {
    ...(req.slideIds ? { scope: new Set(req.slideIds) } : {}),
    reset: new Set(req.reset ?? []),
    keep: new Set(req.keep ?? []),
  };
}

/**
 * What a re-import of `p` with `req` would do, slide by slide, without reading the deck: the dialog lists the
 * made-editable slides so the user can keep any of them (`GET /presentations/:id/pptx-reimport`). Every
 * slide is listed, numbered as the editor numbers them; those outside `req.slideIds` are kept.
 */
export function planReimport(p: Presentation, req: PptxReimportReq, tags: MediaTags): PptxReimportPlan {
  const fileId = deckOf(p) ?? '';
  const sets = requestSets(req);
  const deck = deckOf(p);
  const slides: PptxReimportPlanSlide[] = [];
  let number = 0;
  for (const sec of p.sections)
    for (const sl of sec.slides) {
      const kind = kindOf(sl, deck, tags);
      slides.push({
        slideId: sl.id,
        number: ++number,
        kind,
        action: actionOf(sl, kind, sets),
        userObjects: userCount(sl, kind),
      });
    }
  return { presentationId: p.id, fileId, slides };
}

/** The slides the native import made from the stored deck, by deck position, before they are merged. */
export type FreshDeck = {
  slides: {
    /** `SlideRef.index`: position in the deck's slide order, hidden slides counted. */
    index: number;
    /** Position among the shown slides (the LibreOffice page); absent for a hidden slide. */
    shown?: number;
    /** The converted slide, its media ids already the library's (`storePictures`). */
    slide: Slide;
  }[];
  /**
   * Extracted text boxes per deck slide, for the made-editable rule (text objects equal to one are replaced),
   * with where each box is (`boxes`, the 1920x1080 contain frame the old 'Make editable' laid its text boxes
   * in): a text object on one of them whose text differs is the volunteer's correction of it.
   */
  texts?: { index: number; texts: string[]; boxes?: { text: string; box: Box }[] }[];
  /**
   * Every slide the deck lists (also those not converted): the page rule of legacy slides. Absent: the
   * slides above.
   */
  listed?: { index: number; hidden: boolean; shown?: number }[];
  /** The background the import gave the whole presentation (one picture behind every slide), if any. */
  backgroundMediaId?: string;
  /** The fresh import's `source` (its `native` counts and slide rectangle, its `log`). */
  source?: Presentation['source'];
  /** The LibreOffice follow-up the fresh slides that wait would get (`PptxLoSlide`), by the fresh slides' ids. */
  lo?: PptxLoSlide[];
  /** Whether every deck slide was converted (a whole re-import): its log replaces the presentation's. */
  whole?: boolean;
};

/** The fresh deck of a native build (`buildNative`). */
export function freshOf(b: NativeBuild, whole: boolean): FreshDeck {
  const slides = b.p.sections.flatMap((s) => s.slides);
  return {
    slides: slides
      .filter((sl) => sl.pptx)
      .map((sl) => ({
        index: sl.pptx!.index,
        ...(sl.pptx!.shown !== undefined ? { shown: sl.pptx!.shown } : {}),
        slide: sl,
      })),
    texts: [...b.texts].map(([index, texts]) => {
      const boxes = b.textBoxes.get(index);
      return { index, texts, ...(boxes?.length ? { boxes } : {}) };
    }),
    listed: b.listed.map((r) => ({
      index: r.index,
      hidden: r.hidden,
      ...(r.shown !== undefined ? { shown: r.shown } : {}),
    })),
    ...(b.p.backgroundMediaId ? { backgroundMediaId: b.p.backgroundMediaId } : {}),
    ...(b.p.source ? { source: b.p.source } : {}),
    lo: b.lo,
    whole,
  };
}

/** What `mergeReimport` counts (`PptxReimportResult` without the presentation and revision). */
export type ReimportCounts = Omit<PptxReimportResult, 'presentationId' | 'rev'>;

/** A legacy page number from its picture's name ('<title> – 3'), as the picture import names its pages. */
export function pageFromName(name: string | undefined): number | undefined {
  const m = name ? / [–-] (\d{1,6})$/.exec(name) : null;
  const n = m ? Number(m[1]) : 0;
  return n >= 1 ? n : undefined;
}

/** Text compared as a volunteer reads it: whitespace runs as one space, trimmed. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** How much two boxes must overlap (intersection over union) for a text object to sit on an extracted box. */
const SAME_PLACE = 0.6;

/** Whether box `a` is where box `b` is: they overlap by at least `SAME_PLACE` of their union. */
export function samePlace(a: Box, b: Box): boolean {
  const r = (x: Box) => {
    const x0 = Math.min(x.x, x.x + x.w);
    const y0 = Math.min(x.y, x.y + x.h);
    return { x0, y0, x1: x0 + Math.abs(x.w), y1: y0 + Math.abs(x.h) };
  };
  const p = r(a);
  const q = r(b);
  const w = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
  const h = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
  if (!(w > 0 && h > 0)) return false;
  const inter = w * h;
  const union = (p.x1 - p.x0) * (p.y1 - p.y0) + (q.x1 - q.x0) * (q.y1 - q.y0) - inter;
  return union > 0 && inter / union >= SAME_PLACE;
}

/**
 * The deck slide (`SlideRef.index`) each slide of `p` comes from, for the kinds that have one: a native
 * slide its `pptx.index`; a legacy page its page through `storedPagesOf`; a made-editable slide the page its
 * picture's name gives. Slides the rule cannot place are absent (a page `storedPagesOf` calls ambiguous).
 */
export function deckIndexes(
  p: Presentation,
  listed: readonly { index: number; hidden: boolean; shown?: number }[],
  tags: MediaTags,
  names: MediaNames | undefined,
): Map<string, number> {
  const deck = deckOf(p);
  const out = new Map<string, number>();
  const pages: [string, number][] = [];
  for (const sec of p.sections)
    for (const sl of sec.slides) {
      const kind = kindOf(sl, deck, tags);
      if (kind === 'native') out.set(sl.id, sl.pptx!.index);
      else if (kind === 'page') pages.push([sl.id, sl.imported!.page]);
      else if (kind === 'made-editable') {
        const page = pageFromName(names?.(pagePicture(sl, tags)!.mediaId));
        if (page) pages.push([sl.id, page]);
      }
    }
  if (!pages.length) return out;
  const renderer = p.source?.kind === 'pptx' ? p.source.renderer : undefined;
  const highest = Math.max(...pages.map(([, n]) => n));
  const map = storedPagesOf(renderer, listed, highest);
  for (const [id, page] of pages) {
    const index = map[page - 1];
    if (index !== undefined && index >= 0) out.set(id, index);
  }
  return out;
}

/** The deck slide whose text bodies a made-editable slide's text boxes repeat most (ties: none). */
function byText(sl: Slide, texts: Map<number, string[]>): number | undefined {
  const mine = new Set(
    sl.objects
      .filter((o) => o.type === 'text')
      .map((o) => (o.type === 'text' ? norm(o.text) : ''))
      .filter(Boolean),
  );
  if (!mine.size) return undefined;
  let best: number | undefined;
  let most = 0;
  let tie = false;
  for (const [index, list] of texts) {
    const n = new Set(list.map(norm).filter((t) => mine.has(t))).size;
    if (n > most) {
      best = index;
      most = n;
      tie = false;
    } else if (n && n === most) tie = true;
  }
  return most && !tie ? best : undefined;
}

/** JSON with every object's keys sorted: two slides built in another field order compare equal. */
function sortedKeys(_k: string, v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );
}

/** A slide compared without its object ids (fresh ones differ every run), its digest and its field order. */
function shape(sl: Slide): string {
  const ids = new Map(sl.objects.map((o, i) => [o.id, `#${i}`]));
  const objects = sl.objects.map((o) => ({ ...o, id: ids.get(o.id) }));
  const out: Record<string, unknown> = { ...sl, objects };
  if (sl.lyricObjectId) out.lyricObjectId = ids.get(sl.lyricObjectId) ?? sl.lyricObjectId;
  if (sl.pptx) {
    const { digest: _d, ...pptx } = sl.pptx;
    out.pptx = pptx;
  }
  return JSON.stringify(out, sortedKeys);
}

/** Slide-level settings a re-import keeps from the stored slide (design/27 §11). */
const KEPT = [
  'clearBackground',
  'durationMs',
  'overrides',
  'hidden',
  'transition',
  'audio',
  'scripture',
] as const;

/**
 * The fresh object that is the stored slide's imported object `o`: the same PowerPoint shape (`shapeId`,
 * with the same type and role, and placeholder when both have one), else the one at the same place among
 * the imported objects of its type. Undefined when nothing matches.
 */
function sameImported(o: SlideObject, cur: Slide, f: Slide): SlideObject | undefined {
  const og = o.origin;
  if (!og) return undefined;
  const fresh = f.objects.filter((x) => x.origin && x.type === o.type);
  if (og.shapeId !== undefined) {
    const hits = fresh.filter(
      (x) =>
        x.origin!.shapeId === og.shapeId &&
        x.origin!.role === og.role &&
        (og.ph === undefined || x.origin!.ph === undefined || x.origin!.ph === og.ph),
    );
    if (hits.length === 1) return hits[0];
  }
  const mine = cur.objects.filter((x) => x.origin && x.type === o.type);
  const k = mine.indexOf(o);
  return k >= 0 && mine.length === fresh.length ? fresh[k] : undefined;
}

/**
 * The lyric box of the rebuilt slide: the volunteer's choice ('Make lyric box') kept, an object added in
 * ordo as it is, an imported one mapped to the fresh object it now is (`sameImported`); the converter's
 * choice when the slide had none or its choice has no match. A slide setting like notes: it stays through
 * a re-import and a 'Reset slide' alike, and stage, lower thirds, the stream key and search keep following it.
 */
function lyricOf(cur: Slide, f: Slide, keep: SlideObject[]): string | undefined {
  const id = cur.lyricObjectId;
  if (!id) return f.lyricObjectId;
  if (keep.some((o) => o.id === id)) return id;
  const o = cur.objects.find((x) => x.id === id);
  return (o && sameImported(o, cur, f)?.id) ?? f.lyricObjectId;
}

/**
 * The stored slide `cur` rebuilt from the fresh slide `f`: its objects, then `keep` on top; the slide-level
 * settings by the rules at the top of this file. Undefined when the result is not a valid slide.
 */
function rebuild(
  cur: Slide,
  f: Slide,
  keep: SlideObject[],
  legacy: boolean,
  background: string | undefined,
): Slide | undefined {
  const next: Slide = { id: cur.id, objects: [...f.objects, ...keep] };
  const lyric = lyricOf(cur, f, keep);
  if (lyric) next.lyricObjectId = lyric;
  const set = next as Record<string, unknown>;
  for (const k of KEPT) {
    const v = legacy ? (cur[k] ?? f[k]) : cur[k];
    if (v !== undefined) set[k] = v;
  }
  const notes = cur.notes?.trim() ? cur.notes : f.notes;
  if (notes) next.notes = notes;
  if (background) next.backgroundMediaId = background;
  if (f.pptx) {
    const pptx = { ...f.pptx };
    // The PowerPoint picture of the same deck slide stays valid (and whether the screens show it).
    if (cur.pptx?.refMediaId && cur.pptx.fileId === pptx.fileId && cur.pptx.index === pptx.index) {
      pptx.refMediaId = cur.pptx.refMediaId;
      if (cur.pptx.show) pptx.show = cur.pptx.show;
    }
    next.pptx = pptx;
  }
  const parsed = Slide.safeParse(next);
  if (!parsed.success) return undefined;
  // The digest of the import's objects (those with an origin, `digest.ts`): the operator's kept on top are
  // left out, so moving, editing or deleting them later does not make the slide edited.
  if (parsed.data.pptx) parsed.data.pptx.digest = importDigest(parsed.data.objects);
  return parsed.data;
}

/** `log` with `line` appended, the oldest lines dropped past `SOURCE_LOG_CHARS`. */
function appendLog(log: string | undefined, line: string): string {
  const lines = [...(log ? log.split('\n') : []), line];
  let n = lines.reduce((a, l) => a + l.length + 1, 0);
  while (lines.length > 1 && n > SOURCE_LOG_CHARS) n -= lines.shift()!.length + 1;
  return lines.join('\n');
}

/** What the re-import did, as one line of `source.log` and the job log. */
export function summaryLine(c: ReimportCounts): string {
  const parts = [
    `${c.regenerated} slide(s) rebuilt`,
    `${c.replaced} legacy slide(s) made editable`,
    `${c.keptEdited} edited slide(s) kept`,
  ];
  if (c.userObjects) parts.push(`${c.userObjects} object(s) added in ordo kept on top`);
  return `re-imported from PowerPoint: ${parts.join(', ')}`;
}

/**
 * The stored presentation `current` with the fresh slides merged in, by the rules at the top of this file,
 * the counts the job reports, and the follow-up plans of the merged slides that wait for LibreOffice (by
 * their kept ids, with the merged digests). Pure: no I/O. Returns `current` itself (the same object) when
 * nothing changes, so the job saves no revision then. `names` gives a media item's name (the page of a
 * made-editable slide); without it such slides are matched by their text.
 */
export function mergeReimport(
  current: Presentation,
  fresh: FreshDeck,
  req: PptxReimportReq,
  tags: MediaTags,
  names?: MediaNames,
): { p: Presentation; counts: ReimportCounts; lo: PptxLoSlide[] } {
  const counts: ReimportCounts = { regenerated: 0, keptEdited: 0, replaced: 0, userObjects: 0 };
  const deck = deckOf(current);
  if (!deck) return { p: current, counts, lo: [] };
  const sets = requestSets(req);
  const byIndex = new Map(fresh.slides.map((s) => [s.index, s]));
  const texts = new Map((fresh.texts ?? []).map((t) => [t.index, t.texts]));
  const places = new Map((fresh.texts ?? []).map((t) => [t.index, t.boxes ?? []]));
  const listed =
    fresh.listed ??
    fresh.slides.map((s) => ({ index: s.index, hidden: s.shown === undefined, shown: s.shown }));
  const shownTexts = new Map(
    [...texts].filter(([i]) => listed.some((r) => r.index === i && !r.hidden && r.shown !== undefined)),
  );
  const indexes = deckIndexes(current, listed, tags, names);
  const plans = new Map((fresh.lo ?? []).map((l) => [l.slideId, l]));
  const out = new Map<string, Slide>();
  /** Slides that took the fresh presentation's background as their own. */
  const tookBackground = new Set<string>();
  const lo: PptxLoSlide[] = [];

  for (const sec of current.sections)
    for (const sl of sec.slides) {
      const kind = kindOf(sl, deck, tags);
      const action = actionOf(sl, kind, sets);
      if (action === 'keep-edited') counts.keptEdited++;
      if (action !== 'regenerate' && action !== 'replace') continue;
      const index = indexes.get(sl.id) ?? (kind === 'made-editable' ? byText(sl, shownTexts) : undefined);
      const f = index === undefined ? undefined : byIndex.get(index);
      if (!f?.slide.pptx || f.slide.pptx.fileId !== deck) continue;
      const fp = f.slide.pptx;
      const legacy = kind !== 'native';
      // A legacy page whose deck slide is a picture again gains nothing: it stays as it is.
      if (legacy && fp.class === 'picture') continue;
      let keep: SlideObject[];
      if (kind === 'native') {
        const cp = sl.pptx!;
        // Written again by the same converter, its LibreOffice work done: already what a re-import makes.
        if (
          !sets.reset.has(sl.id) &&
          fp.pending &&
          cp.version === fp.version &&
          cp.class === fp.class &&
          !cp.pending &&
          !cp.failed
        )
          continue;
        keep = sl.objects.filter((o) => !o.origin);
      } else if (kind === 'page') keep = [...sl.objects];
      else {
        const deckTexts = new Set((texts.get(f.index) ?? []).map(norm));
        const at = places.get(f.index) ?? [];
        // The made-editable text boxes: those repeating the deck's text, and those on an extracted box with
        // another text, which the volunteer corrected (a typo fixed, a date changed).
        const fromImport = (o: SlideObject) =>
          o.type === 'text' &&
          o.origin === undefined &&
          (deckTexts.has(norm(o.text)) || at.some((b) => samePlace(o.box, b.box)));
        const corrected = sl.objects
          .slice(1)
          .some((o) => fromImport(o) && o.type === 'text' && !deckTexts.has(norm(o.text)));
        // The rebuilt slide would show the deck's old wording; keeping the box on top would show both. The
        // slide stays as it is (an edited slide), unless the request resets it.
        if (corrected && !sets.reset.has(sl.id)) {
          counts.keptEdited++;
          continue;
        }
        keep = sl.objects.slice(1).filter((o) => !fromImport(o));
      }
      let background = sl.backgroundMediaId;
      if (legacy && !background) {
        const theirs = f.slide.backgroundMediaId ?? fresh.backgroundMediaId;
        if (theirs && theirs !== current.backgroundMediaId) {
          background = theirs;
          if (!f.slide.backgroundMediaId) tookBackground.add(sl.id);
        }
      }
      const next = rebuild(sl, f.slide, keep, legacy, background);
      if (!next || shape(next) === shape(sl)) continue;
      out.set(sl.id, next);
      if (legacy) counts.replaced++;
      else counts.regenerated++;
      counts.userObjects += keep.length;
      const plan = plans.get(f.slide.id);
      if (plan && next.pptx?.pending) lo.push({ ...plan, slideId: sl.id, digest: next.pptx.digest ?? '' });
    }
  if (!out.size) return { p: current, counts, lo: [] };

  const sections = current.sections.map((sec) => ({
    ...sec,
    slides: sec.slides.map((sl) => out.get(sl.id) ?? sl),
  }));
  const p: Presentation = { ...current, sections };
  // A legacy deck converted whole: its one background is the presentation's again, as on a fresh import, so
  // the pickers swap it on every slide at once.
  const all = sections.flatMap((s) => s.slides);
  if (
    fresh.backgroundMediaId &&
    !current.backgroundMediaId &&
    tookBackground.size &&
    all.every((sl) => tookBackground.has(sl.id))
  ) {
    p.backgroundMediaId = fresh.backgroundMediaId;
    p.sections = sections.map((sec) => ({
      ...sec,
      slides: sec.slides.map((sl) => {
        if (!tookBackground.has(sl.id)) return sl;
        const { backgroundMediaId: _bg, ...rest } = sl;
        return rest;
      }),
    }));
  }
  const mine = all.filter((sl) => sl.pptx?.fileId === deck);
  const cls = (c: 'native' | 'hybrid' | 'picture') => mine.filter((sl) => sl.pptx!.class === c).length;
  const freshNative = fresh.source?.kind === 'pptx' ? fresh.source.native : undefined;
  const curSource = current.source!;
  const slideRect = freshNative?.slideRect ?? curSource.native?.slideRect;
  const line = summaryLine(counts);
  const log =
    fresh.whole && fresh.source?.log !== undefined
      ? appendLog(fresh.source.log, line)
      : appendLog(curSource.log, line);
  p.source = {
    ...curSource,
    native: {
      version: freshNative?.version ?? CONVERTER_VERSION,
      slides: mine.length,
      native: cls('native'),
      hybrid: cls('hybrid'),
      picture: cls('picture'),
      ...(slideRect ? { slideRect } : {}),
    },
    log,
  };
  return { p, counts, lo };
}

/** Queue a re-import (the route has checked the lock and the stored deck). */
export function queueReimport(
  deps: Pick<PptxDeps, 'jobs'>,
  presentationId: string,
  hash: string,
  req: PptxReimportReq,
  by?: string,
  options?: PptxImportOptions,
): Job {
  return enqueuePptx(deps.jobs, PPTX_JOBS.reimport, {
    presentationId,
    hash,
    ...(by ? { by } : {}),
    ...(req.slideIds ? { slideIds: req.slideIds } : {}),
    ...(req.reset ? { reset: req.reset } : {}),
    ...(req.keep ? { keep: req.keep } : {}),
    ...(options && Object.keys(options).length ? { options } : {}),
  });
}

/**
 * The options the presentation's first native import was given (its `pptx-native` job, while the queue
 * keeps it); undefined when unknown (the defaults apply, as on an upload without them).
 */
export function importOptionsOf(
  deps: Pick<PptxDeps, 'lib'>,
  presentationId: string,
  hash: string,
): PptxImportOptions | undefined {
  try {
    const row = deps.lib.db
      .prepare(
        `SELECT payload FROM jobs WHERE kind = ? AND state = 'done' AND json_extract(result, '$.presentationId') = ?
         AND json_extract(payload, '$.hash') = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(PPTX_JOBS.native, presentationId, hash) as { payload: string } | undefined;
    const o = row ? (JSON.parse(row.payload) as PptxNativePayload).options : undefined;
    if (!o || typeof o !== 'object') return undefined;
    const out: PptxImportOptions = {};
    if (typeof o.extendBackgrounds === 'boolean') out.extendBackgrounds = o.extendBackgrounds;
    if (typeof o.transitionSounds === 'boolean') out.transitionSounds = o.transitionSounds;
    return out;
  } catch {
    return undefined;
  }
}

/** Follow-ups of one presentation read for pictures to reuse (newest first). */
const FOLLOW_UP_HISTORY = 20;
/** How many times the save is tried against a newer copy (someone saved during the merge). */
const SAVE_TRIES = 3;

/**
 * The pictures earlier follow-ups of the presentation stored that the new plans can use as they are (the
 * same deck slide, and for the art the same deck elements): `done` and `placed` of a `PptxLoPayload`, so
 * LibreOffice is not run again for a slide a re-import rebuilt.
 */
export function earlierWork(
  deps: Pick<PptxDeps, 'lib'>,
  presentationId: string,
  hash: string,
  slides: readonly PptxLoSlide[],
): Pick<PptxLoPayload, 'done' | 'placed'> {
  const rows = deps.lib.db
    .prepare(
      `SELECT payload FROM jobs WHERE kind = ? AND json_extract(payload, '$.presentationId') = ?
       ORDER BY created_at DESC, id DESC LIMIT ${FOLLOW_UP_HISTORY}`,
    )
    .all(PPTX_JOBS.lo, presentationId) as { payload: string }[];
  const want = new Map(slides.map((s) => [s.slideId, s]));
  const parts = new Set(
    slides.flatMap((s) => [
      ...(s.metafiles ?? []).map(([m]) => m),
      ...(s.metafileObjects ?? []).map((m) => m.part),
    ]),
  );
  const done = new Map<string, string>();
  const placed = new Map<string, { x: number; y: number; w: number; h: number }>();
  const has = (id: string) => id === '' || !!deps.lib.media.get(id);
  for (const r of rows) {
    let pl: Partial<PptxLoPayload>;
    try {
      pl = JSON.parse(r.payload) as Partial<PptxLoPayload>;
    } catch {
      continue;
    }
    if (pl.hash !== hash) continue;
    const before = new Map((Array.isArray(pl.slides) ? pl.slides : []).map((s) => [s.slideId, s]));
    const where = new Map(Array.isArray(pl.placed) ? pl.placed : []);
    for (const [k, id] of Array.isArray(pl.done) ? pl.done : []) {
      if (done.has(k) || typeof id !== 'string' || !has(id)) continue;
      if (k.startsWith('mf:')) {
        if (parts.has(k.slice(3))) done.set(k, id);
        continue;
      }
      const at = k.lastIndexOf(':');
      const slideId = k.slice(0, at);
      const what = k.slice(at + 1);
      const now = want.get(slideId);
      const then = before.get(slideId);
      if (!now || !then || now.index !== then.index || now.shown !== then.shown) continue;
      if (what === 'page' && now.class === 'picture') done.set(k, id);
      if (
        what === 'art' &&
        now.art &&
        then.art &&
        JSON.stringify(now.art.elements) === JSON.stringify(then.art.elements)
      ) {
        const box = where.get(k);
        if (id !== '' && !box) continue;
        done.set(k, id);
        if (box) placed.set(k, box);
      }
    }
  }
  return {
    ...(done.size ? { done: [...done] } : {}),
    ...(placed.size ? { placed: [...placed] } : {}),
  };
}

/** Defer the job while its presentation is live-locked (ADR 0007): back to the queue with backoff. */
function deferWhileLocked(ctx: JobCtx<PptxReimportPayload>): never {
  const n = ctx.payload.deferrals ?? 0;
  ctx.setPayload({ ...ctx.payload, deferrals: n + 1 });
  const ms = deferDelay(n);
  throw new JobDeferred(
    ms,
    `waiting: the presentation is live; the re-import tries again in ${Math.round(ms / 1000)} s`,
  );
}

/** How long a re-import waits for the presentation's LibreOffice follow-up before it looks again. */
export const FOLLOW_UP_WAIT_MS = 15_000;

/** Whether a LibreOffice follow-up of the presentation is queued or running. */
export function followUpActive(deps: Pick<PptxDeps, 'lib'>, presentationId: string): boolean {
  return !!deps.lib.db
    .prepare(
      `SELECT 1 FROM jobs WHERE kind = ? AND state IN ('queued', 'running')
       AND json_extract(payload, '$.presentationId') = ? LIMIT 1`,
    )
    .get(PPTX_JOBS.lo, presentationId);
}

/**
 * Wait for the presentation's LibreOffice follow-up: its plans name the slides as they are now, so a slide
 * rebuilt under it would get its art in the wrong place. Not a lock deferral (not counted).
 */
function deferWhileFollowUp(): never {
  throw new JobDeferred(
    FOLLOW_UP_WAIT_MS,
    `waiting: LibreOffice is still drawing part of this presentation; the re-import tries again in ${FOLLOW_UP_WAIT_MS / 1000} s`,
  );
}

/**
 * The deck slides a re-import of `p` limited to `req.slideIds` needs converted, once the deck is listed;
 * undefined (every slide) for a whole re-import, or when a slide asked for can only be placed by its text.
 */
function scopeOf(
  p: Presentation,
  req: PptxReimportReq,
  tags: MediaTags,
  names: MediaNames,
): NativeJobEnv['only'] {
  const ids = req.slideIds;
  if (!ids) return undefined;
  return (listed) => {
    const indexes = deckIndexes(p, listed, tags, names);
    const kinds = new Map(
      p.sections.flatMap((s) => s.slides).map((sl) => [sl.id, kindOf(sl, deckOf(p), tags)] as const),
    );
    const want = new Set<number>();
    for (const id of ids) {
      const i = indexes.get(id);
      if (i !== undefined) want.add(i);
      else if (kinds.get(id) === 'made-editable') return undefined;
    }
    return want;
  };
}

/**
 * The bytes of the stored slides a re-import keeps as they are, for the size budget of the slides it builds
 * (`NativeJobEnv.reserve`, design/27 §3.4): a re-import of some slides ('Make editable' on a page, 'Reset
 * slide') keeps every other slide; a whole one keeps the slides that do not come from the deck (the deck's
 * own are all converted and counted by the build, the edited ones' stored copies standing in for them).
 */
export function keptBytes(p: Presentation, plan: PptxReimportPlan, scoped: boolean): number {
  const action = new Map(plan.slides.map((s) => [s.slideId, s]));
  let n = 0;
  for (const sec of p.sections)
    for (const sl of sec.slides) {
      const a = action.get(sl.id);
      const rebuilt = a?.action === 'regenerate' || a?.action === 'replace';
      if (scoped ? !rebuilt : a?.kind === 'other') n += slideBytes(sl);
    }
  return n;
}

const zero = (presentationId: string, keptEdited = 0): PptxReimportResult => ({
  presentationId,
  regenerated: 0,
  keptEdited,
  replaced: 0,
  userObjects: 0,
});

/**
 * The `pptx-reimport` job: read the stored deck, convert it on the pool (`nativeJob.ts`'s steps 1-5 for
 * the slides asked for, `buildNative`), `mergeReimport`, save one revision by `REIMPORT_BY` with the
 * LibreOffice follow-up and the clips' media jobs in the same transaction. Nothing is written while the
 * presentation is live-locked (the job defers itself); a re-import that changes nothing saves nothing.
 */
export function reimportJob(deps: PptxDeps, env: NativeJobEnv = {}): JobHandler<PptxReimportPayload> {
  return async (ctx) => {
    const pl = ctx.payload;
    const p0 = deps.lib.presentations.get(pl.presentationId);
    if (!p0) throw notFound('The presentation is gone');
    if (deps.locked(p0.id)) deferWhileLocked(ctx);
    if (followUpActive(deps, p0.id)) deferWhileFollowUp();
    if (deckOf(p0) !== pl.hash)
      throw new Error(
        'The presentation no longer comes from the PowerPoint file this re-import was asked for',
      );
    if (!deps.lib.getFile(pl.hash)) throw new Error('The PowerPoint file is no longer stored');
    const media = (id: string) => deps.lib.media.get(id);
    const tags: MediaTags = (id) => media(id)?.tags;
    const names: MediaNames = (id) => media(id)?.name;
    const req: PptxReimportReq = {
      ...(pl.slideIds ? { slideIds: pl.slideIds } : {}),
      ...(pl.reset ? { reset: pl.reset } : {}),
      ...(pl.keep ? { keep: pl.keep } : {}),
    };
    const plan = planReimport(p0, req, tags);
    const todo = plan.slides.filter((s) => s.action === 'regenerate' || s.action === 'replace');
    const edited = plan.slides.filter((s) => s.action === 'keep-edited').length;
    if (!todo.length) {
      ctx.log('nothing to re-import: no slide of this presentation comes unedited from its PowerPoint file');
      return zero(p0.id, edited);
    }
    ctx.log(`re-importing ${todo.length} slide(s) from the stored PowerPoint file`);

    // Steps 1-5 of the native import, under this presentation's id, its resume points in this payload.
    const nctx: JobCtx<PptxNativePayload> = {
      id: ctx.id,
      payload: {
        hash: pl.hash,
        name: p0.title,
        ...(pl.options ? { options: pl.options } : {}),
        done: { media: [], ...pl.done, presentationId: p0.id },
      },
      signal: ctx.signal,
      log: (m) => ctx.log(m),
      progress: (f) => ctx.progress(0.9 * f),
      setPayload: (np) => {
        nctx.payload = np;
        ctx.setPayload({ ...ctx.payload, ...(np.done ? { done: np.done } : {}) });
      },
    };
    let build: NativeBuild;
    try {
      build = await buildNative(deps, nctx, {
        ...env,
        only: scopeOf(p0, req, tags, names),
        reserve: keptBytes(p0, plan, !!req.slideIds),
      });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      throw new Error(`The PowerPoint file could not be converted again: ${logSafe(errorMessage(e), 300)}`);
    }
    const fresh = freshOf(build, !req.slideIds);
    const clips = [...new Set([...build.clipIds, ...build.clipsCreated])];

    // Merged into the newest copy and saved in the same synchronous step; a save that meets a newer
    // revision (another process) merges again.
    for (let attempt = 1; ; attempt++) {
      const cur = deps.lib.presentations.get(p0.id);
      if (!cur) {
        for (const id of clips) deps.media.queue(id);
        throw notFound('The presentation was deleted during the re-import');
      }
      // Live now, or a follow-up queued meanwhile (a save brought back waiting slides): the conversion runs
      // again later, its pictures and clips resumed from this payload (the clips' media jobs go now).
      const locked = deps.locked(cur.id);
      if (locked || followUpActive(deps, cur.id)) {
        for (const id of clips) deps.media.queue(id);
        if (locked) deferWhileLocked(ctx);
        deferWhileFollowUp();
      }
      if (deckOf(cur) !== pl.hash) throw new Error('The presentation was changed to another PowerPoint file');
      const m = mergeReimport(cur, fresh, req, tags, names);
      if (m.p === cur) {
        for (const id of clips) deps.media.queue(id);
        ctx.log('nothing changed: every slide is as the PowerPoint file and this converter make it');
        return { presentationId: cur.id, ...m.counts } satisfies PptxReimportResult;
      }
      const parsed = PresentationSchema.parse(m.p);
      const bytes = presentationBytes(parsed);
      if (bytes > SIZE_BUDGETS.presentationMax)
        ctx.log(
          `[warn] the presentation is ${formatBytes(bytes)} after the re-import, over its ${formatBytes(SIZE_BUDGETS.presentationMax)} budget: going live and snapshots may be slow`,
        );
      let loJobId: string | undefined;
      try {
        const saved = deps.lib.db.transaction(() => {
          const s = deps.lib.savePresentation(parsed, { expectedRev: cur.rev, by: REIMPORT_BY });
          let after: Job | undefined;
          if (m.lo.length) {
            after = enqueuePptx(deps.jobs, PPTX_JOBS.lo, {
              presentationId: s.id,
              hash: pl.hash,
              version: CONVERTER_VERSION,
              slides: m.lo,
              ...earlierWork(deps, s.id, pl.hash, m.lo),
            });
            loJobId = after.id;
          }
          // The clips' media jobs, after the follow-up (jobs of a class run in creation order).
          for (const id of clips) after = deps.media.queue(id, after ? { after } : {}) ?? after;
          return s;
        })();
        deps.lib.emit([{ kind: 'presentation', id: saved.id, rev: saved.rev, entity: saved }]);
        ctx.log(
          `${summaryLine(m.counts)}; revision ${saved.rev}` +
            (loJobId ? `; LibreOffice follows for ${m.lo.length} slide(s)` : ''),
        );
        ctx.progress(1);
        return { presentationId: saved.id, rev: saved.rev, ...m.counts } satisfies PptxReimportResult;
      } catch (e) {
        if (e instanceof HttpError && e.status === 409 && attempt < SAVE_TRIES) continue;
        for (const id of clips) deps.media.queue(id);
        throw e;
      }
    }
  };
}
