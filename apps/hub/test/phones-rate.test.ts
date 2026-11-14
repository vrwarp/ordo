/**
 * LAN addresses leave the hub-wide PIN bucket (design/28 §4): a scanner on the public name that trips the
 * global bucket (50 failures per 15 minutes) no longer locks out the venue PC or a phone on church Wi-Fi; each
 * address keeps its own bucket (5 per 15 minutes), and the 429 says which bucket locked it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/net.ts';
import { client, EDIT_PIN, startHub, type TestHub } from './helpers.ts';
import { refusal } from './phones-helpers.ts';

describe('isPrivateAddress', () => {
  it('reads the LAN, loopback and link-local ranges as private, carrier-grade NAT as public', () => {
    for (const ip of [
      '10.0.0.5',
      '172.16.3.4',
      '172.31.255.1',
      '192.168.1.20',
      '127.0.0.1',
      '169.254.10.1',
      '::1',
      'fd00::5',
      'fe80::1',
      '::ffff:192.168.1.7',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of [
      '100.64.0.1',
      '172.32.0.1',
      '203.0.113.9',
      '8.8.8.8',
      '2001:db8::1',
      '::ffff:8.8.8.8',
      '',
      'x',
    ])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('the PIN buckets', () => {
  let hub: TestHub | undefined;
  afterEach(async () => {
    await hub?.cleanup();
    hub = undefined;
  });
  const from = (ip: string) => client(hub!.url, '', { 'x-forwarded-for': ip });
  const pin = (ip: string, p: string) => from(ip).fetch('/auth/pin', { method: 'POST', json: { pin: p } });

  it('after 50 public failures, public addresses are locked out (everyone); LAN addresses still sign in', async () => {
    hub = await startHub({ trustedProxies: ['127.0.0.1/32'] });
    for (let i = 0; i < 50; i++)
      expect((await pin(`198.51.${100 + Math.floor(i / 4)}.${i % 4}`, '000000')).status).toBe(401);
    const pub = await pin('203.0.113.50', EDIT_PIN);
    expect(pub.status).toBe(429);
    expect(await refusal(pub)).toMatchObject({ code: 'locked_out', scope: 'everyone' });
    // Before P0 these were 429 too (the global bucket counted and blocked everyone, measured at d0f49cb).
    for (const ip of ['192.168.1.20', '10.0.0.5', 'fd00::5', '::ffff:192.168.1.7'])
      expect((await pin(ip, EDIT_PIN)).status, ip).toBe(200);
  });

  it('5 LAN failures lock that address (network); 60 from 12 LAN addresses do not lock out a public one', async () => {
    hub = await startHub({ trustedProxies: ['127.0.0.1/32'] });
    for (let i = 0; i < 5; i++) await pin('192.168.1.30', '000000');
    const lan = await pin('192.168.1.30', EDIT_PIN);
    expect(lan.status).toBe(429);
    expect(await refusal(lan)).toMatchObject({ code: 'locked_out', scope: 'network' });
    expect(lan.headers.get('retry-after')).toBeTruthy();
    for (let ip = 0; ip < 12; ip++) for (let i = 0; i < 5; i++) await pin(`10.1.0.${ip}`, '000000');
    expect((await pin('203.0.113.51', EDIT_PIN)).status).toBe(200);
    expect(hub.db.prepare(`SELECT COUNT(*) n FROM auth_global_failures`).get()).toEqual({ n: 0 });
  });
});
