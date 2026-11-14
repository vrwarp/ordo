/**
 * Picture sheets (design/27 §15 M9, `budget-decorations.md` §3.4, plan decision 2; `decor-conv`): pictures
 * made of several pictures, through the bake path, so a slide past its object or picture budget stays native.
 * One recipe (`bake.ts` `SheetBake`) for both uses; the hub makes the pixels (`decor-render`: `bakes.ts`
 * `storeSheets`, `bakeTask.ts`), and so does the fidelity harness.
 *
 * - **Composite** (`pictureRuns`, `emitComposite`): a z-run of at least two plain pictures (no clip or
 *   sound, no clip geometry, outline, 3-D or tile, colour effects only those a bake makes, not sheared,
 *   inside the render clamp's bounds) becomes one `ImageObject` (`fit: 'stretch'`, locked)
 *   over their union box, its media the sheet `pptxmedia:sheet<n>`. Each cell is a member as the picture
 *   emitter writes it (its crop, recolour, flips, turn (quarter turns exactly, any other angle sampled as
 *   Canvas draws a turned picture: `bake.ts` `SheetCell.rotation`) and opacity), at `SHEET_DENSITY` px per
 *   logical px (the 3840 density), in z-order, the sheet scaled down uniformly to stay within
 *   `SHEET_LIMITS`. Hidden and culled elements do not end a run; anything else does.
 * - **Atlas** (`atlasParts` at classification, `atlasSlide` once the slide is emitted): past
 *   `MAX_SLIDE_PICTURES` distinct pictures, the fewest smallest are packed into one sheet (shelf packing by
 *   height, at most 8,192 px wide), each object keeping its box, rotation, mask, flips and opacity and
 *   showing its cell through its crop (the cell is the picture's visible region at its box's size times
 *   `SHEET_DENSITY`); one cell per part, recipe and crop, sized for its largest use. Every build since M1
 *   draws it; the render clamp counts one picture.
 * - **Recorded** (`EmittedSlide.sheets`): each sheet a slide uses, the ids of the objects drawn from it and
 *   those objects as they would be without it, which the hub puts back when it cannot make the sheet (a
 *   source that does not decode, a budget); `EmitResult.sheets` lists each distinct sheet once.
 *
 * Pure: IR and emitted objects in, objects and recipes out.
 */
import type { ImageObject, SlideObject } from '@ordo/domain';
import { type PictureBake, type SheetBake, type SheetCell, SHEET_LIMITS, sheetKey } from './bake.ts';
import { boundsOf } from './classify.ts';
import type { EmitCtx } from './emit-ctx.ts';
import { decompose } from './frame.ts';
import type { Element, Frame, PictureElement } from './ir.ts';
import { BAKED_EFFECTS } from './picture.ts';

/** The prefix of sheets' placeholder media ids (`pptxmedia:sheet<n>`, `EmitResult.sheets`). */
export const SHEET_PREFIX = 'pptxmedia:sheet';
/** Device px per logical px a sheet's cells are made at: the 3840 density, so a 4K output is never upscaled. */
export const SHEET_DENSITY = 2;

/** The render clamp keeps box edges within ±2× the logical canvas (`@ordo/renderer` `CLAMP.boxFactor`). */
const CLAMP_W = 2 * 1_920;
const CLAMP_H = 2 * 1_080;

/** One sheet a slide uses (`EmittedSlide.sheets`). */
export interface EmittedSheet {
  /** The sheet's placeholder media id (`SHEET_PREFIX`), one per distinct recipe in the deck. */
  id: string;
  /** The ids of the slide's objects drawn from it: the composite, or each atlas object. */
  uses: string[];
  /**
   * The objects as they are without the sheet, in z-order: the composite's members in its place, or each
   * atlas object with its own picture (same ids). An importer that cannot make the sheet puts them back.
   */
  objects: ImageObject[];
}

