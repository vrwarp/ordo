import { type Box, newId, type Presentation, type Slide, type SlideObject } from '@ordo/domain';
import type { ZOrder } from '../ops.ts';
import { withSlide } from './common.ts';

/*
 * Group ops (M4 item B; design/27 §11 item 5 "Groups and shape+text pairs", "Locked objects"). A flattened
 * PowerPoint group, or a shape with its text (a TextObject over a ShapeObject), is a set of objects sharing
 * `origin.group`: a click selects them together, Alt-click (long-press on touch) one member. Every op takes
 * the selected ids, acts on them as one block in one undo step, and returns `p` itself when nothing changes.
 *
 * Locked objects (`locked`: PowerPoint art, SmartArt and table grids) can be moved, resized, deleted and
 * reordered, nothing else; art keeps its aspect when resized.
 *
 * Boxes: `x, y, w, h` is the unrotated box, `rotation` (degrees, clockwise on screen) turns it about its
 * centre, as every drawer and the editor's Konva nodes draw it.
 */

/**
 * The editor's object selection: `ids` in the slide's z order (bottom first), `primary` one of them, the
 * object the Object panel edits. The store keeps it as `objectIds` and `objectId` (`editorStore.ts`).
 */
export type Selection = { ids: string[]; primary: string };

/** Whether an object is locked: move, resize, delete and z-order only (text and geometry read-only). */
export function isLocked(o: Pick<SlideObject, 'locked'>): boolean {
  return o.locked === true;
}

/**
 * Whether resizing keeps the object's aspect: a locked picture (LibreOffice's art for a chart, SmartArt or
 * WordArt, drawn stretched to its box), which a free resize would distort (design/27 §11 "Locked objects").
 */
export function keepsAspect(o: Pick<SlideObject, 'locked' | 'type'>): boolean {
  return isLocked(o) && o.type === 'image';
}

/** Whether any of `objects` belongs to a group ('Ungroup' applies). */
export function hasGroup(objects: readonly Pick<SlideObject, 'origin'>[]): boolean {
  return objects.some((o) => o.origin?.group !== undefined);
}

/**
 * The objects a click on `objectId` selects: every object of the slide sharing its `origin.group`, in z
 * order; just itself when it has none (or with Alt, which the canvas handles by not calling this). Empty
 * when the object is not on the slide.
 */
export function groupMembers(s: Pick<Slide, 'objects'>, objectId: string): string[] {
  const o = s.objects.find((x) => x.id === objectId);
  if (!o) return [];
  const g = o.origin?.group;
  if (g === undefined) return [objectId];
  return s.objects.filter((x) => x.origin?.group === g).map((x) => x.id);
}

/**
 * What a press on `objectId` selects (the canvas; design/27 §11 item 5), from the current selection:
 * - plain: its group (`groupMembers`), or the current selection kept when it is already in it, so a press on
 *   a selected object starts dragging the whole selection; it becomes the primary;
 * - Alt (long-press on touch): that one member;
 * - Shift: its group added to the selection, or taken out when all of it is selected; Shift+Alt the one
 *   member. `undefined` when nothing is left selected.
 * The ids come in the slide's z order.
 */
export function clickSelection(
  s: Pick<Slide, 'objects'>,
  current: { ids: readonly string[]; primary?: string },
  objectId: string,
  mods: { alt?: boolean; shift?: boolean } = {},
): Selection | undefined {
  if (!s.objects.some((o) => o.id === objectId)) return undefined;
  const ordered = (want: Set<string>) => s.objects.filter((o) => want.has(o.id)).map((o) => o.id);
  const have = new Set(current.ids.filter((id) => s.objects.some((o) => o.id === id)));
  const unit = mods.alt ? [objectId] : groupMembers(s, objectId);
  if (mods.shift) {
    if (unit.every((id) => have.has(id))) {
      for (const id of unit) have.delete(id);
      const ids = ordered(have);
      if (!ids.length) return undefined;
      const primary = current.primary && have.has(current.primary) ? current.primary : ids[ids.length - 1]!;
      return { ids, primary };
    }
    for (const id of unit) have.add(id);
    return { ids: ordered(have), primary: objectId };
  }
  if (mods.alt) return { ids: [objectId], primary: objectId };
  if (have.has(objectId)) return { ids: ordered(have), primary: objectId };
  return { ids: unit, primary: objectId };
}

