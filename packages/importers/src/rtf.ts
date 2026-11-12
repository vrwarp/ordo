import type { Rgba } from '@ordo/domain';

export interface RtfSpan {
  start: number;
  end: number;
  fontName?: string;
  fontSizePt?: number;
  color?: Rgba;
  highlight?: Rgba;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Superscript (+0.33), subscript (-0.2), or \upN / \dnN shift as fraction of font size. */
  baseline?: number;
  caps?: 'all' | 'small';
  /** Character tracking in points (\expndtwN / 20, or \expndN / 4). */
  letterSpacingPt?: number;
  strokeWidth?: number;
  strokeColor?: Rgba;
}

export interface RtfPara {
  align?: 'left' | 'center' | 'right' | 'justify';
  indentPt?: number;
  firstLinePt?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  lineSpacing?: number;
  leadingPt?: number;
  bulletChar?: string;
  isBullet?: boolean;
}

/** Plain text and the first run's character style extracted from an RTF document. */
export interface RtfResult {
  text: string;
  /** True when the input was not RTF at all and was taken as plain text (line breaks kept). */
  plain?: boolean;
  /** Font name from the font table for the first run (often a PostScript name such as `HelveticaNeue-Bold`). */
  fontName?: string;
  /** Font size of the first run in points (`\fsN` is half-points). */
  fontSizePt?: number;
  color?: Rgba;
  bold: boolean;
  italic: boolean;
  align?: 'left' | 'center' | 'right';
  /** Cocoa `\strokewidthN` of the first run (negative: stroke and fill). */
  strokeWidth?: number;
  strokeColor?: Rgba;
  /** Number of distinct character styles used by non-whitespace text; > 1 means mixed runs. */
  styleRuns: number;
  /** The first run's paragraph: `\slN\slmult1` line spacing as a multiple of single spacing. */
  lineSpacing?: number;
  /** The first run's paragraph: `\saN` space after it, in points. */
  spaceAfterPt?: number;
  /** Cocoa `\slleadingN` extra line spacing / leading in points (N / 20). */
  leadingPt?: number;
  /** True when RTF bullet/list markers (`\listtable`, `\listtext`, `\pntext`, `\ls`) were detected. */
  hasBulletList?: boolean;
  /** Paragraph left indent (`\liN`) in points (N / 20). */
  indentPt?: number;
  /** Paragraph first line indent (`\fiN`) in points (N / 20, negative for hanging). */
  firstLinePt?: number;
  /** Multi-run rich character spans covering ranges of `text`. */
  spans?: RtfSpan[];
  /** Per-paragraph styles for each newline-separated line in `text`. */
  paras?: RtfPara[];
}

type Dest = 'text' | 'fonttbl' | 'colortbl' | 'expandedcolortbl' | 'listtext' | 'skip';

/** Font names longer than this are cut (a real PostScript or family name is far shorter). */
export const RTF_FONT_NAME_MAX = 200;
/**
 * Text kept from one RTF document; more is dropped while reading. A slide's text and its notes are cut to
 * 10,000 characters later, so this only has to bound the work: 100 MB of `\par` used to build a 20 million
 * line string and split it (618 MB) before the cut.
 */
export const RTF_TEXT_MAX = 64 * 1024;
/** RTF numeric parameters are 16/32-bit; anything larger is clamped. */
const NUM_LIMIT = 2 ** 31;

/**
 * Trailing spaces and tabs removed from every line, leading and trailing blank lines removed. Written as
 * loops because the equivalent regexes backtrack quadratically on long whitespace runs.
 */
export function tidyLines(text: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    let end = l.length;
    while (end > 0 && (l.charCodeAt(end - 1) === 32 || l.charCodeAt(end - 1) === 9)) end--;
    if (end !== l.length) lines[i] = l.slice(0, end);
  }
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a] === '') a++;
  while (b > a && lines[b - 1] === '') b--;
  return lines.slice(a, b).join('\n');
}

/** Replace lone UTF-16 surrogates (from `\uN` with half a pair) with U+FFFD. */
function wellFormed(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(v)));

function rgbaEqual(a?: Rgba, b?: Rgba): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.r === b.r && a.g === b.g && a.b === b.b && (a.a ?? 1) === (b.a ?? 1);
}

function sameSpanFormat(a: RtfSpan, b: RtfSpan): boolean {
  return (
    a.fontName === b.fontName &&
    a.fontSizePt === b.fontSizePt &&
    rgbaEqual(a.color, b.color) &&
    rgbaEqual(a.highlight, b.highlight) &&
    (a.bold ?? false) === (b.bold ?? false) &&
    (a.italic ?? false) === (b.italic ?? false) &&
    (a.underline ?? false) === (b.underline ?? false) &&
    (a.strike ?? false) === (b.strike ?? false) &&
    (a.baseline ?? 0) === (b.baseline ?? 0) &&
    a.caps === b.caps &&
    (a.letterSpacingPt ?? 0) === (b.letterSpacingPt ?? 0) &&
    (a.strokeWidth ?? 0) === (b.strokeWidth ?? 0) &&
    rgbaEqual(a.strokeColor, b.strokeColor)
  );
}

