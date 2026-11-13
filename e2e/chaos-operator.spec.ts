import {
  type APIRequestContext,
  type BrowserContext,
  type CDPSession,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { SONG, fixtures, uploadMedia, waitCacheReady } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { busOf, expectCue, go, hubApi, hubLive, launchOutputs, liveService, login } from './linkhelpers.ts';
import { inflateSync } from 'node:zlib';
import { PNG } from './png.ts';

/**
 * Chaos for the operator window (design/25, phase C): the core worker dies mid-service (in hub mode, while
 * the operator is the fallback authority, and during the hand-back), the main thread blocks, the hub dies,
 * the session expires. The audience screens must not notice; no command may be lost.
 *
 * Every fault that the audience could see is watched on the output for the whole fault window (review
 * 2026-11-04 item 7): the cue the window says it holds and its bus are sampled every 100 ms by a timer
 * inside the output page (so the cadence does not depend on the test runner: a max gap of 600 ms is
 * asserted, with the first sample at the fault), and the test pixel (the cue on screen) plus a pixel of the
 * picture are a second, lower-rate series from CDP captures (as fast as the machine allows, 100 ms to
 * seconds each under load), from the fault until recovery plus 500 ms.
 *
 * Each test owns a hub on its own port and the specs share the machine's CPU with CDP captures, so the file
 * is serial: not safe to run in parallel with itself or with the other chaos specs on the same ports.
 *
 * Ports BASE+1..BASE+7 (default 8540; ORDO_CHAOS_OPERATOR_PORT moves them so concurrent runs do not collide).
 */
const BASE = Number(process.env.ORDO_CHAOS_OPERATOR_PORT ?? 8540);
test.describe.configure({ mode: 'serial' });

type Hooks = {
  __ordo: {
    live(): {
      seq: number;
      live?: number;
      authority: string;
      hubConnected: boolean;
      hubRefused?: string;
      reconcile: string | null;
      recovering: boolean;
      generation?: number;
      endpoints: Record<string, { active: string; port: boolean; relay: boolean; ready: boolean }>;
      offers: Record<string, number>;
      mainThreadStallMaxMs?: number;
      unacknowledged: number;
    };
    chaos: {
      killWorker(name: string): boolean;
      blockMain(ms: number): void;
      workerDispatch(action: { id: string }, delayMs: number): void;
      kickHub(): void;
    };
  };
};

function opUrl(port: number): string {
  return `http://op.localhost:${port}`;
}

/** Turn on the operator's test hooks before any page script runs. */
async function testMode(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('ordo.test', '1');
    } catch {
      /* not an operator origin */
    }
  });
}

function opLive(page: Page) {
  return page.evaluate(() => (window as unknown as Hooks).__ordo.live());
}

/** The output's own view of its fallback-bus carrier ('port' or 'window'), when it reports one. */
async function outputTransport(p: Page): Promise<string | undefined> {
  return p.evaluate(
    () => (window as unknown as { __ordo: { state(): { transport?: string } } }).__ordo.state().transport,
  );
}

// ---------------------------------------------------------------- the audience screen, sampled

type Rgb = { r: number; g: number; b: number };
/** A sample taken inside the output page: the cue it holds and its bus, `t` ms after the watch began. */
type CueSample = { t: number; shown: number | null; bus: string };
/** A CDP capture: the test pixel (decoded to a cue) and the picture pixel. */
type PixelSample = { t: number; cue: number | null; px: Rgb };
type ChaosWindow = Window & { __chaos?: CueSample[]; __chaosTimer?: number; __chaosT0?: number };

async function pixel(p: Page, x: number, y: number): Promise<Rgb> {
  return PNG.firstPixel(await p.screenshot({ clip: { x, y, width: 1, height: 1 } }));
}

/** Decode an 8-bit RGB(A) PNG screenshot (all five scanline filters) and read the pixel at (x, y). */
function pngPixels(buf: Buffer): (x: number, y: number) => Rgb {
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
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const v = raw[src + i]!;
      const a = i >= bpp ? out[row + i - bpp]! : 0;
      const b = y > 0 ? out[row - stride + i]! : 0;
      const c = i >= bpp && y > 0 ? out[row - stride + i - bpp]! : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + i] = (v + pred) & 255;
    }
  }
  return (x, y) => {
    const i = y * stride + x * bpp;
    return { r: out[i]!, g: out[i + 1]!, b: out[i + 2]! };
  };
}

