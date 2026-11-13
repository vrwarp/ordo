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
import { badRequest, conflict, notFound } from './errors.ts';
import { validate } from './validate.ts';

export type Change = { kind: LibraryKind; id: string; rev?: number; entity?: unknown; deleted?: boolean };

/** How many library seqs of change history are kept for `snapshot({ since })`. */
export const LIBRARY_CHANGES_KEEP = 20_000;

export const FolderSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(500),
  parentId: z.string().max(200).optional(),
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

/**
 * Settings invariants (design/25), checked on every write of `key`. Returns the problems, empty when sound.
 * Exactly-one-audio-master is checked by the API (routes.ts) with its own messages.
 */
export function settingsProblems(
  key: SettingsKey,
  next: Settings[SettingsKey],
  current: Pick<Settings, 'looks' | 'outputs'>,
): string[] {
  const out: string[] = [];
  const outputs = key === 'outputs' ? (next as Output[]) : current.outputs;
  const looks = key === 'looks' ? (next as Look[]) : current.looks;
  if (key === 'outputs') {
    const hosts = new Map<number, string>();
    for (const o of outputs) {
      if (o.kind === 'stage') continue;
      const other = hosts.get(o.hostIndex);
      if (other !== undefined) out.push(`"${o.name}" and "${other}" both use out${o.hostIndex}`);
      hosts.set(o.hostIndex, o.name);
    }
  }
  if (key === 'looks') {
    const ids = new Set<string>();
    for (const l of looks) {
      if (ids.has(l.id)) out.push(`look id ${l.id} is used twice`);
      ids.add(l.id);
    }
  }
  if (key === 'outputs' || key === 'looks') {
    const ids = new Set(looks.map((l) => l.id));
    for (const o of outputs)
      if (!ids.has(o.lookId)) out.push(`"${o.name}" uses look ${o.lookId}, which does not exist`);
  }
  return out;
}

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
  private db: DB;
  private table: string;
  private schema: z.ZodType<T>;
  private columns: (e: T) => Record<string, string | number | null>;
  constructor(
    db: DB,
    table: string,
    schema: z.ZodType<T>,
    columns: (e: T) => Record<string, string | number | null> = () => ({}),
  ) {
    this.db = db;
    this.table = table;
    this.schema = schema;
    this.columns = columns;
  }

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

  private timeZone: string;

  readonly db: DB;
  constructor(db: DB, opts: { timeZone: string }) {
    this.db = db;
    this.timeZone = opts.timeZone;
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
    if (!this.themes.get(DEFAULT_THEME.id)) this.saveTheme({ ...DEFAULT_THEME }, { create: true });
  }

  // ---- settings ----
  /**
   * A stored settings value, read through its schema (design/25 "defaults for missing keys on read"):
   * missing fields get their defaults; a value that no longer validates degrades element by element for
   * lists (an invalid look or output is dropped) and to the defaults for documents. A missing row reads
   * as the default (outputs excepted: they hold tokens and are always seeded).
   */
  private readSetting<K extends SettingsKey>(key: K, json: string | undefined): Settings[K] {
    const schema = SETTINGS_SCHEMAS[key];
    let raw: unknown;
    try {
      raw = json === undefined ? undefined : JSON.parse(json);
    } catch {
      raw = undefined;
    }
    if (raw !== undefined) {
      const r = schema.safeParse(raw);
      if (r.success) return r.data as Settings[K];
      if (Array.isArray(raw)) {
        const el = key === 'looks' ? Look : Output;
        const items = raw.flatMap((x) => {
          const e = el.safeParse(x);
          return e.success ? [e.data] : [];
        });
        if (items.length || key === 'outputs') return items as Settings[K];
      } else if (raw && typeof raw === 'object' && 'shape' in schema) {
        // A document with a bad field: keep every field that still validates, default the rest.
        const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape;
        const kept = Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).filter(([k, v]) => shape[k]?.safeParse(v).success),
        );
        const merged = schema.safeParse({
          ...((this.defaults() as Record<string, unknown>)[key] as object),
          ...kept,
        });
        if (merged.success) return merged.data as Settings[K];
      }
    }
    if (key === 'outputs') return [] as unknown as Settings[K];
    return schema.parse(this.defaults()[key]) as Settings[K];
  }

  private defaults(): Omit<Settings, 'outputs'> {
    return {
      general: { ...DEFAULT_GENERAL, timeZone: this.timeZone, defaultThemeId: DEFAULT_THEME.id },
      looks: DEFAULT_LOOKS,
      audio: DEFAULT_AUDIO,
      keymap: DEFAULT_KEYMAP,
      surfaces: DEFAULT_SURFACES,
    };
  }

  getSettings(): Settings {
    const rows = new Map(
      (this.db.prepare(`SELECT key, json FROM settings`).all() as { key: string; json: string }[]).map(
        (r) => [r.key, r.json],
      ),
    );
    const out = {} as Record<string, unknown>;
    for (const k of SETTINGS_KEYS) out[k] = this.readSetting(k, rows.get(k));
    return out as Settings;
  }
  getSetting<K extends SettingsKey>(key: K): Settings[K] {
    if (!SETTINGS_KEYS.includes(key)) throw notFound(`setting ${key}`);
    const r = this.db.prepare(`SELECT json FROM settings WHERE key = ?`).get(key) as
      | { json: string }
      | undefined;
    return this.readSetting(key, r?.json);
  }
  putSetting<K extends SettingsKey>(key: K, value: Settings[K]): Settings[K] {
    const v = validate(SETTINGS_SCHEMAS[key], value, key) as Settings[K];
    if (key === 'outputs' || key === 'looks') {
      const problems = settingsProblems(key, v, {
        looks: this.getSetting('looks'),
        outputs: this.getSetting('outputs'),
      });
      if (problems.length) throw badRequest(problems.slice(0, 3).join('; '), 'settings_invariant');
    }
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

  // ---- themes with revisions ----
  saveTheme(t: Theme, opts: { expectedRev?: number; by?: string; create?: boolean } = {}): Theme {
    return this.db.transaction(() => {
      const saved =
        opts.create || !this.themes.get(t.id)
          ? this.themes.insert(t)
          : this.themes.update(t.id, t, opts.expectedRev);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO theme_revisions (theme_id, rev, json, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          saved.id,
          saved.rev,
          JSON.stringify(saved),
          opts.by ?? null,
          (saved as { updatedAt?: string }).updatedAt ?? nowIso(),
        );
      this.pruneThemeRevisions(saved.id);
      return saved;
    })();
  }

  pruneThemeRevisions(id: string, now = Date.now()): void {
    const cutoff = new Date(now - 30 * 86400_000).toISOString();
    this.db
      .prepare(
        `DELETE FROM theme_revisions WHERE theme_id = ? AND saved_at < ? AND rev NOT IN
         (SELECT rev FROM theme_revisions WHERE theme_id = ? ORDER BY rev DESC LIMIT 50)`,
      )
      .run(id, cutoff, id);
  }

  themeRevisions(id: string): RevisionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT rev, json, saved_by, saved_at FROM theme_revisions WHERE theme_id = ? ORDER BY rev DESC`,
      )
      .all(id) as { rev: number; json: string; saved_by: string | null; saved_at: string }[];
    return rows.map((r) => ({
      rev: r.rev,
      savedAt: r.saved_at,
      savedBy: r.saved_by ?? undefined,
      title: (JSON.parse(r.json) as Theme).name,
    }));
  }

  themeRevision(id: string, rev: number): Theme {
    const r = this.db
      .prepare(`SELECT json FROM theme_revisions WHERE theme_id = ? AND rev = ?`)
      .get(id, rev) as { json: string } | undefined;
    if (!r) throw notFound(`revision ${rev} of theme ${id}`);
    return JSON.parse(r.json) as Theme;
  }

  restoreThemeRevision(id: string, rev: number, by?: string): Theme {
    const old = this.themeRevision(id, rev);
    const cur = this.themes.must(id);
    return this.saveTheme({ ...old, id, rev: cur.rev }, { expectedRev: cur.rev, by });
  }

  /**
   * Whether a theme or a stored presentation names this font family in a text style (`"fontFamily":"…"` in
   * its JSON, case-insensitive): one indexed-free scan per table, for the few CJK fallback families only.
   */
  namesFontFamily(family: string): boolean {
    const like = `%"fontFamily":${JSON.stringify(family).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    for (const table of ['themes', 'presentations'])
      if (this.db.prepare(`SELECT 1 FROM ${table} WHERE json LIKE ? ESCAPE '\\' LIMIT 1`).get(like))
        return true;
    return false;
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
  /**
   * Insert or replace the face with the same family/weight/style and unicode-range: the subsets of one
   * Google family, weight and style are separate faces (design/27 §10).
   */
  upsertFont(f: Omit<Font, 'id'> & { id?: string }): Font {
    const range = f.unicodeRange ?? '';
    const existing = (
      this.db
        .prepare(`SELECT id, json FROM fonts WHERE family = ? AND weight = ? AND style = ?`)
        .all(f.family, f.weight, f.style) as { id: string; json: string }[]
    ).find((r) => ((JSON.parse(r.json) as Font).unicodeRange ?? '') === range);
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

  /**
   * The size of a full library snapshot (`GET /library/snapshot`, every presentation to every operator) in
   * bytes, summed from the stored JSON without parsing an entity: hub health reports it (design/27 §3.4).
   * It matches `JSON.stringify(snapshot())` to within a few bytes per entity.
   */
  snapshotStats(): { snapshotBytes: number; presentations: number } {
    let bytes = `{"seq":${this.seq()},"settings":{}}`.length;
    let presentations = 0;
    for (const table of SNAPSHOT_TABLES) {
      const r = this.db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(json AS BLOB))), 0) AS b FROM ${table}`)
        .get() as { n: number; b: number };
      // `,"<table>":[...]` with a comma between entities.
      bytes += r.b + Math.max(0, r.n - 1) + table.length + 6;
      if (table === 'presentations') presentations = r.n;
    }
    const s = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(json AS BLOB)) + LENGTH(key) + 3), 0) AS b FROM settings`,
      )
      .get() as { n: number; b: number };
    bytes += s.b + Math.max(0, s.n - 1);
    return { snapshotBytes: bytes, presentations };
  }
}

/** The entity tables a library snapshot lists in full. */
const SNAPSHOT_TABLES = ['presentations', 'playlists', 'media', 'fonts', 'themes', 'folders'] as const;

export function stripTokens(s: Settings): Settings {
  return { ...s, outputs: s.outputs.map(({ token: _t, ...o }) => o) };
}
