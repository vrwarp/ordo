/**
 * SmartArt from its drawing cache (design/27 §5 "Element support", §15 M6): a SmartArt graphic frame whose
 * deck holds PowerPoint's drawing of it (`ppt/diagrams/drawingN.xml`) is drawn natively, as a locked group of
 * ordinary shapes and pictures with editable text; without a drawing it stays residual (LibreOffice lays it
 * out and draws it into the art).
 *
 * - **Finding the drawing** as PowerPoint and LibreOffice do: the frame's `dgm:relIds r:dm` names the data
 *   model part; its `dgm:extLst` holds `dsp:dataModelExt relId`, a relationship of the part holding the frame
 *   (slide, layout or master) to the drawing part (`diagramDrawing`). Anything missing, external or malformed
 *   on the way: no drawing (residual).
 * - **The drawing's shapes** (`dsp:sp`, `dsp:grpSp` in `dsp:spTree`) have PresentationML's vocabulary, so they
 *   are read as one: a copy of the tree with the `dsp:` shape elements named `p:` (`p:sp`, `p:spPr`,
 *   `p:style`, `p:txBody`, …; DrawingML children shared, never copied) goes through the ordinary shape walk
 *   (`walk.ts` `walkTree`), geometry, fills, lines, effects, style references and text included. Their
 *   relationships (picture fills) are the drawing part's.
 * - **Placement.** The drawing's coordinates are the frame's, relative to its offset at scale 1 (verified on
 *   decks: LibreOffice places the drawing's group at the frame's position and does not scale it); a
 *   `dsp:grpSpPr` with a child space maps it onto the frame like a group's.
 * - **Text colour.** The colours part's node text colour replaces the colour of the shapes' `a:fontRef`
 *   (`nodeTextColor`), as LibreOffice applies it: drawing caches often name the style label's fill colour
 *   there (white text on white nodes), and a run's own colour still wins.
 * - **Text** goes in its own text rectangle when the drawing gives one (`dsp:txXfrm`, PowerPoint's own
 *   layout of the node's text, in the drawing's coordinates): the shape is emitted without its text, and the
 *   text as a frameless rect over `dsp:txXfrm`, turned by the shape's rotation plus its own (LibreOffice
 *   turns the text area so). A text that a shape showing nothing casts its shadow on keeps that shadow.
 * - **Identity.** Every element of one drawing has `diagram` (a number per frame on the slide) and the
 *   frame's `cNvPr id`, so the render copy finds the frame again, and the frame's flattened group. The XML
 *   node of each shape is kept on it (`ShapeElement.node`), so classification rates the drawing's shapes by
 *   their own XML (3D, vertical text …), never a slide shape that shares an id.
 * - **Emission** (`lockDiagram`): `origin { src: 'pptx', shapeId, role: 'diagram', group }` on every object,
 *   `locked` on all but the text objects (move, resize, delete and z-order only; the text stays editable).
 * - Classification (`classify.ts` `wholeDiagrams`) keeps a drawing whole: native, or entirely in the art.
 *
 * Bounded like any shape tree: the drawing's shapes count against the slide's 5,000, its groups against the
 * depth of 32; the renamed copy is made once per drawing part (iterative, linear in its size). A drawing can
 * be named from every slide, so the drawings read per package are bounded too (`DIAGRAM_NODE_BUDGET`
 * elements; past it SmartArt stays residual).
 */
import { partOf, type SlideCtx, type Source } from './context.ts';
import { childSpace, type Xfrm } from './frame.ts';
import type { Affine, ElementBase, ShapeElement } from './ir.ts';
import { type Package, relType } from './opc.ts';
import type { WalkState } from './walk.ts';
import { child, num, path, type XNode } from './xml.ts';
import type { SlideObject } from '@ordo/domain';

/** The extension URI under which a data model names its drawing (`dsp:dataModelExt`). */
export const DRAWING_EXT_URI = 'http://schemas.microsoft.com/office/drawing/2008/diagram';
/** `dgm:extLst` children looked at for the drawing's extension (a deck can give it any number of others). */
const MAX_EXT_SCAN = 64;

/** What `walk.ts` lends this module (passed in, so the two do not import each other). */
export interface Walker {
  walkTree(
    ctx: SlideCtx,
    tree: XNode | undefined,
    from: Source,
    map: Affine,
    group: number | undefined,
    depth: number,
    st: WalkState,
  ): void;
  readXfrm(x: XNode | undefined): Xfrm;
  boxAffine(map: Affine, x: Xfrm): Affine;
}

