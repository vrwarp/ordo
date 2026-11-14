import { expect, test } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { portOf } from './ports.ts';
import { expectCue, go, hubApi, hubLive, launchOutputs, liveService, login } from './linkhelpers.ts';
import { TcpProxy } from './tcpproxy.ts';

const PROXY_PORT = portOf('link-silent-hub', 0);
const HUB_PORT = portOf('link-silent-hub', 1);
const op = `http://op.localhost:${PROXY_PORT}`;

/**
 * Review items 2 and 3: a hub that dies silently (frozen TCP, no close) is noticed by the time since the
 * last pong, within about 10 s while live, and the operator is the authority a 5 s grace later.
 */
test('a silently dead hub is noticed within 12 s and the operator is the authority soon after', async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const hub = HubProcess.fresh(HUB_PORT);
  const proxy = new TcpProxy(PROXY_PORT, HUB_PORT);
  await hub.start();
  await proxy.start();
  try {
    let a = await hubApi(HUB_PORT);
    await liveService(a, 2);
    await login(page, op);
    const outs = await launchOutputs(page, context, 2);
    await go(page);
    await expectCue(outs, 0);
    // Let the live ping cadence settle (status flaps would show as "reconnecting" below).
    await page.waitForTimeout(4000);
    await expect(page.locator('body')).not.toContainText('reconnecting');

    const t0 = Date.now();
    proxy.freeze();
    await expect(page.locator('body')).toContainText('Hub reconnecting', { timeout: 13_000 });
    const noticedMs = Date.now() - t0;
    await expect(page.locator('body')).toContainText('running from this PC', { timeout: 10_000 });
    const authorityMs = Date.now() - t0;
    console.log(`silent hub: noticed after ${noticedMs} ms, authority after ${authorityMs} ms`);
    expect(noticedMs).toBeLessThanOrEqual(12_000);
    expect(authorityMs).toBeLessThanOrEqual(17_000);

    // GO works through the fallback bus.
    await page.waitForTimeout(500);
    await go(page);
    await expectCue(outs, 1);

    // The hub is reachable again: it adopts the operator's state and the outputs return to it.
    proxy.thaw();
    a = await hubApi(HUB_PORT);
    await expect.poll(() => hubLive(a), { timeout: 30_000 }).toBe(1);
    await expect(page.locator('body')).not.toContainText('running from this PC', { timeout: 15_000 });
    await go(page);
    await expectCue(outs, 2);
    await expect.poll(() => hubLive(a), { timeout: 10_000 }).toBe(2);
  } finally {
    await proxy.stop();
    hub.kill();
  }
});
