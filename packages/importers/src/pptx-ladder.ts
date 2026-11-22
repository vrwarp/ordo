/**
 * The native import's budget ladder (design/27 §3.4, M9 `ladder`; plan decision 3, steps 4 and 5): what the
 * hub stores of each slide so that no slide is a picture for its size (on a hub with LibreOffice, a slide this
 * ladder would fit plain or minimal keeps LibreOffice's page instead: `pptx-core.ts` `ImportCore.pageForBudget`).
 *
 * - **A slide over 64 KB** as the hub stores it (`storedBytes`) takes the first level of `@ordo/domain`
 *   `fitSlideBudget` that fits: its outlines re-gridded, then its text formatting dropped (the largest first),
 *   then its decorations left out (the largest first). Text, pictures and the background always stay.
 * - **The presentation's tail**: once the import passes `SIZE_BUDGETS.presentationCompact`, or the rest would
 *   not fit `presentationMax`, the slides from there on are stored minimal (`minimalSlide`: their text,
 *   pictures and background, a page drawn as a shape kept as the slide's colour), `planImportSizes` taking the
 *   minimal form's size as the compact one. A deck that does not fit even so (about 4,000 slides) is planned
 *   again with minimal forms without their pages, before any text is cut.
 * - **Outline files past the import's budget** (`PPTX_LIMITS.geomFileBytes`, or a file that could not be
 *   stored): the objects that name one are left out (a shape) or lose their mask (a picture), never the slide
 *   (`withoutFiles`).
 *
 * What the ladder leaves out is recorded as `Slide.pptx.missing` ('decoration', 'chart') by the job, with or
 * without LibreOffice: nothing draws it (LibreOffice draws no budget's art, plan §6.1).
 *
 * Pure and portable (the import core of `@ordo/importers`): the hub's job (`nativeJob.ts`, through
 * `pptx-core.ts` `ImportCore.budget`), the client's assembly (`pptx-client.ts`, the Pages demo) and the
 * fidelity harness (`tools/pptx-fidelity` `census.ts`, `native.ts` `--hub-budget`) plan with the same
 * functions.
 */
import {
  type BudgetFit,
  type BudgetLevel,
  fitSlideBudget,
  gridSlide,
  IMPORT_RESERVE_BYTES,
  type ImportSizePlan,
  jsonBytes,
  MISSING_LIMITS,
  type MissingKind,
  minimalSlide,
  planImportSizes,
  type Presentation,
  SIZE_BUDGETS,
  Slide,
  type SlideObject,
  type SlidePptx,
} from '@ordo/domain';
import { MAX_DRAWN_OBJECTS, MAX_DRAWN_PICTURES } from '@ordo/pptx-scene/budget.ts';
import { sanitizePresentation } from './sanitize.ts';

/** Characters of an id as the hub writes it (a ULID) and of a stored file's name (a SHA-256 in hex). */
const ID_CHARS = 26;
const REF_CHARS = 64;
/**
 * How far within the budget `quickBytes` must be for `storedWithin` to trust it: the converter writes every
 * field the schema would default, so sanitizing (which rounds and cuts) and parsing change a slide's JSON by
 * far less than this (measured: within 1 % on typical slides, about 10 % smaller on shape-heavy ones).
 */
const QUICK_MARGIN_BYTES = 2 * 1024;

/** An id counted at a ULID's length (the converter's own `pptx-<n>` are shorter). */
function idPad(v: unknown): number {
  return typeof v === 'string' ? Math.max(0, ID_CHARS - v.length) : 0;
}

/** A geometry ref counted at a SHA-256's length (the converter's placeholders `pptxgeom:<n>` are shorter). */
function refPad(o: SlideObject): number {
  const g = o.type === 'shape' ? o.geom : o.type === 'image' ? o.mask : undefined;
  const ref = g?.ref;
  return typeof ref === 'string' ? Math.max(0, REF_CHARS - ref.length) : 0;
}

/** What padding ids and refs adds to a slide's JSON. */
function pads(slide: Slide): number {
  let n = idPad(slide.id) + idPad(slide.lyricObjectId);
  for (const o of Array.isArray(slide.objects) ? slide.objects : []) n += idPad(o.id) + refPad(o);
  return n;
}

