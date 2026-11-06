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
  /**
   * A gradient text fill (`a:gradFill` in the run's properties, or inherited), as a CSS gradient over the
   * run's text box. pptx-preview ignores it and draws the text black.
   */
  gradient?: string;
  /** The text colour a list style gives the run (only when the run sets none itself). */
  color?: string;
  /**
   * Hollow text (`a:noFill`): only its outline is drawn (`a:ln`, width in points), or nothing when it has
   * none. pptx-preview fills it black.
   */
  hollow?: { width: number; color?: string };
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
  /**
   * The paragraph's bullet as the nearest bullet setting of its chain decides: `none` when that is
   * `a:buNone` (or nothing sets one), so the bullet pptx-preview merged in from further up is removed; the
   * label of an automatic number (`a:buAutoNum`, counted from `startAt` along the box, as PowerPoint and
   * LibreOffice do; pptx-preview always counts from 1 and knows few formats); `char` for a character
   * bullet, which pptx-preview draws itself. Absent when the paragraph is empty (no bullet is drawn).
   */
  bullet?: { none: true } | { num: string; color?: string } | { char: true; color?: string };
  /**
   * Left margin and first-line indent in points (`marL`, `indent`, inherited): a negative indent hangs the
   * bullet or number in the margin, the text of every line starting at the margin. pptx-preview puts every
   * line at the margin plus the indent.
   */
  marL?: number;
  indent?: number;
  /**
   * The margins in points (left, top, right, bottom) of the table cell the paragraph is in (`a:tcPr`
   * `marL`/`marT`/`marR`/`marB`, PowerPoint's defaults when unset): pptx-preview rounds them down, takes
   * a point off left and right, and uses 5 and 3 points when they are unset.
   */
  cell?: [number, number, number, number];
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
   * Lines do not wrap (`wrap="none"`): the box grows sideways from its paragraphs' alignment. pptx-preview
   * wraps them at the box's width.
   */
  nowrap?: boolean;
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
  shape: 'ellipse' | 'roundRect' | 'path';
  /** Corner radius in points (roundRect). */
  radius?: number;
  /** The outline (`path`: a custom geometry), as SVG path data in points from the picture's corner. */
  d?: string;
};

/** Insets of a rectangle, as fractions of its size (`a:fillRect`, `a:srcRect` give thousandths of a percent). */
export type Insets = { l: number; t: number; r: number; b: number };

/**
 * A slide's background picture as PowerPoint places it (`p:bg/p:bgPr/a:blipFill` of the slide, else of its
 * layout, else of its master, the first that has a background, as pptx-preview looks it up). pptx-preview
 * stretches it over its fill rectangle (or, with a fill rectangle, draws it at its own size: its size has no
 * units), ignoring the crop and the tiling. Lengths are fractions of the slide's width (x) and height (y).
 */
export type BackgroundFill = {
  /** The slide's position among the slides pptx-preview draws (0 = first). */
  slide: number;
  /** Stretched: the rectangle the picture fills (`a:stretch/a:fillRect`), as insets of the slide. */
  rect?: Insets;
  /** Stretched: the part of the picture shown (`a:srcRect`), as insets of the picture. */
  crop?: Insets;
  /**
   * Tiled (`a:tile`): one tile's size (the picture's own size at its resolution, scaled by sx/sy), where one
   * tile's corner lies (alignment plus offset), and the mirroring of every other tile.
   */
  tile?: { w: number; h: number; x: number; y: number; flip: 'none' | 'x' | 'y' | 'xy' };
};
export type HiddenMasterShapes = { slide: number; layout: boolean };

const HIDES_MASTER_SHAPES = /^<p:(sld|sldLayout)\b[^>]*\sshowMasterSp="(0|false)"/;

/** The start tag of a part's root element (after the XML declaration and comments). */
function rootTag(xml: string): string {
  return /<p:[A-Za-z]+\b[^>]*>/.exec(xml)?.[0] ?? '';
}

/**
 * pptx-preview draws the shapes of a slide's master and layout under every slide, ignoring
 * `showMasterSp="0"` ("hide background graphics"): on a slide with its own full-slide picture, the
 * master's frame and ornaments are drawn over it. Lists the slides that hide them, for the page.
 */
async function masterShapesHidden(
  zip: JSZip,
  order: string[],
  read: (name: string) => Promise<string | undefined>,
): Promise<HiddenMasterShapes[]> {
  const out: HiddenMasterShapes[] = [];
  const layouts = new Map<string, boolean>();
  for (let i = 0; i < order.length; i++) {
    const xml = await read(order[i]!);
    if (xml === undefined) continue;
    if (HIDES_MASTER_SHAPES.test(rootTag(xml))) {
      out.push({ slide: i, layout: true });
      continue;
    }
    const layout = await relTarget(zip, order[i]!, 'slideLayout');
    if (!layout) continue;
    let hides = layouts.get(layout);
    if (hides === undefined) {
      hides = HIDES_MASTER_SHAPES.test(rootTag((await read(layout)) ?? ''));
      layouts.set(layout, hides);
    }
    if (hides) out.push({ slide: i, layout: false });
  }
  return out;
}

/** Most points of a custom outline a picture is clipped to. */
const MAX_PATH_POINTS = 4096;

/**
 * A custom geometry (`a:custGeom`) as SVG path data in points from the shape's corner, for a box of
 * `w` x `h` points; undefined when it uses what this does not draw (arcs, guide names) or is too long.
 */
export function custPath(geom: XNode | undefined, w: number, h: number): string | undefined {
  const paths = children(child(geom, 'a:pathLst'), 'a:path');
  if (!paths.length) return undefined;
  let d = '';
  let points = 0;
  for (const p of paths) {
    const pw = num(p.attrs.w);
    const ph = num(p.attrs.h);
    // A path without its own size is in the shape's EMU.
    const sx = pw ? w / pw : 1 / EMU_PER_PT;
    const sy = ph ? h / ph : 1 / EMU_PER_PT;
    for (const seg of p.children) {
      const cmd = { 'a:moveTo': 'M', 'a:lnTo': 'L', 'a:cubicBezTo': 'C', 'a:quadBezTo': 'Q', 'a:close': 'Z' }[
        seg.name
      ];
      if (!cmd) return undefined;
      d += cmd;
      for (const pt of children(seg, 'a:pt')) {
        const x = Number(pt.attrs.x);
        const y = Number(pt.attrs.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || ++points > MAX_PATH_POINTS) return undefined;
        d += `${+(x * sx).toFixed(2)} ${+(y * sy).toFixed(2)} `;
      }
    }
  }
  return d.trim() || undefined;
}

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
  /** Slide background pictures tiled, cropped or placed in a fill rectangle. */
  backgrounds: BackgroundFill[];
  /**
   * Slides (positions among those pptx-preview draws) that hide the shapes of their master and layout
   * (`showMasterSp="0"` on the slide, `layout` true) or of their master only (on the layout).
   */
  hiddenMasterShapes: HiddenMasterShapes[];
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
  /** The automatic numbers of the text box being walked. */
  numbering?: Numbering;
  /** The table cell being walked: its margins in points (see `ParaStyle.cell`). */
  cell?: [number, number, number, number];
};

