/**
 * Writes from another site and from pages older than the hub (design/28 §4): a write whose Origin is present
 * and neither this host nor a role host of the venue domain is refused (403 `origin`, `null` included), in both
 * process models; a capped session's write needs `x-ordo` always, a full session's once Phones is on; sign-in,
 * setup and sign-out (anonymous) and output tokens never need it. GETs are never affected.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { client, EDIT_PIN, login, OPERATE_PIN, song, startHub, type TestHub } from './helpers.ts';
import { phone, refusal, type TwoProcesses, twoProcesses } from './phones-helpers.ts';

const post = (base: string, path: string, headers: Record<string, string>, body: unknown = song()) =>
  fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('Origin and x-ordo on writes', () => {
  let hub: TestHub | undefined;
  let two: TwoProcesses | undefined;
  afterEach(async () => {
    await hub?.cleanup();
    await two?.close();
    hub = undefined;
    two = undefined;
  });

  async function originChecks(base: string, port: string) {
    const ed = await login(base, EDIT_PIN);
    const h = { cookie: ed.cookie, 'x-ordo': '1' };
    // Before P0 a cross-site write was accepted (201, measured at d0f49cb).
    const evil = await post(base, '/presentations', { ...h, origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect((await refusal(evil)).code).toBe('origin');
    expect((await post(base, '/presentations', { ...h, origin: 'null' })).status).toBe(403);
    for (const origin of [
      `http://127.0.0.1:${port}`,
      `http://op.localhost:${port}`,
      'http://out1.localhost',
      undefined,
    ])
      expect(
        (await post(base, '/presentations', { ...h, ...(origin ? { origin } : {}) })).status,
        `Origin ${origin}`,
      ).toBe(201);
    // A GET is never checked.
    const get = await fetch(`${base}/api/v1/presentations`, {
      headers: { ...h, origin: 'https://evil.example' },
    });
    expect(get.status).toBe(200);
    // Anonymous writes meet the Origin check too (a sign-in from another site).
    const pin = await post(base, '/auth/pin', { origin: 'https://evil.example' }, { pin: EDIT_PIN });
    expect((await refusal(pin)).code).toBe('origin');
  }

  it('refuses a write from another site, accepts this host and the role hosts (one process)', async () => {
    hub = await startHub();
    await originChecks(hub.url, new URL(hub.url).port);
  });

  it('refuses a write from another site in both processes (proxied library write and live write)', async () => {
    two = await twoProcesses();
    await originChecks(two.base, new URL(two.base).port);
    const op = await login(two.base, OPERATE_PIN);
    const live = await post(
      two.base,
      '/actions',
      { cookie: op.cookie, origin: 'https://evil.example' },
      { id: 'next' },
    );
    expect((await refusal(live)).code).toBe('origin');
  });

  async function headerChecks(base: string, setPhones: (on: boolean) => Promise<void>) {
    const ph = await phone(base);
    const phNoHeader = client(base, ph.cookie, {}, { xOrdo: false });
    const ipadNoHeader = client(base, (await login(base, EDIT_PIN)).cookie, {}, { xOrdo: false });
    const r1 = await phNoHeader.fetch('/presentations', { method: 'POST', json: song() });
    expect(r1.status).toBe(403);
    expect(await refusal(r1)).toEqual({
      code: 'x_ordo_required',
      message: 'Reload ordo: this page is older than the hub.',
    });
    expect((await ph.fetch('/presentations', { method: 'POST', json: song() })).status).toBe(201);
    // Phones off: a full session's write without the header is accepted, as before.
    expect((await ipadNoHeader.fetch('/presentations', { method: 'POST', json: song() })).status).toBe(201);
    await setPhones(true);
    const r2 = await ipadNoHeader.fetch('/presentations', { method: 'POST', json: song() });
    expect((await refusal(r2)).code).toBe('x_ordo_required');
    // GETs, anonymous sign-in, tokens: never.
    expect((await ipadNoHeader.fetch('/presentations')).status).toBe(200);
    const anon = client(base, '', {}, { xOrdo: false });
    expect((await anon.fetch('/auth/pin', { method: 'POST', json: { pin: EDIT_PIN } })).status).toBe(200);
    await setPhones(false);
    expect((await ipadNoHeader.fetch('/presentations', { method: 'POST', json: song() })).status).toBe(201);
  }

  it('x-ordo: capped always, full sessions only with Phones on; anonymous and tokens never (one process)', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    await headerChecks(hub.url, async (on) => {
      await op.json('/settings/phones', { method: 'PUT', json: { enabled: on } });
    });
    // A token principal is exempt (the stage's and an output's only writes are on the socket; none needs it).
    await op.json('/settings/phones', { method: 'PUT', json: { enabled: true } });
    const tok = hub.lib.getSetting('outputs')[0]!.token!;
    const res = await fetch(`${hub.url}/api/v1/live/events`, {
      method: 'POST',
      headers: { 'x-ordo-token': tok, 'content-type': 'application/json' },
      body: JSON.stringify({ k: 'next', at: Date.now() }),
    });
    expect((await refusal(res)).code).not.toBe('x_ordo_required');
  });

  it('x-ordo in both processes: the live process reads Phones from its settings copy', async () => {
    two = await twoProcesses();
    const op = await login(two.base, OPERATE_PIN);
    await headerChecks(two.base, async (on) => {
      await op.json('/settings/phones', { method: 'PUT', json: { enabled: on } });
    });
    await op.json('/settings/phones', { method: 'PUT', json: { enabled: true } });
    const opNoHeader = client(two.base, op.cookie, {}, { xOrdo: false });
    // /actions is answered by the live process itself.
    const live = await opNoHeader.fetch('/actions', { method: 'POST', json: { id: 'next' } });
    expect((await refusal(live)).code).toBe('x_ordo_required');
    expect((await op.fetch('/actions', { method: 'POST', json: { id: 'next' } })).status).toBe(200);
  });
});
