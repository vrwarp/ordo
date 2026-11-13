/**
 * The slide budgets (design/27 §5, §15 M9, `budget-decorations.md` §3.1, plan decision 3 step 1;
 * `decor-conv`): what keeps a slide within `MAX_SLIDE_OBJECTS` objects and `MAX_SLIDE_PICTURES` distinct
 * pictures while drawing all of it natively. Nothing goes to LibreOffice's art for a budget again, and nothing
 * is dropped because it is slow to draw (decisions.md "Slow-to-draw elements": the drawing budgets choose how
 * an element is drawn, plate or live, never whether).
 *
 * `fitBudgets` runs the reliefs in order, each after the first only while the slide is over the object
 * budget (`budgetCost`), stopping as soon as it fits; within a step the runs that save most go first:
 * 0. **cull** (`cullElements`, always): an element whose bounds, grown by its effects' and outline's reach,
 *    miss the slide area (`offSlide`; the deck's area, not the 1920 x 1080 frame), or a shape that shows
 *    nothing (`invisible`: no visible fill, line, text or effect), is treated as hidden: not emitted, counted,
 *    put in the art or its text. Clips, sounds and SmartArt drawings' elements are never culled;
 * 1. **tables and charts** are one object each (`ShapeObject.table`, `ShapeObject.chart`);
 * 2. **shapes of one look** merged as M6 merges them (`classify.ts` `shapeRuns`, `ShapeElement.merge`);
 * 3. **decorations**, narrow scope (`decor.ts` `decorRuns`: a SmartArt drawing, a top-level group, a
 *    layout's or master's decorations; `ElementBase.decor`), the shape runs worked out again around them;
 * 4. **composites** (`sheet.ts` `pictureRuns`: z-runs of plain pictures as one picture; `ElementBase.sheet`);
 * 5. **decorations**, wide scope (the source alone: the slide's own ungrouped shapes too); then, only for a
 *    slide still over with real 3-D on it, the 3-D shapes in decorations too, drawn flat
 *    (`3d:flat-in-decoration`; plan decision 6);
 * 6. **the text ceiling**: a slide whose objects left are text or nothing a step can merge keeps up to
 *    `MAX_SLIDE_OBJECTS_TEXT` (190);
 * 7. **the guard** (never reached in the corpus): past that, the topmost elements that are not text are
 *    left out until at most 190 such objects and `MAX_DRAWN_OBJECTS` (200, the render clamp) in all remain,
 *    then the topmost text; what is left out is culled as `budget` and listed (`Classification.missing`);
 * P. **the atlas** (`sheet.ts` `atlasParts`): past `MAX_SLIDE_PICTURES` distinct pictures the fewest
 *    smallest are packed into one (`Classification.atlas`); a slide an atlas cannot bring within it leaves
 *    its topmost pictures out (the guard's way).
 *
 * The budget halves of M6's art (`classify.ts` `fitTables`, `wholeDiagrams`' budget step, `fitShapes`,
 * M9 wave 1's `fit3d`) stay only behind `ParseOptions.budgetArt`, for the harness's A/B.
 *
 * Pure apart from the elements' marks; linear in the elements per step and run (each step's cost is worked
 * out again after each run it applies; runs are at most half the elements).
 */
import { MISSING_LIMITS, type MissingKind } from '@ordo/domain/missing.ts';
import {
  artRange,
  boundsOf,
  MAX_SLIDE_OBJECTS,
  MAX_SLIDE_PICTURES,
  overlaps,
  shapeRuns,
} from './classify.ts';
import type { SlideCtx } from './context.ts';
import { decorRuns } from './decor.ts';
import type { ArtRange, Background, Element, Frame, RectEmu, ShapeElement } from './ir.ts';
import { atlasParts, pictureRuns } from './sheet.ts';