/** A quarter-turn count of a rotation in degrees, or undefined for one that is not a whole quarter turn. */
function quarterOf(rotation: number): 0 | 1 | 2 | 3 | undefined {
  const q = rotation / 90;
  const r = Math.round(q);
  if (Math.abs(q - r) > 1e-6) return undefined;
  return (((r % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

/** The effects a bake makes (`picture.ts`): a picture with any other is approx and stays apart. */
const plainEffects = (p: PictureElement) => !p.picture.effects?.some((n) => !BAKED_EFFECTS.has(n));

/** Whether a picture can be a cell of a composite (see the header). */
export function compositable(e: Element, frame: Frame): e is PictureElement {
  if (e.kind !== 'picture' || e.hidden || e.support !== 'native') return false;
  if (e.media || e.line || e.look3d || e.custom || e.geom !== 'rect') return false;
  if (e.picture.tile || e.picture.metafile || !plainEffects(e)) return false;
  if (decompose(e.xf).sheared) return false;
  const b = boundsOf(e);
  const x0 = frame.x0 + b.x * frame.s;
  const y0 = frame.y0 + b.y * frame.s;
  const x1 = x0 + b.cx * frame.s;
  const y1 = y0 + b.cy * frame.s;
  return x0 >= -CLAMP_W && x1 <= CLAMP_W && y0 >= -CLAMP_H && y1 <= CLAMP_H && b.cx > 0 && b.cy > 0;
}

/**
 * The composite runs of a slide's elements: indexes of z-adjacent `compositable` pictures, bottom first, at
 * least two and at most `SHEET_LIMITS.cells` a run. Hidden elements do not end a run; an excluded one
 * (in the art, in a decoration) does.
 */
export function pictureRuns(
  elements: readonly Element[],
  frame: Frame,
  exclude: ReadonlySet<number> = new Set(),
): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  const end = () => {
    if (run.length > 1) runs.push(run);
    run = [];
  };
  elements.forEach((e, i) => {
    if (e.hidden) return;
    if (exclude.has(i) || !compositable(e, frame)) {
      end();
      return;
    }
    if (run.length >= SHEET_LIMITS.cells) end();
    run.push(i);
  });
  end();
  return runs;
}

/** What one emitted picture shows, as a sheet cell's source: its part and recipe. */
function sourceOf(ctx: EmitCtx, o: ImageObject): { part: string; bake?: PictureBake } | undefined {
  return ctx.mediaPart?.(o.mediaId);
}

/** Whether an emitted picture can be a composite's cell as it is drawn. */
function cellable(o: SlideObject): o is ImageObject {
  return (
    o.type === 'image' &&
    !o.play &&
    !o.mask &&
    !o.look3d &&
    (o.radius ?? 0) === 0 &&
    o.fit === 'stretch' &&
    Number.isFinite(o.box.rotation ?? 0)
  );
}

/** A sheet's uniform scale within `SHEET_LIMITS` for a `w` x `h` sheet of cells covering `cells` pixels. */
function sheetScale(w: number, h: number, cells: number): number {
  return Math.min(
    1,
    SHEET_LIMITS.side / Math.max(1, w, h),
    Math.sqrt(SHEET_LIMITS.pixels / Math.max(1, w * h)),
    Math.sqrt(SHEET_LIMITS.decoded / Math.max(1, cells)),
  );
}

/** A sheet's placeholder id, recorded for the slide (`EmittedSlide.sheets`). */
function useSheet(ctx: EmitCtx, bake: SheetBake, uses: string[], objects: ImageObject[]): string | undefined {
  if (!ctx.sheet || !ctx.sheets) return undefined;
  const id = ctx.sheet(bake);
  ctx.sheets.push({ id, uses, objects });
  return id;
}

/**
 * Write a run of pictures (bottom first, `pictureRuns`) as one composite on `out` and return true, or return
 * false, leaving `out` as it was, when it writes none (no sheets in this emission, a member not drawn as
 * one plain picture): the members are then emitted one by one. `emitOne` emits a member as the picture
 * emitter does.
 */
export function emitComposite(
  ctx: EmitCtx,
  run: readonly Element[],
  out: SlideObject[],
  emitOne: (e: Element, out: SlideObject[]) => void,
): boolean {
  if (!ctx.sheet || !ctx.sheets || run.length < 2 || run.length > SHEET_LIMITS.cells) return false;
  const objects: ImageObject[] = [];
  for (const e of run) {
    const sink: SlideObject[] = [];
    emitOne(e, sink);
    const o = sink[0];
    if (sink.length !== 1 || !o || !cellable(o)) return false;
    const src = sourceOf(ctx, o);
    if (!src || src.bake?.tile) return false;
    objects.push(o);
  }
  // Each picture as drawn: its box turned by its quarter turns (the sides swap on an odd one), or by any
  // other angle (its turned box's bounds).
  const drawn = objects.map((o) => {
    const rotation = o.box.rotation ?? 0;
    const q = quarterOf(rotation);
    const cx = o.box.x + o.box.w / 2;
    const cy = o.box.y + o.box.h / 2;
    let w: number;
    let h: number;
    if (q !== undefined) {
      const odd = q % 2 === 1;
      w = odd ? o.box.h : o.box.w;
      h = odd ? o.box.w : o.box.h;
    } else {
      const a = (rotation * Math.PI) / 180;
      w = Math.abs(o.box.w * Math.cos(a)) + Math.abs(o.box.h * Math.sin(a));
      h = Math.abs(o.box.w * Math.sin(a)) + Math.abs(o.box.h * Math.cos(a));
    }
    return { o, q, rotation, x: cx - w / 2, y: cy - h / 2, w, h };
  });
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let area = 0;
  for (const d of drawn) {
    x0 = Math.min(x0, d.x);
    y0 = Math.min(y0, d.y);
    x1 = Math.max(x1, d.x + d.w);
    y1 = Math.max(y1, d.y + d.h);
    area += d.w * d.h * SHEET_DENSITY * SHEET_DENSITY;
  }
  if (!(x1 > x0 && y1 > y0)) return false;
  const k = SHEET_DENSITY * sheetScale((x1 - x0) * SHEET_DENSITY, (y1 - y0) * SHEET_DENSITY, area);
  const W = Math.max(1, Math.round((x1 - x0) * k));
  const H = Math.max(1, Math.round((y1 - y0) * k));
  const cells: SheetCell[] = [];
  for (const d of drawn) {
    const src = sourceOf(ctx, d.o)!;
    const x = Math.min(W - 1, Math.max(0, Math.round((d.x - x0) * k)));
    const y = Math.min(H - 1, Math.max(0, Math.round((d.y - y0) * k)));
    const w = Math.max(1, Math.min(W - x, Math.round(d.w * k)));
    const h = Math.max(1, Math.min(H - y, Math.round(d.h * k)));
    const o = d.o;
    cells.push({
      part: src.part,
      ...(o.crop ? { crop: { ...o.crop } } : {}),
      ...(src.bake?.recolor?.length ? { recolor: src.bake.recolor } : {}),
      x,
      y,
      w,
      h,
      ...(o.flipH ? { flipH: true } : {}),
      ...(o.flipV ? { flipV: true } : {}),
      ...(d.q
        ? { quarter: d.q }
        : d.q === undefined
          ? {
              rotation: Math.round(d.rotation * 1e6) / 1e6,
              src: { w: Math.max(1, Math.round(o.box.w * k)), h: Math.max(1, Math.round(o.box.h * k)) },
            }
          : {}),
      ...((o.opacity ?? 1) < 1 ? { alpha: o.opacity } : {}),
    });
  }
  const bake: SheetBake = { w: W, h: H, cells, layout: 'composite' };
  const sheet: ImageObject = {
    id: ctx.newId(),
    type: 'image',
    box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0, rotation: 0 },
    mediaId: '',
    fit: 'stretch',
    opacity: 1,
    radius: 0,
    locked: true,
  };
  const id = useSheet(ctx, bake, [sheet.id], objects);
  if (id === undefined) return false;
  sheet.mediaId = id;
  out.push(sheet);
  return true;
}

// ── Atlas ───────────────────────────────────────────────────────────────────────────────────────────────

/** The picture part an element draws (a `p:pic`'s, a shape's picture fill), when an atlas may hold it. */
function atlasPart(e: Element): string | undefined {
  if (e.hidden || e.support === 'residual') return undefined;
  const p =
    e.kind === 'picture'
      ? e.picture
      : e.kind === 'shape' && e.fill.kind === 'picture'
        ? e.fill.picture
        : undefined;
  if (!p || p.tile || p.metafile) return undefined;
  if (e.kind === 'picture' && e.media) return undefined;
  return p.part;
}

/**
 * The picture parts an atlas packs so a slide shows at most `max` distinct pictures (`MAX_SLIDE_PICTURES`):
 * of the parts it may hold (not a clip's poster, a tiled fill or a metafile; `keep` never: the background's,
 * the composites'), the fewest smallest by the area their largest use covers, within `SHEET_LIMITS.cells`
 * and its decoded pixels at `SHEET_DENSITY`. `distinct` is the slide's count of distinct pictures. Empty when
 * none is needed, or when no atlas brings the slide within `max` (the caller then leaves pictures out).
 */
export function atlasParts(
  elements: readonly Element[],
  frame: Frame,
  distinct: number,
  max: number,
  keep: ReadonlySet<string> = new Set(),
  exclude: ReadonlySet<number> = new Set(),
): string[] {
  if (distinct <= max) return [];
  const area = new Map<string, number>();
  const blocked = new Set<string>(keep);
  for (const [i, e] of elements.entries()) {
    // Pictures in the art or a composite are not drawn on their own.
    if (e.hidden || e.sheet !== undefined || exclude.has(i)) continue;
    const part = atlasPart(e);
    if (part === undefined) {
      // A part some use of which the atlas cannot hold stays out of it.
      const p =
        e.kind === 'picture'
          ? e.picture.part
          : e.kind === 'shape' && e.fill.kind === 'picture'
            ? e.fill.picture.part
            : undefined;
      if (p !== undefined) blocked.add(p);
      continue;
    }
    const b = boundsOf(e);
    const a = b.cx * frame.s * SHEET_DENSITY * b.cy * frame.s * SHEET_DENSITY;
    area.set(part, Math.max(area.get(part) ?? 0, a));
  }
  const candidates = [...area].filter(([p]) => !blocked.has(p)).sort((p, q) => p[1] - q[1]);
  // m parts in one sheet make the slide show distinct - m + 1 pictures.
  const need = distinct - max + 1;
  if (need < 2 || candidates.length < need) return [];
  const chosen = candidates.slice(0, need);
  const pixels = chosen.reduce((n, [, a]) => n + a, 0);
  if (chosen.length > SHEET_LIMITS.cells || pixels > SHEET_LIMITS.decoded * 4) return [];
  return chosen.map(([p]) => p);
}

/**
 * Pack the slide's pictures of `parts` (`atlasParts`) into one atlas sheet, once the slide is emitted: each
 * such picture keeps its box and shows its cell through its crop, and the sheet is recorded
 * (`EmittedSlide.sheets`). Shelf packing by descending height into rows at most 8,192 px wide, scaled down
 * uniformly within `SHEET_LIMITS`. Leaves the objects as they are when no sheet can be made.
 */
export function atlasSlide(ctx: EmitCtx, objects: SlideObject[], parts: readonly string[]): void {
  if (!parts.length || !ctx.sheet || !ctx.sheets || !ctx.mediaPart) return;
  const want = new Set(parts);
  // Cells by part, recipe and crop, each sized for its largest use.
  type Cell = {
    key: string;
    part: string;
    bake?: PictureBake;
    crop?: ImageObject['crop'];
    w: number;
    h: number;
    uses: ImageObject[];
  };
  const cells = new Map<string, Cell>();
  for (const o of objects) {
    if (o.type !== 'image' || o.play || o.fit !== 'stretch') continue;
    const src = ctx.mediaPart(o.mediaId);
    if (!src || !want.has(src.part) || src.bake?.tile) continue;
    const key = JSON.stringify([src.part, src.bake?.recolor ?? null, o.crop ?? null]);
    let c = cells.get(key);
    if (!c) {
      c = {
        key,
        part: src.part,
        ...(src.bake ? { bake: src.bake } : {}),
        ...(o.crop ? { crop: o.crop } : {}),
        w: 0,
        h: 0,
        uses: [],
      };
      cells.set(key, c);
    }
    c.w = Math.max(c.w, o.box.w * SHEET_DENSITY);
    c.h = Math.max(c.h, o.box.h * SHEET_DENSITY);
    c.uses.push(o);
  }
  const list = [...cells.values()].filter((c) => c.w > 0 && c.h > 0);
  if (list.length < 1 || list.length > SHEET_LIMITS.cells) return;
  let total = 0;
  for (const c of list) total += c.w * c.h;
  // A sheet about as wide as it is tall, never wider than the limit nor narrower than its widest cell.
  let scale = Math.min(1, Math.sqrt(SHEET_LIMITS.decoded / Math.max(1, total)));
  let packed: { c: Cell; x: number; y: number; w: number; h: number }[] = [];
  let W = 0;
  let H = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const sized = list
      .map((c) => ({ c, w: Math.max(1, Math.round(c.w * scale)), h: Math.max(1, Math.round(c.h * scale)) }))
      .sort((p, q) => q.h - p.h || q.w - p.w);
    const widest = Math.max(...sized.map((s) => s.w));
    const rowW = Math.min(
      SHEET_LIMITS.side,
      Math.max(widest, Math.ceil(Math.sqrt(total * scale * scale) * 1.2)),
    );
    packed = [];
    let x = 0;
    let y = 0;
    let row = 0;
    W = 0;
    for (const s of sized) {
      if (x > 0 && x + s.w > rowW) {
        y += row;
        x = 0;
        row = 0;
      }
      packed.push({ c: s.c, x, y, w: s.w, h: s.h });
      x += s.w;
      row = Math.max(row, s.h);
      W = Math.max(W, x);
    }
    H = y + row;
    if (W <= SHEET_LIMITS.side && H <= SHEET_LIMITS.side && W * H <= SHEET_LIMITS.pixels) break;
    scale *= 0.8;
  }
  if (!(W >= 1 && H >= 1 && W <= SHEET_LIMITS.side && H <= SHEET_LIMITS.side && W * H <= SHEET_LIMITS.pixels))
    return;
  const bake: SheetBake = {
    w: W,
    h: H,
    cells: packed.map(({ c, x, y, w, h }) => ({
      part: c.part,
      ...(c.crop ? { crop: { ...c.crop } } : {}),
      ...(c.bake?.recolor?.length ? { recolor: c.bake.recolor } : {}),
      x,
      y,
      w,
      h,
    })),
    layout: 'atlas',
  };
  const originals: ImageObject[] = [];
  const uses: string[] = [];
  const id = ctx.sheet(bake);
  for (const { c, x, y, w, h } of packed)
    for (const o of c.uses) {
      originals.push({ ...o, ...(o.crop ? { crop: { ...o.crop } } : {}) });
      uses.push(o.id);
      const f = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
      o.mediaId = id;
      o.crop = { l: f(x / W), t: f(y / H), r: f(1 - (x + w) / W), b: f(1 - (y + h) / H) };
    }
  ctx.sheets.push({ id, uses, objects: originals });
}

/** A stable key of a sheet (`bake.ts` `sheetKey`), re-exported for the emitter's dedupe. */
export { sheetKey };
