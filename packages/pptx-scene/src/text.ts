/**
 * Text bodies (design/27 §4 "Text bodies", "Fonts", "Run properties").
 *
 * Owned by work item C (inherit-emit). The scaffold reads paragraphs and runs with size, bold, italic, a
 * solid colour and the Latin typeface through the chain, alignment, insets, anchor and wrap. Still to do for
 * M1: lnSpcPct, outline (w/2), outer shadow, underline, caps, `p:style` fontRef colours; then (M2) spacing,
 * bullets and numbering, marL/indent, rtl, baseline, autofit scales.
 */
import { readFill } from './color.ts';
import type { SlideCtx } from './context.ts';
import { type Chain, bodyPrChain, firstAttr, isTitle, paraChain } from './inherit.ts';
import type { Fill, Para, Run, RunStyle, TextBody } from './ir.ts';
import { themeFont } from './theme.ts';
import { child, num, textOf, type XNode } from './xml.ts';

/** PowerPoint's default text size when nothing in the chain sets one. */
export const DEFAULT_SIZE_PT = 18;
/** Font sizes are clamped to this range in points (design/27 §12). */
export const MIN_SIZE_PT = 1;
export const MAX_SIZE_PT = 4_000;

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

const on = (v: string | undefined) => v === '1' || v === 'true';

/** A shape's text body with inheritance resolved, or undefined when it has none. */
export function readTextBody(ctx: SlideCtx, c: Chain): TextBody | undefined {
  const txBody = child(c.own, 'p:txBody');
  if (!txBody) return undefined;
  const body = bodyPrChain(c);
  const ins = (k: string, d: number) => num(firstAttr(body, k)) ?? d;
  const paras: Para[] = [];
  for (const p of txBody.children) if (p.name === 'a:p') paras.push(readPara(ctx, c, p));
  return {
    paras,
    insets: {
      l: ins('lIns', 91_440),
      t: ins('tIns', 45_720),
      r: ins('rIns', 91_440),
      b: ins('bIns', 45_720),
    },
    anchor: ANCHOR[firstAttr(body, 'anchor') ?? 't'] ?? 'top',
    wrap: firstAttr(body, 'wrap') !== 'none',
    autofit: { kind: 'none' },
  };
}

function readPara(ctx: SlideCtx, c: Chain, p: XNode): Para {
  const pPr = child(p, 'a:pPr');
  const level = Math.min(8, Math.max(0, num(pPr?.attrs.lvl) ?? 0));
  const chain = [pPr, ...paraChain(ctx, c, level)];
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
  return {
    runs,
    align: ALIGN[firstAttr(chain, 'algn') ?? 'l'] ?? 'left',
    level,
    marL: num(firstAttr(chain, 'marL')) ?? 0,
    indent: num(firstAttr(chain, 'indent')) ?? 0,
    rtl: on(firstAttr(chain, 'rtl')),
    end: runStyle(ctx, c, child(p, 'a:endParaRPr'), chain),
  };
}

/**
 * A run's effective properties: its own `a:rPr`, then each `a:defRPr` along the paragraph chain, then the
 * theme (+mj-lt for title placeholders, +mn-lt otherwise; text colour tx1).
 */
export function runStyle(
  ctx: SlideCtx,
  c: Chain,
  rPr: XNode | undefined,
  chain: (XNode | undefined)[],
): RunStyle {
  const props = [rPr, ...chain.map((n) => child(n, 'a:defRPr'))];
  let fill: Fill | undefined;
  for (const n of props) {
    fill = readFill(n, ctx.color);
    if (fill) break;
  }
  const latinRef = props.map((n) => child(n, 'a:latin')?.attrs.typeface).find((t) => t);
  const size = (num(firstAttr(props, 'sz')) ?? DEFAULT_SIZE_PT * 100) / 100;
  const tx1 = ctx.color.scheme.get(ctx.color.map.get('tx1') ?? 'dk1');
  return {
    sizePt: Math.min(MAX_SIZE_PT, Math.max(MIN_SIZE_PT, size)),
    bold: on(firstAttr(props, 'b')),
    italic: on(firstAttr(props, 'i')),
    underline: (firstAttr(props, 'u') ?? 'none') !== 'none',
    strike: (firstAttr(props, 'strike') ?? 'noStrike') !== 'noStrike',
    fill:
      fill ?? (tx1 ? { kind: 'solid', color: tx1 } : { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }),
    latin: themeFont(ctx.theme, latinRef ?? (isTitle(c.ph) ? '+mj-lt' : '+mn-lt')),
    baseline: (num(firstAttr(props, 'baseline')) ?? 0) / 100_000,
    spacingPt: (num(firstAttr(props, 'spc')) ?? 0) / 100,
    caps: firstAttr(props, 'cap') === 'all' ? 'all' : firstAttr(props, 'cap') === 'small' ? 'small' : 'none',
  };
}

/** The plain text of a body: paragraphs joined by '\n' (breaks are '\n' too). */
export function plainText(body: TextBody): string {
  return body.paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
}
