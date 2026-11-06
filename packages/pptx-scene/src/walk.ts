/**
 * The shape-tree walk (design/27 §4 "Groups", "Master and layout decorations", "Alternate content",
 * "Inheritance").
 *
 * - Bottom first: the master's decorations, the layout's, then the slide's own shapes. Master and layout
 *   decorations are drawn unless `showMasterSp="0"` is on the slide (both) or the layout (the master's).
 *   Placeholders of layouts and masters are templates, never drawn.
 * - `mc:AlternateContent`: the one branch `Package.xml` keeps (`markup.ts` `chooseAlternate`: the first
 *   `mc:Choice` whose `Requires` namespaces are all understood, else `mc:Fallback`; never both).
 * - Placeholders take their position from own → layout → master. One with no position anywhere is not drawn
 *   when it is a date, footer, slide number or header; any other gets the whole slide. A slide placeholder
 *   without text (prompt text only) is not drawn.
 * - Placeholders inherit their shape properties too: geometry, fill, line and effects come from the nearest
 *   `p:spPr` along the chain that sets them, then the nearest `p:style` references.
 * - Groups are flattened into absolute placements: child space scaled and translated, then the group's
 *   rotation and flips about its centre; a missing offset is the origin, ext and chExt substitute for each
 *   other; depth ≤ 32. A child's own box is scaled along the group's axes before its own rotation
 *   (`boxAffine`), as LibreOffice places it: PowerPoint has no shear (ungrouping turns every child back into
 *   a box and a rotation). A child the plain composed affine would shear (rotated in a group scaled
 *   unevenly) is still marked residual (design/27 §4), and drawn so in M1.
 * - Graphic frames are residual (charts, OLE), except tables, which `tables.ts` reads (M6): each table's
 *   objects form a group of their own, or join the top-level group they are in; and SmartArt whose deck
 *   holds PowerPoint's drawing of it (M6, `smartart.ts`): its shapes are read like these, as the frame's
 *   own group.
 *
 * Owned by work item C (inherit-emit).
 */
import { colorIn, readFill, styleFill, withPhClr } from './color.ts';
import { partOf, type SlideCtx, type Source } from './context.ts';
import { readBackground } from './background.ts';
import { apply, childSpace, decompose, IDENTITY, multiply, xfrmAffine, type Xfrm } from './frame.ts';
import {
  type Chain,
  chainOf,
  firstChildOf,
  geometryOf,
  inheritedXfrm,
  isFooter,
  nodes,
  nvOf,
  spPrChain,
  spPrOf,
  styleOf,
} from './inherit.ts';
import type { Affine, Element, ElementBase, Fill, Line, ShapeElement, Support } from './ir.ts';
import { chooseAlternate } from './markup.ts';
import { customPaths, knownPreset, MAX_SLIDE_PATH_POINTS, placeConnectors, readCxnRef } from './geom.ts';
import { blipReader, blipReaderOf, readPicture } from './picture.ts';
import { readSmartArt, type Walker } from './smartart.ts';
import { readTable } from './tables.ts';
import { readShadow, readTextBody, textChars } from './text.ts';
import { child, num, path, type XNode } from './xml.ts';

/** Group nesting followed (design/27 §12). */
export const MAX_GROUP_DEPTH = 32;
/** Shape-tree elements read per slide, decorations included (design/27 §12). */
export const MAX_SHAPES_PER_SLIDE = 5_000;

/**
 * Presets M1 drew with today's fields (ordo's rect/ellipse/line and a rounded rect). Since M6 every preset of
 * the table is drawn (`geom.ts` `knownPreset`); this is the set an older build draws exactly.
 */
export const M1_PRESETS: ReadonlySet<string> = new Set([
  'rect',
  'roundRect',
  'ellipse',
  'line',
  'straightConnector1',
]);

const on = (v: string | undefined) => v === '1' || v === 'true';
const finite = (v: number | undefined, dflt: number) => (v !== undefined && Number.isFinite(v) ? v : dflt);

