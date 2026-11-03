import { type ExtractedText, LOGICAL_HEIGHT, LOGICAL_WIDTH } from '@ordo/domain';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import { sanitizeExtracted } from './sanitize.ts';

/** Slides read from one file at most (a sldIdLst can list anything). */
export const PPTX_MAX_SLIDES = 2000;
/** XML element nesting kept; deeper content is dropped (real slides nest a few dozen levels). */
const XML_MAX_DEPTH = 256;
/** Largest slide side OOXML allows (51,206,400 EMU = 56 in). */
const MAX_SLIDE_EMU = 51_206_400;

/** A namespaced XML element as a small tree (order preserved). */
interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

// biome-ignore lint/suspicious/noExplicitAny: fast-xml-parser preserveOrder output is untyped
type Raw = any;

function toNodes(raw: Raw[], depth = 0): XNode[] {
  const out: XNode[] = [];
  if (depth > XML_MAX_DEPTH || !Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    let name = '';
    for (const k of Object.keys(entry)) if (k !== ':@') name = k;
    if (!name || name === '?xml') continue;
    if (name === '#text') {
      out.push({ name, attrs: {}, children: [], text: String(entry['#text'] ?? '') });
      continue;
    }
    const attrs = (entry[':@'] ?? {}) as Record<string, string>;
    out.push({ name, attrs, children: toNodes(entry[name] as Raw[], depth + 1), text: '' });
  }
  return out;
}

function parseXml(xml: string): XNode[] {
  try {
    return toNodes(parser.parse(xml) as Raw[]);
  } catch (e) {
    // A stack overflow in the parser on absurd nesting is reported as a bad file, not a crash.
    if (e instanceof RangeError) throw new Error('PowerPoint XML is nested too deeply');
    throw e;
  }
}

function child(n: XNode | undefined, name: string): XNode | undefined {
  return n?.children.find((c) => c.name === name);
}
function children(n: XNode | undefined, name: string): XNode[] {
  return n ? n.children.filter((c) => c.name === name) : [];
}
function path(n: XNode | undefined, ...names: string[]): XNode | undefined {
  let cur = n;
  for (const nm of names) cur = child(cur, nm);
  return cur;
}
function textOf(n: XNode): string {
  let s = '';
  for (const c of n.children) s += c.name === '#text' ? c.text : textOf(c);
  return s;
}
function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

type Xfrm = { x: number; y: number; cx: number; cy: number; rot: number };

function readXfrm(n: XNode | undefined): Xfrm | undefined {
  if (!n) return undefined;
  const off = child(n, 'a:off');
  const ext = child(n, 'a:ext');
  if (!off || !ext) return undefined;
  return {
    x: num(off.attrs.x) ?? 0,
    y: num(off.attrs.y) ?? 0,
    cx: num(ext.attrs.cx) ?? 0,
    cy: num(ext.attrs.cy) ?? 0,
    rot: (num(n.attrs.rot) ?? 0) / 60000,
  };
}

/** Group transform: maps child coordinates into the parent's space. */
type GroupTx = { ox: number; oy: number; sx: number; sy: number; chx: number; chy: number };
const IDENTITY: GroupTx = { ox: 0, oy: 0, sx: 1, sy: 1, chx: 0, chy: 0 };

function applyTx(x: Xfrm, tx: GroupTx): Xfrm {
  return {
    x: tx.ox + (x.x - tx.chx) * tx.sx,
    y: tx.oy + (x.y - tx.chy) * tx.sy,
    cx: x.cx * tx.sx,
    cy: x.cy * tx.sy,
    rot: x.rot,
  };
}

type Placeholder = { type?: string; idx?: string };

function placeholderOf(sp: XNode): Placeholder | undefined {
  const nv = child(sp, 'p:nvSpPr') ?? child(sp, 'p:nvGraphicFramePr');
  const ph = path(nv, 'p:nvPr', 'p:ph');
  if (!ph) return undefined;
  return { type: ph.attrs.type, idx: ph.attrs.idx };
}

function normType(t: string | undefined): string {
  if (!t) return 'body';
  if (t === 'ctrTitle') return 'title';
  if (t === 'subTitle') return 'body';
  return t;
}

/** Placeholder geometry of a layout or master part. */
type PhIndex = { byIdx: Map<string, Xfrm>; byType: Map<string, Xfrm> };

