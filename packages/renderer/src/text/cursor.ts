import type { Box, TextObject } from '@ordo/domain';

import { clampBox, clampStyle, clampText, num } from '../clamp.ts';
import { type Ctx2D, setLetterSpacing } from '../ctx.ts';
import { layoutText, paragraphDirections } from '../text2d.ts';
import { graphemeBoundaries, isBreakSpace } from './breaks.ts';
import { currentFontEnv } from './fonts.ts';
import { itemize, resolveRunStyle } from './itemize.ts';
import { measurerFor } from './measure.ts';
import { clampTextObject, isRichText, layoutRich, storedFitHolds } from './rich.ts';
import { segText } from './segments.ts';
import type { FontEnv } from './types.ts';

/*
 * Canvas-native text editing geometry (hit-testing, caret placement, selection highlight rectangles,
 * vertical line navigation, and word/paragraph range helpers).
 *
 * Works in the logical coordinate space of `o.box` (1920x1080 slide units, rotation not applied), using
 * the exact same layout engines (`layoutRich` for rich text, `layoutText` for legacy text) that paint
 * the slide canvas, so caret and selection highlights match rendered glyphs 1:1 with zero layout shift.
 */

export type CaretRect = {
  /** Logical X coordinate in the same coordinate space as `o.box`. */
  x: number;
  /** Logical Y of the top of the line box. */
  y: number;
  /** Logical height of the line box. */
  height: number;
  /** 0-based visual line index. */
  line: number;
};

export type SelectionRect = {
  x: number;
  y: number;
  w: number;
  h: number;
  line: number;
};

type EditableSeg = {
  start: number;
  end: number;
  x: number;
  w: number;
  rtl: boolean;
  prefixWidth: (offset: number) => number;
};

type EditableLine = {
  para: number;
  top: number;
  baseline: number;
  height: number;
  x: number;
  w: number;
  start: number;
  end: number;
  softWrapAfter: boolean;
  segs: EditableSeg[];
};

/** If `offset` falls in the middle of a surrogate pair in `text`, snap it to the pair's start. */
function snapCodePoint(text: string, offset: number): number {
  const n = text.length;
  const clamped = Math.max(0, Math.min(n, Math.trunc(offset)));
  if (clamped > 0 && clamped < n) {
    const hi = text.charCodeAt(clamped - 1);
    const lo = text.charCodeAt(clamped);
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return clamped - 1;
  }
  return clamped;
}

/** Build `EditableLine[]` from the rich text engine (`layoutRich`). */
function richEditableLines(ctx: Ctx2D, o: TextObject, env: FontEnv): EditableLine[] {
  const c = clampTextObject(o);
  const m = measurerFor(ctx);
  const layout = layoutRich(m, c, env);
  const src = storedFitHolds(c, env) ? c : { ...c, style: { ...c.style, fitScale: undefined } };
  const it = itemize(src);
  const out: EditableLine[] = [];

  for (let li = 0; li < layout.lines.length; li++) {
    const line = layout.lines[li]!;
    const para = it.paras[line.para];
    const nextLine = layout.lines[li + 1];
    const softWrapAfter = nextLine !== undefined && nextLine.para === line.para;

    if (line.segs.length === 0) {
      const pStart = para ? para.start : 0;
      const pEnd = para ? para.end : 0;
      out.push({
        para: line.para,
        top: line.top,
        baseline: line.baseline,
        height: line.height,
        x: line.x,
        w: 0,
        start: pStart,
        end: pEnd,
        softWrapAfter: false,
        segs: [],
      });
      continue;
    }

    let minStart = Number.POSITIVE_INFINITY;
    let maxEnd = Number.NEGATIVE_INFINITY;
    const segs: EditableSeg[] = line.segs.map((seg) => {
      if (seg.start < minStart) minStart = seg.start;
      if (seg.end > maxEnd) maxEnd = seg.end;
      const rtl = seg.level % 2 === 1;
      const run = seg.run >= 0 ? c.runs?.[seg.run] : undefined;
      const rs = resolveRunStyle(c.style, run);
      const spacing = rs.letterSpacing * layout.fontScale;
      const dir = rtl ? 'rtl' : 'ltr';
      return {
        start: seg.start,
        end: seg.end,
        x: seg.x,
        w: seg.w,
        rtl,
        prefixWidth: (offset: number) => {
          if (offset <= seg.start) return 0;
          if (offset >= seg.end) return seg.w;
          const str = segText(c.text, seg.start, offset, rs.caps);
          if (!str) return 0;
          const w = m.width(seg.font, dir, rs.lang, spacing, str) + spacing;
          return Math.max(0, Math.min(seg.w, w));
        },
      };
    });

    out.push({
      para: line.para,
      top: line.top,
      baseline: line.baseline,
      height: line.height,
      x: line.x,
      w: line.w,
      start: minStart,
      end: maxEnd,
      softWrapAfter,
      segs,
    });
  }

  return out;
}

