/**
 * The emitter of the shape pictures (C-SR4, C-SR5, C-SR6, C-SR17 of the track's brief; the owner's Q53): one run of
 * shapes, as the planner (`raster-plan.ts`) made it, becomes ONE locked picture where its lowest member was, and
 * the RECIPE the hub's page draws it from. Modelled on `sheet.ts`'s `emitComposite`.
 *
 * - **The picture**: an `ImageObject` (`fit: 'stretch'`, locked) over the run's rectangle, its media id the
 *   placeholder `pptxmedia:raster<16 hex of the recipe hash>` until the hub stores the picture, its origin
 *   `{ src: 'pptx', role: 'raster', shapeId, group, raster }` (the provenance of the owner's named later project
 *   Q62: the converter and drawing versions, the point rule, the recipe hash, the member count and the members'
 *   references in runs; the deck's hash and the slide's place are added by the importer, which knows them).
 * - **The recipe** (`RasterRecipe`, written to the maker's contract C-RM1): for each member, in z order, the stored
 *   shape the emitter would write WITHOUT its geometry (box, flips, fill, gradient, stroke, ends, opacity: the
 *   effect fields only where the capability list allows them), its geometry as built paths in the member's box space
 *   as base64, and, for a text-bearing member, its text object and the font families it needs. A candidate's
 *   geometry is the WIDE compile of the `a:custGeom` the walk kept, past the converter's own limits (and past the
 *   screens', which never draw it); any other member's is what the screens draw for its stored object.
 * - **The put-back list** (`EmittedRaster`): the objects each member would be without the picture, in z order, which
 *   the hub puts back when it cannot make the picture. A candidate comes back in the form the planner worked out
 *   (D5), so a failed picture never leaves a slide past the converter's own limits.
 *
 * THE WIDE COMPILE IS INJECTED (`RasterGeometry`): the renderer's `compileGeom` and `buildGeom` take an optional
 * `limits` that replaces the points of a path and the number of paths for one call (the maker's renderer commit);
 * this file declares their shape and the emitter's context carries them, so that it builds and is tested against
 * today's renderer and is wired to the real functions when they are merged. The reader that feeds the compile is
 * here (`readWide`): the converter's own (`geom.ts` `readCustGeom`) stops at the stored limits.
 *
 * Returns false, leaving `out` as it was, when it can write none: nothing is written or registered unless the
 * whole run can be drawn (a picture is complete or not made).
 */
import type { ImageObject, ObjectOrigin, ShapeObject, SlideObject, TextObject } from '@ordo/domain';
import {
  type GeomNotes,
  type GeomSource,
  type GuidePairs,
  newGeomNotes,
  type PathCmdSource,
  type PathSource,
  type SiteSource,
} from '@ordo/renderer/geom/compile.ts';
import { boxSide, legacyGeometry, storedPath } from '@ordo/renderer/geom/built.ts';
import {
  CMD_CLOSE,
  CMD_CUBIC,
  CMD_LINE,
  CMD_MOVE,
  CMD_QUAD,
  type CompiledGeom,
  GEOM_LIMITS,
} from '@ordo/renderer/geom/ops.ts';
import { type BuiltGeom, type GeomPath, presetGeometry } from '@ordo/renderer/geom/path.ts';
import type { EmitOne } from './decor.ts';
import type { Element, Frame, ShapeElement } from './ir.ts';
import { boxPx } from './frame.ts';
import {
  canonicalBytes,
  commandCost,
  encodePath,
  encodeRefs,
  hashOfBytes,
  pathListOf,
  RASTER_DENSITY,
  RASTER_POINTS,
  RASTER_READ,
  RASTER_RUN,
  RASTER_VERSION,
  type RasterMember,
  type RasterPath,
  type RasterRecipe,
  type RasterShape,
  type RasterText,
  rasterPlaceholder,
  rawPointCost,
} from './raster.ts';
import {
  type RasterElement,
  type RasterMemberPlan,
  type RasterRunPlan,
  rasterFormOf,
} from './raster-plan.ts';
import { CONVERTER_VERSION } from './version.ts';
import { child, type PathCommand, pathCommands, type XNode } from './xml.ts';

