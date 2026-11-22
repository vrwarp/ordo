import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RasterFont } from './raster-recipe.ts';

/*
 * The picture driver (C-RM4; the owner's Q56.d: the hub uses the browser where it can): the hub's own headless
 * Chromium, started over the DevTools protocol on a PIPE (`--remote-debugging-pipe`: no port is ever opened),
 * that loads the picture page (raster-page.ts, built to dist/raster-page.js) and draws one recipe at a time.
 *
 * It is a COPY of the old preview driver's `Browser` and `Page` (packages/pptx-render/src/chromium.ts; design 27
 * M8 deletes that package, so the hub never imports it), HARDENED for the hub:
 * - spawned as `nice -n 19` in its OWN process group (`detached`), and the whole group is killed at once on close,
 *   on abort and when a service goes live (the old driver killed the main pid only and had neither);
 * - a memory flag for the page's JavaScript heap, `--font-render-hinting=none` and a fontconfig file with hinting
 *   off (a hinted Chromium widens a line 0.2 to 0.4 %), `--disable-dev-shm-usage` when the measures say so;
 * - no network (`--host-resolver-rules=MAP * ~NOTFOUND`) and no port; the page reads only files the driver names;
 * - ONE browser at a time hub-wide (a process-wide single flight: two light imports never run two browsers),
 *   one picture at a time, a deadline per picture (RASTER_PAGE_MS), the profile folder removed on every path.
 * A crashed browser is the loop's to relaunch once (rasters.ts `drawRasters`).
 *
 * Never on a GO path, never in a service: only the hub's import job (rasters.ts) and the tests import this file.
 */

/** A picture's deadline: past it the browser's whole group is killed and the picture is 'timeout'. */
export const RASTER_PAGE_MS = 60_000;

/** Why a picture was not made; the planner maps each to its own words. */
export type RasterReason =
  | 'recipe'
  | 'font'
  | 'timeout'
  | 'aborted'
  | 'live'
  | 'crash'
  | 'empty'
  | 'page'
  | 'no-browser';

export type RasterDraw =
  | { ok: true; png: Uint8Array; w: number; h: number; ms: number }
  | { ok: false; reason: RasterReason; detail?: string };

/** The reason an abort carries when the live watcher stopped the picture (any other abort is the job's). */
export const LIVE_ABORT = 'live';

export type LaunchOptions = {
  /** Keep Chromium's sandbox (ORDO_CHROMIUM_SANDBOX=1). Off by default: the sandbox needs user namespaces. */
  sandbox?: boolean;
  /** Cancelled or out of time: fails the launch and kills the group. */
  signal: AbortSignal;
  /** The page's JavaScript heap, in MB (`--js-flags=--max-old-space-size`). */
  memoryMb?: number;
  /** `--disable-dev-shm-usage` (the container's /dev/shm is 64 MB by default). */
  noDevShm?: boolean;
  /** Process start, for tests (default `spawn`). */
  spawnFn?: typeof spawn;
  /** Where the built page is (default `rasterPageFile()`). */
  pageFile?: string;
  /** Extra arguments after the fixed ones (measures). */
  extraArgs?: string[];
  /** The page is made again (a fresh renderer) after this many pictures: the renderer's memory drifts up (default RASTER_RECYCLE_EVERY). */
  recycleEvery?: number;
};

/** A browser's renderer is replaced after this many pictures, so a long import stays under the memory ceiling. */
export const RASTER_RECYCLE_EVERY = 100000;

/** The memory flag's default: the page's JS heap holds the recipe's text and arrays, not the canvas. */
export const RASTER_MEMORY_MB = 1024;

/** The arguments Chromium is started with; no `--remote-debugging-port`, ever (a test greps this list). */
export function rasterArgs(
  profileDir: string,
  o: Pick<LaunchOptions, 'sandbox' | 'memoryMb' | 'noDevShm' | 'extraArgs' | 'recycleEvery'>,
): string[] {
  return [
    '--headless',
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // The GPU process is one more process of the tree for nothing (the canvas draws in software).
    '--in-process-gpu',
    // One renderer process for the one page (a spare is not kept either).
    '--renderer-process-limit=1',
    '--disable-features=SpareRendererForSitePerProcess',
    // The network service runs inside the browser process: one process fewer (about 100 MB of the tree), and the
    // page has no network to serve (every host is unresolvable, below).
    '--enable-features=NetworkServiceInProcess2',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-component-update',
    '--mute-audio',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    // Text with the fonts' own advances, as an output draws it (a hinted Chromium widens a line).
    '--font-render-hinting=none',
    `--js-flags=--max-old-space-size=${Math.max(64, Math.floor(o.memoryMb ?? RASTER_MEMORY_MB))}`,
    ...(o.noDevShm ? ['--disable-dev-shm-usage'] : []),
    // The page reads the recipe and the font files next to it with file: requests.
    '--allow-file-access-from-files',
    // No network: nothing a recipe or a font names is fetched from anywhere.
    '--host-resolver-rules=MAP * ~NOTFOUND',
    ...(o.sandbox ? [] : ['--no-sandbox']),
    ...(o.extraArgs ?? []),
    'about:blank',
  ];
}

