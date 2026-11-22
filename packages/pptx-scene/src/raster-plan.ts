/**
 * The planner of the shape pictures (the owner's Q53, Q53.e, Q53.f, Q53.h in its new form and Q56.d; C-SR2, C-SR3,
 * D3 to D5, D10 and D19 of the track's brief): which custom-path shapes of a slide are drawn into pictures, which
 * other shapes are drawn into them, and what each shape becomes again if its picture cannot be made.
 *
 * - **Candidates** (`RasterCandidate`, written by the walk, step 5 of the track, on a shape element): a custom-path
 *   shape with more than `RASTER_POINTS` points, or one past a geometry limit of the converter, with its raw point
 *   cost, the `a:custGeom` node the recipe builder reads, and what the converter gives it today.
 * - **Runs** (`planRasters`): bottom up, the candidates of one SCOPE (a SmartArt drawing, a top-level group, a
 *   layout's or master's decorations, else the source: the decoration rule of `decor.ts`), with the small shapes
 *   BETWEEN two of them drawn into the picture (the owner's Q53.e: they also stop being editable). An element that
 *   shares no area with the run's members is SKIPPED (any kind; it is drawn above the picture, and no later member
 *   may overlap it); anything else ends the run. Hidden elements, elements past the slide's edge and shapes that show
 *   nothing are skipped without ending it. The shapes the guard would cull LATER are INCLUDED (the planner runs
 *   before the budget steps), so a picture has no holes. A text box between candidates is drawn in only when it lies
 *   over the run (it could not be skipped): text stays live text where it can.
 * - **The cap**: a slide holds at most `RASTER_MAX_PICTURES` pictures and `RASTER_SLIDE_PIXELS` pixels. Past the
 *   cap, neighbouring runs are merged where the skip rule allows (left to right, only as far as the cap needs), and
 *   the runs that cannot be merged are not made, the ones with the fewest candidate points first; their shapes
 *   stay as today, and the report says so.
 * - **What may be drawn in** is read from one list, `RASTER_MAY_HOLD` (the owner's Q53.i): a candidate with a kind
 *   the list says no to stays as today and is counted by kind.
 * - **The put-back forms** (D5): each candidate's form if its picture cannot be made, worked out in walk order
 *   against the slide total left after the shapes that stay shapes, so a failed picture can never leave a slide
 *   with more path points than the converter allows.
 *
 * Pure: it reads the IR and writes `raster` (the index of the run's first element) on each member and clears the
 * residual mark of a claimed shape past a limit; nothing else. The emitter (`raster-emit.ts`) writes the objects.
 */
import { boundsOf, overlaps, unionBox } from './classify.ts';
import { LOGICAL_H, LOGICAL_W } from './frame.ts';
import { knownPreset, MAX_SLIDE_PATH_POINTS } from './geom.ts';
import type {
  Background,
  CustomPaths,
  Element,
  ElementBase,
  Frame,
  RectEmu,
  ShapeElement,
  TextBody,
} from './ir.ts';
import {
  RASTER_CANDIDATES_MAX,
  RASTER_MAX_PICTURES,
  RASTER_MAY_HOLD,
  RASTER_READ,
  RASTER_RUN,
  RASTER_SLIDE_PIXELS,
  RASTER_DENSITY,
  RASTER_WORDS_MAX,
  type RasterMayHold,
  type RasterMaker,
  type RasterRef,
} from './raster.ts';
import type { XNode } from './xml.ts';

/** Whether a slide plans pictures: 'off' plans nothing, 'detect' counts the candidates, 'plan' plans. */
export type RasterMode = 'off' | 'detect' | 'plan';

/** What a candidate becomes again when its picture cannot be made: its stored paths ('built') or today's box ('box'). */
export type RasterForm = 'built' | 'box';

/**
 * A custom-path shape the walk marks for a picture (C-SR2): `raw` is the converter's point cost over what the file
 * holds, `why` the rule that made it one ('points': over `RASTER_POINTS`; 'limit': past a geometry limit of the
 * converter; 'total': only the slide's total refused it), `times` the objects that would store it, `today` what
 * `customPaths` gives it (over the limits, a box), and `node` the `a:custGeom` the recipe builder reads.
 */
