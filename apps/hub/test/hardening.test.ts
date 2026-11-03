/** Phase D hardening (design/25): validated restore, goLive quarantine, socket limits, bounded bodies, settings invariants, decode limits, job attempts. */
import { lyricSlide, type LiveState, newId, type Presentation } from '@ordo/domain';
import { initialState } from '@ordo/live-state';
import pino from 'pino';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, openLiveDb } from '../src/db.ts';
import { MAX_JOB_ATTEMPTS, JobQueue } from '../src/jobs.ts';
import { settingsProblems } from '../src/library.ts';
import { LiveService, quarantinePresentation, SNAPSHOTS_PREV_KEEP } from '../src/live.ts';
import { checkDecodeLimits } from '../src/media/service.ts';
import { MAX_MESSAGE_BYTES, RATE_BURST } from '../src/ws.ts';
import {
  byType,
  connectWs,
  login,
  OPERATE_PIN,
  sleep,
  song,
  startHub,
  type TestHub,
  tempDir,
} from './helpers.ts';
import { join } from 'node:path';

const quiet = pino({ level: 'silent' });
let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

/** A LiveService over a bare live database, with a source that has one playlist. */
function liveOn(file: string) {
  const db = openLiveDb(file);
  const p = song();
  const pl = {
    id: 'pl',
    rev: 1,
    name: 'Sunday',
    items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }],
  };
  const live = new LiveService(
    db,
    {
      goLiveInputs: (id) =>
        id === 'pl'
          ? {
              playlist: pl,
              presentation: (pid) => (pid === p.id ? p : undefined),
              media: () => undefined,
              fonts: () => [],
              looks: [],
              general: {},
            }
          : undefined,
      settings: () => ({ outputs: [], surfaces: { messagePresets: [] } }),
    },
    quiet,
    { snapshotIntervalMs: 60_000 },
  );
  return { db, live };
}

describe('validated restore (design/25 "Journal and snapshots on disk")', () => {
  it('keeps the current and two previous snapshots, and falls back past a corrupt one', () => {
    const file = join(tempDir(), 'live.db');
    const a = liveOn(file);
    a.live.start();
    a.live.submit({ k: 'goLive', playlistId: 'pl' }, { role: 'operate' }); // snapshot at seq 1
    a.live.submit({ k: 'next', at: Date.now() }, { role: 'operate' });
    a.live.snapshot(true); // seq 2
    a.live.submit({ k: 'next', at: Date.now() }, { role: 'operate' });
    a.live.snapshot(true); // seq 3
    a.live.submit({ k: 'next', at: Date.now() }, { role: 'operate' });
    a.live.snapshot(true); // seq 4
    expect(
      (a.db.prepare(`SELECT seq FROM live_snapshot_prev ORDER BY rowid`).all() as { seq: number }[]).map(
        (r) => r.seq,
      ),
    ).toEqual([2, 3]);
    expect(SNAPSHOTS_PREV_KEEP).toBe(2);
    // Corrupt the current snapshot: valid JSON, wrong shape. Then make the newest previous one break an invariant.
    a.db.prepare(`UPDATE live_snapshot SET json = ? WHERE id = 1`).run('{"seq":4,"mode":"live"}');
    const prev3 = JSON.parse(
      (a.db.prepare(`SELECT json FROM live_snapshot_prev WHERE seq = 3`).get() as { json: string }).json,
    ) as LiveState;
    a.db
      .prepare(`UPDATE live_snapshot_prev SET json = ? WHERE seq = 3`)
      .run(JSON.stringify({ ...prev3, live: 999 }));
    a.live.stop = () => undefined; // no shutdown snapshot: the corrupt rows must stay
    a.db.close();

    const b = liveOn(file);
    b.live.restore();
    // seq 2 restored, then the journal replays 3 and 4.
    expect(b.live.state.seq).toBe(4);
    expect(b.live.state.mode).toBe('live');
    expect(b.live.restoreWarnings.join('\n')).toMatch(/current snapshot \(seq 4\) failed validation/);
    expect(b.live.restoreWarnings.join('\n')).toMatch(
      /previous snapshot 1 \(seq 3\) failed validation: live 999 out of range/,
    );
    b.db.close();
  });

  it('ends the journal replay at a corrupt row with a warning instead of throwing', () => {
    const file = join(tempDir(), 'live.db');
    const a = liveOn(file);
    a.live.start();
    a.live.submit({ k: 'goLive', playlistId: 'pl' }, { role: 'operate' });
    for (let i = 0; i < 3; i++) a.live.submit({ k: 'next', at: Date.now() }, { role: 'operate' });
    a.db.prepare(`UPDATE live_journal SET event_json = '{not json' WHERE seq = 3`).run();
    a.db.close();
    const b = liveOn(file);
    expect(() => b.live.restore()).not.toThrow();
    expect(b.live.state.seq).toBe(2);
    expect(b.live.restoreWarnings).toEqual(['journal row 3 is not valid JSON; replay stopped']);
    // A row that parses but is not an event also stops it.
    b.db.prepare(`UPDATE live_journal SET event_json = '{"k":"go"}' WHERE seq = 3`).run();
    b.live.restore();
    expect(b.live.restoreWarnings[0]).toMatch(/journal row 3 is not a live event/);
    b.db.close();
  });

  it('starts idle when every snapshot is unreadable and the journal does not continue them', () => {
    const file = join(tempDir(), 'live.db');
    const db = openLiveDb(file);
    db.prepare(`INSERT INTO live_snapshot (id, seq, json, saved_at) VALUES (1, 9, 'garbage', 0)`).run();
    db.close();
    const b = liveOn(file);
    b.live.restore();
    expect(b.live.state).toEqual(initialState());
    expect(b.live.restoreWarnings).toEqual(['current snapshot (seq 9) is not valid JSON']);
  });

  it('never adopts an operator state that breaks the invariants', async () => {
    const { live } = liveOn(join(tempDir(), 'live.db'));
    live.start();
    const bad = { ...initialState(), seq: 5, live: 3 };
    expect(live.adopt(bad)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/live 3 out of range/),
    });
  });
});

