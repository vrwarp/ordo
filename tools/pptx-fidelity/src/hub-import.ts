/**
 * Decks through a real hub (design/27 §15 M9, the M9 plan §6.3). Three uses share this module:
 *
 * - **The exit's hub import** (`npx tsx src/hub-import.ts [options] <deck | folder>...`): starts this
 *   checkout's hub with a PATH that holds only `node`, `ffmpeg`, `ffprobe`, `pdftoppm`, `pdfinfo` and
 *   `prlimit` (no `soffice`, no `libreoffice`) and `ORDO_LIBREOFFICE=auto`, so the hub has to find out by
 *   itself that LibreOffice is absent; asserts that `GET /capabilities` says so; posts every deck through the
 *   upload route, as an operator does; waits for every job; and writes per deck the job state, the time to
 *   version 1, the classes, `pending`, the `missing` kinds, `simplified`, the presentation's bytes and its
 *   largest slide's, and whether a goLive of it resolves every media, geometry and decoration file it names
 *   (`resolvePlaylist`, then each manifest file fetched). `--libreoffice` runs the same with LibreOffice on
 *   the PATH (its `pptx-lo` slides are counted). `--dry-run` lists the decks without starting a hub.
 * - **`--before hub`** (`beforehub.ts`): the same hub, LibreOffice present, its version 2 drawn by the
 *   harness's renderer: what a hub with LibreOffice really showed (`HubSession`, `hubSlides`).
 * - **`__hub <entry>`**, internal: the process the two start (`createHub` from the hub's built bundle or its
 *   sources, one process, `jobs.light` = 1, every other setting from its `ORDO_*` environment).
 *
 * The hub reads the decks as it reads any upload (they are untrusted; nothing here opens them). Output
 * names a deck by its name below the folder given, except decks under a `--sermons` folder, which are
 * `sermon-<k>`: those are private, and only counts of them are ever written.
 *
 * Options: `--out DIR` (default tmp/hub-import: `hub-import.json`, `hub-import.md`, the hub's data and log),
 * `--hub dist|source` (the built `apps/hub/dist/main.js`, the default when it exists, or the sources through
 * tsx), `--libreoffice`, `--dry-run`, `--sermons FOLDER` (repeatable; its decks are also posted),
 * `--timeout-s N` per job (default 600), `--mem-limit-mb N` (the compose file's `mem_limit`, default 4096),
 * `--keep-data` (leave the hub's data folder).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { constants, existsSync, openAsBlob, readFileSync } from 'node:fs';
import { access, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  drawnShapeFileRefs,
  type FileRef,
  type Media,
  type Presentation,
  resolvePlaylist,
  type Slide,
  utf8Bytes,
} from '@ordo/domain';
import { DECK_RE, listDecks } from './decks.ts';
import { type NativeMedia, sniffPicture } from './native.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

/** The tools a hub without LibreOffice may use (the M9 plan §6.3): nothing else is on its PATH. */
export const LITE_TOOLS = ['node', 'ffmpeg', 'ffprobe', 'pdftoppm', 'pdfinfo', 'prlimit'] as const;
/** What the run must never find on the hub's PATH. */
export const OFFICE_COMMANDS = ['soffice', 'libreoffice'] as const;

export const SLIDE_MAX_BYTES = 64 * 1024;
export const PRESENTATION_MAX_BYTES = 4 * 1024 * 1024;
/** A sermon deck reaches version 1 within this (design/27 §13). */
export const SERMON_V1_MS = 5_000;
/** The PIN the throwaway hub is set up with (`ORDO_DEV_PIN`). */
const PIN = '246810';
/** Log lines the session keeps (the hub's own ring is smaller; these are for the soffice check). */
const LOG_LINES = 20_000;
/** Media and geometry files fetched per presentation at most. */
const MAX_FILES = 5_000;

