/**
 * What a native import reports (design/27 §11 item 12, §12 "Logs"; M3 item B): the `pptx-native` job's
 * result for the import card, and `Presentation.source.log`. Deck-derived strings (titles, hosts, font and
 * part names) reach a log line only through `logSafe`: control characters and newlines removed, cut to 200
 * characters, so a deck cannot forge `[warn]`/`[error]` lines or the 'HH:MM:SS msg' format.
 */
import { clean } from '@ordo/pptx-scene/log.ts';
import { BUNDLED_FACES, bundledSubstitute } from '../fonts/bundled.ts';
import type { PptxNativeResult } from './shared.ts';

/** A deck-derived string made safe for a job log line or `source.log`. */
export function logSafe(s: string, max = 200): string {
  return clean(s, max);
}

/** Notes the import card shows; `source.log` keeps every line. */
export const RESULT_NOTES = 20;
/** Missing families the import card names. */
export const RESULT_FONTS = 20;
/** `Presentation.source.log` is at most this long (`MAX.long` of `@ordo/domain`). */
export const SOURCE_LOG_CHARS = 200_000;

/** The import card's numbers and notes from what the job saved and logged. */
export function importResult(input: {
  presentationId: string;
  classes: readonly ('native' | 'hybrid' | 'picture')[];
  compact: number;
  pending: number;
  loJobId?: string;
  missingFonts: readonly string[];
  notes: readonly string[];
}): PptxNativeResult {
  const count = (c: 'native' | 'hybrid' | 'picture') => input.classes.filter((k) => k === c).length;
  return {
    presentationId: input.presentationId,
    slides: input.classes.length,
    native: count('native'),
    hybrid: count('hybrid'),
    picture: count('picture'),
    compact: input.compact,
    pending: input.pending,
    ...(input.loJobId ? { loJobId: input.loJobId } : {}),
    missingFonts: input.missingFonts.slice(0, RESULT_FONTS).map((f) => logSafe(f, 100)),
    notes: input.notes.slice(0, RESULT_NOTES).map((n) => logSafe(n, 300)),
  };
}

/**
 * Families every output can draw with exact line breaks before any upload: ordo's default font, generic
 * families, the bundled faces and the Office faces with a bundled metric-compatible substitute (design/27
 * §10, `fonts/bundled.ts`).
 */
const GENERIC: ReadonlySet<string> = new Set(['sans-serif', 'serif', 'monospace', 'system-ui']);
const BUNDLED: ReadonlySet<string> = new Set(BUNDLED_FACES.map((f) => f.family.toLowerCase()));

function covered(k: string): boolean {
  return GENERIC.has(k) || BUNDLED.has(k) || bundledSubstitute(k) !== undefined;
}

/**
 * The families a deck's text uses that neither the library's fonts nor a metric-compatible substitute
 * cover: the import card offers an upload ("Upload Century Gothic for exact line breaks"). In first-use
 * order, each once (case-insensitive), cleaned for display.
 */
export function missingFonts(used: Iterable<string>, library: Iterable<string>): string[] {
  const have = new Set<string>();
  for (const f of library) have.add(f.trim().toLowerCase());
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of used) {
    const f = logSafe(raw, 100);
    const k = f.toLowerCase();
    if (!f || seen.has(k)) continue;
    seen.add(k);
    if (have.has(k) || covered(k)) continue;
    out.push(f);
    if (out.length >= RESULT_FONTS) break;
  }
  return out;
}

/** `source.log` lines, each sanitised, the whole bounded (the last line says how many were left out). */
export class ImportLog {
  private lines: string[] = [];
  private chars = 0;
  private dropped = 0;

  /** Add a line: `msg` is composed by the job, with every deck string already through `logSafe`. */
  add(level: 'info' | 'warn', msg: string): void {
    const line = `${level === 'warn' ? '[warn] ' : ''}${logSafe(msg, 400)}`;
    if (this.chars + line.length + 1 > SOURCE_LOG_CHARS - 100) {
      this.dropped++;
      return;
    }
    this.lines.push(line);
    this.chars += line.length + 1;
  }

  /** The warnings, in order (the import card's notes). */
  warnings(): string[] {
    return this.lines.filter((l) => l.startsWith('[warn] ')).map((l) => l.slice(7));
  }

  toString(): string {
    return [...this.lines, ...(this.dropped ? [`… ${this.dropped} more line(s)`] : [])].join('\n');
  }
}
