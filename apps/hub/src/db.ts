import Database from 'better-sqlite3';

export type DB = Database.Database;

/**
 * Numbered migrations. Each is idempotent (IF NOT EXISTS everywhere) so re-running one after a crash
 * mid-migration is safe. `PRAGMA user_version` records the last applied number.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'library',
    sql: `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS presentations (
  id TEXT PRIMARY KEY, rev INTEGER NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
  folder_id TEXT, archived INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS presentations_title ON presentations(title);
CREATE TABLE IF NOT EXISTS presentation_revisions (
  presentation_id TEXT NOT NULL, rev INTEGER NOT NULL, json TEXT NOT NULL,
  saved_by TEXT, saved_at TEXT NOT NULL, PRIMARY KEY (presentation_id, rev));
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY, rev INTEGER NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, rev INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
  json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, mime TEXT NOT NULL, path TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fonts (
  id TEXT PRIMARY KEY, family TEXT NOT NULL, weight INTEGER NOT NULL, style TEXT NOT NULL,
  json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS fonts_family ON fonts(family);
CREATE TABLE IF NOT EXISTS themes (
  id TEXT PRIMARY KEY, rev INTEGER NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, rev INTEGER NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, rev INTEGER NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL);
`,
  },
  {
    version: 2,
    name: 'auth',
    sql: `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, ua_hash TEXT NOT NULL, remembered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, ua_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_attempts_ip_at ON auth_attempts(ip, at);
CREATE INDEX IF NOT EXISTS auth_attempts_at ON auth_attempts(at);
`,
  },
  {
    version: 3,
    name: 'jobs-live',
    sql: `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, class TEXT NOT NULL, state TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
  payload TEXT NOT NULL, log TEXT NOT NULL DEFAULT '[]', result TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, created_at);
CREATE TABLE IF NOT EXISTS live_journal (
  seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, cmd_id TEXT, kind TEXT NOT NULL DEFAULT 'event', event_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS live_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, json TEXT NOT NULL, saved_at INTEGER NOT NULL);
`,
  },
  {
    version: 4,
    name: 'uploads',
    sql: `
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER, offset INTEGER NOT NULL DEFAULT 0,
  fields TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`,
  },
  {
    version: 5,
    name: 'library-changes',
    // One row per library change at the library seq it was emitted with, so GET /library/snapshot?since=
    // can answer with deltas. Pruned to the last LIBRARY_CHANGES_KEEP seqs.
    sql: `
CREATE TABLE IF NOT EXISTS library_changes (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS library_changes_seq ON library_changes(seq);
`,
  },
  {
    version: 6,
    name: 'live-snapshot-history',
    // The two snapshots before the current one (design/25): a snapshot that fails validation on restore
    // falls back to the newest good one of these.
    sql: `
CREATE TABLE IF NOT EXISTS live_snapshot_prev (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL, json TEXT NOT NULL, saved_at INTEGER NOT NULL);
`,
  },
  {
    version: 7,
    name: 'job-attempts',
    // How many times a job was started. A job that was running when its process died is re-queued with
    // the count kept, and fails for good after MAX_JOB_ATTEMPTS instead of crashing the process in a loop.
    // (A side table rather than a column, so every migration stays idempotent.)
    sql: `
CREATE TABLE IF NOT EXISTS job_attempts (job_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0);
`,
  },
  {
    version: 8,
    name: 'media-hashes',
    // The SHA-256 media hash index (design/27 §4; apps/hub/src/pptx/mediaParts.ts): imports find media with
    // the same content without scanning every media row. 'content' rows hold each item's original file hash,
    // kept by the triggers whichever code path writes `media` and backfilled here for existing libraries;
    // 'source' rows the hash of the deck part a prepared picture was made from. JSON is read only after
    // json_valid (a malformed row is skipped, never an error inside a trigger).
    sql: `
CREATE TABLE IF NOT EXISTS media_hashes (
  hash TEXT NOT NULL, role TEXT NOT NULL, media_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (hash, role, media_id));
CREATE INDEX IF NOT EXISTS media_hashes_media ON media_hashes(media_id);
INSERT OR IGNORE INTO media_hashes (hash, role, media_id, created_at)
  SELECT h, 'content', id, created_at FROM (
    SELECT id, created_at, CASE WHEN json_valid(json) THEN json_extract(json, '$.original.hash') END AS h
    FROM media)
  WHERE typeof(h) = 'text';
CREATE TRIGGER IF NOT EXISTS media_hashes_insert AFTER INSERT ON media BEGIN
  INSERT OR IGNORE INTO media_hashes (hash, role, media_id, created_at)
    SELECT h, 'content', NEW.id, NEW.created_at
    FROM (SELECT CASE WHEN json_valid(NEW.json) THEN json_extract(NEW.json, '$.original.hash') END AS h)
    WHERE typeof(h) = 'text';
END;
CREATE TRIGGER IF NOT EXISTS media_hashes_update AFTER UPDATE OF json ON media BEGIN
  DELETE FROM media_hashes WHERE media_id = NEW.id AND role = 'content'
    AND hash IS NOT (CASE WHEN json_valid(NEW.json) THEN json_extract(NEW.json, '$.original.hash') END);
  INSERT OR IGNORE INTO media_hashes (hash, role, media_id, created_at)
    SELECT h, 'content', NEW.id, NEW.created_at
    FROM (SELECT CASE WHEN json_valid(NEW.json) THEN json_extract(NEW.json, '$.original.hash') END AS h)
    WHERE typeof(h) = 'text';
END;
CREATE TRIGGER IF NOT EXISTS media_hashes_delete AFTER DELETE ON media BEGIN
  DELETE FROM media_hashes WHERE media_id = OLD.id;
END;
`,
  },
  {
    version: 9,
    name: 'jobs-kind-state',
    // `JobQueue.active`: whether an item already has a queued or running job, looked up among the jobs of
    // one kind and state rather than every job (a library import can queue thousands of media jobs).
    sql: `
CREATE INDEX IF NOT EXISTS jobs_kind_state ON jobs(kind, state);
`,
  },
  {
    version: 10,
    name: 'theme-revisions',
    sql: `
CREATE TABLE IF NOT EXISTS theme_revisions (
  theme_id TEXT NOT NULL, rev INTEGER NOT NULL, json TEXT NOT NULL,
  saved_by TEXT, saved_at TEXT NOT NULL, PRIMARY KEY (theme_id, rev));
`,
  },
  {
    version: 11,
    name: 'capped-sessions',
    // Sessions with a cap below full (design/28 §3.2: a phone's 'light'): role 'edit' whatever PIN matched,
    // `pin` the PIN that did (a PIN change ends them), never remembered. A side table rather than a column of
    // `sessions`, so a hub downgraded past this migration never finds a capped cookie (401: fail closed).
    sql: `
CREATE TABLE IF NOT EXISTS capped_sessions (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, cap TEXT NOT NULL, pin TEXT NOT NULL, ua_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS capped_sessions_expiry ON capped_sessions(expires_at);
CREATE INDEX IF NOT EXISTS capped_sessions_pin ON capped_sessions(pin);
`,
  },
  {
    version: 12,
    name: 'auth-global-failures',
    // The hub-wide PIN bucket's own rows (design/28 §4): failures from public addresses only, so a scanner on
    // the public name can no longer lock out the venue PC or a phone on church Wi-Fi.
    sql: `
CREATE TABLE IF NOT EXISTS auth_global_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_global_failures_at ON auth_global_failures(at);
`,
  },
  {
    version: 13,
    name: 'job-paced',
    // Jobs queued during a capped (phone) request, or by a job that was (design/28 §10 items 8 and 11): held
    // while a service is live whatever `settings.phones.enabled` says. A row goes with its job.
    sql: `
CREATE TABLE IF NOT EXISTS job_paced (job_id TEXT PRIMARY KEY);
`,
  },
  {
    version: 14,
    name: 'prerender-store',
    // The tables of the pre-render store (design/29 §1.3, r2b sub-wave 2), all additive and idempotent, nothing
    // copied: heads and their pages (a slide file's index), the keys a save computes per revision, the pictures
    // and the failures of a key, the references each presentation's revisions make to content files (intervals),
    // the backfill's marker and the collector's marks. PR #29's hub (0.9.0) opens a folder at 14 and ignores them:
    // an update again rescans (`refs_scanned`).
    sql: `
CREATE TABLE IF NOT EXISTS slide_heads (
  hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, objects INTEGER NOT NULL, uses TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS slide_head_pages (
  head TEXT NOT NULL, pos INTEGER NOT NULL, page TEXT NOT NULL, PRIMARY KEY (head, pos));
CREATE INDEX IF NOT EXISTS slide_head_pages_page ON slide_head_pages(page);
CREATE TABLE IF NOT EXISTS prerender_keys (
  presentation_id TEXT NOT NULL, rev INTEGER NOT NULL, slide_id TEXT NOT NULL, key TEXT NOT NULL,
  standby_id TEXT NOT NULL, sig TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (presentation_id, rev, slide_id, key));
CREATE INDEX IF NOT EXISTS prerender_keys_key ON prerender_keys(presentation_id, key);
CREATE INDEX IF NOT EXISTS prerender_keys_standby ON prerender_keys(standby_id);
CREATE TABLE IF NOT EXISTS prerenders (
  presentation_id TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, slide_id TEXT NOT NULL,
  standby_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'slide', hash TEXT NOT NULL,
  mime TEXT NOT NULL, bytes INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL, opaque INTEGER NOT NULL,
  made_by TEXT, made_role TEXT NOT NULL, last_rev INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (presentation_id, key, size));
CREATE INDEX IF NOT EXISTS prerenders_hash ON prerenders(hash);
CREATE INDEX IF NOT EXISTS prerenders_standby ON prerenders(presentation_id, standby_id);
CREATE TABLE IF NOT EXISTS prerender_failures (
  key TEXT PRIMARY KEY, reason TEXT NOT NULL, made_by TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS file_refs (
  presentation_id TEXT NOT NULL, hash TEXT NOT NULL, first_rev INTEGER NOT NULL, last_rev INTEGER NOT NULL,
  PRIMARY KEY (presentation_id, hash, first_rev));
CREATE INDEX IF NOT EXISTS file_refs_hash ON file_refs(hash);
CREATE TABLE IF NOT EXISTS refs_scanned (
  presentation_id TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (presentation_id, rev));
CREATE TABLE IF NOT EXISTS collect_marks (hash TEXT PRIMARY KEY, since INTEGER NOT NULL);
`,
  },
  {
    // 14 is the pre-render store's (design/29 §1.3): this is the next number after it, so the two lists merge in order.
    version: 15,
    name: 'revision-summaries',
    // One small row per kept presentation revision for the History list (design/28 P2, the title only): a revision is a full
    // copy of the presentation, up to 8 MiB, and listing them parsed every one (57 of 8 MiB: 5.4 s and 2.2 GiB). A side table
    // rather than a column, so the migration stays idempotent (the test re-applies every migration's SQL); nothing is copied
    // here (the library process makes the rows of the revisions that have none, paced: apps/hub/src/revisions.ts). `title_json`
    // is the title as its JSON string literal, so it comes back exactly. The three triggers delete a summary whenever its
    // revision row is replaced, edited or deleted, by any hub: one that opens the folder and does not know this table writes
    // revisions as it always did, and a summary is never wrong or left behind (an INSERT OR REPLACE fires the insert trigger
    // whatever `recursive_triggers` says). An older hub opens a folder at 15 and ignores the table.
    sql: `
CREATE TABLE IF NOT EXISTS revision_summaries (
  presentation_id TEXT NOT NULL, rev INTEGER NOT NULL, title_json TEXT NOT NULL,
  saved_by TEXT, saved_at TEXT NOT NULL, PRIMARY KEY (presentation_id, rev));
CREATE TRIGGER IF NOT EXISTS revision_summaries_replace BEFORE INSERT ON presentation_revisions BEGIN
  DELETE FROM revision_summaries WHERE presentation_id = NEW.presentation_id AND rev = NEW.rev;
END;
CREATE TRIGGER IF NOT EXISTS revision_summaries_delete AFTER DELETE ON presentation_revisions BEGIN
  DELETE FROM revision_summaries WHERE presentation_id = OLD.presentation_id AND rev = OLD.rev;
END;
CREATE TRIGGER IF NOT EXISTS revision_summaries_edit AFTER UPDATE ON presentation_revisions BEGIN
  DELETE FROM revision_summaries WHERE presentation_id = OLD.presentation_id AND rev = OLD.rev;
  DELETE FROM revision_summaries WHERE presentation_id = NEW.presentation_id AND rev = NEW.rev;
END;
`,
  },
  {
    version: 16,
    name: 'revision-saved-at',
    // `Library.pruneRevisions` (run at the end of every save) tests `saved_at` of the revisions of the presentation, and in a row of
    // `presentation_revisions` that small column is stored after the `json` (up to 8 MiB), so SQLite walked every revision's overflow
    // pages to read it even when nothing was deleted: 295 to 305 ms of a save of a 2.2 MiB presentation with 653 revisions, growing
    // with every revision kept (all of the last 30 days are). This index holds `saved_at` and `rev` beside the presentation, so the
    // test never opens a row: the plan is a COVERING INDEX (apps/hub/test/revision-prune.test.ts). Selecting the 50th newest `rev`
    // first does not do it: every older row is still a candidate, and its `saved_at` is still read. Building the index reads every
    // revision once, here (about 0.2 to 0.6 s for 774 MiB of revisions with the folder in the cache, then a disk read of what the
    // revisions hold); nothing is copied. The index is the database's own, kept by any build's INSERT, REPLACE and DELETE, so an older
    // hub opens a folder at 16, ignores it and keeps it right (and its own prune statement is served by it too).
    sql: `
CREATE INDEX IF NOT EXISTS presentation_revisions_saved ON presentation_revisions(presentation_id, saved_at, rev);
`,
  },
];

/**
 * The running service's resolved copy, once per id (live-by-ref, design/29 §2.3 M2): the id is the SHA-256 (hex)
 * of the exact UTF-8 bytes in `json`, kept twice (copy 0 and 1) and verified on every read; snapshots and journal
 * rows name the copy instead of holding it. Part of LIVE_SCHEMA, and created by the live service itself when it
 * runs on another database (the one-process hub keeps its live tables in ordo.db, which has a migration list this
 * table is not in: it has no version, and a hub from before this ignores it).
 */
