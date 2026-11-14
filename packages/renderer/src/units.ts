import { LOGICAL_HEIGHT, LOGICAL_WIDTH, type Look, type Slide, type SlideObject } from '@ordo/domain';
import { clampLook, clampSlide, num } from './clamp.ts';
import { drawableContent } from './content.ts';
import type { Ctx2D } from './ctx.ts';
import { digest } from './digest.ts';
import { charged, GEOM_COST, hasPart } from './geom/cost.ts';
import { geomAwaited, geomFilesVersion } from './geom/stored.ts';
import {
  drawnCost,
  legacyCopy,
  legacyOf,
  overGeomBudget,
  slideBudget,
  withinDrawBudget,
} from './geombudget.ts';
import { geomShapeReach } from './sprite.ts';
import { geomShapeSteps, hasShapeExtras } from './shape.ts';
import { type CachedSprite, SpriteCache } from './spritecache.ts';
import { drawObject, type ImageLookup, registerSlideObjectsDrawer } from './text2d.ts';

/*
 * Geometry units (design/27 §12-13, M9 decisions "Slow-to-draw elements", Runtime: draw it, never drop it). The
 * slide's drawing budget (`geombudget.ts`) sends a stored geometry past `GEOM_COST.slide` to its legacy copy, so
 * that no synchronous draw passes §13's 50 ms task. On the outputs and the desktop thumbnails such an object is
 * drawn whole instead, from a unit made beforehand in slices:
 *
 * - **What**: each shape of a stored geometry `overGeomBudget` sends to a legacy copy ('geom' or 'both'), drawn
 *   whole (`slideUnits`): the geometry, gradient, dash, arrowheads and outline as `drawObject` draws them, with
 *   the shadow, glow and soft edge the budget kept for it ('geom': drawn on its legacy copy before units) when
 *   the shape and its effects together are within `GEOM_COST.slide` (`unitDrawn`), else without its effects;
 *   in z-order while their area is within `UNIT_SLIDE_AREAS` frames. Never text, and never a table, chart,
 *   decoration or 3-D look (their own drawers; effect units and decorations come with effect-units). Until
 *   effect units these keep their legacy copies (`slideUnitsLeft`, counted by the census): a plain shape past
 *   the budget for its paint (its first colour), a shape no task could draw (alone past `GEOM_COST.slide`: its
 *   legacy line draws nothing for thin line art), a masked picture (drawn without its mask) and the objects past
 *   the slide's `UNIT_SLIDE_AREAS`; and a shape whose effects would put its one call past a task is drawn
 *   without them (design/27 §13 lists all as effect-units must items).
 * - **Where**: at the job's device scale, over the object's reach (`geomShapeReach` of what it draws) rounded out
 *   to whole device px and cut to the frame (the logical frame at that scale), so its origin is an integer and a
 *   1:1 copy at that origin is the very pixels drawing it there would give.
 * - **Making** (`makeUnit`, `prepareSlideUnits`): in steps on the job's lane turns, as many a turn as fit in half
 *   of `SLICE_MS`: a scratch canvas of the frame, then each draw call of the object (`shape.ts` `geomShapeSteps`:
 *   a path's fill, its outline) at the frame's own transform, then its rect copied 1:1 into the unit's picture
 *   (`transferToImageBitmap`, no copy). The very pixels drawing the object on the frame gives: no clip and no
 *   other transform, which would move Skia's anti-aliasing (a band clipped out of a curve is flattened anew, up
 *   to a whole level at its edges: measured, design/27 §13). A step is at most one call of a shape within
 *   `GEOM_COST.slide` (about 38 ms at 4K, cold), within §13's 50 ms task.
 * - **Keeping** (`unitCache`): one cache for every unit of the thread, `UNIT_CACHE_BYTES` (192 MiB, the owner's
 *   figure for all units: effect units extend it, never a second cache), least recently used first, with
 *   counted pins: the asset worker pins a job's units from its prepare step to its raster, and keeps a cue's
 *   pinned while it is armed or warmed. Keys (`unitKey`, `UNIT_VERSION`): a digest of the drawn fields (its
 *   geometry file by hash, never an id), the scale, the origin and the cut.
 * - **Drawing** (the slide objects' drawer registered below): `drawSlide2D` draws each object the budget sends to a
 *   legacy copy whose unit is ready as a copy of the unit, under a context whose transform is a whole-pixel
 *   translation (else as before); `sprite.ts` `slideReach` sizes it by the unit's rect and `sceneSlides` splits
 *   by its original's bounds (`geombudget.ts` `legacyOf`). A unit not ready yet leaves its legacy copy.
 */

