import {
  canonicalJson,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Look,
  type ShapeObject,
  type Slide,
  type SlideObject,
} from '@ordo/domain';
import { CLAMP, clampLook, clampSlide, num } from './clamp.ts';
import { drawableContent } from './content.ts';
import type { Ctx2D } from './ctx.ts';
import { decorFilesVersion } from './decor/files.ts';
import { digest } from './digest.ts';
import { EFFECT_STEP_PIXELS, effectRect, effectSteps } from './effects.ts';
import { charged, GEOM_COST, hasPart, type LegacyPart } from './geom/cost.ts';
import { geomAwaited, geomFilesVersion } from './geom/stored.ts';
import {
  drawnCost,
  legacyCopy,
  legacyOf,
  registerUnitCopies,
  slideBudget,
  withinDrawBudget,
} from './geombudget.ts';
import { hasPictureEffects, pictureTarget, preparedKey } from './picture.ts';
import { geomShapeReach } from './sprite.ts';
import {
  type Affine,
  boxTransform,
  decorHooks,
  decorHooksGeneration,
  drawGeomShape,
  geomBodySteps,
  geomEffectSource,
  geomShapeSteps,
  hasShapeExtras,
  placeBox,
} from './shape.ts';
import { type CachedSprite, SpriteCache } from './spritecache.ts';
import { drawObject, type ImageLookup, registerSlideObjectsDrawer } from './text2d.ts';

/*
 * Units (design/14 "Geometry units" and "Effect units", design/27 §13, M9 decisions "Slow-to-draw elements",
 * Runtime: draw it, never drop it). The slide's drawing budget (`geombudget.ts`) sends an object past
 * `GEOM_COST.slide` or `EFFECT_COST.slide` to a legacy copy, so that no synchronous draw passes §13's 50 ms task.
 * On the outputs, the desktop thumbnails and the harness such an object is drawn whole instead, from a unit made
 * beforehand in slices; the editor and phones keep the legacy copies.
 *
 * - **What** (`slideUnits`, `effectWanted`): in z-order while their area is within `UNIT_SLIDE_AREAS` frames, a
 *   `whole` unit of a shape past the geometry budget (with its gradient, dash, arrowheads and effects), a
 *   `sliced` one of a geometry past `GEOM_COST.slide` alone, a `layers` unit of a full-opacity shape's shadow and
 *   glow past the effect budget (its body drawn live), a `whole` one of a soft-edged or translucent shape past
 *   it, a `whole` one of a decoration past `DECOR_SPRITE`, and a masked picture's prepared bitmap (`prepared`).
 *   Never text, tables, charts, 3-D looks or a picture's effects (`slideUnitsLeft` counts what keeps its legacy
 *   copy, and why; the census reads it). `setEffectUnits(false)` plans 62a1c3a's geometry units only.
 * - **Where**: at the job's device scale over the object's reach (a shape's geometry, or its composite with its
 *   layers, `effects.ts` `effectRect`), whole device px cut to the frame, so a 1:1 copy at its origin is the very
 *   pixels drawing it there gives.
 * - **Making** (`makeUnit`, `prepareSlideUnits`): in steps on the job's lane turns, as many a turn as fit in half
 *   of `SLICE_MS` (a decoration at most `DECOR_TURN_SHAPES`): on a scratch of the frame, one draw call a step, then
 *   its rect copied out; with effects, `effectSteps` (the compose path of `drawEffected`, in steps and bands). No
 *   clip and no other transform, which would move Skia's anti-aliasing (measured, design/27 §13).
 * - **Keeping** (`unitCache`): one cache for every unit of the thread, `UNIT_CACHE_BYTES` (192 MiB, the owner's
 *   figure for all units), least recently used first, with counted pins (the asset worker's jobs). Keys
 *   (`unitKey`): canonical JSON of what is drawn, digested; the position only where the frame cuts the unit.
 * - **Drawing** (the slide objects' drawer registered below): `drawSlide2D` copies each ready unit 1:1 in
 *   z-order under a whole-pixel translation; a unit not ready leaves the legacy copy, and with `late` (an output
 *   raster) a decoration's is left out and reported.
 */

/** Bumped whenever a unit's pixels for the same key would change (keys of older units then miss). */
export const UNIT_VERSION = 2;
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
/** A decoration unit's shapes drawn in one turn at most (`drawDecorRange`), each turn within `SLICE_MS`. */
export const DECOR_TURN_SHAPES = 32;
/**
 * A sliced unit's step at most, in drawing units (`GEOM_COST`): a group of sub-paths whose estimates add up to
 * about half of `SLICE_MS` at 4K (`GEOM_COST.nsPerUnit`).
 */
