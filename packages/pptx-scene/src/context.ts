/**
 * What every per-slide reader receives: the package, the deck, the slide's parsed parts, its theme and its
 * colour context. Shared by all work items; change it only by adding fields.
 */
import { type ColorCtx, colorContext } from './color.ts';
import { type DeckInfo, type SlideRef, slideParts } from './deck.ts';
import type { Frame } from './ir.ts';
import type { Log } from './log.ts';
import type { FaceSource } from './metrics.ts';
import type { Package } from './opc.ts';
import { readTheme, type Theme } from './theme.ts';
import type { SlideTiming } from './timing.ts';
import { child, type XNode } from './xml.ts';

export interface SlideCtx {
  pkg: Package;
  deck: DeckInfo;
  frame: Frame;
  ref: SlideRef;
  /** The slide part and its root (`p:sld`). */
  part: string;
  slide: XNode;
  layoutPart?: string;
  /** `p:sldLayout`. */
  layout?: XNode;
  masterPart?: string;
  /** `p:sldMaster`. */
  master?: XNode;
  theme: Theme;
  /** The theme part, for the relationships of its picture fills (added by work item C). */
  themePart?: string;
  /**
   * Master clrMap with the layout's and then the slide's clrMapOvr: used for the slide's own, inherited and
   * background colours.
   */
  color: ColorCtx;
  /** This slide's notes (approximations, skipped content). */
  log: Log;
  /**
   * The pixel size of a picture part whose bytes are not in the package (spilled to disk), when the caller
   * can tell (`ParseOptions.pictureSize`). Undefined: unknown.
   */
  pictureSize?: (part: string) => { w: number; h: number } | undefined;
  /**
   * Whether a clip part is a video or a sound, from its bytes, when the caller can tell
   * (`ParseOptions.mediaKind`; M5 hub scope; `readMediaRef` has the rule). Undefined: the element and the
   * timing decide.
   */
  mediaKind?: (part: string) => 'video' | 'audio' | undefined;
  /** The slide's `p:timing` and transition sound (`timing.ts`), read before its shape tree. */
  timing?: SlideTiming;
  /**
   * The font faces text is measured with when the caller has them (`ParseOptions.fontFace`, M6 tables: a
   * row grows to its text). Undefined: widths are estimated.
   */
  fontFace?: FaceSource;
}

/** Where an element comes from in the inheritance chain. */
export type Source = 'slide' | 'layout' | 'master';

/** The part that holds a source's XML, for resolving its relationships (`r:embed`, `r:link`). */
export function partOf(ctx: SlideCtx, from: Source): string | undefined {
  return from === 'slide' ? ctx.part : from === 'layout' ? ctx.layoutPart : ctx.masterPart;
}

/** The root of a source's part. */
export function rootOf(ctx: SlideCtx, from: Source): XNode | undefined {
  return from === 'slide' ? ctx.slide : from === 'layout' ? ctx.layout : ctx.master;
}

/** Read a slide's parts and build its context. Throws when the slide part itself cannot be read. */
export function slideContext(
  pkg: Package,
  deck: DeckInfo,
  frame: Frame,
  ref: SlideRef,
  log: Log,
  extra: Pick<SlideCtx, 'pictureSize' | 'mediaKind' | 'fontFace'> = {},
): SlideCtx {
  const parts = slideParts(pkg, ref.part);
  const theme = readTheme(parts.theme);
  return {
    pkg,
    deck,
    frame,
    ref,
    part: ref.part,
    slide: parts.slide,
    layoutPart: parts.layoutPart,
    layout: parts.layout,
    masterPart: parts.masterPart,
    master: parts.master,
    theme,
    themePart: parts.themePart,
    color: colorContext(
      theme,
      child(parts.master, 'p:clrMap'),
      child(parts.slide, 'p:clrMapOvr'),
      child(parts.layout, 'p:clrMapOvr'),
    ),
    log,
    ...(extra.pictureSize ? { pictureSize: extra.pictureSize } : {}),
    ...(extra.mediaKind ? { mediaKind: extra.mediaKind } : {}),
    ...(extra.fontFace ? { fontFace: extra.fontFace } : {}),
  };
}