function createSpan(
  start: number,
  end: number,
  st: GroupState,
  fonts: Map<number, string>,
  colors: (Rgba | null)[],
): RtfSpan {
  const span: RtfSpan = { start, end };
  const name = fonts.get(st.font);
  if (name) span.fontName = name.slice(0, RTF_FONT_NAME_MAX);
  if (st.fsSeen) span.fontSizePt = st.fs / 2;
  const col = colors[st.cf];
  if (col) span.color = col;
  if (st.cb > 0) {
    const h = colors[st.cb];
    if (h) span.highlight = h;
  }
  if (st.b) span.bold = true;
  if (st.i) span.italic = true;
  if (st.ul) span.underline = true;
  if (st.strike) span.strike = true;
  if (st.baseline) span.baseline = st.baseline;
  if (st.caps) span.caps = st.caps;
  if (st.expndTwips) span.letterSpacingPt = Math.round((st.expndTwips / 20) * 100) / 100;
  if (st.strokeWidth) span.strokeWidth = st.strokeWidth;
  if (st.strokeWidth && st.strokeColor > 0) {
    const sc = colors[st.strokeColor];
    if (sc) span.strokeColor = sc;
  }
  return span;
}

function snapshotPara(st: GroupState, docSlleading: number, bulletChar?: string): RtfPara {
  const p: RtfPara = {};
  if (st.alignSeen) p.align = st.align;
  if (st.li) p.indentPt = Math.round((st.li / 20) * 100) / 100;
  if (st.fi) p.firstLinePt = Math.round((st.fi / 20) * 100) / 100;
  if (st.sb > 0) p.spaceBeforePt = Math.round((st.sb / 20) * 100) / 100;
  if (st.sa > 0) p.spaceAfterPt = Math.round((st.sa / 20) * 100) / 100;
  if (st.slmult && st.sl > 0) p.lineSpacing = Math.round((st.sl / 240) * 100) / 100;
  const leading = st.slleading > 0 ? st.slleading : docSlleading;
  if (leading > 0) p.leadingPt = Math.min(500, Math.round((leading / 20) * 100) / 100);
  if (bulletChar) p.bulletChar = bulletChar;
  if (bulletChar || st.isBullet) p.isBullet = true;
  return p;
}

function tidyWithOffsets(
  rawText: string,
  rawSpans: RtfSpan[],
  rawParas: RtfPara[],
): { text: string; spans: RtfSpan[]; paras: RtfPara[] } {
  const lines = rawText.split('\n');
  const trimmedLens = new Int32Array(lines.length);
  const trimmedLines: string[] = new Array(lines.length);

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    let end = l.length;
    while (end > 0 && (l.charCodeAt(end - 1) === 32 || l.charCodeAt(end - 1) === 9)) end--;
    trimmedLens[i] = end;
    trimmedLines[i] = end === l.length ? l : l.slice(0, end);
  }

  let a = 0;
  let b = lines.length;
  while (a < b && trimmedLines[a] === '') a++;
  while (b > a && trimmedLines[b - 1] === '') b--;

  if (a >= b) {
    return { text: '', spans: [], paras: [] };
  }

  const survivingLines = trimmedLines.slice(a, b);
  const text = survivingLines.join('\n');

  const rawLineStarts = new Int32Array(lines.length);
  let rawOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    rawLineStarts[i] = rawOffset;
    rawOffset += lines[i]!.length + 1;
  }

  const resLineStarts = new Int32Array(b - a);
  let resOffset = 0;
  for (let i = a; i < b; i++) {
    resLineStarts[i - a] = resOffset;
    resOffset += trimmedLens[i]! + 1;
  }

  function findLine(pos: number): number {
    let low = 0;
    let high = lines.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const start = rawLineStarts[mid]!;
      const nextStart = mid + 1 < lines.length ? rawLineStarts[mid + 1]! : Number.POSITIVE_INFINITY;
      if (pos < start) high = mid - 1;
      else if (pos >= nextStart) low = mid + 1;
      else return mid;
    }
    return Math.max(0, Math.min(lines.length - 1, low));
  }

  function mapOffset(pos: number): number {
    if (pos <= 0) return 0;
    if (pos >= rawText.length) return text.length;
    const i = findLine(pos);
    if (i < a) return 0;
    if (i >= b) return text.length;
    const col = pos - rawLineStarts[i]!;
    const tLen = trimmedLens[i]!;
    const rStart = resLineStarts[i - a]!;
    if (col <= tLen) {
      return rStart + col;
    }
    return rStart + tLen;
  }

  const remapped: RtfSpan[] = [];
  for (const s of rawSpans) {
    const start = mapOffset(s.start);
    const end = mapOffset(s.end);
    if (end <= start) continue;
    const span: RtfSpan = { ...s, start, end };
    if (remapped.length > 0) {
      const prev = remapped[remapped.length - 1]!;
      if (prev.end === span.start && sameSpanFormat(prev, span)) {
        prev.end = span.end;
        continue;
      }
    }
    remapped.push(span);
  }

  if (remapped.length > 2000) remapped.length = 2000;

  while (rawParas.length < lines.length) rawParas.push({});
  const paras = rawParas.slice(a, b);
  if (paras.length > 1000) paras.length = 1000;

  return { text, spans: remapped, paras };
}

