import { copyFile, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { nextTimeOfDay } from '@ordo/domain';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { DB } from './db.ts';
import { notFound } from './errors.ts';
import type { FileRow, Library } from './library.ts';
import { hashFile } from './store.ts';

export const RETENTION_DAYS = 30;
/** Pre-restore copies are kept at most this many (and never beyond RETENTION_DAYS). */
export const PRE_RESTORE_KEEP = 3;
/** The scheduler never arms a timer shorter than this, whatever the clock says. */
export const MIN_SCHEDULE_DELAY_MS = 60_000;
/** A 03:00 less than this far ahead counts as passed (the run that just fired must arm tomorrow's). */
const SCHEDULE_LEAD_MS = 5_000;
const BACKUP_RE = /^ordo-(\d{4}-\d{2}-\d{2}(?:-\d{6})?)\.db$/;
const PRE_RESTORE_RE = /^ordo-pre-restore-.*\.db$/;
/** A backup or manifest being written; renamed to its real name when complete. */
const PARTIAL_SUFFIX = '.partial';

export type MediaManifest = { createdAt: string; db: string; files: FileRow[] };

function zonedDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}
function zonedTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .format(ms)
    .replace(/:/g, '');
}

/**
 * Nightly `VACUUM INTO` snapshot plus a media manifest; 30-day retention. `timeZone` is a function so the
 * venue time zone from settings (the same one countdowns use) is read each time the timer is armed.
 */
export class Backups {
  readonly dir: string;
  private timer?: NodeJS.Timeout;
  private running?: Promise<{ file: string }>;

  constructor(
    private db: DB,
    private lib: Library,
    private opts: { dataDir: string; timeZone: () => string },
    private log: Logger,
  ) {
    this.dir = join(opts.dataDir, 'backups');
  }

  timeZone(): string {
    return this.opts.timeZone();
  }

  /**
   * Arm the timer for the next 03:00 in the venue time zone, strictly after `now` (so the run that just
   * fired arms tomorrow's, never a 1 s retry); the timer itself is never shorter than a minute. Returns the
   * instant the timer targets.
   */
  schedule(now = Date.now()): number {
    clearTimeout(this.timer);
    const at = nextTimeOfDay('03:00', this.timeZone(), now, {
      strictlyAfter: true,
      minLeadMs: SCHEDULE_LEAD_MS,
    });
    this.timer = setTimeout(
      () => {
        this.nightly()
          .catch((e) => this.log.error({ err: (e as Error).message }, 'nightly backup failed'))
          .finally(() => this.schedule());
      },
      Math.max(MIN_SCHEDULE_DELAY_MS, at - now),
    );
    this.timer.unref();
    return at;
  }

  /** Today's nightly file name (venue date). */
  nightlyFile(now = Date.now()): string {
    return join(this.dir, `ordo-${zonedDate(now, this.timeZone())}.db`);
  }

