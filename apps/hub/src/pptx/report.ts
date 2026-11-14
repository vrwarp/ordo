/**
 * What a native import reports (design/27 §11 item 12, §12 "Logs"; M3 item B): the `pptx-native` job's
 * result for the import card, and `Presentation.source.log`. Deck-derived strings (titles, hosts, font and
 * part names) reach a log line only through `logSafe`: control characters and newlines removed, cut to 200
 * characters, so a deck cannot forge `[warn]`/`[error]` lines or the 'HH:MM:SS msg' format.
 */
import { logSafe, RESULT_FONTS, RESULT_NOTES } from '@ordo/importers/pptx-report.ts';
import type { PptxNativeResult } from './shared.ts';

// `source.log`, `logSafe` and `missingFonts` are the import core's (`@ordo/importers` `pptx-report.ts`),
// which the client parse shares; the import card's result is the hub's.
export {
  ImportLog,
  logSafe,
  missingFonts,
  RESULT_FONTS,
  RESULT_NOTES,
  SOURCE_LOG_CHARS,
} from '@ordo/importers/pptx-report.ts';

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