// ── What the emitter is handed ──────────────────────────────────────────────────────────────────────────────

/** The two limits of a wide compile: the points of a path and the number of paths, for one call (never stored). */
export interface RasterLimits {
  points: number;
  paths: number;
}

/** The renderer's `compileGeom` with its optional third parameter. */
export type RasterCompile = (
  src: GeomSource,
  notes: GeomNotes | undefined,
  limits: RasterLimits,
) => CompiledGeom;

/** The renderer's `buildGeom` with its optional last parameter (the adjust pairs a custom geometry needs none of). */
export type RasterBuild = (
  geom: CompiledGeom,
  w: number,
  h: number,
  adj: undefined,
  notes: GeomNotes | undefined,
  limits: RasterLimits,
) => BuiltGeom;

/** The wide compile and build, injected together. */
export interface RasterGeometry {
  compile: RasterCompile;
  build: RasterBuild;
}

/** What the converter records of one picture (`EmittedSlide.rasters`, C-SR6). */
export interface EmittedRaster {
  /** The placeholder media id, one per distinct recipe in the deck. */
  id: string;
  /** The ids of the slide's objects drawn from it: the picture. */
  uses: string[];
  /** The objects as they are without the picture, in z order: the members' (a shape and its text with one group). */
  objects: SlideObject[];
  /** The members' shape ids (`p:cNvPr id`). */
  members: number[];
  /** The words of the members that carry text (the slide's imported text keeps them for search: Q68). */
  words?: string;
}

/** The part of the emitter's context this file reads (`EmitCtx` has these fields from step 5 of the track). */
export interface RasterEmitCtx {
  frame: Frame;
  newId: () => string;
  /** Origins are written (the emission is the rich one). */
  rich?: boolean;
  /**
   * Registers a recipe (one per distinct hash in the deck, `EmitResult.rasters`) and answers its placeholder media
   * id, which is `rasterPlaceholder(hash)`; undefined when a budget refuses it (the run is then not made).
   */
  raster?: (recipe: RasterRecipe, hash: string) => string | undefined;
  /** The slide's pictures so far (`EmittedSlide.rasters`). */
  rasters?: EmittedRaster[];
  rasterGeometry?: RasterGeometry;
  /** A group number for a shape and its text put back together (the emitter's counter of pairs). */
  pairGroup?: () => number | undefined;
  /** Told why a run could not be made (a short word: the report counts them). */
  rasterFailed?: (reason: string) => void;
}

/** The provenance of a picture (C-SR17); `file` and `slide` are added by the importer. */
export interface RasterProvenance {
  cv: number;
  rv: number;
  pts: number;
  h: string;
  n: number;
  from: 'slide' | 'layout' | 'master';
  refs?: [number, number, number][];
}

// ── Reading a custom geometry past the converter's limits ───────────────────────────────────────────────────

/** Children of one list scanned at most, as a multiple of what the list may hold (`geom.ts` `SCAN_FACTOR`). */
const SCAN_FACTOR = 4;
/** An attribute as the compiler reads it, cut one character past its bound so the bound still applies. */
const cut = (v: string | undefined, limit: number = GEOM_LIMITS.formula) =>
  v === undefined ? undefined : v.length > limit + 1 ? v.slice(0, limit + 1) : v;

function guideList(list: XNode | undefined): GuidePairs {
  const out: [string, string][] = [];
  const kids = list?.children ?? [];
  const scan = Math.min(kids.length, SCAN_FACTOR * GEOM_LIMITS.guides);
  for (let i = 0; i < scan && out.length <= GEOM_LIMITS.guides; i++) {
    const gd = kids[i]!;
    if (gd.name !== 'a:gd') continue;
    out.push([cut(gd.attrs.name, GEOM_LIMITS.name) ?? '', cut(gd.attrs.fmla) ?? '']);
  }
  return out;
}

function ptArgs(c: PathCommand, n: number): string[] {
  const args: string[] = [];
  for (const [x, y] of c.pts) {
    args.push(cut(x) ?? '0', cut(y) ?? '0');
    if (args.length >= 2 * n) break;
  }
  return args;
}