export const SLICE_UNITS = Math.round(((SLICE_MS / 2) * 1e6) / GEOM_COST.nsPerUnit);

/** A unit's rect in frame device px: whole px, its origin at the top left. */
export interface UnitRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * How a unit draws its object (design/14 "Effect units"):
 * - `whole`: the object entirely (its geometry, paint and effects), the object itself skipped where it is copied;
 * - `layers`: the shadow and glow of a full-opacity shape (or a picture's shadow under its prepared bitmap), the
 *   body drawn live over it (`drawGeomShape` 'body');
 * - `sliced`: a geometry past `GEOM_COST.slide` on its own, made one group of sub-paths a step (`geomBodySteps`).
 */
export type UnitKind = 'whole' | 'layers' | 'sliced';

/**
 * What a unit is of: a shape (a stored or preset geometry, a plain shape's gradient, dash or arrowheads, its
 * effects), a decoration past `DECOR_SPRITE`, or a masked picture whose prepared bitmap (the asset worker's,
 * cut to its mask in slices) is drawn in place of the budget's copy without its mask (`prepared`: no bitmap of
 * its own, 0 bytes).
 */
export type UnitOf = 'shape' | 'decor' | 'prepared';

/** An object past the slide's drawing budget, as its unit draws it. */
export interface GeomUnit {
  readonly key: string;
  readonly kind: UnitKind;
  readonly of: UnitOf;
  /** The object as the slide holds it (clamped). */
  readonly object: SlideObject;
  /** What the unit draws: the object with its effects (effect units), or without them (`setEffectUnits(false)`). */
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

/** Bytes of units this thread holds (the unit cache's own count, every kind): what health reads. */
export function unitCacheBytes(): number {
  return unitCache.bytes('unit');
}

// ── The switch ──────────────────────────────────────────────────────────────────────────────────────────

let effectUnitsOn = true;
let switches = 0;

/**
 * Effect units on (the default) or off (a venue troubleshooting switch: an output's `?effects=base`, wired by
 * the asset worker's init): off, this thread plans the units 62a1c3a planned, geometry units only (a stored
 * geometry past the budget, its effects kept only within one call), and draws effects past the budget, plain
 * shapes past it for their paint and masked pictures as their legacy copies, and decorations directly.
 */
export function setEffectUnits(on: boolean): void {
  if (on === effectUnitsOn) return;
  effectUnitsOn = on;
  switches++;
}

/** Whether effect units are on in this thread (`setEffectUnits`). */
export function effectUnits(): boolean {
  return effectUnitsOn;
}

/**
 * The media a picture unit's key names (the asset worker's media id to decoded file hash; default: the id).
 * A media id that resolves to nothing is keyed as missing, so no unit made before a media delete matches.
 */
let mediaOf: ((id: string) => string | undefined) | undefined;
let mediaResolvers = 0;

/** Install how a unit's key names its media (`mediaOf`); undefined puts the default back. */
export function setUnitMedia(resolve: ((id: string) => string | undefined) | undefined): void {
  mediaOf = resolve;
  mediaResolvers++;
}

/** What a plan depends on besides its objects and scale: files read, the decoration drawer, the switch. */
function generation(): number {
  return geomFilesVersion() + decorFilesVersion() + decorHooksGeneration() + switches + mediaResolvers;
}

// ── Which objects, where, under which key ───────────────────────────────────────────────────────────────

/**
 * Whether a unit draws `o` whole with effect units off (62a1c3a's geometry units): a shape of a stored geometry
 * drawn by the geometry engine alone (`drawGeomShape`); never text, a table, a chart, a decoration or 3-D.
 */
function unitShape(o: SlideObject): boolean {
  if (o.type !== 'shape' || !hasShapeExtras(o)) return false;
  const s = o as Record<string, unknown>;
  if (s.geom === undefined) return false;
  return s.table === undefined && s.chart === undefined && s.decor === undefined && s.look3d === undefined;
}

/**
 * Whether an effect unit draws a shape: one the geometry engine draws alone (`drawGeomShape`: a stored or preset
 * geometry, or a plain shape with a gradient, dash, arrowheads or effects); never text, a table, a chart, a
 * decoration (its own unit) or a 3-D look.
 */
function effectShape(o: SlideObject): boolean {
  if (o.type !== 'shape' || !hasShapeExtras(o)) return false;
  const s = o as Record<string, unknown>;
  return s.table === undefined && s.chart === undefined && s.decor === undefined && s.look3d === undefined;
}

/** A field a unit's key leaves out: what names or places the object in the editor, never what it draws. */
const NOT_DRAWN = new Set(['id', 'origin', 'locked']);

/**
 * What an object draws, for its unit's key: its fields but `NOT_DRAWN` (a geometry file by its hash,
 * `ShapeGeom.ref`), its box without its position unless `placed` (the frame cuts the unit), a picture's media id
 * as its file (`setUnitMedia`), in canonical JSON (keys sorted: the same object read back keys the same).
 */
function drawnFields(o: SlideObject, placed: boolean): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!NOT_DRAWN.has(k)) fields[k] = v;
  if (!placed && o.box) {
    const { x: _x, y: _y, ...size } = o.box;
    fields.box = size;
  }
  if (o.type === 'image') {
    const id = o.mediaId;
    const file = mediaOf ? mediaOf(id) : id;
    fields.mediaId = file === undefined ? `missing:${id}` : `file:${file}`;
  }
  return fields;
}