/**
 * Wrap one paragraph of legacy text while tracking exact UTF-16 character offsets in `fullText`.
 * Matches `wrapParagraph` in `text2d.ts` line-for-line so line breaks are identical.
 */
function wrapLegacyParaOffsets(
  ctx: Pick<Ctx2D, 'measureText'>,
  fullText: string,
  paraStart: number,
  paraEnd: number,
  uppercase: boolean,
  maxWidth: number,
): { start: number; end: number; drawnEnd: number }[] {
  const rawPara = fullText.slice(paraStart, paraEnd);
  const measureStr = (s: string) => ctx.measureText(uppercase ? s.toUpperCase() : s).width;

  const tokens: { word: string; start: number; end: number }[] = [];
  const re = /\S+/g;
  for (let m = re.exec(rawPara); m !== null; m = re.exec(rawPara)) {
    tokens.push({
      word: m[0],
      start: paraStart + m.index,
      end: paraStart + m.index + m[0].length,
    });
  }

  if (tokens.length === 0) {
    return [{ start: paraStart, end: paraEnd, drawnEnd: paraStart }];
  }

  const lines: { start: number; end: number; drawnEnd: number }[] = [];
  let lineText = '';
  let lineStart = paraStart;
  let lineEnd = tokens[0]!.end;

  for (let wi = 0; wi < tokens.length; wi++) {
    const tok = tokens[wi]!;
    const w = tok.word;
    const candidate = lineText ? `${lineText} ${w}` : w;
    if (measureStr(candidate) <= maxWidth || !lineText) {
      if (!lineText && measureStr(w) > maxWidth) {
        let chunk = '';
        let chunkStart = wi === 0 ? paraStart : tok.start;
        let pos = tok.start;
        for (const ch of w) {
          const nextPos = pos + ch.length;
          if (measureStr(chunk + ch) > maxWidth && chunk) {
            lines.push({ start: chunkStart, end: pos, drawnEnd: pos });
            chunk = ch;
            chunkStart = pos;
          } else {
            chunk += ch;
          }
          pos = nextPos;
        }
        lineText = chunk;
        lineStart = chunkStart;
        lineEnd = tok.end;
      } else {
        if (!lineText) lineStart = wi === 0 ? paraStart : tok.start;
        lineText = candidate;
        lineEnd = tok.end;
      }
    } else {
      const nextTok = tokens[wi]!;
      lines.push({ start: lineStart, end: nextTok.start, drawnEnd: lineEnd });
      lineText = w;
      lineStart = nextTok.start;
      lineEnd = nextTok.end;
    }
  }

  lines.push({ start: lineStart, end: paraEnd, drawnEnd: lineEnd });
  return lines;
}