const cdps = new WeakMap<Page, Promise<CDPSession>>();

/**
 * One capture for both points: the test pixel at (0,0) and the picture pixel at (x, y). A raw CDP capture
 * of the compositor surface: Playwright's screenshot waits and restyles (caret, fonts) and takes 300 to
 * 800 ms here, too slow to sample every 100 ms.
 */
async function twoPixels(p: Page, x: number, y: number): Promise<[Rgb, Rgb]> {
  let s = cdps.get(p);
  if (!s) {
    s = p.context().newCDPSession(p);
    cdps.set(p, s);
  }
  const r = (await (
    await s
  ).send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: x + 1, height: y + 1, scale: 1 },
    optimizeForSpeed: true,
  })) as { data: string };
  const at = pngPixels(Buffer.from(r.data, 'base64'));
  return [at(0, 0), at(x, y)];
}
/** The cue in the test pixel (r = cue & 255, g = cue >> 8, b = 255), null when the pixel is not a marker. */
const markerCue = (px: Rgb): number | null => (px.b < 200 ? null : px.r + (px.g << 8));
const dist = (a: Rgb, b: Rgb) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

/** A point near the top of the 16:9 picture: the navy background, away from the lyric. */
async function pictureXY(p: Page): Promise<[number, number]> {
  return p.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pw = Math.min(w, (h * 16) / 9);
    const ph = (pw * 9) / 16;
    return [Math.floor(w / 2), Math.floor((h - ph) / 2 + ph * 0.06)] as [number, number];
  });
}

async function outState(p: Page): Promise<{ shown: number | null; bus: string }> {
  return p.evaluate(() => {
    const s = (
      window as unknown as { __ordo: { state(): { held: { live: string }[]; bus: string } } }
    ).__ordo.state();
    const m = /^sl\|[^|]*\|[^|]*\|(\d+)\|/.exec(s.held[1]?.live ?? '');
    return { shown: m ? Number(m[1]) : null, bus: s.bus };
  });
}

/**
 * Watches one output until stopped. Two series:
 * - cues: a 100 ms timer in the output page records the cue the window holds (the renderer's held live
 *   slide, what `shownSlideCue` reads) and its bus into `window.__chaos`, read out at the end; its first
 *   sample is taken synchronously when the watch starts;
 * - pixels: CDP captures of the test pixel and a picture pixel from Node, as fast as they return.
 * The output is brought to the front (headless Chromium pauses rAF in hidden pages); key presses still
 * reach the operator page.
 */
class ScreenWatch {
  readonly pixels: PixelSample[] = [];
  cues: CueSample[] = [];
  readonly pre: { cue: number; px: Rgb };
  private running = true;
  private loop?: Promise<void>;
  private t0 = 0;
  /** Epoch of the in-page series' origin (before the test injects the fault). */
  private pageT0 = 0;

  private o: Page;
  private xy: [number, number];
  private constructor(o: Page, xy: [number, number], pre: { cue: number; px: Rgb }) {
    this.o = o;
    this.xy = xy;
    this.pre = pre;
  }

  static async start(o: Page): Promise<ScreenWatch> {
    await o.bringToFront();
    await o.waitForTimeout(300);
    const xy = await pictureXY(o);
    const [mark, px] = await twoPixels(o, ...xy);
    const cue = markerCue(mark);
    // The decoder agrees with the single-pixel reader.
    expect(markerCue(await pixel(o, 0, 0))).toBe(cue);
    expect(cue, 'the test pixel shows a cue before the fault').not.toBeNull();
    expect(px.r + px.g + px.b, 'the picture is not black before the fault').toBeGreaterThan(30);
    const w = new ScreenWatch(o, xy, { cue: cue!, px });
    // The in-page sampler: `t` is the page's own clock relative to the first sample (same machine, so it
    // lines up with Node's within a few ms). It returns that epoch, taken before the first sample.
    w.pageT0 = await o.evaluate(() => {
      const w = window as unknown as ChaosWindow & {
        __ordo: { state(): { held: { live: string }[]; bus: string } };
      };
      clearInterval(w.__chaosTimer);
      w.__chaos = [];
      w.__chaosT0 = Date.now();
      const read = () => {
        try {
          const st = w.__ordo.state();
          const m = /^sl\|[^|]*\|[^|]*\|(\d+)\|/.exec(st.held[1]?.live ?? '');
          w.__chaos!.push({ t: Date.now() - w.__chaosT0!, shown: m ? Number(m[1]) : null, bus: st.bus });
        } catch (e) {
          w.__chaos!.push({ t: Date.now() - w.__chaosT0!, shown: null, bus: `error ${e}` });
        }
      };
      read();
      w.__chaosTimer = window.setInterval(read, 100);
      return w.__chaosT0;
    });
    w.t0 = Date.now();
    w.loop = w.run();
    return w;
  }