/**
 * A paragraph being walked: its level and properties, its index in the paragraph table (-1 when it is not
 * described), and, computed on first use and shared by its runs, its property chain and what runs inherit.
 */
type ParaCtx = {
  lvl: number;
  pPr?: XNode;
  index: number;
  chain?: XNode[];
  /** How many of `chain`'s nodes come before the master's text styles (the paragraph's and shape's own). */
  local?: number;
  inherited?: Inherited;
};

/** Run properties a paragraph's runs inherit (the first value along its chain), as written. */
type Inherited = {
  latin?: string;
  ea?: string;
  sz?: string;
  spc?: string;
  baseline?: string;
  /** The nearest fill a list style gives text (`a:solidFill`, `a:gradFill`, `a:noFill`...). */
  fill?: XNode;
  /** `fill` comes from the paragraph, the shape's list style or its placeholders', not the master's styles. */
  localFill?: boolean;
  /** The nearest text outline (`a:ln`). */
  ln?: XNode;
};

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
  /** The repairs before it (Strict OOXML, group transforms, placeholders) too. */
  const readRepair = reader(MAX_TOTAL_BYTES);
  // First, as everything after reads Transitional names and values.
  let changed = await repairStrict(zip, notes, readRepair);
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
  if (await repairContentTypes(zip, notes)) changed = true;
  if (await applyColorOverrides(zip, notes)) changed = true;
  let full = false;
  /** Text tags walked so far, over every part. */
  let texts = 0;
  const names = Object.keys(zip.files)
    .filter((n) => PART_RE.test(n))
    .sort();
  /** What pptx-preview finds on each layout (see `topPlaceholders`). */
  const layoutTops = new Map<string, { idx: Set<string>; type: Set<string> }>();
  for (const name of names) {
    const xml = await readRepair(name);
    if (xml === undefined) continue;
    let fixed = xml.includes('<p:grpSpPr') ? completeGroupTransforms(xml) : xml;
    if (fixed !== xml) notes.push(`${name}: group transforms completed`);
    if (name.startsWith('ppt/slides/') && fixed.includes('<p:ph')) {
      const lp = await relTarget(zip, name, 'slideLayout');
      // Without a layout pptx-preview draws no placeholder at all; there is nothing to match.
      const layout = lp && zip.file(lp) ? await layoutOf(lp) : undefined;
      if (lp && layout) {
        let top = layoutTops.get(lp);
        if (!top) {
          top = topPlaceholders(await parse(lp));
          layoutTops.set(lp, top);
        }
        const r = placeOrphanPlaceholders(
          fixed,
          top,
          (ph) => findLayoutPh(layout, ph)?.xfrm ?? findMasterPh(layout.master, ph.type)?.xfrm,
          { cx: Math.round(slideWidthPt * EMU_PER_PT), cy: Math.round(slideHeightPt * EMU_PER_PT) },
        );
        if (r.placed || r.dropped)
          notes.push(`${name}: placeholders not on the layout: ${r.placed} placed, ${r.dropped} dropped`);
        fixed = r.xml;
      }
    }
    if (fixed !== xml) {
      zip.file(name, fixed);
      changed = true;
    }
  }
  for (const name of names) {
    if (full) break;
    const raw = await read(name);
    if (raw === undefined || !raw.includes('<a:t')) continue;
    let xml = raw;
    let tags = startTags(xml, 'a:t');
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
    const moved = moveGroupOrigins(xml, root);
    if (moved !== xml) {
      xml = moved;
      tags = startTags(xml, 'a:t');
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
    if (last > 0 || xml !== raw) {
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
  // Before the renames: the relationships it adds point to pictures that may be renamed.
  if (await themeBackgrounds(zip, notes, readLater)) changed = true;
  if (await renameMedia(zip, notes, readLater)) changed = true;
  const pictures = await pictureClips(drawn, readLater, notes);
  const backgrounds = await backgroundFills(zip, drawn, readLater, notes, slideWidthPt, slideHeightPt);
  const hiddenMasterShapes = await masterShapesHidden(zip, drawn, readLater);
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
    backgrounds,
    hiddenMasterShapes,
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
    // The relationships namespace's prefix is the deck's choice; `r` is only the usual one.
    const rid = id.attrs['r:id'] ?? Object.entries(id.attrs).find(([k]) => k.endsWith(':id'))?.[1];
    const target = rid === undefined ? undefined : byId.get(rid);
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
    if (!xml || !/prst="(ellipse|roundRect)"|<a:custGeom/.test(xml)) continue;
    let root: XNode | undefined;
    try {
      root = rootOf(parseXml(xml, name));
    } catch (e) {
      notes.push(`${name}: ${(e as Error).message}`);
      continue;
    }
    for (const pic of children(path(root, 'p:cSld', 'p:spTree'), 'p:pic')) {
      const spPr = child(pic, 'p:spPr');
      const cust = child(spPr, 'a:custGeom');
      const geom = child(spPr, 'a:prstGeom');
      const prst = cust ? 'path' : geom?.attrs.prst;
      if (prst !== 'ellipse' && prst !== 'roundRect' && prst !== 'path') continue;
      const xfrm = child(spPr, 'a:xfrm');
      if (!xfrm || num(xfrm.attrs.rot)) continue;
      // A flipped outline would need flipping too; pictures with one are rare.
      if (prst === 'path' && (xfrm.attrs.flipH === '1' || xfrm.attrs.flipV === '1')) continue;
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
      if (prst === 'path') {
        clip.d = custPath(cust, clip.w, clip.h);
        if (!clip.d) continue;
      }
      out.push(clip);
    }
  }
  return out;
}

/** Bytes of a slide, layout or master read to find its background (`p:bg` comes first in `p:cSld`). */
const PART_HEAD_BYTES = 16 * 1024;

/** The start of a part, as text. */
async function partHead(zip: JSZip, name: string): Promise<string | undefined> {
  const b = await readBytes(zip, name, PART_HEAD_BYTES, true);
  return b && new TextDecoder().decode(b);
}

/** The background a part names (`p:cSld/p:bg`): its blip fill, `null` for another fill, undefined for none. */
function backgroundOf(xml: string, name: string): XNode | null | undefined {
  const at = xml.indexOf('<p:bg>');
  if (at < 0) return undefined;
  // Past the part's start read: not known, so not corrected.
  const end = xml.indexOf('</p:bg>', at);
  if (end < 0) return null;
  const bg = rootOf(parseXml(xml.slice(at, end + 7), name));
  const bgPr = child(bg, 'p:bgPr');
  if (child(bg, 'p:bgRef') || child(bgPr, 'a:solidFill') || child(bgPr, 'a:gradFill')) return null;
  return child(bgPr, 'a:blipFill') ?? undefined;
}

/** A relationship's target by id, as a zip path. */
async function relById(
  part: string,
  id: string,
  read: (name: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const slash = part.lastIndexOf('/');
  const relsPath = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
  const xml = await read(relsPath);
  if (xml === undefined) return undefined;
  const rel = children(rootOf(parseXml(xml, relsPath)), 'Relationship').find((r) => r.attrs.Id === id);
  if (!rel?.attrs.Target || rel.attrs.TargetMode === 'External') return undefined;
  return resolvePath(part.slice(0, slash), decodePart(rel.attrs.Target));
}

/** Insets in thousandths of a percent as fractions; undefined when all are zero. */
function insetsOf(n: XNode | undefined): Insets | undefined {
  if (!n) return undefined;
  const f = (k: string) => (num(n.attrs[k]) ?? 0) / 100_000;
  const v = { l: f('l'), t: f('t'), r: f('r'), b: f('b') };
  return v.l || v.t || v.r || v.b ? v : undefined;
}

/**
 * A picture's size in pixels and its resolution (pixels per inch; 96 when it states none), from the header
 * of a PNG, JPEG, GIF or BMP file.
 */
export function pictureSize(b: Uint8Array): { w: number; h: number; dpiX: number; dpiY: number } | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ok = (o: number, n: number) => o >= 0 && o + n <= b.length;
  let dpiX = 96;
  let dpiY = 96;
  if (ok(0, 24) && dv.getUint32(0) === 0x89504e47) {
    const w = dv.getUint32(16);
    const h = dv.getUint32(20);
    for (let o = 8, n = 0; ok(o, 8) && n < MAX_PICTURE_HEADERS; n++) {
      const len = dv.getUint32(o);
      const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
      if (type === 'pHYs' && ok(o + 8, 9) && b[o + 16] === 1) {
        dpiX = Math.round(dv.getUint32(o + 8) * 0.0254) || 96;
        dpiY = Math.round(dv.getUint32(o + 12) * 0.0254) || 96;
      }
      if (type === 'IDAT' || type === 'IEND') break;
      o += 12 + len;
    }
    return w && h ? { w, h, dpiX, dpiY } : undefined;
  }
  if (ok(0, 4) && dv.getUint16(0) === 0xffd8) {
    for (let o = 2, n = 0; ok(o, 4) && b[o] === 0xff && n < MAX_PICTURE_HEADERS; n++) {
      const m = b[o + 1]!;
      const len = dv.getUint16(o + 2);
      if (m === 0xe0 && ok(o + 4, 12) && dv.getUint32(o + 4) === 0x4a464946) {
        const unit = b[o + 11];
        const k = unit === 1 ? 1 : unit === 2 ? 2.54 : 0;
        if (k) {
          dpiX = dv.getUint16(o + 12) * k || 96;
          dpiY = dv.getUint16(o + 14) * k || 96;
        }
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && ok(o + 5, 5)) {
        const h = dv.getUint16(o + 5);
        const w = dv.getUint16(o + 7);
        return w && h ? { w, h, dpiX, dpiY } : undefined;
      }
      o += 2 + len;
    }
    return undefined;
  }
  if (ok(0, 10) && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const w = dv.getUint16(6, true);
    const h = dv.getUint16(8, true);
    return w && h ? { w, h, dpiX, dpiY } : undefined;
  }
  if (ok(0, 46) && b[0] === 0x42 && b[1] === 0x4d) {
    const w = Math.abs(dv.getInt32(18, true));
    const h = Math.abs(dv.getInt32(22, true));
    dpiX = Math.round(dv.getInt32(38, true) * 0.0254) || 96;
    dpiY = Math.round(dv.getInt32(42, true) * 0.0254) || 96;
    return w && h ? { w, h, dpiX, dpiY } : undefined;
  }
  return undefined;
}

/** Bytes of a picture's header read for its size (a JPEG's frame header follows its metadata). */
const PICTURE_HEAD_BYTES = 256 * 1024;

/**
 * For each drawn slide whose background picture pptx-preview places wrongly (tiled, cropped, or in a fill
 * rectangle), where PowerPoint places it.
 */
async function backgroundFills(
  zip: JSZip,
  order: string[],
  read: (name: string) => Promise<string | undefined>,
  notes: string[],
  slideW: number,
  slideH: number,
): Promise<BackgroundFill[]> {
  const out: BackgroundFill[] = [];
  /** A part's own background, with the part its relationships belong to. */
  const own = new Map<string, Promise<{ fill: XNode | null; part: string } | undefined>>();
  const ownOf = (part: string) => {
    let p = own.get(part);
    if (!p) {
      p = (async () => {
        const xml = await partHead(zip, part);
        if (!xml?.includes('<p:bg>')) return undefined;
        const fill = backgroundOf(xml, part);
        return fill === undefined ? undefined : { fill, part };
      })();
      own.set(part, p);
    }
    return p;
  };
  const up = new Map<string, Promise<string | undefined>>();
  const upOf = (part: string, type: string) => {
    let p = up.get(part);
    if (!p) {
      p = relTarget(zip, part, type);
      up.set(part, p);
    }
    return p;
  };
  const sizes = new Map<string, ReturnType<typeof pictureSize>>();
  for (let i = 0; i < order.length; i++) {
    try {
      let part: string | undefined = order[i]!;
      let found: { fill: XNode | null; part: string } | undefined;
      for (const type of ['slideLayout', 'slideMaster', '']) {
        found = await ownOf(part);
        if (found || !type) break;
        part = type === 'slideLayout' ? await relTarget(zip, part, type) : await upOf(part, type);
        if (!part) break;
      }
      const fill = found?.fill;
      if (!found || !fill) continue;
      const bg: BackgroundFill = { slide: i };
      const tile = child(fill, 'a:tile');
      if (tile) {
        const id = path(fill, 'a:blip')?.attrs['r:embed'];
        const media = id ? await relById(found.part, id, read) : undefined;
        if (!media) continue;
        if (!sizes.has(media)) {
          const head = await readBytes(zip, media, PICTURE_HEAD_BYTES, true);
          sizes.set(media, head && pictureSize(head));
        }
        const size = sizes.get(media);
        if (!size) continue;
        const a = tile.attrs;
        // The picture's size in points, scaled; then as fractions of the slide.
        const w = ((size.w / size.dpiX) * 72 * (num(a.sx) ?? 100_000)) / 100_000 / slideW;
        const h = ((size.h / size.dpiY) * 72 * (num(a.sy) ?? 100_000)) / 100_000 / slideH;
        if (!(w > 0 && h > 0)) continue;
        // The corner, edge middle or centre a tile is aligned to (tl, t, tr, l, ctr, r, bl, b, br).
        const algn = a.algn ?? 'tl';
        const ax = ['tr', 'r', 'br'].includes(algn)
          ? 1 - w
          : ['t', 'ctr', 'b'].includes(algn)
            ? (1 - w) / 2
            : 0;
        const ay = ['bl', 'b', 'br'].includes(algn)
          ? 1 - h
          : ['l', 'ctr', 'r'].includes(algn)
            ? (1 - h) / 2
            : 0;
        const flip = a.flip === 'x' || a.flip === 'y' || a.flip === 'xy' ? a.flip : 'none';
        bg.tile = {
          w,
          h,
          x: ax + (num(a.tx) ?? 0) / EMU_PER_PT / slideW,
          y: ay + (num(a.ty) ?? 0) / EMU_PER_PT / slideH,
          flip,
        };
      } else {
        const rect = insetsOf(path(fill, 'a:stretch', 'a:fillRect'));
        const crop = insetsOf(child(fill, 'a:srcRect'));
        if (!rect && !crop) continue;
        if (rect) bg.rect = rect;
        if (crop) bg.crop = crop;
      }
      out.push(bg);
    } catch (e) {
      notes.push(`${order[i]} background: ${(e as Error).message}`);
    }
  }
  return out;
}

/** A path from directory `dir` to `to` (both zip paths), as a relationship target. */
function relativePath(dir: string, to: string): string {
  const a = dir.split('/').filter(Boolean);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

/** The top-level fills of a theme's `a:bgFillStyleLst`, as XML. */
function backgroundStyles(theme: string): string[] {
  const at = theme.indexOf('<a:bgFillStyleLst>');
  const end = at < 0 ? -1 : theme.indexOf('</a:bgFillStyleLst>', at);
  if (end < 0) return [];
  const list = theme.slice(at + 18, end);
  const out: string[] = [];
  const re = /<a:(\w+)\b[^>]*?(\/)?>/g;
  for (let m = re.exec(list); m; m = re.exec(list)) {
    if (m[2]) {
      out.push(m[0]);
      continue;
    }
    // A fill does not hold a fill of its own kind.
    const close = list.indexOf(`</a:${m[1]}>`, re.lastIndex);
    if (close < 0) break;
    const stop = close + m[1]!.length + 5;
    out.push(list.slice(m.index, stop));
    re.lastIndex = stop;
  }
  return out;
}

/**
 * A theme fill with its placeholder colour (`phClr`) replaced by `color` (one colour element, as a
 * `p:bgRef` holds it): the placeholder's own changes (tint, shade, ...) follow the colour's. Undefined when
 * `color` is not one colour element.
 */
export function withPlaceholderColor(fill: string, color: string): string | undefined {
  const c =
    /^\s*<a:(scrgbClr|srgbClr|hslClr|sysClr|schemeClr|prstClr)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:\1>)\s*$/.exec(
      color,
    );
  if (!c) return undefined;
  const [, tag, attrs, inner = ''] = c;
  return fill.replace(
    /<a:schemeClr val="phClr"\s*(?:\/>|>([\s\S]*?)<\/a:schemeClr>)/g,
    (_m, own: string | undefined) => `<a:${tag}${attrs}>${inner}${own ?? ''}</a:${tag}>`,
  );
}

/**
 * A background that refers to a picture or gradient fill of its theme (`p:bgRef` idx 1001 and up: the
 * theme's background fill styles, as Office 2007 and 2010 themes use) is drawn by pptx-preview as a plain
 * colour. Writes the fill into the part (`p:bgPr`), a picture with a relationship to the theme's picture, a
 * gradient with the reference's colour in place of the placeholder colour, so pptx-preview draws it.
 */
async function themeBackgrounds(
  zip: JSZip,
  notes: string[],
  read: (name: string) => Promise<string | undefined>,
): Promise<boolean> {
  let changed = false;
  // Most themes have no picture among their background styles: then nothing is read.
  let pictures = false;
  for (const t of Object.keys(zip.files).filter((n) => /^ppt\/theme\/[^/]+\.xml$/.test(n))) {
    const xml = await read(t);
    if (xml && backgroundStyles(xml).some((f) => /^<a:(blipFill|gradFill)\b/.test(f))) pictures = true;
  }
  if (!pictures) return false;
  const themes = new Map<string, Promise<string | undefined>>();
  const themeOf = (master: string) => {
    let t = themes.get(master);
    if (!t) {
      t = relTarget(zip, master, 'theme');
      themes.set(master, t);
    }
    return t;
  };
  for (const name of Object.keys(zip.files).filter((n) => PART_RE.test(n))) {
    try {
      if (!/<p:bgRef[^>]*\sidx="1\d\d\d"/.test((await partHead(zip, name)) ?? '')) continue;
      const xml = await read(name);
      const at = xml?.indexOf('<p:bgRef') ?? -1;
      if (!xml || at < 0) continue;
      const idx = num(/^<p:bgRef[^>]*\sidx="(\d+)"/.exec(xml.slice(at, at + 200))?.[1]);
      if (idx === undefined || idx < 1001) continue;
      let master: string | undefined = name;
      if (name.startsWith('ppt/slides/')) master = await relTarget(zip, name, 'slideLayout');
      if (master && !master.startsWith('ppt/slideMasters/'))
        master = await relTarget(zip, master, 'slideMaster');
      const themePart = master && (await themeOf(master));
      const theme = themePart && (await read(themePart));
      if (!themePart || !theme) continue;
      const fill = backgroundStyles(theme)[idx - 1001];
      const gt = xml.indexOf('>', at);
      const end = gt < 0 || xml[gt - 1] === '/' ? gt : xml.indexOf('</p:bgRef>', gt);
      if (end < 0) continue;
      const stop = end === gt ? gt + 1 : end + 10;
      if (fill?.startsWith('<a:gradFill')) {
        // The gradient's placeholder colour is the reference's colour; without one there is nothing to draw.
        const own = end > gt ? withPlaceholderColor(fill, xml.slice(gt + 1, end)) : undefined;
        if (!own) continue;
        zip.file(name, `${xml.slice(0, at)}<p:bgPr>${own}<a:effectLst/></p:bgPr>${xml.slice(stop)}`);
        changed = true;
        continue;
      }
      if (!fill?.startsWith('<a:blipFill')) continue;
      const id = /\sr:embed="([^"]*)"/.exec(fill)?.[1];
      const media = id ? await relById(themePart, id, read) : undefined;
      if (!media || !zip.file(media)) continue;
      const slash = name.lastIndexOf('/');
      const relsPath = `${name.slice(0, slash)}/_rels/${name.slice(slash + 1)}.rels`;
      const rels =
        (await read(relsPath)) ??
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      let rid = 'rIdOrdoBg';
      for (let i = 2; rels.includes(`Id="${rid}"`); i++) rid = `rIdOrdoBg${i}`;
      const close = rels.lastIndexOf('</Relationships>');
      if (close < 0) continue;
      const rel = `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${relativePath(name.slice(0, slash), media)}"/>`;
      zip.file(relsPath, rels.slice(0, close) + rel + rels.slice(close));
      const own = fill.replace(/\sr:embed="[^"]*"/, () => ` r:embed="${rid}"`);
      zip.file(name, `${xml.slice(0, at)}<p:bgPr>${own}<a:effectLst/></p:bgPr>${xml.slice(stop)}`);
      changed = true;
    } catch (e) {
      notes.push(`${name} theme background: ${(e as Error).message}`);
    }
  }
  return changed;
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