/** Objects a slide whose objects past `MAX_SLIDE_OBJECTS` are all text (or unmergeable) may keep. */
export const MAX_SLIDE_OBJECTS_TEXT = 190;
/** The render clamp's objects (`@ordo/renderer` `CLAMP.maxObjects`): what the guard never passes. */
export const MAX_DRAWN_OBJECTS = 200;

/** What the budgets did to a slide (its notes say it; the census counts it). */
export interface BudgetPlan {
  culled: { offSlide: number; invisible: number };
  /** Shapes merged by look (`ShapeElement.merge`) and the objects they became. */
  merged: { shapes: number; objects: number };
  /** Shapes drawn as decorations and the decorations. */
  decorated: { shapes: number; decors: number };
  /** Pictures drawn as composites and the composites. */
  composited: { pictures: number; sheets: number };
  /** Real 3-D shapes drawn flat in decorations. */
  flat3d: number;
  /** Picture parts packed into an atlas. */
  atlas: string[];
  /** Elements the guard left out. */
  left: number;
  /** The slide's objects and distinct pictures once planned. */
  objects: number;
  pictures: number;
}

// ── Culling ─────────────────────────────────────────────────────────────────────────────────────────────

/** How far an element's drawing reaches past its bounds, in EMU: shadow, glow, half its outline. */
function reachOf(e: Element): number {
  let r = 0;
  if (e.kind === 'shape') {
    if (e.shadow) r = Math.max(r, Math.abs(e.shadow.dist) + Math.abs(e.shadow.blur));
    if (e.glow) r = Math.max(r, Math.abs(e.glow.radius));
  }
  const line = e.kind === 'shape' || e.kind === 'picture' ? e.line : undefined;
  if (line && line.fill.kind !== 'none') r = Math.max(r, Math.abs(line.width) / 2);
  return Number.isFinite(r) ? r : 0;
}

/** Whether a fill shows anything: not none, not fully transparent. */
function shows(f: ShapeElement['fill'] | undefined): boolean {
  if (!f) return false;
  switch (f.kind) {
    case 'none':
      return false;
    case 'solid':
      return f.color.a > 0;
    case 'gradient':
      return f.stops.some((s) => s.color.a > 0);
    case 'pattern':
      return f.fg.a > 0 || f.bg.a > 0;
    default:
      return true;
  }
}

/** A shape that shows nothing: no visible fill, line, text or effect. */
function invisible(e: Element): boolean {
  if (e.kind !== 'shape' || e.text || e.shadow || e.glow || e.softEdge || e.look3d) return false;
  if (shows(e.fill)) return false;
  return !(e.line && shows(e.line.fill));
}

/** Never culled: clips and sounds (their poster and `play`), and the elements of a SmartArt drawing. */
const keeps = (e: Element) => e.diagram !== undefined || (e.kind === 'picture' && e.media !== undefined);

/**
 * Cull a slide's elements (step 0): each one that draws nothing on the slide area (`frame.cx` x `frame.cy`
 * EMU) is marked `culled` and hidden. Per leaf, so a group across the edge keeps its visible members.
 */
export function cullElements(frame: Frame, elements: Element[]): BudgetPlan['culled'] {
  const out = { offSlide: 0, invisible: 0 };
  const area: RectEmu = { x: 0, y: 0, cx: frame.cx, cy: frame.cy };
  for (const e of elements) {
    if (e.hidden || keeps(e)) continue;
    let why: 'offSlide' | 'invisible' | undefined;
    if (invisible(e)) why = 'invisible';
    else {
      const b = boundsOf(e);
      const r = reachOf(e);
      const grown = { x: b.x - r, y: b.y - r, cx: b.cx + 2 * r, cy: b.cy + 2 * r };
      if ([grown.x, grown.y, grown.cx, grown.cy].every(Number.isFinite) && !overlaps(grown, area))
        why = 'offSlide';
    }
    if (!why) continue;
    e.culled = why;
    e.hidden = true;
    out[why]++;
  }
  return out;
}

// ── The cost ────────────────────────────────────────────────────────────────────────────────────────────