/** The `dsp:` elements that are PresentationML's shape vocabulary (read under `p:`). */
const SHAPE_VOCABULARY: ReadonlySet<string> = new Set([
  'spTree',
  'nvGrpSpPr',
  'cNvPr',
  'cNvGrpSpPr',
  'grpSpPr',
  'grpSp',
  'sp',
  'nvSpPr',
  'cNvSpPr',
  'spPr',
  'style',
  'txBody',
]);

/** A drawing's tree with the shape vocabulary renamed, and each `p:sp` by its synthetic `cNvPr id`. */
interface Renamed {
  tree: XNode;
  /** Synthetic id (1, 2, …) → the renamed `p:sp` and whether it is a child of the drawing's own tree. */
  shapes: Map<number, { node: XNode; top: boolean }>;
}

/**
 * Elements of SmartArt drawings read per package (one pool batch, one harness deck): a drawing is shared, so
 * a deck can name one large drawing from every slide. Past this many, further SmartArt is left to
 * LibreOffice (residual, noted), so the work stays within what the deck's own slides could cost.
 */
export const DIAGRAM_NODE_BUDGET = 2_000_000;
const spent = new WeakMap<object, number>();
const sizeCache = new WeakMap<XNode, number>();

/** The elements of a tree (iterative, memoised per root). */
function sizeOf(tree: XNode): number {
  let n = sizeCache.get(tree);
  if (n !== undefined) return n;
  n = 0;
  const stack = [tree];
  while (stack.length) {
    const x = stack.pop()!;
    n++;
    for (const c of x.children) if (c.name !== '#text') stack.push(c);
  }
  sizeCache.set(tree, n);
  return n;
}

const renamedCache = new WeakMap<XNode, { font: XNode | undefined; v: Renamed }>();

/**
 * The drawing's `dsp:spTree` with its shape vocabulary under `p:` (memoised per node and text colour). Each
 * `p:sp` gets a synthetic `cNvPr id` (its place, from 1), which `readSmartArt` maps back to the node;
 * DrawingML subtrees (`a:` …) are shared with the parsed part, and `dsp:txXfrm` keeps its name. With `font`
 * (a colour element), every style's `a:fontRef` takes it as its colour (`nodeTextColor`).
 */
function renamed(tree: XNode, font?: XNode): Renamed {
  const known = renamedCache.get(tree);
  if (known && known.font === font) return known.v;
  const shapes = new Map<number, { node: XNode; top: boolean }>();
  const copy = (n: XNode, attrs: Record<string, string> = n.attrs): XNode => ({
    name: `p:${n.name.slice(4)}`,
    attrs,
    children: [],
    text: n.text,
  });
  const root = copy(tree);
  // [source, its copy, groups above it in the drawing, the id of the p:sp it belongs to]
  const stack: [XNode, XNode, number, number | undefined][] = [[tree, root, 0, undefined]];
  let ids = 0;
  while (stack.length) {
    const [src, dst, depth, spId] = stack.pop()!;
    for (const c of src.children) {
      const local = c.name.startsWith('dsp:') ? c.name.slice(4) : '';
      if (!SHAPE_VOCABULARY.has(local)) {
        dst.children.push(c);
        continue;
      }
      let attrs = c.attrs;
      let id = spId;
      if (local === 'sp') id = ++ids;
      else if (local === 'grpSp') id = undefined;
      if (local === 'cNvPr' && spId !== undefined) {
        attrs = Object.assign(Object.create(null), c.attrs, { id: String(spId) }) as Record<string, string>;
      }
      const out = copy(c, attrs);
      dst.children.push(out);
      if (local === 'sp' && id !== undefined) shapes.set(id, { node: out, top: depth === 0 });
      if (local === 'style' && font) {
        for (const r of c.children)
          out.children.push(r.name === 'a:fontRef' ? { ...r, children: [font] } : r);
        continue;
      }
      stack.push([c, out, local === 'grpSp' ? depth + 1 : depth, id]);
    }
  }
  const v = { tree: root, shapes };
  renamedCache.set(tree, { font, v });
  return v;
}

/** Colour elements a colours part's list holds (`color.ts` reads each). */
const COLOR_NAMES: ReadonlySet<string> = new Set([
  'a:srgbClr',
  'a:schemeClr',
  'a:sysClr',
  'a:prstClr',
  'a:scrgbClr',
  'a:hslClr',
]);
/** Children of a colours part, and of one of its lists, looked at (a deck can give them any number). */
const MAX_COLORS_SCAN = 256;