/** Where the built page lives: `raster-page.js` next to this module in the bundle (the way `cpuWorkerUrl` finds the CPU worker). */
export function rasterPageUrl(): URL {
  const here = import.meta.url;
  return new URL(here.endsWith('.ts') ? './raster-page.ts' : './raster-page.js', here);
}

let built: Promise<string> | undefined;

/**
 * The built page's file: next to the bundle, else (a source run: dev and tests) built once per process with
 * esbuild into a folder of the temp directory.
 */
export function rasterPageFile(): Promise<string> {
  const url = rasterPageUrl();
  if (url.pathname.endsWith('.js')) return Promise.resolve(fileURLToPath(url));
  built ??= (async () => {
    const out = join(tmpdir(), `ordo-raster-page-${process.pid}`);
    mkdirSync(out, { recursive: true });
    const file = join(out, 'raster-page.js');
    const { build } = await import('esbuild');
    await build({
      entryPoints: [fileURLToPath(url)],
      outfile: file,
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'es2022',
      logLevel: 'silent',
      absWorkingDir: resolve(dirname(fileURLToPath(url)), '../..'),
    });
    return file;
  })();
  return built;
}

/** A fontconfig file with this machine's configuration and glyph hinting off for every face; undefined when there is no base. */
function unhintedFontconfig(dir: string): string | undefined {
  const base = process.env.FONTCONFIG_FILE || '/etc/fonts/fonts.conf';
  if (!existsSync(base)) return undefined;
  const xml = (v: string) => v.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const file = join(dir, 'fonts.conf');
  writeFileSync(
    file,
    [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
      '<fontconfig>',
      `  <include ignore_missing="yes">${xml(resolve(base))}</include>`,
      '  <match target="font">',
      '    <edit name="hinting" mode="assign"><bool>false</bool></edit>',
      '    <edit name="hintstyle" mode="assign"><const>hintnone</const></edit>',
      '  </match>',
      '</fontconfig>',
      '',
    ].join('\n'),
  );
  return file;
}

// ONE browser at a time hub-wide: a session takes the slot at launch and gives it back at close.
let flight: Promise<void> = Promise.resolve();

