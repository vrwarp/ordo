import { type ChildProcess, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { type Annotation, annotatePptx } from './annotate.ts';
import { fontFallbacks } from './fonts.ts';
import { type PageArgs, type PageResult, pageMain, placeBackground, takeMarkers } from './page.ts';

export type PreviewOptions = {
  /** Chromium (or Chrome) executable. */
  chromium: string;
  /** For the whole render, from the call: reading and annotating the deck, finding fonts, Chromium. */
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Annotate the deck (default `annotatePptx`, on the calling thread). The hub runs it on its CPU worker
   * pool: a crafted deck must not hold the event loop. `signal` aborts when the render is cancelled or out
   * of time.
   */
  annotate?: (deck: Uint8Array, signal: AbortSignal) => Promise<Annotation>;
  /** Output slide size in pixels (default 1920x1080). */
  width?: number;
  height?: number;
  /**
   * Keep Chromium's sandbox. Off by default: the sandbox needs user namespaces, which containers and
   * root usually do not have. The page is ordo's own harness with every network request refused; the
   * deck is data for pptx-preview, as it is for LibreOffice (which has no sandbox at all).
   */
  sandbox?: boolean;
  /** Apply ordo's corrections (default true). False renders exactly as pptx-preview does. */
  fixes?: boolean;
  /** Typeface → installed substitute; default: asked of fontconfig (`fc-match`) for every typeface used. */
  fallbacks?: Record<string, string>;
  log?: (line: string) => void;
  /** Diagnosis: return the HTML of these slides (1-based) as drawn, corrections applied. */
  dumpSlides?: number[];
};

export type PreviewResult = {
  /** One PNG per slide, in order. */
  pages: string[];
  /** Runs styled by ordo's corrections. */
  styled: number;
  notes: string[];
  /** The HTML of the slides asked for with `dumpSlides`, by slide number. */
  dom?: Record<number, string>;
};

/** The unmodified pptx-preview browser bundle (resolved where the calling app installed it). */
export function pptxPreviewBundle(from: string = import.meta.url): string {
  return createRequire(from).resolve('pptx-preview/dist/pptx-preview.umd.js');
}

/**
 * Render every slide of a .pptx with pptx-preview in headless Chromium and screenshot each one.
 * `workDir` must be an empty directory the caller removes; the PNGs are written there.
 */
export async function renderWithPptxPreview(
  input: string,
  workDir: string,
  o: PreviewOptions,
): Promise<PreviewResult> {
  // One deadline for the whole render, from here: the annotation and the font lookup count, not only
  // Chromium. Cancelling stops it at any step.
  const stop = new AbortController();
  const timer = setTimeout(
    () => stop.abort(new Error(`pptx-preview timed out after ${Math.round(o.timeoutMs / 1000)} s`)),
    o.timeoutMs,
  );
  const cancel = () => stop.abort(new Error('cancelled'));
  if (o.signal?.aborted) cancel();
  else o.signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await render(input, workDir, o, stop.signal);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', cancel);
  }
}