/** Bumped whenever a unit's pixels for the same key would change (keys of older units then miss). */
export const UNIT_VERSION = 1;
/** A unit's turn on the lane is cut after about this long (ms; each step is measured). */
export const SLICE_MS = 10;
/** Bytes of units kept for drawing, every kind together (a full-frame unit at 4K is 33 MB). */
export const UNIT_CACHE_BYTES = 192 * 1024 * 1024;
/**
 * The area of a slide's units at most, in frames: a slide copies at most one frame of units, about 5 ms at 4K
 * on the asset worker's software canvas (a 16 MB unit 1.7 ms), on top of a draw the drawing budget holds to
 * about 38 ms; past it, later objects keep their legacy copies. So a cue holds at most one frame of units (33 MB
 * at 4K), and the live, armed and warmed cues fit the cache.
 */
export const UNIT_SLIDE_AREAS = 1;
/**
 * A job makes units for at most this long (ms of its lane's time): the rest of its objects are drawn as their
 * legacy copies this time, and a later job of the slide goes on with them (what is made stays cached).
 */
export const UNIT_WAIT_MS = 1_000;

/** A unit's rect in frame device px: whole px, its origin at the top left. */
export interface UnitRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** An object past the slide's drawing budget, as its unit draws it. */
export interface GeomUnit {
  readonly key: string;
  /** The object as the slide holds it (clamped). */
  readonly object: SlideObject;
  /** What the unit draws: the object without its effects. */
  readonly drawn: SlideObject;
  /** Device px per logical px. */
  readonly scale: number;
  readonly rect: UnitRect;
  /** Its bitmap's bytes. */
  readonly bytes: number;
}

/** A unit's picture. */
export interface UnitImage extends CachedSprite {
  readonly source: CanvasImageSource;
  readonly w: number;
  readonly h: number;
}

/** The units of this thread (the asset worker's, a thumbnail worker's, the harness page's). */
export const unitCache = new SpriteCache<UnitImage>(UNIT_CACHE_BYTES);

/** What making units did so far on this thread (tests and health read the difference across a job). */
const work = { made: 0, steps: 0, turns: 0 };

/** Units made, steps drawn and lane turns taken by `makeUnit` on this thread so far. */
export function unitWork(): { made: number; steps: number; turns: number } {
  return { ...work };
}

/** Forget every unpinned unit (tests, a cold measurement, memory pressure). */
export function clearUnits(): void {
  unitCache.clear('unit');
}

/** Keep a unit from eviction until it is unpinned as often (made already or not yet). */
export function pinUnit(key: string): void {
  unitCache.pin('unit', key);
}

export function unpinUnit(key: string): void {
  unitCache.unpin('unit', key);
}

/** Keep `source` as the picture of `u` (its rect's size); false when the cache does not take it. */
export function putUnit(u: GeomUnit, source: CanvasImageSource): boolean {
  const close = () => {
    const s = source as { close?: () => void };
    if (typeof s.close === 'function') s.close();
  };
  const kept = unitCache.set('unit', u.key, { source, w: u.rect.w, h: u.rect.h, bytes: u.bytes, close });
  if (!kept) close();
  return kept;
}

/** The picture of `u` if it is ready. */
export function unitReady(u: GeomUnit): UnitImage | undefined {
  return unitCache.get('unit', u.key);
}