/** Waits for the slot; the returned function gives it back. Rejects with the signal's reason, keeping the chain whole. */
async function takeSlot(signal: AbortSignal): Promise<() => void> {
  const prev = flight;
  let release: () => void = () => undefined;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  flight = prev.then(() => mine);
  if (signal.aborted) {
    void prev.then(() => release());
    throw signal.reason;
  }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([prev, aborted]);
  } catch (e) {
    void prev.then(() => release());
    throw e;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  let given = false;
  return () => {
    if (given) return;
    given = true;
    release();
  };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

/** One Chromium process driven over the DevTools protocol on a pipe, with the picture page loaded. */
export class RasterBrowser {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private chunks: Buffer[] = [];
  private failure?: Error;
  private rejectFailed: (e: Error) => void = () => undefined;
  /** Rejects when the browser fails (exits, crashes, is killed); never resolves. */
  readonly failed = new Promise<never>((_, reject) => {
    this.rejectFailed = reject;
  });
  private sessionId?: string;
  private targetId?: string;
  private fontsKey = '';
  private closed?: Promise<void>;
  private drawn = 0;
  private recycleEvery = RASTER_RECYCLE_EVERY;
  private pageFile = '';

  private readonly proc: ChildProcess;
  private readonly out: Writable;
  private readonly profileDir: string;
  private readonly release: () => void;

  private constructor(
    proc: ChildProcess,
    out: Writable,
    input: Readable,
    profileDir: string,
    release: () => void,
  ) {
    this.proc = proc;
    this.out = out;
    this.profileDir = profileDir;
    this.release = release;
    this.failed.catch(() => undefined);
    input.on('data', (d: Buffer) => this.onData(d));
    // A write after Chromium has gone (EPIPE) fails the pending calls instead of crashing the process.
    out.on('error', (e) => this.fail(e));
    input.on('error', (e) => this.fail(e));
    proc.on('exit', (code, sig) => this.fail(new Error(`Chromium exited (${sig ?? code})`)));
    proc.on('error', (e) => this.fail(e));
  }

  /** The process id of the browser (the group leader), for tests. */
  get pid(): number | undefined {
    return this.proc.pid;
  }

  /**
   * Starts Chromium in `workDir` (the job's scratch folder: the profile lives under it and is removed on every
   * path) and loads the page. Waits for the one browser slot of the hub first. `signal` fails the launch and
   * kills the group.
   */
  static async launch(exe: string, workDir: string, o: LaunchOptions): Promise<RasterBrowser> {
    const release = await takeSlot(o.signal);
    let b: RasterBrowser | undefined;
    const profileDir = join(workDir, `profile-${process.pid}-${Date.now().toString(36)}`);
    try {
      mkdirSync(profileDir, { recursive: true });
      const fc = unhintedFontconfig(profileDir);
      const args = rasterArgs(join(profileDir, 'data'), o);
      const proc = (o.spawnFn ?? spawn)('nice', ['-n', '19', exe, ...args], {
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
        // Its own process group: the whole tree is killed at once.
        detached: true,
        env: {
          PATH: process.env.PATH,
          HOME: profileDir,
          LANG: 'C.UTF-8',
          ...(fc ? { FONTCONFIG_FILE: fc } : {}),
        },
      });
      b = new RasterBrowser(proc, proc.stdio[3] as Writable, proc.stdio[4] as Readable, profileDir, release);
      b.recycleEvery = Math.max(1, Math.floor(o.recycleEvery ?? RASTER_RECYCLE_EVERY));
      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString('utf8')).slice(-4000);
      });
      const onAbort = () =>
        b?.fail(
          o.signal.reason instanceof Error
            ? o.signal.reason
            : new Error(String(o.signal.reason ?? 'aborted')),
        );
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
      proc.on('exit', () => o.signal.removeEventListener('abort', onAbort));
      try {
        await b.send('Browser.getVersion');
        b.pageFile = o.pageFile ?? (await rasterPageFile());
        await b.openPage();
      } catch (e) {
        const msg =
          (e as NodeJS.ErrnoException).code === 'ENOENT'
            ? `Chromium not found at ${exe}`
            : (e as Error).message;
        throw new Error(`${msg}${stderr ? `: ${stderr.trim().split('\n').slice(-2).join(' | ')}` : ''}`);
      }
      return b;
    } catch (e) {
      if (b) await b.close();
      else {
        rmSync(profileDir, { recursive: true, force: true });
        release();
      }
      throw e;
    }
  }

  private onData(d: Buffer): void {
    let start = 0;
    for (let i = d.indexOf(0); i >= 0; i = d.indexOf(0, start)) {
      this.chunks.push(d.subarray(start, i));
      const msg = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      start = i + 1;
      let m: { id?: number; result?: unknown; error?: { message: string } };
      try {
        m = JSON.parse(msg);
      } catch {
        continue;
      }
      if (m.id === undefined) continue;
      const p = this.pending.get(m.id);
      if (!p) continue;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    }
    if (start < d.length) this.chunks.push(d.subarray(start));
  }

  /** The browser failed: every waiting call is rejected and the whole group is killed. */
  fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    this.rejectFailed(e);
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.killGroup();
  }

  private send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  /** Opens the one page of this browser: a document that loads the built page script. */
  private async openPage(): Promise<void> {
    const html = join(this.profileDir, 'index.html');
    writeFileSync(
      html,
      `<!doctype html><meta charset="utf-8"><body><script src="${pathToFileURL(this.pageFile).href}"></script></body>`,
    );
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    this.targetId = targetId;
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    this.sessionId = sessionId;
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    const r = await this.send<{ errorText?: string }>(
      'Page.navigate',
      { url: pathToFileURL(html).href },
      sessionId,
    );
    if (r.errorText) throw new Error(`could not open the picture page: ${r.errorText}`);
    // The script is a synchronous tag: once the document's scripts have run, the api exists.
    const ready = await this.evaluate<boolean>(
      `new Promise((ok) => { const t = Date.now(); const poll = () => typeof window.__raster === 'object' ? ok(true) : Date.now() - t > 15000 ? ok(false) : setTimeout(poll, 20); poll(); })`,
    );
    if (!ready) throw new Error('the picture page did not start');
    this.fontsKey = '';
  }

  /** Closes the page and opens a fresh one: the renderer process starts again with none of the old pictures' memory. */
  private async recycle(): Promise<void> {
    const old = this.targetId;
    this.drawn = 0;
    await this.openPage();
    if (old) {
      const r = await this.send('Target.closeTarget', { targetId: old }).catch((e) => ({ err: String(e) }));
      if (process.env.RASTER_DEBUG) console.log('closeTarget', JSON.stringify(r));
    }
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`the picture page failed: ${(d.exception?.description ?? d.text).split('\n')[0]}`);
    }
    return r.result.value as T;
  }

  /**
   * Draws the recipe in `recipeFile` (checked by the caller first and again by the page) with `fonts` registered,
   * and returns its PNG. `signal` stops the picture at once (its reason `LIVE_ABORT` is 'live', anything else
   * 'aborted'); the deadline is `deadlineMs` (default RASTER_PAGE_MS) over the whole picture. Never throws.
   */
  async draw(
    recipeFile: string,
    fonts: RasterFont[],
    o: { signal?: AbortSignal; deadlineMs?: number; timer?: (fn: () => void, ms: number) => () => void } = {},
  ): Promise<RasterDraw> {
    if (this.failure) return { ok: false, reason: 'crash', detail: this.failure.message.slice(0, 200) };
    const t0 = Date.now();
    const abortReason = (): RasterDraw => ({
      ok: false,
      reason: o.signal?.reason === LIVE_ABORT ? 'live' : 'aborted',
    });
    if (o.signal?.aborted) return abortReason();
    let timedOut = false;
    const setTimer =
      o.timer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
    const cancelTimer = setTimer(() => {
      timedOut = true;
      this.fail(new Error('the picture took too long'));
    }, o.deadlineMs ?? RASTER_PAGE_MS);
    const onAbort = () => this.fail(new Error('stopped'));
    o.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (this.drawn >= this.recycleEvery) await this.recycle();
      this.drawn++;
      const key = JSON.stringify(
        fonts.map((f) => [f.hash, f.family, f.weight, f.style, f.unicodeRange ?? '']),
      );
      if (key !== this.fontsKey) {
        await this.evaluate(`window.__raster.setFonts(${JSON.stringify(fonts)})`);
        this.fontsKey = key;
      }
      const r = await this.evaluate<
        | { ok: true; w: number; h: number; bytes: number; chunks: number; ms: number }
        | { ok: false; reason: RasterReason; detail: string }
      >(`window.__raster.draw(${JSON.stringify(pathToFileURL(recipeFile).href)})`);
      if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
      const parts: Buffer[] = [];
      for (let i = 0; i < r.chunks; i++)
        parts.push(Buffer.from(await this.evaluate<string>(`window.__raster.take(${i})`), 'base64'));
      await this.evaluate('window.__raster.release()');
      const png = Buffer.concat(parts);
      if (png.length !== r.bytes || png.length < 33 || png[25] !== 6)
        return { ok: false, reason: 'page', detail: 'the picture is not an RGBA PNG' };
      return {
        ok: true,
        png: new Uint8Array(png.buffer, png.byteOffset, png.length),
        w: r.w,
        h: r.h,
        ms: Date.now() - t0,
      };
    } catch (e) {
      if (timedOut) return { ok: false, reason: 'timeout' };
      if (o.signal?.aborted) return abortReason();
      const failure = this.failure as Error | undefined;
      if (failure) return { ok: false, reason: 'crash', detail: failure.message.slice(0, 200) };
      return { ok: false, reason: 'page', detail: String((e as Error).message).slice(0, 200) };
    } finally {
      cancelTimer();
      o.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Kills the browser's whole process group at once. */
  killGroup(): void {
    const pid = this.proc.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  /**
   * Closes the browser: kills the whole group, waits for the process to be gone, removes the profile folder and
   * gives the hub's one browser slot back. Safe to call twice.
   */
  close(): Promise<void> {
    this.closed ??= (async () => {
      const gone = new Promise<void>((resolveGone) => {
        if (this.proc.exitCode !== null || this.proc.signalCode !== null) resolveGone();
        else this.proc.once('exit', () => resolveGone());
      });
      if (!this.failure) this.failure = new Error('closed');
      this.rejectFailed(this.failure);
      for (const p of this.pending.values()) p.reject(this.failure);
      this.pending.clear();
      this.killGroup();
      await Promise.race([gone, new Promise<void>((r) => setTimeout(r, 5000).unref())]);
      rmSync(this.profileDir, { recursive: true, force: true });
      this.release();
    })();
    return this.closed;
  }
}
