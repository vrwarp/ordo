import type { TextObject, TextStyle } from '@ordo/domain';

import { CLAMP } from '../clamp.ts';
import { visualOrder } from './bidi.ts';
import { graphemeBoundaries } from './breaks.ts';
import { linearWidth, memoMeasurer, scaleWidth, spacingGaps } from './measure.ts';
import {
  FIT_SPACINGS,
  type FitScale,
  OFFICE_SINGLE,
  SCRIPT_SCALE,
  autofit,
  fitFactor,
  officeFontPx,
  officeLine,
} from './office.ts';
import { segText } from './segments.ts';
import type {
  BulletSpec,
  FaceRequest,
  FontEnv,
  LaidLine,
  Measurer,
  ParaStyle,
  Piece,
  PreparedPara,
  RichLayout,
  RunStyle,
  Seg,
  StyleRun,
} from './types.ts';

/*
 * Stages 6, 8, 9 and 10: lines, alignment, anchor, insets and autofit (design/27 §6). Owner:
 * lines-office (B). Everything here is in logical px: no output scale ever reaches it.
 *
 * Lines (per paragraph, greedy):
 * - The first line starts at `indentPx + firstLinePx` (marL + indent), the others at `indentPx`, both at
 *   least 0; a soft paragraph (a:br) is a continuation, so its first line starts at `indentPx`. A bullet
 *   sits at the first line's start in a box at least -indent wide (a hanging bullet), and the text follows
 *   the box. Available width = inner width - that start.
 * - Pieces fill a line while they fit; a word (pieces with no break between them) that does not fit goes to
 *   the next line; one wider than a whole line is cut between graphemes (an emergency break). Trailing
 *   whitespace hangs: it never counts against the width.
 * - `wrap: false` never breaks a line.
 * - Right-to-left paragraphs (bidi level 1) mirror the start: indents and the bullet are on the right, the
 *   pieces run from the right (UAX#9 L2 between pieces, `visualOrder`), and the hanging whitespace is on
 *   the visual left. `align` stays visual: left is left in either direction.
 *
 * Alignment: left, centre and right place the line in its available width (a line wider than it grows from
 * its alignment: left rightwards, right leftwards, centre both ways). `justify` spreads the free width over
 * the trailing whitespace of every piece but the last (`extraPerSpace` per whitespace unit) on all lines
 * but a paragraph's last, which starts at the paragraph's start edge (right for RTL); `distribute` spreads
 * the last line too. A line without inter-piece spaces is not spread. No kashida.
 *
 * Line models (F = the line's main size after autofit: the paragraph's main run, its first without a
 * baseline shift, else its first, else its end mark; a larger unshifted run on the line raises it, as
 * LibreOffice sizes each line by its own portions, so lines never overlap):
 * - 'ordo': drawText's vertical model, pitch `lineHeight × F` with the baseline `(pitch - F)/2 + 0.8F`
 *   below the line's top (text2d.ts). A paragraph's `lineSpacing` p is a multiple of single spacing,
 *   pitch `p × 1.2F` (the same meaning as in the office model), `lineSpacingPx` the exact pitch.
 * - 'office': `officeLine` (office.ts), with the box's `lineHeight` / 1.2 as the proportion of paragraphs
 *   that set none.
 * Raised and lowered runs are drawn at 0.58 × their size, shifted by baseline × size, and never grow the
 * line. Space before and after a paragraph are not drawn before the first or after the last; in the office
 * model they are scaled by the autofit spacing scale k, as are proportional and exact spacing.
 *
 * Soft paragraphs continue the paragraph before them: no bullet, no space between them, and that
 * paragraph's style (alignment, indents, spacing, line spacing, main size and direction). A trailing a:br
 * (an empty soft paragraph) makes a line as tall as the paragraph's, or its end mark's when larger.
 *
 * Anchor and insets: `valign` places the laid-out text in the box less its insets (`style.insets`, else
 * `padding` on every side); text taller than that overflows equally (middle), downwards (top) or upwards
 * (bottom).
 *
 * Autofit (`autofit` in office.ts): laid out once at the stored `fitScale` (else full size) with measured
 * widths; when that does not fit, LibreOffice's search lays the text out with widths scaled linearly from
 * that layout, and only the scale it finds is laid out again with measured widths. Run sizes are rounded to
 * whole points in the office model (`officeFontPx`), scaled exactly in the 'ordo' one.
 */

