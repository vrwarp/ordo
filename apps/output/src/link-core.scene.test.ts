import { HubConnection, OutputLink } from '@ordo/client';
import { LOOK_MAIN, LOOK_STAGE, type LiveState, type ResolvedPlaylist } from '@ordo/domain';
import { checkInvariants, initialState, reduce } from '@ordo/live-state';
import type { OutputConfigRes } from '@ordo/protocol';
import { type AssetJob, SRC_VIDEO, type ToAsset, type ToRender, planFrame } from '@ordo/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clipCues,
  clipLive,
  cueOf,
  withClips,
} from '../../../packages/renderer/src/fixtures.scene.test-util.ts';
import { liveState, media } from '../../../packages/renderer/src/fixtures.test-util.ts';
import type { LinkToMain, MediaCommand } from './host-protocol.ts';
import { LinkCore, type SlotMirror } from './link-core.ts';
import { MemoryStreamStore } from './opfs.ts';

/**
 * The link's half of a clip playing inside its slide (design/27 §7.2 "Arming and slot ownership"): every
 * output arms the clip in the media pair (muted unless the audio master, never as SRC_VIDEO content), the
 * slide job carries the slot and its load generation at once, a scene drawn for another slot or
 * generation is drawn again in place, and the picture leaves the renderer (`vclear`) when the media layer
 * clears or while a clip hidden when stopped is not playing.
 */

const config = (audioMaster: boolean, lookId = 'look-main'): OutputConfigRes =>
  ({
    output: {
      id: 'o1',
      name: 'Audience 1',
      kind: 'output',
      hostIndex: 1,
      lookId,
      enabled: true,
      audioMaster,
    },
    looks: [],
    audio: {},
    general: {},
    fonts: [],
  }) as unknown as OutputConfigRes;

function setup() {
  const hub = new HubConnection({ role: 'output', appVersion: 't', url: 'ws://unused' });
  const sent: unknown[] = [];
  hub.start = () => undefined;
  hub.send = (m) => {
    sent.push(m);
    return true;
  };
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
    for (const p of [render.port1, render.port2, asset.port1, asset.port2]) p.close();
  };
  /** Media commands sent to the host, of kind `k`. */
  const cmds = <K extends MediaCommand['k']>(k: K) =>
    posts.flatMap((p) =>
      p.t === 'media' && p.cmd.k === k ? [p.cmd as Extract<MediaCommand, { k: K }>] : [],
    );
  /** Slide jobs posted to the asset worker for cue `cue`. */
  const slideJobs = (cue: number) =>
    toAsset.flatMap((m) =>
      m.t === 'job' && m.job.kind === 'slide' && m.job.cueIndex === cue
        ? [m.job as Extract<AssetJob, { kind: 'slide' }>]
        : [],
    );
  const slots = (core as unknown as { slots: SlotMirror[] }).slots;
  const state = async (s: LiveState) => {
    hub.emit('state', { t: 'live.state', v: 1, seq: s.seq, state: s });
    await tick();
  };
  return { core, hub, link, sent, posts, toRender, toAsset, close, cmds, slideJobs, slots, state };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const key = (slideId: string, mediaId = 'vid', hash = 'd2') => `md|${cueOf(slideId)}|${mediaId}|${hash}`;