/**
 * The text colour of the SmartArt's nodes, as LibreOffice takes it (`PPTShapeGroupContext::applyFontRefColor`):
 * the last colour of the colours part's `node0` style label's `dgm:txFillClrLst` (the frame's `r:cs`), which
 * replaces the colour of every `a:fontRef` of the drawing (a run's own colour still wins). Undefined when the
 * part, the label or the list is missing.
 */
function nodeTextColor(ctx: SlideCtx, source: string, frame: XNode): XNode | undefined {
  const cs = path(frame, 'a:graphic', 'a:graphicData', 'dgm:relIds')?.attrs['r:cs'];
  const rel = cs ? ctx.pkg.rel(source, cs) : undefined;
  if (!rel || rel.external || !ctx.pkg.has(rel.target)) return undefined;
  let root: XNode | undefined;
  try {
    root = ctx.pkg.xml(rel.target);
  } catch {
    return undefined;
  }
  const labels = root?.name === 'dgm:colorsDef' ? root.children : [];
  for (let i = 0; i < labels.length && i < MAX_COLORS_SCAN; i++) {
    const l = labels[i]!;
    if (l.name !== 'dgm:styleLbl' || l.attrs.name !== 'node0') continue;
    const list = child(l, 'dgm:txFillClrLst')?.children ?? [];
    let last: XNode | undefined;
    for (let k = 0; k < list.length && k < MAX_COLORS_SCAN; k++)
      if (COLOR_NAMES.has(list[k]!.name)) last = list[k];
    return last;
  }
  return undefined;
}

/** The relationship id of a frame's drawing: the data model's `dsp:dataModelExt relId`. */
function drawingRelId(ctx: SlideCtx, source: string, frame: XNode): string | undefined {
  const dm = path(frame, 'a:graphic', 'a:graphicData', 'dgm:relIds')?.attrs['r:dm'];
  if (!dm) return undefined;
  const rel = ctx.pkg.rel(source, dm);
  if (!rel || rel.external || !ctx.pkg.has(rel.target)) return undefined;
  return modelDrawingRelId(ctx.pkg, rel.target, ctx.log);
}

/**
 * The relationship id (of the part holding the frame) that a data model part names as its drawing
 * (`dsp:dataModelExt relId`), or undefined. The render copy keeps that relationship with the frame.
 */
export function modelDrawingRelId(
  pkg: Package,
  dataPart: string,
  log?: (msg: string) => void,
): string | undefined {
  let model: XNode | undefined;
  try {
    model = pkg.xml(dataPart);
  } catch {
    log?.('a SmartArt data part could not be read');
    return undefined;
  }
  const exts = child(model, 'dgm:extLst')?.children ?? [];
  for (let i = 0; i < exts.length && i < MAX_EXT_SCAN; i++) {
    const ext = exts[i]!;
    if (ext.name !== 'a:ext' || ext.attrs.uri !== DRAWING_EXT_URI) continue;
    const id = child(ext, 'dsp:dataModelExt')?.attrs.relId;
    if (id) return id;
  }
  return undefined;
}

/** The SmartArt drawing's tree and part of a graphic frame, or undefined when the deck holds none. */
export function smartArtDrawing(
  ctx: SlideCtx,
  from: Source,
  frame: XNode,
): { part: string; tree: XNode } | undefined {
  const source = partOf(ctx, from);
  if (source === undefined) return undefined;
  const id = drawingRelId(ctx, source, frame);
  if (!id) return undefined;
  const rel = ctx.pkg.rel(source, id);
  if (!rel || rel.external || relType(rel.type) !== 'diagramDrawing' || !ctx.pkg.has(rel.target))
    return undefined;
  let root: XNode | undefined;
  try {
    root = ctx.pkg.xml(rel.target);
  } catch {
    ctx.log('a SmartArt drawing could not be read: LibreOffice draws it');
    return undefined;
  }
  const tree = root?.name === 'dsp:drawing' ? child(root, 'dsp:spTree') : undefined;
  return tree ? { part: rel.target, tree } : undefined;
}

/** The context the drawing's shapes are read in: their relationships are the drawing part's. */
function drawingCtx(ctx: SlideCtx, from: Source, part: string): SlideCtx {
  if (from === 'slide') return { ...ctx, part };
  if (from === 'layout') return { ...ctx, layoutPart: part };
  return { ...ctx, masterPart: part };
}

const finite = (v: number | undefined, d: number) => (v !== undefined && Number.isFinite(v) ? v : d);

