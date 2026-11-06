import { LOGICAL_HEIGHT, type TextObject, rgbaCss } from '@ordo/domain';

import { CLAMP, num } from '../clamp.ts';
import { type Ctx2D, roundRect, setLang, setLetterSpacing, withRotation } from '../ctx.ts';
import { resolveRunStyle } from './itemize.ts';
import { insetsOf } from './lines.ts';
import { segText } from './segments.ts';
import type { FontEnv, LaidLine, RichLayout, RunStyle, Seg } from './types.ts';

/*
 * Paint passes (design/27 §6 "Paint passes"). Owner: paint-dispatch (D).
 *
 * Under `ctx.scale(scale)` (composed with the caller's transform: thumbnails translate, the editor draws
 * at devicePixelRatio), each segment is drawn at its reference x with `textAlign 'left'`, its own font,
 * direction, language and letter spacing, so line breaks and positions never depend on the device size.
 * Canvas shadows ignore the transform, so shadow offsets and blur are multiplied by `scale` (as drawText).
 * Order, as today: 1 text fill box and highlight; 2 shadows (run shadow, else box shadow); 3 glow
 * (`shadowBlur` with zero offset); 4 outline (`strokeText` at 2× width, round joins); 5 fill; 6 underline
 * and strike (thickness F/18, underline at baseline + 0.1F); 7 bullets. Hidden paragraphs are laid out,
 * never painted.
 *
 * Scaffold: passes 1 (fill box), 2, 4, 5 and 7. To build: highlight, glow, underline and strike, the M6
 * gradient over the box, caches.
 */

/** Paint a layout of `o` (made by `layoutRich` for the same object) at `scale` device px per logical px. */
export function paintRich(ctx: Ctx2D, o: TextObject, l: RichLayout, scale: number, _env: FontEnv): void {
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
  // Lines far outside the clamp region are never visible (drawText culls them the same way).
  const lo = -CLAMP.boxFactor * LOGICAL_HEIGHT;
  const hi = CLAMP.boxFactor * LOGICAL_HEIGHT;
  const lines = l.lines.filter(
    (line) => !o.paras?.[line.para]?.hidden && line.top + line.height >= lo && line.top <= hi,
  );
  const eachSeg = (fn: (s: Seg, line: LaidLine, st: RunStyle, text: string) => void) => {
    for (const line of lines)
      for (const s of line.segs) {
        const st = styleOf(s.run);
        const text = segText(o.text, s.start, s.end, st.caps);
        if (!text.trim()) continue;
        ctx.font = s.font;
        ctx.direction = s.level % 2 ? 'rtl' : 'ltr';
        setLang(ctx, st.lang);
        setLetterSpacing(ctx, st.letterSpacing);
        fn(s, line, st, text);
      }
  };
  ctx.save();
  ctx.globalAlpha = num(o.opacity, 0, 1, 1);
  ctx.scale(scale, scale);
  withRotation(ctx, o.box, 1, () => {
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    if (style.fill && o.text.trim()) {
      const ins = insetsOf(style);
      const ink = l.ink;
      ctx.fillStyle = rgbaCss(style.fill.color);
      roundRect(
        ctx,
        ink.x - ins.l,
        ink.y - ins.t,
        ink.w + ins.l + ins.r,
        ink.h + ins.t + ins.b,
        style.fill.radius,
      );
      ctx.fill();
    }
    eachSeg((s, line, st, text) => {
      if (!st.shadow) return;
      ctx.save();
      ctx.shadowColor = rgbaCss(st.shadow.color);
      ctx.shadowBlur = st.shadow.blur * scale;
      ctx.shadowOffsetX = st.shadow.dx * scale;
      ctx.shadowOffsetY = st.shadow.dy * scale;
      ctx.fillStyle = rgbaCss(st.outline?.color ?? st.color);
      ctx.fillText(text, s.x, line.baseline + s.shift);
      ctx.restore();
    });
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    eachSeg((s, line, st, text) => {
      if (!st.outline || st.outline.width <= 0) return;
      ctx.lineWidth = st.outline.width * 2;
      ctx.strokeStyle = rgbaCss(st.outline.color);
      ctx.strokeText(text, s.x, line.baseline + s.shift);
    });
    eachSeg((s, line, st, text) => {
      ctx.fillStyle = rgbaCss(st.color);
      ctx.fillText(text, s.x, line.baseline + s.shift);
    });
    ctx.direction = 'ltr';
    setLetterSpacing(ctx, 0);
    for (const line of lines) {
      const b = line.bullet;
      if (!b) continue;
      ctx.font = b.font;
      ctx.fillStyle = rgbaCss(b.color);
      ctx.fillText(b.text, b.x, line.baseline);
    }
  });
  ctx.restore();
}
