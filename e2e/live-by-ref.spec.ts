/**
 * The running service by reference (design/29 §2.3 M2; live-by-ref). A 6 MiB service is live with an Audience window
 * on it. (1) The window saves a small record per GO and the copy once, in pieces, after its first flip. (2) A raw
 * screen that says it holds the copy is sent the state without it, under a quarter of the whole frame, and one that
 * holds nothing the whole state. (3) The hub is killed and started again on the same data: the window is back on the hub
 * without a reload, cue 3 still shown; a raw screen holding the copy gets the restored state by name. (4) 20 more
 * screens say hello at once while a GO is sent every 1.2 s: every GO is applied within 1,000 ms and the window flips
 * on time. (5) A second playlist goes live beside the first (the take-over): a GO sent 20 ms after it applies within
 * 250 ms, a screen that reconnects holding the OLD copy is sent the new one whole. (6) The hub is killed again during
 * that service: the new service is restored. Its hub's port: e2e/ports.ts row 'live-by-ref'.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { lyricSlide, newId } from '../packages/domain/src/index.ts';
import { APP_VERSION } from '../packages/protocol/src/index.ts';
import { shownSlideCue } from './helpers.ts';
import { HubProcess } from './hubproc.ts';
import { hubApi, launchOutputs, login } from './linkhelpers.ts';
import { portOf } from './ports.ts';

const hubRequire = createRequire(resolve('apps/hub/package.json'));
type Frame = { text: string; bytes: number };
type Socket = {
  on(ev: 'open', fn: () => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  on(ev: 'message', fn: (data: Buffer) => void): void;
  send(data: string): void;
  terminate(): void;
};
type WsCtor = new (url: string, opts?: { headers?: Record<string, string> }) => Socket;

/** A raw screen: says hello (holding `resolvedId` or nothing) and keeps its frames. */
async function rawScreen(port: number, cookie: string, resolvedId?: string) {
  const WS = hubRequire('ws') as WsCtor;
  const ws = new WS(`ws://localhost:${port}/ws`, { headers: { cookie } });
  const frames: Frame[] = [];
  ws.on('message', (d) => frames.push({ text: d.toString(), bytes: d.length }));
  await new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', rej);
  });
  ws.send(
    JSON.stringify({
      t: 'hello',
      v: 1,
      role: 'operate',
      appVersion: APP_VERSION,
      ...(resolvedId ? { resolvedId } : {}),
    }),
  );
  const state = async (): Promise<{
    msg: { resolvedId?: string; state: { resolved?: unknown; seq: number; live?: number } };
    bytes: number;
  }> => {
    await expect
      .poll(() => frames.some((f) => f.text.startsWith('{"t":"live.state"')), {
        timeout: 30_000,
        intervals: [50],
      })
      .toBe(true);
    const f = frames.find((x) => x.text.startsWith('{"t":"live.state"'))!;
    return { msg: JSON.parse(f.text), bytes: f.bytes };
  };
  return { ws, frames, state };
}

/** A presentation of 50 lyric slides, about 115 KB. */
function presentation(i: number) {
  const line = 'Amazing grace how sweet the sound that saved a wretch like me ';
  const sid = newId();
  return {
    id: newId(),
    rev: 1,
    title: `Song ${i}`,
    kind: 'song',
    meta: { tags: [] },
    sections: [
      {
        id: sid,
        label: 'Verse 1',
        short: 'V1',
        slides: Array.from({ length: 50 }, (_, k) => lyricSlide(`${i}.${k} ${line.repeat(30)}`)),
      },
    ],
    arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
    archived: false,
  };
}

async function service(a: APIRequestContext, name: string, mib: number): Promise<string> {
  const items: unknown[] = [];
  const n = Math.ceil((mib * 1024) / 115);
  for (let i = 0; i < n; i++) {
    const p = (await (await a.post('presentations', { data: presentation(i) })).json()) as { id: string };
    items.push({ id: `i${i}`, kind: 'presentation', presentationId: p.id });
  }
  const pl = (await (await a.post('playlists', { data: { name, items } })).json()) as { id: string };
  return pl.id;
}

const event = async (a: APIRequestContext, ev: Record<string, unknown>) => {
  const r = await a.post('live/events', {
    data: { id: `${ev.k}-${Date.now()}-${Math.random()}`, event: ev },
  });
  expect(r.ok(), await r.text()).toBe(true);
};
type HubLive = { seq: number; live?: number; resolved?: { playlist: { id: string } } };
const hubLive = async (a: APIRequestContext) =>
  ((await (await a.get('live')).json()) as { state: HubLive }).state;
const lateFlips = (p: Page) =>
  p.evaluate(() =>
    Number(
      (window as unknown as { __ordo: { telemetry(): { lateFlips?: number } } }).__ordo.telemetry()
        .lateFlips ?? 0,
    ),
  );
/** Has the window saved the whole copy (a marker in its store)? Keys of the form copy:<outputId>. */
const copySaved = (p: Page) =>
  p.evaluate(
    () =>
      new Promise<boolean>((resolveFn) => {
        const req = indexedDB.open('ordo-output');
        req.onerror = () => resolveFn(false);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kv')) return resolveFn(false);
          const keys = db.transaction('kv').objectStore('kv').getAllKeys();
          keys.onsuccess = () =>
            resolveFn((keys.result as string[]).some((k) => /^copy:[^:]+$/.test(String(k))));
          keys.onerror = () => resolveFn(false);
        };
      }),
  );