const keyMemo = new WeakMap<SlideObject, Map<string, string>>();

/** A sub-pixel phase as a key part (6 decimals: float noise never splits a key). */
const phaseOf = (v: number) => (((v % 1) + 1) % 1).toFixed(6);

/**
 * The key of a unit (bake-on-save critic corrections): a digest (`digest.ts`) of canonical JSON of
 * `UNIT_VERSION`, its kind, what it is of and what it draws (`drawnFields`: no id, origin or lock; no position
 * when the frame does not cut it, `placed`), then in memory only the device scale, the box's sub-pixel phase on
 * the device (`phase`: two objects at the same phase draw the same pixels), the unit's size and, `placed`, its
 * origin. An id change keeps the key, any drawn field (an effect, a paint, the kind) changes it, and a unit made
 * for one place is copied at another of the same phase.
 */
export function unitKey(
  u: { readonly kind: UnitKind; readonly of: UnitOf; readonly drawn: SlideObject },
  scale: number,
  rect: UnitRect,
  phase: readonly [number, number],
  placed: boolean,
): string {
  const at = `${u.kind}|${u.of}|${placed ? 1 : 0}|${mediaResolvers}`;
  let m = keyMemo.get(u.drawn);
  if (!m) keyMemo.set(u.drawn, (m = new Map()));
  let d = m.get(at);
  if (d === undefined) {
    d = digest(canonicalJson({ v: UNIT_VERSION, kind: u.kind, of: u.of, o: drawnFields(u.drawn, placed) }));
    if (m.size >= 8) m.clear();
    m.set(at, d);
  }
  const where = placed ? `@${rect.x},${rect.y}` : '';
  return `u${UNIT_VERSION}:${d}@${scale}:${phaseOf(phase[0])},${phaseOf(phase[1])}:${rect.w}x${rect.h}${where}`;
}

/** The frame at `scale` in device px (the logical frame's, rounded up). */
function frameAt(scale: number): { w: number; h: number } {
  return { w: Math.ceil(LOGICAL_WIDTH * scale - 1e-6), h: Math.ceil(LOGICAL_HEIGHT * scale - 1e-6) };
}

/**
 * A logical rect at `scale` as whole device px, rounded out, and the same cut to the frame; undefined when
 * not finite or of no size, `cut` undefined when nowhere on the frame.
 */
function deviceRects(
  r: { x: number; y: number; w: number; h: number } | null | undefined,
  scale: number,
): { full: UnitRect; cut: UnitRect | undefined } | undefined {
  const frame = frameAt(scale);
  if (r === null) {
    const all = { x: 0, y: 0, w: frame.w, h: frame.h };
    return { full: all, cut: all };
  }
  if (!r || !(r.w > 0 && r.h > 0)) return undefined;
  const x0 = Math.floor(r.x * scale);
  const y0 = Math.floor(r.y * scale);
  const x1 = Math.ceil((r.x + r.w) * scale);
  const y1 = Math.ceil((r.y + r.h) * scale);
  if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)))
    return undefined;
  const full = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const cx0 = Math.max(0, x0);
  const cy0 = Math.max(0, y0);
  const cx1 = Math.min(frame.w, x1);
  const cy1 = Math.min(frame.h, y1);
  const cut = cx1 > cx0 && cy1 > cy0 ? { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 } : undefined;
  return { full, cut };
}

/** Whether the frame cuts `full` (its cut differs). */
const cutBy = (full: UnitRect, cut: UnitRect) =>
  full.x !== cut.x || full.y !== cut.y || full.w !== cut.w || full.h !== cut.h;

/** A shape's box space on the device at `scale` (`boxTransform` with its flips). */
function shapeTransform(o: SlideObject, scale: number): Affine {
  return boxTransform(
    o.box,
    scale,
    (o as { flipH?: boolean }).flipH === true,
    (o as { flipV?: boolean }).flipV === true,
  );
}

