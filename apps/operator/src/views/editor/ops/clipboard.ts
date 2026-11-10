import {
  newId,
  replaceText,
  type Presentation,
  type Rgba,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextPara,
  type TextRun,
  type TextStyle,
} from '@ordo/domain';
import { withSlide } from './common.ts';
import { MAX_OBJECTS } from './group.ts';
import { type ParaPatch, type RunPatch, type RunStyle, RUN_FIELDS, VISUAL_RUN_FIELDS } from './text.ts';

/*
 * Rich clipboard operations across three layers:
 * 1. Intra-Ordo lossless rich text copy/cut/paste (`sliceRichText`, `pasteRichText`, `data-ordo-rich`).
 * 2. Cross-application HTML <-> Ordo rich text conversion (`richTextToHtml`, `htmlToRichText`).
 * 3. Slide canvas object & image copy/cut/paste (`serializeObjectsToHtml`, `parseObjectsFromHtml`, `pasteObjects`).
 */

export type RichTextSlice = {
  text: string;
  runs?: TextRun[];
  paras?: (TextPara | null)[];
};

const MAX_RUNS = 2000;
const MAX_PARAS = 5000;
const MAX_GROUP = 100_000;
const COORD = 100_000;

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const inPair = (s: string, i: number) =>
  i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i));

function span(text: string, start: number, end: number): [number, number] {
  const c = (v: number) => (fin(v) ? clampN(Math.round(v), 0, text.length) : 0);
  let a = Math.min(c(start), c(end));
  let b = Math.max(c(start), c(end));
  if (inPair(text, a)) a--;
  if (inPair(text, b)) b++;
  return [a, b];
}

function newlines(s: string, start = 0, end = s.length): number {
  let n = 0;
  for (let i = s.indexOf('\n', start); i >= 0 && i < end; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

function same(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  const a = x as Record<string, unknown>;
  const b = y as Record<string, unknown>;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
}

function fieldsOf(r: TextRun): RunStyle {
  const f: Record<string, unknown> = {};
  for (const k of RUN_FIELDS) if (r[k] !== undefined) f[k] = r[k];
  return f as RunStyle;
}

function validRuns(runs: readonly TextRun[], len: number): TextRun[] {
  const out: TextRun[] = [];
  let at = 0;
  for (const r of runs) {
    if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end)) continue;
    if (r.start < at || r.start >= len || r.end <= r.start) continue;
    out.push(r.end > len ? { ...r, end: len } : r);
    at = Math.min(r.end, len);
  }
  return out;
}

function normalizeRuns(runs: readonly TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    if (r.end <= r.start || !RUN_FIELDS.some((k) => r[k] !== undefined)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.end === r.start && RUN_FIELDS.every((k) => same(prev[k], r[k])))
      out[out.length - 1] = { ...prev, end: r.end };
    else out.push(r);
  }
  return out;
}

function trimParas(paras: (TextPara | null)[]): (TextPara | null)[] {
  let n = Math.min(paras.length, MAX_PARAS);
  while (n > 0 && paras[n - 1] == null) n--;
  return paras.slice(0, n);
}

const BAD = Symbol('bad');

function cleanRgba(v: unknown): Rgba | typeof BAD {
  if (!v || typeof v !== 'object') return BAD;
  const c = v as Record<string, unknown>;
  if (!fin(c.r) || !fin(c.g) || !fin(c.b) || !fin(c.a)) return BAD;
  return {
    r: Math.round(clampN(c.r, 0, 255)),
    g: Math.round(clampN(c.g, 0, 255)),
    b: Math.round(clampN(c.b, 0, 255)),
    a: clampN(c.a, 0, 1),
  };
}

