import { type ExtractedText, LOGICAL_HEIGHT, LOGICAL_WIDTH } from '@ordo/domain';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import { IMPORT_LIMITS, sanitizeExtracted } from './sanitize.ts';

/** Slides read from one file at most (a sldIdLst can list anything). */
export const PPTX_MAX_SLIDES = 2000;
/** XML element nesting kept; deeper content is dropped (real slides nest a few dozen levels). */
const XML_MAX_DEPTH = 256;
/** Largest slide side OOXML allows (51,206,400 EMU = 56 in). */
const MAX_SLIDE_EMU = 51_206_400;
/**
 * Largest XML part (slide, layout, master, rels, presentation) inflated, checked against the size the zip
 * declares before inflating and again while inflating (a lying header is caught after this many bytes).
 * Real slide XML is tens of KB; images and media are separate parts and are never read.
 */
export const PPTX_MAX_PART_BYTES = 8 * 1024 * 1024;
/** Total XML inflated from one file, counting every read (a part read twice counts twice). */
export const PPTX_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/**
 * Shapes (`p:sp`, `p:graphicFrame`, `p:grpSp`, `p:pic`, `p:cxnSp`) one slide may hold; counted in the XML
 * text before it is parsed, because parsing is the expensive part (300,000 shapes cost 8 s and 1 GB).
 */
export const PPTX_MAX_SHAPES_PER_SLIDE = 5_000;
/** Markup tags (`<`) one XML part may hold, counted the same way (a dense real slide has a few thousand). */
export const PPTX_MAX_TAGS_PER_PART = 250_000;
/** Text kept per box while walking; more is cut (the box is clipped to IMPORT_LIMITS.text anyway). */
const TEXT_PER_BOX = IMPORT_LIMITS.text + 1;

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