// ── Which objects, where, under which key ───────────────────────────────────────────────────────────────

/**
 * Whether a unit draws `o` whole: a shape of a stored geometry (custom or preset: its legacy copy is another
 * shape, a rect, an ellipse or a line) drawn by the geometry engine alone (`drawGeomShape`); never text. A plain
 * shape past the budget for its gradient, dash or arrowheads keeps its legacy copy (the same shape in its first
 * colour, a plain outline) until effect units, as a unit's copy costs its area on top of the budget's draw.
 */
function unitShape(o: SlideObject): boolean {
  if (o.type !== 'shape' || !hasShapeExtras(o)) return false;
  const s = o as Record<string, unknown>;
  if (s.geom === undefined) return false;
  return s.table === undefined && s.chart === undefined && s.decor === undefined && s.look3d === undefined;
}

/** A field a unit's key leaves out: what names or places the object in the editor, never what it draws. */
const NOT_DRAWN = new Set(['id', 'origin', 'locked']);
const fieldsMemo = new WeakMap<object, string>();

/** A digest of what an object draws (its fields but `NOT_DRAWN`; a geometry file by its hash, `ShapeGeom.ref`). */
function drawnFields(o: SlideObject): string {
  let d = fieldsMemo.get(o);
  if (d === undefined) {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!NOT_DRAWN.has(k)) fields[k] = v;
    d = digest(JSON.stringify(fields));
    fieldsMemo.set(o, d);
  }
  return d;
}

/**
 * The key of a unit: `UNIT_VERSION`, the digest of the drawn fields of what it draws (box, turn and flips,
 * paints, geometry by its file's hash), the scale, its origin and its cut (`rect`). One function, so that a
 * later key (effect units: SHA-256 of canonical JSON) replaces it in one place.
 */
export function unitKey(drawn: SlideObject, scale: number, rect: UnitRect): string {
  return `u${UNIT_VERSION}:${drawnFields(drawn)}@${scale}:${rect.x},${rect.y},${rect.w}x${rect.h}`;
}

/** The frame at `scale` in device px (the logical frame's, rounded up). */
function frameAt(scale: number): { w: number; h: number } {
  return { w: Math.ceil(LOGICAL_WIDTH * scale - 1e-6), h: Math.ceil(LOGICAL_HEIGHT * scale - 1e-6) };
}

/** Where `drawn` draws at `scale`, whole device px cut to the frame; undefined when nowhere on it. */
function rectOf(drawn: SlideObject, scale: number): UnitRect | undefined {
  if (drawn.type !== 'shape' || geomAwaited(drawn.geom)) return undefined;
  const frame = frameAt(scale);
  const r = geomShapeReach(drawn, scale);
  // Unknown reach: the whole frame.
  const x0 = r ? Math.max(0, Math.floor(r.x * scale)) : 0;
  const y0 = r ? Math.max(0, Math.floor(r.y * scale)) : 0;
  const x1 = r ? Math.min(frame.w, Math.ceil((r.x + r.w) * scale)) : frame.w;
  const y1 = r ? Math.min(frame.h, Math.ceil((r.y + r.h) * scale)) : frame.h;
  if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)))
    return undefined;
  if (r && !(r.w > 0 && r.h > 0)) return undefined;
  if (!(x1 > x0 && y1 > y0)) return undefined;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const unitMemo = new WeakMap<SlideObject, { version: number; byScale: Map<string, GeomUnit | null> }>();

/**
 * What a unit of `o` draws: `o` with its effects when the budget kept them (`keepEffects`: its legacy copy is
 * 'geom', the effects drawn on it) and the object drawn whole with them is within `GEOM_COST.slide` (one call
 * of the making, the effects included); else `o` without its effects (the budget left them out too, 'both',
 * or they would put the one call past a task: drawn without them until effect units, design/27 §13).
 */
function unitDrawn(o: SlideObject, keepEffects: boolean): SlideObject {
  if (!hasPart(o, 'effects')) return o;
  if (keepEffects && charged(drawnCost(o)) <= GEOM_COST.slide) return o;
  return legacyCopy(o, 'effects');
}