/** The first executable called `name` on `path`, or undefined. */
export async function findOnPath(name: string, path = process.env.PATH ?? ''): Promise<string | undefined> {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const f = join(dir, name);
    try {
      await access(f, constants.X_OK);
      if ((await stat(f)).isFile()) return f;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/**
 * A folder of links to `tools` only (each found on `from`), to be the hub's whole PATH. Returns the folder
 * and the tools that were not found.
 */
export async function toolsOnlyPath(
  dir: string,
  tools: readonly string[] = LITE_TOOLS,
  from = process.env.PATH ?? '',
): Promise<{ path: string; missing: string[] }> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const missing: string[] = [];
  for (const t of tools) {
    const real = t === 'node' ? process.execPath : await findOnPath(t, from);
    if (real) await symlink(real, join(dir, t));
    else missing.push(t);
  }
  return { path: dir, missing };
}

/** A TCP port free right now on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? ok(a.port) : fail(new Error('no port'))));
    });
  });
}

function tsxLoaderUrl(): string {
  const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
  return pathToFileURL(join(dirname(pkg), 'dist', 'loader.mjs')).href;
}

/** The hub module a session starts: the built bundle, or the sources. */
export function hubEntry(kind: 'dist' | 'source' | undefined): string {
  const dist = join(root, 'apps/hub/dist/main.js');
  if (kind === 'dist' || (kind === undefined && existsSync(dist))) return dist;
  return join(root, 'apps/hub/src/main.ts');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A job as `GET /jobs/:id` answers. */
export type HubJob = {
  id: string;
  kind: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  log: string[];
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

/** The `pptx-native` job's result fields this module reads (the hub's `PptxNativeResult`). */
export type NativeResult = {
  presentationId?: string;
  native?: number;
  hybrid?: number;
  picture?: number;
  pending?: number;
  loJobId?: string;
  simplified?: unknown;
  missing?: unknown;
};

export class HubError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** An edit-role session on a hub's API (`/api/v1`), cookie kept. */
export class HubClient {
  private cookie = '';
  constructor(readonly base: string) {}

  async login(pin = PIN): Promise<void> {
    const r = await fetch(`${this.base}/auth/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    if (!r.ok) throw new HubError(`auth/pin -> ${r.status} ${(await r.text()).slice(0, 200)}`, r.status);
    this.cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('cookie', this.cookie);
    return fetch(`${this.base}/${path}`, { ...init, headers });
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await this.req(path, init);
    if (!r.ok) throw new HubError(`${path} -> ${r.status} ${(await r.text()).slice(0, 300)}`, r.status);
    return (await r.json()) as T;
  }

  /** GET of a JSON resource, undefined on 404. */
  async maybe<T>(path: string): Promise<T | undefined> {
    const r = await this.req(path);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new HubError(`${path} -> ${r.status} ${(await r.text()).slice(0, 300)}`, r.status);
    return (await r.json()) as T;
  }

  /** A content-store file's bytes, undefined when the hub has no such file. */
  async file(hash: string): Promise<Uint8Array | undefined> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const r = await this.req(`files/${hash}`);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new HubError(`files/${hash} -> ${r.status}`, r.status);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Post a deck through `POST /import/document` (editable slides), under `uploadName`. */
  async importDeck(file: string, uploadName = basename(file)): Promise<HubJob> {
    const form = new FormData();
    form.append('file', await openAsBlob(file), uploadName);
    return this.json<HubJob>('import/document', { method: 'POST', body: form });
  }

  /** A job once it is done or failed (or the deadline passed: then it throws). */
  async waitJob(id: string, timeoutMs: number): Promise<HubJob> {
    const until = Date.now() + timeoutMs;
    for (let wait = 50; ; wait = Math.min(500, wait * 2)) {
      const j = await this.json<HubJob>(`jobs/${encodeURIComponent(id)}`);
      if (j.state === 'done' || j.state === 'failed') return j;
      if (Date.now() > until)
        throw new HubError(`job ${j.kind} still ${j.state} after ${timeoutMs / 1000} s`);
      await sleep(wait);
    }
  }
}

/** The hub process a session started (`__hub`): its log lines and its largest resident size seen. */
export class HubSession {
  readonly lines: string[] = [];
  /** Log lines that show a LibreOffice command being run (`officeSpawns`). */
  officeLines: string[] = [];
  rssMaxKb = 0;
  private timer?: NodeJS.Timeout;

  private constructor(
    readonly proc: ChildProcess,
    readonly client: HubClient,
    readonly dataDir: string,
  ) {}

  /**
   * Start a hub on a free port with its data in `dataDir` (emptied first). `path` is its whole PATH;
   * `env` adds `ORDO_*` settings (`ORDO_LIBREOFFICE`, `ORDO_FONTS_DIR`, …).
   */
  static async start(o: {
    dataDir: string;
    entry?: string;
    path?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<HubSession> {
    await rm(o.dataDir, { recursive: true, force: true });
    await mkdir(o.dataDir, { recursive: true });
    const port = await freePort();
    const proc = spawn(
      process.execPath,
      ['--import', tsxLoaderUrl(), fileURLToPath(import.meta.url), '__hub', o.entry ?? hubEntry(undefined)],
      {
        cwd: root,
        env: {
          PATH: o.path ?? process.env.PATH ?? '',
          HOME: process.env.HOME ?? o.dataDir,
          LANG: 'C.UTF-8',
          ORDO_DATA: o.dataDir,
          ORDO_DOMAIN: 'localhost',
          ORDO_PORT: String(port),
          ORDO_HOST: '127.0.0.1',
          ORDO_DEV_PIN: PIN,
          ORDO_TZ: 'UTC',
          ORDO_FONTS_DIR: '/usr/share/fonts',
          ...o.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const s = new HubSession(proc, new HubClient(`http://localhost:${port}/api/v1`), o.dataDir);
    // The hub never outlives the process that started it.
    const reap = () => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    };
    process.once('exit', reap);
    proc.once('exit', () => process.off('exit', reap));
    const take = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line) continue;
        if (s.lines.length >= LOG_LINES) s.lines.shift();
        s.lines.push(line);
        if (officeSpawn(line) && s.officeLines.length < 100) s.officeLines.push(line.slice(0, 500));
      }
    };
    proc.stdout?.on('data', take);
    proc.stderr?.on('data', take);
    s.timer = setInterval(() => s.sampleRss(), 500);
    s.timer.unref();
    const until = Date.now() + (o.timeoutMs ?? 60_000);
    for (;;) {
      if (proc.exitCode !== null) {
        clearInterval(s.timer);
        throw new HubError(
          `the hub exited (${proc.exitCode}): ${s.lines.slice(-5).join(' | ').slice(0, 800)}`,
        );
      }
      const up = await fetch(`http://localhost:${port}/api/v1/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (up) break;
      if (Date.now() > until) {
        await s.close();
        throw new HubError('the hub did not start');
      }
      await sleep(200);
    }
    await s.client.login();
    return s;
  }

  private sampleRss(): void {
    const pid = this.proc.pid;
    if (pid === undefined) return;
    try {
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (m) this.rssMaxKb = Math.max(this.rssMaxKb, Number(m[1]));
    } catch {
      /* gone, or not Linux */
    }
  }

  /** The data folder's size in bytes (a long run starts a new hub when it grows past what disk allows). */
  async dataBytes(): Promise<number> {
    return dirBytes(this.dataDir);
  }

  async close(o: { keepData?: boolean } = {}): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      for (let i = 0; i < 50 && this.proc.exitCode === null; i++) await sleep(100);
      if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    }
    if (!o.keepData) await rm(this.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** Whether a hub log line shows a LibreOffice command run, or tried (its spawn failing, its exit). */
export function officeSpawn(line: string): boolean {
  return /\b(soffice|libreoffice)\b[^\n]{0,80}\b(ENOENT|EACCES|exited with|spawn|failed to execute|timed out|killed)\b|\bspawn\s+(soffice|libreoffice)\b|unshare: failed to execute (soffice|libreoffice)/i.test(
    line,
  );
}

async function dirBytes(dir: string): Promise<number> {
  let n = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) n += (await stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return n;
}

/** A stored presentation's slides, in deck order (hidden ones included). */
export const slidesOf = (p: Presentation): Slide[] => p.sections.flatMap((s) => s.slides);

/** The media a slide draws: its background, its page picture, its pictures (by media id). */
function mediaIdsOf(slide: Slide): string[] {
  const ids = new Set<string>();
  if (slide.backgroundMediaId) ids.add(slide.backgroundMediaId);
  if (slide.imported?.imageMediaId) ids.add(slide.imported.imageMediaId);
  for (const o of slide.objects) if (o.type === 'image') ids.add(o.mediaId);
  return [...ids];
}

/** A presentation's slides with what they draw fetched into `dir`, ready for `NativeRenderer.renderDeck`. */
export type HubSlides = {
  presentation: Presentation;
  /** In deck order; a slide without a background of its own gets the presentation's, as a cue does. */
  slides: Slide[];
  media: NativeMedia[];
  geoms: { id: string; file: unknown }[];
  notes: string[];
};

/**
 * Fetch a presentation and the pictures and geometry files its slides draw into `dir` (`media/`): an image's
 * delivery file (else its original), a video's poster. Bounded by `MAX_FILES`; a file the hub lacks is a note.
 */
export async function hubSlides(client: HubClient, presentationId: string, dir: string): Promise<HubSlides> {
  const presentation = await client.json<Presentation>(`presentations/${encodeURIComponent(presentationId)}`);
  const notes: string[] = [];
  const slides = slidesOf(presentation).map((s) =>
    !s.backgroundMediaId && !s.clearBackground && presentation.backgroundMediaId
      ? { ...s, backgroundMediaId: presentation.backgroundMediaId }
      : s,
  );
  await mkdir(join(dir, 'media'), { recursive: true });
  const media: NativeMedia[] = [];
  const ids = [...new Set(slides.flatMap(mediaIdsOf))].slice(0, MAX_FILES);
  for (const [k, id] of ids.entries()) {
    const entry: NativeMedia = { id, part: id };
    media.push(entry);
    const m = await client.maybe<Media>(`media/${encodeURIComponent(id)}`);
    const ref = m ? (m.kind === 'image' ? (m.delivery ?? m.original) : m.poster) : undefined;
    const bytes = ref ? await client.file(ref.hash) : undefined;
    if (!bytes) {
      notes.push(`media ${k + 1} is not on the hub`);
      continue;
    }
    const type = sniffPicture(bytes.subarray(0, 16));
    if (!type) continue;
    const file = `media/h${k + 1}.${type === 'jpeg' ? 'jpg' : type}`;
    await writeFile(join(dir, file), bytes);
    entry.file = file;
    entry.type = type;
  }
  const geoms: { id: string; file: unknown }[] = [];
  const refs = [...new Set(slides.flatMap((s) => drawnShapeFileRefs(s)))].slice(0, MAX_FILES);
  for (const ref of refs) {
    const bytes = await client.file(ref);
    if (!bytes) {
      notes.push('a geometry file is not on the hub');
      continue;
    }
    try {
      geoms.push({ id: ref, file: JSON.parse(new TextDecoder().decode(bytes)) as unknown });
    } catch {
      notes.push('a geometry file is not JSON');
    }
  }
  return { presentation, slides, media, geoms, notes };
}

/** One deck imported: its jobs, and what version 1 and the latest version hold. */
export type HubImport = {
  job: HubJob;
  /** POST to the native job's end, in ms. */
  v1Ms: number;
  presentationId?: string;
  /** The LibreOffice follow-up (`pptx-lo`), when the import queued one and the caller waited for it. */
  followUp?: HubJob;
  result?: NativeResult;
};

/** Post a deck and wait for its import (and, with `followUp`, for the LibreOffice follow-up too). */
export async function importDeck(
  client: HubClient,
  file: string,
  o: { uploadName?: string; timeoutMs: number; followUp: boolean },
): Promise<HubImport> {
  const t0 = performance.now();
  const queued = await client.importDeck(file, o.uploadName);
  const job = await client.waitJob(queued.id, o.timeoutMs);
  const v1Ms = Math.round(performance.now() - t0);
  const result = job.result && typeof job.result === 'object' ? (job.result as NativeResult) : undefined;
  const out: HubImport = { job, v1Ms, ...(result ? { result } : {}) };
  if (typeof result?.presentationId === 'string') out.presentationId = result.presentationId;
  if (o.followUp && typeof result?.loJobId === 'string')
    out.followUp = await client.waitJob(result.loJobId, o.timeoutMs);
  return out;
}

// ── The exit's hub import (§6.3) ─────────────────────────────────────────────────────────────────────────

export type HubImportArgs = {
  out: string;
  dryRun: boolean;
  libreoffice: boolean;
  hub?: 'dist' | 'source';
  sermons: string[];
  timeoutMs: number;
  memLimitMb: number;
  keepData: boolean;
  decks: string[];
};

export function parseHubImportArgs(argv: readonly string[]): HubImportArgs {
  const a: HubImportArgs = {
    out: 'tmp/hub-import',
    dryRun: false,
    libreoffice: false,
    sermons: [],
    timeoutMs: 600_000,
    memLimitMb: 4096,
    keepData: false,
    decks: [],
  };
  const value = (i: number, name: string) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  const num = (v: string, name: string) => {
    const n = Number(v);
    if (!(n > 0)) throw new Error(`${name} takes a number > 0`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--out') a.out = value(++i, v);
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--libreoffice') a.libreoffice = true;
    else if (v === '--keep-data') a.keepData = true;
    else if (v === '--sermons') a.sermons.push(value(++i, v));
    else if (v === '--timeout-s') a.timeoutMs = num(value(++i, v), v) * 1000;
    else if (v === '--mem-limit-mb') a.memLimitMb = num(value(++i, v), v);
    else if (v === '--hub') {
      const h = value(++i, v);
      if (h !== 'dist' && h !== 'source') throw new Error('--hub takes dist or source');
      a.hub = h;
    } else if (v === '--') continue;
    else if (v.startsWith('--')) throw new Error(`unknown option ${v}`);
    else a.decks.push(v);
  }
  return a;
}

/** One deck of the run: what the hub made of it. */
export type DeckRecord = {
  /** Its name below the folder given, or `sermon-<k>` for a private deck. */
  name: string;
  ext: string;
  bytes: number;
  sermon?: true;
  state: 'done' | 'failed' | 'error';
  error?: string;
  v1Ms?: number;
  slides?: number;
  classes?: { native: number; hybrid: number; picture: number };
  pending?: number;
  /** Slides of version 1 left for LibreOffice (`pending`), the `pptx-lo` slide count with `--libreoffice`. */
  loSlides?: number;
  followUp?: string;
  missing?: Record<string, number>;
  simplified?: unknown;
  presentationBytes?: number;
  largestSlideBytes?: number;
  slidesOver64k?: number;
  manifest?: { files: number; unresolved: number; degraded: number; error?: string };
};

export type HubImportReport = {
  createdAt: string;
  dryRun: boolean;
  libreoffice: 'hidden' | 'present';
  hub?: string;
  capabilities?: unknown;
  decks: DeckRecord[];
  unreadable: { name: string; why: 'missing target' }[];
  rssMaxMb?: number;
  officeLines?: string[];
  gates?: { name: string; pass: boolean; detail: string }[];
};

/** Every deck of the folders and files given, sermons last, each with the name the report gives it. */
async function inventory(a: HubImportArgs) {
  const worship = await listDecks(a.decks);
  const sermons = await listDecks(a.sermons);
  let k = 0;
  return [
    ...worship.map((d) => ({ ...d, label: d.name, sermon: false })),
    ...sermons.map((d) => ({ ...d, label: `sermon-${++k}`, sermon: true })),
  ];
}

const extOf = (name: string) => extname(name).slice(1).toLowerCase();

/** The goLive of one presentation, resolved as the hub resolves it, each manifest file then fetched. */
async function manifestCheck(
  client: HubClient,
  p: Presentation,
): Promise<NonNullable<DeckRecord['manifest']>> {
  const media = new Map<string, Media>();
  const files = new Map<string, FileRef>();
  const slides = slidesOf(p);
  const ids = new Set<string>(p.backgroundMediaId ? [p.backgroundMediaId] : []);
  for (const s of slides) for (const id of mediaIdsOf(s)) ids.add(id);
  for (const id of [...ids].slice(0, MAX_FILES)) {
    const m = await client.maybe<Media>(`media/${encodeURIComponent(id)}`);
    if (m) media.set(id, m);
  }
  for (const ref of [...new Set(slides.flatMap((s) => drawnShapeFileRefs(s)))].slice(0, MAX_FILES)) {
    const b = await client.file(ref);
    if (b) files.set(ref, { hash: ref, bytes: b.length, mime: 'application/json', path: '' });
  }
  try {
    const resolved = resolvePlaylist(
      {
        playlist: {
          id: 'hub-import',
          rev: 1,
          name: 'hub import',
          items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }],
        },
        presentation: (id) => (id === p.id ? p : undefined),
        media: (id) => media.get(id),
        fonts: () => [],
        looks: [],
        general: {},
        file: (hash) => files.get(hash),
      },
      'hub-import',
      { digest: (parts) => String(parts.length) },
    );
    let unresolved = 0;
    for (const f of resolved.files) if (!(await client.file(f.hash))) unresolved++;
    const named = new Set(slides.flatMap((s) => drawnShapeFileRefs(s)));
    for (const ref of named) if (!files.has(ref)) unresolved++;
    return { files: resolved.files.length, unresolved, degraded: resolved.degraded?.length ?? 0 };
  } catch (e) {
    return { files: 0, unresolved: 1, degraded: 0, error: (e as Error).message.slice(0, 300) };
  }
}

/** What version 1 (or the latest version) of one imported deck holds, for its record. */
function contents(p: Presentation, rec: DeckRecord): void {
  const slides = slidesOf(p);
  rec.slides = slides.length;
  rec.classes = { native: 0, hybrid: 0, picture: 0 };
  rec.pending = 0;
  rec.missing = {};
  rec.slidesOver64k = 0;
  rec.largestSlideBytes = 0;
  for (const s of slides) {
    const c = s.pptx?.class;
    if (c === 'native' || c === 'hybrid' || c === 'picture') rec.classes[c]++;
    if (s.pptx?.pending) rec.pending++;
    for (const m of s.pptx?.missing ?? []) {
      const kind = m.split(':')[0]!;
      rec.missing[kind] = (rec.missing[kind] ?? 0) + 1;
    }
    const b = utf8Bytes(JSON.stringify(s));
    rec.largestSlideBytes = Math.max(rec.largestSlideBytes, b);
    if (b > SLIDE_MAX_BYTES) rec.slidesOver64k++;
  }
  rec.presentationBytes = utf8Bytes(JSON.stringify(p));
}

/** The §6.3 gates over a run's records. */
export function hubImportGates(
  r: HubImportReport,
  memLimitMb: number,
): NonNullable<HubImportReport['gates']> {
  const d = r.decks;
  const sum = (f: (x: DeckRecord) => number) => d.reduce((n, x) => n + f(x), 0);
  const gates: NonNullable<HubImportReport['gates']> = [];
  const gate = (name: string, pass: boolean, detail: string) => gates.push({ name, pass, detail });
  const notDone = d.filter((x) => x.state !== 'done').length;
  gate('every job is done', notDone === 0, `${notDone} of ${d.length} not done`);
  if (r.libreoffice === 'hidden') {
    const caps = r.capabilities as { libreoffice?: { state?: unknown } } | undefined;
    const state = caps ? String(caps.libreoffice?.state) : 'not served (a hub before M9)';
    gate('GET /capabilities reports LibreOffice absent', state === 'absent', state);
    const pending = sum((x) => x.pending ?? 0);
    gate('pending is 0', pending === 0, `${pending} slide(s) pending`);
    gate(
      'no LibreOffice command in the hub log',
      !r.officeLines?.length,
      `${r.officeLines?.length ?? 0} line(s)`,
    );
  }
  const pictures = sum((x) => x.classes?.picture ?? 0);
  gate('no picture slide', pictures === 0, `${pictures} picture slide(s)`);
  const over = sum((x) => x.slidesOver64k ?? 0);
  gate('no slide over 64 KB', over === 0, `${over} slide(s)`);
  const big = d.filter((x) => (x.presentationBytes ?? 0) > PRESENTATION_MAX_BYTES).length;
  gate('no presentation over 4 MiB', big === 0, `${big} presentation(s)`);
  const unresolved = sum((x) => x.manifest?.unresolved ?? 0);
  gate('every manifest reference resolves', unresolved === 0, `${unresolved} unresolved`);
  const slow = d.filter((x) => x.sermon && (x.v1Ms ?? Number.POSITIVE_INFINITY) > SERMON_V1_MS).length;
  const sermons = d.filter((x) => x.sermon).length;
  if (sermons) gate('sermon decks reach version 1 within 5 s', slow === 0, `${slow} of ${sermons} slower`);
  const rss = r.rssMaxMb ?? 0;
  gate('hub RSS within the mem_limit', rss <= memLimitMb, `${rss} MB of ${memLimitMb} MB`);
  return gates;
}

/** The report as markdown: counts and gates, worship deck names only in the per-deck table. */
export function hubImportMarkdown(r: HubImportReport): string {
  const lines = [
    `# Hub import (${r.dryRun ? 'dry run' : `LibreOffice ${r.libreoffice}`}) ${r.createdAt}`,
    '',
    `${r.decks.length} deck(s), ${r.unreadable.length} unreadable link(s)${r.hub ? `; hub ${r.hub}` : ''}${r.rssMaxMb !== undefined ? `; RSS max ${r.rssMaxMb} MB` : ''}`,
    '',
  ];
  if (r.gates?.length) {
    lines.push('| gate | result | detail |', '|---|---|---|');
    for (const g of r.gates) lines.push(`| ${g.name} | ${g.pass ? 'PASS' : 'FAIL'} | ${g.detail} |`);
    lines.push('');
  }
  if (!r.dryRun) {
    const done = r.decks.filter((d) => d.classes);
    const c = { native: 0, hybrid: 0, picture: 0 };
    const missing: Record<string, number> = {};
    for (const d of done) {
      for (const k of ['native', 'hybrid', 'picture'] as const) c[k] += d.classes![k];
      for (const [k, n] of Object.entries(d.missing ?? {})) missing[k] = (missing[k] ?? 0) + n;
    }
    lines.push(
      `slides: ${c.native} native, ${c.hybrid} hybrid, ${c.picture} picture; missing: ${
        Object.entries(missing)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ') || 'none'
      }`,
      '',
    );
  }
  return lines.join('\n');
}

/** The §6.3 run (or its dry run). Returns the report it wrote to `<out>/hub-import.json`. */
export async function runHubImport(argv: readonly string[]): Promise<HubImportReport> {
  const a = parseHubImportArgs(argv);
  const out = resolve(a.out);
  await mkdir(out, { recursive: true });
  const decks = await inventory(a);
  const report: HubImportReport = {
    createdAt: new Date().toISOString(),
    dryRun: a.dryRun,
    libreoffice: a.libreoffice ? 'present' : 'hidden',
    decks: [],
    unreadable: decks
      .filter((d) => !d.exists)
      .map((d) => ({ name: d.label, why: 'missing target' as const })),
  };
  const readable = decks.filter((d) => d.exists && DECK_RE.test(d.name));
  const write = async () => {
    await writeFile(join(out, 'hub-import.json'), JSON.stringify(report, null, 1));
    await writeFile(join(out, 'hub-import.md'), hubImportMarkdown(report));
  };
  if (a.dryRun) {
    for (const d of readable)
      report.decks.push({
        name: d.label,
        ext: extOf(d.name),
        bytes: (await stat(d.file)).size,
        ...(d.sermon ? { sermon: true as const } : {}),
        state: 'done',
      });
    await write();
    return report;
  }
  const entry = hubEntry(a.hub);
  report.hub = entry.endsWith('.js') ? 'dist' : 'source';
  const path = a.libreoffice ? process.env.PATH : (await toolsOnlyPath(join(out, 'path'))).path;
  if (!a.libreoffice)
    for (const c of OFFICE_COMMANDS)
      if (await findOnPath(c, path)) throw new Error(`${c} is on the hub's PATH`);
  const session = await HubSession.start({
    dataDir: join(out, 'hub-data'),
    entry,
    ...(path ? { path } : {}),
    env: { ORDO_LIBREOFFICE: 'auto' },
  });
  try {
    report.capabilities = await session.client.maybe('capabilities');
    for (const d of readable) {
      const rec: DeckRecord = {
        name: d.label,
        ext: extOf(d.name),
        bytes: (await stat(d.file)).size,
        ...(d.sermon ? { sermon: true as const } : {}),
        state: 'error',
      };
      report.decks.push(rec);
      try {
        const imp = await importDeck(session.client, d.file, {
          uploadName: `deck-${report.decks.length}.${rec.ext}`,
          timeoutMs: a.timeoutMs,
          followUp: false,
        });
        rec.state = imp.job.state === 'done' ? 'done' : 'failed';
        rec.v1Ms = imp.v1Ms;
        if (imp.job.error) rec.error = imp.job.error.slice(0, 300);
        if (imp.result?.simplified !== undefined) rec.simplified = imp.result.simplified;
        if (imp.presentationId) {
          const p = await session.client.json<Presentation>(
            `presentations/${encodeURIComponent(imp.presentationId)}`,
          );
          contents(p, rec);
          rec.loSlides = rec.pending ?? 0;
          if (a.libreoffice && typeof imp.result?.loJobId === 'string') {
            const lo = await session.client.waitJob(imp.result.loJobId, a.timeoutMs);
            rec.followUp = lo.state;
            const p2 = await session.client.json<Presentation>(
              `presentations/${encodeURIComponent(imp.presentationId)}`,
            );
            contents(p2, rec);
            rec.manifest = await manifestCheck(session.client, p2);
          } else rec.manifest = await manifestCheck(session.client, p);
        }
      } catch (e) {
        rec.error = (e as Error).message.slice(0, 300);
      }
      await write();
    }
  } finally {
    report.rssMaxMb = Math.round(session.rssMaxKb / 1024);
    report.officeLines = session.officeLines;
    await writeFile(join(out, 'hub.log'), session.lines.join('\n'));
    await session.close({ keepData: a.keepData });
  }
  report.gates = hubImportGates(report, a.memLimitMb);
  await write();
  return report;
}

/** `__hub <entry>`: one hub process (`createHub`) on `ORDO_PORT`, with one light job at a time. */
async function serveHub(entry: string): Promise<void> {
  const mod = (await import(pathToFileURL(entry).href)) as {
    createHub(
      o: Record<string, unknown>,
    ): Promise<{ listen(port?: number): Promise<string>; close(): Promise<void> }>;
  };
  const hub = await mod.createHub({ jobs: { heavy: 1, light: 1 } });
  await hub.listen();
  const stop = () => {
    const force = setTimeout(() => process.exit(1), 5_000);
    force.unref();
    hub.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const done =
    cmd === '__hub'
      ? serveHub(rest[0] ?? hubEntry(undefined))
      : runHubImport(process.argv.slice(2)).then((r) => {
          console.log(hubImportMarkdown(r));
          if (r.gates?.some((g) => !g.pass)) process.exitCode = 1;
        });
  done.catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
