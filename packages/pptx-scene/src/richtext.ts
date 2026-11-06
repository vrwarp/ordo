/**
 * A text body as rich ordo text (design/27 §3.1, §3.2, §4 "Text bodies", §6, §11 "Mapping"):
 * `TextObject.text` with sparse `runs`, paragraph styles (`paras`) and the box fields of the office line
 * model, every value from the inheritance chain the IR already resolved.
 *
 * - **Text.** Paragraphs joined by '\n'; an `a:br` is a '\n' too, starting a paragraph `{ soft: true }`
 *   that continues the one before it (§3.1). Tabs and other control characters inside `a:t` are spaces, so
 *   paragraph i of the text is always `paras[i]`. At most `MAX_TEXT` characters (the rest is cut, noted).
 * - **Box style** (§3.2): the dominant run's style (most visible characters), so an older build that strips
 *   every new key still draws the text sensibly: its family, weight, slant, size, colour, letter spacing,
 *   outline, shadow and caps; `align` and `lineHeight` from the paragraph holding most of the text;
 *   `padding` the smallest inset. The office fields beside them: `lineModel: 'office'`, the four `insets`,
 *   `wrap: false` for `wrap="none"`, `autofit: 'shrink'` with PowerPoint's stored `fitScale` for
 *   `normAutofit` (font = fontScale, spacing = 1 − lnSpcReduction; sizes stay unscaled, the engine applies
 *   it), `direction` (PowerPoint paragraphs are left to right unless `rtl="1"`), `lang`, `underline` and
 *   `fallbackFonts` (fontmap.ts).
 * - **Runs** (§4 "Run properties"): every stretch whose look differs from the box style, merged while it
 *   stays the same: family, weight, slant, `sizeScale` (× the box size), colour (all colour forms, already
 *   resolved; hollow text is transparent with its outline; a gradient is its first stop until M6),
 *   highlight, underline, strike, caps, letter spacing, `baseline` (a superscript verse number), outline and
 *   shadow (null where the box has one and the run has none) and language (when its primary subtag
 *   differs). A run's characters are drawn in its Latin, East Asian or complex-script family by script
 *   (fontmap.ts `scriptClasses`), so one PowerPoint run can become several ordo runs. The '\n' that ends an
 *   empty paragraph carries that paragraph's end mark (`a:endParaRPr`), which sizes the empty line; the last
 *   paragraph, when empty, takes the '\n' before it (`itemize.ts`).
 * - **Paragraphs** (§4, §6): alignment (justify and distribute included) where it differs from the box,
 *   level, `marL` → `indentPx`, `indent` → `firstLinePx` (negative: a hanging bullet), space before and
 *   after (points, or a share of the paragraph's largest run size, as LibreOffice takes it), line spacing (a percentage as a multiple
 *   of single spacing, points as an exact pitch) wherever it differs from the box's `lineHeight`, the
 *   nearest bullet setting (a Wingdings, Wingdings 2 or 3, Webdings or Symbol character mapped to Unicode
 *   with `@ordo/domain` `symbolFontChar` and drawn in the text's font, '•' for an unknown code, another
 *   symbol font's or any other private-use character; automatic numbers with their scheme and `startAt`,
 *   `buFont`, `buClr`, `buSzPct`/`buSzPts`, `a:buNone` as null) and the direction where it differs from the
 *   box. A null entry is a paragraph with the box's defaults; trailing nulls are left out.
 *
 * Pure and bounded: at most `MAX_RUNS` runs and `MAX_PARAS` paragraph styles (the schema's limits; what is
 * past them takes the box style, noted), every number finite and inside the schema's bounds, so
 * `Slide.parse` accepts the object as it is.
 */
import type { Rgba as OrdoRgba, TextPara, TextRun, TextStyle } from '@ordo/domain';
import { isPrivateUse, isSymbolFont, symbolFontChar } from '@ordo/domain/bullets.ts';
import { fallbackFonts, type ScriptClass, scriptClasses } from './fontmap.ts';
import { lenPx, ptPx } from './frame.ts';
import type { Bullet, Fill, Frame, Para, RunStyle, Shadow, TextBody } from './ir.ts';
import type { Log } from './log.ts';