/**
 * The unit of an object the budget sends to a legacy copy (`o` as the slide holds it, clamped), at `scale`,
 * with its effects when `keepEffects` (its legacy copy is 'geom': the budget kept them, `unitDrawn`):
 * undefined when a unit cannot draw it (`unitShape`), its geometry file is not read yet, it draws nothing on
 * the frame, its unit would be past half the cache, or drawing it alone is past `GEOM_COST.slide` (a hostile
 * object no task could draw: 24,000 arrowheads, a 500 px outline on a tiny path, a full-slide line art of
 * thousands of holes; it keeps its legacy copy, as the budget has it, until effect units slice it: an open must
 * item, design/27 §13). Memoised per object, scale, effects and geometry files read.
 */
export function unitOf(o: SlideObject, scale: number, keepEffects = false): GeomUnit | undefined {
  if (!o || !unitShape(o)) return undefined;
  const s = num(scale, 0.01, 8, 1);
  const version = geomFilesVersion();
  let m = unitMemo.get(o);
  if (!m || m.version !== version) unitMemo.set(o, (m = { version, byScale: new Map() }));
  const at = `${s}|${keepEffects ? 1 : 0}`;
  let u = m.byScale.get(at);
  if (u === undefined) {
    const drawn = unitDrawn(o, keepEffects);
    const rect = charged(drawnCost(drawn)) <= GEOM_COST.slide ? rectOf(drawn, s) : undefined;
    const bytes = rect ? rect.w * rect.h * 4 : 0;
    u =
      rect && bytes <= UNIT_CACHE_BYTES / 2
        ? { key: unitKey(drawn, s, rect), object: o, drawn, scale: s, rect, bytes }
        : null;
    if (m.byScale.size >= 8) m.byScale.clear();
    m.byScale.set(at, u);
  }
  return u ?? undefined;
}

/** Whether the budget kept `o`'s effects though it sends its geometry to a legacy copy ('geom'). */
function keptEffects(o: SlideObject, copy: SlideObject | undefined): boolean {
  return !!copy && legacyOf(copy)?.part === 'geom' && hasPart(o, 'effects');
}

/**
 * An object the budget sends to a legacy copy that gets no unit, and why: `alone` (drawing it alone is past
 * `GEOM_COST.slide`), `kind` (no unit draws it: a plain shape, a masked picture), `area` (past the slide's
 * `UNIT_SLIDE_AREAS`), `nowhere` (nothing on the frame, or a file not read yet). The census counts them
 * (`unitsLeft`), so the ratchet sees what draws as its legacy copy on the outputs.
 */
export type UnitLeft = 'alone' | 'kind' | 'area' | 'nowhere';

/** The objects of a slide (clamped, in z-order) the budget sends to legacy copies that get no unit at `scale`. */
export function slideUnitsLeft(objects: readonly SlideObject[], scale: number): UnitLeft[] {
  const s = num(scale, 0.01, 8, 1);
  const over = overGeomBudget(objects);
  if (!over.size) return [];
  const withUnit = new Set(slideUnits(objects, s).map((u) => u.object));
  const copies = slideBudget(objects);
  const out: UnitLeft[] = [];
  for (const o of objects) {
    if (!over.has(o) || withUnit.has(o)) continue;
    if (!unitShape(o)) out.push('kind');
    else if (charged(drawnCost(unitDrawn(o, keptEffects(o, copies.get(o))))) > GEOM_COST.slide)
      out.push('alone');
    else if (unitOf(o, s, keptEffects(o, copies.get(o)))) out.push('area');
    else out.push('nowhere');
  }
  return out;
}

const slideMemo = new WeakMap<
  readonly SlideObject[],
  { version: number; byScale: Map<number, GeomUnit[]> }
>();
/**
 * The scales at which each object (a slide's, clamped) is drawn from its unit, with the geometry files read
 * when `slideUnits` planned it: a plan made before a file was read is planned again before it is drawn so.
 */