  /**
   * The timer's work: skipped when today's nightly backup already exists (a restart after 03:00) and passes
   * an integrity check. A file that does not (written by an older hub that vacuumed in place and was
   * interrupted) is removed and the backup taken again.
   */
  async nightly(now = Date.now()): Promise<{ file: string; skipped: boolean }> {
    const file = this.nightlyFile(now);
    if (await exists(file)) {
      const bad = integrityProblem(file);
      if (!bad) {
        this.log.info({ file: basename(file) }, 'nightly backup already exists; skipped');
        return { file: basename(file), skipped: true };
      }
      this.log.warn({ file: basename(file), problem: bad }, 'nightly backup is damaged; taking it again');
      await rm(file, { force: true });
    }
    const r = await this.run({ nightly: true, now });
    return { ...r, skipped: false };
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  run(opts: { nightly?: boolean; now?: number } = {}): Promise<{ file: string }> {
    if (this.running) return this.running;
    this.running = this.doRun(opts).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async doRun(opts: { nightly?: boolean; now?: number }): Promise<{ file: string }> {
    const now = opts.now ?? Date.now();
    const tz = this.timeZone();
    const date = zonedDate(now, tz);
    let stamp = opts.nightly ? date : `${date}-${zonedTime(now, tz)}`;
    let file = join(this.dir, `ordo-${stamp}.db`);
    if (await exists(file)) {
      stamp = `${date}-${zonedTime(now, tz)}`;
      file = join(this.dir, `ordo-${stamp}.db`);
      await rm(file, { force: true });
    }
    // Vacuum into a temporary name and rename: a run interrupted part way (power, a killed process) never
    // leaves a file under the real name that a later night or a restore would take for a backup.
    const partial = `${file}${PARTIAL_SUFFIX}`;
    await rm(partial, { force: true });
    try {
      this.db.prepare('VACUUM INTO ?').run(partial);
      await rename(partial, file);
    } catch (e) {
      await rm(partial, { force: true });
      throw e;
    }
    // The database and its manifest are two files, each written atomically but not as a pair: a crash
    // between the rename above and the manifest's leaves a database with no manifest. That backup is still
    // restorable (findBackup and restoreBackup take a missing manifest as "media not verified", with a
    // warning), so the pair is not retried or rolled back here.
    const manifest: MediaManifest = {
      createdAt: new Date(now).toISOString(),
      db: basename(file),
      files: this.lib.allFiles(),
    };
    const manifestFile = join(this.dir, `media-manifest-${stamp}.json`);
    await writeFile(`${manifestFile}${PARTIAL_SUFFIX}`, JSON.stringify(manifest, null, 1));
    await rename(`${manifestFile}${PARTIAL_SUFFIX}`, manifestFile);
    this.log.info({ file: basename(file), files: manifest.files.length }, 'backup written');
    await this.prune(now);
    return { file: basename(file) };
  }

  /**
   * Retention: backups and manifests older than 30 days go; pre-restore copies (`restore` keeps the
   * replaced database) are capped at the newest PRE_RESTORE_KEEP and the same 30 days.
   */
  async prune(now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    const cutoff = now - RETENTION_DAYS * 86400_000;
    const preRestore: { f: string; mtime: number }[] = [];
    for (const f of await readdir(this.dir)) {
      // Leftovers of an interrupted run (prune runs after this run renamed its own files).
      if (f.endsWith(PARTIAL_SUFFIX)) {
        await rm(join(this.dir, f), { force: true });
        removed.push(f);
        continue;
      }
      const pre = PRE_RESTORE_RE.test(f);
      if (!pre && !BACKUP_RE.test(f) && !/^media-manifest-.*\.json$/.test(f)) continue;
      const st = await stat(join(this.dir, f));
      if (pre) preRestore.push({ f, mtime: st.mtimeMs });
      if (st.mtimeMs < cutoff) {
        await rm(join(this.dir, f), { force: true });
        removed.push(f);
      }
    }
    preRestore.sort((a, b) => b.mtime - a.mtime);
    for (const { f } of preRestore.slice(PRE_RESTORE_KEEP)) {
      if (removed.includes(f)) continue;
      await rm(join(this.dir, f), { force: true });
      removed.push(f);
    }
    return removed;
  }

  async list(): Promise<{ files: string[] }> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => BACKUP_RE.test(f));
    files.sort().reverse();
    return { files };
  }
}

/** Undefined when `file` is a readable SQLite database that passes `integrity_check`; else what is wrong. */
export function integrityProblem(file: string): string | undefined {
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const ic = db.pragma('integrity_check', { simple: true });
      return ic === 'ok' ? undefined : String(ic);
    } finally {
      db.close();
    }
  } catch (e) {
    return (e as Error).message;
  }
}

function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/**
 * Find a backup by file name, path or date (YYYY-MM-DD → the latest that day). The manifest is optional: a
 * run interrupted between the database's rename and the manifest's (or a backup copied in by hand) has
 * none, and the restore then warns that media was not verified instead of refusing.
 */
