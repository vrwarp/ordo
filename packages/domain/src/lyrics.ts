import { newId } from './ids.ts';
import type { Presentation, Section, Slide, TextStyle, Box, Theme } from './schemas.ts';
import { DEFAULT_THEME } from './defaults.ts';

/** Known section labels and their short forms. Matching is case-insensitive. */
const SECTION_PATTERNS: { full: string; abbr: string; label: string; short: string }[] = [
  { full: 'verse', abbr: 'V', label: 'Verse', short: 'V' },
  { full: 'pre[- ]?chorus', abbr: 'PC', label: 'Pre-Chorus', short: 'PC' },
  { full: 'chorus', abbr: 'C', label: 'Chorus', short: 'C' },
  { full: 'bridge', abbr: 'B', label: 'Bridge', short: 'B' },
  { full: 'tag', abbr: 'T', label: 'Tag', short: 'T' },
  { full: 'ending|outro', abbr: 'E', label: 'Ending', short: 'E' },
  { full: 'intro', abbr: 'I', label: 'Intro', short: 'I' },
  { full: 'interlude', abbr: 'IL', label: 'Interlude', short: 'IL' },
  { full: 'instrumental', abbr: 'IN', label: 'Instrumental', short: 'IN' },
  { full: 'refrain', abbr: 'R', label: 'Refrain', short: 'R' },
  { full: 'vamp', abbr: 'VA', label: 'Vamp', short: 'VA' },
  { full: 'misc', abbr: 'M', label: 'Misc', short: 'M' },
].map((p) => p);
/** A number with an optional letter suffix (`1`, `1a`), as SongSelect and CCLI exports use. */
const NUM = '(\\d+[a-zA-Z]?)?';
const FULL_RES = SECTION_PATTERNS.map((p) => ({ p, re: new RegExp(`^(?:${p.full})\\s*${NUM}$`, 'i') }));
/** Abbreviations are case-sensitive so a lyric line like "c" or "be" is never taken for a label. */
const ABBR_RES = SECTION_PATTERNS.map((p) => ({ p, re: new RegExp(`^${p.abbr}${NUM}$`) }));
/** Trailing repeat markers on a label: `x2`, `×2`, `2x`, `(x2)`, `(repeat)`, `repeat 3 times`. */
const REPEAT_RE = /\s*\(?\s*(?:[x×]\s*(\d+)|(\d+)\s*[x×]|repeat(?:\s*(\d+)\s*(?:times|x))?)\s*\)?\s*:?$/i;
/** ChordPro short section directives (`{soc}` … `{eob}`) and their long forms. */
export const CHORDPRO_SECTION_DIRECTIVES: Record<string, string> = {
  soc: 'start_of_chorus',
  eoc: 'end_of_chorus',
  sov: 'start_of_verse',
  eov: 'end_of_verse',
  sob: 'start_of_bridge',
  eob: 'end_of_bridge',
  sot: 'start_of_tab',
  eot: 'end_of_tab',
};

export type SectionLabel = { label: string; short: string; repeat?: number };

/**
 * If `line` is a section label (`Verse 1`, `[Chorus]`, `C2:`, `(Chorus)`, `Verse 1a`, `Chorus x2`), return the
 * normalized label and short form. A repeat marker (`x2`) is stripped and reported as `repeat`.
 */
export function parseSectionLabel(line: string): SectionLabel | null {
  let t = line.trim();
  if (!t) return null;
  const bracket =
    /^\[(.+)\]$/.exec(t) ?? /^\((.+)\)$/.exec(t) ?? /^\{(?:c|comment|start_of_\w+)\s*:\s*(.+)\}$/i.exec(t);
  if (bracket) t = bracket[1]!.trim();
  t = t.replace(/:$/, '').trim();
  let repeat: number | undefined;
  const rep = REPEAT_RE.exec(t);
  if (rep && rep.index > 0) {
    const n = Number(rep[1] ?? rep[2] ?? rep[3] ?? 2);
    repeat = Number.isFinite(n) && n > 1 ? n : 2;
    t = t.slice(0, rep.index).trim();
  }
  // Parentheses around the label after the marker was removed: `(Chorus) x2`.
  const paren = /^\((.+)\)$/.exec(t);
  if (paren) t = paren[1]!.trim();
  t = t.replace(/:$/, '').trim();
  for (const { p, re } of [...FULL_RES, ...ABBR_RES]) {
    const m = re.exec(t);
    if (m) {
      const n = (m[1] ?? '').toLowerCase();
      const out: SectionLabel = { label: `${p.label}${n ? ' ' + n : ''}`, short: `${p.short}${n}` };
      if (repeat) out.repeat = repeat;
      return out;
    }
  }
  return null;
}

