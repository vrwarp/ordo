import {
  type Gradient,
  LOGICAL_HEIGHT,
  type Rgba,
  type Shadow,
  type TextObject,
  rgbaCss,
} from '@ordo/domain';

import { CLAMP, num } from '../clamp.ts';
import { type Ctx2D, roundRect, setLang, setLetterSpacing, withRotation } from '../ctx.ts';
import { gradientStyle } from '../geom/paint.ts';
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
 * 5. fill: solid, or the box's gradient (`style.paint`, M6) for runs without their own colour: one gradient
 *    over the box in logical px (geom/paint.ts; a radial one as a circle to the farthest corner);
 * 6. underline and strike: F/18 thick, underline centred F/10 below the baseline, strike F/4 above it,
 *    F being the segment's drawn size; no descender skipping, as LibreOffice;
 * 7. bullets and numbers: their fill. A bullet takes its paragraph's first run's shadow and outline (else
 *    the box's) and the glow in passes 2-4, as PowerPoint gives it the first run's character formatting, so a
 *    white number keeps its shadow on a light background.
 * Lines of hidden paragraphs (the M8 split reveal) are laid out but never painted.
 *
 * Caches: everything that does not depend on the device scale (drawn strings with case mapping, resolved
 * run styles, CSS colours, highlight and decoration rectangles, merged across segments) is built once per
 * layout in a `PaintPlan`, memoised by layout identity; layouts themselves are memoised per object and font
 * generation (rich.ts), so repainting at another scale, in a thumbnail or in the editor costs only the draw
 * calls. Context state (font, direction, language, spacing, fill) is assigned only when it changes.
 *
 * Seams (M9 plan decision 6): the passes put glyphs on the context through a glyph painter (`GlyphPainter`:
 * plain `fillText`/`strokeText`; upright graphemes of vertical text, the writing engine; warped glyphs, the
 * warp painter), and they draw on a face target (`FaceTarget`: the context itself; or a face sprite the 3-D
 * look shades, whose alpha makes the shadow and glow). Both are chosen per object from what is registered
 * (`registerGlyphPainter`, `registerFaceTarget`), independently, so a bevelled warped title gets its rim on
 * the warped glyphs. With nothing registered it is the plain painter on the direct target: the calls above,
 * exactly as before the seam (paint.hooks.test.ts).
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

/** One segment's glyphs (or one bullet), ready to draw. */
export type PlannedGlyphs = {
  /** The layout line it is on (`RichLayout.lines` index). */
  line: number;
  /** Its segment in that line (`RichLine.segs` index); absent for a bullet. */
  seg?: number;
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
  /** Filled with the box's gradient instead (`style.paint`, a run without its own colour). */
  grad?: true;
  /** The colour that casts the shadow: the outline's, else the fill's (as `drawText`). */
  cast: string;
  shadow: Shadow | null;
  shadowColor: string;
  outline: { width: number; color: string } | null;
};

/** A highlight, underline or strike rectangle (logical px), on one layout line. */
export type PlannedRect = {
  line: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  shadow: Shadow | null;
  shadowColor: string;
};

export type LineMaskStrap = { x: number; y: number; w: number; h: number };
export type LineMaskPlan = {
  straps: LineMaskStrap[];
  fill?: string;
  gradient?: Gradient;
};

/** What `paintRich` draws for one layout, independent of the device scale. */
export type PaintPlan = {
  /** The text fill box (logical px), or null. */
  box: { x: number; y: number; w: number; h: number; radius: number; color: string } | null;
  highlights: PlannedRect[];
  /** Glyphs of every visible, non-blank segment, in line then visual order. */
  glyphs: PlannedGlyphs[];
  /** Underlines and strikes. */
  decorations: PlannedRect[];
  /** Bullets and numbers, with their paragraph's first run's effects. */
  bullets: PlannedGlyphs[];
  glow: { radius: number; color: string; fill: string } | null;
  /** The box's gradient text paint (`style.paint`), or null. */
  paint: Gradient | null;
  /** ProPresenter line-fill mask straps (`style.lineMask`), or null. */
  lineMask: LineMaskPlan | null;
  lineMasks?: LineMaskStrap[];
};

const plans = new WeakMap<RichLayout, { o: TextObject; plan: PaintPlan }>();

/** The pass a glyph run is drawn in (the header's 2 to 5 and 7). */
export type GlyphPass = 'shadow' | 'glow' | 'outline' | 'fill' | 'bullet';
/** The pass a rectangle is drawn in: a highlight (1), a shadowed underline or strike (2), a line (6). */
export type RectPass = 'highlight' | 'shadow' | 'decoration';

/**
 * Puts a plan's glyphs and rectangles on a context (M9 plan decision 6). The passes set the context's state
 * (font, direction, language, letter spacing, paint, shadow, outline width) before each call, under the
 * object's transform in logical px; the painter draws with it.
 */
export interface GlyphPainter {
  readonly kind: 'plain' | 'upright' | 'warp';
  /** The plan to paint for `o` laid out as `l` (default `paintPlan(o, l)`): a warp lays text out its way. */
  plan?(o: TextObject, l: RichLayout): PaintPlan;
  /** A glyph run's text: stroked in the 'outline' pass, filled in every other. */
  glyphs(ctx: Ctx2D, g: PlannedGlyphs, pass: GlyphPass): void;
  /** A highlight, underline or strike, filled. */
  rect(ctx: Ctx2D, r: PlannedRect, pass: RectPass): void;
}

/** Today's painter: each run at its reference position, `fillText`, `strokeText` and `fillRect`. */
export const PLAIN_PAINTER: GlyphPainter = {
  kind: 'plain',
  glyphs(ctx, g, pass) {
    if (pass === 'outline') ctx.strokeText(g.text, g.x, g.y);
    else ctx.fillText(g.text, g.x, g.y);
  },
  rect(ctx, r) {
    ctx.fillRect(r.x, r.y, r.w, r.h);
  },
};

/** The passes after the fill box and highlights, for a face target to draw where it needs them. */
export interface PaintPasses {
  /** Passes 2 and 3 (shadows, glow) on `c`, which the target has set up as `ctx` (transform and alpha). */
  effects(c: Ctx2D): void;
  /** Passes 4 to 7 (outline, fill, underline and strike, bullets) on `c`. */
  face(c: Ctx2D): void;
}

/**
 * Where the face of a text object is drawn (M9 plan decision 6): on the context (`direct`), or into a face
 * sprite (`sprite`, the 3-D look: shaded, then its alpha casts the shadow and glow).
 */
export interface FaceTarget {
  readonly kind: 'direct' | 'sprite';
  /** Draws the passes onto `ctx`, which holds the object's transform (scale, rotation) and opacity. */
  draw(ctx: Ctx2D, o: TextObject, plan: PaintPlan, passes: PaintPasses, scale: number): void;
}

/** Today's target: effects, then the face, on the context itself. */
export const DIRECT_TARGET: FaceTarget = {
  kind: 'direct',
  draw(ctx, _o, _plan, passes) {
    passes.effects(ctx);
    passes.face(ctx);
  },
};

type Hooked<T> = { applies: (o: TextObject) => boolean; hook: T };
const painters = new Map<'upright' | 'warp', Hooked<GlyphPainter>>();
let spriteTarget: Hooked<FaceTarget> | undefined;

/**
 * Register the glyph painter of a kind for the objects `applies` says (the writing engine: upright; the warp
 * painter: warp). The last one registered for a kind wins; returns its unregistration.
 */
export function registerGlyphPainter(
  kind: 'upright' | 'warp',
  applies: (o: TextObject) => boolean,
  painter: GlyphPainter,
): () => void {
  const entry = { applies, hook: painter };
  painters.set(kind, entry);
  return () => {
    if (painters.get(kind) === entry) painters.delete(kind);
  };
}

/** Register the face sprite target (the 3-D look) for the objects `applies` says; returns its unregistration. */
export function registerFaceTarget(applies: (o: TextObject) => boolean, target: FaceTarget): () => void {
  const entry = { applies, hook: target };
  spriteTarget = entry;
  return () => {
    if (spriteTarget === entry) spriteTarget = undefined;
  };
}

/** The painter of an object: a warp's, else upright's when they apply, else the plain painter. */
export function glyphPainterFor(o: TextObject): GlyphPainter {
  for (const kind of ['warp', 'upright'] as const) {
    const p = painters.get(kind);
    if (p?.applies(o)) return p.hook;
  }
  return PLAIN_PAINTER;
}

/** The face target of an object: the sprite target when it applies, else the direct one. */
export function faceTargetFor(o: TextObject): FaceTarget {
  return spriteTarget?.applies(o) ? spriteTarget.hook : DIRECT_TARGET;
}

/** A painter and target chosen by the caller instead of the registered ones. */
export type PaintHooks = { painter?: GlyphPainter; target?: FaceTarget };

/** Paint a layout of `o` (made by `layoutRich` for the same object) at `scale` device px per logical px. */
export function paintRich(
  ctx: Ctx2D,
  o: TextObject,
  l: RichLayout,
  scale: number,
  _env: FontEnv,
  hooks?: PaintHooks,
): void {
  const painter = hooks?.painter ?? glyphPainterFor(o);
  const target = hooks?.target ?? faceTargetFor(o);
  const plan = painter.plan?.(o, l) ?? paintPlan(o, l);
  ctx.save();
  ctx.globalAlpha = num(o.opacity, 0, 1, 1);
  ctx.scale(scale, scale);
  withRotation(ctx, o.box, 1, () => {
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const state = new TextState(ctx);
    // A target's own context (a face sprite) keeps its own record of what was assigned.
    const states = new Map<Ctx2D, TextState>([[ctx, state]]);
    const stateOf = (c: Ctx2D): TextState => {
      let st = states.get(c);
      if (!st) {
        c.textBaseline = 'alphabetic';
        c.textAlign = 'left';
        st = new TextState(c);
        states.set(c, st);
      }
      return st;
    };
    // 1. Fill box, line masks and highlights.
    if (plan.box) {
      const b = plan.box;
      state.fill(b.color);
      roundRect(ctx, b.x, b.y, b.w, b.h, b.radius);
      ctx.fill();
    }
    if (plan.lineMask && plan.lineMask.straps.length > 0) {
      const lm = plan.lineMask;
      if (lm.gradient) {
        const b = o.box;
        const g = gradientStyle(ctx, lm.gradient, b.w, b.h, 0, { x0: b.x, y0: b.y });
        const grad = typeof g === 'object' && g !== null && 'style' in g ? g.style : g;
        state.paint(grad as CanvasGradient);
      } else if (lm.fill) {
        state.fill(lm.fill);
      }
      for (const r of lm.straps) {
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    }
    for (const r of plan.highlights) {
      state.fill(r.color);
      painter.rect(ctx, r, 'highlight');
    }
    const cast = [...plan.glyphs, ...plan.bullets];
    target.draw(
      ctx,
      o,
      plan,
      {
        effects: (c) => paintEffects(c, stateOf(c), plan, cast, scale, painter),
        face: (c) => paintFace(c, stateOf(c), o, plan, cast, painter),
      },
      scale,
    );
  });
  ctx.restore();
}

/** Passes 2 and 3: shadows of the casting glyphs, bullets and decorations, then the glow. */
function paintEffects(
  ctx: Ctx2D,
  state: TextState,
  plan: PaintPlan,
  cast: readonly PlannedGlyphs[],
  scale: number,
  painter: GlyphPainter,
): void {
  // 2. Shadows: one shadow setting per run of equal shadows.
  if (cast.some((g) => g.shadow) || plan.decorations.some((d) => d.shadow)) {
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
    for (const g of cast) {
      if (!g.shadow) continue;
      use(g.shadow, g.shadowColor);
      state.text(g);
      state.fill(g.cast);
      painter.glyphs(ctx, g, 'shadow');
    }
    for (const d of plan.decorations) {
      if (!d.shadow) continue;
      use(d.shadow, d.shadowColor);
      state.fill(d.color);
      painter.rect(ctx, d, 'shadow');
    }
    ctx.restore();
    state.reset();
  }
  // 3. Glow: the glyphs in the glow colour, blurred around themselves.
  if (plan.glow && cast.length) {
    ctx.save();
    ctx.shadowColor = plan.glow.color;
    ctx.shadowBlur = plan.glow.radius * scale;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    state.fill(plan.glow.fill);
    for (const g of cast) {
      state.text(g);
      painter.glyphs(ctx, g, 'glow');
    }
    ctx.restore();
    state.reset();
  }
}

/** Passes 4 to 7: outline, fill, underline and strike, bullets. */
function paintFace(
  ctx: Ctx2D,
  state: TextState,
  o: TextObject,
  plan: PaintPlan,
  cast: readonly PlannedGlyphs[],
  painter: GlyphPainter,
): void {
  // 4. Outline.
  if (cast.some((g) => g.outline)) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    for (const g of cast) {
      if (!g.outline) continue;
      state.text(g);
      ctx.lineWidth = g.outline.width * 2;
      ctx.strokeStyle = g.outline.color;
      painter.glyphs(ctx, g, 'outline');
    }
  }
  // 5. Fill.
  let grad: ReturnType<typeof gradientStyle> | undefined;
  for (const g of plan.glyphs) {
    state.text(g);
    if (g.grad && plan.paint) {
      const b = o.box;
      grad ??= gradientStyle(ctx, plan.paint, b.w, b.h, 0, { x0: b.x, y0: b.y });
      state.paint(grad as CanvasGradient);
    } else state.fill(g.fill);
    painter.glyphs(ctx, g, 'fill');
  }
  // 6. Underline and strike.
  for (const d of plan.decorations) {
    state.fill(d.color);
    painter.rect(ctx, d, 'decoration');
  }
  // 7. Bullets: in the paragraph's direction, no spacing, the bullet's own font and colour.
  for (const b of plan.bullets) {
    state.text(b);
    state.fill(b.fill);
    painter.glyphs(ctx, b, 'bullet');
  }
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
  // Lines with their index in the layout (painters that place lines their own way read it).
  const lines = l.lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !hidden[line.para] && line.top + line.height >= lo && line.top <= hi);
  let lineMask: LineMaskPlan | null = null;
  const lm = o.style.lineMask;
  if (lm && (lm.fill || lm.gradient)) {
    const visibleLines = lines
      .map(({ line }) => line)
      .filter(
        (ln) =>
          ln.segs.some((seg) =>
            /[^\s\u200b-\u200d\ufeff]/.test(segText(o.text, seg.start, seg.end, 'none')),
          ) || !!ln.bullet,
      );
    if (visibleLines.length > 0) {
      const maxLineW = Math.max(...visibleLines.map((ln) => ln.w));
      const straps: LineMaskStrap[] = [];
      const hOff = lm.heightOffsetPx ?? 0;
      const vOff = lm.vOffsetPx ?? 0;
      const wOff = lm.widthOffsetPx ?? 0;
      const hShift = lm.hOffsetPx ?? 0;
      const maskStyle = lm.style ?? 'fullWidth';
      for (const ln of visibleLines) {
        const F = ln.segs.length
          ? Math.max(...ln.segs.map((s) => s.sizePx))
          : o.style.fontSizePx * l.fontScale;
        const h = Math.max(0, F * 1.2 + hOff);
        const y = ln.baseline - F * 0.9 - hOff / 2 + vOff;
        let w = 0;
        let x = 0;
        if (maskStyle === 'fullWidth') {
          w = Math.max(0, o.box.w + wOff);
          x = o.box.x - wOff / 2 + hShift;
        } else if (maskStyle === 'lineWidth') {
          w = Math.max(0, ln.w + wOff);
          x = ln.x - wOff / 2 + hShift;
        } else if (maskStyle === 'maxLineWidth') {
          w = Math.max(0, maxLineW + wOff);
          const baseX =
            o.style.align === 'left'
              ? o.box.x
              : o.style.align === 'right'
                ? o.box.x + o.box.w - maxLineW
                : o.box.x + (o.box.w - maxLineW) / 2;
          x = baseX - wOff / 2 + hShift;
        }
        straps.push({ x, y, w, h });
      }
      lineMask = {
        straps,
        ...(lm.fill ? { fill: css(lm.fill) } : {}),
        ...(lm.gradient ? { gradient: lm.gradient } : {}),
      };
    }
  }
  const plan: PaintPlan = {
    box: null,
    highlights: [],
    glyphs: [],
    decorations: [],
    bullets: [],
    glow: null,
    paint: style.paint ?? null,
    lineMask,
    lineMasks: lineMask?.straps ?? [],
  };
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
  for (const { line, index } of lines) {
    // The line's content without hanging whitespace: highlights and decorations stop at its edges.
    const left = line.x;
    const right = line.x + line.w;
    const marks = new Marks(index);
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
      const grad = plan.paint !== null && (s.run < 0 || o.runs?.[s.run]?.color === undefined);
      plan.glyphs.push({
        line: index,
        seg: i,
        ...(grad ? { grad: true as const } : {}),
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
    if (b?.text.trim()) {
      const st = styleOf(b.run ?? -1);
      const fill = css(b.color);
      plan.bullets.push({
        line: index,
        text: b.text,
        x: b.x,
        y: line.baseline,
        font: b.font,
        dir: b.dir ?? 'ltr',
        lang: b.lang ?? '',
        spacing: 0,
        fill,
        cast: st.outline ? css(st.outline.color) : fill,
        shadow: st.shadow,
        shadowColor: st.shadow ? css(st.shadow.color) : '',
        outline:
          st.outline && st.outline.width > 0
            ? { width: st.outline.width, color: css(st.outline.color) }
            : null,
      });
    }
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
  readonly #last = new Map<string, { rect: PlannedRect; seg: number }>();
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }

  add(
    out: PlannedRect[],
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
    const rect: PlannedRect = {
      line: this.line,
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
  readonly ctx: Ctx2D;
  constructor(ctx: Ctx2D) {
    this.ctx = ctx;
  }

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

  /** A gradient fill; the next `fill` assigns its colour again. */
  paint(style: CanvasGradient): void {
    this.ctx.fillStyle = style;
    this.#fill = '';
  }
}