export async function findBackup(dataDir: string, ref: string): Promise<{ db: string; manifest?: string }> {
  const dir = join(dataDir, 'backups');
  let db: string | undefined;
  if (isAbsolute(ref) || ref.includes('/')) db = resolve(ref);
  else if (BACKUP_RE.test(ref)) db = join(dir, ref);
  else {
    const all = (await readdir(dir).catch(() => [] as string[]))
      .filter((f) => BACKUP_RE.test(f) && f.includes(ref))
      .sort();
    if (all.length) db = join(dir, all[all.length - 1]!);
  }
  if (
    !db ||
    !(await stat(db).then(
      (s) => s.isFile(),
      () => false,
    ))
  )
    throw notFound(`No backup matches "${ref}"`);
  const stamp = BACKUP_RE.exec(basename(db))?.[1];
  const manifest = stamp ? join(dir, `media-manifest-${stamp}.json`) : undefined;
  const hasManifest = manifest
    ? await stat(manifest).then(
        () => true,
        () => false,
      )
    : false;
  return { db, manifest: hasManifest ? manifest : undefined };
}

/**
 * Restore a backup into `<dataDir>/ordo.db`. The hub must be stopped. Verifies the database and every
 * media manifest hash first; the current database is kept as `backups/ordo-pre-restore-<ts>.db`.
 */
export async function restoreBackup(
  dataDir: string,
  ref: string,
  opts: { force?: boolean; print?: (s: string) => void } = {},
): Promise<{ restored: string; verified: number; missing: string[]; mismatched: string[] }> {
  const print = opts.print ?? ((s: string) => console.log(s));
  const { db, manifest } = await findBackup(dataDir, ref);
  print(`backup: ${db}`);
  const bad = integrityProblem(db);
  if (bad) throw new Error(`integrity check failed: ${bad}`);
  const missing: string[] = [];
  const mismatched: string[] = [];
  let verified = 0;
  if (manifest) {
    const m = JSON.parse(await readFile(manifest, 'utf8')) as MediaManifest;
    print(`verifying ${m.files.length} media file(s)`);
    for (const f of m.files) {
      const abs = resolve(dataDir, f.path);
      const exists = await stat(abs).then(
        (s) => s.isFile(),
        () => false,
      );
      if (!exists) {
        missing.push(f.path);
        continue;
      }
      const h = await hashFile(abs);
      if (h.hash !== f.hash) mismatched.push(f.path);
      else verified++;
    }
    print(`verified ${verified}, missing ${missing.length}, mismatched ${mismatched.length}`);
  } else print('warning: no media manifest next to this backup; media not verified');
  if ((missing.length || mismatched.length) && !opts.force)
    throw new Error(
      `media verification failed (${missing.length} missing, ${mismatched.length} mismatched); rerun with --force to restore anyway`,
    );
  const target = join(dataDir, 'ordo.db');
  if (
    await stat(target).then(
      () => true,
      () => false,
    )
  ) {
    const keep = join(
      dataDir,
      'backups',
      `ordo-pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
    );
    const cur = new Database(target);
    try {
      cur.pragma('wal_checkpoint(TRUNCATE)');
      cur.prepare('VACUUM INTO ?').run(keep);
    } finally {
      cur.close();
    }
    print(`previous database saved as ${keep}`);
  }
  await rm(`${target}-wal`, { force: true });
  await rm(`${target}-shm`, { force: true });
  await copyFile(db, target);
  print(`restored ${basename(db)} to ${target}`);
  resetLiveCopies(dataDir, print);
  return { restored: db, verified, missing, mismatched };
}

/**
 * The live process keeps copies of the library in live.db (its context: settings, output tokens, fonts,
 * logo; and recent goLive bundles). After a restore they describe a library that no longer exists: drop
 * them, so the live process fetches the restored library's context when it starts (the supervisor starts
 * the library first) instead of serving old output tokens and settings. The live journal and snapshots
 * stay: the live state is not part of a backup.
 */
export function resetLiveCopies(dataDir: string, print: (s: string) => void = () => undefined): void {
  const file = join(dataDir, 'live.db');
  try {
    const live = new Database(file, { fileMustExist: true });
    try {
      const n = live.prepare(`DELETE FROM live_kv WHERE key IN ('context', 'bundles')`).run().changes;
      if (n) print('cleared the live process copies of the old library in live.db');
    } finally {
      live.close();
    }
  } catch {
    /* no live.db (single-process hub, or never started): nothing cached */
  }
}
