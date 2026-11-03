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
].map((p) => p);
const FULL_RES = SECTION_PATTERNS.map((p) => ({ p, re: new RegExp(`^(?:${p.full})\\s*(\\d*)$`, 'i') }));
/** Abbreviations are case-sensitive so a lyric line like "c" or "be" is never taken for a label. */
const ABBR_RES = SECTION_PATTERNS.map((p) => ({ p, re: new RegExp(`^${p.abbr}(\\d*)$`) }));

/** If `line` is a section label (`Verse 1`, `[Chorus]`, `C2:`), return the normalized label and short form. */
export function parseSectionLabel(line: string): { label: string; short: string } | null {
  let t = line.trim();
  if (!t) return null;
  const bracket = /^\[(.+)\]$/.exec(t) ?? /^\{(?:c|comment|start_of_\w+)\s*:\s*(.+)\}$/i.exec(t);
  if (bracket) t = bracket[1]!.trim();
  t = t.replace(/:$/, '').trim();
  for (const { p, re } of [...FULL_RES, ...ABBR_RES]) {
    const m = re.exec(t);
    if (m) {
      const n = m[1] ?? '';
      return { label: `${p.label}${n ? ' ' + n : ''}`, short: `${p.short}${n}` };
    }
  }
  return null;
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
function isChordLine(line: string): boolean {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  return toks.length > 0 && toks.every((t) => CHORD_TOKEN.test(t) || t === '|' || t === '-');
}

/**
 * Parse plain lyrics, SongSelect's lyrics text export, or ChordPro.
 * Chord brackets `[G]` are stripped from lyrics and kept per line in `chords`.
 */
export function parseLyrics(input: string): ParsedSong {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const song: ParsedSong = { sections: [], order: [] };
  type Cur = ParsedSection & { _repeatOf?: ParsedSection };
  const ctx: { current: Cur | null } = { current: null };
  let stanza: string[] = [];
  let sawDirectiveTitle = false;
  const flush = () => {
    if (ctx.current && !ctx.current._repeatOf && stanza.length) ctx.current.stanzas.push(stanza);
    stanza = [];
  };
  const startSection = (label: string, short: string) => {
    flush();
    const existing = song.sections.find((s) => s.label === label);
    song.order.push(label);
    if (existing && existing.stanzas.length > 0) {
      // Repeated label with content again: a repeat; ignore the content if identical, else create numbered variant.
      ctx.current = { label, short, stanzas: [], _repeatOf: existing };
      return;
    }
    const next: Cur = existing ?? { label, short, stanzas: [] };
    ctx.current = next;
    if (!existing) song.sections.push(next);
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
      const key = dir[1]!.toLowerCase();
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
      else if (
        key === 'c' ||
        key === 'comment' ||
        key === 'ci' ||
        key === 'comment_italic' ||
        key.startsWith('start_of_')
      ) {
        const lbl = parseSectionLabel(val || key.replace('start_of_', ''));
        if (lbl) startSection(lbl.label, lbl.short);
      } else if (key.startsWith('end_of_')) {
        flush();
      }
      continue;
    }
    const label = parseSectionLabel(line);
    if (label) {
      startSection(label.label, label.short);
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
    const target = cur._repeatOf ?? cur;
    if (isChordLine(line)) {
      if (!cur._repeatOf) target.chords = [...(target.chords ?? []), line.trim()];
      continue;
    }
    const chords: string[] = [];
    const lyric = line.replace(/\[([^\]]+)\]/g, (_m, c: string) => {
      chords.push(c);
      return '';
    });
    if (chords.length && !cur._repeatOf) target.chords = [...(target.chords ?? []), chords.join(' ')];
    const clean = lyric.replace(/\s{2,}/g, ' ').trim();
    if (!clean) continue;
    if (cur._repeatOf) continue; // content of a repeated section is ignored; the arrangement repeats it
    stanza.push(clean);
  }
  flush();
  song.sections = song.sections.filter((s) => s.stanzas.length > 0);
  song.order = song.order.filter((l) => song.sections.some((s) => s.label === l));
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