// ---- geometry --------------------------------------------------------------------------------------------

type Pt = { x: number; y: number };
const RAD = Math.PI / 180;

function turn(p: Pt, deg: number): Pt {
  if (!deg) return p;
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

const centre = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** The axis-aligned bounds of a box as drawn (turned about its centre). */
export function boundsOf(b: Box): { x0: number; y0: number; x1: number; y1: number } {
  const r = b.rotation ?? 0;
  if (!(r % 360)) return { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
  const c = Math.abs(Math.cos(r * RAD));
  const s = Math.abs(Math.sin(r * RAD));
  const hw = (Math.abs(b.w) * c + Math.abs(b.h) * s) / 2;
  const hh = (Math.abs(b.w) * s + Math.abs(b.h) * c) / 2;
  const m = centre(b);
  return { x0: m.x - hw, y0: m.y - hh, x1: m.x + hw, y1: m.y + hh };
}

/**
 * The group box of a selection: the unrotated bounding box of its members as drawn, which the Konva
 * Transformer spans and the Object panel's box editor edits. `undefined` for no objects.
 */
export function groupBox(objects: readonly Pick<SlideObject, 'box'>[]): Box | undefined {
  if (!objects.length) return undefined;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const o of objects) {
    const b = boundsOf(o.box);
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1);
  }
  return { x: tidy(x0), y: tidy(y0), w: tidy(x1 - x0), h: tidy(y1 - y0), rotation: 0 };
}

/**
 * A rectangle as Konva's Transformer reports it (`x, y` its top-left corner as drawn, turned by `rotation`
 * about that corner, in stage px) as a slide Box (turned about its centre), at `scale` stage px per slide
 * px.
 */
export function boxFromCorner(
  r: { x: number; y: number; width: number; height: number; rotation: number },
  scale: number,
): Box {
  const w = r.width / scale;
  const h = r.height / scale;
  const half = turn({ x: w / 2, y: h / 2 }, r.rotation);
  const cx = r.x / scale + half.x;
  const cy = r.y / scale + half.y;
  return { x: tidy(cx - w / 2), y: tidy(cy - h / 2), w: tidy(w), h: tidy(h), rotation: tidy(r.rotation) };
}