  private async run(): Promise<void> {
    while (this.running) {
      const t = Date.now() - this.t0;
      try {
        const [mark, px] = await twoPixels(this.o, ...this.xy);
        this.pixels.push({ t, cue: markerCue(mark), px });
      } catch (e) {
        this.pixels.push({ t, cue: null, px: { r: 0, g: 0, b: 0 } });
        console.log(`pixel capture failed at ${t} ms: ${e}`);
      }
      const wait = 100 - (Date.now() - this.t0 - t);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** Stop once the in-page series reaches `endAt` (epoch ms; default now) and read it out. */
  async stop(endAt = Date.now()): Promise<void> {
    const left = endAt + 150 - Date.now();
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    this.running = false;
    await this.loop;
    this.cues = await this.o.evaluate(() => {
      const w = window as unknown as ChaosWindow;
      clearInterval(w.__chaosTimer);
      return w.__chaos ?? [];
    });
  }

  timeline(): string {
    const rows = [
      ...this.cues.map((x) => ({ t: x.t, s: `${x.t}ms held cue=${x.shown} bus=${x.bus}` })),
      ...this.pixels.map((x) => ({
        t: x.t,
        s: `${x.t}ms pixel cue=${x.cue} px=${x.px.r},${x.px.g},${x.px.b}`,
      })),
    ].sort((a, b) => a.t - b.t);
    return rows.map((r) => r.s).join('\n');
  }

  /**
   * Every cue sample (in-page, every 100 ms with no gap over 600 ms, from the fault to the end) holds a
   * cue from `cues` (in order: the screen may only move forward through the list, as a GO pressed during
   * the fault lands) on a bus from `buses`; every pixel capture shows a cue from the list on the test
   * pixel and the pre-fault picture pixel (never black, never a fade).
   */
  assertHeld(label: string, cues: number[], buses: string[]): void {
    const tl = this.timeline();
    const gap = (ts: number[]) => ts.reduce((g, t, i) => (i ? Math.max(g, t - ts[i - 1]!) : g), 0);
    const spanMs = Date.now() - this.t0;
    const cueGap = gap(this.cues.map((c) => c.t));
    const pxGap = gap([0, ...this.pixels.map((p) => p.t)]);
    console.log(
      `${label}: ${this.cues.length} cue samples (max gap ${cueGap} ms) and ${this.pixels.length} pixel captures ` +
        `(max gap ${pxGap} ms) over ${this.cues.at(-1)?.t ?? 0} ms, cues ${cues.join('→')}`,
    );
    expect(this.cues.length, `${label}: too few cue samples\n${tl}`).toBeGreaterThan(3);
    // The first sample was taken before `start()` returned, that is before the fault was injected.
    expect(this.pageT0 + this.cues[0]!.t, `${label}: cue sampling started late`).toBeLessThanOrEqual(this.t0);
    expect(cueGap, `${label}: cue sampling gap\n${tl}`).toBeLessThan(600);
    expect(this.cues.at(-1)!.t, `${label}: cue sampling ended early`).toBeGreaterThan(spanMs - 2000);
    expect(this.pixels.length, `${label}: no pixel capture\n${tl}`).toBeGreaterThan(0);
    const bad: string[] = [];
    let si = 0;
    for (const x of this.cues) {
      const s = x.shown === null ? -1 : cues.indexOf(x.shown, si);
      if (s < 0) bad.push(`${x.t}ms held cue ${x.shown}`);
      else si = s;
      if (!buses.includes(x.bus)) bad.push(`${x.t}ms bus ${x.bus}`);
    }
    let ci = 0;
    for (const x of this.pixels) {
      const c = x.cue === null ? -1 : cues.indexOf(x.cue, ci);
      if (c < 0) bad.push(`${x.t}ms test pixel cue ${x.cue}`);
      else ci = c;
      if (dist(x.px, this.pre.px) > 30 || x.px.r + x.px.g + x.px.b < 30)
        bad.push(`${x.t}ms picture ${x.px.r},${x.px.g},${x.px.b}`);
    }
    expect(
      bad,
      `${label}: the screen must hold cues ${cues.join('→')} on bus ${buses.join('/')}:\n${tl}`,
    ).toEqual([]);
  }
}

/** A live service whose song has a navy picture background (so "black" is never a legitimate frame). */
async function pictureService(a: APIRequestContext, maxHost: number): Promise<void> {
  const fx = fixtures();
  const bg = await uploadMedia(a, fx.png, 'image/png', true);
  const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
  const full = await (await a.get(`presentations/${song.id}`)).json();
  expect(
    (await a.put(`presentations/${song.id}`, { data: { ...full, backgroundMediaId: bg.id } })).ok(),
  ).toBe(true);
  const outs = (await (await a.get('settings/outputs')).json()) as { hostIndex: number; kind: string }[];
  const settings = outs.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex <= maxHost }));
  expect((await a.put('settings/outputs', { data: settings })).ok()).toBe(true);
  const pl = await (
    await a.post('playlists', {
      data: { name: 'Chaos', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
    })
  ).json();
  expect(
    (await a.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } })).ok(),
  ).toBe(true);
}

