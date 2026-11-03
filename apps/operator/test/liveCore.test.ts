import { describe, expect, it } from 'vitest';
import {
  type LiveEvent,
  type LiveState,
  parseLyrics,
  type ResolvedPlaylist,
  songFromParsed,
} from '@ordo/domain';
import { initialState, reduce } from '@ordo/live-state';
import type { LiveDeltaMsg } from '@ordo/protocol';
import { type HubOut, LiveCore, type LiveNotice } from '../src/lib/liveCore.ts';

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
function harness(seed?: LiveState) {
  const sent: HubOut[] = [];
  const notices: LiveNotice[] = [];
  const deltas: LiveDeltaMsg[] = [];
  const timers: { fn: () => void; ms: number; id: number; cleared: boolean }[] = [];
  let tid = 0;
  let nid = 0;
  const fb = { active: false, activated: 0, deactivated: 0, last: undefined as LiveState | undefined };
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
        activate: (s) => {
          fb.active = true;
          fb.activated++;
          fb.last = s;
        },
        deactivate: () => {
          fb.active = false;
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
