import { type Font, type LiveState, type Media, newId, type Playlist, type Presentation, type ResolvedPlaylist } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { byType, client, connectWs, login, OPERATE_PIN, sleep, song, startHub, type TestHub } from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

function fakeMedia(h: TestHub, state: Media['state'] = 'ready', name = 'bg'): Media {
  const hash = newId().toLowerCase().padEnd(64, '0').slice(0, 64);
  const m = h.lib.media.insert({
    id: newId(),
    rev: 1,
    name,
    tags: [],
    kind: 'video',
    original: { hash, bytes: 10, mime: 'video/mp4', path: `media/${hash.slice(0, 2)}/${hash}.mp4` },
    delivery: { hash: `d${hash.slice(1)}`, bytes: 5, mime: 'video/mp4', path: 'x' },
    poster: { hash: `p${hash.slice(1)}`, bytes: 1, mime: 'image/jpeg', path: 'y' },
    state,
    loop: true,
    isBackground: true,
  });
  return m;
}

function fakeFont(h: TestHub, family: string, weight: number): Font {
  const hash = `f${weight}`.padEnd(64, 'a');
  return h.lib.upsertFont({ family, weight, style: 'normal', file: { hash, bytes: 3, mime: 'font/woff2', path: `fonts/${hash}.woff2` }, source: 'upload' });
}

async function setup(h: TestHub) {
  const bg = fakeMedia(h);
  const p = h.lib.savePresentation({ ...song(), backgroundMediaId: bg.id }, { create: true });
  const loop: Presentation = {
    ...song('Announcements'),
    kind: 'loop',
    loop: { defaultSlideMs: 1000 },
  };
  const lp = h.lib.savePresentation(loop, { create: true });
  const pl = h.lib.playlists.insert({
    id: newId(),
    rev: 1,
    name: 'Sunday',
    items: [
      { id: newId(), kind: 'presentation', presentationId: p.id },
      { id: newId(), kind: 'presentation', presentationId: lp.id },
    ],
  });
  return { bg, p, lp, pl };
}

