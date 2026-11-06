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
 *   the next line; one wider than a whole line is cut between clusters (an emergency break). Trailing
 *   whitespace never counts against the width. At a wrap it hangs, outside the alignment too; at the end of
 *   a paragraph or before an a:br it is text and is aligned with the rest, as LibreOffice and PowerPoint
 *   align it (centred "Amen " sits half a space left of centred "Amen").
 * - An emergency break costs work in proportion to the line it fills, never to the rest of the word: the cut
 *   is found by galloping from the piece's start (prefixes of 1, 2, 4, ... clusters, then a bisection of the
 *   last window), cluster boundaries are found only as far as that reaches, and the rest of the piece is
 *   carried unmeasured (`Measured.lazy`, its width estimated) until it may fit a line. So a 10,000-letter
 *   word in a narrow box costs about as much as the lines it makes, in every drawer and in every step of
 *   the autofit search. The cut search measures a cut in the trailing whitespace without it, so that
 *   whitespace hangs on the word's last line as on any other and is never cut off onto the next one.
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
 * Raised and lowered runs are drawn at 0.58 × their size (at least 4 px), shifted by baseline × size, and
 * never grow the line. A bullet is drawn at `sizePct` × F within 4-1,000 px, in the paragraph's direction
 * and its first run's language (an Arabic or Hebrew number reads as its paragraph does: '.1' for '1.'). Space before and after a paragraph are not drawn before the first or after the last; in the office
 * model they are scaled by the autofit spacing scale k, as are proportional and exact spacing.
 *
 * Soft paragraphs continue the paragraph before them: no bullet, no space between them, and that
 * paragraph's style (alignment, indents, spacing, line spacing, main size and direction). A trailing a:br
 * (an empty soft paragraph that no soft paragraph follows) makes a line as tall as its own end mark (the
 * run covering its '\n', or for the last paragraph the '\n' before it), not the paragraph's main size, and
 * in the office model at single spacing: the paragraph's proportional spacing does not apply to it (so
 * neither does the spacing scale k, which leaves single spacing alone), its exact spacing does, as on any
 * line. An empty line between two a:br and an empty paragraph keep the paragraph's spacing. LibreOffice
 * 24.2, measured: at 90 % a 40 pt trailing line is 96 px high, not 86.4.
 *
 * Anchor and insets: `valign` places the laid-out text in the box less its insets (`style.insets`, else
 * `padding` on every side); text taller than that overflows equally (middle), downwards (top) or upwards
 * (bottom).
 *
 * Autofit (`autofit` in office.ts): laid out once at the stored `fitScale` (else full size) with measured
 * widths; when that does not fit, LibreOffice's search lays the text out with widths scaled linearly from
 * that layout, and only the scale it finds is laid out again with measured widths. Run sizes are rounded to
 * whole points in the office model (`officeFontPx`), scaled exactly in the 'ordo' one, and stay within
 * 2-1,000 px (`fitSize`): a 1 pt run, PowerPoint's smallest, keeps its size and its 2.4 px line.
 */

/** The four insets: `style.insets`, else `padding` on every side. */
export function insetsOf(style: TextStyle): { l: number; t: number; r: number; b: number } {
  const p = style.padding;
  return style.insets ?? { l: p, t: p, r: p, b: p };
}

/**
 * A run size under the autofit font scale, within the render bounds of runs (2-1,000 px, design/27 §3.2):
 * scaled exactly, or rounded to whole points as LibreOffice does in the office model (never below 1 pt).
 */
export function fitSize(sizePx: number, fontScale: number, office = false): number {
  const s = office ? officeFontPx(sizePx, fontScale) : sizePx * fontScale;
  return Math.min(CLAMP.maxFontPx, Math.max(CLAMP.minRunFontPx, s));
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
  /**
   * The rest of an emergency break, not measured yet: `w`, `t` and `a` are estimates (the cut piece's width
   * less the part on the line). It is measured once it may fit a line, and never placed unmeasured.
   */
  lazy?: boolean;
  /**
   * The cluster boundaries of the piece this one was cut from, from index `base` on (the boundaries inside
   * this piece): every line of an emergency break reads the same list instead of finding them again.
   */
  cuts?: { list: ClusterCuts; base: number };
};

