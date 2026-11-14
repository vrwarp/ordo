import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { APP_VERSION } from '../packages/protocol/src/index.ts';
import { expect, type Page, test } from '@playwright/test';
import { fixtures, SONG, uploadMedia, waitCacheReady } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { expectCue, go, hubApi, hubLive, launchOutputs, login } from './linkhelpers.ts';
import { PNG } from './png.ts';
import { portOf } from './ports.ts';

/**
 * Chaos for the two-process hub (design/25 "Hub", phase D): kill the library process mid-service, kill the
 * live process, freeze it (SIGSTOP: the stall watchdog), corrupt the live snapshot on disk, flood a
 * WebSocket, and crash the library past its restart budget. Through every outage the audience screen is
 * sampled about every 100 ms, from the fault until recovery + 500 ms: it must keep showing the held cue
 * and its picture (a pixel of the background compared with the value before the fault), never black.
 * Its hub's port: e2e/ports.ts row 'chaos-hub'.
 */
const PORT = portOf('chaos-hub');
const op = `http://op.localhost:${PORT}`;
// Native modules and ws are dependencies of the hub; resolve them from there.
const hubRequire = createRequire(resolve('apps/hub/package.json'));
type Socket = {
  on(ev: 'open', fn: () => void): void;
  on(ev: 'close', fn: (code: number) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  on(ev: 'message', fn: (data: Buffer) => void): void;
  send(data: string): void;
  terminate(): void;
};
type WsCtor = new (url: string, opts?: { headers?: Record<string, string> }) => Socket;

/**
 * Is an output connected to the live process that answers now, and sending it health? Asked as an
 * operator over a fresh socket (the hub's health summary): true only once the output's link talks to the
 * restarted process, not merely because its old socket has not noticed the death yet.
 */
function outputOnHub(WS: WsCtor, port: number, cookie: string): Promise<boolean> {
  return new Promise((done) => {
    let ws: Socket;
    try {
      ws = new WS(`ws://localhost:${port}/ws`, { headers: { cookie } });
    } catch {
      done(false);
      return;
    }
    const t = setTimeout(() => finish(false), 2500);
    const finish = (v: boolean) => {
      clearTimeout(t);
      ws.terminate();
      done(v);
    };
    ws.on('error', () => finish(false));
    ws.on('close', () => finish(false));
    ws.on('open', () =>
      ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'operate', appVersion: APP_VERSION })),
    );
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as { t: string; outputs?: Record<string, { connected: boolean }> };
      if (m.t === 'health.summary' && Object.values(m.outputs ?? {}).some((o) => o.connected)) {
        finish(true);
      }
    });
  });
}
type Db = {
  prepare(sql: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown };
  close(): void;
};
type Px = { r: number; g: number; b: number };

/** A pixel near the top of the 16:9 picture (the look's background, away from the lyric). */
async function backgroundPixel(p: Page): Promise<Px> {
  const [x, y] = await p.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pw = Math.min(w, (h * 16) / 9);
    const ph = (pw * 9) / 16;
    return [Math.floor(w / 2), Math.floor((h - ph) / 2 + ph * 0.06)];
  });
  return PNG.firstPixel(await p.screenshot({ clip: { x: x!, y: y!, width: 4, height: 4 } }));
}

const dist = (a: Px, b: Px) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

/** Wait until the output's renderer is up and has not been rebuilt for 2 s (its diagnostics log). */
async function rendererSettled(out: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const log = await out.evaluate(
          () => (window as unknown as { __ordo: { state(): { log?: string[] } } }).__ordo.state().log ?? [],
        );
        const events = log.filter((l) => /renderer (ready|restored)|device lost|rebuilding/.test(l));
        const last = events[events.length - 1];
        if (!last || !/renderer (ready|restored)/.test(last)) return false;
        const [h, m, sec] = last.slice(0, 12).split(':').map(Number);
        const now = new Date();
        const at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h!, m!, sec!);
        return Date.now() - at > 2000;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * Watch the audience screen through a fault. Call before injecting the fault, then `until(recovered)`.
 *
 * - The held cue is sampled every 100 ms inside the output page (a timer reading the renderer's held live
 *   slide, the same value `shownSlideCue` reads), so its cadence does not depend on the test runner.
 * - The picture is sampled from Node as fast as screenshots allow (a 1-pixel clip of the background,
 *   tens to hundreds of ms each on a loaded machine) and compared with `ref`, the value before the fault.
 * - Both run until `recovered()` has been true for 500 ms. Every cue sample must be one of `allowed`, moving
 *   only forward (a GO sent during the outage); every pixel must be close to `ref`, never black; neither
 *   sampler may leave a gap. A bad pixel does not stop the sampling: every sample is recorded, the first
 *   bad one is diagnosed (screenshot, output log), and the summary reports the longest run of bad samples
 *   before the per-sample assertions fail.
 */
