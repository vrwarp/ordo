import { HubConnection, OutputLink } from '@ordo/client';
import type { LiveState, Media } from '@ordo/domain';
import type { OutputConfigRes } from '@ordo/protocol';
import type { FromAsset, ToAsset, ToRender } from '@ordo/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { picture, slideOf, texts } from '../../../packages/renderer/src/frame.test-util.ts';
import { stateOf } from '../../../packages/renderer/src/plan.full.test-util.ts';
import type { LinkToMain } from './host-protocol.ts';
import { LinkCore } from './link-core.ts';
import { MemoryStreamStore } from './opfs.ts';

/*
 * The slide jobs of the link worker for a crowded slide (design 29 R1): the job carries the slide before the live
 * clamp's cut (`full`) and the files of every picture of it, so the asset worker can make the frame; the job of an
 * ordinary slide is what it always was.
 */

const config = (): OutputConfigRes =>
  ({
    output: {
      id: 'o1',
      name: 'Audience 1',
      kind: 'output',
      hostIndex: 1,
      lookId: 'look-main',
      enabled: true,
      audioMaster: false,
    },
    looks: [],
    audio: {},
    general: {},
    fonts: [],
  }) as unknown as OutputConfigRes;

function setup() {
  const hub = new HubConnection({ role: 'output', appVersion: 't', url: 'ws://unused' });
  hub.start = () => undefined;
  hub.send = () => true;
  const link = new OutputLink({
    role: 'output',
    appVersion: 't',
    hub,
    fallback: null,
    outputId: 'o1',
    token: 't',
  });
  const posts: LinkToMain[] = [];
  const kv = new Map<string, unknown>();
  const core = new LinkCore({
    link,
    store: new MemoryStreamStore(),
    json: { get: async (k) => kv.get(k) as never, set: async (k, v) => void kv.set(k, v) },
    post: (m) => posts.push(m),
    width: 640,
    height: 360,
    testMode: true,
    fetchConfig: () => Promise.reject(new Error('offline')),
    fetchNetwork: () => Promise.reject(new Error('offline')),
  });
  const render = new MessageChannel();
  const asset = new MessageChannel();
  const toRender: ToRender[] = [];
  const toAsset: ToAsset[] = [];
  render.port2.onmessage = (e) => toRender.push(e.data);
  asset.port2.onmessage = (e) => toAsset.push(e.data);
  core.onPorts(render.port1, asset.port1, { link: 0, render: 0, asset: 0 });
  const close = () => {
    for (const c of [render, asset]) {
      c.port1.close();
      c.port2.close();
    }
  };
  return { core, hub, toAsset, asset, close };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const stateMsg = (state: LiveState) => ({ t: 'live.state' as const, v: 1 as const, seq: state.seq, state });

/** `state` with image media `m0..m(n-1)` (files `hash0..`) in its resolved playlist. */
function withMedia(state: LiveState, n: number): LiveState {
  const media: Record<string, Media> = { ...(state.resolved?.media ?? {}) };
  for (let i = 0; i < n; i++)
    media[`m${i}`] = {
      id: `m${i}`,
      rev: 1,
      name: `Picture ${i}`,
      tags: [],
      kind: 'image',
      original: { hash: `hash${i}`, bytes: 10, mime: 'image/png', path: `files/hash${i}` },
      state: 'ready',
      loop: false,
      isBackground: false,
    } as Media;
  return { ...state, resolved: { ...state.resolved!, media } };
}

type JobMsg = Extract<ToAsset, { t: 'job' }>;
const slideJobs = (msgs: ToAsset[]) =>
  msgs.filter((m): m is JobMsg => m.t === 'job' && m.job.kind === 'slide');

describe('link worker core: the jobs of a crowded slide', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pics = Array.from({ length: 24 }, (_, i) =>
    picture(`pic${i}`, `m${i}`, { x: 10 + (i % 8) * 220, y: 700 + Math.floor(i / 8) * 100, w: 200, h: 90 }),
  );

  it('carries the whole slide and the files of every picture, the cut slide staying the cut one', async () => {
    const slide = slideOf([...texts(340), ...pics], 'crowd');
    const t = setup();
    await t.core.start();
    t.hub.emit('state', stateMsg(withMedia(stateOf(slide), 24)));
    await tick(30);
    const job = slideJobs(t.toAsset).find((m) => m.job.kind === 'slide' && m.job.cueIndex === 0)!.job;
    expect(job.kind).toBe('slide');
    if (job.kind !== 'slide') return;
    expect(job.full).toBeDefined();
    expect(job.full!.objects).toHaveLength(364);
    expect(job.slide.objects).toHaveLength(200);
    // every picture of the slide, the 8 the cut left out too: the frame draws them
    expect(Object.keys(job.images).sort()).toEqual(Array.from({ length: 24 }, (_, i) => `m${i}`).sort());
    expect(job.images.m23).toBe('hash23');
    t.close();
  });

  it('carries no full slide for an ordinary slide: its job is what it always was', async () => {
    const slide = slideOf([...texts(30), ...pics.slice(0, 3)], 'calm');
    const t = setup();
    await t.core.start();
    t.hub.emit('state', stateMsg(withMedia(stateOf(slide), 3)));
    await tick(30);
    const job = slideJobs(t.toAsset)[0]!.job;
    expect(job.kind === 'slide' && 'full' in job).toBe(false);
    expect(job.kind === 'slide' && Object.keys(job.images).sort()).toEqual(['m0', 'm1', 'm2']);
    t.close();
  });

  it('asks a restarted asset worker to make the frame of the slide it holds: the units job carries the whole slide', async () => {
    const slide = slideOf([...texts(340), ...pics], 'crowd');
    const t = setup();
    await t.core.start();
    t.hub.emit('state', stateMsg(withMedia(stateOf(slide), 24)));
    await tick(30);
    const live = slideJobs(t.toAsset).find((m) => m.job.kind === 'slide' && m.job.cueIndex === 0)!;
    t.asset.port2.postMessage({
      t: 'done',
      layer: live.job.layer,
      key: live.job.key,
      ms: 1,
      unitsLeft: 1,
    } satisfies FromAsset);
    await tick(20);
    const render = new MessageChannel();
    const asset = new MessageChannel();
    const after: ToAsset[] = [];
    asset.port2.onmessage = (e) => after.push(e.data as ToAsset);
    t.core.onPorts(render.port1, asset.port1, { link: 0, render: 0, asset: 1 });
    t.core.sync();
    await tick(30);
    const units = after.find((m): m is Extract<ToAsset, { t: 'units' }> => m.t === 'units');
    expect(units).toBeDefined();
    expect(units!.job.kind === 'slide' && units!.job.full?.objects.length).toBe(364);
    expect(units!.job.kind === 'slide' && Object.keys(units!.job.images)).toHaveLength(24);
    for (const c of [render, asset]) {
      c.port1.close();
      c.port2.close();
    }
    t.close();
  });
});