/** An element's own fields (`ElementBase`), copied. */
function baseOf(e: ElementBase): ElementBase {
  return {
    shapeId: e.shapeId,
    name: e.name,
    xf: e.xf,
    from: e.from,
    ...(e.ph ? { ph: e.ph } : {}),
    ...(e.group !== undefined ? { group: e.group } : {}),
    ...(e.hidden ? { hidden: true } : {}),
    support: e.support,
    ...(e.reasons ? { reasons: [...e.reasons] } : {}),
    ...(e.diagram !== undefined ? { diagram: e.diagram } : {}),
  };
}

/**
 * Read a SmartArt graphic frame from its drawing cache into `st.out` (the frame's flattened `group`, nested
 * one level deeper than `depth`). `frameXf` is the frame's unit-square affine and `place` its box in the
 * tree's coordinates. False, with nothing added, when the deck holds no drawing for it (the frame stays a
 * residual element).
 */
export function readSmartArt(
  ctx: SlideCtx,
  frame: XNode,
  from: Source,
  frameXf: Affine,
  place: Xfrm,
  base: ElementBase,
  group: number,
  depth: number,
  st: WalkState,
  walker: Walker,
): boolean {
  const drawing = smartArtDrawing(ctx, from, frame);
  if (!drawing) return false;
  const cost = (spent.get(ctx.pkg) ?? 0) + sizeOf(drawing.tree);
  if (cost > DIAGRAM_NODE_BUDGET) {
    ctx.log('more SmartArt than an import reads natively: LibreOffice draws the rest');
    return false;
  }
  spent.set(ctx.pkg, cost);
  const source = partOf(ctx, from)!;
  const { tree, shapes } = renamed(drawing.tree, nodeTextColor(ctx, source, frame));
  // The drawing's own child space, when it states one; else the frame's coordinates at scale 1.
  const x = child(child(tree, 'p:grpSpPr'), 'a:xfrm');
  const chOff = child(x, 'a:chOff');
  const chExt = child(x, 'a:chExt');
  const ext = {
    cx: finite(num(chExt?.attrs.cx), place.cx) || place.cx,
    cy: finite(num(chExt?.attrs.cy), place.cy) || place.cy,
  };
  const inner = childSpace(
    frameXf,
    { x: finite(num(chOff?.attrs.x), 0), y: finite(num(chOff?.attrs.y), 0) },
    ext,
  );
  const diagram = (st.diagrams = (st.diagrams ?? 0) + 1);
  const at = st.out.length;
  walker.walkTree(drawingCtx(ctx, from, drawing.part), tree, from, inner, group, depth + 1, st);
  const read = st.out.splice(at);
  for (const e of read) {
    const shape = shapes.get(e.shapeId);
    e.shapeId = base.shapeId;
    e.diagram = diagram;
    e.group = group;
    if (base.hidden) e.hidden = true;
    if (e.kind !== 'shape' || !shape) {
      st.out.push(e);
      continue;
    }
    e.node = shape.node;
    const tx = shape.top ? child(shape.node, 'dsp:txXfrm') : undefined;
    if (!e.text || !tx) {
      st.out.push(e);
      continue;
    }
    // The text in PowerPoint's own text rectangle, turned with the shape (LibreOffice: the text area
    // rotation is the shape's plus the rectangle's).
    const own = walker.readXfrm(child(child(shape.node, 'p:spPr'), 'a:xfrm'));
    const box = walker.readXfrm(tx);
    const rot = (own.rot + box.rot) % 360;
    const textXf = walker.boxAffine(inner, { ...box, rot, flipH: false, flipV: false });
    const visible = e.fill.kind !== 'none' || e.line !== undefined;
    const text: ShapeElement = {
      ...baseOf(e),
      xf: textXf,
      kind: 'shape',
      geom: 'rect',
      fill: { kind: 'none' },
      ...(!visible && e.shadow ? { shadow: e.shadow } : {}),
      text: e.text,
      node: shape.node,
    };
    delete e.text;
    st.out.push(e, text);
  }
  return true;
}

/**
 * Mark the objects a SmartArt element emitted (`objects` from `at`): its origin (the frame's id, role
 * 'diagram', the frame's group) and `locked` on all but text, whose content stays editable.
 */
export function lockDiagram(e: ElementBase, objects: SlideObject[], at: number): void {
  for (let i = at; i < objects.length; i++) {
    const o = objects[i]!;
    o.origin = {
      src: 'pptx',
      ...(e.shapeId > 0 ? { shapeId: Math.min(2_147_483_647, e.shapeId) } : {}),
      role: 'diagram',
      ...(e.group !== undefined ? { group: Math.min(100_000, Math.max(0, e.group)) } : {}),
    };
    if (o.type !== 'text') o.locked = true;
  }
}
