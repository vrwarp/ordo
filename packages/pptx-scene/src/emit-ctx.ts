/**
 * What every part of the emitter shares (design/27 §15 M9, `conv-seams`: `emit.ts` split into `emit.ts`,
 * `emit-text.ts`, `emit-budget.ts` and `emit-table.ts`, so that the M9 areas each own the part they change):
 * one slide's emission context (`EmitCtx`), the M9 field gate (`M9_FIELDS`, `EmitOptions.m9Writes`), and the
 * box, colour and object helpers every part uses. Moved here verbatim from `emit.ts`; nothing here depends on
 * the other parts, so they import it and never each other in a cycle.
 *
 * Pure: values in, ordo objects out.
 */
import type { ImageObject, Rgba as OrdoRgba, ShapeObject } from '@ordo/domain';
import type { PictureBake, SheetBake } from './bake.ts';
import type { PlatePlan } from './decor.ts';
import { boxPx } from './frame.ts';
import type { Affine, Fill, Frame, Rgba } from './ir.ts';
import type { EmittedClip } from './media.ts';
import type { EmittedSheet } from './sheet.ts';

/** Logical coordinates are bounded by the schema (`coord`). */
export const MAX_COORD = 100_000;

/** The render clamp keeps box edges within ±2× the logical canvas (`@ordo/renderer` `CLAMP.boxFactor`). */
export const CANVAS_W = 1_920;
export const CANVAS_H = 1_080;
export const BOX_FACTOR = 2;

/**
 * The stored fields of design/27 §15 M9 the converter writes (plan §3), each behind its own switch:
 * `EmitOptions.m9Writes` (the hub's `M9_WRITES`, default every field) names those it may write. Without a
 * field the converter writes what an older build draws for it (design/27 §3.2): a table as its M6 group of
 * shapes, a chart as its chart area, decorations as separate shapes, 3-D flat, a warp as plain text, vertical
 * text in its turned box, a `centerBlock` as the lines at their own alignment, a metafile through LibreOffice
 * or left out, an `adjWide` angle clamped, a geometry file within the M6 bounds. Without 'decorFile' a
 * decoration keeps its parts in the slide (`decor.ts` `decorFiles`, `DecorData.ref` never written): what an
 * importer that stores no decoration files needs (the hub and the client name and store them since
 * `decor-render`: both write 'decorFile').
 */
export const M9_FIELDS = [
  'table',
  'chart',
  'decor',
  'decorFile',
  'look3d',
  'warp',
  'writing',
  'centerBlock',
  'vectorFonts',
  'adjWide',
  'geomFile64',
] as const;
export type M9Field = (typeof M9_FIELDS)[number];

/** Every M9 field: the default of `EmitOptions.m9Writes` (decisions.md 1: M9 writes its fields in 0.2.0). */
export const ALL_M9_FIELDS: ReadonlySet<M9Field> = new Set(M9_FIELDS);

/** Whether the slide's emission may write an M9 field (`EmitOptions.m9Writes`). */
export function writes(ctx: Pick<EmitCtx, 'm9'>, field: M9Field): boolean {
  return ctx.m9.has(field);
}

/** What one slide's emission needs. */
export interface EmitCtx {
  frame: Frame;
  newId: () => string;
  mediaId: (part: string) => string;
  extend: boolean;
  crop: boolean;
  rich: boolean;
  lo: boolean;
  media: Map<string, string>;
  /** The placeholder id of a baked picture (M6); undefined: nothing is baked. */
  bake?: (part: string, bake: PictureBake) => string;
  log: (msg: string) => void;
  /** Metafile pictures set aside, with the index in the slide's objects where each would go. */
  metafiles?: { part: string; object: ImageObject; at: number }[];
  /** UTF-8 bytes of the slide's rich text objects so far (`MAX_SLIDE_BYTES`). */
  textBytes: number;
  clipId: (key: string) => string;
  transitionSounds: boolean;
  /** The slide's clips (`media.ts`). */
  clips?: EmittedClip[];
  /**
   * M9: LibreOffice can draw what ordo does not (`EmitOptions.libreoffice`, default true). Without it the
   * art and the metafile pictures are not planned: what they would draw is recorded as missing (`hybrid.ts`).
   */
  libreoffice: boolean;
  /** M9: the stored fields the emission may write (`EmitOptions.m9Writes`, `writes`). */
  m9: ReadonlySet<M9Field>;
  /**
   * M9 (`decor-conv`, `sheet.ts`): the placeholder media id of a sheet (`pptxmedia:sheet<n>`, one per distinct
   * recipe in the deck); undefined: no sheets in this emission (pictures are emitted one by one).
   */
  sheet?: (bake: SheetBake) => string;
  /** M9: the sheets the slide uses so far (`EmittedSlide.sheets`). */
  sheets?: EmittedSheet[];
  /** M9: the picture part and recipe a placeholder media id stands for (a part's, a bake's). */
  mediaPart?: (id: string) => { part: string; bake?: PictureBake } | undefined;
  /** M9 (`decor-conv`): the slide's plate plan once it is emitted (`EmittedSlide.plate`). */
  plate?: PlatePlan & { pastBudget: string[] };
}

