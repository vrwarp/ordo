/**
 * Inheritance (design/27 §4 "Inheritance"): placeholder matching, the xfrm, bodyPr and shape-property chain,
 * and the paragraph-property chain.
 *
 * - A slide placeholder finds its layout placeholder by idx, else by type; a slide or layout placeholder
 *   finds its master placeholder by type class (ctrTitle and title → title; dt, ftr, sldNum, hdr →
 *   themselves; everything else → body). Placeholders nested in a layout's or master's groups count too.
 * - xfrm, bodyPr and the shape properties (geometry, fill, line, effects) come from own → layout → master.
 * - Paragraph properties come from the paragraph's own pPr, the shape's lstStyle, the layout's and the
 *   master's placeholder lstStyle, the master's txStyles entry (placeholders only) and the presentation's
 *   defaultTextStyle. Non-placeholder text uses defaultTextStyle, never otherStyle (verified in
 *   LibreOffice; `annotate.ts` has it wrong).
 *
 * Owned by work item C (inherit-emit).
 */
import type { SlideCtx, Source } from './context.ts';
import { child, firstChild, path, type XNode } from './xml.ts';

/** A placeholder reference (`p:ph`). OOXML's default type is 'obj' (a body placeholder). */
export interface PhRef {
  type: string;
  idx?: string;
}

/** The `*Pr` holding `p:nvPr` for each shape-tree element. */
const NV: Record<string, string> = Object.assign(Object.create(null), {
  'p:sp': 'p:nvSpPr',
  'p:pic': 'p:nvPicPr',
  'p:graphicFrame': 'p:nvGraphicFramePr',
  'p:grpSp': 'p:nvGrpSpPr',
  'p:cxnSp': 'p:nvCxnSpPr',
});

/** Footer-like placeholders: not drawn when nothing gives them a position (design/27 §4). */
export const FOOTER_TYPES: ReadonlySet<string> = new Set(['dt', 'ftr', 'sldNum', 'hdr']);

/** Bound of an `a:avLst` guide value (design/27 §12). */
const MAX_ADJ = 10_000_000;

/** Group nesting followed when indexing a layout's or master's placeholders. */
const MAX_INDEX_DEPTH = 32;

/** The non-visual properties (`p:nvSpPr`, …) of a shape-tree element. */
export function nvOf(el: XNode): XNode | undefined {
  const name = NV[el.name];
  return name ? child(el, name) : undefined;
}

/** A shape-tree element's placeholder, or undefined. */
export function placeholderOf(el: XNode): PhRef | undefined {
  const ph = path(nvOf(el), 'p:nvPr', 'p:ph');
  if (!ph) return undefined;
  return { type: ph.attrs.type || 'obj', ...(ph.attrs.idx !== undefined ? { idx: ph.attrs.idx } : {}) };
}

/** The master's placeholder class of a type: ctrTitle and title → title; dt/ftr/sldNum/hdr → themselves; else body. */
export function masterClass(type: string): string {
  if (type === 'title' || type === 'ctrTitle') return 'title';
  if (FOOTER_TYPES.has(type)) return type;
  return 'body';
}

/** Whether a placeholder takes the master's titleStyle. */
export function isTitle(ph: PhRef | undefined): boolean {
  return ph !== undefined && masterClass(ph.type) === 'title';
}

/** Whether a placeholder is a date, footer, slide number or header. */
export function isFooter(ph: PhRef | undefined): boolean {
  return ph !== undefined && FOOTER_TYPES.has(ph.type);
}

/** A layout's or master's placeholders, indexed once: the first of each key wins, in document order. */
interface PhIndex {
  byIdx: Map<string, XNode>;
  byType: Map<string, XNode>;
  byClass: Map<string, XNode>;
}

const indexCache = new WeakMap<XNode, PhIndex>();

