/**
 * The import core of a native PowerPoint import (design/27 §2 steps 3-5, §3.4, §5; M9 `ladder`): from the
 * converted slides of a deck to version 1 as it is stored, the one copy the hub's job (`apps/hub/src/pptx/
 * nativeJob.ts`, its own parse and a client scene alike) and the client's assembly (`pptx-client.ts`
 * `assemblePptxScene`, the Pages demo and the fidelity harness) share. Pure TypeScript: runs in Node,
 * browsers and Web Workers. What touches the store (spilling, pictures, clips, outline files) stays with the
 * caller, which hands the results in.
 *
 * - **Drafts** (`ImportCore.drafts`): one per listed slide with its class, notes (the whole presentation's
 *   speaker notes within `NOTES_TOTAL_BYTES`), hidden flag, transition and timing; a slide nothing could read
 *   is an empty hybrid slide that says so; the metafiles it draws wait for LibreOffice or are listed missing;
 *   without LibreOffice what it would have drawn is listed (`gaps`).
 * - **Budgets** (`ImportCore.budget`): the §3.4 budgets as M9's budget ladder (`pptx-ladder.ts`): outline
 *   files within the import's budget, each slide within 64 KB, the presentation within 4 MiB (its tail stored
 *   minimal). Without LibreOffice no slide becomes a picture for its size: the client's old compact step is
 *   gone. With LibreOffice, a slide over 64 KB that the ladder would store without its formatting or
 *   decorations ('plain', 'minimal') keeps LibreOffice's page instead, as before M9 (`pageForBudget`): a hub
 *   with LibreOffice never shows less of a slide than one without it, nor less than before M9.
 * - **Assembly** (`ImportCore.assemble`): placeholders remapped (`remapMediaIds`), a background with alpha
 *   laid on white, one background on every slide made the presentation's, provenance (`Slide.pptx`),
 *   sections and the Default arrangement, `sanitizePresentation`, `Slide.safeParse` (a refused slide stored
 *   minimal, else as its text), the digest of the import's objects (`importDigest`), the LibreOffice
 *   follow-up's plan (`loSlides`) and the families the library lacks.
 *
 * A slide is picture class when the converter classes it so (more pictures than a slide may hold), or, with
 * LibreOffice only, when its slide budget would store it plain or minimal; no failure makes one (M9, plan
 * decision 3; the before-hub gate of decision 2 for hubs with LibreOffice).
 */
import {
  type Box,
  compactSlideBytes,
  drawnGeomRefs,
  formatBytes,
  IMPORT_RESERVE_BYTES,
  type ImageObject,
  MISSING_LIMITS,
  type MissingKind,
  minimalSlide,
  missingEntry,
  missingKind,
  missingLabel,
  newId,
  Presentation,
  type Section,
  type ShapeObject,
  SIZE_BUDGETS,
  Slide,
  type SlideObject,
  type SlidePptx,
  type TextObject,
  utf8Bytes,
} from '@ordo/domain';
import {
  addNote,
  type ArtInfo,
  type EmittedClip,
  type EmittedSlide,
  CLIP_PREFIX,
  MEDIA_PREFIX,
  rowOf,
  type SectionInfo,
  type SlideClass,
  type SlideRef,
} from '@ordo/pptx-scene';
import { digestOf, SLIDE_BUDGET_NOTE, SLIDE_BYTES_NOTE } from '@ordo/pptx-scene/emit.ts';
import { CONVERTER_VERSION } from '@ordo/pptx-scene/version.ts';
import type { NamedGeomFile } from './pptx-geoms.ts';
import { type LadderSlide, planLadder, withoutFiles } from './pptx-ladder.ts';
import { type ImportLog, logSafe, missingFonts } from './pptx-report.ts';
import type { SceneScan, SceneSlideExtra } from './pptx-scan.ts';
import { remapMediaIds } from './remap.ts';
import { clampBox, sanitizePresentation } from './sanitize.ts';

/** Speaker notes kept for the whole presentation (§3.4: notes travel with every presentation); past it, cut. */
export const NOTES_TOTAL_BYTES = 1024 * 1024;

/**
 * The import log's line for a deck classified as an announcement loop (PowerPoint plays it looping, every
 * shown slide timed), on both paths: the import report says what a loop does and offers 'Treat as slides'.
 */
export const LOOP_IMPORT_NOTE =
  'PowerPoint plays this deck as a loop with every slide timed: imported as an announcement loop (the import report can treat it as slides)';
/** Notes of a slide past `NOTES_TOTAL_BYTES` keep this many characters. */
const NOTES_CUT_CHARS = 200;
/** A slide's `pptx.notes` (the schema's bound). */
const SLIDE_NOTES = 16;
/** The text of a picture-class slide kept for search (`MAX.text` of `@ordo/domain`). */
const ART_TEXT_CHARS = 20_000;
/** That text on a deck too large for its budget even with every slide compact (§3.4). */
const COMPACT_TEXT_CHARS = 200;
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

/** One converted slide, with its media map (placeholder → part) and what the import reads beside it. */
export type Converted = {
  s: EmittedSlide;
  media: Map<string, string>;
  extra?: SceneSlideExtra;
  /**
   * Objects a bound on outline files left out (a batch's `geomOver`, or a client scene's: the slide's new
   * files did not fit), with what they drew.
   */
  geomLeft?: { dropped: number; unmasked: number; missing: MissingKind[] };
  /** Only its text, from the rescue (M9 `ladder`): its conversion failed. */
  rescued?: boolean;
};

