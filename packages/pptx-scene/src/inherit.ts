/**
 * Inheritance (design/27 §4 "Inheritance"): placeholder matching, the xfrm and bodyPr chain, and the
 * paragraph-property chain.
 *
 * Owned by work item C (inherit-emit). The scaffold has the whole lookup order; still to do: placeholders
 * with no position anywhere (dt/ftr/sldNum/hdr not drawn, others the whole slide), `buNone` nearest wins,
 * fonts through the chain (+mj-lt for title placeholders, +mn-lt otherwise), and the M1 run properties.
 */
import type { SlideCtx, Source } from './context.ts';
import { child, path, type XNode } from './xml.ts';

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
  if (type === 'dt' || type === 'ftr' || type === 'sldNum' || type === 'hdr') return type;
  return 'body';
}

/** Whether a placeholder takes the master's titleStyle. */
export function isTitle(ph: PhRef | undefined): boolean {
  return ph !== undefined && masterClass(ph.type) === 'title';
}

function placeholders(root: XNode | undefined): { el: XNode; ph: PhRef }[] {
  const out: { el: XNode; ph: PhRef }[] = [];
  for (const el of path(root, 'p:cSld', 'p:spTree')?.children ?? []) {
    const ph = NV[el.name] ? placeholderOf(el) : undefined;
    if (ph) out.push({ el, ph });
  }
  return out;
}

/** The layout's placeholder for `ph`: by idx, else by type. */
export function layoutPlaceholder(layout: XNode | undefined, ph: PhRef): XNode | undefined {
  const all = placeholders(layout);
  if (ph.idx !== undefined) {
    const byIdx = all.find((p) => p.ph.idx === ph.idx);
    if (byIdx) return byIdx.el;
  }
  return all.find((p) => p.ph.type === ph.type)?.el;
}

/** The master's placeholder for `ph`: by type class. */
export function masterPlaceholder(master: XNode | undefined, ph: PhRef): XNode | undefined {
  const cls = masterClass(ph.type);
  return placeholders(master).find((p) => masterClass(p.ph.type) === cls)?.el;
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
 * The paragraph-property chain of a paragraph at `level`, after its own `a:pPr`, nearest first:
 * the shape's lstStyle, the layout placeholder's, the master placeholder's, the master's txStyles entry
 * (titleStyle for titles, bodyStyle for other placeholders, otherStyle for dt/ftr/sldNum/hdr; nothing for
 * non-placeholders, design/27 §4), then the presentation's defaultTextStyle.
 */
export function paraChain(ctx: SlideCtx, c: Chain, level: number): XNode[] {
  const out: XNode[] = [];
  for (const n of nodes(c)) out.push(...listLevel(path(n, 'p:txBody', 'a:lstStyle'), level));
  if (c.ph) {
    const cls = masterClass(c.ph.type);
    const style = cls === 'title' ? 'p:titleStyle' : cls === 'body' ? 'p:bodyStyle' : 'p:otherStyle';
    out.push(...listLevel(path(ctx.master, 'p:txStyles', style), level));
  }
  out.push(...listLevel(ctx.deck.defaultTextStyle, level));
  return out;
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