/** The drawn size of a run `sz` px after autofit: 0.58 × for a raised or lowered run, at least 4 px. */
function drawnPx(sz: number, baseline: number): number {
  return baseline ? Math.max(CLAMP.minFontPx, sz * SCRIPT_SCALE) : sz;
}

/** A bullet's size: `sizePct` × the paragraph's main size, within the render bounds (4-1,000 px). */
function bulletPx(F: number, sizePct: number): number {
  return Math.min(CLAMP.maxFontPx, Math.max(CLAMP.minFontPx, F * sizePct));
}

/** Units of a cluster window: boundaries are found this far at least, then twice as far each time. */
const CLUSTER_WINDOW = 32;

/**
 * Cluster boundaries inside [start, end) (breaks.ts `graphemeBoundaries`), found only as far as they are
 * asked for, in windows that double from the last boundary found (so finding all of them is linear in the
 * piece). A boundary at a window's end is not trusted until the next window (a mark or a joiner may
 * follow), and no window ends inside a surrogate pair. Boundaries never depend on the font size: one list
 * serves every line and every autofit step of a piece.
 */
class ClusterCuts {
  readonly #cuts: number[] = [];
  #scanned: number;
  constructor(
    readonly text: string,
    readonly start: number,
    readonly end: number,
  ) {
    this.#scanned = start;
  }

  /** The k-th boundary, or undefined when there are no more than k (then `count` is exact). */
  at(k: number): number | undefined {
    const cuts = this.#cuts;
    while (cuts.length <= k && this.#scanned < this.end) {
      const from = cuts.length ? cuts[cuts.length - 1]! : this.start;
      const s = this.#scanned;
      let to = Math.min(this.end, s + Math.max(CLUSTER_WINDOW, s - this.start));
      const c = this.text.charCodeAt(to - 1);
      if (to < this.end && c >= 0xd800 && c <= 0xdbff) to++;
      for (const b of graphemeBoundaries(this.text, from, to)) cuts.push(b);
      this.#scanned = to;
    }
    return cuts[k];
  }

  /** Boundaries found so far. */
  get count(): number {
    return this.#cuts.length;
  }
}

/** A piece's widths at the autofit search's reference scale: the linear widths are scaled from them. */
type BaseWidths = WeakMap<Piece, { w: number; t: number; refPx: number; sw: number; st: number }>;

/** What one layout keeps across its autofit steps: reference widths and cluster boundaries per piece. */
type Shared = { bases: BaseWidths; clusters: WeakMap<Piece, ClusterCuts> };

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

/**
 * Lay out prepared paragraphs in the object's box: absolute logical coordinates (§6). Autofit never goes
 * below `minFontScale` (look bands: 0.5, as drawText's).
 */
