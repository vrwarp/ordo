import JSZip from 'jszip';
import { encodeMarker, MAX_MARKED_RUNS } from './markers.ts';
import { child, children, num, parseXml, path, rootOf, type XNode } from './xml.ts';

/**
 * What ordo applies to a rendered run because pptx-preview gets it wrong or ignores it. Only properties
 * this module can resolve from the XML are set; the rest of the run is drawn as pptx-preview draws it.
 */
export type RunStyle = {
  /** The run's Latin typeface, theme references (`+mn-lt`) resolved. */
  latin?: string;
  /** The run's East Asian typeface, theme references resolved. */
  ea?: string;
  /** OOXML baseline shift: thousandths of a percent of the font size (30000 = raised 30 %). */
  baseline?: number;
  /** A shadow drawn behind the glyphs, in points of the slide. */
  shadow?: TextShadow;
  /** The run's paragraph (index into `Annotation.paras`). */
  p?: number;
  /** The run's text box (index into `Annotation.bodies`). */
  b?: number;
};

export type TextShadow = { dx: number; dy: number; blur: number; color: string };

/** Paragraph properties ordo applies to the run's `<p>`. */
export type ParaStyle = {
  /**
   * Line spacing as a percentage of the font's natural line height, in thousandths (100000 = single), the
   * text box's shrink-to-fit reduction already taken off. pptx-preview uses the font size instead.
   */
  lnSpcPct?: number;
  /** Exact line spacing in points. */
  lnSpcPt?: number;
  /** Space before and after the paragraph: points, or a share of a line (100000 = one line). */
  spcBef?: Spacing;
  spcAft?: Spacing;
};

export type Spacing = { pt: number } | { lines: number };

/** Text box properties ordo applies to the run's text wrapper. */
export type BodyStyle = {
  /** Margins in points: left, top, right, bottom (PowerPoint's defaults when the deck sets none). */
  insets: [number, number, number, number];
  /** Where the text sits in the box (`anchor`; PowerPoint's default is the top). */
  anchor: 't' | 'ctr' | 'b';
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
const EMU_PER_PT = 12_700;
const PART_RE = /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/;
/** Every `a:t` start tag, in document order; group 1 is `/` for an empty `<a:t/>`. */
const A_T_RE = /<a:t(?=[\s/>])[^>]*?(\/?)>/g;

type Theme = {
  major: { latin?: string; ea?: string };
  minor: { latin?: string; ea?: string };
  colors: Record<string, string>;
  effects: XNode[];
};

type Placeholder = { type: string; idx?: string; lstStyle?: XNode; bodyPr?: XNode };

type Master = {
  path: string;
  theme: Theme;
  clrMap: Record<string, string>;
  txStyles: { title?: XNode; body?: XNode; other?: XNode };
  placeholders: Placeholder[];
};

type Layout = { path: string; master?: Master; placeholders: Placeholder[] };

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
};

/** What a walk collects: one entry per `a:t`, and the paragraph and text box tables runs point to. */
type Acc = { styles: (RunStyle | null)[]; paras: ParaStyle[]; bodies: BodyStyle[] };

const EMU_INSET_LR = 91_440;
const EMU_INSET_TB = 45_720;

/** Annotate a deck for pptx-preview: mark every text run and say how ordo styles it after rendering. */
export async function annotatePptx(input: Uint8Array): Promise<Annotation> {
  const zip = await JSZip.loadAsync(input);
  const notes: string[] = [];
  const read = async (name: string): Promise<string | undefined> => {
    const f = zip.file(name);
    if (!f) return undefined;
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (size > MAX_PART_BYTES) {
      notes.push(`${name}: larger than ${MAX_PART_BYTES} bytes, not read`);
      return undefined;
    }
    return f.async('string');
  };
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
  const names = Object.keys(zip.files)
    .filter((n) => PART_RE.test(n))
    .sort();
  for (const name of names) {
    if (full) break;
    const xml = await read(name);
    if (xml === undefined || !xml.includes('<a:t')) continue;
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
    const acc: Acc = { styles: [], paras, bodies };
    walk(root, ctx, {}, undefined, undefined, acc);
    const styles = acc.styles;
    const tags = [...xml.matchAll(A_T_RE)];
    if (tags.length !== styles.length) {
      notes.push(`${name}: ${tags.length} text tags but ${styles.length} parsed; left unmarked`);
      continue;
    }
    let out = '';
    let last = 0;
    for (let i = 0; i < tags.length; i++) {
      const m = tags[i]!;
      const st = styles[i];
      if (!st || m[1] === '/') continue;
      if (runs.length >= MAX_MARKED_RUNS) {
        notes.push(`more than ${MAX_MARKED_RUNS} runs; the rest are unmarked`);
        full = true;
        break;
      }
      const end = m.index + m[0].length;
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
  const bytes = changed
    ? await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        compressionOptions: { level: 1 },
      })
    : input;
  return { bytes, runs, paras, bodies, families: [...families].sort(), slideWidthPt, slideHeightPt, notes };
}

