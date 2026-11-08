import { describe, expect, it } from 'vitest';
import {
  jsonBytes,
  type LiveEvent,
  type LiveState,
  parseLyrics,
  type ResolvedPlaylist,
  SIZE_BUDGETS,
  songFromParsed,
} from '@ordo/domain';
import { initialState, reduce } from '@ordo/live-state';
import type { LiveDeltaMsg } from '@ordo/protocol';
import { type HubOut, LiveCore, type LiveCoreDeps, type LiveNotice } from '../src/lib/liveCore.ts';

function resolved(id = 'pl', name = 'Sunday'): ResolvedPlaylist {
  const a = songFromParsed(parseLyrics('Verse 1\na\nb\n\nChorus\nc\nd'), { linesPerSlide: 1 });
  return {
    playlist: { id, rev: 1, name, items: [{ id: 'i0', kind: 'presentation', presentationId: a.id }] },
    presentations: { [a.id]: a },
    media: {},
    fonts: [],
    looks: [],
    files: [],
    manifestId: 'm',
  };
}

/** A fake hub running the real reducer, plus fake fallback bus and timers. */
function harness(seed?: LiveState, extra: Partial<LiveCoreDeps> = {}) {
  const sent: HubOut[] = [];
  const notices: LiveNotice[] = [];
  const deltas: LiveDeltaMsg[] = [];
  const timers: { fn: () => void; ms: number; id: number; cleared: boolean }[] = [];
  let tid = 0;
  let nid = 0;
  const fb = {
    active: false,
    activated: 0,
    deactivated: 0,
    hold: false,
    last: undefined as LiveState | undefined,
  };
  let clockFallback = false;
  let hubUp = true;
  const core = new LiveCore(
    {
      sendHub: (m) => {
        if (!hubUp) return false;
        sent.push(m);
        return true;
      },
      fallback: {
        activate: (s, o) => {
          fb.active = true;
          fb.activated++;
          fb.hold = !!o?.hold;
          fb.last = s;
        },
        setHold: (on) => {
          fb.hold = on;
        },
        deactivate: () => {
          fb.active = false;
          fb.hold = false;
          fb.deactivated++;
        },
        broadcastDelta: (d, s) => {
          deltas.push(d);
          fb.last = s;
        },
      },
      setClockFallback: (on) => {
        clockFallback = on;
      },
      newId: () => `id${++nid}`,
      setTimer: (fn, ms) => {
        const t = { fn, ms, id: ++tid, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        (t as { cleared: boolean }).cleared = true;
      },
      onChange: () => undefined,
      onNotice: (n) => notices.push(n),
      ...extra,
    },
    seed,
  );
  const fire = (ms: number) => {
    for (const t of timers)
      if (!t.cleared && t.ms === ms) {
        t.cleared = true;
        t.fn();
      }
  };
  return {
    core,
    sent,
    notices,
    deltas,
    fb,
    fire,
    timers,
    setHub: (up: boolean) => {
      hubUp = up;
    },
    get clockFallback() {
      return clockFallback;
    },
  };
}

function liveHub(): LiveState {
  return reduce(initialState(), { k: 'goLive', resolved: resolved() });
}

describe('LiveCore hub mode', () => {
  it('applies optimistically, rebases on deltas and acks', () => {
    const h = harness();
    h.core.onStatus(true);
    let hub = liveHub();
    h.core.onState(hub);
    h.core.submit({ k: 'next', at: 10 });
    expect(h.core.view.live).toBe(0);
    expect(h.core.pendingCount).toBe(1);
    const ev = h.sent[0] as { t: 'live.event'; id: string; event: LiveEvent };
    expect(ev.t).toBe('live.event');
    const from = hub.seq;
    hub = reduce(hub, ev.event);
    h.core.onDelta({ seq: hub.seq, fromSeq: from, event: ev.event, id: ev.id });
    expect(h.core.pendingCount).toBe(0);
    expect(JSON.stringify(h.core.view)).toBe(JSON.stringify(hub));
  });

  it('rolls back a rejected event and reports it', () => {
    const h = harness();
    h.core.onStatus(true);
    h.core.onState(liveHub());
    const id = h.core.submit({ k: 'next', at: 1 });
    h.core.onAck({ id, rejected: 'nope' });
    expect(h.core.view.live).toBeUndefined();
    expect(h.notices[0]).toMatchObject({ kind: 'rejected', reason: 'nope' });
  });

  it('resyncs on a sequence gap and ignores deltas until the state arrives', () => {
    const h = harness();
    h.core.onStatus(true);
    const hub = liveHub();
    h.core.onState(hub);
    h.core.onDelta({ seq: hub.seq + 5, fromSeq: hub.seq + 4, event: { k: 'next', at: 1 } });
    expect(h.sent.at(-1)).toEqual({ t: 'live.resync' });
    h.core.onDelta({ seq: hub.seq + 6, fromSeq: hub.seq + 5, event: { k: 'next', at: 1 } });
    expect(h.core.view.seq).toBe(hub.seq);
    const later = reduce(hub, { k: 'next', at: 2 });
    h.core.onState(later);
    expect(h.core.view.live).toBe(0);
  });

  it('sends goLive without applying it locally', () => {
    const h = harness();
    h.core.onStatus(true);
    h.core.submit({ k: 'goLive', playlistId: 'pl' });
    expect(h.core.view.mode).toBe('idle');
    expect(h.sent[0]).toMatchObject({ t: 'live.event', event: { k: 'goLive' } });
  });

  it('re-submits a command whose ack was lost in a socket blip with its original id (item 13)', () => {
    const h = harness();
    h.core.onStatus(true);
    const hub = liveHub();
    h.core.onState(hub);
    const id = h.core.submit({ k: 'next', at: 5 });
    expect(h.sent.at(-1)).toMatchObject({ t: 'live.event', id });
    expect(h.core.view.live).toBe(0);
    // The socket drops before any ack or delta arrives; the hub may or may not have applied it.
    h.core.onStatus(false);
    h.core.onStatus(true);
    h.sent.length = 0;
    h.core.onState(hub); // the hub's state on reconnect does not show the command
    expect(h.sent).toEqual([{ t: 'live.event', id, event: { k: 'next', at: 5 } }]);
    expect(h.core.view.live).toBe(0); // no snap back
    expect(h.core.pendingCount).toBe(1);
    // The hub had journalled it: it acks the id with the seq it got, and the delta (or state) confirms it.
    const applied = reduce(hub, { k: 'next', at: 5 });
    h.core.onDelta({ seq: applied.seq, fromSeq: hub.seq, event: { k: 'next', at: 5 }, id });
    h.core.onAck({ id, seq: applied.seq });
    expect(h.core.pendingCount).toBe(0);
    expect(h.core.view.live).toBe(0);
    // Confirmed commands are not re-sent on the next full state.
    h.sent.length = 0;
    h.core.onState(applied);
    expect(h.sent).toEqual([]);
  });

  it('does not re-submit commands the hub rejected or confirmed, and drops stale ones', () => {
    let now = 1000;
    const h = harness();
    (h.core as unknown as { deps: { now: () => number } }).deps.now = () => now;
    h.core.onStatus(true);
    const hub = liveHub();
    h.core.onState(hub);
    const a = h.core.submit({ k: 'next', at: 1 });
    const b = h.core.submit({ k: 'next', at: 2 });
    const c = h.core.submit({ k: 'next', at: 3 });
    h.core.onAck({ id: a, rejected: 'no' });
    h.core.onAck({ id: b, seq: hub.seq + 1 });
    h.sent.length = 0;
    h.core.onState(hub);
    expect(h.sent.map((m) => (m as { id?: string }).id)).toEqual([c]);
    now += 61_000;
    h.sent.length = 0;
    h.core.onState(hub);
    expect(h.sent).toEqual([]);
  });

  it('re-sends commands made during a short disconnect', () => {
    const h = harness();
    h.core.onStatus(true);
    const hub = liveHub();
    h.core.onState(hub);
    h.core.onStatus(false);
    h.setHub(false);
    h.core.submit({ k: 'next', at: 5 });
    expect(h.core.view.live).toBe(0);
    h.setHub(true);
    h.core.onStatus(true);
    h.core.onState(hub);
    expect(h.sent.at(-1)).toMatchObject({ t: 'live.event', event: { k: 'next' } });
    expect(h.core.view.live).toBe(0);
    expect(h.fb.activated).toBe(0);
  });
});

describe('LiveCore fallback authority', () => {
  it('activates after the grace period only while live', () => {
    const idle = harness();
    idle.core.onStatus(true);
    idle.core.onStatus(false);
    expect(idle.timers).toHaveLength(0);

    const h = harness();
    h.core.onStatus(true);
    h.core.onState(liveHub());
    h.core.onStatus(false);
    h.core.onStatus(true); // back within the grace period
    h.fire(5000);
    expect(h.fb.activated).toBe(0);
    h.core.onStatus(false);
    h.fire(5000);
    expect(h.fb.activated).toBe(1);
    expect(h.core.authority).toBe('fallback');
    expect(h.clockFallback).toBe(true);
    expect(h.notices.some((n) => n.kind === 'fallback-on')).toBe(true);
  });

  it('applies events with the reducer and broadcasts deltas continuing the sequence', () => {
    const h = harness();
    h.core.onStatus(true);
    const hub = liveHub();
    h.core.onState(hub);
    h.core.onStatus(false);
    h.setHub(false);
    h.core.submit({ k: 'next', at: 100 }); // pending, unsent
    h.fire(5000);
    expect(h.fb.last?.live).toBe(0); // the unsent optimistic event is part of the fallback state
    h.core.submit({ k: 'next', at: 200 });
    expect(h.deltas).toHaveLength(1);
    expect(h.deltas[0]).toMatchObject({ fromSeq: hub.seq + 1, seq: hub.seq + 2 });
    expect(h.core.view.live).toBe(1);
    h.core.submit({ k: 'goLive', playlistId: 'x' });
    expect(h.notices.at(-1)?.kind).toBe('unavailable');
    h.core.externalEvent({ k: 'media.ended', cueIndex: 0, at: 1 });
    expect(h.deltas).toHaveLength(2);
  });

  function inFallback() {
    const h = harness();
    h.core.onStatus(true);
    const hub = liveHub();
    h.core.onState(hub);
    h.core.onStatus(false);
    h.setHub(false);
    h.fire(5000);
    h.core.submit({ k: 'next', at: 100 });
    h.core.submit({ k: 'next', at: 200 });
    h.setHub(true);
    return { h, hub };
  }

  it('adopts when the hub returns with the same playlist and a lower seq', () => {
    const { h, hub } = inFallback();
    const local = h.core.view;
    h.core.onStatus(true);
    h.core.onWelcome();
    h.core.onState(hub);
    expect(h.sent.at(-1)).toMatchObject({ t: 'live.adopt', state: local });
    expect(h.core.authority).toBe('fallback');
    // Hub adopts and broadcasts the full state.
    h.core.onState({ ...local });
    expect(h.core.authority).toBe('hub');
    expect(h.fb.deactivated).toBe(1);
    expect(h.clockFallback).toBe(false);
    expect(h.core.view.live).toBe(1);
  });

  it('adopts into an idle (restarted) hub', () => {
    const { h } = inFallback();
    h.core.onWelcome();
    h.core.onState(initialState());
    expect(h.sent.at(-1)).toMatchObject({ t: 'live.adopt' });
  });

  it('takes the hub state when it is newer for the same playlist', () => {
    const { h, hub } = inFallback();
    const newer = { ...hub, seq: hub.seq + 10 };
    h.core.onWelcome();
    h.core.onState(newer);
    expect(h.core.authority).toBe('hub');
    expect(h.notices.some((n) => n.kind === 'hub-newer')).toBe(true);
  });

  it('hands back silently when the hub state has the same seq (nothing changed, item 43)', () => {
    const { h, hub } = inFallback();
    const local = h.core.view;
    h.core.onWelcome();
    h.core.onState({ ...local, seq: local.seq });
    expect(h.core.authority).toBe('hub');
    expect(h.notices.some((n) => n.kind === 'hub-newer')).toBe(false);
    expect(hub.seq).toBeLessThan(local.seq);
  });

  it('asks the operator on a playlist conflict, and keep-local adopts with force', () => {
    const { h } = inFallback();
    const other = reduce(initialState(), { k: 'goLive', resolved: resolved('other', 'Other') });
    h.core.onWelcome();
    h.core.onState(other);
    expect(h.core.reconcile).toBe('conflict');
    expect(h.notices.at(-1)).toMatchObject({ kind: 'conflict', hubPlaylist: 'Other' });
    h.core.resolveConflict('local');
    expect(h.sent.at(-1)).toMatchObject({ t: 'live.adopt', force: true });
  });

  it('take-hub on conflict hands authority back with the hub state', () => {
    const { h } = inFallback();
    const other = reduce(initialState(), { k: 'goLive', resolved: resolved('other', 'Other') });
    h.core.onWelcome();
    h.core.onState(other);
    h.core.resolveConflict('hub');
    expect(h.core.authority).toBe('hub');
    expect(h.core.view.resolved?.playlist.id).toBe('other');
  });

  it('replays commands made while the adoption was in flight', () => {
    const { h, hub } = inFallback();
    h.core.onStatus(true);
    h.core.onWelcome();
    h.core.onState(hub);
    const adopted = (h.sent.at(-1) as { state: LiveState }).state;
    h.core.submit({ k: 'prev', at: 300 });
    h.core.onState(adopted);
    expect(h.core.authority).toBe('hub');
    expect(h.sent.at(-1)).toMatchObject({ t: 'live.event', event: { k: 'prev' } });
    expect(h.core.view.live).toBe(0);
  });

  it('activates from a cached live state when the hub never answers after a reload', () => {
    const h = harness(liveHub());
    h.fire(5000);
    expect(h.core.authority).toBe('fallback');
  });
});

describe('LiveCore pending persistence (core restart, design/25)', () => {
  it('exports unconfirmed commands and a restarted core re-sends them with the same ids once', () => {
    const a = harness();
    a.core.onStatus(true);
    const hub = liveHub();
    a.core.onState(hub);
    a.setHub(false);
    const id = a.core.submit({ k: 'next', at: 5 }, 'aid-1');
    expect(id).toBe('aid-1');
    // A second submit with the same id (a re-sent action) is ignored.
    expect(a.core.submit({ k: 'next', at: 5 }, 'aid-1')).toBe('aid-1');
    expect(a.core.pendingCount).toBe(1);
    const saved = a.core.pendingCommands();
    expect(saved.map((p) => p.id)).toEqual(['aid-1']);

    // The core dies; a new one is seeded with the confirmed hub state and the saved commands.
    const b = harness(hub);
    b.core.restorePending(saved);
    expect(b.core.view.live).toBe(0); // proposed at once
    expect(b.sent).toEqual([]); // not connected yet
    b.core.onStatus(true);
    b.core.onState(hub);
    const sent = b.sent.filter((m) => m.t === 'live.event') as { id: string }[];
    expect(sent.map((m) => m.id)).toEqual(['aid-1']);
    expect(b.core.view.live).toBe(0); // applied once, not twice
  });

  it('drops expired, malformed and goLive commands on restore', () => {
    const b = harness(liveHub());
    b.core.restorePending([
      { id: 'old', event: { k: 'next', at: 1 }, at: Date.now() - 120_000 },
      { id: 'gl', event: { k: 'goLive', playlistId: 'x' } as never, at: Date.now() },
      null as never,
      { id: 'ok', event: { k: 'next', at: 1 }, at: Date.now() },
    ]);
    expect(b.core.pendingCommands().map((p) => p.id)).toEqual(['ok']);
  });
});

describe('LiveCore going live without the hub (held service, design/17)', () => {
  const offline = () => {
    const h = harness(undefined, { resolveLocal: (id) => resolved(id, 'Sunday from cache') });
    h.setHub(false);
    h.core.onStatus(false);
    return h;
  };

  it('goes live from this PC only when asked, resolving the playlist locally', () => {
    const h = offline();
    // A plain goLive with the hub away is refused, as before: never automatic.
    h.core.submit({ k: 'goLive', playlistId: 'pl' });
    expect(h.core.view.mode).toBe('idle');
    expect(h.notices.at(-1)).toMatchObject({ kind: 'unavailable' });
    h.core.submit({ k: 'goLive', playlistId: 'pl' }, undefined, { local: true });
    expect(h.core.view.mode).toBe('live');
    expect(h.core.view.resolved?.playlist.name).toBe('Sunday from cache');
    expect(h.core.authority).toBe('fallback');
    expect(h.core.held).toBe(true);
    expect(h.fb.hold).toBe(true);
    expect(h.deltas.at(-1)?.event.k).toBe('goLive');
    expect(h.notices.at(-1)).toMatchObject({ kind: 'local-live', playlist: 'Sunday from cache' });
    // Every command now applies on this PC.
    h.core.submit({ k: 'go', cueIndex: 1, at: 1 });
    expect(h.core.view.live).toBe(1);
  });

  it('a local goLive while the hub is connected goes through the hub; a resolve failure is reported', () => {
    // The socket came back between the dialog and its confirm: the hub resolves it, nothing is held.
    const h = harness(undefined, { resolveLocal: () => resolved() });
    h.core.onStatus(true);
    h.core.submit({ k: 'goLive', playlistId: 'pl' }, undefined, { local: true });
    expect(h.core.view.mode).toBe('idle');
    expect(h.core.held).toBe(false);
    expect(h.sent.at(-1)).toMatchObject({ t: 'live.event', event: { k: 'goLive', playlistId: 'pl' } });
    const bad = harness(undefined, {
      resolveLocal: () => {
        throw new Error('Cannot go live: "Intro video" is still processing');
      },
    });
    bad.core.onStatus(false);
    bad.core.submit({ k: 'goLive', playlistId: 'pl' }, undefined, { local: true });
    expect(bad.core.view.mode).toBe('idle');
    expect(bad.core.held).toBe(false);
    expect(bad.notices.at(-1)).toMatchObject({
      kind: 'rejected',
      reason: expect.stringMatching(/processing/),
    });
  });

  it('does not hand a held service to a hub that comes back, whatever the hub holds', () => {
    const h = offline();
    h.core.submit({ k: 'goLive', playlistId: 'pl' }, undefined, { local: true });
    h.core.submit({ k: 'go', cueIndex: 1, at: 1 });
    h.setHub(true);
    h.core.onStatus(true);
    h.core.onWelcome();
    // An idle hub, and a hub that is itself live with another service: neither is adopted or followed.
    h.core.onState(initialState());
    h.core.onState(reduce(initialState(), { k: 'goLive', resolved: resolved('other', 'Other') }));
    expect(h.sent.some((m) => m.t === 'live.adopt')).toBe(false);
    expect(h.core.authority).toBe('fallback');
    expect(h.core.view.resolved?.playlist.name).toBe('Sunday from cache');
    expect(h.core.view.live).toBe(1);
    expect(h.fb.hold).toBe(true);
    expect(h.notices.filter((n) => n.kind === 'hub-back-held')).toHaveLength(1);
    expect(h.notices.some((n) => n.kind === 'conflict')).toBe(false);
  });

  it('after End service hands the authority back once the hub answers', () => {
    const h = offline();
    h.core.submit({ k: 'goLive', playlistId: 'pl' }, undefined, { local: true });
    h.setHub(true);
    h.core.onStatus(true);
    h.core.submit({ k: 'endService', at: 2 });
    expect(h.core.held).toBe(false);
    expect(h.fb.hold).toBe(false);
    expect(h.notices.at(-1)).toMatchObject({ kind: 'held-ended', hubConnected: true });
    expect(h.sent.at(-1)).toEqual({ t: 'live.resync' });
    h.core.onState(initialState());
    expect(h.core.authority).toBe('hub');
    expect(h.fb.deactivated).toBe(1);
    expect(h.sent.some((m) => m.t === 'live.adopt')).toBe(false);
  });

  it('after End service, a hub that is live with another service is followed, never overridden', () => {
    const h = offline();
    h.core.submit({ k: 'goLive', playlistId: 'pl' }, undefined, { local: true });
    h.setHub(true);
    h.core.onStatus(true);
    h.core.submit({ k: 'endService', at: 2 });
    // Another operator went live through the hub meanwhile: no conflict dialog, no adopt; follow it.
    const other = reduce(initialState(), { k: 'goLive', resolved: resolved('other', 'Other service') });
    h.core.onState(other);
    expect(h.core.authority).toBe('hub');
    expect(h.core.view.resolved?.playlist.name).toBe('Other service');
    expect(h.sent.some((m) => m.t === 'live.adopt')).toBe(false);
    expect(h.notices.some((n) => n.kind === 'conflict')).toBe(false);
  });

  it('after End service with the hub still away, stays in charge and may go live locally again', () => {
    const h = offline();
    h.core.submit({ k: 'goLive', playlistId: 'pl' }, undefined, { local: true });
    h.core.submit({ k: 'endService', at: 2 });
    expect(h.notices.at(-1)).toMatchObject({ kind: 'held-ended', hubConnected: false });
    expect(h.core.authority).toBe('fallback');
    h.core.submit({ k: 'goLive', playlistId: 'pl2' }, undefined, { local: true });
    expect(h.core.held).toBe(true);
    expect(h.fb.hold).toBe(true);
    // When the hub finally returns idle after that second service ended, nothing is transferred.
    h.core.submit({ k: 'endService', at: 3 });
    h.setHub(true);
    h.core.onStatus(true);
    h.core.onWelcome();
    h.core.onState(initialState());
    expect(h.core.authority).toBe('hub');
    expect(h.sent.some((m) => m.t === 'live.adopt')).toBe(false);
  });

  it('a goLive asked for during the hand-back after End service waits for the hub to take over', () => {
    const h = offline();
    h.core.submit({ k: 'goLive', playlistId: 'pl' }, undefined, { local: true });
    h.setHub(true);
    h.core.onStatus(true);
    h.core.submit({ k: 'endService', at: 2 });
    expect(h.core.reconcile).toBe('awaitState');
    h.sent.length = 0;
    h.core.submit({ k: 'goLive', playlistId: 'pl2' });
    // Not refused as "hub unreachable", not sent yet either: the hub has not got the authority back.
    expect(h.notices.some((n) => n.kind === 'unavailable')).toBe(false);
    expect(h.sent.some((m) => m.t === 'live.event')).toBe(false);
    h.core.onState(initialState());
    expect(h.core.authority).toBe('hub');
    expect(h.sent.at(-1)).toMatchObject({ t: 'live.event', event: { k: 'goLive', playlistId: 'pl2' } });
    // The hub going away again during the hand-back refuses it instead, so the operator is told.
    const g = offline();
    g.core.submit({ k: 'goLive', playlistId: 'pl' }, undefined, { local: true });
    g.setHub(true);
    g.core.onStatus(true);
    g.core.submit({ k: 'endService', at: 2 });
    g.core.submit({ k: 'goLive', playlistId: 'pl2' });
    g.setHub(false);
    g.core.onStatus(false);
    expect(g.notices.at(-1)).toMatchObject({ kind: 'unavailable', command: { k: 'goLive' } });
    g.setHub(true);
    g.core.onStatus(true);
    g.core.onWelcome();
    g.sent.length = 0;
    g.core.onState(initialState());
    expect(g.sent.some((m) => m.t === 'live.event')).toBe(false);
  });

  it('End service while the hub adopts the fallback service ends it on the hub, with no conflict', () => {
    const h = harness(reduce(initialState(), { k: 'goLive', resolved: resolved() }));
    h.core.onStatus(true);
    h.core.onStatus(false);
    h.timers.find((t) => !t.cleared)!.fn(); // grace: fallback authority
    h.core.submit({ k: 'go', cueIndex: 1, at: 1 });
    h.core.onStatus(true);
    h.core.onWelcome();
    h.core.onState(initialState()); // the hub restarted idle: adopt this PC's service
    expect(h.core.reconcile).toBe('adopting');
    h.core.submit({ k: 'endService', at: 2 });
    // The hub answers with the adopted (live) state: the end is replayed to it, no dialog.
    const adopted = (h.sent.at(-1) as { t: 'live.adopt'; state: LiveState }).state;
    h.sent.length = 0;
    h.core.onState(adopted);
    expect(h.core.authority).toBe('hub');
    expect(h.notices.some((n) => n.kind === 'conflict')).toBe(false);
    expect(h.sent.at(-1)).toMatchObject({ t: 'live.event', event: { k: 'endService' } });
  });

  it('resumes a held service after a core restart, telling the windows to keep holding', () => {
    const seed = reduce(initialState(), { k: 'goLive', resolved: resolved('pl', 'Held') });
    const h = harness(seed);
    h.core.resumeHeld();
    expect(h.core.authority).toBe('fallback');
    expect(h.core.held).toBe(true);
    expect(h.fb.hold).toBe(true);
    expect(h.notices.some((n) => n.kind === 'fallback-on')).toBe(false);
    h.core.onStatus(true);
    h.core.onWelcome();
    h.core.onState(initialState());
    expect(h.core.authority).toBe('fallback');
  });
});

describe('LiveCore hand-back size (design/27 §3.4)', () => {
  const MiB = 1024 * 1024;
  /** A live service of one imported presentation: `slides` slides of `chars` characters each. */
  function bigResolved(slides: number, chars: number): ResolvedPlaylist {
    const text = 'y'.repeat(chars);
    const style = {
      fontFamily: 'Calibri',
      fontWeight: 400,
      fontStyle: 'normal' as const,
      fontSizePx: 40,
      color: { r: 255, g: 255, b: 255, a: 1 },
      align: 'left' as const,
      valign: 'top' as const,
      lineHeight: 1.2,
      letterSpacing: 0,
      padding: 0,
      transform: 'none' as const,
    };
    return {
      playlist: {
        id: 'pl',
        rev: 1,
        name: 'Big',
        items: [{ id: 'i0', kind: 'presentation', presentationId: 'big' }],
      },
      presentations: {
        big: {
          id: 'big',
          rev: 1,
          title: 'Imported deck',
          kind: 'slides',
          meta: { tags: [] },
          sections: [
            {
              id: 'sec',
              label: 'Deck',
              short: '',
              slides: Array.from({ length: slides }, (_, i) => ({
                id: `sl${i}`,
                objects: [
                  {
                    id: `t${i}`,
                    type: 'text',
                    box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
                    text,
                    style,
                    opacity: 1,
                  },
                ],
              })),
            },
          ],
          arrangements: [],
          archived: false,
        },
      },
      media: {},
      fonts: [],
      looks: [],
      files: [],
      manifestId: 'm',
    };
  }
  /** The hub went away during the service; this PC took over and moved on; the hub is back. */
  function tookOver(r: ResolvedPlaylist, extra: Partial<LiveCoreDeps> = {}) {
    const h = harness(undefined, extra);
    h.core.onStatus(true);
    const hub = reduce(initialState(), { k: 'goLive', resolved: r });
    h.core.onState(hub);
    h.core.onStatus(false);
    h.setHub(false);
    h.fire(5000);
    h.core.submit({ k: 'next', at: 100 });
    h.setHub(true);
    h.core.onStatus(true);
    h.core.onWelcome();
    return { h, hub };
  }

  it('hands a 13 MiB service back to the hub as usual', () => {
    const r = bigResolved(700, 19_500);
    expect(jsonBytes(r)).toBeGreaterThan(13 * MiB);
    expect(jsonBytes(r)).toBeLessThan(14 * MiB);
    const { h, hub } = tookOver(r);
    h.core.onState(hub);
    expect(h.sent.at(-1)).toMatchObject({ t: 'live.adopt' });
    expect(h.notices.some((n) => n.kind === 'adopt-too-large')).toBe(false);
  });

  it('refuses a hand-back over 15 MiB locally, holds the service, and ends the hub copy after End service', () => {
    const r = bigResolved(820, 19_500);
    const { h, hub } = tookOver(r);
    h.core.onState(hub);
    // Never sent: the hub would close the socket, and the operator would reconnect and try again.
    expect(h.sent.some((m) => m.t === 'live.adopt')).toBe(false);
    const n = h.notices.at(-1) as Extract<LiveNotice, { kind: 'adopt-too-large' }>;
    expect(n).toMatchObject({ kind: 'adopt-too-large', max: SIZE_BUDGETS.adoptMax });
    expect(n.bytes).toBeGreaterThan(SIZE_BUDGETS.adoptMax);
    expect(n.bytes).toBeLessThan(SIZE_BUDGETS.socketMax);
    expect(h.core.authority).toBe('fallback');
    expect(h.core.held).toBe(true);
    expect(h.core.reconcile).toBeNull();
    expect(h.core.staleOnHub).toBe('pl');
    expect(h.fb.hold).toBe(true);
    // Meanwhile the hub's states change nothing: no dialog, no second notice, the service runs here.
    h.core.onState(hub);
    expect(h.notices.filter((x) => x.kind === 'adopt-too-large')).toHaveLength(1);
    expect(h.notices.some((x) => x.kind === 'conflict' || x.kind === 'hub-back-held')).toBe(false);
    h.core.submit({ k: 'next', at: 300 });
    expect(h.core.view.live).toBe(1);
    // End service: the hub still shows its old copy, so it is ended there with this PC's idle state.
    h.core.submit({ k: 'endService', at: 400 });
    expect(h.sent.at(-1)).toEqual({ t: 'live.resync' });
    h.core.onState(hub);
    const adopt = h.sent.at(-1) as Extract<HubOut, { t: 'live.adopt' }>;
    expect(adopt).toMatchObject({ t: 'live.adopt', force: true });
    expect(adopt.state.mode).toBe('idle');
    expect(jsonBytes(adopt)).toBeLessThan(64 * 1024);
    expect(h.core.staleOnHub).toBeUndefined();
    h.core.onState({ ...adopt.state, seq: hub.seq + 10 });
    expect(h.core.authority).toBe('hub');
    expect(h.fb.hold).toBe(false);
  });

  it('after End service follows a hub that went on to another playlist, and resumes the marker after a restart', () => {
    // A small limit stands in for a large service.
    const { h } = tookOver(resolved(), { adoptMaxBytes: 1000 });
    h.core.onState(liveHub());
    expect(h.core.held).toBe(true);
    h.core.submit({ k: 'endService', at: 400 });
    const other = reduce(initialState(), { k: 'goLive', resolved: resolved('other', 'Other service') });
    h.core.onState(other);
    expect(h.core.authority).toBe('hub');
    expect(h.core.view.resolved?.playlist.name).toBe('Other service');
    expect(h.sent.some((m) => m.t === 'live.adopt')).toBe(false);
    // A core restart during such a hold keeps the marker, so End service still ends the hub's copy.
    const seed = reduce(initialState(), { k: 'goLive', resolved: resolved() });
    const g = harness(seed);
    g.core.resumeHeld('pl');
    expect(g.core.staleOnHub).toBe('pl');
    g.core.onStatus(true);
    g.core.onWelcome();
    g.core.submit({ k: 'endService', at: 5 });
    g.core.onState(liveHub());
    expect(g.sent.at(-1)).toMatchObject({ t: 'live.adopt', force: true, state: { mode: 'idle' } });
  });
});