/** Mutable state of one slide's walk. */
export interface WalkState {
  out: Element[];
  count: number;
  groups: number;
  /** The slide's background, read once when a shape uses it (`useBgFill`). */
  background?: Fill;
  /** Custom geometry points so far (design/27 §12: 64k per slide; M6). */
  points?: number;
  /** SmartArt drawings read so far (M6, `smartart.ts`: `ElementBase.diagram` numbers them). */
  diagrams?: number;
  /**
   * A shape of the slide's own tree with text and its own `a:spAutoFit` was read: LibreOffice sizes the
   * rows of the tables after it with font-independent line spacing (`tables.ts` `TableReadOptions`).
   */
  autogrow?: boolean;
}

const shows = (n: XNode | undefined) => n?.attrs.showMasterSp !== '0' && n?.attrs.showMasterSp !== 'false';
const treeOf = (n: XNode | undefined) => path(n, 'p:cSld', 'p:spTree');

/**
 * Every element drawn on the slide, bottom first: master decorations, layout decorations, own shapes. The
 * decorations are walked once per layout and colour map and shared by every slide that shows them (each
 * slide gets shallow copies, which classification may mark), so their cost does not grow with the slides.
 */
export function walkSlide(ctx: SlideCtx): Element[] {
  const st: WalkState = { out: [], count: 0, groups: 0 };
  if (shows(ctx.slide)) decorations(ctx, st);
  walkTree(ctx, treeOf(ctx.slide), 'slide', IDENTITY, undefined, 0, st);
  // Connector ends glued to shapes move to their connection sites (M6).
  placeConnectors(st.out);
  return st.out;
}

/** The master's and layout's decorations as one slide's walk leaves them, with the notes it logged. */
interface Decorations {
  out: Element[];
  count: number;
  groups: number;
  notes: string[];
  points: number;
}

/**
 * Decorations by layout root and colour map. `null`: they read the slide's own background (`useBgFill`),
 * so they are walked for every slide.
 */
const decorationCache = new WeakMap<XNode, Map<string, Decorations | null>>();

function decorations(ctx: SlideCtx, st: WalkState): void {
  const walk = (c: SlideCtx) => {
    if (shows(ctx.layout)) walkTree(c, treeOf(ctx.master), 'master', IDENTITY, undefined, 0, st);
    walkTree(c, treeOf(ctx.layout), 'layout', IDENTITY, undefined, 0, st);
  };
  if (!ctx.layout) {
    walk(ctx);
    return;
  }
  // What the walk of a layout and its master depends on besides them (deck-wide facts aside): the colours.
  const key = [...ctx.color.map.values()].join(' ');
  let byKey = decorationCache.get(ctx.layout);
  if (!byKey) decorationCache.set(ctx.layout, (byKey = new Map()));
  const known = byKey.get(key);
  if (known === null) {
    walk(ctx);
    return;
  }
  if (known) {
    for (const note of known.notes) ctx.log(note);
    for (const e of known.out) st.out.push({ ...e });
    st.count = known.count;
    st.groups = known.groups;
    st.points = known.points;
    return;
  }
  const notes: string[] = [];
  walk({
    ...ctx,
    log: (msg) => {
      notes.push(msg);
      ctx.log(msg);
    },
  });
  if (st.background !== undefined) {
    byKey.set(key, null);
    return;
  }
  // Kept as walked; this slide and the next ones get copies.
  byKey.set(key, { out: st.out.slice(), count: st.count, groups: st.groups, notes, points: st.points ?? 0 });
  for (let i = 0; i < st.out.length; i++) st.out[i] = { ...st.out[i]! };
}

