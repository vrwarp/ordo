/**
 * Clips of the native PowerPoint import (design/27 §2 step 5, §8 "Hub" and "p:timing mapping"; M3 wave 2,
 * M5 hub scope): crafted decks with generated clips (MP4, WMV, WMA, MP3, WAV) through the real
 * `pptx-native` job, CPU pool and media jobs.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { copyFile, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_GENERAL,
  DEFAULT_LOOKS,
  expandCues,
  type ImageObject,
  localDigest,
  type Media,
  type Presentation,
  resolvePlaylist,
  type Slide,
  slideContent,
} from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  CLRMAP_OVR,
  chartFrame,
  chartXml,
  clipRels,
  imageRel,
  type MediaTimingSpec,
  mediaPic,
  para,
  type RelSpec,
  run,
  type SlideSpec,
  sp,
  timingXml,
  withPart,
} from '@ordo/pptx-scene/test-util.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type JobCtx, MAX_JOB_ATTEMPTS } from '../src/jobs.ts';
import { volumeGainDb } from '../src/media/service.ts';
import { spillClips } from '../src/pptx/clips.ts';
import { spillDeckParts } from '../src/pptx/deckParts.ts';
import { nativeJob } from '../src/pptx/nativeJob.ts';
import { PPTX_LIMITS, type PptxNativePayload, type PptxNativeResult } from '../src/pptx/shared.ts';
import { ffmpeg, fixtures } from './fixtures.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

const IN = 914_400;
const W = 12_192_000;
const H = 6_858_000;

let hub: TestHub;
let dir: string;
const bytes: Record<string, Uint8Array> = {};

beforeAll(async () => {
  hub = await startHub();
  dir = tempDir('ordo-pptx-clips-');
  const m = join(dir, 'media');
  mkdirSync(m, { recursive: true });
  const av = (name: string, seconds: number, extra: string[]) =>
    ffmpeg(m, name, [
      ...['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=25:duration=${seconds}`],
      ...['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`],
      ...extra,
      '-shortest',
    ]);
  const files: Record<string, string> = {
    'clip.mp4': av('clip.mp4', 3, [
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
    ]),
    'loop.mp4': ffmpeg(m, 'loop.mp4', [
      ...['-f', 'lavfi', '-i', 'testsrc2=size=192x108:rate=25:duration=1'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
    ]),
    'clip.wmv': fixtures.wmv(m),
    'tune.mp3': ffmpeg(m, 'tune.mp3', [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=1',
      '-c:a',
      'libmp3lame',
    ]),
    'tone.wav': fixtures.wav(m),
    // Bytes no other test uses, so nothing is found already in the library.
    'order.wmv': av('order.wmv', 1, ['-c:v', 'wmv2', '-c:a', 'wmav2', '-ar', '22050']),
    'order.mp3': ffmpeg(m, 'order.mp3', [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=550:duration=1',
      '-c:a',
      'libmp3lame',
    ]),
    'chime.wav': ffmpeg(m, 'chime.wav', ['-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.5']),
    'failing.wav': ffmpeg(m, 'failing.wav', ['-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.5']),
    'resume.wmv': av('resume.wmv', 2, ['-c:v', 'wmv2', '-c:a', 'wmav2']),
    'poster.png': ffmpeg(m, 'poster.png', ['-f', 'lavfi', '-i', 'color=c=navy:s=320x180', '-frames:v', '1']),
    // A WMA whose stream list follows 12 KB of metadata, past the 4,100 bytes a sniff used to read.
    'big.wma': ffmpeg(m, 'big.wma', [
      ...['-f', 'lavfi', '-i', 'sine=frequency=470:duration=1'],
      ...['-metadata', `comment=${'x'.repeat(6000)}`, '-c:a', 'wmav2'],
    ]),
    // An audio-only MP4 of brand isom: its head looks like any MP4 video.
    'isom.mp4': ffmpeg(m, 'isom.mp4', [
      ...['-f', 'lavfi', '-i', 'sine=frequency=490:duration=1'],
      ...['-c:a', 'aac', '-brand', 'isom'],
    ]),
    'trims.mp3': ffmpeg(m, 'trims.mp3', [
      ...['-f', 'lavfi', '-i', 'sine=frequency=510:duration=1'],
      ...['-c:a', 'libmp3lame'],
    ]),
    'orphan.wav': ffmpeg(m, 'orphan.wav', ['-f', 'lavfi', '-i', 'sine=frequency=530:duration=0.5']),
    'given-up.wav': ffmpeg(m, 'given-up.wav', ['-f', 'lavfi', '-i', 'sine=frequency=550:duration=0.5']),
    'hash.mp4': av('hash.mp4', 1, ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']),
    // Two seconds: bytes no other clip has (hash.mp4 is the same encode at one second).
    'collide.mp4': av('collide.mp4', 2, ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']),
    'no-deck.wav': ffmpeg(m, 'no-deck.wav', ['-f', 'lavfi', '-i', 'sine=frequency=570:duration=0.5']),
    'no-scratch.wav': ffmpeg(m, 'no-scratch.wav', ['-f', 'lavfi', '-i', 'sine=frequency=590:duration=0.5']),
  };
  for (const [k, f] of Object.entries(files)) bytes[k] = await readFile(f);
  bytes['garbage.mp4'] = new TextEncoder().encode('this is not a video at all, only text');
  // An MP4 header over nothing: sniffed as a video, so it is stored; its media job fails.
  const corrupt = new Uint8Array(4096);
  corrupt.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
  bytes['corrupt.mp4'] = corrupt;
}, 120_000);
afterAll(async () => {
  await hub?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type ClipSpec = {
  id: number;
  kind: 'video' | 'audio';
  /** The clip's bytes (`bytes` key); its part is `ppt/media/<n>-<file>`, or `part` when given. */
  file: string;
  part?: string;
  /** Written under the other element (pptxgenjs writes sounds under `a:videoFile`). */
  element?: 'video' | 'audio';
  box?: { x: number; y: number; cx: number; cy: number };
  timing?: Omit<MediaTimingSpec, 'spid' | 'kind'>;
  trim?: { st?: number; end?: number };
  /** Linked (External): this URL instead of a part. */
  url?: string;
};

