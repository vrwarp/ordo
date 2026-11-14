/**
 * Text bodies (design/27 §4 "Text bodies", "Fonts", "Run properties").
 *
 * Every value is the effective one, the chain resolved:
 * - Run properties: the run's own `a:rPr`, then each `a:defRPr` along the paragraph chain (`inherit.ts`),
 *   with the shape's `p:style/a:fontRef` (colour and major/minor font) between the shape's own list styles
 *   and the master's text styles / the presentation's defaultTextStyle; then the theme (+mj-lt for title
 *   placeholders, +mn-lt otherwise; colour tx1). The nearest fill decides, so an own solidFill or noFill
 *   overrides an inherited gradient; the nearest `a:ln` is the text outline, the nearest `a:effectLst` the
 *   text shadow.
 * - Paragraph properties: the nearest value along the paragraph's own pPr and its chain; the nearest
 *   `a:buNone`/`a:buChar`/`a:buAutoNum`/`a:buBlip` decides the bullet.
 * - Body properties: each attribute from the nearest `a:bodyPr` along own → layout → master; the nearest
 *   body that says how text fits decides the policy, but a stored `normAutofit` scale (fontScale,
 *   lnSpcReduction) is taken from the shape's own `a:bodyPr` only: a layout's or master's was computed for
 *   their prompt text, not the slide's (LibreOffice ignores an inherited autofit altogether).
 *
 * Owned by work item C (inherit-emit).
 */
import { type ColorCtx, colorIn, fillElementOf, fillOf, readFill } from './color.ts';
import type { SlideCtx } from './context.ts';
import {
  bodyPrChain,
  type Chain,
  firstAttr,
  firstChildOf,
  firstOfAny,
  isTitle,
  paraChainParts,
} from './inherit.ts';
import type { Bullet, Fill, Line, Para, Run, RunStyle, Shadow, Spacing, TextBody } from './ir.ts';
import { langScript, themeFont, typefaceName } from './theme.ts';
import { child, num, path, textOf, type XNode } from './xml.ts';

/** PowerPoint's default text size when nothing in the chain sets one. */
export const DEFAULT_SIZE_PT = 18;
/** Font sizes are clamped to this range in points (design/27 §12). */
export const MIN_SIZE_PT = 1;
export const MAX_SIZE_PT = 4_000;
/** Default body insets in EMU: 0.1 in left and right, 0.05 in top and bottom. */
export const DEFAULT_INSETS = { l: 91_440, t: 45_720, r: 91_440, b: 45_720 } as const;
/** PowerPoint's text outline width when an `a:ln` sets none: 0.75 pt. */
export const DEFAULT_OUTLINE_EMU = 9_525;
/** Bound of EMU lengths read from text and effects (a slide side, design/27 §12). */
const MAX_EMU = 51_206_400;

const ALIGN: Record<string, Para['align']> = Object.assign(Object.create(null), {
  l: 'left',
  ctr: 'center',
  r: 'right',
  just: 'justify',
  justLow: 'justify',
  dist: 'distribute',
  thaiDist: 'distribute',
});

const ANCHOR: Record<string, TextBody['anchor']> = Object.assign(Object.create(null), {
  t: 'top',
  ctr: 'middle',
  b: 'bottom',
  just: 'middle',
  dist: 'middle',
});

const BULLETS = ['a:buNone', 'a:buChar', 'a:buAutoNum', 'a:buBlip'] as const;
/** Theme script tags written with the East Asian font (`langScript`); the others use the complex-script one. */
const EA_SCRIPTS: ReadonlySet<string> = new Set(['Jpan', 'Hang', 'Hans', 'Hant', 'Yiii']);
const FITS = ['a:normAutofit', 'a:spAutoFit', 'a:noAutofit'] as const;

const on = (v: string | undefined) => v === '1' || v === 'true';
const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
const emu = (v: number | undefined, dflt: number) => clamp(v ?? dflt, 0, MAX_EMU);
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
/**
 * Fills ordo does not paint text with: a picture (`a:blipFill`) and the group's fill (`a:grpFill`, which means
 * nothing on text). The nearest fill of a run's chain being one of them gives the run the text colour, as no
 * fill would (tx1; design/27 §4 "Picture-filled text"), and keeps its outline.
 */