/** Build `EditableLine[]` from the legacy text engine (`layoutText`). */
function legacyEditableLines(ctx: Ctx2D, o: TextObject): EditableLine[] {
  const rawText = clampText(o.text);
  const uppercase = o.style.transform === 'uppercase';
  const style = clampStyle(o.style);
  const box = clampBox(o.box);
  const layout = layoutText(ctx, o.text, o.style, o.box, 1, false);
  const pad = style.padding;
  const innerW = Math.max(1, box.w - 2 * pad);
  const dirs = paragraphDirections(uppercase ? rawText.toUpperCase() : rawText);

  const font0 = ctx.font;
  const dir0 = ctx.direction;
  ctx.font = layout.font;
  setLetterSpacing(ctx, layout.letterSpacing);

  const paras = rawText.split('\n');
  const out: EditableLine[] = [];
  let paraStart = 0;
  let lineIdx = 0;

  for (let pi = 0; pi < paras.length; pi++) {
    const pText = paras[pi]!;
    const paraEnd = paraStart + pText.length;
    const d = dirs?.[pi] ?? null;
    ctx.direction = d ?? dir0;

    const wrapped = wrapLegacyParaOffsets(ctx, rawText, paraStart, paraEnd, uppercase, innerW);
    for (let wi = 0; wi < wrapped.length; wi++) {
      const wLine = wrapped[wi]!;
      const laid = layout.lines[lineIdx];
      lineIdx++;
      const top = laid ? laid.y : box.y + pad + (lineIdx - 1) * layout.lineHeightPx;
      const height = layout.lineHeightPx;
      const baseline = top + (height - layout.fontSize) / 2 + layout.fontSize * 0.8;
      const softWrapAfter = wi < wrapped.length - 1;
      const rtl = (laid?.dir ?? d) === 'rtl';

      // When a line is empty (or all whitespace), compute its aligned anchor x.
      let lineX = laid?.x ?? box.x + pad;
      const drawnW = laid?.width ?? 0;
      if (wLine.end <= wLine.start && !laid) {
        if (style.align === 'center') lineX = box.x + pad + innerW / 2;
        else if (style.align === 'right') lineX = box.x + pad + innerW;
      }

      if (wLine.end <= wLine.start) {
        out.push({
          para: pi,
          top,
          baseline,
          height,
          x: lineX,
          w: 0,
          start: wLine.start,
          end: wLine.end,
          softWrapAfter: false,
          segs: [],
        });
      } else {
        const measurePrefix = (offset: number): number => {
          if (offset <= wLine.start) return 0;
          const clampedOff = Math.min(wLine.end, offset);
          const prevFont = ctx.font;
          ctx.font = layout.font;
          setLetterSpacing(ctx, layout.letterSpacing);
          // Match the normalized single-space rendering of `wrapParagraph` up to `drawnEnd`, plus any trailing spaces.
          const rawSlice = rawText.slice(wLine.start, clampedOff);
          const str = uppercase ? rawSlice.toUpperCase() : rawSlice;
          const w = ctx.measureText(str).width;
          ctx.font = prevFont;
          return Math.max(0, w);
        };
        const totalW = Math.max(drawnW, measurePrefix(wLine.end));
        out.push({
          para: pi,
          top,
          baseline,
          height,
          x: lineX,
          w: totalW,
          start: wLine.start,
          end: wLine.end,
          softWrapAfter,
          segs: [
            {
              start: wLine.start,
              end: wLine.end,
              x: lineX,
              w: totalW,
              rtl,
              prefixWidth: measurePrefix,
            },
          ],
        });
      }
    }

    paraStart = paraEnd + 1;
  }

  ctx.font = font0;
  ctx.direction = dir0;
  return out;
}

/** Return the unified `EditableLine[]` for any `TextObject`. */
function editableLines(ctx: Ctx2D, o: TextObject, env = currentFontEnv()): EditableLine[] {
  return isRichText(o) ? richEditableLines(ctx, o, env) : legacyEditableLines(ctx, o);
}

/** Logical X coordinate of `offset` on `line`. */
function xOnLine(line: EditableLine, offset: number): number {
  if (line.segs.length === 0) return line.x;
  for (let i = 0; i < line.segs.length; i++) {
    const seg = line.segs[i]!;
    if (offset >= seg.start && offset <= seg.end) {
      // If offset is at a segment boundary shared with the next segment in logical order, either gives the same X.
      const pw = seg.prefixWidth(offset);
      return seg.rtl ? seg.x + seg.w - pw : seg.x + pw;
    }
  }
  const first = line.segs[0]!;
  if (offset < line.start) return first.rtl ? first.x + first.w : first.x;
  const last = line.segs[line.segs.length - 1]!;
  return last.rtl ? last.x : last.x + last.w;
}

