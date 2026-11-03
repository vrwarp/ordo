import { copyFile, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { nextTimeOfDay } from '@ordo/domain';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { DB } from './db.ts';
import { notFound } from './errors.ts';
import type { FileRow, Library } from './library.ts';
import { hashFile } from './store.ts';

export const RETENTION_DAYS = 30;
const BACKUP_RE = /^ordo-(\d{4}-\d{2}-\d{2}(?:-\d{6})?)\.db$/;

export type MediaManifest = { createdAt: string; db: string; files: FileRow[] };

function zonedDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}
function zonedTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .format(ms)
    .replace(/:/g, '');
}

/** Nightly `VACUUM INTO` snapshot plus a media manifest; 30-day retention. */
export class Backups {
  readonly dir: string;
  private timer?: NodeJS.Timeout;
  private running?: Promise<{ file: string }>;

  constructor(
    private db: DB,
    private lib: Library,
    private opts: { dataDir: string; timeZone: string },
    private log: Logger,
  ) {
    this.dir = join(opts.dataDir, 'backups');
  }

  /** Arm the timer for the next 03:00 in the venue time zone. */
  schedule(now = Date.now()): number {
    clearTimeout(this.timer);
    const at = nextTimeOfDay('03:00', this.opts.timeZone, now);
    this.timer = setTimeout(
      () => {
        this.run({ nightly: true })
          .catch((e) => this.log.error({ err: (e as Error).message }, 'nightly backup failed'))
          .finally(() => this.schedule());
      },
      Math.max(1000, at - now),
    );
    this.timer.unref();
    return at;
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
    const date = zonedDate(now, this.opts.timeZone);
    let stamp = opts.nightly ? date : `${date}-${zonedTime(now, this.opts.timeZone)}`;
    let file = join(this.dir, `ordo-${stamp}.db`);
    if (await stat(file).then(() => true, () => false)) {
      stamp = `${date}-${zonedTime(now, this.opts.timeZone)}`;
      file = join(this.dir, `ordo-${stamp}.db`);
      await rm(file, { force: true });
    }
    this.db.prepare('VACUUM INTO ?').run(file);
    const manifest: MediaManifest = { createdAt: new Date(now).toISOString(), db: basename(file), files: this.lib.allFiles() };
    await writeFile(join(this.dir, `media-manifest-${stamp}.json`), JSON.stringify(manifest, null, 1));
    this.log.info({ file: basename(file), files: manifest.files.length }, 'backup written');
    await this.prune(now);
    return { file: basename(file) };
  }

  async prune(now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    const cutoff = now - RETENTION_DAYS * 86400_000;
    for (const f of await readdir(this.dir)) {
      if (!BACKUP_RE.test(f) && !/^media-manifest-.*\.json$/.test(f)) continue;
      const st = await stat(join(this.dir, f));
      if (st.mtimeMs < cutoff) {
        await rm(join(this.dir, f), { force: true });
        removed.push(f);
      }
    }
    return removed;
  }

  async list(): Promise<{ files: string[] }> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => BACKUP_RE.test(f));
    files.sort().reverse();
    return { files };
  }
}

/** Find a backup by file name, path or date (YYYY-MM-DD → the latest that day). */
export async function findBackup(dataDir: string, ref: string): Promise<{ db: string; manifest?: string }> {
  const dir = join(dataDir, 'backups');
  let db: string | undefined;
  if (isAbsolute(ref) || ref.includes('/')) db = resolve(ref);
  else if (BACKUP_RE.test(ref)) db = join(dir, ref);
  else {
    const all = (await readdir(dir).catch(() => [] as string[])).filter((f) => BACKUP_RE.test(f) && f.includes(ref)).sort();
    if (all.length) db = join(dir, all[all.length - 1]!);
  }
  if (!db || !(await stat(db).then((s) => s.isFile(), () => false))) throw notFound(`No backup matches "${ref}"`);
  const stamp = BACKUP_RE.exec(basename(db))?.[1];
  const manifest = stamp ? join(dir, `media-manifest-${stamp}.json`) : undefined;
  const hasManifest = manifest ? await stat(manifest).then(() => true, () => false) : false;
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
  const check = new Database(db, { readonly: true, fileMustExist: true });
  try {
    const ic = check.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') throw new Error(`integrity check failed: ${String(ic)}`);
  } finally {
    check.close();
  }
  const missing: string[] = [];
  const mismatched: string[] = [];
  let verified = 0;
  if (manifest) {
    const m = JSON.parse(await readFile(manifest, 'utf8')) as MediaManifest;
    print(`verifying ${m.files.length} media file(s)`);
    for (const f of m.files) {
      const abs = resolve(dataDir, f.path);
      const exists = await stat(abs).then((s) => s.isFile(), () => false);
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
  if (await stat(target).then(() => true, () => false)) {
    const keep = join(dataDir, 'backups', `ordo-pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
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
  return { restored: db, verified, missing, mismatched };
}