/** An `a:xfrm` (or `p:xfrm`) read; missing values are 0 (off) and 0 (ext). */
export function readXfrm(x: XNode | undefined): Xfrm {
  const off = child(x, 'a:off');
  const ext = child(x, 'a:ext');
  return {
    x: finite(num(off?.attrs.x), 0),
    y: finite(num(off?.attrs.y), 0),
    cx: finite(num(ext?.attrs.cx), 0),
    cy: finite(num(ext?.attrs.cy), 0),
    rot: (finite(num(x?.attrs.rot), 0) / 60_000) % 360,
    flipH: on(x?.attrs.flipH),
    flipV: on(x?.attrs.flipV),
  };
}

/**
 * The branch of an `mc:AlternateContent` to read: the first understood Choice, else the Fallback
 * (`markup.ts` `chooseAlternate`, so the walk and `Package.xml` never disagree).
 */
export function alternateBranch(ac: XNode): XNode | undefined {
  return chooseAlternate(ac);
}

/**
 * The unit-square affine of an `a:xfrm` box in a tree whose coordinates `map` takes to the slide: the box's
 * centre goes through `map`, its sides are scaled by `map`'s own axis scales, then its rotation and flips
 * apply, then `map`'s rotation and flips. The same as `map ∘ xfrmAffine(x)` unless the box is rotated in a
 * tree scaled unevenly, where that would shear it.
 */
export function boxAffine(map: Affine, x: Xfrm): Affine {
  const sx = Math.hypot(map[0], map[1]);
  const sy = Math.hypot(map[2], map[3]);
  if (!(sx > 0 && sy > 0 && Number.isFinite(sx) && Number.isFinite(sy))) return multiply(map, xfrmAffine(x));
  const [cx, cy] = apply(map, x.x + x.cx / 2, x.y + x.cy / 2);
  const w = x.cx * sx;
  const h = x.cy * sy;
  // The box about the origin, then map's rotation and flips (its columns made unit length).
  const local = xfrmAffine({ ...x, x: -w / 2, y: -h / 2, cx: w, cy: h });
  const m = multiply([map[0] / sx, map[1] / sx, map[2] / sy, map[3] / sy, 0, 0], local);
  return [m[0], m[1], m[2], m[3], m[4] + cx, m[5] + cy];
}

/** What a group passes to its children. */
export interface GroupInherit {
  /** What `a:grpFill` stands for. */
  fill?: Fill;
  /** The group itself would be sheared: its children are placed approximately (marked residual). */
  sheared?: boolean;
}

/**
 * Walk one shape tree (`p:spTree`, a `p:grpSp` or an `mc:AlternateContent` branch). `map` takes the tree's
 * coordinates to slide EMU; `group` is the flattened group number of a top-level group's members.
 */