/** Find the visual line index for a character `offset`. */
function lineIndexForOffset(lines: readonly EditableLine[], offset: number, preferLineEnd = false): number {
  if (lines.length === 0) return 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (offset < line.start) return i;
    if (offset >= line.start && offset <= line.end) {
      // At a soft-wrap boundary where `offset === line.end === lines[i + 1].start`,
      // place the caret at the start of the next line unless `preferLineEnd` is requested.
      if (
        !preferLineEnd &&
        line.softWrapAfter &&
        offset === line.end &&
        i + 1 < lines.length &&
        lines[i + 1]!.start === offset
      ) {
        continue;
      }
      return i;
    }
  }
  return lines.length - 1;
}

/**
 * Compute the caret rectangle in the logical coordinate space of `o.box` for UTF-16 `offset` in `o.text`.
 */
export function caretPosition(
  ctx: Ctx2D,
  o: TextObject,
  offset: number,
  preferLineEnd = false,
  env = currentFontEnv(),
): CaretRect {
  const lines = editableLines(ctx, o, env);
  if (lines.length === 0) {
    const style = clampStyle(o.style);
    const box = clampBox(o.box);
    const h = style.fontSizePx * style.lineHeight;
    return { x: box.x + style.padding, y: box.y + style.padding, height: h, line: 0 };
  }
  const cleanOffset = snapCodePoint(o.text, offset);
  const idx = lineIndexForOffset(lines, cleanOffset, preferLineEnd);
  const line = lines[idx]!;
  const x = xOnLine(line, cleanOffset);
  return {
    x,
    y: line.top,
    height: line.height,
    line: idx,
  };
}

/**
 * Compute selection highlight rectangles in the logical coordinate space of `o.box` for `[start, end)`.
 */
export function selectionRects(
  ctx: Ctx2D,
  o: TextObject,
  start: number,
  end: number,
  env = currentFontEnv(),
): SelectionRect[] {
  const a = snapCodePoint(o.text, Math.min(start, end));
  const b = snapCodePoint(o.text, Math.max(start, end));
  if (a >= b) return [];

  const lines = editableLines(ctx, o, env);
  const rects: SelectionRect[] = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (line.segs.length === 0) {
      // Empty line inside a multi-line selection: highlight a narrow newline marker.
      if (line.start >= a && line.start < b) {
        rects.push({
          x: line.x,
          y: line.top,
          w: Math.max(8, line.height * 0.25),
          h: line.height,
          line: li,
        });
      }
      continue;
    }

    if (b <= line.start || a >= line.end) continue;

    const lineRects: SelectionRect[] = [];
    for (const seg of line.segs) {
      const s0 = Math.max(a, seg.start);
      const s1 = Math.min(b, seg.end);
      if (s0 >= s1) continue;
      const w0 = seg.prefixWidth(s0);
      const w1 = seg.prefixWidth(s1);
      const x0 = seg.rtl ? seg.x + seg.w - w0 : seg.x + w0;
      const x1 = seg.rtl ? seg.x + seg.w - w1 : seg.x + w1;
      const rx = Math.min(x0, x1);
      const rw = Math.max(2, Math.abs(x1 - x0));
      lineRects.push({
        x: rx,
        y: line.top,
        w: rw,
        h: line.height,
        line: li,
      });
    }

    // Merge touching rects on the same line.
    lineRects.sort((r1, r2) => r1.x - r2.x);
    for (const r of lineRects) {
      const prev = rects[rects.length - 1];
      if (prev && prev.line === r.line && Math.abs(prev.x + prev.w - r.x) <= 1.5) {
        const right = Math.max(prev.x + prev.w, r.x + r.w);
        prev.w = right - prev.x;
      } else {
        rects.push(r);
      }
    }
  }

  return rects;
}

/**
 * Hit-test a logical point `(x, y)` (in the same coordinate space as `o.box`) and return the nearest
 * UTF-16 character offset in `o.text`.
 */
