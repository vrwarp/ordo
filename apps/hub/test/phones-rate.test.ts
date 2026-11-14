/**
 * LAN addresses leave the hub-wide PIN bucket (design/28 §4): a scanner on the public name that trips the
 * global bucket (50 failures per 15 minutes) no longer locks out the venue PC or a phone on church Wi-Fi; each
 * address keeps its own bucket (5 per 15 minutes), and the 429 says which bucket locked it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/net.ts';
import { client, EDIT_PIN, startHub, type TestHub } from './helpers.ts';
import { refusal, twoProcesses } from './phones-helpers.ts';

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

/**
 * Concurrent guesses (review of P0, round 1): the buckets held only for sequential attempts. The route checked
 * the buckets, awaited two argon2 verifies, and only then recorded the failure, so every request of a burst
 * passed the check: 40 of 40 concurrent wrong PINs from one LAN address were verified, 300 of 300 in a burst
 * (the last, the correct PIN, signed in), and 80 concurrent public failures left 80 rows against the cap of 50.
 * Each attempt is now counted as a failure in the tick that checks the buckets, and settled after the verify.
 */
describe('the PIN buckets under concurrent guesses', () => {
  const statuses = (all: Response[]) => {
    const n: Record<number, number> = {};
    for (const r of all) n[r.status] = (n[r.status] ?? 0) + 1;
    return n;
  };
  for (const model of ['one process', 'two processes (through the live proxy)'] as const) {
    describe(model, () => {
      let base = '';
      let db: TestHub['db'];
      let close: () => Promise<void> = async () => undefined;
      afterEach(async () => {
        await close();
        close = async () => undefined;
      });
      const start = async () => {
        if (model === 'one process') {
          const h = await startHub({ trustedProxies: ['127.0.0.1/32'] });
          base = h.url;
          db = h.db;
          close = () => h.cleanup();
        } else {
          const two = await twoProcesses(0, { trustedProxies: ['127.0.0.1/32'] });
          base = two.base;
          db = two.lib.db;
          close = () => two.close();
        }
      };
      const pin = (ip: string, p: unknown) =>
        client(base, '', { 'x-forwarded-for': ip }).fetch('/auth/pin', {
          method: 'POST',
          json: typeof p === 'string' ? { pin: p } : p,
        });

      it('20 concurrent wrong PINs from one LAN address: at most 5 verified, the rest locked out', async () => {
        await start();
        const all = await Promise.all(
          Array.from({ length: 20 }, (_, i) => pin('192.168.1.77', `10000${i % 10}`)),
        );
        const n = statuses(all);
        expect((n[401] ?? 0) + (n[200] ?? 0)).toBeLessThanOrEqual(5);
        expect(n[429]).toBeGreaterThanOrEqual(15);
        expect(
          db.prepare(`SELECT COUNT(*) n FROM auth_attempts WHERE ip = ? AND ok = 0`).get('192.168.1.77'),
        ).toEqual({ n: 5 });
        // The correct PIN in the same window is locked out too.
        expect((await pin('192.168.1.77', EDIT_PIN)).status).toBe(429);
      });

      it('a burst of 30 with the correct PIN last signs in only if it is among the 5 verified', async () => {
        await start();
        const guesses = Array.from({ length: 30 }, (_, i) => String(200000 + i));
        guesses[29] = EDIT_PIN;
        const all = await Promise.all(guesses.map((g) => pin('10.0.0.9', g)));
        const n = statuses(all);
        expect((n[401] ?? 0) + (n[200] ?? 0)).toBeLessThanOrEqual(5);
      });

      it('80 concurrent wrong PINs from 80 public addresses: at most 50 verified, 50 global failures', async () => {
        await start();
        const all = await Promise.all(Array.from({ length: 80 }, (_, i) => pin(`198.51.100.${i}`, '000000')));
        const n = statuses(all);
        expect(n[401] ?? 0).toBeLessThanOrEqual(50);
        expect(db.prepare(`SELECT COUNT(*) n FROM auth_global_failures`).get()).toEqual({ n: 50 });
        const pub = await pin('203.0.113.80', EDIT_PIN);
        expect(pub.status).toBe(429);
        expect(await refusal(pub)).toMatchObject({ code: 'locked_out', scope: 'everyone' });
      });

      it('a success clears its reservation; a malformed body is not counted', async () => {
        await start();
        for (let i = 0; i < 8; i++) expect((await pin('203.0.113.7', { pin: 123456 })).status).toBe(400);
        for (let i = 0; i < 4; i++) expect((await pin('203.0.113.7', EDIT_PIN)).status).toBe(200);
        expect(db.prepare(`SELECT COUNT(*) n FROM auth_global_failures`).get()).toEqual({ n: 0 });
        expect(
          db.prepare(`SELECT COUNT(*) n FROM auth_attempts WHERE ip = ? AND ok = 0`).get('203.0.113.7'),
        ).toEqual({ n: 0 });
        expect(
          db.prepare(`SELECT COUNT(*) n FROM auth_attempts WHERE ip = ? AND ok = 1`).get('203.0.113.7'),
        ).toEqual({ n: 4 });
      });
    });
  }
});