/** One slide on its way to version 1. */
export type Draft = {
  ref: SlideRef;
  slide: Slide;
  /** Its batch's placeholder ids → picture parts (`EmitResult.media`). */
  media: Map<string, string>;
  cls: SlideClass;
  /**
   * The converter's notes, then the import's, each added with `addNote` (as the converter adds its own), so
   * the list stays within the schema's 16 with 'and N more' last and a note of the import's is counted, not
   * cut.
   */
  notes: string[];
  /** Hybrid slides: what the art holds (`EmittedSlide.art`, item D). */
  art?: ArtInfo;
  /** Text baked into the art or the page picture (`pptx.artText`). */
  artText?: string;
  /**
   * M9 `ladder`: what the budgets or a failure left out of the slide (`Slide.pptx.missing` entries: decoration,
   * chart, slide), with LibreOffice or without (nothing draws it; the guard's left-outs are LibreOffice's art
   * on a hub with it, `budgetLeft`).
   */
  dropped?: string[];
  /** The budget ladder simplified it (`simplified` in the result). */
  simplified?: boolean;
  /**
   * Metafile pictures version 1 leaves out (`EmittedSlide.metafiles`, item D): LibreOffice converts each part
   * and the follow-up puts the object back just under `before`.
   */
  metafiles?: { part: string; object: ImageObject; before?: string }[];
  /** The clips the slide plays or names (`EmittedSlide.clips`, `clips.ts`). */
  clips?: EmittedClip[];
  /**
   * M9, without LibreOffice: what nothing draws on the slide (`Slide.pptx.missing` entries). A picture-class
   * slide lists 'slide' instead (`provenance`).
   */
  missing?: string[];
  /** M9, with LibreOffice: the kinds its art holds (`artKinds`), for `PptxLoSlide.kinds`. */
  artKinds?: MissingKind[];
};

/** One slide of the LibreOffice follow-up, as version 1 left it (the hub's `pptx-lo` payload). */
export type PptxLoSlide = {
  slideId: string;
  /** `SlideRef.index`: the slide in the render copy. */
  index: number;
  /** `SlideRef.shown`: its page in a print of the shown slides. */
  shown?: number;
  class: SlideClass;
  /** Hybrid slides: the art to draw (`EmittedSlide.art`). */
  art?: ArtInfo;
  /**
   * Metafile pictures version 1 left out, as emitted (their `mediaId` any placeholder): once LibreOffice has
   * converted `part`, each goes in just under the object `before` names (on top when absent or gone; on top
   * with a note when the slide was edited).
   */
  metafileObjects?: { part: string; object: ImageObject; before?: string }[];
  /** Version 1's digest of the slide (`Slide.pptx.digest`): the follow-up patches only an unedited slide. */
  digest: string;
  /**
   * Version 1's objects of `ArtInfo.replaces`, each with `digestOf([object])`: [id, digest] pairs. On a slide
   * edited meanwhile the art still replaces those that are exactly as they were.
   */
  replaced?: [string, string][];
  /**
   * M9: what the slide lacks if LibreOffice never draws it (`Slide.pptx.missing` entries, `@ordo/domain`
   * `MISSING_KINDS`): written when a hub that lost LibreOffice clears `pending` (`withoutLibreOffice`).
   * Absent in plans made before M9 (the kinds are then read from the slide's class).
   */
  kinds?: string[];
};

/** What `ImportCore.assemble` needs besides the drafts and their stored pictures. */
export type AssembleInput = {
  /** The presentation's id, chosen before the save. */
  id: string;
  /** Its title (the upload's file name, one line). */
  title: string;
  /** The deck's SHA-256 (`Slide.pptx.fileId`, `source.fileId`). */
  hash: string;
  sections: readonly SectionInfo[];
  slideRect: { x: number; y: number; w: number; h: number };
  scan: Pick<SceneScan, 'loop'>;
  /** Whether a stored picture (its media id) has alpha: a background with alpha is laid on white. */
  hasAlpha(mediaId: string): boolean;
  /** Media ids of the deck's clips: never the presentation's background. */
  clipIds: ReadonlySet<string>;
  /** The families the library's fonts cover (the import card offers an upload for the rest). */
  libraryFamilies: Iterable<string>;
};

/** Version 1 as `ImportCore.assemble` builds it. */
export type Assembled = {
  /** The presentation (sanitized, parsed, digests set, `source.native`, `source.log`). */
  p: Presentation;
  /** The LibreOffice follow-up of its slides that wait (`pptx.pending`). */
  lo: PptxLoSlide[];
  missingFonts: string[];
};

export type ImportCoreOptions = {
  /** LibreOffice can draw what ordo cannot (the hub's `HubTools`; a client parse for such a hub). */
  lo: boolean;
  /** `source.log`. */
  log: ImportLog;
  /** A warning of `kind`: the caller writes it to `log` (and, on the hub, to the job's log within bounds). */
  warn: (kind: string, msg: string) => void;
  /** Bytes of outline files the import stores (`PPTX_IMPORT_LIMITS.geomFileBytes`; tests set less). */
  geomFileBytes: number;
  /**
   * A re-import: the bytes of the stored slides it keeps as they are, which share the presentation's size
   * budget with the slides it builds (§3.4).
   */
  reserve?: number;
};

/** One import's steps 3-5 and the state they share (see the module comment). */
export class ImportCore {
  readonly log: ImportLog;
  /** LibreOffice can draw what ordo cannot (decided once the tools are known). */
  lo: boolean;
  /** The deck's outline files by name: what the kept slides' refs name. */
  readonly geomFiles = new Map<string, NamedGeomFile>();
  /** Bytes of `geomFiles`. */
  geomBytes = 0;
  /** The names of files dropped past the import's budget as they arrived. */
  readonly geomDropped = new Set<string>();
  private readonly warnTo: (kind: string, msg: string) => void;
  private readonly geomFileBytes: number;
  private readonly reserve: number;

  constructor(o: ImportCoreOptions) {
    this.log = o.log;
    this.lo = o.lo;
    this.warnTo = o.warn;
    this.geomFileBytes = o.geomFileBytes;
    this.reserve = Number.isFinite(o.reserve) && (o.reserve ?? 0) > 0 ? o.reserve! : 0;
  }

  /** A warning (`ImportCoreOptions.warn`). */
  warn(kind: string, msg: string): void {
    this.warnTo(kind, msg);
  }

  /**
   * An outline file of the deck as it arrives (a batch's, or a client scene's after its check): kept within
   * the import's budget, else dropped at once (step 3 leaves out what names it). A file known already is
   * left as it is.
   */
  addGeomFile(f: NamedGeomFile): void {
    if (this.geomFiles.has(f.hash) || this.geomDropped.has(f.hash)) return;
    if (this.geomBytes + f.bytes.length > this.geomFileBytes) {
      this.geomDropped.add(f.hash);
      return;
    }
    this.geomFiles.set(f.hash, f);
    this.geomBytes += f.bytes.length;
  }

