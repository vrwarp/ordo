/**
 * The goLive check in a worker thread (design/29 §2.3 M8): what it resolves equals what the live loop
 * resolved before (quarantine included), and its resolvedId names the copy exactly (M2).
 */
import { type Media, newId, type ResolvedPlaylist, resolvePlaylist } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bundleInputs,
  GoLiveWorker,
  manifestDigest,
  type PrepareOutput,
  prepareGoLive,
} from '../src/golive-worker.ts';
import { song } from './helpers.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function clip(trim?: { startMs: number; endMs: number }): Media {
  const hash = 'c'.repeat(64);
  return {
    id: 'clip1',
    rev: 1,
    name: 'Welcome loop',
    tags: [],
    kind: 'video',
    original: { hash, bytes: 10, mime: 'video/mp4', path: `media/cc/${hash}.mp4` },
    delivery: { hash: `d${hash.slice(1)}`, bytes: 5, mime: 'video/mp4', path: 'x' },
    state: 'ready',
    loop: false,
    isBackground: false,
    ...(trim ? { trim } : {}),
  };
}

/** A bundle of two songs (one with a slide that fails the schema) and a clip. */
function bundle() {
  const a = song('First');
  const b = song('Second');
  // A slide that fails the schema keeps its id and is shown empty (quarantine, design/25).
  (b.sections[0]!.slides[1] as unknown as { objects: unknown }).objects = 'not a list';
  return {
    playlist: {
      id: 'pl',
      rev: 3,
      name: 'Sunday',
      items: [
        { id: 'i1', kind: 'presentation', presentationId: a.id },
        { id: 'i2', kind: 'media', mediaId: 'clip1' },
        { id: 'i3', kind: 'presentation', presentationId: b.id },
      ],
    },
    presentations: { [a.id]: a, [b.id]: b },
    media: { clip1: clip() },
    fonts: [],
    looks: [],
    general: {},
  };
}

const parse = (out: PrepareOutput): ResolvedPlaylist => {
  if (!out.ok) throw new Error(out.reason);
  return JSON.parse(dec.decode(out.buffer)) as ResolvedPlaylist;
};

let worker: GoLiveWorker | undefined;
afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

describe('golive-worker (design/29 M8)', () => {
  it('resolves, in its thread, exactly what the live loop resolved, quarantine included', async () => {
    const b = bundle();
    const onLoop = resolvePlaylist(
      bundleInputs(b as unknown as Parameters<typeof bundleInputs>[0], { takenAt: 1 }),
      'pl',
      {
        digest: manifestDigest,
      },
    );
    expect(onLoop.degraded?.some((d) => /slide 2 is invalid/.test(d.reason))).toBe(true);
    worker = new GoLiveWorker();
    const out = await worker.run({ playlistId: 'pl', bundle: enc.encode(JSON.stringify(b)), takenAt: 1 });
    expect(worker.inline).toBe(false);
    expect(parse(out)).toEqual(JSON.parse(JSON.stringify(onLoop)));
    // A cached copy carries its reason as the first degraded entry, as on the loop.
    const cached = await worker.run({
      playlistId: 'pl',
      bundle: enc.encode(JSON.stringify(b)),
      takenAt: 1,
      cachedCopy: 'Went live from the copy of this playlist saved 3 days ago',
    });
    expect(parse(cached).degraded?.[0]).toEqual({
      cueIndex: -1,
      reason: 'Went live from the copy of this playlist saved 3 days ago',
    });
  });

  it('refuses as the loop did: a missing presentation, a damaged copy', async () => {
    const b = bundle();
    const missing = { ...b, presentations: {} };
    worker = new GoLiveWorker();
    const out = await worker.run({
      playlistId: 'pl',
      bundle: enc.encode(JSON.stringify(missing)),
      takenAt: 1,
    });
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer exists/) });
    const damaged = prepareGoLive({ playlistId: 'pl', bundle: enc.encode('{"playlist":'), takenAt: 1 });
    expect(damaged).toMatchObject({ ok: false, reason: expect.stringMatching(/damaged copy/) });
  });

  it('names the copy by the SHA-256 of its one serialisation: the same for the same copy, another for a trim', async () => {
    const b = bundle();
    worker = new GoLiveWorker();
    const run = (x: unknown) =>
      worker!.run({ playlistId: 'pl', bundle: enc.encode(JSON.stringify(x)), takenAt: 1 });
    const one = await run(b);
    const two = await run(b);
    if (!one.ok || !two.ok) throw new Error('not prepared');
    expect(one.resolvedId).toMatch(/^[0-9a-f]{64}$/);
    expect(two.resolvedId).toBe(one.resolvedId);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(one.buffer).digest('hex')).toBe(one.resolvedId);
    // A clip's trim is not part of the manifest id (design/29 M2); it is part of the resolvedId.
    const trimmed = await run({ ...b, media: { clip1: clip({ startMs: 1000, endMs: 9000 }) } });
    if (!trimmed.ok) throw new Error('not prepared');
    expect(parse(trimmed).manifestId).toBe(parse(one).manifestId);
    expect(trimmed.resolvedId).not.toBe(one.resolvedId);
  });

  it('a worker past its time is stopped and the next check gets a new one', async () => {
    worker = new GoLiveWorker();
    const big = bundle();
    // Many presentations: a check that takes longer than 1 ms.
    for (let i = 0; i < 400; i++) {
      const p = song(`Song ${i}`);
      big.presentations[p.id] = p;
      big.playlist.items.push({ id: newId(), kind: 'presentation', presentationId: p.id });
    }
    const err = await worker
      .run({ playlistId: 'pl', bundle: enc.encode(JSON.stringify(big)), takenAt: 1 }, 1)
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/took longer than/);
    const out = await worker.run({
      playlistId: 'pl',
      bundle: enc.encode(JSON.stringify(bundle())),
      takenAt: 1,
    });
    expect(out.ok).toBe(true);
  });
  it('prepares and goes live from a cached bundle saved before pre-rendered slides had fields (GL4)', () => {
    const b = bundle();
    const a = Object.values(b.presentations)[0]!;
    const head = 'b'.repeat(64);
    // a pre-rendered stand-in whose bundle carries none of slideHeads, prerenders or prerenderKeys
    a.sections[0]!.slides[0]!.prerender = { why: ['count'], file: { ref: head, bytes: 10 }, live: [] };
    const files = {
      [head]: { hash: head, bytes: 10, mime: 'application/json', path: `media/bb/${head}.json` },
    };
    const out = prepareGoLive({
      playlistId: 'pl',
      bundle: enc.encode(JSON.stringify({ ...b, files })),
      takenAt: 1,
    });
    if (!out.ok) throw new Error(out.reason);
    const r = JSON.parse(dec.decode(out.buffer)) as ResolvedPlaylist;
    expect(r.geoms?.map((g) => g.hash)).toContain(head);
    expect(r.prerenders ?? []).toEqual([]);
    expect(r.prerenderKeys ?? []).toEqual([]);
  });
});