export const LIVE_RESOLVED_SQL = `
CREATE TABLE IF NOT EXISTS live_resolved (
  resolved_id TEXT NOT NULL, copy INTEGER NOT NULL, bytes INTEGER NOT NULL, json BLOB NOT NULL, saved_at INTEGER NOT NULL,
  PRIMARY KEY (resolved_id, copy));
`;

/**
 * The running service's cue list, once per id (live-by-ref follow-up, design/29 §2.3 M2): the id is the SHA-256 (hex) of
 * the exact UTF-8 bytes in `json`, verified on every read. It is built once at the goLive and never changes (the reducer
 * keeps the array), so the snapshot names it beside the copy instead of writing it again each time it is taken; one
 * row, because the cue list can be derived from the copy it belongs to when the row is torn (the restore does, with a
 * warning). Created the way `live_resolved` is.
 */
export const LIVE_CUES_SQL = `
CREATE TABLE IF NOT EXISTS live_cues (
  cues_id TEXT NOT NULL PRIMARY KEY, bytes INTEGER NOT NULL, json BLOB NOT NULL, saved_at INTEGER NOT NULL);
`;

/**
 * The live process's own database (design/25): journal, snapshots and the cached copies of library data it
 * needs to run a service while the library process is down. Separate from ordo.db so a library failure (a
 * long write lock, a corrupt page) cannot stall or break the live service.
 */
