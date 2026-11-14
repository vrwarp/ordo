import { execFileSync } from 'node:child_process';
import { type IncomingMessage, type Server, createServer, request as httpRequest } from 'node:http';
import { type Socket, connect } from 'node:net';
import { inflateSync } from 'node:zlib';
import { type APIRequestContext, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { SONG, fixtures, testPixelCue, uploadMedia, waitCacheReady } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { expectCue, go, hubApi, hubLive, launchOutputs, login } from './linkhelpers.ts';
import { PNG } from './png.ts';

/**
 * Design/25 chaos for the output window. Ports PORT..PORT+5 (default 8500; ORDO_CHAOS_OUTPUT_PORT moves
 * them so concurrent runs do not collide).
 *
 * Every worker kill is watched on the audience screen for the whole fault window (review 2026-11-04
 * item 7): the test pixel (the cue the screen shows), a pixel of the picture and the cue the window says
 * it holds are sampled about every 100 ms from the kill until the worker's restart count went up and the
 * hold canvas came down, plus 500 ms, and each sample is compared with the value before the kill.
 */
const PORT = Number(process.env.ORDO_CHAOS_OUTPUT_PORT ?? 8500);
/** How long an abruptly killed render worker may go unnoticed (50 ms heartbeat, 200 ms silence, 50 ms check). */
const RENDER_CRASH_DETECT_MS = 400;

type Held = { live: string; armed?: string; queued?: string };
type Ordo = {
  __ordo: {
    state(): Record<string, unknown> & {
      keys: { live: Record<string, string>; armed: Record<string, string> };
      workers: { name: string; restarts: number; generation: number }[];
      hold: boolean;
      holdCue?: number;
      seq: number;
      live?: number;
      armed?: number;
      bus: string;
      quarantined: string[];
      missingImages?: Record<string, string[]>;
      cacheRepairs: number;
      held: Held[];
      errors?: Record<string, string>;
    };
    telemetry(): Record<string, unknown> & {
      resyncs: number;
      cacheRepairs?: number;
      workers?: unknown[];
      armedOk?: boolean;
      armed?: number;
      error?: string;
      cache?: { ready: number; total: number };
    };
    chaos: {
      killWorker(n: 'link' | 'render' | 'asset'): void;
      injectDelta(d: unknown): void;
      verifyCache(): void;
    };
  };
};

const st = (p: Page) => p.evaluate(() => (window as unknown as Ordo).__ordo.state());
const restarts = async (p: Page, name: string) =>
  (await st(p)).workers.find((w) => w.name === name)?.restarts ?? 0;

type Rgb = { r: number; g: number; b: number };

/** Where the picture pixel is: near the top of the 16:9 picture (the navy background, away from the lyric). */
async function centreXY(p: Page): Promise<[number, number]> {
  return p.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pw = Math.min(w, (h * 16) / 9);
    const ph = (pw * 9) / 16;
    return [Math.floor(w / 2), Math.floor((h - ph) / 2 + ph * 0.06)] as [number, number];
  });
}

async function pixel(p: Page, x: number, y: number): Promise<Rgb> {
  return PNG.firstPixel(await p.screenshot({ clip: { x, y, width: 1, height: 1 } }));
}

/** Decode an 8-bit RGB/RGBA PNG screenshot (all five scanline filters): pixel (x, y) as RGB. */
function decodePng(buf: Buffer): ((x: number, y: number) => Rgb) & { width: number; height: number } {
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp]! : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f] ?? 0;
      out[y * stride + i] = (raw[src + i]! + pred) & 255;
    }
  }
  const at = (x: number, y: number): Rgb => {
    const i = y * stride + x * bpp;
    return { r: out[i]!, g: out[i + 1]!, b: out[i + 2]! };
  };
  return Object.assign(at, { width, height });
}

type Cdp = {
  send(m: string, p?: unknown): Promise<unknown>;
  on(ev: string, fn: (e: never) => void): void;
};
const cdps = new WeakMap<Page, Cdp>();

/**
 * The test pixel (0, 0) and the picture pixel (cx, cy) from one screenshot of the composited screen,
 * taken over CDP (Playwright's screenshot waits for extra frames and takes ~300 ms; this takes ~30).
 */
async function twoPixels(p: Page, cx: number, cy: number): Promise<[Rgb, Rgb]> {
  let cdp = cdps.get(p);
  if (!cdp) {
    cdp = (await p.context().newCDPSession(p)) as unknown as Cdp;
    cdps.set(p, cdp);
  }
  const r = (await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: cx + 1, height: cy + 1, scale: 1 },
    optimizeForSpeed: true,
  })) as { data: string };
  const px = decodePng(Buffer.from(r.data, 'base64'));
  return [px(0, 0), px(cx, cy)];
}