/** Longest text an ordo `TextObject` holds (`@ordo/domain` MAX.text). */
export const MAX_TEXT = 20_000;
/** Runs and paragraph styles one `TextObject` holds (`@ordo/domain` TextObject). */
export const MAX_RUNS = 2_000;
export const MAX_PARAS = 5_000;
/** Stored font sizes in logical px (design/27 §4 "Sizes"). */
export const MIN_FONT_PX = 4;
export const MAX_FONT_PX = 1_000;
/** Single line spacing of the office line model: 1.2 × the font size. */
export const SINGLE_LINE = 1.2;
/** The bullet a picture bullet (`a:buBlip`) is drawn as. */
const PICTURE_BULLET = '\u{2022}';
/** Logical coordinates are bounded by the schema (`coord`). */
const MAX_COORD = 100_000;

export interface RichOptions {
  frame: Frame;
  /** The shadow the shape casts with its text: PowerPoint draws it only when the shape itself shows nothing. */
  shapeShadow?: Shadow;
  log: Log;
  /**
   * For the fidelity harness only (`EmitOptions.loCompat`): LibreOffice 24.2's policies where they differ
   * from PowerPoint's, so the native column can be compared with its pictures. Shrink-to-fit only when the
   * shape's own `a:bodyPr` asks for it (an inherited `normAutofit` is not applied), always re-fitted from
   * full size (no stored scale); no run shadows (the shadow an unfilled shape casts stays); no outline on
   * filled text (the copy LibreOffice draws has them stripped).
   */
  lo?: boolean;
  /**
   * The text and its box style only, without runs and paragraph styles: what `emit.ts` writes once a slide
   * has passed its JSON budget (design/27 §3.4; the slide is classed picture).
   */
  plain?: boolean;
}

/** A body as the text fields of a `TextObject` (the box and id are the caller's). */
export interface RichText {
  text: string;
  style: TextStyle;
  runs?: TextRun[];
  paras?: (TextPara | null)[];
}

/** A stretch of text in one run style and one family. */
interface Piece {
  start: number;
  end: number;
  style: RunStyle;
  family: string | undefined;
  cls: ScriptClass;
}

/** An ordo paragraph: a PowerPoint paragraph, or one of its soft lines (after an `a:br`). */
interface OrdoPara {
  start: number;
  end: number;
  /** The PowerPoint paragraph it belongs to. */
  ir: Para;
  soft: boolean;
}

/** A '\n' and the style it carries when it matters (it ends an empty paragraph). */
interface Newline {
  at: number;
  style: RunStyle;
}