/** Where `drawn` draws at `scale` without effects (the geometry's reach), as device rects. */
function reachRects(drawn: SlideObject, scale: number) {
  if (drawn.type !== 'shape' || geomAwaited(drawn.geom)) return undefined;
  // Unknown reach: the whole frame.
  return deviceRects(geomShapeReach(drawn, scale) ?? null, scale);
}

/** Where a shape and its layers' composite lands at `scale` (`effects.ts` `effectRect`), as device rects. */
function effectRects(o: ShapeObject, scale: number) {
  const src = geomEffectSource(o, shapeTransform(o, scale));
  if (!src) return undefined;
  const frame = frameAt(scale);
  const r = effectRect(src, frame.w, frame.h);
  if (!r) return r === null ? { full: { x: 0, y: 0, w: 0, h: 0 }, cut: undefined } : undefined;
  const full = { x: r.x, y: r.y, w: r.w, h: r.h };
  const cx0 = Math.max(0, r.x);
  const cy0 = Math.max(0, r.y);
  const cx1 = Math.min(frame.w, r.x + r.w);
  const cy1 = Math.min(frame.h, r.y + r.h);
  return { full, cut: cx1 > cx0 && cy1 > cy0 ? { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 } : undefined };
}

/**
 * What a unit of `o` draws with effect units off (62a1c3a): `o` with its effects when the budget kept them
 * (`keepEffects`: its legacy copy is 'geom') and the object drawn whole with them is within `GEOM_COST.slide`,
 * else `o` without its effects.
 */
function baseDrawn(o: SlideObject, keepEffects: boolean): SlideObject {
  if (!hasPart(o, 'effects')) return o;
  if (keepEffects && charged(drawnCost(o)) <= GEOM_COST.slide) return o;
  return legacyCopy(o, 'effects');
}

/**
 * An object past the budget that gets no unit, and why: `alone` (no draw call within a task draws it: one
 * sub-path past `GEOM_COST.geometry`, with effect units off any shape alone past `GEOM_COST.slide`), `kind` (no
 * unit draws it: a table, a chart, a 3-D look, a picture's effects; with effect units off a plain shape or a
 * masked picture), `area` (past the slide's `UNIT_SLIDE_AREAS`), `nowhere` (nothing on the frame, a file not
 * read yet). The census counts them (`unitsLeft`; `unitsAlone` fails it).
 */
export type UnitLeft = 'alone' | 'kind' | 'area' | 'nowhere';

type Wanted = { u: GeomUnit } | { left: UnitLeft } | undefined;

/** A unit as planned: its kind, what it is of and draws, its rects and phase. */
function unitAt(
  o: SlideObject,
  kind: UnitKind,
  of: UnitOf,
  drawn: SlideObject,
  scale: number,
  rects: { full: UnitRect; cut: UnitRect | undefined } | undefined,
  phase: readonly [number, number],
): Wanted {
  if (!rects?.cut) return { left: 'nowhere' };
  const rect = rects.cut;
  const bytes = of === 'prepared' ? 0 : rect.w * rect.h * 4;
  if (bytes > UNIT_CACHE_BYTES / 2) return { left: 'area' };
  const u = { kind, of, drawn };
  return {
    u: { key: unitKey(u, scale, rect, phase, cutBy(rects.full, rect)), ...u, object: o, scale, rect, bytes },
  };
}

/** The unit 62a1c3a planned for `o` (effect units off), with what the budget left out (`part`). */
function baseWanted(o: SlideObject, part: LegacyPart | undefined, s: number): Wanted {
  if (part !== 'geom' && part !== 'both') return undefined;
  if (!unitShape(o)) return { left: 'kind' };
  const drawn = baseDrawn(o, part === 'geom' && hasPart(o, 'effects'));
  if (charged(drawnCost(drawn)) > GEOM_COST.slide) return { left: 'alone' };
  const m = shapeTransform(o, s);
  return unitAt(o, 'whole', 'shape', drawn, s, reachRects(drawn, s), [m.e, m.f]);
}

/**
 * The unit effect units plan for `o` (clamped, the slide's), whose legacy copy leaves out `part` (undefined:
 * drawn as it is), at `s` (design/14 "Effect units"):
 * - a decoration past `DECOR_SPRITE`: `whole`, made by `drawDecorRange` (its own budget part: never refused);
 * - a shape past the geometry budget ('geom', 'both'), with its effects: `whole` when it alone is within
 *   `GEOM_COST.slide`, else `sliced` (`geomBodySteps`), else none (`alone`);
 * - a shape past the effect budget only ('effects'): `whole` when soft-edged or below full opacity, else
 *   `layers` (its shadow and glow; its body is drawn live, within the budget);
 * - a masked picture past the geometry budget: `prepared` (its prepared bitmap holds its mask);
 * - anything else past the budget (a table, a chart, 3-D, a picture's effects): none (`kind`).
 */