/** The cue in the test pixel (r = cue & 255, g = cue >> 8, b = 255), null when the pixel is not a marker. */
const markerCue = (px: Rgb): number | null => (px.b < 200 ? null : px.r + (px.g << 8));

/** The slide cue a held-keys list says is live (`sl|...|<cue>|...`), null when none. */
const heldCue = (held: Held[]): number | null => {
  const m = /^sl\|[^|]*\|[^|]*\|(\d+)\|/.exec(held[1]?.live ?? '');
  return m ? Number(m[1]) : null;
};

type Sample = {
  t: number;
  cue: number | null;
  px: Rgb;
  hold: boolean;
  /** The cue the window says the screen holds: the hold's cue while it is up, else the renderer's. */
  shown: number | null;
  restarts: number;
};

const dist = (a: Rgb, b: Rgb) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

/**
 * Kill `worker` and sample the screen about every `everyMs` until its restart count went up and the hold
 * came down, then for 500 ms more. Every sample must show the pre-kill cue (test pixel and the window's
 * own account) and the pre-kill picture pixel: never black, never transparent, never a fade from black.
 */
async function killAndWatch(
  o: Page,
  worker: 'link' | 'render' | 'asset',
  opts: { everyMs?: number; maxMs?: number; graceMs?: number } = {},
): Promise<Sample[]> {
  // CHAOS_SAMPLE_MS samples faster (e.g. 20) when checking a fix by hand.
  const everyMs = opts.everyMs ?? Number(process.env.CHAOS_SAMPLE_MS ?? 100);
  const maxMs = opts.maxMs ?? 25_000;
  await o.bringToFront();
  await o.waitForTimeout(300);
  const [cx, cy] = await centreXY(o);
  const before = await restarts(o, worker);
  const s0 = await st(o);
  const pre = { cue: markerCue(await pixel(o, 0, 0)), px: await pixel(o, cx, cy), shown: heldCue(s0.held) };
  expect(pre.cue, 'the test pixel shows a cue before the kill').not.toBeNull();
  expect(pre.shown).toBe(pre.cue);
  expect(pre.px.r + pre.px.g + pre.px.b).toBeGreaterThan(30);

  // Every composited frame is also recorded (CDP screencast) through the restart, so a one-frame glitch
  // between two samples is caught too (review F7); CHAOS_SCREENCAST=0 turns it off.
  const frames: { t: number; cue: number | null; px: Rgb }[] = [];
  let cast: Cdp | undefined;
  let scaled = 0;
  const vw = await o.evaluate(() => window.innerWidth);
  if (process.env.CHAOS_SCREENCAST !== '0') {
    cast = (await o.context().newCDPSession(o)) as unknown as Cdp;
    cast.on('Page.screencastFrame', (e: { data: string; sessionId: number }) => {
      const px = decodePng(Buffer.from(e.data, 'base64'));
      // A frame may come scaled: only full-size frames carry the 1 px test marker exactly.
      if (px.width >= vw) frames.push({ t: Date.now() - t0, cue: markerCue(px(0, 0)), px: px(cx, cy) });
      else scaled++;
      void cast!.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => undefined);
    });
    await cast.send('Page.startScreencast', {
      format: 'png',
      everyNthFrame: 1,
      maxWidth: vw,
      maxHeight: 4000,
    });
  }
  const t0 = Date.now();
  await o.evaluate((n) => (window as unknown as Ordo).__ordo.chaos.killWorker(n), worker);
  const samples: Sample[] = [];
  let recoveredAt = 0;
  while (Date.now() - t0 < maxMs) {
    const t = Date.now() - t0;
    const [[mark, px], s] = await Promise.all([twoPixels(o, cx, cy), st(o)]);
    const r = s.workers.find((w) => w.name === worker)?.restarts ?? 0;
    samples.push({
      t,
      cue: markerCue(mark),
      px,
      hold: s.hold,
      shown: s.hold ? (s.holdCue ?? null) : heldCue(s.held),
      restarts: r,
    });
    if (!recoveredAt && r > before && !s.hold) recoveredAt = Date.now();
    if (recoveredAt && Date.now() - recoveredAt >= 500) break;
    const wait = everyMs - (Date.now() - t0 - t);
    if (wait > 0) await o.waitForTimeout(wait);
  }
  if (cast) {
    await cast.send('Page.stopScreencast').catch(() => undefined);
    let gap = 0;
    for (let i = 1; i < frames.length; i++) gap = Math.max(gap, frames[i]!.t - frames[i - 1]!.t);
    const wrong = frames.filter(
      (f) =>
        f.t >= (opts.graceMs ?? 0) &&
        (f.cue !== pre.cue || dist(f.px, pre.px) > 30 || f.px.r + f.px.g + f.px.b < 30),
    );
    console.log(
      `${worker} kill screencast: ${frames.length} frames (${scaled} scaled ones skipped), largest gap ${gap} ms, ${wrong.length} wrong`,
    );
    expect(wrong.map((f) => `${f.t}ms cue=${f.cue} px=${f.px.r},${f.px.g},${f.px.b}`)).toEqual([]);
  }
  const line = (x: Sample) =>
    `${x.t}ms cue=${x.cue} shown=${x.shown} px=${x.px.r},${x.px.g},${x.px.b} hold=${x.hold} restarts=${x.restarts}`;
  const timeline = samples.map(line).join('\n');
  expect(
    recoveredAt,
    `the ${worker} worker did not restart and uncover in time:\n${timeline}`,
  ).toBeGreaterThan(0);
  // A render worker that dies abruptly takes its canvas's picture with it (Chrome may composite the
  // dead OffscreenCanvas placeholder white at once); the host notices from the missing 50 ms heartbeat
  // within about 250 ms and covers the screen with the hold. That detection window is reported, not
  // failed; everything after it must hold.
  const grace = opts.graceMs ?? 0;
  const inGrace = samples.filter((x) => x.t < grace && (x.cue !== pre.cue || dist(x.px, pre.px) > 30));
  if (inGrace.length)
    console.log(`${worker} kill: ${inGrace.length} sample(s) off in the first ${grace} ms (crash detection)`);
  const bad = samples.filter(
    (x) =>
      x.t >= grace &&
      (x.cue !== pre.cue || x.shown !== pre.cue || dist(x.px, pre.px) > 30 || x.px.r + x.px.g + x.px.b < 30),
  );
  const log = bad.length ? ((await st(o)) as { log?: string[] }).log?.join('\n') : '';
  expect(
    bad.map(line),
    `the screen must hold cue ${pre.cue} (${pre.px.r},${pre.px.g},${pre.px.b}) through the ${worker} restart:\n${timeline}\n${log}`,
  ).toEqual([]);
  console.log(
    `${worker} kill: ${samples.length} samples over ${samples.at(-1)?.t} ms (mean interval ${Math.round(
      (samples.at(-1)?.t ?? 0) / Math.max(1, samples.length - 1),
    )} ms), all on cue ${pre.cue}`,
  );
  return samples;
}