/** Visible characters of a string (whitespace not counted). */
export function visibleChars(s: string): number {
  let n = 0;
  for (const ch of s) if (ch.trim()) n++;
  return n;
}

/** UTF-8 length of `s`. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 2 : 3; // a pair counts 2 + 2
  }
  return n;
}

// ── Boxes and colours ───────────────────────────────────────────────────────────────────────────────────

export type Box = { x: number; y: number; w: number; h: number; rotation: number };

/** `v` within [lo, hi]; NaN and infinities become `lo` clamped to 0. */
export function bound(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : Math.min(hi, Math.max(lo, 0));
}

export function clampBox(b: Box): Box {
  const c = (v: number) => bound(v, -MAX_COORD, MAX_COORD);
  return {
    x: c(b.x),
    y: c(b.y),
    w: bound(b.w, 0, MAX_COORD),
    h: bound(b.h, 0, MAX_COORD),
    rotation: bound(b.rotation, -36_000, 36_000),
  };
}

export function boxOf(ctx: EmitCtx, xf: Affine): Box {
  return clampBox(boxPx(ctx.frame, xf));
}

/**
 * A box narrowed by `l`, `t`, `r`, `b` along its own (rotated) axes; negative values grow it. The size never
 * goes below zero.
 */
export function insetBox(box: Box, l: number, t: number, r: number, b: number): Box {
  const w = Math.max(0, box.w - l - r);
  const h = Math.max(0, box.h - t - b);
  const lx = (l - r) / 2;
  const ly = (t - b) / 2;
  const a = (box.rotation * Math.PI) / 180;
  const cx = box.x + box.w / 2 + lx * Math.cos(a) - ly * Math.sin(a);
  const cy = box.y + box.h / 2 + lx * Math.sin(a) + ly * Math.cos(a);
  return { x: cx - w / 2, y: cy - h / 2, w, h, rotation: box.rotation };
}

/** The same centre, the sides swapped and turned by `deg` (vertical text laid out along the long side). */
export function quarterTurn(box: Box, deg: number): Box {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let rotation = box.rotation + deg;
  if (rotation > 180) rotation -= 360;
  if (rotation <= -180) rotation += 360;
  return { x: cx - box.h / 2, y: cy - box.w / 2, w: box.h, h: box.w, rotation };
}

export function ordo(c: Rgba): OrdoRgba {
  const ch = (v: number) => (Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : 0);
  return { r: ch(c.r), g: ch(c.g), b: ch(c.b), a: Number.isFinite(c.a) ? Math.min(1, Math.max(0, c.a)) : 1 };
}

/** The share of the foreground in a `pctNN` pattern; 0.5 for the others. */
function patternShare(preset: string): number {
  const m = /^pct(\d{1,2})$/.exec(preset);
  return m ? Number(m[1]) / 100 : 0.5;
}

/**
 * The legacy solid colour of a fill (design/27 §3.2): solid as it is, a gradient's first stop, a pattern's
 * foreground and background blended by coverage. Undefined for none, pictures and group fills.
 */
export function legacyColor(f: Fill): OrdoRgba | undefined {
  switch (f.kind) {
    case 'solid':
      return ordo(f.color);
    case 'gradient': {
      let first = f.stops[0];
      for (const s of f.stops) if (first && s.at < first.at) first = s;
      return first ? ordo(first.color) : undefined;
    }
    case 'pattern': {
      const k = patternShare(f.preset);
      const mix = (a: number, b: number) => a * k + b * (1 - k);
      return ordo({
        r: mix(f.fg.r, f.bg.r),
        g: mix(f.fg.g, f.bg.g),
        b: mix(f.fg.b, f.bg.b),
        a: mix(f.fg.a, f.bg.a),
      });
    }
    default:
      return undefined;
  }
}

export function shape(
  ctx: EmitCtx,
  box: Box,
  kind: ShapeObject['shape'],
  fill: OrdoRgba | undefined,
): ShapeObject {
  return {
    id: ctx.newId(),
    type: 'shape',
    box: clampBox(box),
    shape: kind,
    ...(fill ? { fill } : {}),
    opacity: 1,
    radius: 0,
  };
}