function effectWanted(o: SlideObject, part: LegacyPart | undefined, s: number): Wanted {
  if (o.type === 'shape' && o.decor !== undefined) {
    const hooks = decorHooks();
    if (!hooks?.capped(o)) return undefined;
    const m = shapeTransform(o, s);
    return unitAt(o, 'whole', 'decor', o, s, deviceRects(hooks.reach(o), s), [m.e, m.f]);
  }
  if (part === undefined) return undefined;
  if (o.type === 'image') {
    if (part === 'effects') return { left: 'kind' };
    const t = pictureTarget(o, s);
    if (!t || (part === 'both' && hasPictureEffects(o))) return { left: 'kind' };
    return unitAt(
      o,
      'whole',
      'prepared',
      o,
      s,
      deviceRects({ x: t.x / s, y: t.y / s, w: t.w / s, h: t.h / s }, s),
      [0, 0],
    );
  }
  if (!effectShape(o)) return { left: 'kind' };
  const m = shapeTransform(o, s);
  const phase = [m.e, m.f] as const;
  const effects = hasPart(o, 'effects');
  const rects = effects ? effectRects(o as ShapeObject, s) : reachRects(o, s);
  if (part === 'effects') {
    if (!effects) return undefined;
    const soft = num((o as ShapeObject).softEdge, 0, CLAMP.maxEffectPx, 0) > 0;
    const whole = soft || num(o.opacity, 0, 1, 1) < 1;
    return unitAt(o, whole ? 'whole' : 'layers', 'shape', o, s, rects, phase);
  }
  const body = charged(drawnCost(effects ? legacyCopy(o, 'effects') : o));
  if (body <= GEOM_COST.slide) return unitAt(o, 'whole', 'shape', o, s, rects, phase);
  if (!geomBodySteps(o as ShapeObject, SLICE_UNITS)) return { left: 'alone' };
  return unitAt(o, 'sliced', 'shape', o, s, rects, phase);
}

const wantedMemo = new WeakMap<SlideObject, { gen: number; by: Map<string, Wanted> }>();

/** `effectWanted` or `baseWanted` (`setEffectUnits`), memoised per object, part, scale and generation. */
function wanted(o: SlideObject, part: LegacyPart | undefined, s: number): Wanted {
  const gen = generation();
  let m = wantedMemo.get(o);
  if (!m || m.gen !== gen) wantedMemo.set(o, (m = { gen, by: new Map() }));
  const at = `${s}|${part ?? ''}`;
  if (m.by.has(at)) return m.by.get(at);
  const w = effectUnitsOn ? effectWanted(o, part, s) : baseWanted(o, part, s);
  if (m.by.size >= 8) m.by.clear();
  m.by.set(at, w);
  return w;
}

/** What the budget leaves out of `o` (its legacy copy's part), undefined when it is drawn as it is. */
function partOf(o: SlideObject, copies: ReadonlyMap<SlideObject, SlideObject>): LegacyPart | undefined {
  const c = copies.get(o);
  return c ? legacyOf(c)?.part : undefined;
}

/**
 * The unit of `o` (a slide object, clamped) at `scale` as if alone on its slide, with what the budget leaves out
 * of it (`part`; default: its geometry, as when past `GEOM_COST.slide`): undefined when none would draw it.
 */
export function unitOf(
  o: SlideObject,
  scale: number,
  part: LegacyPart | boolean = 'geom',
): GeomUnit | undefined {
  if (!o) return undefined;
  const p: LegacyPart = part === true ? 'geom' : part === false ? 'both' : part;
  const w = wanted(o, p, num(scale, 0.01, 8, 1));
  return w && 'u' in w ? w.u : undefined;
}

/** The objects of a slide (clamped, in z-order) past the budget that get no unit at `scale`, and why. */
export function slideUnitsLeft(objects: readonly SlideObject[], scale: number): UnitLeft[] {
  const s = num(scale, 0.01, 8, 1);
  const copies = slideBudget(objects);
  const withUnit = new Set(slideUnits(objects, s).map((u) => u.object));
  const out: UnitLeft[] = [];
  for (const o of objects) {
    const w = wanted(o, partOf(o, copies), s);
    if (!w || withUnit.has(o)) continue;
    out.push('left' in w ? w.left : 'area');
  }
  return out;
}

const slideMemo = new WeakMap<readonly SlideObject[], { gen: number; byScale: Map<number, GeomUnit[]> }>();
/** Each object's unit at each scale, with the generation `slideUnits` planned it at (what the drawers copy). */
const planned = new WeakMap<SlideObject, Map<number, { gen: number; u: GeomUnit }>>();

