import { expect, type Page, test } from '@playwright/test';
import { SONG } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { portOf } from './ports.ts';
import { go, hubApi, launchOutputs, liveService, login } from './linkhelpers.ts';

/** Its two hubs: e2e/ports.ts row 'chaos-stage'. */
const HUB_PORT = portOf('chaos-stage', 0);
const STAGE = `http://stage.localhost:${HUB_PORT}`;

type Telemetry = {
  seq?: number;
  resyncs?: number;
  invariantResyncs?: number;
  ready?: boolean;
  workers: { name: string; generation: number; restarts: number; gaveUp: boolean }[];
};

const telemetry = (p: Page) =>
  p.evaluate(() =>
    (window as unknown as { __ordo: { telemetry(): unknown } }).__ordo.telemetry(),
  ) as Promise<Telemetry>;

/**
 * Design/25 chaos for the stage window (phase E): its link worker owns the socket, the mirror, fonts and
 * timers; the main thread only renders. Killing the worker must not blank the stage, the supervisor must
 * restart it, and the next GO must reach the screen. A malformed delta must resync, never crash.
 */
test('the stage survives a killed link worker and a malformed delta', async ({ context }) => {
  test.setTimeout(120_000);
  const hub = HubProcess.fresh(HUB_PORT);
  await hub.start();
  try {
    const a = await hubApi(HUB_PORT);
    const song = await (await a.post('import/songselect', { data: { text: SONG } })).json();
    const pl = await (
      await a.post('playlists', {
        data: { name: 'Chaos', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
      })
    ).json();
    expect(
      (await a.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } })).ok(),
    ).toBe(true);
    const outs = (await (await a.get('settings/outputs')).json()) as {
      id: string;
      kind: string;
      token?: string;
    }[];
    const st = outs.find((o) => o.kind === 'stage')!;

    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(
      `${STAGE}/?output=${encodeURIComponent(st.id)}&token=${encodeURIComponent(st.token ?? '')}&test=1`,
    );
    const next = async () => expect((await a.post('actions', { data: { id: 'next' } })).ok()).toBe(true);

    await next();
    await expect(page.locator('.current')).toContainText('First line of verse one', { timeout: 15_000 });

    // 1. Kill the link worker as a crash would: the stage keeps its lyrics while the supervisor notices
    //    the missing heartbeat (2 s) and starts a new worker, which paints from IndexedDB and reconnects.
    const killed = await page.evaluate(() =>
      (
        window as unknown as { __ordo: { chaos: { killWorker(n: string): boolean } } }
      ).__ordo.chaos.killWorker('link'),
    );
    expect(killed).toBe(true);
    for (let i = 0; i < 5; i++) {
      await expect(page.locator('.current')).toContainText('First line of verse one');
      await page.waitForTimeout(400);
    }
    await expect
      .poll(async () => (await telemetry(page)).workers.find((w) => w.name === 'link')?.restarts ?? 0, {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await telemetry(page)).ready, { timeout: 10_000 }).toBe(true);
    await expect(page.locator('.current')).toContainText('First line of verse one');

    // The next GO reaches the stage through the restarted worker.
    await next();
    await expect(page.locator('.current')).toContainText('Chorus line alpha', { timeout: 15_000 });

    // 2. A malformed delta (as if from the hub) is rejected: the stage keeps its text and resyncs.
    // Wait until the stage has applied the hub's current sequence, so the delta follows on from it.
    const hubSeq = async () => ((await (await a.get('live')).json()) as { state: { seq: number } }).state.seq;
    const seq = await hubSeq();
    await expect.poll(async () => (await telemetry(page)).seq ?? -1, { timeout: 5000 }).toBe(seq);
    const before = await telemetry(page);
    await page.evaluate((seq) => {
      const o = (window as unknown as { __ordo: { chaos: { inject(k: string, m: unknown): void } } }).__ordo;
      o.chaos.inject('delta', {
        t: 'live.delta',
        v: 1,
        seq: seq + 1,
        fromSeq: seq,
        event: { k: 'go', cueIndex: 'x' },
      });
    }, before.seq!);
    await expect
      .poll(async () => (await telemetry(page)).resyncs ?? 0, { timeout: 5000 })
      .toBeGreaterThan(before.resyncs ?? 0);
    await expect(page.locator('.current')).toContainText('Chorus line alpha');
    await next();
    await expect(page.locator('.current')).toContainText('Verse two line one', { timeout: 15_000 });

    // A state that breaks the live-state invariants is not drawn and triggers a resync.
    const t2 = await telemetry(page);
    await page.evaluate(() =>
      (window as unknown as { __ordo: { chaos: { badState(): void } } }).__ordo.chaos.badState(),
    );
    await expect
      .poll(async () => (await telemetry(page)).invariantResyncs ?? 0, { timeout: 5000 })
      .toBeGreaterThan(t2.invariantResyncs ?? 0);
    await expect(page.locator('.current')).toContainText('Verse two line one');

    expect(errors).toEqual([]);
  } finally {
    hub.kill();
  }
});

/**
 * The stage on the operator's fallback bus: the operator opened it, the hub dies, the operator becomes the
 * authority. Killing the stage's link worker there must not lose the bus: the restarted worker gets the
 * bus back (relay of window.postMessage, and a fresh port when the operator hands them over) and follows
 * the next GO.
 */
test('the stage follows the fallback bus across a link worker restart', async ({ context, page }) => {
  test.setTimeout(120_000);
  const port = portOf('chaos-stage', 1);
  const op = `http://op.localhost:${port}`;
  const hub = HubProcess.fresh(port);
  await hub.start();
  try {
    const a = await hubApi(port);
    await liveService(a, 1);
    const outs = (await (await a.get('settings/outputs')).json()) as { kind: string; enabled: boolean }[];
    const withStage = outs.map((o) => (o.kind === 'stage' ? { ...o, enabled: true } : o));
    expect((await a.put('settings/outputs', { data: withStage })).ok()).toBe(true);
    await login(page, op);
    await launchOutputs(page, context, 1);
    await expect
      .poll(() => context.pages().filter((p) => /\/\/stage\.localhost/.test(p.url())).length, {
        timeout: 20_000,
      })
      .toBe(1);
    const stage = context.pages().find((p) => /\/\/stage\.localhost/.test(p.url()))!;
    const errors: string[] = [];
    stage.on('pageerror', (e) => errors.push(e.message));
    const bus = async () =>
      await stage.evaluate(
        () => (window as unknown as { ordoStage: { view(): { bus: string } } }).ordoStage.view().bus,
      );
    const current = () => stage.locator('.current');

    await go(page);
    await expect(current()).toContainText('First line of verse one', { timeout: 15_000 });

    hub.kill();
    await expect(page.locator('body')).toContainText('running from this PC', { timeout: 20_000 });
    await expect.poll(bus, { timeout: 15_000 }).toBe('fallback');
    await go(page);
    await expect(current()).toContainText('Chorus line alpha', { timeout: 15_000 });

    // Kill the stage's link worker while it is on the operator's bus.
    await stage.evaluate(() =>
      (window as unknown as { ordoStage: { chaos(): { killWorker(n: string): boolean } } }).ordoStage
        .chaos()
        .killWorker('link'),
    );
    await page.waitForTimeout(500);
    await expect(current()).toContainText('Chorus line alpha');
    await expect.poll(bus, { timeout: 20_000 }).toBe('fallback');
    await go(page);
    await expect(current()).toContainText('Verse two line one', { timeout: 15_000 });
    expect(errors).toEqual([]);
  } finally {
    hub.kill();
  }
});
