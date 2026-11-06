/**
 * `presentation.xml` and the parts each slide hangs off (design/27 §1 `deck.ts`, §4 "Order and identity").
 *
 * - **Size**: `p:sldSz`, else (missing or out of bounds) the one default 12,192,000 x 6,858,000 EMU.
 * - **Order**: `p:sldIdLst`, each entry's relationship id read whatever its prefix. Slides it does not list
 *   are not read. When it lists no slide that exists, the presentation's slide relationships (else the
 *   content types' slide parts) by the number in their name (`slide2` before `slide10`). At most 2,000.
 * - **Hidden and shown** (port of `pptx-render/src/annotate.ts` `placeSlides`): `show="0"` or `"false"` on
 *   `p:sld` hides a slide; it keeps its place in the order and has no shown index. A slide listed twice is read
 *   once, at its first place, but each later listing of a shown slide still takes a shown index: LibreOffice
 *   prints one page per listing (verified), and the shown index is the LibreOffice page.
 * - `p14:sectionLst`, `p:defaultTextStyle` and `p:embeddedFontLst`.
 *
 * Owned by work item A (reading).
 */
import { DEFAULT_SLIDE, MAX_SIDE, MIN_SIDE } from './frame.ts';
import type { SectionInfo } from './ir.ts';
import { clean } from './log.ts';
import { decodeText, type Package, relIdOf, relType, SLIDE_CONTENT_TYPE } from './opc.ts';
import { child, children, num, rootTag, type XNode } from './xml.ts';

/** At most this many slides are read (design/27 §4). */
export const MAX_SLIDES = 2_000;
/** Sections read from `p14:sectionLst`. */
export const MAX_SECTIONS = 1_000;
/** Typefaces read from `p:embeddedFontLst`. */
export const MAX_EMBEDDED_FONTS = 64;
/** Bytes at the start of a slide part searched for its root tag (the show flag) before parsing all of it. */
export const SLIDE_HEAD_BYTES = 64 * 1024;

/** Content types of a presentation part: a deck, a show, a template, a macro-enabled deck. */
const PRESENTATION_TYPES = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml',
  'application/vnd.ms-powerpoint.template.macroEnabled.main+xml',
];

