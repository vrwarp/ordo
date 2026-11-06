import { LOGICAL_HEIGHT, type Rgba, type Shadow, type TextObject, rgbaCss } from '@ordo/domain';

import { CLAMP, num } from '../clamp.ts';
import { type Ctx2D, roundRect, setLang, setLetterSpacing, withRotation } from '../ctx.ts';
import { resolveRunStyle } from './itemize.ts';
import { insetsOf } from './lines.ts';
import { segText } from './segments.ts';
import type { FontEnv, RichLayout, RunStyle } from './types.ts';

/*
 * Paint passes (design/27 §6 "Paint passes"). Owner: paint-dispatch (D).
 *
 * Under `ctx.scale(scale)` (composed with the caller's transform: thumbnails translate first), each segment
 * is drawn at its reference x with `textAlign 'left'` and its own font, direction, language and letter
 * spacing, so line breaks and positions never depend on the device size. Canvas shadows ignore the
 * transform, so shadow offsets and blur are multiplied by `scale` (as `drawText` does): `scale` is the whole
 * device px per logical px, and a caller that draws at a higher density (the editor at devicePixelRatio)
 * passes it in `scale` rather than scaling the context itself.
 *
 * The passes, in `drawText`'s order:
 * 1. the text fill box (`style.fill`, the ink grown by the insets) and run highlights;
 * 2. shadows of every line: the run's shadow, else the box's (a run's `shadow: null` turns it off),
 *    underlines and strikes included;
 * 3. glow (`style.glow`): the glyphs blurred with `shadowBlur` = radius and zero offset;
 * 4. outline: `strokeText` at 2 × width with round joins, under the fill (ordo's `width = w/2` semantics);
 * 5. fill: solid (the gradient over the box is M6);
 * 6. underline and strike: F/18 thick, underline centred F/10 below the baseline, strike F/4 above it,
 *    F being the segment's drawn size; no descender skipping, as LibreOffice;
 * 7. bullets and numbers.
 * Lines of hidden paragraphs (the M8 split reveal) are laid out but never painted.
 *
 * Caches: everything that does not depend on the device scale (drawn strings with case mapping, resolved
 * run styles, CSS colours, highlight and decoration rectangles, merged across segments) is built once per
 * layout in a `PaintPlan`, memoised by layout identity; layouts themselves are memoised per object and font
 * generation (rich.ts), so repainting at another scale, in a thumbnail or in the editor costs only the draw
 * calls. Context state (font, direction, language, spacing, fill) is assigned only when it changes.
 */

/** Underline and strike thickness, × the segment's drawn size (LibreOffice's F/18). */
export const DECORATION_THICKNESS = 1 / 18;
/** Underline centre below the baseline, × size. */
export const UNDERLINE_OFFSET = 0.1;
/** Strike centre above the baseline, × size (about half the x-height of common faces). */
export const STRIKE_RISE = 0.25;
/** Highlight box above and below the baseline, × size: 1.2 × size tall, so highlighted single-spaced lines meet. */
export const HIGHLIGHT_ASCENT = 0.9;
export const HIGHLIGHT_DESCENT = 0.3;

/** One segment's glyphs, ready to draw. */
type Glyphs = {
  text: string;
  x: number;
  /** Baseline y, the segment's shift included. */
  y: number;
  font: string;
  dir: 'ltr' | 'rtl';
  lang: string;
  spacing: number;
  /** Fill colour (pass 5). */
  fill: string;
  /** The colour that casts the shadow: the outline's, else the fill's (as `drawText`). */
  cast: string;
  shadow: Shadow | null;
  shadowColor: string;
  outline: { width: number; color: string } | null;
};

type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  shadow: Shadow | null;
  shadowColor: string;
};

type Bullet = { text: string; x: number; y: number; font: string; color: string };

/** What `paintRich` draws for one layout, independent of the device scale. */
export type PaintPlan = {
  /** The text fill box (logical px), or null. */
  box: { x: number; y: number; w: number; h: number; radius: number; color: string } | null;
  highlights: Rect[];
  /** Glyphs of every visible, non-blank segment, in line then visual order. */
  glyphs: Glyphs[];
  /** Underlines and strikes. */
  decorations: Rect[];
  bullets: Bullet[];
  glow: { radius: number; color: string; fill: string } | null;
};

const plans = new WeakMap<RichLayout, { o: TextObject; plan: PaintPlan }>();