/**
 * A slide's bytes as the hub stores it, `pptx` included: sanitized as the import sanitizes every slide
 * (`sanitizePresentation`: boxes to 0.01 px, colours, bounds), parsed (`Slide.safeParse`: the schema's
 * defaults filled in), its ids and geometry refs counted at the length the hub writes them. The converter's
 * own estimate (`storedSlideBytes`) is about 10 % over this on shape-heavy slides (unrounded boxes), which made
 * slides of 57-60 KB pictures before M9 (wave 0 review). `slide` is not changed.
 */
export function storedBytes(slide: Slide): number {
  try {
    const copy = structuredClone(slide);
    const p: Presentation = {
      id: 'p',
      rev: 1,
      title: 'p',
      kind: 'slides',
      meta: { tags: [] },
      sections: [{ id: 's', label: 'Slides', short: 'S', slides: [copy] }],
      arrangements: [],
      archived: false,
    };
    sanitizePresentation(p);
    const sanitized = p.sections[0]!.slides[0]!;
    const parsed = Slide.safeParse(sanitized);
    const out = parsed.success ? parsed.data : sanitized;
    return jsonBytes(out) + pads(out);
  } catch {
    return jsonBytes(slide) + pads(slide);
  }
}

/**
 * A fast estimate of `storedBytes` (about 20 times faster): the slide's JSON with its ids and refs padded, not
 * sanitized nor parsed. What the presentation's plan sums (`planLadder`).
 */
export function quickBytes(slide: Slide): number {
  return jsonBytes(slide) + pads(slide);
}

/**
 * `storedBytes` for a slide near or over `max`, else `quickBytes`: a slide is measured exactly wherever the
 * budget's decision depends on it.
 */
export function storedWithin(slide: Slide, max: number): number {
  const quick = quickBytes(slide);
  return quick + QUICK_MARGIN_BYTES <= max ? quick : storedBytes(slide);
}

/** One slide the ladder plans: the slide with its provenance as it will be stored (`Slide.pptx`). */
export type LadderInput = {
  slide: Slide;
  /**
   * Left as it is (a picture-class slide, which keeps no objects): counted at its size, never fitted and
   * never made minimal.
   */
  fixed?: boolean;
  /**
   * Q24.b: a slide kept whole (`ImportCore.budget`: heavy and eligible, within the share): never fitted, simplified
   * or put in the tail; its level is 'full', or 'grid' past 64 KiB (`wholeLevel`), and its bytes are the
   * presentation's reserve for the plan of the others.
   */
  whole?: true;
  /**
   * The slide's bytes as `storedWithin` counts them, when the caller measured this very slide already (`ImportCore.budget`
   * does, to tell a slide that cannot be heavy): used for the slide as given, never for a form of it the ladder makes, so
   * the plan is the plan without it and the slide is measured once (Q24.b, M4).
   */
  size?: number;
};

/** What the ladder stores of one slide. */
export type LadderSlide = {
  /** The slide as it is stored (its `pptx` as given). */
  slide: Slide;
  /** The level `fitSlideBudget` kept; 'minimal' for a slide of the tail too. */
  level: BudgetLevel;
  /** Stored minimal for the presentation's budget (`planImportSizes`' tail). */
  tail: boolean;
  /** Its bytes as `storedWithin` counts them (the tail's and fixed slides' by `quickBytes`). */
  bytes: number;
  /** Objects left out (decorations, charts). */
  dropped: number;
  /** Text objects and tables left without their formatting. */
  plain: number;
  /** What the left-out objects drew ('decoration', 'chart'), each once. */
  missing: MissingKind[];
  /** Q24.b: the slide was planned whole (`LadderInput.whole`): level 'full' or 'grid', never simplified, never in the tail. */
  whole?: true;
};

export type LadderPlan = { slides: LadderSlide[]; plan: ImportSizePlan };

