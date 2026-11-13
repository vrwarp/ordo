/**
 * @ordo/pptx-scene: PowerPoint decks as ordinary ordo slides (design/27).
 *
 *   const scene = parseDeck(parts);          // untrusted deck → hub-internal scene IR
 *   const out = emitSlides(scene, { ... });  // IR → ordo Slides with `pptxmedia:<n>` picture ids
 *
 * Pure TypeScript: no DOM, no zip, no fs, no runtime dependency. The input is the deck's parts by name
 * (`extractZip`'s `files`); media parts may be empty (spilled to disk), only their names are used.
 */
import { classifySlide } from './classify.ts';
import { slideContext } from './context.ts';
import { type DeckInfo, readDeck, type SlideRef } from './deck.ts';
import { readBackground } from './background.ts';
import { bakeKey, type PictureBake, type SheetBake, sheetKey } from './bake.ts';
import { DECOR_PREFIX } from './decor.ts';
import { SHEET_PREFIX } from './sheet.ts';
import {
  ALL_M9_FIELDS,
  BAKE_PREFIX,
  CLIP_PREFIX,
  type EmitOptions,
  type EmitResult,
  type EmittedSlide,
  emitDeck,
  GEOM_PREFIX,
  type M9Field,
  MEDIA_PREFIX,
} from './emit.ts';
import { frameOf, slideRect } from './frame.ts';
import type { DeckScene, Frame, SectionInfo, SlideScene } from './ir.ts';
import { clean, type Log, noteList } from './log.ts';
import { openPackage, type PartSource } from './opc.ts';
import { readSlideSounds } from './media.ts';
import type { FaceMetrics, FaceSource } from './metrics.ts';
import { MAX_DPI, MIN_DPI, type PictureHeader } from './picture.ts';
import { readSlideTiming } from './timing.ts';
import { walkSlide } from './walk.ts';

export type { BlipReader, ColorCtx } from './color.ts';
export type { SlideCtx, Source } from './context.ts';
export type { DeckInfo, SlideRef } from './deck.ts';
export type { EmitOptions, EmitResult, EmittedSlide, M9Field } from './emit.ts';
export {
  ALL_M9_FIELDS,
  BAKE_PREFIX,
  CLIP_PREFIX,
  GEOM_FILE_CHARS,
  GEOM_PREFIX,
  M9_FIELDS,
  MEDIA_PREFIX,
  SLIDE_BYTES_NOTE,
  storedSlideBytes,
  TEXT_BUDGET_BYTES,
} from './emit.ts';
export type { BakeRaster, PictureBake, SheetBake, SheetCell, TileBake } from './bake.ts';
export { applySheet, cellSourceSize, checkSheet, SHEET_LIMITS } from './bake.ts';
export {
  type BudgetOptions,
  type BudgetPlan,
  MAX_DRAWN_OBJECTS,
  MAX_DRAWN_PICTURES,
  MAX_SLIDE_OBJECTS_TEXT,
} from './budget.ts';
export { DECOR_PREFIX, type PlatePlan, platePlan } from './decor.ts';
export { type EmittedSheet, SHEET_DENSITY, SHEET_PREFIX } from './sheet.ts';
export type { EmittedClip } from './media.ts';
export { type PictureHeader, pictureSize } from './picture.ts';
export { CONVERTER_VERSION, M9_HELD_BACK, M9_WRITES, PPTX_SHEETS } from './version.ts';
export * from './ir.ts';
export { addNote, type Log, SLIDE_NOTES } from './log.ts';
export {
  advanceOf,
  type BodyMeasure,
  ESTIMATED_ADVANCE,
  type FaceMetrics,
  type FaceSource,
  type FaceStyle,
  heightOf,
  metricsOfTables,
  type SfntTables,
  sfntMetrics,
} from './metrics.ts';
export {
  type Decision,
  decisionOf,
  drawnWithoutArt,
  missingKindOf,
  RESIDUAL_ROWS,
  type ResidualRow,
  rowOf,
} from './residual.ts';
export type { Package, PartSource, Rel } from './opc.ts';
export { RESCUE_DEPTH, RESCUE_NOTE, rescueDeck } from './rescue.ts';
export type { Theme } from './theme.ts';