async function watchScreen(out: Page, label: string, ref: Px, allowed: number[]) {
  await out.bringToFront();
  await out.evaluate(() => {
    const w = window as unknown as {
      __chaos?: { t: number; cue: number | null }[];
      __chaosTimer?: number;
      __ordo: { state(): { held: { live: string }[] } };
    };
    clearInterval(w.__chaosTimer);
    w.__chaos = [];
    const read = () => {
      const key = w.__ordo.state().held[1]?.live ?? '';
      const m = /^sl\|[^|]*\|[^|]*\|(\d+)\|/.exec(key);
      w.__chaos!.push({ t: Date.now(), cue: m ? Number(m[1]) : null });
    };
    read();
    w.__chaosTimer = window.setInterval(read, 100);
  });
  const t0 = Date.now();
  const navs: string[] = [];
  out.on('framenavigated', (f) => {
    if (f === out.mainFrame()) navs.push(`+${Date.now() - t0} ms ${f.url()}`);
  });
  const pixels: { t: number; px: Px }[] = [];
  let stopPixels = false;
  let diagnosed = false;
  const pixelLoop = (async () => {
    while (!stopPixels) {
      const at = Date.now();
      const px = await backgroundPixel(out).catch(() => undefined);
      if (!px) {
        // A screenshot can fail while the page is busy; the gap check below bounds how often.
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      pixels.push({ t: Date.now(), px });
      if (dist(px, ref) >= 40 && !diagnosed) {
        diagnosed = true;
        const file = test.info().outputPath(`${label.replace(/\W+/g, '-')}-bad-pixel.png`);
        await out
          .screenshot({ path: file, clip: { x: 0, y: 0, width: 1280, height: 200 } })
          .catch(() => undefined);
        console.log(`${label}: navigations ${navs.join(', ')}; url ${out.url()}`);
        const st = await out
          .evaluate(
            () => (window as unknown as { __ordo: { state(): { log?: string[] } } }).__ordo.state().log,
          )
          .catch(() => undefined);
        console.log(`${label}: output log at the bad sample:\n  ${(st ?? []).slice(-12).join('\n  ')}`);
        console.log(`${label} at +${at - t0} ms: bad pixel ${JSON.stringify(px)}; screen saved to ${file}`);
      }
      const spent = Date.now() - at;
      if (spent < 100) await new Promise((r) => setTimeout(r, 100 - spent));
    }
  })();

  return {
    async until(recovered: () => Promise<boolean>, maxMs = 30_000): Promise<void> {
      let recoveredAt: number | undefined;
      try {
        while (recoveredAt === undefined) {
          expect(Date.now() - t0, `${label}: not recovered within ${maxMs} ms`).toBeLessThan(maxMs);
          if (await recovered().catch(() => false)) recoveredAt = Date.now();
          else await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        stopPixels = true;
        await pixelLoop;
      }
      const cues = await out.evaluate(() => {
        const w = window as unknown as {
          __chaos: { t: number; cue: number | null }[];
          __chaosTimer?: number;
        };
        clearInterval(w.__chaosTimer);
        return w.__chaos;
      });
      const end = recoveredAt + 500;
      const gap = (ts: number[]) => ts.reduce((g, t, i) => (i ? Math.max(g, t - ts[i - 1]!) : g), 0);
      // The longest run of consecutive bad pixel samples (off the picture or black), as a duration from
      // the sample before the run to its last sample: how long the audience would have seen it.
      const isBad = (p: Px) => dist(p, ref) >= 40 || p.r + p.g + p.b <= 30;
      let badSamples = 0;
      let longestBadMs = 0;
      let runStart: number | undefined;
      for (let i = 0; i < pixels.length; i++) {
        const p = pixels[i]!;
        if (isBad(p.px)) {
          badSamples++;
          runStart ??= i ? pixels[i - 1]!.t : t0;
          longestBadMs = Math.max(longestBadMs, p.t - runStart);
        } else runStart = undefined;
      }
      console.log(
        `${label}: recovered after ${recoveredAt - t0} ms; ${cues.length} cue samples (max gap ${gap(cues.map((c) => c.t))} ms), ` +
          `${pixels.length} pixel samples (max gap ${gap(pixels.map((p) => p.t))} ms); ` +
          (badSamples
            ? `${badSamples} bad pixel sample(s), longest bad run ${longestBadMs} ms`
            : 'no bad pixel sample'),
      );
      // Cues: through the whole window, every ~100 ms.
      expect(cues[0]!.t, `${label}: cue sampling started late`).toBeLessThanOrEqual(t0);
      expect(cues[cues.length - 1]!.t, `${label}: cue sampling ended early`).toBeGreaterThanOrEqual(
        end - 150,
      );
      expect(gap(cues.map((c) => c.t)), `${label}: cue sampling gap`).toBeLessThan(400);
      let last = 0;
      for (const c of cues) {
        const tag = `${label} at +${c.t - t0} ms`;
        expect(c.cue, `${tag}: no held cue`).not.toBeNull();
        expect(allowed, `${tag}: cue ${c.cue}`).toContain(c.cue);
        const i = allowed.indexOf(c.cue!);
        expect(i, `${tag}: cue went back`).toBeGreaterThanOrEqual(last);
        last = i;
      }
      // Pixels: never off the picture, never black, and no long blind spot.
      for (const p of pixels) {
        const tag = `${label} at +${p.t - t0} ms`;
        expect(p.px.r + p.px.g + p.px.b, `${tag}: screen black`).toBeGreaterThan(30);
        expect(
          dist(p.px, ref),
          `${tag}: picture changed ${JSON.stringify(p.px)} vs ${JSON.stringify(ref)}`,
        ).toBeLessThan(40);
      }
      expect(pixels[pixels.length - 1]!.t, `${label}: pixel sampling ended early`).toBeGreaterThanOrEqual(
        end - 1500,
      );
      expect(gap([t0, ...pixels.map((p) => p.t)]), `${label}: pixel sampling gap`).toBeLessThan(1500);
    },
  };
}

// Trace screenshots and DOM snapshots would slow the 100 ms sampling down several times over.
test.use({ trace: { mode: 'retain-on-failure', screenshots: false, snapshots: false } });

test('the screen holds through library and live process crashes, a stall, a corrupt snapshot, a flooding socket and an exhausted restart budget', async ({
  context,
  page,
}) => {
  test.setTimeout(360_000);
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    let a = await hubApi(PORT);
    // The song on a navy background: the sampled pixel is the picture, not an empty (black) screen.
    const bg = await uploadMedia(a, fixtures().png, 'image/png', true);
    const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
    const full = await (await a.get(`presentations/${song.id}`)).json();
    expect(
      (await a.put(`presentations/${song.id}`, { data: { ...full, backgroundMediaId: bg.id } })).ok(),
    ).toBe(true);
    const outsAll = (await (await a.get('settings/outputs')).json()) as {
      kind: string;
      hostIndex: number;
    }[];
    expect(
      (
        await a.put('settings/outputs', {
          data: outsAll.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex <= 1 })),
        })
      ).ok(),
    ).toBe(true);
    const pl = await (
      await a.post('playlists', {
        data: { name: 'Chaos', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
      })
    ).json();
    expect(
      (await a.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } })).ok(),
    ).toBe(true);
    expect(hub.children().library.state).toBe('up');
    await login(page, op);
    const [out] = await launchOutputs(page, context, 1);
    await go(page);
    await expectCue([out!], 0);
    const health = async () => {
      const r = await fetch(`http://localhost:${PORT}/api/v1/health`).catch(() => undefined);
      return r?.ok ? ((await r.json()) as { library?: string; mode?: string }) : undefined;
    };
    const goTo = async (cueIndex: number) =>
      expect((await a.post('live/events', { data: { k: 'go', cueIndex, at: Date.now() } })).ok()).toBe(true);
    await goTo(1);
    await expectCue([out!], 1);
    await out!.bringToFront();
    // A freshly launched output may still be in a device-loss rebuild (SwiftShader loses the WebGPU device at
    // startup here), covered by an opaque black hold until a good frame exists. Take the reference only once
    // the renderer has settled and the hold is down.
    await rendererSettled(out!);
    await expect
      .poll(
        async () => {
          const held = await out!.evaluate(
            () =>
              (window as unknown as { __ordo: { state(): { hold?: boolean } } }).__ordo.state().hold ?? false,
          );
          const p = await backgroundPixel(out!);
          return !held && p.r + p.g + p.b > 30;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const ref = await backgroundPixel(out!);
    expect(ref.r + ref.g + ref.b).toBeGreaterThan(30);
    const WS = hubRequire('ws') as WsCtor;
    const cookie = (await a.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await expect.poll(async () => outputOnHub(WS, PORT, cookie), { timeout: 15_000 }).toBe(true);

    // (a) Kill the library process: the live API keeps answering (a GO during the outage reaches the
    // screen), the screen holds throughout, and the library is back within a few seconds.
    const libWatch = await watchScreen(out!, 'library killed', ref, [1, 2]);
    const killedAt = Date.now();
    hub.killChild('library');
    await goTo(2);
    let backMs = 0;
    await libWatch.until(async () => {
      const ok =
        (await a.get('playlists').catch(() => undefined))?.status() === 200 &&
        hub.children().library.restarts === 1;
      if (ok && !backMs) backMs = Date.now() - killedAt;
      return ok;
    });
    console.log(`library process answering again ${backMs} ms after it was killed`);
    expect(backMs).toBeLessThan(5000);
    await expectCue([out!], 2);
    // A reloaded output refills its cache and shows the live cue.
    await out!.reload();
    await waitCacheReady(out!);
    await expectCue([out!], 2);
    // The next fault must meet a settled renderer (a WebGPU device lost and rebuilt after a reload is a
    // different fault, not this spec's).
    await rendererSettled(out!);
    await goTo(0);
    await expectCue([out!], 0);
    // (b) Kill the live process: the output holds its cue through the restart and is back on the hub; the
    // restarted live process resumes from its snapshot and the operator GOes on through it.
    const liveWatch = await watchScreen(out!, 'live killed', ref, [0]);
    hub.killChild('live');
    await liveWatch.until(async () => {
      const c = hub.children().live;
      return (
        c.restarts === 1 &&
        c.state === 'up' &&
        (await health())?.mode === 'live' &&
        (await outputOnHub(WS, PORT, cookie))
      );
    });
    await expect.poll(() => hubLive(a).catch(() => -1), { timeout: 20_000 }).toBe(0);
    await go(page);
    await expectCue([out!], 1, 30_000);
    await expect.poll(() => hubLive(a), { timeout: 20_000 }).toBe(1);

    // (c) Freeze the live process (SIGSTOP): sockets go silent, the supervisor's stall watchdog kills it
    // after about 5 s and starts another. The screen holds the whole time.
    const stallWatch = await watchScreen(out!, 'live stalled', ref, [1]);
    const stalledAt = Date.now();
    hub.stopChild('live');
    await stallWatch.until(async () => {
      const c = hub.children().live;
      return c.restarts === 2 && c.state === 'up' && (await outputOnHub(WS, PORT, cookie));
    }, 45_000);
    console.log(
      `live process stalled; replaced and outputs back on the hub after ${Date.now() - stalledAt} ms`,
    );
    a = await hubApi(PORT);
    await go(page);
    await expectCue([out!], 2, 30_000);
    await expect.poll(() => hubLive(a), { timeout: 20_000 }).toBe(2);

    // (d) A socket that sends an oversize message, and one that floods, are closed; the rest carry on.
    const outs = (await (await a.get('settings/outputs')).json()) as {
      token: string;
      kind: string;
      hostIndex: number;
    }[];
    const tok = outs.find((o) => o.kind === 'output' && o.hostIndex === 3)!.token;
    const closeCode = (send: (ws: Socket) => void) =>
      new Promise<number>((done, fail) => {
        const ws = new WS(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(tok)}`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'output', appVersion: APP_VERSION }));
          send(ws);
        });
        ws.on('close', (code) => done(code));
        ws.on('error', fail);
      });
    expect(
      await closeCode((ws) =>
        ws.send(JSON.stringify({ t: 'health', v: 1, health: { pad: 'x'.repeat(100_000) } })),
      ),
    ).toBe(1008);
    expect(
      await closeCode((ws) => {
        for (let i = 0; i < 300; i++) ws.send(JSON.stringify({ t: 'time.ping', v: 1, c: i }));
      }),
    ).toBe(1008);
    await goTo(0);
    await expectCue([out!], 0);
    expect(await hubLive(a)).toBe(0);

    // (e) Corrupt the newest live snapshot on disk and remove the journal before it: the restarted hub
    // falls back to the previous good snapshot and replays the journal from there. The screen is watched
    // from the moment the whole hub is killed until the output is back on the restarted hub in live mode.
    await page.waitForTimeout(6000); // a periodic snapshot of this state; the previous ones stay
    await goTo(1);
    await expectCue([out!], 1);
    const before = await (await a.get('live')).json();
    const snapshotWatch = await watchScreen(out!, 'hub killed, snapshot corrupt', ref, [1]);
    const hubKilledAt = Date.now();
    hub.kill(); // the live process writes its final snapshot as the supervisor vanishes
    await page.waitForTimeout(3000);
    const Database = hubRequire('better-sqlite3') as new (file: string) => Db;
    const db = new Database(join(hub.dataDir, 'live.db'));
    const cur = db.prepare(`SELECT seq FROM live_snapshot WHERE id = 1`).get() as { seq: number };
    expect(cur.seq).toBe(before.seq);
    db.prepare(`UPDATE live_snapshot SET json = '{"seq":' || seq || ',"mode":"live","cues":"broken"}'`).run();
    const prev = (db.prepare(`SELECT MAX(seq) s FROM live_snapshot_prev`).get() as { s: number }).s;
    expect(prev).toBeLessThan(cur.seq);
    // Without the fallback, a replay from an empty state would need these rows.
    db.prepare(`DELETE FROM live_journal WHERE seq <= ?`).run(prev);
    db.close();
    await hub.start();
    await snapshotWatch.until(
      async () => (await health())?.mode === 'live' && (await outputOnHub(WS, PORT, cookie)),
      60_000,
    );
    console.log(
      `hub killed and restarted on a corrupt snapshot; output back on it after ${Date.now() - hubKilledAt} ms`,
    );
    a = await hubApi(PORT);
    const after = await (await a.get('live')).json();
    expect(after.seq).toBe(before.seq);
    expect(after.state.mode).toBe('live');
    expect(after.state.live).toBe(1);
    // The output rides the restart and still follows the operator's GO.
    await expectCue([out!], 1);
    await page.waitForTimeout(1500);
    await go(page);
    await expectCue([out!], 2, 30_000);
    await expect.poll(() => hubLive(a), { timeout: 20_000 }).toBe(2);

    // (f) Crash the library past its restart budget (5 in 60 s): it stays down and is reported as failed;
    // proxied API calls answer 503 while the live API, the screen and GO carry on.
    let kills = 0;
    let lastPid = 0;
    const budgetWatch = await watchScreen(out!, 'library budget exhausted', ref, [2]);
    await budgetWatch.until(async () => {
      const c = hub.children().library;
      if (c.state === 'failed') return (await health())?.library === 'failed';
      if (c.state === 'up' && c.pid && c.pid !== lastPid) {
        lastPid = c.pid;
        kills++;
        process.kill(c.pid, 'SIGKILL');
      }
      return false;
    }, 60_000);
    console.log(`library failed after ${kills} kills`);
    expect(kills).toBe(6);
    expect((await health())?.library).toBe('failed');
    const proxiedCall = await a.get('playlists');
    expect(proxiedCall.status()).toBe(503);
    expect((await proxiedCall.json()).error.code).toBe('library_unavailable');
    await goTo(1);
    await expectCue([out!], 1);
    expect(await hubLive(a)).toBe(1);
  } finally {
    hub.kill();
  }
});