export function walkTree(
  ctx: SlideCtx,
  tree: XNode | undefined,
  from: Source,
  map: Affine,
  group: number | undefined,
  depth: number,
  st: WalkState,
  inherit: GroupInherit = {},
): void {
  const groupFill = inherit.fill;
  for (const el of tree?.children ?? []) {
    if (el.name === 'mc:AlternateContent') {
      // The branch `Package.xml` kept (design/27 §4: the first understood Choice, else the Fallback).
      if (depth >= MAX_GROUP_DEPTH) continue;
      walkTree(ctx, chooseAlternate(el), from, map, group, depth + 1, st, inherit);
      continue;
    }
    if (el.name === '#text' || !nvOf(el)) continue;
    if (++st.count > MAX_SHAPES_PER_SLIDE) {
      ctx.log(`more than ${MAX_SHAPES_PER_SLIDE} shapes: the rest are not drawn`);
      return;
    }
    const chain = chainOf(ctx, el, from);
    // Placeholders of layouts and masters are templates, not decorations.
    if (from !== 'slide' && chain.ph) continue;
    const cNvPr = child(nvOf(el), 'p:cNvPr');
    const hidden = on(cNvPr?.attrs.hidden);
    const xfrm = inheritedXfrm(chain);
    let place: Xfrm;
    if (xfrm) place = readXfrm(xfrm);
    else if (chain.ph) {
      // No position anywhere: footers are not drawn, anything else gets the whole slide.
      if (isFooter(chain.ph)) continue;
      place = { x: 0, y: 0, cx: ctx.frame.cx, cy: ctx.frame.cy, rot: 0, flipH: false, flipV: false };
    } else if (el.name === 'p:grpSp') place = readXfrm(undefined);
    else continue; // nothing places it: zero size
    if (el.name === 'p:grpSp') {
      // A missing chExt is the ext and the other way round.
      const chExt = path(spPrOf(el), 'a:xfrm', 'a:chExt');
      if (!place.cx && !place.cy) {
        place.cx = finite(num(chExt?.attrs.cx), 0);
        place.cy = finite(num(chExt?.attrs.cy), 0);
      }
    }
    const xf = boxAffine(map, place);
    const sheared = inherit.sheared || decompose(multiply(map, xfrmAffine(place))).sheared;
    const base: ElementBase = {
      shapeId: Math.max(0, Math.min(2_147_483_647, Math.floor(finite(num(cNvPr?.attrs.id), 0)))),
      name: (cNvPr?.attrs.name ?? '').slice(0, 200),
      xf,
      from,
      ...(chain.ph ? { ph: { type: chain.ph.type.slice(0, 20), ...idxOf(chain.ph.idx) } } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(hidden ? { hidden: true } : {}),
      support: 'native',
    };
    const at = st.out.length;
    switch (el.name) {
      case 'p:sp':
      case 'p:cxnSp': {
        const shape = readShape(ctx, el, base, chain, st, groupFill);
        if (shape) st.out.push(shape);
        if (
          from === 'slide' &&
          shape?.kind === 'shape' &&
          textChars(shape.text) > 0 &&
          child(path(el, 'p:txBody', 'a:bodyPr'), 'a:spAutoFit')
        )
          st.autogrow = true;
        break;
      }
      case 'p:pic': {
        const pic = readPicture(ctx, el, base);
        if (pic) {
          if (pic.kind === 'picture') {
            const line = readLine(ctx, chain);
            if (line) pic.line = line;
            const custNode = pic.geom === 'custom' ? firstChildOf(spPrChain(chain), 'a:custGeom') : undefined;
            if (custNode) {
              pic.custom = slideCustom(ctx, custNode, base, st);
              if (pic.custom.over) {
                pic.support = pic.support === 'residual' ? 'residual' : 'approx';
                pic.reasons = [...(pic.reasons ?? []), 'mask:custom'];
              }
            }
          }
          st.out.push(pic);
        }
        break;
      }
      case 'p:grpSp': {
        if (hidden) break;
        if (depth >= MAX_GROUP_DEPTH) {
          ctx.log(`groups nested deeper than ${MAX_GROUP_DEPTH} are not drawn`);
          break;
        }
        const x = child(spPrOf(el), 'a:xfrm');
        const chOff = child(x, 'a:chOff');
        const chExt = child(x, 'a:chExt');
        // A missing offset is the origin; a missing chExt is the ext.
        const ext = {
          cx: finite(num(chExt?.attrs.cx), place.cx),
          cy: finite(num(chExt?.attrs.cy), place.cy),
        };
        const inner = childSpace(
          xf,
          { x: finite(num(chOff?.attrs.x), 0), y: finite(num(chOff?.attrs.y), 0) },
          ext,
        );
        let fill = readFill(spPrOf(el), ctx.color, blipReader(ctx, from));
        if (fill?.kind === 'group') fill = groupFill;
        walkTree(ctx, el, from, inner, group ?? ++st.groups, depth + 1, st, {
          fill: fill ?? groupFill,
          sheared,
        });
        break;
      }
      case 'p:graphicFrame': {
        const what = graphicKind(path(el, 'a:graphic', 'a:graphicData')?.attrs.uri ?? '');
        if (what === 'table') {
          // Drawn natively (M6, `tables.ts`): its objects are one group, the top-level group's when nested.
          const own = { ...base, group: group ?? ++st.groups };
          st.out.push(
            readTable(ctx, el, own, (cx, cy) => boxAffine(map, { ...place, cx, cy }), {
              ...(st.autogrow ? { afterAutogrow: true } : {}),
            }),
          );
          break;
        }
        // M6: SmartArt with PowerPoint's drawing of it is drawn natively (`smartart.ts`), its own group.
        if (what === 'smartart' && depth < MAX_GROUP_DEPTH) {
          const own = group ?? ++st.groups;
          if (readSmartArt(ctx, el, from, xf, place, base, own, depth, st, WALKER)) break;
        }
        st.out.push({ ...base, kind: 'residual', what, support: 'residual', reasons: [what] });
        break;
      }
    }
    if (sheared && el.name !== 'p:grpSp')
      for (let i = at; i < st.out.length; i++) {
        const e = st.out[i]!;
        e.support = 'residual';
        e.reasons = [...(e.reasons ?? []).filter((r) => r !== 'shear'), 'shear'];
      }
  }
}

/** What `smartart.ts` reads a drawing's shapes with. */
const WALKER: Walker = { walkTree, readXfrm, boxAffine };

function idxOf(idx: string | undefined): { idx?: string } {
  return idx === undefined ? {} : { idx: idx.slice(0, 20) };
}

/** What a graphic frame holds, from its `a:graphicData uri`. */
function graphicKind(uri: string): string {
  if (uri.endsWith('/chart') || uri.endsWith('/chartex')) return 'chart';
  if (uri.endsWith('/table')) return 'table';
  if (uri.endsWith('/diagram')) return 'smartart';
  if (uri.endsWith('/ole')) return 'ole';
  return 'graphicFrame';
}

/** Each node of the chain with the part that holds it (for relationships of picture fills). */
function chainParts(ctx: SlideCtx, c: Chain): [XNode, string | undefined][] {
  const out: [XNode, string | undefined][] = [[c.own, partOf(ctx, c.from)]];
  if (c.layout) out.push([c.layout, ctx.layoutPart]);
  if (c.master) out.push([c.master, ctx.masterPart]);
  return out;
}

/** A shape's fill along the chain: the nearest `p:spPr` fill, else the style's `a:fillRef`. */
function fillOf(ctx: SlideCtx, c: Chain): Fill | undefined {
  for (const [n, part] of chainParts(ctx, c)) {
    const f = readFill(spPrOf(n), ctx.color, blipReaderOf(ctx, part));
    if (f) return f;
  }
  return styleFill(ctx.theme, child(styleOf(c), 'a:fillRef'), ctx.color, blipReaderOf(ctx, ctx.themePart));
}

function readShape(
  ctx: SlideCtx,
  el: XNode,
  base: ElementBase,
  chain: Chain,
  st: WalkState,
  groupFill: Fill | undefined,
): ShapeElement | undefined {
  const { geom, adj } = geometryOf(chain);
  const custNode = geom === 'custom' ? firstChildOf(spPrChain(chain), 'a:custGeom') : undefined;
  const coverage = custNode ? pathCoverage(custNode) : undefined;
  const custom = custNode ? slideCustom(ctx, custNode, base, st) : undefined;
  let fill = fillOf(ctx, chain) ?? { kind: 'none' };
  if (on(el.attrs.useBgFill)) {
    st.background ??= readBackground(ctx).fill;
    fill = st.background;
    if (fill.kind !== 'solid' && fill.kind !== 'none') {
      ctx.log('a shape filled with a picture or gradient background is not drawn');
      fill = { kind: 'none' };
    }
  }
  if (fill.kind === 'group') fill = groupFill ?? { kind: 'none' };
  const text = readTextBody(ctx, chain);
  const chars = textChars(text);
  // An empty slide placeholder shows only its prompt text, which is never drawn.
  if (base.from === 'slide' && chain.ph && !chars && fill.kind !== 'picture') return undefined;
  const line = readLine(ctx, chain);
  const fx = effectsOf(ctx, chain);
  const reasons: string[] = [];
  let support: Support = 'native';
  // M6: every preset of the table, custom geometry within the bounds, gradients and line styles are drawn;
  // an unknown preset is drawn as its rect and a pattern as its blended colour.
  if (geom !== 'custom' && !knownPreset(geom)) reasons.push(`preset:${geom}`);
  if (fill.kind === 'pattern') reasons.push('pattFill');
  if (reasons.length) support = 'approx';
  if (custom?.over) {
    reasons.push('custGeom');
    support = 'residual';
  }
  const cxn =
    el.name === 'p:cxnSp'
      ? (() => {
          const nv = child(nvOf(el), 'p:cNvCxnSpPr');
          const start = readCxnRef(child(nv, 'a:stCxn'));
          const end = readCxnRef(child(nv, 'a:endCxn'));
          return start || end ? { ...(start ? { start } : {}), ...(end ? { end } : {}) } : undefined;
        })()
      : undefined;
  if (text && chars) {
    // Vertical text, warped text and columns are residual until M8 (design/27 §5); M1 still draws them.
    const residual = [
      ...(text.vert ? ['vert'] : []),
      ...(text.warp ? ['warp'] : []),
      ...(text.numCol ? ['numCol'] : []),
    ];
    if (residual.length) {
      reasons.push(...residual);
      support = 'residual';
    }
  }
  return {
    ...base,
    kind: 'shape',
    geom,
    ...(adj ? { adj } : {}),
    fill,
    ...(line ? { line } : {}),
    ...(fx.shadow ? { shadow: fx.shadow } : {}),
    ...(text && chars ? { text } : {}),
    ...(coverage !== undefined ? { coverage } : {}),
    support,
    ...(reasons.length ? { reasons } : {}),
    ...(custom ? { custom } : {}),
    ...(fx.glow ? { glow: fx.glow } : {}),
    ...(fx.softEdge ? { softEdge: fx.softEdge } : {}),
    ...(cxn ? { cxn } : {}),
  };
}

/**
 * A custom geometry built for an element (`geom.ts`), its points counted against the slide's 64k; past them
 * it is marked over the bounds (residual: LibreOffice draws it). Its compile notes go to the slide's log.
 */
export function slideCustom(ctx: SlideCtx, node: XNode, base: ElementBase, st: WalkState) {
  const p = decompose(base.xf);
  const custom = customPaths(node, p.w, p.h, ctx.frame.s);
  for (const n of custom.notes) ctx.log(`custom geometry: ${n}`);
  st.points = (st.points ?? 0) + custom.points;
  if (st.points > MAX_SLIDE_PATH_POINTS && !custom.over) {
    ctx.log(
      `more than ${MAX_SLIDE_PATH_POINTS} path points: further custom geometry is drawn by LibreOffice`,
    );
    return { ...custom, over: true };
  }
  return custom;
}

/**
 * An outline along the chain: each property from the nearest `a:ln` that sets it, else the theme line the
 * style's `a:lnRef` names. Undefined when none is drawn.
 */
function readLine(ctx: SlideCtx, c: Chain): Line | undefined {
  const lns = nodes(c)
    .map((n) => child(spPrOf(n), 'a:ln'))
    .filter((n): n is XNode => n !== undefined);
  const lnRef = child(styleOf(c), 'a:lnRef');
  const idx = num(lnRef?.attrs.idx) ?? 0;
  const themeLn = idx > 0 && idx <= 3 ? ctx.theme.lines[idx - 1] : undefined;
  const refCtx = withPhClr(ctx.color, colorIn(lnRef, ctx.color));
  let fill: Fill | undefined;
  for (const ln of lns) {
    fill = readFill(ln, ctx.color);
    if (fill) break;
  }
  fill ??= themeLn ? readFill(themeLn, refCtx) : undefined;
  if (!fill || fill.kind === 'none') return undefined;
  const all = themeLn ? [...lns, themeLn] : lns;
  const attr = (name: string) => all.map((n) => n.attrs[name]).find((v) => v !== undefined);
  const childAttr = (name: string, a: string) =>
    all.map((n) => child(n, name)?.attrs[a]).find((v) => v !== undefined);
  const out: Line = { width: Math.max(0, Math.min(20_116_800, finite(num(attr('w')), 9_525))), fill };
  // The nearest a:ln that sets a dash decides it, preset or custom (M6).
  for (const n of all) {
    const prst = child(n, 'a:prstDash');
    if (prst) {
      const dash = prst.attrs.val;
      if (dash && dash !== 'solid') out.dash = dash.slice(0, 20);
      break;
    }
    const cust = child(n, 'a:custDash');
    if (cust) {
      const ds: number[] = [];
      for (let i = 0; i < cust.children.length && i < MAX_DASH_SCAN && ds.length < MAX_DASH_STOPS; i++) {
        const d = cust.children[i]!;
        if (d.name !== 'a:ds') continue;
        ds.push(dashLength(num(d.attrs.d)), dashLength(num(d.attrs.sp)));
      }
      if (ds.length) out.custDash = ds;
      break;
    }
  }
  const head = childAttr('a:headEnd', 'type');
  if (head && head !== 'none') out.head = head.slice(0, 20);
  const tail = childAttr('a:tailEnd', 'type');
  if (tail && tail !== 'none') out.tail = tail.slice(0, 20);
  const size = (el: string) => {
    const w = childAttr(el, 'w') ?? 'med';
    const len = childAttr(el, 'len') ?? 'med';
    return w === 'med' && len === 'med' ? undefined : { w: w.slice(0, 4), len: len.slice(0, 4) };
  };
  const headSize = out.head ? size('a:headEnd') : undefined;
  if (headSize) out.headSize = headSize;
  const tailSize = out.tail ? size('a:tailEnd') : undefined;
  if (tailSize) out.tailSize = tailSize;
  for (const n of all) {
    const join = child(n, 'a:round')
      ? 'round'
      : child(n, 'a:bevel')
        ? 'bevel'
        : child(n, 'a:miter')
          ? 'miter'
          : undefined;
    if (join) {
      out.join = join;
      break;
    }
  }
  const cap = attr('cap');
  if (cap === 'flat' || cap === 'rnd' || cap === 'sq')
    out.cap = cap === 'rnd' ? 'round' : cap === 'sq' ? 'square' : 'flat';
  return out;
}

/** Dash stops read per `a:custDash` (pairs flattened), and its children scanned. */
const MAX_DASH_STOPS = 16;
const MAX_DASH_SCAN = 64;

/** A custom dash length (`a:ds d`, `sp`: 100,000 = one line width) in line widths, within 0..100. */
function dashLength(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) ? Math.max(0, Math.min(100, v / 100_000)) : 1;
}