describe('link worker: a clip playing inside its slide', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms the clip on an output that is not the audio master, muted, and never offers it as SRC_VIDEO', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(false));
    await t.state(clipLive('c1'));
    const load = t.cmds('load').find((c) => c.key === key('c1'));
    expect(load).toMatchObject({ muted: true, hash: 'd2', loop: false });
    expect([2, 3]).toContain(load!.slot);
    // The slide job went out at once with the slot and its load generation, before the clip loaded.
    const jobs = t.slideJobs(cueOf('c1'));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.video).toEqual({ objectId: 'v1', slot: load!.slot, gen: load!.gen });
    expect(jobs[0]!.refresh).toBeUndefined();
    // The media layer draws nothing.
    expect(t.toRender.some((m) => m.t === 'flip' && m.layer === 3 && m.key !== '')).toBe(false);
    t.core.onMediaEvent({ k: 'loaded', slot: load!.slot, key: load!.key });
    await tick();
    expect(t.toRender.some((m) => m.t === 'content' && m.kind === SRC_VIDEO)).toBe(false);
    // Transport and routing find the slot by the desc key: muted here, playing from the layer's start.
    expect(
      t
        .cmds('apply')
        .filter((c) => c.slot === load!.slot)
        .at(-1)?.transport,
    ).toEqual({
      state: 'playing',
      startedAt: 1000,
      positionMs: 0,
      loop: false,
    });
    expect(
      t
        .cmds('route')
        .filter((c) => c.slot === load!.slot)
        .at(-1)?.master,
    ).toBe(false);
    // Nothing is drawn again: the scene already names this slot and generation.
    t.core.sync();
    expect(t.slideJobs(cueOf('c1'))).toHaveLength(1);
    expect((t.core.introspect() as { scenes: Record<string, string> }).scenes).toEqual({
      [jobs[0]!.key]: `${load!.slot}|${load!.gen}`,
    });
    t.close();
  });

  it("the slide job carries the clip's own size for the plane", async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(false));
    const sized = {
      ...withClips,
      media: { ...withClips.media, vid: { ...withClips.media.vid!, width: 1280, height: 720 } },
    };
    await t.state({ ...clipLive('c1'), resolved: sized });
    const load = t.cmds('load').find((c) => c.key === key('c1'))!;
    expect(t.slideJobs(cueOf('c1'))[0]?.video).toEqual({
      objectId: 'v1',
      slot: load.slot,
      gen: load.gen,
      w: 1280,
      h: 720,
    });
    t.close();
  });

  it('the audio master plays its sound and reports its end for the slide cue', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(true));
    t.hub.connected = true;
    t.hub.emit('status', { connected: true });
    await t.state(clipLive('c1', {}, { at: Date.now() - 61_000 }));
    const load = t.cmds('load').find((c) => c.key === key('c1'));
    expect(load?.muted).toBe(false);
    t.core.onMediaEvent({ k: 'loaded', slot: load!.slot, key: load!.key });
    await tick();
    expect(
      t
        .cmds('route')
        .filter((c) => c.slot === load!.slot)
        .at(-1)?.master,
    ).toBe(true);
    t.core.onMediaEvent({ k: 'ended', slot: load!.slot, key: load!.key });
    const ended = t.sent.filter((m) => (m as { event?: { k: string } }).event?.k === 'media.ended');
    expect(ended).toHaveLength(1);
    expect((ended[0] as { event: { cueIndex: number } }).event.cueIndex).toBe(cueOf('c1'));
    t.close();
  });

  it("preloads the next slide's clip on every output, held paused, and its slide job carries it", async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(false));
    await t.state(clipLive('c1', {}, { armed: cueOf('c2') }));
    const live = t.cmds('load').find((c) => c.key === key('c1'));
    const next = t.cmds('load').find((c) => c.key === key('c2', 'vid2', 'd3'));
    expect(live && next).toBeTruthy();
    expect(next!.slot).not.toBe(live!.slot);
    expect(next!.muted).toBe(true);
    const armedJob = t.slideJobs(cueOf('c2'))[0];
    expect(armedJob?.video).toEqual({ objectId: 'v2', slot: next!.slot, gen: next!.gen });
    for (const l of [live!, next!]) t.core.onMediaEvent({ k: 'loaded', slot: l.slot, key: l.key });
    await tick();
    expect(t.cmds('holdPaused').some((c) => c.slot === next!.slot)).toBe(true);
    expect(t.cmds('holdPaused').some((c) => c.slot === live!.slot)).toBe(false);
    // c2 is a click-start clip hidden while not playing: its picture is kept out of the renderer.
    expect(
      t.cmds('vclear').some((c) => c.slot === next!.slot && c.key === next!.key && c.at === undefined),
    ).toBe(true);
    t.close();
  });

  it('with no free slot the slide is drawn with its poster, then drawn again in place once a slot is armed', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(false));
    // Both media slots are fading other videos out for a while.
    for (const s of [t.slots[2]!, t.slots[3]!]) {
      s.key = `md|x${s.id}`;
      s.busyUntil = Date.now() + 60_000;
    }
    await t.state(clipLive('c1'));
    expect(t.cmds('load')).toHaveLength(0);
    const first = t.slideJobs(cueOf('c1'));
    expect(first).toHaveLength(1);
    expect(first[0]!.video).toBeUndefined();
    t.slots[2]!.busyUntil = 0;
    t.core.sync();
    await tick();
    const load = t.cmds('load').find((c) => c.key === key('c1'));
    expect(load?.slot).toBe(2);
    const jobs = t.slideJobs(cueOf('c1'));
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.key).toBe(first[0]!.key);
    expect(jobs[1]!.refresh).toBe(true);
    expect(jobs[1]!.video).toEqual({ objectId: 'v1', slot: 2, gen: load!.gen });
    t.close();
  });

  it('a clip loaded again under a new generation draws its slide again in place', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(false));
    await t.state(clipLive('c1'));
    const first = t.cmds('load').find((c) => c.key === key('c1'))!;
    t.core.onMediaEvent({ k: 'loadError', slot: first.slot, key: first.key, error: 'network error' });
    await tick();
    // Backing off: no new generation, nothing drawn again.
    t.core.sync();
    await tick();
    expect(t.cmds('load').filter((c) => c.key === first.key)).toHaveLength(1);
    expect(t.slideJobs(cueOf('c1'))).toHaveLength(1);
    (t.core as unknown as { errors: Map<string, unknown> }).errors.delete(first.key);
    t.core.sync();
    await tick();
    const again = t.cmds('load').filter((c) => c.key === first.key);
    expect(again).toHaveLength(2);
    expect(again[1]!.gen).toBeGreaterThan(first.gen);
    const jobs = t.slideJobs(cueOf('c1'));
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.refresh).toBe(true);
    expect(jobs[1]!.video).toEqual({ objectId: 'v1', slot: again[1]!.slot, gen: again[1]!.gen });
    t.close();
  });

  it('Clear media: the clip pauses after the fade and its picture leaves the renderer; the slide stays', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(false));
    await t.state(clipLive('c1'));
    const load = t.cmds('load').find((c) => c.key === key('c1'))!;
    t.core.onMediaEvent({ k: 'loaded', slot: load.slot, key: load.key });
    await tick();
    const slideFlips = t.toRender.filter((m) => m.t === 'flip' && m.layer === 1).length;
    const cleared = clipLive('c1', {}, { seq: 5 });
    cleared.layers.media = { content: null, at: 5000, seq: 5 };
    await t.state(cleared);
    const pause = t.cmds('pauseAt').find((c) => c.slot === load.slot);
    const vclear = t.cmds('vclear').find((c) => c.slot === load.slot);
    // Paused when the media layer's 300 ms fade ends; the picture leaves at the same hub time.
    expect(pause?.at).toBe(5300);
    expect(vclear).toEqual({ k: 'vclear', slot: load.slot, key: load.key, at: 5300 });
    // The slide is neither drawn again nor flipped.
    expect(t.slideJobs(cueOf('c1'))).toHaveLength(1);
    expect(t.toRender.filter((m) => m.t === 'flip' && m.layer === 1)).toHaveLength(slideFlips);
    t.close();
  });

  it("'Hide while not playing' keeps the clip's picture out while it is not playing", async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(false));
    await t.state(clipLive('c2', { state: 'paused' }));
    const k = key('c2', 'vid2', 'd3');
    // Sent before the load reaches the host, so even its first frame is never shown.
    const firstClear = t.posts.findIndex((p) => p.t === 'media' && p.cmd.k === 'vclear');
    const firstLoad = t.posts.findIndex((p) => p.t === 'media' && p.cmd.k === 'load');
    expect(firstClear).toBeGreaterThanOrEqual(0);
    expect(firstClear).toBeLessThan(firstLoad);
    expect(t.cmds('vclear')[0]?.key).toBe(k);
    expect(t.cmds('vclear')[0]?.at).toBeUndefined();
    const n = t.cmds('vclear').length;
    await t.state(clipLive('c2', { state: 'playing', startedAt: 2000 }, { seq: 5 }));
    t.core.sync();
    expect(t.cmds('vclear')).toHaveLength(n);
    // A clip shown when stopped is never hidden.
    const u = setup();
    await u.core.start();
    u.core.applyConfig(config(false));
    await u.state(clipLive('c1', { state: 'paused' }));
    expect(u.cmds('vclear')).toHaveLength(0);
    t.close();
    u.close();
  });

  it('in a lyric-only look only the audio master arms the clip, for its sound; the slide has no video', async () => {
    const master = setup();
    await master.core.start();
    master.core.applyConfig(config(true, LOOK_STAGE.id));
    await master.state(clipLive('c1'));
    const load = master.cmds('load').find((c) => c.key === key('c1'));
    expect(load?.muted).toBe(false);
    expect(master.slideJobs(cueOf('c1')).every((j) => j.video === undefined)).toBe(true);
    master.core.onMediaEvent({ k: 'loaded', slot: load!.slot, key: load!.key });
    await tick();
    expect(master.toRender.some((m) => m.t === 'content' && m.kind === SRC_VIDEO)).toBe(false);
    const other = setup();
    await other.core.start();
    other.core.applyConfig(config(false, LOOK_STAGE.id));
    await other.state(clipLive('c1'));
    expect(other.cmds('load')).toHaveLength(0);
    master.close();
    other.close();
  });

  it('GO to the next clip slide: the clip that left keeps its slot through the fade, the newly armed one waits', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(false));
    await t.state(clipLive('c1', {}, { armed: cueOf('c2') }));
    const x = t.cmds('load').find((c) => c.key === key('c1'))!;
    const y = t.cmds('load').find((c) => c.key === key('c2', 'vid2', 'd3'))!;
    for (const l of [x, y]) t.core.onMediaEvent({ k: 'loaded', slot: l.slot, key: l.key });
    await tick();
    // GO c2 at hub time `at`; c4 (another clip) is armed next.
    const at = Date.now() + 50;
    await t.state(clipLive('c2', { state: 'paused' }, { armed: cueOf('c4'), at, seq: 6 }));
    const pause = t.cmds('pauseAt').find((c) => c.slot === x.slot);
    expect(pause?.at).toBe(at + 300);
    expect(t.cmds('vclear').some((c) => c.slot === x.slot && c.at === at + 300)).toBe(true);
    // c4's clip cannot take c1's slot while c1 fades out: its slide is drawn with the poster for now.
    const z = key('c4');
    expect(t.cmds('load').some((c) => c.key === z)).toBe(false);
    const c4 = t.slideJobs(cueOf('c4'));
    expect(c4).toHaveLength(1);
    expect(c4[0]!.video).toBeUndefined();
    // The fade is over: c4's clip takes the freed slot and its slide is drawn again in place.
    t.slots[x.slot]!.busyUntil = 0;
    t.core.sync();
    await tick();
    const zl = t.cmds('load').find((c) => c.key === z);
    expect(zl?.slot).toBe(x.slot);
    const again = t.slideJobs(cueOf('c4'));
    expect(again).toHaveLength(2);
    expect(again[1]).toMatchObject({ refresh: true, video: { objectId: 'v4', slot: x.slot, gen: zl!.gen } });
    t.close();
  });
});

