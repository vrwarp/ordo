import { describe, expect, it } from 'vitest';
import { type LiveEvent, type LiveState, parseLyrics, type ResolvedPlaylist, songFromParsed } from '@ordo/domain';
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
    for (const t of timers) if (!t.cleared && t.ms === ms) {
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
