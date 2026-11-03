import { randomBytes } from 'node:crypto';
import {
  AudioSettings,
  DEFAULT_AUDIO,
  DEFAULT_GENERAL,
  DEFAULT_KEYMAP,
  DEFAULT_LOOKS,
  DEFAULT_SURFACES,
  DEFAULT_THEME,
  Font,
  GeneralSettings,
  KeyMap,
  Look,
  Media,
  newId,
  Output,
  Playlist,
  Presentation,
  SurfaceSettings,
  Theme,
} from '@ordo/domain';
import type {
  Folder,
  LibraryKind,
  LibrarySnapshot,
  LibrarySnapshotDelta,
  RevisionInfo,
  Settings,
  SettingsKey,
} from '@ordo/protocol';
import { z } from 'zod';
import { type DB, nowIso } from './db.ts';
import { conflict, notFound } from './errors.ts';
import { validate } from './validate.ts';

export type Change = { kind: LibraryKind; id: string; rev?: number; entity?: unknown; deleted?: boolean };

/** How many library seqs of change history are kept for `snapshot({ since })`. */
export const LIBRARY_CHANGES_KEEP = 20_000;

export const FolderSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  parentId: z.string().optional(),
});

export const SETTINGS_SCHEMAS: Record<SettingsKey, z.ZodType> = {
  general: GeneralSettings,
  looks: z.array(Look),
  outputs: z.array(Output),
  audio: AudioSettings,
  keymap: KeyMap,
  surfaces: SurfaceSettings,
};
export const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMAS) as SettingsKey[];

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function defaultOutputs(): Output[] {
  const o = (name: string, hostIndex: number, lookId: string, extra: Partial<Output> = {}): Output => ({
    id: newId(),
    name,
    kind: 'output',
    hostIndex,
    lookId,
    enabled: true,
    audioMaster: false,
    token: newToken(),
    ...extra,
  });
  return [
    o('Audience 1', 1, 'look-main', { audioMaster: true }),
    o('Audience 2', 2, 'look-main'),
    o('Lobby', 3, 'look-lower-third'),
    o('Stream', 4, 'look-stream'),
    o('Stage', 0, 'look-stage', { kind: 'stage' }),
  ];
}

type Row = { id: string; rev: number; json: string; created_at: string; updated_at: string };

/** A JSON entity table with id/rev/json/created_at/updated_at plus optional indexed columns. */
class EntityTable<T extends { id: string; rev?: number }> {
  constructor(
    private db: DB,
    private table: string,
    private schema: z.ZodType<T>,
    private columns: (e: T) => Record<string, string | number | null> = () => ({}),
  ) {}

  private parse(r: Row): T {
    const e = JSON.parse(r.json) as T;
    return { ...e, rev: r.rev, createdAt: r.created_at, updatedAt: r.updated_at } as T;
  }

  list(): T[] {
    return (this.db.prepare(`SELECT * FROM ${this.table} ORDER BY created_at, id`).all() as Row[]).map((r) =>
      this.parse(r),
    );
  }
  get(id: string): T | undefined {
    const r = this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.parse(r) : undefined;
  }
  must(id: string): T {
    const e = this.get(id);
    if (!e) throw notFound(`${this.table.replace(/s$/, '')} ${id} not found`);
    return e;
  }

  insert(input: T): T {
    const now = nowIso();
    const e = validate(this.schema, { ...input, id: input.id || newId(), rev: 1 }) as T;
    const cols = this.columns(e);
    const names = ['id', 'rev', 'json', 'created_at', 'updated_at', ...Object.keys(cols)];
    const stored = { ...e, createdAt: now, updatedAt: now };
    this.db
      .prepare(`INSERT INTO ${this.table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`)
      .run(e.id, 1, JSON.stringify(stored), now, now, ...Object.values(cols));
    return { ...stored, rev: 1 } as T;
  }