/**
 * What a slide KEPT WHOLE is stored as (Q24.b, D9): as it is within `max`, else its outlines re-gridded
 * (`gridSlide`: lossless on screen, no point moves by more than 1/32 px) and then STOPPED: nothing is left out and
 * no formatting is dropped (`fitSlideBudget` is not called), so the slide stays over `max` and its record says
 * `bytes`. `size` is the caller's measure (`storedWithin`). Pure; never throws.
 */
export function wholeLevel(
  slide: Slide,
  max: number,
  size: (s: Slide) => number,
): { slide: Slide; level: 'full' | 'grid'; bytes: number } {
  const full = size(slide);
  if (full <= max) return { slide, level: 'full', bytes: full };
  const grid = gridSlide(slide);
  return { slide: grid, level: 'grid', bytes: grid === slide ? full : size(grid) };
}

/**
 * A slide cut to what the screens draw (the live clamp's rule, `@ordo/renderer` `clampSlide`): the first
 * `MAX_DRAWN_OBJECTS` objects from the bottom, and no picture of a 17th distinct image (`MAX_DRAWN_PICTURES`). What
 * a presentation does to a heavy slide past its share of whole ones (`ImportCore.budget`, Q28.a), and nothing else
 * does: the objects it keeps are the objects the screens draw today. `left` counts the objects left out; `kinds`
 * says what they drew as `Slide.pptx.missing` kinds do ('decoration' for shapes and pictures, 'element' for text
 * and tables), each once. A lyric id that is gone is cleared. The same slide object comes back when nothing is
 * left; junk (a slide without a list of objects) is returned as it is. Pure; never throws.
 */
export function trimToCounts(slide: Slide): { slide: Slide; left: number; kinds: MissingKind[] } {
  try {
    const src: readonly SlideObject[] = Array.isArray(slide?.objects) ? slide.objects : [];
    const kept: SlideObject[] = [];
    const images = new Set<string>();
    const kinds: MissingKind[] = [];
    let left = 0;
    for (const o of src) {
      let keep = kept.length < MAX_DRAWN_OBJECTS;
      if (keep && o?.type === 'image') {
        if (!images.has(o.mediaId) && images.size >= MAX_DRAWN_PICTURES) keep = false;
        else images.add(o.mediaId);
      }
      if (keep) {
        kept.push(o);
        continue;
      }
      left++;
      const k: MissingKind =
        o?.type === 'text' || (o?.type === 'shape' && (o.table !== undefined || o.chart !== undefined))
          ? 'element'
          : 'decoration';
      if (!kinds.includes(k) && kinds.length < MISSING_LIMITS.entries) kinds.push(k);
    }
    if (!left) return { slide, left: 0, kinds: [] };
    const out: Slide = { ...slide, objects: kept };
    if (out.lyricObjectId && !kept.some((o) => o.id === out.lyricObjectId)) delete out.lyricObjectId;
    return { slide: out, left, kinds };
  } catch {
    return { slide, left: 0, kinds: [] };
  }
}

/** The kinds a left-out object drew: a chart's, else decoration. */
function droppedKinds(before: Slide, after: Slide): { dropped: number; missing: MissingKind[] } {
  const kept = new Set(after.objects.map((o) => o.id));
  const missing: MissingKind[] = [];
  let dropped = 0;
  for (const o of before.objects) {
    if (kept.has(o.id)) continue;
    dropped++;
    const k: MissingKind = o.type === 'shape' && o.chart ? 'chart' : 'decoration';
    if (!missing.includes(k)) missing.push(k);
  }
  return { dropped, missing };
}

/** Text objects and tables that had formatting and have none in `after`. */
function plainCount(before: Slide, after: Slide): number {
  const formatted = (o: SlideObject) =>
    o.type === 'text'
      ? o.runs !== undefined || o.paras !== undefined
      : o.type === 'shape' &&
        !!o.table &&
        (o.table.runStyles !== undefined ||
          (Array.isArray(o.table.cells) && o.table.cells.some((c) => c?.runs || c?.paras)));
  const was = new Set(before.objects.filter(formatted).map((o) => o.id));
  let n = 0;
  for (const o of after.objects) if (was.has(o.id) && !formatted(o)) n++;
  return n;
}