/** One command of a path as the compiler reads it, or undefined for another element (named by its local name: see raster.ts). */
function readCmd(c: PathCommand): PathCmdSource | undefined {
  const op = c.name.startsWith('a:') ? c.name.slice(2) : '';
  switch (op) {
    case 'moveTo':
    case 'lnTo':
      return { op, args: ptArgs(c, 1) };
    case 'arcTo':
      return {
        op,
        args: [
          cut(c.attrs.wR) ?? '0',
          cut(c.attrs.hR) ?? '0',
          cut(c.attrs.stAng) ?? '0',
          cut(c.attrs.swAng) ?? '0',
        ],
      };
    case 'quadBezTo':
      return { op, args: ptArgs(c, 2) };
    case 'cubicBezTo':
      return { op, args: ptArgs(c, 3) };
    case 'close':
      return { op, args: [] };
    default:
      return undefined;
  }
}

/** An `a:path` as ONE compiler path (the wide compile keeps a path whole up to `limits.points`). */
function readPathWide(p: XNode, budget: number): PathSource {
  const cmds: PathCmdSource[] = [];
  let total = 0;
  const scan = SCAN_FACTOR * budget;
  let seen = 0;
  for (const c of pathCommands(p)) {
    if (seen++ >= scan) break;
    const cost = commandCost(c.name);
    const cmd = cost === undefined ? undefined : readCmd(c);
    if (cost !== undefined && cmd) {
      total += cost;
      cmds.push(cmd);
    }
    if (total > budget) break;
  }
  const a = p.attrs;
  const attr = (k: string) => cut(a[k], 64);
  const out: { -readonly [K in keyof PathSource]: PathSource[K] } = { cmds };
  if (a.w !== undefined) out.w = attr('w');
  if (a.h !== undefined) out.h = attr('h');
  if (a.fill !== undefined) out.fill = attr('fill');
  if (a.stroke !== undefined) out.stroke = attr('stroke');
  if (a.extrusionOk !== undefined) out.extrusionOk = attr('extrusionOk');
  return out;
}

/**
 * An `a:custGeom` as the strings `compileGeom` reads, each `a:path` whole (at most `limits.paths` of them, each of at
 * most `limits.points` points): `geom.ts` `readCustGeom` does the same within the stored limits. Undefined when the
 * geometry has more paths than a recipe holds.
 */
export function readWide(node: XNode, limits: RasterLimits): GeomSource | undefined {
  const paths: PathSource[] = [];
  const kids = pathListOf(node)?.children ?? [];
  const scan = Math.min(kids.length, SCAN_FACTOR * limits.paths);
  for (let i = 0; i < scan; i++) {
    if (kids[i]!.name !== 'a:path') continue;
    if (paths.length >= limits.paths) return undefined;
    paths.push(readPathWide(kids[i]!, limits.points));
  }
  const sites: SiteSource[] = [];
  const cxnKids = child(node, 'a:cxnLst')?.children ?? [];
  const cxnScan = Math.min(cxnKids.length, SCAN_FACTOR * GEOM_LIMITS.sites);
  for (let i = 0; i < cxnScan && sites.length <= GEOM_LIMITS.sites; i++) {
    const c = cxnKids[i]!;
    if (c.name !== 'a:cxn') continue;
    const pos = child(c, 'a:pos');
    sites.push({ ang: cut(c.attrs.ang) ?? '0', x: cut(pos?.attrs.x) ?? '0', y: cut(pos?.attrs.y) ?? '0' });
  }
  const r = child(node, 'a:rect')?.attrs;
  const out: { -readonly [K in keyof GeomSource]: GeomSource[K] } = {
    av: guideList(child(node, 'a:avLst')),
    gd: guideList(child(node, 'a:gdLst')),
    paths,
    sites,
  };
  if (r) out.rect = { l: cut(r.l), t: cut(r.t), r: cut(r.r), b: cut(r.b) };
  return out;
}

// ── The recipe's geometry ───────────────────────────────────────────────────────────────────────────────────

/** Compiler notes that mean part of the drawing was dropped (`geom.ts` `LOST`). */
const LOST = /paths over the limit|path points over the limit/;

