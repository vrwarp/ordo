import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { SlideObject } from '../packages/domain/src/index.ts';
import { CPU_ONLY_ARGS } from './chromiumargs.ts';
import { HubProcess } from './hubproc.ts';
import { hubApi } from './linkhelpers.ts';
import { CROWDED, crowdedCentre, crowdedColor, crowdedDeck } from './pptxdecks.ts';
import { portOf } from './ports.ts';
import {
  apiJson,
  at,
  cacheReady,
  capture,
  liveEvent,
  type OutputRec,
  type RGB,
  settledOn,
} from './pptxlive.ts';

/**
 * The seams between sub-wave 2's tracks that no single track's spec can see (integrate-2, chore (c); row `sw2-seams`):
 * - (A) live-by-ref x live-frame x the output's saved state: a slide of more than 200 shapes (the cut of the live
 *   raster at the base) is live on an Audience window (1920 x 1080, Canvas 2D); the window saves the service it was
 *   sent; the hub is killed and started again on the same data; the window is sent its state BY NAME (a quarter of the
 *   size of the first state it was sent or less), still draws the topmost square the base cut away, and a GO to the
 *   next slide and back flips without a late flip;
 * - (B) prerender-store x a GO: a hub whose free-space floor is above any real disk (`ORDO_MIN_FREE_GB=10000`, the
 *   technician's override): an upload and an import answer 507 with W44's sentence naming the free space, while a
 *   service that is live goes on (a GO moves the Audience), another saved playlist goes live beside it and applies,
 *   and a presentation and a playlist are still saved.
 * Two hubs without LibreOffice, one per case (ports 0 and 1 of the row). No product hook is used: the window is read
 * through `window.__ordo` (the e2e telemetry every output spec reads), the hub through its API and its own log.
 */
const OUT = 'test-results/sw2-seams';
const LEAD_MS = 33;
const TOL = 12;

// This file starts the headless browser with no GPU switches and no GPU (`CPU_ONLY_ARGS`, e2e/chromiumargs.ts): every
// window in it is `renderer=2d` (Canvas 2D, which the page draws on the CPU), so nothing of WebGPU is lost. The config's
// SwiftShader process takes about 170 % of a CPU for an idle 1920 x 1080 window (and, where the suite runs at nice 19 as
// an integration machine's does, it keeps a higher priority than the renderer and the hub), which starves them on two
// CPUs, a CI runner's: the third screenshot of a long-lived window did not complete there and the file failed in about
// two of three runs (`taskset -c 0-1`, retries 0: repair 2 of sub-wave 2); it also took 12 minutes when it passed. With
// this list it takes about 20 seconds in that setting. (`--disable-gpu` beside the config's GPU switches was not
// enough: a late flip showed in two of three runs.)
test.use({ launchOptions: { args: CPU_ONLY_ARGS } });

type Api = APIRequestContext;
const close = (got: RGB, want: readonly [number, number, number], tol = TOL) =>
  got.every((v, k) => Math.abs(v - want[k]!) <= tol);

/** A slide of `count` squares at the crowded deck's places and colours (`pptxdecks.ts` CROWDED), as plain shapes. */
function squaresSlide(id: string, count: number): { id: string; objects: SlideObject[] } {
  const objects: SlideObject[] = Array.from({ length: count }, (_, i) => {
    const [cx, cy] = crowdedCentre(i);
    const [r, g, b] = crowdedColor(i);
    return {
      id: `sq${i}`,
      type: 'shape',
      box: {
        x: cx - CROWDED.side / 2,
        y: cy - CROWDED.side / 2,
        w: CROWDED.side,
        h: CROWDED.side,
        rotation: 0,
      },
      shape: 'rect',
      fill: { r, g, b, a: 1 },
      opacity: 1,
      radius: 0,
    } as SlideObject;
  });
  return { id, objects };
}

