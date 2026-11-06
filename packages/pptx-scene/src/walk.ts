/**
 * The shape-tree walk (design/27 §4 "Groups", "Master and layout decorations", "Alternate content",
 * "Inheritance").
 *
 * - Bottom first: the master's decorations, the layout's, then the slide's own shapes. Master and layout
 *   decorations are drawn unless `showMasterSp="0"` is on the slide (both) or the layout (the master's).
 *   Placeholders of layouts and masters are templates, never drawn.
 * - `mc:AlternateContent`: the first `mc:Choice` whose `Requires` prefixes are all understood, else
 *   `mc:Fallback`; never both.
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
import { blipReader, blipReaderOf, readPicture } from './picture.ts';
import { readShadow, readTextBody, textChars } from './text.ts';
import { child, num, path, type XNode } from './xml.ts';

/** Group nesting followed (design/27 §12). */
export const MAX_GROUP_DEPTH = 32;
/** Shape-tree elements read per slide, decorations included (design/27 §12). */
export const MAX_SHAPES_PER_SLIDE = 5_000;

/** Presets drawn natively in M1 (ordo's rect/ellipse/line and a rounded rect). */
export const M1_PRESETS: ReadonlySet<string> = new Set([
  'rect',
  'roundRect',
  'ellipse',
  'line',
  'straightConnector1',
]);

/**
 * `mc:Choice Requires` prefixes the walk understands: PowerPoint 2010 and 2013 shape extensions (media,
 * transitions). Anything else (a14 maths, aink ink, am3d models, cx chart extensions, v VML) takes the
 * Fallback, usually a picture of the same content.
 */
export const UNDERSTOOD_PREFIXES: ReadonlySet<string> = new Set(['p14', 'p15']);

const on = (v: string | undefined) => v === '1' || v === 'true';
const finite = (v: number | undefined, dflt: number) => (v !== undefined && Number.isFinite(v) ? v : dflt);

/** Mutable state of one slide's walk. */
export interface WalkState {
  out: Element[];
  count: number;
  groups: number;
  /** The slide's background, read once when a shape uses it (`useBgFill`). */
  background?: Fill;
}

/** Every element drawn on the slide, bottom first: master decorations, layout decorations, own shapes. */
export function walkSlide(ctx: SlideCtx): Element[] {
  const st: WalkState = { out: [], count: 0, groups: 0 };
  const shows = (n: XNode | undefined) => n?.attrs.showMasterSp !== '0' && n?.attrs.showMasterSp !== 'false';
  const tree = (n: XNode | undefined) => path(n, 'p:cSld', 'p:spTree');
  if (shows(ctx.slide)) {
    if (shows(ctx.layout)) walkTree(ctx, tree(ctx.master), 'master', IDENTITY, undefined, 0, st);
    walkTree(ctx, tree(ctx.layout), 'layout', IDENTITY, undefined, 0, st);
  }
  walkTree(ctx, tree(ctx.slide), 'slide', IDENTITY, undefined, 0, st);
  return st.out;
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

/** The branch of an `mc:AlternateContent` to read: the first understood Choice, else the Fallback. */
export function alternateBranch(ac: XNode): XNode | undefined {
  for (const c of ac.children) {
    if (c.name !== 'mc:Choice') continue;
    const req = (c.attrs.Requires ?? '').split(/\s+/).filter(Boolean);
    if (req.length && req.every((p) => UNDERSTOOD_PREFIXES.has(p))) return c;
  }
  return child(ac, 'mc:Fallback');
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
      if (depth >= MAX_GROUP_DEPTH) continue;
      walkTree(ctx, alternateBranch(el), from, map, group, depth + 1, st, inherit);
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
        break;
      }
      case 'p:pic': {
        const pic = readPicture(ctx, el, base);
        if (pic) {
          if (pic.kind === 'picture') {
            const line = readLine(ctx, chain);
            if (line) pic.line = line;
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
  const coverage = geom === 'custom' ? pathCoverage(firstChildOf(spPrChain(chain), 'a:custGeom')) : undefined;
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
  const shadow = shadowOf(ctx, chain);
  const reasons: string[] = [];
  let support: Support = 'native';
  if (geom === 'custom') reasons.push('custGeom');
  else if (!M1_PRESETS.has(geom)) reasons.push(`preset:${geom}`);
  if (fill.kind === 'gradient') reasons.push('gradFill');
  if (fill.kind === 'pattern') reasons.push('pattFill');
  if (line?.dash || line?.head || line?.tail) reasons.push('lineStyle');
  if (reasons.length) support = 'approx';
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
    ...(shadow ? { shadow } : {}),
    ...(text && chars ? { text } : {}),
    ...(coverage !== undefined ? { coverage } : {}),
    support,
    ...(reasons.length ? { reasons } : {}),
  };
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
  const dash = childAttr('a:prstDash', 'val');
  if (dash && dash !== 'solid') out.dash = dash.slice(0, 20);
  const head = childAttr('a:headEnd', 'type');
  if (head && head !== 'none') out.head = head.slice(0, 20);
  const tail = childAttr('a:tailEnd', 'type');
  if (tail && tail !== 'none') out.tail = tail.slice(0, 20);
  return out;
}

/** A shape's outer shadow: the nearest `a:effectLst` along the chain decides, else the style's `a:effectRef`. */
function shadowOf(ctx: SlideCtx, c: Chain): ShapeElement['shadow'] {
  for (const n of nodes(c)) {
    const lst = child(spPrOf(n), 'a:effectLst');
    if (lst) return readShadow(child(lst, 'a:outerShdw'), ctx.color);
  }
  const ref = child(styleOf(c), 'a:effectRef');
  const idx = num(ref?.attrs.idx) ?? 0;
  const entry = idx > 0 && idx <= 3 ? ctx.theme.effects[idx - 1] : undefined;
  if (!entry) return undefined;
  const refCtx = withPhClr(ctx.color, colorIn(ref, ctx.color));
  return readShadow(path(entry, 'a:effectLst', 'a:outerShdw'), refCtx);
}

/** Points read per custom geometry for its coverage (design/27 §12: ≤ 4,096 path points per path). */
const MAX_COVERAGE_POINTS = 4_096;

/**
 * The share of its box an `a:custGeom` fills: the shoelace area of each sub-path (curves by their end
 * points), summed and capped at 1, over the path's own size. Undefined when a point is not a number (a guide
 * name) or a path has no size.
 */
export function pathCoverage(geom: XNode | undefined): number | undefined {
  let total = 0;
  let points = 0;
  for (const p of child(geom, 'a:pathLst')?.children ?? []) {
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
      if (c.name === 'a:close') {
        close();
        continue;
      }
      if (c.name === 'a:moveTo') close();
      const pts = c.children.filter((n) => n.name === 'a:pt');
      const pt = pts[pts.length - 1];
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