async function render(
  input: string,
  workDir: string,
  o: PreviewOptions,
  signal: AbortSignal,
): Promise<PreviewResult> {
  const width = o.width ?? 1920;
  const height = o.height ?? 1080;
  const fixes = o.fixes !== false;
  const notes: string[] = [];
  const raw = new Uint8Array(await untilAborted(readFile(input), signal));
  const annotate = o.annotate ?? ((deck, s) => annotatePptx(deck, { signal: s }));
  const ann = fixes ? await untilAborted(annotate(raw, signal), signal) : undefined;
  if (ann) notes.push(...ann.notes);
  await mkdir(join(workDir, 'profile'), { recursive: true });
  await writeFile(join(workDir, 'deck.pptx'), ann ? ann.bytes : raw);
  await copyFile(pptxPreviewBundle(), join(workDir, 'pptx-preview.js'));
  await writeFile(
    join(workDir, 'index.html'),
    '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}' +
      '.pptx-preview-slide-wrapper{margin:0!important}</style><div id="root"></div>' +
      '<script src="pptx-preview.js"></script>',
  );
  const fallbacks =
    o.fallbacks ?? (ann ? await untilAborted(fontFallbacks(ann.families, o.timeoutMs, signal), signal) : {});
  const args: PageArgs = {
    pptxUrl: 'deck.pptx',
    width,
    height,
    runs: ann?.runs ?? [],
    paras: ann?.paras ?? [],
    bodies: ann?.bodies ?? [],
    pictures: ann?.pictures ?? [],
    backgrounds: ann?.backgrounds ?? [],
    fallbacks,
    slideWidthPt: ann?.slideWidthPt ?? 720,
    fixes,
  };

  // Out of time or cancelled while preparing: Chromium is not started at all.
  signal.throwIfAborted();
  const browser = await Browser.launch(o.chromium, workDir, { sandbox: o.sandbox, signal });
  try {
    const page = await browser.newPage(width, height);
    await page.navigate(pathToFileURL(join(workDir, 'index.html')).href);
    const res = await page.evaluate<PageResult>(
      // esbuild (tsx, the hub bundle) may wrap named functions in __name(): define it in the page.
      // `takeMarkers` and `placeBackground` are declared first, under the names pageMain's body calls them by.
      `var __name = (f) => f; ${takeMarkers.toString()}; ${placeBackground.toString()}; (${pageMain.toString()})(${JSON.stringify(args)})`,
    );
    notes.push(...res.errors.map((e) => `page: ${e}`));
    if (!res.slides.length) throw new Error('pptx-preview rendered no slides');
    let dom: Record<number, string> | undefined;
    if (o.dumpSlides?.length) {
      dom = {};
      for (const n of o.dumpSlides)
        dom[n] = await page.evaluate<string>(
          `(document.querySelectorAll('.pptx-preview-slide-wrapper')[${n - 1}]?.outerHTML ?? '').replace(/data:[^"')]{30}[^"')]*/g, (m) => m.slice(0, 30) + '…')`,
        );
    }
    const pages: string[] = [];
    for (let i = 0; i < res.slides.length; i++) {
      const r = res.slides[i]!;
      // One slide at a time, pinned over the top of the viewport: Chromium does not reliably paint content
      // far below the viewport for a clipped capture. Pinning keeps the slide's size, so charts are not
      // resized (hiding the other slides did that, and ECharts then replayed its animation).
      await page.evaluate(
        `(() => { const el = document.querySelectorAll('.pptx-preview-slide-wrapper')[${i}]; el.dataset.ordoCss = el.style.cssText; Object.assign(el.style, { position: 'fixed', left: '0px', top: '0px', zIndex: '2147483647' }); window.scrollTo(0, 0); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })()`,
      );
      const png = await page.screenshot({ x: 0, y: 0, width: r.width, height: r.height });
      await page.evaluate(
        `(() => { const el = document.querySelectorAll('.pptx-preview-slide-wrapper')[${i}]; el.style.cssText = el.dataset.ordoCss ?? ''; })()`,
      );
      const file = join(workDir, `slide-${String(i + 1).padStart(4, '0')}.png`);
      await writeFile(file, png);
      pages.push(file);
    }
    // pptx-preview draws slides in part-name order and draws hidden ones: put them in the presentation's
    // order and leave hidden slides out, as LibreOffice does.
    const order = ann?.slideOrder ?? [];
    let ordered = pages;
    if (order.length === pages.length && order.some((v, k) => v !== k)) {
      const placed: string[] = [];
      pages.forEach((file, k) => {
        const at = order[k]!;
        if (at >= 0) placed[at] = file;
      });
      ordered = placed.filter((f) => f !== undefined);
      const hidden = order.filter((v) => v < 0).length;
      notes.push(`slides put in presentation order${hidden ? `; ${hidden} hidden slide(s) left out` : ''}`);
    } else if (order.length && order.length !== pages.length)
      notes.push(
        `pptx-preview drew ${pages.length} slide(s) where ${order.length} were expected; order kept`,
      );
    o.log?.(`pptx-preview: ${ordered.length} slide(s), ${res.styled} run(s) restyled`);
    return { pages: ordered, styled: res.styled, notes, ...(dom ? { dom } : {}) };
  } finally {
    await browser.shutdown();
  }
}

/** `p`, or the signal's reason as soon as it aborts (the work behind `p` is told by the same signal). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

/** A Chromium process driven over the DevTools protocol on a pipe (`--remote-debugging-pipe`). */
class Browser {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, ((params: unknown, sessionId?: string) => void)[]>();
  private chunks: Buffer[] = [];
  private failure?: Error;
  private rejectFailed: (e: Error) => void = () => undefined;
  /** Rejects when the browser fails (exits, crashes, is cancelled or out of time); never resolves. */
  readonly failed = new Promise<never>((_, reject) => {
    this.rejectFailed = reject;
  });