/** The rich text of a body, or undefined when it has no visible character. */
export function richText(body: TextBody, opts: RichOptions): RichText | undefined {
  const built = buildText(body, opts.log);
  if (!built.text.trim()) return undefined;
  const { text, pieces, paras, newlines } = built;
  const f = opts.frame;

  // The dominant style (most visible characters; the first to lead keeps a tie) and the paragraph holding
  // most of the text.
  const counts = new Map<string, { n: number; piece: Piece }>();
  let top: { n: number; piece: Piece } | undefined;
  for (const p of pieces) {
    const n = visibleChars(text, p.start, p.end);
    if (!n) continue;
    const k = styleKey(p.style, p.family);
    let c = counts.get(k);
    if (!c) counts.set(k, (c = { n: 0, piece: p }));
    c.n += n;
    if (!top || c.n > top.n) top = c;
  }
  const mainPara = largestPara(body);
  if (!mainPara) return undefined;
  const dom = top?.piece ?? { style: mainPara.end, family: mainPara.end.latin, cls: 'latin' as const };
  const st = dom.style;
  const fontPx = bound(ptPx(f, st.sizePt), MIN_FONT_PX, MAX_FONT_PX);
  const family = (dom.family ?? 'Calibri').slice(0, 300);
  const color = runColor(st.fill, opts.log);
  const ins = {
    l: bound(lenPx(f, body.insets.l), 0, MAX_COORD),
    t: bound(lenPx(f, body.insets.t), 0, MAX_COORD),
    r: bound(lenPx(f, body.insets.r), 0, MAX_COORD),
    b: bound(lenPx(f, body.insets.b), 0, MAX_COORD),
  };
  const align = legacyAlign(mainPara);
  const rtl = mainPara.rtl;
  const style: TextStyle = {
    fontFamily: family,
    fontWeight: st.bold ? 700 : 400,
    fontStyle: st.italic ? 'italic' : 'normal',
    fontSizePx: fontPx,
    color,
    align,
    valign: body.anchor,
    lineHeight: boxLineHeight(mainPara, fontPx, f),
    letterSpacing: bound(ptPx(f, st.spacingPt), -1000, 1000),
    padding: Math.min(ins.l, ins.t, ins.r, ins.b),
    transform: st.caps === 'none' ? 'none' : 'uppercase',
    lineModel: 'office',
    insets: ins,
  };
  const lo = opts.lo === true;
  const outline = runOutline(f, st, lo);
  if (outline) style.outline = outline;
  const shadow = runShadow(f, (lo ? undefined : st.shadow) ?? opts.shapeShadow);
  if (shadow) style.shadow = shadow;
  if (!body.wrap) style.wrap = false;
  if (body.autofit.kind === 'shrink' && (!lo || body.autofit.own)) {
    style.autofit = 'shrink';
    const font = bound(body.autofit.fontScale, 0.01, 1);
    const spacing = bound(1 - body.autofit.lnSpcReduction, 0, 1);
    if ((font < 1 || spacing < 1) && !lo) style.fitScale = { font, spacing };
  }
  style.direction = rtl ? 'rtl' : 'ltr';
  const lang = cleanLang(st.lang);
  if (lang) style.lang = lang;
  if (st.underline) style.underline = true;

  // Families tried after each run's own: substitutes, the East Asian and complex-script faces, scripts.
  const byClass = (cls: ScriptClass) => familiesBy(pieces, text, (p) => p.cls === cls);
  const withFallbacks = (bullets: string[]) => {
    const all = [...familiesBy(pieces, text, () => true), ...bullets];
    const fallbacks = fallbackFonts(family, byClass('ea'), byClass('cs'), all, text, lang);
    if (fallbacks.length) style.fallbackFonts = fallbacks;
  };
  if (opts.plain) {
    withFallbacks([]);
    return { text, style };
  }

  // Runs: what differs from the box, merged while it stays the same.
  const ctx: DiffCtx = {
    f,
    box: style,
    boxCaps: st.caps === 'none' ? 'none' : 'all',
    shadow: opts.shapeShadow,
    lo,
  };
  const marks: { start: number; end: number; diff: Omit<TextRun, 'start' | 'end'> }[] = [];
  const keys: string[] = [];
  let ni = 0;
  const push = (start: number, end: number, diff: Omit<TextRun, 'start' | 'end'> | undefined) => {
    if (!diff) return;
    const key = JSON.stringify(diff);
    const last = marks[marks.length - 1];
    if (last && last.end === start && keys[keys.length - 1] === key) last.end = end;
    else {
      marks.push({ start, end, diff });
      keys.push(key);
    }
  };
  const nl = (upTo: number) => {
    // Newlines before `upTo`: one that matters carries its own style; the others continue the run before.
    for (; ni < newlines.length && newlines[ni]!.at < upTo; ni++) {
      const n = newlines[ni]!;
      const matters = endsEmpty(paras, n.at, text.length);
      // Its family draws nothing: only its size and the rest of its look count.
      if (matters) push(n.at, n.at + 1, runDiff(ctx, n.style, undefined, opts.log));
      else {
        const last = marks[marks.length - 1];
        if (last && last.end === n.at) last.end = n.at + 1;
      }
    }
  };
  for (const p of pieces) {
    nl(p.start);
    push(p.start, p.end, runDiff(ctx, p.style, p.family, opts.log));
  }
  nl(Number.POSITIVE_INFINITY);
  // A run that only carries a '\n' nobody needs (it continued the run before it) is fine; a run may not
  // end past the text.
  let runs: TextRun[] = marks.map((m) => ({ start: m.start, end: Math.min(m.end, text.length), ...m.diff }));
  runs = runs.filter((r) => r.end > r.start);
  if (runs.length > MAX_RUNS) {
    opts.log(`a text box has more than ${MAX_RUNS} differently formatted runs: the rest take the box style`);
    runs = runs.slice(0, MAX_RUNS);
  }

  // Paragraph styles.
  let out: (TextPara | null)[] = paras.map((p) => paraStyle(p, style, f, opts.log));
  while (out.length && out[out.length - 1] === null) out.pop();
  if (out.length > MAX_PARAS) {
    opts.log(`a text box has more than ${MAX_PARAS} paragraphs: the rest take the box style`);
    out = out.slice(0, MAX_PARAS);
  }

  withFallbacks(bulletFamilies(out));
  return {
    text,
    style,
    ...(runs.length ? { runs } : {}),
    ...(out.length ? { paras: out } : {}),
  };
}

