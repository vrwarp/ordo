import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Media, MediaTrim } from '@ordo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureLoudness, trimArgs } from '../src/media/ffmpeg.ts';
import { keptMs, normTrim, sameTrim, volumeGainDb } from '../src/media/service.ts';
import { extensionAgrees, hashFile, type Sniffed, sniff } from '../src/store.ts';
import { fixtures } from './fixtures.ts';
import { type Client, EDIT_PIN, login, startHub, type TestHub, tempDir } from './helpers.ts';

/*
 * Old church clips and PowerPoint media (design/27 §8 "Hub"): ASF, MPEG program streams and AIFF ingest,
 * trims are baked into the delivery and deduplicated with the hash, and video soundtracks are measured for
 * loudness like audio files (design/18 "Gain staging").
 */

let hub: TestHub;
let ed: Client;
const fx = tempDir('ordo-fx-formats-');

beforeAll(async () => {
  hub = await startHub();
  ed = await login(hub.url, EDIT_PIN);
});
afterAll(async () => {
  await hub.cleanup();
  rmSync(fx, { recursive: true, force: true });
});

const head = (path: string) => readFileSync(path).subarray(0, 4100);
const bytes = (...xs: (number | string)[]) =>
  new Uint8Array(xs.flatMap((x) => (typeof x === 'string' ? [...Buffer.from(x, 'latin1')] : [x])));
const ASF = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];

async function uploaded(path: string): Promise<Media> {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(path)]), basename(path));
  const res = await ed.fetch('/media', { method: 'POST', body: fd });
  expect(res.status).toBe(201);
  const m = (await res.json()) as Media;
  await hub.jobs.idle();
  return hub.lib.media.must(m.id);
}

let copies = 0;
/** A private copy of a fixture: ingest moves the file it is given. */
function copy(path: string): string {
  const out = join(fx, `copy-${++copies}-${basename(path)}`);
  copyFileSync(path, out);
  return out;
}

async function trimmed(trim: MediaTrim | undefined): Promise<Media> {
  const m = await hub.media.ingest({ path: copy(fixtures.halves(fx)) }, 'halves.wmv', { trim });
  await hub.jobs.idle();
  return hub.lib.media.must(m.id);
}

/**
 * Mean grey level (0..255) over every frame of a video. The halves clip is black for its first second and
 * white after (the ASF muxer starts its video 46 ms late, so one frame of a cut at 1 s is the other colour).
 */
