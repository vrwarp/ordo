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
 *   a box and a rotation), and a box turned by 45° up to 135° (or 225° up to 315°) takes the scales the
 *   other way round. A child the plain composed affine would shear (rotated in a group scaled unevenly) is
 *   approx (reason 'shear'): placed as LibreOffice 24.2 places it, measured with a probe deck.
 * - Graphic frames are residual (charts, OLE), except tables, which `tables.ts` reads (M6): each table's
 *   objects form a group of their own, or join the top-level group they are in; and SmartArt whose deck
 *   holds PowerPoint's drawing of it (M6, `smartart.ts`): its shapes are read like these, as the frame's
 *   own group.
 * - M9 seams (`conv-seams`): a chart frame goes through `chart.ts` `readChart` and an OLE frame through
 *   `ole.ts` `readOle` first (residual when they read nothing, as every one does until `charts-conv` and
 *   `metafile-a`), and every shape and picture through `three3d.ts` `read3d` (its 3-D, until `three-model`
 *   none: real 3-D is drawn flat, approx `3d`, `classify.ts`).
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
import type {
  Affine,
  Element,
  ElementBase,
  CustomPaths,
  Fill,
  Line,
  RasterCandidate,
  ShapeElement,
  Support,
} from './ir.ts';
import { RASTER_POINTS, rawPointCost } from './raster.ts';
import { chooseAlternate } from './markup.ts';
import { CANVAS_H, CANVAS_W } from '@ordo/renderer/geom/bounds.ts';
import {
  type DrawnGeom,
  type DrawSpec,
  drawCost,
  GEOM_COST,
  maskCost,
  slowGradient,
} from '@ordo/renderer/geom/cost.ts';
import { outlineOf } from '@ordo/renderer/geom/outline.ts';
import {
  customPaths,
  drawSpecOf,
  knownPreset,
  MAX_SLIDE_PATH_POINTS,
  outlineFields,
  placeConnectors,
  presetDrawn,
  readCxnRef,
} from './geom.ts';
import { readChart } from './chart.ts';
import { readOle } from './ole.ts';
import { blipReader, blipReaderOf, readPicture } from './picture.ts';
import { readSmartArt, type Walker } from './smartart.ts';
import { readTable } from './tables.ts';
import { readShadow, readTextBody, textChars } from './text.ts';
import { read3d } from './three3d.ts';
import { missingEntry } from '@ordo/domain/missing.ts';
import { child, num, path, pathCommands, type XNode } from './xml.ts';

/** Group nesting followed (design/27 §12). */
export const MAX_GROUP_DEPTH = 32;
/**
 * Shape-tree elements read per slide, decorations included (design/27 §12; design/29 B3: 5,000 until the packed reader). It is the
 * walk's own count, shared by the text rescue and a SmartArt drawing. What protects memory is not this count but the reader's
 * element bound (`MAX_PACKED_ELEMENTS_PER_PART`): 50,000 ordinary shapes are about 650,000 elements and are refused by it first,
 * so this count binds only for shapes of one to nine elements. What a slide read in full still loses is the converter's own
 * bounds, not this track's: the emitter's 1,000 objects (`MAX_OBJECTS`) and 65,536 path points a slide (`MAX_SLIDE_PATH_POINTS`).
 */
export const MAX_SHAPES_PER_SLIDE = 50_000;

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
/** The three counters the walk charges a slide's custom geometry and drawing against (`WalkState` is one). */
export interface Ledger {
  points?: number;
  geomCost?: number;
  floors?: number;
}

