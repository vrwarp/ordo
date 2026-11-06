/**
 * @ordo/pptx-scene: PowerPoint decks as ordinary ordo slides (design/27).
 *
 *   const scene = parseDeck(parts);          // untrusted deck → hub-internal scene IR
 *   const out = emitSlides(scene, { ... });  // IR → ordo Slides with `pptxmedia:<part>` picture ids
 *
 * Pure TypeScript: no DOM, no zip, no fs, no runtime dependency. The input is the deck's parts by name
 * (`extractZip`'s `files`); media parts may be empty (spilled to disk), only their names are used.
 */
import { classifySlide } from './classify.ts';
import { slideContext } from './context.ts';
import { readDeck } from './deck.ts';
import { readBackground } from './background.ts';
import { type EmitOptions, type EmitResult, emitDeck } from './emit.ts';
import { frameOf } from './frame.ts';
import type { DeckScene, SlideScene } from './ir.ts';
import { clean, type Log, noteList } from './log.ts';
import { openPackage, type PartSource } from './opc.ts';
import { walkSlide } from './walk.ts';

export type { BlipReader, ColorCtx } from './color.ts';
export type { SlideCtx, Source } from './context.ts';
export type { DeckInfo, SlideRef } from './deck.ts';
export type { EmitOptions, EmitResult, EmittedSlide } from './emit.ts';
export { MEDIA_PREFIX } from './emit.ts';
export * from './ir.ts';
export type { Log } from './log.ts';
export type { Package, PartSource, Rel } from './opc.ts';
export type { Theme } from './theme.ts';

export interface ParseOptions {
  /** Receives deck-level notes as they happen (they are also in `DeckScene.notes`). */
  log?: Log;
}

/**
 * Read a deck into the scene IR. Never throws for one bad slide: that slide gets `error` (it is
 * quarantined as class 'picture'). Throws only when the deck has no readable presentation part.
 */
export function parseDeck(src: PartSource, opts: ParseOptions = {}): DeckScene {
  const deckNotes = noteList();
  const log: Log = (msg) => {
    deckNotes.log(msg);
    opts.log?.(msg);
  };
  const pkg = openPackage(src, log);
  const deck = readDeck(pkg);
  const frame = frameOf(deck.size.cx, deck.size.cy);
  const slides: SlideScene[] = deck.slides.map((ref) => {
    const t0 = performance.now();
    const { notes, log: slideLog } = noteList();
    const base = {
      index: ref.index,
      ...(ref.shown !== undefined ? { shown: ref.shown } : {}),
      hidden: ref.hidden,
      part: ref.part,
    };
    try {
      const ctx = slideContext(pkg, deck, frame, ref, slideLog);
      const elements = walkSlide(ctx);
      const background = readBackground(ctx);
      return {
        ...base,
        layoutPart: ctx.layoutPart,
        masterPart: ctx.masterPart,
        background,
        elements,
        classification: classifySlide(ctx, elements, background),
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
  return { frame, slides, sections: deck.sections, notes: deckNotes.notes };
}

/** Turn a scene into ordo slides (see `EmitOptions`). Pure: the same scene and options give the same slides. */
export function emitSlides(scene: DeckScene, opts: EmitOptions = {}): EmitResult {
  return emitDeck(scene, opts);
}