/** What a built command costs a recipe (the renderer's `compile.ts` unit: move, line and close 1, quad 2, cubic 3). */
const PAIRS: Readonly<Record<number, number>> = {
  [CMD_MOVE]: 1,
  [CMD_LINE]: 1,
  [CMD_QUAD]: 2,
  [CMD_CUBIC]: 3,
  [CMD_CLOSE]: 0,
};
const COSTS: Readonly<Record<number, number>> = {
  [CMD_MOVE]: 1,
  [CMD_LINE]: 1,
  [CMD_QUAD]: 2,
  [CMD_CUBIC]: 3,
  [CMD_CLOSE]: 1,
};

/** A built path as the recipe writes it, and its cost; undefined for a command or a point a recipe cannot hold. */
function recipePath(p: GeomPath, cont: boolean): { path: RasterPath; cost: number } | undefined {
  let pairs = 0;
  let cost = 0;
  for (const op of p.cmds) {
    const n = PAIRS[op];
    if (n === undefined) return undefined;
    pairs += n;
    cost += COSTS[op]!;
  }
  if (p.pts.length !== pairs * 2) return undefined;
  for (const v of p.pts) if (!Number.isFinite(v)) return undefined;
  const e = encodePath(p.cmds, p.pts);
  return { path: { ...e, fill: p.fill, stroke: p.stroke, ...(cont ? { cont: true as const } : {}) }, cost };
}

/** The paths the screens draw for a stored shape object, in its box space (`decor.ts` `drawnOf` builds the same). */
function builtOf(o: ShapeObject): { path: GeomPath; cont: boolean }[] | undefined {
  const w = boxSide(o.box.w);
  const h = boxSide(o.box.h);
  if (o.geom) {
    if (typeof o.geom.preset === 'string') {
      const g = presetGeometry(o.geom.preset, w, h, o.geom.adj as [string, number][] | undefined);
      return g ? g.paths.map((path) => ({ path, cont: false })) : undefined;
    }
    if (Array.isArray(o.geom.paths) && o.geom.paths.length && o.geom.ref === undefined)
      return o.geom.paths.map((p, k) => ({ path: storedPath(p, w, h), cont: k > 0 && p.cont === true }));
    return undefined;
  }
  return legacyGeometry(o.shape, o.radius ?? 0, w, h).paths.map((path) => ({ path, cont: false }));
}

// ── One member ──────────────────────────────────────────────────────────────────────────────────────────────

/** A deep copy of plain data (the objects the emitter writes hold numbers, strings, booleans, arrays and plain objects). */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The font families a text object needs (`@ordo/domain` `slideUses` collects the same). */
function familiesOf(t: TextObject): string[] {
  const out = new Set<string>();
  const add = (f: unknown) => {
    if (typeof f === 'string' && f.trim()) out.add(f.slice(0, 256));
  };
  add(t.style?.fontFamily);
  for (const f of t.style?.fallbackFonts ?? []) add(f);
  for (const r of t.runs ?? []) add(r.fontFamily);
  for (const p of t.paras ?? []) add(p?.bullet?.fontFamily);
  return [...out].slice(0, 32);
}

/**
 * The shape a candidate is drawn from: the element with a stored geometry in place of the one it has (a placeholder
 * path, never drawn), so that the emitter writes the fields it writes for a shape it draws natively: fill, outline,
 * gradient, flips, ends and, for a text-bearing one, its text object, laid out in the text rectangle of the
 * geometry. The recipe holds none of this placeholder: its geometry is the wide compile's.
 */
function recipeForm(e: RasterElement): ShapeElement {
  const today = e.rasterOf!.today;
  return {
    ...e,
    custom: {
      paths: [{ d: 'M 0 0 L 1 0 L 1 1 Z', w: 1, h: 1 }],
      points: 3,
      text: today.text,
      sites: today.sites,
      notes: [],
      ink: 1,
    },
  };
}

/** The element in the form it has without its picture (D5): a candidate comes back as the planner worked out. */
function putBackForm(m: RasterMemberPlan): ShapeElement {
  const e = m.element;
  if (!m.candidate || !e.rasterOf || !m.form) return e;
  return { ...e, custom: rasterFormOf(e.rasterOf, m.form) };
}

