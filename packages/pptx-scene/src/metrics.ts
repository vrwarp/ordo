/**
 * Advance widths read from font files, so text can be measured without a browser (design/27 §15 M6 tables:
 * a table row is as tall as its text, measured with sfnt metrics on the hub).
 *
 * - **The sfnt reader** (`head`, `hhea`, `hmtx`, `cmap`, `OS/2`, `GPOS` and `kern` pair kerning, collections,
 *   every bound) lives in `@ordo/renderer/text/sfnt/{reader,cmap}.ts` since M9 (design/27 §15 M9 decision
 *   12), so the glyph outline reader of the asset worker builds on the same bounded tables; this module
 *   re-exports it unchanged (`FaceMetrics`, `sfntMetrics`, `metricsOfTables`, `SFNT_LIMITS`, `SfntTables`).
 * - **`FaceSource`**: the caller's font resolver, by family, weight and slant (`ParseOptions.fontFace`), and
 *   since M9 optionally by script (`FaceSource.script`, for the table cells whose run faces lack a script).
 * - **M9 measurement seams** for the converter's later work: `advanceOf` (a line's advance in em, the legacy
 *   size of a warped title) and `heightOf` (paragraphs' height at a size through `tables.ts` `Measure`, the
 *   fit of a SmartArt node).
 *
 * Pure: bytes in, numbers out.
 */
import type { Para, RunStyle, TextBody } from './ir.ts';
import type { FaceMetrics } from '@ordo/renderer/text/sfnt/reader.ts';

export {
  type FaceMetrics,
  metricsOfTables,
  SFNT_LIMITS,
  type SfntTables,
  sfntMetrics,
  tablesAt,
} from '@ordo/renderer/text/sfnt/reader.ts';

/**
 * The face that draws `family` in a weight and slant, as the caller's font resolver would pick it (the
 * library's own face, else nothing: substitutes are asked for by name), or undefined when there is none.
 *
 * M9: a source may also answer `script(code)`, the face its fallback draws a script in (an ISO 15924 code of
 * the domain's `FALLBACK_SCRIPTS`: 'Hang', 'Hani', 'Arab' …) when no face of the run has it: the hub's
 * bundled or on-demand script face, the harness's `fc-match`. A source without it measures such text with
 * estimated widths, as before.
 */
export type FaceSource = ((family: string, bold: boolean, italic: boolean) => FaceMetrics | undefined) & {
  script?: (code: string) => FaceMetrics | undefined;
};

// ── M9 measurement seams ────────────────────────────────────────────────────────────────────────────────

/** The face a line of text is measured in: its family (the deck's own name), weight and slant. */
export interface FaceStyle {
  family: string;
  bold: boolean;
  italic: boolean;
}

/** The advance of a character no face has, as a share of the em (warps' legacy size, design/27 M9). */
export const ESTIMATED_ADVANCE = 0.55;

/**
 * The advance of one line of text in em (its width at a 1 px font size): each code point by the first face
 * that has a glyph for it, the family's own, then `fallbacks` in order (each asked once per call, its bold
 * and italic face first, then its regular one), plus the pair kerning of neighbours one face draws (as the
 * renderer measures a run); a code point no face has is `ESTIMATED_ADVANCE`. Line breaks are not looked at:
 * the caller measures one line at a time. Linear in the text, never throws (a face that throws is missing).
 */
export function advanceOf(
  faces: FaceSource | undefined,
  text: string,
  style: FaceStyle,
  fallbacks: readonly string[] = [],
): number {
  const chain: FaceMetrics[] = [];
  const seen: string[] = [];
  for (const name of [style.family, ...fallbacks]) {
    const key = name.trim().toLowerCase();
    if (!key || seen.includes(key)) continue;
    seen.push(key);
    let f: FaceMetrics | undefined;
    try {
      f = faces?.(name, style.bold, style.italic);
      if (!f && (style.bold || style.italic)) f = faces?.(name, false, false);
    } catch {
      f = undefined;
    }
    if (f && typeof f.advance === 'function') chain.push(f);
  }
  let w = 0;
  let prev: { cp: number; face: FaceMetrics } | undefined;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let face: FaceMetrics | undefined;
    let a: number | undefined;
    for (const f of chain) {
      const v = f.advance(cp);
      if (v !== undefined && Number.isFinite(v) && v >= 0) {
        face = f;
        a = v;
        break;
      }
    }
    if (face && a !== undefined) {
      w += a;
      if (prev?.face === face && face.kern) {
        const k = face.kern(prev.cp, cp);
        if (Number.isFinite(k)) w += k;
      }
      prev = { cp, face };
    } else {
      w += ESTIMATED_ADVANCE;
      prev = undefined;
    }
  }
  return Math.max(0, w);
}

/** What lays text out for its height: `tables.ts` `Measure`, which breaks lines as the renderer does. */
export interface BodyMeasure {
  height(body: TextBody, widthPx: number): number;
}

/** Run sizes `heightOf` takes, as `RunStyle.sizePt` is bounded (`text.ts`). */
const MIN_SIZE_PT = 1;
const MAX_SIZE_PT = 4_000;

/**
 * The height in logical px of paragraphs laid out `widthPx` wide by `m` (its line breaking and the office
 * line model; the body's insets are not part of it), every run and end mark at `sizePt` when it is given
 * (clamped to 1-4,000 pt), else at its own size: the size a SmartArt node's text fits at (design/27 M9,
 * `dgm-core`).
 */
export function heightOf(m: BodyMeasure, paras: readonly Para[], widthPx: number, sizePt?: number): number {
  const size =
    sizePt === undefined || !Number.isFinite(sizePt)
      ? undefined
      : Math.min(MAX_SIZE_PT, Math.max(MIN_SIZE_PT, sizePt));
  const sized = (s: RunStyle): RunStyle => (size === undefined ? s : { ...s, sizePt: size });
  const body: TextBody = {
    paras: paras.map((p) => ({
      ...p,
      runs: p.runs.map((r) => ({ ...r, style: sized(r.style) })),
      end: sized(p.end),
    })),
    insets: { l: 0, t: 0, r: 0, b: 0 },
    anchor: 'top',
    wrap: true,
    autofit: { kind: 'none' },
  };
  const h = m.height(body, Number.isFinite(widthPx) ? Math.max(0, widthPx) : 0);
  return Number.isFinite(h) ? Math.max(0, h) : 0;
}
