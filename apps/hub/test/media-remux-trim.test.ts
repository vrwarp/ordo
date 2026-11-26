import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import type { Media } from '@ordo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canRemuxH264, MAX_REMUX_BITRATE_BPS, type ProbeInfo, probe } from '../src/media/ffmpeg.ts';
import { ffmpeg, fixtures } from './fixtures.ts';
import { type Client, EDIT_PIN, login, OPERATE_PIN, startHub, type TestHub, tempDir } from './helpers.ts';
import { phone } from './phones-helpers.ts';

let hub: TestHub;
let ed: Client;
let op: Client;
let capped: Client;
const fx = tempDir('ordo-fx-remux-trim-');

beforeAll(async () => {
  hub = await startHub();
  ed = await login(hub.url, EDIT_PIN);
  op = await login(hub.url, OPERATE_PIN);
  capped = await phone(hub.url, EDIT_PIN, 'light');
});

afterAll(async () => {
  await hub.cleanup();
  rmSync(fx, { recursive: true, force: true });
});

async function uploadFile(path: string): Promise<Media> {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(path)]), basename(path));
  const res = await ed.fetch('/media', { method: 'POST', body: fd });
  expect(res.status).toBe(201);
  const m = (await res.json()) as Media;
  await hub.jobs.idle();
  return hub.lib.media.must(m.id);
}

function latestJobLog(mediaId: string): string {
  const jobs = hub.jobs
    .list()
    .filter((j) => (j.result as { mediaId?: string } | undefined)?.mediaId === mediaId);
  return jobs[0]?.log.join('\n') ?? '';
}

describe('canRemuxH264', () => {
  const base: ProbeInfo = {
    durationMs: 10_000,
    bitRateBps: 5_000_000,
    video: {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      profile: 'High',
      pix_fmt: 'yuv420p',
      field_order: 'progressive',
      width: 1920,
      height: 1080,
      sample_aspect_ratio: '1:1',
      fps: 30,
      bit_rate: '4800000',
      hasAlpha: false,
    },
    audio: {
      index: 1,
      codec_type: 'audio',
      codec_name: 'aac',
      channels: 2,
    },
  };

  it('accepts compliant progressive 8-bit H.264 + stereo AAC within 1080p60 and 20 Mbps', () => {
    expect(canRemuxH264(base)).toBe(true);
    expect(canRemuxH264({ ...base, audio: undefined })).toBe(true);
    expect(canRemuxH264({ ...base, audio: { ...base.audio!, channels: 1 } })).toBe(true);
  });

  it('rejects trimmed, high-bitrate, >1080p, >60fps, non-yuv420p, interlaced, anamorphic, alpha, or non-AAC inputs', () => {
    expect(canRemuxH264(base, { trim: { startMs: 0, endMs: 5000 } })).toBe(false);
    expect(
      canRemuxH264({ ...base, video: { ...base.video!, bit_rate: String(MAX_REMUX_BITRATE_BPS + 1) } }),
    ).toBe(false);
    expect(canRemuxH264({ ...base, video: { ...base.video!, width: 3840, height: 2160 } })).toBe(false);
    expect(canRemuxH264({ ...base, video: { ...base.video!, fps: 120 } })).toBe(false);
    expect(canRemuxH264({ ...base, video: { ...base.video!, pix_fmt: 'yuv420p10le' } })).toBe(false);
    expect(canRemuxH264({ ...base, video: { ...base.video!, profile: 'High 10' } })).toBe(false);
    expect(canRemuxH264({ ...base, video: { ...base.video!, field_order: 'tt' } })).toBe(false);
    expect(canRemuxH264({ ...base, video: { ...base.video!, sample_aspect_ratio: '32:27' } })).toBe(false);
    expect(canRemuxH264({ ...base, video: { ...base.video!, hasAlpha: true } })).toBe(false);
    expect(canRemuxH264({ ...base, audio: { ...base.audio!, codec_name: 'opus' } })).toBe(false);
    expect(canRemuxH264({ ...base, audio: { ...base.audio!, channels: 6 } })).toBe(false);
  });
});