/** The namespace and relationship-type root of Strict OOXML (ISO/IEC 29500 Strict). */
const STRICT = 'http://purl.oclc.org/ooxml/';
const STRICT_URI =
  /http:\/\/purl\.oclc\.org\/ooxml\/(drawingml|presentationml|spreadsheetml|wordprocessingml|officeDocument)\/([A-Za-z0-9/-]+)/g;
/** Strict names that differ in Transitional (the rest only move under `.../2006/`). */
const STRICT_RENAMED: Record<string, string> = {
  'officeDocument/relationships/metadata/thumbnail':
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail',
  'officeDocument/relationships/metadata/core-properties':
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  'officeDocument/relationships/extendedProperties':
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  'officeDocument/relationships/customProperties':
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties',
  'officeDocument/extendedProperties':
    'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  'officeDocument/customProperties':
    'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
};
/** DrawingML and PresentationML parts, whose Strict percentages (`"90%"`) are thousandths in Transitional. */
const PERCENT_PART_RE =
  /^ppt\/(slides|slideLayouts|slideMasters|notesSlides|notesMasters|handoutMasters|theme)\/[^/]+\.xml$/;

/**
 * A part of a Strict OOXML deck in its Transitional form: namespace and relationship-type URIs, and, with
 * `percents`, percentage attributes (`val="90%"` is `val="90000"`). pptx-preview knows only Transitional
 * URIs: in a Strict deck it finds no theme, layout or master and draws no slide at all.
 */