describe('goLive deep validation with quarantine', () => {
  it('replaces an invalid slide by an empty one, lists it in degraded and still goes live', async () => {
    hub = await startHub();
    const p = hub.lib.savePresentation(song('Bad slide'), { create: true });
    const pl = hub.lib.playlists.insert({
      id: newId(),
      rev: 1,
      name: 'Sunday',
      items: [{ id: newId(), kind: 'presentation', presentationId: p.id }],
    });
    // Damage the stored row behind the API's back: a text object with an absurd font size and no text.
    const stored = JSON.parse(
      (hub.db.prepare(`SELECT json FROM presentations WHERE id = ?`).get(p.id) as { json: string }).json,
    ) as Presentation;
    const badSlide = stored.sections[0]!.slides[1]!;
    (badSlide.objects[0] as unknown as Record<string, unknown>).style = { fontSizePx: 1e9 };
    hub.db.prepare(`UPDATE presentations SET json = ? WHERE id = ?`).run(JSON.stringify(stored), p.id);

    const seq = hub.live.submit({ k: 'goLive', playlistId: pl.id }, { role: 'operate' });
    expect(seq).toBe(1);
    const r = hub.live.state.resolved!;
    expect(hub.live.state.mode).toBe('live');
    expect(hub.live.state.cues.length).toBe(2);
    const slides = r.presentations[p.id]!.sections[0]!.slides;
    expect(slides[0]!.objects.length).toBe(1);
    expect(slides[1]).toEqual({ id: badSlide.id, objects: [] });
    expect(r.degraded).toEqual([
      {
        cueIndex: 1,
        presentationId: p.id,
        slideId: badSlide.id,
        reason: expect.stringMatching(/"Bad slide" Verse 1 slide 2 is invalid/),
      },
    ]);
  });

  it('resets a presentation with broken fields and drops invalid playlist items', () => {
    const raw = { ...song('Broken'), kind: 'nonsense', meta: 'x' };
    const q = quarantinePresentation(raw, raw.id);
    expect(q.presentation.kind).toBe('slides');
    expect(q.presentation.sections[0]!.slides.length).toBe(2);
    expect(q.problems[0]!.reason).toMatch(/"Broken" is damaged/);
    const hopeless = quarantinePresentation(42, 'pid');
    expect(hopeless.presentation).toMatchObject({ id: 'pid', sections: [] });
    expect(hopeless.problems[0]!.reason).toMatch(/is damaged|cannot be read/);
  });

  it('answers a clean playlist without a degraded key', async () => {
    hub = await startHub();
    const p = hub.lib.savePresentation(song(), { create: true });
    const pl = hub.lib.playlists.insert({
      id: newId(),
      rev: 1,
      name: 'Sunday',
      items: [{ id: newId(), kind: 'presentation', presentationId: p.id }],
    });
    hub.live.submit({ k: 'goLive', playlistId: pl.id }, { role: 'operate' });
    expect('degraded' in hub.live.state.resolved!).toBe(false);
  });
});