describe('reducer, planner and link: a clip playing inside its slide', () => {
  /** GO to slide `slideId` of the clips deck from the c3 slide (no clip), with the real reducer. */
  const goTo = (slideId: string, at = 1000) => {
    const from = reduce(liveState({ resolved: withClips, cues: clipCues, seq: 1 }), {
      k: 'go',
      cueIndex: cueOf('c3'),
      at: at - 500,
    });
    return reduce(from, { k: 'go', cueIndex: cueOf(slideId), at });
  };

  it("the reducer's slide branch fills the media layer the planner draws inside the slide", () => {
    const s = goTo('c1');
    expect(checkInvariants(s)).toEqual([]);
    expect(s.layers.media.content).toEqual(clipLive('c1').layers.media.content);
    const p = planFrame(s, LOOK_MAIN);
    expect(p.media.key).toBe('');
    expect(p.media.desc).toMatchObject({ key: key('c1'), inSlide: { objectId: 'v1' }, state: 'playing' });
    expect(p.slide.desc?.video).toEqual({ objectId: 'v1', mediaId: 'vid', hash: 'd2' });
  });

  it('a click-start clip hidden while stopped goes live paused, hidden, and plays on F8', () => {
    const s = goTo('c2');
    expect(s.layers.media.content).toMatchObject({ objectId: 'v2', mediaId: 'vid2', state: 'paused' });
    const p = planFrame(s, LOOK_MAIN);
    expect(p.media.desc?.inSlide).toEqual({ objectId: 'v2', showWhenStopped: false });
    const played = reduce(s, { k: 'media.play', at: 2000 });
    expect(planFrame(played, LOOK_MAIN).media.desc).toMatchObject({
      inSlide: { objectId: 'v2', showWhenStopped: false },
      state: 'playing',
      startedAt: 2000,
    });
  });

  it('a slide without a clip clears the clip of the slide before it', () => {
    const s = reduce(goTo('c1'), { k: 'go', cueIndex: cueOf('c3'), at: 3000 });
    expect(s.layers.media.content).toBeNull();
    expect(planFrame(s, LOOK_MAIN).media.desc).toBeNull();
  });
});

