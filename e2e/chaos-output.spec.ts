import { type Page, expect, test } from '@playwright/test';
import { SONG, fixtures, testPixelCue, uploadMedia, waitCacheReady } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { expectCue, go, hubApi, launchOutputs, login } from './linkhelpers.ts';
import { PNG } from './png.ts';

const PORT = 8500;
const op = `http://op.localhost:${PORT}`;

type Ordo = {
  __ordo: {
    state(): Record<string, unknown> & {
      keys: { live: Record<string, string> };
      workers: { name: string; restarts: number; generation: number }[];
      hold: boolean;
      seq: number;
      live?: number;
      bus: string;
      quarantined: string[];
      cacheRepairs: number;
      held: { live: string }[];
    };
    telemetry(): Record<string, unknown> & { resyncs: number; cacheRepairs?: number; workers?: unknown[] };
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

/** A pixel near the top of the 16:9 picture (the navy background, away from the lyric), never black. */
async function centre(p: Page): Promise<{ r: number; g: number; b: number }> {
  await p.bringToFront();
  const [x, y] = await p.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pw = Math.min(w, (h * 16) / 9);
    const ph = (pw * 9) / 16;
    return [Math.floor(w / 2), Math.floor((h - ph) / 2 + ph * 0.06)];
  });
  const buf = await p.screenshot({ clip: { x: x!, y: y!, width: 1, height: 1 } });
  return PNG.firstPixel(buf);
}

/** Sample the screen while `ms` pass: it must never go black (design/25: the hold covers rebuilds). */
async function neverBlack(p: Page, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const px = await centre(p);
    expect(px.r + px.g + px.b, `screen went black at ${new Date().toISOString()}`).toBeGreaterThan(30);
    await p.waitForTimeout(150);
  }
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

/**
 * Design/25 chaos for the output window: workers are killed, a cached file is corrupted, a malformed delta
 * arrives; the audience screen keeps its picture, the window recovers on its own, and GO keeps working.
 */
test('the output survives killed workers, a corrupt cache file and a malformed delta', async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    const a = await hubApi(PORT);
    const fx = fixtures();
    const bg = await uploadMedia(a, fx.png, 'image/png', true);
    const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
    const full = await (await a.get(`presentations/${song.id}`)).json();
    expect((await a.put(`presentations/${song.id}`, { data: { ...full, backgroundMediaId: bg.id } })).ok()).toBe(
      true,
    );
    const outs = (await (await a.get('settings/outputs')).json()) as { hostIndex: number; kind: string }[];
    const settings = outs.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex <= 1 }));
    expect((await a.put('settings/outputs', { data: settings })).ok()).toBe(true);
    const pl = await (
      await a.post('playlists', {
        data: { name: 'Chaos', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
      })
    ).json();
    expect(
      (await a.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } })).ok(),
    ).toBe(true);

    await login(page, op);
    const [out] = await launchOutputs(page, context, 1);
    const o = out!;
    // The chaos hooks exist only with ?test=1: reload the launched window with it (the opener stays).
    // Canvas 2D as in the other specs: this container's software WebGPU loses its device at start-up.
    await o.goto(`${o.url()}&test=1&renderer=2d`);
    await waitCacheReady(o);
    await go(page);
    await expectCue([o], 0);
    await expect.poll(async () => (await st(o)).keys.live.background ?? '', { timeout: 15_000 }).toMatch(/^bg\|/);
    const bgHash = (await st(o)).keys.live.background!.split('|')[2]!;
    const bgBytes = await opfsSize(o, bgHash);
    expect(bgBytes).toBeGreaterThan(0);

    await test.step('(a) a killed link worker restarts; the screen keeps its frame; the next GO flips', async () => {
      await o.evaluate(() => (window as unknown as Ordo).__ordo.chaos.killWorker('link'));
      await neverBlack(o, 1500);
      expect(await testPixelCue(o)).toBe(0);
      await expect.poll(() => restarts(o, 'link'), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      await expect.poll(async () => (await st(o)).bus, { timeout: 15_000 }).toBe('hub');
      await go(page);
      await expectCue([o], 1);
      await expect.poll(() => testPixelCue(o), { timeout: 10_000 }).toBe(1);
    });

    await test.step('(a) a killed render worker is rebuilt under the hold canvas', async () => {
      await o.evaluate(() => (window as unknown as Ordo).__ordo.chaos.killWorker('render'));
      await neverBlack(o, 2000);
      await expect.poll(() => restarts(o, 'render'), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      await expect.poll(async () => (await st(o)).hold, { timeout: 15_000 }).toBe(false);
      await expectCue([o], 1);
      await neverBlack(o, 500);
      await page.bringToFront();
      await page.keyboard.press('ArrowLeft');
      await expectCue([o], 0);
      await expect.poll(() => testPixelCue(o), { timeout: 10_000 }).toBe(0);
    });

    await test.step('(a) a killed asset worker restarts and the next GO is prepared by the new one', async () => {
      await o.evaluate(() => (window as unknown as Ordo).__ordo.chaos.killWorker('asset'));
      await expect.poll(() => restarts(o, 'asset'), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
      await go(page);
      await expectCue([o], 1);
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
      await o.evaluate(() => (window as unknown as Ordo).__ordo.chaos.killWorker('asset'));
      await expect.poll(() => restarts(o, 'asset'), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
      await o.evaluate(() => (window as unknown as Ordo).__ordo.chaos.killWorker('render'));
      await neverBlack(o, 1500);
      await expect.poll(() => restarts(o, 'render'), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
      await expect.poll(async () => (await st(o)).cacheRepairs, { timeout: 20_000 }).toBeGreaterThan(before);
      await expect.poll(() => opfsSize(o, bgHash), { timeout: 20_000 }).toBe(bgBytes);
      await expect
        .poll(async () => (await st(o)).held[0]?.live ?? '', { timeout: 30_000 })
        .toBe(`bg|${bg.id}|${bgHash}`);
      expect((await st(o)).quarantined).toEqual([]);
      await expect.poll(async () => (await st(o)).hold, { timeout: 15_000 }).toBe(false);
      await expectCue([o], 1);
    });

    await test.step('(c) a malformed delta is rejected with a resync; the state is intact', async () => {
      const s0 = await st(o);
      const r0 = (await o.evaluate(() => (window as unknown as Ordo).__ordo.telemetry())).resyncs;
      await o.evaluate((seq) => {
        const c = (window as unknown as Ordo).__ordo.chaos;
        c.injectDelta({ t: 'live.delta', v: 1, seq: seq + 1, fromSeq: seq, event: { k: 'go', cueIndex: 'x' } });
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
      await expectCue([o], 1);
      await go(page);
      await expectCue([o], 2);
      await expect.poll(() => testPixelCue(o), { timeout: 10_000 }).toBe(2);
    });
  } finally {
    hub.kill();
  }
});
