import type { SlideObject, TextObject } from '@ordo/domain';
import {
  type Ctx2D,
  clampBox,
  clampStyle,
  clampTextObject,
  currentFontEnv,
  type FontEnv,
  isRichText,
  layoutRich,
  layoutText,
  type Measurer,
  measurerFor,
} from '@ordo/renderer';

/*
 * The overflow test of the editor (M4 item C; design/27 §11 item 4): whether a text box's text does not fit
 * it, laid out exactly as the drawers lay it out, so the canvas's dashed red edge and the Object panel's
 * "Text does not fit" agree with what every screen shows:
 * - rich text (runs, paragraph styles or a rich style field: `isRichText`) through the rich engine,
 *   `layoutRich(measurer, clampTextObject(o), fontEnv).overflow`, with the measurer and font environment the
 *   editor's canvas draws with (`measurerFor`, `currentFontEnv`), so the layout is the one the canvas has
 *   already memoised for the object. A shrink-to-fit box overflows only past the engine's smallest fit;
 *   text wider than a box that does not wrap overflows too;
 * - legacy text through `layoutText` at 1 device px per logical px (as the canvas draws it): the lines are
 *   taller than the box less its padding.
 * Empty and blank text never overflows. Results are memoised by object identity and font generation (a face
 * that loads later lays the box out again).
 */

/** What the test lays text out with: defaults to the editor canvas's own (tests pass fixed-width ones). */
export type FitProbe = {
  /** The rich engine's measurer (default: `measurerFor`, the shared measuring context). */
  measurer?: Measurer;
  /** The context legacy text is measured in (default: a 1x1 canvas of the page). */
  ctx?: Ctx2D;
  /** The font environment (default: `currentFontEnv()`, the page's font resolver). */
  env?: FontEnv;
};

/** Logical px a legacy layout may exceed its box by before it counts as overflowing (rounding). */
const SLACK = 0.5;

let measureCtx: Ctx2D | null | undefined;
/** A 2D context to measure legacy text in, or null where the platform has none (node). */
function pageCtx(): Ctx2D | null {
  if (measureCtx !== undefined) return measureCtx;
  measureCtx = null;
  try {
    if (typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
    else if (typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d');
  } catch {
    measureCtx = null;
  }
  return measureCtx;
}

const memo = new WeakMap<TextObject, { env: FontEnv; generation: number; overflow: boolean }>();

/** Whether the text of `o` does not fit its box, laid out as the drawers lay it out (see the top). */
export function textOverflows(o: TextObject, probe: FitProbe = {}): boolean {
  if (!o.text.trim()) return false;
  const env = probe.env ?? currentFontEnv();
  const shared = !probe.measurer && !probe.ctx;
  if (shared) {
    const hit = memo.get(o);
    if (hit && hit.env === env && hit.generation === env.generation) return hit.overflow;
  }
  const overflow = isRichText(o) ? richOverflow(o, env, probe) : legacyOverflow(o, probe);
  if (overflow === undefined) return false;
  if (shared) memo.set(o, { env, generation: env.generation, overflow });
  return overflow;
}

function richOverflow(o: TextObject, env: FontEnv, probe: FitProbe): boolean | undefined {
  let m = probe.measurer;
  if (!m) {
    const ctx = probe.ctx ?? pageCtx();
    if (!ctx) return undefined;
    m = measurerFor(ctx);
  }
  return layoutRich(m, clampTextObject(o), env).overflow;
}

function legacyOverflow(o: TextObject, probe: FitProbe): boolean | undefined {
  const ctx = probe.ctx ?? pageCtx();
  if (!ctx) return undefined;
  const style = clampStyle(o.style);
  const box = clampBox(o.box);
  const l = layoutText(ctx, o.text, style, box, 1);
  const innerH = Math.max(1, box.h - 2 * style.padding);
  return l.lines.length * l.lineHeightPx > innerH + SLACK;
}

/** The text objects of `objects` whose text does not fit their box, in order. */
export function overflowingText(objects: readonly SlideObject[], probe?: FitProbe): TextObject[] {
  const out: TextObject[] = [];
  for (const o of objects) if (o.type === 'text' && textOverflows(o, probe)) out.push(o);
  return out;
}

/**
 * The Object panel's note for a text box whose text does not fit (design/27 §11 item 4), or undefined
 * when it fits. A shrink-to-fit box that still overflows has shrunk as far as the engine shrinks.
 */
export function fitMessage(o: TextObject, probe?: FitProbe): string | undefined {
  if (!textOverflows(o, probe)) return undefined;
  return o.style.autofit === 'shrink'
    ? 'Text does not fit, even shrunk: enlarge the box or shorten the text.'
    : 'Text does not fit: turn on Shrink text to fit or enlarge the box.';
}