// ── Text and pieces ─────────────────────────────────────────────────────────────────────────────────────

function buildText(
  body: TextBody,
  log: Log,
): { text: string; pieces: Piece[]; paras: OrdoPara[]; newlines: Newline[] } {
  let text = '';
  const pieces: Piece[] = [];
  const paras: OrdoPara[] = [];
  const newlines: Newline[] = [];
  let cut = false;
  let tabs = false;
  const room = () => MAX_TEXT - text.length;
  for (let pi = 0; pi < body.paras.length && !cut; pi++) {
    const p = body.paras[pi]!;
    if (pi > 0) {
      if (room() < 1) {
        cut = true;
        break;
      }
      newlines.push({ at: text.length, style: body.paras[pi - 1]!.end });
      text += '\n';
    }
    let para: OrdoPara = { start: text.length, end: text.length, ir: p, soft: false };
    paras.push(para);
    // The paragraph's characters, for the script of each one (an a:br counts as a weak character).
    const raw = p.runs.map((r) => (r.kind === 'break' ? '\n' : clean(r.text)));
    if (p.runs.some((r) => r.kind !== 'break' && r.text.includes('\t'))) tabs = true;
    const classes = scriptClasses(raw.join(''));
    let at = 0; // offset of the run in the paragraph
    for (let ri = 0; ri < p.runs.length; ri++) {
      const r = p.runs[ri]!;
      const s = raw[ri]!;
      if (r.kind === 'break') {
        if (room() < 1) {
          cut = true;
          break;
        }
        para.end = text.length;
        newlines.push({ at: text.length, style: r.style });
        text += '\n';
        para = { start: text.length, end: text.length, ir: p, soft: true };
        paras.push(para);
        at += 1;
        continue;
      }
      let len = s.length;
      if (len > room()) {
        len = room();
        // Never between the halves of a surrogate pair.
        if (len > 0 && isHigh(s.charCodeAt(len - 1))) len--;
        cut = true;
      }
      for (let i = 0; i < len; ) {
        const cls = classes[at + i]!;
        let j = i + 1;
        while (j < len && classes[at + j] === cls) j++;
        const start = text.length + i;
        pieces.push({ start, end: text.length + j, style: r.style, family: styleFamily(r.style, cls), cls });
        i = j;
      }
      text += s.slice(0, len);
      at += s.length;
      if (cut) break;
    }
    para.end = text.length;
  }
  if (cut) log(`a text box was cut to ${MAX_TEXT} characters`);
  if (tabs) log('tabs are drawn as spaces');
  // The last paragraph, when empty, takes its size from the '\n' before it: give that one its end mark.
  const last = paras[paras.length - 1];
  const lastNl = newlines[newlines.length - 1];
  if (last && last.start === last.end && lastNl && lastNl.at === last.start - 1)
    newlines[newlines.length - 1] = { at: lastNl.at, style: last.ir.end };
  return { text, pieces, paras, newlines };
}

/** Whether the '\n' at `at` ends an empty paragraph, or comes right before an empty last one. */
function endsEmpty(paras: readonly OrdoPara[], at: number, len: number): boolean {
  // Paragraphs are sorted: find the one ending at `at` by bisection.
  let lo = 0;
  let hi = paras.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = paras[mid]!;
    if (p.end < at) lo = mid + 1;
    else if (p.end > at) hi = mid - 1;
    else {
      if (p.start === p.end) return true;
      const next = paras[mid + 1];
      return (
        next !== undefined && next.start === len && next.start === next.end && mid + 1 === paras.length - 1
      );
    }
  }
  return false;
}

/** Text of `a:t` as ordo draws it: tabs and other control characters are spaces (one per UTF-16 unit). */
function clean(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing them is the point
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
}

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/** The family a run draws characters of one script class in: its ea or cs typeface, else its Latin one. */
function styleFamily(s: RunStyle, cls: ScriptClass): string | undefined {
  return (cls === 'ea' ? s.ea : cls === 'cs' ? s.cs : undefined) ?? s.latin;
}

function visibleChars(text: string, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x20 && c !== 0xa0 && !(c >= 0xdc00 && c <= 0xdfff)) n++;
  }
  return n;
}