async function opfsSize(p: Page, hash: string): Promise<number> {
  return p.evaluate(async (h) => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('ordo-cache');
      return (await (await dir.getFileHandle(h)).getFile()).size;
    } catch {
      return -1; // being replaced
    }
  }, hash);
}

async function corrupt(p: Page, hash: string, sameSize: boolean): Promise<void> {
  await p.evaluate(
    async ({ h, same }) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('ordo-cache');
      const fh = await dir.getFileHandle(h);
      const size = (await fh.getFile()).size;
      const w = await fh.createWritable();
      const junk = new Uint8Array(same ? size : 1234);
      for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) & 255;
      await w.write(junk);
      await w.close();
    },
    { h: hash, same: sameSize },
  );
}

/** Sample the screen while `ms` pass: it must never go black. */
async function neverBlack(p: Page, ms: number): Promise<void> {
  const [x, y] = await centreXY(p);
  await p.bringToFront();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const px = await pixel(p, x, y);
    expect(px.r + px.g + px.b, `screen went black at ${new Date().toISOString()}`).toBeGreaterThan(30);
    await p.waitForTimeout(100);
  }
}

/** Only audience output 1 (the audio master by default) enabled. */
async function oneOutput(a: APIRequestContext): Promise<void> {
  const outs = (await (await a.get('settings/outputs')).json()) as { hostIndex: number; kind: string }[];
  const settings = outs.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex <= 1 }));
  expect((await a.put('settings/outputs', { data: settings })).ok()).toBe(true);
}

async function goLiveWith(a: APIRequestContext, items: unknown[]): Promise<void> {
  const pl = await (await a.post('playlists', { data: { name: 'Chaos', items } })).json();
  expect(
    (await a.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } })).ok(),
  ).toBe(true);
}

