import { afterEach, describe, expect, it } from 'vitest';
import { checkRouteAccess } from '../src/hub.ts';
import { ipInCidr } from '../src/net.ts';
import { byType, client, connectWs, EDIT_PIN, login, OPERATE_PIN, startHub, type TestHub } from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

describe('auth', () => {
  it('runs first-run setup once, then logs in with either PIN', async () => {
    hub = await startHub({ devPin: undefined });
    const anon = client(hub.url);
    expect(await anon.json('/auth/me')).toMatchObject({ role: null, setupRequired: true, version: '0.1.0' });
    expect((await anon.fetch('/auth/pin', { method: 'POST', json: { pin: '123456' } })).status).toBe(409);
    const weak = await anon.fetch('/auth/setup', { method: 'POST', json: { operatePin: '12', editPin: '34' } });
    expect(weak.status).toBe(400);
    const same = await anon.fetch('/auth/setup', { method: 'POST', json: { operatePin: '123456', editPin: '123456' } });
    expect(same.status).toBe(400);
    const ok = await anon.json<{ role: string }>('/auth/setup', {
      method: 'POST',
      json: { operatePin: '123456', editPin: '654321' },
    });
    expect(ok.role).toBe('operate');
    expect(await anon.json('/auth/me')).toMatchObject({ role: 'operate', setupRequired: false });
    const again = await client(hub.url).fetch('/auth/setup', { method: 'POST', json: { operatePin: '999999', editPin: '888888' } });
    expect(again.status).toBe(409);
    const edit = await login(hub.url, '654321');
    expect(await edit.json('/auth/me')).toMatchObject({ role: 'edit' });
  });

  it('sets a host-only HttpOnly SameSite=Lax cookie, Secure only behind https', async () => {
    hub = await startHub({ trustedProxies: ['127.0.0.1/32'] });
    const plain = await fetch(`${hub.url}/api/v1/auth/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: OPERATE_PIN }),
    });
    const c1 = plain.headers.getSetCookie().find((c) => c.startsWith('ordo_session='))!;
    expect(c1).toMatch(/HttpOnly/i);
    expect(c1).toMatch(/SameSite=Lax/i);
    expect(c1).not.toMatch(/Secure/i);
    expect(c1).not.toMatch(/Domain=/i);
    expect(c1).toMatch(/Max-Age=3600/);
    const https = await fetch(`${hub.url}/api/v1/auth/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ pin: OPERATE_PIN, remember: true }),
    });
    const cookies = https.headers.getSetCookie();
    const c2 = cookies.find((c) => c.startsWith('ordo_session='))!;
    expect(c2).toMatch(/Secure/);
    expect(c2).toMatch(/Max-Age=43200/);
    expect(cookies.some((c) => c.startsWith('ordo_device='))).toBe(true);
    expect(https.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('logout ends the session', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    expect((await op.fetch('/library/snapshot')).status).toBe(200);
    const sessionCookie = op.cookie;
    await op.fetch('/auth/logout', { method: 'POST' });
    const stale = client(hub.url, sessionCookie);
    expect((await stale.fetch('/library/snapshot')).status).toBe(401);
  });

  it('locks out an IP after 5 wrong PINs and the hub after 50', async () => {
    hub = await startHub({ trustedProxies: ['127.0.0.1/32'] });
    const from = (ip: string) => client(hub!.url, '', { 'x-forwarded-for': ip });
    const a = from('198.51.100.1');
    for (let i = 0; i < 5; i++) expect((await a.fetch('/auth/pin', { method: 'POST', json: { pin: '000000' } })).status).toBe(401);
    const locked = await a.fetch('/auth/pin', { method: 'POST', json: { pin: OPERATE_PIN } });
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { error: { message: string } }).error.message).toMatch(/Try again in 15 minutes/);
    expect(locked.headers.get('retry-after')).toBeTruthy();
    // Another IP still works.
    expect((await from('198.51.100.2').fetch('/auth/pin', { method: 'POST', json: { pin: OPERATE_PIN } })).status).toBe(200);
    // Global bucket: 50 failures across many IPs locks everyone out.
    for (let i = 0; i < 45; i++)
      await from(`198.51.101.${i}`).fetch('/auth/pin', { method: 'POST', json: { pin: '000000' } });
    const all = await from('198.51.102.1').fetch('/auth/pin', { method: 'POST', json: { pin: OPERATE_PIN } });
    expect(all.status).toBe(429);
  });

  it('declares an access role on every route and fails fast otherwise', async () => {
    hub = await startHub();
    expect(hub.routes.length).toBeGreaterThan(40);
    for (const r of hub.routes) expect(['public', 'edit', 'operate', 'token', 'live', 'any']).toContain(r.access);
    expect(() => checkRouteAccess({ method: 'GET', url: '/x' })).toThrow(/does not declare/);
    const byUrl = (u: string, m = 'POST') => hub!.routes.find((r) => r.url === `/api/v1${u}` && r.method.includes(m));
    expect(byUrl('/live/events')?.access).toBe('operate');
    expect(byUrl('/actions')?.access).toBe('operate');
    expect(byUrl('/presentations')?.access).toBe('edit');
    expect(byUrl('/files/:hash', 'GET')?.access).toBe('any');
  });

  it('keeps the edit role away from live control', async () => {
    hub = await startHub();
    const edit = await login(hub.url, EDIT_PIN);
    expect((await edit.fetch('/live/events', { method: 'POST', json: { k: 'next', at: 1 } })).status).toBe(403);
    expect((await edit.fetch('/actions', { method: 'POST', json: { id: 'next' } })).status).toBe(403);
    expect((await edit.fetch('/settings/general', { method: 'PUT', json: {} })).status).toBe(403);
    expect((await edit.fetch('/live')).status).toBe(403);
    const snap = await edit.json<{ settings: { outputs: { token?: string }[] } }>('/library/snapshot');
    expect(snap.settings.outputs.every((o) => o.token === undefined)).toBe(true);
    // Over WebSocket: edit sockets get no live state and their live events are rejected.
    const ws = await connectWs(hub.url, { cookie: edit.cookie, hello: { role: 'edit' } });
    const welcome = await ws.next(byType('welcome'));
    expect(welcome.role).toBe('edit');
    ws.send({ t: 'live.event', id: 'x1', event: { k: 'next', at: 1 } });
    const ack = await ws.next(byType('live.ack'));
    expect(ack.rejected).toMatch(/forbidden/);
    expect(ws.messages.some((m) => m.t === 'live.state')).toBe(false);
    // Claiming operate with an edit session is refused.
    const ws2 = await connectWs(hub.url, { cookie: edit.cookie, hello: { role: 'operate' } });
    expect((await ws2.next(byType('bye'))).reason).toBe('forbidden');
    ws.close();
  });

  it('lets output tokens reach only output endpoints', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const outputs = await op.json<{ id: string; token: string; kind: string; name: string }[]>('/settings/outputs');
    expect(outputs.map((o) => o.name)).toEqual(['Audience 1', 'Audience 2', 'Lobby', 'Stream', 'Stage']);
    const out = outputs[0]!;
    const t = client(hub.url, '', { 'x-ordo-token': out.token });
    const cfg = await t.json<{ output: { id: string; token?: string }; looks: unknown[]; fonts: unknown[] }>('/output/config');
    expect(cfg.output.id).toBe(out.id);
    expect(cfg.output.token).toBeUndefined();
    expect(cfg.looks.length).toBe(4);
    expect((await t.fetch('/live')).status).toBe(200);
    expect((await t.fetch('/cache/manifest')).status).toBe(200);
    expect((await t.fetch('/library/snapshot')).status).toBe(403);
    expect((await t.fetch('/live/events', { method: 'POST', json: { k: 'next', at: 1 } })).status).toBe(403);
    expect((await client(hub.url, '', { 'x-ordo-token': 'nope' }).fetch('/output/config')).status).toBe(401);
    expect((await client(hub.url).fetch(`/output/config?token=${encodeURIComponent(out.token)}`)).status).toBe(200);
    // Rotation invalidates the old token.
    const rotated = await op.json<{ token: string }>(`/outputs/${out.id}/token/rotate`, { method: 'POST' });
    expect(rotated.token).not.toBe(out.token);
    expect((await t.fetch('/output/config')).status).toBe(401);
    // Operate session cannot read /output/config (token-only).
    expect((await op.fetch('/output/config')).status).toBe(403);
  });

  it('matches CIDRs for v4, v6 and mapped addresses', () => {
    expect(ipInCidr('172.17.0.1', '172.16.0.0/12')).toBe(true);
    expect(ipInCidr('::ffff:172.17.0.1', '172.16.0.0/12')).toBe(true);
    expect(ipInCidr('172.32.0.1', '172.16.0.0/12')).toBe(false);
    expect(ipInCidr('::1', '::1/128')).toBe(true);
    expect(ipInCidr('fd00::5', 'fc00::/7')).toBe(true);
    expect(ipInCidr('10.0.0.1', '10.0.0.1')).toBe(true);
  });
});