/** Paint a layout of `o` (made by `layoutRich` for the same object) at `scale` device px per logical px. */
export function paintRich(ctx: Ctx2D, o: TextObject, l: RichLayout, scale: number, _env: FontEnv): void {
  const plan = paintPlan(o, l);
  ctx.save();
  ctx.globalAlpha = num(o.opacity, 0, 1, 1);
  ctx.scale(scale, scale);
  withRotation(ctx, o.box, 1, () => {
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const state = new TextState(ctx);
    // 1. Fill box and highlights.
    if (plan.box) {
      const b = plan.box;
      state.fill(b.color);
      roundRect(ctx, b.x, b.y, b.w, b.h, b.radius);
      ctx.fill();
    }
    for (const r of plan.highlights) {
      state.fill(r.color);
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // 2. Shadows: the casting glyphs and decorations, one shadow setting per run of equal shadows.
    if (plan.glyphs.some((g) => g.shadow) || plan.decorations.some((d) => d.shadow)) {
      ctx.save();
      let cur: Shadow | null = null;
      const use = (s: Shadow, color: string) => {
        if (s === cur) return;
        cur = s;
        ctx.shadowColor = color;
        ctx.shadowBlur = s.blur * scale;
        ctx.shadowOffsetX = s.dx * scale;
        ctx.shadowOffsetY = s.dy * scale;
      };
      for (const g of plan.glyphs) {
        if (!g.shadow) continue;
        use(g.shadow, g.shadowColor);
        state.text(g);
        state.fill(g.cast);
        ctx.fillText(g.text, g.x, g.y);
      }
      for (const d of plan.decorations) {
        if (!d.shadow) continue;
        use(d.shadow, d.shadowColor);
        state.fill(d.color);
        ctx.fillRect(d.x, d.y, d.w, d.h);
      }
      ctx.restore();
      state.reset();
    }
    // 3. Glow: the glyphs in the glow colour, blurred around themselves.
    if (plan.glow && plan.glyphs.length) {
      ctx.save();
      ctx.shadowColor = plan.glow.color;
      ctx.shadowBlur = plan.glow.radius * scale;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      state.fill(plan.glow.fill);
      for (const g of plan.glyphs) {
        state.text(g);
        ctx.fillText(g.text, g.x, g.y);
      }
      ctx.restore();
      state.reset();
    }
    // 4. Outline.
    if (plan.glyphs.some((g) => g.outline)) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      for (const g of plan.glyphs) {
        if (!g.outline) continue;
        state.text(g);
        ctx.lineWidth = g.outline.width * 2;
        ctx.strokeStyle = g.outline.color;
        ctx.strokeText(g.text, g.x, g.y);
      }
    }
    // 5. Fill.
    for (const g of plan.glyphs) {
      state.text(g);
      state.fill(g.fill);
      ctx.fillText(g.text, g.x, g.y);
    }
    // 6. Underline and strike.
    for (const d of plan.decorations) {
      state.fill(d.color);
      ctx.fillRect(d.x, d.y, d.w, d.h);
    }
    // 7. Bullets: left to right, no spacing, the bullet's own font and colour.
    for (const b of plan.bullets) {
      state.text({ font: b.font, dir: 'ltr', lang: '', spacing: 0 });
      state.fill(b.color);
      ctx.fillText(b.text, b.x, b.y);
    }
  });
  ctx.restore();
}

/** The scale-independent part of painting `l`, memoised by layout. */
export function paintPlan(o: TextObject, l: RichLayout): PaintPlan {
  const hit = plans.get(l);
  if (hit && hit.o === o) return hit.plan;
  const plan = buildPlan(o, l);
  plans.set(l, { o, plan });
  return plan;
}