describe('link worker: a slide sound that starts on click', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Cue 0: playlist audio 'bed'; cue 1: a slide whose sound 'sfx' starts on click.
  const sfx = {
    ...media.vid!,
    id: 'sfx',
    kind: 'audio' as const,
    delivery: { hash: 'a7', bytes: 10, mime: 'audio/mp4', path: 'files/a7' },
  };
  const bed = { ...sfx, id: 'bed', delivery: { ...sfx.delivery, hash: 'a8', path: 'files/a8' } };
  const r: ResolvedPlaylist = {
    ...withClips,
    playlist: {
      ...withClips.playlist,
      items: [
        { id: 'b', kind: 'media', mediaId: 'bed', loop: true },
        { id: 's', kind: 'presentation', presentationId: 'snd' },
      ],
    },
    presentations: {
      snd: {
        ...withClips.presentations.clips!,
        id: 'snd',
        sections: [
          {
            id: 's',
            label: 'S',
            short: 'S',
            slides: [{ id: 'x', objects: [], audio: { mediaId: 'sfx', start: 'click' } }],
          },
        ],
      },
    },
    media: { ...withClips.media, sfx, bed },
  };

  it('the audio master preloads it paused while the playlist audio plays on, and F8 plays it', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(true));
    const now = Date.now();
    let s = reduce(initialState(), { k: 'goLive', resolved: r });
    s = reduce(s, { k: 'go', cueIndex: 0, at: now });
    s = reduce(s, { k: 'go', cueIndex: 1, at: now + 100 });
    expect(s.audio.content?.mediaId).toBe('bed');
    await t.state(s);
    const bedLoad = t.cmds('load').find((c) => c.key === 'au|0|bed|a8');
    const sfxLoad = t.cmds('load').find((c) => c.key === 'au|1|sfx|a7');
    expect(bedLoad && sfxLoad).toBeTruthy();
    expect(sfxLoad!.slot).not.toBe(bedLoad!.slot);
    for (const l of [bedLoad!, sfxLoad!]) t.core.onMediaEvent({ k: 'loaded', slot: l.slot, key: l.key });
    await tick();
    // Only the playlist audio plays; the waiting sound gets no transport yet.
    expect(
      t
        .cmds('apply')
        .filter((c) => c.slot === bedLoad!.slot)
        .at(-1)?.transport.state,
    ).toBe('playing');
    expect(t.cmds('apply').some((c) => c.slot === sfxLoad!.slot)).toBe(false);
    const loads = t.cmds('load').length;
    s = reduce(s, { k: 'media.play', at: now + 400 });
    await t.state(s);
    expect(t.cmds('load')).toHaveLength(loads); // already loaded
    expect(
      t
        .cmds('apply')
        .filter((c) => c.slot === sfxLoad!.slot)
        .at(-1)?.transport,
    ).toMatchObject({
      state: 'playing',
      startedAt: now + 400,
    });
    t.close();
  });
});