/** A slide of one flat colour over the whole 1920 x 1080 slide. */
function flatSlide(
  id: string,
  c: { r: number; g: number; b: number },
): { id: string; objects: SlideObject[] } {
  return {
    id,
    objects: [
      {
        id: `${id}-fill`,
        type: 'shape',
        box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
        shape: 'rect',
        fill: { ...c, a: 1 },
        opacity: 1,
        radius: 0,
      } as SlideObject,
    ],
  };
}

const presentation = (a: Api, title: string, slides: { id: string; objects: SlideObject[] }[]) =>
  apiJson<{ id: string }>(a, 'presentations', {
    post: { title, kind: 'slides', sections: [{ id: 'sec', label: title, short: 'S', slides }] },
  });
const playlist = (a: Api, name: string, presentationIds: string[]) =>
  apiJson<{ id: string }>(a, 'playlists', {
    post: {
      name,
      items: presentationIds.map((presentationId, i) => ({
        id: `i${i}`,
        kind: 'presentation',
        presentationId,
      })),
    },
  });

type HubLive = { seq: number; live?: number; resolved?: { playlist: { id: string } } };
const hubLive = async (a: Api) => ((await (await a.get('live')).json()) as { state: HubLive }).state;

/** An Audience window (renderer=2d) that keeps the size of every `live.state` message the hub sends it, in order. */
async function audienceWindow(
  ctx: BrowserContext,
  port: number,
  o: OutputRec,
  states: number[],
): Promise<Page> {
  const page = await ctx.newPage();
  page.on('websocket', (ws) =>
    ws.on('framereceived', (e) => {
      const text = typeof e.payload === 'string' ? e.payload : e.payload.toString('utf8');
      if (text.startsWith('{"t":"live.state"')) states.push(Buffer.byteLength(text));
    }),
  );
  await page.addInitScript((name) => {
    window.name = name;
  }, `ordo-out-${o.id}`);
  await page.setViewportSize({ width: 1920, height: 1080 });
  page.on('pageerror', (e) => console.error(`[${o.name}] pageerror`, e.message));
  await page.goto(
    `http://out${o.hostIndex}.localhost:${port}/?output=${encodeURIComponent(o.id)}&token=${encodeURIComponent(o.token ?? '')}&renderer=2d`,
  );
  return page;
}

/** Has the window saved the whole copy of the service (a key `copy:<outputId>` in its store)? */
const copySaved = (p: Page) =>
  p.evaluate(
    () =>
      new Promise<boolean>((resolveFn) => {
        const req = indexedDB.open('ordo-output');
        req.onerror = () => resolveFn(false);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) return resolveFn(false);
          const keys = db.transaction('kv').objectStore('kv').getAllKeys();
          keys.onsuccess = () =>
            resolveFn((keys.result as string[]).some((k) => /^copy:[^:]+$/.test(String(k))));
          keys.onerror = () => resolveFn(false);
        };
      }),
  );

const lateFlips = (p: Page) =>
  p.evaluate(() =>
    Number(
      (window as unknown as { __ordo: { telemetry(): { lateFlips?: number } } }).__ordo.telemetry()
        .lateFlips ?? 0,
    ),
  );

const audienceOf = async (a: Api): Promise<OutputRec> => {
  const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
  return outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
};

async function hubWithoutLibreOffice(port: number, env: Record<string, string> = {}): Promise<HubProcess> {
  const hub = HubProcess.fresh(port);
  hub.env.ORDO_LIBREOFFICE = 'off';
  Object.assign(hub.env, env);
  await hub.start();
  return hub;
}

test.describe.configure({ mode: 'serial' });

const hubs: HubProcess[] = [];
test.beforeAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
});
test.afterAll(() => {
  for (const h of hubs) h.kill();
});

