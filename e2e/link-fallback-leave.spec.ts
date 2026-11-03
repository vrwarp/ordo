import { expect, test } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { busOf, expectCue, go, hubApi, hubLive, launchOutputs, liveService, login } from './linkhelpers.ts';

const PORT = 8384;
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

    // The operator tab goes away while the hub is still down: the outputs leave the bus on their own.
    await page.close();
    await expect.poll(() => busOf(outs[0]!), { timeout: 5000 }).toBe('none');

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
    await page2.waitForTimeout(3000);
    for (const o of outs)
      if (!o.isClosed())
        console.log(
          'OLD',
          o.url(),
          await o.evaluate(() => JSON.stringify((window as any).__ordo.state().log.slice(-12))).catch((e) => String(e)),
        );
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