describe('link worker: GO then a quick Prev between two clip slides', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const clipSlide = (id: string, objectId: string, clip: string) => ({
    id,
    objects: [
      {
        id: objectId,
        type: 'image' as const,
        box: { x: 480, y: 270, w: 960, h: 540, rotation: 0 },
        mediaId: 'hold',
        play: { mediaId: clip },
        fit: 'cover' as const,
        opacity: 1,
        radius: 0,
      },
    ],
  });
  const r: ResolvedPlaylist = {
    ...withClips,
    playlist: { ...withClips.playlist, items: [{ id: 'x', kind: 'presentation', presentationId: 'two' }] },
    presentations: {
      two: {
        ...withClips.presentations.clips!,
        id: 'two',
        transition: { kind: 'crossfade', ms: 200 },
        sections: [
          {
            id: 's',
            label: 'M',
            short: 'M',
            slides: [clipSlide('a', 'oa', 'vid'), clipSlide('b', 'ob', 'vid2'), clipSlide('c', 'oc', 'vid')],
          },
        ],
      },
    },
  };

  it('the clip just left keeps playing through the fade back, keeps its picture, then rewinds to its first frame', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(false));
    const now = Date.now();
    let s = reduce(initialState(), { k: 'goLive', resolved: r });
    s = reduce(s, { k: 'go', cueIndex: 0, at: now });
    await t.state(s);
    for (const l of t.cmds('load')) t.core.onMediaEvent({ k: 'loaded', slot: l.slot, key: l.key });
    await tick();
    const b = t.cmds('load').find((c) => c.key === 'md|1|vid2|d3')!;
    expect(b).toBeTruthy();
    s = reduce(s, { k: 'go', cueIndex: 1, at: now + 50 }); // b's clip plays
    await t.state(s);
    expect(
      t
        .cmds('apply')
        .filter((c) => c.slot === b.slot)
        .at(-1)?.transport.state,
    ).toBe('playing');
    const before = t.posts.length;
    s = reduce(s, { k: 'prev', at: now + 100 }); // during the 200 ms crossfade: a live again, b armed
    await t.state(s);
    const onB = () =>
      t.posts
        .slice(before)
        .flatMap((p) => (p.t === 'media' && 'slot' in p.cmd && p.cmd.slot === b.slot ? [p.cmd] : []));
    // Not frozen at once, and its picture never leaves the renderer: it is the outgoing side and armed.
    expect(onB().map((c) => c.k)).not.toContain('holdPaused');
    expect(onB().some((c) => c.k === 'vclear')).toBe(false);
    expect(onB().find((c) => c.k === 'pauseAt')).toMatchObject({ at: now + 300 });
    // When the fade ends it is sought back to its first frame, paused, for the next GO.
    await tick(Math.max(0, now + 300 - Date.now()) + 60);
    expect(
      onB()
        .filter((c) => c.k === 'apply')
        .at(-1),
    ).toMatchObject({
      k: 'apply',
      transport: { state: 'paused', positionMs: 0 },
    });
    // Later syncs, once it is no longer busy fading out, hold it paused there.
    await tick(Math.max(0, now + 400 - Date.now()) + 30);
    const n = onB().length;
    t.core.sync();
    expect(
      onB()
        .slice(n)
        .map((c) => c.k),
    ).toEqual(['holdPaused']);
    // GO to b again plays it from its start.
    s = reduce(s, { k: 'go', cueIndex: 1, at: now + 1000 });
    await t.state(s);
    expect(
      onB()
        .filter((c) => c.k === 'apply')
        .at(-1),
    ).toMatchObject({
      transport: { state: 'playing', startedAt: now + 1000, positionMs: 0 },
    });
    t.close();
  });

  it('a clip that played and is armed again after its fade is sought back at once', async () => {
    const t = setup();
    await t.core.start();
    t.core.applyConfig(config(false));
    const now = Date.now();
    let s = reduce(initialState(), { k: 'goLive', resolved: r });
    s = reduce(s, { k: 'go', cueIndex: 1, at: now - 5000 }); // b played and its fade is long over
    await t.state(s);
    for (const l of t.cmds('load')) t.core.onMediaEvent({ k: 'loaded', slot: l.slot, key: l.key });
    await tick();
    const b = t.cmds('load').find((c) => c.key === 'md|1|vid2|d3')!;
    s = reduce(s, { k: 'go', cueIndex: 0, at: now - 4000 }); // back to a, 4 s ago: b is armed
    await t.state(s);
    await tick(20);
    const applies = t.cmds('apply').filter((c) => c.slot === b.slot);
    expect(applies.at(-1)?.transport).toMatchObject({ state: 'paused', positionMs: 0 });
    t.close();
  });
});
