/**
 * What a phone's socket may send and receive (design/28 §3.3, §10 items 1 and 9), and the Live now summary
 * without slide text. A capped socket sends hello (edit) and time.ping; receives welcome, time.pong, bye,
 * live.ack and the stripped library.delta; a live.event is refused with an ack, anything else above its cap
 * is dropped. Operate, output, stage and uncapped edit sockets run none of the new checks.
 */
import { type Playlist, newId, type Presentation } from '@ordo/domain';
import { APP_VERSION, ClientMessage, type LiveSummaryRes } from '@ordo/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_MESSAGE_CAP, SERVER_MESSAGE_CAP } from '../src/caps.ts';
import {
  byType,
  type Client,
  connectWs,
  EDIT_PIN,
  login,
  OPERATE_PIN,
  sleep,
  song,
  startHub,
  type TestHub,
} from './helpers.ts';
import { phone } from './phones-helpers.ts';

describe('the message tables', () => {
  it('list every client message type, and only hello and time.ping are below full', () => {
    const types = ClientMessage.options.map((o) => (o.shape.t as unknown as { value: string }).value).sort();
    expect(Object.keys(CLIENT_MESSAGE_CAP).sort()).toEqual(types);
    expect(Object.entries(CLIENT_MESSAGE_CAP).filter(([, c]) => c !== 'full')).toEqual([
      ['hello', 'view'],
      ['time.ping', 'view'],
    ]);
  });
  it('list every server message type; a phone receives welcome, time.pong, bye, live.ack, library.delta', () => {
    expect(
      Object.entries(SERVER_MESSAGE_CAP)
        .filter(([, c]) => c !== 'full')
        .map(([t]) => t)
        .sort(),
    ).toEqual(['bye', 'library.delta', 'live.ack', 'time.pong', 'welcome']);
    expect(Object.keys(SERVER_MESSAGE_CAP).sort()).toEqual(
      [
        'bye',
        'health.summary',
        'library.delta',
        'live.ack',
        'live.delta',
        'live.state',
        'preview',
        'rtc.signal',
        'time.pong',
        'welcome',
      ].sort(),
    );
  });
});

describe('a phone on the socket and the Live now summary', () => {
  let hub: TestHub;
  let op: Client;
  let ph: Client;
  let p: Presentation;
  let pl: Playlist;
  beforeEach(async () => {
    hub = await startHub();
    op = await login(hub.url, OPERATE_PIN);
    ph = await phone(hub.url, OPERATE_PIN);
    p = await op.json<Presentation>('/presentations', { method: 'POST', json: song() });
    pl = await op.json<Playlist>('/playlists', {
      method: 'POST',
      json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
    });
  });
  afterEach(async () => {
    await hub.cleanup();
  });

  const goLive = async () => {
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    await op.json('/live/events', { method: 'POST', json: { k: 'next', at: Date.now() } });
  };

  it('a live.event from a phone (operate PIN) is refused with forbidden: cap; live.adopt gets no answer', async () => {
    await goLive();
    const ws = await connectWs(hub.url, { cookie: ph.cookie, hello: { role: 'edit' } });
    await ws.next(byType('welcome'));
    const seq = hub.live.state.seq;
    ws.send({ t: 'live.event', id: 'p-1', event: { k: 'next', at: Date.now() } });
    // Before P0: 'forbidden: edit role' (the role check); the cap is checked first now.
    expect(await ws.next((m) => m.t === 'live.ack' && m.id === 'p-1')).toMatchObject({
      rejected: 'forbidden: cap',
    });
    ws.send({ t: 'live.adopt', state: hub.live.state, force: true });
    ws.send({ t: 'live.resync' });
    ws.send({ t: 'preview', to: 'o1', slideId: 's' });
    ws.send({ t: 'rtc.signal', to: 'operator', data: {} });
    ws.send({ t: 'health', health: { presented: 1 } });
    ws.send({ t: 'time.ping', c: 1 });
    await ws.next(byType('time.pong'));
    expect(ws.messages.filter((m) => m.t === 'live.ack').length).toBe(1);
    expect(hub.live.state.seq).toBe(seq);
    ws.close();
  });

  it('hello operate is refused; hello edit gets the welcome an iPad gets', async () => {
    const asOperate = await connectWs(hub.url, { cookie: ph.cookie, hello: { role: 'operate' } });
    expect(await asOperate.next(byType('bye'))).toMatchObject({ reason: 'forbidden' });
    const ipad = await login(hub.url, EDIT_PIN);
    const a = await connectWs(hub.url, { cookie: ph.cookie, hello: { role: 'edit' } });
    const b = await connectWs(hub.url, { cookie: ipad.cookie, hello: { role: 'edit' } });
    const wa = await a.next(byType('welcome'));
    const wb = await b.next(byType('welcome'));
    const shape = (w: Record<string, unknown>) => ({ ...w, hubMs: 0 });
    expect(shape(wa)).toEqual(shape(wb));
    expect(wa).toMatchObject({ role: 'edit', appVersion: APP_VERSION });
    a.close();
    b.close();
  });

  it('during a service a phone gets no live state, delta or health, but the library delta arrives', async () => {
    const ws = await connectWs(hub.url, { cookie: ph.cookie, hello: { role: 'edit' } });
    const opWs = await connectWs(hub.url, { cookie: op.cookie });
    await ws.next(byType('welcome'));
    await opWs.next(byType('welcome'));
    await goLive();
    await opWs.next(byType('live.delta'));
    await op.json('/presentations', { method: 'POST', json: song('Another') });
    const d = await ws.next(byType('library.delta'));
    expect((d.changes as { kind: string }[])[0]?.kind).toBe('presentation');
    await opWs.next(byType('health.summary'), 3000);
    await sleep(300);
    const kinds = new Set(ws.messages.map((m) => m.t));
    for (const t of ['live.state', 'live.delta', 'health.summary', 'rtc.signal', 'preview'])
      expect(kinds.has(t)).toBe(false);
    // The operate socket gets everything as before.
    const opKinds = new Set(opWs.messages.map((m) => m.t));
    for (const t of ['welcome', 'live.state', 'live.delta', 'health.summary', 'library.delta'])
      expect(opKinds.has(t)).toBe(true);
    ws.close();
    opWs.close();
  });

  it('the Live now summary carries no slide text for a phone; the iPad keeps its label', async () => {
    await goLive();
    const ipad = await login(hub.url, EDIT_PIN);
    const forPhone = await ph.json<LiveSummaryRes>('/live/summary');
    const forIpad = await ipad.json<LiveSummaryRes>('/live/summary');
    // Before P0 the phone got liveLabel "Amazing grace" (the live slide's text, measured at d0f49cb).
    expect(forPhone).not.toHaveProperty('liveLabel');
    expect(forPhone).toMatchObject({ mode: 'live', playlistName: 'Sunday', lockedPresentationIds: [p.id] });
    expect(forIpad.liveLabel).toBeTruthy();
    const { liveLabel: _l, ...rest } = forIpad;
    expect(forPhone).toEqual(rest);
  });
});
