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

/** A bounded, de-duplicated list of notes with a `log` function that appends to it. */
export function noteList(max = MAX_NOTES): { notes: string[]; log: Log } {
  const notes: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const log: Log = (msg) => {
    if (seen.has(msg)) return;
    if (notes.length < max - 1) {
      seen.add(msg);
      notes.push(msg);
    } else notes[max - 1] = `… ${++dropped} more`; // not remembered: `seen` stays bounded
  };
  return { notes, log };
}