/**
 * Launch one output from the operator and reload it with the test pixel (`?test=1`) and Canvas 2D (this
 * container's software WebGPU loses its device at start-up). The opener stays, so the window asks the
 * operator for a fresh bus port.
 */
async function launchWatchedOutput(page: Page, context: BrowserContext): Promise<Page> {
  const [o] = await launchOutputs(page, context, 1);
  await o!.goto(`${o!.url()}&test=1&renderer=2d`);
  await waitCacheReady(o!);
  await expect
    .poll(async () => Object.values((await opLive(page)).endpoints).some((e) => e.port && e.ready), {
      timeout: 15_000,
    })
    .toBe(true);
  return o!;
}

/** Wait until `cond` holds, polling every 100 ms (for loops that run beside a ScreenWatch). */
async function until(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond().catch(() => false)) return Date.now();
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

// ---------------------------------------------------------------- specs

test('the core worker dies mid-service: the screen holds, GO works within ~3 s and no command is lost', async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  const PORT = BASE + 1;
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    const a = await hubApi(PORT);
    await pictureService(a, 1);
    await testMode(page);
    await login(page, opUrl(PORT));
    const o = await launchWatchedOutput(page, context);
    await go(page);
    await expectCue([o], 0);
    await expect.poll(() => hubLive(a)).toBe(0);
    const before = await opLive(page);

    // Kill the core and press GO at once: the key lands in the outbox, not in the dead worker. The screen
    // is watched from before the kill.
    const watch = await ScreenWatch.start(o);
    const t0 = Date.now();
    expect(await page.evaluate(() => (window as unknown as Hooks).__ordo.chaos.killWorker('core'))).toBe(
      true,
    );
    await page.keyboard.press('Space');
    let sawRecovering = false;
    let hubAt = 0;
    const doneAt = await until(
      async () => {
        const l = await opLive(page);
        sawRecovering ||= l.recovering;
        if (!hubAt && (await hubLive(a)) === 1) hubAt = Date.now();
        return !!hubAt && !l.recovering && l.generation === (before.generation ?? 0) + 1;
      },
      15_000,
      'the restarted core and the GO at the hub',
    );
    await watch.stop(doneAt + 500);
    const recoveredMs = hubAt - t0;
    console.log(`core killed: the pending GO reached the hub after ${recoveredMs} ms`);
    // The supervisor declares the core dead after 1.5 s without heartbeats (checked every 250 ms); a new
    // core boots, reconnects and re-sends the outbox in a few hundred ms: 1.8 to 1.9 s measured here on a
    // loaded 4-core container, so 3 s leaves over a second of margin.
    expect(recoveredMs).toBeLessThan(3000);
    expect(sawRecovering, 'the UI showed "Recovering" while the core was down').toBe(true);
    // The screen held cue 0 until the GO landed, then cue 1, on the hub bus throughout.
    watch.assertHeld('core kill (hub mode)', [0, 1], ['hub']);
    await expectCue([o], 1);
    await expect(page.locator('[data-recovering]')).toBeHidden({ timeout: 5000 });
    // The worker acknowledges an action only after persisting it, so the outbox empties just after the hub
    // has applied the GO: wait for it rather than reading it at one instant.
    await expect.poll(async () => (await opLive(page)).unacknowledged, { timeout: 3000 }).toBe(0);

    // Exactly once: the hub is at cue 1, not 2 (the re-sent action kept its id).
    await page.waitForTimeout(1000);
    expect(await hubLive(a)).toBe(1);

    // GO keeps working through the new core, and the restarted core re-took a port to the output.
    await go(page);
    await expectCue([o], 2);
    await expect.poll(() => hubLive(a)).toBe(2);
    await expect
      .poll(async () => Object.values((await opLive(page)).endpoints).every((e) => e.port), {
        timeout: 10_000,
      })
      .toBe(true);
  } finally {
    hub.kill();
  }
});