const planned = new WeakMap<SlideObject, Map<number, number>>();

/**
 * The units a slide's objects (`slideContent`'s, clamped, in z-order) ask for at `scale`: one for each object
 * the slide's drawing budget sends to a legacy copy ('geom' or 'both') that a unit can draw (`unitOf`), in
 * z-order, while their area stays within `UNIT_SLIDE_AREAS` frames (later ones keep their legacy copies). What
 * the drawers copy (`drawSlide2D`, a scene's parts) is this plan. Memoised per objects array, scale and geometry
 * files read.
 */
export function slideUnits(objects: readonly SlideObject[], scale: number): readonly GeomUnit[] {
  const s = num(scale, 0.01, 8, 1);
  const version = geomFilesVersion();
  let m = slideMemo.get(objects);
  if (!m || m.version !== version) slideMemo.set(objects, (m = { version, byScale: new Map() }));
  let out = m.byScale.get(s);
  if (!out) {
    out = [];
    const over = overGeomBudget(objects);
    const copies = slideBudget(objects);
    const frame = frameAt(s);
    let area = 0;
    if (over.size)
      for (const o of objects) {
        if (!over.has(o)) continue;
        const u = unitOf(o, s, keptEffects(o, copies.get(o)));
        if (!u) continue;
        const a = (u.rect.w * u.rect.h) / (frame.w * frame.h);
        if (area + a > UNIT_SLIDE_AREAS) continue;
        area += a;
        out.push(u);
        let at = planned.get(o);
        if (!at) planned.set(o, (at = new Map()));
        at.set(s, version);
      }
    if (m.byScale.size >= 8) m.byScale.clear();
    m.byScale.set(s, out);
  }
  return out;
}

/** The objects a slide draws as authored with `look` (none for a look that draws bands or hides it). */
function authoredObjects(slide: Slide, look: Look | undefined): readonly SlideObject[] {
  if (look && clampLook(look).layers.slide.mode !== 'authored') return [];
  return drawableContent(clampSlide(slide)).objects;
}

/** The units `drawSlide2D` with `look` at `scale` would copy for `slide` (`slideUnits`). */
export function unitsOfSlide(slide: Slide, scale: number, look?: Look): readonly GeomUnit[] {
  const objects = authoredObjects(slide, look);
  return objects.length ? slideUnits(objects, scale) : [];
}

// ── Making ──────────────────────────────────────────────────────────────────────────────────────────────

/** How a unit's making takes the lane: a turn for a synchronous slice, a check for a cancelled job. */
export interface UnitRun {
  /** Runs a synchronous slice of work in a turn (the asset worker's lanes; at once elsewhere). */
  slice<T>(fn: () => T): Promise<T>;
  /** Throws when the job was cancelled. */
  check(): void;
  /** The clock (tests). */
  now?(): number;
}