const ORIGIN_SRC = 'pptx';
const MAX_GROUP = 100_000;

/** Where an object came from (`emit.ts` `originOf`: the same fields, so a put-back object has the origin it would have had). */
function originFor(e: Element, o: SlideObject, group: number | undefined): ObjectOrigin {
  const role =
    e.from !== 'slide'
      ? 'deco'
      : o.type === 'image'
        ? 'picture'
        : o.type === 'shape'
          ? 'shape'
          : !e.ph
            ? 'text'
            : e.ph.type === 'title' || e.ph.type === 'ctrTitle'
              ? 'title'
              : 'body';
  const out: ObjectOrigin = { src: ORIGIN_SRC, role };
  if (Number.isInteger(e.shapeId) && e.shapeId > 0) out.shapeId = Math.min(2_147_483_647, e.shapeId);
  if (e.ph) {
    const type = e.ph.type.replace(/[^A-Za-z]/g, '').slice(0, 24) || 'obj';
    const idx = e.ph.idx?.replace(/[^0-9]/g, '').slice(0, 10);
    out.ph = idx ? `${type}:${idx}` : type;
  }
  if (group !== undefined && Number.isInteger(group) && group >= 0) out.group = Math.min(MAX_GROUP, group);
  return out;
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Write a run (`planRasters`) as one picture on `out` and return true, or return false, leaving `out` as it was
 * and nothing registered, when it writes none. `emitOne` emits a member as the single-element emitter does.
 */
export function emitRaster(
  ctx: RasterEmitCtx,
  run: RasterRunPlan,
  out: SlideObject[],
  emitOne: EmitOne,
): boolean {
  const fail = (reason: string): false => {
    ctx.rasterFailed?.(reason);
    return false;
  };
  if (!ctx.raster) return fail('no-registry');
  if (!run.members.length || run.members.length > RASTER_RUN.members) return fail('members');
  const rect = run.rect;
  const w = rect.w * RASTER_DENSITY;
  const h = rect.h * RASTER_DENSITY;
  if (!(w >= 1 && h >= 1 && w * h <= RASTER_RUN.pixels)) return fail('pixels');
  const limits: RasterLimits = { points: RASTER_READ.pointsShape, paths: RASTER_RUN.paths };

  const members: RasterMember[] = [];
  const putBack: SlideObject[] = [];
  let points = 0;
  let texts = 0;
  for (const m of run.members) {
    const e = m.element;
    // 1. The member as the emitter writes it for a shape drawn natively: its shape and its text object.
    const sink: SlideObject[] = [];
    emitOne(m.candidate ? recipeForm(e) : e, sink);
    const shapeObj = sink.find((o): o is ShapeObject => o.type === 'shape');
    const textObj = sink.find((o): o is TextObject => o.type === 'text');
    // 2. Its geometry, in its box space. A member with words and nothing to paint (no fill, no outline) has none.
    let geometry: { path: GeomPath; cont: boolean }[] | undefined;
    let base: RasterShape;
    if (shapeObj) {
      const { id: _i, geom: _g, origin: _o, locked: _l, ...rest } = clone(shapeObj);
      base = { ...rest, ...(rest.shape === 'line' ? { shape: 'rect' as const } : {}) } as RasterShape;
    } else if (textObj) {
      const b = boxPx(ctx.frame, e.xf);
      base = {
        type: 'shape',
        box: { x: b.x, y: b.y, w: b.w, h: b.h, rotation: b.rotation },
        shape: 'rect',
        opacity: 1,
        radius: 0,
      };
      geometry = [];
    } else return fail('geometry');
    if (m.candidate) {
      const cand = e.rasterOf;
      if (!cand?.node) return fail('geometry');
      const raw = rawPointCost(cand.node);
      if (raw.capped || raw.points > RASTER_READ.pointsShape) return fail('read-bound');
      if (raw.paths > limits.paths) return fail('paths');
      if (shapeObj) {
        if (!ctx.rasterGeometry) return fail('no-compile');
        const src = readWide(cand.node, limits);
        if (!src) return fail('paths');
        const notes = newGeomNotes();
        const side = (v: number) => (Number.isFinite(v) && v > 0 ? v : 1);
        let built: BuiltGeom;
        try {
          const compiled = ctx.rasterGeometry.compile(src, notes, limits);
          built = ctx.rasterGeometry.build(
            compiled,
            side(base.box.w),
            side(base.box.h),
            undefined,
            notes,
            limits,
          );
        } catch {
          return fail('geometry');
        }
        if (notes.messages.some((x) => LOST.test(x))) return fail('read-bound');
        geometry = built.paths.map((path) => ({ path, cont: false }));
      }
    } else if (shapeObj) geometry = builtOf(shapeObj);
    if (!geometry || (!geometry.length && shapeObj)) return fail('geometry');
    if (geometry.length > RASTER_RUN.paths) return fail('paths');
    const paths: RasterPath[] = [];
    let cost = 0;
    for (const { path, cont } of geometry) {
      const rp = recipePath(path, cont && paths.length > 0);
      if (!rp) return fail('geometry');
      paths.push(rp.path);
      cost += rp.cost;
    }
    if (cost > RASTER_RUN.pointsMember) return fail('read-bound');
    points += cost;
    if (points > RASTER_RUN.points) return fail('recipe-points');
    const b = base.box;
    if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) return fail('geometry');
    const member: RasterMember = { shape: base, geom: { paths } };
    if (textObj) {
      if (++texts > RASTER_RUN.texts) return fail('texts');
      const { id: _i, origin: _o, locked: _l, ...rest } = clone(textObj);
      member.text = rest as RasterText;
      const families = familiesOf(textObj);
      if (families.length) member.families = families;
    }
    members.push(member);
    // 3. The member as it is without the picture (the put-back list).
    const back: SlideObject[] = [];
    emitOne(putBackForm(m), back);
    const group = e.group ?? (back.length > 1 ? ctx.pairGroup?.() : undefined);
    if (ctx.rich) for (const o of back) o.origin ??= originFor(e, o, group);
    putBack.push(...back);
  }

  const recipe: RasterRecipe = {
    v: 1,
    w,
    h,
    box: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    density: RASTER_DENSITY,
    members,
  };
  let bytes: Uint8Array;
  try {
    bytes = canonicalBytes(recipe);
  } catch {
    return fail('recipe');
  }
  if (bytes.length > RASTER_RUN.bytes) return fail('recipe-bytes');
  const hash = hashOfBytes(bytes);
  const placeholder = rasterPlaceholder(hash);
  const id = ctx.raster(recipe, hash);
  if (id === undefined) return fail('budget');
  if (id !== placeholder) return fail('placeholder');

  const first = run.members[0]!.element;
  const image: ImageObject = {
    id: ctx.newId(),
    type: 'image',
    box: { x: rect.x, y: rect.y, w: rect.w, h: rect.h, rotation: 0 },
    mediaId: id,
    fit: 'stretch',
    opacity: 1,
    radius: 0,
    locked: true,
  };
  if (ctx.rich) {
    const provenance: RasterProvenance = {
      cv: CONVERTER_VERSION,
      rv: RASTER_VERSION,
      pts: RASTER_POINTS,
      h: hash.slice(0, 16),
      n: members.length,
      from: run.from,
    };
    const refs = encodeRefs(run.refs);
    if (refs) provenance.refs = refs;
    const origin: ObjectOrigin & { raster?: RasterProvenance } = { src: ORIGIN_SRC, role: 'raster' };
    if (Number.isInteger(first.shapeId) && first.shapeId > 0)
      origin.shapeId = Math.min(2_147_483_647, first.shapeId);
    if (run.group !== undefined && Number.isInteger(run.group) && run.group >= 0)
      origin.group = Math.min(MAX_GROUP, run.group);
    origin.raster = provenance;
    image.origin = origin;
  }
  out.push(image);
  ctx.rasters?.push({
    id,
    uses: [image.id],
    objects: putBack,
    members: run.members.map((m) => m.element.shapeId),
    ...(run.words ? { words: run.words } : {}),
  });
  return true;
}
