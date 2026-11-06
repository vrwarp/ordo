import type { TextObject, TextStyle } from '@ordo/domain';

import { CLAMP } from '../clamp.ts';
import { visualOrder } from './bidi.ts';
import { graphemeBoundaries } from './breaks.ts';
import { type FitScale, SCRIPT_SCALE, autofit, officeLine } from './office.ts';
import { segText } from './segments.ts';
import type {
  BulletSpec,
  FontEnv,
  LaidLine,
  Measurer,
  ParaStyle,
  Piece,
  PreparedPara,
  RichLayout,
  RunStyle,
  Seg,
} from './types.ts';

/*
 * Stages 6, 8 and 9: lines, alignment, anchor and insets (design/27 §6). Owner: lines-office (B).
 *
 * Greedy fill per paragraph. Available width = box - insets - marL (`indentPx`) - first-line indent; trailing
 * whitespace hangs; `wrap: false` never wraps and a line grows from its alignment. Then UAX#9 L2 reordering
 * between pieces (`visualOrder`). The 'ordo' line model reproduces `drawText`'s vertical metrics exactly:
 * pitch `lineHeight × F`, baseline `(pitch - F)/2 + 0.8 × F` below the line's top (text2d.ts), so turning on
 * a rich field never moves an existing box's lines vertically. 'office' uses `officeLine`.
 *
 * Scaffold: greedy fill with emergency breaks, left/centre/right alignment, both line models, space before
 * and after, valign anchor, `wrap: false`. To build: justify and distribute (`extraPerSpace`), right-to-left
 * paragraphs starting at the right, hanging bullets (the bullet box at least -indent wide), autofit with the
 * linear-width search (office.ts), and the 'ordo' meaning of `lineSpacing`/`lineSpacingPx`.
 */

/** The four insets: `style.insets`, else `padding` on every side. */
export function insetsOf(style: TextStyle): { l: number; t: number; r: number; b: number } {
  const p = style.padding;
  return style.insets ?? { l: p, t: p, r: p, b: p };
}

/** A run size under the autofit font scale, within the render bounds (4-1,000 px, design/27 §3.2). */
export function fitSize(sizePx: number, fontScale: number): number {
  return Math.min(CLAMP.maxFontPx, Math.max(CLAMP.minFontPx, sizePx * fontScale));
}

/** Line pitch and baseline depth in the 'ordo' model: `drawText`'s, with paragraph spacing on top. */
export function ordoLine(F: number, para: ParaStyle, lineHeight: number): { height: number; ascent: number } {
  const height = para.lineSpacingPx ?? lineHeight * F * (para.lineSpacing ?? 1);
  return { height, ascent: (height - F) / 2 + 0.8 * F };
}

/** A piece measured at the layout's size. */
type Measured = {
  piece: Piece;
  style: RunStyle;
  run: number;
  font: string;
  sizePx: number;
  shift: number;
  /** Advance of the drawn string. */
  w: number;
  /** Width without the trailing whitespace. */
  t: number;
  /** Advance to the next piece on the line: `w` + the run's letter spacing. */
  a: number;
};

type Flowed = { lines: LaidLine[]; height: number; widest: number };

const EPS = 1e-6;

/** Lay out prepared paragraphs in the object's box: absolute logical coordinates (§6). */
export function layoutBox(
  m: Measurer,
  o: TextObject,
  prepared: PreparedPara[],
  bullets: readonly (BulletSpec | null)[],
  env: FontEnv,
): RichLayout {
  const style = o.style;
  const box = o.box;
  const ins = insetsOf(style);
  const innerW = Math.max(1, box.w - ins.l - ins.r);
  const innerH = Math.max(1, box.h - ins.t - ins.b);
  const flow = (fit: FitScale) => flowParas(m, o, prepared, bullets, env, fit, innerW);
  const fit = autofit(style, (f) => flow(f).height, innerH);
  const laid = flow(fit);
  let y0 = box.y + ins.t;
  if (style.valign === 'middle') y0 += (innerH - laid.height) / 2;
  else if (style.valign === 'bottom') y0 += innerH - laid.height;
  const dx = box.x + ins.l;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const line of laid.lines) {
    line.top += y0;
    line.baseline += y0;
    line.x += dx;
    if (line.bullet) line.bullet.x += dx;
    for (const s of line.segs) s.x += dx;
    minX = Math.min(minX, line.x);
    maxX = Math.max(maxX, line.x + line.w);
  }
  const first = laid.lines[0];
  const last = laid.lines[laid.lines.length - 1];
  const ink =
    first && last
      ? { x: minX, y: first.top, w: maxX - minX, h: last.top + last.height - first.top, rotation: 0 }
      : { x: dx, y: y0, w: 0, h: 0, rotation: 0 };
  return {
    lines: laid.lines,
    fontScale: fit.font,
    spacingScale: fit.spacing,
    overflow: laid.height > innerH + 0.01 || laid.widest > innerW + 0.01,
    ink,
  };
}