export function hitTestText(ctx: Ctx2D, o: TextObject, x: number, y: number, env = currentFontEnv()): number {
  const lines = editableLines(ctx, o, env);
  if (lines.length === 0) return 0;

  // 1. Find the closest visual line vertically.
  let bestLine = lines[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const top = line.top;
    const bottom = line.top + line.height;
    const dist = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (dist < bestDist) {
      bestDist = dist;
      bestLine = line;
      if (dist === 0) break;
    }
  }

  if (bestLine.segs.length === 0) return bestLine.start;

  // 2. Check if the click is before the left-most segment or after the right-most segment on the line.
  const firstSeg = bestLine.segs[0]!;
  const lastSeg = bestLine.segs[bestLine.segs.length - 1]!;
  if (x <= firstSeg.x) {
    return firstSeg.rtl ? firstSeg.end : firstSeg.start;
  }
  if (x >= lastSeg.x + lastSeg.w) {
    let endOffset = lastSeg.rtl ? lastSeg.start : lastSeg.end;
    // On a soft-wrapped line ending in break spaces, keep the caret before the trailing space so it stays on this line.
    if (bestLine.softWrapAfter && !lastSeg.rtl) {
      while (endOffset > bestLine.start && isBreakSpace(o.text.charCodeAt(endOffset - 1))) {
        endOffset--;
      }
    }
    return endOffset;
  }

  // 3. Find the segment containing (or horizontally closest to) `x`.
  let targetSeg = firstSeg;
  let minSegDist = Number.POSITIVE_INFINITY;
  for (const seg of bestLine.segs) {
    const d = x < seg.x ? seg.x - x : x > seg.x + seg.w ? x - (seg.x + seg.w) : 0;
    if (d < minSegDist) {
      minSegDist = d;
      targetSeg = seg;
      if (d === 0) break;
    }
  }

  // 4. Snap to the nearest grapheme cluster boundary inside `targetSeg` using mid-glyph comparison.
  const bounds = [targetSeg.start, ...graphemeBoundaries(o.text, targetSeg.start, targetSeg.end)];
  let bestOffset = targetSeg.start;
  let bestXDist = Number.POSITIVE_INFINITY;
  for (const b of bounds) {
    const w = targetSeg.prefixWidth(b);
    const bx = targetSeg.rtl ? targetSeg.x + targetSeg.w - w : targetSeg.x + w;
    const d = Math.abs(x - bx);
    if (d < bestXDist) {
      bestXDist = d;
      bestOffset = b;
    }
  }

  if (bestLine.softWrapAfter && bestOffset === bestLine.end) {
    while (bestOffset > bestLine.start && isBreakSpace(o.text.charCodeAt(bestOffset - 1))) {
      bestOffset--;
    }
  }

  return bestOffset;
}

/**
 * Move the caret one visual line up (`dir = -1`) or down (`dir = 1`), preserving horizontal `preferredX`.
 */