/** The measure `fitSlideBudget` asks for: the caller's for the slide as given, `storedWithin` for any other form. */
const measureOf = (x: LadderInput, max: number) => (s: Slide) =>
  x.size !== undefined && s === x.slide ? x.size : storedWithin(s, max);

/**
 * The ladder over an import's slides, in deck order: each slide fitted to `SIZE_BUDGETS.slideMax`
 * (`fitSlideBudget` against `storedBytes`), then `planImportSizes` over the fitted sizes with each slide's
 * minimal form as its compact size, and the tail stored minimal. `reserve` is what the presentation holds
 * besides its slides (`IMPORT_RESERVE_BYTES`, plus a re-import's kept slides). Pure.
 */
export function planLadder(
  inputs: readonly LadderInput[],
  reserve: number = IMPORT_RESERVE_BYTES,
): LadderPlan {
  const max = SIZE_BUDGETS.slideMax;
  if (inputs.some((x) => x.whole === true && !x.fixed)) return planWithWhole(inputs, reserve, max);
  const fits: (BudgetFit | undefined)[] = inputs.map((x) =>
    x.fixed ? undefined : fitSlideBudget(x.slide, max, { size: measureOf(x, max) }),
  );
  const sizes = inputs.map((x, i) => fits[i]?.bytes ?? quickBytes(x.slide));
  const tailOf = (page: boolean) => {
    const minimal = inputs.map((x, i) => (x.fixed ? undefined : minimalSlide(fits[i]!.slide, { page })));
    const plan = planImportSizes(
      sizes,
      inputs.map((_, i) => (minimal[i] ? quickBytes(minimal[i]!) : sizes[i]!)),
      reserve,
    );
    return { minimal, plan };
  };
  // The tail keeps each slide's page (its background colour) while the deck fits with it; a deck that does not
  // fit the presentation budget (8 MiB) even then (about 4,000 slides) leaves the pages out rather than cut the text of every slide.
  let tail = tailOf(true);
  if (!tail.plan.fits) tail = tailOf(false);
  const { minimal, plan } = tail;
  const slides = inputs.map((x, i): LadderSlide => {
    const fit = fits[i];
    if (!fit)
      return {
        slide: x.slide,
        level: 'full',
        tail: false,
        bytes: sizes[i]!,
        dropped: 0,
        plain: 0,
        missing: [],
      };
    if (plan.reasons[i] !== 'presentation')
      return {
        slide: fit.slide,
        level: fit.level,
        tail: false,
        bytes: fit.bytes,
        dropped: fit.dropped,
        plain: fit.plain,
        missing: fit.missing,
      };
    const m = minimal[i]!;
    const gone = droppedKinds(x.slide, m);
    return {
      slide: m,
      level: 'minimal',
      tail: true,
      bytes: quickBytes(m),
      dropped: gone.dropped,
      plain: plainCount(x.slide, m),
      missing: gone.missing,
    };
  });
  return { slides, plan };
}

/**
 * `planLadder` with slides kept whole (Q24.b, D9): they are planned FIRST. Each is stored by `wholeLevel` (never
 * fitted, simplified or tailed) and its bytes join the presentation's reserve for the plan of the others, so they
 * count against the 8 MiB bound but never push an ordinary slide over the 6 MiB mark (`planImportSizes` measures that
 * mark on the running total of the slides it plans, which excludes the reserve): a heavy slide late in a deck does not
 * make the slides after it minimal, and an early one does not make the later ones tail sooner. The returned plan is
 * over the whole deck: `compact` and `reasons` hold nothing for a whole slide, `tailFrom` is the place in the deck of
 * the first tailed ordinary slide, and `total` includes the whole slides' bytes (what `ImportCore.budget` weighs the
 * LibreOffice pages against).
 */