/**
 * Encoding (WHATWG label) for an RTF `\fcharsetN`. 0 (ANSI) and 1 (default) follow the document's
 * `\ansicpgN`; charsets missing here (symbol, OEM, Mac) keep Windows-1252.
 */
const CHARSET_ENCODING: Record<number, string> = {
  128: 'shift_jis',
  129: 'euc-kr',
  134: 'gbk',
  136: 'big5',
  161: 'windows-1253',
  162: 'windows-1254',
  163: 'windows-1258',
  177: 'windows-1255',
  178: 'windows-1256',
  186: 'windows-1257',
  204: 'windows-1251',
  222: 'windows-874',
  238: 'windows-1250',
};

/** Encoding for an `\ansicpgN` code page (`undefined`: Windows-1252, decoded without a TextDecoder). */
function codePageEncoding(cp: number): string | undefined {
  if (cp === 1252 || cp <= 0) return undefined;
  if (cp === 932) return 'shift_jis';
  if (cp === 936) return 'gbk';
  if (cp === 949) return 'euc-kr';
  if (cp === 950) return 'big5';
  if (cp === 874 || (cp >= 1250 && cp <= 1258)) return `windows-${cp}`;
  if (cp === 10000) return 'macintosh';
  return undefined;
}

const decoders = new Map<string, TextDecoder | null>();
/** A decoder for `label`, or null when this runtime has none (the bytes then read as Windows-1252). */
function decoderFor(label: string): TextDecoder | null {
  if (!decoders.has(label)) {
    let d: TextDecoder | null = null;
    try {
      d = new TextDecoder(label);
    } catch {
      d = null;
    }
    decoders.set(label, d);
  }
  return decoders.get(label) ?? null;
}

interface GroupState {
  dest: Dest;
  font: number;
  fs: number;
  cf: number;
  b: boolean;
  i: boolean;
  align: 'left' | 'center' | 'right' | 'justify';
  /** Whether a `\fsN` / `\qX` was seen: without one the attributes decide, not RTF's defaults. */
  fsSeen: boolean;
  alignSeen: boolean;
  uc: number;
  strokeWidth: number;
  strokeColor: number;
  /** Paragraph spacing (`\saN`, `\sbN`, `\slN`, `\slmultN`), in twips; reset by `\pard`. */
  sa: number;
  sb: number;
  sl: number;
  slmult: boolean;
  slleading: number;
  li: number;
  fi: number;
  ul: boolean;
  strike: boolean;
  baseline: number;
  caps?: 'all' | 'small';
  cb: number;
  expndTwips: number;
  expndTwipsExplicit: boolean;
  isBullet: boolean;
}

/** Destinations whose contents are not body text. */
const SKIP_DESTS = new Set([
  'stylesheet',
  'info',
  'pict',
  'header',
  'headerl',
  'headerr',
  'headerf',
  'footer',
  'footerl',
  'footerr',
  'footerf',
  'footnote',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'xmlnstbl',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'filetbl',
  'revtbl',
  'fldinst',
  'object',
  'generator',
  'mmathPr',
  'pgdsctbl',
  'nonshppict',
  'shppict',
  'bkmkstart',
  'bkmkend',
  'author',
  'title',
  'operator',
  'company',
]);

const CP1252: Record<number, number> = {
  128: 0x20ac,
  130: 0x201a,
  131: 0x0192,
  132: 0x201e,
  133: 0x2026,
  134: 0x2020,
  135: 0x2021,
  136: 0x02c6,
  137: 0x2030,
  138: 0x0160,
  139: 0x2039,
  140: 0x0152,
  142: 0x017d,
  145: 0x2018,
  146: 0x2019,
  147: 0x201c,
  148: 0x201d,
  149: 0x2022,
  150: 0x2013,
  151: 0x2014,
  152: 0x02dc,
  153: 0x2122,
  154: 0x0161,
  155: 0x203a,
  156: 0x0153,
  158: 0x017e,
  159: 0x0178,
};

function cp1252(byte: number): string {
  return String.fromCharCode(CP1252[byte] ?? byte);
}