function cleanRunFields(raw: RunPatch): RunStyle {
  const out: Record<string, unknown> = {};
  for (const k of RUN_FIELDS) {
    const v = raw[k];
    if (v === undefined) continue;
    switch (k) {
      case 'fontFamily':
        if (typeof v === 'string' && v.trim() && v.length <= 300) out[k] = v.trim();
        break;
      case 'lang':
        if (typeof v === 'string' && v.trim() && v.length <= 35) out[k] = v.trim();
        break;
      case 'fontWeight':
        if (fin(v)) out[k] = clampN(v, 0, 1000);
        break;
      case 'fontStyle':
        if (v === 'normal' || v === 'italic') out[k] = v;
        break;
      case 'sizeScale':
        if (fin(v) && v > 0 && Math.abs(v - 1) >= 1e-9) out[k] = clampN(v, 0.01, 50);
        break;
      case 'baseline':
        if (fin(v) && v !== 0) out[k] = clampN(v, -1, 1);
        break;
      case 'letterSpacing':
        if (fin(v)) out[k] = clampN(v, -1000, 1000);
        break;
      case 'color':
      case 'highlight': {
        const c = cleanRgba(v);
        if (c !== BAD) out[k] = c;
        break;
      }
      case 'underline':
      case 'strike':
        if (typeof v === 'boolean') out[k] = v;
        break;
      case 'caps':
        if (v === 'none' || v === 'all' || v === 'small') out[k] = v;
        break;
      case 'outline':
        if (v === null) out[k] = null;
        else if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          const color = cleanRgba(o.color);
          if (fin(o.width) && color !== BAD) out[k] = { width: clampN(o.width, 0, COORD), color };
        }
        break;
      case 'shadow':
        if (v === null) out[k] = null;
        else if (v && typeof v === 'object') {
          const s = v as Record<string, unknown>;
          const color = cleanRgba(s.color);
          if (fin(s.dx) && fin(s.dy) && fin(s.blur) && color !== BAD) {
            out[k] = {
              dx: clampN(s.dx, -COORD, COORD),
              dy: clampN(s.dy, -COORD, COORD),
              blur: clampN(s.blur, 0, COORD),
              color,
            };
          }
        }
        break;
    }
  }
  return out as RunStyle;
}

const ALIGNS = ['left', 'center', 'right', 'justify', 'distribute'];

function cleanPara(raw: ParaPatch | null | undefined, allowSoft: boolean): TextPara | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, unknown> = {};
  if (typeof raw.align === 'string' && ALIGNS.includes(raw.align)) out.align = raw.align;
  if (fin(raw.level)) out.level = clampN(Math.round(raw.level), 0, 8);
  if (fin(raw.indentPx)) out.indentPx = clampN(raw.indentPx, -COORD, COORD);
  if (fin(raw.firstLinePx)) out.firstLinePx = clampN(raw.firstLinePx, -COORD, COORD);
  if (fin(raw.spaceBeforePx)) out.spaceBeforePx = clampN(raw.spaceBeforePx, 0, COORD);
  if (fin(raw.spaceAfterPx)) out.spaceAfterPx = clampN(raw.spaceAfterPx, 0, COORD);
  if (fin(raw.lineSpacingPx)) out.lineSpacingPx = clampN(raw.lineSpacingPx, 0, COORD);
  else if (fin(raw.lineSpacing)) out.lineSpacing = clampN(raw.lineSpacing, 0, 13.2);
  if (raw.bullet === null) out.bullet = null;
  else if (raw.bullet && typeof raw.bullet === 'object') {
    const b = raw.bullet as Record<string, unknown>;
    const cleanB: NonNullable<TextPara['bullet']> = {};
    if (typeof b.char === 'string' && b.char && b.char.length <= 8) cleanB.char = b.char;
    if (typeof b.auto === 'string' && b.auto && b.auto.length <= 40) cleanB.auto = b.auto;
    if (fin(b.startAt)) cleanB.startAt = clampN(Math.round(b.startAt), 1, 32_767);
    if (typeof b.fontFamily === 'string' && b.fontFamily.trim() && b.fontFamily.length <= 300)
      cleanB.fontFamily = b.fontFamily.trim();
    const c = cleanRgba(b.color);
    if (c !== BAD) cleanB.color = c;
    if (fin(b.sizePct)) cleanB.sizePct = clampN(b.sizePct, 0.1, 4);
    out.bullet = cleanB;
  }
  if (typeof raw.rtl === 'boolean') out.rtl = raw.rtl;
  if (typeof raw.hidden === 'boolean') out.hidden = raw.hidden;
  if (allowSoft && raw.soft === true) out.soft = true;
  return Object.keys(out).length ? (out as TextPara) : null;
}

// ---- Layer 1: Lossless Rich Text Slice & Splice ---------------------------------------------------------

/**
 * Extract the selected `[start, end)` substring along with its 0-indexed `runs` and `paras`.
 */
