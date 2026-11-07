/**
 * Text bodies as emitted (design/27 §1 `emit.ts`, §4 "Text", §6; split out of `emit.ts` in M9, `conv-seams`):
 * one `TextObject` per body, its box the shape's text rectangle (turned a quarter for vertical text).
 *
 * - **Rich text** (default): `richtext.ts` (runs, paragraph styles, the office box fields), the insets and
 *   paragraph margins written as they are; its JSON counts against the slide's text budget (`emit-budget.ts`).
 * - **Legacy text** (`EmitOptions.richText: false`): the dominant run's style with insets, margins and a
 *   `wrap="none"` growth folded into the box, as M1 wrote it (see `emit.ts`'s header).
 * - **M9 seams** (`text-conv`): `warpOf` and `writingOf` write `TextObject.warp` and `.writing` when
 *   `EmitOptions.m9Writes` has them; stubs until then.
 *
 * Pure: IR in, ordo objects out.
 */
import type { TextObject } from '@ordo/domain';
import { chargeText, overText } from './emit-budget.ts';
import {
  type Box,
  bound,
  boxOf,
  type EmitCtx,
  insetBox,
  legacyColor,
  MAX_COORD,
  ordo,
  quarterTurn,
  clampBox,
  visibleChars,
} from './emit-ctx.ts';
import { lenPx, multiply, ptPx } from './frame.ts';
import { textRectOf } from './geom.ts';
import type { Frame, Para, RunStyle, ShapeElement, TextBody } from './ir.ts';
import { EMU_PER_PT } from './ir.ts';
import { richText } from './richtext.ts';

/** Longest text an ordo `TextObject` holds (`@ordo/domain` MAX.text). */
export const MAX_TEXT = 20_000;

/** Stored font sizes in logical px (design/27 §4 "Sizes"). */
export const MIN_FONT_PX = 4;
export const MAX_FONT_PX = 1_000;

/** Single line spacing in the office line model: 1.2 × the font size (`pptx-render/src/page.ts`). */
export const SINGLE_LINE = 1.2;

/** How far a `wrap="none"` box grows on the side its alignment extends to, in logical px. */
const NO_WRAP_GROWTH = 1_920;

/** The text of a body as `TextObject.text`: paragraphs and breaks as '\n', tabs as spaces. */
export function legacyText(body: TextBody): string {
  return body.paras
    .map((p) => p.runs.map((r) => (r.kind === 'break' ? '\n' : r.text.replaceAll('\t', ' '))).join(''))
    .join('\n');
}

/** A key for "the same look" when counting characters per style. */
function styleKey(s: RunStyle): string {
  const f =
    s.fill.kind === 'solid'
      ? `${s.fill.color.r},${s.fill.color.g},${s.fill.color.b},${s.fill.color.a}`
      : s.fill.kind;
  return [
    s.sizePt,
    s.bold,
    s.italic,
    s.latin ?? '',
    f,
    s.caps,
    s.spacingPt,
    s.outline ? s.outline.width : '',
    s.shadow ? 1 : 0,
  ].join('|');
}

/** The dominant run style (most characters) and the paragraph holding most of the text. */
export function dominant(body: TextBody): { style: RunStyle; para: Para; text: string } | undefined {
  const count = new Map<string, { n: number; style: RunStyle; text: string }>();
  let top: { n: number; style: RunStyle; text: string } | undefined;
  let para: Para | undefined;
  let paraChars = -1;
  for (const p of body.paras) {
    let pc = 0;
    for (const r of p.runs) {
      if (r.kind === 'break') continue;
      const n = visibleChars(r.text);
      pc += n;
      if (!n) continue;
      const k = styleKey(r.style);
      let c = count.get(k);
      if (!c) count.set(k, (c = { n: 0, style: r.style, text: '' }));
      c.n += n;
      if (c.text.length < 400) c.text += r.text;
      if (!top || c.n > top.n) top = c;
    }
    if (pc > paraChars) {
      para = p;
      paraChars = pc;
    }
  }
  if (!para) return undefined;
  return { style: top?.style ?? para.end, para, text: top?.text ?? '' };
}

/** Text mostly in East Asian scripts, or in complex scripts (Arabic, Hebrew, Indic, Thai). */
function scriptOf(text: string): 'latin' | 'ea' | 'cs' {
  let ea = 0;
  let cs = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x2e80 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7af) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xffef) ||
      c >= 0x20000
    )
      ea++;
    else if (
      (c >= 0x0590 && c <= 0x08ff) ||
      (c >= 0x0900 && c <= 0x0e7f) ||
      (c >= 0xfb1d && c <= 0xfdff) ||
      (c >= 0xfe70 && c <= 0xfeff)
    )
      cs++;
    else if (ch.trim()) other++;
  }
  return ea > other && ea >= cs ? 'ea' : cs > other ? 'cs' : 'latin';
}