const BOX = { x: IN, y: IN, cx: 4 * IN, cy: 2.25 * IN };

/** A slide with these clips (each its own poster) and `shapes` above them. */
function clipSlide(clips: ClipSpec[], shapes = '', o: { after?: string; rels?: RelSpec[] } = {}): SlideSpec {
  const rels: RelSpec[] = [imageRel('rIdP', 'poster.png'), ...(o.rels ?? [])];
  let xml = '';
  const timing: MediaTimingSpec[] = [];
  for (const c of clips) {
    const el = c.element ?? c.kind;
    const part = c.part ?? c.file;
    if (c.url) rels.push({ id: `rIdL${c.id}`, type: el, target: c.url, external: true });
    else rels.push(...clipRels(el, part, { embed: `rIdE${c.id}`, link: `rIdL${c.id}` }));
    xml += mediaPic({
      id: c.id,
      kind: el,
      rId: 'rIdP',
      ...(c.url ? {} : { embed: `rIdE${c.id}` }),
      link: `rIdL${c.id}`,
      ...(c.box ?? BOX),
      ...(c.trim ? { trim: c.trim } : {}),
    });
    if (c.timing) timing.push({ spid: c.id, kind: c.kind, ...c.timing });
  }
  return {
    shapes: xml + shapes,
    rels,
    after: `${CLRMAP_OVR}${o.after ?? ''}${timing.length ? timingXml(timing) : ''}`,
  };
}

/** The deck's media parts: the poster and every clip file the slides name. */
function deckOf(slides: SlideSpec[], files: Record<string, string>): Map<string, Uint8Array> {
  const media: Record<string, Uint8Array> = { 'ppt/media/poster.png': bytes['poster.png']! };
  for (const [part, file] of Object.entries(files)) media[`ppt/media/${part}`] = bytes[file]!;
  return buildDeck({ slides, media });
}

async function importDeck(
  parts: Map<string, Uint8Array>,
  name: string,
  options: { transitionSounds?: boolean } = {},
): Promise<{ job: Job; result: PptxNativeResult; p: Presentation }> {
  const file = await zipDeck(parts, dir, `${Math.random().toString(36).slice(2)}.pptx`);
  const hash = await storeDeck(hub, file);
  const queued = hub.imports.pptx.queueNative(hash, name, options);
  const job = await waitJob(hub, queued.id);
  if (job.state !== 'done') throw new Error(`import failed: ${job.error}\n${job.log.join('\n')}`);
  const result = job.result as PptxNativeResult;
  return { job, result, p: hub.lib.presentations.must(result.presentationId) };
}

const images = (s: Slide) => s.objects.filter((o): o is ImageObject => o.type === 'image');
const playOf = (s: Slide) => images(s).find((o) => o.play)?.play;

/** The media jobs queued for an item (any state). */
function mediaJobs(mediaId: string): Job[] {
  return hub.jobs.list(1_000).filter((j) => j.kind === 'media' && jobPayload(j.id)?.mediaId === mediaId);
}
function jobPayload(id: string): { mediaId?: string } | undefined {
  const r = hub.lib.db.prepare('SELECT payload FROM jobs WHERE id = ?').get(id) as
    | { payload: string }
    | undefined;
  return r ? JSON.parse(r.payload) : undefined;
}