/** Split a label into its base (`Chorus`) and numeric part (`2` of `Chorus 2`, `1a` → 1). */
function splitLabel(label: string): { base: string; n: number } {
  const m = /^(.*?)\s*(\d+)[a-z]?$/i.exec(label);
  return m ? { base: m[1]!, n: Number(m[2]) } : { base: label, n: 0 };
}

/** The next free numbered label for `base` among `labels` (`Chorus` + `Chorus 2` → `Chorus 3`). */
export function nextFreeLabel(base: string, labels: readonly string[]): string {
  let max = 0;
  for (const l of labels) {
    const s = splitLabel(l);
    if (s.base.toLowerCase() !== base.toLowerCase()) continue;
    max = Math.max(max, s.n || 1);
  }
  return `${base} ${max + 1}`;
}

function normLine(l: string): string {
  return l.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True when two stanza lists carry the same lyrics (case and spacing ignored). */
export function sameStanzas(a: readonly string[][], b: readonly string[][]): boolean {
  const fa = a.flat().map(normLine);
  const fb = b.flat().map(normLine);
  return fa.length === fb.length && fa.every((l, i) => l === fb[i]);
}

export type ParsedSection = {
  label: string;
  short: string /** stanzas = blocks separated by blank lines */;
  stanzas: string[][];
  chords?: string[];
};
export type ParsedSong = {
  title?: string;
  author?: string;
  ccli?: string;
  copyright?: string;
  key?: string;
  tempo?: number;
  sections: ParsedSection[];
  /** Section labels in the order they appeared, used as the default arrangement when it repeats. */
  order: string[];
};

const CHORD_TOKEN = /^[A-G](?:#|b)?(?:m|maj|min|dim|aug|sus|add)?\d*(?:\/[A-G](?:#|b)?)?$/;
/** Bracketed chords (`[G]`, `[Am7]`) anywhere in the file mark it as a chord chart. */
const BRACKET_CHORD = /\[[A-G](?:#|b)?(?:m|maj|min|dim|aug|sus|add)?\d*(?:\/[A-G](?:#|b)?)?\]/;

/**
 * A line made of chord symbols only. A single token (`A`, `Am`) is a lyric unless the file has bracketed
 * chords elsewhere: lines such as "A" or "Be" occur in lyrics far more often than one-chord lines.
 */
export function isChordLine(line: string, chordChart = false): boolean {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return false;
  if (!toks.every((t) => CHORD_TOKEN.test(t) || t === '|' || t === '-')) return false;
  const chords = toks.filter((t) => CHORD_TOKEN.test(t)).length;
  return chords >= 2 || chordChart;
}

/**
 * Parse plain lyrics, SongSelect's lyrics text export, or ChordPro.
 * Chord brackets `[G]` are stripped from lyrics and kept per line in `chords`.
 *
 * A repeated label (`Chorus` again) repeats the section in `order`; when its lyrics differ from the first
 * occurrence it becomes the next free numbered section (`Chorus 2`) instead.
 */
export function parseLyrics(input: string): ParsedSong {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const song: ParsedSong = { sections: [], order: [] };
  const chordChart = BRACKET_CHORD.test(input);
  /** The section being collected; `_repeatOf` is set while re-reading an existing label. */
  type Cur = ParsedSection & { _repeatOf?: ParsedSection; _orderIndex: number; _repeat: number };
  const ctx: { current: Cur | null } = { current: null };
  let stanza: string[] = [];
  let sawDirectiveTitle = false;
  const flush = () => {
    if (ctx.current && stanza.length) ctx.current.stanzas.push(stanza);
    stanza = [];
  };
  /** A repeated label has been fully read: keep it as a repeat, or promote differing lyrics to a new section. */
  const settle = () => {
    const cur = ctx.current;
    if (!cur?._repeatOf) return;
    const existing = cur._repeatOf;
    if (cur.stanzas.length === 0 || sameStanzas(cur.stanzas, existing.stanzas)) return;
    const { base } = splitLabel(existing.label);
    const twin = song.sections.find(
      (sec) =>
        sec !== existing && splitLabel(sec.label).base === base && sameStanzas(sec.stanzas, cur.stanzas),
    );
    let label: string;
    if (twin) label = twin.label;
    else {
      label = nextFreeLabel(
        base,
        song.sections.map((sec) => sec.label),
      );
      const short = parseSectionLabel(label)?.short ?? label;
      const next: ParsedSection = { label, short, stanzas: cur.stanzas };
      if (cur.chords?.length) next.chords = cur.chords;
      song.sections.push(next);
    }
    for (let i = 0; i < cur._repeat; i++) song.order[cur._orderIndex + i] = label;
  };
  const startSection = (label: string, short: string, repeat = 1) => {
    flush();
    settle();
    const existing = song.sections.find((s) => s.label === label);
    const orderIndex = song.order.length;
    for (let i = 0; i < repeat; i++) song.order.push(label);
    if (existing && existing.stanzas.length > 0) {
      ctx.current = {
        label,
        short,
        stanzas: [],
        _repeatOf: existing,
        _orderIndex: orderIndex,
        _repeat: repeat,
      };
      return;
    }
    const next: Cur = existing
      ? Object.assign(existing, { _orderIndex: orderIndex, _repeat: repeat })
      : { label, short, stanzas: [], _orderIndex: orderIndex, _repeat: repeat };
    ctx.current = next;
    if (!existing) song.sections.push(next);
  };
  /** `{sov}` / `{start_of_verse}` without a name: the next free verse number. */
  const startDirectiveSection = (kind: string, val: string) => {
    let lbl = parseSectionLabel(val || kind);
    if (!lbl) return;
    if (!val && /^verse$/i.test(kind)) {
      const label = nextFreeLabel(
        'Verse',
        song.sections.map((s) => s.label),
      );
      lbl = parseSectionLabel(label) ?? lbl;
    }
    startSection(lbl.label, lbl.short, lbl.repeat);
  };

  // Footer detection for SongSelect text exports: everything from "CCLI Song #" on, else trailing licence lines.
  const footer: string[] = [];
  const songLine = lines.findIndex((l) => /^\s*ccli\s*song\s*#?/i.test(l));
  if (songLine >= 0) {
    footer.push(
      ...lines
        .splice(songLine)
        .map((l) => l.trim())
        .filter(Boolean),
    );
  } else {
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!.trim();
      if (!l) continue;
      if (/^©|copyright|^for use solely|^ccli/i.test(l)) {
        footer.unshift(l);
        lines.splice(i, 1);
        continue;
      }
      break;
    }
  }
  const authorLine = songLine >= 0 ? footer[1] : undefined;
  if (authorLine && !/©|copyright|^for use|^ccli/i.test(authorLine)) song.author = authorLine;
  for (const f of footer) {
    const m = /ccli\s*(?:song)?\s*#?\s*(\d{3,})/i.exec(f);
    if (m && !/license/i.test(f)) song.ccli = m[1];
    if (/©|copyright/i.test(f)) song.copyright = f.replace(/^©\s*/, '');
  }

  let lineIndex = 0;
  for (const raw of lines) {
    lineIndex++;
    const line = raw.replace(/\s+$/, '');
    const dir = /^\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}$/i.exec(line.trim());
    if (dir) {
      const short = CHORDPRO_SECTION_DIRECTIVES[dir[1]!.toLowerCase()];
      const key = short ?? dir[1]!.toLowerCase();
      const val = (dir[2] ?? '').trim();
      if (key === 'title' || key === 't') {
        song.title = val;
        sawDirectiveTitle = true;
      } else if (
        key === 'artist' ||
        key === 'author' ||
        key === 'composer' ||
        key === 'subtitle' ||
        key === 'st'
      ) {
        song.author = song.author ?? val;
      } else if (key === 'ccli') song.ccli = val;
      else if (key === 'copyright') song.copyright = val;
      else if (key === 'key') song.key = val;
      else if (key === 'tempo') song.tempo = Number(val) || undefined;
      else if (key === 'c' || key === 'comment' || key === 'ci' || key === 'comment_italic') {
        const lbl = parseSectionLabel(val);
        if (lbl) startSection(lbl.label, lbl.short, lbl.repeat);
      } else if (key.startsWith('start_of_')) {
        startDirectiveSection(key.replace('start_of_', ''), val);
      } else if (key.startsWith('end_of_')) {
        flush();
      }
      continue;
    }
    const label = parseSectionLabel(line);
    if (label) {
      startSection(label.label, label.short, label.repeat);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // Title heuristic: first non-empty line of a plain/SongSelect file before any section.
    if (!ctx.current && !sawDirectiveTitle && !song.title && song.sections.length === 0 && lineIndex <= 3) {
      song.title = line.trim();
      continue;
    }
    if (!ctx.current) startSection('Verse 1', 'V1');
    const cur = ctx.current as unknown as Cur;
    if (isChordLine(line, chordChart)) {
      cur.chords = [...(cur.chords ?? []), line.trim()];
      continue;
    }
    const chords: string[] = [];
    const lyric = line.replace(/\[([^\]]+)\]/g, (_m, c: string) => {
      chords.push(c);
      return '';
    });
    if (chords.length) cur.chords = [...(cur.chords ?? []), chords.join(' ')];
    const clean = lyric.replace(/\s{2,}/g, ' ').trim();
    if (!clean) continue;
    stanza.push(clean);
  }
  flush();
  settle();
  song.sections = song.sections.filter((s) => s.stanzas.length > 0);
  song.order = song.order.filter((l) => song.sections.some((s) => s.label === l));
  for (const sec of song.sections) {
    const c = sec as Partial<Cur>;
    delete c._orderIndex;
    delete c._repeat;
    delete c._repeatOf;
  }
  return song;
}

/** Split a section's stanzas into slide texts. Stanzas longer than linesPerSlide are chunked. */
export function sectionSlideTexts(section: ParsedSection, linesPerSlide: number): string[] {
  const out: string[] = [];
  for (const st of section.stanzas) {
    if (st.length <= linesPerSlide) {
      out.push(st.join('\n'));
      continue;
    }
    for (let i = 0; i < st.length; i += linesPerSlide) out.push(st.slice(i, i + linesPerSlide).join('\n'));
  }
  return out;
}

export function lyricSlide(text: string, theme: Pick<Theme, 'lyricBox' | 'text'> = DEFAULT_THEME): Slide {
  const objId = newId();
  return {
    id: newId(),
    objects: [
      { id: objId, type: 'text', box: { ...theme.lyricBox }, text, style: { ...theme.text }, opacity: 1 },
    ],
    lyricObjectId: objId,
  };
}

/** Build a song presentation from parsed lyrics. */
export function songFromParsed(
  parsed: ParsedSong,
  opts: { title?: string; linesPerSlide?: number; theme?: Theme; source?: Presentation['source'] } = {},
): Presentation {
  const lps = opts.linesPerSlide ?? 2;
  const theme = opts.theme ?? DEFAULT_THEME;
  const sections: Section[] = parsed.sections.map((ps) => ({
    id: newId(),
    label: ps.label,
    short: ps.short,
    slides: sectionSlideTexts(ps, lps).map((t) => lyricSlide(t, theme)),
    chords: ps.chords,
  }));
  const byLabel = new Map(sections.map((s) => [s.label, s.id]));
  const authoring = sections.map((s) => s.id);
  const orderIds = parsed.order.map((l) => byLabel.get(l)!).filter(Boolean);
  const arrangements = [
    { id: newId(), name: 'Default', sectionIds: orderIds.length > authoring.length ? orderIds : authoring },
  ];
  return {
    id: newId(),
    rev: 1,
    title: opts.title ?? parsed.title ?? 'Untitled song',
    kind: 'song',
    meta: {
      author: parsed.author,
      ccli: parsed.ccli,
      copyright: parsed.copyright,
      key: parsed.key,
      tempo: parsed.tempo,
      tags: [],
    },
    themeId: opts.theme?.id,
    sections,
    arrangements,
    linesPerSlide: lps,
    source: opts.source ?? { kind: 'paste' },
    archived: false,
  };
}

export function textStyleWith(base: TextStyle, patch: Partial<TextStyle>): TextStyle {
  return { ...base, ...patch };
}
export type { Box };