function indexOf(root: XNode): PhIndex {
  let idx = indexCache.get(root);
  if (idx) return idx;
  idx = { byIdx: new Map(), byType: new Map(), byClass: new Map() };
  const stack: [XNode, number][] = [];
  const tree = path(root, 'p:cSld', 'p:spTree');
  if (tree) stack.push([tree, 0]);
  // Depth-first in document order: children pushed in reverse.
  while (stack.length) {
    const [n, depth] = stack.pop()!;
    if (n !== tree) {
      const ph = NV[n.name] ? placeholderOf(n) : undefined;
      if (ph) {
        if (ph.idx !== undefined && !idx.byIdx.has(ph.idx)) idx.byIdx.set(ph.idx, n);
        if (!idx.byType.has(ph.type)) idx.byType.set(ph.type, n);
        const cls = masterClass(ph.type);
        if (!idx.byClass.has(cls)) idx.byClass.set(cls, n);
        continue;
      }
      if (n.name !== 'p:grpSp' || depth >= MAX_INDEX_DEPTH) continue;
    }
    for (let i = n.children.length - 1; i >= 0; i--) {
      const c = n.children[i]!;
      if (c.name === 'p:grpSp' || NV[c.name]) stack.push([c, depth + 1]);
    }
  }
  indexCache.set(root, idx);
  return idx;
}

/** The layout's placeholder for `ph`: by idx, else by type. */
export function layoutPlaceholder(layout: XNode | undefined, ph: PhRef): XNode | undefined {
  if (!layout) return undefined;
  const idx = indexOf(layout);
  return (ph.idx !== undefined ? idx.byIdx.get(ph.idx) : undefined) ?? idx.byType.get(ph.type);
}

/** The master's placeholder for `ph`: by type class. */
export function masterPlaceholder(master: XNode | undefined, ph: PhRef): XNode | undefined {
  return master ? indexOf(master).byClass.get(masterClass(ph.type)) : undefined;
}

/** An element and the placeholders it inherits from. */
export interface Chain {
  own: XNode;
  from: Source;
  ph?: PhRef;
  /** The matching layout placeholder (for a slide element). */
  layout?: XNode;
  /** The matching master placeholder (for a slide or layout element). */
  master?: XNode;
}

export function chainOf(ctx: SlideCtx, own: XNode, from: Source): Chain {
  const ph = placeholderOf(own);
  if (!ph || from === 'master') return { own, from, ...(ph ? { ph } : {}) };
  const layout = from === 'slide' ? layoutPlaceholder(ctx.layout, ph) : undefined;
  return { own, from, ph, layout, master: masterPlaceholder(ctx.master, ph) };
}

/** The chain's nodes, nearest first. */
export function nodes(c: Chain): XNode[] {
  const out = [c.own];
  if (c.layout) out.push(c.layout);
  if (c.master) out.push(c.master);
  return out;
}

/** The shape properties element of a shape-tree element. */
export function spPrOf(el: XNode): XNode | undefined {
  return child(el, el.name === 'p:grpSp' ? 'p:grpSpPr' : 'p:spPr');
}

/** The shape properties along the chain, nearest first (fill, line, geometry and effects inherit). */
export function spPrChain(c: Chain): XNode[] {
  const out: XNode[] = [];
  for (const n of nodes(c)) {
    const s = spPrOf(n);
    if (s) out.push(s);
  }
  return out;
}

/** Guide values read per preset (real presets have at most 8 adjustments). */
const MAX_GUIDES = 10;
/** Children of an `a:avLst` looked at for those guides (a deck can give it any number of others). */
const MAX_GUIDE_SCAN = 64;

/**
 * A preset name as a deck string that reaches notes and reasons: letters and digits only (every
 * `ST_ShapeType` value is), at most 40 characters; anything else is 'other'.
 */
export function presetName(v: string | undefined): string {
  if (v === undefined) return 'rect';
  return /^[A-Za-z0-9]{1,40}$/.test(v) ? v : 'other';
}

/** The nearest preset or custom geometry along the chain, with its guide values. */
export function geometryOf(c: Chain): { geom: string; adj?: [string, number][] } {
  for (const n of nodes(c)) {
    const spPr = spPrOf(n);
    const prst = child(spPr, 'a:prstGeom');
    if (prst) {
      const adj: [string, number][] = [];
      const gds = child(prst, 'a:avLst')?.children ?? [];
      for (let i = 0; i < gds.length && i < MAX_GUIDE_SCAN && adj.length < MAX_GUIDES; i++) {
        const gd = gds[i]!;
        if (gd.name !== 'a:gd') continue;
        const m = /^val\s+(-?\d+(?:\.\d+)?)$/.exec((gd.attrs.fmla ?? '').slice(0, 40).trim());
        const v = m ? Number(m[1]) : Number.NaN;
        if (gd.attrs.name && Number.isFinite(v))
          adj.push([gd.attrs.name.slice(0, 16), Math.max(-MAX_ADJ, Math.min(MAX_ADJ, v))]);
      }
      const geom = presetName(prst.attrs.prst);
      return adj.length ? { geom, adj } : { geom };
    }
    if (child(spPr, 'a:custGeom')) return { geom: 'custom' };
  }
  return { geom: 'rect' };
}