/** Lines of every paragraph at one autofit scale, relative to the inner box's top-left corner. */
function flowParas(
  m: Measurer,
  o: TextObject,
  prepared: PreparedPara[],
  bullets: readonly (BulletSpec | null)[],
  env: FontEnv,
  fit: FitScale,
  innerW: number,
): Flowed {
  const text = o.text;
  const office = o.style.lineModel === 'office';
  const wrap = o.style.wrap !== false;
  const k = office ? fit.spacing : 1;
  const lines: LaidLine[] = [];
  let y = 0;
  let widest = 0;
  const measure = (piece: Piece, sr: { style: RunStyle; run: number }): Measured => {
    const st = sr.style;
    const size = fitSize(st.sizePx, fit.font);
    const sizePx = st.baseline ? size * SCRIPT_SCALE : size;
    const font = env.font({
      family: st.family,
      fallbacks: st.fallbacks,
      weight: st.weight,
      italic: st.italic,
      smallCaps: st.caps === 'small',
      sizePx,
      script: piece.script,
    });
    const dir = piece.level % 2 ? 'rtl' : 'ltr';
    const ls = st.letterSpacing;
    const w = m.width(font, dir, st.lang, ls, segText(text, piece.start, piece.end, st.caps));
    const t =
      piece.trail === piece.end
        ? w
        : piece.trail === piece.start
          ? 0
          : m.width(font, dir, st.lang, ls, segText(text, piece.start, piece.trail, st.caps));
    return { piece, style: st, run: sr.run, font, sizePx, shift: -st.baseline * size, w, t, a: w + ls };
  };

  prepared.forEach((pp, pi) => {
    const para = pp.para;
    const ps = para.style;
    const main = para.runs.find((r) => !r.style.baseline) ?? para.runs[0]!;
    const F = fitSize(main.style.sizePx, fit.font);
    const metrics = office ? officeLine(F, ps, k) : ordoLine(F, ps, o.style.lineHeight);
    if (pi > 0 && !para.soft) y += (prepared[pi - 1]!.para.style.spaceAfterPx + ps.spaceBeforePx) * k;
    const queue = pp.pieces.map((p) => measure(p, para.runs[p.sr]!));
    const bullet = !para.soft && queue.length ? bullets[para.index] : null;
    let bulletLine: LaidLine['bullet'];
    let bulletW = 0;
    if (bullet) {
      const sizePx = F * bullet.sizePct;
      const { family, fallbacks, weight, italic } = bullet;
      const font = env.font({ family, fallbacks, weight, italic, smallCaps: false, sizePx, script: '' });
      bulletW = m.width(font, 'ltr', '', 0, bullet.text);
      bulletLine = { text: bullet.text, x: 0, font, sizePx, color: bullet.color };
    }
    const firstX = ps.indentPx + (para.soft ? 0 : ps.firstLinePx);
    let cur: Measured[] = [];
    let adv = 0;
    let n = 0; // lines of this paragraph so far
    const startX = () => (n === 0 ? firstX + bulletW : ps.indentPx);
    const avail = () => Math.max(1, innerW - startX());
    const flush = () => {
      const lineW = cur.length ? adv - cur[cur.length - 1]!.a + cur[cur.length - 1]!.t : 0;
      const room = avail() - lineW;
      const off = ps.align === 'center' ? room / 2 : ps.align === 'right' ? room : 0;
      const x = startX() + off;
      const order = visualOrder(cur.map((c) => c.piece.level));
      const segs: Seg[] = [];
      let sx = x;
      for (const i of order) {
        const c = cur[i]!;
        segs.push({
          start: c.piece.start,
          end: c.piece.end,
          x: sx,
          w: c.w,
          run: c.run,
          level: c.piece.level,
          font: c.font,
          sizePx: c.sizePx,
          shift: c.shift,
        });
        sx += c.a;
      }
      const line: LaidLine = {
        para: para.index,
        top: y,
        baseline: y + metrics.ascent,
        height: metrics.height,
        x,
        w: lineW,
        segs,
        extraPerSpace: 0,
      };
      if (n === 0 && bulletLine) line.bullet = { ...bulletLine, x: x - bulletW };
      lines.push(line);
      widest = Math.max(widest, startX() + lineW);
      y += metrics.height;
      n++;
      cur = [];
      adv = 0;
    };
    const push = (c: Measured) => {
      cur.push(c);
      adv += c.a;
    };
    let i = 0;
    while (i < queue.length) {
      let j = i;
      while (j < queue.length - 1 && !queue[j]!.piece.breakAfter) j++;
      let word = 0;
      for (let q = i; q < j; q++) word += queue[q]!.a;
      const wordW = word + queue[j]!.t;
      if (!wrap || adv + wordW <= avail() + EPS) {
        for (let q = i; q <= j; q++) push(queue[q]!);
        i = j + 1;
        continue;
      }
      if (cur.length) {
        flush();
        continue;
      }
      // The word alone is wider than the line: whole pieces while they fit, then an emergency break.
      let q = i;
      while (q <= j && adv + queue[q]!.t <= avail() + EPS) push(queue[q++]!);
      if (q <= j) {
        const split = splitPiece(queue[q]!, avail() - adv, cur.length === 0);
        if (split) {
          push(measure(split[0], queue[q]!));
          queue[q] = measure(split[1], queue[q]!);
        } else if (!cur.length) push(queue[q++]!); // one grapheme wider than the line: it overflows
      }
      flush();
      i = q;
    }
    if (cur.length || n === 0) flush();
  });

  function splitPiece(c: Measured, room: number, force: boolean): [Piece, Piece] | null {
    const p = c.piece;
    const cuts = graphemeBoundaries(text, p.start, p.end);
    const dir = p.level % 2 ? 'rtl' : 'ltr';
    const width = (end: number) =>
      m.width(c.font, dir, c.style.lang, c.style.letterSpacing, segText(text, p.start, end, c.style.caps));
    let lo = 0;
    let hi = cuts.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (width(cuts[mid]!) <= room + EPS) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0 && !force) return null;
    const at = cuts[Math.max(0, best)];
    if (at === undefined) return null;
    return [
      { ...p, end: at, trail: at, breakAfter: false },
      { ...p, start: at, trail: Math.max(at, p.trail) },
    ];
  }

  return { lines, height: y, widest };
}