  /** Step 3: one draft per listed slide with its class, notes, hidden flag, transition and timing. */
  drafts(listed: readonly SlideRef[], converted: Map<number, Converted>, scan: SceneScan): Draft[] {
    const notes = new Map(scan.notes);
    let notesBytes = 0;
    let notesCut = 0;
    const drafts = listed.map((ref) => {
      const c = converted.get(ref.index);
      const label = `slide ${ref.index + 1}`;
      // The converter's budget notes: the job notes what its own budget ladder did (step 3).
      const own = c ? c.s.notes.filter((n) => n !== SLIDE_BUDGET_NOTE && n !== SLIDE_BYTES_NOTE) : [];
      const d: Draft = c
        ? {
            ref,
            slide: { ...c.s.slide, objects: c.s.slide.objects.map(imported) },
            media: c.media,
            cls: c.s.classification.class,
            notes: own,
            ...(c.s.art && !c.rescued ? { art: c.s.art, artText: c.s.art.text } : {}),
            ...(c.s.clips?.length && !c.rescued ? { clips: c.s.clips } : {}),
          }
        : {
            // Nothing of it could be read, not even its text (M9: never a picture).
            ref,
            slide: { id: newId(), objects: [] },
            media: new Map(),
            cls: 'hybrid',
            notes: ['not converted: nothing of it could be read'],
            dropped: [missingEntry('slide')],
          };
      if (c?.rescued) {
        d.cls = 'hybrid';
        d.dropped = addMissing(d.dropped, 'slide');
      }
      if (d.cls !== 'picture' && (c?.geomLeft?.dropped || c?.geomLeft?.unmasked))
        this.leftOut(d, c.geomLeft, 'batch');
      for (const n of own) this.log.add('info', `${label}: ${n}`);
      if (c?.s.classification.class === 'picture')
        this.log.add('info', `${label}: picture class (${c.s.classification.reasons.join(', ')})`);
      if (ref.hidden) d.slide.hidden = true;
      let text = notes.get(ref.index);
      if (text) {
        const bytes = utf8Bytes(text);
        if (notesBytes + bytes > NOTES_TOTAL_BYTES) {
          text = text.slice(0, NOTES_CUT_CHARS);
          notesCut++;
        }
        notesBytes += utf8Bytes(text);
        d.slide.notes = text;
      }
      const x = c?.extra;
      if (x?.transition) d.slide.transition = x.transition;
      if (x?.advanceMs !== undefined && x.advanceMs > 0) d.slide.durationMs = x.advanceMs;
      if (x?.note) {
        addNote(d.notes, x.note);
        this.log.add('info', `${label}: ${x.note}`);
      }
      // The metafiles the slide draws, set aside by the converter (item D): LibreOffice converts them.
      const mf = c?.rescued ? undefined : c?.s.metafiles;
      if (mf?.length && d.cls !== 'picture') {
        if (this.lo) {
          d.metafiles = mf.map((m) => ({ ...m, object: imported(m.object) }));
          addNote(d.notes, `${mf.length} metafile picture(s) wait for LibreOffice`);
        } else {
          d.missing = addMissing(d.missing, 'metafile');
          addNote(d.notes, `not drawn: ${mf.length} vector picture(s) (EMF, WMF)`);
        }
      }
      if (c && !c.rescued && d.cls !== 'picture') {
        if (this.lo) {
          if (d.art) d.artKinds = artKinds(c.s.classification.reasons);
          this.budgetLeft(d, c.s);
        } else this.gaps(d, c.s);
      }
      if (d.cls === 'picture') toPicture(d);
      return d;
    });
    if (notesCut)
      this.warn(
        'notes',
        `the speaker notes of ${notesCut} slide(s) were cut: a presentation keeps at most ${NOTES_TOTAL_BYTES / 1024 ** 2} MB of notes`,
      );
    return drafts;
  }

  /**
   * M9, with LibreOffice: what the slide budgets' guard left out and nothing draws (`EmittedSlide.missing`,
   * which lists nothing else when the converter plans for LibreOffice) is listed as dropped (`provenance`
   * writes it to `Slide.pptx.missing` either way); the slide is then hybrid. Since `lo-forms` the converter
   * gives the guard's left-outs to LibreOffice's art on such a hub (`budget:shapes` / `budget:pictures`, the
   * owner's decision of 2026-11-13), so its scenes list nothing here; one that still lists them (a converter
   * that culled them) has them listed. The hub's job and the client parse both run it, through these drafts.
   */
  budgetLeft(d: Draft, e: EmittedSlide): void {
    for (const m of Array.isArray(e.missing) ? e.missing : [])
      if (typeof m === 'string') d.dropped = addMissing(d.dropped, m);
    if (d.dropped?.length && d.cls === 'native') d.cls = 'hybrid';
  }

  /**
   * M9, without LibreOffice: what LibreOffice would have drawn on this slide is listed (`Draft.missing`). A
   * converter told so lists it itself (`EmittedSlide.missing`, its note already in the slide's notes); one
   * that still planned the art has it dropped here, by the kinds of the art's reasons (`artKinds`). The slide
   * is then hybrid with no art object (design/27 M9 decision 8), its art's text kept for search.
   */
  gaps(d: Draft, e: EmittedSlide): void {
    for (const m of Array.isArray(e.missing) ? e.missing : [])
      if (typeof m === 'string') d.missing = addMissing(d.missing, m);
    if (e.artText && !d.artText) d.artText = e.artText;
    if (d.art) {
      const kinds = artKinds(e.classification.reasons);
      for (const k of kinds) d.missing = addMissing(d.missing, k);
      if (kinds.length) addNote(d.notes, `not drawn: ${kinds.map(missingLabel).join(', ')}`);
      delete d.art;
    }
    if (d.missing?.length && d.cls === 'native') d.cls = 'hybrid';
    // An art that only improved on what version 1 draws (flat 3-D past the object budget): nothing is missing.
    else if (!d.missing?.length && !d.dropped?.length && d.cls === 'hybrid') d.cls = 'native';
  }

