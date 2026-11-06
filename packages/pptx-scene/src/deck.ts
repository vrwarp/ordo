/**
 * `presentation.xml` and the parts each slide hangs off (design/27 §1 `deck.ts`, §4 "Order and identity").
 *
 * Owned by work item A (reading). Still to do: `p14:sectionLst`, `embeddedFontLst`, a prefix-agnostic
 * `r:id` on `p:sldId`, slides by `slideN` number when `p:sldIdLst` is empty, duplicates placed once, and
 * the shown index exactly as `annotate.ts` `placeSlides` (725-800).
 */
import type { SectionInfo } from './ir.ts';
import { clean } from './log.ts';
import type { Package } from './opc.ts';
import { child, num, type XNode } from './xml.ts';

/** At most this many slides are read (design/27 §4). */
export const MAX_SLIDES = 2_000;

/** One entry of the slide order. */
export interface SlideRef {
  /** Position in `p:sldIdLst` order. */
  index: number;
  /** The slide part, e.g. `ppt/slides/slide1.xml`. */
  part: string;
  /** `show="0"` or `"false"` on `p:sld`. */
  hidden: boolean;
  /** Position among the shown slides; undefined when hidden. */
  shown?: number;
}

export interface DeckInfo {
  /** The presentation part, usually `ppt/presentation.xml`. */
  presentationPart: string;
  /** `p:sldSz` in EMU (the default 12,192,000 x 6,858,000 when missing or out of bounds). */
  size: { cx: number; cy: number };
  slides: SlideRef[];
  /** `p:defaultTextStyle`: the list style of text that is not in a placeholder. */
  defaultTextStyle?: XNode;
  sections: SectionInfo[];
  /** Typefaces of `p:embeddedFontLst` (decks with embedded fonts are excluded from harness means). */
  embeddedFonts: string[];
}

/** The parts a slide inherits from, each with its parsed root. */
export interface SlideParts {
  slide: XNode;
  layoutPart?: string;
  layout?: XNode;
  masterPart?: string;
  master?: XNode;
  themePart?: string;
  theme?: XNode;
}

/** Read `presentation.xml`: slide size, slide order with hidden flags and shown index, default text style. */
export function readDeck(pkg: Package): DeckInfo {
  const presentationPart = pkg.relOfType('', 'officeDocument')?.target ?? 'ppt/presentation.xml';
  const pres = pkg.xml(presentationPart);
  if (!pres) throw new Error('the deck has no presentation part');
  const sz = child(pres, 'p:sldSz');
  const size = { cx: num(sz?.attrs.cx) ?? 12_192_000, cy: num(sz?.attrs.cy) ?? 6_858_000 };
  const slides: SlideRef[] = [];
  let shown = 0;
  for (const id of child(pres, 'p:sldIdLst')?.children ?? []) {
    if (id.name !== 'p:sldId') continue;
    if (slides.length >= MAX_SLIDES) {
      pkg.log(`only the first ${MAX_SLIDES} slides are read`);
      break;
    }
    const rid = id.attrs['r:id'];
    const rel = rid === undefined ? undefined : pkg.rel(presentationPart, rid);
    if (!rel || rel.external || !pkg.has(rel.target)) continue;
    let hidden = false;
    try {
      const show = pkg.xml(rel.target)?.attrs.show;
      hidden = show === '0' || show === 'false';
    } catch {
      /* unreadable: quarantined when the slide is read */
    }
    slides.push({ index: slides.length, part: rel.target, hidden, ...(hidden ? {} : { shown: shown++ }) });
  }
  return {
    presentationPart,
    size,
    slides,
    defaultTextStyle: child(pres, 'p:defaultTextStyle'),
    sections: [],
    embeddedFonts: [],
  };
}

/** Follow a slide to its layout, master and theme. Throws when the slide part cannot be read. */
export function slideParts(pkg: Package, part: string): SlideParts {
  const slide = pkg.xml(part);
  if (!slide) throw new Error(`${clean(part)} is missing`);
  const out: SlideParts = { slide };
  const read = (p: string | undefined): XNode | undefined => {
    if (p === undefined) return undefined;
    try {
      return pkg.xml(p);
    } catch (e) {
      pkg.log(`${clean(p)} could not be read: ${clean((e as Error).message)}`);
      return undefined;
    }
  };
  out.layoutPart = pkg.relOfType(part, 'slideLayout')?.target;
  out.layout = read(out.layoutPart);
  out.masterPart =
    out.layoutPart === undefined ? undefined : pkg.relOfType(out.layoutPart, 'slideMaster')?.target;
  out.master = read(out.masterPart);
  out.themePart = out.masterPart === undefined ? undefined : pkg.relOfType(out.masterPart, 'theme')?.target;
  out.theme = read(out.themePart);
  return out;
}