async function settled(mediaIds: string[], timeoutMs = 120_000): Promise<Media[]> {
  const t0 = Date.now();
  for (;;) {
    const all = mediaIds.map((id) => hub.lib.media.must(id));
    if (all.every((m) => m.state === 'ready' || m.state === 'failed')) return all;
    if (Date.now() - t0 > timeoutMs) throw new Error(`media still ${all.map((m) => m.state).join(', ')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('pptx-native: clips play in place', () => {
  let p: Presentation;
  let job: Job;
  let slides: Slide[];

  beforeAll(async () => {
    const full = { x: 0, y: 0, cx: W, cy: H };
    const title = sp({
      id: 20,
      x: IN,
      y: IN,
      cx: 8 * IN,
      cy: IN,
      ph: 'title',
      txBody: body(para(run('Welcome'))),
    });
    const parts = deckOf(
      [
        // 1. A trimmed, looping, autoplay MP4 (kept: 0.5 s to 2 s of 3 s).
        clipSlide([
          {
            id: 4,
            kind: 'video',
            file: 'clip.mp4',
            trim: { st: 500, end: 1000 },
            timing: { start: 'auto', loop: true, rewind: true, vol: 80_000 },
          },
        ]),
        // 2. A WMV that waits for a click, and an MP3 sound over three slides with its icon hidden.
        clipSlide([
          { id: 4, kind: 'video', file: 'clip.wmv', timing: { start: 'trigger' } },
          {
            id: 5,
            kind: 'audio',
            file: 'tune.mp3',
            box: { x: W - IN, y: H - IN, cx: IN / 2, cy: IN / 2 },
            timing: { start: 'auto', numSld: 3, showWhenStopped: false },
          },
        ]),
        // 3. A WAV written under a:videoFile, as pptxgenjs does: the bytes say it is a sound.
        clipSlide([{ id: 4, kind: 'video', file: 'tone.wav', element: 'video', timing: { start: 'auto' } }]),
        // 4. A clip that is not a video, and a linked one: [warn] lines, posters.
        clipSlide([
          { id: 4, kind: 'video', file: 'garbage.mp4', timing: { start: 'auto' } },
          {
            id: 5,
            kind: 'video',
            file: '',
            url: 'https://www.youtube.com/embed/xyz?private=1',
            box: { ...BOX, x: 6 * IN },
          },
        ]),
        // 5. A looping, muted video over the whole slide under a title: the motion background.
        clipSlide(
          [
            {
              id: 4,
              kind: 'video',
              file: 'loop.mp4',
              box: full,
              timing: { start: 'auto', loop: true, mute: true },
            },
          ],
          title,
        ),
        // 6. The MP4 again, whole (another clip), and the WMV again (the same clip).
        clipSlide([
          { id: 4, kind: 'video', file: 'clip.mp4', part: 'clip-again.mp4', timing: { start: 'click' } },
          { id: 5, kind: 'audio', file: 'tune.mp3', part: 'tune-again.mp3', timing: { start: 'auto' } },
        ]),
        // 7. A clip whose media job fails: it stays in place, optional at goLive.
        clipSlide([{ id: 4, kind: 'video', file: 'corrupt.mp4', timing: { start: 'auto' } }]),
      ],
      {
        'clip.mp4': 'clip.mp4',
        'clip.wmv': 'clip.wmv',
        'tune.mp3': 'tune.mp3',
        'tone.wav': 'tone.wav',
        'garbage.mp4': 'garbage.mp4',
        'loop.mp4': 'loop.mp4',
        'clip-again.mp4': 'clip.mp4',
        'tune-again.mp3': 'tune.mp3',
        'corrupt.mp4': 'corrupt.mp4',
      },
    );
    ({ p, job } = await importDeck(parts, 'Clips.pptx'));
    slides = slidesOf(p);
  }, 120_000);

  it('stores each clip, tagged and named for the deck, and plays it in place with its timing', () => {
    const play1 = playOf(slides[0]!)!;
    expect(play1).toEqual({
      mediaId: expect.any(String),
      start: 'auto',
      loop: true,
      onEnd: 'black',
      gainDb: volumeGainDb(80_000),
    });
    const m1 = hub.lib.media.must(play1.mediaId);
    expect(m1).toMatchObject({ kind: 'video', tags: ['pptx'], name: 'Clips – slide 1 video' });
    // The trim is baked: 0.5 s from the start, and PowerPoint's `end` is cut from the end of 3 s.
    expect(m1.trim).toEqual({ startMs: 500, endMs: 2000 });

    const play2 = playOf(slides[1]!)!;
    expect(play2).toEqual({ mediaId: expect.any(String), start: 'click' });
    expect(hub.lib.media.must(play2.mediaId)).toMatchObject({ kind: 'video', name: 'Clips – slide 2 video' });
    expect(slides[1]!.audio).toEqual({ mediaId: expect.any(String), start: 'auto', slides: 3 });
    expect(hub.lib.media.must(slides[1]!.audio!.mediaId)).toMatchObject({
      kind: 'audio',
      name: 'Clips – slide 2 sound',
      tags: ['pptx'],
    });
    // The hidden audio icon is not drawn: only the video's poster is left.
    expect(images(slides[1]!)).toHaveLength(1);

    // pptxgenjs's sound under a:videoFile: the slide's sound, not a video.
    expect(playOf(slides[2]!)).toBeUndefined();
    expect(hub.lib.media.must(slides[2]!.audio!.mediaId).kind).toBe('audio');
  });

  it('a clip that cannot be imported, or a linked one, leaves a [warn] line and its poster', () => {
    const s4 = slides[3]!;
    expect(images(s4)).toHaveLength(2);
    expect(images(s4).every((o) => !o.play)).toBe(true);
    const log = job.log.join('\n');
    expect(log).toMatch(/\[warn\] slide 4: the video could not be imported \(.*\): its poster is shown/);
    expect(log).toContain('[warn] slide 4: linked video (www.youtube.com) not imported: its poster is shown');
    expect(log).not.toContain('private=1');
    expect(p.source!.log).toContain('[warn] slide 4: linked video (www.youtube.com) not imported');
    expect(s4.pptx!.notes).toContain('the video could not be imported: its poster is shown');
  });

  it("makes a looping, muted full-slide video the slide's motion background, never the presentation's", () => {
    const s5 = slides[4]!;
    const bg = hub.lib.media.must(s5.backgroundMediaId!);
    expect(bg).toMatchObject({ kind: 'video', name: 'Clips – slide 5 video' });
    expect(p.backgroundMediaId).toBeUndefined();
    // The poster and the solid background under it are gone; the title stays.
    expect(s5.objects.map((o) => o.type)).toEqual(['text']);
  });

  it('one clip per part and trim: the same file whole is another clip, the same bytes again the same one', () => {
    const whole = playOf(slides[5]!)!.mediaId;
    expect(whole).not.toBe(playOf(slides[0]!)!.mediaId);
    expect(hub.lib.media.must(whole).trim).toBeUndefined();
    expect(slides[5]!.audio!.mediaId).toBe(slides[1]!.audio!.mediaId);
    // Every clip's media job is queued once, after the import saved version 1.
    for (const id of new Set([whole, playOf(slides[0]!)!.mediaId, slides[5]!.audio!.mediaId]))
      expect(mediaJobs(id)).toHaveLength(1);
  });

  it('the media jobs bake the trim; a clip whose job fails stays in place and goLive shows its poster', async () => {
    const trimmed = playOf(slides[0]!)!.mediaId;
    const broken = playOf(slides[6]!)!.mediaId;
    const background = slides[4]!.backgroundMediaId!;
    const [t, b, bgm] = await settled([trimmed, broken, background]);
    expect(t!.state).toBe('ready');
    expect(t!.durationMs).toBeGreaterThan(1300);
    expect(t!.durationMs).toBeLessThan(1700);
    expect(b!.state).toBe('failed');
    expect(bgm!.state).toBe('ready');
    const r = resolvePlaylist(
      {
        playlist: {
          id: 'pl',
          rev: 1,
          name: 'Sunday',
          items: [{ id: 'i', kind: 'presentation', presentationId: p.id }],
        },
        presentation: (id) => hub.lib.presentations.get(id),
        media: (id) => hub.lib.media.get(id),
        fonts: () => [],
        looks: DEFAULT_LOOKS,
        general: DEFAULT_GENERAL,
      },
      'pl',
      { digest: localDigest },
    );
    expect(r.degraded?.map((d) => d.reason)).toContain(
      '"Clips – slide 7 video" (slide video) failed; showing its poster',
    );
  }, 180_000);
});

describe('pptx-native: clips and the LibreOffice follow-up', () => {
  it("queues the clips' media jobs after the follow-up, so LibreOffice never waits behind a transcode", async () => {
    const chart = chartFrame({ id: 9, x: 6 * IN, y: IN, cx: 4 * IN, cy: 3 * IN, rId: 'rIdC' });
    const parts = deckOf(
      [
        clipSlide(
          [{ id: 4, kind: 'video', file: 'clip.wmv', part: 'other.wmv', timing: { start: 'auto' } }],
          chart,
          {
            rels: [{ id: 'rIdC', type: 'chart', target: '../charts/chart1.xml' }],
          },
        ),
        clipSlide([{ id: 4, kind: 'audio', file: 'tune.mp3', part: 'other.mp3', timing: { start: 'auto' } }]),
      ],
      { 'other.wmv': 'order.wmv', 'other.mp3': 'order.mp3' },
    );
    withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
    const { result, p } = await importDeck(parts, 'Ordered.pptx');
    expect(result.loJobId).toBeDefined();
    const lo = hub.jobs.get(result.loJobId!);
    const [s1, s2] = slidesOf(p) as [Slide, Slide];
    const clips = [playOf(s1)!.mediaId, s2.audio!.mediaId];
    const order = (j: Job) => `${j.createdAt}|${j.id}`;
    for (const id of clips) {
      const [mj] = mediaJobs(id);
      expect(mj).toBeDefined();
      expect(order(mj!) > order(lo)).toBe(true);
    }
  }, 120_000);
});

describe('pptx-native: transition sounds and resume', () => {
  it('imports a transition sound only with the option', async () => {
    const transition =
      '<p:transition><p:fade/><p:sndAc><p:stSnd><p:snd r:embed="rIdS" name="chime.wav"/></p:stSnd></p:sndAc></p:transition>';
    const slide = clipSlide([], '', {
      after: transition,
      rels: [{ id: 'rIdS', type: 'audio', target: '../media/chime.wav' }],
    });
    const parts = deckOf([slide], { 'chime.wav': 'chime.wav' });
    const off = await importDeck(parts, 'Chime.pptx');
    expect(slidesOf(off.p)[0]!.audio).toBeUndefined();
    const on = await importDeck(parts, 'Chime.pptx', { transitionSounds: true });
    const audio = slidesOf(on.p)[0]!.audio!;
    expect(audio.start).toBe('auto');
    expect(hub.lib.media.must(audio.mediaId)).toMatchObject({ kind: 'audio', name: 'Chime – slide 1 sound' });
  }, 60_000);

  it('a re-run reuses the clips it stored: no clip is stored or queued twice', async () => {
    const parts = deckOf(
      [
        clipSlide([
          { id: 4, kind: 'video', file: 'clip.wmv', part: 'resume.wmv', timing: { start: 'auto' } },
        ]),
      ],
      {
        'resume.wmv': 'resume.wmv',
      },
    );
    const file = await zipDeck(parts, dir, 'resume.pptx');
    const hash = await storeDeck(hub, file);
    const run = async (payload: PptxNativePayload) => {
      const ctx: JobCtx<PptxNativePayload> = {
        id: 'direct',
        payload,
        signal: new AbortController().signal,
        log: () => {},
        progress: () => {},
        setPayload: (pl) => {
          ctx.payload = pl;
        },
      };
      const out = (await nativeJob(hub.imports.pptx.deps)(ctx)) as PptxNativeResult;
      return { out, payload: ctx.payload };
    };
    const first = await run({ hash, name: 'Resume.pptx' });
    const clip = playOf(slidesOf(hub.lib.presentations.must(first.out.presentationId))[0]!)!.mediaId;
    expect(first.payload.done!.clips).toEqual([['ppt/media/resume.wmv', clip]]);
    const count = hub.lib.media.list().filter((m) => m.name.startsWith('Resume')).length;
    // A run that died before its save: the pairs are kept, the presentation is not.
    const again = await run({
      hash,
      name: 'Resume.pptx',
      done: { media: first.payload.done!.media, clips: first.payload.done!.clips! },
    });
    const p2 = hub.lib.presentations.must(again.out.presentationId);
    expect(playOf(slidesOf(p2)[0]!)!.mediaId).toBe(clip);
    expect(hub.lib.media.list().filter((m) => m.name.startsWith('Resume'))).toHaveLength(count);
    expect(mediaJobs(clip)).toHaveLength(1);
  }, 60_000);

  it('an import that fails after storing its clips still queues their media jobs', async () => {
    const parts = deckOf(
      [clipSlide([{ id: 4, kind: 'audio', file: 'failing.wav', timing: { start: 'auto' } }])],
      { 'failing.wav': 'failing.wav' },
    );
    const file = await zipDeck(parts, dir, 'failing.pptx');
    const hash = await storeDeck(hub, file);
    const lib = hub.lib;
    const failing = new Proxy(lib, {
      get(target, key) {
        if (key === 'savePresentation')
          return () => {
            throw new Error('the disk is full');
          };
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const ctx: JobCtx<PptxNativePayload> = {
      id: 'direct',
      payload: { hash, name: 'Failing.pptx' },
      signal: new AbortController().signal,
      log: () => {},
      progress: () => {},
      setPayload: (pl) => {
        ctx.payload = pl;
      },
    };
    await expect(nativeJob({ ...hub.imports.pptx.deps, lib: failing })(ctx)).rejects.toThrow(
      /the disk is full/,
    );
    const [pair] = ctx.payload.done!.clips!;
    expect(hub.lib.media.must(pair![1]).name).toBe('Failing – slide 1 sound');
    expect(mediaJobs(pair![1])).toHaveLength(1);
  }, 60_000);
});

describe('pptx-native: clips and the one fallback rule (M3 wave 2 items A and B)', () => {
  it("marks every object a clip leaves as the import's: a slide showing its PowerPoint picture hides them", async () => {
    const full = { x: 0, y: 0, cx: W, cy: H };
    const title = sp({
      id: 20,
      x: IN,
      y: IN,
      cx: 8 * IN,
      cy: IN,
      ph: 'title',
      txBody: body(para(run('Announcements'))),
    });
    const parts = deckOf(
      [
        // 1. A boxed autoplay clip under a title: the poster carries `play`.
        clipSlide(
          [{ id: 4, kind: 'video', file: 'clip.mp4', part: 'boxed.mp4', timing: { start: 'auto' } }],
          title,
        ),
        // 2. A looping, muted full-slide video that cannot be imported (not a video): its poster goes back
        //    at the bottom as the slide's background.
        clipSlide(
          [
            {
              id: 4,
              kind: 'video',
              file: 'garbage.mp4',
              part: 'motion.mp4',
              box: full,
              timing: { start: 'auto', loop: true, mute: true },
            },
          ],
          title,
        ),
      ],
      { 'boxed.mp4': 'clip.mp4', 'motion.mp4': 'garbage.mp4' },
    );
    const { p } = await importDeck(parts, 'Fallback.pptx');
    const [s1, s2] = slidesOf(p) as [Slide, Slide];
    expect(playOf(s1)).toBeDefined();
    expect(s2.backgroundMediaId).toBeUndefined();
    const bottom = s2.objects[0]!;
    expect(bottom).toMatchObject({ type: 'image', origin: { src: 'pptx', role: 'bg' } });
    expect((bottom as ImageObject).play).toBeUndefined();
    for (const s of [s1, s2]) {
      expect(s.objects.every((o) => o.origin?.src === 'pptx')).toBe(true);
      // 'Show PowerPoint picture': the reference picture and only the operator's own objects are drawn.
      const mine = {
        id: 'mine',
        type: 'shape',
        box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
        shape: 'rect',
      };
      const shown = slideContent({
        ...s,
        objects: [...s.objects, mine as never],
        pptx: { ...s.pptx!, refMediaId: 'ref', show: 'picture' },
      });
      expect(shown.pictureMediaId).toBe('ref');
      expect(shown.objects.map((o) => o.id)).toEqual(['mine']);
    }
  }, 60_000);
});

describe('pptx-native: clips the bytes or the deck could mislead (review)', () => {
  it('a sound element stays a sound whatever its container: a WMA with a long header, an isom MP4', async () => {
    const icon = { x: W - IN, y: H - IN, cx: IN / 2, cy: IN / 2 };
    const parts = deckOf(
      [
        clipSlide([
          {
            id: 4,
            kind: 'audio',
            file: 'big.wma',
            box: icon,
            timing: { start: 'auto', showWhenStopped: false },
          },
        ]),
        clipSlide([{ id: 4, kind: 'audio', file: 'isom.mp4', box: icon, timing: { start: 'auto' } }]),
      ],
      { 'big.wma': 'big.wma', 'isom.mp4': 'isom.mp4' },
    );
    const { p, job } = await importDeck(parts, 'Sounds.pptx');
    const [s1, s2] = slidesOf(p) as [Slide, Slide];
    for (const s of [s1, s2]) {
      expect(playOf(s)).toBeUndefined();
      expect(s.audio).toMatchObject({ mediaId: expect.any(String), start: 'auto' });
    }
    // The hidden icon is not drawn; the one shown while stopped is.
    expect(images(s1)).toHaveLength(0);
    expect(images(s2)).toHaveLength(1);
    expect(p.source!.log).toContain('slide 1: sound stored');
    expect(p.source!.log).toContain('slide 2: sound stored');
    expect(job.log.join('\n')).not.toContain('[warn]');
    const [a1, a2] = await settled([s1.audio!.mediaId, s2.audio!.mediaId]);
    expect(a1).toMatchObject({ kind: 'audio', state: 'ready' });
    expect(a2).toMatchObject({ state: 'ready' });
    // The cue plays them as the slide's sound.
    const resolved = resolvePlaylist(
      {
        playlist: {
          id: 'pl',
          rev: 1,
          name: 'Sunday',
          items: [{ id: 'i', kind: 'presentation', presentationId: p.id }],
        },
        presentation: (id) => hub.lib.presentations.get(id),
        media: (id) => hub.lib.media.get(id),
        fonts: () => [],
        looks: DEFAULT_LOOKS,
        general: DEFAULT_GENERAL,
      },
      'pl',
      { digest: localDigest },
    );
    expect(expandCues(resolved).map((c) => c.slideAudio?.mediaId)).toEqual([
      s1.audio!.mediaId,
      s2.audio!.mediaId,
    ]);
  }, 120_000);

  it('the clip limit counts parts and trims: one part trimmed on every slide stores at most the limit', async () => {
    const n = PPTX_LIMITS.clips + 5;
    const slides = Array.from({ length: n }, (_, i) =>
      clipSlide([
        { id: 4, kind: 'audio', file: 'trims.mp3', trim: { st: 10 * (i + 1) }, timing: { start: 'auto' } },
      ]),
    );
    const before = new Set(hub.lib.media.list().map((m) => m.id));
    const { p, job } = await importDeck(deckOf(slides, { 'trims.mp3': 'trims.mp3' }), 'Trims.pptx');
    const created = hub.lib.media.list().filter((m) => !before.has(m.id) && m.name.startsWith('Trims'));
    expect(created).toHaveLength(PPTX_LIMITS.clips);
    expect(created.flatMap((m) => mediaJobs(m.id))).toHaveLength(PPTX_LIMITS.clips);
    const sl = slidesOf(p);
    expect(sl.filter((s) => s.audio)).toHaveLength(PPTX_LIMITS.clips);
    expect(sl.at(-1)!.audio).toBeUndefined();
    const log = job.log.join('\n');
    expect(log).toContain(
      `[warn] 5 clip(s) past the ${PPTX_LIMITS.clips} (parts and trims) an import may store`,
    );
    expect(log).toContain(
      `[warn] slide ${n}: the sound could not be imported (past the ${PPTX_LIMITS.clips} clips`,
    );
    await hub.jobs.idle();
  }, 180_000);

  it('a part whose name holds # is the same part whole and trimmed; a [warn] never shows a scratch path', async () => {
    const parts = deckOf(
      [
        clipSlide([
          { id: 4, kind: 'video', file: 'hash.mp4', part: 'h%23ash.mp4', timing: { start: 'auto' } },
        ]),
        clipSlide([
          {
            id: 4,
            kind: 'video',
            file: 'hash.mp4',
            part: 'h%23ash.mp4',
            trim: { st: 200 },
            timing: { start: 'auto' },
          },
        ]),
      ],
      { 'h#ash.mp4': 'hash.mp4' },
    );
    const { p, job } = await importDeck(parts, 'Hash.pptx');
    const [s1, s2] = slidesOf(p) as [Slide, Slide];
    const whole = playOf(s1)!.mediaId;
    const trimmed = playOf(s2)!.mediaId;
    expect(whole).not.toBe(trimmed);
    expect(hub.lib.media.must(trimmed).trim).toEqual({ startMs: 200, endMs: expect.any(Number) });
    expect(job.log.join('\n')).not.toContain('could not be imported');
    expect(`${job.log.join('\n')}\n${p.source!.log}`).not.toMatch(/[\\/]tmp[\\/]/);
  }, 120_000);

  it('a resumed run that fails queues the clips an earlier attempt stored', async () => {
    const parts = deckOf(
      [clipSlide([{ id: 4, kind: 'audio', file: 'orphan.wav', timing: { start: 'auto' } }])],
      { 'orphan.wav': 'orphan.wav' },
    );
    const hash = await storeDeck(hub, await zipDeck(parts, dir, 'orphan.pptx'));
    const deps = hub.imports.pptx.deps;
    const proxy = <T extends object>(target: T, key: string, v: unknown): T =>
      new Proxy(target, {
        get(t, k) {
          if (k === key) return v;
          const x = Reflect.get(t, k, t);
          return typeof x === 'function' ? x.bind(t) : x;
        },
      });
    const failing = proxy(deps.lib, 'savePresentation', () => {
      throw new Error('stopped');
    });
    const ctxOf = (payload: PptxNativePayload) => {
      const ctx: JobCtx<PptxNativePayload> = {
        id: 'direct',
        payload,
        signal: new AbortController().signal,
        log: () => {},
        progress: () => {},
        setPayload: (pl) => {
          ctx.payload = pl;
        },
      };
      return ctx;
    };
    // Attempt 1 dies after storing the clip (nothing of the process runs after it: no queue).
    const ctx1 = ctxOf({ hash, name: 'Orphan.pptx' });
    const dead = proxy(deps.media, 'queue', () => undefined);
    await expect(nativeJob({ ...deps, lib: failing, media: dead })(ctx1)).rejects.toThrow(/stopped/);
    const id = ctx1.payload.done!.clips![0]![1];
    expect(hub.lib.media.must(id).state).toBe('uploaded');
    expect(mediaJobs(id)).toHaveLength(0);
    // Attempt 2 resumes from the pairs, reuses the clip and fails: the clip is queued now.
    await expect(nativeJob({ ...deps, lib: failing })(ctxOf(ctx1.payload))).rejects.toThrow(/stopped/);
    expect(mediaJobs(id)).toHaveLength(1);
    expect((await settled([id]))[0]!.state).toBe('ready');
  }, 60_000);

  it('a job abandoned after repeated crashes queues the clips it stored (its give-up)', async () => {
    const f = join(dir, 'given-up-copy.wav');
    await copyFile(join(dir, 'media', 'given-up.wav'), f);
    const m = await hub.media.ingest({ path: f }, 'Given up – slide 1 sound', {
      queue: false,
      tags: ['pptx'],
    });
    await hub.jobs.idle();
    const now = new Date().toISOString();
    const jobId = `abandoned-${Math.random().toString(36).slice(2)}`;
    const payload: PptxNativePayload = {
      hash: 'f'.repeat(64),
      name: 'Given up.pptx',
      done: { media: [], clips: [['ppt/media/given-up.wav', m.id]] },
    };
    hub.lib.db
      .prepare(
        `INSERT INTO jobs (id, kind, class, state, progress, payload, log, created_at, updated_at) VALUES (?, 'pptx-native', 'light', 'running', 0, ?, '[]', ?, ?)`,
      )
      .run(jobId, JSON.stringify(payload), now, now);
    hub.lib.db
      .prepare('INSERT INTO job_attempts (job_id, attempts) VALUES (?, ?)')
      .run(jobId, MAX_JOB_ATTEMPTS);
    hub.jobs.start(); // the sweep a restart runs
    expect(hub.jobs.get(jobId).state).toBe('failed');
    expect(mediaJobs(m.id)).toHaveLength(1);
    expect((await settled([m.id]))[0]!.state).toBe('ready');
  }, 60_000);
});

describe('pptx-native: clips beside the pictures, and resumed attempts (re-review)', () => {
  it("never overwrites or takes away a picture's spilled file: a clip part of a picture's extension, a part both", async () => {
    // Both spills name their files entry-N<part extension> from 1: in one folder, the clip media1.png would
    // overwrite the picture image1.png, and renaming the clip both.png would take the picture both.png away.
    const deck = await zipDeck(
      new Map([
        ['ppt/media/image1.png', bytes['poster.png']!],
        ['ppt/media/media1.png', bytes['collide.mp4']!],
        ['ppt/media/both.png', bytes['poster.png']!],
      ]),
      dir,
      'collide-parts.pptx',
    );
    const scratch = await hub.store.tmpDir();
    const signal = new AbortController().signal;
    try {
      const pictures = await spillDeckParts(
        deck,
        scratch,
        ['ppt/media/image1.png', 'ppt/media/both.png'],
        signal,
      );
      const clips = await spillClips(
        deck,
        scratch,
        ['ppt/media/media1.png', 'ppt/media/both.png'],
        PPTX_LIMITS.spillBytes,
        signal,
      );
      expect(pictures.files.size).toBe(2);
      for (const file of pictures.files.values())
        expect(Buffer.compare(await readFile(file), Buffer.from(bytes['poster.png']!))).toBe(0);
      const video = clips.files.get('ppt/media/media1.png')!;
      expect(video.kind).toBe('video');
      expect(Buffer.compare(await readFile(video.file), Buffer.from(bytes['collide.mp4']!))).toBe(0);
      expect(clips.files.get('ppt/media/both.png')).toMatchObject({ file: expect.any(String) });
      expect(clips.files.get('ppt/media/both.png')!.kind).toBeUndefined();
      // No clip file is a picture's, and the pictures' folder holds only the pictures and the clips' folder.
      const pictureFiles = new Set(pictures.files.values());
      for (const c of clips.files.values()) expect(pictureFiles.has(c.file)).toBe(false);
      expect((await readdir(scratch)).filter((f) => !f.startsWith('clips-')).sort()).toEqual(
        [...pictureFiles].map((f) => f.slice(scratch.length + 1)).sort(),
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    // Through the job: the poster's part and a clip part of the same extension, and a clip named by the
    // poster's own part. Both posters are stored, the first clip plays, the second is no video.
    const parts = deckOf(
      [
        clipSlide([
          { id: 4, kind: 'video', file: 'collide.mp4', part: 'collide.png', timing: { start: 'auto' } },
        ]),
        clipSlide([
          { id: 4, kind: 'video', file: 'poster.png', part: 'poster.png', timing: { start: 'auto' } },
        ]),
      ],
      { 'collide.png': 'collide.mp4' },
    );
    const { p, job } = await importDeck(parts, 'Collide.pptx');
    const [s1, s2] = slidesOf(p) as [Slide, Slide];
    for (const s of [s1, s2]) {
      const [poster] = images(s);
      expect(poster).toBeDefined();
      expect(hub.lib.media.must(poster!.mediaId)).toMatchObject({ kind: 'image', state: 'ready' });
    }
    expect(hub.lib.media.must(playOf(s1)!.mediaId)).toMatchObject({
      kind: 'video',
      name: 'Collide – slide 1 video',
    });
    expect(playOf(s2)).toBeUndefined();
    const log = job.log.join('\n');
    expect(log).not.toContain('a picture could not be imported');
    expect(log).toContain('[warn] slide 2: the video could not be imported (not a video or sound file)');
    await settled([playOf(s1)!.mediaId]);
  }, 120_000);

  it('a resumed attempt that fails before its run starts (the deck gone, no scratch folder) queues the stored clips', async () => {
    const deps = hub.imports.pptx.deps;
    const proxy = <T extends object>(target: T, key: string, v: unknown): T =>
      new Proxy(target, {
        get(t, k) {
          if (k === key) return v;
          const x = Reflect.get(t, k, t);
          return typeof x === 'function' ? x.bind(t) : x;
        },
      });
    const ctxOf = (payload: PptxNativePayload) => {
      const ctx: JobCtx<PptxNativePayload> = {
        id: 'direct',
        payload,
        signal: new AbortController().signal,
        log: () => {},
        progress: () => {},
        setPayload: (pl) => {
          ctx.payload = pl;
        },
      };
      return ctx;
    };
    const failing = proxy(deps.lib, 'savePresentation', () => {
      throw new Error('stopped');
    });
    const cases: { file: string; resumed: Partial<typeof deps>; error: RegExp }[] = [
      {
        file: 'no-deck.wav',
        resumed: { lib: proxy(deps.lib, 'getFile', () => undefined) },
        error: /deck is missing/,
      },
      {
        file: 'no-scratch.wav',
        resumed: { store: proxy(deps.store, 'tmpDir', () => Promise.reject(new Error('no scratch folder'))) },
        error: /no scratch folder/,
      },
    ];
    for (const c of cases) {
      const parts = deckOf([clipSlide([{ id: 4, kind: 'audio', file: c.file, timing: { start: 'auto' } }])], {
        [c.file]: c.file,
      });
      const hash = await storeDeck(hub, await zipDeck(parts, dir, `${c.file}.pptx`));
      // Attempt 1 dies after storing the clip (nothing of the process runs after it: no queue).
      const ctx1 = ctxOf({ hash, name: `${c.file}.pptx` });
      const dead = proxy(deps.media, 'queue', () => undefined);
      await expect(nativeJob({ ...deps, lib: failing, media: dead })(ctx1)).rejects.toThrow(/stopped/);
      const id = ctx1.payload.done!.clips![0]![1];
      expect(hub.lib.media.must(id).state).toBe('uploaded');
      expect(mediaJobs(id)).toHaveLength(0);
      // Attempt 2 stops before NativeImport runs: the clip of attempt 1 is queued all the same.
      await expect(nativeJob({ ...deps, ...c.resumed })(ctxOf(ctx1.payload))).rejects.toThrow(c.error);
      expect(mediaJobs(id), c.file).toHaveLength(1);
      expect((await settled([id]))[0]!.state).toBe('ready');
    }
  }, 60_000);
});