export function layoutBox(
  m: Measurer,
  o: TextObject,
  prepared: PreparedPara[],
  bullets: readonly (BulletSpec | null)[],
  env: FontEnv,
  minFontScale?: number,
): RichLayout {
  const style = o.style;
  const box = o.box;
  const ins = insetsOf(style);
  const innerW = Math.max(1, box.w - ins.l - ins.r);
  const innerH = Math.max(1, box.h - ins.t - ins.b);
  // One layout measures each string once, whatever the shared cache evicts during the autofit search.
  const mm = memoMeasurer(m);
  const shared: Shared = { bases: new WeakMap(), clusters: new WeakMap() };
  let exact: { fit: FitScale; flowed: Flowed } | null = null;
  const flowExact = (fit: FitScale): Flowed => {
    if (exact && exact.fit.font === fit.font && exact.fit.spacing === fit.spacing) return exact.flowed;
    const flowed = flowParas(mm, o, prepared, bullets, env, innerW, fit, shared);
    exact = { fit, flowed };
    return flowed;
  };
  const fit = autofit(
    style,
    innerH,
    (f) => flowExact(f).height,
    (f, ref) => flowParas(mm, o, prepared, bullets, env, innerW, f, shared, ref).height,
    style.lineModel === 'office' ? FIT_SPACINGS : FIT_SPACINGS.slice(0, 1),
    minFontScale,
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
 * `linear` (a reference scale), widths are not measured at `fit` but scaled linearly from their measure at
 * `linear`, and only `height` is computed (the autofit search: `lines` is empty).
 */
function flowParas(
  m: Measurer,
  o: TextObject,
  prepared: PreparedPara[],
  bullets: readonly (BulletSpec | null)[],
  env: FontEnv,
  innerW: number,
  fit: FitScale,
  shared: Shared,
  linear?: FitScale,
): Flowed {
  const text = o.text;
  const style = o.style;
  const office = style.lineModel === 'office';
  const wrap = style.wrap !== false;
  const k = office ? fit.spacing : 1;
  // The spacing scale never changes a width: only a different font scale needs the linear estimate.
  const base = linear && linear.font !== fit.font ? linear : null;
  const size = (px: number, f: FitScale) => fitSize(px, f.font, office);
  // Font strings by run style, size and script: an emergency break asks for the same one on every line.
  const fonts = new Map<RunStyle, Map<number, Map<string, string>>>();
  const fontOf = (st: RunStyle, script: string, sizePx: number): string => {
    let bySize = fonts.get(st);
    if (!bySize) fonts.set(st, (bySize = new Map()));
    let byScript = bySize.get(sizePx);
    if (!byScript) bySize.set(sizePx, (byScript = new Map()));
    let font = byScript.get(script);
    if (font === undefined) {
      font = env.font({
        family: st.family,
        fallbacks: st.fallbacks,
        weight: st.weight,
        italic: st.italic,
        smallCaps: st.caps === 'small',
        sizePx,
        script,
      });
      byScript.set(script, font);
    }
    return font;
  };
  /** Width of `s` drawn in run style `st`, measured at the scale `f`. */
  const measureAt = (st: RunStyle, script: string, dir: 'ltr' | 'rtl', s: string, f: FitScale): number => {
    const px = drawnPx(size(st.sizePx, f), st.baseline);
    return m.width(fontOf(st, script, px), dir, st.lang, st.letterSpacing, s);
  };
  /** Width of `s` drawn in run style `st` at the layout's size: measured, or scaled from `base`. */
  const widthOf = (st: RunStyle, script: string, dir: 'ltr' | 'rtl', s: string): number => {
    if (!base) return measureAt(st, script, dir, s, fit);
    const w = measureAt(st, script, dir, s, base);
    const ref = drawnPx(size(st.sizePx, base), st.baseline);
    return linearWidth(w, ref, drawnPx(size(st.sizePx, fit), st.baseline), st.letterSpacing, s);
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
  /** `piece` measured; `keep` keeps its reference widths for the next search step (the prepared pieces). */
  const measure = (piece: Piece, sr: StyleRun, keep = true): Measured => {
    const st = sr.style;
    const sz = size(st.sizePx, fit);
    const sizePx = drawnPx(sz, st.baseline);
    let w: number;
    let t: number;
    if (base) {
      // The search lays out the same pieces up to 30 times: their reference widths are kept per piece.
      let b = shared.bases.get(piece);
      if (!b) {
        const gaps = (e: number) =>
          st.letterSpacing ? st.letterSpacing * spacingGaps(segText(text, piece.start, e, st.caps)) : 0;
        const refPx = drawnPx(size(st.sizePx, base), st.baseline);
        b = { ...pieceWidths(piece, st, base), refPx, sw: gaps(piece.end), st: gaps(piece.trail) };
        if (keep) shared.bases.set(piece, b);
      }
      w = scaleWidth(b.w, b.refPx, sizePx, b.sw);
      t = scaleWidth(b.t, b.refPx, sizePx, b.st);
    } else ({ w, t } = pieceWidths(piece, st, fit));
    return {
      piece,
      style: st,
      run: sr.run,
      font: base ? '' : fontOf(st, piece.script, sizePx),
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
      const bpx = bulletPx(F, spec.sizePct);
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
      const dir = rtl ? 'rtl' : 'ltr';
      if (base && main) {
        const rpx = bulletPx(size(main.style.sizePx, base), spec.sizePct);
        const w = m.width(env.font({ ...req, sizePx: rpx }), dir, spec.lang, 0, spec.text);
        bulletW = linearWidth(w, rpx, bpx, 0, spec.text);
      } else bulletW = m.width(font, dir, spec.lang, 0, spec.text);
      bulletBox = Math.max(bulletW, other - x0);
      bullet = {
        text: spec.text,
        x: 0,
        font,
        sizePx: bpx,
        color: spec.color,
        dir,
        lang: spec.lang,
        run: spec.run,
      };
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
    /**
     * Where an emergency break cuts piece `c` to fit `room`: after the most clusters that fit (the first
     * cluster when nothing fits and `force`), by galloping from the piece's start and bisecting the last
     * window, so the strings measured are at most about twice the line. `all`: every cut inside the piece
     * fits (the whole piece was not measured). Trailing whitespace hangs: a cut inside it fits when the
     * text before it does, and `'whole'` says the piece's text fits (or is one cluster wider than the line,
     * when `force`) with its whitespace hanging, so it is never cut and never starts the next line.
     */
    const splitPiece = (
      c: Measured,
      room: number,
      force: boolean,
    ):
      | { head: Piece; tail: Piece; all: boolean; cuts: { list: ClusterCuts; base: number } }
      | 'whole'
      | null => {
      const p = c.piece;
      let view = c.cuts;
      if (!view) {
        let list = shared.clusters.get(p);
        if (!list) {
          list = new ClusterCuts(text, p.start, p.end);
          shared.clusters.set(p, list);
        }
        view = { list, base: 0 };
      }
      const { list, base: b0 } = view;
      const cuts = { at: (k: number) => list.at(b0 + k), count: () => list.count - b0 };
      const dir = p.level % 2 ? 'rtl' : 'ltr';
      // Where the trailing whitespace starts: a cut at or after it measures the text before it only.
      const hang = Math.max(p.start, p.trail);
      const fits = (k: number) => {
        const end = Math.min(cuts.at(k)!, hang);
        return (
          end <= p.start ||
          widthOf(c.style, p.script, dir, segText(text, p.start, end, c.style.caps)) <= room + EPS
        );
      };
      let lo = -1; // the last cut known to fit
      let hi: number; // the first cut known not to fit, or the number of cuts
      for (let k = 0, step = 1; ; ) {
        const at = cuts.at(k);
        if (at === undefined) {
          hi = cuts.count();
          break;
        }
        if (!fits(k)) {
          hi = k;
          break;
        }
        // Every later cut is in the whitespace too, and fits: the clusters there need not be found.
        if (at >= hang) return 'whole';
        lo = k;
        k += step;
        step *= 2;
      }
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (!fits(mid)) hi = mid;
        else if (cuts.at(mid)! >= hang) return 'whole';
        else lo = mid;
      }
      if (lo < 0 && !force) return null;
      const at = cuts.at(Math.max(0, lo));
      if (at === undefined) return null;
      // Forced: the first cluster is wider than the line, and only whitespace follows it.
      if (at >= hang) return 'whole';
      return {
        // The cut is before the whitespace: the head has none, the tail keeps all of it.
        head: { ...p, end: at, trail: at, breakAfter: false },
        tail: { ...p, start: at },
        all: lo >= 0 && cuts.at(lo + 1) === undefined,
        cuts: { list, base: b0 + Math.max(0, lo) + 1 },
      };
    };
    /** The rest of `c` after an emergency break put `head` on the line: estimated, measured later. */
    const rest = (
      c: Measured,
      head: Measured,
      tail: Piece,
      cuts: { list: ClusterCuts; base: number },
    ): Measured => {
      const w = Math.max(0, c.w - head.a);
      const t = tail.trail <= tail.start ? 0 : Math.max(0, w - (c.w - c.t));
      return {
        ...c,
        piece: tail,
        w,
        t,
        a: w + c.style.letterSpacing,
        spaces: Math.max(0, tail.end - Math.max(tail.start, tail.trail)),
        lazy: true,
        cuts,
      };
    };
    let i = 0;
    // The word being placed: pieces i..j (j has a break after it, or is the last), and its width (each
    // piece's advance, the last one's without its trailing whitespace), kept in step as pieces leave it.
    let j = -1;
    let word = 0;
    const share = (q: number) => (q === j ? queue[q]!.t : queue[q]!.a);
    const take = (q: number) => {
      word -= share(q);
      push(queue[q]!);
    };
    const replace = (q: number, c: Measured) => {
      word -= share(q);
      queue[q] = c;
      word += share(q);
    };
    while (i < queue.length) {
      const room = avail(broken.length);
      if (i > j) {
        j = i;
        while (j < queue.length - 1 && !queue[j]!.piece.breakAfter) j++;
        word = 0;
        for (let q = i; q <= j; q++) word += share(q);
      }
      const head = queue[i]!;
      if (head.lazy) {
        // The rest of an emergency break, on a line of its own (`cur` is empty): cut another line's worth
        // off it, or measure it once all of it may fit.
        const sr = runs[head.piece.sr]!;
        const cut = splitPiece(head, room, true);
        if (!cut || cut === 'whole' || cut.all)
          replace(i, { ...measure(head.piece, sr, false), cuts: head.cuts });
        else {
          const h = measure(cut.head, sr, false);
          push(h);
          replace(i, rest(head, h, cut.tail, cut.cuts));
          endLine();
        }
        continue;
      }
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
      while (q <= j && adv + queue[q]!.t <= room + EPS) take(q++);
      if (q <= j) {
        const c = queue[q]!;
        const cut = splitPiece(c, room - adv, cur.length === 0);
        const sr = runs[c.piece.sr]!;
        if (cut && cut !== 'whole') {
          const h = measure(cut.head, sr, false);
          push(h);
          replace(q, rest(c, h, cut.tail, cut.cuts));
        } else if (cut || !cur.length) take(q++); // one cluster wider than the line overflows; whitespace hangs
      }
      endLine();
      i = q;
    }
    if (cur.length || !broken.length) endLine();

    // Placing: line metrics, then (not for the autofit search, which needs heights only) alignment and
    // visual order.
    broken.forEach((items, n) => {
      // An empty line after an a:br (an empty soft paragraph) is as tall as its own end mark, not as the
      // paragraph it continues (LibreOffice 24.2, measured): a small endParaRPr makes a short last line.
      let lineF = !items.length && para.soft ? 0 : F;
      for (const c of items) if (!c.style.baseline && c.size > lineF) lineF = c.size;
      if (!items.length)
        for (const r of runs) if (!r.style.baseline) lineF = Math.max(lineF, size(r.style.sizePx, fit));
      if (!(lineF > 0)) lineF = F;
      // That line, when it ends its paragraph (no soft paragraph follows), is single spaced in the office
      // model whatever the paragraph's proportional spacing, so the spacing scale leaves it alone too; exact
      // spacing still applies. An empty line between two a:br and an empty paragraph keep the paragraph's
      // spacing. LibreOffice 24.2, measured.
      const trailingBr = office && !items.length && para.soft && !prepared[pi + 1]?.para.soft;
      const metrics = office
        ? trailingBr
          ? officeLine(lineF, ps.lineSpacingPx === null ? { ...ps, lineSpacing: 1 } : ps, k, OFFICE_SINGLE)
          : officeLine(lineF, ps, k, style.lineHeight)
        : ordoLine(lineF, ps, style.lineHeight);
      if (linear) {
        y += metrics.height;
        return;
      }
      const lineStart = startX(n);
      const A = innerW - lineStart;
      const L = rtl ? 0 : lineStart;
      const tail = items[items.length - 1];
      // The paragraph's last line ends at its end or at an a:br: its trailing whitespace is text, aligned
      // with the rest, as LibreOffice and PowerPoint align it. Only whitespace at a wrap hangs.
      const last = n === broken.length - 1;
      let lineW = 0;
      for (const c of items) lineW += c.a;
      if (tail) lineW += (last ? tail.w : tail.t) - tail.a;
      let spaces = 0;
      for (let q = 0; q < items.length - 1; q++) spaces += items[q]!.spaces;
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
          x: isTail && odd && !last ? sx - (c.w - c.t) : sx,
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