export interface ParseOptions {
  /** Receives deck-level notes as they happen (they are also in `DeckScene.notes`). */
  log?: Log;
  /**
   * The pixel size of a picture part whose bytes are not in `src` (spilled to disk), e.g. from its first
   * bytes on disk. Asked at most once per part; sides outside 1..1,000,000 count as unknown. Without it a
   * spilled picture's size is unknown, and a background picture of unknown size is drawn as a stretched
   * image over the slide rather than as the slide background (design/27 §4 "Backgrounds"). `pictureSize`
   * (exported) reads both from a header, `alpha` included: only a background known to be opaque becomes
   * the slide background.
   */
  pictureSize?: (part: string) => PictureHeader | undefined;
  /**
   * Read only the slides whose place in the deck's order (`SlideRef.index`) is in [from, to): one batch of
   * the hub's pool task (design/27 §2). Deck facts (frame, sections, notes) are read whole either way.
   */
  range?: { from: number; to: number };
  /**
   * Whether a clip part (video, sound) is a video or a sound, from its bytes, when the caller can tell: the
   * hub sniffs each spilled clip (design/27 §4 "Media": pptxgenjs writes sounds under `a:videoFile`). Asked
   * at most once per part. Only 'audio' overrides the element (a sniff may call a sound it cannot tell a
   * video); 'video' decides only a clip whose element and timing do not. Undefined, or without it: the
   * element and the slide's timing decide.
   */
  mediaKind?: (part: string) => 'video' | 'audio' | undefined;
  /**
   * The font face of a family in a weight and slant, as the caller's fonts would draw it (M6 tables: a row is
   * as tall as its text, measured with the faces' advances; `metrics.ts` `sfntMetrics` reads a font file).
   * Asked at most once per family, weight and slant, and for at most `MAX_FACE_LOOKUPS` of them per call; a
   * family it has no face for is undefined, and its text is measured with estimated widths (noted).
   */
  fontFace?: FaceSource;
  /**
   * The fidelity harness's A/B only (`--budget-art`; never the hub): the slide budgets of M6 and M9 wave 1,
   * which send tables, SmartArt drawings, real 3-D and shapes without text past the object budget to
   * LibreOffice's art, instead of M9's native decorations, composites and atlases (`classify.ts`
   * `ClassifyOptions.budgetArt`). Plan §4 names it an emit option; it is read here because a slide is
   * classified as it is parsed.
   */
  budgetArt?: boolean;
  /**
   * M9: the stored fields the converter may write (`EmitOptions.m9Writes`, the same set). Read here too
   * because a slide's budgets are planned as it is parsed: without 'decor' no decoration is planned
   * (`budget.ts` `BudgetOptions.decorations`).
   */
  m9Writes?: ReadonlySet<M9Field>;
  /**
   * M9: whether pictures are drawn from sheets (`EmitOptions.sheets`, the same flag). Read here too: without
   * sheets no composite or atlas is planned (`BudgetOptions.sheets`).
   */
  sheets?: boolean;
}

/** Families, weights and slants `ParseOptions.fontFace` is asked for per call (a deck can name thousands). */
export const MAX_FACE_LOOKUPS = 256;
/** Scripts `FaceSource.script` is asked for per call (M9; ISO 15924 codes, at most a few dozen exist in decks). */
export const MAX_SCRIPT_LOOKUPS = 64;

/**
 * `ParseOptions.fontFace` asked once per family, weight and slant (case-insensitive), and once per script
 * when it answers `script` (M9), each answer checked. Exported for its tests.
 */
