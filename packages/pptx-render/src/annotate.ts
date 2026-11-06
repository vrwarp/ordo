import JSZip from 'jszip';
import { encodeMarker, MAX_MARKED_RUNS } from './markers.ts';
import {
  child,
  children,
  countUpTo,
  firstChild,
  num,
  parseXml,
  path,
  rootOf,
  startTags,
  type XNode,
} from './xml.ts';

/**
 * What ordo applies to a rendered run because pptx-preview gets it wrong or ignores it. Only properties
 * this module can resolve from the XML are set; the rest of the run is drawn as pptx-preview draws it.
 */
export type RunStyle = {
  /** The run's Latin typeface, theme references (`+mn-lt`) resolved. */
  latin?: string;
  /** The run's East Asian typeface, theme references resolved. */
  ea?: string;
  /** Font size in points (`sz`, inherited; 18 when nothing sets it), before any shrink to fit. */
  size?: number;
  /** Extra space between characters in points (`spc`). pptx-preview ignores it and condenses Latin text. */
  spc?: number;
  /** OOXML baseline shift: thousandths of a percent of the font size (30000 = raised 30 %). */
  baseline?: number;
  /** Shadows drawn behind the glyphs, in points of the slide, topmost first. */
  shadows?: TextShadow[];
  /** The run's paragraph (index into `Annotation.paras`). */
  p?: number;
  /** The run's text box (index into `Annotation.bodies`). */
  b?: number;
};

export type TextShadow = { dx: number; dy: number; blur: number; color: string };

/** Paragraph properties ordo applies to the run's `<p>`. */
export type ParaStyle = {
  /**
   * Line spacing as a percentage of single spacing, in thousandths (100000 = single). Single spacing is
   * 1.2 times the font size, whatever the font; pptx-preview uses the font size itself.
   */
  lnSpcPct?: number;
  /** Exact line spacing in points. */
  lnSpcPt?: number;
  /** Space before and after the paragraph: points, or a multiple of the paragraph's font size. */
  spcBef?: Spacing;
  spcAft?: Spacing;
  /** The paragraph's end mark (`a:endParaRPr`): what an empty paragraph's height comes from. */
  end?: RunStyle;
  /**
   * Alignment (`algn`, inherited; left when nothing says). pptx-preview knows only l/ctr/r/dist and centres
   * justified text (`just`), common on scripture slides.
   */
  align?: 'l' | 'ctr' | 'r' | 'just' | 'dist' | 'justLow' | 'thaiDist';
};

export type Spacing = { pt: number } | { em: number };

/** Text box properties ordo applies to the run's text wrapper. */
export type BodyStyle = {
  /** Margins in points: left, top, right, bottom (PowerPoint's defaults when the deck sets none). */
  insets: [number, number, number, number];
  /** Where the text sits in the box (`anchor`; PowerPoint's default is the top). */
  anchor: 't' | 'ctr' | 'b';
  /** The box's paragraphs in order (indexes into `Annotation.paras`), one per paragraph pptx-preview draws. */
  paras: number[];
  /** Shrink text on overflow (`a:normAutofit`) and the scale PowerPoint stored, as fractions. */
  autofit?: { fontScale: number; lnSpcReduction: number };
  /** Vertical text (`vert`): not re-fitted or re-placed, pptx-preview's layout is kept. */
  vertical?: boolean;
  /**
   * A preset shape whose text area is not the whole shape (arrows, callouts, diamonds...): pptx-preview's
   * text rectangle and its stored shrink scale are kept.
   */
  shaped?: boolean;
  /**
   * The shape's exact size in points, when it is known from the XML (not in a group, horizontal text):
   * pptx-preview rounds it to whole points, enough to change where lines break and whether text fits.
   */
  size?: { w: number; h: number };
};

/**
 * A slide picture drawn in a shape other than a rectangle (pptx-preview always draws a rectangle). Only
 * pictures directly on a slide (not in groups) are listed; geometry in points.
 */
export type PictureClip = {
  /** The slide's position among the slides pptx-preview draws (0 = first). */
  slide: number;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: 'ellipse' | 'roundRect';
  /** Corner radius in points (roundRect). */
  radius?: number;
};

export type Annotation = {
  /** The deck with a marker in every styled run (the input itself when nothing was marked). */
  bytes: Uint8Array;
  /** Styles by marker id. */
  runs: RunStyle[];
  /** Paragraph styles the runs point to. */
  paras: ParaStyle[];
  /** Text box styles the runs point to. */
  bodies: BodyStyle[];
  /** Pictures to clip to their shape. */
  pictures: PictureClip[];
  /**
   * For each slide pptx-preview draws, in its order (it ignores the presentation's order and sorts slides by
   * the number in their part name), its place in the presentation's order of shown slides, or -1 for a
   * hidden slide (LibreOffice leaves those out). Empty when the order could not be read.
   */
  slideOrder: number[];
  /** Distinct typefaces the marked runs name, for font fallback lookup. */
  families: string[];
  /** Slide size in points (`p:sldSz`, 914400 EMU per inch, 72 points per inch). */
  slideWidthPt: number;
  slideHeightPt: number;
  /** Parts left as they were, and why. */
  notes: string[];
};

/** Largest XML part read (real slide XML is tens of KB). */
const MAX_PART_BYTES = 8 * 1024 * 1024;
/** Largest picture read to remove its colour profile. */
const MAX_PICTURE_BYTES = 64 * 1024 * 1024;
/** Most paragraphs and text boxes described (a deck of a few KB can hold millions of empty ones). */
const MAX_PARAS = 1 << 16;
const MAX_BODIES = 1 << 15;
/** Most XML read in all, over every part (once for the text walk, once more for the passes after it). */
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/**
 * Most `a:t` elements walked in a deck, empty ones included: each is styled before it is marked (or left
 * unmarked), and a few KB of deck can hold hundreds of thousands of empty runs.
 */
const MAX_TEXTS = 1 << 18;
/**
 * Most picture bytes inflated to remove colour profiles, over every picture. A stripped picture stays in
 * memory until the deck is written, and a few MB of deck can inflate to gigabytes of pictures.
 */
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
/** The start of a picture searched for a colour profile. */
const PROFILE_HEAD_BYTES = 256 * 1024;

type ZipStream = {
  on(event: 'data', fn: (chunk: Uint8Array) => void): ZipStream;
  on(event: 'error', fn: (e: Error) => void): ZipStream;
  on(event: 'end', fn: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
};

/**
 * A part's bytes, or undefined when it is missing or inflates past `limit` (counted while inflating: the
 * size a zip entry declares is the deck's own claim).
 */
async function readBytes(
  zip: JSZip,
  name: string,
  limit: number,
  /** Return the first `limit` bytes instead of nothing when the part is longer. */
  head = false,
): Promise<Uint8Array | undefined> {
  const f = zip.file(name);
  if (!f) return undefined;
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    // JSZip's streaming reader (documented, missing from its type declarations).
    const s = (f as unknown as { internalStream(type: 'uint8array'): ZipStream }).internalStream(
      'uint8array',
    );
    const finish = () => {
      const out = new Uint8Array(Math.min(total, limit));
      let o = 0;
      for (const c of chunks) {
        const n = Math.min(c.length, out.length - o);
        out.set(c.subarray(0, n), o);
        o += n;
      }
      resolve(out);
    };
    s.on('data', (chunk: Uint8Array) => {
      if (done) return;
      total += chunk.length;
      chunks.push(chunk);
      if (total > limit) {
        done = true;
        s.pause();
        if (head) finish();
        else resolve(undefined);
      }
    });
    s.on('error', (e: Error) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
    s.on('end', () => {
      if (done) return;
      done = true;
      finish();
    });
    s.resume();
  });
}

