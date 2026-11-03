import type { Rgba } from '@ordo/domain';

/** Plain text and the first run's character style extracted from an RTF document. */
export interface RtfResult {
  text: string;
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
}

type Dest = 'text' | 'fonttbl' | 'colortbl' | 'skip';

interface GroupState {
  dest: Dest;
  font: number;
  fs: number;
  cf: number;
  b: boolean;
  i: boolean;
  align: 'left' | 'center' | 'right' | 'justify';
  uc: number;
  strokeWidth: number;
  strokeColor: number;
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
  'expandedcolortbl',
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
 * destinations) and the first run's font, size, colour, weight, alignment and stroke.
 */
export function parseRtf(input: string | Uint8Array): RtfResult {
  const src = typeof input === 'string' ? input : rtfBytesToString(input);
  const fonts = new Map<number, string>();
  const colors: (Rgba | null)[] = [];
  let curFontIdx = -1;
  let fontName = '';
  let colorDraft: { r?: number; g?: number; b?: number } = {};

  const initial: GroupState = {
    dest: 'text',
    font: 0,
    fs: 24,
    cf: 0,
    b: false,
    i: false,
    align: 'left',
    uc: 1,
    strokeWidth: 0,
    strokeColor: 0,
  };
  const stack: GroupState[] = [];
  let st: GroupState = { ...initial };
  let out = '';
  let first: GroupState | null = null;
  const styleKeys = new Set<string>();
  let skipChars = 0;
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
        } else fontName += ch;
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
    let text = chars;
    if (skipChars > 0) {
      const n = Math.min(skipChars, text.length);
      text = text.slice(n);
      skipChars -= n;
    }
    if (!text) return;
    if (/\S/.test(text) && text !== '\n') {
      if (!first) first = { ...st };
      styleKeys.add(`${st.font}|${st.fs}|${st.cf}|${st.b}|${st.i}|${st.strokeWidth}|${st.strokeColor}`);
    }
    out += text;
  };

  const n = src.length;
  let p = 0;
  while (p < n) {
    const c = src[p]!;
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
        const num = numStr ? Number(numStr) : undefined;
        const wasGroupStart = groupStart;
        groupStart = false;
        if (wasGroupStart || starPending) {
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
            st.dest = 'skip';
            continue;
          }
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
        if (!Number.isNaN(byte)) emit(cp1252(byte));
        groupStart = false;
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
        st.uc = num ?? 1;
        return;
      case 'f':
        if (st.dest === 'fonttbl') {
          curFontIdx = num ?? 0;
          fontName = '';
        } else st.font = num ?? 0;
        return;
      case 'fs':
        st.fs = num ?? 24;
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
      case 'plain':
        st.font = 0;
        st.fs = 24;
        st.cf = 0;
        st.b = false;
        st.i = false;
        st.strokeWidth = 0;
        st.strokeColor = 0;
        return;
      case 'pard':
        st.align = 'left';
        return;
      case 'qc':
        st.align = 'center';
        return;
      case 'ql':
        st.align = 'left';
        return;
      case 'qr':
        st.align = 'right';
        return;
      case 'qj':
        st.align = 'justify';
        return;
      case 'strokewidth':
        st.strokeWidth = num ?? 0;
        return;
      case 'strokec':
        st.strokeColor = num ?? 0;
        return;
      case 'red':
        if (st.dest === 'colortbl') colorDraft.r = num ?? 0;
        return;
      case 'green':
        if (st.dest === 'colortbl') colorDraft.g = num ?? 0;
        return;
      case 'blue':
        if (st.dest === 'colortbl') colorDraft.b = num ?? 0;
        return;
      default:
        return;
    }
  }

  const text = out
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+$/, '')
    .replace(/^\n+/, '');
  const f = first as GroupState | null;
  const res: RtfResult = { text, bold: false, italic: false, styleRuns: styleKeys.size };
  if (f) {
    const name = fonts.get(f.font);
    if (name) res.fontName = name;
    res.fontSizePt = f.fs / 2;
    const col = colors[f.cf];
    if (col) res.color = col;
    res.bold = f.b;
    res.italic = f.i;
    res.align = f.align === 'justify' ? 'left' : f.align;
    if (f.strokeWidth) {
      res.strokeWidth = f.strokeWidth;
      const sc = colors[f.strokeColor];
      if (sc) res.strokeColor = sc;
    }
  }
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