function meanLuma(path: string): number {
  const raw = execFileSync('ffmpeg', [
    ...['-v', 'error', '-i', path, '-vf', 'scale=1:1'],
    ...['-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
  ]);
  return raw.reduce((a, b) => a + b, 0) / raw.length;
}

function jobLog(m: Media): string {
  const job = hub.jobs.list().find((j) => (j.result as { mediaId?: string } | undefined)?.mediaId === m.id);
  return job?.log.join('\n') ?? '';
}

describe('sniffing old formats', () => {
  it('reads ASF as WMV or WMA from its stream list, MPEG program streams and AIFF', () => {
    expect(sniff(head(fixtures.wmv(fx)))).toEqual({ ext: 'wmv', mime: 'video/x-ms-wmv', kind: 'video' });
    expect(sniff(head(fixtures.wma(fx)))).toEqual({ ext: 'wma', mime: 'audio/x-ms-wma', kind: 'audio' });
    expect(sniff(head(fixtures.mpg(fx)))).toEqual({ ext: 'mpg', mime: 'video/mpeg', kind: 'video' });
    expect(sniff(head(fixtures.vob(fx)))).toEqual({ ext: 'mpg', mime: 'video/mpeg', kind: 'video' });
    expect(sniff(head(fixtures.aiff(fx)))).toEqual({ ext: 'aiff', mime: 'audio/aiff', kind: 'audio' });
    expect(sniff(head(fixtures.avi(fx)))?.ext).toBe('avi');
  });

  it('falls back to video for an ASF head without its stream list, and refuses near misses', () => {
    // Only the header object's fixed part: the streams are not in the head.
    expect(sniff(bytes(...ASF, ...new Array(14).fill(0)))).toEqual({
      ext: 'asf',
      mime: 'video/x-ms-asf',
      kind: 'video',
    });
    expect(sniff(bytes(...ASF.slice(0, 15), 0x6d, 0, 0))).toBeUndefined();
    expect(sniff(bytes('FORM', 0, 0, 0, 4, 'AIFC'))?.ext).toBe('aiff');
    expect(sniff(bytes('FORM', 0, 0, 0, 4, 'ILBM'))).toBeUndefined();
    expect(sniff(bytes(0, 0, 1, 0xbb, 0, 0))).toBeUndefined();
    expect(sniff(bytes(0, 0, 1, 0xba))?.ext).toBe('mpg');
  });

  it('accepts the usual extensions for each, and either ASF extension for an ASF file', () => {
    const wmv = sniff(head(fixtures.wmv(fx)))!;
    const wma = sniff(head(fixtures.wma(fx)))!;
    const asf: Sniffed = { ext: 'asf', mime: 'video/x-ms-asf', kind: 'video' };
    for (const s of [wmv, wma, asf])
      for (const name of ['a.wmv', 'a.WMA', 'a.asf']) expect(extensionAgrees(name, s)).toBe(true);
    const mpg = sniff(head(fixtures.mpg(fx)))!;
    for (const name of ['a.mpg', 'a.mpeg', 'a.vob']) expect(extensionAgrees(name, mpg)).toBe(true);
    const aiff = sniff(head(fixtures.aiff(fx)))!;
    for (const name of ['a.aif', 'a.aiff', 'a.aifc']) expect(extensionAgrees(name, aiff)).toBe(true);
    expect(extensionAgrees('a.wma', mpg)).toBe(false);
    expect(extensionAgrees('a.aiff', wmv)).toBe(false);
    expect(extensionAgrees('a.wmv', sniff(head(fixtures.png(fx)))!)).toBe(false);
  });
});

describe('ingesting old formats', () => {
  it('transcodes WMV, MPEG-PS and old AVI to H.264 MP4 and measures their soundtracks', async () => {
    for (const [path, mime, codec] of [
      [fixtures.wmv(fx), 'video/x-ms-wmv', 'wmv2'],
      [fixtures.mpg(fx), 'video/mpeg', 'mpeg1video'],
      [fixtures.avi(fx), 'video/x-msvideo', 'msmpeg4v2'],
    ] as const) {
      const m = await uploaded(path);
      expect(m).toMatchObject({ kind: 'video', state: 'ready', width: 160, height: 120 });
      expect(m.original.mime).toBe(mime);
      expect(m.delivery?.mime).toBe('video/mp4');
      expect(m.poster?.mime).toBe('image/jpeg');
      expect(m.durationMs).toBeGreaterThan(900);
      // A 1/8 full-scale sine measures about -21 LUFS.
      expect(m.audio?.loudnessLufs).toBeGreaterThan(-30);
      expect(m.audio?.loudnessLufs).toBeLessThan(-10);
      expect(m.audio?.gainDb).toBe(0);
      expect(jobLog(m)).toContain(`video ${codec} 160x120`);
      expect(jobLog(m)).toMatch(/loudness -\d+(\.\d)? LUFS/);
    }
  });

  it('normalises WMA and AIFF to AAC with their loudness', async () => {
    for (const [path, mime] of [
      [fixtures.wma(fx), 'audio/x-ms-wma'],
      [fixtures.aiff(fx), 'audio/aiff'],
    ] as const) {
      const m = await uploaded(path);
      expect(m).toMatchObject({ kind: 'audio', state: 'ready' });
      expect(m.original.mime).toBe(mime);
      expect(m.delivery?.mime).toBe('audio/mp4');
      expect(m.audio?.loudnessLufs).toBeLessThan(0);
      expect(m.durationMs).toBeGreaterThan(900);
    }
  });

  it('leaves a video without sound unmeasured', async () => {
    const m = await uploaded(fixtures.silentMpg(fx));
    expect(m).toMatchObject({ kind: 'video', state: 'ready' });
    expect(m.audio).toBeUndefined();
    expect(jobLog(m)).not.toContain('loudness');
  });

  it('measures over the first audio stream, within a trim', async () => {
    const halves = fixtures.halves(fx);
    const o = { timeoutMs: 30_000 };
    expect(await measureLoudness(halves, { ...o, trim: { startMs: 0, endMs: 1000 } })).toBeUndefined();
    expect(await measureLoudness(halves, { ...o, trim: { startMs: 1000, endMs: 2000 } })).toBeLessThan(-10);
  });
});

describe('trims', () => {
  it('normalises, compares and measures trims', () => {
    expect(normTrim(undefined)).toBeUndefined();
    expect(normTrim({ startMs: -5, endMs: 1999.6 })).toEqual({ startMs: 0, endMs: 2000 });
    expect(normTrim({ startMs: 2000, endMs: 2000 })).toBeUndefined();
    expect(normTrim({ startMs: 3000, endMs: 1000 })).toBeUndefined();
    expect(normTrim({ startMs: Number.NaN, endMs: 1000 })).toBeUndefined();
    expect(normTrim({ startMs: 0, endMs: 1e12 })).toEqual({ startMs: 0, endMs: 4 * 3600_000 });
    expect(sameTrim(undefined, undefined)).toBe(true);
    expect(sameTrim(undefined, { startMs: 0, endMs: 1 })).toBe(false);
    expect(sameTrim({ startMs: 0, endMs: 1 }, { startMs: 0, endMs: 1 })).toBe(true);
    expect(sameTrim({ startMs: 0, endMs: 1 }, { startMs: 0, endMs: 2 })).toBe(false);
    expect(keptMs(10_000, undefined)).toBe(10_000);
    expect(keptMs(10_000, { startMs: 1500, endMs: 4000 })).toBe(2500);
    expect(keptMs(3000, { startMs: 1500, endMs: 4000 })).toBe(1500);
    expect(keptMs(undefined, { startMs: 1500, endMs: 4000 })).toBeUndefined();
    expect(trimArgs({ startMs: 1500, endMs: 4000 })).toEqual(['-ss', '1.500', '-to', '4.000']);
    expect(trimArgs(undefined)).toEqual([]);
  });

  it('bakes the trim into the delivery and records it', async () => {
    const late = await trimmed({ startMs: 1000, endMs: 2000 });
    expect(late).toMatchObject({ kind: 'video', state: 'ready', trim: { startMs: 1000, endMs: 2000 } });
    expect(late.durationMs).toBeGreaterThan(900);
    expect(late.durationMs).toBeLessThan(1200);
    expect(meanLuma(hub.store.abs(late.delivery!.path))).toBeGreaterThan(200);
    expect(late.audio?.loudnessLufs).toBeLessThan(-10);
    expect(jobLog(late)).toContain('keeping 1 s to 2 s of the source');

    const early = await trimmed({ startMs: 0, endMs: 1000 });
    expect(early.trim).toEqual({ startMs: 0, endMs: 1000 });
    expect(meanLuma(hub.store.abs(early.delivery!.path))).toBeLessThan(40);
    // Only the silent half is kept: nothing to measure.
    expect(early.audio).toMatchObject({ gainDb: 0 });
    expect(early.audio?.loudnessLufs).toBeUndefined();

    const whole = await trimmed(undefined);
    expect(whole.trim).toBeUndefined();
    expect(whole.durationMs).toBeGreaterThan(1900);
    const mid = meanLuma(hub.store.abs(whole.delivery!.path));
    expect(mid).toBeGreaterThan(80);
    expect(mid).toBeLessThan(180);
  });

  it('fails a clip trimmed to start after its end', async () => {
    const m = await trimmed({ startMs: 5000, endMs: 6000 });
    expect(m.state).toBe('failed');
    expect(m.error).toMatch(/trimmed to start at 5 s, after its end/);
  });

  it('deduplicates on the hash and the trim', async () => {
    const src = fixtures.halves(fx);
    const { hash } = await hashFile(src);
    const whole = (await hub.media.ingestOnce({ path: copy(src) }, 'halves.wmv')).media;
    const late = (
      await hub.media.ingestOnce({ path: copy(src) }, 'halves.wmv', { trim: { startMs: 1000, endMs: 2000 } })
    ).media;
    expect(whole.trim).toBeUndefined();
    expect(late.trim).toEqual({ startMs: 1000, endMs: 2000 });
    expect(whole.id).not.toBe(late.id);
    expect(hub.media.findClip(hash)?.id).toBe(whole.id);
    expect(hub.media.findClip(hash, { startMs: 1000, endMs: 2000 })?.id).toBe(late.id);
    // Same bytes, same trim (after normalisation): the existing item, and the file is removed.
    const again = copy(src);
    const r1 = await hub.media.ingestOnce({ path: again }, 'halves.wmv', {
      trim: { startMs: 999.7, endMs: 2000 },
    });
    expect(r1.reused).toBe(true);
    expect(r1.media.id).toBe(late.id);
    expect(existsSync(again)).toBe(false);
    const r2 = await hub.media.ingestOnce({ path: copy(src) }, 'halves.wmv');
    expect(r2).toMatchObject({ reused: true, media: { id: whole.id } });
    // A trim that keeps nothing is no trim.
    const r3 = await hub.media.ingestOnce({ path: copy(src) }, 'halves.wmv', {
      trim: { startMs: 500, endMs: 500 },
    });
    expect(r3).toMatchObject({ reused: true, media: { id: whole.id } });
    // Another trim is another clip, made from the same stored original.
    const before = hub.lib.media.list().length;
    const r4 = await hub.media.ingestOnce({ path: copy(src) }, 'halves.wmv', {
      trim: { startMs: 1000, endMs: 1500 },
    });
    expect(r4.reused).toBe(false);
    expect(r4.media.trim).toEqual({ startMs: 1000, endMs: 1500 });
    expect(r4.media.original.path).toBe(whole.original.path);
    expect(hub.lib.media.list().length).toBe(before + 1);
    await hub.jobs.idle();
    expect(hub.lib.media.must(r4.media.id)).toMatchObject({ state: 'ready', durationMs: expect.any(Number) });
    expect(hub.lib.media.must(r4.media.id).durationMs).toBeLessThan(700);
  });

  it('ignores a trim on an image, which is then reused whatever the trim', async () => {
    const png = fixtures.png(fx);
    const m = await hub.media.ingest({ path: copy(png) }, 'still.png', {
      trim: { startMs: 0, endMs: 1000 },
    });
    expect(m.trim).toBeUndefined();
    const again = await hub.media.ingestOnce({ path: copy(png) }, 'still.png', {
      trim: { startMs: 0, endMs: 2000 },
    });
    expect(again).toMatchObject({ reused: true, media: { id: m.id } });
    await hub.jobs.idle();
  });
});

describe('volumeGainDb', () => {
  it('maps PowerPoint volume to 20·log10(vol/100000), clamped to -100..0 dB', () => {
    expect(volumeGainDb(100_000)).toBe(0);
    expect(volumeGainDb(50_000)).toBe(-6.02);
    expect(volumeGainDb(80_000)).toBe(-1.94);
    expect(volumeGainDb(10_000)).toBe(-20);
    expect(volumeGainDb(1)).toBe(-100);
    expect(volumeGainDb(0.01)).toBe(-100);
    expect(volumeGainDb(0)).toBe(-100);
    expect(volumeGainDb(-5)).toBe(-100);
    expect(volumeGainDb(250_000)).toBe(0);
    expect(volumeGainDb(undefined)).toBe(0);
    expect(volumeGainDb(Number.NaN)).toBe(0);
    expect(volumeGainDb(Number.POSITIVE_INFINITY)).toBe(0);
    expect(Object.is(volumeGainDb(100_000), 0)).toBe(true);
  });
});