/** A shape's effects (M6: outer shadow, glow, soft edge). */
interface Effects {
  shadow?: ShapeElement['shadow'];
  glow?: ShapeElement['glow'];
  softEdge?: number;
}

/** Effect radii in EMU are bounded (design/27 §12). */
const MAX_EFFECT_EMU = 20_116_800;

/** The effects of one `a:effectLst`, colours in `color`. */
function effectList(lst: XNode | undefined, color: SlideCtx['color']): Effects {
  if (!lst) return {};
  const out: Effects = {};
  const shadow = readShadow(child(lst, 'a:outerShdw'), color);
  if (shadow) out.shadow = shadow;
  const glow = child(lst, 'a:glow');
  const radius = Math.max(0, Math.min(MAX_EFFECT_EMU, finite(num(glow?.attrs.rad), 0)));
  const glowColor = glow ? colorIn(glow, color) : undefined;
  if (glow && radius > 0 && glowColor) out.glow = { radius, color: glowColor };
  const soft = Math.max(0, Math.min(MAX_EFFECT_EMU, finite(num(child(lst, 'a:softEdge')?.attrs.rad), 0)));
  if (soft > 0) out.softEdge = soft;
  return out;
}

/**
 * A shape's effects: the nearest `a:effectLst` along the chain decides them all, else the style's
 * `a:effectRef` (the theme's effect style, its `phClr` the reference's colour).
 */