export interface RasterCandidate {
  raw: number;
  why: 'points' | 'limit' | 'total';
  times: number;
  today: CustomPaths;
  node: XNode;
}

/**
 * A shape element with the two fields this release adds to the IR (`rasterOf`, the walk's; `raster`, the planner's:
 * the index of the first element of the run the shape is drawn into). Step 5 of the track moves both into `ir.ts`.
 */
export type RasterElement = ShapeElement & { rasterOf?: RasterCandidate; raster?: number };

export interface RasterPlanOptions {
  /** Default 'plan'. */
  mode?: RasterMode;
  /** Who draws the pictures: words are drawn in only by the page. */
  maker: RasterMaker;
  /** The slide is anchored (an animation, a playing clip, step text, a lyric, a video background): no run is made. */
  anchored?: boolean;
  /** Path points the slide total holds for the shapes that stay shapes (the walk's real counter). Default 0. */
  pointsUsed?: number;
  /** The capability list; default `RASTER_MAY_HOLD` (a test passes a copy). */
  mayHold?: Readonly<RasterMayHold>;
  /** Pictures a slide holds at most (default `RASTER_MAX_PICTURES`; the census may raise it to 8). */
  maxPictures?: number;
  /** Device pixels of a slide's pictures at most (default `RASTER_SLIDE_PIXELS`). */
  slidePixels?: number;
}

/** One shape of a run. */
export interface RasterMemberPlan {
  /** Its place in the slide's elements. */
  index: number;
  element: RasterElement;
  /** A candidate (a shape past the rule), as against a small shape drawn in. */
  candidate: boolean;
  /** It carries words: the recipe holds its text object beside its shape. */
  text: boolean;
  /** Its points as a recipe counts them (a candidate's raw cost). */
  points: number;
  /** A candidate's put-back form (a small shape is put back as the emitter writes it). */
  form?: RasterForm;
}

/** One picture. */
export interface RasterRunPlan {
  /** The index of the run's lowest member: where the picture goes in z order. */
  first: number;
  members: RasterMemberPlan[];
  candidates: number;
  points: number;
  texts: number;
  from: ElementBase['from'];
  /** The group number the members share, when they share one. */
  group?: number;
  /** The picture's rectangle in slide logical px: the union box cut to the slide, rounded outward to a 2 px grid. */
  rect: { x: number; y: number; w: number; h: number };
  /** The members' union box in slide EMU. */
  box: RectEmu;
  /** The members, named so that a later step finds them in the deck (z order). */
  refs: RasterRef[];
  /** The words of the members that carry text, bottom first. */
  words: string;
}

/** Candidates that stay as today, by why (C-SR11). */
export interface RasterSkipped {
  text: number;
  effects: number;
  fill: number;
  anchored: number;
  other: number;
}

export interface RasterPlan {
  mode: RasterMode;
  /** Candidates on the slide (the shown ones). */
  candidates: number;
  runs: RasterRunPlan[];
  /** The put-back form of each candidate, by element index. */
  forms: (RasterForm | undefined)[];
  /** Shapes drawn into pictures (the candidates and the small shapes with them). */
  shapes: number;
  skipped: RasterSkipped;
  /** Named reasons (a short list: text, effects, fill, read-bound, anchored, pictures, pixels, candidates, canvas, words). */
  reasons: string[];
  /** The slide's pictured words, cut at `RASTER_WORDS_MAX` (C-SR18). */
  words: string;
  wordsCut: boolean;
}

// ── Reading an element ──────────────────────────────────────────────────────────────────────────────────────

/** Straight lines, connectors and their routes: drawn as lines, never as a member's geometry. */
const LINE_GEOMS = /^(line|straightConnector1|(bent|curved)Connector[2-5])$/;
/** The render clamp keeps box edges within twice the logical canvas (`@ordo/renderer` `CLAMP.boxFactor`). */
const CLAMP_W = 2 * LOGICAL_W;
const CLAMP_H = 2 * LOGICAL_H;
/** What a preset shape costs a recipe at most (its built paths are a few dozen points). */
const PRESET_POINTS = 64;
/** The work the merge of runs may do (elements looked at), so a hostile slide cannot make it quadratic. */
const FUSE_WORK = 2_000_000;