async function readText(zip: JSZip, name: string, limit = MAX_PART_BYTES): Promise<string | undefined> {
  const b = await readBytes(zip, name, limit);
  return b && new TextDecoder().decode(b);
}
const EMU_PER_PT = 12_700;
const PART_RE = /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/;

type Theme = {
  major: { latin?: string; ea?: string };
  minor: { latin?: string; ea?: string };
  colors: Record<string, string>;
  effects: XNode[];
};

type Placeholder = { type: string; idx?: string; lstStyle?: XNode; bodyPr?: XNode; xfrm?: XNode };

/** A layout's or master's placeholders, the first of each key in document order. */
type Placeholders = {
  byIdx: Map<string, Placeholder>;
  byType: Map<string, Placeholder>;
  /** By the master placeholder type a type falls back to (`masterType`). */
  byMasterType: Map<string, Placeholder>;
};

type Master = {
  path: string;
  theme: Theme;
  clrMap: Record<string, string>;
  txStyles: { title?: XNode; body?: XNode; other?: XNode };
  placeholders: Placeholders;
};

type Layout = { path: string; master?: Master; placeholders: Placeholders };

type PartCtx = {
  kind: 'slide' | 'layout' | 'master';
  master?: Master;
  layout?: Layout;
  defaultTextStyle?: XNode;
};

type ShapeCtx = {
  ph?: { type: string; idx?: string };
  lstStyle?: XNode;
  shadow?: TextShadow;
  /** The shape's text box (index into the bodies table) and its own `a:bodyPr`. */
  body?: number;
  bodyPr?: XNode;
  /** The shape's own `a:xfrm`, and whether it sits in a group (whose transform scales it). */
  xfrm?: XNode;
  /** Its preset geometry (`a:prstGeom prst`), if it has one. */
  prst?: string;
  grouped?: boolean;
};

/**
 * A paragraph being walked: its level and properties, its index in the paragraph table (-1 when it is not
 * described), and, computed on first use and shared by its runs, its property chain and what runs inherit.
 */
type ParaCtx = { lvl: number; pPr?: XNode; index: number; chain?: XNode[]; inherited?: Inherited };

/** Run properties a paragraph's runs inherit (the first value along its chain), as written. */
type Inherited = { latin?: string; ea?: string; sz?: string; spc?: string; baseline?: string };

/**
 * What a walk collects: one entry per `a:t`, and the paragraph and text box tables runs point to. The walk
 * stops (`over`) at `limit` entries: more than the part's text tags cannot be aligned with them anyway.
 */
type Acc = {
  styles: (RunStyle | null)[];
  paras: ParaStyle[];
  bodies: BodyStyle[];
  limit: number;
  over?: boolean;
};

/** Preset shapes whose text area is the whole shape, as pptx-preview draws them. */
const FULL_TEXT_AREA = new Set([
  'rect',
  'roundRect',
  'snip1Rect',
  'snip2SameRect',
  'round1Rect',
  'round2SameRect',
]);

const EMU_INSET_LR = 91_440;
const EMU_INSET_TB = 45_720;

/** Annotate a deck for pptx-preview: mark every text run and say how ordo styles it after rendering. */
export async function annotatePptx(
  input: Uint8Array,
  /** `signal` stops the work between parts (in the hub it runs on a worker thread, which is terminated). */
  opts: { signal?: AbortSignal } = {},
): Promise<Annotation> {
  const signal = opts.signal;
  signal?.throwIfAborted();
  const zip = await JSZip.loadAsync(input);
  const notes: string[] = [];
  /** A reader of XML parts that reads nothing more once `total` characters have been read. */
  const reader = (total: number) => {
    let budget = total;
    return async (name: string): Promise<string | undefined> => {
      signal?.throwIfAborted();
      if (!zip.file(name)) return undefined;
      if (budget <= 0) return undefined;
      const limit = Math.min(MAX_PART_BYTES, budget);
      const xml = await readText(zip, name, limit);
      if (xml === undefined) {
        notes.push(`${name}: larger than ${limit} bytes, not read`);
        // Out of budget: read nothing more. One oversized part is only skipped.
        if (limit < MAX_PART_BYTES) budget = 0;
      } else budget -= xml.length;
      return xml;
    };
  };
  const read = reader(MAX_TOTAL_BYTES);
  /** The passes after the text walk (picture shapes, chart titles, relationships) read on their own budget. */
  const readLater = reader(MAX_TOTAL_BYTES);
  const parse = async (name: string): Promise<XNode | undefined> => {
    const xml = await read(name);
    if (xml === undefined) return undefined;
    try {
      return rootOf(parseXml(xml, name));
    } catch (e) {
      notes.push(`${name}: ${(e as Error).message}`);
      return undefined;
    }
  };

  const pres = await parse('ppt/presentation.xml');
  const sz = child(pres, 'p:sldSz');
  const slideWidthPt = (num(sz?.attrs.cx) ?? 9_144_000) / EMU_PER_PT;
  const slideHeightPt = (num(sz?.attrs.cy) ?? 6_858_000) / EMU_PER_PT;
  const defaultTextStyle = child(pres, 'p:defaultTextStyle');

  const themes = new Map<string, Theme>();
  const masters = new Map<string, Master>();
  const layouts = new Map<string, Layout>();

  const themeOf = async (p: string): Promise<Theme> => {
    let t = themes.get(p);
    if (!t) {
      t = readTheme(await parse(p));
      themes.set(p, t);
    }
    return t;
  };
  const masterOf = async (p: string): Promise<Master> => {
    let m = masters.get(p);
    if (!m) {
      const root = await parse(p);
      const themePath = await relTarget(zip, p, 'theme');
      const theme = themePath ? await themeOf(themePath) : readTheme(undefined);
      m = {
        path: p,
        theme,
        clrMap: child(root, 'p:clrMap')?.attrs ?? {},
        txStyles: {
          title: path(root, 'p:txStyles', 'p:titleStyle'),
          body: path(root, 'p:txStyles', 'p:bodyStyle'),
          other: path(root, 'p:txStyles', 'p:otherStyle'),
        },
        placeholders: placeholdersOf(root),
      };
      masters.set(p, m);
    }
    return m;
  };
  const layoutOf = async (p: string): Promise<Layout> => {
    let l = layouts.get(p);
    if (!l) {
      const root = await parse(p);
      const mp = await relTarget(zip, p, 'slideMaster');
      l = { path: p, master: mp ? await masterOf(mp) : undefined, placeholders: placeholdersOf(root) };
      layouts.set(p, l);
    }
    return l;
  };

  const runs: RunStyle[] = [];
  const paras: ParaStyle[] = [];
  const bodies: BodyStyle[] = [];
  const families = new Set<string>();
  let changed = await repairContentTypes(zip, notes);
  let full = false;
  /** Text tags walked so far, over every part. */
  let texts = 0;
  const names = Object.keys(zip.files)
    .filter((n) => PART_RE.test(n))
    .sort();
  for (const name of names) {
    if (full) break;
    const xml = await read(name);
    if (xml === undefined || !xml.includes('<a:t')) continue;
    const tags = startTags(xml, 'a:t');
    if (texts + tags.length > MAX_TEXTS) {
      notes.push(`more than ${MAX_TEXTS} text elements; ${name} and the parts after it are left unmarked`);
      break;
    }
    texts += tags.length;
    let root: XNode | undefined;
    try {
      root = rootOf(parseXml(xml, name));
    } catch (e) {
      notes.push(`${name}: ${(e as Error).message}`);
      continue;
    }
    const ctx: PartCtx = { kind: 'slide', defaultTextStyle };
    if (name.startsWith('ppt/slideMasters/')) {
      ctx.kind = 'master';
      ctx.master = await masterOf(name);
    } else if (name.startsWith('ppt/slideLayouts/')) {
      ctx.kind = 'layout';
      ctx.layout = await layoutOf(name);
      ctx.master = ctx.layout.master;
    } else {
      const lp = await relTarget(zip, name, 'slideLayout');
      ctx.layout = lp ? await layoutOf(lp) : undefined;
      ctx.master = ctx.layout?.master;
    }
    // One entry per `a:t` in document order: the style of its run, or null outside a run.
    const acc: Acc = { styles: [], paras, bodies, limit: tags.length };
    walk(root, ctx, {}, undefined, undefined, acc);
    const styles = acc.styles;
    if (acc.over || tags.length !== styles.length) {
      const parsed = acc.over ? `more than ${tags.length}` : String(styles.length);
      notes.push(`${name}: ${tags.length} text tags but ${parsed} parsed; left unmarked`);
      continue;
    }
    let out = '';
    let last = 0;
    for (let i = 0; i < tags.length; i++) {
      const [start, end] = tags[i]!;
      const st = styles[i];
      // `<a:t/>`: an empty run, nothing to mark.
      if (!st || (end - 2 >= start + 4 && xml[end - 2] === '/')) continue;
      if (runs.length >= MAX_MARKED_RUNS) {
        notes.push(`more than ${MAX_MARKED_RUNS} runs; the rest are unmarked`);
        full = true;
        break;
      }
      out += xml.slice(last, end) + encodeMarker(runs.length);
      last = end;
      runs.push(st);
      if (st.latin) families.add(st.latin);
      if (st.ea) families.add(st.ea);
    }
    if (last > 0) {
      zip.file(name, out + xml.slice(last));
      changed = true;
    }
  }
  let drawn: string[] = [];
  let slideOrder: number[] = [];
  try {
    drawn = await previewSlides(zip);
    slideOrder = await shownOrder(zip, pres, drawn, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    notes.push(`slide order: ${(e as Error).message}`);
  }
  // Relationships first: they are small, and a renamed picture needs every one pointing to it rewritten.
  if (await renameMedia(zip, notes, readLater)) changed = true;
  const pictures = await pictureClips(drawn, readLater, notes);
  if (await stripColorProfiles(zip, notes, MAX_MEDIA_BYTES, signal)) changed = true;
  if (await titleCharts(zip, notes, readLater)) changed = true;
  signal?.throwIfAborted();
  const bytes = changed
    ? await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 1 },
      })
    : input;
  return {
    bytes,
    runs,
    paras,
    bodies,
    pictures,
    slideOrder,
    families: [...families].sort(),
    slideWidthPt,
    slideHeightPt,
    notes,
  };
}