  /**
   * Objects of `d` left out for its outline files (M9 `ladder.ts` `withoutFiles`): past the batch's or the
   * import's budget of files, or files the store could not take. What they drew is missing (class hybrid).
   */
  leftOut(
    d: Draft,
    left: { dropped: number; unmasked: number; missing: MissingKind[] },
    why: 'batch' | 'import' | 'store',
  ): void {
    for (const k of left.missing) d.dropped = addMissing(d.dropped, k);
    if (left.dropped && d.cls === 'native') d.cls = 'hybrid';
    const parts = [
      ...(left.dropped ? [`${left.dropped} shape(s) left out`] : []),
      ...(left.unmasked ? [`${left.unmasked} picture(s) drawn without their outline`] : []),
    ].join(', ');
    const n = d.ref.index + 1;
    if (why === 'store') {
      addNote(d.notes, `its shape outlines could not be stored: ${parts}`);
      return;
    }
    addNote(d.notes, `over the import budget of shape outlines: ${parts}`);
    this.warn(
      'budget',
      why === 'batch'
        ? `slide ${n}'s shape outlines pass what one conversion batch may return: ${parts}`
        : `slide ${n}'s shape outlines pass the import's ${formatBytes(this.geomFileBytes)} of outline files: ${parts}`,
    );
  }

  /**
   * With LibreOffice: the size of LibreOffice's page form of a slide the ladder stores as `r` (picture class,
   * its text kept for search, the follow-up draws the page), when the slide keeps that form instead, as every
   * slide over 64 KB did before M9; else undefined. Only for a slide over 64 KB that the ladder fitted by
   * leaving something out ('plain': its formatting; 'minimal': its decorations), only when the page form
   * (`compactSlideBytes`, with version 2's page record) is within 64 KB, and only while it grows the
   * presentation by no more than `room`, so the presentation's plan still holds. The presentation's tail
   * stays minimal on every hub (its slides are whole text slides past 3 MiB: editable, and no page to wait
   * for), so a hub with LibreOffice shows it as one without does. The 2026-11-13 review measured 22 worship slides of E that
   * a hub with LibreOffice showed far worse stored plain or minimal (0.13-0.94) than as LibreOffice's page
   * (0.90-0.999): the exit gate of M9 decision 2 for such hubs.
   */
  pageForBudget(d: Draft, r: LadderSlide, room: number): number | undefined {
    if (!this.lo || d.cls === 'picture' || r.tail) return undefined;
    if ((r.level !== 'plain' && r.level !== 'minimal') || (!r.dropped && !r.plain)) return undefined;
    const bytes = compactSlideBytes(record(d, DIGEST_STANDIN, true), d.artText);
    if (bytes > SIZE_BUDGETS.slideMax || bytes - r.bytes > Math.max(0, room)) return undefined;
    return bytes;
  }

  /**
   * Step 3: the §3.4 budgets, M9's budget ladder (`ladder.ts`): outline files within the import's budget,
   * each slide within 64 KB (`fitSlideBudget`), the presentation within 4 MiB (its tail stored minimal).
   * Without LibreOffice no slide becomes a picture; with it, a slide over 64 KB that would be stored plain or
   * minimal keeps LibreOffice's page (`pageForBudget`). Returns how many slides it simplified (formatting or decorations left
   * out).
   */
  budget(drafts: Draft[]): number {
    // Outline files, admitted one by one in slide order while the import's budget holds; what names one past
    // it (or one dropped as its batch arrived) is left out.
    const admitted = new Set<string>();
    let fileBytes = 0;
    for (const d of drafts) {
      if (d.cls === 'picture') continue;
      const refs = drawnGeomRefs(d.slide);
      if (!refs.length) continue;
      const keep = new Set<string>();
      for (const name of refs) {
        if (admitted.has(name)) {
          keep.add(name);
          continue;
        }
        if (this.geomDropped.has(name)) continue;
        const f = this.geomFiles.get(name);
        // Not this import's file (the store's already, `storeGeomFiles`): it costs nothing here.
        if (!f) {
          keep.add(name);
          continue;
        }
        if (fileBytes + f.bytes.length > this.geomFileBytes) continue;
        admitted.add(name);
        keep.add(name);
        fileBytes += f.bytes.length;
      }
      if (keep.size === refs.length) continue;
      const left = withoutFiles(d.slide, (ref) => keep.has(ref));
      d.slide = left.slide;
      this.leftOut(d, left, 'import');
    }
    // Each slide fitted, then the presentation's tail (a re-import's kept slides take their part, `reserve`).
    const max = SIZE_BUDGETS.slideMax;
    const { slides, plan } = planLadder(
      drafts.map((d) => ({ slide: record(d, DIGEST_STANDIN, this.lo), fixed: d.cls === 'picture' })),
      IMPORT_RESERVE_BYTES + this.reserve,
    );
    let simplified = 0;
    let pages = 0;
    // What the presentation may still grow by within its budget (LibreOffice's page forms, `pageForBudget`).
    let room = SIZE_BUDGETS.presentationMax - (IMPORT_RESERVE_BYTES + this.reserve) - plan.total;
    drafts.forEach((d, i) => {
      const r = slides[i]!;
      if (d.cls === 'picture' || r.level === 'full') return;
      const n = d.ref.index + 1;
      const page = this.pageForBudget(d, r, room);
      if (page !== undefined) {
        // The slide as converted (not the ladder's form): its whole text is kept for search.
        toPicture(d);
        room -= page - r.bytes;
        pages++;
        addNote(d.notes, `over ${max / 1024} KB: LibreOffice draws its page`);
        this.log.add(
          'info',
          `slide ${n} is over ${max / 1024} KB: LibreOffice draws its page (fitted, it would leave out ${r.level === 'plain' ? 'its formatting' : 'its decorations'})`,
        );
        return;
      }
      const { pptx: _, ...slide } = r.slide;
      d.slide = slide;
      if (r.level === 'grid')
        this.log.add(
          'info',
          `slide ${n}: its outlines were redrawn on a 1/16 px grid to fit the slide budget`,
        );
      // Re-gridded, or over the budget with nothing it may leave out (its text alone): kept whole.
      if (r.level === 'grid' || (!r.tail && !r.dropped && !r.plain)) {
        if (r.bytes > max)
          this.warn(
            'budget',
            `slide ${n} is over ${max / 1024} KB with only its text and pictures (${formatBytes(r.bytes)}): it keeps them all`,
          );
        return;
      }
      d.simplified = true;
      simplified++;
      for (const k of r.missing) d.dropped = addMissing(d.dropped, k);
      if (r.missing.length && d.cls === 'native') d.cls = 'hybrid';
      if (r.tail) {
        addNote(d.notes, 'the presentation reached its size budget: only its text and pictures are kept');
        return;
      }
      const what = [
        ...(r.plain ? [`the formatting of ${r.plain} text box(es)`] : []),
        ...(r.dropped ? [`${r.dropped} decoration shape(s)`] : []),
      ].join(' and ');
      addNote(d.notes, `simplified to fit the slide budget: ${what} left out`);
      this.warn(
        'budget',
        r.bytes > max
          ? `slide ${n} is over ${max / 1024} KB: ${what} left out, and it is still ${formatBytes(r.bytes)} with only its text and pictures`
          : `slide ${n} is over ${max / 1024} KB: ${what} left out to fit`,
      );
    });
    if (pages)
      this.warn('budget', `${pages} slide(s) over their size budget show LibreOffice's page, as before M9`);
    if (plan.tailFrom >= 0)
      this.warn(
        'budget',
        `the presentation reached its size budget (${SIZE_BUDGETS.presentationMax / 1024 ** 2} MiB): slide ${plan.tailFrom + 1} and later keep only their text and pictures`,
      );
    if (!plan.fits) {
      // Even minimal the slides are over the budget (their text alone): the tail's text, and what picture
      // slides keep for search, is cut.
      let cut = 0;
      for (const [i, d] of drafts.entries()) {
        if (d.cls === 'picture') {
          if (!d.artText || d.artText.length <= COMPACT_TEXT_CHARS) continue;
          d.artText = cutText(d.artText, COMPACT_TEXT_CHARS);
          cut++;
          continue;
        }
        if (!slides[i]!.tail) continue;
        let changed = false;
        d.slide = {
          ...d.slide,
          objects: d.slide.objects.map((o) => {
            if (o.type !== 'text' || o.text.length <= COMPACT_TEXT_CHARS) return o;
            changed = true;
            return { ...o, text: cutText(o.text, COMPACT_TEXT_CHARS) } satisfies TextObject;
          }),
        };
        if (changed) {
          cut++;
          addNote(
            d.notes,
            `its text was cut to ${COMPACT_TEXT_CHARS} characters a box: the deck is too large`,
          );
        }
      }
      this.warn(
        'budget',
        `the deck is over ${SIZE_BUDGETS.presentationMax / 1024 ** 2} MiB even with every slide minimal: the text of ${cut} slide(s) was cut to ${COMPACT_TEXT_CHARS} characters a box`,
      );
    }
    return simplified;
  }