/**
 * The units a slide's objects (`slideContent`'s, clamped, in z-order) ask for at `scale`: one for each object
 * `wanted` plans one for, in z-order, while their area stays within `UNIT_SLIDE_AREAS` frames (later ones keep
 * their legacy copies, counted 'area'; a prepared picture's has no area of its own). What the drawers copy
 * (`drawSlide2D`, a scene's parts) is this plan. Memoised per objects array, scale and generation.
 */
export function slideUnits(objects: readonly SlideObject[], scale: number): readonly GeomUnit[] {
  const s = num(scale, 0.01, 8, 1);
  const gen = generation();
  let m = slideMemo.get(objects);
  if (!m || m.gen !== gen) slideMemo.set(objects, (m = { gen, byScale: new Map() }));
  let out = m.byScale.get(s);
  if (!out) {
    out = [];
    const copies = slideBudget(objects);
    const frame = frameAt(s);
    let area = 0;
    for (const o of objects) {
      const w = wanted(o, partOf(o, copies), s);
      if (!w || !('u' in w)) continue;
      const u = w.u;
      if (u.bytes > 0) {
        const a = (u.rect.w * u.rect.h) / (frame.w * frame.h);
        if (area + a > UNIT_SLIDE_AREAS + 1e-9) continue;
        area += a;
      }
      out.push(u);
      let at = planned.get(o);
      if (!at) planned.set(o, (at = new Map()));
      at.set(s, { gen, u });
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

/** What a unit's steps draw onto and how its picture is taken: the frame's scratch (copied out) or a composite. */
type UnitSteps = { steps: (() => void)[]; picture(): OffscreenCanvas | undefined; perTurn: number };

/**
 * A unit drawn as the frame draws its object (a shape without effects, a sliced shape, a decoration): a scratch
 * canvas of the frame, the object's draw calls on it at the frame's own transform (`draws`), then its rect
 * copied 1:1 into the unit's own canvas. No clip and no other transform, which would move Skia's anti-aliasing.
 */
function onFrame(u: GeomUnit, draws: ((ctx: Ctx2D) => void)[], perTurn: number): UnitSteps {
  const frame = frameAt(u.scale);
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
  return { steps, picture: () => unit?.canvas, perTurn };
}

/**
 * A unit of a shape and its effects: `effects.ts` `effectSteps`, the compose path of `drawEffected` in steps
 * (its layers made and enlarged in bands, its body call by call or one sub-path group a step, a soft edge's mask
 * once and its multiply in bands), then the composite's part on the frame copied into the unit at the shape's
 * opacity (`layers`: the layers alone, at full opacity, the body drawn live over them), in bands.
 */
function composite(u: GeomUnit, o: ShapeObject): UnitSteps | undefined {
  const frame = frameAt(u.scale);
  const src = geomEffectSource(o, shapeTransform(o, u.scale));
  const body = geomBodySteps(o, u.kind === 'sliced' ? SLICE_UNITS : undefined);
  if (!src || !body) return undefined;
  const es = effectSteps(src, body, frame.w, frame.h, u.kind === 'layers');
  if (!es) return undefined;
  const { x, y, w, h } = u.rect;
  const opacity = u.kind === 'layers' ? 1 : num(o.opacity, 0, 1, 1);
  let unit: ReturnType<typeof canvas2d>;
  const rows = Math.max(1, Math.floor(EFFECT_STEP_PIXELS / Math.max(1, w)));
  const copies: (() => void)[] = [
    () => {
      unit = canvas2d(w, h);
    },
  ];
  for (let y0 = 0; y0 < h; y0 += rows) {
    const n = Math.min(rows, h - y0);
    copies.push(() => {
      const from = es.result();
      if (!unit || !from) return;
      unit.c.save();
      unit.c.beginPath();
      unit.c.rect(0, y0, w, n);
      unit.c.clip();
      unit.c.globalAlpha = opacity;
      unit.c.drawImage(from, es.x - x, es.y - y);
      unit.c.restore();
      unit.c.getImageData(0, y0, 1, 1);
    });
  }
  return {
    steps: [...es.steps, ...copies],
    picture: () => (es.result() ? unit?.canvas : undefined),
    perTurn: Infinity,
  };
}

/** A shape's draw calls on the frame (box space placed, its opacity applied), one sub-path group a step. */
function slicedDraws(o: ShapeObject, scale: number): ((ctx: Ctx2D) => void)[] | undefined {
  const body = geomBodySteps(o, SLICE_UNITS);
  if (!body) return undefined;
  const opacity = num(o.opacity, 0, 1, 1);
  return body.map((step) => (ctx: Ctx2D) => {
    ctx.save();
    placeBox(ctx, o.box, scale, o.flipH === true, o.flipV === true);
    ctx.globalAlpha *= opacity;
    step(ctx);
    ctx.restore();
  });
}

/** How `u` is made, step by step (undefined: it cannot be made here). */
function unitSteps(u: GeomUnit): UnitSteps | undefined {
  const o = u.drawn;
  if (o.type !== 'shape') return undefined;
  if (u.of === 'decor') {
    const hooks = decorHooks();
    if (!hooks) return undefined;
    const n = hooks.count(o);
    const draws: ((ctx: Ctx2D) => void)[] = [];
    for (let i = 0; i < n; i++) draws.push((ctx) => hooks.range(ctx, o, u.scale, i, i + 1));
    return onFrame(u, draws, DECOR_TURN_SHAPES);
  }
  if (hasPart(o, 'effects')) return composite(u, o);
  if (u.kind === 'sliced') {
    const draws = slicedDraws(o, u.scale);
    return draws ? onFrame(u, draws, Infinity) : undefined;
  }
  return onFrame(u, geomShapeSteps(o, u.scale), Infinity);
}

/**
 * Make `u` (see the header) in steps on the lane's turns of `run`: as many steps a turn as fit in about half of
 * `SLICE_MS` (at least one; a decoration's at most `DECOR_TURN_SHAPES`), each step one draw call of the object,
 * one blur of a reduced layer or one band of rows. Its picture is kept in `unitCache` (`putUnit`). Resolves with
 * the longest turn (ms), 0 when it was ready already (or has no picture of its own, `prepared`), or undefined when
 * no unit could be made (no canvas, a drawing error): the object then keeps its legacy copy. A cancelled job
 * (`run.check`) stops between turns, and nothing is kept.
 */
export async function makeUnit(u: GeomUnit, run: UnitRun): Promise<number | undefined> {
  if (u.of === 'prepared' || unitCache.has('unit', u.key)) return 0;
  const now = run.now ?? (() => performance.now());
  const plan = unitSteps(u);
  if (!plan) return undefined;
  const { steps } = plan;
  let at = 0;
  let failed = false;
  let longest = 0;
  while (at < steps.length && !failed) {
    run.check();
    const t0 = now();
    await run.slice(() => {
      try {
        let n = 0;
        do {
          steps[at++]!();
          work.steps++;
          n++;
        } while (at < steps.length && n < plan.perTurn && now() - t0 < SLICE_MS / 2);
      } catch (err) {
        // The renderer draws what it can of hostile content; a throw here leaves the legacy copy.
        console.warn('[ordo units] a unit could not be drawn', err);
        failed = true;
      }
    });
    work.turns++;
    longest = Math.max(longest, now() - t0);
  }
  const picture = failed ? undefined : plan.picture();
  if (!picture) return undefined;
  run.check();
  // Its bitmap taken from the canvas (no copy).
  if (!putUnit(u, picture.transferToImageBitmap())) return undefined;
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
  // The plan (the budget, each unit's kind, reach and key: canonical JSON digested) in a turn of the lane.
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
    if (u.of === 'prepared' || unitCache.has('unit', u.key)) {
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

/** The unit planned for `o` (an object of the slide, clamped) at `scale` in this generation, if any. */
function plannedFor(o: SlideObject, scale: number): GeomUnit | undefined {
  const e = planned.get(o)?.get(scale);
  return e && e.gen === generation() ? e.u : undefined;
}

/** The original of an object as the budget draws it (its legacy copy's, else itself). */
const originalOf = (o: SlideObject) => legacyOf(o)?.original ?? o;

/** Whether a prepared picture's bitmap is what the lookup hands back for its target (its mask cut in). */
function preparedReady(o: SlideObject, scale: number, images: ImageLookup | undefined): boolean {
  if (o.type !== 'image' || !images) return false;
  const t = pictureTarget(o, scale);
  const img = t ? images(o.mediaId, t) : undefined;
  return !!t && !!img && preparedKey(img) === t.key;
}

/** The unit `drawSlide2D` copies for `o`, an object as the budget draws it, at `scale`, and whether it is ready. */
function unitFor(
  o: SlideObject,
  scale: number,
  images?: ImageLookup,
): { u: GeomUnit; img?: UnitImage; ready: boolean } | undefined {
  const u = plannedFor(originalOf(o), scale);
  if (!u) return undefined;
  if (u.of === 'prepared') return { u, ready: preparedReady(u.object, scale, images) };
  const img = unitCache.get('unit', u.key);
  return img ? { u, img, ready: true } : { u, ready: false };
}

/** Whether the context's transform is a translation by whole device px (a 1:1 copy is exact under it). */
function wholePixels(ctx: Ctx2D): boolean {
  // A context that cannot say (a test's stand-in) is taken as untransformed, as the drawers take it.
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : undefined;
  if (!m) return true;
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && Number.isInteger(m.e) && Number.isInteger(m.f);
}

/**
 * `drawSlide2D`'s objects with their units: in z-order, an object whose unit is ready is copied from it 1:1
 * (`layers`: its body drawn live over it; `prepared`: the picture drawn from its prepared bitmap), one whose
 * unit is not ready keeps its legacy copy (the cheap placeholder), and with `late` (an output raster, C2b) a
 * decoration whose unit is not ready is left out and reported (drawn directly it would be the long task), so it
 * fades in once made. False when it draws nothing differently (the slide is drawn as the budget has it).
 */
function drawWithUnits(
  ctx: Ctx2D,
  _raw: Slide,
  objects: readonly SlideObject[],
  scale: number,
  images?: ImageLookup,
  late?: (key: string) => void,
): boolean {
  const s = num(scale, 0.01, 8, 1);
  // The objects as the budget draws them: a part of a slide (`sceneSlides`) holds the legacy copies already.
  const drawn = withinDrawBudget(objects);
  let found: (ReturnType<typeof unitFor> | undefined)[] | undefined;
  let any = false;
  for (let i = 0; i < drawn.length; i++) {
    const f = unitFor(drawn[i]!, s, images);
    if (!f) continue;
    (found ??= [])[i] = f;
    if (f.ready || (late && f.u.of === 'decor')) any = true;
  }
  if (!found || !any) return false;
  const copies = wholePixels(ctx);
  if (!copies && !late) return false;
  for (let i = 0; i < drawn.length; i++) {
    const f = found[i];
    if (f?.ready && copies) {
      if (f.u.of === 'prepared') drawObject(ctx, f.u.object, s, images);
      else if (f.img) {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(f.img.source, f.u.rect.x, f.u.rect.y);
        ctx.restore();
        if (f.u.kind === 'layers' && f.u.object.type === 'shape') drawGeomShape(ctx, f.u.object, s, 'body');
      }
      continue;
    }
    if (f && late && f.u.of === 'decor') {
      late(f.u.key);
      continue;
    }
    drawObject(ctx, drawn[i]!, s, images);
  }
  return true;
}

/** Where `o`, as the budget draws it, reaches when its unit is drawn (the unit's rect, logical px). */
function unitReach(
  o: SlideObject,
  scale: number,
): { x: number; y: number; w: number; h: number } | undefined {
  const s = num(scale, 0.01, 8, 1);
  const f = unitFor(o, s);
  if (!f?.ready || f.u.of === 'prepared') return undefined;
  const { x, y, w, h } = f.u.rect;
  return { x: x / s, y: y / s, w: w / s, h: h / s };
}

/** The object a picture lookup is asked for in place of `o` (as the budget draws it): a prepared picture's original. */
function drawnFor(o: SlideObject, scale: number): SlideObject | undefined {
  const u = plannedFor(originalOf(o), num(scale, 0.01, 8, 1));
  return u?.of === 'prepared' ? u.object : undefined;
}

registerSlideObjectsDrawer({ draw: drawWithUnits, reach: unitReach, drawnFor });

/** A unit's area in slide areas (its rect at its scale over the logical frame). */
const slideAreas = (u: GeomUnit) => (u.rect.w * u.rect.h) / (u.scale * u.scale * LOGICAL_WIDTH * LOGICAL_HEIGHT);

/**
 * What a slide's units cost (health, the prepare step's report): `making`, the drawing units of what they draw
 * (`charged` of each object as its unit draws it), paid once at arm in the prepare step's turns, never in the
 * raster; `copy`, the slide areas the raster copies from them when warm.
 */
export function slideUnitsCost(slide: Slide, scale: number, look?: Look): { making: number; copy: number } {
  let making = 0;
  let copy = 0;
  for (const u of unitsOfSlide(slide, scale, look)) {
    if (u.of === 'prepared') continue;
    making += charged(drawnCost(u.drawn));
    copy += slideAreas(u);
  }
  return { making, copy };
}

// The raster's cost as health rates it (`geombudget.ts` `slideJobCost`): objects planned for units here are
// copies, at whichever scale this thread planned them (one an output).
registerUnitCopies((objects) => {
  let out: SlideObject[] | undefined;
  let area = 0;
  const gen = generation();
  for (const o of objects) {
    const at = planned.get(o);
    if (!at) continue;
    for (const e of at.values()) {
      if (e.gen !== gen || e.u.of === 'prepared') continue;
      (out ??= []).push(o);
      area += slideAreas(e.u);
      break;
    }
  }
  return out ? { objects: out, area } : undefined;
});