function buildPlan(o: TextObject, l: RichLayout): PaintPlan {
  const style = o.style;
  const styles = new Map<number, RunStyle>();
  const styleOf = (run: number): RunStyle => {
    let s = styles.get(run);
    if (!s) {
      s = resolveRunStyle(style, run < 0 ? undefined : o.runs?.[run]);
      styles.set(run, s);
    }
    return s;
  };
  const colours = new Map<Rgba, string>();
  const css = (c: Rgba): string => {
    let s = colours.get(c);
    if (s === undefined) {
      s = rgbaCss(c);
      colours.set(c, s);
    }
    return s;
  };
  // Lines far outside the clamp region are never visible (drawText culls them the same way).
  const lo = -CLAMP.boxFactor * LOGICAL_HEIGHT;
  const hi = CLAMP.boxFactor * LOGICAL_HEIGHT;
  const hidden = hiddenParas(o);
  const lines = l.lines.filter(
    (line) => !hidden[line.para] && line.top + line.height >= lo && line.top <= hi,
  );
  const plan: PaintPlan = { box: null, highlights: [], glyphs: [], decorations: [], bullets: [], glow: null };
  if (style.fill && o.text.trim()) {
    const ins = insetsOf(style);
    const ink = l.ink;
    plan.box = {
      x: ink.x - ins.l,
      y: ink.y - ins.t,
      w: ink.w + ins.l + ins.r,
      h: ink.h + ins.t + ins.b,
      radius: style.fill.radius,
      color: css(style.fill.color),
    };
  }
  if (style.glow && style.glow.radius > 0 && style.glow.color.a > 0)
    plan.glow = {
      radius: style.glow.radius,
      color: css({ ...style.glow.color, a: 1 }),
      fill: css(style.glow.color),
    };
  for (const line of lines) {
    // The line's content without hanging whitespace: highlights and decorations stop at its edges.
    const left = line.x;
    const right = line.x + line.w;
    const marks = new Marks();
    line.segs.forEach((s, i) => {
      const st = styleOf(s.run);
      const x0 = Math.max(s.x, left);
      const x1 = Math.min(s.x + s.w, right);
      const y = line.baseline + s.shift;
      const F = s.sizePx;
      if (st.highlight && st.highlight.a > 0)
        marks.add(
          plan.highlights,
          'h',
          i,
          x0,
          x1,
          y - HIGHLIGHT_ASCENT * F,
          (HIGHLIGHT_ASCENT + HIGHLIGHT_DESCENT) * F,
          css(st.highlight),
          null,
        );
      const t = F * DECORATION_THICKNESS;
      const shadow = st.shadow;
      if (st.underline)
        marks.add(
          plan.decorations,
          'u',
          i,
          x0,
          x1,
          y + UNDERLINE_OFFSET * F - t / 2,
          t,
          css(st.color),
          shadow,
        );
      if (st.strike)
        marks.add(plan.decorations, 's', i, x0, x1, y - STRIKE_RISE * F - t / 2, t, css(st.color), shadow);
      const text = segText(o.text, s.start, s.end, st.caps);
      if (!text.trim()) return;
      plan.glyphs.push({
        text,
        x: s.x,
        y,
        font: s.font,
        dir: s.level % 2 ? 'rtl' : 'ltr',
        lang: st.lang,
        spacing: st.letterSpacing,
        fill: css(st.color),
        cast: css(st.outline?.color ?? st.color),
        shadow,
        shadowColor: shadow ? css(shadow.color) : '',
        outline:
          st.outline && st.outline.width > 0
            ? { width: st.outline.width, color: css(st.outline.color) }
            : null,
      });
    });
    const b = line.bullet;
    if (b?.text.trim())
      plan.bullets.push({ text: b.text, x: b.x, y: line.baseline, font: b.font, color: css(b.color) });
  }
  return plan;
}

/**
 * Whether each paragraph is hidden (the M8 split reveal), as itemize.ts resolves it: its own `hidden`, else,
 * for a soft paragraph (a line break inside one PowerPoint paragraph), the hidden state of the paragraph it
 * continues.
 */
export function hiddenParas(o: TextObject): boolean[] {
  const out: boolean[] = [];
  const paras = o.paras ?? [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    out.push(p?.hidden ?? (i > 0 && p?.soft === true ? out[i - 1]! : false));
  }
  return out;
}

/**
 * Highlight and decoration rectangles of one line. A mark continues its kind's previous one when that came
 * from the segment just before in visual order, with the same colour, position, thickness and shadow, so an
 * underline or highlight runs unbroken across word gaps and justification.
 */
class Marks {
  readonly #last = new Map<string, { rect: Rect; seg: number }>();

  add(
    out: Rect[],
    kind: string,
    seg: number,
    x0: number,
    x1: number,
    y: number,
    h: number,
    color: string,
    shadow: Shadow | null,
  ): void {
    const last = this.#last.get(kind);
    const r = last?.rect;
    if (
      last &&
      r &&
      last.seg === seg - 1 &&
      r.color === color &&
      r.shadow === shadow &&
      r.y === y &&
      r.h === h
    ) {
      if (x1 > r.x + r.w) r.w = x1 - r.x;
      last.seg = seg;
      return;
    }
    if (x1 <= x0) return;
    const rect: Rect = {
      x: x0,
      y,
      w: x1 - x0,
      h,
      color,
      shadow,
      shadowColor: shadow ? rgbaCss(shadow.color) : '',
    };
    out.push(rect);
    this.#last.set(kind, { rect, seg });
  }
}

/** The text state last assigned to the context, so unchanged values are not assigned (and parsed) again. */
class TextState {
  #font = '';
  #dir = '';
  #lang: string | null = null;
  #spacing = Number.NaN;
  #fill = '';
  constructor(readonly ctx: Ctx2D) {}

  /** Forget what was assigned (after a `restore`). */
  reset(): void {
    this.#font = '';
    this.#dir = '';
    this.#lang = null;
    this.#spacing = Number.NaN;
    this.#fill = '';
  }

  text(g: { font: string; dir: 'ltr' | 'rtl'; lang: string; spacing: number }): void {
    const { ctx } = this;
    if (g.font !== this.#font) {
      ctx.font = g.font;
      this.#font = g.font;
    }
    if (g.dir !== this.#dir) {
      ctx.direction = g.dir;
      this.#dir = g.dir;
    }
    if (g.lang !== this.#lang) {
      setLang(ctx, g.lang);
      this.#lang = g.lang;
    }
    if (g.spacing !== this.#spacing) {
      setLetterSpacing(ctx, g.spacing);
      this.#spacing = g.spacing;
    }
  }

  fill(color: string): void {
    if (color !== this.#fill) {
      this.ctx.fillStyle = color;
      this.#fill = color;
    }
  }
}