const TEXT_COLOUR_FILLS: Readonly<Record<string, RunStyle['textFill']>> = Object.assign(Object.create(null), {
  'a:blipFill': 'picture',
  'a:grpFill': 'group',
});

/**
 * A shape's text body with inheritance resolved, or undefined when it has none. `styled` (a table cell's
 * text style, `tables.ts`) is an `a:pPr` whose `a:defRPr` takes the place of the shape's `p:style/a:fontRef`
 * in the chain: after the body's own list style, before the presentation's defaults.
 */
export function readTextBody(ctx: SlideCtx, c: Chain, styled?: XNode): TextBody | undefined {
  const txBody = child(c.own, 'p:txBody');
  if (!txBody) return undefined;
  const body = bodyPrChain(c);
  const ins = (k: string, d: number) => emu(num(firstAttr(body, k)), d);
  const fontRef = styled ?? fontRefNode(ctx, c);
  const paras: Para[] = [];
  for (const p of txBody.children) if (p.name === 'a:p') paras.push(readPara(ctx, c, p, fontRef));
  const out: TextBody = {
    paras,
    insets: {
      l: ins('lIns', DEFAULT_INSETS.l),
      t: ins('tIns', DEFAULT_INSETS.t),
      r: ins('rIns', DEFAULT_INSETS.r),
      b: ins('bIns', DEFAULT_INSETS.b),
    },
    anchor: ANCHOR[firstAttr(body, 'anchor') ?? 't'] ?? 'top',
    wrap: firstAttr(body, 'wrap') !== 'none',
    autofit: autofitOf(firstOfAny(body, FITS), path(c.own, 'p:txBody', 'a:bodyPr')),
  };
  const vert = firstAttr(body, 'vert');
  if (vert !== undefined && vert !== 'horz') out.vert = vert;
  const numCol = num(firstAttr(body, 'numCol'));
  if (numCol !== undefined && numCol > 1) out.numCol = Math.min(16, Math.floor(numCol));
  if (on(firstAttr(body, 'anchorCtr'))) out.anchorCtr = anchorCtrMoves(out);
  const warp = firstChildOf(body, 'a:prstTxWarp')?.attrs.prst;
  if (warp && warp !== 'textNoShape') out.warp = { preset: warp };
  return out;
}

/**
 * Whether `anchorCtr` moves any of a body's text. It centres the text block, as wide as its widest line
 * and still wrapped at the box width, in the box (LibreOffice: horizontal adjust CENTER instead of BLOCK).
 * A centre-aligned line lies at the same distance from the middle of a block of any width (half its margin
 * and indent), so when every paragraph that draws something is centred, each line is where it would be
 * without `anchorCtr`. Not with columns: their block can be narrower than all the columns.
 */
function anchorCtrMoves(body: TextBody): boolean {
  return (body.numCol ?? 1) > 1 || body.paras.some((p) => p.align !== 'center' && drawsSomething(p));
}

/**
 * Whether a paragraph draws anything: a field (PowerPoint fills in its value), or text with a character
 * other than white space, or white space that a bullet, underline, strikethrough or highlight shows.
 */
function drawsSomething(p: Para): boolean {
  return p.runs.some(
    (r) =>
      r.kind === 'field' ||
      (r.kind === 'text' &&
        r.text !== '' &&
        (/\S/u.test(r.text) ||
          p.bullet !== undefined ||
          r.style.underline ||
          r.style.strike ||
          r.style.highlight !== undefined)),
  );
}

/**
 * How a body's text fits: the nearest fit element decides the policy; the stored scale of a `normAutofit`
 * counts only on the shape's own `a:bodyPr` (an inherited one shrinks from full size).
 */