export interface WalkState extends Ledger {
  out: Element[];
  count: number;
  groups: number;
  /** The slide's background, read once when a shape uses it (`useBgFill`). */
  background?: Fill;
  /** Custom geometry points so far (design/27 §12: 64k per slide; M6). */
  points?: number;
  /**
   * Drawing estimates of what is drawn natively so far, the background's first (`GEOM_COST.slide`,
   * `chargeDrawing`).
   */
  geomCost?: number;
  /**
   * The legacy copies of what is kept so far (renderer `geom/cost.ts` `slidePlan`'s floor: every drawer draws
   * at least these, counted first and never refused), the background's first (`chargeDrawing`,
   * `chargeFloor`).
   */
  floors?: number;
  /** SmartArt drawings read so far (M6, `smartart.ts`: `ElementBase.diagram` numbers them). */
  diagrams?: number;
  /**
   * Q53 (`ParseOptions.rasters`): 'plan' marks the shapes the planner may draw into pictures and keeps them out of
   * the counters above, 'detect' only marks them (the counters stay as today's).
   */
  rasters?: 'plan' | 'detect';
  /** The threshold of the census sweep (`ParseOptions.rasterPoints`); undefined: `RASTER_POINTS`. */
  rasterPoints?: number;
  /**
   * With 'plan', the counters as TODAY's converter keeps them (every shape charged, the candidates included): what a
   * candidate gets as its put-back form (`RasterCandidate.today`) is worked out against them, exactly as it is today.
   */
  today?: Ledger;
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
export function walkSlide(ctx: SlideCtx, stats?: { points: number }): Element[] {
  const st: WalkState = { out: [], count: 0, groups: 0 };
  if (ctx.rasters) st.rasters = ctx.rasters;
  if (ctx.rasters && ctx.rasterPoints !== undefined) st.rasterPoints = ctx.rasterPoints;
  // The background is emitted under everything, a full-slide fill laid on white (`emit.ts`
  // `emitBackground`): its pixels are charged first, as every drawer's budget counts them.
  const bg = readBackground(ctx).fill;
  st.geomCost = backgroundCost(bg);
  st.floors = backgroundCost(bg, true);
  if (st.rasters === 'plan') st.today = { points: 0, geomCost: st.geomCost, floors: st.floors };
  if (shows(ctx.slide)) decorations(ctx, st);
  walkTree(ctx, treeOf(ctx.slide), 'slide', IDENTITY, undefined, 0, st);
  // Connector ends glued to shapes move to their connection sites (M6).
  placeConnectors(st.out);
  // The path points the shapes that stay shapes use (the planner's put-back forms are worked out after them).
  if (stats) stats.points = st.points ?? 0;
  return st.out;
}

/**
 * What drawing a slide's background costs as emitted (renderer `geom/cost.ts` `drawCost`): a full-slide rect,
 * opaque (a colour or a gradient laid on white; a picture's white under it), at most the canvas. `legacy`:
 * as its legacy copy (a colour).
 */
function backgroundCost(fill: Fill, legacy = false): number {
  const g = presetDrawn('rect', undefined, CANVAS_W, CANVAS_H);
  const gradient = fill.kind === 'gradient' && !legacy;
  return drawCost(g, {
    fill: true,
    paint: {
      gradient,
      ...(gradient && slowGradient(fill.stops.slice(0, 16)) ? { slow: true } : {}),
      ...(gradient && fill.path !== undefined ? { radial: true } : {}),
      translucent: false,
    },
    place: { box: { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H } },
  });
}

/** The master's and layout's decorations as one slide's walk leaves them, with the notes it logged. */
interface Decorations {
  out: Element[];
  count: number;
  groups: number;
  notes: string[];
  points: number;
  geomCost: number;
  floors: number;
  /** With rasters planned: what the decorations charge the 'today' counters. */
  today?: { points: number; geomCost: number; floors: number };
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
  const key =
    [...ctx.color.map.values()].join(' ') +
    (st.rasters ? `|rasters:${st.rasters}${st.rasterPoints !== undefined ? `:${st.rasterPoints}` : ''}` : '');
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
    // What the decorations charge on top of this slide's background.
    st.geomCost = (st.geomCost ?? 0) + known.geomCost;
    st.floors = (st.floors ?? 0) + known.floors;
    if (st.today && known.today) {
      st.today.points = known.today.points;
      st.today.geomCost = (st.today.geomCost ?? 0) + known.today.geomCost;
      st.today.floors = (st.today.floors ?? 0) + known.today.floors;
    }
    return;
  }
  const notes: string[] = [];
  const before = st.geomCost ?? 0;
  const floorsBefore = st.floors ?? 0;
  const todayBefore = st.today ? { g: st.today.geomCost ?? 0, f: st.today.floors ?? 0 } : undefined;
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
  byKey.set(key, {
    out: st.out.slice(),
    count: st.count,
    groups: st.groups,
    notes,
    points: st.points ?? 0,
    geomCost: (st.geomCost ?? 0) - before,
    floors: (st.floors ?? 0) - floorsBefore,
    ...(st.today && todayBefore
      ? {
          today: {
            points: st.today.points ?? 0,
            geomCost: (st.today.geomCost ?? 0) - todayBefore.g,
            floors: (st.today.floors ?? 0) - todayBefore.f,
          },
        }
      : {}),
  });
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

/** How far a group's scale may be from 1 and still count as none (`boxAffine`). */
const UNSCALED = 1e-9;

/**
 * The unit-square affine of an `a:xfrm` box in a tree whose coordinates `map` takes to the slide: the box's
 * centre goes through `map`, its sides are scaled by `map`'s own axis scales, then its rotation and flips
 * apply, then `map`'s rotation and flips. The same as `map ∘ xfrmAffine(x)` unless the box is rotated in a
 * tree scaled unevenly, where that would shear it.
 *
 * A box turned by 45° up to 135°, or 225° up to 315°, in a scaled tree has the scales swapped: its width
 * takes the tree's vertical scale and its height the horizontal one, so that it grows along the axis it
 * shows on the slide. That is how LibreOffice imports it, saying MSO does the same (oox
 * `Shape::createAndInsert`, `lcl_doSpecialMSOWidthHeightToggle`); a probe deck of turned children in
 * unevenly scaled, rotated, mirrored and nested groups draws as LibreOffice 24.2 draws it. (LibreOffice's
 * newer source also turns a swapped box in a mirrored tree a further half turn; 24.2 does not.)
 */
export function boxAffine(map: Affine, x: Xfrm): Affine {
  const sx = Math.hypot(map[0], map[1]);
  const sy = Math.hypot(map[2], map[3]);
  if (!(sx > 0 && sy > 0 && Number.isFinite(sx) && Number.isFinite(sy))) return multiply(map, xfrmAffine(x));
  const [cx, cy] = apply(map, x.x + x.cx / 2, x.y + x.cy / 2);
  const deg = Math.trunc(x.rot);
  const swap =
    (Math.abs(sx - 1) > UNSCALED || Math.abs(sy - 1) > UNSCALED) &&
    ((deg >= 45 && deg < 135) || (deg >= 225 && deg < 315));
  const w = x.cx * (swap ? sy : sx);
  const h = x.cy * (swap ? sx : sy);
  // The box about the origin, then map's rotation and flips (its columns made unit length).
  const local = xfrmAffine({ ...x, x: -w / 2, y: -h / 2, cx: w, cy: h });
  const m = multiply([map[0] / sx, map[1] / sx, map[2] / sy, map[3] / sy, 0, 0], local);
  return [m[0], m[1], m[2], m[3], m[4] + cx, m[5] + cy];
}

/** What a group passes to its children. */
export interface GroupInherit {
  /** What `a:grpFill` stands for. */
  fill?: Fill;
  /** The group itself would be sheared: its children are placed as LibreOffice places them (approx). */
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
      // W10 (design/29 section 3): what the cap leaves out is listed on the slide.
      (ctx.cut ??= new Set()).add(missingEntry('element', 'shapes'));
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
      ...(place.flipH ? { ownFlipH: true as const } : {}),
      ...(place.flipV ? { ownFlipV: true as const } : {}),
      support: 'native',
    };
    const at = st.out.length;
    switch (el.name) {
      case 'p:sp':
      case 'p:cxnSp': {
        const shape = readShape(ctx, el, base, chain, st, groupFill);
        if (shape) {
          // M9 (`three-model`): the shape's 3-D.
          const look3d = read3d(ctx, chain);
          if (look3d) shape.look3d = look3d;
          st.out.push(shape);
        }
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
            // M9 (`three-model`): the picture's 3-D.
            const look3d = read3d(ctx, chain);
            if (look3d) pic.look3d = look3d;
            const line = readLine(ctx, chain);
            if (line) pic.line = line;
            const custNode = pic.geom === 'custom' ? firstChildOf(spPrChain(chain), 'a:custGeom') : undefined;
            // The mask is filled once; the outline is a stroke-only shape along the same geometry (`emit.ts`
            // `emitPicture`): its points are stored twice.
            const outline = line ? outlineOf(outlineFields(ctx.frame, line)) : undefined;
            const rate = (g: DrawnGeom) =>
              maskCost(g) + (outline ? drawCost(g, { fill: false, outline }) : 0);
            // Its legacy copy: the picture without its mask (free), its outline a plain one around its box.
            const floor = outline ? legacyCost(ctx, base.xf, { fill: false, outline }) : 0;
            if (custNode) {
              pic.custom = slideCustom(ctx, custNode, base, st, rate, line ? 2 : 1, floor);
              if (pic.custom.over) {
                pic.support = pic.support === 'residual' ? 'residual' : 'approx';
                pic.reasons = [...(pic.reasons ?? []), 'mask:custom'];
              }
            } else if (pic.geom !== 'rect' || line) {
              const p = decompose(base.xf);
              const g = presetDrawn(pic.geom, pic.adj, p.w * ctx.frame.s, p.h * ctx.frame.s);
              // Past the budget it is kept whole, charged as its legacy copy: the emitted slide's own plan
              // (`emit.ts` `fitDrawing`) names it, drawn whole from a geometry unit on outputs and as its
              // legacy shape elsewhere (M9, `decor-conv`).
              chargeShape(st, rate(g), floor);
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
        // M9 seams: a chart or an OLE object ordo reads (`chart.ts`, `ole.ts`; none yet), else residual.
        const read =
          what === 'chart'
            ? readChart(ctx, el, from, base)
            : what === 'ole'
              ? readOle(ctx, el, from, base)
              : undefined;
        if (read) {
          st.out.push(read);
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
    // A child the composed affine would shear is placed by `boxAffine`, as LibreOffice places it; whether
    // PowerPoint places every such child so is not measured: approx.
    if (sheared && el.name !== 'p:grpSp' && st.out.length > at) {
      ctx.log('a shape turned in an unevenly scaled group is placed as LibreOffice places it');
      for (let i = at; i < st.out.length; i++) {
        const e = st.out[i]!;
        if (e.support === 'native') e.support = 'approx';
        e.reasons = [...(e.reasons ?? []).filter((r) => r !== 'shear'), 'shear'];
      }
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

/** The nearest `p:spPr` fill along the chain (`a:noFill` included), or undefined when none sets one. */
function spPrFillOf(ctx: SlideCtx, c: Chain): Fill | undefined {
  for (const [n, part] of chainParts(ctx, c)) {
    const f = readFill(spPrOf(n), ctx.color, blipReaderOf(ctx, part));
    if (f) return f;
  }
  return undefined;
}

/** The fill of a shape's style (`p:style` `a:fillRef`), what it draws when no `p:spPr` sets one. */
function styleFillOf(ctx: SlideCtx, c: Chain): Fill | undefined {
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
  // `useBgFill` (LibreOffice pptshapegroupcontext.cxx): the slide's background only where no `p:spPr` along
  // the chain sets a fill of its own (`a:noFill` or none; the style's `a:fillRef` does not count). An explicit
  // fill wins, as LibreOffice draws it: a Designer layout's full-slide "decorative" rect with useBgFill="1"
  // and a tx1 solidFill is the dark panel its light text sits on.
  const ownFill = spPrFillOf(ctx, chain);
  let fill = ownFill ?? styleFillOf(ctx, chain) ?? { kind: 'none' };
  if (on(el.attrs.useBgFill) && (!ownFill || ownFill.kind === 'none')) {
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
  // What drawing it costs as `emit.ts` emits it (renderer `geom/cost.ts`): the shape object (fill, outline,
  // effects), and a picture fill's picture clipped to the same geometry.
  const spec = drawSpecOf(ctx.frame, { fill, ...(line ? { line } : {}), ...fx }, base.xf);
  const pictureFill = fill.kind === 'picture';
  const rate = (g: DrawnGeom) => drawCost(g, spec) + (pictureFill ? maskCost(g) : 0);
  // What it draws at least, past any budget (`slidePlan`'s floor): its legacy shape.
  const floor = legacyCost(ctx, base.xf, spec);
  const read = custNode
    ? slideCustomR(ctx, custNode, base, st, rate, pictureFill && line ? 2 : 1, floor, true)
    : undefined;
  const custom = read?.custom;
  if (!custNode && (fill.kind !== 'none' || line)) {
    const p = decompose(base.xf);
    const g = presetDrawn(geom, adj, p.w * ctx.frame.s, p.h * ctx.frame.s);
    // M9 (`decor-conv`, decisions.md "Slow-to-draw elements"): a shape past the slide's drawing budget (its
    // pixels, its outline, dashes or arrowheads) is kept whole, never sent to the art: the budget decides how
    // it is drawn, not whether. It is charged as its legacy copy (what every drawer draws at least), and the
    // emitted slide's own plan (`emit.ts` `fitDrawing`) names it: each drawer draws it natively where the
    // slide's plan has room, else the outputs draw it whole from a geometry unit and every other drawer as its
    // legacy shape.
    chargeShape(st, rate(g), floor);
  }
  // A shape not drawn natively but still emitted (`emit.ts`: its legacy rect, ellipse or line, under its text)
  // is charged as that legacy shape: every drawer draws it, and no budget refuses it (renderer
  // `geom/cost.ts` `slidePlan` counts it first).
  if (!pictureFill) {
    // A candidate the pictures may take charges only the 'today' counters (`slideCustomR`).
    if (custom?.over === true && !(read?.cand && st.today)) chargeFloor(st, floor);
    if (st.today && read?.shadow?.over === true) chargeFloor(st.today, floor);
  }
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
    ...(read?.cand ? { rasterOf: read.cand } : {}),
    ...(fx.glow ? { glow: fx.glow } : {}),
    ...(fx.softEdge ? { softEdge: fx.softEdge } : {}),
    ...(cxn ? { cxn } : {}),
  };
}

/**
 * A custom geometry built for an element (`geom.ts`), its points (times `times`: the objects that store
 * them) counted against the slide's 64k, its fill estimate against `GEOM_COST.geometry` and what drawing it
 * costs as emitted (`rate`: renderer `geom/cost.ts` `drawCost`, fill, outline and effects, with
 * `GEOM_COST.point` a stored point) against the slide's `GEOM_COST.slide` (`chargeDrawing`). Past the slide's
 * points it is over the bounds (residual), and charges nothing. Past the drawing budgets (M9, `decor-conv`,
 * decisions.md "Slow-to-draw elements") it is kept whole (`complex`), charged as its legacy copy (`floor`):
 * the renderer, which holds a slide to the same budgets the same way (`geom/cost.ts` `slidePlan`,
 * `geombudget.ts`), draws it whole from a geometry unit on outputs and as its legacy shape elsewhere (the
 * legacy values of `emit.ts` `emitShape`: a line for line art); past `GEOM_COST.geometry` alone (`stored.ts`)
 * every drawer draws its legacy shape until the slide's decoration plate holds it. The emitted slide's plan
 * names it (`emit.ts` `fitDrawing`). Its compile notes go to the slide's log.
 */
export function slideCustom(
  ctx: SlideCtx,
  node: XNode,
  base: ElementBase,
  st: WalkState,
  rate?: (g: DrawnGeom) => number,
  times = 1,
  floor?: number,
) {
  return slideCustomR(ctx, node, base, st, rate, times, floor, false).custom;
}

/** What `slideCustomR` read: the geometry as the shape gets it, the candidate mark and the 'today' result. */
export interface CustomRead {
  custom: CustomPaths;
  /** Q53: the shape is a picture candidate (`ParseOptions.rasters`). */
  cand?: RasterCandidate;
  /** With rasters planned: what today's counters (every shape charged) gave this shape. */
  shadow?: CustomPaths;
}

const SAY_NOTHING = (_m: string): void => undefined;

/**
 * The charges of `slideCustom` on one set of counters: a custom geometry's points (times `times`) against the
 * slide's 64k (past them it is over the bounds and charges nothing), its drawing against the budgets. `say` hears the
 * messages the walk logs.
 */
function chargeCustom(
  say: (msg: string) => void,
  led: Ledger,
  custom: CustomPaths,
  times: number,
  floor: number | undefined,
): CustomPaths {
  if (custom.over) return custom;
  const points = custom.points * times;
  if ((led.points ?? 0) + points > MAX_SLIDE_PATH_POINTS) {
    say(`more than ${MAX_SLIDE_PATH_POINTS} path points: further custom geometry is drawn by LibreOffice`);
    return { ...custom, over: true };
  }
  // A margin under the renderer's budgets, for the rounding of the stored coordinates.
  const costly = (custom.fillCost ?? 0) > GEOM_COST.geometry * COST_MARGIN;
  if (costly)
    say(
      "a custom geometry too costly to draw at once (its edges cross the box many times) is drawn as its legacy shape until the slide's decoration plate holds it",
    );
  led.points = (led.points ?? 0) + points;
  if (costly || !chargeDrawing(led, (custom.cost ?? 0) + points * GEOM_COST.point, floor)) {
    chargeFloor(led, floor ?? 0);
    return { ...custom, complex: true };
  }
  return custom;
}

/**
 * `slideCustom` with the picture candidates of Q53 (`ParseOptions.rasters`, C-SR2). Without rasters it is the one
 * function it always was. With 'detect' a shape past `RASTER_POINTS` (the raw cost of its commands, an arc 12, before
 * any cut), past a geometry limit or refused by the slide total is only MARKED: the counters, the notes and the shape
 * are today's. With 'plan' a marked shape charges NEITHER the slide total NOR the drawing budget (the pictures
 * take it, so the shapes that stay shapes keep their room); what it is given if no picture takes it is worked out
 * against 'today' counters that charge every shape, so it is exactly what today's converter gives it, and its notes
 * wait on the mark (`RasterCandidate.notes`) for the caller to say them if it stays a shape.
 */
export function slideCustomR(
  ctx: SlideCtx,
  node: XNode,
  base: ElementBase,
  st: WalkState,
  rate: ((g: DrawnGeom) => number) | undefined,
  times: number,
  floor: number | undefined,
  shape: boolean,
): CustomRead {
  const p = decompose(base.xf);
  const custom = customPaths(node, p.w, p.h, ctx.frame.s, rate);
  const say = (m: string) => ctx.log(m);
  const mark = shape && st.rasters !== undefined;
  if (!mark) {
    for (const n of custom.notes) ctx.log(`custom geometry: ${n}`);
    const result = chargeCustom(say, st, custom, times, floor);
    const shadow = st.today ? chargeCustom(SAY_NOTHING, st.today, custom, times, floor) : undefined;
    return { custom: result, ...(shadow ? { shadow } : {}) };
  }
  const raw = rawPointCost(node);
  const cost = raw.points;
  const limit = st.rasterPoints ?? RASTER_POINTS;
  if (st.rasters === 'detect') {
    for (const n of custom.notes) ctx.log(`custom geometry: ${n}`);
    const result = chargeCustom(say, st, custom, times, floor);
    const why =
      raw.capped || cost > limit ? 'points' : custom.over ? 'limit' : result.over ? 'total' : undefined;
    return why
      ? { custom: result, cand: { raw: cost, why, times, today: result, node } }
      : { custom: result };
  }
  const customNotes = custom.notes.map((n) => `custom geometry: ${n}`);
  const todayNotes: string[] = [];
  const shadow = chargeCustom((m) => todayNotes.push(m), st.today!, custom, times, floor);
  const why =
    raw.capped || cost > limit ? 'points' : custom.over ? 'limit' : shadow.over ? 'total' : undefined;
  if (!why) {
    for (const n of customNotes) ctx.log(n);
    // A shape the pictures never take is charged for real, with the messages of its own charge.
    const result = chargeCustom(say, st, custom, times, floor);
    return { custom: result, shadow };
  }
  return {
    custom: shadow,
    shadow,
    cand: { raw: cost, why, times, today: shadow, node, notes: [...customNotes, ...todayNotes] },
  };
}

/** `chargeDrawing`, else the floor, on the walk's counters and (with rasters planned) on today's. */
function chargeShape(st: WalkState, cost: number, floor: number): void {
  if (!chargeDrawing(st, cost, floor)) chargeFloor(st, floor);
  if (st.today && !chargeDrawing(st.today, cost, floor)) chargeFloor(st.today, floor);
}

/**
 * Charges what drawing an element costs (`drawCost`, its stored points' share included) against the slide's
 * `GEOM_COST.slide` (within COST_MARGIN of it), and its legacy copy (`floor`, default `cost`) against the
 * floors: false, with nothing charged, past it.
 */
function chargeDrawing(st: Ledger, cost: number, floor = cost): boolean {
  const total = (st.geomCost ?? 0) + cost;
  if (!(total <= GEOM_COST.slide * COST_MARGIN)) return false;
  st.geomCost = total;
  st.floors = (st.floors ?? 0) + floor;
  return true;
}

/**
 * Charges an element the drawing budget cannot take whole as its legacy copy (`floor`), what every drawer
 * draws for it at least (renderer `geom/cost.ts` `slidePlan`: counted first and never refused). Since M9
 * (`decor-conv`, decisions.md "Slow-to-draw elements") such an element is always kept whole: past the floors
 * too (a stack of full-slide fills: 140 legacy fills took 300 ms at 4K) the outputs draw it whole from a
 * geometry unit made in slices (renderer `units.ts`), later from the slide's decoration plate, and every
 * other drawer as its legacy shape, never LibreOffice.
 */
function chargeFloor(st: Ledger, floor: number): void {
  st.floors = (st.floors ?? 0) + floor;
  st.geomCost = (st.geomCost ?? 0) + floor;
}

/**
 * What an element's legacy copy costs (renderer `geom/cost.ts` `slidePlan`'s floor, `withoutPart` 'both'): a
 * rect of its box in its legacy colour with a plain outline, without effects, what every drawer draws for it
 * at least. A rect for every legacy kind (an ellipse or a line costs no more).
 */
function legacyCost(ctx: SlideCtx, xf: Affine, spec: DrawSpec): number {
  const p = decompose(xf);
  const g = presetDrawn('rect', undefined, p.w * ctx.frame.s, p.h * ctx.frame.s);
  const o = spec.outline;
  return drawCost(g, {
    fill: spec.fill,
    paint: { translucent: spec.paint?.translucent !== false },
    ...(spec.place ? { place: spec.place } : {}),
    ...(o ? { outline: { width: o.width, join: 'miter', cap: 'butt', miterLimit: o.miterLimit } } : {}),
  });
}

/** The share of the renderer's drawing budgets the converter fills (rounding of stored coordinates aside). */
const COST_MARGIN = 0.98;

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
    for (const c of pathCommands(p)) {
      // Every command counts, with or without points, and so does every child of one.
      steps += 1 + c.kids;
      if (steps > MAX_COVERAGE_STEPS) return undefined;
      if (c.name === 'a:close') {
        close();
        continue;
      }
      if (c.name === 'a:moveTo') close();
      const pt = c.pts[c.pts.length - 1];
      if (!pt) {
        if (c.name === 'a:arcTo') return undefined;
        continue;
      }
      if (++points > MAX_COVERAGE_POINTS) return undefined;
      const x = num(pt[0]);
      const y = num(pt[1]);
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