/** Slides in presentation order (`p:sldIdLst`), as zip paths. */
async function slideOrder(zip: JSZip, pres: XNode | undefined): Promise<string[]> {
  const xml = pres ? await readText(zip, 'ppt/_rels/presentation.xml.rels') : undefined;
  if (xml === undefined) return [];
  const rels = rootOf(parseXml(xml, 'ppt/_rels/presentation.xml.rels'));
  const byId = new Map(children(rels, 'Relationship').map((r) => [r.attrs.Id, r.attrs.Target]));
  const out: string[] = [];
  for (const id of children(child(pres, 'p:sldIdLst'), 'p:sldId')) {
    const target = byId.get(id.attrs['r:id']);
    if (target) out.push(resolvePath('ppt', target));
  }
  return out;
}

/** The slides pptx-preview draws, in its order (see `previewOrder`). */
async function previewSlides(zip: JSZip): Promise<string[]> {
  return previewOrder((await readText(zip, '[Content_Types].xml')) ?? '');
}

/**
 * The slides pptx-preview draws, in its order, from `[Content_Types].xml`: the slide parts it lists,
 * sorted by the first number in the part name (stable).
 */
export function previewOrder(contentTypes: string): string[] {
  const parts: { p: string; n: number; i: number }[] = [];
  for (const [start, end] of startTags(contentTypes, 'Override')) {
    const tag = contentTypes.slice(start, end);
    if (
      !/ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.slide\+xml"/.test(tag)
    )
      continue;
    const p = /PartName="\/?([^"]*)"/.exec(tag)?.[1];
    if (p) parts.push({ p, n: Number(/(\d+)/.exec(p)?.[1] ?? 1), i: parts.length });
  }
  return parts.sort((a, b) => a.n - b.n || a.i - b.i).map((x) => x.p);
}

/** Where each drawn slide goes: its place among the presentation's shown slides, or -1. */
async function shownOrder(
  zip: JSZip,
  pres: XNode | undefined,
  drawn: string[],
  signal?: AbortSignal,
): Promise<number[]> {
  const order = await slideOrder(zip, pres);
  if (!order.length || !drawn.length) return [];
  const isDrawn = new Set(drawn);
  const hidden = new Set<string>();
  for (const part of new Set(order)) {
    signal?.throwIfAborted();
    if (!isDrawn.has(part)) continue;
    const head = new TextDecoder().decode((await readBytes(zip, part, 4096, true)) ?? new Uint8Array());
    if (startTags(head, 'p:sld').some(([s, e]) => /\sshow="(0|false)"/.test(head.slice(s, e))))
      hidden.add(part);
  }
  return placeSlides(order, drawn, hidden);
}

/**
 * For each drawn slide, its place among the shown slides of the presentation's `order` (the first, when it
 * is listed twice), or -1 when it is hidden or not in the presentation. Sets and maps: a deck can list
 * tens of thousands of slides.
 */
export function placeSlides(order: string[], drawn: string[], hidden: Set<string>): number[] {
  const isDrawn = new Set(drawn);
  const place = new Map<string, number>();
  let n = 0;
  for (const part of order) {
    if (!isDrawn.has(part) || hidden.has(part)) continue;
    if (!place.has(part)) place.set(part, n);
    n++;
  }
  return drawn.map((part) => place.get(part) ?? -1);
}

async function pictureClips(
  order: string[],
  read: (name: string) => Promise<string | undefined>,
  notes: string[],
): Promise<PictureClip[]> {
  const out: PictureClip[] = [];
  for (let i = 0; i < order.length; i++) {
    const name = order[i]!;
    const xml = await read(name);
    if (!xml || !/prst="(ellipse|roundRect)"/.test(xml)) continue;
    let root: XNode | undefined;
    try {
      root = rootOf(parseXml(xml, name));
    } catch (e) {
      notes.push(`${name}: ${(e as Error).message}`);
      continue;
    }
    for (const pic of children(path(root, 'p:cSld', 'p:spTree'), 'p:pic')) {
      const spPr = child(pic, 'p:spPr');
      const geom = child(spPr, 'a:prstGeom');
      const prst = geom?.attrs.prst;
      if (prst !== 'ellipse' && prst !== 'roundRect') continue;
      const xfrm = child(spPr, 'a:xfrm');
      if (!xfrm || num(xfrm.attrs.rot)) continue;
      const off = child(xfrm, 'a:off');
      const ext = child(xfrm, 'a:ext');
      const pt = (v: string | undefined) => (num(v) ?? 0) / EMU_PER_PT;
      const clip: PictureClip = {
        slide: i,
        x: pt(off?.attrs.x),
        y: pt(off?.attrs.y),
        w: pt(ext?.attrs.cx),
        h: pt(ext?.attrs.cy),
        shape: prst,
      };
      if (prst === 'roundRect') {
        const gd = children(child(geom, 'a:avLst'), 'a:gd').find((g) => g.attrs.name === 'adj');
        const adj = num(/^val\s+(-?\d+)$/.exec(gd?.attrs.fmla ?? '')?.[1]) ?? 16_667;
        clip.radius = (Math.min(clip.w, clip.h) * Math.max(0, Math.min(50_000, adj))) / 100_000;
      }
      out.push(clip);
    }
  }
  return out;
}

