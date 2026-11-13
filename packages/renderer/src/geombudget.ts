import { LOGICAL_HEIGHT, LOGICAL_WIDTH, type Look, type SlideObject, type TextObject } from '@ordo/domain';
import { CLAMP, clampLook, num } from './clamp.ts';
import { drawableContent } from './content.ts';
import { drawnBounds } from './geom/bounds.ts';
import { legacyGeometry } from './geom/built.ts';
import {
  charged,
  effectArea,
  type LegacyPart,
  objectCost,
  type Rated,
  slidePlan,
  withoutPart,
} from './geom/cost.ts';
import { outlineOf } from './geom/outline.ts';
import type { BuiltGeom } from './geom/path.ts';
import { geomFilesVersion, storedCost, storedGeometry } from './geom/stored.ts';
import { pictureTarget } from './picture.ts';
import { clampShapeObject } from './shape.ts';

/*
 * A slide's drawing budget (design/27 §12 "drawing cost", §13), the same for every drawer: the outputs'
 * asset worker and the thumbnail worker (`drawSlide2D`, `slidePictures`, `sceneSlides`) and the editor canvas.
 * - Geometry: in z-order, each shape and each picture mask is drawn while the drawing estimates of what is
 *   drawn (`objectCost`: fills with the pixels they paint, a gradient's about five times a colour's, outlines
 *   with their joins, caps, dashes and arrowheads, effect passes), on top of every object's legacy copy
 *   (counted first and never refused), stay within `GEOM_COST.slide` and the stored paths' points within
 *   `GEOM_COST.slidePoints` (§12's 64k); a later one is drawn as its legacy shape (`withoutPart` 'geom': a
 *   shape without its stored geometry, gradient (its first stop), dash, arrowheads, joins and caps; a picture
 *   without its mask), as an older build draws it. A stored geometry whose fill alone is over `GEOM_COST.geometry` is already its
 *   legacy shape (`storedGeometry`).
 * - Effects: shapes keep their shadow, glow and soft edge, and pictures their shadow and soft edge, while the
 *   area of their layers (`effectArea`, over what each shape draws: `bounds.ts` `drawnBounds`, the bounds
 *   `drawGeomShape` makes its layers over; over a picture's box, as `drawPictureEffected` makes them) stays
 *   within `EFFECT_COST.slide`; later ones are drawn without them.
 * The loop is `slidePlan`, which the converter runs on what it emits (`pptx-scene` `emit.ts`), after keeping
 * native slides within the same budgets as it reads them (`walk.ts` `slideCost`, `fitEffects`), so this
 * changes only what an edit, a save or a hostile file makes. Worked out again once a geometry file the slide
 * names is read.
 */

/** What a slide's objects cost as its drawing budget draws them (`slideDrawCost`). */
export interface SlideDrawCost {
  /** The drawing estimates and stored points of what is drawn (`charged`), in `GEOM_COST` units. */
  readonly units: number;
  /** The area of the effect layers drawn, in slide areas, weighted (`effectArea`). */
  readonly effects: number;
  /**
   * The glyphs drawn again blurred (`contentCost`: a box or run shadow, or a glow): each such character's em
   * square (its size squared), in slide areas; health's raster estimate reads it and the next ones
   * (`rasterEstimateMs`). Absent: none.
   */
  readonly textEffects?: number;
  /** The characters drawn (not white space): what laying the text out measures and drawing it fills. */
  readonly chars?: number;
  /** The pictures copied 1:1 from a prepared bitmap (`pictureTarget`): their area on the slide, in slide areas. */
  readonly pictures?: number;
  /** The pictures drawn from their source through a transform (turned, round corners, past 16 MP), likewise. */
  readonly sourcePictures?: number;
}

const memo = new WeakMap<
  readonly SlideObject[],
  {
    version: number;
    drawn: ReadonlyMap<SlideObject, SlideObject>;
    over: ReadonlySet<SlideObject>;
    cost: SlideDrawCost;
  }
>();
const copies = new WeakMap<SlideObject, { geom?: SlideObject; effects?: SlideObject; both?: SlideObject }>();
const rated = new WeakMap<SlideObject, { version: number; r: Rated; area: number }>();

/**
 * An object as drawn past a budget (`withoutPart`): without its stored geometry and costly outline fields
 * (`geom`), without its effects (`effects`), or both. Memoised per object, so the drawers' caches see one copy.
 */
export function legacyCopy<T extends SlideObject>(o: T, what: LegacyPart): T {
  let c = copies.get(o);
  if (!c) copies.set(o, (c = {}));
  const hit = c[what];
  if (hit) return hit as T;
  const out = withoutPart(o, what);
  c[what] = out;
  return out;
}

/** An object as its legacy shape: a shape without its stored geometry, a picture without its mask. */
export function withoutGeom<T extends SlideObject>(o: T): T {
  return legacyCopy(o, 'geom');
}