test('(A) a crowded slide on a screen that holds the service: a restarted hub sends its state by name and the top square is still drawn', async ({
  context,
}) => {
  test.setTimeout(420_000);
  const port = portOf('sw2-seams', 0);
  const hub = await hubWithoutLibreOffice(port);
  hubs.push(hub);
  const a = await hubApi(port);
  // 230 squares: past the 200 objects the live raster keeps at the base (the base's cut loses squares 200-229).
  const crowded = await presentation(a, 'Crowded', [squaresSlide('crowded', CROWDED.count)]);
  const next = await presentation(a, 'Next', [flatSlide('next', { r: 20, g: 120, b: 200 })]);
  const pl = await playlist(a, 'Seams', [crowded.id, next.id]);
  await liveEvent(a, { k: 'goLive', playlistId: pl.id });
  await expect.poll(async () => (await hubLive(a)).resolved?.playlist.id, { timeout: 60_000 }).toBe(pl.id);
  const audience = await audienceOf(a);
  const states: number[] = [];
  const w = await audienceWindow(context, port, audience, states);
  await cacheReady(w);
  await w.bringToFront();
  await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() + LEAD_MS });
  await settledOn(w, 0);

  // The topmost square (the 230th: the live raster of the base cut it) is drawn, the first one too.
  const top = CROWDED.count - 1;
  const shows = async (file: string) => {
    const shot = await capture(w, join(OUT, file));
    return {
      first: close(at(shot, crowdedCentre(0)), crowdedColor(0)),
      top: close(at(shot, crowdedCentre(top)), crowdedColor(top)),
    };
  };
  await expect
    .poll(() => shows('before-restart.png'), { timeout: 90_000, intervals: [1000] })
    .toEqual({
      first: true,
      top: true,
    });
  // The first state the window was sent carries the whole service; the window saves it once and holds it.
  expect(states.length, 'the window was sent a state at connect').toBeGreaterThanOrEqual(1);
  const firstBytes = states[0]!;
  expect(
    firstBytes,
    'the first state carries the whole service (the 230 squares and the next slide)',
  ).toBeGreaterThan(20_000);
  await expect.poll(() => copySaved(w), { timeout: 60_000, intervals: [250] }).toBe(true);
  const late = await lateFlips(w);

  // The hub is killed and started again on the same data folder; the window comes back without a reload.
  const origin = await w.evaluate(() => performance.timeOrigin);
  const seen = states.length;
  hub.kill();
  await w.waitForTimeout(1500);
  await hub.start();
  const a2 = await hubApi(port);
  await expect
    .poll(async () => (await hubLive(a2)).resolved?.playlist.id, { timeout: 60_000, intervals: [250] })
    .toBe(pl.id);
  await expect.poll(() => states.length, { timeout: 90_000, intervals: [100] }).toBeGreaterThan(seen);
  const afterBytes = states[seen]!;
  console.log(`sw2-seams A: first state ${firstBytes} B, the first after the restart ${afterBytes} B`);
  // (1) the window holds the copy: the hub sent its state by name, at most a quarter of the first.
  expect(afterBytes, 'the state after the restart is sent by name').toBeLessThanOrEqual(firstBytes / 4);
  expect(await w.evaluate(() => performance.timeOrigin), 'no reload').toBe(origin);
  // (2) the same square is still drawn, from the copy the window holds.
  await expect
    .poll(() => shows('after-restart.png'), { timeout: 90_000, intervals: [1000] })
    .toEqual({
      first: true,
      top: true,
    });
  // (3) a GO to the next slide and back flips, none of them late.
  await w.bringToFront();
  await liveEvent(a2, { k: 'go', cueIndex: 1, at: Date.now() + LEAD_MS });
  await settledOn(w, 1);
  await liveEvent(a2, { k: 'go', cueIndex: 0, at: Date.now() + LEAD_MS });
  await settledOn(w, 0);
  await expect
    .poll(() => shows('after-go-back.png'), { timeout: 90_000, intervals: [1000] })
    .toEqual({
      first: true,
      top: true,
    });
  expect(await lateFlips(w), 'no late flip from the restart to the GO back').toBe(late);
  await w.close();
  hub.kill();
});