/** Picture types pptx-preview loads (by extension), when their part name starts with `image`. */
const PICTURE_EXT = /\.(png|jpe?g|gif|emf|wmf|bmp|tiff?|svg)$/i;

/** A part name or relationship target with its %-escapes decoded; as written when they are malformed. */
function decodePart(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * pptx-preview loads only media parts named `ppt/media/image*`; pictures named otherwise (pptxgenjs writes
 * `Slide-3-image-1.png`) are drawn as nothing, a slide background included. Rename them, and every
 * relationship that points to them.
 */
async function renameMedia(
  zip: JSZip,
  notes: string[],
  read: (name: string) => Promise<string | undefined>,
): Promise<boolean> {
  const renames = new Map<string, string>();
  const taken = new Set<string>();
  for (const name of Object.keys(zip.files)) {
    const m = /^ppt\/media\/([^/]+)$/.exec(name);
    if (!m || m[1]!.startsWith('image') || !PICTURE_EXT.test(name)) continue;
    let to = `ppt/media/image-ordo-${m[1]}`;
    for (let i = 2; zip.file(to) || taken.has(to); i++) to = `ppt/media/image-ordo${i}-${m[1]}`;
    renames.set(name, to);
    taken.add(to);
  }
  // Only what was moved is pointed to.
  for (const [from, to] of renames) if (!(await moveFile(zip, from, to))) renames.delete(from);
  if (!renames.size) return false;
  for (const rels of Object.keys(zip.files).filter((n) => n.endsWith('.rels'))) {
    const xml = await read(rels);
    if (!xml) continue;
    const dir = rels.replace(/_rels\/[^/]+\.rels$/, '').replace(/\/$/, '');
    let hit = false;
    // Replacer functions here and below: a returned string is never read for `$` patterns.
    const next = xml.replace(/(\sTarget=")([^"]*)(")/g, (all, a: string, target: string, b: string) => {
      if (/^[a-z]+:/i.test(target)) return all; // external
      const to = renames.get(resolvePath(dir, decodePart(target)));
      if (!to) return all;
      hit = true;
      return `${a}${target.slice(0, target.lastIndexOf('/') + 1)}${to.slice(to.lastIndexOf('/') + 1)}${b}`;
    });
    if (hit) zip.file(rels, next);
  }
  const types = await readText(zip, '[Content_Types].xml');
  if (types) {
    // One pass over the entries, whatever the number of pictures.
    const next = types.replace(/PartName="\/([^"]*)"/g, (all, part: string) => {
      const to = renames.get(part);
      return to === undefined ? all : `PartName="/${to}"`;
    });
    if (next !== types) zip.file('[Content_Types].xml', next);
  }
  notes.push(`${renames.size} picture(s) renamed for pptx-preview, which loads only media named image*`);
  return true;
}

/**
 * Give a part another name. A part read from the deck keeps its compressed bytes (JSZip's own `loadAsync`
 * adds every part from that same internal object), so a picture moves without being inflated, whatever its
 * size; anything else is read and written again.
 */
async function moveFile(zip: JSZip, from: string, to: string): Promise<boolean> {
  const f = zip.file(from);
  if (!f) return false;
  const internal = f as unknown as { _data?: unknown; _dataBinary?: boolean };
  if (internal._data != null && internal._dataBinary === true) {
    zip.file(to, internal._data as Uint8Array, { binary: true, date: f.date });
  } else {
    const b = await readBytes(zip, from, MAX_PICTURE_BYTES);
    if (!b) return false;
    zip.file(to, b);
  }
  zip.remove(from);
  return true;
}

/**
 * pptx-preview prints a placeholder title ("图表标题", "Chart Title") on every line, bar and area chart
 * without one. PowerPoint shows none when the title was deleted, and the series name when a chart with a
 * single series has an automatic title. Give such charts the title PowerPoint shows, or a blank one.
 *
 * Linear scans only: a lazy regular expression over a whole chart part (`<c:ser>[\s\S]*?<c:tx>...`)
 * backtracks for seconds on a few KB of unclosed series.
 */
async function titleCharts(
  zip: JSZip,
  notes: string[],
  read: (name: string) => Promise<string | undefined>,
): Promise<boolean> {
  let titled = 0;
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/charts\/chart[^/]*\.xml$/.test(name)) continue;
    const xml = await read(name);
    const at = xml?.indexOf(CHART_TAG) ?? -1;
    if (!xml || at < 0) continue;
    // Only the chart's own title counts (the first child of c:chart), not an axis title. A title with no
    // text of its own is automatic: PowerPoint shows the series name for one series, "Chart Title" else.
    const own = ownTitle(xml, at + CHART_TAG.length);
    if (own?.content.includes('<c:tx>')) continue;
    const deleted = /<c:autoTitleDeleted\s+val="(1|true)"/.test(xml);
    const seriesName = countUpTo(xml, '<c:ser>', 1) === 1 ? firstSeriesName(xml) : undefined;
    const text = own ? seriesName || 'Chart Title' : !deleted && seriesName ? seriesName : ' ';
    const tx = `<c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx>`;
    // Spliced by position, never `String.replace` with a string: `$'` in a series name would expand.
    const title = own
      ? `<c:title>${tx}${own.content}</c:title>`
      : `<c:title>${tx}<c:overlay val="0"/></c:title>`;
    const rest = own ? own.end : at + CHART_TAG.length;
    zip.file(name, xml.slice(0, at) + CHART_TAG + title + xml.slice(rest));
    titled++;
  }
  if (titled)
    notes.push(`${titled} chart(s) given the title PowerPoint shows instead of pptx-preview's placeholder`);
  return titled > 0;
}

const CHART_TAG = '<c:chart>';

/**
 * The `c:title` that is the chart's first child (whitespace before it allowed), looked for at `from`, just
 * after `<c:chart>`: its content (empty for `<c:title/>`) and the offset just past it. Undefined when the
 * chart's first child is something else or the title is never closed.
 */
function ownTitle(xml: string, from: number): { content: string; end: number } | undefined {
  let i = from;
  while (i < xml.length && /\s/.test(xml[i]!)) i++;
  const next = xml[i + '<c:title'.length] ?? '';
  if (!xml.startsWith('<c:title', i) || !(next === '/' || next === '>' || /\s/.test(next))) return undefined;
  const gt = xml.indexOf('>', i);
  if (gt < 0) return undefined;
  if (xml[gt - 1] === '/') return { content: '', end: gt + 1 };
  const endTag = xml.indexOf('</c:title>', gt + 1);
  if (endTag < 0) return undefined;
  return { content: xml.slice(gt + 1, endTag), end: endTag + '</c:title>'.length };
}