  /** Step 5: remap, assemble, sanitize, digest; the follow-up's plan. */
  assemble(drafts: Draft[], stored: ReadonlyMap<string, string>, a: AssembleInput): Assembled {
    const { hash, slideRect, scan } = a;
    // Remap each slide with its own batch's placeholders.
    for (const d of drafts) {
      const map = new Map<string, string>();
      for (const [ph, part] of d.media) {
        const id = stored.get(part);
        if (id) map.set(ph, id);
      }
      const before = d.slide.objects.length;
      d.slide = remapMediaIds(d.slide, map);
      if (d.slide.objects.length < before)
        addNote(d.notes, `${before - d.slide.objects.length} picture(s) could not be imported`);
      if (d.slide.lyricObjectId && !d.slide.objects.some((o) => o.id === d.slide.lyricObjectId))
        delete d.slide.lyricObjectId;
      const bg = d.slide.backgroundMediaId;
      if (bg && a.hasAlpha(bg)) {
        // A picture with alpha is drawn on white, as PowerPoint lays every background (design/27 §4).
        delete d.slide.backgroundMediaId;
        if (d.cls !== 'picture') d.slide.objects.unshift(...backgroundOnWhite(bg, slideRect));
        addNote(d.notes, 'a background picture with transparency is drawn on white');
      }
    }
    const kind = isLoop(drafts, scan.loop) ? 'loop' : 'slides';
    const p: Presentation = {
      id: a.id,
      rev: 1,
      title: a.title,
      kind,
      meta: { tags: [] },
      sections: [],
      arrangements: [],
      source: { kind: 'pptx', fileId: hash },
      archived: false,
    };
    if (kind === 'loop') {
      p.loop = {
        defaultSlideMs: mostCommon(drafts.map((d) => d.slide.durationMs ?? 0).filter((v) => v > 0)),
      };
      this.log.add('info', LOOP_IMPORT_NOTE);
    }
    // One background on every slide becomes the presentation's, so the pickers swap it (the pro7 pattern). A
    // motion background stays the slides': goLive does not wait for a slide's clip (design/27 §8).
    const bgs = new Set(drafts.map((d) => d.slide.backgroundMediaId));
    const [onlyBg] = bgs;
    if (bgs.size === 1 && onlyBg && !a.clipIds.has(onlyBg)) {
      p.backgroundMediaId = onlyBg;
      for (const d of drafts) delete d.slide.backgroundMediaId;
    }
    // Provenance (the digest is set once the objects are final).
    for (const d of drafts) d.slide.pptx = provenance(d, hash, this.lo);
    p.sections = sectionsOf(drafts, a.sections);
    p.arrangements = [{ id: newId(), name: 'Default', sectionIds: p.sections.map((s) => s.id) }];
    sanitizePresentation(p);
    // A slide the schema refuses is stored minimal (its text, pictures and background), else as its text
    // alone, rather than failing the deck (M9: never a picture).
    const byId = new Map(drafts.map((d) => [d.slide.id, d]));
    for (const sec of p.sections)
      sec.slides = sec.slides.map((sl) => {
        const ok = Slide.safeParse(sl);
        if (ok.success) return ok.data;
        const d = byId.get(sl.id);
        this.warn(
          'slide',
          `slide ${(sl.pptx?.index ?? 0) + 1} could not be stored as converted: only its text and pictures are kept`,
        );
        if (!d) return Slide.parse({ id: sl.id, objects: [] });
        const kept = d.slide.objects.length;
        d.slide = minimalSlide(d.slide);
        if (d.slide.objects.length < kept) d.dropped = addMissing(d.dropped, 'decoration');
        if (d.cls === 'native') d.cls = 'hybrid';
        addNote(d.notes, 'not storable as converted: only its text and pictures are kept');
        d.slide.pptx = provenance(d, hash, this.lo);
        const again = Slide.safeParse(d.slide);
        if (again.success) return again.data;
        // The text rescue: each text object rebuilt from its text and box alone.
        d.slide = { ...d.slide, objects: rescuedTexts(d.slide.objects) };
        delete d.slide.lyricObjectId;
        d.dropped = addMissing(d.dropped, 'slide');
        d.slide.pptx = provenance(d, hash, this.lo);
        const text = Slide.safeParse(d.slide);
        return text.success ? text.data : Slide.parse({ id: sl.id, objects: [], pptx: d.slide.pptx });
      });
    const parsed = Presentation.parse(p);
    // The digest of the import's objects (every object here has an origin, `imported`): the "unedited" test
    // of the follow-up and re-import (`digest.ts`).
    const slides = parsed.sections.flatMap((s) => s.slides);
    for (const sl of slides) if (sl.pptx) sl.pptx.digest = importDigest(sl.objects);
    const classes = slides.map((sl) => sl.pptx?.class ?? 'native');
    const counts = {
      native: classes.filter((c) => c === 'native').length,
      hybrid: classes.filter((c) => c === 'hybrid').length,
      picture: classes.filter((c) => c === 'picture').length,
    };
    parsed.source = {
      kind: 'pptx',
      fileId: hash,
      native: { version: CONVERTER_VERSION, slides: slides.length, ...counts, slideRect },
    };
    this.log.add(
      'info',
      `${slides.length} slide(s): ${counts.native} native, ${counts.hybrid} hybrid, ${counts.picture} picture`,
    );
    const lo = loSlides(drafts, slides);
    if (lo.length) this.log.add('info', `${lo.length} slide(s) wait for LibreOffice`);
    const gaps = slides.filter((sl) => sl.pptx?.missing?.length).length;
    if (gaps)
      this.log.add('info', `${gaps} slide(s) have something ordo cannot draw (no LibreOffice on this hub)`);
    const fonts = missingFonts(fontFamilies(slides), a.libraryFamilies);
    for (const f of fonts) this.log.add('info', `font not available: ${f}`);
    parsed.source.log = this.log.toString();
    return { p: parsed, lo, missingFonts: fonts };
  }
}