export function sliceRichText(
  o: Pick<TextObject, 'text' | 'runs' | 'paras'>,
  start: number,
  end: number,
): RichTextSlice {
  const [a, b] = span(o.text, start, end);
  if (a >= b) return { text: '' };
  const text = o.text.slice(a, b);
  const valid = validRuns(o.runs ?? [], o.text.length);
  const runs: TextRun[] = [];
  for (const r of valid) {
    if (r.end <= a || r.start >= b) continue;
    const s = Math.max(r.start, a) - a;
    const e = Math.min(r.end, b) - a;
    if (e > s) runs.push({ ...fieldsOf(r), start: s, end: e });
  }
  const normRuns = normalizeRuns(runs);

  const firstPara = newlines(o.text, 0, a);
  const count = newlines(text) + 1;
  const oldParas = o.paras ?? [];
  const paras: (TextPara | null)[] = [];
  for (let i = 0; i < count; i++) {
    const pIdx = firstPara + i;
    const cur = oldParas[pIdx] ?? null;
    if (i === 0 && cur?.soft === true) {
      // Resolve soft line over its parent paragraph so the first paragraph of the slice is standalone.
      let h = pIdx - 1;
      while (h > 0 && oldParas[h]?.soft === true) h--;
      const parent = oldParas[h] ?? {};
      const { soft: _, ...rest } = cur;
      paras.push(cleanPara({ ...parent, ...rest }, false));
    } else {
      paras.push(cleanPara(cur, i > 0));
    }
  }
  const trimmedParas = trimParas(paras);
  return {
    text,
    runs: normRuns,
    ...(trimmedParas.length ? { paras: trimmedParas } : {}),
  };
}

/**
 * Splice `slice` into `o` in place of `[start, end)`, preserving rich runs and paragraph styles.
 */
export function pasteRichText(
  o: TextObject,
  start: number,
  end: number,
  slice: RichTextSlice,
): { object: TextObject; caret: number; overrides: string[] } {
  const [a, b] = span(o.text, start, end);
  const ins = slice.text ?? '';
  const caret = a + ins.length;
  if (a === b && !ins) return { object: o, caret: a, overrides: [] };

  // Plain-text paste (no runs or paras on the slice): delegate to domain `replaceText` so typing/pasting
  // plain text inside a styled run inherits that run's style.
  if (slice.runs === undefined && !slice.paras?.some(Boolean)) {
    return { object: replaceText(o, a, b, ins), caret, overrides: [] };
  }

  const base = replaceText(o, a, b, ins);
  const nextText = base.text;
  const delta = ins.length - (b - a);

  // Build spliced runs: [0, a) from `o`, [a, a + ins.length) from `slice.runs`, [b, end) from `o` shifted by delta.
  const oldRuns = validRuns(o.runs ?? [], o.text.length);
  const combined: TextRun[] = [];
  for (const r of oldRuns) {
    if (r.start >= a) break;
    const e = Math.min(r.end, a);
    if (e > r.start) combined.push({ ...fieldsOf(r), start: r.start, end: e });
  }

  const overridesSet = new Set<string>();
  const sliceRuns = slice.runs ?? [];
  let cursor = 0;
  for (const r of sliceRuns) {
    if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end)) continue;
    const s = Math.max(cursor, Math.max(0, r.start));
    const e = Math.min(ins.length, r.end);
    if (e <= s) continue;
    const cleaned = cleanRunFields(r);
    if (RUN_FIELDS.some((k) => cleaned[k] !== undefined)) {
      combined.push({ ...cleaned, start: a + s, end: a + e });
      for (const k of VISUAL_RUN_FIELDS) {
        if (cleaned[k] !== undefined) overridesSet.add(`runs.${k}`);
      }
    }
    cursor = e;
  }

  for (const r of oldRuns) {
    if (r.end <= b) continue;
    const s = Math.max(r.start, b) + delta;
    const e = r.end + delta;
    if (e > s) combined.push({ ...fieldsOf(r), start: s, end: e });
  }

  const normRuns = normalizeRuns(validRuns(combined, nextText.length));
  const out: TextObject = { ...base };
  if (o.runs !== undefined || normRuns.length > 0) {
    out.runs = normRuns.length <= MAX_RUNS ? normRuns : (base.runs ?? []);
  }

  // Merge paragraph styles when `slice.paras` has entries.
  if (slice.paras?.some(Boolean)) {
    const firstPara = newlines(o.text, 0, a);
    const sliceParaCount = newlines(ins) + 1;
    const totalParas = newlines(nextText) + 1;
    const baseParas = base.paras ?? [];
    const mergedParas: (TextPara | null)[] = Array.from(
      { length: totalParas },
      (_, i) => baseParas[i] ?? null,
    );
    const atLineStart = a === 0 || o.text.charCodeAt(a - 1) === 0x0a;
    for (let i = 0; i < sliceParaCount && firstPara + i < totalParas; i++) {
      const sp = slice.paras[i];
      if (!sp) continue;
      // Only apply paragraph 0's style if pasting at the start of a line or pasting multiple paragraphs.
      if (i === 0 && !atLineStart && sliceParaCount === 1) continue;
      const cleaned = cleanPara(sp, i > 0);
      if (cleaned) mergedParas[firstPara + i] = cleaned;
    }
    const trimmed = trimParas(mergedParas);
    if (trimmed.length || o.paras !== undefined) out.paras = trimmed;
  }

  return { object: out, caret, overrides: [...overridesSet] };
}