/** Launch output 1 from the operator and reload it with the chaos hooks (`?test=1`) and Canvas 2D. */
async function launchChaosOutput(page: Page, context: BrowserContext, port: number): Promise<Page> {
  await login(page, `http://op.localhost:${port}`);
  const [out] = await launchOutputs(page, context, 1);
  const o = out!;
  // The chaos hooks exist only with ?test=1: reload the launched window with it (the opener stays).
  // Canvas 2D as in the other specs: this container's software WebGPU loses its device at start-up.
  await o.goto(`${o.url()}&test=1&renderer=2d`);
  return o;
}

/**
 * Workers are killed, a cached file is corrupted, a malformed delta arrives; the audience screen keeps its
 * picture throughout, the window recovers on its own, and GO keeps working.
 */
test('the output survives killed workers, a corrupt cache file and a malformed delta', async ({
  context,
  page,
}) => {
  test.setTimeout(300_000);
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    const a = await hubApi(PORT);
    const fx = fixtures();
    const bg = await uploadMedia(a, fx.png, 'image/png', true);
    const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
    const full = await (await a.get(`presentations/${song.id}`)).json();
    expect(
      (await a.put(`presentations/${song.id}`, { data: { ...full, backgroundMediaId: bg.id } })).ok(),
    ).toBe(true);
    await oneOutput(a);
    await goLiveWith(a, [{ id: 'i1', kind: 'presentation', presentationId: song.id }]);

    const o = await launchChaosOutput(page, context, PORT);
    await waitCacheReady(o);
    await go(page);
    await expectCue([o], 0);
    await expect
      .poll(async () => (await st(o)).keys.live.background ?? '', { timeout: 15_000 })
      .toMatch(/^bg\|/);
    const bgHash = (await st(o)).keys.live.background!.split('|')[2]!;
    const bgBytes = await opfsSize(o, bgHash);
    expect(bgBytes).toBeGreaterThan(0);

    await test.step('(a) a killed link worker restarts; the screen holds its cue throughout; the next GO flips', async () => {
      await killAndWatch(o, 'link');
      await expect.poll(async () => (await st(o)).bus, { timeout: 15_000 }).toBe('hub');
      await go(page);
      await expectCue([o], 1);
      await expect.poll(() => testPixelCue(o), { timeout: 10_000 }).toBe(1);
    });

    await test.step('(a) a killed render worker is rebuilt under the hold: never black, never a fade', async () => {
      await killAndWatch(o, 'render', { graceMs: RENDER_CRASH_DETECT_MS });
      await expectCue([o], 1);
      await page.bringToFront();
      await page.keyboard.press('ArrowLeft');
      await expectCue([o], 0);
      await expect.poll(() => testPixelCue(o), { timeout: 10_000 }).toBe(0);
    });

    await test.step('(a) a render worker killed right after a GO holds the new cue', async () => {
      await go(page);
      await expectCue([o], 1);
      await expect.poll(() => testPixelCue(o), { timeout: 10_000 }).toBe(1);
      await killAndWatch(o, 'render', { graceMs: RENDER_CRASH_DETECT_MS });
    });

    await test.step('(a) a killed asset worker restarts; the screen holds; the next GO is prepared by the new one', async () => {
      await killAndWatch(o, 'asset');
      await go(page);
      await expectCue([o], 2);
      await neverBlack(o, 500);
      const t = await o.evaluate(() => (window as unknown as Ordo).__ordo.telemetry());
      expect(Array.isArray(t.workers)).toBe(true);
    });

    await test.step('(b) a truncated cache file is found and fetched again', async () => {
      await corrupt(o, bgHash, false);
      expect(await opfsSize(o, bgHash)).toBe(1234);
      await o.evaluate(() => (window as unknown as Ordo).__ordo.chaos.verifyCache());
      await expect.poll(() => opfsSize(o, bgHash), { timeout: 20_000 }).toBe(bgBytes);
      expect((await st(o)).cacheRepairs).toBeGreaterThanOrEqual(1);
      await neverBlack(o, 300);
    });

    await test.step('(b) a same-size corrupt file fails to decode: removed, fetched again, re-armed', async () => {
      const before = (await st(o)).cacheRepairs;
      await corrupt(o, bgHash, true);
      // Drop every decoded copy: the asset worker's cache and the render worker's stacks.
      const assets = await restarts(o, 'asset');
      await o.evaluate(() => (window as unknown as Ordo).__ordo.chaos.killWorker('asset'));
      await expect.poll(() => restarts(o, 'asset'), { timeout: 15_000 }).toBeGreaterThan(assets);
      await killAndWatch(o, 'render', { graceMs: RENDER_CRASH_DETECT_MS });
      await expect.poll(async () => (await st(o)).cacheRepairs, { timeout: 20_000 }).toBeGreaterThan(before);
      await expect.poll(() => opfsSize(o, bgHash), { timeout: 20_000 }).toBe(bgBytes);
      await expect
        .poll(async () => (await st(o)).held[0]?.live ?? '', { timeout: 30_000 })
        .toBe(`bg|${bg.id}|${bgHash}`);
      expect((await st(o)).quarantined).toEqual([]);
      await expect.poll(async () => (await st(o)).hold, { timeout: 15_000 }).toBe(false);
      await expectCue([o], 2);
    });

    await test.step('(c) a malformed delta is rejected with a resync; the state is intact', async () => {
      const s0 = await st(o);
      const r0 = (await o.evaluate(() => (window as unknown as Ordo).__ordo.telemetry())).resyncs;
      await o.evaluate((seq) => {
        const c = (window as unknown as Ordo).__ordo.chaos;
        c.injectDelta({
          t: 'live.delta',
          v: 1,
          seq: seq + 1,
          fromSeq: seq,
          event: { k: 'go', cueIndex: 'x' },
        });
        c.injectDelta({ t: 'live.delta', v: 1, seq: seq + 1, fromSeq: seq, event: null });
        c.injectDelta({ nonsense: true });
      }, s0.seq);
      await expect
        .poll(async () => (await o.evaluate(() => (window as unknown as Ordo).__ordo.telemetry())).resyncs, {
          timeout: 10_000,
        })
        .toBeGreaterThan(r0);
      const s1 = await st(o);
      expect(s1.live).toBe(s0.live);
      expect(s1.seq).toBe(s0.seq);
      await expectCue([o], 2);
      await page.bringToFront();
      await page.keyboard.press('ArrowLeft');
      await expectCue([o], 1);
      await expect.poll(() => testPixelCue(o), { timeout: 10_000 }).toBe(1);
    });

    await test.step('(d) GPU device-loss rebuilds after a reload never uncover a white or black canvas', async () => {
      // This container's software WebGPU loses its device right after start (several times, then the
      // engine switches to Canvas 2D on a fresh canvas): reload with ?renderer=webgpu (a software adapter
      // otherwise gets Canvas 2D at once) to get those rebuilds.
      await o.bringToFront();
      const [cx, cy] = await centreXY(o);
      const ref = (await twoPixels(o, cx, cy))[1];
      expect(markerCue((await twoPixels(o, cx, cy))[0])).toBe(1);
      await o.goto(o.url().replace('&renderer=2d', '&renderer=webgpu'));
      const t0 = Date.now();
      const samples: {
        t: number;
        cue: number | null;
        px: Rgb;
        hold: boolean;
        gpuLost: number;
        why: string;
      }[] = [];
      while (Date.now() - t0 < 10_000) {
        const [shot, info] = await Promise.all([
          // The window is reloading: a screenshot taken between documents fails; that is not a sample.
          twoPixels(o, cx, cy).catch(() => null),
          o
            .evaluate(() => {
              const w = window as unknown as Ordo;
              const t = w.__ordo.telemetry() as { gpuLost?: number };
              const st = w.__ordo.state() as { hold: boolean; holdReasons?: string[] };
              return { hold: st.hold, gpuLost: t.gpuLost ?? 0, why: (st.holdReasons ?? []).join('+') };
            })
            .catch(() => ({ hold: false, gpuLost: 0, why: '' })),
        ]);
        if (shot) samples.push({ t: Date.now() - t0, cue: markerCue(shot[0]), px: shot[1], ...info });
        await o.waitForTimeout(40);
      }
      const good = (x: (typeof samples)[number]) => x.cue === 1 && dist(x.px, ref) <= 30;
      const first = samples.findIndex(good);
      const line = (x: (typeof samples)[number]) =>
        `${x.t}ms cue=${x.cue} px=${x.px.r},${x.px.g},${x.px.b} hold=${x.hold}${x.why ? `(${x.why})` : ''} gpuLost=${x.gpuLost}`;
      const timeline = samples.map(line).join('\n');
      expect(first, `the reloaded output never showed cue 1:\n${timeline}`).toBeGreaterThanOrEqual(0);
      // Never a white (lost) canvas, before the first frame either; once the cue is on screen it stays
      // there through every rebuild.
      const white = (x: (typeof samples)[number]) => x.px.r > 230 && x.px.g > 230 && x.px.b > 230;
      const bad = [...samples.slice(0, first).filter(white), ...samples.slice(first).filter((x) => !good(x))];
      expect(bad.map(line), `the picture was lost during a device-loss rebuild:\n${timeline}`).toEqual([]);
      const lost = samples.at(-1)!.gpuLost;
      if (process.env.CHAOS_DEBUG) console.log(timeline);
      console.log(
        `device-loss reload: first good frame at ${samples[first]!.t} ms, ${lost} device loss(es), ${samples.length} samples, all good after it`,
      );
    });
  } finally {
    hub.kill();
  }
});