describe('WebSocket limits', () => {
  it('closes a socket that sends an oversize message or floods, and leaves the others alone', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const tok = hub.lib.getSetting('outputs')[0]!.token!;
    const out = await connectWs(hub.url, { token: tok, hello: { role: 'output' } });
    await out.next(byType('live.state'));
    const other = await connectWs(hub.url, { cookie: op.cookie });
    await other.next(byType('live.state'));

    // Another output (a second socket of the same output would supersede the first).
    const tok2 = hub.lib.getSetting('outputs')[1]!.token!;
    const big = await connectWs(hub.url, { token: tok2, hello: { role: 'output' } });
    await big.next(byType('live.state'));
    // A non-operator health message beyond 64 KiB.
    const closed = new Promise<number>((r) => big.ws.once('close', (code) => r(code)));
    big.ws.send(JSON.stringify({ t: 'health', v: 1, health: { pad: 'x'.repeat(MAX_MESSAGE_BYTES) } }));
    expect(await closed).toBe(1008);
    expect(big.messages.some((m) => m.t === 'bye' && m.reason === 'too-large')).toBe(true);

    const flood = await connectWs(hub.url, { cookie: op.cookie });
    await flood.next(byType('live.state'));
    const fclosed = new Promise<number>((r) => flood.ws.once('close', (code) => r(code)));
    for (let i = 0; i < RATE_BURST * 3; i++) flood.ws.send(JSON.stringify({ t: 'time.ping', v: 1, c: i }));
    expect(await fclosed).toBe(1008);
    expect(flood.messages.some((m) => m.t === 'bye' && m.reason === 'rate-limited')).toBe(true);
    expect(hub.sockets.limitClosures).toMatchObject({ 'too-large': 1, 'rate-limited': 1 });

    // The others still work.
    other.send({ t: 'time.ping', c: 1 });
    expect(await other.next(byType('time.pong'))).toMatchObject({ c: 1 });
    expect(out.ws.readyState).toBe(WebSocket.OPEN);
    out.close();
    other.close();
  });

  it('lets an operator adopt a large state', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const a = await connectWs(hub.url, { cookie: op.cookie });
    await a.next(byType('live.state'));
    const st = { ...initialState(), seq: 3, messages: [], pad: 'y'.repeat(200_000) };
    a.send({ t: 'live.adopt', state: st });
    expect(await a.next((m) => m.t === 'live.ack')).toMatchObject({ id: 'adopt', seq: 3 });
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    a.close();
  });

  it('applies a command sent right behind a goLive to the new playlist', async () => {
    hub = await startHub();
    const p = hub.lib.savePresentation(song(), { create: true });
    const pl = hub.lib.playlists.insert({
      id: newId(),
      rev: 1,
      name: 'Sunday',
      items: [{ id: newId(), kind: 'presentation', presentationId: p.id }],
    });
    const op = await login(hub.url, OPERATE_PIN);
    const a = await connectWs(hub.url, { cookie: op.cookie });
    await a.next(byType('live.state'));
    a.send({ t: 'live.event', id: 'g', event: { k: 'goLive', playlistId: pl.id } });
    a.send({ t: 'live.event', id: 'n', event: { k: 'go', cueIndex: 1, at: Date.now() } });
    expect(await a.next((m) => m.t === 'live.ack' && m.id === 'n')).toMatchObject({ seq: 2 });
    expect(hub.live.state.live).toBe(1);
    a.close();
  });
});

