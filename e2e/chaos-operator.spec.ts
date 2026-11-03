import { expect, type Page, test } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { busOf, expectCue, go, hubApi, hubLive, launchOutputs, liveService, login } from './linkhelpers.ts';

/**
 * Chaos for the operator window (design/25, phase C): the core worker dies mid-service, the main thread
 * blocks, the hub dies. The audience screens must not notice; no command may be lost. Ports 8540-8559.
 */

type Hooks = {
  __ordo: {
    live(): {
      seq: number;
      live?: number;
      authority: string;
      hubConnected: boolean;
      recovering: boolean;
      generation?: number;
      endpoints: Record<string, { active: string; port: boolean; relay: boolean; ready: boolean }>;
      mainThreadStallMaxMs?: number;
      unacknowledged: number;
    };
    chaos: {
      killWorker(name: string): boolean;
      blockMain(ms: number): void;
      workerDispatch(action: { id: string }, delayMs: number): void;
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

test('the core worker dies mid-service: the UI shows recovering, GO works within ~3 s and no command is lost', async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const PORT = 8541;
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
    const before = await opLive(page);

    // Kill the core and press GO at once: the key lands in the outbox, not in the dead worker.
    await page.bringToFront();
    const t0 = Date.now();
    expect(await page.evaluate(() => (window as unknown as Hooks).__ordo.chaos.killWorker('core'))).toBe(
      true,
    );
    await page.keyboard.press('Space');
    await expect(page.locator('[data-recovering]')).toBeVisible({ timeout: 3000 });
    await expect.poll(() => hubLive(a), { timeout: 8000 }).toBe(1);
    const recoveredMs = Date.now() - t0;
    console.log(`core killed: the pending GO reached the hub after ${recoveredMs} ms`);
    expect(recoveredMs).toBeLessThan(5000);
    await expectCue(outs, 1);
    await expect(page.locator('[data-recovering]')).toBeHidden({ timeout: 5000 });
    const after = await opLive(page);
    expect(after.generation).toBe((before.generation ?? 0) + 1);
    expect(after.unacknowledged).toBe(0);

    // Exactly once: the hub is at cue 1, not 2 (the re-sent action kept its id).
    await page.waitForTimeout(1000);
    expect(await hubLive(a)).toBe(1);

    // GO keeps working through the new core, and the restarted core re-took a port to the output.
    await go(page);
    await expectCue(outs, 2);
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
  const PORT = 8542;
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

test('the fallback bus runs over MessagePorts: with the hub dead GO reaches the outputs port to port', async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const PORT = 8543;
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

    hub.kill();
    await page.bringToFront();
    await expect(page.locator('body')).toContainText('running from this PC', { timeout: 25_000 });
    await page.waitForTimeout(1000);
    await go(page);
    await expectCue(outs, 1);

    // The operator's core holds a direct port to every output and uses it.
    const eps = (await opLive(page)).endpoints;
    expect(Object.keys(eps)).toHaveLength(2);
    for (const e of Object.values(eps)) expect(e).toMatchObject({ active: 'port', port: true, ready: true });
    // The output side agrees, when it reports its carrier.
    for (const p of outs) {
      const t = await outputTransport(p);
      if (t !== undefined) expect(t).toBe('port');
    }
  } finally {
    hub.kill();
  }
});