export const LIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS live_journal (
  seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, cmd_id TEXT, kind TEXT NOT NULL DEFAULT 'event', event_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS live_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, json TEXT NOT NULL, saved_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS live_snapshot_prev (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL, json TEXT NOT NULL, saved_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS live_kv (key TEXT PRIMARY KEY, json TEXT NOT NULL, saved_at INTEGER NOT NULL);
${LIVE_RESOLVED_SQL}${LIVE_CUES_SQL}`;

export function openLiveDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 1000');
  db.exec(LIVE_SCHEMA);
  return db;
}

/**
 * The live process's connection to ordo.db, for sessions and the PIN-setup flag only. No migrations, a
 * short busy timeout (a write waits at most 50 ms for the library process's lock, and callers treat a busy
 * error as "skip this time"), and no automatic checkpoints: the library process owns the WAL.
 */
export function openSharedDb(file: string): DB {
  const db = new Database(file, { fileMustExist: true });
  db.pragma('busy_timeout = 50');
  db.pragma('wal_autocheckpoint = 0');
  return db;
}

/** Apply `migrations` (an older build's list in tests) past the database's `user_version`. */
export function migrate(
  db: DB,
  migrations: readonly { version: number; sql: string }[] = MIGRATIONS,
): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  return db.pragma('user_version', { simple: true }) as number;
}

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