type Refusal = 'text' | 'effects' | 'fill' | 'other';

/** What the planner knows of one element. */
interface Cell {
  i: number;
  e: Element;
  /** Draws nothing: skipped and ends nothing (hidden, past the slide's edge, shows nothing). */
  silent: boolean;
  /** Its bounds are not numbers: it ends every run and can be skipped by none. */
  broken: boolean;
  /** Its bounds grown by what its drawing reaches past them, in slide EMU. */
  box: RectEmu;
  kind: 'candidate' | 'small' | 'text' | 'other';
  /** Why a candidate stays as today (`kind` 'other'). */
  refusal?: Refusal;
  /** A named reason that says more than the bucket. */
  why?: string;
  scope: string;
  from: ElementBase['from'];
  group?: number;
  points: number;
  hasText: boolean;
}

/** How far an element's drawing reaches past its bounds, in EMU: shadow, glow, its outline (all of it, for joins). */
function reach(e: Element): number {
  let r = 0;
  if (e.kind === 'shape') {
    if (e.shadow) r = Math.max(r, Math.abs(e.shadow.dist) + Math.abs(e.shadow.blur));
    if (e.glow) r = Math.max(r, Math.abs(e.glow.radius));
    if (typeof e.softEdge === 'number') r = Math.max(r, Math.abs(e.softEdge));
  }
  const line = e.kind === 'shape' || e.kind === 'picture' ? e.line : undefined;
  if (line && line.fill.kind !== 'none') r = Math.max(r, Math.abs(line.width));
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

/** A shape that shows nothing: no visible fill, line, text or effect (the converter does not import it). */
function invisible(e: Element): boolean {
  if (e.kind !== 'shape' || e.text || e.shadow || e.glow || e.softEdge || e.look3d) return false;
  if (shows(e.fill)) return false;
  return !(e.line && shows(e.line.fill));
}

/** Clips and SmartArt drawings are never culled (`budget.ts` `keeps`). */
const keeps = (e: Element) => e.diagram !== undefined || (e.kind === 'picture' && e.media !== undefined);

/** A text body's characters as `TextObject.text` writes them (paragraphs and breaks as '\n'). */
function bodyText(body: TextBody | undefined): string {
  if (!body) return '';
  return body.paras
    .map((p) => p.runs.map((r) => (r.kind === 'break' ? '\n' : r.text.replaceAll('\t', ' '))).join(''))
    .join('\n')
    .trim();
}

/** A gradient whose stops differ in transparency. */
function seeThrough(f: ShapeElement['fill']): boolean {
  if (f.kind !== 'gradient' || f.stops.length < 2) return false;
  const a = f.stops[0]!.color.a;
  return f.stops.some((s) => s.color.a !== a);
}

/** Why a shape stays as today: a kind the capability list says no to, or something a picture cannot hold. */
function refusalOf(e: ShapeElement, may: Readonly<RasterMayHold>, maker: RasterMaker): Refusal | undefined {
  if (e.text && !(maker === 'page' && may.text)) return 'text';
  if (
    (e.shadow && !may.shadow) ||
    (e.glow && !may.glow) ||
    (e.softEdge && !may.softEdge) ||
    (e.look3d && !may.threeD)
  )
    return 'effects';
  const f = e.fill;
  if (
    (f.kind === 'picture' && !may.pictureFill) ||
    (f.kind === 'pattern' && !may.pattern) ||
    (seeThrough(f) && !may.alphaGradient)
  )
    return 'fill';
  if (f.kind === 'group') return 'other';
  if (e.diagram !== undefined) return 'other';
  // A shape that is residual for any reason but the geometry (vertical text, a warp, columns) is not drawn here.
  if (e.support === 'residual' && !(e.reasons ?? []).every((r) => r === 'custGeom')) return 'other';
  return undefined;
}

/** Whether a shape that is no candidate has a geometry a recipe can hold: stored paths, or a preset the table draws. */
function geometryOk(e: ShapeElement): boolean {
  if (e.custom) return !e.custom.over && e.custom.paths.length > 0;
  if (e.geom === 'custom' || LINE_GEOMS.test(e.geom)) return false;
  return knownPreset(e.geom);
}

const scopeOf = (e: Element): string =>
  e.diagram !== undefined
    ? `${e.from}:d${e.diagram}`
    : e.group !== undefined
      ? `${e.from}:g${e.group}`
      : e.from;

function cellOf(
  i: number,
  e: Element,
  frame: Frame,
  area: RectEmu,
  may: Readonly<RasterMayHold>,
  maker: RasterMaker,
): Cell {
  const b = boundsOf(e);
  const r = reach(e);
  const box: RectEmu = { x: b.x - r, y: b.y - r, cx: b.cx + 2 * r, cy: b.cy + 2 * r };
  const finite = [box.x, box.y, box.cx, box.cy].every(Number.isFinite);
  const cell: Cell = {
    i,
    e,
    silent: false,
    broken: !finite,
    box,
    kind: 'other',
    scope: scopeOf(e),
    from: e.from,
    ...(e.group !== undefined ? { group: e.group } : {}),
    points: 0,
    hasText: false,
  };
  if (e.hidden) cell.silent = true;
  else if (finite && !keeps(e) && (invisible(e) || !overlaps(box, area))) cell.silent = true;
  if (cell.silent || e.kind !== 'shape') return cell;
  const cand = (e as RasterElement).rasterOf;
  cell.hasText = !!e.text;
  // The picture's pixels are the screens' own: a shape the render clamp would cut is not drawn whole by it.
  const x0 = frame.x0 + box.x * frame.s;
  const y0 = frame.y0 + box.y * frame.s;
  const x1 = x0 + box.cx * frame.s;
  const y1 = y0 + box.cy * frame.s;
  const inClamp = x0 >= -CLAMP_W && x1 <= CLAMP_W && y0 >= -CLAMP_H && y1 <= CLAMP_H;
  if (cand) {
    cell.kind = 'candidate';
    cell.points = cand.raw;
    let refusal = refusalOf(e, may, maker);
    if (!refusal && !(Number.isFinite(cand.raw) && cand.raw >= 0 && cand.node && inClamp)) refusal = 'other';
    if (!refusal && cand.raw > RASTER_READ.pointsShape) {
      refusal = 'other';
      cell.why = 'read-bound';
    }
    if (refusal) {
      cell.kind = 'other';
      cell.refusal = refusal;
    }
    return cell;
  }
  if (refusalOf(e, may, maker) || !geometryOk(e) || !inClamp || e.support === 'residual') return cell;
  cell.points = e.custom ? e.custom.points : PRESET_POINTS;
  cell.kind = e.text ? 'text' : 'small';
  return cell;
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A run being built. */
interface RunB {
  lo: number;
  scope: string;
  from: ElementBase['from'];
  cells: Cell[];
  skipped: Cell[];
  box: RectEmu;
  points: number;
  texts: number;
  /** The index in `cells` of the last candidate: the small shapes after it are not the run's. */
  last: number;
}

const open = (c: Cell): RunB => ({
  lo: c.i,
  scope: c.scope,
  from: c.from,
  cells: [c],
  skipped: [],
  box: c.box,
  points: c.points,
  texts: c.hasText ? 1 : 0,
  last: 0,
});

const hitsMember = (r: RunB, box: RectEmu) =>
  overlaps(r.box, box) && r.cells.some((m) => overlaps(m.box, box));
const hitsSkipped = (r: RunB, box: RectEmu) => r.skipped.some((s) => overlaps(s.box, box));

const roomFor = (r: RunB, c: Cell) =>
  r.cells.length < RASTER_RUN.members &&
  r.points + c.points <= RASTER_RUN.points &&
  r.texts + (c.hasText ? 1 : 0) <= RASTER_RUN.texts;

/** The run, cut back to its last candidate (a small shape no candidate follows is not drawn in). */
function finish(r: RunB): RunB {
  const cells = r.cells.slice(0, r.last + 1);
  const end = cells[cells.length - 1]!.i;
  let box = cells[0]!.box;
  let points = 0;
  let texts = 0;
  for (const c of cells) {
    box = unionBox(box, c.box);
    points += c.points;
    if (c.hasText) texts++;
  }
  return { ...r, cells, skipped: r.skipped.filter((s) => s.i < end), box, points, texts };
}

/**
 * The runs of the cells in [from, to]: bottom up (C-SR3). `sameScope` keeps a run to one scope (the first pass);
 * the source (layout, master, slide) is always one.
 */
function scan(cells: readonly Cell[], from: number, to: number, sameScope: boolean): RunB[] {
  const runs: RunB[] = [];
  let r: RunB | undefined;
  const end = () => {
    if (r) runs.push(finish(r));
    r = undefined;
  };
  const joins = (c: Cell) =>
    r !== undefined &&
    r.from === c.from &&
    (!sameScope || r.scope === c.scope) &&
    roomFor(r, c) &&
    !hitsSkipped(r, c.box);
  const add = (c: Cell) => {
    const run = r!;
    run.cells.push(c);
    run.box = unionBox(run.box, c.box);
    run.points += c.points;
    if (c.hasText) run.texts++;
    if (c.kind === 'candidate') run.last = run.cells.length - 1;
  };
  /** An element that is not a member: skipped when it shares no area with the run, else it ends the run. */
  const other = (c: Cell) => {
    if (!r) return;
    if (!c.broken && r.skipped.length < RASTER_RUN.skipped && !hitsMember(r, c.box)) r.skipped.push(c);
    else end();
  };
  for (let k = from; k <= to; k++) {
    const c = cells[k]!;
    if (c.silent) continue;
    if (c.kind === 'candidate') {
      if (joins(c)) add(c);
      else {
        end();
        r = open(c);
      }
    } else if (c.kind === 'small') {
      if (joins(c)) add(c);
      else other(c);
    } else if (c.kind === 'text') {
      // A text box lies over the run or apart from it: only one that lies over it has to be drawn in.
      if (r && !c.broken && hitsMember(r, c.box) && joins(c)) add(c);
      else other(c);
    } else other(c);
  }
  end();
  return runs;
}

const FROM_RANK = { master: 0, layout: 1, slide: 2 } as const;

/** The most the picture of a run can be: its union box in slide logical px, cut to the canvas, out to a 2 px grid. */
function rectOf(box: RectEmu, frame: Frame): RasterRunPlan['rect'] | undefined {
  const eps = 1e-6;
  const px0 = Math.max(0, frame.x0 + box.x * frame.s);
  const py0 = Math.max(0, frame.y0 + box.y * frame.s);
  const px1 = Math.min(LOGICAL_W, frame.x0 + (box.x + box.cx) * frame.s);
  const py1 = Math.min(LOGICAL_H, frame.y0 + (box.y + box.cy) * frame.s);
  const x0 = Math.floor(px0 / 2 + eps) * 2;
  const y0 = Math.floor(py0 / 2 + eps) * 2;
  const x1 = Math.ceil(px1 / 2 - eps) * 2;
  const y1 = Math.ceil(py1 / 2 - eps) * 2;
  if (!([x0, y0, x1, y1].every(Number.isFinite) && x1 > x0 && y1 > y0)) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────────────────

const emptyPlan = (mode: RasterMode, n: number, candidates = 0): RasterPlan => ({
  mode,
  candidates,
  runs: [],
  forms: new Array<RasterForm | undefined>(n).fill(undefined),
  shapes: 0,
  skipped: { text: 0, effects: 0, fill: 0, anchored: 0, other: 0 },
  reasons: [],
  words: '',
  wordsCut: false,
});

/**
 * Plan the pictures of one slide's elements (see the header). `background` is read by no rule today (the video
 * background of the owner's Q25.c.b is the caller's, in `opts.anchored`): it is in the signature so that a later
 * release that lets a picture stand under a moving background reads it where it belongs.
 */
export function planRasters(
  elements: readonly Element[],
  _background: Background | undefined,
  frame: Frame,
  opts: RasterPlanOptions,
): RasterPlan {
  const mode = opts.mode ?? 'plan';
  const n = elements.length;
  if (mode === 'off') return emptyPlan(mode, n);
  if (mode === 'detect') {
    let count = 0;
    for (const e of elements) if (e.kind === 'shape' && !e.hidden && (e as RasterElement).rasterOf) count++;
    return emptyPlan(mode, n, count);
  }
  // A slide with no candidate plans nothing and is not touched (the output is today's, byte for byte).
  let any = false;
  for (const e of elements)
    if (e.kind === 'shape' && (e as RasterElement).rasterOf) {
      any = true;
      break;
    }
  if (!any) return emptyPlan(mode, n);

  const may = opts.mayHold ?? RASTER_MAY_HOLD;
  const maxPictures = Math.max(1, Math.floor(opts.maxPictures ?? RASTER_MAX_PICTURES));
  const slidePixels = opts.slidePixels ?? RASTER_SLIDE_PIXELS;
  const area: RectEmu = { x: 0, y: 0, cx: frame.cx, cy: frame.cy };
  const cells = elements.map((e, i) => cellOf(i, e, frame, area, may, opts.maker));

  const reasons = new Set<string>();
  const skipped: RasterSkipped = { text: 0, effects: 0, fill: 0, anchored: 0, other: 0 };

  // The candidates past the most a slide plans for stay as today.
  let seen = 0;
  for (const c of cells) {
    if (c.kind !== 'candidate') continue;
    if (++seen > RASTER_CANDIDATES_MAX) {
      c.kind = 'other';
      c.refusal = 'other';
      c.why = 'candidates';
    }
  }

  // THE PUT-BACK FORMS (D5), in walk order: a shape past a limit is a box; any other fits while the total has room.
  const forms = new Array<RasterForm | undefined>(n).fill(undefined);
  const left = Math.max(0, MAX_SLIDE_PATH_POINTS - Math.max(0, opts.pointsUsed ?? 0));
  let used = 0;
  let candidates = 0;
  for (const c of cells) {
    const cand = (c.e as RasterElement).rasterOf;
    if (!cand || c.silent || c.e.kind !== 'shape') continue;
    candidates++;
    const cost = Math.max(0, cand.today.points) * Math.max(1, cand.times);
    const form: RasterForm =
      cand.today.over === true && cand.why !== 'total' ? 'box' : used + cost <= left ? 'built' : 'box';
    if (form === 'built') used += cost;
    forms[c.i] = form;
  }

  let runs: RunB[] = [];
  if (opts.anchored) {
    skipped.anchored = candidates;
    reasons.add('anchored');
  } else {
    runs = scan(cells, 0, n - 1, true);
    // Past the cap, neighbouring runs are merged where the skip rule allows, left to right, only as far as the cap needs.
    if (runs.length > maxPictures) {
      let budget = FUSE_WORK;
      const fused: RunB[] = [];
      let acc = runs[0]!;
      for (let k = 1; k < runs.length; k++) {
        const next = runs[k]!;
        const count = fused.length + 1 + (runs.length - k);
        if (count > maxPictures && budget > 0) {
          const hi = next.cells[next.cells.length - 1]!.i;
          budget -= hi - acc.lo + 1;
          const merged = scan(cells, acc.lo, hi, false);
          if (merged.length === 1 && merged[0]!.lo === acc.lo) {
            acc = merged[0]!;
            continue;
          }
        }
        fused.push(acc);
        acc = next;
      }
      fused.push(acc);
      runs = fused;
    }
  }

  // The rectangle of each picture; a run with nothing on the canvas is not made.
  type Placed = { run: RunB; rect: RasterRunPlan['rect']; cand: number };
  let placed: Placed[] = [];
  const dropped = new Map<Cell, string>();
  for (const run of runs) {
    const rect = rectOf(run.box, frame);
    const cs = run.cells.filter((c) => c.kind === 'candidate');
    if (!rect) {
      for (const c of cs) dropped.set(c, 'canvas');
      reasons.add('canvas');
      continue;
    }
    placed.push({ run, rect, cand: cs.reduce((a, c) => a + c.points, 0) });
  }
  // The cap: past the pictures or the pixels a slide holds, the runs with the fewest candidate points are not made.
  const pixels = (p: Placed) => p.rect.w * RASTER_DENSITY * p.rect.h * RASTER_DENSITY;
  const total = () => placed.reduce((a, p) => a + pixels(p), 0);
  const worst = () =>
    placed.reduce((w, p) =>
      p.cand < w.cand ||
      (p.cand === w.cand &&
        (FROM_RANK[p.run.from] < FROM_RANK[w.run.from] || (p.run.from === w.run.from && p.run.lo < w.run.lo)))
        ? p
        : w,
    );
  const drop = (p: Placed, why: string) => {
    placed = placed.filter((q) => q !== p);
    for (const c of p.run.cells) if (c.kind === 'candidate') dropped.set(c, why);
    reasons.add(why);
  };
  while (placed.length > maxPictures) drop(worst(), 'pictures');
  while (placed.length > 0 && total() > slidePixels) drop(worst(), 'pixels');

  // Marks, claims, words and references.
  const nth = new Map<string, number>();
  const nths = elements.map((e) => {
    const key = `${e.from}\u0000${e.shapeId}`;
    const k = nth.get(key) ?? 0;
    nth.set(key, k + 1);
    return k;
  });
  const out: RasterRunPlan[] = [];
  const pictured = new Set<number>();
  let words = '';
  let wordsCut = false;
  for (const { run, rect } of placed) {
    const members: RasterMemberPlan[] = [];
    const refs: RasterRef[] = [];
    const said: string[] = [];
    let group: number | undefined = run.cells[0]!.group;
    for (const c of run.cells) {
      const el = c.e as RasterElement;
      el.raster = run.lo;
      pictured.add(c.i);
      if (
        c.kind === 'candidate' &&
        el.support === 'residual' &&
        (el.reasons ?? []).every((r) => r === 'custGeom')
      ) {
        // Claimed: it is a native element again (the picture draws it, or its put-back form does).
        el.support = 'native';
        delete el.reasons;
      }
      if (c.group !== group) group = undefined;
      const form = forms[c.i];
      members.push({
        index: c.i,
        element: el,
        candidate: c.kind === 'candidate',
        text: c.hasText,
        points: c.points,
        ...(form && c.kind === 'candidate' ? { form } : {}),
      });
      refs.push({ from: el.from, shapeId: el.shapeId, nth: nths[c.i]! });
      if (c.hasText) {
        const t = bodyText(el.text);
        if (t) said.push(t);
      }
    }
    const runWords = said.join('\n');
    if (runWords) {
      words = words ? `${words}\n${runWords}` : runWords;
    }
    out.push({
      first: run.lo,
      members,
      candidates: members.filter((m) => m.candidate).length,
      points: run.points,
      texts: run.texts,
      from: run.from,
      ...(group !== undefined ? { group } : {}),
      rect,
      box: run.box,
      refs,
      words: runWords.slice(0, RASTER_WORDS_MAX),
    });
  }
  if (words.length > RASTER_WORDS_MAX) {
    words = words.slice(0, RASTER_WORDS_MAX);
    wordsCut = true;
    reasons.add('words');
  }

  // What stays as today, counted by why.
  for (const c of cells) {
    if (c.silent || c.e.kind !== 'shape' || !(c.e as RasterElement).rasterOf || pictured.has(c.i)) continue;
    if (opts.anchored) continue;
    const refusal = c.refusal ?? 'other';
    skipped[refusal]++;
    reasons.add(c.why ?? dropped.get(c) ?? refusal);
  }

  return {
    mode,
    candidates,
    runs: out,
    forms,
    shapes: out.reduce((a, r) => a + r.members.length, 0),
    skipped,
    reasons: [...reasons].slice(0, 32),
    words,
    wordsCut,
  };
}