function effectsOf(ctx: SlideCtx, c: Chain): Effects {
  for (const n of nodes(c)) {
    const lst = child(spPrOf(n), 'a:effectLst');
    if (lst) return effectList(lst, ctx.color);
  }
  const ref = child(styleOf(c), 'a:effectRef');
  const idx = num(ref?.attrs.idx) ?? 0;
  const entry = idx > 0 && idx <= 3 ? ctx.theme.effects[idx - 1] : undefined;
  if (!entry) return {};
  const refCtx = withPhClr(ctx.color, colorIn(ref, ctx.color));
  return effectList(path(entry, 'a:effectLst'), refCtx);
}

/** Points read per custom geometry for its coverage (design/27 §12: ≤ 4,096 path points per path). */
const MAX_COVERAGE_POINTS = 4_096;
/**
 * Elements (sub-paths, commands with or without points, and their children) read per custom geometry
 * (design/27 §12: 64k path points per slide), so commands without points are bounded too.
 */
const MAX_COVERAGE_STEPS = 65_536;

/** The coverage of each `a:custGeom` read so far: an inherited one is rated for every inheriting shape. */
const coverageCache = new WeakMap<XNode, number | undefined>();

/**
 * The share of its box an `a:custGeom` fills: the shoelace area of each sub-path (curves by their end
 * points), summed and capped at 1, over the path's own size. Undefined when a point is not a number (a guide
 * name), a path has no size, or the paths hold more than `MAX_COVERAGE_POINTS` points or
 * `MAX_COVERAGE_STEPS` elements in all. Memoised per node.
 */
