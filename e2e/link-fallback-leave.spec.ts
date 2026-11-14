import { expect, test } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { portOf } from './ports.ts';
import {
  busOf,
  expectCue,
  go,
  hubApi,
  hubLive,
  launchOutputs,
  leftBusAt,
  liveService,
  login,
} from './linkhelpers.ts';

const PORT = portOf('link-fallback-leave');
const op = `http://op.localhost:${PORT}`;

/**
 * Review item 1: outputs put on the fallback bus by an operator tab that then goes away must follow the
 * hub again once it returns, and a new operator tab's Relaunch must take the windows over.
 */
test('outputs leave the fallback bus when the operator tab closes, and a new tab takes them over', async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    let a = await hubApi(PORT);
    await liveService(a, 2);
    await login(page, op);
    const outs = await launchOutputs(page, context, 2);
    await go(page);
    await expectCue(outs, 0);

    // The hub dies; the operator becomes the authority and GOes to cue 1 over the fallback bus.
    hub.kill();
    await expect(page.locator('body')).toContainText('running from this PC', { timeout: 20_000 });
    await page.waitForTimeout(1000);
    await go(page);
    await expectCue(outs, 1);
    for (const o of outs) expect(await busOf(o)).toBe('fallback');

    // The operator tab goes away while the hub is still down: the outputs leave the bus on their own, because
    // the operator went (its `pagehide`, or the host's 250 ms opener check: design/17), within 5 s of the
    // close by their own clock. The time is read from each window's link log, not from when this test hears
    // back: after a tab closes, Chrome's browser thread can wait seconds on the GPU process (SwiftShader
    // keeps it busy drawing both outputs every frame), and nothing reaches the test meanwhile (up to 11 s
    // seen on a loaded 4-core machine, while the windows had left within 260 ms).
    const closedAt = Date.now();
    await page.close();
    for (const o of outs) {
      await expect.poll(() => busOf(o), { timeout: 20_000 }).toBe('none');
      await expect.poll(async () => (await leftBusAt(o, closedAt)) !== undefined).toBe(true);
      const left = (await leftBusAt(o, closedAt))!;
      expect(['opener closed', 'operator says hub up']).toContain(left.reason);
      expect(left.at - closedAt).toBeLessThan(5000);
    }

    // The hub returns with its journalled state (cue 0): the outputs follow it again.
    await hub.start();
    a = await hubApi(PORT);
    await expect.poll(() => busOf(outs[0]!), { timeout: 15_000 }).toBe('hub');
    await expectCue(outs, 0);
    expect(await hubLive(a)).toBe(0);
    await a.post('actions', { data: { id: 'next' } });
    await expectCue(outs, 1);

    // A new operator tab: it holds no handles, says so, and its Relaunch takes the windows over.
    const page2 = await context.newPage();
    await login(page2, op);
    await expect(page2.locator('[data-fallback-link]')).toHaveText('fallback link 0/2', { timeout: 10_000 });
    const outs2 = await launchOutputs(page2, context, 2, 'Relaunch');
    // The old windows cannot be reached by name from another tab; the hub tells them they are superseded.
    await expect.poll(() => outs.filter((p) => !p.isClosed()).length, { timeout: 15_000 }).toBe(0);
    await expect(page2.locator('[data-fallback-link]')).toHaveCount(0);
    await go(page2);
    await expectCue(outs2, 2);
    expect(await hubLive(a)).toBe(2);
  } finally {
    hub.kill();
  }
});
