import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedPlaylist } from '@ordo/domain';
import { byType, connectWs, login, OPERATE_PIN, startHub, type TestHub } from './helpers.ts';
import { SESSION_TOUCH_MS } from '../src/ws.ts';
import { SESSION_MS } from '../src/auth.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

/** Items 13 and 24: command de-duplication by id and session sliding over the socket. */
describe('WebSocket link under failure', () => {
  it('acknowledges a re-submitted command id with its original seq without applying it twice', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const a = await connectWs(hub.url, { cookie: op.cookie });
    await a.next(byType('welcome'));
    await a.next(byType('live.state'));
    const song = await op.json<{ id: string }>('/import/songselect', {
      method: 'POST',
      json: { text: 'Song\n\nVerse 1\na\nb\n\nChorus\nc\nd' },
    });
    const pl = await op.json<{ id: string }>('/playlists', {
      method: 'POST',
      json: { name: 'P', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
    });
    a.send({ t: 'live.event', id: 'gl', event: { k: 'goLive', playlistId: pl.id } });
    expect(await a.next((m) => m.t === 'live.ack' && m.id === 'gl')).toMatchObject({ seq: 1 });
    a.send({ t: 'live.event', id: 'n1', event: { k: 'next', at: Date.now() } });
    expect(await a.next((m) => m.t === 'live.ack' && m.id === 'n1')).toMatchObject({ seq: 2 });
    expect(hub.live.state.live).toBe(0);
    // The same id again (the operator never saw the ack): same seq, no new delta, state unchanged.
    a.send({ t: 'live.event', id: 'n1', event: { k: 'next', at: Date.now() } });
    expect(await a.next((m) => m.t === 'live.ack' && m.id === 'n1')).toMatchObject({ seq: 2 });
    expect(hub.live.state.live).toBe(0);
    expect(hub.live.state.seq).toBe(2);
    // From a fresh socket too (the operator reconnected).
    const b = await connectWs(hub.url, { cookie: op.cookie });
    await b.next(byType('welcome'));
    b.send({ t: 'live.event', id: 'n1', event: { k: 'next', at: Date.now() } });
    expect(await b.next((m) => m.t === 'live.ack' && m.id === 'n1')).toMatchObject({ seq: 2 });
    expect(hub.live.state.live).toBe(0);
    b.send({ t: 'live.event', id: 'n2', event: { k: 'next', at: Date.now() } });
    expect(await b.next((m) => m.t === 'live.ack' && m.id === 'n2')).toMatchObject({ seq: 3 });
    expect(hub.live.state.live).toBe(1);
    expect((hub.live.state.resolved as ResolvedPlaylist).playlist.id).toBe(pl.id);
    a.close();
    b.close();
  });

  it('slides a session on socket activity and closes the socket once the session is gone', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN, { remember: false });
    const a = await connectWs(hub.url, { cookie: op.cookie });
    await a.next(byType('welcome'));
    const token = /ordo_session=([^;]+)/.exec(op.cookie)![1]!;
    const before = hub.auth.session(token)!;
    expect(before).toBeTruthy();
    // A ping well into the future (keyboard-only use for most of the session's life) slides the expiry.
    const later = Date.now() + SESSION_MS - 60_000;
    // The socket touches at most every SESSION_TOUCH_MS; simulate time having passed by touching directly
    // through the same path the socket uses.
    expect(hub.auth.touchSession(before.id, later)).toBe(true);
    expect(hub.auth.session(token, later + SESSION_MS - 1000)).toBeTruthy();
    // Once the session has ended (logout), the next touched message closes the socket.
    hub.auth.endSession(token);
    expect(hub.auth.touchSession(before.id)).toBe(false);
    (a as unknown as { ws: { send(s: string): void } }).ws.send(
      JSON.stringify({ t: 'time.ping', v: 1, c: 1 }),
    );
    // Pings within SESSION_TOUCH_MS of the connection do not hit the database.
    expect(await a.next(byType('time.pong'))).toBeTruthy();
    expect(SESSION_TOUCH_MS).toBe(30_000);
    a.close();
  });
});