export function strictToTransitional(xml: string, percents: boolean): string {
  let out = xml.replace(STRICT_URI, (_m, area: string, rest: string) => {
    const key = `${area}/${rest}`;
    return STRICT_RENAMED[key] ?? `http://schemas.openxmlformats.org/${area}/2006/${rest}`;
  });
  if (percents)
    out = out.replace(/<[^<>!?]*>/g, (tag) =>
      tag.replace(
        /(\s[\w:.-]+=")(-?\d+(?:\.\d+)?)%"/g,
        (_m, pre: string, n: string) => `${pre}${Math.round(Number(n) * 1000)}"`,
      ),
    );
  return out;
}

/** Rewrite a Strict deck's XML parts, relationships and content types to Transitional (see above). */
async function repairStrict(
  zip: JSZip,
  notes: string[],
  read: (name: string) => Promise<string | undefined>,
): Promise<boolean> {
  const root = (await readText(zip, '_rels/.rels')) ?? '';
  const presRels = (await readText(zip, 'ppt/_rels/presentation.xml.rels')) ?? '';
  if (!root.includes(STRICT) && !presRels.includes(STRICT)) return false;
  let n = 0;
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name]?.dir || !/\.(xml|rels)$/i.test(name)) continue;
    const xml = await read(name);
    if (xml === undefined || !xml.includes(STRICT)) continue;
    zip.file(name, strictToTransitional(xml, PERCENT_PART_RE.test(name)));
    n++;
  }
  notes.push(`Strict OOXML: ${n} part${n === 1 ? '' : 's'} rewritten to Transitional`);
  return n > 0;
}