export function pathCoverage(geom: XNode | undefined): number | undefined {
  if (!geom) return undefined;
  if (coverageCache.has(geom)) return coverageCache.get(geom);
  const v = coverageOf(geom);
  coverageCache.set(geom, v);
  return v;
}

function coverageOf(geom: XNode): number | undefined {
  let total = 0;
  let points = 0;
  let steps = 0;
  for (const p of child(geom, 'a:pathLst')?.children ?? []) {
    if (++steps > MAX_COVERAGE_STEPS) return undefined;
    if (p.name !== 'a:path') continue;
    if (p.attrs.fill === 'none') continue;
    const w = num(p.attrs.w);
    const h = num(p.attrs.h);
    if (!w || !h || w <= 0 || h <= 0) return undefined;
    let area = 0;
    let sub = 0;
    let first: [number, number] | undefined;
    let last: [number, number] | undefined;
    const close = () => {
      if (first && last) sub += last[0] * first[1] - first[0] * last[1];
      area += Math.abs(sub) / 2;
      sub = 0;
      first = last = undefined;
    };
    for (const c of p.children) {
      // Every command counts, with or without points, and so does every child of one.
      steps += 1 + c.children.length;
      if (steps > MAX_COVERAGE_STEPS) return undefined;
      if (c.name === 'a:close') {
        close();
        continue;
      }
      if (c.name === 'a:moveTo') close();
      let pt: XNode | undefined;
      for (const n of c.children) if (n.name === 'a:pt') pt = n;
      if (!pt) {
        if (c.name === 'a:arcTo') return undefined;
        continue;
      }
      if (++points > MAX_COVERAGE_POINTS) return undefined;
      const x = num(pt.attrs.x);
      const y = num(pt.attrs.y);
      if (x === undefined || y === undefined) return undefined;
      if (last) sub += last[0] * y - x * last[1];
      else first = [x, y];
      last = [x, y];
    }
    close();
    total += area / (w * h);
  }
  return points ? Math.min(1, total) : undefined;
}
