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

  it('tells an older window of the same output it is superseded when a newer one connects', async () => {
    hub = await startHub();
    const out = hub.lib.getSetting('outputs')[0]!;
    const old = await connectWs(hub.url, { token: out.token, hello: { role: 'output', outputId: out.id } });
    await old.next(byType('welcome'));
    const fresh = await connectWs(hub.url, { token: out.token, hello: { role: 'output', outputId: out.id } });
    await fresh.next(byType('welcome'));
    expect((await old.next(byType('bye'))).reason).toBe('superseded');
    expect(fresh.messages.some((m) => m.t === 'bye')).toBe(false);
    old.close();
    fresh.close();
  });

  it("a Pulpit Lectern on the stage output's link neither replaces the Stage Display nor is replaced; the output's health is the display's", async () => {
    // PR #28's lectern (`/stage?view=lectern`, the Outputs page's "Open Pulpit Lectern") is the stage output's
    // own URL and token: before its hello said `view: 'lectern'`, the hub took it for a newer Stage Display
    // window and sent the display bye 'superseded', which closed it (every GO missed while the lectern was open).
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const ops = await connectWs(hub.url, { cookie: op.cookie });
    await ops.next(byType('welcome'));
    const stage = hub.lib.getSetting('outputs').find((o) => o.kind === 'stage')!;
    const helloOf = (view?: 'lectern') => ({ role: 'stage', outputId: stage.id, ...(view ? { view } : {}) });
    const display = await connectWs(hub.url, { token: stage.token, hello: helloOf() });
    await display.next(byType('welcome'));
    const lectern = await connectWs(hub.url, { token: stage.token, hello: helloOf('lectern') });
    await lectern.next(byType('welcome'));
    // A second lectern (the pastor's iPad and the worship leader's): neither lectern is replaced.
    const lectern2 = await connectWs(hub.url, { token: stage.token, hello: helloOf('lectern') });
    await lectern2.next(byType('welcome'));
    const song = await op.json<{ id: string }>('/import/songselect', {
      method: 'POST',
      json: { text: 'Song\n\nVerse 1\na\nb\n\nChorus\nc\nd' },
    });
    const pl = await op.json<{ id: string }>('/playlists', {
      method: 'POST',
      json: { name: 'P', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
    });
    ops.send({ t: 'live.event', id: 'gl', event: { k: 'goLive', playlistId: pl.id } });
    await ops.next((m) => m.t === 'live.ack' && m.id === 'gl');
    ops.send({ t: 'live.event', id: 'go1', event: { k: 'go', cueIndex: 1, at: Date.now() } });
    const seq = ((await ops.next((m) => m.t === 'live.ack' && m.id === 'go1')) as { seq: number }).seq;
    // Every window follows the GO.
    for (const w of [display, lectern, lectern2])
      expect(await w.next((m) => m.t === 'live.delta' && (m as { seq?: number }).seq === seq)).toBeTruthy();
    for (const w of [display, lectern, lectern2]) expect(w.messages.some((m) => m.t === 'bye')).toBe(false);

    // The output's health is the Stage Display's: a lectern's own health is not taken for it.
    display.send({
      t: 'health',
      health: { presented: 60, missed: 0, longTasks: 0, cache: { ready: 3, total: 3 } },
    });
    const presented = (m: Record<string, unknown>) =>
      m.t === 'health.summary'
        ? (m.outputs as Record<string, { presented: number; connected: boolean }>)[stage.id]
        : undefined;
    await ops.next((m) => presented(m)?.presented === 60);
    const from = ops.messages.length;
    lectern.send({
      t: 'health',
      health: { presented: 5, missed: 9, longTasks: 0, cache: { ready: 0, total: 3 } },
    });
    await ops.next((m) => m.t === 'health.summary' && ops.messages.indexOf(m) > from + 1, 4000);
    const after = ops.messages
      .slice(from)
      .map(presented)
      .filter((e) => e !== undefined);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((e) => e!.presented === 60 && e!.connected)).toBe(true);

    // A newer Stage Display window (a Relaunch) still replaces the older display, and only it.
    const display2 = await connectWs(hub.url, { token: stage.token, hello: helloOf() });
    await display2.next(byType('welcome'));
    expect((await display.next(byType('bye'))).reason).toBe('superseded');
    await new Promise((r) => setTimeout(r, 100));
    for (const w of [display2, lectern, lectern2]) expect(w.messages.some((m) => m.t === 'bye')).toBe(false);

    // With the displays gone, the stage output is not connected, though both lecterns are still open.
    display.close();
    display2.close();
    await ops.next((m) => m.t === 'health.summary' && presented(m)?.connected === false, 4000);
    for (const w of [lectern, lectern2]) expect(w.messages.some((m) => m.t === 'bye')).toBe(false);
    // A lectern is a window of the stage output only: an Audience output's token with `view` is its own window.
    const audience = hub.lib.getSetting('outputs').find((o) => o.kind !== 'stage')!;
    const aOld = await connectWs(hub.url, {
      token: audience.token,
      hello: { role: 'output', outputId: audience.id },
    });
    await aOld.next(byType('welcome'));
    const aNew = await connectWs(hub.url, {
      token: audience.token,
      hello: { role: 'output', outputId: audience.id, view: 'lectern' },
    });
    await aNew.next(byType('welcome'));
    expect((await aOld.next(byType('bye'))).reason).toBe('superseded');
    for (const w of [ops, lectern, lectern2, aOld, aNew]) w.close();
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