/** The four insets: `style.insets`, else `padding` on every side. */
export function insetsOf(style: TextStyle): { l: number; t: number; r: number; b: number } {
  const p = style.padding;
  return style.insets ?? { l: p, t: p, r: p, b: p };
}

/**
 * A run size under the autofit font scale, within the render bounds (4-1,000 px, design/27 §3.2): scaled
 * exactly, or rounded to whole points as LibreOffice does in the office model.
 */
export function fitSize(sizePx: number, fontScale: number, office = false): number {
  const s = office ? officeFontPx(sizePx, fontScale) : sizePx * fontScale;
  return Math.min(CLAMP.maxFontPx, Math.max(CLAMP.minFontPx, s));
}

/**
 * Line pitch and baseline depth in the 'ordo' model: `drawText`'s (`lineHeight × F`, baseline
 * `(pitch - F)/2 + 0.8F`), or the paragraph's own spacing: `lineSpacing` × single (1.2F), `lineSpacingPx`
 * exact.
 */
export function ordoLine(F: number, para: ParaStyle, lineHeight: number): { height: number; ascent: number } {
  const p = para.lineSpacing;
  const height = para.lineSpacingPx ?? (p !== null && p > 0 ? p * OFFICE_SINGLE * F : lineHeight * F);
  return { height, ascent: (height - F) / 2 + 0.8 * F };
}

/** A piece measured at the layout's size. */
type Measured = {
  piece: Piece;
  style: RunStyle;
  run: number;
  font: string;
  /** The run's size after autofit, before the 0.58 of a raised or lowered run (what F compares). */
  size: number;
  /** Drawn size. */
  sizePx: number;
  shift: number;
  /** Advance of the drawn string. */
  w: number;
  /** Width without the trailing whitespace. */
  t: number;
  /** Advance to the next piece on the line: `w` + the run's letter spacing. */
  a: number;
  /** Trailing whitespace units: where justification adds space. */
  spaces: number;
};

/** A piece's widths at the autofit search's reference scale: the linear widths are scaled from them. */
type BaseWidths = WeakMap<Piece, { w: number; t: number; refPx: number; sw: number; st: number }>;

type Flowed = {
  /** Lines relative to the inner box's top-left corner. */
  lines: LaidLine[];
  /** Width of each line's bullet text (0 without one), for the ink box. */
  bulletW: number[];
  height: number;
};

/** What a soft paragraph takes from the paragraph it continues. */
type Continued = { style: ParaStyle; F: number; rtl: boolean };

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
  // One layout measures each string once, whatever the shared cache evicts during the autofit search.
  const mm = memoMeasurer(m);
  const bases: BaseWidths = new WeakMap();
  let exact: { fit: FitScale; flowed: Flowed } | null = null;
  const flowExact = (fit: FitScale): Flowed => {
    if (exact && exact.fit.font === fit.font && exact.fit.spacing === fit.spacing) return exact.flowed;
    const flowed = flowParas(mm, o, prepared, bullets, env, innerW, fit);
    exact = { fit, flowed };
    return flowed;
  };
  const fit = autofit(
    style,
    innerH,
    (f) => flowExact(f).height,
    (f, ref) => flowParas(mm, o, prepared, bullets, env, innerW, f, { ref, bases }).height,
    style.lineModel === 'office' ? FIT_SPACINGS : FIT_SPACINGS.slice(0, 1),
  );
  const laid = flowExact(fit);
  let y0 = box.y + ins.t;
  if (style.valign === 'middle') y0 += (innerH - laid.height) / 2;
  else if (style.valign === 'bottom') y0 += innerH - laid.height;
  const dx = box.x + ins.l;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  laid.lines.forEach((line, i) => {
    line.top += y0;
    line.baseline += y0;
    line.x += dx;
    for (const s of line.segs) s.x += dx;
    minX = Math.min(minX, line.x);
    maxX = Math.max(maxX, line.x + line.w);
    if (line.bullet) {
      line.bullet.x += dx;
      minX = Math.min(minX, line.bullet.x);
      maxX = Math.max(maxX, line.bullet.x + laid.bulletW[i]!);
    }
  });
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
    overflow:
      fitFactor(laid.height, innerH) < 1 ||
      (first !== undefined && (minX < dx - 0.01 || maxX > dx + innerW + 0.01)),
    ink,
  };
}