/** The geometry an object draws at its box, as the drawers build it, and its stored points. */
function drawnGeometry(o: SlideObject): { g: BuiltGeom | undefined; points: number } {
  if (o.type === 'shape') {
    const g = storedGeometry(o.geom, o.box.w, o.box.h);
    if (g) return { g, points: storedCost(g)?.points ?? 0 };
    return { g: legacyGeometry(o.shape, o.radius ?? 0, o.box.w, o.box.h), points: 0 };
  }
  if (o.type === 'image' && o.mask) {
    const g = storedGeometry(o.mask, o.box.w, o.box.h);
    return { g, points: (g && storedCost(g)?.points) ?? 0 };
  }
  return { g: undefined, points: 0 };
}

/** An object's estimate and effect area as drawn (clamped), memoised per object and files read. */
function ratedOf(o: SlideObject): { r: Rated; area: number } {
  const version = geomFilesVersion();
  const hit = rated.get(o);
  if (hit && hit.version === version) return hit;
  let r: Rated = { est: 0, points: 0 };
  let area = 0;
  if (o?.box && (o.type === 'shape' || o.type === 'image')) {
    const c = o.type === 'shape' ? clampShapeObject(o) : o;
    const { g, points } = drawnGeometry(c);
    r = { est: objectCost(c, g), points };
    // The effect layers cover what the shape draws, as `drawGeomShape` makes them; a picture's its box
    // (`picture-effects.ts`).
    if (c.type === 'shape' && g && (c.shadow || c.glow || c.softEdge))
      area = effectArea(c, drawnBounds(g, outlineOf(c)));
    else if (c.type === 'image' && (c.shadow || c.softEdge)) area = effectArea(c);
  }
  const out = { version, r, area };
  rated.set(o, out);
  return out;
}

/** What an object costs to draw (`objectCost`, clamped as drawn), memoised per object and files read. */
export function drawnCost(o: SlideObject): Rated {
  return ratedOf(o).r;
}

/**
 * What an object's effects weigh against the slide's effect budget (`effectArea` over what it draws,
 * `drawnBounds`, clamped as drawn), memoised per object and files read.
 */
export function drawnEffectArea(o: SlideObject): number {
  return ratedOf(o).area;
}

/**
 * The objects of `objects` (a slide's, in z-order) that its drawing budget changes, each with what is drawn
 * instead (`legacyCopy`). Memoised per objects array and geometry files read.
 */
export function slideBudget(objects: readonly SlideObject[]): ReadonlyMap<SlideObject, SlideObject> {
  return planOf(objects).drawn;
}

function planOf(objects: readonly SlideObject[]) {
  const version = geomFilesVersion();
  const hit = memo.get(objects);
  if (hit && hit.version === version) return hit;
  const drawn = new Map<SlideObject, SlideObject>();
  const over = new Set<SlideObject>();
  const parts = slidePlan(
    objects,
    (o, part) => drawnCost(part ? legacyCopy(o, part) : o),
    (o) => drawnEffectArea(o),
  );
  let units = 0;
  let effects = 0;
  parts.forEach((part, i) => {
    const o = objects[i]!;
    const d = part ? legacyCopy(o, part) : o;
    units += charged(drawnCost(d));
    effects += drawnEffectArea(d);
    if (!part) return;
    drawn.set(o, d);
    if (part !== 'effects') over.add(o);
  });
  const out = { version, drawn, over, cost: { units, effects, ...contentCost(objects) } };
  memo.set(objects, out);
  return out;
}

const SLIDE_AREA = LOGICAL_WIDTH * LOGICAL_HEIGHT;

/** A box's area on the slide (logical px², cut to the frame), in slide areas. */
function onSlide(b: { x: number; y: number; w: number; h: number }): number {
  const x0 = Math.max(0, num(b.x, -1e6, 1e6, 0));
  const y0 = Math.max(0, num(b.y, -1e6, 1e6, 0));
  const x1 = Math.min(LOGICAL_WIDTH, num(b.x, -1e6, 1e6, 0) + num(b.w, 0, 1e6, 0));
  const y1 = Math.min(LOGICAL_HEIGHT, num(b.y, -1e6, 1e6, 0) + num(b.h, 0, 1e6, 0));
  return x1 > x0 && y1 > y0 ? ((x1 - x0) * (y1 - y0)) / SLIDE_AREA : 0;
}

/** Characters that draw a glyph (not white space), counted to `CLAMP.maxTextChars`. */
function inked(text: string, from: number, to: number): number {
  let n = 0;
  const end = Math.min(to, text.length, CLAMP.maxTextChars);
  for (let i = Math.max(0, from); i < end; i++) {
    const c = text.charCodeAt(i);
    if (c > 32 && c !== 0xa0 && !(c >= 0x2000 && c <= 0x200b) && c !== 0x3000) n++;
  }
  return n;
}