/** Slides of a presentation with something nothing draws (`Slide.pptx.missing`). */
export function missingSlides(p: Presentation): number {
  let n = 0;
  for (const sec of p.sections) for (const sl of sec.slides) if (sl.pptx?.missing?.length) n++;
  return n;
}

/** The text of a slide's text objects, for search and labels (`pptx.artText`). */
function textOfObjects(objects: readonly SlideObject[]): string {
  const out: string[] = [];
  let n = 0;
  for (const o of objects) {
    if (o.type !== 'text' || !o.text.trim()) continue;
    out.push(o.text);
    n += o.text.length + 1;
    if (n > ART_TEXT_CHARS) break;
  }
  return out.join('\n').slice(0, ART_TEXT_CHARS);
}

/** The text of an emitted slide's text bodies: its text objects, then the text baked into its art. */
export function bodyTexts(s: Pick<EmittedSlide, 'slide' | 'art'>): string[] {
  const out: string[] = [];
  for (const o of s.slide.objects) if (o.type === 'text' && o.text.trim()) out.push(o.text);
  if (s.art?.text?.trim()) out.push(s.art.text);
  return out;
}

/** `bodyTexts` with where each body is (the art's text at the art's box). */
export function bodyBoxes(s: Pick<EmittedSlide, 'slide' | 'art'>): { text: string; box: Box }[] {
  const out: { text: string; box: Box }[] = [];
  for (const o of s.slide.objects)
    if (o.type === 'text' && o.text.trim()) out.push({ text: o.text, box: o.box });
  if (s.art?.text?.trim()) out.push({ text: s.art.text, box: { ...s.art.box, rotation: 0 } });
  return out;
}

/** `s` cut to at most `n` UTF-16 units, never inside a surrogate pair. */
export function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/**
 * The text objects of a slide the schema refused even minimal, each rebuilt from its text and box alone in a
 * plain style (the last of M9's rescues: the words stay, editable).
 */
function rescuedTexts(objects: readonly SlideObject[]): TextObject[] {
  const out: TextObject[] = [];
  for (const o of objects) {
    if (o?.type !== 'text' || typeof o.text !== 'string' || !o.text.trim()) continue;
    const size = o.style?.fontSizePx;
    out.push({
      id: newId(),
      type: 'text',
      box: clampBox(o.box),
      text: cutText(o.text, ART_TEXT_CHARS),
      style: {
        fontFamily: 'Calibri',
        fontWeight: 400,
        fontStyle: 'normal',
        fontSizePx: typeof size === 'number' && size >= 4 && size <= 1000 ? size : 40,
        color: { r: 0, g: 0, b: 0, a: 1 },
        align: 'left',
        valign: 'top',
        lineHeight: 1.2,
        letterSpacing: 0,
        padding: 0,
        transform: 'none',
      },
      opacity: 1,
      origin: { src: 'pptx', role: 'text' },
    });
    if (out.length >= 1_000) break;
  }
  return out;
}

/** Make a draft picture class: no objects, its text kept for search (version 2 adds the page picture). */
export function toPicture(d: Draft): void {
  const text = textOfObjects(d.slide.objects);
  d.cls = 'picture';
  d.slide.objects = [];
  delete d.slide.lyricObjectId;
  delete d.art;
  delete d.metafiles;
  // The whole slide is what is missing now (`provenance`), and what LibreOffice draws is its page.
  delete d.missing;
  delete d.artKinds;
  // A hybrid slide's art text is part of the page too.
  const all = [text, d.artText].filter(Boolean).join('\n').slice(0, ART_TEXT_CHARS);
  if (all) d.artText = all;
  else delete d.artText;
}

/** A stand-in for `Slide.pptx.digest` in size estimates: as long as `digestOf`'s. */
export const DIGEST_STANDIN = 'x'.repeat(16);

/** The slide as it will be stored, with a stand-in digest (for its size). */
export function record(d: Draft, digest: string, lo: boolean): Slide {
  return { ...d.slide, pptx: { ...provenance(d, 'x'.repeat(64), lo), digest } };
}