/** The picture part an element draws: a `p:pic`'s, or a shape's picture fill. */
function picturePart(e: Element): string | undefined {
  if (e.kind === 'picture') return e.picture.part;
  if (e.kind === 'shape' && e.fill.kind === 'picture') return e.fill.picture.part;
  return undefined;
}

/** The objects an element emits on its own (a shape with a fill or line and text is two). */
function ownObjects(e: Element): number {
  if (e.kind === 'picture' || e.kind === 'table' || e.kind === 'chart') return 1;
  if (e.kind === 'shape') return (e.fill.kind !== 'none' || e.line ? 1 : 0) + (e.text ? 1 : 0);
  return 0;
}

/** Whether an element holds text (a shape's text body, a table's cells), for the guard. */
const hasText = (e: Element) => (e.kind === 'shape' && !!e.text) || e.kind === 'table';

/**
 * What a slide costs as planned: its objects as version 1 draws them (the background one, a table or a chart
 * one, each run of merged shapes, each decoration and each composite one, and the elements of the art range
 * as themselves: version 1, and a hub without LibreOffice for good, draws them until the art replaces them,
 * which only lowers the count) and its distinct pictures (the background's, the art range's, the art one and
 * each composite one; the atlas's parts as one).
 */
export function budgetCost(
  elements: readonly Element[],
  background: Background,
  art: ArtRange | undefined,
  atlas: readonly string[] = [],
): { objects: number; pictures: number } {
  const inArt = new Set(art?.elements);
  const pictures = new Set<string>();
  const runs = new Set<string>();
  let objects = 0;
  let sheets = 0;
  if (background.fill.kind !== 'none') objects++;
  if (background.fill.kind === 'picture') pictures.add(background.fill.picture.part);
  elements.forEach((e, i) => {
    if (e.hidden || e.kind === 'residual') return;
    if (inArt.has(i)) {
      // The art's elements that are not residual elements (and the stand-ins of residual text) are drawn by
      // version 1, and by a hub without LibreOffice for good, until the art replaces them: as themselves.
      const part = picturePart(e);
      if (part !== undefined) pictures.add(part);
      objects += ownObjects(e);
      return;
    }
    if (e.sheet !== undefined) {
      if (!runs.has(`s${e.sheet}`)) {
        runs.add(`s${e.sheet}`);
        objects++;
        sheets++;
      }
      return;
    }
    const part = picturePart(e);
    if (part !== undefined) pictures.add(part);
    if (e.decor !== undefined) {
      if (!runs.has(`d${e.decor}`)) {
        runs.add(`d${e.decor}`);
        objects++;
      }
      return;
    }
    if (e.kind === 'shape' && e.merge !== undefined) {
      if (!runs.has(`m${e.merge}`)) {
        runs.add(`m${e.merge}`);
        objects++;
      }
      objects += e.text ? 1 : 0;
      return;
    }
    objects += ownObjects(e);
  });
  let distinct = pictures.size + sheets + (art ? 1 : 0);
  const packed = atlas.filter((p) => pictures.has(p)).length;
  if (packed > 1) distinct -= packed - 1;
  return { objects, pictures: distinct };
}

// ── The steps ───────────────────────────────────────────────────────────────────────────────────────────

/** Clear the merge marks and mark the shape runs (`shapeRuns`) of what no decoration or composite holds. */
function markShapeRuns(elements: Element[], frame: Frame, inArt: ReadonlySet<number>): void {
  const exclude = new Set(inArt);
  elements.forEach((e, i) => {
    if (e.kind === 'shape') delete e.merge;
    if (e.decor !== undefined || e.sheet !== undefined) exclude.add(i);
  });
  for (const run of shapeRuns(elements, frame, exclude))
    for (const i of run) (elements[i] as ShapeElement).merge = run[0]!;
}

function clearMerges(elements: Element[]): void {
  for (const e of elements) if (e.kind === 'shape') delete e.merge;
}