/** The nearest `p:style` along the chain (the shape's style-matrix references). */
export function styleOf(c: Chain): XNode | undefined {
  return firstChildOf(nodes(c), 'p:style');
}

/** The nearest `a:xfrm` along the chain (own → layout → master). */
export function inheritedXfrm(c: Chain): XNode | undefined {
  for (const n of nodes(c)) {
    const x = child(spPrOf(n), 'a:xfrm') ?? child(n, 'p:xfrm'); // p:xfrm: graphic frames
    if (x) return x;
  }
  return undefined;
}

/** The `a:bodyPr` elements along the chain, nearest first (each attribute: the first that sets it). */
export function bodyPrChain(c: Chain): XNode[] {
  const out: XNode[] = [];
  for (const n of nodes(c)) {
    const b = path(n, 'p:txBody', 'a:bodyPr');
    if (b) out.push(b);
  }
  return out;
}

/** `lvl(N+1)pPr` then `defPPr` of a list style, the ones present. */
export function listLevel(lst: XNode | undefined, level: number): XNode[] {
  const out: XNode[] = [];
  const lvl = child(lst, `a:lvl${Math.min(8, Math.max(0, level)) + 1}pPr`);
  if (lvl) out.push(lvl);
  const def = child(lst, 'a:defPPr');
  if (def) out.push(def);
  return out;
}

/**
 * The paragraph-property chain of a paragraph at `level`, after its own `a:pPr`, split where a shape's
 * `p:style/a:fontRef` applies: `local` holds the shape's lstStyle and its layout and master placeholders'
 * (nearer than the font reference), `styles` the master's txStyles entry (titleStyle for titles,
 * bodyStyle for other placeholders, otherStyle for dt/ftr/sldNum/hdr; nothing for non-placeholders) and the
 * presentation's defaultTextStyle.
 */
export function paraChainParts(ctx: SlideCtx, c: Chain, level: number): { local: XNode[]; styles: XNode[] } {
  const local: XNode[] = [];
  for (const n of nodes(c)) local.push(...listLevel(path(n, 'p:txBody', 'a:lstStyle'), level));
  const styles: XNode[] = [];
  if (c.ph) {
    const cls = masterClass(c.ph.type);
    const style = cls === 'title' ? 'p:titleStyle' : cls === 'body' ? 'p:bodyStyle' : 'p:otherStyle';
    styles.push(...listLevel(path(ctx.master, 'p:txStyles', style), level));
  }
  styles.push(...listLevel(ctx.deck.defaultTextStyle, level));
  return { local, styles };
}

/**
 * The paragraph-property chain of a paragraph at `level`, after its own `a:pPr`, nearest first:
 * the shape's lstStyle, the layout placeholder's, the master placeholder's, the master's txStyles entry
 * (titleStyle for titles, bodyStyle for other placeholders, otherStyle for dt/ftr/sldNum/hdr; nothing for
 * non-placeholders, design/27 §4), then the presentation's defaultTextStyle.
 */
export function paraChain(ctx: SlideCtx, c: Chain, level: number): XNode[] {
  const { local, styles } = paraChainParts(ctx, c, level);
  return [...local, ...styles];
}

/** The first value of attribute `name` along `chain`. */
export function firstAttr(chain: readonly (XNode | undefined)[], name: string): string | undefined {
  for (const n of chain) {
    const v = n?.attrs[name];
    if (v !== undefined) return v;
  }
  return undefined;
}

/** The first child named `name` along `chain`. */
export function firstChildOf(chain: readonly (XNode | undefined)[], name: string): XNode | undefined {
  for (const n of chain) {
    const v = child(n, name);
    if (v) return v;
  }
  return undefined;
}

/**
 * The first child named any of `names` along `chain` (the nearest node that has one decides). Looked up
 * through the node's name index (`xml.ts` `firstChild`): chains hold shared layout, master and presentation
 * nodes, read once per paragraph.
 */
export function firstOfAny(
  chain: readonly (XNode | undefined)[],
  names: readonly string[],
): XNode | undefined {
  for (const n of chain) {
    const c = firstChild(n, names);
    if (c) return c;
  }
  return undefined;
}