export function textObject(ctx: EmitCtx, e: ShapeElement, shapeVisible: boolean): TextObject | undefined {
  if (ctx.rich) return richTextObject(ctx, e, shapeVisible);
  const body = e.text!;
  let text = legacyText(body);
  if (!text.trim()) return undefined;
  if (text.length > MAX_TEXT) {
    ctx.log(`a text box was cut to ${MAX_TEXT} characters`);
    text = text.slice(0, MAX_TEXT);
  }
  const dom = dominant(body);
  if (!dom) return undefined;
  const st = dom.style;
  const f = ctx.frame;
  const fit = body.autofit.kind === 'shrink' ? body.autofit : undefined;
  const fontPx = bound(ptPx(f, st.sizePt * (fit?.fontScale ?? 1)), MIN_FONT_PX, MAX_FONT_PX);

  // The text rectangle: the preset's, minus the insets; padding is the smallest inset, the rest is folded.
  let box = textBox(ctx, e);
  const ins = body.insets;
  const l = lenPx(f, ins.l);
  const t = lenPx(f, ins.t);
  const r = lenPx(f, ins.r);
  const b = lenPx(f, ins.b);
  const pad = Math.min(l, t, r, b);
  box = insetBox(box, l - pad, t - pad, r - pad, b - pad);
  const margin = marginOf(body);
  if (margin.l || margin.r) box = insetBox(box, lenPx(f, margin.l), 0, lenPx(f, margin.r), 0);
  const para = dom.para;
  const align =
    para.align === 'center' || para.align === 'distribute'
      ? 'center'
      : para.align === 'right'
        ? 'right'
        : 'left';
  if (para.align === 'justify' || para.align === 'distribute')
    ctx.log(`${para.align} text is drawn ${align}-aligned (M2)`);
  if (!body.wrap) {
    const g = NO_WRAP_GROWTH;
    box =
      align === 'left'
        ? insetBox(box, 0, 0, -g, 0)
        : align === 'right'
          ? insetBox(box, -g, 0, 0, 0)
          : insetBox(box, -g / 2, 0, -g / 2, 0);
  }
  if (
    body.vert === 'vert' ||
    body.vert === 'eaVert' ||
    body.vert === 'mongolianVert' ||
    body.vert === 'vert270'
  )
    box = quarterTurn(box, body.vert === 'vert270' ? -90 : 90);
  if (body.vert || body.warp || body.numCol)
    ctx.log('vertical, warped or multi-column text is drawn as plain text (M8)');

  const face = scriptOf(dom.text);
  const family = (face === 'ea' ? st.ea : face === 'cs' ? st.cs : undefined) ?? st.latin ?? 'Calibri';
  let color = legacyColor(st.fill);
  if (st.fill.kind === 'none') color = { r: 0, g: 0, b: 0, a: 0 }; // hollow: only the outline shows
  const style: TextObject['style'] = {
    fontFamily: family.slice(0, 300),
    fontWeight: st.bold ? 700 : 400,
    fontStyle: st.italic ? 'italic' : 'normal',
    fontSizePx: fontPx,
    color: color ?? { r: 0, g: 0, b: 0, a: 1 },
    align,
    valign: body.anchor,
    lineHeight: lineHeightOf(para, fontPx, f, fit?.lnSpcReduction ?? 0),
    letterSpacing: bound(ptPx(f, st.spacingPt), -1000, 1000),
    padding: bound(pad, 0, MAX_COORD),
    transform: st.caps === 'none' ? 'none' : 'uppercase',
  };
  const outline = st.outline && st.outline.fill.kind === 'solid' ? ordo(st.outline.fill.color) : undefined;
  if (st.outline && outline)
    style.outline = { width: bound(lenPx(f, st.outline.width) / 2, 0, 500), color: outline };
  const shadow = st.shadow ?? (shapeVisible ? undefined : e.shadow);
  if (shadow) {
    const dir = (shadow.dir * Math.PI) / 180;
    const dist = lenPx(f, shadow.dist);
    style.shadow = {
      dx: bound(dist * Math.cos(dir), -500, 500),
      dy: bound(dist * Math.sin(dir), -500, 500),
      blur: bound(lenPx(f, shadow.blur), 0, 500),
      color: ordo(shadow.color),
    };
  }
  if (st.caps === 'small') ctx.log('small caps are drawn as capitals (M2)');
  return { id: ctx.newId(), type: 'text', box: clampBox(box), text, style, opacity: 1 };
}

/**
 * A body as a rich `TextObject` (`richtext.ts`): the box is the shape's text rectangle (the preset's, turned
 * a quarter for vertical text), the insets and paragraph margins are written as they are.
 */