describe('goLive resolution and manifest', () => {
  it('resolves presentations, media, fonts (all weights of used families), looks and files', async () => {
    hub = await startHub();
    const { bg, p, pl } = await setup(hub);
    fakeFont(hub, 'Inter', 400);
    fakeFont(hub, 'Inter', 700);
    fakeFont(hub, 'Unused', 400);
    const op = await login(hub.url, OPERATE_PIN);
    const r = await op.json<{ seq: number }>('/live/events', { method: 'POST', json: { id: 'c1', event: { k: 'goLive', playlistId: pl.id } } });
    expect(r.seq).toBe(1);
    const live = await op.json<{ state: LiveState }>('/live');
    const res = live.state.resolved!;
    expect(live.state.mode).toBe('live');
    expect(Object.keys(res.presentations)).toContain(p.id);
    expect(Object.keys(res.media)).toEqual([bg.id]);
    expect(res.fonts.map((f) => `${f.family}:${f.weight}`).sort()).toEqual(['Inter:400', 'Inter:700']);
    expect(res.looks.length).toBe(4);
    expect(res.files.map((f) => f.hash).sort()).toEqual(
      [bg.delivery!.hash, bg.poster!.hash, ...res.fonts.map((f) => f.file.hash)].sort(),
    );
    const manifest = await op.json<{ manifestId: string; files: unknown[]; resolved: ResolvedPlaylist }>('/cache/manifest');
    expect(manifest.manifestId).toBe(res.manifestId);
    expect(manifest.files.length).toBe(4);
    // A token reads the same manifest.
    const tok = hub.lib.getSetting('outputs')[0]!.token!;
    expect((await client(hub.url, '', { 'x-ordo-token': tok }).json<{ manifestId: string }>('/cache/manifest')).manifestId).toBe(
      res.manifestId,
    );
  });

  it('refuses to go live while referenced media is not ready', async () => {
    hub = await startHub();
    const { pl } = await setup(hub);
    const pending = fakeMedia(hub, 'processing', 'Countdown');
    const p2 = hub.lib.playlists.update(pl.id, {
      ...pl,
      items: [...pl.items, { id: newId(), kind: 'media', mediaId: pending.id }],
    });
    const op = await login(hub.url, OPERATE_PIN);
    const res = await op.fetch('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: p2.id } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/"Countdown" is still processing/);
    // A client-resolved goLive is never accepted.
    const forged = await op.fetch('/live/events', { method: 'POST', json: { k: 'goLive', resolved: {} } });
    expect(forged.status).toBeGreaterThanOrEqual(400);
  });

  it('maps /actions through actionToEvent with at = now + 33 ms', async () => {
    hub = await startHub();
    const { pl } = await setup(hub);
    const op = await login(hub.url, OPERATE_PIN);
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    const before = Date.now();
    const r = await op.json<{ seq: number }>('/actions', { method: 'POST', json: { id: 'next' } });
    expect(r.seq).toBe(2);
    expect(hub.live.state.live).toBe(0);
    const at = hub.live.state.layers.slide.at;
    expect(at).toBeGreaterThanOrEqual(before + 33);
    expect(at).toBeLessThan(Date.now() + 100);
    expect(await op.json('/actions', { method: 'POST', json: { id: 'launchOutputs' } })).toMatchObject({ ignored: true });
    expect((await op.fetch('/actions', { method: 'POST', json: { id: 'bogus' } })).status).toBe(400);
  });

  it('auto-advances loop presentations', async () => {
    hub = await startHub();
    const { pl } = await setup(hub);
    hub.live.submit({ k: 'goLive', playlistId: pl.id }, { role: 'operate' });
    // Loop presentation starts at cue 2 (after two song slides).
    hub.live.submit({ k: 'go', cueIndex: 2, at: Date.now() }, { role: 'operate' });
    expect(hub.live.state.live).toBe(2);
    await sleep(500);
    expect(hub.live.state.live).toBe(2);
    await sleep(800);
    expect(hub.live.state.live).toBe(3);
    expect(hub.live.state.layers.slide.at - hub.live.state.cues.length).toBeGreaterThan(0);
    await sleep(1000);
    expect(hub.live.state.live).toBe(2); // wraps within the item
  });
});

describe('WebSocket live flow', () => {
  it('hello → welcome + state; event → ack + delta to everyone; resync; time sync', async () => {
    hub = await startHub();
    const { pl } = await setup(hub);
    const op = await login(hub.url, OPERATE_PIN);
    const out = hub.lib.getSetting('outputs')[0]!;
    const a = await connectWs(hub.url, { cookie: op.cookie });
    const w = await a.next(byType('welcome'));
    expect(w).toMatchObject({ role: 'operate', seq: 0, appVersion: '0.1.0' });
    expect(typeof w.hubMs).toBe('number');
    expect((await a.next(byType('live.state'))).seq).toBe(0);
    const o = await connectWs(hub.url, { token: out.token, hello: { role: 'output', outputId: out.id } });
    expect((await o.next(byType('welcome'))).role).toBe('output');
    await o.next(byType('live.state'));

    a.send({ t: 'live.event', id: 'e1', event: { k: 'goLive', playlistId: pl.id } });
    const ack = await a.next(byType('live.ack'));
    expect(ack).toMatchObject({ id: 'e1', seq: 1 });
    const d = await o.next(byType('live.delta'));
    expect(d).toMatchObject({ seq: 1, fromSeq: 0, id: 'e1' });
    expect((d.event as { k: string; resolved: ResolvedPlaylist }).resolved.playlist.id).toBe(pl.id);
    a.send({ t: 'live.event', id: 'e2', event: { k: 'next', at: Date.now() + 33 } });
    expect(await o.next(byType('live.delta'))).toMatchObject({ seq: 2, fromSeq: 1, id: 'e2' });
    a.send({ t: 'live.event', id: 'bad', event: { k: 'nope' } });
    // Invalid messages are dropped (schema), unknown playlists are rejected with a reason.
    a.send({ t: 'live.event', id: 'e3', event: { k: 'goLive', playlistId: 'missing' } });
    expect((await a.next((m) => m.t === 'live.ack' && m.id === 'e3')).rejected).toMatch(/not found/);

    o.send({ t: 'live.resync' });
    const st = await o.next(byType('live.state'));
    expect(st.seq).toBe(2);
    expect((st.state as LiveState).live).toBe(0);

    const c = Date.now();
    o.send({ t: 'time.ping', c });
    const pong = await o.next(byType('time.pong'));
    expect(pong.c).toBe(c);
    expect(Math.abs((pong.s as number) - Date.now())).toBeLessThan(1000);

    // Outputs may only send media.ended / audio.ended.
    o.send({ t: 'live.event', id: 'o1', event: { k: 'next', at: 1 } });
    expect((await o.next(byType('live.ack'))).rejected).toMatch(/only report/);
    o.send({ t: 'live.event', id: 'o2', event: { k: 'media.ended', cueIndex: 0, at: 1 } });
    expect((await o.next(byType('live.ack'))).rejected).toMatch(/stale/);
    a.close();
    o.close();
  });

  it('rejects stale app versions, bad origins and tokenless sockets', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const v = await connectWs(hub.url, { cookie: op.cookie, hello: { role: 'operate', appVersion: '0.0.1' } });
    expect((await v.next(byType('bye'))).reason).toBe('version');
    const anon = await connectWs(hub.url, { hello: { role: 'operate' } });
    expect((await anon.next(byType('bye'))).reason).toBe('unauthorized');
    await expect(connectWs(hub.url, { cookie: op.cookie, origin: 'https://evil.example' })).rejects.toThrow(/403/);
    const ok = await connectWs(hub.url, { cookie: op.cookie, origin: 'http://op.localhost:8080' });
    await ok.next(byType('welcome'));
    ok.close();
  });

  it('aggregates health once per second and relays rtc signalling', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const outs = hub.lib.getSetting('outputs');
    const out = outs[0]!;
    const a = await connectWs(hub.url, { cookie: op.cookie });
    await a.next(byType('welcome'));
    const o = await connectWs(hub.url, { token: out.token, hello: { role: 'output', outputId: out.id } });
    await o.next(byType('welcome'));
    o.send({ t: 'health', health: { presented: 60, missed: 0, longTasks: 0, cache: { ready: 3, total: 4 } } });
    const hs = await a.next((m) => {
      if (m.t !== 'health.summary') return false;
      const e = (m.outputs as Record<string, { presented: number; connected: boolean }>)[out.id];
      return e?.presented === 60;
    });
    const entries = hs.outputs as Record<string, { connected: boolean; name: string; lastSeen: number }>;
    expect(entries[out.id]).toMatchObject({ connected: true, name: 'Audience 1' });
    expect(entries[outs[1]!.id]).toMatchObject({ connected: false, name: 'Audience 2', lastSeen: 0 });

    a.send({ t: 'rtc.signal', to: out.id, sdp: { type: 'offer', sdp: 'x' } });
    expect(await o.next(byType('rtc.signal'))).toMatchObject({ from: 'operator', to: out.id });
    o.send({ t: 'rtc.signal', to: 'operator', sdp: { type: 'answer', sdp: 'y' } });
    expect(await a.next(byType('rtc.signal'))).toMatchObject({ from: out.id, to: 'operator' });

    o.close();
    await a.next((m) => m.t === 'health.summary' && !(m.outputs as Record<string, { connected: boolean }>)[out.id]!.connected);
    a.close();
  });

  it('adopts operator state per design/17', async () => {
    hub = await startHub();
    const { pl } = await setup(hub);
    const op = await login(hub.url, OPERATE_PIN);
    // Operator state from degraded mode: live on pl at seq 10.
    hub.live.submit({ k: 'goLive', playlistId: pl.id }, { role: 'operate' });
    const opState: LiveState = { ...hub.live.state, seq: 10, live: 1 };
    // Hub restarted idle → accepts.
    hub.live.state = { ...hub.live.state, mode: 'idle', resolved: undefined, seq: 3 };
    const a = await connectWs(hub.url, { cookie: op.cookie });
    await a.next(byType('live.state'));
    a.send({ t: 'live.adopt', state: opState });
    expect(await a.next(byType('live.ack'))).toMatchObject({ id: 'adopt', seq: 10 });
    const st = await a.next(byType('live.state'));
    expect(st.seq).toBe(10);
    expect(hub.live.state.live).toBe(1);
    // Same playlist but hub newer → refused, operator gets the hub's state.
    a.send({ t: 'live.adopt', state: { ...opState, seq: 5 } });
    expect((await a.next(byType('live.ack'))).rejected).toMatch(/newer/);
    await a.next(byType('live.state'));
    // Different playlist → refused unless forced.
    const other = hub.lib.playlists.insert({ ...pl, id: newId() } as Playlist);
    const otherState = { ...opState, seq: 20, resolved: { ...opState.resolved!, playlist: other } };
    a.send({ t: 'live.adopt', state: otherState });
    expect((await a.next(byType('live.ack'))).rejected).toMatch(/different playlist/);
    a.send({ t: 'live.adopt', state: otherState, force: true });
    expect(await a.next((m) => m.t === 'live.ack' && !m.rejected)).toMatchObject({ seq: 20 });
    expect(hub.live.state.resolved?.playlist.id).toBe(other.id);
    a.close();
  });

  it('restores live state after a restart from snapshot + journal', async () => {
    const first = await startHub();
    const dir = first.dir;
    const { pl } = await setup(first);
    first.live.submit({ k: 'goLive', playlistId: pl.id }, { role: 'operate' });
    first.live.submit({ k: 'next', at: Date.now() }, { role: 'operate' });
    first.live.submit({ k: 'next', at: Date.now() }, { role: 'operate' });
    await first.close();
    hub = await startHub({ dataDir: dir });
    expect(hub.live.state.seq).toBe(3);
    expect(hub.live.state.mode).toBe('live');
    expect(hub.live.state.live).toBe(1);
    // Journal replay without a fresh snapshot.
    hub.live.submit({ k: 'next', at: Date.now() }, { role: 'operate' });
    hub.live.restore();
    expect(hub.live.state.seq).toBe(4);
    expect(hub.live.journalTail(10).map((j) => j.seq)).toEqual([1, 2, 3, 4]);
  });
});