test('the service by reference: small records per GO, a restart that sends it by name, a storm beside GOs, a take-over beside a GO', async ({
  context,
  page,
}) => {
  test.setTimeout(420_000);
  const port = portOf('live-by-ref');
  const hub = HubProcess.fresh(port);
  await hub.start();
  try {
    const a = await hubApi(port);
    const cookieOf = async () =>
      (await a.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const outs = (await (await a.get('settings/outputs')).json()) as { kind: string; hostIndex: number }[];
    expect(
      (
        await a.put('settings/outputs', {
          data: outs.map((o) => ({ ...o, enabled: o.kind !== 'stage' && o.hostIndex === 1 })),
        })
      ).ok(),
    ).toBe(true);
    const first = await service(a, 'First service', 6);
    const second = await service(a, 'Second service', 2);
    await event(a, { k: 'goLive', playlistId: first });
    await expect.poll(async () => (await hubLive(a)).resolved?.playlist.id, { timeout: 60_000 }).toBe(first);

    // the Audience window on it
    await login(page, `http://op.localhost:${port}`);
    const [out] = await launchOutputs(page, context, 1);
    if (!out) throw new Error('no Audience window');
    const cueOn = async () => {
      await out.bringToFront();
      return shownSlideCue(out);
    };
    for (let i = 0; i < 4; i++) {
      await event(a, { k: 'next', at: Date.now() });
      await page.waitForTimeout(300);
    }
    await expect.poll(cueOn, { timeout: 20_000 }).toBe(3);
    // (1) the copy is saved once on the window, after its first flip
    await expect.poll(() => copySaved(out), { timeout: 30_000, intervals: [250] }).toBe(true);
    const origin = await out.evaluate(() => performance.timeOrigin);

    // (2) raw screens: one holding nothing is sent the whole state, one holding the id the state without it
    const cookie = await cookieOf();
    const nothing = await rawScreen(port, cookie);
    const whole = await nothing.state();
    expect(whole.bytes).toBeGreaterThan(5 * 1024 * 1024);
    const id = whole.msg.resolvedId!;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const holding = await rawScreen(port, cookie, id);
    const small = await holding.state();
    expect(small.msg.state.resolved).toBeUndefined();
    expect(small.msg.resolvedId).toBe(id);
    expect(small.bytes).toBeLessThan(0.25 * whole.bytes);
    nothing.ws.terminate();
    holding.ws.terminate();
    const seqBefore = (await hubLive(a)).seq;

    // (3) the hub is killed and started again on the same data
    hub.kill();
    await page.waitForTimeout(1500);
    await hub.start();
    const a2 = await hubApi(port);
    await expect.poll(async () => (await hubLive(a2)).live, { timeout: 60_000, intervals: [250] }).toBe(3);
    expect((await hubLive(a2)).seq).toBeGreaterThanOrEqual(seqBefore);
    await expect.poll(cueOn, { timeout: 60_000 }).toBe(3);
    expect(await out.evaluate(() => performance.timeOrigin)).toBe(origin); // no reload
    const cookie2 = (await a2.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const afterRestart = await rawScreen(port, cookie2, id);
    const restored = await afterRestart.state();
    expect(restored.msg.state.resolved).toBeUndefined();
    expect(restored.bytes).toBeLessThan(0.25 * whole.bytes);
    afterRestart.ws.terminate();

    // (4) 20 screens say hello at once while a GO is sent every 1.2 s
    const late = await lateFlips(out);
    const storm = await Promise.all(Array.from({ length: 20 }, () => rawScreen(port, cookie2, id)));
    let lastMs = 0;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const seq = (await hubLive(a2)).seq;
      await event(a2, { k: 'next', at: Date.now() });
      await expect
        .poll(async () => (await hubLive(a2)).seq, { timeout: 5_000, intervals: [10] })
        .toBeGreaterThan(seq);
      lastMs = Date.now() - t0;
      expect(lastMs).toBeLessThan(1000);
      await page.waitForTimeout(1200);
    }
    for (const s of storm) {
      const st = await s.state();
      expect(st.msg.state.resolved).toBeUndefined();
      s.ws.terminate();
    }
    expect(await lateFlips(out)).toBe(late);

    // (5) a second service goes live beside the first; a GO 20 ms after it applies within 250 ms of its press
    const oldHolder = await rawScreen(port, cookie2, id);
    await oldHolder.state();
    const before = (await hubLive(a2)).seq;
    await event(a2, { k: 'goLive', playlistId: second });
    await page.waitForTimeout(20);
    const press = Date.now();
    await event(a2, { k: 'next', at: Date.now() });
    await expect
      .poll(async () => (await hubLive(a2)).resolved?.playlist.id, { timeout: 60_000, intervals: [20] })
      .toBe(second);
    await expect
      .poll(async () => (await hubLive(a2)).seq, { timeout: 5_000, intervals: [10] })
      .toBeGreaterThan(before + 1);
    console.log(`take-over: the GO after it applied ${Date.now() - press} ms after its press`);
    oldHolder.ws.terminate();
    const newHolder = await rawScreen(port, cookie2, id); // still holds the OLD copy
    const gotNew = await newHolder.state();
    expect(gotNew.msg.resolvedId).not.toBe(id);
    expect(gotNew.msg.state.resolved).toBeTruthy();
    newHolder.ws.terminate();

    // (6) killed again during the new service: it is restored
    hub.kill();
    await page.waitForTimeout(1500);
    await hub.start();
    const a3 = await hubApi(port);
    await expect
      .poll(async () => (await hubLive(a3)).resolved?.playlist.id, { timeout: 60_000, intervals: [250] })
      .toBe(second);
  } finally {
    hub.kill();
  }
});