function richTextObject(ctx: EmitCtx, e: ShapeElement, shapeVisible: boolean): TextObject | undefined {
  const body = e.text!;
  // Past the slide's budget the text is written without runs and paragraph styles (picture class anyway).
  const over = overText(ctx);
  const rich = richText(body, {
    frame: ctx.frame,
    ...(shapeVisible || !e.shadow ? {} : { shapeShadow: e.shadow }),
    log: ctx.log,
    ...(ctx.lo ? { lo: true } : {}),
    ...(over ? { plain: true } : {}),
  });
  if (!rich) return undefined;
  let box = textBox(ctx, e);
  if (
    body.vert === 'vert' ||
    body.vert === 'eaVert' ||
    body.vert === 'mongolianVert' ||
    body.vert === 'vert270'
  )
    box = quarterTurn(box, body.vert === 'vert270' ? -90 : 90);
  if (body.vert || body.warp || body.numCol)
    ctx.log('vertical, warped or multi-column text is drawn as plain text (M8)');
  const o: TextObject = {
    id: ctx.newId(),
    type: 'text',
    box: clampBox(box),
    text: rich.text,
    style: rich.style,
    opacity: 1,
  };
  if (rich.runs) o.runs = rich.runs;
  if (rich.paras) o.paras = rich.paras;
  // M9 (`text-conv`): the warp and the writing mode, each only when `EmitOptions.m9Writes` has it.
  const warp = warpOf(ctx, body, o);
  if (warp) o.warp = warp;
  const writing = writingOf(ctx, body);
  if (writing) o.writing = writing;
  chargeText(ctx, o);
  return o;
}

/**
 * M9 (`text-conv`, warps.md §4.2): the `TextObject.warp` of a body (`TextBody.warp`, its preset and adjust
 * values), with the legacy style an older build best draws written into `o` (the box-filling size, no wrap,
 * centred, zero insets), or undefined. Only when `EmitOptions.m9Writes` has 'warp'. Stub: none yet (the body
 * is drawn as plain text, as before).
 */
export function warpOf(_ctx: EmitCtx, _body: TextBody, _o: TextObject): TextObject['warp'] {
  return undefined;
}

/**
 * M9 (`text-conv`, geometry-leftovers.md §5): the `TextObject.writing` of a vertical body (`eaVert` CJK
 * upright, `wordArtVert` stacked, `mongolianVert` reversed), or undefined for horizontal text, `vert` and
 * `vert270` (the turned box is exact). Only when `EmitOptions.m9Writes` has 'writing'. Stub: none yet.
 */
export function writingOf(_ctx: EmitCtx, _body: TextBody): TextObject['writing'] {
  return undefined;
}

/**
 * The paragraph margin to fold into a legacy text box, in EMU, on the start side of the paragraphs: the
 * least that every paragraph with text keeps clear of (`marL`, or the first line's `marL + indent` when a
 * paragraph has no bullet and that is less; bullets are not drawn in M1, so text starts at `marL`). Left
 * for left-to-right paragraphs, right for right-to-left ones; none when they are mixed.
 */
export function marginOf(body: TextBody): { l: number; r: number } {
  let least = Number.POSITIVE_INFINITY;
  let ltr = false;
  let rtl = false;
  for (const p of body.paras) {
    if (!p.runs.some((r) => r.kind !== 'break' && r.text.trim())) continue;
    const m = p.bullet ? p.marL : Math.min(p.marL, p.marL + p.indent);
    least = Math.min(least, Math.max(0, m));
    if (p.rtl) rtl = true;
    else ltr = true;
  }
  if (!Number.isFinite(least) || least <= 0 || (ltr && rtl)) return { l: 0, r: 0 };
  return rtl ? { l: 0, r: least } : { l: least, r: 0 };
}

/** `TextStyle.lineHeight` (a multiple of the font size) from the paragraph's line spacing. */
function lineHeightOf(p: Para, fontPx: number, f: Frame, reduction: number): number {
  const ls = p.lineSpacing;
  let h: number;
  if (ls && 'pts' in ls) h = (ls.pts * EMU_PER_PT * f.s) / fontPx;
  else h = SINGLE_LINE * Math.max(0, (ls?.pct ?? 1) - reduction);
  return bound(h, 0.1, 10);
}

/**
 * The shape's text rectangle as a box (M6): its geometry's `a:rect` (every preset of POI's table, a custom
 * geometry's own) placed through the shape's affine, so a flipped shape's rectangle is mirrored with it
 * (and its text turned half a turn by a vertical flip, as PowerPoint draws it); the whole box for a rect or
 * a preset the table does not know.
 */
export function textBox(ctx: EmitCtx, e: ShapeElement): Box {
  const [l, t, r, b] = textRectOf(e);
  if (l === 0 && t === 0 && r === 1 && b === 1) return boxOf(ctx, e.xf);
  return boxOf(ctx, multiply(e.xf, [Math.max(0, r - l), 0, 0, Math.max(0, b - t), l, t]));
}