  /** Replace with rev check. `expectedRev` undefined skips the check (server-side updates). */
  update(id: string, input: T, expectedRev?: number): T {
    const cur = this.must(id);
    if (expectedRev !== undefined && cur.rev !== expectedRev)
      throw conflict(`Changed since you opened it (rev ${cur.rev}, yours ${expectedRev})`, {
        rev: cur.rev,
        current: cur,
      });
    const rev = (cur.rev ?? 0) + 1;
    const now = nowIso();
    const createdAt = (cur as { createdAt?: string }).createdAt ?? now;
    const e = validate(this.schema, { ...input, id, rev }) as T;
    const stored = { ...e, rev, createdAt, updatedAt: now };
    const cols = this.columns(e);
    const sets = ['rev = ?', 'json = ?', 'updated_at = ?', ...Object.keys(cols).map((c) => `${c} = ?`)];
    this.db
      .prepare(`UPDATE ${this.table} SET ${sets.join(', ')} WHERE id = ?`)
      .run(rev, JSON.stringify(stored), now, ...Object.values(cols), id);
    return stored as T;
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
  }
}

export type FileRow = { hash: string; bytes: number; mime: string; path: string };

export class Library {
  readonly presentations: EntityTable<Presentation>;
  readonly playlists: EntityTable<Playlist>;
  readonly media: EntityTable<Media>;
  readonly themes: EntityTable<Theme & { rev?: number }>;
  readonly folders: EntityTable<Folder & { rev?: number }>;
  private listeners: ((changes: Change[], seq: number) => void)[] = [];

  constructor(
    readonly db: DB,
    opts: { timeZone: string },
  ) {
    this.presentations = new EntityTable(db, 'presentations', Presentation, (p) => ({
      title: p.title,
      kind: p.kind,
      folder_id: p.folderId ?? null,
      archived: p.archived ? 1 : 0,
    }));
    this.playlists = new EntityTable(db, 'playlists', Playlist, (p) => ({ name: p.name }));
    this.media = new EntityTable(db, 'media', Media, (m) => ({ name: m.name, kind: m.kind, state: m.state }));
    this.themes = new EntityTable(db, 'themes', Theme.extend({ rev: z.number().int().optional() }));
    this.folders = new EntityTable(db, 'folders', FolderSchema.extend({ rev: z.number().int().optional() }));
    this.seed(opts.timeZone);
  }

  onChange(fn: (changes: Change[], seq: number) => void): void {
    this.listeners.push(fn);
  }