/**
 * The name of the chart's first series (`c:ser`): the first `<c:v>text</c:v>` in its `c:tx`. The scans are
 * bounded to that series; a series that is never closed has no name.
 */
function firstSeriesName(xml: string): string | undefined {
  const ser = xml.indexOf('<c:ser>');
  if (ser < 0) return undefined;
  const serEnd = xml.indexOf('</c:ser>', ser);
  const tx = xml.indexOf('<c:tx>', ser);
  if (serEnd < 0 || tx < 0 || tx > serEnd) return undefined;
  const txEnd = xml.indexOf('</c:tx>', tx);
  const end = txEnd >= 0 && txEnd < serEnd ? txEnd : serEnd;
  for (let v = xml.indexOf('<c:v>', tx); v >= 0 && v < end; v = xml.indexOf('<c:v>', v + 1)) {
    // Text up to the next tag, which must close the value.
    const lt = xml.indexOf('<', v + 5);
    if (lt >= 0 && lt < end && xml.startsWith('</c:v>', lt)) return xml.slice(v + 5, lt);
  }
  return undefined;
}

/**
 * Drop embedded colour profiles from pictures (JPEG APP2 ICC_PROFILE segments, PNG iCCP chunks). Chromium
 * converts a picture from its profile; LibreOffice, the reference for now, uses the values as sRGB. At most
 * `budget` bytes of pictures are inflated in all (a stripped picture stays in memory until the deck is
 * written); the pictures after that keep their profiles.
 */
export async function stripColorProfiles(
  zip: JSZip,
  notes: string[],
  budget: number,
  signal?: AbortSignal,
): Promise<boolean> {
  let stripped = 0;
  let left = budget;
  let spent = false;
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/media\/[^/]+\.(jpe?g|png)$/i.test(name)) continue;
    signal?.throwIfAborted();
    if (left <= 0) {
      spent = true;
      break;
    }
    // A profile sits before the image data: look for one in the first bytes before reading it all.
    const head = await readBytes(zip, name, Math.min(PROFILE_HEAD_BYTES, left), true);
    left -= head?.length ?? 0;
    const png = /\.png$/i.test(name);
    if (!head || !new TextDecoder('latin1').decode(head).includes(png ? 'iCCP' : 'ICC_PROFILE')) continue;
    const limit = Math.min(MAX_PICTURE_BYTES, left);
    const b = await readBytes(zip, name, limit);
    // A picture past the limit was inflated up to it.
    left -= b?.length ?? limit;
    if (!b) {
      if (limit < MAX_PICTURE_BYTES) spent = true;
      continue;
    }
    const out = png ? withoutIccp(b) : withoutJpegIcc(b);
    if (out) {
      zip.file(name, out);
      stripped++;
    }
  }
  if (stripped) notes.push(`${stripped} picture colour profile(s) removed`);
  if (spent)
    notes.push(
      `colour profiles: pictures past ${Math.round(budget / 1024 / 1024)} MB in all are left as they are`,
    );
  return stripped > 0;
}

/** Segments or chunks read before a picture's image data (a real picture has a few dozen). */
const MAX_PICTURE_HEADERS = 4096;

/** A JPEG without its ICC_PROFILE segments, or undefined when it has none (or is not a JPEG). */
export function withoutJpegIcc(b: Uint8Array): Uint8Array | undefined {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  const keep: [number, number][] = [[0, 2]];
  let at = 2;
  let dropped = false;
  for (let n = 0; at + 4 <= b.length && b[at] === 0xff; n++) {
    if (n >= MAX_PICTURE_HEADERS) return undefined;
    const marker = b[at + 1]!;
    if (marker === 0xda || marker === 0xd9) break; // image data follows: everything from here is kept
    const len = (b[at + 2]! << 8) | b[at + 3]!;
    if (len < 2 || at + 2 + len > b.length) return undefined;
    const icc =
      marker === 0xe2 &&
      len >= 14 &&
      String.fromCharCode(...b.subarray(at + 4, at + 15)) === 'ICC_PROFILE' &&
      b[at + 15] === 0;
    if (icc) dropped = true;
    else keep.push([at, at + 2 + len]);
    at += 2 + len;
  }
  if (!dropped) return undefined;
  keep.push([at, b.length]);
  return concat(b, keep);
}

/**
 * A PNG without its iCCP chunk, or undefined when it has none (or is not a PNG). The chunk comes before the
 * image data (the PNG specification; decoders ignore one after it), so the walk stops at the first IDAT
 * and everything from there is kept as it is.
 */
export function withoutIccp(b: Uint8Array): Uint8Array | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 8 || sig.some((v, i) => b[i] !== v)) return undefined;
  const keep: [number, number][] = [[0, 8]];
  let at = 8;
  let dropped = false;
  for (let n = 0; at + 12 <= b.length; n++) {
    if (n >= MAX_PICTURE_HEADERS) return undefined;
    const len = ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    if (type === 'IDAT' || type === 'IEND') break;
    const end = at + 12 + len;
    if (end > b.length) return undefined;
    if (type === 'iCCP') dropped = true;
    else keep.push([at, end]);
    at = end;
  }
  if (!dropped) return undefined;
  keep.push([at, b.length]);
  return concat(b, keep);
}

/** The byte ranges `[start, end)` of `b`, joined. */
function concat(b: Uint8Array, ranges: [number, number][]): Uint8Array {
  const out = new Uint8Array(ranges.reduce((n, [s, e]) => n + e - s, 0));
  let o = 0;
  for (const [s, e] of ranges) {
    out.set(b.subarray(s, e), o);
    o += e - s;
  }
  return out;
}

/**
 * Drop `[Content_Types].xml` overrides that name a part the package does not have. pptxgenjs writes one
 * slide-master override per slide but only one master; PowerPoint and LibreOffice ignore the extra
 * entries, pptx-preview opens every listed master and stops drawing (nothing at all) on the first missing
 * one.
 */
async function repairContentTypes(zip: JSZip, notes: string[]): Promise<boolean> {
  const xml = await readText(zip, '[Content_Types].xml');
  if (xml === undefined) return false;
  let dropped = 0;
  let out = '';
  let last = 0;
  for (const [start, end] of startTags(xml, 'Override')) {
    if (xml[end - 2] !== '/') continue; // only empty elements, `<Override .../>`, are dropped
    const part = /PartName="([^"]*)"/.exec(xml.slice(start, end))?.[1];
    if (part === undefined || zip.file(decodePart(part).replace(/^\/+/, ''))) continue;
    out += xml.slice(last, start);
    last = end;
    dropped++;
  }
  if (!dropped) return false;
  zip.file('[Content_Types].xml', out + xml.slice(last));
  notes.push(`[Content_Types].xml: ${dropped} entr${dropped === 1 ? 'y' : 'ies'} for missing parts removed`);
  return true;
}

/** The part a relationship of `type` (the last segment of its Type URI) points to, as a zip path. */
async function relTarget(zip: JSZip, part: string, type: string): Promise<string | undefined> {
  const slash = part.lastIndexOf('/');
  const relsPath = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
  const xml = await readText(zip, relsPath);
  if (xml === undefined) return undefined;
  const root = rootOf(parseXml(xml, relsPath));
  const rel = children(root, 'Relationship').find((r) => (r.attrs.Type ?? '').endsWith(`/${type}`));
  const target = rel?.attrs.Target;
  if (!target || rel?.attrs.TargetMode === 'External') return undefined;
  return resolvePath(part.slice(0, slash), target);
}