// ---- Layer 2: Cross-Application HTML <-> RichTextSlice --------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rgbaCss(c: Rgba): string {
  return c.a >= 1
    ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
    : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Number(c.a.toFixed(3))})`;
}

/**
 * Serialize a `RichTextSlice` to semantic HTML with an embedded `data-ordo-rich` attribute for lossless
 * round-tripping inside Ordo and clean rich pasting into Google Docs, Word, Keynote, and Notes.
 */
export function richTextToHtml(slice: RichTextSlice, baseStyle?: TextStyle): string {
  const payload = escapeHtml(JSON.stringify(slice));
  const lines = slice.text.split('\n');
  const runs = validRuns(slice.runs ?? [], slice.text.length);
  const htmlLines: string[] = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;

    // Slice runs covering [lineStart, lineEnd).
    const segments: string[] = [];
    let at = lineStart;
    const pushSeg = (s: number, e: number, f: RunStyle) => {
      const raw = slice.text.slice(s, e);
      if (!raw) return;
      let html = escapeHtml(raw);
      const styles: string[] = [];
      const fam = f.fontFamily ?? baseStyle?.fontFamily;
      if (fam) styles.push(`font-family: ${fam}`);
      if (f.sizeScale && Math.abs(f.sizeScale - 1) > 0.01) {
        styles.push(`font-size: ${Math.round(f.sizeScale * 100)}%`);
      }
      if (f.color) styles.push(`color: ${rgbaCss(f.color)}`);
      if (f.highlight) styles.push(`background-color: ${rgbaCss(f.highlight)}`);
      if (f.letterSpacing) styles.push(`letter-spacing: ${f.letterSpacing}px`);
      if (f.caps === 'all') styles.push('text-transform: uppercase');
      else if (f.caps === 'small') styles.push('font-variant: small-caps');

      if (styles.length) html = `<span style="${escapeHtml(styles.join('; '))}">${html}</span>`;
      if (f.strike) html = `<s>${html}</s>`;
      if (f.underline) html = `<u>${html}</u>`;
      if (f.fontStyle === 'italic') html = `<i>${html}</i>`;
      if (f.fontWeight !== undefined && f.fontWeight >= 600) html = `<b>${html}</b>`;
      if (f.baseline !== undefined && f.baseline > 0.05) html = `<sup>${html}</sup>`;
      else if (f.baseline !== undefined && f.baseline < -0.05) html = `<sub>${html}</sub>`;
      segments.push(html);
    };

    for (const r of runs) {
      if (r.end <= lineStart) continue;
      if (r.start >= lineEnd) break;
      const s = Math.max(r.start, lineStart);
      const e = Math.min(r.end, lineEnd);
      if (s > at) pushSeg(at, s, {});
      pushSeg(s, e, fieldsOf(r));
      at = e;
    }
    if (at < lineEnd) pushSeg(at, lineEnd, {});

    const inner = segments.length ? segments.join('') : '<br>';
    const para = slice.paras?.[i];
    const pStyles: string[] = ['margin: 0'];
    if (para?.align) pStyles.push(`text-align: ${para.align}`);
    if (para?.bullet && para.bullet !== null) {
      const prefix = para.bullet.char ? `${escapeHtml(para.bullet.char)} ` : '• ';
      htmlLines.push(`<p style="${escapeHtml(pStyles.join('; '))}">${prefix}${inner}</p>`);
    } else {
      htmlLines.push(`<p style="${escapeHtml(pStyles.join('; '))}">${inner}</p>`);
    }
  }

  return `<div data-ordo-rich="${payload}">${htmlLines.join('')}</div>`;
}

// ---- Lightweight, dependency-free HTML parser for cross-app paste --------------------------------------

type HtmlNode =
  | { type: 'text'; value: string }
  | { type: 'element'; tag: string; attrs: Record<string, string>; children: HtmlNode[] };

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  bull: '\u2022',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z0-9]+);/g, (full, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? (code === 160 ? ' ' : String.fromCodePoint(code)) : full;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? (code === 160 ? ' ' : String.fromCodePoint(code)) : full;
    }
    return ENTITIES[body.toLowerCase()] ?? full;
  });
}

function parseAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = re.exec(attrStr); m !== null; m = re.exec(attrStr)) {
    const name = m[1]!.toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[name] = decodeEntities(val);
  }
  return attrs;
}

function parseHtmlTree(html: string): HtmlNode[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<(script|style|head|title|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  const root: { tag: string; attrs: Record<string, string>; children: HtmlNode[] } = {
    tag: 'root',
    attrs: {},
    children: [],
  };
  const stack = [root];
  const tagRe = /<\/?([a-zA-Z0-9:-]+)\b([^>]*?)(\/?)>/g;
  let lastIndex = 0;

  for (let m = tagRe.exec(cleaned); m !== null; m = tagRe.exec(cleaned)) {
    if (m.index > lastIndex) {
      const text = decodeEntities(cleaned.slice(lastIndex, m.index));
      if (text) stack[stack.length - 1]!.children.push({ type: 'text', value: text });
    }
    lastIndex = tagRe.lastIndex;
    const full = m[0]!;
    const tag = m[1]!.toLowerCase();
    const isClose = full.startsWith('</');
    const isSelfClose = m[3] === '/' || VOID_TAGS.has(tag);

    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i;
          break;
        }
      }
    } else {
      // Auto-close implicit sibling tags (<p> before <p>, <li> before <li>).
      if ((tag === 'p' || tag === 'li') && stack[stack.length - 1]?.tag === tag) {
        stack.pop();
      }
      const node: HtmlNode = {
        type: 'element',
        tag,
        attrs: parseAttributes(m[2] ?? ''),
        children: [],
      };
      stack[stack.length - 1]!.children.push(node);
      if (!isSelfClose) stack.push(node);
    }
  }

  if (lastIndex < cleaned.length) {
    const text = decodeEntities(cleaned.slice(lastIndex));
    if (text) stack[stack.length - 1]!.children.push({ type: 'text', value: text });
  }

  return root.children;
}

function findElementWithAttr(nodes: readonly HtmlNode[], attr: string): string | undefined {
  for (const n of nodes) {
    if (n.type === 'element') {
      if (attr in n.attrs) return n.attrs[attr];
      const found = findElementWithAttr(n.children, attr);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const NAMED_COLORS: Record<string, Rgba> = {
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  crimson: { r: 220, g: 20, b: 60, a: 1 },
  darkred: { r: 139, g: 0, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  gold: { r: 255, g: 215, b: 0, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  purple: { r: 128, g: 0, b: 128, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
};

function parseCssColor(raw: string | undefined): Rgba | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  if (!s || s === 'inherit' || s === 'initial' || s === 'transparent' || s === 'currentcolor')
    return undefined;
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = Number.parseInt(hex[0]! + hex[0]!, 16);
      const g = Number.parseInt(hex[1]! + hex[1]!, 16);
      const b = Number.parseInt(hex[2]! + hex[2]!, 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return { r, g, b, a: 1 };
    } else if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
        return { r, g, b, a: clampN(a, 0, 1) };
      }
    }
    return undefined;
  }
  const m = s.match(
    /^rgba?\(\s*([0-9.]+)\s*[, ]\s*([0-9.]+)\s*[, ]\s*([0-9.]+)(?:\s*[,/]\s*([0-9.]+))?\s*\)$/,
  );
  if (m) {
    const r = clampN(Math.round(Number(m[1])), 0, 255);
    const g = clampN(Math.round(Number(m[2])), 0, 255);
    const b = clampN(Math.round(Number(m[3])), 0, 255);
    const a = m[4] !== undefined ? clampN(Number(m[4]), 0, 1) : 1;
    if (a <= 0) return undefined;
    return { r, g, b, a };
  }
  return undefined;
}

function parseStyleMap(styleAttr: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!styleAttr) return map;
  for (const part of styleAttr.split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim().toLowerCase();
    const v = part.slice(idx + 1).trim();
    if (k && v) map[k] = v;
  }
  return map;
}

function isLightColor(c: Rgba | undefined): boolean {
  if (!c) return true;
  const lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  return lum > 0.55;
}

function isDefaultDarkTextColor(c: Rgba): boolean {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  return max <= 68 && max - min <= 20;
}

function isDefaultWhiteBackground(c: Rgba): boolean {
  return c.r >= 245 && c.g >= 245 && c.b >= 245;
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'li',
  'tr',
  'section',
  'article',
  'header',
  'footer',
]);

const GENERIC_FONTS = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'inherit',
  'initial',
  '-apple-system',
  'blinkmacsystemfont',
  'times new roman',
  'times',
]);

/**
 * Parse clipboard HTML into a `RichTextSlice`.
 * - If `data-ordo-rich` is present, decodes the lossless Ordo slice directly.
 * - Otherwise converts external HTML (Bible Gateway, Logos, Google Docs, Word, web pages) into Ordo's
 *   `text`, `runs`, and `paras`, filtering out default dark body text colors when pasting into a light-text slide box.
 */
export function htmlToRichText(html: string, targetBoxStyle?: TextStyle): RichTextSlice | null {
  if (!html?.trim()) return null;
  const tree = parseHtmlTree(html);
  const ordoPayload = findElementWithAttr(tree, 'data-ordo-rich');
  if (ordoPayload) {
    try {
      const parsed = JSON.parse(ordoPayload) as RichTextSlice;
      if (parsed && typeof parsed.text === 'string') {
        const cleanRuns = (parsed.runs ?? []).map((r) => ({
          ...cleanRunFields(r),
          start: r.start,
          end: r.end,
        }));
        const cleanParas = (parsed.paras ?? []).map((p, i) => cleanPara(p, i > 0));
        return {
          text: parsed.text,
          runs: normalizeRuns(validRuns(cleanRuns, parsed.text.length)),
          ...(cleanParas.some(Boolean) ? { paras: trimParas(cleanParas) } : {}),
        };
      }
    } catch {
      // Fall through to standard HTML parsing if JSON is malformed.
    }
  }

  // If this is an Ordo object payload (not rich text), return null so canvas object paste handles it.
  if (findElementWithAttr(tree, 'data-ordo-objects') !== undefined) return null;

  const targetIsLight = isLightColor(targetBoxStyle?.color);
  let text = '';
  const runs: TextRun[] = [];
  const paras: (TextPara | null)[] = [];
  let currentPara: TextPara | null = null;
  let atBlockBoundary = true;

  const trimTrailingLineSpace = () => {
    while (text.endsWith(' ')) {
      text = text.slice(0, -1);
    }
    const len = text.length;
    while (runs.length > 0 && runs[runs.length - 1]!.start >= len) {
      runs.pop();
    }
    if (runs.length > 0 && runs[runs.length - 1]!.end > len) {
      runs[runs.length - 1]!.end = len;
    }
  };

  const ensureNewLine = () => {
    if (!atBlockBoundary && text.length > 0 && !text.endsWith('\n')) {
      trimTrailingLineSpace();
      const pIdx = newlines(text);
      if (currentPara) {
        paras[pIdx] = currentPara;
        currentPara = null;
      }
      text += '\n';
    }
    atBlockBoundary = true;
  };

  type WalkContext = {
    style: RunStyle;
    inPre: boolean;
    listStack: { kind: 'ul' | 'ol'; index: number }[];
  };

  const walk = (nodes: readonly HtmlNode[], ctx: WalkContext) => {
    for (const n of nodes) {
      if (n.type === 'text') {
        const val = ctx.inPre ? n.value.replace(/\r\n?/g, '\n') : n.value.replace(/[\r\n\t ]+/g, ' ');
        if (!val) continue;
        // Skip purely whitespace text nodes between block elements or after a trailing space.
        const stripLead = !ctx.inPre && (atBlockBoundary || text.endsWith(' '));
        const chunk = stripLead ? val.replace(/^\s+/, '') : val;
        if (!chunk) continue;
        const start = text.length;
        text += chunk;
        atBlockBoundary = chunk.endsWith('\n');
        const cleaned = cleanRunFields(ctx.style);
        if (RUN_FIELDS.some((k) => cleaned[k] !== undefined)) {
          runs.push({ ...cleaned, start, end: text.length });
        }
        continue;
      }

      const tag = n.tag;
      if (tag === 'br') {
        if (!ctx.inPre) trimTrailingLineSpace();
        const pIdx = newlines(text);
        if (currentPara) paras[pIdx] = currentPara;
        text += '\n';
        atBlockBoundary = true;
        continue;
      }

      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) ensureNewLine();

      const nextStyle: RunStyle = { ...ctx.style };
      const classes = (n.attrs.class ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const css = parseStyleMap(n.attrs.style);

      // Semantic HTML tags
      if (tag === 'b' || tag === 'strong' || /^h[1-6]$/.test(tag)) nextStyle.fontWeight = 700;
      if (tag === 'i' || tag === 'em' || tag === 'cite' || tag === 'dfn') nextStyle.fontStyle = 'italic';
      if (tag === 'u' || tag === 'ins') nextStyle.underline = true;
      if (tag === 's' || tag === 'strike' || tag === 'del') nextStyle.strike = true;
      if (tag === 'sup') nextStyle.baseline = 0.3;
      if (tag === 'sub') nextStyle.baseline = -0.25;

      // Bible Gateway / Logos / Scripture classes
      if (
        classes.includes('versenum') ||
        classes.includes('chapternum') ||
        classes.includes('v-num') ||
        classes.includes('verse-num')
      ) {
        nextStyle.baseline = 0.3;
      }
      if (classes.includes('woj') || classes.includes('words-of-jesus')) {
        nextStyle.color = { r: 220, g: 38, b: 38, a: 1 };
      }
      if (classes.includes('smcap') || classes.includes('small-caps')) {
        nextStyle.caps = 'small';
      }

      // Inline CSS properties
      if (css['font-weight']) {
        const fw = css['font-weight']!.toLowerCase();
        const num = Number.parseInt(fw, 10);
        if (fw === 'bold' || fw === 'bolder' || (Number.isFinite(num) && num >= 600)) {
          nextStyle.fontWeight = 700;
        } else if (fw === 'normal' || (Number.isFinite(num) && num > 0 && num < 600)) {
          delete nextStyle.fontWeight;
        }
      }
      if (css['font-style']) {
        const fs = css['font-style']!.toLowerCase();
        if (fs === 'italic' || fs === 'oblique') nextStyle.fontStyle = 'italic';
        else if (fs === 'normal') delete nextStyle.fontStyle;
      }
      const td = `${css['text-decoration'] ?? ''} ${css['text-decoration-line'] ?? ''}`.toLowerCase();
      if (td.includes('underline')) nextStyle.underline = true;
      if (td.includes('line-through')) nextStyle.strike = true;

      if (css['vertical-align']) {
        const va = css['vertical-align']!.toLowerCase();
        if (va === 'super') nextStyle.baseline = 0.3;
        else if (va === 'sub') nextStyle.baseline = -0.25;
      }
      if (css['text-transform']?.toLowerCase() === 'uppercase') nextStyle.caps = 'all';
      if (css['font-variant']?.toLowerCase() === 'small-caps') nextStyle.caps = 'small';

      if (css.color) {
        const c = parseCssColor(css.color);
        if (c && !(targetIsLight && isDefaultDarkTextColor(c))) {
          nextStyle.color = c;
        }
      }
      const bgCss = css['background-color'] ?? css.background;
      if (bgCss) {
        const bg = parseCssColor(bgCss);
        if (bg && !(targetIsLight && isDefaultWhiteBackground(bg))) {
          nextStyle.highlight = bg;
        }
      }
      if (css['font-family']) {
        const firstFam = css['font-family']!.split(',')[0]!
          .replace(/^['"]+|['"]+$/g, '')
          .trim();
        if (firstFam && !GENERIC_FONTS.has(firstFam.toLowerCase())) {
          nextStyle.fontFamily = firstFam;
        }
      }

      // Paragraph alignment & list bullets
      const alignCss = (css['text-align'] ?? n.attrs.align ?? '').toLowerCase();
      if (isBlock && ALIGNS.includes(alignCss)) {
        currentPara = { ...(currentPara ?? {}), align: alignCss as TextPara['align'] };
      }

      const nextListStack = [...ctx.listStack];
      if (tag === 'ul') {
        const startAt = Number.parseInt(n.attrs.start ?? '1', 10);
        nextListStack.push({ kind: 'ul', index: Number.isFinite(startAt) ? startAt : 1 });
      } else if (tag === 'ol') {
        const startAt = Number.parseInt(n.attrs.start ?? '1', 10);
        nextListStack.push({ kind: 'ol', index: Number.isFinite(startAt) ? startAt : 1 });
      } else if (tag === 'li') {
        const topList = nextListStack[nextListStack.length - 1];
        const level = Math.max(0, Math.min(8, nextListStack.length - 1));
        if (topList?.kind === 'ol') {
          currentPara = {
            ...(currentPara ?? {}),
            bullet: { auto: 'arabicPeriod', ...(topList.index > 1 ? { startAt: topList.index } : {}) },
            ...(level > 0 ? { level } : {}),
          };
          topList.index++;
        } else {
          currentPara = {
            ...(currentPara ?? {}),
            bullet: { char: '•' },
            ...(level > 0 ? { level } : {}),
          };
        }
      }

      const inPre = ctx.inPre || tag === 'pre' || (css['white-space'] ?? '').toLowerCase().startsWith('pre');
      walk(n.children, { style: nextStyle, inPre, listStack: nextListStack });

      if (isBlock) {
        const pIdx = newlines(text);
        if (currentPara) {
          paras[pIdx] = currentPara;
          currentPara = null;
        }
        ensureNewLine();
      }
    }
  };

  walk(tree, { style: {}, inPre: false, listStack: [] });

  // Trim trailing newline added by the last block element, and any trailing inline space.
  if (text.endsWith('\n')) {
    text = text.slice(0, -1);
  }
  trimTrailingLineSpace();
  if (!text) return null;

  const normRuns = normalizeRuns(validRuns(runs, text.length));
  const maxP = newlines(text) + 1;
  const trimmedParas = trimParas(paras.slice(0, maxP));

  return {
    text,
    runs: normRuns,
    ...(trimmedParas.length ? { paras: trimmedParas } : {}),
  };
}

// ---- Layer 3: Slide Canvas Object Copy/Cut/Paste --------------------------------------------------------

export type CopiedObjectsData = {
  objects: SlideObject[];
  sourceSlideId?: string;
};

/**
 * Serialize selected slide objects into an HTML wrapper with `data-ordo-objects` + fallback plain text.
 */
export function serializeObjectsToHtml(
  objects: readonly SlideObject[],
  sourceSlideId?: string,
): { html: string; text: string } {
  const payload: CopiedObjectsData = {
    objects: structuredClone(objects) as SlideObject[],
    sourceSlideId,
  };
  const encoded = escapeHtml(JSON.stringify(payload));
  const textParts = objects
    .filter((o): o is TextObject => o.type === 'text' && !!o.text.trim())
    .map((o) => o.text);
  const text = textParts.join('\n\n') || `[Ordo: ${objects.length} slide object(s)]`;
  const html = `<div data-ordo-objects="${encoded}">${escapeHtml(text)}</div>`;
  return { html, text };
}

/**
 * Parse copied Ordo slide objects from clipboard HTML (`data-ordo-objects`), if present.
 */
export function parseObjectsFromHtml(html: string): CopiedObjectsData | null {
  if (!html?.includes('data-ordo-objects')) return null;
  const tree = parseHtmlTree(html);
  const raw = findElementWithAttr(tree, 'data-ordo-objects');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CopiedObjectsData;
    if (!parsed || !Array.isArray(parsed.objects) || !parsed.objects.length) return null;
    const valid = parsed.objects.filter(
      (o) =>
        o &&
        typeof o === 'object' &&
        (o.type === 'text' || o.type === 'image' || o.type === 'shape') &&
        o.box &&
        fin(o.box.x) &&
        fin(o.box.y) &&
        fin(o.box.w) &&
        fin(o.box.h),
    );
    if (!valid.length) return null;
    return { objects: valid, sourceSlideId: parsed.sourceSlideId };
  } catch {
    return null;
  }
}

function freshGroup(taken: Set<number>): number {
  let top = -1;
  for (const g of taken) top = Math.max(top, g);
  if (top < MAX_GROUP) return top + 1;
  for (let g = 0; g <= MAX_GROUP; g++) if (!taken.has(g)) return g;
  return MAX_GROUP;
}

/**
 * Paste `objects` onto `slideId` of `p`, assigning fresh IDs and group numbers and offsetting by `(dx, dy)`.
 */
export function pasteObjects(
  p: Presentation,
  slideId: string,
  objects: readonly SlideObject[],
  offset: { dx: number; dy: number } = { dx: 20, dy: 20 },
): { p: Presentation; ids: string[]; full?: boolean } {
  if (!objects.length) return { p, ids: [] };
  const ids: string[] = [];
  let full = false;
  const dx = fin(offset.dx) ? offset.dx : 0;
  const dy = fin(offset.dy) ? offset.dy : 0;

  const next = withSlide(p, slideId, (s: Slide) => {
    if (s.objects.length + objects.length > MAX_OBJECTS) {
      full = true;
      return s;
    }
    const taken = new Set<number>();
    for (const o of s.objects) if (o.origin?.group !== undefined) taken.add(o.origin.group);
    const groups = new Map<number, number>();

    const copies = objects.map((o) => {
      const c = structuredClone(o) as SlideObject;
      c.id = newId();
      c.box = { ...c.box, x: c.box.x + dx, y: c.box.y + dy };
      const g = c.origin?.group;
      if (c.origin && g !== undefined) {
        let fresh = groups.get(g);
        if (fresh === undefined) {
          fresh = freshGroup(taken);
          taken.add(fresh);
          groups.set(g, fresh);
        }
        c.origin = { ...c.origin, group: fresh };
      }
      ids.push(c.id);
      return c;
    });
    return { ...s, objects: [...s.objects, ...copies] };
  });

  if (next === p) return { p, ids: [], ...(full ? { full: true } : {}) };
  return { p: next, ids };
}
