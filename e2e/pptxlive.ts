import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { type APIRequestContext, type BrowserContext, expect, type Page } from '@playwright/test';
import { shownSlideCue } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { decodePng, type Pixels } from './png.ts';

/**
 * Shared steps of the native PowerPoint import specs (design/27 §14.12): a hub of their own with the
 * bundled fonts, a deck through the real upload route, output windows at a chosen size, captures and their
 * comparison.
 */

/** A hub on `port` that registers the bundled fonts (the image sets ORDO_FONTS_DIR the same way). */
export async function pptxHub(port: number): Promise<HubProcess> {
  process.env.ORDO_FONTS_DIR ??= '/usr/share/fonts';
  const hub = HubProcess.fresh(port);
  await hub.start();
  return hub;
}

export type ImportJob = { id: string; state: string; log: string[]; result?: { presentationId: string } };

/** Upload a deck through POST /import/document (editable slides, the route's default) and wait for it. */
export async function importPptx(a: APIRequestContext, file: string): Promise<ImportJob> {
  const res = await a.post('import/document', {
    multipart: {
      file: {
        name: basename(file),
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        buffer: readFileSync(file),
      },
    },
  });
  expect(res.status(), await res.text()).toBe(202);
  const queued = (await res.json()) as { id: string };
  let job: ImportJob | undefined;
  await expect
    .poll(
      async () => {
        job = (await (await a.get(`jobs/${queued.id}`)).json()) as ImportJob;
        return job.state;
      },
      { timeout: 120_000 },
    )
    .toMatch(/^(done|failed)$/);
  expect(job!.state, job!.log.join('\n')).toBe('done');
  return job!;
}

export async function apiJson<T>(
  a: APIRequestContext,
  path: string,
  init?: { put?: unknown; post?: unknown },
) {
  const r = init?.put
    ? await a.put(path, { data: init.put })
    : init?.post
      ? await a.post(path, { data: init.post })
      : await a.get(path);
  if (!r.ok()) throw new Error(`${path} -> ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

let evN = 0;
export async function liveEvent(a: APIRequestContext, e: Record<string, unknown>): Promise<void> {
  await apiJson(a, 'live/events', { post: { id: `px-${Date.now()}-${evN++}`, event: e } });
}

export type OutputRec = {
  id: string;
  name: string;
  kind: string;
  hostIndex: number;
  lookId: string;
  token?: string;
  audioMaster?: boolean;
};

/** An output or stage window of the hub on `port`, opened at `size` (CSS px at device scale 1). */
export async function roleWindow(
  ctx: BrowserContext,
  port: number,
  o: OutputRec,
  size: { width: number; height: number },
  extra = '',
): Promise<Page> {
  const page = await ctx.newPage();
  await page.setViewportSize(size);
  page.on('pageerror', (e) => console.error(`[${o.name}] pageerror`, e.message));
  const q = `output=${encodeURIComponent(o.id)}&token=${encodeURIComponent(o.token ?? '')}${extra ? `&${extra}` : ''}`;
  const origin =
    o.kind === 'stage' ? `http://stage.localhost:${port}` : `http://out${o.hostIndex}.localhost:${port}`;
  await page.goto(`${origin}/?${q}`);
  return page;
}

type Telemetry = { cache?: { ready: number; total: number }; compositor?: string; error?: string };

export const telemetryOf = (p: Page) =>
  p.evaluate(() =>
    (window as unknown as { __ordo: { telemetry(): unknown } }).__ordo.telemetry(),
  ) as Promise<Telemetry>;

/** Wait until an output is live with every file of the service cached. */
export async function cacheReady(p: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const t = await telemetryOf(p).catch(() => undefined);
        const mode = await p
          .evaluate(
            () => (window as unknown as { __ordo: { state(): { mode: string } } }).__ordo.state().mode,
          )
          .catch(() => '');
        return mode === 'live' && !!t?.cache && t.cache.ready >= t.cache.total;
      },
      { timeout: 90_000 },
    )
    .toBe(true);
}

/** The slide cue an output draws (it draws only while in front). */
export async function cueOn(p: Page): Promise<number | null> {
  await p.bringToFront();
  return shownSlideCue(p);
}

/** Wait until the output shows `cue` and its crossfade is over. */
export async function settledOn(p: Page, cue: number): Promise<void> {
  await expect.poll(() => cueOn(p), { timeout: 30_000 }).toBe(cue);
  await p.waitForTimeout(900);
}

/** A screenshot of the output (rAF runs only in the page in front), written to `file`. */
export async function capture(p: Page, file: string): Promise<Pixels> {
  await p.bringToFront();
  await p.waitForTimeout(300);
  const png = await p.screenshot();
  writeFileSync(file, png);
  return decodePng(png);
}

/**
 * SSIM of two pictures, greyscale at 960x540 (ffmpeg), as the fidelity harness scores
 * (tools/pptx-fidelity `main.ts`): 1 is identical.
 */
export function ssim(a: string, b: string): number {
  const out = execFileSync(
    'sh',
    [
      '-c',
      'ffmpeg -hide_banner -nostats -i "$1" -i "$2" -lavfi "[0:v]scale=960:540:flags=area,format=gray[a];[1:v]scale=960:540:flags=area,format=gray[b];[a][b]ssim" -f null - 2>&1',
      'ssim',
      a,
      b,
    ],
    { encoding: 'utf8' },
  );
  const m = /All:([0-9.]+)/.exec(out);
  return m ? Number(m[1]) : 0;
}

/** Pixels whose channels differ by more than `tol` between two same-size pictures, as a share of all. */
export function diffShare(a: Pixels, b: Pixels, tol = 40): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i]! - b.data[i]!) > tol ||
      Math.abs(a.data[i + 1]! - b.data[i + 1]!) > tol ||
      Math.abs(a.data[i + 2]! - b.data[i + 2]!) > tol
    )
      n++;
  }
  return n / (a.width * a.height);
}

export type RGB = [number, number, number];

/** The colour at a logical point (the output fills its 16:9 viewport). */
export function at(img: Pixels, [lx, ly]: [number, number]): RGB {
  const x = Math.min(img.width - 1, Math.round((lx * img.width) / 1920));
  const y = Math.min(img.height - 1, Math.round((ly * img.height) / 1080));
  const o = (y * img.width + x) * 4;
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
}