describe('Hub H.264 remux fast-path and non-destructive PUT /media/:id/trim', () => {
  it('remuxes a compliant H.264 + AAC MP4 without re-encoding, strips metadata, and records sourceDurationMs', async () => {
    const compliant = ffmpeg(fx, 'compliant.mp4', [
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=640x360:d=3:r=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-b:a',
      '128k',
      '-metadata',
      'comment=secret-gps-tag',
    ]);

    const m = await uploadFile(compliant);
    expect(m.state).toBe('ready');
    expect(m.delivery?.mime).toBe('video/mp4');
    expect(m.poster?.mime).toBe('image/jpeg');
    expect(m.audio?.loudnessLufs).toBeTypeOf('number');
    expect(m.sourceDurationMs).toBeGreaterThan(2500);
    expect(m.durationMs).toBeGreaterThan(2500);
    expect(latestJobLog(m.id)).toContain('remuxing compliant H.264 stream (no re-encode)');

    const outInfo = await probe(hub.store.abs(m.delivery!.path), 10_000);
    expect(outInfo.video?.codec_name).toBe('h264');
    expect(outInfo.audio?.codec_name).toBe('aac');
  });

  it('non-destructively trims, re-trims, and resets a video via PUT /media/:id/trim while releasing old deliveries', async () => {
    const src = ffmpeg(fx, 'trimmable.mp4', [
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=320x180:d=4:r=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
    ]);

    const m0 = await uploadFile(src);
    expect(m0.state).toBe('ready');
    const origDeliveryPath = hub.store.abs(m0.delivery!.path);
    expect(existsSync(origDeliveryPath)).toBe(true);

    // 1. Apply trim [1000, 2500] -> ~1.5s delivery, sourceDurationMs stays ~4s
    const r1 = await ed.fetch(`/media/${m0.id}/trim`, {
      method: 'PUT',
      json: { trim: { startMs: 1000, endMs: 2500 } },
    });
    expect(r1.status).toBe(200);
    await hub.jobs.idle();
    const m1 = hub.lib.media.must(m0.id);
    expect(m1.state).toBe('ready');
    expect(m1.trim).toEqual({ startMs: 1000, endMs: 2500 });
    expect(m1.durationMs).toBeGreaterThan(1200);
    expect(m1.durationMs).toBeLessThan(1900);
    expect(m1.sourceDurationMs).toBeGreaterThan(3500);
    expect(m1.delivery!.hash).not.toBe(m0.delivery!.hash);
    expect(existsSync(origDeliveryPath)).toBe(false);

    // 2. Reset trim to null -> full ~4s restored via remux fast-path
    const r2 = await ed.fetch(`/media/${m0.id}/trim`, {
      method: 'PUT',
      json: { trim: null },
    });
    expect(r2.status).toBe(200);
    await hub.jobs.idle();
    const m2 = hub.lib.media.must(m0.id);
    expect(m2.state).toBe('ready');
    expect(m2.trim).toBeUndefined();
    expect(m2.durationMs).toBeGreaterThan(3500);
    expect(latestJobLog(m2.id)).toContain('remuxing compliant H.264 stream (no re-encode)');
  });

  it('supports non-destructive trimming on audio items', async () => {
    const wav = ffmpeg(fx, 'tone.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4']);
    const m0 = await uploadFile(wav);
    expect(m0.kind).toBe('audio');
    expect(m0.sourceDurationMs).toBeGreaterThan(3500);

    const r = await ed.fetch(`/media/${m0.id}/trim`, {
      method: 'PUT',
      json: { trim: { startMs: 500, endMs: 2000 } },
    });
    expect(r.status).toBe(200);
    await hub.jobs.idle();
    const m1 = hub.lib.media.must(m0.id);
    expect(m1.state).toBe('ready');
    expect(m1.trim).toEqual({ startMs: 500, endMs: 2000 });
    expect(m1.durationMs).toBe(1500);
    expect(m1.sourceDurationMs).toBeGreaterThan(3500);
  });

  it('enforces validation (400), capped phone refusal (403), and live playlist lock (423)', async () => {
    const img = await uploadFile(fixtures.png(fx));
    const badImg = await ed.fetch(`/media/${img.id}/trim`, {
      method: 'PUT',
      json: { trim: { startMs: 0, endMs: 1000 } },
    });
    expect(badImg.status).toBe(400);

    const clip = await uploadFile(fixtures.video(fx));
    const badRange = await ed.fetch(`/media/${clip.id}/trim`, {
      method: 'PUT',
      json: { trim: { startMs: 2000, endMs: 1000 } },
    });
    expect(badRange.status).toBe(400);

    const phoneRefusal = await capped.fetch(`/media/${clip.id}/trim`, {
      method: 'PUT',
      json: { trim: { startMs: 0, endMs: 500 } },
    });
    expect(phoneRefusal.status).toBe(403);

    // Lock the clip in a live playlist and verify 423
    const plRes = await ed.fetch('/playlists', {
      method: 'POST',
      json: {
        name: 'Trim Lock Test',
        items: [{ id: 'it1', kind: 'media', mediaId: clip.id }],
      },
    });
    expect(plRes.status).toBe(201);
    const pl = (await plRes.json()) as { id: string };
    const goRes = await op.fetch('/live/events', {
      method: 'POST',
      json: { k: 'goLive', playlistId: pl.id },
    });
    expect(goRes.status).toBe(200);
    try {
      const lockedRes = await ed.fetch(`/media/${clip.id}/trim`, {
        method: 'PUT',
        json: { trim: { startMs: 0, endMs: 500 } },
      });
      expect(lockedRes.status).toBe(423);
    } finally {
      await op.fetch('/live/events', { method: 'POST', json: { k: 'endService' } });
    }
  });
});