/**
 * Give every group transform (`p:grpSpPr/a:xfrm`) all four of `a:off`, `a:ext`, `a:chOff` and `a:chExt`.
 * Each is optional; pptx-preview reads all four and stops drawing the deck (no slide at all) on a group
 * without one. A missing offset is the origin (as LibreOffice reads it) and a missing size is the other
 * one, so a group without child extents does not scale its shapes.
 */
export function completeGroupTransforms(xml: string): string {
  let out = '';
  let last = 0;
  /** Where the last group's properties close: a tag before it is inside them (one scan, not one each). */
  let after = 0;
  for (const [start, end] of startTags(xml, 'p:grpSpPr')) {
    if (xml[end - 2] === '/' || start < after) continue;
    const close = xml.indexOf('</p:grpSpPr>', end);
    if (close < 0) break;
    after = close;
    const inner = xml.slice(end, close);
    const tag = startTags(inner, 'a:xfrm')[0];
    if (!tag) continue;
    const xs = end + tag[0];
    const selfClosing = inner[tag[1] - 2] === '/';
    const xclose = selfClosing ? tag[1] : inner.indexOf('</a:xfrm>', tag[1]);
    if (xclose < 0) continue;
    const xe = end + xclose + (selfClosing ? 0 : '</a:xfrm>'.length);
    const span = xml.slice(xs, xe);
    let x: XNode | undefined;
    try {
      x = rootOf(parseXml(span, 'a:xfrm'));
    } catch {
      continue;
    }
    const got = (name: string) => {
      const a = child(x, name)?.attrs;
      return a && Object.keys(a).length ? a : undefined;
    };
    const off = got('a:off');
    const ext = got('a:ext');
    const chOff = got('a:chOff');
    const chExt = got('a:chExt');
    if (off && ext && chOff && chExt) continue;
    const pt = (a: Record<string, string> | undefined, k1: string, k2: string) =>
      `${k1}="${num(a?.[k1]) ?? 0}" ${k2}="${num(a?.[k2]) ?? 0}"`;
    const head = xml.slice(xs, end + tag[1] - (selfClosing ? 2 : 1));
    out +=
      xml.slice(last, xs) +
      `${head}><a:off ${pt(off, 'x', 'y')}/><a:ext ${pt(ext ?? chExt, 'cx', 'cy')}/>` +
      `<a:chOff ${pt(chOff, 'x', 'y')}/><a:chExt ${pt(chExt ?? ext, 'cx', 'cy')}/></a:xfrm>`;
    last = xe;
  }
  return last ? out + xml.slice(last) : xml;
}

/** The placeholders pptx-preview can find on a layout: those directly in its shape tree, by idx and type. */
function topPlaceholders(root: XNode | undefined): { idx: Set<string>; type: Set<string> } {
  const out = { idx: new Set<string>(), type: new Set<string>() };
  for (const sp of children(path(root, 'p:cSld', 'p:spTree'), 'p:sp')) {
    const ph = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
    if (ph?.attrs.idx) out.idx.add(ph.attrs.idx);
    if (ph?.attrs.type) out.type.add(ph.attrs.type);
  }
  return out;
}

/** Placeholders for the date, footer, slide number and header: LibreOffice draws none without a place. */
const FOOTER_TYPES = new Set(['dt', 'ftr', 'sldNum', 'hdr']);

/**
 * A slide placeholder without a position of its own whose layout has no placeholder pptx-preview matches
 * it to (by idx, or by type when it has no idx): pptx-preview stops drawing the deck on it. Give it the
 * position it inherits (the layout's placeholder of its type, else the master's). When nothing places it,
 * drop a date, footer, slide number or header (LibreOffice draws none) and give anything else the whole
 * slide (`slide`, in EMU), so its text is still drawn.
 */
