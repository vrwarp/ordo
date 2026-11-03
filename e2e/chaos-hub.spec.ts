import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { waitCacheReady } from './helpers.ts';
import { expectCue, go, hubApi, hubLive, launchOutputs, liveService, login } from './linkhelpers.ts';

/**
 * Chaos for the two-process hub (design/25 "Hub", phase D): kill the library process mid-service, kill
 * the live process, corrupt the live snapshot on disk, flood a WebSocket. The audience screen keeps its
 * cue throughout and the operator keeps control. Ports 8600-8619.
 */
const PORT = 8600;
const op = `http://op.localhost:${PORT}`;
// Native modules and ws are dependencies of the hub; resolve them from there.
const hubRequire = createRequire(resolve('apps/hub/package.json'));

test('the service survives library and live process crashes, a corrupt snapshot and a flooding socket', async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    let a = await hubApi(PORT);
    await liveService(a, 1);
    expect(hub.children().library.state).toBe('up');
    await login(page, op);
    const [out] = await launchOutputs(page, context, 1);
    await go(page);
    await expectCue([out!], 0);

    // (a) Kill the library process: GO keeps working, a reloaded output refills its cache and shows the
    // live cue, and the library is back within about a second.
    const killedAt = Date.now();
    hub.killChild('library');
    const libraryBack = (async () => {
      for (;;) {
        if ((await a.get('playlists').catch(() => undefined))?.status() === 200) return Date.now() - killedAt;
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    await go(page);
    await expectCue([out!], 1);
    await out!.reload();
    await waitCacheReady(out!);
    await expectCue([out!], 1);
    const backMs = await libraryBack;
    console.log(`library process answering again ${backMs} ms after it was killed`);
    expect(backMs).toBeLessThan(5000);
    expect(hub.children().library.restarts).toBe(1);

    // (b) Kill the live process: the output holds its cue, the restarted live process resumes from its
    // snapshot with the same live cue, and the operator GOes on through it.
    hub.killChild('live');
    await expectCue([out!], 1);
    await expect.poll(() => hubLive(a).catch(() => -1), { timeout: 20_000 }).toBe(1);
    expect(hub.children().live.restarts).toBe(1);
    await page.waitForTimeout(1500);
    await go(page);
    await expectCue([out!], 2, 30_000);
    await expect.poll(() => hubLive(a), { timeout: 20_000 }).toBe(2);

    // (d) A socket that sends an oversize message, and one that floods, are closed; the rest carry on.
    const WS = hubRequire('ws') as typeof import('ws').default;
    const outs = (await (await a.get('settings/outputs')).json()) as {
      token: string;
      kind: string;
      hostIndex: number;
    }[];
    const tok = outs.find((o) => o.kind === 'output' && o.hostIndex === 3)!.token;
    const closeCode = (send: (ws: import('ws').default) => void) =>
      new Promise<number>((done, fail) => {
        const ws = new WS(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(tok)}`);
        ws.on('open', () => {
          ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'output', appVersion: '0.1.0' }));
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
    // The song has three slides and cue 2 is the last: jump back to the top through the API.
    const goTo = async (cueIndex: number) =>
      expect((await a.post('live/events', { data: { k: 'go', cueIndex, at: Date.now() } })).ok()).toBe(true);
    await goTo(0);
    await expectCue([out!], 0);
    expect(await hubLive(a)).toBe(0);

    // (c) Corrupt the newest live snapshot on disk and remove the journal before it: the restarted hub
    // falls back to the previous good snapshot and replays the journal from there.
    await page.waitForTimeout(6000); // a periodic snapshot of this state; the previous ones stay
    await goTo(1);
    await expectCue([out!], 1);
    const before = await (await a.get('live')).json();
    hub.kill(); // the live process writes its final snapshot (seq 5) as the supervisor vanishes
    await page.waitForTimeout(3000);
    const Database = hubRequire('better-sqlite3') as typeof import('better-sqlite3');
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
  } finally {
    hub.kill();
  }
});