  /** Bump the library sequence and notify listeners (WebSocket broadcast). */
  emit(changes: Change[]): number {
    const seq = this.seq() + 1;
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('library_seq', ?)`).run(String(seq));
      const ins = this.db.prepare(`INSERT INTO library_changes (seq, kind, id, deleted) VALUES (?, ?, ?, ?)`);
      for (const c of changes) if (c.kind !== 'job') ins.run(seq, c.kind, c.id, c.deleted ? 1 : 0);
      if (seq % 1000 === 0)
        this.db.prepare(`DELETE FROM library_changes WHERE seq < ?`).run(seq - LIBRARY_CHANGES_KEEP);
    })();
    for (const l of this.listeners) l(changes, seq);
    return seq;
  }

  /** The oldest seq the change log still covers (0 when it covers everything since the database was made). */
  private oldestChangeSeq(): number {
    const r = this.db.prepare(`SELECT MIN(seq) AS s FROM library_changes`).get() as { s: number | null };
    const seq = this.seq();
    if (seq === 0) return 0;
    // Rows older than the retention window were pruned: anything before (seq - KEEP) is unknowable.
    const floor = Math.max(0, seq - LIBRARY_CHANGES_KEEP);
    return r.s === null ? seq : Math.max(floor, r.s - 1);
  }

  seq(): number {
    const r = this.db.prepare(`SELECT value FROM meta WHERE key = 'library_seq'`).get() as
      | { value: string }
      | undefined;
    return r ? Number(r.value) : 0;
  }

  private seed(timeZone: string): void {
    const now = nowIso();
    const defaults: Settings = {
      general: { ...DEFAULT_GENERAL, timeZone, defaultThemeId: DEFAULT_THEME.id },
      looks: DEFAULT_LOOKS,
      outputs: defaultOutputs(),
      audio: DEFAULT_AUDIO,
      keymap: DEFAULT_KEYMAP,
      surfaces: DEFAULT_SURFACES,
    };
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO settings (key, rev, json, updated_at) VALUES (?, 1, ?, ?)`,
    );
    for (const k of SETTINGS_KEYS) ins.run(k, JSON.stringify(defaults[k]), now);
    if (!this.themes.get(DEFAULT_THEME.id)) this.themes.insert({ ...DEFAULT_THEME });
  }

  // ---- settings ----
  getSettings(): Settings {
    const out = {} as Record<string, unknown>;
    for (const r of this.db.prepare(`SELECT key, json FROM settings`).all() as {
      key: string;
      json: string;
    }[])
      if ((SETTINGS_KEYS as string[]).includes(r.key)) out[r.key] = JSON.parse(r.json);
    return out as Settings;
  }
  getSetting<K extends SettingsKey>(key: K): Settings[K] {
    const r = this.db.prepare(`SELECT json FROM settings WHERE key = ?`).get(key) as
      | { json: string }
      | undefined;
    if (!r) throw notFound(`setting ${key}`);
    return JSON.parse(r.json) as Settings[K];
  }
  putSetting<K extends SettingsKey>(key: K, value: Settings[K]): Settings[K] {
    const v = validate(SETTINGS_SCHEMAS[key], value, key) as Settings[K];
    this.db
      .prepare(
        `INSERT INTO settings (key, rev, json, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET rev = rev + 1, json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(v), nowIso());
    this.emit([{ kind: 'settings', id: key, entity: v }]);
    return v;
  }
  /** Internal (non-API) settings rows such as PIN hashes. */
  getInternal<T>(key: string): T | undefined {
    const r = this.db.prepare(`SELECT json FROM settings WHERE key = ?`).get(key) as
      | { json: string }
      | undefined;
    return r ? (JSON.parse(r.json) as T) : undefined;
  }
  putInternal(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, rev, json, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET rev = rev + 1, json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  // ---- presentations with revisions ----
  savePresentation(
    p: Presentation,
    opts: { expectedRev?: number; by?: string; create?: boolean },
  ): Presentation {
    return this.db.transaction(() => {
      const saved =
        opts.create || !this.presentations.get(p.id)
          ? this.presentations.insert(p)
          : this.presentations.update(p.id, p, opts.expectedRev);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO presentation_revisions (presentation_id, rev, json, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(saved.id, saved.rev, JSON.stringify(saved), opts.by ?? null, saved.updatedAt ?? nowIso());
      this.pruneRevisions(saved.id);
      return saved;
    })();
  }

  /** Keep the newest 50 revisions or everything from the last 30 days, whichever is more. */
  pruneRevisions(id: string, now = Date.now()): void {
    const cutoff = new Date(now - 30 * 86400_000).toISOString();
    this.db
      .prepare(
        `DELETE FROM presentation_revisions WHERE presentation_id = ? AND saved_at < ? AND rev NOT IN
         (SELECT rev FROM presentation_revisions WHERE presentation_id = ? ORDER BY rev DESC LIMIT 50)`,
      )
      .run(id, cutoff, id);
  }

  revisions(id: string): RevisionInfo[] {
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

  revision(id: string, rev: number): Presentation {
    const r = this.db
      .prepare(`SELECT json FROM presentation_revisions WHERE presentation_id = ? AND rev = ?`)
      .get(id, rev) as { json: string } | undefined;
    if (!r) throw notFound(`revision ${rev} of ${id}`);
    return JSON.parse(r.json) as Presentation;
  }

  restoreRevision(id: string, rev: number, by?: string): Presentation {
    const old = this.revision(id, rev);
    const cur = this.presentations.must(id);
    return this.savePresentation({ ...old, id, rev: cur.rev }, { expectedRev: cur.rev, by });
  }

  // ---- files (content store index) ----
  addFile(f: FileRow): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO files (hash, bytes, mime, path, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(f.hash, f.bytes, f.mime, f.path, nowIso());
  }
  getFile(hash: string): FileRow | undefined {
    return this.db.prepare(`SELECT hash, bytes, mime, path FROM files WHERE hash = ?`).get(hash) as
      | FileRow
      | undefined;
  }
  allFiles(): FileRow[] {
    return this.db.prepare(`SELECT hash, bytes, mime, path FROM files ORDER BY hash`).all() as FileRow[];
  }
  /** Hashes still referenced by any media or font row. */
  fileReferenced(hash: string): boolean {
    const like = `%"${hash}"%`;
    const m = this.db.prepare(`SELECT 1 FROM media WHERE json LIKE ? LIMIT 1`).get(like);
    const f = this.db.prepare(`SELECT 1 FROM fonts WHERE json LIKE ? LIMIT 1`).get(like);
    const p = this.db.prepare(`SELECT 1 FROM presentations WHERE json LIKE ? LIMIT 1`).get(like);
    return !!(m || f || p);
  }
  deleteFileRow(hash: string): void {
    this.db.prepare(`DELETE FROM files WHERE hash = ?`).run(hash);
  }

  // ---- fonts ----
  listFonts(): Font[] {
    return (
      this.db.prepare(`SELECT json FROM fonts ORDER BY family, weight, style`).all() as { json: string }[]
    ).map((r) => JSON.parse(r.json) as Font);
  }
  getFont(id: string): Font | undefined {
    const r = this.db.prepare(`SELECT json FROM fonts WHERE id = ?`).get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Font) : undefined;
  }
  /** Insert or replace the face with the same family/weight/style. */
  upsertFont(f: Omit<Font, 'id'> & { id?: string }): Font {
    const existing = this.db
      .prepare(`SELECT id FROM fonts WHERE family = ? AND weight = ? AND style = ?`)
      .get(f.family, f.weight, f.style) as { id: string } | undefined;
    const font = validate(Font, { ...f, id: existing?.id ?? f.id ?? newId() });
    this.db
      .prepare(
        `INSERT INTO fonts (id, family, weight, style, json, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
      )
      .run(font.id, font.family, font.weight, font.style, JSON.stringify(font), nowIso());
    return font;
  }
  deleteFont(id: string): Font | undefined {
    const f = this.getFont(id);
    if (f) this.db.prepare(`DELETE FROM fonts WHERE id = ?`).run(id);
    return f;
  }

  /**
   * The library since `since` as deltas, or undefined when the hub cannot answer with deltas (unknown or
   * pruned seq, or a seq ahead of the hub): callers then fall back to the full snapshot.
   */
  changesSince(since: number, opts: { withTokens: boolean }): LibrarySnapshotDelta | undefined {
    const seq = this.seq();
    if (!Number.isInteger(since) || since < 0 || since > seq) return undefined;
    if (since === seq) return { seq, since, changes: [] };
    if (since < this.oldestChangeSeq()) return undefined;
    const rows = this.db
      .prepare(`SELECT seq, kind, id, deleted FROM library_changes WHERE seq > ? ORDER BY seq, rowid`)
      .all(since) as { seq: number; kind: LibraryKind; id: string; deleted: number }[];
    // Only the latest change of each entity matters; the entity itself is read fresh.
    const latest = new Map<string, { kind: LibraryKind; id: string }>();
    for (const r of rows) {
      const key = `${r.kind}:${r.id}`;
      latest.delete(key);
      latest.set(key, { kind: r.kind, id: r.id });
    }
    const changes: LibrarySnapshotDelta['changes'] = [];
    for (const { kind, id } of latest.values()) {
      const entity = this.entity(kind, id, opts.withTokens);
      if (entity === undefined) {
        if (kind !== 'settings' && kind !== 'job') changes.push({ kind, id, deleted: true });
        continue;
      }
      const rev = (entity as { rev?: number }).rev;
      changes.push({ kind: kind as LibrarySnapshotDelta['changes'][number]['kind'], id, rev, entity });
    }
    return { seq, since, changes };
  }

  private entity(kind: LibraryKind, id: string, withTokens: boolean): unknown {
    switch (kind) {
      case 'presentation':
        return this.presentations.get(id);
      case 'playlist':
        return this.playlists.get(id);
      case 'media':
        return this.media.get(id);
      case 'theme':
        return this.themes.get(id);
      case 'folder':
        return this.folders.get(id);
      case 'font':
        return this.getFont(id);
      case 'settings': {
        if (!(SETTINGS_KEYS as string[]).includes(id)) return undefined;
        const v = this.getSetting(id as SettingsKey);
        return id === 'outputs' && !withTokens ? (v as Output[]).map(({ token: _t, ...o }) => o) : v;
      }
      default:
        return undefined;
    }
  }

  snapshot(opts: { withTokens: boolean }): LibrarySnapshot {
    const settings = this.getSettings();
    return {
      seq: this.seq(),
      presentations: this.presentations.list(),
      playlists: this.playlists.list(),
      media: this.media.list(),
      fonts: this.listFonts(),
      themes: this.themes.list(),
      folders: this.folders.list(),
      settings: opts.withTokens ? settings : stripTokens(settings),
    };
  }
}

export function stripTokens(s: Settings): Settings {
  return { ...s, outputs: s.outputs.map(({ token: _t, ...o }) => o) };
}