function parseXml(xml: string, part: string): XNode[] {
  if (countUpTo(xml, '<', PPTX_MAX_TAGS_PER_PART) > PPTX_MAX_TAGS_PER_PART)
    throw new Error(
      `This PowerPoint file is not supported: ${part} has more than ${PPTX_MAX_TAGS_PER_PART.toLocaleString('en-US')} XML tags`,
    );
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
/**
 * A short piece of a huge string as its own string: V8 keeps the parent of a slice alive, so a 10,000
 * character piece of an 8 MB text node would otherwise hold the whole node (and the XML) after the parse.
 */
function detach(s: string): string {
  return s.length > 1024 ? (s + ' ').slice(0, -1) : s;
}

/** Text of a node, at most `max` characters (a run can hold megabytes; the box keeps 10,000). */
function textOf(n: XNode, max: number): string {
  let s = '';
  for (const c of n.children) {
    if (s.length >= max) break;
    s += c.name === '#text' ? detach(c.text.slice(0, max - s.length)) : textOf(c, max - s.length);
  }
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

function paragraphText(p: XNode, max: number): string {
  let s = '';
  for (const c of p.children) {
    if (s.length >= max) break;
    if (c.name === 'a:r' || c.name === 'a:fld') {
      const t = child(c, 'a:t');
      if (t) s += textOf(t, max - s.length);
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
  let s = '';
  const paras = children(body, 'a:p');
  for (let i = 0; i < paras.length && s.length < TEXT_PER_BOX; i++) {
    if (i > 0) s += '\n';
    s += paragraphText(paras[i]!, TEXT_PER_BOX - s.length);
  }
  return s.trimEnd();
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

/** The size the zip's central directory declares for an entry (JSZip keeps it on a private field). */
function declaredSize(f: JSZip.JSZipObject): number {
  const data = (f as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : 0;
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/**
 * Reads XML parts from the archive with the size bounds above: the declared size is checked before
 * inflating, the inflated bytes are counted while streaming (a header that lies is stopped at the bound,
 * not after inflating everything) and every read counts against the archive's total.
 */
class Parts {
  private used = 0;
  private readonly rels = new Map<string, { rels: Rels; types: Map<string, string> }>();
  constructor(private readonly zip: JSZip) {}

  private tooBig(part: string, size: number): Error {
    return new SlideTooLarge(
      `This PowerPoint file is not supported: ${part} expands to ${size >= PPTX_MAX_PART_BYTES ? `over ${mb(PPTX_MAX_PART_BYTES)}` : mb(size)} (a slide's XML is normally well under 1 MB)`,
    );
  }
  private tooMuch(): Error {
    return new Error(
      `This PowerPoint file is not supported: its slides expand to more than ${mb(PPTX_MAX_ARCHIVE_BYTES)} of XML`,
    );
  }

  async text(part: string): Promise<string | undefined> {
    const f = this.zip.file(part);
    if (!f) return undefined;
    const declared = declaredSize(f);
    if (declared > PPTX_MAX_PART_BYTES) throw this.tooBig(part, declared);
    if (this.used + declared > PPTX_MAX_ARCHIVE_BYTES) throw this.tooMuch();
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let n = 0;
      let settled = false;
      // JSZip streams an entry in chunks (internalStream is public API, missing from its typings).
      const s = (
        f as unknown as { internalStream(t: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> }
      ).internalStream('uint8array');
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        s.pause();
        reject(e);
      };
      s.on('data', (c: Uint8Array) => {
        if (settled) return;
        n += c.length;
        if (n > PPTX_MAX_PART_BYTES) return fail(this.tooBig(part, n));
        if (this.used + n > PPTX_MAX_ARCHIVE_BYTES) return fail(this.tooMuch());
        chunks.push(c);
      });
      s.on('error', (e: unknown) => fail(e instanceof Error ? e : new Error(String(e))));
      s.on('end', () => {
        if (settled) return;
        settled = true;
        const out = new Uint8Array(n);
        let o = 0;
        for (const c of chunks) {
          out.set(c, o);
          o += c.length;
        }
        resolve(out);
      });
      s.resume();
    });
    this.used += bytes.length;
    return new TextDecoder().decode(bytes);
  }

  async relsOf(part: string): Promise<{ rels: Rels; types: Map<string, string> }> {
    const hit = this.rels.get(part);
    if (hit) return hit;
    const rels: Rels = new Map();
    const types = new Map<string, string>();
    const res = { rels, types };
    this.rels.set(part, res);
    const xml = await this.text(relsPathFor(part));
    if (!xml) return res;
    const tree = parseXml(xml, relsPathFor(part));
    const root = tree.find((n) => n.name === 'Relationships');
    for (const r of children(root, 'Relationship')) {
      if (!r.attrs.Id || !r.attrs.Target || r.attrs.TargetMode === 'External') continue;
      const target = resolveTarget(part, r.attrs.Target);
      rels.set(r.attrs.Id, target);
      types.set(r.attrs.Id, (r.attrs.Type ?? '').split('/').pop() ?? '');
    }
    return res;
  }
}

/** Occurrences of `needle` in `hay`, stopping once `limit` is passed. */
function countUpTo(hay: string, needle: string, limit: number): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0 && n <= limit; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/** Shapes on a slide, counted in its XML text; stops counting past the limit. */
function shapeCount(xml: string): number {
  let n = 0;
  for (const tag of ['<p:sp>', '<p:sp ', '<p:graphicFrame', '<p:grpSp>', '<p:grpSp ', '<p:pic', '<p:cxnSp']) {
    n += countUpTo(xml, tag, PPTX_MAX_SHAPES_PER_SLIDE - n);
    if (n > PPTX_MAX_SHAPES_PER_SLIDE) break;
  }
  return n;
}

export type PptxText = {
  slideSize: { cx: number; cy: number };
  slides: { index: number; boxes: ExtractedText[] }[];
  /** Slides whose text was not read (too large or too many shapes), with why; the others are read. */
  skipped?: { index: number; reason: string }[];
};

/** A slide over the per-slide limits: that slide's text is skipped, not the whole deck's. */
class SlideTooLarge extends Error {}

/**
 * Extract each slide's text boxes from a .pptx: paragraphs from `a:t` runs, geometry from `a:xfrm` (falling
 * back to layout/master placeholders), scaled from EMU to the 1920x1080 logical canvas. Slides are ordered
 * by `p:sldIdLst`; `index` is 1-based.
 */
export async function extractPptxText(buf: Uint8Array): Promise<PptxText> {
  const zip = await JSZip.loadAsync(buf);
  const parts = new Parts(zip);
  const presPart = 'ppt/presentation.xml';
  const presXml = await parts.text(presPart);
  if (!presXml) throw new Error('not a PowerPoint file: ppt/presentation.xml is missing');
  const pres = parseXml(presXml, presPart).find((n) => n.name === 'p:presentation');
  const sz = child(pres, 'p:sldSz');
  const side = (v: number | undefined, def: number) =>
    v !== undefined && v > 0 && v <= MAX_SLIDE_EMU ? v : def;
  const slideSize = { cx: side(num(sz?.attrs.cx), 12192000), cy: side(num(sz?.attrs.cy), 6858000) };
  const { rels } = await parts.relsOf(presPart);

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
    const xml = await parts.text(part);
    const ix = xml ? indexPlaceholders(parseXml(xml, part)) : { byIdx: new Map(), byType: new Map() };
    phCache.set(part, ix);
    return ix;
  };

  const slides: PptxText['slides'] = [];
  const skipped: NonNullable<PptxText['skipped']> = [];
  // A slide list may name one part many times: it is read and walked once.
  const done = new Map<string, ExtractedText[]>();
  for (let i = 0; i < slideParts.length; i++) {
    const part = slideParts[i]!;
    const seen = done.get(part);
    if (seen) {
      slides.push({ index: i + 1, boxes: seen.map((b) => ({ ...b, box: { ...b.box } })) });
      continue;
    }
    // A slide over the per-slide limits (an icon sheet of thousands of vector shapes, common in free
    // template packs) loses its own text, not the deck's; the deck-wide total still stops everything.
    let xml: string | undefined;
    try {
      xml = await parts.text(part);
    } catch (e) {
      if (!(e instanceof SlideTooLarge)) throw e;
      skipped.push({
        index: i + 1,
        reason: e.message.replace(/^This PowerPoint file is not supported: /, ''),
      });
      done.set(part, []);
      slides.push({ index: i + 1, boxes: [] });
      continue;
    }
    const boxes: ExtractedText[] = [];
    if (!xml) {
      slides.push({ index: i + 1, boxes });
      continue;
    }
    if (shapeCount(xml) > PPTX_MAX_SHAPES_PER_SLIDE) {
      skipped.push({
        index: i + 1,
        reason: `slide ${i + 1} has more than ${PPTX_MAX_SHAPES_PER_SLIDE.toLocaleString('en-US')} shapes`,
      });
      done.set(part, []);
      slides.push({ index: i + 1, boxes: [] });
      continue;
    }
    const sr = await parts.relsOf(part);
    let layoutPart: string | undefined;
    for (const [rid, t] of sr.types) if (t === 'slideLayout') layoutPart = sr.rels.get(rid);
    let masterPart: string | undefined;
    if (layoutPart) {
      const lr = await parts.relsOf(layoutPart);
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
          let len = 0;
          const collect = (m: XNode) => {
            if (m.name === 'a:txBody') {
              if (len >= TEXT_PER_BOX) return;
              const t = bodyText(m);
              len += t.length + 1;
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
    const sld = parseXml(xml, part).find((n) => n.name === 'p:sld');
    const tree = path(sld, 'p:cSld', 'p:spTree');
    if (tree) for (const c of tree.children) visit(c, IDENTITY);
    done.set(part, boxes);
    slides.push({ index: i + 1, boxes });
  }
  return { slideSize, slides, ...(skipped.length ? { skipped } : {}) };
}

/** Slide, layout and master parts whose text runs LibreOffice draws. */
const RENDER_PARTS = /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/;
const RUN_PROPS = /<a:(rPr|defRPr|endParaRPr)\b([^>]*?)(\/>|>([\s\S]*?)<\/a:\1>)/g;
const TEXT_OUTLINE = /<a:ln\b[^>]*\/>|<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/g;

/**
 * Prepare a .pptx for LibreOffice's PDF export. LibreOffice cannot draw a coloured outline around filled
 * text (`<a:ln>` in a run's properties): it substitutes its own contour effect, hollow letters without the
 * fill, which with a drop shadow reads as broken text. Filled text loses its outline instead (the fill and
 * shadow stay, as PowerPoint shows them); text that is meant to be hollow (`<a:noFill/>`) keeps it.
 * Returns the input itself when nothing needed changing.
 */
export async function pptxForRendering(buf: Uint8Array): Promise<{ bytes: Uint8Array; outlines: number }> {
  const zip = await JSZip.loadAsync(buf);
  let outlines = 0;
  for (const name of Object.keys(zip.files)) {
    if (!RENDER_PARTS.test(name)) continue;
    const xml = await zip.file(name)!.async('string');
    if (!xml.includes('<a:ln')) continue;
    const next = xml.replace(RUN_PROPS, (m, tag: string, attrs: string, _end, body: string | undefined) => {
      if (body === undefined || !body.includes('<a:ln')) return m;
      const stripped = body.replace(TEXT_OUTLINE, '');
      if (stripped.includes('<a:noFill/>')) return m;
      outlines++;
      return `<a:${tag}${attrs}>${stripped}</a:${tag}>`;
    });
    if (next !== xml) zip.file(name, next);
  }
  if (!outlines) return { bytes: buf, outlines };
  // Unchanged parts keep their compressed bytes (JSZip reuses them when the method matches).
  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 1 },
  });
  return { bytes, outlines };
}