function planWithWhole(inputs: readonly LadderInput[], reserve: number, max: number): LadderPlan {
  const whole = new Map<number, ReturnType<typeof wholeLevel>>();
  inputs.forEach((x, i) => {
    if (x.whole === true && !x.fixed) whole.set(i, wholeLevel(x.slide, max, measureOf(x, max)));
  });
  let heavy = 0;
  for (const w of whole.values()) heavy += w.bytes;
  const rest = inputs.map((_, i) => i).filter((i) => !whole.has(i));
  const sub = planLadder(
    rest.map((i) => inputs[i]!),
    reserve + heavy,
  );
  const slides: LadderSlide[] = [];
  const compact: boolean[] = [];
  const reasons: ImportSizePlan['reasons'] = [];
  let r = 0;
  inputs.forEach((_, i) => {
    const w = whole.get(i);
    if (w) {
      slides.push({
        slide: w.slide,
        level: w.level,
        tail: false,
        bytes: w.bytes,
        dropped: 0,
        plain: 0,
        missing: [],
        whole: true,
      });
      compact.push(false);
      reasons.push(null);
    } else {
      slides.push(sub.slides[r]!);
      compact.push(sub.plan.compact[r]!);
      reasons.push(sub.plan.reasons[r]!);
      r++;
    }
  });
  const plan: ImportSizePlan = {
    ...sub.plan,
    compact,
    reasons,
    total: sub.plan.total + heavy,
    tailFrom: sub.plan.tailFrom < 0 ? -1 : rest[sub.plan.tailFrom]!,
  };
  return { slides, plan };
}

/**
 * `slide` without what names a shape file `keep` refuses (one past the import's budget, or one the store
 * could not take): a shape whose geometry or decoration (M9 `DecorData.ref`) is in such a file is left out (its
 * file never arrives, and its legacy shape would stand where a traced outline was; a decoration would draw
 * nothing), a picture keeps its box without the mask. Returns the slide (the same object when nothing names
 * such a file), the shapes left out, the masks dropped and what the shapes drew.
 */
export function withoutFiles(
  slide: Slide,
  keep: (ref: string) => boolean,
): { slide: Slide; dropped: number; unmasked: number; missing: MissingKind[] } {
  let dropped = 0;
  let unmasked = 0;
  const missing: MissingKind[] = [];
  const objects: SlideObject[] = [];
  for (const o of slide.objects) {
    if (
      o.type === 'shape' &&
      ((typeof o.geom?.ref === 'string' && !keep(o.geom.ref)) ||
        (typeof o.decor?.ref === 'string' && !keep(o.decor.ref)))
    ) {
      dropped++;
      const k: MissingKind = o.chart ? 'chart' : 'decoration';
      if (!missing.includes(k)) missing.push(k);
      continue;
    }
    if (o.type === 'image' && typeof o.mask?.ref === 'string' && !keep(o.mask.ref)) {
      const { mask: _, ...rest } = o;
      objects.push(rest);
      unmasked++;
      continue;
    }
    objects.push(o);
  }
  if (!dropped && !unmasked) return { slide, dropped, unmasked, missing };
  const out: Slide = { ...slide, objects };
  if (out.lyricObjectId && !objects.some((o) => o.id === out.lyricObjectId)) delete out.lyricObjectId;
  return { slide: out, dropped, unmasked, missing };
}

/**
 * The provenance a slide is measured with before the job writes its own (`nativeJob.ts` `provenance`): as
 * long as the job's, the file named by a SHA-256 and the digest by a stand-in of `digestOf`'s length. For
 * the harness, which measures emitted slides as the hub will store them.
 */
export function provenanceStandIn(o: {
  index: number;
  shown?: number;
  cls: SlidePptx['class'];
  version: number;
  notes?: readonly string[];
  artText?: string;
  missing?: readonly string[];
}): SlidePptx {
  return {
    fileId: 'x'.repeat(64),
    index: o.index,
    ...(o.shown !== undefined ? { shown: o.shown } : {}),
    class: o.cls,
    version: o.version,
    ...(o.missing?.length ? { missing: o.missing.slice(0, 16) } : {}),
    ...(o.notes?.length ? { notes: o.notes.slice(0, 16).map((n) => n.slice(0, 400)) } : {}),
    ...(o.artText ? { artText: o.artText } : {}),
    digest: 'x'.repeat(16),
  };
}