/**
 * `Slide.pptx` of a draft (without its digest). With LibreOffice (`lo`), a hybrid or picture slide and one
 * with metafile pictures waits for it (`pending`); without it nothing waits, and what nothing draws is listed
 * (`missing`: the draft's, or 'slide' for a picture-class slide, design/27 M9).
 */
export function provenance(d: Draft, hash: string, lo: boolean): SlidePptx {
  // A hybrid slide waits for its art; one that is hybrid only for what the budgets left out does not.
  const pending = lo && (d.cls === 'picture' || !!d.art || !!d.metafiles?.length);
  let missing = lo ? undefined : d.cls === 'picture' ? [missingEntry('slide')] : d.missing;
  if (d.cls !== 'picture')
    for (const e of d.dropped ?? []) missing = addMissing(missing ? [...missing] : [], e);
  const artText = d.artText;
  return {
    fileId: hash,
    index: d.ref.index,
    ...(d.ref.shown !== undefined ? { shown: d.ref.shown } : {}),
    class: d.cls,
    version: CONVERTER_VERSION,
    ...(pending ? { pending: true } : {}),
    ...(missing?.length ? { missing: missing.slice(0, MISSING_LIMITS.entries) } : {}),
    ...(d.notes.length ? { notes: d.notes.slice(0, SLIDE_NOTES).map((n) => logSafe(n)) } : {}),
    ...(artText ? { artText } : {}),
  };
}

/** The placeholder ids a batch's slides use. */
export function usedPlaceholders(slides: readonly Slide[]): Set<string> {
  const used = new Set<string>();
  for (const s of slides) {
    if (s.backgroundMediaId?.startsWith(MEDIA_PREFIX)) used.add(s.backgroundMediaId);
    for (const o of s.objects)
      if (o.type === 'image' && o.mediaId.startsWith(MEDIA_PREFIX)) used.add(o.mediaId);
  }
  return used;
}

/**
 * `o` marked as a PowerPoint import's (`origin`, design/27 §3.1), unless the converter marked it already. A
 * slide set to show its PowerPoint picture draws that picture and only the objects without an origin, the
 * ones the operator added in ordo (`slideContent`, design/27 §5).
 */
export function imported<T extends SlideObject>(o: T): T {
  return o.origin ? o : { ...o, origin: { src: 'pptx' } };
}

/** A background picture with alpha as PowerPoint draws it: on a white rect over the slide area. */
export function backgroundOnWhite(
  mediaId: string,
  rect: { x: number; y: number; w: number; h: number },
): [ShapeObject, ImageObject] {
  const box = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, rotation: 0 };
  const origin = { src: 'pptx', role: 'bg' };
  return [
    { id: newId(), type: 'shape', box, shape: 'rect', fill: WHITE, opacity: 1, radius: 0, origin },
    {
      id: newId(),
      type: 'image',
      box: { ...box },
      mediaId,
      fit: 'stretch',
      opacity: 1,
      radius: 0,
      origin: { ...origin },
    },
  ];
}

/**
 * Sections in slide order: each run of consecutive slides of one `p14:section` is an ordo section under its
 * name; slides in none are 'Slides'. Without sections, one 'Slides' section. Empty sections are left out.
 */
export function sectionsOf(drafts: readonly Draft[], info: readonly SectionInfo[]): Section[] {
  const of = new Map<number, number>();
  info.forEach((s, i) => {
    for (const idx of s.slides) if (!of.has(idx)) of.set(idx, i);
  });
  const out: Section[] = [];
  let cur: number | undefined | null = null;
  for (const d of drafts) {
    const s = of.get(d.ref.index);
    if (s !== cur || !out.length) {
      const label = s === undefined ? 'Slides' : logSafe(info[s]!.name, 60) || 'Slides';
      out.push({ id: newId(), label, short: '', slides: [] });
      cur = s;
    }
    out[out.length - 1]!.slides.push(d.slide);
  }
  return out;
}

/** Whether a looping show has every shown slide timed: the presentation becomes a loop. */
export function isLoop(drafts: readonly Draft[], loops: boolean): boolean {
  if (!loops) return false;
  const shown = drafts.filter((d) => !d.ref.hidden);
  return shown.length > 0 && shown.every((d) => (d.slide.durationMs ?? 0) > 0);
}

export function mostCommon(values: readonly number[]): number {
  const n = new Map<number, number>();
  let best = values[0] ?? 5_000;
  for (const v of values) {
    n.set(v, (n.get(v) ?? 0) + 1);
    if (n.get(v)! > (n.get(best) ?? 0)) best = v;
  }
  return Math.max(500, best);
}

/** The slides the LibreOffice follow-up works on, from version 1 as stored. */
export function loSlides(drafts: readonly Draft[], slides: readonly Slide[]): PptxLoSlide[] {
  const byId = new Map(drafts.map((d) => [d.slide.id, d]));
  const out: PptxLoSlide[] = [];
  for (const sl of slides) {
    if (!sl.pptx?.pending) continue;
    const d = byId.get(sl.id);
    out.push({
      slideId: sl.id,
      index: sl.pptx.index,
      ...(sl.pptx.shown !== undefined ? { shown: sl.pptx.shown } : {}),
      class: sl.pptx.class,
      ...(d?.art && sl.pptx.class === 'hybrid' ? { art: d.art } : {}),
      ...(d?.metafiles?.length && sl.pptx.class !== 'picture' ? { metafileObjects: d.metafiles } : {}),
      digest: sl.pptx.digest ?? '',
      ...(d?.art && sl.pptx.class === 'hybrid' ? { replaced: replacedOf(sl, d.art) } : {}),
      kinds: loKinds(sl.pptx.class, d),
    });
  }
  return out;
}

/**
 * What a waiting slide lacks if LibreOffice never draws it (`PptxLoSlide.kinds`, `withoutLibreOffice`): none
 * for an art that only improves on what version 1 draws (`artKinds` empty: flat 3-D past the object budget).
 */
function loKinds(cls: SlideClass, d: Draft | undefined): string[] {
  if (cls === 'picture' || !d) return [missingEntry('slide')];
  let out: string[] = [];
  if (d.art) for (const k of d.artKinds ?? (['element'] as const)) out = addMissing(out, k);
  if (d.metafiles?.length) out = addMissing(out, 'metafile');
  return d.art || d.metafiles?.length ? out : [missingEntry('element')];
}