  private constructor(
    private proc: ChildProcess,
    private out: Writable,
    input: Readable,
  ) {
    // Raced by whoever waits on the browser; not an unhandled rejection when nobody is waiting.
    this.failed.catch(() => undefined);
    input.on('data', (d: Buffer) => this.onData(d));
    // A write after Chromium has gone (EPIPE) fails the pending calls instead of crashing the process.
    out.on('error', (e) => this.fail(e));
    input.on('error', (e) => this.fail(e));
    proc.on('exit', (code, sig) => this.fail(new Error(`Chromium exited (${sig ?? code})`)));
    proc.on('error', (e) => this.fail(e));
  }

  /** Start Chromium. `signal` (cancelled, or out of time) fails it with the signal's reason. */
  static async launch(
    exe: string,
    workDir: string,
    o: { sandbox?: boolean; signal: AbortSignal },
  ): Promise<Browser> {
    const args = [
      '--headless',
      '--remote-debugging-pipe',
      `--user-data-dir=${join(workDir, 'profile')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-component-update',
      '--mute-audio',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      // The harness reads the deck next to it with a file:// request.
      '--allow-file-access-from-files',
      // No network: a deck can link pictures on the web; nothing is fetched while rendering.
      '--host-resolver-rules=MAP * ~NOTFOUND',
      ...(o.sandbox ? [] : ['--no-sandbox']),
      'about:blank',
    ];
    const proc = spawn(exe, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: workDir, LANG: 'C.UTF-8' },
    });
    const b = new Browser(proc, proc.stdio[3] as Writable, proc.stdio[4] as Readable);
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-4000);
    });
    const onAbort = () => b.fail(o.signal.reason instanceof Error ? o.signal.reason : new Error('cancelled'));
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
    proc.on('exit', () => o.signal.removeEventListener('abort', onAbort));
    try {
      await b.send('Browser.getVersion');
    } catch (e) {
      const msg =
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? `Chromium not found at ${exe}`
          : (e as Error).message;
      await b.shutdown();
      throw new Error(`${msg}${stderr ? `: ${stderr.trim().split('\n').slice(-2).join(' | ')}` : ''}`);
    }
    return b;
  }

  private onData(d: Buffer): void {
    let start = 0;
    for (let i = d.indexOf(0); i >= 0; i = d.indexOf(0, start)) {
      this.chunks.push(d.subarray(start, i));
      const msg = Buffer.concat(this.chunks).toString('utf8');
      this.chunks = [];
      start = i + 1;
      this.onMessage(
        JSON.parse(msg) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
          method?: string;
          params?: unknown;
          sessionId?: string;
        },
      );
    }
    if (start < d.length) this.chunks.push(d.subarray(start));
  }

  private onMessage(m: {
    id?: number;
    result?: unknown;
    error?: { message: string };
    method?: string;
    params?: unknown;
    sessionId?: string;
  }): void {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
      return;
    }
    for (const l of this.listeners.get(m.method ?? '') ?? []) l(m.params, m.sessionId);
  }

  fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    this.rejectFailed(e);
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.close();
  }

  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  /** Listen to an event; returns the function that stops listening. */
  on(method: string, fn: (params: unknown, sessionId?: string) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
    return () => {
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    };
  }

  async newPage(width: number, height: number): Promise<Page> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = new Page(this, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return page;
  }

  close(): void {
    if (this.proc.exitCode === null && !this.proc.killed) this.proc.kill('SIGKILL');
  }

  /**
   * Ask Chromium to quit and wait until it has (its helper processes finish writing the profile, so the
   * caller can delete the work directory); kill it if it takes longer than a few seconds.
   */
  async shutdown(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
    if (!this.failure) this.send('Browser.close').catch(() => undefined);
    else this.close();
    const timer = setTimeout(() => this.close(), 5000);
    await exited;
    clearTimeout(timer);
  }
}

class Page {
  constructor(
    private browser: Browser,
    private sessionId: string,
  ) {}

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  async navigate(url: string): Promise<void> {
    let off = () => {};
    const loaded = new Promise<void>((resolve) => {
      off = this.browser.on('Page.loadEventFired', (_p, s) => {
        if (s === this.sessionId) resolve();
      });
    });
    try {
      const r = await this.send<{ errorText?: string }>('Page.navigate', { url });
      if (r.errorText) throw new Error(`could not open the harness page: ${r.errorText}`);
      // Chromium can fail after answering the navigation and before the page loads: nothing fires then.
      await Promise.race([loaded, this.browser.failed]);
    } finally {
      off();
    }
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`pptx-preview failed: ${(d.exception?.description ?? d.text).split('\n')[0]}`);
    }
    return r.result.value as T;
  }

  async screenshot(clip: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
    const r = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: 1 },
      captureBeyondViewport: true,
    });
    return Buffer.from(r.data, 'base64');
  }
}