function indexPlaceholders(tree: XNode[]): PhIndex {
  const idx: PhIndex = { byIdx: new Map(), byType: new Map() };
  const visit = (n: XNode) => {
    if (n.name === 'p:sp') {
      const ph = placeholderOf(n);
      const xf = readXfrm(path(n, 'p:spPr', 'a:xfrm'));
      if (ph && xf) {
        if (ph.idx !== undefined && !idx.byIdx.has(ph.idx)) idx.byIdx.set(ph.idx, xf);
        const t = normType(ph.type);
        if (!idx.byType.has(t)) idx.byType.set(t, xf);
      }
    }
    for (const c of n.children) visit(c);
  };
  for (const n of tree) visit(n);
  return idx;
}

function lookupPh(ph: Placeholder, ...indexes: (PhIndex | undefined)[]): Xfrm | undefined {
  for (const ix of indexes) {
    if (!ix) continue;
    if (ph.idx !== undefined) {
      const x = ix.byIdx.get(ph.idx);
      if (x) return x;
    }
    const t = ix.byType.get(normType(ph.type));
    if (t) return t;
  }
  return undefined;
}

function paragraphText(p: XNode): string {
  let s = '';
  for (const c of p.children) {
    if (c.name === 'a:r' || c.name === 'a:fld') {
      const t = child(c, 'a:t');
      if (t) s += textOf(t);
    } else if (c.name === 'a:br') s += '\n';
  }
  return s;
}

function firstSize(body: XNode): number | undefined {
  let found: number | undefined;
  const visit = (n: XNode) => {
    if (found !== undefined) return;
    if (n.name === 'a:rPr' || n.name === 'a:endParaRPr' || n.name === 'a:defRPr') {
      const sz = num(n.attrs.sz);
      if (sz !== undefined) {
        found = sz;
        return;
      }
    }
    for (const c of n.children) visit(c);
  };
  // Runs first, then end-of-paragraph and list-style defaults.
  for (const p of children(body, 'a:p')) for (const r of children(p, 'a:r')) visit(r);
  if (found === undefined) visit(body);
  return found;
}

function bodyText(body: XNode): string {
  const paras = [...children(body, 'a:p')].map(paragraphText);
  return paras.join('\n').trimEnd();
}

type Rels = Map<string, string>;

function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const base = fromPart.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') base.pop();
    else if (seg && seg !== '.') base.push(seg);
  }
  return base.join('/');
}

function relsPathFor(part: string): string {
  const dir = part.split('/').slice(0, -1).join('/');
  const file = part.split('/').pop()!;
  return `${dir ? dir + '/' : ''}_rels/${file}.rels`;
}

async function readText(zip: JSZip, p: string): Promise<string | undefined> {
  const f = zip.file(p);
  return f ? f.async('string') : undefined;
}

async function readRels(zip: JSZip, part: string): Promise<{ rels: Rels; types: Map<string, string> }> {
  const rels: Rels = new Map();
  const types = new Map<string, string>();
  const xml = await readText(zip, relsPathFor(part));
  if (!xml) return { rels, types };
  const tree = parseXml(xml);
  const root = tree.find((n) => n.name === 'Relationships');
  for (const r of children(root, 'Relationship')) {
    if (!r.attrs.Id || !r.attrs.Target || r.attrs.TargetMode === 'External') continue;
    const target = resolveTarget(part, r.attrs.Target);
    rels.set(r.attrs.Id, target);
    types.set(r.attrs.Id, (r.attrs.Type ?? '').split('/').pop() ?? '');
  }
  return { rels, types };
}

export type PptxText = {
  slideSize: { cx: number; cy: number };
  slides: { index: number; boxes: ExtractedText[] }[];
};

/**
 * Extract each slide's text boxes from a .pptx: paragraphs from `a:t` runs, geometry from `a:xfrm` (falling
 * back to layout/master placeholders), scaled from EMU to the 1920x1080 logical canvas. Slides are ordered
 * by `p:sldIdLst`; `index` is 1-based.
 */
