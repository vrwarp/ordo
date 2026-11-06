/**
 * What a native import reports (design/27 §11 item 12, §12 "Logs"; M3 item B): the `pptx-native` job's
 * result for the import card, and `Presentation.source.log`. Deck-derived strings (titles, hosts, font and
 * part names) reach a log line only through `logSafe`: control characters and newlines removed, cut to 200
 * characters, so a deck cannot forge `[warn]`/`[error]` lines or the 'HH:MM:SS msg' format.
 */
import { clean } from '@ordo/pptx-scene/log.ts';
import type { PptxNativeResult } from './shared.ts';
import { notYet } from './shared.ts';

/** A deck-derived string made safe for a job log line or `source.log`. */
export function logSafe(s: string, max = 200): string {
  return clean(s, max);
}

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
  void input;
  throw notYet('B', 'importResult');
}