function autofitOf(fit: XNode | undefined, ownBodyPr: XNode | undefined): TextBody['autofit'] {
  if (fit?.name === 'a:spAutoFit') return { kind: 'shape' };
  if (fit?.name !== 'a:normAutofit') return { kind: 'none' };
  const own = ownBodyPr !== undefined && firstOfAny([ownBodyPr], FITS) === fit;
  if (!own) return { kind: 'shrink', fontScale: 1, lnSpcReduction: 0 };
  const fontScale = clamp((num(fit.attrs.fontScale) ?? 100_000) / 100_000, 0.01, 1);
  const lnSpcReduction = clamp((num(fit.attrs.lnSpcReduction) ?? 0) / 100_000, 0, 0.9);
  return { kind: 'shrink', fontScale, lnSpcReduction, own };
}

/**
 * The shape's `p:style/a:fontRef` as a paragraph-property node of the chain: its colour as a solid fill and
 * its font collection (`idx` major or minor) as the Latin, East Asian and complex-script typefaces.
 */
function fontRefNode(ctx: SlideCtx, c: Chain): XNode | undefined {
  const ref = child(child(c.own, 'p:style'), 'a:fontRef');
  if (!ref) return undefined;
  const props: XNode[] = [];
  const color = colorIn(ref, ctx.color);
  if (color) props.push(el('a:solidFill', {}, [el('a:srgbClr', { val: hex(color) }, alphaOf(color))]));
  const set = ref.attrs.idx === 'major' ? 'mj' : ref.attrs.idx === 'minor' ? 'mn' : undefined;
  if (set)
    for (const s of ['latin', 'ea', 'cs'])
      props.push(el(`a:${s}`, { typeface: `+${set}-${s === 'latin' ? 'lt' : s}` }));
  return props.length ? el('a:pPr', {}, [el('a:defRPr', {}, props)]) : undefined;
}

function el(name: string, attrs: Record<string, string>, children: XNode[] = []): XNode {
  return { name, attrs: Object.assign(Object.create(null), attrs), children, text: '' };
}

function hex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function alphaOf(c: { a: number }): XNode[] {
  return c.a < 1 ? [el('a:alpha', { val: String(Math.round(clamp(c.a, 0, 1) * 100_000)) })] : [];
}

function readPara(ctx: SlideCtx, c: Chain, p: XNode, fontRef: XNode | undefined): Para {
  const pPr = child(p, 'a:pPr');
  const level = clamp(Math.floor(num(pPr?.attrs.lvl) ?? 0), 0, 8);
  const { local, styles } = paraChainParts(ctx, c, level);
  const chain: (XNode | undefined)[] = [pPr, ...local, ...(fontRef ? [fontRef] : []), ...styles];
  const runs: Run[] = [];
  for (const r of p.children) {
    if (r.name === 'a:r' || r.name === 'a:fld')
      runs.push({
        kind: r.name === 'a:r' ? 'text' : 'field',
        text: textOf(child(r, 'a:t')),
        style: runStyle(ctx, c, child(r, 'a:rPr'), chain),
      });
    else if (r.name === 'a:br')
      runs.push({ kind: 'break', text: '\n', style: runStyle(ctx, c, child(r, 'a:rPr'), chain) });
  }
  const out: Para = {
    runs,
    align: ALIGN[firstAttr(chain, 'algn') ?? 'l'] ?? 'left',
    level,
    marL: clamp(num(firstAttr(chain, 'marL')) ?? 0, -MAX_EMU, MAX_EMU),
    indent: clamp(num(firstAttr(chain, 'indent')) ?? 0, -MAX_EMU, MAX_EMU),
    rtl: on(firstAttr(chain, 'rtl')),
    end: runStyle(ctx, c, child(p, 'a:endParaRPr'), chain),
  };
  const before = spacingOf(chain, 'a:spcBef');
  if (before) out.spaceBefore = before;
  const after = spacingOf(chain, 'a:spcAft');
  if (after) out.spaceAfter = after;
  const line = spacingOf(chain, 'a:lnSpc');
  if (line) out.lineSpacing = line;
  const bullet = bulletOf(ctx, chain);
  if (bullet) out.bullet = bullet;
  else if (firstOfAny(chain, BULLETS)?.name === 'a:buNone') out.bulletNone = true;
  return out;
}