export function placeOrphanPlaceholders(
  xml: string,
  layout: { idx: Set<string>; type: Set<string> },
  inherited: (ph: { type: string; idx?: string }) => XNode | undefined,
  slide: { cx: number; cy: number },
): { xml: string; placed: number; dropped: number } {
  let out = '';
  let last = 0;
  let placed = 0;
  let dropped = 0;
  /** Where the last shape ends: shapes do not nest, so each is scanned once. */
  let after = 0;
  for (const [start, tagEnd] of startTags(xml, 'p:sp')) {
    if (start < after || xml[tagEnd - 2] === '/') continue;
    const close = xml.indexOf('</p:sp>', tagEnd);
    if (close < 0) break;
    const end = close + '</p:sp>'.length;
    after = end;
    const span = xml.slice(start, end);
    if (!span.includes('<p:ph')) continue;
    let sp: XNode | undefined;
    try {
      sp = rootOf(parseXml(span, 'p:sp'));
    } catch {
      continue;
    }
    const ph = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
    const spPr = child(sp, 'p:spPr');
    if (!ph || !spPr || child(spPr, 'a:xfrm')) continue;
    const { idx, type } = ph.attrs;
    if (idx ? layout.idx.has(idx) : !type || layout.type.has(type)) continue;
    let xfrm = inherited({ type: type ?? 'obj', idx });
    let off = child(xfrm, 'a:off')?.attrs;
    let ext = child(xfrm, 'a:ext')?.attrs;
    if (!off || !ext) {
      if (FOOTER_TYPES.has(type ?? '')) {
        out += xml.slice(last, start);
        last = end;
        dropped++;
        continue;
      }
      xfrm = undefined;
      off = { x: '0', y: '0' };
      ext = { cx: String(slide.cx), cy: String(slide.cy) };
    }
    const attrs = Object.entries(xfrm?.attrs ?? {})
      .filter(([k]) => k === 'rot' || k === 'flipH' || k === 'flipV')
      .map(([k, v]) => ` ${k}="${num(v) ?? (v === 'true' ? 1 : 0)}"`)
      .join('');
    const own =
      `<a:xfrm${attrs}><a:off x="${num(off.x) ?? 0}" y="${num(off.y) ?? 0}"/>` +
      `<a:ext cx="${num(ext.cx) ?? 0}" cy="${num(ext.cy) ?? 0}"/></a:xfrm>`;
    const pe = startTags(span, 'p:spPr')[0]![1];
    const fixed =
      span[pe - 2] === '/'
        ? `${span.slice(0, pe - 2).trimEnd()}>${own}</p:spPr>${span.slice(pe)}`
        : span.slice(0, pe) + own + span.slice(pe);
    out += xml.slice(last, start) + fixed;
    last = end;
    placed++;
  }
  return { xml: last ? out + xml.slice(last) : xml, placed, dropped };
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

/** Most layout and master copies made for slides with their own colour mapping. */
const MAX_OVERRIDE_COPIES = 64;
const CT_LAYOUT = 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml';
const CT_MASTER = 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';

function relsOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

/** A start tag's attributes as written (`name="value"` pairs). */
function tagAttrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out.set(m[1]!, m[2]!);
  return out;
}

/** A relationships part with the target of its first relationship of `type` replaced. */
export function retarget(rels: string, type: string, target: string): string {
  for (const [start, end] of startTags(rels, 'Relationship')) {
    const tag = rels.slice(start, end);
    if (!new RegExp(`Type="[^"]*/${type}"`).test(tag)) continue;
    return rels.slice(0, start) + tag.replace(/Target="[^"]*"/, `Target="${target}"`) + rels.slice(end);
  }
  return rels;
}

/** The first free `<dir>/<stem><n>.xml` part name. */
function freePart(zip: JSZip, dir: string, stem: string): string {
  for (let n = 1; ; n++) {
    const p = `${dir}/${stem}${n}.xml`;
    if (!zip.file(p)) return p;
  }
}

/**
 * pptx-preview ignores a slide's own colour mapping (`p:clrMapOvr/a:overrideClrMapping`, typically a dark
 * slide in a light deck: bg1 → dk1, tx1 → lt1) and maps every scheme colour through its master's
 * `p:clrMap`: the slide's dark background and light text come out white and black. Each such slide is
 * pointed to a copy of its layout, and of that layout's master with the slide's mapping as its `p:clrMap`,
 * so the slide's own colours, its background and what it inherits resolve as in PowerPoint and LibreOffice.
 */
export async function applyColorOverrides(zip: JSZip, notes: string[]): Promise<boolean> {
  let types = await readText(zip, '[Content_Types].xml');
  if (types === undefined || !types.includes('</Types>')) return false;
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/[^/]+\.xml$/.test(n))
    .sort();
  /** Copies by original part and mapping. */
  const copies = new Map<string, string>();
  let made = 0;
  let changed = false;
  for (const slide of slides) {
    const xml = await readText(zip, slide);
    if (xml === undefined) continue;
    const ovr = /<p:clrMapOvr>\s*(<a:overrideClrMapping\b[^>]*>)/.exec(xml)?.[1];
    if (!ovr) continue;
    const mapping = [...tagAttrs(ovr)].filter(([k]) => !k.includes(':'));
    const layout = await relTarget(zip, slide, 'slideLayout');
    const master = layout && (await relTarget(zip, layout, 'slideMaster'));
    const layoutXml = layout && (await readText(zip, layout));
    const masterXml = master && (await readText(zip, master));
    if (!layout || !master || layoutXml === undefined || masterXml === undefined) continue;
    const clrMap = /<p:clrMap\b[^>]*>/.exec(masterXml);
    if (!clrMap) continue;
    const merged = tagAttrs(clrMap[0]);
    // The master's own mapping (written again, as PowerPoint often does) changes nothing.
    if (mapping.every(([k, v]) => (merged.get(k) ?? k) === v)) continue;
    for (const [k, v] of mapping) merged.set(k, v);
    const key = [...merged].map(([k, v]) => `${k}=${v}`).join(' ');
    let newLayout = copies.get(`${layout}|${key}`);
    if (!newLayout) {
      if (made >= MAX_OVERRIDE_COPIES) {
        notes.push(`${slide}: colour mapping left to its master (more than ${MAX_OVERRIDE_COPIES} copies)`);
        continue;
      }
      let newMaster = copies.get(`${master}|${key}`);
      if (!newMaster) {
        newMaster = freePart(zip, 'ppt/slideMasters', 'slideMaster');
        const attrs = [...merged].map(([k, v]) => ` ${k}="${v}"`).join('');
        let rest = masterXml.slice(clrMap.index + clrMap[0].length);
        const close = rest.indexOf('</p:clrMap>');
        if (!clrMap[0].endsWith('/>') && close >= 0) rest = rest.slice(close + '</p:clrMap>'.length);
        zip.file(newMaster, `${masterXml.slice(0, clrMap.index)}<p:clrMap${attrs}/>${rest}`);
        const mrels = await readText(zip, relsOf(master));
        if (mrels !== undefined) zip.file(relsOf(newMaster), mrels);
        types = types.replace(
          '</Types>',
          `<Override PartName="/${newMaster}" ContentType="${CT_MASTER}"/></Types>`,
        );
        copies.set(`${master}|${key}`, newMaster);
        made++;
      }
      newLayout = freePart(zip, 'ppt/slideLayouts', 'slideLayout');
      zip.file(newLayout, layoutXml);
      const lrels = (await readText(zip, relsOf(layout))) ?? '';
      const masterName = newMaster.slice(newMaster.lastIndexOf('/') + 1);
      zip.file(relsOf(newLayout), retarget(lrels, 'slideMaster', `../slideMasters/${masterName}`));
      types = types.replace(
        '</Types>',
        `<Override PartName="/${newLayout}" ContentType="${CT_LAYOUT}"/></Types>`,
      );
      copies.set(`${layout}|${key}`, newLayout);
      made++;
    }
    const srels = await readText(zip, relsOf(slide));
    if (srels === undefined) continue;
    const layoutName = newLayout.slice(newLayout.lastIndexOf('/') + 1);
    zip.file(relsOf(slide), retarget(srels, 'slideLayout', `../slideLayouts/${layoutName}`));
    changed = true;
  }
  if (changed) zip.file('[Content_Types].xml', types);
  return changed;
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
  para.local = out.length;
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
  let fill: XNode | undefined;
  let localFill = false;
  paraChain(part, shape, para).forEach((n, i) => {
    const d = child(n, 'a:defRPr');
    if (!d) return;
    defs.push(d);
    if (fill) return;
    fill = firstChild(d, FILLS);
    localFill = i < (para.local ?? 0);
  });
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
  const ln = defs.map((n) => child(n, 'a:ln')).find((c) => c);
  if (ln) para.inherited.ln = ln;
  if (fill) {
    para.inherited.fill = fill;
    if (localFill) para.inherited.localFill = true;
  }
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