/** Float noise from the transform maths off a coordinate (1/1000 px), so stored boxes stay readable. */
function tidy(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** A rotation in (-180, 180], to 1/10 degree. */
function normRotation(deg: number): number {
  let r = Math.round(deg * 10) / 10;
  r %= 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return r === 0 ? 0 : r;
}

const sameBox = (a: Box, b: Box) =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && (a.rotation ?? 0) === (b.rotation ?? 0);

/**
 * One member's box under the group transform from `from` to `to`: its centre mapped by the group's affine
 * (scaled about the group box, turned about the group centre), its size scaled along its own axes (a
 * rotated member scales by the group's scale seen along its axes), its rotation turned with the group.
 * Font sizes, insets and stroke widths are not boxes: they do not scale. A locked object keeps its rotation
 * (its centre still follows the group), and a locked picture its aspect.
 */
export function transformMember(o: Pick<SlideObject, 'box' | 'locked' | 'type'>, from: Box, to: Box): Box {
  const b = o.box;
  const fr = from.rotation ?? 0;
  const tr = to.rotation ?? 0;
  const sx = from.w ? Math.abs(to.w / from.w) : 1;
  const sy = from.h ? Math.abs(to.h / from.h) : 1;
  const dr = tr - fr;
  if (sx === 1 && sy === 1 && !(dr % 360)) {
    // A move: every member by the same delta, exactly.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return { ...b, x: b.x + dx, y: b.y + dy };
  }
  const fc = centre(from);
  const tc = centre(to);
  const local = turn({ x: centre(b).x - fc.x, y: centre(b).y - fc.y }, -fr);
  const mapped = turn({ x: local.x * sx, y: local.y * sy }, tr);
  const c = { x: tc.x + mapped.x, y: tc.y + mapped.y };
  // The member's own axes in the group's frame, and the group's scale along each of them.
  const a = ((b.rotation ?? 0) - fr) * RAD;
  let kx = Math.hypot(sx * Math.cos(a), sy * Math.sin(a));
  let ky = Math.hypot(sx * Math.sin(a), sy * Math.cos(a));
  if (keepsAspect(o)) kx = ky = Math.min(kx, ky);
  const w = Math.max(1, tidy(b.w * kx));
  const h = Math.max(1, tidy(b.h * ky));
  const rotation = isLocked(o) || !(dr % 360) ? (b.rotation ?? 0) : normRotation((b.rotation ?? 0) + dr);
  return { x: tidy(c.x - w / 2), y: tidy(c.y - h / 2), w, h, rotation };
}

// ---- the ops ---------------------------------------------------------------------------------------------

/** `s` with `fn` applied to each object of `ids` (an object `fn` returns unchanged stays the same object). */
function mapMembers(s: Slide, ids: readonly string[], fn: (o: SlideObject) => SlideObject): Slide {
  const want = new Set(ids);
  let changed = false;
  const objects = s.objects.map((o) => {
    if (!want.has(o.id)) return o;
    const next = fn(o);
    if (next !== o) changed = true;
    return next;
  });
  return changed ? { ...s, objects } : s;
}

/**
 * Move `ids` by (dx, dy) in slide units (a drag of the selection, arrow-key nudges). Locked objects move too.
 */
export function moveObjects(
  p: Presentation,
  slideId: string,
  ids: readonly string[],
  dx: number,
  dy: number,
): Presentation {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return p;
  return withSlide(p, slideId, (s) =>
    mapMembers(s, ids, (o) => ({ ...o, box: { ...o.box, x: o.box.x + dx, y: o.box.y + dy } })),
  );
}

/**
 * The Transformer over a multi-object selection: its box went from `from` (the members' bounding box,
 * unrotated) to `to` (moved, scaled, turned about its centre). Every member's box is scaled about the group
 * box and turned about the group centre; font sizes, insets and stroke widths do not scale. A locked art
 * picture keeps its aspect. A single object goes through the editor's own box update, not this.
 */
export function transformGroup(
  p: Presentation,
  slideId: string,
  ids: readonly string[],
  from: Box,
  to: Box,
): Presentation {
  const finite = [
    from.x,
    from.y,
    from.w,
    from.h,
    to.x,
    to.y,
    to.w,
    to.h,
    from.rotation ?? 0,
    to.rotation ?? 0,
  ];
  if (!finite.every(Number.isFinite) || sameBox(from, to)) return p;
  return withSlide(p, slideId, (s) =>
    mapMembers(s, ids, (o) => {
      const box = transformMember(o, from, to);
      return sameBox(box, o.box) ? o : { ...o, box };
    }),
  );
}

/**
 * Delete `ids` (locked ones too); the slide's `lyricObjectId` is cleared when its lyric object goes.
 */
export function deleteObjects(p: Presentation, slideId: string, ids: readonly string[]): Presentation {
  const gone = new Set(ids);
  return withSlide(p, slideId, (s) => {
    if (!s.objects.some((o) => gone.has(o.id))) return s;
    const next: Slide = { ...s, objects: s.objects.filter((o) => !gone.has(o.id)) };
    if (s.lyricObjectId && gone.has(s.lyricObjectId)) next.lyricObjectId = undefined;
    return next;
  });
}

/** `ObjectOrigin.group` is at most 100,000 (the schema's bound). */
const MAX_GROUP = 100_000;

/** A group number no object of `s` uses (`taken` holds the ones given out already). */
function freshGroup(taken: Set<number>): number {
  let top = -1;
  for (const g of taken) top = Math.max(top, g);
  if (top < MAX_GROUP) return top + 1;
  for (let g = 0; g <= MAX_GROUP; g++) if (!taken.has(g)) return g;
  return MAX_GROUP;
}

/** The schema's bound on a slide's objects (`Slide.objects`). */
export const MAX_OBJECTS = 1000;

/**
 * Duplicate `ids` as one block placed right above the topmost of them, offset by 20 px, with fresh ids; the
 * copies of a group share a new `origin.group` number, so the copy is a group of its own. `ids`: the copies,
 * in the order of `ids` (the editor selects them).
 *
 * A copy keeps everything else of its original (style, runs, crop, `play`, `locked`, the rest of `origin`); it
 * is never the slide's lyric object.
 */
export function duplicateObjects(
  p: Presentation,
  slideId: string,
  ids: readonly string[],
): { p: Presentation; ids: string[] } {
  const copyOf = new Map<string, string>();
  const next = withSlide(p, slideId, (s) => {
    const want = new Set(ids);
    const originals = s.objects.filter((o) => want.has(o.id));
    if (!originals.length) return s;
    // A slide holds at most `MAX_OBJECTS` objects (the schema's bound): a copy past it is refused, as the
    // hub would refuse the save.
    if (s.objects.length + originals.length > MAX_OBJECTS) return s;
    const top = s.objects.indexOf(originals[originals.length - 1]!);
    const taken = new Set<number>();
    for (const o of s.objects) if (o.origin?.group !== undefined) taken.add(o.origin.group);
    const groups = new Map<number, number>();
    const copies = originals.map((o) => {
      const c = structuredClone(o) as SlideObject;
      c.id = newId();
      c.box = { ...c.box, x: c.box.x + 20, y: c.box.y + 20 };
      const g = c.origin?.group;
      if (c.origin && g !== undefined) {
        let fresh = groups.get(g);
        if (fresh === undefined) {
          fresh = freshGroup(taken);
          taken.add(fresh);
          groups.set(g, fresh);
        }
        c.origin = { ...c.origin, group: fresh };
      }
      copyOf.set(o.id, c.id);
      return c;
    });
    const objects = [...s.objects.slice(0, top + 1), ...copies, ...s.objects.slice(top + 1)];
    return { ...s, objects };
  });
  if (next === p) return { p, ids: [] };
  const out: string[] = [];
  for (const id of ids) {
    const c = copyOf.get(id);
    if (c && !out.includes(c)) out.push(c);
  }
  return { p: next, ids: out };
}

/**
 * Bring `ids` to the front or back, or one step forward or backward, as one block that stays contiguous and
 * keeps its own order. Forward gathers the block at its topmost member and moves it above the next object
 * over it; backward gathers it at its bottom member and moves it under the next object below it.
 */
export function reorderObjects(
  p: Presentation,
  slideId: string,
  ids: readonly string[],
  z: ZOrder,
): Presentation {
  const want = new Set(ids);
  return withSlide(p, slideId, (s) => {
    const block = s.objects.filter((o) => want.has(o.id));
    if (!block.length) return s;
    const rest = s.objects.filter((o) => !want.has(o.id));
    const first = s.objects.indexOf(block[0]!);
    const last = s.objects.indexOf(block[block.length - 1]!);
    // How many of the other objects lie below the block's bottom and below its top member.
    const below = (at: number) => s.objects.slice(0, at).filter((o) => !want.has(o.id)).length;
    const k =
      z === 'front'
        ? rest.length
        : z === 'back'
          ? 0
          : z === 'forward'
            ? Math.min(rest.length, below(last) + 1)
            : Math.max(0, below(first) - 1);
    const objects = [...rest.slice(0, k), ...block, ...rest.slice(k)];
    return objects.every((o, i) => o === s.objects[i]) ? s : { ...s, objects };
  });
}

/**
 * 'Ungroup': `origin.group` cleared on every member, so a click selects each alone. The rest of `origin`
 * stays (a re-import still knows them).
 */
export function ungroup(p: Presentation, slideId: string, ids: readonly string[]): Presentation {
  return withSlide(p, slideId, (s) =>
    mapMembers(s, ids, (o) => {
      if (!o.origin || o.origin.group === undefined) return o;
      const { group: _group, ...origin } = o.origin;
      return { ...o, origin };
    }),
  );
}