/** `a:spcBef`, `a:spcAft` or `a:lnSpc`: the nearest one decides (an explicit zero overrides). */
function spacingOf(chain: readonly (XNode | undefined)[], name: string): Spacing | undefined {
  const s = firstChildOf(chain, name);
  const pts = num(child(s, 'a:spcPts')?.attrs.val);
  if (pts !== undefined) return { pts: clamp(pts / 100, 0, 1_584) };
  const pct = num(child(s, 'a:spcPct')?.attrs.val);
  if (pct !== undefined) return { pct: clamp(pct / 100_000, 0, 13.2) };
  return undefined;
}

/** The effective bullet: the nearest bullet element decides; `a:buNone` (or none anywhere) is no bullet. */
function bulletOf(ctx: SlideCtx, chain: readonly (XNode | undefined)[]): Bullet | undefined {
  const b = firstOfAny(chain, BULLETS);
  if (!b || b.name === 'a:buNone') return undefined;
  if (b.name === 'a:buBlip') return { kind: 'picture' };
  const extra: { font?: string; color?: Para['end']['highlight']; sizePct?: number; sizePt?: number } = {};
  const font = firstOfAny(chain, ['a:buFont', 'a:buFontTx']);
  const face = font?.name === 'a:buFont' ? themeFont(ctx.theme, font.attrs.typeface) : undefined;
  if (face) extra.font = face;
  const clr = firstOfAny(chain, ['a:buClr', 'a:buClrTx']);
  const color = clr?.name === 'a:buClr' ? colorIn(clr, ctx.color) : undefined;
  if (color) extra.color = color;
  const sz = firstOfAny(chain, ['a:buSzPct', 'a:buSzPts', 'a:buSzTx']);
  const pct = sz?.name === 'a:buSzPct' ? num(sz.attrs.val) : undefined;
  if (pct !== undefined) extra.sizePct = clamp(pct / 100_000, 0.25, 4);
  const pts = sz?.name === 'a:buSzPts' ? num(sz.attrs.val) : undefined;
  if (pts !== undefined) extra.sizePt = clamp(pts / 100, MIN_SIZE_PT, MAX_SIZE_PT);
  if (b.name === 'a:buAutoNum')
    return {
      kind: 'auto',
      scheme: (b.attrs.type ?? 'arabicPeriod').slice(0, 40),
      startAt: clamp(Math.floor(num(b.attrs.startAt) ?? 1), 1, 32_767),
      ...extra,
    };
  const ch = String.fromCodePoint((b.attrs.char || '•').codePointAt(0)!); // the first character only
  return { kind: 'char', char: ch, ...extra };
}

/**
 * A run's effective properties: its own `a:rPr`, then each `a:defRPr` along the paragraph chain, then the
 * theme (+mj-lt for title placeholders, +mn-lt otherwise; text colour tx1).
 */