/** `list` with `entry` added once (a stored `Slide.pptx.missing` entry, within its bounds). */
export function addMissing(list: string[] | undefined, entry: string): string[] {
  const colon = entry.indexOf(':');
  const e = missingEntry(missingKind(entry), colon > 0 ? entry.slice(colon + 1) : undefined);
  const out = list ?? [];
  if (!out.includes(e) && out.length < MISSING_LIMITS.entries) out.push(e);
  return out;
}

/** Reasons of a hybrid slide's art whose element ordo draws as a shape (what a decoration loses). */
const SHAPE_REASONS: ReadonlySet<string> = new Set(['shapes', 'custGeom', 'geom', 'preset', 'path']);

/**
 * The kinds of what a hybrid slide's art holds, read from the converter's `art:<reason>` reasons (design/27
 * M9: what a hub without LibreOffice lists in `Slide.pptx.missing` when the converter does not list it
 * itself, and `PptxLoSlide.kinds` with LibreOffice). A reason the converter's decision table names
 * (`residual.ts` `rowOf`) has the kind the converter records for it without LibreOffice (`missingKindOf`),
 * so both lists agree; for any other reason: a metafile picture (EMF, WMF), decoration shapes for geometry,
 * the reason's own kind when it is one (chart, SmartArt, OLE, an equation, ink), 'element' for the rest. A
 * reason whose element version 1 draws as ordo draws it within the budgets (`ResidualRow.drawn`: flat 3-D
 * past the object budget) has none: an art of only those lacks nothing ([]). Deck strings are only compared.
 */
export function artKinds(reasons: readonly string[]): MissingKind[] {
  const out: MissingKind[] = [];
  let drawn = false;
  for (const r of reasons) {
    if (typeof r !== 'string' || !r.startsWith('art:')) continue;
    const reason = r.slice(4);
    if (rowOf(reason)?.drawn) {
      drawn = true;
      continue;
    }
    let k = reason;
    if (k.startsWith('budget:')) k = k.slice(7);
    const head = k.split(':')[0] ?? '';
    const kind: MissingKind =
      rowOf(reason)?.missing ??
      (k === 'pic:emf' || k === 'pic:wmf'
        ? 'metafile'
        : SHAPE_REASONS.has(head)
          ? 'decoration'
          : missingKind(head));
    if (!out.includes(kind)) out.push(kind);
  }
  return out.length || drawn ? out : ['element'];
}

/** Version 1's objects the art replaces, each with its own digest (`PptxLoSlide.replaced`). */
function replacedOf(slide: Slide, art: ArtInfo): [string, string][] {
  const want = new Set(art.replaces);
  return slide.objects.filter((o) => want.has(o.id)).map((o) => [o.id, digestOf([o])]);
}

/** The families the slides' text asks for, in first-use order. */
export function fontFamilies(slides: readonly Slide[]): string[] {
  const out = new Set<string>();
  for (const s of slides) for (const o of s.objects) if (o.type === 'text') out.add(o.style.fontFamily);
  return [...out];
}

/** The digest of the import's objects of a slide: those with an `origin`, in their order (`digest.ts`). */
export function importDigest(objects: readonly SlideObject[]): string {
  return digestOf(objects.filter((o) => o.origin));
}

/** Whether `digest` (a stored `Slide.pptx.digest` or a follow-up's) still matches the slide's objects. */
export function digestMatches(objects: readonly SlideObject[], digest: string | undefined): boolean {
  if (!digest) return false;
  return importDigest(objects) === digest || digestOf(objects) === digest;
}

// ── Clips (the hub's `clips.ts` ingests them; a client assembly without a store leaves them out) ────────────

/** One slide's use of its clips, as `place`/`unplace` see it. */
export type ClipUse = { slide: Slide; picture: boolean };

/** Whether the slide keeps a use for the clip: a picture-class slide keeps only its sound. */
export function wanted(c: EmittedClip, picture: boolean): boolean {
  return !picture || c.role === 'sound';
}

/** The clip's placeholder replaced by its media id. */
export function place(s: ClipUse, c: EmittedClip, id: string): void {
  const sl = s.slide;
  if (c.role === 'play') {
    const play = sl.objects.find((x): x is ImageObject => x.id === c.objectId && x.type === 'image')?.play;
    if (play && play.mediaId === c.id) play.mediaId = id;
  } else if (c.role === 'sound') {
    if (sl.audio && sl.audio.mediaId === c.id) sl.audio.mediaId = id;
  } else if (c.role === 'background') {
    if (sl.backgroundMediaId === c.id) sl.backgroundMediaId = id;
  }
}

/** The clip's use left out: its object stays a poster; a motion background's poster goes back at the bottom. */
export function unplace(s: ClipUse, c: EmittedClip): void {
  const sl = s.slide;
  if (c.role === 'play') {
    const o = sl.objects.find((x): x is ImageObject => x.id === c.objectId && x.type === 'image');
    if (o && o.play?.mediaId === c.id) delete o.play;
  } else if (c.role === 'sound') {
    if (sl.audio?.mediaId === c.id) delete sl.audio;
  } else if (c.role === 'background' && sl.backgroundMediaId === c.id) {
    delete sl.backgroundMediaId;
    // Marked as the import's background (`origin`, design/27 §3.1), as every object the job writes is: a
    // slide set to show its PowerPoint picture leaves it out (`slideContent`), and the background pickers
    // find it.
    if (!s.picture && c.poster)
      sl.objects.unshift({ ...c.poster, origin: { ...(c.poster.origin ?? { src: 'pptx' }), role: 'bg' } });
  }
}

/** Any clip placeholder left (a slide edited by the job meanwhile, a role this wave does not know): removed. */
export function sweep(sl: Slide): void {
  const isClip = (v: string | undefined) => v?.startsWith(CLIP_PREFIX) === true;
  for (const o of sl.objects) if (o.type === 'image' && isClip(o.play?.mediaId)) delete o.play;
  if (isClip(sl.audio?.mediaId)) delete sl.audio;
  if (isClip(sl.backgroundMediaId)) delete sl.backgroundMediaId;
}
