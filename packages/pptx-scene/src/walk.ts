/**
 * The shape-tree walk (design/27 §4 "Groups", "Master and layout decorations", "Alternate content").
 *
 * Owned by work item C (inherit-emit). The scaffold walks master and layout decorations (honouring
 * `showMasterSp`) then the slide's own shapes, flattening groups through their child space, and reads
 * shapes (preset, solid fill and line, style references) and pictures, and takes `mc:Fallback` of
 * `mc:AlternateContent`. Still to do: the first understood `mc:Choice` (else the Fallback; never both),
 * placeholders without a position, empty placeholders, sheared children as residual, effects (outer
 * shadow), lines and connectors at any angle.
 */
import { readFill, styleFill, withPhClr, colorIn } from './color.ts';
import type { SlideCtx, Source } from './context.ts';
import { childSpace, IDENTITY, multiply, xfrmAffine, type Xfrm } from './frame.ts';
import { chainOf, inheritedXfrm, nvOf, spPrOf } from './inherit.ts';
import type { Affine, Element, ElementBase, Fill, Line, ShapeElement, Support } from './ir.ts';
import { blipReader, readPicture } from './picture.ts';
import { plainText, readTextBody } from './text.ts';
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

const on = (v: string | undefined) => v === '1' || v === 'true';

interface WalkState {
  out: Element[];
  count: number;
  groups: number;
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
    x: num(off?.attrs.x) ?? 0,
    y: num(off?.attrs.y) ?? 0,
    cx: num(ext?.attrs.cx) ?? 0,
    cy: num(ext?.attrs.cy) ?? 0,
    rot: (num(x?.attrs.rot) ?? 0) / 60_000,
    flipH: on(x?.attrs.flipH),
    flipV: on(x?.attrs.flipV),
  };
}

/**
 * Walk one shape tree (`p:spTree` or a `p:grpSp`). `map` takes the tree's coordinates to slide EMU;
 * `group` is the flattened group number of a top-level group's members.
 */
export function walkTree(
  ctx: SlideCtx,
  tree: XNode | undefined,
  from: Source,
  map: Affine,
  group: number | undefined,
  depth: number,
  st: WalkState,
): void {
  for (const el of tree?.children ?? []) {
    if (el.name === 'mc:AlternateContent') {
      // Scaffold: the Fallback only (work item C picks the first mc:Choice it understands, never both).
      walkTree(ctx, child(el, 'mc:Fallback'), from, map, group, depth + 1, st);
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
    const xfrm = inheritedXfrm(chain);
    const xf = xfrm ? multiply(map, xfrmAffine(readXfrm(xfrm))) : map;
    const base: ElementBase = {
      shapeId: num(cNvPr?.attrs.id) ?? 0,
      name: cNvPr?.attrs.name ?? '',
      xf,
      from,
      ...(chain.ph ? { ph: chain.ph } : {}),
      ...(group !== undefined ? { group } : {}),
      ...(on(cNvPr?.attrs.hidden) ? { hidden: true } : {}),
      support: 'native',
    };
    switch (el.name) {
      case 'p:sp':
      case 'p:cxnSp':
        st.out.push(readShape(ctx, el, base, chain));
        break;
      case 'p:pic': {
        const pic = readPicture(ctx, el, base);
        if (pic) st.out.push(pic);
        break;
      }
      case 'p:grpSp': {
        if (depth >= MAX_GROUP_DEPTH) {
          ctx.log(`groups nested deeper than ${MAX_GROUP_DEPTH} are not drawn`);
          break;
        }
        const x = child(spPrOf(el), 'a:xfrm');
        const own = readXfrm(x);
        const chOff = child(x, 'a:chOff');
        const chExt = child(x, 'a:chExt');
        // A missing chExt is the ext and the other way round; a missing offset is the origin.
        const ext = { cx: num(chExt?.attrs.cx) ?? own.cx, cy: num(chExt?.attrs.cy) ?? own.cy };
        if (!own.cx && !own.cy) Object.assign(own, ext);
        const inner = childSpace(
          multiply(map, xfrmAffine(own)),
          { x: num(chOff?.attrs.x) ?? 0, y: num(chOff?.attrs.y) ?? 0 },
          ext,
        );
        walkTree(ctx, el, from, inner, group ?? ++st.groups, depth + 1, st);
        break;
      }
      case 'p:graphicFrame': {
        const uri = path(el, 'a:graphic', 'a:graphicData')?.attrs.uri ?? '';
        const what = uri.endsWith('/chart')
          ? 'chart'
          : uri.endsWith('/table')
            ? 'table'
            : uri.endsWith('/diagram')
              ? 'smartart'
              : uri.endsWith('/ole')
                ? 'ole'
                : 'graphicFrame';
        st.out.push({ ...base, kind: 'residual', what, support: 'residual', reasons: [what] });
        break;
      }
    }
  }
}

function readShape(
  ctx: SlideCtx,
  el: XNode,
  base: ElementBase,
  chain: ReturnType<typeof chainOf>,
): ShapeElement {
  const spPr = spPrOf(el);
  const style = child(el, 'p:style');
  const blip = blipReader(ctx, base.from);
  const prst = child(spPr, 'a:prstGeom')?.attrs.prst;
  const geom = prst ?? (child(spPr, 'a:custGeom') ? 'custom' : 'rect');
  const fill: Fill = readFill(spPr, ctx.color, blip) ??
    styleFill(ctx.theme, child(style, 'a:fillRef'), ctx.color, blip) ?? {
      kind: 'none',
    };
  const line = readLine(ctx, child(spPr, 'a:ln'), child(style, 'a:lnRef'));
  const text = readTextBody(ctx, chain);
  const reasons: string[] = [];
  if (!M1_PRESETS.has(geom)) reasons.push(`preset:${geom}`);
  if (fill.kind !== 'none' && fill.kind !== 'solid') reasons.push(`fill:${fill.kind}`);
  const support: Support = reasons.length ? 'approx' : 'native';
  return {
    ...base,
    kind: 'shape',
    geom,
    fill,
    ...(line ? { line } : {}),
    ...(text && plainText(text).length ? { text } : {}),
    support,
    ...(reasons.length ? { reasons } : {}),
  };
}

/** A shape's outline: its own `a:ln`, else the theme line its `a:lnRef` names. Undefined when none is drawn. */
function readLine(ctx: SlideCtx, ln: XNode | undefined, lnRef: XNode | undefined): Line | undefined {
  const idx = num(lnRef?.attrs.idx) ?? 0;
  const themeLn = idx > 0 ? ctx.theme.lines[idx - 1] : undefined;
  const refCtx = withPhClr(ctx.color, colorIn(lnRef, ctx.color));
  const fill = readFill(ln, ctx.color) ?? (themeLn ? readFill(themeLn, refCtx) : undefined);
  if (!fill || fill.kind === 'none') return undefined;
  const width = num(ln?.attrs.w) ?? num(themeLn?.attrs.w) ?? 12_700;
  return { width, fill };
}