/** A key for "the same look" when counting characters per style. */
function styleKey(s: RunStyle, family: string | undefined): string {
  const f =
    s.fill.kind === 'solid'
      ? `${s.fill.color.r},${s.fill.color.g},${s.fill.color.b},${s.fill.color.a}`
      : s.fill.kind;
  return [
    s.sizePt,
    s.bold,
    s.italic,
    family ?? '',
    f,
    s.caps,
    s.spacingPt,
    s.baseline,
    s.underline,
    s.outline ? s.outline.width : '',
    s.shadow ? 1 : 0,
  ].join('|');
}

/** The paragraph holding most visible characters (the first of a tie). */
function largestPara(body: TextBody): Para | undefined {
  let best: Para | undefined;
  let most = -1;
  for (const p of body.paras) {
    let n = 0;
    for (const r of p.runs) if (r.kind !== 'break') n += visibleChars(r.text, 0, r.text.length);
    if (n > most) {
      best = p;
      most = n;
    }
  }
  return best;
}

/** Families used by the pieces `pick` selects, most visible characters first. */
function familiesBy(pieces: readonly Piece[], text: string, pick: (p: Piece) => boolean): string[] {
  const n = new Map<string, number>();
  for (const p of pieces)
    if (p.family && pick(p)) n.set(p.family, (n.get(p.family) ?? 0) + visibleChars(text, p.start, p.end));
  return [...n]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

function bulletFamilies(paras: readonly (TextPara | null)[]): string[] {
  const out = new Set<string>();
  for (const p of paras) if (p?.bullet?.fontFamily) out.add(p.bullet.fontFamily);
  return [...out];
}

// ── Box values ──────────────────────────────────────────────────────────────────────────────────────────

/** The legacy alignment of a paragraph: justify starts at its start edge, distribute is centred. */
function legacyAlign(p: Para): TextStyle['align'] {
  switch (p.align) {
    case 'center':
    case 'distribute':
      return 'center';
    case 'right':
      return 'right';
    case 'justify':
      return p.rtl ? 'right' : 'left';
    default:
      return 'left';
  }
}

/** `TextStyle.lineHeight` (a multiple of the font size): 1.2 × a percentage, or an exact pitch over the size. */
function boxLineHeight(p: Para, fontPx: number, f: Frame): number {
  const ls = p.lineSpacing;
  const h = ls && 'pts' in ls ? ptPx(f, ls.pts) / fontPx : SINGLE_LINE * (ls && ls.pct > 0 ? ls.pct : 1);
  return bound(h, 0.1, 10);
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────────

interface DiffCtx {
  f: Frame;
  box: TextStyle;
  boxCaps: 'none' | 'all';
  shadow: Shadow | undefined;
  lo: boolean;
}

/** What a run's look changes on the box style; undefined when nothing. */
function runDiff(
  ctx: DiffCtx,
  s: RunStyle,
  family: string | undefined,
  log: Log,
): Omit<TextRun, 'start' | 'end'> | undefined {
  const box = ctx.box;
  const d: Omit<TextRun, 'start' | 'end'> = {};
  if (family && family !== box.fontFamily) d.fontFamily = family.slice(0, 300);
  const weight = s.bold ? 700 : 400;
  if (weight !== box.fontWeight) d.fontWeight = weight;
  const slant = s.italic ? 'italic' : 'normal';
  if (slant !== box.fontStyle) d.fontStyle = slant;
  const px = bound(ptPx(ctx.f, s.sizePt), 0.01, MAX_FONT_PX * 4);
  const scale = Math.round((px / box.fontSizePx) * 1e6) / 1e6;
  if (Math.abs(scale - 1) > 1e-6) d.sizeScale = bound(scale, 0.01, 50);
  const color = runColor(s.fill, log);
  if (!sameColor(color, box.color)) d.color = color;
  if (s.highlight) d.highlight = ordo(s.highlight);
  if (s.underline !== (box.underline ?? false)) d.underline = s.underline;
  if (s.strike) d.strike = true;
  if (s.baseline) d.baseline = bound(s.baseline, -1, 1);
  const spacing = bound(ptPx(ctx.f, s.spacingPt), -1000, 1000);
  if (Math.abs(spacing - box.letterSpacing) > 1e-6) d.letterSpacing = spacing;
  const caps = s.caps;
  if (caps !== ctx.boxCaps) d.caps = caps;
  const outline = runOutline(ctx.f, s, ctx.lo);
  if (!sameOutline(outline, box.outline)) d.outline = outline ?? null;
  const shadow = runShadow(ctx.f, (ctx.lo ? undefined : s.shadow) ?? ctx.shadow);
  if (!sameShadow(shadow, box.shadow)) d.shadow = shadow ?? null;
  const lang = cleanLang(s.lang);
  if (lang && primary(lang) !== primary(box.lang)) d.lang = lang;
  for (const _ in d) return d;
  return undefined;
}

/** A run's colour: solid; a gradient's first stop (M6 paints it); hollow text transparent. */
function runColor(fill: Fill, log: Log): OrdoRgba {
  switch (fill.kind) {
    case 'solid':
      return ordo(fill.color);
    case 'none':
      return { r: 0, g: 0, b: 0, a: 0 };
    case 'gradient': {
      log('gradient text is drawn in its first colour (M6)');
      let first = fill.stops[0];
      for (const s of fill.stops) if (first && s.at < first.at) first = s;
      return first ? ordo(first.color) : { r: 0, g: 0, b: 0, a: 1 };
    }
    case 'pattern': {
      const m = /^pct(\d{1,2})$/.exec(fill.preset);
      const k = m ? Number(m[1]) / 100 : 0.5;
      const mix = (a: number, b: number) => a * k + b * (1 - k);
      return ordo({
        r: mix(fill.fg.r, fill.bg.r),
        g: mix(fill.fg.g, fill.bg.g),
        b: mix(fill.fg.b, fill.bg.b),
        a: mix(fill.fg.a, fill.bg.a),
      });
    }
    default:
      return { r: 0, g: 0, b: 0, a: 1 };
  }
}

/** A text outline (`a:ln` with a solid fill) at half its width: ordo strokes twice the width under the fill. */
function runOutline(f: Frame, s: RunStyle, lo = false): TextStyle['outline'] {
  const ln = s.outline;
  if (lo && s.fill.kind !== 'none') return undefined;
  if (ln?.fill.kind !== 'solid') return undefined;
  return { width: bound(lenPx(f, ln.width) / 2, 0, 500), color: ordo(ln.fill.color) };
}

function runShadow(f: Frame, sh: Shadow | undefined): TextStyle['shadow'] {
  if (!sh) return undefined;
  const dir = (sh.dir * Math.PI) / 180;
  const dist = lenPx(f, sh.dist);
  return {
    dx: bound(dist * Math.cos(dir), -500, 500),
    dy: bound(dist * Math.sin(dir), -500, 500),
    blur: bound(lenPx(f, sh.blur), 0, 500),
    color: ordo(sh.color),
  };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6;

function sameColor(a: OrdoRgba | undefined, b: OrdoRgba | undefined): boolean {
  if (!a || !b) return a === b;
  return near(a.r, b.r) && near(a.g, b.g) && near(a.b, b.b) && near(a.a, b.a);
}

function sameOutline(a: TextStyle['outline'], b: TextStyle['outline']): boolean {
  if (!a || !b) return !a && !b;
  return near(a.width, b.width) && sameColor(a.color, b.color);
}

function sameShadow(a: TextStyle['shadow'], b: TextStyle['shadow']): boolean {
  if (!a || !b) return !a && !b;
  return near(a.dx, b.dx) && near(a.dy, b.dy) && near(a.blur, b.blur) && sameColor(a.color, b.color);
}

/** A BCP 47 tag as the schema and the renderer keep it (letters, digits and hyphens, ≤ 35). */
function cleanLang(v: string | undefined): string {
  return (v ?? '').slice(0, 35).replace(/[^A-Za-z0-9-]/g, '');
}

function primary(lang: string | undefined): string {
  return (lang ?? '').split('-')[0]!.toLowerCase();
}

// ── Paragraphs ──────────────────────────────────────────────────────────────────────────────────────────

/** The style of one ordo paragraph, or null when it takes the box defaults. */
function paraStyle(p: OrdoPara, box: TextStyle, f: Frame, log: Log): TextPara | null {
  if (p.soft) return { soft: true };
  const ir = p.ir;
  const out: TextPara = {};
  if (ir.align !== box.align) out.align = ir.align;
  if (ir.level > 0) out.level = ir.level;
  const marL = bound(lenPx(f, ir.marL), -MAX_COORD, MAX_COORD);
  if (marL) out.indentPx = marL;
  const indent = bound(lenPx(f, ir.indent), -MAX_COORD, MAX_COORD);
  if (indent) out.firstLinePx = indent;
  const mainPt = mainSize(ir);
  // A percentage gap is a share of the paragraph's largest run, as LibreOffice sizes it (oox
  // TextParagraph::insertAt takes the largest character height).
  const gapPt = largestSize(ir);
  const space = (s: Para['spaceBefore']) =>
    s === undefined ? 0 : bound('pts' in s ? ptPx(f, s.pts) : s.pct * ptPx(f, gapPt), 0, MAX_COORD);
  const before = space(ir.spaceBefore);
  if (before) out.spaceBeforePx = before;
  const after = space(ir.spaceAfter);
  if (after) out.spaceAfterPx = after;
  const ls = ir.lineSpacing;
  if (ls && 'pts' in ls) out.lineSpacingPx = bound(ptPx(f, ls.pts), 0, MAX_COORD);
  else {
    const pct = ls && ls.pct > 0 ? ls.pct : 1;
    if (Math.abs(SINGLE_LINE * pct - box.lineHeight) > 1e-6) out.lineSpacing = bound(pct, 0, 13.2);
  }
  const bullet = bulletOf(ir.bullet, ir.bulletNone === true, mainPt, log);
  if (bullet !== undefined) out.bullet = bullet;
  if (ir.rtl !== (box.direction === 'rtl')) out.rtl = ir.rtl;
  for (const _ in out) return out;
  return null;
}

/** A paragraph's main size in points: its first run without a baseline shift, else its first, else its end. */
function mainSize(p: Para): number {
  let first: number | undefined;
  for (const r of p.runs) {
    if (r.kind === 'break' || !r.text) continue;
    first ??= r.style.sizePt;
    if (!r.style.baseline) return r.style.sizePt;
  }
  return first ?? p.end.sizePt;
}

/** A paragraph's largest run size in points (its a:br marks aside), else its end mark's for an empty one. */
function largestSize(p: Para): number {
  let most: number | undefined;
  for (const r of p.runs)
    if (r.kind !== 'break' && r.text && (most === undefined || r.style.sizePt > most)) most = r.style.sizePt;
  return most ?? p.end.sizePt;
}

/** `TextPara.bullet` from the IR's: undefined (none set), null (`a:buNone`) or the bullet. */
function bulletOf(
  b: Bullet | undefined,
  none: boolean,
  mainPt: number,
  log: Log,
): TextPara['bullet'] | undefined {
  if (!b) return none ? null : undefined;
  if (b.kind === 'picture') {
    log('picture bullets are drawn as •');
    return { char: PICTURE_BULLET };
  }
  const out: NonNullable<TextPara['bullet']> = {};
  if (b.kind === 'char') {
    const mapped = isSymbolFont(b.font) ? symbolFontChar(b.font, b.char) : null;
    // A private-use character of any other font (an icon font, a symbol font ordo has no table for) is
    // nothing an output font draws: '•' in the text's font, as for an unknown symbol code.
    const pua = mapped === null && [...b.char].some((c) => isPrivateUse(c.codePointAt(0)!));
    const text = mapped ?? (pua ? PICTURE_BULLET : b.char);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a bullet is never a control character
    const ch = text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 8);
    out.char = ch || PICTURE_BULLET;
    if (b.font && mapped === null && !pua) out.fontFamily = b.font.slice(0, 300);
  } else {
    out.auto = b.scheme.slice(0, 40);
    if (b.startAt !== 1) out.startAt = Math.min(32_767, Math.max(1, Math.floor(b.startAt)));
    if (b.font && !isSymbolFont(b.font)) out.fontFamily = b.font.slice(0, 300);
  }
  if (b.color) out.color = ordo(b.color);
  const pct = b.sizePct ?? (b.sizePt !== undefined && mainPt > 0 ? b.sizePt / mainPt : undefined);
  if (pct !== undefined && Math.abs(pct - 1) > 1e-6) out.sizePct = bound(pct, 0.1, 4);
  return out;
}

// ── Numbers and colours ─────────────────────────────────────────────────────────────────────────────────

/** `v` within [lo, hi]; NaN and infinities become `lo` clamped to 0. */
function bound(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : Math.min(hi, Math.max(lo, 0));
}

function ordo(c: { r: number; g: number; b: number; a: number }): OrdoRgba {
  const ch = (v: number) => (Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : 0);
  return { r: ch(c.r), g: ch(c.g), b: ch(c.b), a: Number.isFinite(c.a) ? Math.min(1, Math.max(0, c.a)) : 1 };
}