/** One entry of the slide order. */
export interface SlideRef {
  /** Position in the slide order (`DeckInfo.slides`). */
  index: number;
  /** The slide part, e.g. `ppt/slides/slide1.xml`. */
  part: string;
  /** `show="0"` or `"false"` on `p:sld`. */
  hidden: boolean;
  /**
   * The slide's LibreOffice page: its place among the shown listings of `p:sldIdLst` (a repeated listing
   * counts). Undefined when hidden.
   */
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
  /**
   * `p14:sectionLst` in order, names cleaned and cut to 200 characters. A slide is in at most one section
   * (its first); listed ids that name no slide are dropped; a section may be empty.
   */
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

/** The presentation part: the package's officeDocument, else a presentation content type, else the usual name. */
function presentationOf(pkg: Package): { part: string; root: XNode } {
  const candidates = [
    pkg.relOfType('', 'officeDocument')?.target,
    ...PRESENTATION_TYPES.flatMap((t) => pkg.partsOfType(t)),
    'ppt/presentation.xml',
  ];
  const tried = new Set<string>();
  let error: unknown;
  for (const c of candidates) {
    const part = c === undefined ? undefined : pkg.find(c);
    if (part === undefined || tried.has(part)) continue;
    tried.add(part);
    try {
      const root = pkg.xml(part);
      if (root?.name === 'p:presentation') return { part, root };
    } catch (e) {
      error ??= e;
    }
  }
  if (error) throw error;
  throw new Error('the deck has no presentation part');
}

function sizeOf(pkg: Package, pres: XNode): { cx: number; cy: number } {
  const sz = child(pres, 'p:sldSz');
  const cx = num(sz?.attrs.cx);
  const cy = num(sz?.attrs.cy);
  const ok = (v: number | undefined): v is number => v !== undefined && v >= MIN_SIDE && v <= MAX_SIDE;
  if (ok(cx) && ok(cy)) return { cx, cy };
  if (sz) pkg.log('the slide size is out of bounds: the default 13.333 x 7.5 in is used');
  return { cx: DEFAULT_SLIDE.cx, cy: DEFAULT_SLIDE.cy };
}

/** The root of a slide part (name as written, attributes) from its head, else from the whole part. */
function slideRoot(pkg: Package, part: string): XNode | undefined {
  const b = pkg.bytes(part);
  if (!b) return undefined;
  // The root tag is usually within the first kilobyte; a long run of declarations may push it further.
  const head =
    rootTag(decodeText(b.subarray(0, 4096))) ??
    (b.length > 4096 ? rootTag(decodeText(b.subarray(0, SLIDE_HEAD_BYTES))) : undefined);
  if (head) return head;
  try {
    return pkg.xml(part);
  } catch {
    return undefined; // unreadable: quarantined when the slide is read
  }
}

/** The number in a part's file name (`slide12.xml` → 12), for the order without `p:sldIdLst`. */
function partNumber(part: string): number {
  const base = part.slice(part.lastIndexOf('/') + 1);
  let end = base.length;
  while (end > 0 && !(base.charCodeAt(end - 1) >= 0x30 && base.charCodeAt(end - 1) <= 0x39)) end--;
  let start = end;
  while (start > 0 && base.charCodeAt(start - 1) >= 0x30 && base.charCodeAt(start - 1) <= 0x39) start--;
  return start < end ? Number(base.slice(Math.max(start, end - 9), end)) : Number.MAX_SAFE_INTEGER;
}

interface Listing {
  part: string;
  /** `p:sldId id`, for sections. */
  id?: string;
}

/** The slides `p:sldIdLst` lists, in order (repeats kept). */
function listed(pkg: Package, presentationPart: string, pres: XNode): Listing[] {
  const out: Listing[] = [];
  let broken = 0;
  for (const el of child(pres, 'p:sldIdLst')?.children ?? []) {
    if (el.name !== 'p:sldId') continue;
    const rid = relIdOf(el);
    const rel = rid === undefined ? undefined : pkg.rel(presentationPart, rid);
    if (!rel || rel.external || !pkg.has(rel.target)) broken++;
    else out.push({ part: rel.target, id: el.attrs.id });
  }
  if (broken) pkg.log(`${broken} slide list entr${broken === 1 ? 'y names' : 'ies name'} no slide part`);
  return out;
}

/** The slides by number in their names, for a deck whose `p:sldIdLst` lists none. */
function numbered(pkg: Package, presentationPart: string): Listing[] {
  const parts = new Set<string>();
  for (const r of pkg.rels(presentationPart))
    if (!r.external && relType(r.type) === 'slide' && pkg.has(r.target)) parts.add(r.target);
  if (!parts.size) for (const p of pkg.partsOfType(SLIDE_CONTENT_TYPE)) parts.add(p);
  return [...parts]
    .map((part, i) => ({ part, n: partNumber(part), i }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map(({ part }) => ({ part }));
}

function sectionsOf(pres: XNode, idToIndex: Map<string, number>): SectionInfo[] {
  const out: SectionInfo[] = [];
  const placed = new Set<number>();
  for (const ext of children(child(pres, 'p:extLst'), 'p:ext'))
    for (const sec of children(child(ext, 'p14:sectionLst'), 'p14:section')) {
      if (out.length >= MAX_SECTIONS) return out;
      const slides: number[] = [];
      for (const id of children(child(sec, 'p14:sldIdLst'), 'p14:sldId')) {
        const index = id.attrs.id === undefined ? undefined : idToIndex.get(id.attrs.id);
        if (index === undefined || placed.has(index)) continue;
        placed.add(index);
        slides.push(index);
      }
      out.push({ name: clean(sec.attrs.name ?? '', 200), slides });
    }
  return out;
}

function embeddedFontsOf(pres: XNode): string[] {
  const out = new Set<string>();
  for (const f of children(child(pres, 'p:embeddedFontLst'), 'p:embeddedFont')) {
    const face = clean(child(f, 'p:font')?.attrs.typeface ?? '', 100);
    if (face) out.add(face);
    if (out.size >= MAX_EMBEDDED_FONTS) break;
  }
  return [...out];
}

/** Read `presentation.xml`: slide size, slide order with hidden flags and shown index, sections, styles. */
export function readDeck(pkg: Package): DeckInfo {
  const { part: presentationPart, root: pres } = presentationOf(pkg);
  let entries = listed(pkg, presentationPart, pres);
  if (!entries.length) {
    entries = numbered(pkg, presentationPart);
    if (entries.length) pkg.log('the slide list is empty: slides are read in the order of their part names');
  }
  const slides: SlideRef[] = [];
  const byPart = new Map<string, SlideRef>();
  const notSlide = new Set<string>();
  const idToIndex = new Map<string, number>();
  let shown = 0;
  let repeats = 0;
  for (const e of entries) {
    if (notSlide.has(e.part)) continue;
    let ref = byPart.get(e.part);
    if (ref) {
      repeats++;
      if (!ref.hidden) shown++;
    } else {
      if (slides.length >= MAX_SLIDES) {
        pkg.log(`only the first ${MAX_SLIDES} slides are read`);
        break;
      }
      const root = slideRoot(pkg, e.part);
      // A listed part that is not a slide (a layout, a master) is not read. Unreadable ones are, and fail later.
      if (root && root.name !== 'p:sld' && !root.name.endsWith(':sld') && root.name !== 'sld') {
        notSlide.add(e.part);
        continue;
      }
      const show = root?.attrs.show?.trim(); // an XML Schema boolean: surrounding spaces allowed
      const hidden = show === '0' || show === 'false';
      ref = { index: slides.length, part: e.part, hidden, ...(hidden ? {} : { shown: shown++ }) };
      slides.push(ref);
      byPart.set(e.part, ref);
    }
    if (e.id !== undefined && !idToIndex.has(e.id)) idToIndex.set(e.id, ref.index);
  }
  if (repeats) pkg.log(`${repeats} repeated slide list entr${repeats === 1 ? 'y' : 'ies'}: read once each`);
  if (notSlide.size)
    pkg.log(`${notSlide.size} listed part${notSlide.size === 1 ? ' is' : 's are'} not a slide`);
  return {
    presentationPart,
    size: sizeOf(pkg, pres),
    slides,
    defaultTextStyle: child(pres, 'p:defaultTextStyle'),
    sections: sectionsOf(pres, idToIndex),
    embeddedFonts: embeddedFontsOf(pres),
  };
}

/** Follow a slide to its layout, master and theme. Throws when the slide part cannot be read. */
export function slideParts(pkg: Package, part: string): SlideParts {
  const slide = pkg.xml(part);
  if (!slide) throw new Error(`${clean(part)} is missing`);
  if (slide.name !== 'p:sld') throw new Error(`${clean(part)} is not a slide`);
  const out: SlideParts = { slide };
  /** A related part with the expected root element; anything else (a cycle, a wrong type) is not used. */
  const read = (p: string | undefined, root: string): XNode | undefined => {
    if (p === undefined) return undefined;
    try {
      const n = pkg.xml(p);
      if (n && n.name !== root) {
        pkg.log(`${clean(p)} is not a ${root} part: not used`);
        return undefined;
      }
      return n;
    } catch (e) {
      pkg.log(`${clean(p)} could not be read: ${clean((e as Error).message)}`);
      return undefined;
    }
  };
  const layoutPart = pkg.relOfType(part, 'slideLayout')?.target;
  out.layout = read(layoutPart, 'p:sldLayout');
  if (out.layout) out.layoutPart = layoutPart;
  const masterPart = out.layoutPart && pkg.relOfType(out.layoutPart, 'slideMaster')?.target;
  out.master = read(masterPart, 'p:sldMaster');
  if (out.master) out.masterPart = masterPart;
  const themePart = out.masterPart && pkg.relOfType(out.masterPart, 'theme')?.target;
  out.theme = read(themePart, 'a:theme');
  if (out.theme) out.themePart = themePart;
  return out;
}
