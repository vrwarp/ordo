/**
 * IR → ordo objects (design/27 §1 `emit.ts`, §3.2 "The importer always writes the closest legacy values").
 *
 * M1 emits today's objects only (`TextObject`, `ImageObject`, `ShapeObject`), plus `ImageObject.crop` once
 * work item D has added it to the schema. Pictures carry placeholder media ids, `pptxmedia:<part>` by
 * default, which the harness (and later the hub) maps to real media.
 *
 * Owned by work item C (inherit-emit). The scaffold emits a text box in its first run's style, solid
 * rect/roundRect/ellipse/line shapes, stretched pictures, and solid or picture backgrounds. Still to do:
 * the dominant run, line height from lnSpcPct, outline (w/2), outer shadow, caps, lines at any angle,
 * picture backgrounds that are not a 16:9 stretch, the lyric object rule of §4 "Church mappings", and
 * `crop` (one line, once D's schema lands).
 */
import type {
  ImageObject,
  Rgba as OrdoRgba,
  ShapeObject,
  Slide,
  SlideObject,
  TextObject,
} from '@ordo/domain';
import { boxPx, lenPx, ptPx, slideRect } from './frame.ts';
import type {
  Classification,
  DeckScene,
  Element,
  Fill,
  Frame,
  PictureFill,
  Rgba,
  ShapeElement,
  SlideScene,
} from './ir.ts';
import { noteList } from './log.ts';
import { plainText } from './text.ts';

/** The prefix of placeholder media ids. */
export const MEDIA_PREFIX = 'pptxmedia:';
/** Longest text an ordo `TextObject` holds (`@ordo/domain` MAX.text). */
export const MAX_TEXT = 20_000;
/** Stored font sizes in logical px (design/27 §4 "Sizes"). */
export const MIN_FONT_PX = 4;
export const MAX_FONT_PX = 1_000;
/** Logical coordinates are bounded by the schema (`coord`). */
const MAX_COORD = 100_000;

export interface EmitOptions {
  /** A new id for each slide and object; default: deterministic `pptx-<n>`. */
  newId?: () => string;
  /** The media id of a picture part; default `pptxmedia:<part>`. */
  mediaId?: (part: string) => string;
  /** Solid backgrounds cover the whole 1920x1080 frame instead of the slide area (default true). */
  extendBackgrounds?: boolean;
}

export interface EmittedSlide {
  index: number;
  shown?: number;
  hidden: boolean;
  /** An ordinary ordo slide: `Slide.parse` accepts it. */
  slide: Slide;
  classification: Classification;
  /** A digest of the objects written (the "unedited" test of design/27 §5). */
  digest: string;
  notes: string[];
  /** Time spent emitting this slide, in ms. */
  ms: number;
}

export interface EmitResult {
  slides: EmittedSlide[];
  /** Every picture part the objects reference, with its media id, in first-use order. */
  media: { id: string; part: string }[];
  /** The deck's area in 1920x1080 logical px (`source.native.slideRect`). */
  slideRect: { x: number; y: number; w: number; h: number };
  notes: string[];
}

/** What one slide's emission needs. */
interface EmitCtx {
  frame: Frame;
  newId: () => string;
  mediaId: (part: string) => string;
  extend: boolean;
  media: Map<string, string>;
  log: (msg: string) => void;
}

export function emitDeck(scene: DeckScene, opts: EmitOptions = {}): EmitResult {
  let n = 0;
  const newId = opts.newId ?? (() => `pptx-${++n}`);
  const media = new Map<string, string>();
  const mediaId = opts.mediaId ?? ((part: string) => MEDIA_PREFIX + part);
  const slides = scene.slides.map((s) => {
    const t0 = performance.now();
    const { notes, log } = noteList();
    for (const note of s.notes) log(note);
    const ctx: EmitCtx = {
      frame: scene.frame,
      newId,
      mediaId,
      extend: opts.extendBackgrounds ?? true,
      media,
      log,
    };
    const slide = emitSlide(ctx, s);
    return {
      index: s.index,
      ...(s.shown !== undefined ? { shown: s.shown } : {}),
      hidden: s.hidden,
      slide,
      classification: s.classification,
      digest: digestOf(slide.objects),
      notes,
      ms: performance.now() - t0,
    };
  });
  return {
    slides,
    media: [...media].map(([part, id]) => ({ id, part })),
    slideRect: slideRect(scene.frame),
    notes: [...scene.notes],
  };
}

function emitSlide(ctx: EmitCtx, s: SlideScene): Slide {
  const objects: SlideObject[] = [];
  const slide: Slide = { id: ctx.newId(), objects };
  if (s.error) return slide;
  emitBackground(ctx, s, slide);
  for (const e of s.elements) if (!e.hidden) objects.push(...emitElement(ctx, e));
  // M1: the text with the most characters is the lyric box (design/27 §4 "Church mappings" refines it).
  let best: TextObject | undefined;
  for (const o of objects) if (o.type === 'text' && (!best || o.text.length > best.text.length)) best = o;
  if (best?.text.trim()) slide.lyricObjectId = best.id;
  return slide;
}

function emitBackground(ctx: EmitCtx, s: SlideScene, slide: Slide): void {
  const fill = s.background.fill;
  const rect = slideRect(ctx.frame);
  const area = ctx.extend ? { x: 0, y: 0, w: 1920, h: 1080 } : rect;
  if (fill.kind === 'solid') {
    slide.objects.push(shape(ctx, { ...area, rotation: 0 }, 'rect', fill.color));
  } else if (fill.kind === 'picture') {
    const p = fill.picture;
    const sixteenNine = Math.abs(ctx.frame.cx / ctx.frame.cy - 16 / 9) < (16 / 9) * 0.01;
    const plain = !p.crop && !p.fillRect && !p.tile && p.alpha === undefined && !p.effects?.length;
    if (sixteenNine && plain) slide.backgroundMediaId = mediaOf(ctx, p.part);
    else slide.objects.push(image(ctx, { ...rect, rotation: 0 }, p));
  } else if (fill.kind !== 'none') ctx.log(`background: ${fill.kind} fill not drawn yet`);
}

