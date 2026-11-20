import type { Presentation } from '@ordo/domain';
import type { RevisionInfo } from '@ordo/protocol';
import type { Logger } from 'pino';
import type { DB } from './db.ts';

/**
 * Revision summaries (design/28 P2, pulled forward for the title only): the History list of a deck reads one small row
 * per kept revision instead of parsing every revision's JSON. A revision is a full copy of its presentation, up to 8 MiB.
 *
 * Stub of the red commit: the reading is still the old one, so the tests of the summaries fail on behaviour.
 */

/** The first characters of a revision's JSON in which the title is looked for (a presentation stores it third). */
export const TITLE_PREFIX_CHARS = 16 * 1024;
/** The larger look, for a body that stores its title later. */
export const TITLE_WIDE_PREFIX_CHARS = 1024 * 1024;

/**
 * The raw JSON string literal of the top-level `title` of `prefix` (the first characters of an object's JSON), or
 * undefined when it cannot be told from this much of the text.
 */
export function titleTokenIn(_prefix: string): string | undefined {
  return undefined;
}

export class RevisionSummaries {
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /** Remember the summary of a revision just written (the title as its JSON string literal). */
  record(_id: string, _rev: number, _title: string, _savedBy: string | null, _savedAt: string): void {}

  list(id: string): RevisionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT rev, json, saved_by, saved_at FROM presentation_revisions WHERE presentation_id = ? ORDER BY rev DESC`,
      )
      .all(id) as { rev: number; json: string; saved_by: string | null; saved_at: string }[];
    return rows.map((r) => ({
      rev: r.rev,
      savedAt: r.saved_at,
      savedBy: r.saved_by ?? undefined,
      title: (JSON.parse(r.json) as Presentation).title,
    }));
  }

  /** Read one revision, record its summary and return it (undefined when the revision is gone). */
  summarize(_id: string, _rev: number): RevisionInfo | undefined {
    return undefined;
  }

  /** The first revision after `after` (presentation id, rev) that has no summary. */
  next(_after?: { id: string; rev: number }): { id: string; rev: number } | undefined {
    return undefined;
  }

  /** How many revisions have no summary. */
  count(): number {
    return 0;
  }
}

export type RevisionBackfillOptions = {
  live: () => 'idle' | 'live';
  log: Logger;
  now?: () => number;
  yield?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each revision read (tests count them and advance their clock). */
  onRead?: (presentationId: string, rev: number) => void;
  sliceMs?: number;
  startDelayMs?: number;
};

/** The one-off summary of the revisions a hub that did not keep summaries saved. Stub of the red commit. */
export class RevisionTitleBackfill {
  private opts: RevisionBackfillOptions;
  constructor(_summaries: RevisionSummaries, opts: RevisionBackfillOptions) {
    this.opts = opts;
  }
  start(): void {}
  stop(): void {}
  onLiveMode(_mode: 'idle' | 'live'): void {}
  async run(): Promise<void> {
    void this.opts;
  }
}