test('a long main-thread block delays neither a Stream Deck GO nor the fallback heartbeat', async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  const PORT = BASE + 2;
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    const a = await hubApi(PORT);
    await liveService(a, 1);
    await testMode(page);
    await login(page, opUrl(PORT));
    const outs = await launchOutputs(page, context, 1);
    await go(page);
    await expectCue(outs, 0);
    await expect.poll(() => hubLive(a)).toBe(0);

    // A GO from the surfaces path (dispatched inside the core worker 100 ms from now) while the main
    // thread is blocked for 2.5 s: the hub must see it long before the block ends.
    await page.bringToFront();
    const t0 = Date.now();
    const blocked = page.evaluate(() => {
      const o = (window as unknown as Hooks).__ordo;
      o.chaos.workerDispatch({ id: 'next' }, 100);
      o.chaos.blockMain(2500);
      return Date.now();
    });
    await expect.poll(() => hubLive(a), { timeout: 5000, intervals: [50] }).toBe(1);
    const seenAt = Date.now();
    const unblockedAt = await blocked;
    console.log(`GO during a 2.5 s main-thread block reached the hub after ${seenAt - t0} ms`);
    expect(seenAt).toBeLessThan(unblockedAt);
    expect(seenAt - t0).toBeLessThan(2000);
    // No "Recovering" flash after the block: the core never stopped (review item 29).
    const flashes: number[] = [];
    const end = Date.now() + 1500;
    while (Date.now() < end) {
      if ((await opLive(page)).recovering) flashes.push(Date.now() - unblockedAt);
      await page.waitForTimeout(50);
    }
    expect(flashes, '"Recovering" shown after a main-thread block with a healthy core').toEqual([]);
    await expectCue(outs, 1);
    await expect.poll(async () => (await opLive(page)).mainThreadStallMaxMs ?? 0).toBeGreaterThan(2000);

    // Hub gone: the operator becomes the authority over the port bus.
    hub.kill();
    await page.bringToFront();
    await expect(page.locator('body')).toContainText('running from this PC', { timeout: 25_000 });
    for (const p of outs) await expect.poll(() => busOf(p), { timeout: 15_000 }).toBe('fallback');

    // Block the operator's main thread for longer than the outputs' 5 s silence limit: the heartbeat comes
    // from the core worker over the port, so the outputs stay on the fallback bus.
    const longBlock = page.evaluate(() => (window as unknown as Hooks).__ordo.chaos.blockMain(7000));
    const buses: string[] = [];
    const deadline = Date.now() + 6500;
    while (Date.now() < deadline) {
      for (const p of outs) buses.push(await busOf(p));
      await new Promise((r) => setTimeout(r, 500));
    }
    await longBlock;
    expect(buses.every((b) => b === 'fallback')).toBe(true);

    // And a GO after the block still works through the fallback bus.
    await page.waitForTimeout(300);
    await go(page);
    await expectCue(outs, 2);
  } finally {
    hub.kill();
  }
});

