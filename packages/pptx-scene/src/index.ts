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
import { type EmitOptions, type EmitResult, emitDeck } from './emit.ts';
import { frameOf } from './frame.ts';
import type { DeckScene, Frame, SectionInfo, SlideScene } from './ir.ts';
import { clean, type Log, noteList } from './log.ts';
import { openPackage, type PartSource } from './opc.ts';
import { walkSlide } from './walk.ts';

export type { BlipReader, ColorCtx } from './color.ts';
export type { SlideCtx, Source } from './context.ts';
export type { DeckInfo, SlideRef } from './deck.ts';
export type { EmitOptions, EmitResult, EmittedSlide } from './emit.ts';
export { MEDIA_PREFIX } from './emit.ts';
export { pictureSize } from './picture.ts';
export * from './ir.ts';
export type { Log } from './log.ts';
export type { Package, PartSource, Rel } from './opc.ts';
export type { Theme } from './theme.ts';

export interface ParseOptions {
  /** Receives deck-level notes as they happen (they are also in `DeckScene.notes`). */
  log?: Log;
  /**
   * The pixel size of a picture part whose bytes are not in `src` (spilled to disk), e.g. from its first
   * bytes on disk. Asked at most once per part; sides outside 1..1,000,000 count as unknown. Without it a
   * spilled picture's size is unknown, and a background picture of unknown size is drawn as a stretched
   * image over the slide rather than as the slide background (design/27 §4 "Backgrounds").
   */
  pictureSize?: (part: string) => { w: number; h: number } | undefined;
  /**
   * Read only the slides whose place in the deck's order (`SlideRef.index`) is in [from, to): one batch of
   * the hub's pool task (design/27 §2). Deck facts (frame, sections, notes) are read whole either way.
   */
  range?: { from: number; to: number };
}

/** Picture sides a caller's size may have (`picture.ts` reads headers to the same bound). */
const MAX_PICTURE_SIDE = 1_000_000;

/** `ParseOptions.pictureSize` asked once per part, its answer checked. */
function pictureSizes(
  get: ParseOptions['pictureSize'],
): ((part: string) => { w: number; h: number } | undefined) | undefined {
  if (!get) return undefined;
  const known = new Map<string, { w: number; h: number } | undefined>();
  return (part) => {
    if (known.has(part)) return known.get(part);
    let v: { w: number; h: number } | undefined;
    try {
      const got = get(part);
      const ok = (n: unknown): n is number =>
        typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= MAX_PICTURE_SIDE;
      if (got && ok(got.w) && ok(got.h)) v = { w: got.w, h: got.h };
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
  return readScene(src, opts).scene;
}

function readScene(src: PartSource, opts: ParseOptions): { scene: DeckScene; deck: DeckInfo } {
  const deckNotes = noteList();
  const log: Log = (msg) => {
    deckNotes.log(msg);
    opts.log?.(msg);
  };
  const pkg = openPackage(src, log);
  const deck = readDeck(pkg);
  const frame = frameOf(deck.size.cx, deck.size.cy);
  const pictureSize = pictureSizes(opts.pictureSize);
  const range = opts.range;
  const refs = range ? deck.slides.filter((r) => r.index >= range.from && r.index < range.to) : deck.slides;
  const slides: SlideScene[] = refs.map((ref) => {
    const t0 = performance.now();
    const { notes, log: slideLog } = noteList();
    const base = {
      index: ref.index,
      ...(ref.shown !== undefined ? { shown: ref.shown } : {}),
      hidden: ref.hidden,
      part: ref.part,
    };
    try {
      const ctx = slideContext(pkg, deck, frame, ref, slideLog, pictureSize ? { pictureSize } : {});
      const elements = walkSlide(ctx);
      const background = readBackground(ctx);
      const classification = classifySlide(ctx, elements, background);
      return {
        ...base,
        layoutPart: ctx.layoutPart,
        masterPart: ctx.masterPart,
        background,
        elements,
        classification,
        notes,
        ms: performance.now() - t0,
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
  });
  return { scene: { frame, slides, sections: deck.sections, notes: deckNotes.notes }, deck };
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
 * The IR is not returned: M3 item A keeps only one slide's IR alive at a time behind this signature.
 */
export function convertDeck(src: PartSource, opts: ConvertOptions = {}): ConvertResult {
  const { scene, deck } = readScene(src, opts);
  const out = emitDeck(scene, opts);
  return { ...out, frame: scene.frame, sections: scene.sections, listed: deck.slides };
}