/** A software-backed 2D canvas (read back each step; its bitmap is the CPU's, as the asset worker's surface). */
function canvas2d(
  w: number,
  h: number,
): { canvas: OffscreenCanvas; c: OffscreenCanvasRenderingContext2D } | undefined {
  if (typeof OffscreenCanvas === 'undefined') return undefined;
  try {
    const canvas = new OffscreenCanvas(w, h);
    const c = canvas.getContext('2d', { willReadFrequently: true });
    return c ? { canvas, c } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Make `u` (see the header) in steps on the lane's turns of `run`, as many a turn as fit in about half of
 * `SLICE_MS` (at least one): the scratch canvas of the frame made, then each draw call of the object
 * (`geomShapeSteps`: a path's fill, its outline) at the frame's own transform, then its rect copied 1:1 into the
 * unit's own picture, kept in `unitCache`. So the unit is the very pixels drawing the object on the frame gives,
 * and no step draws more than one call (of a shape within `GEOM_COST.slide`, about 38 ms at 4K, cold). Resolves
 * with the longest turn (ms), 0 when it was ready already, or undefined when no unit could be made (no canvas, a
 * drawing error): the object then keeps its legacy copy. A cancelled job (`run.check`) stops between turns, and
 * nothing is kept.
 */
export async function makeUnit(u: GeomUnit, run: UnitRun): Promise<number | undefined> {
  if (unitCache.has('unit', u.key)) return 0;
  const now = run.now ?? (() => performance.now());
  const frame = frameAt(u.scale);
  // A unit with the object's effects is one call (the shape and its layers through the effects path, within
  // `GEOM_COST.slide` with them: `unitDrawn`); one without is a call a path's fill or outline.
  const drawn = u.drawn;
  const draws: ((ctx: Ctx2D) => void)[] =
    drawn.type !== 'shape'
      ? []
      : hasPart(drawn, 'effects')
        ? [(ctx) => drawObject(ctx, drawn, u.scale)]
        : geomShapeSteps(drawn, u.scale);
  const { x, y, w, h } = u.rect;
  let scratch: ReturnType<typeof canvas2d>;
  let unit: ReturnType<typeof canvas2d>;
  // A canvas defers its drawing: each step is made to draw now (a one-pixel read), so its time is the step's.
  const steps: (() => void)[] = [
    () => {
      scratch = canvas2d(frame.w, frame.h);
      scratch?.c.getImageData(0, 0, 1, 1);
    },
    ...draws.map((draw) => () => {
      if (!scratch) return;
      draw(scratch.c as unknown as Ctx2D);
      scratch.c.getImageData(x, y, 1, 1);
    }),
    () => {
      if (!scratch) return;
      unit = canvas2d(w, h);
      unit?.c.drawImage(scratch.canvas, x, y, w, h, 0, 0, w, h);
      unit?.c.getImageData(0, 0, 1, 1);
      scratch = undefined;
    },
  ];
  let at = 0;
  let failed = false;
  let longest = 0;
  while (at < steps.length && !failed) {
    run.check();
    const t0 = now();
    await run.slice(() => {
      try {
        do {
          steps[at++]!();
          work.steps++;
        } while (at < steps.length && now() - t0 < SLICE_MS / 2);
      } catch (err) {
        // The renderer draws what it can of hostile content; a throw here leaves the legacy copy.
        console.warn('[ordo units] a geometry unit could not be drawn', err);
        failed = true;
      }
    });
    work.turns++;
    longest = Math.max(longest, now() - t0);
  }
  scratch = undefined;
  if (failed || !unit) return undefined;
  run.check();
  // Its bitmap taken from the canvas (no copy).
  if (!putUnit(u, unit.canvas.transferToImageBitmap())) return undefined;
  work.made++;
  return longest;
}

/** What `prepareSlideUnits` did. */
export interface SlideUnitsMade {
  /** Units the slide's plan copies (`slideUnits`). */
  readonly units: number;
  /** Made by this call. */
  readonly made: number;
  /** Ready already. */
  readonly ready: number;
  /** Left to their legacy copies this time (past `UNIT_WAIT_MS`, or not drawable here). */
  readonly left: number;
  /** Bytes of the slide's units held after it. */
  readonly bytes: number;
  /** Its longest turn, ms. */
  readonly longestMs: number;
  /** Its time, ms (turns and waits). */
  readonly ms: number;
}

/** How `prepareSlideUnits` keeps what it makes. */
export interface SlideUnitsOptions {
  /** Called with each unit's key before it is made or used (the caller unpins it when its job is done). */
  pin?(key: string): void;
  /** `UNIT_WAIT_MS` unless given. */
  waitMs?: number;
}

/**
 * Make the units `drawSlide2D` with `look` at `scale` copies for `slide` (`unitsOfSlide`: the plan worked out in
 * a turn of its own), in z-order, each in the lane's turns of `run` (`makeUnit`); those ready already are only
 * pinned. Bounded: past `waitMs` of making, the rest are left to their legacy copies this time. Never throws but
 * for a cancelled job.
 */
export async function prepareSlideUnits(
  slide: Slide,
  scale: number,
  look: Look | undefined,
  run: UnitRun,
  opts: SlideUnitsOptions = {},
): Promise<SlideUnitsMade> {
  const now = run.now ?? (() => performance.now());
  // The plan (the budget, each unit's reach and key: a digest of its fields) in a turn of the lane.
  const units = authoredObjects(slide, look).length
    ? await run.slice(() => unitsOfSlide(slide, scale, look))
    : [];
  const waitMs = opts.waitMs ?? UNIT_WAIT_MS;
  const t0 = now();
  let made = 0;
  let ready = 0;
  let left = 0;
  let bytes = 0;
  let longestMs = 0;
  for (const u of units) {
    if (unitCache.has('unit', u.key)) {
      opts.pin?.(u.key);
      ready++;
      bytes += u.bytes;
      continue;
    }
    if (now() - t0 > waitMs) {
      left++;
      continue;
    }
    opts.pin?.(u.key);
    run.check();
    const longest = await makeUnit(u, run);
    if (longest === undefined) {
      left++;
      continue;
    }
    made++;
    bytes += u.bytes;
    longestMs = Math.max(longestMs, longest);
  }
  return { units: units.length, made, ready, left, bytes, longestMs, ms: now() - t0 };
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────────

/** The ready unit `drawSlide2D` copies for `o`, an object as the budget draws it, at `scale`; if any. */
function readyFor(o: SlideObject, scale: number): { u: GeomUnit; img: UnitImage } | undefined {
  const from = legacyOf(o);
  if (!from || from.part === 'effects') return undefined;
  if (planned.get(from.original)?.get(scale) !== geomFilesVersion()) return undefined;
  const u = unitOf(from.original, scale, from.part === 'geom' && hasPart(from.original, 'effects'));
  if (!u) return undefined;
  const img = unitCache.get('unit', u.key);
  return img ? { u, img } : undefined;
}

/** Whether the context's transform is a translation by whole device px (a 1:1 copy is exact under it). */
function wholePixels(ctx: Ctx2D): boolean {
  // A context that cannot say (a test's stand-in) is taken as untransformed, as the drawers take it.
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : undefined;
  if (!m) return true;
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && Number.isInteger(m.e) && Number.isInteger(m.f);
}

/** `drawSlide2D`'s objects with their ready units copied in place of the legacy copies; false when none is. */
function drawWithUnits(
  ctx: Ctx2D,
  _raw: Slide,
  objects: readonly SlideObject[],
  scale: number,
  images?: ImageLookup,
): boolean {
  if (!unitCache.count('unit')) return false;
  const s = num(scale, 0.01, 8, 1);
  // The objects as the budget draws them: a part of a slide (`sceneSlides`) holds the legacy copies already.
  const drawn = withinDrawBudget(objects);
  let ready: ({ u: GeomUnit; img: UnitImage } | undefined)[] | undefined;
  for (let i = 0; i < drawn.length; i++) {
    const r = readyFor(drawn[i]!, s);
    if (r) (ready ??= [])[i] = r;
  }
  if (!ready || !wholePixels(ctx)) return false;
  for (let i = 0; i < drawn.length; i++) {
    const r = ready[i];
    if (!r) {
      drawObject(ctx, drawn[i]!, s, images);
      continue;
    }
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(r.img.source, r.u.rect.x, r.u.rect.y);
    ctx.restore();
  }
  return true;
}

/** Where `o`, as the budget draws it, reaches when its unit is drawn (the unit's rect, logical px). */
function unitReach(
  o: SlideObject,
  scale: number,
): { x: number; y: number; w: number; h: number } | undefined {
  if (!unitCache.count('unit')) return undefined;
  const s = num(scale, 0.01, 8, 1);
  const r = readyFor(o, s);
  if (!r) return undefined;
  const { x, y, w, h } = r.u.rect;
  return { x: x / s, y: y / s, w: w / s, h: h / s };
}

registerSlideObjectsDrawer({ draw: drawWithUnits, reach: unitReach });