function resolvePath(dir: string, target: string): string {
  const parts = target.startsWith('/') ? [] : dir.split('/');
  for (const seg of target.replace(/^\/+/, '').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function readTheme(root: XNode | undefined): Theme {
  const els = child(root, 'a:themeElements');
  const font = (n: XNode | undefined) => ({
    latin: typeface(child(n, 'a:latin')),
    ea: typeface(child(n, 'a:ea')),
  });
  const colors: Record<string, string> = {};
  for (const c of path(els, 'a:clrScheme')?.children ?? []) {
    if (c.name === '#text') continue;
    const srgb = child(c, 'a:srgbClr')?.attrs.val ?? child(c, 'a:sysClr')?.attrs.lastClr;
    if (srgb && /^[0-9a-f]{6}$/i.test(srgb)) colors[c.name.replace(/^a:/, '')] = srgb.toUpperCase();
  }
  return {
    major: font(path(els, 'a:fontScheme', 'a:majorFont')),
    minor: font(path(els, 'a:fontScheme', 'a:minorFont')),
    colors,
    effects: children(path(els, 'a:fmtScheme', 'a:effectStyleLst'), 'a:effectStyle'),
  };
}

function typeface(n: XNode | undefined): string | undefined {
  const t = n?.attrs.typeface?.trim();
  return t ? t : undefined;
}

/**
 * Placeholders of a layout or master tree (groups included), indexed once: every run of a slide looks its
 * placeholder up, and a layout can hold tens of thousands of them.
 */
function placeholdersOf(root: XNode | undefined): Placeholders {
  const out: Placeholders = { byIdx: new Map(), byType: new Map(), byMasterType: new Map() };
  const visit = (n: XNode | undefined) => {
    if (!n) return;
    for (const c of n.children) {
      if (c.name === 'p:sp') {
        const ph = path(c, 'p:nvSpPr', 'p:nvPr', 'p:ph');
        if (!ph) continue;
        const p: Placeholder = {
          type: ph.attrs.type ?? 'obj',
          idx: ph.attrs.idx,
          lstStyle: path(c, 'p:txBody', 'a:lstStyle'),
          bodyPr: path(c, 'p:txBody', 'a:bodyPr'),
          xfrm: path(c, 'p:spPr', 'a:xfrm'),
        };
        // The first of each wins, as a search in document order would find it.
        if (p.idx !== undefined && !out.byIdx.has(p.idx)) out.byIdx.set(p.idx, p);
        if (!out.byType.has(p.type)) out.byType.set(p.type, p);
        const mt = masterType(p.type);
        if (!out.byMasterType.has(mt)) out.byMasterType.set(mt, p);
      } else if (c.name !== '#text') visit(c);
    }
  };
  visit(path(root, 'p:cSld', 'p:spTree'));
  return out;
}

/** The master placeholder type a layout or slide placeholder type falls back to. */
function masterType(type: string): string {
  if (type === 'ctrTitle' || type === 'title') return 'title';
  if (type === 'dt' || type === 'ftr' || type === 'sldNum' || type === 'hdr') return type;
  return 'body';
}

function findLayoutPh(l: Layout | undefined, ph: { type: string; idx?: string }): Placeholder | undefined {
  if (!l) return undefined;
  return (
    (ph.idx !== undefined ? l.placeholders.byIdx.get(ph.idx) : undefined) ??
    l.placeholders.byType.get(ph.type)
  );
}

function findMasterPh(m: Master | undefined, type: string): Placeholder | undefined {
  return m?.placeholders.byMasterType.get(masterType(type));
}

/** A list style's paragraph properties for a level: the level's own, then the list's default. */
function lvlPPr(list: XNode | undefined, lvl: number): XNode[] {
  if (!list) return [];
  const out: XNode[] = [];
  const own = child(list, `a:lvl${lvl + 1}pPr`);
  if (own) out.push(own);
  const dflt = child(list, 'a:defPPr');
  if (dflt) out.push(dflt);
  return out;
}

/**
 * The paragraph-property nodes that apply to a paragraph, nearest first: its own, the shape's list style,
 * the layout's and the master's placeholder, the master's text styles, the presentation's defaults.
 * Computed once per paragraph, for all of its runs.
 */
function paraChain(part: PartCtx, shape: ShapeCtx, para: ParaCtx): XNode[] {
  if (para.chain) return para.chain;
  const { lvl, pPr } = para;
  const out: XNode[] = [];
  if (pPr) out.push(pPr);
  out.push(...lvlPPr(shape.lstStyle, lvl));
  const ph = shape.ph;
  if (ph && part.kind === 'slide') out.push(...lvlPPr(findLayoutPh(part.layout, ph)?.lstStyle, lvl));
  if (ph && part.kind !== 'master') out.push(...lvlPPr(findMasterPh(part.master, ph.type)?.lstStyle, lvl));
  const m = part.master;
  const mt = ph ? masterType(ph.type) : 'other';
  const tx = mt === 'title' ? m?.txStyles.title : mt === 'body' ? m?.txStyles.body : m?.txStyles.other;
  out.push(...lvlPPr(tx, lvl));
  out.push(...lvlPPr(part.defaultTextStyle, lvl));
  para.chain = out;
  return out;
}

/**
 * What a paragraph's runs inherit: for each property, the first value along the run-property defaults
 * (`a:defRPr`) of the paragraph chain. Computed once per paragraph; a run's own properties come first.
 */
function inheritedOf(part: PartCtx, shape: ShapeCtx, para: ParaCtx): Inherited {
  if (para.inherited) return para.inherited;
  const defs: XNode[] = [];
  for (const n of paraChain(part, shape, para)) {
    const d = child(n, 'a:defRPr');
    if (d) defs.push(d);
  }
  const first = (pick: (n: XNode) => string | undefined) => {
    for (const n of defs) {
      const v = pick(n);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  para.inherited = {
    latin: first((n) => typeface(child(n, 'a:latin'))),
    ea: first((n) => typeface(child(n, 'a:ea'))),
    sz: first((n) => n.attrs.sz),
    spc: first((n) => n.attrs.spc),
    baseline: first((n) => n.attrs.baseline),
  };
  return para.inherited;
}

/**
 * `a:spcBef` / `a:spcAft`: the nearest one decides, so an explicit zero overrides an inherited value. A
 * percentage is a share of the font size (LibreOffice's reading; PowerPoint's may be of the line).
 */
function spacing(nodes: XNode[], name: string): Spacing | undefined {
  const s = nodes.map((n) => child(n, name)).find((x) => x);
  if (!s) return undefined;
  const pts = num(child(s, 'a:spcPts')?.attrs.val);
  if (pts !== undefined) return { pt: Math.max(0, Math.min(1584, pts / 100)) };
  const pct = num(child(s, 'a:spcPct')?.attrs.val);
  if (pct !== undefined) return { em: Math.max(0, Math.min(1_320_000, pct)) / 100_000 };
  return undefined;
}

const ALIGNS = new Set(['l', 'ctr', 'r', 'just', 'dist', 'justLow', 'thaiDist']);

function paraStyle(part: PartCtx, shape: ShapeCtx, para: ParaCtx): ParaStyle {
  const st: ParaStyle = {};
  const nodes = paraChain(part, shape, para);
  const algn = nodes.map((n) => n.attrs.algn).find((a) => a !== undefined && ALIGNS.has(a));
  st.align = (algn ?? 'l') as NonNullable<ParaStyle['align']>;
  const bef = spacing(nodes, 'a:spcBef');
  if (bef) st.spcBef = bef;
  const aft = spacing(nodes, 'a:spcAft');
  if (aft) st.spcAft = aft;
  const ln = nodes.map((n) => child(n, 'a:lnSpc')).find((x) => x);
  const pts = num(child(ln, 'a:spcPts')?.attrs.val);
  if (pts !== undefined) {
    st.lnSpcPt = Math.max(0, Math.min(1584, pts / 100));
    return st;
  }
  const pct = num(child(ln, 'a:spcPct')?.attrs.val);
  if (pct !== undefined) st.lnSpcPct = Math.max(0, Math.min(1_320_000, pct));
  return st;
}

const FIT = ['a:normAutofit', 'a:spAutoFit', 'a:noAutofit'] as const;

/** Margins of a text box: its own `a:bodyPr`, then the layout's and master's placeholder, then defaults. */
function bodyStyle(part: PartCtx, shape: ShapeCtx, bodyPr: XNode | undefined): BodyStyle {
  const nodes: XNode[] = [];
  if (bodyPr) nodes.push(bodyPr);
  const ph = shape.ph;
  if (ph && part.kind === 'slide') {
    const l = findLayoutPh(part.layout, ph)?.bodyPr;
    if (l) nodes.push(l);
  }
  if (ph && part.kind !== 'master') {
    const m = findMasterPh(part.master, ph.type)?.bodyPr;
    if (m) nodes.push(m);
  }
  const inset = (attr: string, dflt: number) => {
    for (const n of nodes) {
      const v = num(n.attrs[attr]);
      if (v !== undefined) return Math.max(0, v) / EMU_PER_PT;
    }
    return dflt / EMU_PER_PT;
  };
  const anchorAttr = nodes.map((n) => n.attrs.anchor).find((a) => a !== undefined);
  // The size: the shape's own transform, else its layout's, else its master's placeholder's.
  let xfrm = shape.xfrm;
  if (!xfrm && ph && part.kind === 'slide') xfrm = findLayoutPh(part.layout, ph)?.xfrm;
  if (!xfrm && ph && part.kind !== 'master') xfrm = findMasterPh(part.master, ph.type)?.xfrm;
  const ext = child(xfrm, 'a:ext');
  const cx = num(ext?.attrs.cx);
  const cy = num(ext?.attrs.cy);
  const vert = nodes.map((n) => n.attrs.vert).find((v) => v !== undefined);
  const size =
    !shape.grouped && cx !== undefined && cy !== undefined && cx > 0 && cy > 0 && (!vert || vert === 'horz')
      ? { w: cx / EMU_PER_PT, h: cy / EMU_PER_PT }
      : undefined;
  const anchor = anchorAttr === 'ctr' || anchorAttr === 'b' ? anchorAttr : 't';
  // The nearest body that says how text fits decides; the stored scale is only ever on the shape itself.
  const fit = nodes.map((n) => firstChild(n, FIT)).find((c) => c);
  const fraction = (v: string | undefined, dflt: number) =>
    Math.max(0, Math.min(1, (num(v) ?? dflt) / 100_000));
  const autofit =
    fit?.name === 'a:normAutofit'
      ? {
          fontScale: fraction(fit.attrs.fontScale, 100_000),
          lnSpcReduction: fraction(fit.attrs.lnSpcReduction, 0),
        }
      : undefined;
  return {
    insets: [
      inset('lIns', EMU_INSET_LR),
      inset('tIns', EMU_INSET_TB),
      inset('rIns', EMU_INSET_LR),
      inset('bIns', EMU_INSET_TB),
    ],
    anchor,
    paras: [],
    ...(autofit ? { autofit } : {}),
    ...(size ? { size } : {}),
    ...(vert && vert !== 'horz' ? { vertical: true } : {}),
    ...(shape.prst && !FULL_TEXT_AREA.has(shape.prst) ? { shaped: true } : {}),
  };
}

function resolveFace(face: string | undefined, theme: Theme | undefined): string | undefined {
  if (!face) return undefined;
  if (!face.startsWith('+')) return face;
  const t = theme;
  if (!t) return undefined;
  switch (face) {
    case '+mj-lt':
      return t.major.latin;
    case '+mn-lt':
      return t.minor.latin;
    case '+mj-ea':
      return t.major.ea;
    case '+mn-ea':
      return t.minor.ea;
    default:
      return undefined;
  }
}

/** A run's style: its own properties (`rPr`), then what its paragraph's chain gives it. */
function runStyle(part: PartCtx, shape: ShapeCtx, para: ParaCtx, rPr: XNode | undefined): RunStyle {
  const inh = inheritedOf(part, shape, para);
  const theme = part.master?.theme;
  const st: RunStyle = {};
  // No typeface anywhere: PowerPoint uses the theme's heading font for titles, its body font otherwise.
  const theme0 = shape.ph && masterType(shape.ph.type) === 'title' ? '+mj' : '+mn';
  const latin = resolveFace(typeface(child(rPr, 'a:latin')) ?? inh.latin ?? `${theme0}-lt`, theme);
  if (latin) st.latin = latin;
  const ea = resolveFace(typeface(child(rPr, 'a:ea')) ?? inh.ea ?? `${theme0}-ea`, theme);
  if (ea) st.ea = ea;
  const sz = num(rPr?.attrs.sz ?? inh.sz);
  st.size = Math.max(1, Math.min(4000, (sz ?? 1800) / 100));
  const spc = num(rPr?.attrs.spc ?? inh.spc);
  if (spc) st.spc = Math.max(-4000, Math.min(4000, spc)) / 100;
  const baseline = num(rPr?.attrs.baseline ?? inh.baseline);
  if (baseline) st.baseline = Math.max(-100_000, Math.min(100_000, baseline));
  // The run's own text shadow, then the shadow an unfilled shape casts with its text.
  const own = child(rPr, 'a:effectLst');
  const shadows = [own ? shadowOf(child(own, 'a:outerShdw'), part, undefined) : undefined, shape.shadow];
  const list = shadows.filter((x): x is TextShadow => x !== undefined);
  if (list.length) st.shadows = list;
  return st;
}

/**
 * Walk a part in document order. Every `a:t` adds one entry to `styles`: the style of its run (`a:r` or
 * `a:fld`), or null when it is not in a run. The walk stops (`acc.over`) past `acc.limit` entries.
 */
function walk(
  n: XNode | undefined,
  part: PartCtx,
  shape: ShapeCtx,
  p: ParaCtx | undefined,
  rPr: XNode | null | undefined,
  acc: Acc,
): void {
  if (!n) return;
  for (const c of n.children) {
    if (acc.over) return;
    switch (c.name) {
      case '#text':
        break;
      case 'a:t': {
        if (acc.styles.length >= acc.limit) {
          acc.over = true;
          return;
        }
        if (rPr === undefined || !p) {
          acc.styles.push(null);
          break;
        }
        const st = runStyle(part, shape, p, rPr ?? undefined);
        if (p.index >= 0) st.p = p.index;
        if (shape.body !== undefined) st.b = shape.body;
        acc.styles.push(st);
        break;
      }
      case 'p:sp':
      case 'p:cxnSp': {
        const ctx = shapeCtx(c, part);
        if (shape.grouped) ctx.grouped = true;
        walk(c, part, ctx, undefined, undefined, acc);
        break;
      }
      case 'p:grpSp':
        walk(c, part, { grouped: true }, undefined, undefined, acc);
        break;
      case 'p:graphicFrame':
        walk(c, part, {}, undefined, undefined, acc);
        break;
      case 'p:txBody': {
        // A shape's text box: its margins come from its body properties (table cells have their own).
        const bodyPr = child(c, 'a:bodyPr');
        const inner: ShapeCtx = { ...shape, lstStyle: child(c, 'a:lstStyle') ?? shape.lstStyle, bodyPr };
        if (acc.bodies.length < MAX_BODIES) {
          acc.bodies.push(bodyStyle(part, shape, bodyPr));
          inner.body = acc.bodies.length - 1;
        } else delete inner.body;
        walk(c, part, inner, undefined, undefined, acc);
        break;
      }
      case 'a:txBody':
        walk(
          c,
          part,
          { ...shape, lstStyle: child(c, 'a:lstStyle') ?? shape.lstStyle },
          undefined,
          undefined,
          acc,
        );
        break;
      case 'a:p': {
        const pPr = child(c, 'a:pPr');
        const para: ParaCtx = { lvl: Math.max(0, Math.min(8, num(pPr?.attrs.lvl) ?? 0)), pPr, index: -1 };
        if (acc.paras.length < MAX_PARAS) {
          const ps = paraStyle(part, shape, para);
          ps.end = runStyle(part, shape, para, child(c, 'a:endParaRPr'));
          delete ps.end.shadows;
          acc.paras.push(ps);
          para.index = acc.paras.length - 1;
        }
        // A box whose paragraphs are not all described gets none: the page then matches by markers only.
        const box = shape.body !== undefined ? acc.bodies[shape.body] : undefined;
        if (box) {
          if (para.index >= 0) box.paras.push(para.index);
          else box.paras.length = 0;
        }
        walk(c, part, shape, para, undefined, acc);
        break;
      }
      case 'a:r':
      case 'a:fld':
        walk(c, part, shape, p, child(c, 'a:rPr') ?? null, acc);
        break;
      default:
        walk(c, part, shape, p, rPr, acc);
    }
  }
}

function shapeCtx(sp: XNode, part: PartCtx): ShapeCtx {
  const phNode = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
  const ctx: ShapeCtx = {};
  if (phNode) ctx.ph = { type: phNode.attrs.type ?? 'obj', idx: phNode.attrs.idx };
  const spPr = child(sp, 'p:spPr');
  const xfrm = child(spPr, 'a:xfrm');
  if (xfrm) ctx.xfrm = xfrm;
  const prst = child(spPr, 'a:prstGeom')?.attrs.prst;
  if (prst) ctx.prst = prst;
  // A shape's shadow falls on its text only when the shape itself is not filled.
  const filled =
    !child(spPr, 'a:noFill') &&
    (child(spPr, 'a:solidFill') ||
      child(spPr, 'a:gradFill') ||
      child(spPr, 'a:blipFill') ||
      child(spPr, 'a:pattFill') ||
      (num(path(sp, 'p:style', 'a:fillRef')?.attrs.idx) ?? 0) > 0);
  if (filled) return ctx;
  const effectLst = child(spPr, 'a:effectLst');
  if (effectLst) {
    const s = shadowOf(child(effectLst, 'a:outerShdw'), part, undefined);
    if (s) ctx.shadow = s;
    return ctx;
  }
  const ref = path(sp, 'p:style', 'a:effectRef');
  const idx = num(ref?.attrs.idx) ?? 0;
  const style = idx > 0 ? part.master?.theme.effects[idx - 1] : undefined;
  const s = shadowOf(path(style, 'a:effectLst', 'a:outerShdw'), part, ref);
  if (s) ctx.shadow = s;
  return ctx;
}

function shadowOf(
  sh: XNode | undefined,
  part: PartCtx,
  phColorFrom: XNode | undefined,
): TextShadow | undefined {
  if (!sh) return undefined;
  const dist = (num(sh.attrs.dist) ?? 0) / EMU_PER_PT;
  const dir = ((num(sh.attrs.dir) ?? 0) / 60_000) * (Math.PI / 180);
  const blur = (num(sh.attrs.blurRad) ?? 0) / EMU_PER_PT;
  const color = colorOf(sh, part, phColorFrom) ?? 'rgba(0,0,0,1)';
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { dx: r2(dist * Math.cos(dir)), dy: r2(dist * Math.sin(dir)), blur: r2(blur), color };
}

const PRESET: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  gray: '808080',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
};

const COLORS = ['a:srgbClr', 'a:schemeClr', 'a:prstClr', 'a:sysClr', 'a:scrgbClr'] as const;
/**
 * Colours worked out, by colour element and master: a theme's effect colour is shared by every shape that
 * refers to it, and its modifiers are read once.
 */
const colorCache = new WeakMap<XNode, Map<Master | undefined, string | undefined>>();

/** The CSS colour of the first colour child of `n` (srgb, scheme, preset, system), modifiers applied. */
export function colorOf(n: XNode | undefined, part: PartCtx, phColorFrom?: XNode): string | undefined {
  const c = firstChild(n, COLORS);
  if (!c) return undefined;
  if (c.name === 'a:schemeClr' && c.attrs.val === 'phClr')
    return phColorFrom ? colorOf(phColorFrom, part) : undefined;
  let byMaster = colorCache.get(c);
  if (!byMaster) {
    byMaster = new Map();
    colorCache.set(c, byMaster);
  }
  if (!byMaster.has(part.master)) byMaster.set(part.master, colorValue(c, part.master));
  return byMaster.get(part.master);
}

function colorValue(c: XNode, master: Master | undefined): string | undefined {
  let hex: string | undefined;
  if (c.name === 'a:srgbClr') hex = c.attrs.val;
  else if (c.name === 'a:sysClr') hex = c.attrs.lastClr;
  else if (c.name === 'a:prstClr') hex = PRESET[c.attrs.val ?? ''];
  else if (c.name === 'a:scrgbClr') {
    const ch = (v?: string) => Math.round(Math.max(0, Math.min(1, (num(v) ?? 0) / 100_000)) * 255);
    hex = [c.attrs.r, c.attrs.g, c.attrs.b].map((v) => ch(v).toString(16).padStart(2, '0')).join('');
  } else {
    const val = c.attrs.val ?? '';
    const mapped = master?.clrMap[val] ?? val;
    hex = master?.theme.colors[mapped];
  }
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  let [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex!.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  let alpha = 1;
  for (const m of c.children) {
    const v = (num(m.attrs.val) ?? 100_000) / 100_000;
    if (m.name === 'a:alpha') alpha = v;
    else if (m.name === 'a:shade') [r, g, b] = [r * v, g * v, b * v];
    else if (m.name === 'a:tint')
      [r, g, b] = [r + (1 - r) * (1 - v), g + (1 - g) * (1 - v), b + (1 - b) * (1 - v)];
    else if (m.name === 'a:lumMod' || m.name === 'a:lumOff') {
      const [h, s, l] = rgbToHsl(r, g, b);
      const l2 = m.name === 'a:lumMod' ? l * v : l + v;
      [r, g, b] = hslToRgb(h, s, Math.max(0, Math.min(1, l2)));
    }
  }
  const to255 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return `rgba(${to255(r)},${to255(g)},${to255(b)},${Math.round(alpha * 1000) / 1000})`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