/**
 * Review 2026-11-04 item 2: a video's end must not be lost across a link-worker restart. The link is
 * killed while a non-looping clip with "advance" plays; the clip ends while no link worker is alive; the
 * restarted link learns it from the host and the hub advances.
 */
test('a clip that ends while the link worker is dead still advances the service', async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  const port = PORT + 1;
  const hub = HubProcess.fresh(port);
  await hub.start();
  try {
    const a = await hubApi(port);
    const fx = fixtures(); // a 2 s clip
    const clip = await uploadMedia(a, fx.mp4, 'video/mp4');
    const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
    await oneOutput(a);
    await goLiveWith(a, [
      { id: 'v', kind: 'media', mediaId: clip.id, onEnd: 'advance' },
      { id: 's', kind: 'presentation', presentationId: song.id },
    ]);
    const o = await launchChaosOutput(page, context, port);
    await waitCacheReady(o);
    // The armed clip is ready on its first frame before it goes live.
    await expect.poll(async () => (await st(o)).keys.armed.media ?? '', { timeout: 15_000 }).toMatch(/^md\|/);
    await go(page);
    await expect.poll(() => hubLive(a), { timeout: 10_000 }).toBe(0);
    await o.bringToFront();
    await o.waitForTimeout(500);
    const before = await restarts(o, 'link');
    const killedAt = Date.now();
    await o.evaluate(() => (window as unknown as Ordo).__ordo.chaos.killWorker('link'));
    // The clip ends about 1.5 s later, long before the supervisor notices the dead link (4 s).
    await expect.poll(() => restarts(o, 'link'), { timeout: 15_000 }).toBeGreaterThan(before);
    await expect.poll(() => hubLive(a), { timeout: 15_000 }).toBe(1);
    console.log(`hub advanced ${Date.now() - killedAt} ms after the link worker was killed`);
    await expectCue([o], 1);
  } finally {
    hub.kill();
  }
});

