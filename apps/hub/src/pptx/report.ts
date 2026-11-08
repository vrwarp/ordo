/**
 * What a native import reports (design/27 §11 item 12, §12 "Logs"; M3 item B): the `pptx-native` job's
 * result for the import card, and `Presentation.source.log`. Deck-derived strings (titles, hosts, font and
 * part names) reach a log line only through `logSafe`: control characters and newlines removed, cut to 200
 * characters, so a deck cannot forge `[warn]`/`[error]` lines or the 'HH:MM:SS msg' format.
 */
import { clean } from '@ordo/pptx-scene/log.ts';
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
  /** M9 `ladder`: slides the budget ladder simplified (absent: none counted, an older import). */
  simplified?: number;
  /** M9: slides with something nothing draws (`Slide.pptx.missing`). */
  missing?: number;
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
    ...(input.simplified !== undefined ? { simplified: input.simplified } : {}),
    pending: input.pending,
    ...(input.loJobId ? { loJobId: input.loJobId } : {}),
    missingFonts: input.missingFonts.slice(0, RESULT_FONTS).map((f) => logSafe(f, 100)),
    notes: input.notes.slice(0, RESULT_NOTES).map((n) => logSafe(n, 300)),
    ...(input.missing !== undefined ? { missing: input.missing } : {}),
  };
}

/** Generic families: every output draws them as they are. */
const GENERIC: ReadonlySet<string> = new Set(['sans-serif', 'serif', 'monospace', 'system-ui']);

function covered(k: string): boolean {
  return GENERIC.has(k);
}

/**
 * The families a deck's text uses that the library's fonts do not cover: the import card offers an upload
 * ("Upload Century Gothic for exact line breaks"). In first-use order, each once (case-insensitive), cleaned
 * for display. A bundled metric-compatible substitute (Calibri → Carlito, design/27 §10, `fonts/bundled.ts`)
 * does not count yet: no drawer of this build uses substitutes (M2's font resolver does), so an output
 * without the family draws it in the default font, and the card says so.
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