test('ports are offered once in hub mode; with the hub dead GO reaches the outputs port to port', async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  const PORT = BASE + 3;
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    const a = await hubApi(PORT);
    await liveService(a, 2);
    await testMode(page);
    await login(page, opUrl(PORT));
    const outs = await launchOutputs(page, context, 2);
    await go(page);
    await expectCue(outs, 0);

    // Hub mode for a minute: a proven port that is merely quiet is not re-offered (review item 16). The
    // initial offers are the launch's own (one, then retries at 1.5, 4 and 8 s in case it reached
    // about:blank) and one when the window's hub connection first comes up; after those, nothing.
    await expect
      .poll(async () => Object.values((await opLive(page)).endpoints).every((e) => e.port && e.ready), {
        timeout: 15_000,
      })
      .toBe(true);
    await page.waitForTimeout(10_000);
    const settled = (await opLive(page)).offers;
    await page.waitForTimeout(60_000);
    const later = (await opLive(page)).offers;
    console.log(`port offers per window: ${JSON.stringify(settled)} → after 60 s ${JSON.stringify(later)}`);
    expect(Object.keys(later)).toHaveLength(2);
    for (const [id, n] of Object.entries(later)) {
      expect(n, `offers to ${id} in total`).toBeLessThanOrEqual(5);
      expect(n, `re-offers to ${id} during 60 quiet seconds in hub mode`).toBe(settled[id]);
    }

    hub.kill();
    await page.bringToFront();
    await expect(page.locator('body')).toContainText('running from this PC', { timeout: 25_000 });
    await page.waitForTimeout(1000);
    await go(page);
    await expectCue(outs, 1);

    // The operator's core holds a direct port to every output and uses it.
    const eps = (await opLive(page)).endpoints;
    expect(Object.keys(eps)).toHaveLength(2);
    // A port is proven once the window answers on it; poll rather than read it at one instant.
    await expect
      .poll(
        async () =>
          Object.values((await opLive(page)).endpoints).every(
            (e) =>
              (e as { active?: string; ready?: boolean }).active === 'port' &&
              (e as { ready?: boolean }).ready,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    for (const e of Object.values((await opLive(page)).endpoints))
      expect(e).toMatchObject({ active: 'port', port: true, ready: true });
    // The output side agrees, when it reports its carrier.
    for (const p of outs) {
      const t = await outputTransport(p);
      if (t !== undefined) expect(t).toBe('port');
    }
  } finally {
    hub.kill();
  }
});

test('the core dies while the operator is the fallback authority: it resumes the authority and the screen holds', async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  const PORT = BASE + 4;
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    const a = await hubApi(PORT);
    await pictureService(a, 1);
    await testMode(page);
    await login(page, opUrl(PORT));
    const o = await launchWatchedOutput(page, context);
    await go(page);
    await expectCue([o], 0);

    hub.kill();
    await page.bringToFront();
    await expect(page.locator('body')).toContainText('running from this PC', { timeout: 25_000 });
    await expect.poll(() => busOf(o), { timeout: 15_000 }).toBe('fallback');
    const before = await opLive(page);
    expect(before.authority).toBe('fallback');

    // Kill the core and press GO: the restarted core takes the authority back at once (no second grace)
    // and applies the GO exactly once.
    const watch = await ScreenWatch.start(o);
    const t0 = Date.now();
    expect(await page.evaluate(() => (window as unknown as Hooks).__ordo.chaos.killWorker('core'))).toBe(
      true,
    );
    await page.keyboard.press('Space');
    const doneAt = await until(
      async () => {
        const l = await opLive(page);
        return (
          l.generation === (before.generation ?? 0) + 1 &&
          !l.recovering &&
          l.authority === 'fallback' &&
          (await outState(o)).shown === 1
        );
      },
      15_000,
      'the restarted core as the authority and the GO on screen',
    );
    console.log(`core killed in fallback: authority resumed and the GO shown after ${doneAt - t0} ms`);
    await watch.stop(doneAt + 500);
    watch.assertHeld('core kill (fallback authority)', [0, 1], ['fallback']);
    expect(doneAt - t0).toBeLessThan(5000);

    // Exactly once, and GO keeps working.
    await page.waitForTimeout(1000);
    expect((await outState(o)).shown).toBe(1);
    await go(page);
    await expectCue([o], 2);
    expect((await opLive(page)).authority).toBe('fallback');
  } finally {
    hub.kill();
  }
});