export function runStyle(
  ctx: SlideCtx,
  c: Chain,
  rPr: XNode | undefined,
  chain: readonly (XNode | undefined)[],
): RunStyle {
  const props = [rPr, ...chain.map((n) => child(n, 'a:defRPr'))];
  // The nearest fill decides; a picture or group fill there gives the text colour (`TEXT_COLOUR_FILLS`).
  let fill: Fill | undefined;
  let textFill: RunStyle['textFill'];
  for (const n of props) {
    const el = fillElementOf(n);
    if (!el) continue;
    textFill = TEXT_COLOUR_FILLS[el.name];
    if (!textFill) fill = fillOf(el, ctx.color);
    break;
  }
  const face = (kind: 'latin' | 'ea' | 'cs' | 'sym') => {
    for (const n of props) {
      const t = typefaceName(child(n, `a:${kind}`)?.attrs.typeface);
      if (t) return t;
    }
    return undefined;
  };
  const theme = isTitle(c.ph) ? '+mj' : '+mn';
  const size = num(firstAttr(props, 'sz')) ?? DEFAULT_SIZE_PT * 100;
  const tx1 = ctx.color.scheme.get(ctx.color.map.get('tx1') ?? 'dk1');
  const cap = firstAttr(props, 'cap');
  const out: RunStyle = {
    sizePt: clamp(size / 100, MIN_SIZE_PT, MAX_SIZE_PT),
    bold: on(firstAttr(props, 'b')),
    italic: on(firstAttr(props, 'i')),
    underline: (firstAttr(props, 'u') ?? 'none') !== 'none',
    strike: (firstAttr(props, 'strike') ?? 'noStrike') !== 'noStrike',
    fill: fill ?? { kind: 'solid', color: tx1 ?? BLACK },
    baseline: clamp((num(firstAttr(props, 'baseline')) ?? 0) / 100_000, -1, 1),
    spacingPt: clamp((num(firstAttr(props, 'spc')) ?? 0) / 100, -4_000, 4_000),
    caps: cap === 'all' ? 'all' : cap === 'small' ? 'small' : 'none',
  };
  if (textFill) {
    out.textFill = textFill;
    ctx.log(
      `${textFill === 'picture' ? 'picture-filled text' : 'text with a group fill'} is drawn in the text colour`,
    );
  }
  const lang = firstAttr(props, 'lang');
  // An empty ea or cs typeface of the theme takes the theme's font for the run language's script.
  const script = langScript(lang);
  const asian = script !== undefined && EA_SCRIPTS.has(script);
  const latin = themeFont(ctx.theme, face('latin') ?? `${theme}-lt`);
  if (latin) out.latin = latin;
  const ea = themeFont(ctx.theme, face('ea') ?? `${theme}-ea`, asian ? script : undefined);
  if (ea) out.ea = ea;
  const cs = themeFont(ctx.theme, face('cs') ?? `${theme}-cs`, asian ? undefined : script);
  if (cs) out.cs = cs;
  const sym = themeFont(ctx.theme, face('sym'));
  if (sym) out.sym = sym;
  const outline = textOutline(ctx, firstChildOf(props, 'a:ln'));
  if (outline) out.outline = outline;
  const shadow = readShadow(child(firstChildOf(props, 'a:effectLst'), 'a:outerShdw'), ctx.color);
  if (shadow) out.shadow = shadow;
  if (lang) out.lang = lang.slice(0, 35);
  const highlight = colorIn(firstChildOf(props, 'a:highlight'), ctx.color);
  if (highlight) out.highlight = highlight;
  return out;
}

/** A text outline (`a:ln` in run properties); undefined when it draws nothing (no fill, or noFill). */
function textOutline(ctx: SlideCtx, ln: XNode | undefined): Line | undefined {
  if (!ln) return undefined;
  const fill = readFill(ln, ctx.color);
  if (!fill || fill.kind === 'none') return undefined;
  return { width: emu(num(ln.attrs.w), DEFAULT_OUTLINE_EMU), fill };
}

/** An `a:outerShdw` (of an effect list), its colour resolved; black when it names none. */
export function readShadow(sh: XNode | undefined, color: ColorCtx): Shadow | undefined {
  if (!sh) return undefined;
  return {
    dist: emu(num(sh.attrs.dist), 0),
    blur: emu(num(sh.attrs.blurRad), 0),
    dir: clamp((num(sh.attrs.dir) ?? 0) / 60_000, -36_000, 36_000),
    color: colorIn(sh, color) ?? BLACK,
  };
}

/** The plain text of a body: paragraphs joined by '\n' (breaks are '\n' too). */
export function plainText(body: TextBody): string {
  return body.paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
}

/** Characters of a body's runs (breaks not counted): 0 means an empty body (prompt text only). */
export function textChars(body: TextBody | undefined): number {
  let n = 0;
  for (const p of body?.paras ?? []) for (const r of p.runs) if (r.kind !== 'break') n += r.text.length;
  return n;
}