/** RTF starts with `{\rtf`; anything else (ProPresenter occasionally stores bare text) is plain text. */
export function isRtf(input: string | Uint8Array): boolean {
  const head = typeof input === 'string' ? input.slice(0, 16) : rtfBytesToString(input.subarray(0, 16));
  return /^\s*\{\\rtf/.test(head);
}

/** Plain (non-RTF) text: UTF-8, every line-break convention kept as `\n`, no style information. */
function plainTextResult(input: string | Uint8Array): RtfResult {
  let text: string;
  if (typeof input === 'string') text = input;
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      text = rtfBytesToString(input);
    }
  }
  text = tidyLines(
    text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u2028\u2029]/g, '\n'),
  );
  text = wellFormed(text);
  return { text, plain: true, bold: false, italic: false, styleRuns: 0 };
}

/**
 * RTF is ASCII with escapes, but some writers put UTF-8 straight in: when the bytes are valid UTF-8 they
 * are read as such (ASCII, and so every escape, is unchanged), else byte-for-byte as Latin-1.
 */
function rtfSourceString(bytes: Uint8Array): string {
  let high = false;
  for (let i = 0; i < bytes.length && !high; i++) if (bytes[i]! >= 0x80) high = true;
  if (high) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      /* not UTF-8: Latin-1 below */
    }
  }
  return rtfBytesToString(bytes);
}

/** Decode RTF bytes (ASCII with escapes) into a string without a TextDecoder dependency on encoding. */
export function rtfBytesToString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 4096)));
  }
  return s;
}

/**
 * A small RTF reader: extracts plain text (handling `\par`, `\line`, `\'hh`, `\uN`, groups and ignorable
 * destinations) and the first run's font, size, colour, weight, alignment and stroke, plus multi-run character
 * spans and per-paragraph styles.
 */
