import type { Media } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { fileKind, mediaAccept } from '../src/lib/mediaKinds.ts';
import {
  isClientTranscodeCandidate,
  mediaForm,
  posterSizeFor,
  usesResumableUpload,
} from '../src/services/upload.ts';
import { mp4FileName, shouldClientTranscode } from '../src/services/videoTranscode.ts';
import { canTrimMedia, formatTrimMs, parseTrimMs } from '../src/lib/mediaTrim.ts';

describe('mediaKinds video/audio parity with Hub', () => {
  it('accepts mkv, avi, wmv, asf, mpg, mpeg, vob and legacy audio formats', () => {
    const videoAccept = mediaAccept(['video']);
    for (const ext of ['.mkv', '.avi', '.wmv', '.asf', '.mpg', '.mpeg', '.vob']) {
      expect(videoAccept).toContain(ext);
      expect(fileKind({ name: `clip${ext}` })).toBe('video');
    }
    const audioAccept = mediaAccept(['audio']);
    for (const ext of ['.wma', '.aif', '.aiff', '.aifc']) {
      expect(audioAccept).toContain(ext);
      expect(fileKind({ name: `song${ext}` })).toBe('audio');
    }
  });
});

describe('client WebCodecs pre-transcode gating', () => {
  it('uses chunked resumable uploads above 24 MB on the hub, but never in the browser demo', () => {
    expect(usesResumableUpload(10 * 1024 * 1024, false)).toBe(false);
    expect(usesResumableUpload(50 * 1024 * 1024, false)).toBe(true);
    expect(usesResumableUpload(50 * 1024 * 1024, true)).toBe(false);
  });

  it('scales video posters to fit 640x360 with even dimensions without upscaling', () => {
    expect(posterSizeFor(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(posterSizeFor(1080, 1920)).toEqual({ width: 202, height: 360 });
    expect(posterSizeFor(320, 240)).toEqual({ width: 320, height: 240 });
    expect(posterSizeFor(0, 0)).toEqual({ width: 640, height: 360 });
  });

  it('attaches video poster and metadata fields to mediaForm when provided', () => {
    const clip = new File(['video'], 'sermon.mp4', { type: 'video/mp4' });
    const poster = new Blob(['jpeg'], { type: 'image/jpeg' });
    const fd = mediaForm(clip, {}, undefined, { poster, width: 1920, height: 1080, durationMs: 12500 });
    const p = fd.get('poster');
    expect(p).toBeInstanceOf(File);
    expect((p as File).name).toBe('sermon.jpg');
    expect(fd.get('width')).toBe('1920');
    expect(fd.get('height')).toBe('1080');
    expect(fd.get('durationMs')).toBe('12500');
  });

  it('selects modern video containers as candidates and skips legacy containers, images, and audio', () => {
    for (const name of ['a.mp4', 'b.MOV', 'c.m4v', 'd.webm', 'e.mkv']) {
      expect(isClientTranscodeCandidate({ name, type: '' })).toBe(true);
    }
    for (const name of ['old.wmv', 'old.avi', 'old.mpg', 'old.vob', 'pic.png', 'song.mp3', 'anim.gif']) {
      expect(isClientTranscodeCandidate({ name, type: '' })).toBe(false);
    }
  });

  it('skips transcoding when WebCodecs is unavailable or the venue PC is driving live outputs', () => {
    expect(shouldClientTranscode({ liveMode: 'idle', hasOpenOutputs: false, hasWebCodecs: true })).toBe(true);
    expect(shouldClientTranscode({ liveMode: 'live', hasOpenOutputs: false, hasWebCodecs: true })).toBe(true);
    expect(shouldClientTranscode({ liveMode: 'live', hasOpenOutputs: true, hasWebCodecs: true })).toBe(false);
    expect(shouldClientTranscode({ liveMode: 'idle', hasOpenOutputs: false, hasWebCodecs: false })).toBe(
      false,
    );
  });

  it('renames client-transcoded files to .mp4', () => {
    expect(mp4FileName('sermon-4k.MOV')).toBe('sermon-4k.mp4');
    expect(mp4FileName('clip.mkv')).toBe('clip.mp4');
    expect(mp4FileName('noext')).toBe('noext.mp4');
  });
});

describe('MediaTrimDialog helpers', () => {
  it('formats and parses trim timestamps accurately', () => {
    expect(formatTrimMs(0)).toBe('0:00.0');
    expect(formatTrimMs(5400)).toBe('0:05.4');
    expect(formatTrimMs(72_500)).toBe('1:12.5');
    expect(formatTrimMs(3_723_500)).toBe('1:02:03.5');

    expect(parseTrimMs('5')).toBe(5000);
    expect(parseTrimMs('5.4')).toBe(5400);
    expect(parseTrimMs('1:12.5')).toBe(72_500);
    expect(parseTrimMs('1:02:03.5')).toBe(3_723_500);
    expect(parseTrimMs('1:75')).toBeUndefined();
    expect(parseTrimMs('abc')).toBeUndefined();
    expect(parseTrimMs('')).toBeUndefined();
  });

  it('allows trimming videos and audio, but excludes images and animated GIFs', () => {
    const file = (mime: string): Media['original'] => ({
      hash: 'a'.repeat(64),
      bytes: 100,
      mime,
      path: 'media/a',
    });
    expect(canTrimMedia({ kind: 'video', original: file('video/mp4') })).toBe(true);
    expect(canTrimMedia({ kind: 'audio', original: file('audio/mpeg') })).toBe(true);
    expect(canTrimMedia({ kind: 'image', original: file('image/png') })).toBe(false);
    expect(canTrimMedia({ kind: 'video', original: file('image/gif') })).toBe(false);
  });
});

describe('useLibrary localRev refresh', () => {
  it('increments localRev on upsertLocal and removeLocal so useSearch refreshes without a hub delta', async () => {
    const { removeLocal, upsertLocal, useLibrary } = await import('../src/state/library.ts');
    const before = useLibrary.getState().localRev;
    const item: Media = {
      id: 'demo-vid-1',
      rev: 1,
      name: 'Demo Clip',
      tags: [],
      kind: 'video',
      original: { hash: 'b'.repeat(64), bytes: 1000, mime: 'video/mp4', path: 'files/b' },
      state: 'ready',
      loop: false,
      isBackground: false,
    };
    upsertLocal('media', item);
    expect(useLibrary.getState().localRev).toBe(before + 1);
    removeLocal('media', item.id);
    expect(useLibrary.getState().localRev).toBe(before + 2);
  });
});