export function faceSources(get: FaceSource | undefined): FaceSource | undefined {
  if (!get) return undefined;
  const checked = (ask: () => FaceMetrics | undefined): FaceMetrics | undefined => {
    try {
      const got = ask();
      return got && typeof got.advance === 'function' ? got : undefined;
    } catch {
      return undefined; // a face the caller cannot read is missing
    }
  };
  const known = new Map<string, FaceMetrics | undefined>();
  const out: FaceSource = (family, bold, italic) => {
    const key = `${family.trim().toLowerCase()}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
    if (known.has(key)) return known.get(key);
    if (known.size >= MAX_FACE_LOOKUPS) return undefined;
    const v = checked(() => get(family, bold, italic));
    known.set(key, v);
    return v;
  };
  const script = get.script;
  if (typeof script === 'function') {
    const scripts = new Map<string, FaceMetrics | undefined>();
    out.script = (code) => {
      if (scripts.has(code)) return scripts.get(code);
      if (scripts.size >= MAX_SCRIPT_LOOKUPS) return undefined;
      const v = checked(() => script.call(get, code));
      scripts.set(code, v);
      return v;
    };
  }
  return out;
}

/** `ParseOptions.mediaKind` asked once per part, its answer checked. */
function mediaKinds(get: ParseOptions['mediaKind']): ParseOptions['mediaKind'] {
  if (!get) return undefined;
  const known = new Map<string, 'video' | 'audio' | undefined>();
  return (part) => {
    if (known.has(part)) return known.get(part);
    let v: 'video' | 'audio' | undefined;
    try {
      const got = get(part);
      v = got === 'video' || got === 'audio' ? got : undefined;
    } catch {
      v = undefined; // a kind the caller cannot tell is unknown
    }
    known.set(part, v);
    return v;
  };
}

/** Picture sides a caller's size may have (`picture.ts` reads headers to the same bound). */
const MAX_PICTURE_SIDE = 1_000_000;

/** `ParseOptions.pictureSize` asked once per part, its answer checked. */
function pictureSizes(
  get: ParseOptions['pictureSize'],
): ((part: string) => PictureHeader | undefined) | undefined {
  if (!get) return undefined;
  const known = new Map<string, PictureHeader | undefined>();
  return (part) => {
    if (known.has(part)) return known.get(part);
    let v: PictureHeader | undefined;
    try {
      const got = get(part);
      const ok = (n: unknown): n is number =>
        typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= MAX_PICTURE_SIDE;
      if (got && ok(got.w) && ok(got.h)) {
        v = { w: got.w, h: got.h, ...(typeof got.alpha === 'boolean' ? { alpha: got.alpha } : {}) };
        // M6: a stated resolution sizes tiles (`bake.ts`).
        const dpi = got.dpi;
        const okDpi = (n: unknown): n is number =>
          typeof n === 'number' && Number.isFinite(n) && n >= MIN_DPI && n <= MAX_DPI;
        if (dpi && okDpi(dpi.x) && okDpi(dpi.y)) v.dpi = { x: dpi.x, y: dpi.y };
      }
    } catch {
      v = undefined; // a size the caller cannot read is unknown
    }
    known.set(part, v);
    return v;
  };
}

/**
 * Read a deck into the scene IR. Never throws for one bad slide: that slide gets `error` (it is
 * quarantined as class 'picture'). Throws only when the deck has no readable presentation part.
 */
export function parseDeck(src: PartSource, opts: ParseOptions = {}): DeckScene {
  const r = openScene(src, opts);
  const slides = r.refs.map(r.readSlide);
  return { frame: r.frame, slides, sections: r.deck.sections, notes: r.notes };
}

/** A deck opened for reading: its facts, the slides to read, and a reader for one slide. */
interface SceneReader {
  deck: DeckInfo;
  frame: Frame;
  /** The slides of the range (all of them without one), in order. */
  refs: SlideRef[];
  readSlide: (ref: SlideRef) => SlideScene;
  /** Deck-level notes so far (the list grows as slides are read). */
  notes: string[];
}

function openScene(src: PartSource, opts: ParseOptions): SceneReader {
  const deckNotes = noteList();
  const log: Log = (msg) => {
    deckNotes.log(msg);
    opts.log?.(msg);
  };
  const pkg = openPackage(src, log);
  const deck = readDeck(pkg);
  const frame = frameOf(deck.size.cx, deck.size.cy);
  const pictureSize = pictureSizes(opts.pictureSize);
  const mediaKind = mediaKinds(opts.mediaKind);
  const fontFace = faceSources(opts.fontFace);
  const range = opts.range;
  const refs = range ? deck.slides.filter((r) => r.index >= range.from && r.index < range.to) : deck.slides;
  const readSlide = (ref: SlideRef): SlideScene => {
    const t0 = performance.now();
    const { notes, log: slideLog } = noteList();
    const base = {
      index: ref.index,
      ...(ref.shown !== undefined ? { shown: ref.shown } : {}),
      hidden: ref.hidden,
      part: ref.part,
    };
    try {
      const ctx = slideContext(pkg, deck, frame, ref, slideLog, {
        ...(pictureSize ? { pictureSize } : {}),
        ...(mediaKind ? { mediaKind } : {}),
        ...(fontFace ? { fontFace } : {}),
      });
      // Clip timing is read before the shape tree, which attaches it to each poster (`media.ts`).
      ctx.timing = readSlideTiming(ctx.slide);
      const elements = walkSlide(ctx);
      const background = readBackground(ctx);
      const classification = classifySlide(ctx, elements, background, {
        budgetArt: opts.budgetArt === true,
        budget: { decorations: (opts.m9Writes ?? ALL_M9_FIELDS).has('decor'), sheets: opts.sheets !== false },
      });
      return {
        ...base,
        layoutPart: ctx.layoutPart,
        masterPart: ctx.masterPart,
        background,
        elements,
        classification,
        notes,
        ms: performance.now() - t0,
        ...readSlideSounds(ctx, ctx.timing),
      };
    } catch (e) {
      const error = clean(e instanceof Error ? e.message : String(e));
      return {
        ...base,
        background: { fill: { kind: 'none' }, from: 'none' },
        elements: [],
        classification: { tier: 'fallback', class: 'picture', reasons: ['unreadable'] },
        notes: [...notes, `slide could not be read: ${error}`],
        error,
        ms: performance.now() - t0,
      };
    }
  };
  return { deck, frame, refs, readSlide, notes: deckNotes.notes };
}

/** Turn a scene into ordo slides (see `EmitOptions`). Pure: the same scene and options give the same slides. */
export function emitSlides(scene: DeckScene, opts: EmitOptions = {}): EmitResult {
  return emitDeck(scene, opts);
}

export interface ConvertOptions extends ParseOptions, EmitOptions {}

/** `convertDeck`'s answer: the emitted slides of the range, with the deck facts a batch caller needs. */
export interface ConvertResult extends EmitResult {
  frame: Frame;
  /** Sections over the whole deck, by `SlideRef.index`. */
  sections: SectionInfo[];
  /** Every slide the deck lists, in order (all batches): part, hidden flag and shown index. */
  listed: SlideRef[];
}

/**
 * Parse and emit in one call, the entry point of the hub's `pptx-scene` pool task (design/27 §2, M3). With
 * `range`, only that batch of slides is converted; media ids (`pptxmedia:<n>`) and default object ids are
 * numbered per call, so a batch caller maps them through `EmitResult.media` or passes `mediaId`/`newId`.
 * Each slide is emitted as soon as it is read, so one slide's IR is alive at a time (design/27 §12: a batch
 * of 150 slides within the pool's heap); the result is what `emitSlides(parseDeck(src, opts), opts)` gives.
 */
export function convertDeck(src: PartSource, opts: ConvertOptions = {}): ConvertResult {
  const r = openScene(src, opts);
  // Ids numbered across the slides of the call, as `emitDeck` numbers them over a whole scene.
  let n = 0;
  const newId = opts.newId ?? (() => `pptx-${++n}`);
  const media = new Map<string, string>();
  const mediaId = (part: string) => {
    let id = media.get(part);
    if (id === undefined) {
      id = opts.mediaId ? opts.mediaId(part) : `${MEDIA_PREFIX}${media.size + 1}`;
      media.set(part, id);
    }
    return id;
  };
  // Clip placeholders numbered across the call too (one per part and trim).
  const clips = new Map<string, string>();
  const clipId = (key: string) => {
    let id = clips.get(key);
    if (id === undefined) {
      id = opts.clipId ? opts.clipId(key) : `${CLIP_PREFIX}${clips.size + 1}`;
      clips.set(key, id);
    }
    return id;
  };
  // Baked pictures numbered across the call too (one per part and recipe, M6).
  const bakes = new Map<string, { id: string; part: string; bake: PictureBake }>();
  const bakeId = (part: string, bake: PictureBake) => {
    const key = bakeKey(part, bake);
    let b = bakes.get(key);
    if (!b) {
      b = { id: opts.bakeId ? opts.bakeId(part, bake) : `${BAKE_PREFIX}${bakes.size + 1}`, part, bake };
      bakes.set(key, b);
    }
    return b.id;
  };
  // Geometry files numbered across the call too (one per distinct file, M6 round 2).
  const geomIds = new Map<string, string>();
  const geomId = (json: string) => {
    let id = geomIds.get(json);
    if (id === undefined) {
      id = opts.geomId ? opts.geomId(json) : `${GEOM_PREFIX}${geomIds.size + 1}`;
      geomIds.set(json, id);
    }
    return id;
  };
  // M9 (`decor-conv`): decoration files and sheets numbered across the call too (one per distinct one).
  const decorIds = new Map<string, string>();
  const decorId = (json: string) => {
    let id = decorIds.get(json);
    if (id === undefined) {
      id = opts.decorId ? opts.decorId(json) : `${DECOR_PREFIX}${decorIds.size + 1}`;
      decorIds.set(json, id);
    }
    return id;
  };
  const sheetIds = new Map<string, string>();
  const sheetId = (bake: SheetBake) => {
    const key = sheetKey(bake);
    let id = sheetIds.get(key);
    if (id === undefined) {
      id = opts.sheetId ? opts.sheetId(bake) : `${SHEET_PREFIX}${sheetIds.size + 1}`;
      sheetIds.set(key, id);
    }
    return id;
  };
  const geoms = new Map<string, EmitResult['geoms'][number]>();
  const decors = new Map<string, EmitResult['decors'][number]>();
  const sheets = new Map<string, EmitResult['sheets'][number]>();
  const slides: EmittedSlide[] = [];
  for (const ref of r.refs) {
    const scene: DeckScene = { frame: r.frame, slides: [r.readSlide(ref)], sections: [], notes: [] };
    const one = emitDeck(scene, { ...opts, newId, mediaId, clipId, bakeId, geomId, decorId, sheetId });
    slides.push(one.slides[0]!);
    for (const g of one.geoms) if (!geoms.has(g.id)) geoms.set(g.id, g);
    for (const d of one.decors) if (!decors.has(d.id)) decors.set(d.id, d);
    for (const b of one.sheets) if (!sheets.has(b.id)) sheets.set(b.id, b);
  }
  return {
    slides,
    media: [
      ...[...media].map(([part, id]) => ({ id, part })),
      ...[...bakes.values()].map((b) => ({ id: b.id, part: b.part, bake: b.bake })),
    ],
    slideRect: slideRect(r.frame),
    notes: [...r.notes],
    geoms: [...geoms.values()],
    decors: [...decors.values()],
    sheets: [...sheets.values()],
    frame: r.frame,
    sections: r.deck.sections,
    listed: r.deck.slides,
  };
}
