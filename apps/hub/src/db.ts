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
];

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