describe('bounded, strict request bodies and settings invariants', () => {
  it('refuses unknown keys and out-of-bound values', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const bad = await op.fetch('/presentations', { method: 'POST', json: { ...song(), evil: true } });
    expect(bad.status).toBe(400);
    const huge = song();
    huge.sections[0]!.slides[0] = { ...lyricSlide('x'), durationMs: 1e12 };
    expect((await op.fetch('/presentations', { method: 'POST', json: huge })).status).toBe(400);
    expect((await op.fetch('/actions', { method: 'POST', json: { id: 'next', arg: 1e12 } })).status).toBe(
      400,
    );
    expect((await op.fetch('/folders', { method: 'POST', json: { name: 'a', x: 1 } })).status).toBe(400);
    const m = await op.fetch('/settings/general', {
      method: 'PUT',
      json: { ...hub.lib.getSetting('general'), sneaky: 1 },
    });
    expect(m.status).toBe(400);
    // A theme read back from the hub (with rev and timestamps) is accepted.
    const t = (await op.json<Record<string, unknown>[]>('/themes'))[0]!;
    expect((await op.fetch(`/themes/${t.id}`, { method: 'PUT', json: t })).status).toBe(200);
  });

  it('keeps host indices unique and every output on an existing look', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const outs = hub.lib.getSetting('outputs');
    const dup = outs.map((o) => (o.hostIndex === 2 ? { ...o, hostIndex: 1 } : o));
    const r1 = await op.fetch('/settings/outputs', { method: 'PUT', json: dup });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error: { code: string } }).error.code).toBe('settings_invariant');
    const looks = hub.lib.getSetting('looks').filter((l) => l.id !== 'look-stage');
    const r2 = await op.fetch('/settings/looks', { method: 'PUT', json: looks });
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { error: { message: string } }).error.message).toMatch(
      /look-stage, which does not exist/,
    );
    expect(settingsProblems('outputs', outs, { looks: hub.lib.getSetting('looks'), outputs: outs })).toEqual(
      [],
    );
  });

  it('reads settings through their schema: defaults for missing fields, bad list items dropped', async () => {
    hub = await startHub();
    const g = JSON.parse(
      (hub.db.prepare(`SELECT json FROM settings WHERE key = 'general'`).get() as { json: string }).json,
    );
    delete g.defaultPreRollMs;
    g.clock24h = 'not a boolean';
    hub.db.prepare(`UPDATE settings SET json = ? WHERE key = 'general'`).run(JSON.stringify(g));
    const general = hub.lib.getSetting('general');
    expect(general.defaultPreRollMs).toBe(33);
    expect(general.clock24h).toBe(false);
    expect(general.timeZone).toBe(g.timeZone);
    const looks = hub.lib.getSetting('looks');
    hub.db
      .prepare(`UPDATE settings SET json = ? WHERE key = 'looks'`)
      .run(JSON.stringify([...looks, { id: 'broken' }]));
    expect(hub.lib.getSetting('looks').map((l) => l.id)).toEqual(looks.map((l) => l.id));
  });
});

describe('decode-time limits and jobs that crash their process', () => {
  it('bounds image size, video duration and resolution', () => {
    expect(() => checkDecodeLimits('image', { video: { width: 16384, height: 16384 } })).not.toThrow();
    expect(() => checkDecodeLimits('image', { video: { width: 20000, height: 100 } })).toThrow(
      /limit is 16384/,
    );
    expect(() =>
      checkDecodeLimits('video', { durationMs: 5 * 3600_000, video: { width: 1920, height: 1080 } }),
    ).toThrow(/limit is 4 h/);
    expect(() =>
      checkDecodeLimits('video', { durationMs: 1000, video: { width: 8192, height: 4320 } }),
    ).toThrow(/8K/);
    expect(() =>
      checkDecodeLimits('video', { durationMs: 1000, video: { width: 4320, height: 7680 } }),
    ).not.toThrow();
    expect(() => checkDecodeLimits('audio', { durationMs: 5 * 3600_000 })).toThrow(/Audio/);
  });

  it('fails a job for good after it was running at MAX_JOB_ATTEMPTS process deaths', async () => {
    const db = openDb(join(tempDir(), 'ordo.db'));
    const gaveUp: string[] = [];
    const make = () => {
      const q = new JobQueue(db, quiet, { heavy: 1, light: 1 }, () => undefined);
      q.register<{ x: string }>(
        'crashy',
        () => new Promise(() => undefined), // never finishes: the "process" dies under it
        (p, err) => gaveUp.push(`${p.x}: ${err}`),
      );
      return q;
    };
    const job = make().enqueue('crashy', { x: 'file.mov' });
    for (let i = 1; i <= MAX_JOB_ATTEMPTS; i++) {
      const q = make();
      q.start(); // re-queues the "running" job and starts it again
      await sleep(20);
      expect(q.attempts(job.id)).toBe(i);
      expect(q.get(job.id).state).toBe('running');
      // the process dies here (no stop())
    }
    const last = make();
    last.start();
    expect(last.get(job.id).state).toBe('failed');
    expect(last.get(job.id).error).toMatch(/Stopped 3 times/);
    expect(gaveUp).toEqual([expect.stringMatching(/^file\.mov: Stopped 3 times/)]);
    db.close();
  });
});
