import { expect, test } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { expectCue, go, hubApi, hubLive, launchOutputs, liveService, login } from './linkhelpers.ts';
import { TcpProxy } from './tcpproxy.ts';

const PROXY_PORT = 8382;
const HUB_PORT = 8383;
const op = `http://op.localhost:${PROXY_PORT}`;

/**
 * Review item 13: a command sent just before a short socket blip (under the 5 s fallback grace) is
 * re-submitted with its id on reconnect and applied once; the operator's view does not snap back.
 */
test('a command sent during a short socket blip is not lost', async ({ context, page }) => {
  test.setTimeout(90_000);
  const hub = HubProcess.fresh(HUB_PORT);
  const proxy = new TcpProxy(PROXY_PORT, HUB_PORT);
  await hub.start();
  await proxy.start();
  try {
    const a = await hubApi(HUB_PORT);
    await liveService(a, 1);
    await login(page, op);
    const outs = await launchOutputs(page, context, 1);
    await go(page);
    await expectCue(outs, 0);
    await expect.poll(() => hubLive(a)).toBe(0);

    // The socket is still "up" but nothing gets through; the GO is swallowed. 2 s later the connections
    // are cut: the operator reconnects well inside the 5 s grace.
    proxy.blackhole();
    await go(page);
    await expect(page.locator('body')).toContainText('1 pending', { timeout: 5000 });
    await page.waitForTimeout(2000);
    expect(await hubLive(a)).toBe(0);
    proxy.thaw();

    await expect.poll(() => hubLive(a), { timeout: 10_000 }).toBe(1);
    await expectCue(outs, 1);
    await expect(page.locator('body')).not.toContainText('pending', { timeout: 10_000 });
    await expect(page.locator('body')).not.toContainText('running from this PC');
    await expect(page.locator('body')).not.toContainText(/refused|rejected/i);

    // Applied exactly once: the next GO lands on cue 2.
    await go(page);
    await expect.poll(() => hubLive(a), { timeout: 10_000 }).toBe(2);
    await expectCue(outs, 2);
  } finally {
    await proxy.stop();
    hub.kill();
  }
});