/**
 * An HTTP proxy in front of a hub that can take the file route down (503) while everything else, the
 * WebSockets included, passes. Playwright's routing does not see requests from workers, so the outage is
 * made here; the browser reaches the hub only through this port.
 */
class FileOutageProxy {
  outage = false;
  /** File hashes answered 503 while the rest of the route works (a file the hub cannot serve yet). */
  withhold = new Set<string>();
  refused = 0;
  private server?: Server;
  private sockets = new Set<Socket>();
  readonly port: number;
  readonly hubPort: number;
  constructor(port: number, hubPort: number) {
    this.port = port;
    this.hubPort = hubPort;
  }

  start(): Promise<void> {
    const server = createServer((req, res) => {
      const withheld =
        req.url?.startsWith('/api/v1/files/') &&
        [...this.withhold].some((h) => req.url?.startsWith(`/api/v1/files/${h}`));
      if ((this.outage && req.url?.startsWith('/api/v1/files/')) || withheld) {
        this.refused++;
        res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '1' });
        res.end('outage');
        return;
      }
      const up = httpRequest(
        { host: '127.0.0.1', port: this.hubPort, method: req.method, path: req.url, headers: req.headers },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      up.on('error', () => res.destroy());
      req.pipe(up);
    });
    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const up = connect(this.hubPort, '127.0.0.1', () => {
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2)
          raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        up.write(`${raw}\r\n`);
        if (head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      const drop = () => {
        socket.destroy();
        up.destroy();
      };
      up.on('error', drop);
      socket.on('error', drop);
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

/**
 * Review 2026-11-04 item 3: a transient outage of the file route on a fresh output (a slow NAS at service
 * start) must not quarantine good cues. The background and two video cues cannot be fetched for 14 s;
 * once the fill completes everything arms, nothing is quarantined, and `armedOk` is never true while the
 * armed cue is not actually held.
 */
test('a 14 s file-route outage on a fresh output quarantines nothing', async ({ context, page }) => {
  test.setTimeout(240_000);
  const port = PORT + 2;
  const hub = HubProcess.fresh(port);
  const proxy = new FileOutageProxy(PORT + 3, port);
  await hub.start();
  await proxy.start();
  try {
    const a = await hubApi(port);
    const fx = fixtures();
    const bg = await uploadMedia(a, fx.png, 'image/png', true);
    const clip = await uploadMedia(a, fx.mp4, 'video/mp4');
    const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
    const full = await (await a.get(`presentations/${song.id}`)).json();
    expect(
      (await a.put(`presentations/${song.id}`, { data: { ...full, backgroundMediaId: bg.id } })).ok(),
    ).toBe(true);
    await oneOutput(a);
    await goLiveWith(a, [
      { id: 's', kind: 'presentation', presentationId: song.id },
      { id: 'v1', kind: 'media', mediaId: clip.id, loop: true },
      { id: 'v2', kind: 'media', mediaId: clip.id, onEnd: 'hold' },
    ]);
    // The file route is down for 14 s from before the operator signs in, so neither the fresh output
    // window (fill, asset worker, media elements) nor the operator's cache (fallback files) can get a file.
    proxy.outage = true;
    const outageAt = Date.now();
    await login(page, `http://op.localhost:${proxy.port}`);
    // The last song slide live (the background on screen) and the first clip armed: during the outage
    // the background and a video both fail to arm.
    const cueList = (await (await a.get('live')).json()).state.cues as { kind: string; mediaId?: string }[];
    const firstClip = cueList.findIndex((c) => c.mediaId === clip.id);
    expect(firstClip).toBeGreaterThan(0);
    expect(
      (
        await a.post('live/events', {
          data: { id: 'g1', event: { k: 'go', cueIndex: firstClip - 1, at: Date.now() } },
        })
      ).ok(),
    ).toBe(true);
    const before = new Set(context.pages());
    await page.getByRole('button', { name: 'Launch outputs' }).click();
    await expect
      .poll(() => context.pages().filter((p) => !before.has(p)).length, { timeout: 20_000 })
      .toBe(1);
    const o = context.pages().find((p) => !before.has(p))!;
    const started = Date.now();
    // armedOk must never be true while an armed key is not held. Health is assembled once a second, so a
    // claim is a lie only when it persists for 1.5 s with the same armed cue.
    const lies: string[] = [];
    let since = 0;
    let quarantinedDuring: string[] = [];
    const check = async () => {
      const [s, t] = await Promise.all([
        st(o),
        o.evaluate(() => (window as unknown as Ordo).__ordo.telemetry()),
      ]);
      if (s.quarantined.length) quarantinedDuring = s.quarantined;
      const held = new Set(s.held.flatMap((h) => [h.live, h.armed, h.queued].filter(Boolean) as string[]));
      const missing = Object.values(s.keys.armed ?? {}).filter((k) => k && !held.has(k));
      if (t.armedOk === true && missing.length && t.armed === s.armed) {
        since ||= Date.now();
        if (Date.now() - since > 1500)
          lies.push(
            `${Date.now() - started} ms: armedOk on cue ${s.armed} with ${missing.join(', ')} not held`,
          );
      } else since = 0;
    };
    while (Date.now() - outageAt < 14_000) {
      await check().catch(() => undefined);
      await o.waitForTimeout(250);
    }
    proxy.outage = false;
    console.log(`file route refused ${proxy.refused} requests during the outage`);
    expect(proxy.refused).toBeGreaterThan(0);
    const s14 = await st(o);
    if (process.env.CHAOS_DEBUG) console.log(((s14 as { log?: string[] }).log ?? []).join('\n'));
    console.log(
      `after the outage: quarantined ${JSON.stringify(s14.quarantined)}, errors ${JSON.stringify(s14.errors)}`,
    );
    // After the fill: everything arms. Walk the armed cue through the song and both videos.
    await waitCacheReady(o);
    await expect.poll(async () => (await st(o)).held[0]?.live ?? '', { timeout: 20_000 }).toMatch(/^bg\|/);
    for (let cue = firstClip; cue < cueList.length; cue++) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        await check();
        const t = await o.evaluate(() => (window as unknown as Ordo).__ordo.telemetry());
        if (t.armedOk === true || Date.now() > deadline) break;
        await o.waitForTimeout(250);
      }
      const t = await o.evaluate(() => (window as unknown as Ordo).__ordo.telemetry());
      expect(t.armedOk, `cue ${cue} did not arm: ${JSON.stringify(t.error ?? '')}`).toBe(true);
      expect((await st(o)).quarantined).toEqual([]);
      await go(page);
      await expect.poll(() => hubLive(a), { timeout: 10_000 }).toBe(cue);
      since = 0;
    }
    expect(quarantinedDuring).toEqual([]);
    expect(lies).toEqual([]);
  } finally {
    await proxy.stop();
    hub.kill();
  }
});

/**
 * Design/14 "Slide images that arrive late": a slide whose image file the hub cannot serve yet is drawn
 * without the image (the cue still arms and goes live), and drawn again, in place, once the file arrives
 * with a later fill: no flip, no hold, never black, the cue unchanged.
 */
test('a slide image withheld until after GO is drawn in once its file arrives', async ({ context, page }) => {
  test.setTimeout(240_000);
  const port = PORT + 4;
  const hub = HubProcess.fresh(port);
  const proxy = new FileOutageProxy(PORT + 5, port);
  await hub.start();
  await proxy.start();
  try {
    const a = await hubApi(port);
    const fx = fixtures();
    const orange = 'test-results/fixtures/orange.png';
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=orange:s=400x400',
      '-frames:v',
      '1',
      orange,
    ]);
    const bg = await uploadMedia(a, fx.png, 'image/png', true);
    const img = await uploadMedia(a, orange, 'image/png');
    const rec = (await (await a.get(`media/${img.id}`)).json()) as {
      original: { hash: string };
      delivery?: { hash: string };
    };
    const imgHash = (rec.delivery ?? rec.original).hash;
    const pres = await (
      await a.post('presentations', {
        data: {
          title: 'Picture',
          kind: 'slides',
          backgroundMediaId: bg.id,
          sections: [
            {
              id: 's1',
              label: 'A',
              short: 'A',
              slides: [
                {
                  id: 'sl1',
                  objects: [
                    { id: 'o1', type: 'image', box: { x: 760, y: 340, w: 400, h: 400 }, mediaId: img.id },
                  ],
                },
              ],
            },
          ],
        },
      })
    ).json();
    await oneOutput(a);
    await goLiveWith(a, [{ id: 'i1', kind: 'presentation', presentationId: pres.id }]);
    // The image's file is withheld from before the window opens: neither the fill nor the asset worker
    // can get it, the slide arms without it.
    proxy.withhold.add(imgHash);
    await login(page, `http://op.localhost:${proxy.port}`);
    const before = new Set(context.pages());
    await page.getByRole('button', { name: 'Launch outputs' }).click();
    await expect
      .poll(() => context.pages().filter((p) => !before.has(p)).length, { timeout: 20_000 })
      .toBe(1);
    const o = context.pages().find((p) => !before.has(p))!;
    await o.goto(`${o.url()}&test=1&renderer=2d`);
    await go(page);
    await expectCue([o], 0);
    await expect.poll(() => testPixelCue(o), { timeout: 10_000 }).toBe(0);
    await expect
      .poll(async () => Object.keys((await st(o)).missingImages ?? {}).length, { timeout: 15_000 })
      .toBe(1);
    await o.bringToFront();
    const [cx, cy] = await centreXY(o);
    // The image sits in the middle of the picture (logical box 760,340 400x400).
    const [mx, my] = await o.evaluate(
      () => [Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight / 2)] as [number, number],
    );
    const centre0 = await pixel(o, mx, my);
    console.log(`slide drawn without its image: centre ${centre0.r},${centre0.g},${centre0.b}`);
    expect(centre0.r, 'the image (orange) is not on screen yet').toBeLessThan(150);
    expect(proxy.refused).toBeGreaterThan(0);
    // The file arrives: a later fill caches it and the slide is drawn again with it, in place.
    proxy.withhold.clear();
    const t0 = Date.now();
    const samples: string[] = [];
    let drawnAt = 0;
    while (Date.now() - t0 < 90_000) {
      const [[mark, px], s] = await Promise.all([twoPixels(o, cx, cy), st(o)]);
      const centre = await pixel(o, mx, my);
      const line = `${Date.now() - t0}ms cue=${markerCue(mark)} px=${px.r},${px.g},${px.b} centre=${centre.r},${centre.g},${centre.b} hold=${s.hold} missing=${Object.keys(s.missingImages ?? {}).length}`;
      samples.push(line);
      expect(markerCue(mark), `the cue changed:\n${samples.join('\n')}`).toBe(0);
      expect(s.hold, `the hold came up:\n${samples.join('\n')}`).toBe(false);
      expect(px.r + px.g + px.b, `the screen went black:\n${samples.join('\n')}`).toBeGreaterThan(30);
      if (centre.r > 200 && centre.g > 100 && centre.b < 60 && !Object.keys(s.missingImages ?? {}).length) {
        drawnAt = Date.now() - t0;
        break;
      }
      await o.waitForTimeout(200);
    }
    expect(drawnAt, `the image never appeared:\n${samples.join('\n')}`).toBeGreaterThan(0);
    console.log(
      `slide image drawn in ${drawnAt} ms after its file became available (${samples.length} samples, cue 0 throughout)`,
    );
    expect((await st(o)).quarantined).toEqual([]);
    await neverBlack(o, 500);
  } finally {
    await proxy.stop();
    hub.kill();
  }
});