/**
 * Lines of every paragraph at one autofit scale, relative to the inner box's top-left corner. With
 * `linear`, widths are not measured at `fit` but scaled linearly from their measure at `linear.ref` (the
 * autofit search: only heights are used, and segments carry no font string).
 */
function flowParas(
  m: Measurer,
  o: TextObject,
  prepared: PreparedPara[],
  bullets: readonly (BulletSpec | null)[],
  env: FontEnv,
  innerW: number,
  fit: FitScale,
  linear?: { ref: FitScale; bases: BaseWidths },
): Flowed {
  const text = o.text;
  const style = o.style;
  const office = style.lineModel === 'office';
  const wrap = style.wrap !== false;
  const k = office ? fit.spacing : 1;
  // The spacing scale never changes a width: only a different font scale needs the linear estimate.
  const base = linear && linear.ref.font !== fit.font ? linear.ref : null;
  const size = (px: number, f: FitScale) => fitSize(px, f.font, office);
  const face = (st: RunStyle, script: string, sizePx: number): FaceRequest => ({
    family: st.family,
    fallbacks: st.fallbacks,
    weight: st.weight,
    italic: st.italic,
    smallCaps: st.caps === 'small',
    sizePx,
    script,
  });
  /** Width of `s` drawn in run style `st`, measured at the scale `f`. */
  const measureAt = (st: RunStyle, script: string, dir: 'ltr' | 'rtl', s: string, f: FitScale): number => {
    const px = size(st.sizePx, f) * (st.baseline ? SCRIPT_SCALE : 1);
    return m.width(env.font(face(st, script, px)), dir, st.lang, st.letterSpacing, s);
  };
  /** Width of `s` drawn in run style `st` at the layout's size: measured, or scaled from `base`. */
  const widthOf = (st: RunStyle, script: string, dir: 'ltr' | 'rtl', s: string): number => {
    if (!base) return measureAt(st, script, dir, s, fit);
    const q = st.baseline ? SCRIPT_SCALE : 1;
    const w = measureAt(st, script, dir, s, base);
    return linearWidth(w, size(st.sizePx, base) * q, size(st.sizePx, fit) * q, st.letterSpacing, s);
  };
  /** A piece's drawn string and its width without the trailing whitespace, measured at `f`. */
  const pieceWidths = (piece: Piece, st: RunStyle, f: FitScale): { w: number; t: number } => {
    const dir = piece.level % 2 ? 'rtl' : 'ltr';
    const w = measureAt(st, piece.script, dir, segText(text, piece.start, piece.end, st.caps), f);
    const t =
      piece.trail >= piece.end
        ? w
        : piece.trail <= piece.start
          ? 0
          : measureAt(st, piece.script, dir, segText(text, piece.start, piece.trail, st.caps), f);
    return { w, t };
  };
  const measure = (piece: Piece, sr: StyleRun): Measured => {
    const st = sr.style;
    const sz = size(st.sizePx, fit);
    const sizePx = st.baseline ? sz * SCRIPT_SCALE : sz;
    let w: number;
    let t: number;
    if (base && linear) {
      // The search lays out the same pieces up to 30 times: their reference widths are kept per piece.
      let b = linear.bases.get(piece);
      if (!b) {
        const gaps = (e: number) =>
          st.letterSpacing ? st.letterSpacing * spacingGaps(segText(text, piece.start, e, st.caps)) : 0;
        const refPx = size(st.sizePx, base) * (st.baseline ? SCRIPT_SCALE : 1);
        b = { ...pieceWidths(piece, st, base), refPx, sw: gaps(piece.end), st: gaps(piece.trail) };
        linear.bases.set(piece, b);
      }
      w = scaleWidth(b.w, b.refPx, sizePx, b.sw);
      t = scaleWidth(b.t, b.refPx, sizePx, b.st);
    } else ({ w, t } = pieceWidths(piece, st, fit));
    return {
      piece,
      style: st,
      run: sr.run,
      font: base ? '' : env.font(face(st, piece.script, sizePx)),
      size: sz,
      sizePx,
      shift: -st.baseline * sz,
      w,
      t,
      a: w + st.letterSpacing,
      spaces: Math.max(0, piece.end - Math.max(piece.start, piece.trail)),
    };
  };

  const lines: LaidLine[] = [];
  const bulletWs: number[] = [];
  let y = 0;
  // The paragraph a soft paragraph continues: its style, main size and direction.
  let hard: Continued | null = null;
  // Whether a paragraph or the soft paragraphs continuing it have text: its bullet is drawn on its first
  // line even when that line is empty and the text follows a line break (domain paraLabels counts it).
  const chainText: boolean[] = new Array(prepared.length).fill(false);
  for (let i = prepared.length - 1; i >= 0; i--)
    chainText[i] =
      prepared[i]!.pieces.length > 0 ||
      (i + 1 < prepared.length && prepared[i + 1]!.para.soft && chainText[i + 1]!);

  for (const [pi, pp] of prepared.entries()) {
    const para = pp.para;
    const runs = para.runs;
    const main = runs.find((r) => !r.style.baseline) ?? runs[0];
    const ownF = size(main ? main.style.sizePx : style.fontSizePx, fit);
    const prev = hard as Continued | null;
    const cont = para.soft ? prev : null;
    const ps = cont ? cont.style : para.style;
    const F = cont ? cont.F : ownF;
    const rtl = cont ? cont.rtl : pp.bidi.level === 1;
    if (prev && !cont) y += (prev.style.spaceAfterPx + ps.spaceBeforePx) * k;
    if (!cont) hard = { style: ps, F, rtl };

    const queue = pp.pieces.map((p) => measure(p, runs[p.sr]!));
    const spec = !para.soft && chainText[pi] ? (bullets[para.index] ?? null) : null;
    const other = Math.max(0, ps.indentPx);
    const x0 = para.soft ? other : Math.max(0, ps.indentPx + ps.firstLinePx);
    let bullet: LaidLine['bullet'];
    let bulletW = 0;
    let bulletBox = 0;
    if (spec) {
      const bpx = F * spec.sizePct;
      const req: FaceRequest = {
        family: spec.family,
        fallbacks: spec.fallbacks,
        weight: spec.weight,
        italic: spec.italic,
        smallCaps: false,
        sizePx: bpx,
        script: '',
      };
      const font = env.font(req);
      if (base && main) {
        const rpx = size(main.style.sizePx, base) * spec.sizePct;
        const w = m.width(env.font({ ...req, sizePx: rpx }), 'ltr', '', 0, spec.text);
        bulletW = linearWidth(w, rpx, bpx, 0, spec.text);
      } else bulletW = m.width(font, 'ltr', '', 0, spec.text);
      bulletBox = Math.max(bulletW, other - x0);
      bullet = { text: spec.text, x: 0, font, sizePx: bpx, color: spec.color };
    }
    const startX = (n: number) => (n === 0 ? x0 + bulletBox : other);
    const avail = (n: number) => Math.max(1, innerW - startX(n));

    // Breaking: which pieces go on which line.
    const broken: Measured[][] = [];
    let cur: Measured[] = [];
    let adv = 0;
    const push = (c: Measured) => {
      cur.push(c);
      adv += c.a;
    };
    const endLine = () => {
      broken.push(cur);
      cur = [];
      adv = 0;
    };
    const splitPiece = (c: Measured, room: number, force: boolean): [Piece, Piece] | null => {
      const p = c.piece;
      const cuts = graphemeBoundaries(text, p.start, p.end);
      const dir = p.level % 2 ? 'rtl' : 'ltr';
      const width = (end: number) =>
        widthOf(c.style, p.script, dir, segText(text, p.start, end, c.style.caps));
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
        { ...p, end: at, trail: Math.min(at, Math.max(p.start, p.trail)), breakAfter: false },
        { ...p, start: at, trail: Math.max(at, p.trail) },
      ];
    };
    let i = 0;
    while (i < queue.length) {
      const room = avail(broken.length);
      let j = i;
      while (j < queue.length - 1 && !queue[j]!.piece.breakAfter) j++;
      let word = queue[j]!.t;
      for (let q = i; q < j; q++) word += queue[q]!.a;
      if (!wrap || adv + word <= room + EPS) {
        for (let q = i; q <= j; q++) push(queue[q]!);
        i = j + 1;
        continue;
      }
      if (cur.length) {
        endLine();
        continue;
      }
      // The word alone is wider than the line: whole pieces while they fit, then an emergency break.
      let q = i;
      while (q <= j && adv + queue[q]!.t <= room + EPS) push(queue[q++]!);
      if (q <= j) {
        const c = queue[q]!;
        const split = splitPiece(c, room - adv, cur.length === 0);
        const sr = runs[c.piece.sr]!;
        if (split) {
          push(measure(split[0], sr));
          queue[q] = measure(split[1], sr);
        } else if (!cur.length) push(queue[q++]!); // one grapheme wider than the line: it overflows
      }
      endLine();
      i = q;
    }
    if (cur.length || !broken.length) endLine();

    // Placing: alignment, visual order, line metrics.
    broken.forEach((items, n) => {
      const lineStart = startX(n);
      const A = innerW - lineStart;
      const L = rtl ? 0 : lineStart;
      const tail = items[items.length - 1];
      let lineW = 0;
      for (const c of items) lineW += c.a;
      if (tail) lineW += tail.t - tail.a;
      let spaces = 0;
      for (let q = 0; q < items.length - 1; q++) spaces += items[q]!.spaces;
      const last = n === broken.length - 1;
      const spread = ps.align === 'distribute' || (ps.align === 'justify' && !last);
      const extra = spread && spaces > 0 && A > lineW ? (A - lineW) / spaces : 0;
      const contentW = lineW + extra * spaces;
      const align = ps.align === 'justify' || ps.align === 'distribute' ? (rtl ? 'right' : 'left') : ps.align;
      const x = align === 'center' ? L + (A - contentW) / 2 : align === 'right' ? L + A - contentW : L;
      const segs: Seg[] = [];
      let sx = x;
      for (const q of visualOrder(items.map((c) => c.piece.level))) {
        const c = items[q]!;
        const odd = c.piece.level % 2 === 1;
        const isTail = q === items.length - 1;
        const gap = isTail ? 0 : extra * c.spaces;
        // A right-to-left piece draws its trailing whitespace at its left end: the extra space goes there,
        // and the hanging whitespace of the line's last piece hangs out on the left.
        if (odd) sx += gap;
        segs.push({
          start: c.piece.start,
          end: c.piece.end,
          x: isTail && odd ? sx - (c.w - c.t) : sx,
          w: c.w,
          run: c.run,
          level: c.piece.level,
          font: c.font,
          sizePx: c.sizePx,
          shift: c.shift,
        });
        sx += isTail ? c.t : c.a;
        if (!odd) sx += gap;
      }
      let lineF = F;
      for (const c of items) if (!c.style.baseline && c.size > lineF) lineF = c.size;
      if (!items.length)
        for (const r of runs) if (!r.style.baseline) lineF = Math.max(lineF, size(r.style.sizePx, fit));
      const metrics = office
        ? officeLine(lineF, ps, k, style.lineHeight)
        : ordoLine(lineF, ps, style.lineHeight);
      const line: LaidLine = {
        para: para.index,
        top: y,
        baseline: y + metrics.ascent,
        height: metrics.height,
        x,
        w: contentW,
        segs,
        extraPerSpace: extra,
      };
      let bw = 0;
      if (n === 0 && bullet) {
        line.bullet = { ...bullet, x: rtl ? x + contentW + bulletBox - bulletW : x - bulletBox };
        bw = bulletW;
      }
      lines.push(line);
      bulletWs.push(bw);
      y += metrics.height;
    });
  }

  return { lines, bulletW: bulletWs, height: y };
}