export function parseRtf(input: string | Uint8Array): RtfResult {
  if (!isRtf(input)) return plainTextResult(input);
  const src = typeof input === 'string' ? input : rtfSourceString(input);
  const fonts = new Map<number, string>();
  /** `\fcharsetN` of each font, by font number. */
  const fontCharsets = new Map<number, number>();
  /** The document's `\ansicpgN` encoding (undefined: Windows-1252). */
  let docEncoding: string | undefined;
  /** `\'hh` bytes in a multi-byte encoding, decoded together once the run of escapes ends. */
  let pendingBytes: number[] = [];
  let pendingEncoding = '';
  const colors: (Rgba | null)[] = [];
  let curFontIdx = -1;
  let fontName = '';
  let colorDraft: { r?: number; g?: number; b?: number } = {};

  // Cocoa expandedcolortbl tracking
  let expColorIdx = 0;
  let expComponents: number[] = [];
  let expAlpha: number | undefined;
  let expColorSpace: 'srgb' | 'genericrgb' | 'gray' | 'cmyk' | undefined;

  const initial: GroupState = {
    dest: 'text',
    font: 0,
    fs: 24,
    cf: 0,
    b: false,
    i: false,
    align: 'left',
    fsSeen: false,
    alignSeen: false,
    uc: 1,
    strokeWidth: 0,
    strokeColor: 0,
    sa: 0,
    sb: 0,
    sl: 0,
    slmult: false,
    slleading: 0,
    li: 0,
    fi: 0,
    ul: false,
    strike: false,
    baseline: 0,
    caps: undefined,
    cb: 0,
    expndTwips: 0,
    expndTwipsExplicit: false,
    isBullet: false,
  };
  const stack: GroupState[] = [];
  let st: GroupState = { ...initial };
  let out = '';
  const rawSpans: RtfSpan[] = [];
  const rawParas: RtfPara[] = [];
  let curLineIndex = 0;
  let curBulletChar: string | undefined;

  let docSlleading = 0;
  const syncCurrentPara = () => {
    if (st.dest === 'text') {
      rawParas[curLineIndex] = snapshotPara(st, docSlleading, curBulletChar);
    }
  };
  syncCurrentPara();
  /** No visible character yet: blank lines are dropped as they arrive (tidyLines would drop them anyway). */
  let leading = true;
  let first: GroupState | null = null;
  const styleKeys = new Set<string>();
  let skipChars = 0;
  let hasBulletList = false;
  /** True right after `{` until the first control word: used to detect `{\*\dest ...}`. */
  let groupStart = false;
  let starPending = false;

  const emit = (chars: string) => {
    if (st.dest === 'skip') return;
    if (st.dest === 'fonttbl') {
      for (const ch of chars) {
        if (ch === ';') {
          if (curFontIdx >= 0 && !fonts.has(curFontIdx)) fonts.set(curFontIdx, fontName.trim());
          fontName = '';
        } else if (fontName.length < RTF_FONT_NAME_MAX) fontName += ch;
      }
      return;
    }
    if (st.dest === 'colortbl') {
      for (const ch of chars) {
        if (ch === ';') {
          const { r, g, b } = colorDraft;
          colors.push(
            r === undefined && g === undefined && b === undefined
              ? null
              : { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: 1 },
          );
          colorDraft = {};
        }
      }
      return;
    }
    if (st.dest === 'expandedcolortbl') {
      for (const ch of chars) {
        if (ch === ';') {
          if (expComponents.length >= 3 && (expColorSpace === 'srgb' || !colors[expColorIdx])) {
            colors[expColorIdx] = {
              r: Math.round((expComponents[0]! / 100_000) * 255),
              g: Math.round((expComponents[1]! / 100_000) * 255),
              b: Math.round((expComponents[2]! / 100_000) * 255),
              a: expAlpha ?? colors[expColorIdx]?.a ?? 1,
            };
          } else if (expComponents.length >= 3 && expAlpha !== undefined && colors[expColorIdx]) {
            colors[expColorIdx] = { ...colors[expColorIdx]!, a: expAlpha };
          } else if ((expColorSpace === 'gray' || expComponents.length === 1) && expComponents.length >= 1) {
            const v = Math.round((expComponents[0]! / 100_000) * 255);
            colors[expColorIdx] = {
              r: v,
              g: v,
              b: v,
              a: expAlpha ?? colors[expColorIdx]?.a ?? 1,
            };
          }
          expColorIdx++;
          expComponents = [];
          expAlpha = undefined;
          expColorSpace = undefined;
        }
      }
      return;
    }
    if (st.dest === 'listtext') {
      const m = /\S/.exec(chars);
      if (m && !curBulletChar) {
        curBulletChar = m[0];
        syncCurrentPara();
      }
      return;
    }
    let text = chars;
    if (skipChars > 0) {
      const n = Math.min(skipChars, text.length);
      text = text.slice(n);
      skipChars -= n;
    }
    if (!text || out.length >= RTF_TEXT_MAX) return;
    if (leading) {
      if (/[^ \t\n\u00a0]/.test(text)) {
        leading = false;
      } else {
        out += text;
        const nl = out.lastIndexOf('\n');
        if (nl >= 0) {
          out = out.slice(nl + 1);
          rawParas.length = 0;
          curLineIndex = 0;
          syncCurrentPara();
        }
        return;
      }
    }
    if (/\S/.test(text) && text !== '\n') {
      if (!first) first = { ...st };
      styleKeys.add(
        `${st.font}|${st.fs}|${st.cf}|${st.b}|${st.i}|${st.strokeWidth}|${st.strokeColor}|${st.ul}|${st.strike}|${st.baseline}|${st.caps}|${st.cb}|${st.expndTwips}`,
      );
    }
    const toAppend =
      text.length > RTF_TEXT_MAX - out.length ? text.slice(0, RTF_TEXT_MAX - out.length) : text;
    for (let i = 0; i < toAppend.length; i++) {
      if (toAppend[i] === '\n') {
        syncCurrentPara();
        curBulletChar = undefined;
        curLineIndex++;
        syncCurrentPara();
      }
    }
    const start = out.length;
    out += toAppend;
    const end = out.length;
    syncCurrentPara();
    if (end > start) {
      const span = createSpan(start, end, st, fonts, colors);
      if (
        rawSpans.length > 0 &&
        rawSpans[rawSpans.length - 1]!.end === start &&
        sameSpanFormat(rawSpans[rawSpans.length - 1]!, span)
      ) {
        rawSpans[rawSpans.length - 1]!.end = end;
      } else {
        rawSpans.push(span);
      }
    }
  };

  /** The encoding `\'hh` escapes are in right now (the current font's charset, else the document's). */
  const escapeEncoding = (): string | undefined => {
    const cs = fontCharsets.get(st.font);
    if (cs !== undefined && cs !== 0 && cs !== 1) return CHARSET_ENCODING[cs];
    return docEncoding;
  };
  const flushBytes = () => {
    if (!pendingBytes.length) return;
    const bytes = pendingBytes;
    pendingBytes = [];
    const d = decoderFor(pendingEncoding);
    if (d) emit(d.decode(new Uint8Array(bytes)));
    else for (const b of bytes) emit(cp1252(b));
  };

  const n = src.length;
  let p = 0;
  while (p < n) {
    const c = src[p]!;
    // A run of `\'hh` escapes ends at any other token: decode what it spelled before going on.
    if (pendingBytes.length && !(c === '\\' && src[p + 1] === "'")) flushBytes();
    if (c === '{') {
      stack.push(st);
      st = { ...st };
      groupStart = true;
      starPending = false;
      p++;
      continue;
    }
    if (c === '}') {
      if (st.dest === 'fonttbl' && fontName.trim() && curFontIdx >= 0 && !fonts.has(curFontIdx)) {
        fonts.set(curFontIdx, fontName.trim().replace(/;$/, ''));
        fontName = '';
      }
      st = stack.pop() ?? { ...initial };
      groupStart = false;
      starPending = false;
      p++;
      continue;
    }
    if (c === '\\') {
      const next = src[p + 1];
      if (next === undefined) break;
      if (/[a-zA-Z]/.test(next)) {
        let q = p + 1;
        while (q < n && /[a-zA-Z]/.test(src[q]!)) q++;
        const word = src.slice(p + 1, q);
        let numStr = '';
        if (src[q] === '-' || /\d/.test(src[q] ?? '')) {
          let r = q + 1;
          while (r < n && /\d/.test(src[r]!)) r++;
          numStr = src.slice(q, r);
          q = r;
        }
        if (src[q] === ' ') q++;
        p = q;
        const parsedNum = numStr ? Number(numStr) : Number.NaN;
        const num = Number.isFinite(parsedNum)
          ? clampInt(parsedNum, -NUM_LIMIT, NUM_LIMIT)
          : /^-?\d+$/.test(numStr)
            ? numStr.startsWith('-')
              ? -NUM_LIMIT
              : NUM_LIMIT
            : undefined;
        const wasGroupStart = groupStart;
        groupStart = false;
        if (wasGroupStart || starPending) {
          if (word === 'expandedcolortbl') {
            starPending = false;
            st.dest = 'expandedcolortbl';
            expColorIdx = 0;
            expComponents = [];
            expAlpha = undefined;
            expColorSpace = undefined;
            continue;
          }
          if (word === 'listtext' || word === 'pntext') {
            starPending = false;
            hasBulletList = true;
            st.dest = 'listtext';
            continue;
          }
          if (starPending) {
            starPending = false;
            st.dest = 'skip';
            continue;
          }
          if (word === 'fonttbl') {
            st.dest = 'fonttbl';
            continue;
          }
          if (word === 'colortbl') {
            st.dest = 'colortbl';
            continue;
          }
          if (SKIP_DESTS.has(word)) {
            if (word === 'listtable' || word === 'listoverridetable') {
              hasBulletList = true;
            }
            st.dest = 'skip';
            continue;
          }
        }
        if (word === 'bin') {
          // `\binN`: N bytes of binary data follow (a picture or object); they are never text.
          if (num !== undefined && num > 0) p = Math.min(n, p + num);
          continue;
        }
        controlWord(word, num);
        continue;
      }
      // Control symbols.
      p += 2;
      if (next === "'") {
        const hex = src.slice(p, p + 2);
        p += 2;
        const byte = Number.parseInt(hex, 16);
        groupStart = false;
        if (Number.isNaN(byte)) continue;
        const enc = st.dest === 'text' ? escapeEncoding() : undefined;
        if (!enc) {
          emit(cp1252(byte));
          continue;
        }
        // Fallback bytes after `\uN` (`\ucN` counts bytes, and a double-byte character is two).
        if (skipChars > 0) {
          skipChars--;
          continue;
        }
        if (pendingEncoding !== enc) flushBytes();
        pendingEncoding = enc;
        pendingBytes.push(byte);
        continue;
      }
      if (next === '*') {
        // `{\*\dest ...}` marks an ignorable destination; a stray `\*` elsewhere is ignored.
        starPending = groupStart;
        groupStart = false;
        continue;
      }
      groupStart = false;
      if (next === '\\' || next === '{' || next === '}') emit(next);
      else if (next === '~') emit(' ');
      else if (next === '_') emit('‑');
      else if (next === '-') {
        // optional hyphen: nothing
      } else if (next === '\n' || next === '\r') emit('\n');
      continue;
    }
    if (c === '\r' || c === '\n') {
      p++;
      continue;
    }
    // Plain text run up to the next special character.
    let q = p;
    while (q < n && src[q] !== '\\' && src[q] !== '{' && src[q] !== '}' && src[q] !== '\r' && src[q] !== '\n')
      q++;
    groupStart = false;
    emit(src.slice(p, q));
    p = q;
  }

  function controlWord(word: string, num: number | undefined) {
    if (st.dest === 'expandedcolortbl') {
      if (word === 'c') {
        expComponents.push(clampInt(num ?? 0, 0, 100_000));
        return;
      }
      if (word === 'ca') {
        expAlpha = clampInt(num ?? 0, 0, 100_000) / 100_000;
        return;
      }
      if (word === 'cssrgb') {
        expColorSpace = 'srgb';
        return;
      }
      if (word === 'csgenericrgb') {
        expColorSpace = 'genericrgb';
        return;
      }
      if (word === 'csgray') {
        expColorSpace = 'gray';
        return;
      }
      if (word === 'csdevicecmyk') {
        expColorSpace = 'cmyk';
        return;
      }
      return;
    }
    switch (word) {
      case 'par':
      case 'line':
      case 'sect':
      case 'page':
        if (st.dest === 'text') emit('\n');
        return;
      case 'tab':
        if (st.dest === 'text') emit('\t');
        return;
      case 'emdash':
        return emit('—');
      case 'endash':
        return emit('–');
      case 'bullet':
        return emit('•');
      case 'lquote':
        return emit('‘');
      case 'rquote':
        return emit('’');
      case 'ldblquote':
        return emit('“');
      case 'rdblquote':
        return emit('”');
      case 'u': {
        if (num === undefined) return;
        const code = num < 0 ? num + 65536 : num;
        emit(code === 0x2028 || code === 0x2029 ? '\n' : String.fromCharCode(code));
        if (st.dest === 'text') skipChars = st.uc;
        return;
      }
      case 'uc':
        // Fallback characters after \uN: 0..8 (a negative or huge value would eat or misplace text).
        st.uc = clampInt(num ?? 1, 0, 8);
        return;
      case 'f':
        if (st.dest === 'fonttbl') {
          curFontIdx = num ?? 0;
          fontName = '';
        } else st.font = num ?? 0;
        return;
      case 'fcharset':
        if (st.dest === 'fonttbl' && curFontIdx >= 0 && num !== undefined) fontCharsets.set(curFontIdx, num);
        return;
      case 'ansicpg':
        docEncoding = codePageEncoding(num ?? 1252);
        return;
      case 'fs':
        st.fs = num !== undefined && num > 0 ? Math.min(num, 2000) : 24;
        st.fsSeen = true;
        return;
      case 'cf':
        st.cf = num ?? 0;
        return;
      case 'b':
        st.b = num !== 0;
        return;
      case 'i':
        st.i = num !== 0;
        return;
      case 'ul':
        st.ul = num !== 0;
        return;
      case 'ulnone':
        st.ul = false;
        return;
      case 'uld':
      case 'uldb':
      case 'ulw':
      case 'ulwave':
      case 'ulth':
      case 'uldot':
      case 'uldash':
      case 'uldashd':
      case 'uldashdd':
        st.ul = true;
        return;
      case 'strike':
      case 'striked':
        st.strike = num !== 0;
        return;
      case 'super':
        st.baseline = 0.33;
        return;
      case 'sub':
        st.baseline = -0.2;
        return;
      case 'nosupersub':
        st.baseline = 0;
        return;
      case 'up':
        st.baseline = Math.round(((num ?? 0) / (st.fs > 0 ? st.fs : 24)) * 1000) / 1000;
        return;
      case 'dn':
        st.baseline = Math.round(-((num ?? 0) / (st.fs > 0 ? st.fs : 24)) * 1000) / 1000;
        return;
      case 'caps':
        st.caps = num !== 0 ? 'all' : undefined;
        return;
      case 'scaps':
        st.caps = num !== 0 ? 'small' : undefined;
        return;
      case 'cb':
      case 'chcbpat':
      case 'highlight':
        st.cb = clampInt(num ?? 0, 0, 1000);
        return;
      case 'expndtw':
        st.expndTwips = clampInt(num ?? 0, -20_000, 20_000);
        st.expndTwipsExplicit = true;
        return;
      case 'expnd':
        if (!st.expndTwipsExplicit) st.expndTwips = clampInt((num ?? 0) * 5, -20_000, 20_000);
        return;
      case 'kerning':
        if (num === 0) st.expndTwips = 0;
        return;
      case 'plain':
        st.font = 0;
        st.fs = 24;
        st.cf = 0;
        st.b = false;
        st.i = false;
        st.ul = false;
        st.strike = false;
        st.baseline = 0;
        st.caps = undefined;
        st.cb = 0;
        st.expndTwips = 0;
        st.expndTwipsExplicit = false;
        st.strokeWidth = 0;
        st.strokeColor = 0;
        return;
      case 'pard':
        st.align = 'left';
        st.sa = 0;
        st.sb = 0;
        st.sl = 0;
        st.slmult = false;
        st.slleading = 0;
        st.li = 0;
        st.fi = 0;
        st.isBullet = false;
        syncCurrentPara();
        return;
      case 'sa':
        st.sa = clampInt(num ?? 0, 0, 20_000);
        syncCurrentPara();
        return;
      case 'sb':
        st.sb = clampInt(num ?? 0, 0, 20_000);
        syncCurrentPara();
        return;
      case 'sl':
        st.sl = clampInt(num ?? 0, -20_000, 20_000);
        syncCurrentPara();
        return;
      case 'slmult':
        st.slmult = num === 1;
        syncCurrentPara();
        return;
      case 'slleading':
        st.slleading = clampInt(num ?? 0, 0, 20_000);
        if (st.slleading > docSlleading) docSlleading = st.slleading;
        syncCurrentPara();
        return;
      case 'li':
        st.li = clampInt(num ?? 0, -20_000, 20_000);
        syncCurrentPara();
        return;
      case 'fi':
        st.fi = clampInt(num ?? 0, -20_000, 20_000);
        syncCurrentPara();
        return;
      case 'ls':
        if (num !== undefined && num > 0) {
          hasBulletList = true;
          st.isBullet = true;
        }
        syncCurrentPara();
        return;
      case 'qc':
        st.align = 'center';
        st.alignSeen = true;
        syncCurrentPara();
        return;
      case 'ql':
        st.align = 'left';
        st.alignSeen = true;
        syncCurrentPara();
        return;
      case 'qr':
        st.align = 'right';
        st.alignSeen = true;
        syncCurrentPara();
        return;
      case 'qj':
        st.align = 'justify';
        st.alignSeen = true;
        syncCurrentPara();
        return;
      case 'strokewidth':
        st.strokeWidth = clampInt(num ?? 0, -2000, 2000);
        return;
      case 'strokec':
        st.strokeColor = num ?? 0;
        return;
      case 'red':
        if (st.dest === 'colortbl') colorDraft.r = clampInt(num ?? 0, 0, 255);
        return;
      case 'green':
        if (st.dest === 'colortbl') colorDraft.g = clampInt(num ?? 0, 0, 255);
        return;
      case 'blue':
        if (st.dest === 'colortbl') colorDraft.b = clampInt(num ?? 0, 0, 255);
        return;
      default:
        return;
    }
  }

  flushBytes();
  const tidied = tidyWithOffsets(out, rawSpans, rawParas);
  const text = wellFormed(tidied.text);
  const spans = tidied.spans;
  const paras = tidied.paras;
  const f = first as GroupState | null;
  const res: RtfResult = { text, bold: false, italic: false, styleRuns: styleKeys.size };
  if (spans.length > 0) res.spans = spans;
  if (paras.length > 0) res.paras = paras;
  if (f) {
    const name = fonts.get(f.font);
    if (name) res.fontName = name.slice(0, RTF_FONT_NAME_MAX);
    if (f.fsSeen) res.fontSizePt = f.fs / 2;
    const col = colors[f.cf];
    if (col) res.color = col;
    res.bold = f.b;
    res.italic = f.i;
    if (f.alignSeen) res.align = f.align === 'justify' ? 'left' : f.align;
    // `\slN\slmult1`: N/240 lines (240 twips is single spacing); an exact or at-least `\sl` is not a multiple.
    if (f.slmult && f.sl > 0) res.lineSpacing = Math.round((f.sl / 240) * 100) / 100;
    if (f.sa > 0) res.spaceAfterPt = f.sa / 20;
    const leading = f.slleading > 0 ? f.slleading : docSlleading;
    if (leading > 0) res.leadingPt = Math.min(500, Math.round((leading / 20) * 100) / 100);
    if (f.li) res.indentPt = Math.round((f.li / 20) * 100) / 100;
    if (f.fi) res.firstLinePt = Math.round((f.fi / 20) * 100) / 100;
    if (f.strokeWidth) {
      res.strokeWidth = f.strokeWidth;
      const sc = colors[f.strokeColor];
      if (sc) res.strokeColor = sc;
    }
  }
  if (hasBulletList) res.hasBulletList = true;
  return res;
}