function emitElement(ctx: EmitCtx, e: Element): SlideObject[] {
  const box = clampBox(boxPx(ctx.frame, e.xf));
  if (e.kind === 'residual') {
    ctx.log(`${e.what} not drawn (LibreOffice art comes in M3)`);
    return [];
  }
  if (e.kind === 'picture') return [image(ctx, box, e.picture)];
  return emitShape(ctx, e, box);
}

function emitShape(ctx: EmitCtx, e: ShapeElement, box: Box): SlideObject[] {
  const out: SlideObject[] = [];
  if (e.fill.kind === 'picture') out.push(image(ctx, box, e.fill.picture));
  else {
    const fill = solidOf(e.fill);
    const stroke = e.line ? solidOf(e.line.fill) : undefined;
    if (fill || stroke) {
      const kind =
        e.geom === 'ellipse'
          ? 'ellipse'
          : e.geom === 'line' || e.geom === 'straightConnector1'
            ? 'line'
            : 'rect';
      const o = shape(ctx, box, kind, fill);
      if (stroke && e.line) o.stroke = { width: lenPx(ctx.frame, e.line.width), color: stroke };
      if (e.geom === 'roundRect') o.radius = (Math.min(box.w, box.h) * 16_667) / 100_000;
      out.push(o);
    }
  }
  if (e.text) {
    const t = textObject(ctx, e, box);
    if (t) out.push(t);
  }
  return out;
}

type Box = { x: number; y: number; w: number; h: number; rotation: number };

/** `v` within [lo, hi]; NaN and infinities become `lo` clamped to 0. */
function bound(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : Math.min(hi, Math.max(lo, 0));
}

function clampBox(b: Box): Box {
  const c = (v: number) => bound(v, -MAX_COORD, MAX_COORD);
  return { x: c(b.x), y: c(b.y), w: c(b.w), h: c(b.h), rotation: bound(b.rotation, -36_000, 36_000) };
}

function ordo(c: Rgba): OrdoRgba {
  const ch = (v: number) => (Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : 0);
  return { r: ch(c.r), g: ch(c.g), b: ch(c.b), a: Number.isFinite(c.a) ? Math.min(1, Math.max(0, c.a)) : 1 };
}

function solidOf(f: Fill): OrdoRgba | undefined {
  return f.kind === 'solid' ? ordo(f.color) : undefined;
}

function shape(
  ctx: EmitCtx,
  box: Box,
  kind: ShapeObject['shape'],
  fill: OrdoRgba | Rgba | undefined,
): ShapeObject {
  return {
    id: ctx.newId(),
    type: 'shape',
    box,
    shape: kind,
    ...(fill ? { fill: ordo(fill) } : {}),
    opacity: 1,
    radius: 0,
  };
}

function mediaOf(ctx: EmitCtx, part: string): string {
  let id = ctx.media.get(part);
  if (id === undefined) {
    id = ctx.mediaId(part);
    ctx.media.set(part, id);
  }
  return id;
}

function image(ctx: EmitCtx, box: Box, p: PictureFill): ImageObject {
  return {
    id: ctx.newId(),
    type: 'image',
    box,
    mediaId: mediaOf(ctx, p.part),
    fit: 'stretch',
    opacity: p.alpha ?? 1,
    radius: 0,
  };
}

function textObject(ctx: EmitCtx, e: ShapeElement, box: Box): TextObject | undefined {
  const body = e.text!;
  let text = plainText(body);
  if (!text.trim()) return undefined;
  if (text.length > MAX_TEXT) {
    ctx.log(`a text box was cut to ${MAX_TEXT} characters`);
    text = text.slice(0, MAX_TEXT);
  }
  const first = body.paras[0];
  const run =
    body.paras.flatMap((p) => p.runs).find((r) => r.kind !== 'break' && r.text.trim()) ?? first?.runs[0];
  const st = run?.style ?? first?.end;
  const align = first?.align === 'center' ? 'center' : first?.align === 'right' ? 'right' : 'left';
  const ins = body.insets;
  const color = st ? solidOf(st.fill) : undefined;
  return {
    id: ctx.newId(),
    type: 'text',
    box,
    text,
    style: {
      fontFamily: st?.latin ?? 'Calibri',
      fontWeight: st?.bold ? 700 : 400,
      fontStyle: st?.italic ? 'italic' : 'normal',
      fontSizePx: Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, ptPx(ctx.frame, st?.sizePt ?? 18))),
      color: color ?? { r: 0, g: 0, b: 0, a: st?.fill.kind === 'none' ? 0 : 1 },
      align,
      valign: body.anchor,
      lineHeight: 1.2,
      letterSpacing: bound(ptPx(ctx.frame, st?.spacingPt ?? 0), -1000, 1000),
      padding: bound(lenPx(ctx.frame, Math.min(ins.l, ins.t, ins.r, ins.b)), 0, MAX_COORD),
      transform: st?.caps === 'all' ? 'uppercase' : 'none',
    },
    opacity: 1,
  };
}

/** FNV-1a over the objects' JSON, two 32-bit lanes: 16 hex digits. */
export function digestOf(objects: readonly SlideObject[]): string {
  const s = JSON.stringify(objects);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