/**
 * Drop `[Content_Types].xml` overrides that name a part the package does not have. pptxgenjs writes one
 * slide-master override per slide but only one master; PowerPoint and LibreOffice ignore the extra
 * entries, pptx-preview opens every listed master and stops drawing (nothing at all) on the first missing
 * one.
 */
async function repairContentTypes(zip: JSZip, notes: string[]): Promise<boolean> {
  const f = zip.file('[Content_Types].xml');
  if (!f) return false;
  const xml = await f.async('string');
  let dropped = 0;
  const next = xml.replace(/<Override\b[^>]*?PartName="([^"]*)"[^>]*?\/>/g, (m, part: string) => {
    const name = decodeURIComponent(part).replace(/^\/+/, '');
    if (zip.file(name)) return m;
    dropped++;
    return '';
  });
  if (!dropped) return false;
  zip.file('[Content_Types].xml', next);
  notes.push(`[Content_Types].xml: ${dropped} entr${dropped === 1 ? 'y' : 'ies'} for missing parts removed`);
  return true;
}

/** The part a relationship of `type` (the last segment of its Type URI) points to, as a zip path. */
async function relTarget(zip: JSZip, part: string, type: string): Promise<string | undefined> {
  const slash = part.lastIndexOf('/');
  const relsPath = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
  const f = zip.file(relsPath);
  if (!f) return undefined;
  const xml = await f.async('string');
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

/** Placeholders of a layout or master tree (groups included). */
function placeholdersOf(root: XNode | undefined): Placeholder[] {
  const out: Placeholder[] = [];
  const visit = (n: XNode | undefined) => {
    if (!n) return;
    for (const c of n.children) {
      if (c.name === 'p:sp') {
        const ph = path(c, 'p:nvSpPr', 'p:nvPr', 'p:ph');
        if (ph)
          out.push({
            type: ph.attrs.type ?? 'obj',
            idx: ph.attrs.idx,
            lstStyle: path(c, 'p:txBody', 'a:lstStyle'),
            bodyPr: path(c, 'p:txBody', 'a:bodyPr'),
          });
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
  if (ph.idx !== undefined) {
    const byIdx = l.placeholders.find((p) => p.idx === ph.idx);
    if (byIdx) return byIdx;
  }
  return l.placeholders.find((p) => p.type === ph.type);
}

function findMasterPh(m: Master | undefined, type: string): Placeholder | undefined {
  const want = masterType(type);
  return m?.placeholders.find((p) => masterType(p.type) === want);
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
 */
function paraChain(part: PartCtx, shape: ShapeCtx, lvl: number, pPr: XNode | undefined): XNode[] {
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
  return out;
}

/** The run-property nodes that apply to a run, nearest first (run, then the paragraph chain's defaults). */
function chain(
  part: PartCtx,
  shape: ShapeCtx,
  lvl: number,
  pPr: XNode | undefined,
  rPr: XNode | undefined,
): XNode[] {
  const out: XNode[] = [];
  if (rPr) out.push(rPr);
  for (const n of paraChain(part, shape, lvl, pPr)) {
    const d = child(n, 'a:defRPr');
    if (d) out.push(d);
  }
  return out;
}

/** `a:spcBef` / `a:spcAft`: the nearest one decides, so an explicit zero overrides an inherited value. */
function spacing(nodes: XNode[], name: string): Spacing | undefined {
  const s = nodes.map((n) => child(n, name)).find((x) => x);
  if (!s) return undefined;
  const pts = num(child(s, 'a:spcPts')?.attrs.val);
  if (pts !== undefined) return { pt: Math.max(0, Math.min(1584, pts / 100)) };
  const pct = num(child(s, 'a:spcPct')?.attrs.val);
  if (pct !== undefined) return { lines: Math.max(0, Math.min(1_320_000, pct)) / 100_000 };
  return undefined;
}

function paraStyle(part: PartCtx, shape: ShapeCtx, lvl: number, pPr: XNode | undefined): ParaStyle {
  const st: ParaStyle = {};
  const nodes = paraChain(part, shape, lvl, pPr);
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
  const pct = num(child(ln, 'a:spcPct')?.attrs.val) ?? 100_000;
  // Shrink to fit takes points off the spacing as well as scaling the text.
  const reduction = num(child(shape.bodyPr, 'a:normAutofit')?.attrs.lnSpcReduction) ?? 0;
  st.lnSpcPct = Math.max(0, Math.min(1_320_000, pct - reduction));
  return st;
}

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
  const anchor = anchorAttr === 'ctr' || anchorAttr === 'b' ? anchorAttr : 't';
  return {
    insets: [
      inset('lIns', EMU_INSET_LR),
      inset('tIns', EMU_INSET_TB),
      inset('rIns', EMU_INSET_LR),
      inset('bIns', EMU_INSET_TB),
    ],
    anchor,
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

function runStyle(
  part: PartCtx,
  shape: ShapeCtx,
  lvl: number,
  pPr: XNode | undefined,
  rPr: XNode | undefined,
): RunStyle {
  const nodes = chain(part, shape, lvl, pPr, rPr);
  const theme = part.master?.theme;
  const first = (pick: (n: XNode) => string | undefined) => {
    for (const n of nodes) {
      const v = pick(n);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const st: RunStyle = {};
  // No typeface anywhere: PowerPoint uses the theme's heading font for titles, its body font otherwise.
  const theme0 = shape.ph && masterType(shape.ph.type) === 'title' ? '+mj' : '+mn';
  const latin = resolveFace(first((n) => typeface(child(n, 'a:latin'))) ?? `${theme0}-lt`, theme);
  if (latin) st.latin = latin;
  const ea = resolveFace(first((n) => typeface(child(n, 'a:ea'))) ?? `${theme0}-ea`, theme);
  if (ea) st.ea = ea;
  const baseline = num(first((n) => n.attrs.baseline));
  if (baseline) st.baseline = Math.max(-100_000, Math.min(100_000, baseline));
  const own = child(rPr, 'a:effectLst');
  const runShadow = own ? shadowOf(child(own, 'a:outerShdw'), part, undefined) : undefined;
  const shadow = own ? runShadow : shape.shadow;
  if (shadow) st.shadow = shadow;
  return st;
}

/**
 * Walk a part in document order. Every `a:t` adds one entry to `styles`: the style of its run (`a:r` or
 * `a:fld`), or null when it is not in a run.
 */
function walk(
  n: XNode | undefined,
  part: PartCtx,
  shape: ShapeCtx,
  p: { lvl: number; pPr?: XNode; index: number } | undefined,
  rPr: XNode | null | undefined,
  acc: Acc,
): void {
  if (!n) return;
  for (const c of n.children) {
    switch (c.name) {
      case '#text':
        break;
      case 'a:t': {
        if (rPr === undefined || !p) {
          acc.styles.push(null);
          break;
        }
        const st = runStyle(part, shape, p.lvl, p.pPr, rPr ?? undefined);
        st.p = p.index;
        if (shape.body !== undefined) st.b = shape.body;
        acc.styles.push(st);
        break;
      }
      case 'p:sp':
      case 'p:cxnSp':
        walk(c, part, shapeCtx(c, part), undefined, undefined, acc);
        break;
      case 'p:graphicFrame':
        walk(c, part, {}, undefined, undefined, acc);
        break;
      case 'p:txBody': {
        // A shape's text box: its margins come from its body properties (table cells have their own).
        const bodyPr = child(c, 'a:bodyPr');
        const inner: ShapeCtx = { ...shape, lstStyle: child(c, 'a:lstStyle') ?? shape.lstStyle, bodyPr };
        acc.bodies.push(bodyStyle(part, shape, bodyPr));
        inner.body = acc.bodies.length - 1;
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
        const lvl = Math.max(0, Math.min(8, num(pPr?.attrs.lvl) ?? 0));
        acc.paras.push(paraStyle(part, shape, lvl, pPr));
        walk(c, part, shape, { lvl, pPr, index: acc.paras.length - 1 }, undefined, acc);
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

/** The CSS colour of the first colour child of `n` (srgb, scheme, preset, system), modifiers applied. */
export function colorOf(n: XNode | undefined, part: PartCtx, phColorFrom?: XNode): string | undefined {
  const c = n?.children.find((x) => /^a:(srgbClr|schemeClr|prstClr|sysClr|scrgbClr)$/.test(x.name));
  if (!c) return undefined;
  let hex: string | undefined;
  if (c.name === 'a:srgbClr') hex = c.attrs.val;
  else if (c.name === 'a:sysClr') hex = c.attrs.lastClr;
  else if (c.name === 'a:prstClr') hex = PRESET[c.attrs.val ?? ''];
  else if (c.name === 'a:scrgbClr') {
    const ch = (v?: string) => Math.round(Math.max(0, Math.min(1, (num(v) ?? 0) / 100_000)) * 255);
    hex = [c.attrs.r, c.attrs.g, c.attrs.b].map((v) => ch(v).toString(16).padStart(2, '0')).join('');
  } else {
    const val = c.attrs.val ?? '';
    if (val === 'phClr') return phColorFrom ? colorOf(phColorFrom, part) : undefined;
    const mapped = part.master?.clrMap[val] ?? val;
    hex = part.master?.theme.colors[mapped];
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