export async function extractPptxText(buf: Uint8Array): Promise<PptxText> {
  const zip = await JSZip.loadAsync(buf);
  const presPart = 'ppt/presentation.xml';
  const presXml = await readText(zip, presPart);
  if (!presXml) throw new Error('not a PowerPoint file: ppt/presentation.xml is missing');
  const pres = parseXml(presXml).find((n) => n.name === 'p:presentation');
  const sz = child(pres, 'p:sldSz');
  const side = (v: number | undefined, def: number) =>
    v !== undefined && v > 0 && v <= MAX_SLIDE_EMU ? v : def;
  const slideSize = { cx: side(num(sz?.attrs.cx), 12192000), cy: side(num(sz?.attrs.cy), 6858000) };
  const { rels } = await readRels(zip, presPart);

  let slideParts: string[] = [];
  for (const id of children(child(pres, 'p:sldIdLst'), 'p:sldId')) {
    const rid = id.attrs['r:id'];
    const t = rid ? rels.get(rid) : undefined;
    if (t) slideParts.push(t);
  }
  if (slideParts.length === 0) {
    slideParts = Object.keys(zip.files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }

  slideParts = slideParts.slice(0, PPTX_MAX_SLIDES);
  const sx = LOGICAL_WIDTH / slideSize.cx;
  const sy = LOGICAL_HEIGHT / slideSize.cy;
  // Font sizes are in hundredths of a point; 1 pt = 12700 EMU; scaled with the slide's height ratio.
  const ptToPx = (12700 * LOGICAL_HEIGHT) / slideSize.cy;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const phCache = new Map<string, PhIndex>();
  const phIndex = async (part: string | undefined): Promise<PhIndex | undefined> => {
    if (!part) return undefined;
    const hit = phCache.get(part);
    if (hit) return hit;
    const xml = await readText(zip, part);
    const ix = xml ? indexPlaceholders(parseXml(xml)) : { byIdx: new Map(), byType: new Map() };
    phCache.set(part, ix);
    return ix;
  };

  const slides: PptxText['slides'] = [];
  for (let i = 0; i < slideParts.length; i++) {
    const part = slideParts[i]!;
    const xml = await readText(zip, part);
    const boxes: ExtractedText[] = [];
    if (!xml) {
      slides.push({ index: i + 1, boxes });
      continue;
    }
    const sr = await readRels(zip, part);
    let layoutPart: string | undefined;
    for (const [rid, t] of sr.types) if (t === 'slideLayout') layoutPart = sr.rels.get(rid);
    let masterPart: string | undefined;
    if (layoutPart) {
      const lr = await readRels(zip, layoutPart);
      for (const [rid, t] of lr.types) if (t === 'slideMaster') masterPart = lr.rels.get(rid);
    }
    const layoutIx = await phIndex(layoutPart);
    const masterIx = await phIndex(masterPart);

    const visit = (n: XNode, tx: GroupTx) => {
      if (n.name === 'p:grpSp') {
        const gx = path(n, 'p:grpSpPr', 'a:xfrm');
        const off = readXfrm(gx);
        const chOff = child(gx, 'a:chOff');
        const chExt = child(gx, 'a:chExt');
        let inner = tx;
        if (off && chOff && chExt) {
          const outer = applyTx(off, tx);
          const chx = num(chOff.attrs.x) ?? 0;
          const chy = num(chOff.attrs.y) ?? 0;
          const ccx = num(chExt.attrs.cx) || off.cx || 1;
          const ccy = num(chExt.attrs.cy) || off.cy || 1;
          inner = { ox: outer.x, oy: outer.y, sx: outer.cx / ccx, sy: outer.cy / ccy, chx, chy };
        }
        for (const c of n.children) visit(c, inner);
        return;
      }
      if (n.name === 'p:sp' || n.name === 'p:graphicFrame') {
        let body: XNode | undefined;
        if (n.name === 'p:sp') body = child(n, 'p:txBody');
        let text = '';
        let szHundredths: number | undefined;
        if (body) {
          text = bodyText(body);
          szHundredths = firstSize(body);
        } else {
          // Tables: every cell's paragraphs, row by row.
          const lines: string[] = [];
          const collect = (m: XNode) => {
            if (m.name === 'a:txBody') {
              const t = bodyText(m);
              if (t.trim()) lines.push(t);
              szHundredths ??= firstSize(m);
              return;
            }
            for (const c of m.children) collect(c);
          };
          collect(n);
          text = lines.join('\n');
        }
        if (!text.trim()) return;
        let xf = readXfrm(n.name === 'p:sp' ? path(n, 'p:spPr', 'a:xfrm') : child(n, 'p:xfrm'));
        if (!xf) {
          const ph = placeholderOf(n);
          if (ph) xf = lookupPh(ph, layoutIx, masterIx);
        }
        const g = xf ? applyTx(xf, tx) : { x: 0, y: 0, cx: slideSize.cx, cy: slideSize.cy, rot: 0 };
        const et: ExtractedText = {
          text,
          box: { x: r2(g.x * sx), y: r2(g.y * sy), w: r2(g.cx * sx), h: r2(g.cy * sy), rotation: g.rot },
        };
        if (szHundredths !== undefined) et.fontSizePx = r2((szHundredths / 100) * ptToPx);
        boxes.push(sanitizeExtracted(et));
        return;
      }
      for (const c of n.children) visit(c, tx);
    };
    const sld = parseXml(xml).find((n) => n.name === 'p:sld');
    const tree = path(sld, 'p:cSld', 'p:spTree');
    if (tree) for (const c of tree.children) visit(c, IDENTITY);
    slides.push({ index: i + 1, boxes });
  }
  return { slideSize, slides };
}
