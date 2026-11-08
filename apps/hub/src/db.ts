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
];

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
`;

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

export function migrate(db: DB): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
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