/**
 * Turn a font name from an RTF font table (`HelveticaNeue-BoldItalic`, `Arial`, `Open Sans Bold`) into a CSS
 * family plus weight and style.
 */
export function splitFontName(name: string): { family: string; weight: number; italic: boolean } {
  let base = name.trim();
  let face = '';
  const dash = base.lastIndexOf('-');
  if (dash > 0 && !base.includes(' ')) {
    face = base.slice(dash + 1);
    base = base.slice(0, dash);
  } else {
    const m =
      /\s+((?:Extra|Ultra|Semi|Demi)?\s?(?:Thin|Light|Regular|Book|Medium|Bold|Black|Heavy|Italic|Oblique)(?:\s?(?:Italic|Oblique))?)$/i.exec(
        base,
      );
    if (m) {
      face = m[1]!;
      base = base.slice(0, m.index);
    }
  }
  if (!base.includes(' '))
    base = base
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/MT$/, '')
      .trim();
  const f = face.toLowerCase().replace(/\s/g, '');
  let weight = 400;
  if (/thin|hairline/.test(f)) weight = 100;
  else if (/extralight|ultralight/.test(f)) weight = 200;
  else if (/light/.test(f)) weight = 300;
  else if (/medium/.test(f)) weight = 500;
  else if (/semibold|demibold/.test(f)) weight = 600;
  else if (/extrabold|ultrabold/.test(f)) weight = 800;
  else if (/black|heavy/.test(f)) weight = 900;
  else if (/bold/.test(f)) weight = 700;
  return { family: base || name, weight, italic: /italic|oblique/.test(f) };
}