/** What a run saves when its elements (none merged) become one object. */
function saving(elements: readonly Element[], run: readonly number[]): number {
  let n = 0;
  for (const i of run) n += ownObjects(elements[i]!);
  return n - 1;
}

/**
 * Apply runs, those that save most first, while the slide's objects (`objects`, none merged) pass
 * `MAX_SLIDE_OBJECTS`; `mark` marks one run. Linear: each run's saving is taken from the count, which is not
 * worked out again. Returns the slide's objects after them and the runs applied.
 */
function applyRuns(
  elements: readonly Element[],
  runs: number[][],
  objects: number,
  mark: (run: number[]) => void,
): { objects: number; applied: number[][] } {
  const applied: number[][] = [];
  const sorted = runs
    .map((run, k) => ({ run, k, save: saving(elements, run) }))
    .filter((r) => r.save > 0)
    .sort((p, q) => q.save - p.save || p.k - q.k);
  for (const { run, save } of sorted) {
    if (objects <= MAX_SLIDE_OBJECTS) break;
    mark(run);
    applied.push(run);
    objects -= save;
  }
  return { objects, applied };
}

/**
 * The slide budgets (see the header) on a classified slide's elements, after `refineSupport` and with the
 * art's residual elements marked: merges, decorations, composites, the guard and the atlas, as marks on the
 * elements (`merge`, `decor`, `sheet`, `culled: 'budget'`) and the plan. The caller culls first
 * (`cullElements`) and works out the class. Each step is linear in the elements (plus `shapeRuns`).
 */