test('the core dies while handing the service back to the hub: the hub ends up with the operator state', async ({
  context,
  page,
}) => {
  test.setTimeout(150_000);
  const PORT = BASE + 5;
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    const a = await hubApi(PORT);
    await pictureService(a, 1);
    await testMode(page);
    await login(page, opUrl(PORT));
    const o = await launchWatchedOutput(page, context);
    await go(page);
    await expectCue([o], 0);

    hub.kill();
    await page.bringToFront();
    await expect(page.locator('body')).toContainText('running from this PC', { timeout: 25_000 });
    await expect.poll(() => busOf(o), { timeout: 15_000 }).toBe('fallback');
    await go(page);
    await expectCue([o], 1);
    const before = await opLive(page);

    const watch = await ScreenWatch.start(o);
    await hub.start();
    // Kill the core the moment it starts the hand-back (hub connected while still the authority).
    const killer = page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const o = (window as unknown as Hooks).__ordo;
          const t0 = performance.now();
          const id = setInterval(() => {
            const l = o.live();
            if (l.authority === 'fallback' && (l.reconcile || l.hubConnected)) {
              clearInterval(id);
              o.chaos.killWorker('core');
              resolve(l.reconcile ?? 'connected');
            } else if (l.authority !== 'fallback' || performance.now() - t0 > 30_000) {
              clearInterval(id);
              resolve(`missed (authority ${l.authority})`);
            }
          }, 2);
        }),
    );
    await page.evaluate(() => (window as unknown as Hooks).__ordo.chaos.kickHub());
    const phase = await killer;
    console.log(`core killed during the hand-back, phase: ${phase}`);
    expect(phase).not.toMatch(/missed/);
    const a2 = await hubApi(PORT);
    const doneAt = await until(
      async () => {
        const l = await opLive(page);
        return (
          l.generation === (before.generation ?? 0) + 1 &&
          !l.recovering &&
          l.authority === 'hub' &&
          l.hubConnected &&
          (await hubLive(a2)) === 1 &&
          (await outState(o)).bus === 'hub'
        );
      },
      30_000,
      'the hand-back by the restarted core',
    );
    await watch.stop(doneAt + 500);
    watch.assertHeld('core kill during the hand-back', [1], ['fallback', 'hub']);

    // Exactly once on the hub, and GO goes through the hub again.
    expect(await hubLive(a2)).toBe(1);
    await go(page);
    await expect.poll(() => hubLive(a2)).toBe(2);
    await expectCue([o], 2);
  } finally {
    hub.kill();
  }
});

test('an expired session is not a hub loss: the outputs stay on the hub and the operator signs in again', async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  const PORT = BASE + 6;
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    const a = await hubApi(PORT);
    await pictureService(a, 1);
    await testMode(page);
    await login(page, opUrl(PORT));
    const o = await launchWatchedOutput(page, context);
    await go(page);
    await expectCue([o], 0);
    await expect.poll(() => hubLive(a)).toBe(0);

    // The session is gone (cookies cleared; the outputs authenticate with their tokens) and the hub
    // restarts, so the operator's socket must sign in again and is refused.
    await context.clearCookies();
    const watch = await ScreenWatch.start(o);
    hub.kill();
    await hub.start();
    const upAt = Date.now();
    await page.evaluate(() => (window as unknown as Hooks).__ordo.chaos.kickHub());
    await expect(page.locator('[data-session-expired]')).toBeVisible({ timeout: 10_000 });
    console.log(`sign-in view shown ${Date.now() - upAt} ms after the hub came back`);

    // Well past the 5 s fallback grace: the operator never becomes the authority, never says the hub is
    // lost, and does not toast every reconnect attempt.
    const authorities = new Set<string>();
    while (Date.now() - upAt < 9000) {
      const l = await opLive(page);
      authorities.add(l.authority);
      expect(l.hubRefused).toBe('unauthorized');
      await page.waitForTimeout(250);
    }
    await watch.stop();
    expect([...authorities]).toEqual(['hub']);
    await expect(page.locator('body')).not.toContainText('running from this PC');
    await expect(page.locator('.toast', { hasText: 'Hub closed the connection' })).toHaveCount(0);
    // 'none' while the hub restarts (the output holds its frame, off any bus); never 'fallback'.
    watch.assertHeld('session expiry', [0], ['hub', 'none']);
    expect(await hubLive(a)).toBe(0);

    // Sign in over the running operator: it rejoins the hub as its client and GO works again.
    const overlay = page.locator('[data-session-expired]');
    await overlay.locator('input.pin').fill('246810');
    await overlay.getByRole('button', { name: 'OK' }).click();
    await expect(overlay).toBeHidden({ timeout: 10_000 });
    await expect.poll(async () => (await opLive(page)).hubConnected, { timeout: 10_000 }).toBe(true);
    const l = await opLive(page);
    expect(l.authority).toBe('hub');
    expect(l.hubRefused).toBeUndefined();
    expect(await busOf(o)).toBe('hub');
    const a2 = await hubApi(PORT);
    await go(page);
    await expect.poll(() => hubLive(a2)).toBe(1);
    await expectCue([o], 1);
  } finally {
    hub.kill();
  }
});

