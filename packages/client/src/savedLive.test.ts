import type { Cue, LiveState, Presentation, ResolvedPlaylist } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  type CopyKv,
  joinResolved,
  joinSaved,
  loadCopy,
  saveCopy,
  savedCopyId,
  slimState,
  splitResolved,
} from './savedLive.ts';

/** A fake store that records every put in order and its size, and can fail at the n-th put. */
function fakeKv(failAt?: number) {
  const data = new Map<string, unknown>();
  const puts: { key: string; bytes: number }[] = [];
  const kv: CopyKv = {
    async get<T>(key: string) {
      const v = data.get(key);
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    async set(key, value) {
      if (failAt !== undefined && puts.length + 1 === failAt) throw new Error('quota');
      puts.push({ key, bytes: JSON.stringify(value ?? null).length });
      data.set(key, structuredClone(value));
    },
  };
  return { kv, data, puts };
}

const presentation = (i: number, kb = 1): Presentation =>
  ({
    id: `p${i}`,
    rev: 1,
    title: `Song ${i}`,
    kind: 'song',
    meta: { tags: [] },
    sections: [{ id: `s${i}`, label: 'V', short: 'V', slides: [{ id: `sl${i}`, objects: [], pad: 'x'.repeat(kb * 1024) }] }],
    arrangements: [],
    archived: false,
  }) as unknown as Presentation;

function service(n = 20, kb = 1) {
  const presentations: Record<string, Presentation> = {};
  for (let i = 0; i < n; i++) presentations[`p${i}`] = presentation(i, kb);
  const resolved = {
    playlist: { id: 'pl', name: 'Sunday' },
    presentations,
    media: { m1: { id: 'm1' } },
    files: { f1: 1 },
    fonts: [{ id: 'font1' }],
    geoms: { g: { x: 1 } },
    manifestId: 'abc',
  } as unknown as ResolvedPlaylist;
  const cues = Array.from({ length: n }, (_, i) => ({ index: i, label: `c${i}` })) as unknown as Cue[];
  return { resolved, cues };
}

describe('slimState and joinSaved', () => {
  it('the slim state has neither the copy nor the cue list, and the three join back', () => {
    const { resolved, cues } = service(2);
    const state = { seq: 7, mode: 'live', resolved, cues, layers: {}, props: {}, timers: {}, messages: [], black: false } as unknown as LiveState;
    const slim = slimState(state);
    expect(slim).not.toHaveProperty('resolved');
    expect(slim).not.toHaveProperty('cues');
    expect(slim.seq).toBe(7);
    const joined = joinSaved(slim, { resolved, cues });
    expect(joined).toEqual(state);
    expect(joined.resolved).toBe(resolved);
  });
});

describe('splitResolved / joinResolved', () => {
  it('round-trip a service of 20 presentations, media, files, fonts and geoms to an equal object', () => {
    const { resolved } = service(20);
    const { head, parts } = splitResolved(resolved);
    expect(parts.size).toBe(20);
    expect(head.presentations).toEqual({});
    expect(Object.keys(head)).toEqual(expect.arrayContaining(['media', 'files', 'fonts', 'geoms', 'manifestId']));
    expect(joinResolved(head, parts)).toEqual(resolved);
    expect(joinResolved(head, parts).presentations.p3).toBe(resolved.presentations.p3);
  });
});

describe('saveCopy and loadCopy', () => {
  it('write parts, the cue list, the head, then the marker, and load them to an equal copy', async () => {
    const { resolved, cues } = service(20);
    const { kv, puts } = fakeKv();
    expect(await saveCopy(kv, 'out1', 'id1', resolved, cues)).toBe('saved');
    const order = puts.map((p) => p.key);
    expect(order.at(-1)).toBe('copy:out1');
    expect(order.at(-2)).toBe('copy:out1:id1:head');
    expect(order.at(-3)).toBe('copy:out1:id1:cues');
    expect(order.slice(0, 20).every((k) => k.startsWith('copy:out1:id1:p:'))).toBe(true);
    const loaded = await loadCopy(kv, 'out1');
    expect(loaded?.id).toBe('id1');
    expect(loaded?.resolved).toEqual(resolved);
    expect(loaded?.cues).toEqual(cues);
    expect(await savedCopyId(kv, 'out1')).toBe('id1');
  });

  it('writes the copy once: the same id again is present and puts nothing', async () => {
    const { resolved, cues } = service(3);
    const { kv, puts } = fakeKv();
    await saveCopy(kv, 's', 'id1', resolved, cues);
    const n = puts.length;
    expect(await saveCopy(kv, 's', 'id1', resolved, cues)).toBe('present');
    expect(puts.length).toBe(n);
  });

  it('a torn write (the store fails at the 5th put) never leaves a marker that names an incomplete copy', async () => {
    const { resolved, cues } = service(20);
    const { kv, data } = fakeKv(5);
    expect(await saveCopy(kv, 's', 'id1', resolved, cues)).toBe('failed');
    expect(data.has('copy:s')).toBe(false);
    expect(await loadCopy(kv, 's')).toBeUndefined();
    // a failure while replacing an older copy leaves the older marker, and it still loads complete
    const first = fakeKv();
    await saveCopy(first.kv, 's', 'old', resolved, cues);
    let n = 0;
    const flaky: CopyKv = {
      get: first.kv.get,
      set: async (k, v) => {
        if (++n === 4) throw new Error('quota');
        return first.kv.set(k, v);
      },
    };
    const next = service(20);
    expect(await saveCopy(flaky, 's', 'new', next.resolved, next.cues)).toBe('failed');
    const still = await loadCopy(first.kv, 's');
    expect(still?.id).toBe('old');
    expect(still?.resolved).toEqual(resolved);
  });

  it('a marker whose part is missing loads as undefined', async () => {
    const { resolved, cues } = service(5);
    const { kv, data } = fakeKv();
    await saveCopy(kv, 's', 'id1', resolved, cues);
    data.delete('copy:s:id1:p:p2');
    expect(await loadCopy(kv, 's')).toBeUndefined();
    data.set('copy:s:id1:p:p2', null);
    expect(await loadCopy(kv, 's')).toBeUndefined();
  });

  it('a newer id removes the first id\'s records after the marker moved', async () => {
    const a = service(4);
    const b = service(6);
    const { kv, data } = fakeKv();
    await saveCopy(kv, 's', 'a', a.resolved, a.cues);
    await saveCopy(kv, 's', 'b', b.resolved, b.cues);
    expect(await savedCopyId(kv, 's')).toBe('b');
    const live = [...data.entries()].filter(([, v]) => v !== null).map(([k]) => k);
    expect(live.filter((k) => k.startsWith('copy:s:a:'))).toEqual([]);
    expect((await loadCopy(kv, 's'))?.resolved).toEqual(b.resolved);
  });

  it('no single put is larger than the biggest presentation plus the head', async () => {
    const { resolved, cues } = service(10, 1);
    resolved.presentations.p4 = presentation(4, 1024); // one presentation of 1 MiB
    const { kv, puts } = fakeKv();
    await saveCopy(kv, 's', 'id', resolved, cues);
    const biggest = Math.max(...Object.values(resolved.presentations).map((p) => JSON.stringify(p).length));
    const head = JSON.stringify(splitResolved(resolved).head).length;
    for (const p of puts) expect(p.bytes).toBeLessThanOrEqual(biggest + head);
    expect(Math.max(...puts.map((p) => p.bytes))).toBeLessThan(1.1 * 1024 * 1024);
  });

  it('a newer save aborts an older one at its next put', async () => {
    const { resolved, cues } = service(20);
    const { kv, data } = fakeKv();
    const ctl = new AbortController();
    let n = 0;
    const abortingKv: CopyKv = {
      get: kv.get,
      set: async (k, v) => {
        await kv.set(k, v);
        if (++n === 3) ctl.abort();
      },
    };
    expect(await saveCopy(abortingKv, 's', 'id1', resolved, cues, { signal: ctl.signal })).toBe('aborted');
    expect(n).toBe(3);
    expect(data.has('copy:s')).toBe(false);
  });
});