/** A text object's glyph area drawn again blurred (`contentCost`), in logical px², and its characters. */
function textCost(o: TextObject): { blurred: number; chars: number } {
  if (typeof o.text !== 'string' || !o.text.trim() || !(num(o.opacity, 0, 1, 1) > 0))
    return { blurred: 0, chars: 0 };
  const style = o.style ?? ({} as TextObject['style']);
  const size = num(style.fontSizePx, 1, CLAMP.maxFontPx, 48);
  const glow = !!style.glow && style.glow.radius > 0;
  const boxShadow = !!style.shadow;
  let blurred = 0;
  let chars = 0;
  let at = 0;
  const add = (n: number, px: number, shadow: boolean) => {
    chars += n;
    if (shadow || glow) blurred += n * px * px;
  };
  // Runs in order (stored sorted, not overlapping); what they leave is in the box's style.
  for (const r of Array.isArray(o.runs) ? o.runs.slice(0, CLAMP.maxRuns) : []) {
    const start = num(r?.start, 0, CLAMP.maxTextChars, 0);
    const end = num(r?.end, start, CLAMP.maxTextChars, start);
    if (start > at) add(inked(o.text, at, start), size, boxShadow);
    const px = Math.min(CLAMP.maxFontPx, size * num(r.sizeScale, 0.01, 100, 1));
    add(inked(o.text, Math.max(start, at), end), px, r.shadow === null ? false : !!r.shadow || boxShadow);
    at = Math.max(at, end);
  }
  add(inked(o.text, at, o.text.length), size, boxShadow);
  return { blurred, chars };
}

/**
 * The text and pictures of a slide's objects (`SlideDrawCost` textEffects, chars, pictures, sourcePictures),
 * for health's raster estimate: what the geometry units leave out. Text objects as stored (an autofit's
 * stored scale is not applied: a little high); a picture copied from a prepared bitmap where `pictureTarget`
 * prepares one at the logical size, else drawn from its source.
 */
function contentCost(objects: readonly SlideObject[]): Partial<SlideDrawCost> {
  let textEffects = 0;
  let chars = 0;
  let pictures = 0;
  let sourcePictures = 0;
  for (const o of objects) {
    if (!o?.box) continue;
    if (o.type === 'text') {
      const t = textCost(o);
      textEffects += t.blurred;
      chars += t.chars;
    } else if (o.type === 'image' && num(o.opacity, 0, 1, 1) > 0) {
      const a = onSlide(o.box);
      if (pictureTarget(o, 1)) pictures += a;
      else sourcePictures += a;
    }
  }
  const out: { -readonly [K in keyof SlideDrawCost]?: number } = {};
  if (textEffects > 0) out.textEffects = textEffects / SLIDE_AREA;
  if (chars > 0) out.chars = chars;
  if (pictures > 0) out.pictures = pictures;
  if (sourcePictures > 0) out.sourcePictures = sourcePictures;
  return out;
}

/** The objects of `objects` that draw as their legacy shapes for the slide's geometry budget (`geom`, `both`). */
export function overGeomBudget(objects: readonly SlideObject[]): ReadonlySet<SlideObject> {
  return planOf(objects).over;
}

/**
 * What `objects` (a slide's, in z-order) cost as the slide's drawing budget draws them: the units of their
 * drawing estimates and stored points (`charged`, at most about `GEOM_COST.slide` past the legacy copies) and
 * the weighted area of the effect layers kept (at most about `EFFECT_COST.slide`). What health reads to tell a
 * slide whose content takes longer than the raster budget from a slow computer (`health.ts`
 * `rasterEstimateMs`). Memoised with the budget.
 */
export function slideDrawCost(objects: readonly SlideObject[]): SlideDrawCost {
  return planOf(objects).cost;
}

const NO_COST: SlideDrawCost = { units: 0, effects: 0 };

/**
 * What a slide job draws (`slideDrawCost` of the objects `drawSlide2D` draws for `look`, with its reference or
 * page picture, contain-fitted over the frame, among the pictures; nothing of the kind for a look that draws
 * lyric bands or hides the slide), for health's `heavySlide`. Shares the drawers' memo.
 */
export function slideJobCost(slide: unknown, look?: Look): SlideDrawCost {
  if (look && clampLook(look).layers.slide.mode !== 'authored') return NO_COST;
  const drawn = drawableContent(slide);
  const cost = slideDrawCost(drawn.objects);
  if (!drawn.pictureMediaId) return cost;
  let hit = withPicture.get(cost);
  if (!hit) withPicture.set(cost, (hit = { ...cost, pictures: (cost.pictures ?? 0) + 1 }));
  return hit;
}

const withPicture = new WeakMap<SlideDrawCost, SlideDrawCost>();

/** `objects` as the slide's drawing budget draws them (the same array when it changes none). */
export function withinDrawBudget(objects: readonly SlideObject[]): readonly SlideObject[] {
  const drawn = slideBudget(objects);
  return drawn.size ? objects.map((o) => drawn.get(o) ?? o) : objects;
}