/**
 * pptx-preview guesses the unit of a grouped shape's offset: an x of at most 20000 in magnitude is taken
 * for twentieths of a point, and the shape's offset and size are read in that unit (`$n`/`Jn` in its
 * source): a text box at the group's origin, common in Google Slides decks, is drawn hundreds of times too
 * large and its text lands off the slide. The group's own child origin (`a:chOff`) is guessed the same way
 * for x and y. Moving a group's child coordinates (its `a:chOff` and its children's `a:off` by the same
 * amount) changes nothing in the picture and takes every value out of the misread range. Returns the part
 * rewritten, or the same string when no group needs it (or the tags cannot be matched to the tree).
 */
export function moveGroupOrigins(xml: string, root: XNode | undefined): string {
  if (!root || !xml.includes('<p:grpSp')) return xml;
  const LIMIT = 20_000;
  const shifts = new Map<XNode, { dx: number; dy: number }>();
  const offOf = (c: XNode): XNode | undefined =>
    c.name === 'p:grpSp'
      ? path(c, 'p:grpSpPr', 'a:xfrm', 'a:off')
      : c.name === 'p:graphicFrame'
        ? path(c, 'p:xfrm', 'a:off')
        : path(c, 'p:spPr', 'a:xfrm', 'a:off');
  const offs: XNode[] = [];
  const visit = (n: XNode) => {
    if (n.name === 'a:off' || n.name === 'a:chOff') offs.push(n);
    if (n.name === 'p:grpSp') {
      const chOff = path(n, 'p:grpSpPr', 'a:xfrm', 'a:chOff');
      const cx = num(chOff?.attrs.x);
      const cy = num(chOff?.attrs.y);
      if (chOff && cx !== undefined && cy !== undefined) {
        const kids = n.children
          .filter((c) => /^p:(sp|pic|cxnSp|grpSp|graphicFrame)$/.test(c.name))
          .map(offOf)
          .filter((o): o is XNode => o !== undefined && num(o.attrs.x) !== undefined);
        const xs = [cx, ...kids.map((o) => num(o.attrs.x)!)];
        const dx = xs.some((x) => Math.abs(x) <= LIMIT) ? LIMIT + 1 - xs.reduce((a, b) => Math.min(a, b)) : 0;
        const dy = Math.abs(cy) <= LIMIT ? LIMIT + 1 - cy : 0;
        if (dx || dy) {
          shifts.set(chOff, { dx, dy });
          for (const o of kids) shifts.set(o, { dx, dy });
        }
      }
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  if (!shifts.size) return xml;
  // The tree's `a:off` and `a:chOff` elements in document order are the part's tags in document order.
  const tags = [...startTags(xml, 'a:off'), ...startTags(xml, 'a:chOff')].sort((a, b) => a[0] - b[0]);
  if (tags.length !== offs.length) return xml;
  let out = '';
  let last = 0;
  tags.forEach(([start, end], i) => {
    const n = offs[i]!;
    const sh = shifts.get(n);
    if (!sh) return;
    const x = num(n.attrs.x);
    const y = num(n.attrs.y);
    let tag = xml.slice(start, end);
    if (x !== undefined && sh.dx) tag = tag.replace(/(\sx=)("|')[^"']*\2/, `$1"${x + sh.dx}"`);
    if (y !== undefined && sh.dy) tag = tag.replace(/(\sy=)("|')[^"']*\2/, `$1"${y + sh.dy}"`);
    out += xml.slice(last, start) + tag;
    last = end;
  });
  return out + xml.slice(last);
}

/** The automatic numbers counted so far in a text box, by level: the format, its start and the last number. */
type Numbering = ({ key: string; n: number } | undefined)[];

const BULLET_COLORS = ['a:buClr', 'a:buClrTx'] as const;

const BULLETS = ['a:buNone', 'a:buChar', 'a:buAutoNum', 'a:buBlip'] as const;

/** Whether a paragraph has any text (an empty one draws no bullet and does not count in a numbering). */
function hasText(p: XNode): boolean {
  return p.children.some(
    (r) => (r.name === 'a:r' || r.name === 'a:fld') && (child(r, 'a:t')?.children.length ?? 0) > 0,
  );
}

/**
 * A paragraph's bullet: the nearest bullet setting along its chain decides. Automatic numbers continue
 * from the box's previous numbered paragraph of the same level and format; a paragraph of that level
 * without one, or a shallower one, ends the sequence.
 */
function bulletOf(
  chain: XNode[],
  lvl: number,
  text: boolean,
  numbering: Numbering | undefined,
): ParaStyle['bullet'] {
  if (!text) return undefined;
  let b: XNode | undefined;
  for (const n of chain) {
    b = firstChild(n, BULLETS);
    if (b) break;
  }
  if (numbering) numbering.length = Math.min(numbering.length, lvl + 1);
  if (!b || b.name === 'a:buNone') {
    if (numbering) numbering[lvl] = undefined;
    return { none: true };
  }
  if (b.name !== 'a:buAutoNum') {
    if (numbering) numbering[lvl] = undefined;
    return { char: true };
  }
  const type = b.attrs.type ?? 'arabicPeriod';
  const start = Math.max(1, Math.min(32_767, num(b.attrs.startAt) ?? 1));
  const key = `${type}:${start}`;
  const prev = numbering?.[lvl];
  const n = prev && prev.key === key ? prev.n + 1 : start;
  if (numbering) numbering[lvl] = { key, n };
  return { num: autoNumber(type, n) };
}

/** The label of automatic number `n` in an OOXML format (`ST_TextAutonumberScheme`). */
export function autoNumber(type: string, n: number): string {
  const m = /^(arabic|romanUc|romanLc|alphaUc|alphaLc)(Period|ParenR|ParenBoth|Plain|Minus)$/.exec(type);
  if (!m) {
    if (type === 'circleNumDbPlain' || type === 'circleNumWdBlackPlain' || type === 'circleNumWdWhitePlain')
      return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n);
    return `${n}.`;
  }
  const [, kind, punct] = m;
  let v: string;
  if (kind === 'arabic') v = String(n);
  else if (kind!.startsWith('roman')) {
    v = roman(n);
    if (kind === 'romanLc') v = v.toLowerCase();
  } else {
    // a..z, then aa..zz, then aaa...: the letter repeated, as PowerPoint and LibreOffice count.
    const letter = String.fromCharCode(97 + ((n - 1) % 26));
    v = letter.repeat(Math.floor((n - 1) / 26) + 1);
    if (kind === 'alphaUc') v = v.toUpperCase();
  }
  switch (punct) {
    case 'Period':
      return `${v}.`;
    case 'ParenR':
      return `${v})`;
    case 'ParenBoth':
      return `(${v})`;
    case 'Minus':
      return `- ${v} -`;
    default:
      return v;
  }
}

function roman(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  const table: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  for (const [v, s] of table)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out;
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
  const wrap = nodes.map((n) => n.attrs.wrap).find((v) => v !== undefined);
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
    ...(wrap === 'none' ? { nowrap: true } : {}),
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
  // The run's own fill decides (a solid fill or none overrides an inherited gradient).
  const ownFill = firstChild(rPr, FILLS);
  const fill = ownFill ?? inh.fill;
  if (fill?.name === 'a:gradFill') {
    const gradient = gradientOf(fill, part);
    if (gradient) st.gradient = gradient;
  }
  // A colour from the shape's own list style (or its placeholders'): pptx-preview reads the master's text
  // styles but not these, and draws such text black.
  if (!ownFill && inh.localFill && fill?.name === 'a:solidFill') {
    const color = colorOf(fill, part);
    if (color) st.color = color;
  }
  if (fill?.name === 'a:noFill') {
    // PowerPoint's default text outline is 0.75 pt; an outline without a solid fill is not drawn.
    const ln = child(rPr, 'a:ln') ?? inh.ln;
    const color = colorOf(child(ln, 'a:solidFill'), part);
    const width = Math.max(0, Math.min(100, (num(ln?.attrs.w) ?? 9525) / EMU_PER_PT));
    st.hollow = color ? { width: Math.round(width * 100) / 100, color } : { width: 0 };
  }
  return st;
}

const FILLS = ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'] as const;

/**
 * A DrawingML gradient as a CSS one. Linear (`a:lin ang`: degrees clockwise from left-to-right, CSS's 0
 * is bottom-to-top); path gradients (`a:path`: circle, rect, shape) radiate from the centre of
 * `a:fillToRect`, stop 0 at the centre, and are drawn as radial gradients. Undefined when no stop has a
 * colour.
 */
function gradientOf(grad: XNode, part: PartCtx): string | undefined {
  const stops: [number, string][] = [];
  for (const gs of child(grad, 'a:gsLst')?.children ?? []) {
    if (gs.name !== 'a:gs' || stops.length >= 16) continue;
    const color = colorOf(gs, part);
    const pos = num(gs.attrs.pos);
    if (color && pos !== undefined) stops.push([Math.max(0, Math.min(100, pos / 1000)), color]);
  }
  if (!stops.length) return undefined;
  stops.sort((a, b) => a[0] - b[0]);
  if (stops.length === 1) stops.push([100, stops[0]![1]]);
  const list = stops.map(([pos, c]) => `${c} ${Math.round(pos * 100) / 100}%`).join(', ');
  const path = child(grad, 'a:path');
  if (path) {
    const r = child(path, 'a:fillToRect');
    const f = (v: string | undefined) => Math.max(-100, Math.min(100, (num(v) ?? 0) / 1000));
    const cx = (f(r?.attrs.l) + (100 - f(r?.attrs.r))) / 2;
    const cy = (f(r?.attrs.t) + (100 - f(r?.attrs.b))) / 2;
    const shape = path.attrs.path === 'circle' ? 'circle' : 'ellipse';
    const at = `${Math.round(cx * 100) / 100}% ${Math.round(cy * 100) / 100}%`;
    return `radial-gradient(${shape} farthest-corner at ${at}, ${list})`;
  }
  const ang = ((num(child(grad, 'a:lin')?.attrs.ang) ?? 0) / 60_000) % 360;
  return `linear-gradient(${Math.round((ang + 90) * 100) / 100}deg, ${list})`;
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
        const inner: ShapeCtx = {
          ...shape,
          lstStyle: child(c, 'a:lstStyle') ?? shape.lstStyle,
          bodyPr,
          numbering: [],
        };
        if (acc.bodies.length < MAX_BODIES) {
          acc.bodies.push(bodyStyle(part, shape, bodyPr));
          inner.body = acc.bodies.length - 1;
        } else delete inner.body;
        walk(c, part, inner, undefined, undefined, acc);
        break;
      }
      case 'a:tc': {
        const tcPr = child(c, 'a:tcPr');
        const mar = (attr: string, dflt: number) =>
          Math.max(0, Math.min(4000, (num(tcPr?.attrs[attr]) ?? dflt) / EMU_PER_PT));
        const cell: [number, number, number, number] = [
          mar('marL', EMU_INSET_LR),
          mar('marT', EMU_INSET_TB),
          mar('marR', EMU_INSET_LR),
          mar('marB', EMU_INSET_TB),
        ];
        walk(c, part, { ...shape, cell }, undefined, undefined, acc);
        break;
      }
      case 'a:txBody':
        walk(
          c,
          part,
          { ...shape, lstStyle: child(c, 'a:lstStyle') ?? shape.lstStyle, numbering: [] },
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
          const chain = paraChain(part, shape, para);
          const bullet = bulletOf(chain, para.lvl, hasText(c), shape.numbering);
          if (bullet && !('none' in bullet)) {
            const clr = chain.map((n) => firstChild(n, BULLET_COLORS)).find((x) => x);
            const color = clr?.name === 'a:buClr' ? colorOf(clr, part) : undefined;
            if (color) bullet.color = color;
          }
          if (bullet) ps.bullet = bullet;
          const pt = (attr: string) => {
            const v = num(chain.map((n) => n.attrs[attr]).find((x) => x !== undefined));
            return v === undefined ? undefined : Math.max(-4000, Math.min(4000, v / EMU_PER_PT));
          };
          const marL = pt('marL');
          const indent = pt('indent');
          if (marL) ps.marL = marL;
          if (indent) ps.indent = indent;
          if (shape.cell) ps.cell = shape.cell;
          ps.end = runStyle(part, shape, para, child(c, 'a:endParaRPr'));
          delete ps.end.shadows;
          delete ps.end.gradient;
          delete ps.end.color;
          delete ps.end.hollow;
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
