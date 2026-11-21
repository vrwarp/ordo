/**
 * The live state on the wire (live-by-ref, design/29 §2.3 M2, A15): one encoded message a seq for every
 * socket, sent as a text frame, and the goLive delta assembled from the prepared text (step 2); by name for a
 * socket that holds the copy (step 5). The sockets are real `ws` clients of a real hub.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  carriesCopy,
  isLiveStateMsg,
  liveHub,
  type Raw,
  rawSocket,
  type ServerSocket,
  type ServiceHub,
  type StateMsg,
  stringifySpy,
  waitFor,
} from './byref-helpers.ts';
import { startHub, tempDir } from './helpers.ts';

let svc: ServiceHub | undefined;
afterEach(async () => {
  svc?.op.close();
  await svc?.hub.cleanup();
  svc = undefined;
});

describe('one encoded live state a seq (step 2)', () => {
  it('20 sockets say hello at one seq: the state is encoded once, the frames are the same bytes', async () => {
    svc = await liveHub(2);
    const { hub, cookie } = svc;
    const spy = stringifySpy(isLiveStateMsg);
    const socks: Raw[] = [];
    for (let i = 0; i < 20; i++) socks.push(await rawSocket(hub, cookie));
    await waitFor(() => socks.every((s) => s.of('live.state').length >= 1), 20_000, '20 states');
    spy.restore();
    expect(spy.count()).toBeLessThanOrEqual(1);
    const frames = socks.map((s) => s.frames.find((f) => f.text.includes('"t":"live.state"'))!);
    expect(new Set(frames.map((f) => f.text)).size).toBe(1);
    const state = JSON.parse(frames[0]!.text).state;
    expect(state).toEqual(JSON.parse(JSON.stringify(hub.live.state)));
    for (const s of socks) s.close();
  });

  it('a goLive of a prepared 2 MiB copy: the delta is the one JSON.stringify would make, and no message stringifies the copy', async () => {
    svc = await liveHub(2);
    const { hub, cookie } = svc;
    const watcher = await rawSocket(hub, cookie);
    await waitFor(() => watcher.of('live.state').length > 0);
    const spy = stringifySpy(carriesCopy);
    // a second service goes live beside the first (the take-over): its delta is the one broadcast
    const seqBefore = hub.live.state.seq;
    svc.op.send({ t: 'live.event', id: 'again', event: { k: 'goLive', playlistId: 'pl' } });
    await waitFor(
      () => watcher.of('live.delta').some((d) => d.event?.k === 'goLive'),
      30_000,
      'the goLive delta',
    );
    spy.restore();
    expect(spy.count()).toBe(0);
    const frame = watcher.frames.find(
      (f) => f.text.includes('"t":"live.delta"') && f.text.includes('"k":"goLive"'),
    )!;
    const got = JSON.parse(frame.text);
    delete got.resolvedId;
    const want = JSON.parse(
      JSON.stringify({
        t: 'live.delta',
        v: 1,
        seq: hub.live.state.seq,
        fromSeq: seqBefore,
        event: { k: 'goLive', resolved: hub.live.state.resolved },
        id: 'again',
      }),
    );
    expect(got).toEqual(want);
    watcher.close();
  });

  it('every frame of the live path is a text frame', async () => {
    svc = await liveHub(1);
    const { hub, cookie } = svc;
    const s = await rawSocket(hub, cookie);
    await waitFor(() => s.of('live.state').length > 0);
    svc.op.send({ t: 'live.event', id: 'n1', event: { k: 'next', at: Date.now() } });
    await waitFor(() => s.of('live.delta').length > 0);
    expect(s.frames.length).toBeGreaterThan(2);
    expect(s.frames.every((f) => f.binary === false)).toBe(true);
    s.close();
  });

  it('after a restart the first hello serialises the copy once and the second hello does not', async () => {
    const dir = tempDir();
    svc = await liveHub(1, { dataDir: dir });
    const first = svc;
    first.op.close();
    await first.hub.cleanup();
    svc = undefined;
    const hub = await startHub({ dataDir: dir });
    try {
      const { login, OPERATE_PIN } = await import('./helpers.ts');
      const c = await login(hub.url, OPERATE_PIN);
      const spy = stringifySpy(carriesCopy);
      const a = await rawSocket(hub, c.cookie);
      await waitFor(() => a.of('live.state').length > 0);
      const afterFirst = spy.count();
      const b = await rawSocket(hub, c.cookie);
      await waitFor(() => b.of('live.state').length > 0);
      spy.restore();
      expect(afterFirst).toBeLessThanOrEqual(1);
      expect(spy.count()).toBe(afterFirst);
      expect(a.frames.find((f) => f.text.includes('"live.state"'))!.text).toBe(
        b.frames.find((f) => f.text.includes('"live.state"'))!.text,
      );
      a.close();
      b.close();
    } finally {
      await hub.cleanup();
    }
  });
});

// ---- step 5: the wire by name ----

const stateFrames = (s: { frames: { text: string }[] }) =>
  s.frames.filter((f) => f.text.includes('"t":"live.state"'));
const lastState = (s: { frames: { text: string }[] }): { msg: StateMsg; bytes: number } => {
  const f = stateFrames(s).at(-1)!;
  return { msg: JSON.parse(f.text), bytes: Buffer.byteLength(f.text) };
};
const liveId = (h: ServiceHub) => h.hub.live.resolvedCopy()!.id;

describe('the state by name (step 5)', () => {
  it('a hello holding the live id gets the state without its copy, under a quarter of the whole frame', async () => {
    svc = await liveHub(2);
    const { hub, cookie } = svc;
    const id = liveId(svc);
    const whole = await rawSocket(hub, cookie, { resolvedId: 'f'.repeat(64) });
    await waitFor(() => stateFrames(whole).length > 0);
    const small = await rawSocket(hub, cookie, { resolvedId: id });
    await waitFor(() => stateFrames(small).length > 0);
    const a = lastState(whole);
    const b = lastState(small);
    expect(a.msg.resolvedId).toBe(id);
    expect(a.msg.state.resolved).toBeTruthy();
    expect(b.msg.resolvedId).toBe(id);
    expect(b.msg.state.resolved).toBeUndefined();
    expect(b.msg.state.cues.length).toBe(hub.live.state.cues.length);
    expect(b.msg.state.seq).toBe(a.msg.state.seq);
    expect(b.bytes).toBeLessThan(0.25 * a.bytes);
    whole.close();
    small.close();
  });

  it('a hello holding nothing, another id or a 500-character string is sent the whole state and the id', async () => {
    svc = await liveHub(1);
    const { hub, cookie } = svc;
    const id = liveId(svc);
    for (const resolvedId of [undefined, 'a'.repeat(64), 'x'.repeat(500)]) {
      const s = await rawSocket(hub, cookie, resolvedId === undefined ? {} : { resolvedId });
      await waitFor(() => stateFrames(s).length > 0);
      const m = lastState(s).msg;
      expect(m.state.resolved?.playlist?.id).toBe('pl');
      expect(m.resolvedId).toBe(id);
      s.close();
    }
  });

  it('a resync holding the id gets the small state; a resync that says nothing gets the whole one, and then holds it', async () => {
    svc = await liveHub(1);
    const { hub, cookie } = svc;
    const id = liveId(svc);
    const s = await rawSocket(hub, cookie, { resolvedId: id });
    await waitFor(() => stateFrames(s).length > 0);
    expect(lastState(s).msg.state.resolved).toBeUndefined();
    s.send({ t: 'live.resync', resolvedId: id });
    await waitFor(() => stateFrames(s).length > 1);
    expect(lastState(s).msg.state.resolved).toBeUndefined();
    s.send({ t: 'live.resync' });
    await waitFor(() => stateFrames(s).length > 2);
    expect(lastState(s).msg.state.resolved).toBeTruthy();
    // it was sent the copy, so the hub counts it as holding it: a recovery state is by name
    const client = [...(hub.sockets as unknown as { clients: Set<{ holds?: string }> }).clients].find(
      (c) => c.holds,
    );
    expect(client?.holds).toBe(id);
    s.close();
  });

  it('20 sockets holding the id say hello at one seq: one small encoding, the same bytes; 20 holding nothing: one whole encoding', async () => {
    svc = await liveHub(2);
    const { hub, cookie } = svc;
    const id = liveId(svc);
    const run = async (hello: Record<string, unknown>) => {
      const spy = stringifySpy((a) => isLiveStateMsg(a) || carriesCopy(a));
      const socks: Raw[] = [];
      for (let i = 0; i < 20; i++) socks.push(await rawSocket(hub, cookie, hello));
      await waitFor(() => socks.every((x) => stateFrames(x).length >= 1), 20_000, '20 states');
      spy.restore();
      const texts = new Set(socks.map((x) => stateFrames(x)[0]!.text));
      for (const x of socks) x.close();
      return { n: spy.count(), distinct: texts.size, one: [...texts][0]! };
    };
    const held = await run({ resolvedId: id });
    expect(held.n).toBeLessThanOrEqual(1);
    expect(held.distinct).toBe(1);
    expect(JSON.parse(held.one).state.resolved).toBeUndefined();
    // each socket that was sent the copy now holds it, so a second round of hellos with nothing is a new socket: whole
    const none = await run({});
    expect(none.n).toBe(0);
    expect(none.distinct).toBe(1);
    expect(JSON.parse(none.one).state.resolved).toBeTruthy();
  });

  it('a socket holding the old copy that reconnects after a take-over is sent the new copy whole, never the old one', async () => {
    svc = await liveHub(1);
    const { hub, cookie } = svc;
    const r1 = liveId(svc);
    const hub2 = hub.live as unknown as { source: { bundle: unknown } };
    // the second service: the same playlist with one presentation's title changed (the copy's bytes differ)
    const { bigBundle, bundleBytes, bundleSource } = await import('./byref-helpers.ts');
    const b = bigBundle(1) as { presentations: Record<string, { title: string }> };
    const second = bundleBytes(b);
    hub2.source.bundle = bundleSource({ pl: second }).bundle;
    svc.op.send({ t: 'live.event', id: 'take-over', event: { k: 'goLive', playlistId: 'pl' } });
    await waitFor(() => svc!.op.of('live.ack').some((a) => a.id === 'take-over'), 30_000, 'the take-over');
    const r2 = liveId(svc);
    expect(r2).not.toBe(r1);
    const s = await rawSocket(hub, cookie, { resolvedId: r1 });
    await waitFor(() => stateFrames(s).length > 0);
    const m = lastState(s).msg;
    expect(m.resolvedId).toBe(r2);
    expect(m.state.resolved).toBeTruthy();
    expect(JSON.stringify(m.state.resolved)).toBe(Buffer.from(hub.live.resolvedCopy()!.json).toString());
    s.close();
  });

  it('after an adopt, sockets holding the old id get the adopted state whole, and one holding the adopted id gets it by name', async () => {
    svc = await liveHub(1);
    const { hub, cookie } = svc;
    const idOld = liveId(svc);
    const old = await rawSocket(hub, cookie, { resolvedId: idOld });
    await waitFor(() => stateFrames(old).length > 0);
    const incoming = JSON.parse(JSON.stringify(hub.live.state));
    incoming.resolved.playlist.name = 'Adopted from the operator';
    incoming.seq = hub.live.state.seq + 5;
    const before = stateFrames(old).length;
    svc.op.send({ t: 'live.adopt', state: incoming, force: true });
    await waitFor(() => stateFrames(old).length > before, 20_000, 'the adopt broadcast');
    const m = lastState(old).msg;
    const idNew = liveId(svc);
    expect(idNew).not.toBe(idOld);
    expect(m.resolvedId).toBe(idNew);
    expect(m.state.resolved?.playlist?.name).toBe('Adopted from the operator');
    const again = await rawSocket(hub, cookie, { resolvedId: idNew });
    await waitFor(() => stateFrames(again).length > 0);
    expect(lastState(again).msg.state.resolved).toBeUndefined();
    old.close();
    again.close();
  });

  it('a slow socket that holds the live id gets the small state when its queue drains; one that missed a goLive delta gets the new copy', async () => {
    // no health summaries (an operate socket gets one every interval, and each send drains the queue): the only
    // message that does is the ping this test sends
    svc = await liveHub(1, { healthIntervalMs: 600_000 });
    const { hub, cookie } = svc;
    const id = liveId(svc);
    const serverSide = () => [...(hub.sockets as unknown as { clients: Set<ServerSocket> }).clients];
    const s = await rawSocket(hub, cookie, { resolvedId: id });
    await waitFor(() => stateFrames(s).length > 0);
    const mine = serverSide().at(-1);
    expect(mine?.holds).toBe(id);
    const n0 = stateFrames(s).length;
    // the socket's queue overflowed: it gets a state once a send of its drains
    mine!.needsState = true;
    s.send({ t: 'time.ping', c: 1 });
    await waitFor(() => stateFrames(s).length > n0, 10_000, 'the recovery state');
    expect(lastState(s).msg.state.resolved).toBeUndefined();
    // now it misses a goLive delta while its queue is over
    const { bigBundle, bundleBytes, bundleSource } = await import('./byref-helpers.ts');
    (hub.live as unknown as { source: { bundle: unknown } }).source.bundle = bundleSource({
      pl: bundleBytes(bigBundle(1)),
    }).bundle;
    mine!.needsState = true;
    const n1 = stateFrames(s).length;
    svc.op.send({ t: 'live.event', id: 'again-2', event: { k: 'goLive', playlistId: 'pl' } });
    await waitFor(() => svc!.op.of('live.ack').some((a) => a.id === 'again-2'), 30_000, 'the goLive');
    s.send({ t: 'time.ping', c: 2 });
    await waitFor(() => stateFrames(s).length > n1, 10_000, 'the recovery state');
    const m = lastState(s).msg;
    expect(m.resolvedId).toBe(liveId(svc));
    expect(m.state.resolved).toBeTruthy();
    s.close();
  });

  it('with the switch off no frame carries resolvedId and every state is whole', async () => {
    svc = await liveHub(1, { liveByRef: false });
    const { hub, cookie } = svc;
    const s = await rawSocket(hub, cookie, { resolvedId: 'a'.repeat(64) });
    await waitFor(() => stateFrames(s).length > 0);
    s.send({ t: 'live.resync', resolvedId: 'b'.repeat(64) });
    svc.op.send({ t: 'live.event', id: 'n', event: { k: 'next', at: Date.now() } });
    await waitFor(() => s.of('live.delta').length > 0);
    expect(s.frames.some((f) => f.text.includes('resolvedId'))).toBe(false);
    for (const f of stateFrames(s)) expect(JSON.parse(f.text).state.resolved).toBeTruthy();
    expect(svc.op.frames.some((f) => f.text.includes('resolvedId'))).toBe(false);
    s.close();
  });
});