test('a session refusal while the operator is the fallback authority: the keys keep driving the outputs; signing in hands back', async ({
  context,
  page,
}) => {
  test.setTimeout(150_000);
  const PORT = BASE + 7;
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    const a = await hubApi(PORT);
    await pictureService(a, 1);
    await testMode(page);
    await login(page, opUrl(PORT));
    const o = await launchWatchedOutput(page, context);
    await go(page);
    await expectCue([o], 0);
    await expect.poll(() => hubLive(a)).toBe(0);

    // The hub dies and this PC takes over.
    hub.kill();
    await page.bringToFront();
    await expect(page.locator('body')).toContainText('running from this PC', { timeout: 25_000 });
    await expect.poll(() => busOf(o), { timeout: 15_000 }).toBe('fallback');
    expect((await opLive(page)).authority).toBe('fallback');

    // The hub comes back, but this operator's session is gone meanwhile: the socket is refused. The
    // operator stays the authority (the hub's state is older) and the outputs stay on the fallback bus.
    await context.clearCookies();
    const watch = await ScreenWatch.start(o);
    await hub.start();
    const upAt = Date.now();
    await page.evaluate(() => (window as unknown as Hooks).__ordo.chaos.kickHub());
    await expect.poll(async () => (await opLive(page)).hubRefused, { timeout: 15_000 }).toBe('unauthorized');
    const overlay = page.locator('[data-session-expired]');
    await expect(overlay).toBeVisible({ timeout: 10_000 });
    console.log(`refused while fallback: sign-in card shown ${Date.now() - upAt} ms after the hub came back`);
    // The UI says where the service runs, not "outputs stay on the hub" (review 3, O1).
    await expect(overlay).toHaveAttribute('data-session-expired-mode', 'fallback');
    await expect(page.locator('.topbar')).toContainText(
      'Running from this PC — session ended; sign in to hand back to the hub',
    );
    await expect(overlay).toContainText('running from this PC');
    await expect(page.locator('body')).not.toContainText('stay on the hub');
    await expect(page.locator('body')).not.toContainText('from the hub.');

    // GO from the keyboard, before signing in, reaches the outputs over the fallback bus; the hub stays
    // at its older state and the operator never drops the authority.
    await page.bringToFront();
    await page.keyboard.press('Space');
    await expect.poll(async () => (await outState(o)).shown, { timeout: 5000 }).toBe(1);
    expect(await busOf(o)).toBe('fallback');
    const authorities = new Set<string>();
    const until2 = Date.now() + 3000;
    while (Date.now() < until2) {
      const l = await opLive(page);
      authorities.add(l.authority);
      expect(l.hubRefused).toBe('unauthorized');
      await page.waitForTimeout(250);
    }
    expect([...authorities]).toEqual(['fallback']);
    expect(await hubLive(a)).toBe(0);
    await expect(page.locator('.toast', { hasText: 'Hub closed the connection' })).toHaveCount(0);

    // Sign in between songs: the hub accepts the socket, the operator hands its state over and the outputs
    // go back to the hub bus; the screen never moved back to the hub's older cue.
    await overlay.locator('input.pin').fill('246810');
    await overlay.getByRole('button', { name: 'OK' }).click();
    await expect(overlay).toBeHidden({ timeout: 10_000 });
    const a2 = await hubApi(PORT);
    const doneAt = await until(
      async () => {
        const l = await opLive(page);
        return (
          l.authority === 'hub' &&
          l.hubConnected &&
          !l.hubRefused &&
          (await hubLive(a2)) === 1 &&
          (await outState(o)).bus === 'hub'
        );
      },
      30_000,
      'the hand-back after signing in',
    );
    await watch.stop(doneAt + 500);
    watch.assertHeld('session refusal while fallback', [0, 1], ['fallback', 'hub']);
    await expect(page.locator('.topbar')).not.toContainText('session ended');

    // Exactly once on the hub, and GO goes through the hub again.
    expect(await hubLive(a2)).toBe(1);
    await go(page);
    await expect.poll(() => hubLive(a2)).toBe(2);
    await expectCue([o], 2);
  } finally {
    hub.kill();
  }
});