export function fitBudgets(
  ctx: Pick<SlideCtx, 'frame' | 'log'>,
  elements: Element[],
  background: Background,
): BudgetPlan {
  const frame = ctx.frame;
  const plan: BudgetPlan = {
    culled: { offSlide: 0, invisible: 0 },
    merged: { shapes: 0, objects: 0 },
    decorated: { shapes: 0, decors: 0 },
    composited: { pictures: 0, sheets: 0 },
    flat3d: 0,
    atlas: [],
    left: 0,
    objects: 0,
    pictures: 0,
  };
  const art = artRange(elements);
  const inArt = new Set(art?.elements);
  const cost = () => budgetCost(elements, background, art, plan.atlas);
  const used = () => {
    const out = new Set(inArt);
    elements.forEach((e, i) => {
      if (e.decor !== undefined || e.sheet !== undefined) out.add(i);
    });
    return out;
  };
  if (cost().objects > MAX_SLIDE_OBJECTS) {
    // 2: shapes of one look, as M6 merges them.
    markShapeRuns(elements, frame, inArt);
    if (cost().objects > MAX_SLIDE_OBJECTS) {
      // 3-5 plan with the merges left out (a decoration subsumes them), which are worked out again after.
      clearMerges(elements);
      let objects = cost().objects;
      const decorate = (run: number[]) => {
        for (const i of run) elements[i]!.decor = run[0]!;
      };
      // 3: decorations of one drawing, group or decoration source.
      ({ objects } = applyRuns(elements, decorRuns(elements, frame, { exclude: used() }), objects, decorate));
      // 4: composites of z-adjacent plain pictures.
      if (objects > MAX_SLIDE_OBJECTS)
        ({ objects } = applyRuns(elements, pictureRuns(elements, frame, used()), objects, (run) => {
          for (const i of run) elements[i]!.sheet = run[0]!;
        }));
      // 5: decorations of one source, the slide's own ungrouped shapes too.
      if (objects > MAX_SLIDE_OBJECTS)
        ({ objects } = applyRuns(
          elements,
          decorRuns(elements, frame, { wide: true, exclude: used() }),
          objects,
          decorate,
        ));
      // 5': real 3-D drawn flat in decorations (plan decision 6), only for a slide still over.
      if (objects > MAX_SLIDE_OBJECTS) {
        const r = applyRuns(
          elements,
          decorRuns(elements, frame, { wide: true, flat3d: true, exclude: used() }),
          objects,
          decorate,
        );
        objects = r.objects;
        for (const run of r.applied)
          for (const i of run) {
            const e = elements[i]!;
            if (!e.reasons?.some((x) => x === '3d' || x === '3d:camera')) continue;
            e.reasons = [...e.reasons, '3d:flat-in-decoration'];
            plan.flat3d++;
          }
      }
      // The shapes of one look left merge again, where the slide still needs it.
      if (objects > MAX_SLIDE_OBJECTS) markShapeRuns(elements, frame, inArt);
    }
  }
  // 7: the guard. Elements that are not text first, topmost first; then text.
  if (cost().objects > MAX_SLIDE_OBJECTS_TEXT) plan.left += guard(elements, background, art, inArt);
  // P: the atlas, then the guard's way for what it cannot hold.
  const pictures = cost().pictures;
  if (pictures > MAX_SLIDE_PICTURES) {
    const keep = new Set<string>();
    if (background.fill.kind === 'picture') keep.add(background.fill.picture.part);
    plan.atlas = atlasParts(elements, frame, pictures, MAX_SLIDE_PICTURES, keep, inArt);
    const left = cost().pictures - MAX_SLIDE_PICTURES;
    if (left > 0) plan.left += leavePictures(elements, inArt, [...plan.atlas, ...keep], left);
  }
  // The plan and its notes.
  const runs = (key: 'merge' | 'decor' | 'sheet') => {
    const by = new Map<number, number>();
    for (const e of elements) {
      const k = (e as { [K in typeof key]?: number })[key];
      if (k !== undefined && !e.hidden) by.set(k, (by.get(k) ?? 0) + 1);
    }
    return { members: [...by.values()].reduce((a, b) => a + b, 0), runs: by.size };
  };
  const m = runs('merge');
  const d = runs('decor');
  const s = runs('sheet');
  plan.merged = { shapes: m.members, objects: m.runs };
  plan.decorated = { shapes: d.members, decors: d.runs };
  plan.composited = { pictures: s.members, sheets: s.runs };
  const c = cost();
  plan.objects = c.objects;
  plan.pictures = c.pictures;
  if (m.runs)
    ctx.log(`${m.members} shapes of one look are drawn as ${m.runs} objects (the slide's object budget)`);
  if (d.runs) ctx.log(`${d.members} shapes are drawn as ${d.runs} decoration(s) (the slide's object budget)`);
  if (s.runs) ctx.log(`${s.members} pictures are drawn as ${s.runs} picture(s) (the slide's object budget)`);
  if (plan.flat3d)
    ctx.log(`${plan.flat3d} 3-D shape(s) are drawn flat in decorations (the slide's object budget)`);
  if (plan.atlas.length)
    ctx.log(`${plan.atlas.length} pictures are drawn from one picture (the slide's picture budget)`);
  if (plan.left) ctx.log(`${plan.left} element(s) past the slide's budgets are not drawn`);
  return plan;
}

/** Leave an element out for the budgets (the guard): culled as `budget`, hidden. */
function leave(e: Element): void {
  e.culled = 'budget';
  e.hidden = true;
}

/** The run an element is drawn in (a decoration, a composite, merged shapes), as a key, or undefined. */
function runOf(e: Element): string | undefined {
  if (e.decor !== undefined) return `d${e.decor}`;
  if (e.sheet !== undefined) return `s${e.sheet}`;
  if (e.kind === 'shape' && e.merge !== undefined) return `m${e.merge}`;
  return undefined;
}

/**
 * The guard (step 7): while the slide passes `MAX_DRAWN_OBJECTS` objects or its objects that hold no text
 * pass `MAX_SLIDE_OBJECTS_TEXT`, its topmost element without text is left out (a decoration, a composite
 * or a run of merged shapes whole); then, while it still passes `MAX_DRAWN_OBJECTS`, its topmost element.
 * Linear: the counts are kept as elements go. Returns how many elements were left out.
 */