test('(B) a hub whose free-space floor is above any real disk pauses uploads and imports and never the service', async ({
  context,
}) => {
  test.setTimeout(300_000);
  const port = portOf('sw2-seams', 1);
  // The technician's override: a whole number of GB from 1 to 10,000, so the floor is above this volume's free space.
  const hub = await hubWithoutLibreOffice(port, { ORDO_MIN_FREE_GB: '10000' });
  hubs.push(hub);
  const a = await hubApi(port);

  // (1) a service is live first (saving a presentation and a playlist is not an upload)
  const red = { r: 200, g: 30, b: 30 };
  const green = { r: 30, g: 180, b: 60 };
  const blue = { r: 20, g: 60, b: 200 };
  const one = await presentation(a, 'Two flat slides', [flatSlide('red', red), flatSlide('green', green)]);
  const other = await presentation(a, 'One blue slide', [flatSlide('blue', blue)]);
  const live = await playlist(a, 'Live now', [one.id]);
  const second = await playlist(a, 'Another service', [other.id]);
  await liveEvent(a, { k: 'goLive', playlistId: live.id });
  await expect.poll(async () => (await hubLive(a)).resolved?.playlist.id, { timeout: 60_000 }).toBe(live.id);
  const audience = await audienceOf(a);
  const w = await audienceWindow(context, port, audience, []);
  await cacheReady(w);
  await w.bringToFront();
  const centre: [number, number] = [960, 540];
  const colourIs = (want: { r: number; g: number; b: number }, file: string) => async () =>
    close(at(await capture(w, join(OUT, file)), centre), [want.r, want.g, want.b], 16);

  // (2) an upload and an import answer 507 with W44's sentence, naming the free space
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const upload = await a.post('media', {
    multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: png }, isBackground: 'false' },
  });
  expect(upload.status(), await upload.text()).toBe(507);
  const refusal = (await upload.json()) as { error: { code: string; message: string } };
  expect(refusal.error.code).toBe('disk');
  expect(refusal.error.message).toMatch(
    /^The hub's disk is almost full \(\d+\.\d GB free\)\. New uploads and pictures are paused so the service keeps running\./,
  );
  const deck = crowdedDeck(join(OUT, 'deck'));
  const imported = await a.post('import/document', {
    multipart: {
      file: {
        name: 'crowded.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        buffer: readFileSync(deck),
      },
    },
  });
  expect(imported.status(), await imported.text()).toBe(507);
  expect(((await imported.json()) as { error: { code: string } }).error.code).toBe('disk');

  // (3) the service goes on: a GO moves the Audience
  await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() + LEAD_MS });
  await settledOn(w, 0);
  await expect.poll(colourIs(red, 'floor-cue0.png'), { timeout: 60_000, intervals: [500] }).toBe(true);
  await liveEvent(a, { k: 'go', cueIndex: 1, at: Date.now() + LEAD_MS });
  await settledOn(w, 1);
  await expect.poll(colourIs(green, 'floor-cue1.png'), { timeout: 60_000, intervals: [500] }).toBe(true);

  // (4) another saved playlist goes live during the service: accepted and applied
  await liveEvent(a, { k: 'goLive', playlistId: second.id });
  await expect
    .poll(async () => (await hubLive(a)).resolved?.playlist.id, { timeout: 60_000 })
    .toBe(second.id);
  await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() + LEAD_MS });
  await settledOn(w, 0);
  await expect.poll(colourIs(blue, 'floor-second.png'), { timeout: 60_000, intervals: [500] }).toBe(true);

  // (5) saving a presentation and a playlist still works
  const saved = await presentation(a, 'Saved while the disk is almost full', [flatSlide('saved', red)]);
  const savedList = await playlist(a, 'Saved list', [saved.id]);
  expect(saved.id).toBeTruthy();
  expect(savedList.id).toBeTruthy();
  await w.close();
  hub.kill();
});
