/**
 * Notes about a deck (design/27 §12 "Logs"). Deck-derived strings (titles, hosts, font and part names) go
 * through `clean` before they reach a note, so a deck cannot forge `[warn]`/`[error]` lines or the
 * 'HH:MM:SS msg' format of a job log.
 */

/** Receives one note: what was approximated, skipped or refused. */
export type Log = (msg: string) => void;

/** At most this many notes are kept per slide and per deck; the rest are counted. */
export const MAX_NOTES = 200;

/** A deck string made safe for a log line: control characters and newlines removed, cut to `max`. */
export function clean(s: string, max = 200): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Longest note kept: each deck string in it is cut to 200 characters before it is composed. */
export const MAX_NOTE_CHARS = 400;

/**
 * A bounded, de-duplicated list of notes with a `log` function that appends to it. Every note goes through
 * `clean` as well, so a deck string that reached one without it still cannot break a log line.
 */
export function noteList(max = MAX_NOTES): { notes: string[]; log: Log } {
  const notes: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const log: Log = (raw) => {
    const msg = clean(raw, MAX_NOTE_CHARS);
    if (seen.has(msg)) return;
    if (notes.length < max - 1) {
      seen.add(msg);
      notes.push(msg);
    } else notes[max - 1] = `… ${++dropped} more`; // not remembered: `seen` stays bounded
  };
  return { notes, log };
}

/**
 * The provenance notes a slide stores (`Slide.pptx.notes`, the schema's `max(16)`, each at most 200
 * characters): every writer of a slide's notes adds through `addNote`, so the list stays within the schema
 * and says how much it left out instead of losing notes at the end (design/27 M9: six areas add notes).
 * Notes left out are not remembered (the list stays bounded), so one given twice after the overflow counts
 * twice.
 */
export const SLIDE_NOTES = 16;
export const SLIDE_NOTE_CHARS = 200;

/** How many notes a list's last entry stands for, once it overflowed (`addNote`). */
const overflow = new WeakMap<string[], number>();
const MORE = /^and (\d{1,9}) more$/;

/**
 * Add a note to a slide's stored notes (`list`, changed in place): cleaned and cut to `SLIDE_NOTE_CHARS`,
 * skipped when the list holds it already. Up to `max` notes are kept; past that the list keeps its first
 * `max - 1` and ends with 'and N more', N counting every note left out since. Returns the list.
 */
export function addNote(list: string[], note: string, max = SLIDE_NOTES): string[] {
  const msg = clean(note, SLIDE_NOTE_CHARS);
  if (!msg || max < 1 || list.includes(msg)) return list;
  let more = overflow.get(list);
  if (more === undefined && list.length >= max) {
    // A list copied from one that overflowed: its last entry says how many it stands for.
    const m = MORE.exec(list[max - 1] ?? '');
    if (m) more = Number(m[1]);
  }
  if (more === undefined && list.length < max) {
    list.push(msg);
    return list;
  }
  // Overflow: the last kept note gives its place to the count (one note more than before, or two: it and
  // this one).
  more = more === undefined ? list.length - (max - 1) + 1 : more + 1;
  list.length = max;
  list[max - 1] = `and ${more} more`;
  overflow.set(list, more);
  return list;
}