export function moveCaretVertically(
  ctx: Ctx2D,
  o: TextObject,
  offset: number,
  dir: -1 | 1,
  preferredX?: number,
  env = currentFontEnv(),
): { offset: number; preferredX: number } {
  const lines = editableLines(ctx, o, env);
  if (lines.length === 0) return { offset: 0, preferredX: preferredX ?? 0 };
  const cur = caretPosition(ctx, o, offset, false, env);
  const targetX = preferredX ?? cur.x;
  const nextLineIdx = cur.line + dir;
  if (nextLineIdx < 0) return { offset: 0, preferredX: targetX };
  if (nextLineIdx >= lines.length) return { offset: o.text.length, preferredX: targetX };
  const targetLine = lines[nextLineIdx]!;
  const nextOffset = hitTestText(ctx, o, targetX, targetLine.top + targetLine.height / 2, env);
  return { offset: nextOffset, preferredX: targetX };
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_']/u;

/**
 * Return the `[start, end)` word range around `offset` in `text` (for double-click selection).
 */
export function wordRangeAt(text: string, offset: number): { start: number; end: number } {
  const n = text.length;
  if (n === 0) return { start: 0, end: 0 };
  let at = snapCodePoint(text, offset);
  if (at >= n) at = snapCodePoint(text, n - 1);

  const isSpace = (i: number) => /\s/.test(text[i] ?? '');
  const isWord = (i: number) => WORD_CHAR.test(String.fromCodePoint(text.codePointAt(i) ?? 0));

  // If right after a word character and currently on whitespace/punctuation, prefer the word just before.
  if (!isWord(at) && at > 0 && isWord(snapCodePoint(text, at - 1))) {
    at = snapCodePoint(text, at - 1);
  }

  const kind = isWord(at) ? 'word' : isSpace(at) ? 'space' : 'punct';
  const matches = (i: number) =>
    kind === 'word'
      ? isWord(i)
      : kind === 'space'
        ? isSpace(i) && text[i] !== '\n'
        : !isWord(i) && !isSpace(i);

  let start = at;
  while (start > 0) {
    const prev = snapCodePoint(text, start - 1);
    if (text[prev] === '\n' || !matches(prev)) break;
    start = prev;
  }

  let end = at;
  while (end < n) {
    if (text[end] === '\n' || !matches(end)) break;
    const cp = text.codePointAt(end) ?? 0;
    end += cp > 0xffff ? 2 : 1;
  }

  return { start, end };
}

/**
 * Return the `[start, end)` paragraph range around `offset` in `text` (for triple-click selection).
 */
export function paraRangeAt(text: string, offset: number): { start: number; end: number } {
  const n = text.length;
  const clamped = Math.max(0, Math.min(n, offset));
  let start = text.lastIndexOf('\n', Math.max(0, clamped - 1));
  start = start < 0 ? 0 : start + 1;
  let end = text.indexOf('\n', clamped);
  if (end < 0) end = n;
  return { start, end };
}

/**
 * Transform a point `(slideX, slideY)` in slide logical coordinates into the unrotated local coordinates
 * `(0..box.w, 0..box.h)` of `box`.
 */
export function toLocalBoxPoint(box: Box, slideX: number, slideY: number): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = slideX - cx;
  const dy = slideY - cy;
  const rot = ((box.rotation ?? 0) * Math.PI) / 180;
  if (!rot) return { x: slideX - box.x, y: slideY - box.y };
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  return {
    x: dx * cos - dy * sin + box.w / 2,
    y: dx * sin + dy * cos + box.h / 2,
  };
}

export type TextEditingOverlayOptions = {
  /** Selection start offset in `o.text`. */
  start: number;
  /** Selection end offset in `o.text`. */
  end: number;
  /** Active caret offset (defaults to `end`). */
  caret?: number;
  /** Whether to draw the vertical caret bar (defaults to true). */
  showCaret?: boolean;
  /** Logical-to-device scale when drawing directly to a scaled canvas (defaults to 1). */
  scale?: number;
};

/**
 * Draw selection highlight rectangles and the active caret directly onto `ctx` for `o`.
 * Call after drawing `o`'s text so the selection and caret overlay the exact canvas glyphs.
 */
export function drawTextEditingOverlay(
  ctx: Ctx2D,
  o: TextObject,
  opts: TextEditingOverlayOptions,
  env = currentFontEnv(),
): void {
  const scale = num(opts.scale, 0.01, 8, 1);
  const a = Math.min(opts.start, opts.end);
  const b = Math.max(opts.start, opts.end);

  ctx.save();
  if (scale !== 1) ctx.scale(scale, scale);

  if (a < b) {
    const rects = selectionRects(ctx, o, a, b, env);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.38)';
    for (const r of rects) {
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }

  if (opts.showCaret !== false) {
    const caretIdx = opts.caret ?? opts.end;
    const caret = caretPosition(ctx, o, caretIdx, false, env);
    const barW = 2.5;
    const x = caret.x - barW / 2;
    const y = caret.y;
    const h = Math.max(8, caret.height);
    // High-contrast dark halo + bright white inner caret so it reads clearly on both light and dark slides.
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(x - 1, y - 1, barW + 2, h + 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, barW, h);
  }

  ctx.restore();
}