function guard(
  elements: Element[],
  background: Background,
  art: ArtRange | undefined,
  inArt: ReadonlySet<number>,
): number {
  // Each drawn unit (an element, or a run as one) with its objects and whether it holds text.
  type Unit = { members: number[]; objects: number; text: boolean; gone?: true };
  const units: Unit[] = [];
  const byRun = new Map<string, Unit>();
  let all = budgetCost(elements, background, art).objects;
  let text = 0;
  elements.forEach((e, i) => {
    if (e.hidden || inArt.has(i) || e.kind === 'residual') return;
    const key = runOf(e);
    const t = hasText(e);
    if (key !== undefined) {
      let u = byRun.get(key);
      if (!u) {
        u = { members: [], objects: 1, text: false };
        byRun.set(key, u);
        units.push(u);
      }
      u.members.push(i);
      // A merged shape's text (none: shape runs hold none) would be its own object.
      if (t) {
        u.text = true;
        u.objects++;
        text++;
      }
      return;
    }
    const n = ownObjects(e);
    if (!n) return;
    if (t) text++;
    units.push({ members: [i], objects: n, text: t });
  });
  let left = 0;
  const drop = (u: Unit) => {
    for (const i of u.members) leave(elements[i]!);
    left += u.members.length;
    all -= u.objects;
    if (u.text) text--;
    u.gone = true;
  };
  for (
    let k = units.length - 1;
    k >= 0 && (all > MAX_DRAWN_OBJECTS || all - text > MAX_SLIDE_OBJECTS_TEXT);
    k--
  )
    if (!units[k]!.text) drop(units[k]!);
  for (let k = units.length - 1; k >= 0 && all > MAX_DRAWN_OBJECTS; k--) if (!units[k]!.gone) drop(units[k]!);
  return left;
}

/**
 * The pictures an atlas could not hold (`over` distinct pictures past `MAX_SLIDE_PICTURES`): the topmost
 * pictures are left out until that many distinct ones are no longer drawn: every use of a part that is not
 * the background's nor the atlas's (`kept`), or a composite whole (each is one picture). A clip's poster
 * never. Linear but for the sort of the pictures.
 */
function leavePictures(
  elements: Element[],
  inArt: ReadonlySet<number>,
  kept: readonly string[],
  over: number,
): number {
  const packed = new Set(kept);
  const units = new Map<string, number[]>();
  const posters = new Set<string>();
  elements.forEach((e, i) => {
    if (e.hidden || inArt.has(i) || e.kind === 'residual') return;
    const part = picturePart(e);
    if (e.sheet !== undefined) {
      const key = `sheet ${e.sheet}`;
      units.set(key, [...(units.get(key) ?? []), i]);
      return;
    }
    if (part === undefined || packed.has(part)) return;
    if (e.kind === 'picture' && e.media) posters.add(part);
    units.set(part, [...(units.get(part) ?? []), i]);
  });
  const order = [...units]
    .filter(([key]) => !posters.has(key))
    .sort((p, q) => q[1][q[1].length - 1]! - p[1][p[1].length - 1]!);
  let left = 0;
  for (const [, list] of order.slice(0, over))
    for (const i of list) {
      leave(elements[i]!);
      left++;
    }
  return left;
}

/**
 * What a hub records for the elements the guard left out (`Slide.pptx.missing` kinds): 'decoration' for
 * shapes and pictures, 'element' for text, tables and charts.
 */
export function leftKinds(elements: readonly Element[]): MissingKind[] {
  const kinds: MissingKind[] = [];
  for (const e of elements) {
    if (e.culled !== 'budget') continue;
    const k: MissingKind = (e.kind === 'shape' && !e.text) || e.kind === 'picture' ? 'decoration' : 'element';
    if (!kinds.includes(k) && kinds.length < MISSING_LIMITS.entries) kinds.push(k);
  }
  return kinds;
}
