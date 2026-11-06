import { readFile, rm, writeFile } from 'node:fs/promises';
import type { Media, MediaTrim } from '@ordo/domain';
import { newId } from '@ordo/domain';
import type { Logger } from 'pino';
import type { HubConfig } from '../config.ts';
import { errorMessage, HttpError } from '../errors.ts';
import type { JobCtx, JobQueue } from '../jobs.ts';
import type { Library } from '../library.ts';
import { extensionAgrees, extOf, hashFile, readHead, type Sniffed, sniff, type Store } from '../store.ts';
import {
  downscaleImage,
  firstFramePng,
  gifInfo,
  measureLoudness,
  poster,
  probe,
  transcodeAudio,
  transcodeH264,
  transcodeVp9Alpha,
} from './ffmpeg.ts';

export const MAX_IMAGE_WIDTH = 3840;

/**
 * Decode-time limits (design/25 "Files"). A file beyond them fails its media job with a clear reason and
 * is never retried automatically; the operator can still press Retry after replacing it.
 */
export const DECODE_LIMITS = {
  /** Largest accepted image, either side, in pixels. */
  imageSide: 16384,
  /** Longest accepted video or audio. */
  durationMs: 4 * 3600_000,
  /** Largest accepted video frame (8K UHD), compared as long and short side. */
  videoLong: 7680,
  videoShort: 4320,
  /** GIFs are decoded frame by frame: bound the frame count. */
  gifFrames: 20_000,
} as const;

/** Throws when a probed file exceeds DECODE_LIMITS. Pure, for tests. */
export function checkDecodeLimits(
  kind: 'video' | 'image' | 'audio',
  info: { durationMs?: number; video?: { width?: number; height?: number } },
): void {
  const L = DECODE_LIMITS;
  const w = info.video?.width ?? 0;
  const h = info.video?.height ?? 0;
  if (kind === 'image') {
    if (w > L.imageSide || h > L.imageSide)
      throw new Error(`Image is ${w}x${h}; the limit is ${L.imageSide}x${L.imageSide}`);
    return;
  }
  if (info.durationMs !== undefined && info.durationMs > L.durationMs)
    throw new Error(
      `${kind === 'video' ? 'Video' : 'Audio'} is ${Math.round(info.durationMs / 60_000)} min long; the limit is ${L.durationMs / 3600_000} h`,
    );
  if (kind === 'video' && (Math.max(w, h) > L.videoLong || Math.min(w, h) > L.videoShort))
    throw new Error(`Video is ${w}x${h}; the limit is ${L.videoLong}x${L.videoShort} (8K)`);
}

export type IngestOpts = {
  isBackground?: boolean;
  tags?: string[];
  loop?: boolean;
  checkExtension?: boolean;
  /**
   * Keep only [startMs, endMs] of a video or audio source (PowerPoint's p14:trim, design/27 §8 "Hub"). It is
   * baked into the delivery, so loops, onEnd, the stage's remaining time and media.ended need no trim logic,
   * and recorded as Media.trim. Normalised by normTrim; images ignore it.
   */
  trim?: MediaTrim;
};

/**
 * A trim in whole milliseconds within the decode limit, or undefined when it keeps nothing (end at or before
 * start, or not a number): such a trim is ignored and the whole source is kept.
 */
export function normTrim(t: MediaTrim | undefined): MediaTrim | undefined {
  if (!t) return undefined;
  const startMs = Math.max(0, Math.round(t.startMs));
  const endMs = Math.min(DECODE_LIMITS.durationMs, Math.round(t.endMs));
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? { startMs, endMs }
    : undefined;
}

/** Same kept part: both untrimmed, or the same start and end. */
export function sameTrim(a: MediaTrim | undefined, b: MediaTrim | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.startMs === b.startMs && a.endMs === b.endMs;
}

/** How long the kept part of a source lasts. */
export function keptMs(durationMs: number | undefined, t: MediaTrim | undefined): number | undefined {
  if (!t || durationMs === undefined) return durationMs;
  return Math.max(0, Math.min(durationMs, t.endMs) - t.startMs);
}

/**
 * PowerPoint's media volume (`p:cMediaNode vol`, 100000 = 100 %) as a gain: 20·log10(vol/100000) dB,
 * clamped to −100 (silent) .. 0, to 0.01 dB (design/27 §8 "Hub"). A missing or non-numeric volume is 100 %.
 */
export function volumeGainDb(vol: number | undefined): number {
  if (vol === undefined || Number.isNaN(vol)) return 0;
  if (vol <= 0) return -100;
  const db = Math.round(2000 * Math.log10(vol / 100_000)) / 100;
  return Math.min(0, Math.max(-100, db)) || 0;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(3).replace(/\.?0+$/, '')} s`;
}

export function baseName(name: string): string {
  const b = name.split(/[\\/]/).pop() ?? name;
  return b.replace(/\.[A-Za-z0-9]{1,8}$/, '') || b;
}

/** Media ingest (upload → content store → `media` job) and the processing job itself. */
export class MediaService {
  constructor(
    private lib: Library,
    private store: Store,
    private jobs: JobQueue,
    private cfg: HubConfig,
    private log: Logger,
  ) {
    jobs.register<{ mediaId: string }>(
      'media',
      (ctx) => this.process(ctx),
      // Abandoned after repeated crashes: mark the item failed so nothing waits on it.
      ({ mediaId }, error) => {
        const cur = this.lib.media.get(mediaId);
        if (cur && cur.state !== 'ready') this.save({ ...cur, state: 'failed', error: error.slice(0, 500) });
      },
    );
  }

  /** Identify a received file and check that its name agrees with its content. */
  async identify(path: string, name: string, checkExtension = true): Promise<Sniffed> {
    const s = sniff(await readHead(path));
    if (!s || !['video', 'image', 'audio'].includes(s.kind))
      throw new HttpError(415, 'unsupported_media', `${name}: not a supported video, image or audio file`);
    if (checkExtension && extOf(name) && !extensionAgrees(name, s))
      throw new HttpError(
        415,
        'extension_mismatch',
        `${name}: the file extension does not match its content`,
      );
    return s;
  }

  /** Register an uploaded file (already hashed in uploads/) as a new media item and queue processing. */
  async ingest(
    file: { path: string; hash?: string; bytes?: number },
    name: string,
    opts: IngestOpts = {},
  ): Promise<Media> {
    let s: Sniffed;
    try {
      s = await this.identify(file.path, name, opts.checkExtension !== false);
    } catch (e) {
      await rm(file.path, { force: true });
      throw e;
    }
    const original = await this.store.put(file.path, {
      ext: s.ext,
      mime: s.mime,
      hash: file.hash,
      bytes: file.bytes,
    });
    const kind = s.kind as Media['kind'];
    const trim = kind === 'image' ? undefined : normTrim(opts.trim);
    const media = this.lib.media.insert({
      id: newId(),
      rev: 1,
      name: baseName(name),
      tags: opts.tags ?? [],
      kind,
      original,
      state: 'uploaded',
      loop: opts.loop ?? false,
      isBackground: opts.isBackground ?? false,
      ...(kind === 'audio' ? { audio: { gainDb: 0 } } : {}),
      ...(trim ? { trim } : {}),
    });
    this.lib.emit([{ kind: 'media', id: media.id, rev: media.rev, entity: media }]);
    const heavy = kind === 'video' || s.ext === 'gif';
    this.jobs.enqueue('media', { mediaId: media.id, name: media.name }, heavy ? 'heavy' : 'light');
    return media;
  }

  async ingestBytes(buf: Uint8Array, name: string, opts: IngestOpts = {}): Promise<Media> {
    const tmp = this.store.tmpPath(extOf(name));
    await writeFile(tmp, buf);
    return this.ingest({ path: tmp }, name, opts);
  }

  /**
   * The media item made from these original bytes with this trim (none: the untrimmed one), if any. Imports
   * deduplicate on both, so one file used whole and trimmed gives two clips (design/27 §8 "Hub"). An image
   * (GIFs included) ignores trims, so it matches whatever the trim.
   */
  findClip(hash: string, trim?: MediaTrim): Media | undefined {
    const t = normTrim(trim);
    return this.lib.media
      .list()
      .find(
        (m) =>
          m.original.hash === hash && (m.original.mime.startsWith('image/') || sameTrim(normTrim(m.trim), t)),
      );
  }

  /**
   * `ingest`, unless the same bytes with the same trim are already a media item (in any state, as imports
   * reuse them): that item is returned and the file removed. A re-queued import therefore reuses its clips.
   */
  async ingestOnce(
    file: { path: string; hash?: string; bytes?: number },
    name: string,
    opts: IngestOpts = {},
  ): Promise<{ media: Media; reused: boolean }> {
    const { hash, bytes } =
      file.hash && file.bytes !== undefined
        ? { hash: file.hash, bytes: file.bytes }
        : await hashFile(file.path);
    const existing = this.findClip(hash, opts.trim);
    if (existing) {
      await rm(file.path, { force: true });
      return { media: existing, reused: true };
    }
    return { media: await this.ingest({ path: file.path, hash, bytes }, name, opts), reused: false };
  }

  /** A ready image media item from a file we produced ourselves (document pages). */
  async addReadyImage(
    path: string,
    name: string,
    opts: { width: number; height: number; tags?: string[] },
  ): Promise<Media> {
    const original = await this.store.put(path, { ext: 'png', mime: 'image/png' });
    const media = this.lib.media.insert({
      id: newId(),
      rev: 1,
      name,
      tags: opts.tags ?? [],
      kind: 'image',
      original,
      state: 'ready',
      width: opts.width,
      height: opts.height,
      hasAlpha: false,
      loop: false,
      isBackground: false,
    });
    this.lib.emit([{ kind: 'media', id: media.id, rev: media.rev, entity: media }]);
    return media;
  }

  /** Re-queue a failed item. */
  retry(id: string): Media {
    const m = this.lib.media.must(id);
    const next = this.save({ ...m, state: 'uploaded', error: undefined });
    this.jobs.enqueue(
      'media',
      { mediaId: id, name: m.name },
      m.kind === 'video' || m.original.mime === 'image/gif' ? 'heavy' : 'light',
    );
    return next;
  }

  private save(m: Media): Media {
    const saved = this.lib.media.update(m.id, m);
    this.lib.emit([{ kind: 'media', id: saved.id, rev: saved.rev, entity: saved }]);
    return saved;
  }

  async process(ctx: JobCtx<{ mediaId: string }>): Promise<{ mediaId: string; state: string }> {
    const m0 = this.lib.media.get(ctx.payload.mediaId);
    if (!m0) {
      ctx.log('media item was deleted');
      return { mediaId: ctx.payload.mediaId, state: 'deleted' };
    }
    let m = this.save({ ...m0, state: 'processing', error: undefined });
    ctx.log(`processing ${m.name} (${m.original.mime}, ${(m.original.bytes / 1e6).toFixed(1)} MB)`);
    try {
      m = await this.transform(m, ctx);
      // The item may have been edited (renamed, tagged) while we worked: merge onto the latest row.
      const latest = this.lib.media.get(m.id);
      if (!latest) return { mediaId: m.id, state: 'deleted' };
      m = this.save({
        ...m,
        name: latest.name,
        tags: latest.tags,
        isBackground: latest.isBackground,
        loop: m.kind === 'video' && m.original.mime === 'image/gif' ? true : latest.loop,
        audio: m.audio
          ? { ...m.audio, gainDb: latest.audio?.gainDb ?? m.audio.gainDb, pairId: latest.audio?.pairId }
          : undefined,
        state: 'ready',
        error: undefined,
      });
      ctx.log(`ready${m.delivery ? ` (${m.delivery.mime}, ${(m.delivery.bytes / 1e6).toFixed(1)} MB)` : ''}`);
      return { mediaId: m.id, state: 'ready' };
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      const cur = this.lib.media.get(m.id);
      if (cur) this.save({ ...cur, state: 'failed', error: errorMessage(e).slice(0, 500) });
      throw e;
    }
  }

  private async transform(m: Media, ctx: JobCtx<unknown>): Promise<Media> {
    const t = this.cfg.timeouts;
    const input = this.store.abs(m.original.path);
    const info = await probe(input, t.probe);
    checkDecodeLimits(m.kind, info);
    const trim = m.kind === 'image' ? undefined : normTrim(m.trim);
    if (trim) {
      if (info.durationMs !== undefined && trim.startMs >= info.durationMs)
        throw new Error(
          `The clip is trimmed to start at ${seconds(trim.startMs)}, after its end (${seconds(info.durationMs)})`,
        );
      ctx.log(`keeping ${seconds(trim.startMs)} to ${seconds(trim.endMs)} of the source`);
    }
    const opts = {
      signal: ctx.signal,
      durationMs: keptMs(info.durationMs, trim),
      onProgress: (f: number) => ctx.progress(f * 0.9),
      trim,
    };

    if (m.original.mime === 'image/gif') {
      const gi = gifInfo(await readFile(input));
      if (gi.width > DECODE_LIMITS.imageSide || gi.height > DECODE_LIMITS.imageSide)
        throw new Error(
          `GIF is ${gi.width}x${gi.height}; the limit is ${DECODE_LIMITS.imageSide}x${DECODE_LIMITS.imageSide}`,
        );
      if (gi.frames > DECODE_LIMITS.gifFrames)
        throw new Error(`GIF has ${gi.frames} frames; the limit is ${DECODE_LIMITS.gifFrames}`);
      ctx.log(`GIF ${gi.width}x${gi.height}, ${gi.frames} frame(s)${gi.transparent ? ', transparent' : ''}`);
      if (gi.frames > 1) {
        const ginfo = { ...info, audio: undefined };
        return this.video({ ...m, kind: 'video', loop: true }, input, ginfo, gi.transparent, ctx, opts);
      }
      const out = this.store.tmpPath('png');
      await firstFramePng(input, out, { timeoutMs: t.light, signal: ctx.signal });
      const delivery = await this.store.put(out, { ext: 'png', mime: 'image/png' });
      return { ...m, kind: 'image', delivery, width: gi.width, height: gi.height, hasAlpha: gi.transparent };
    }

    if (m.kind === 'image') {
      const v = info.video;
      if (!v?.width || !v.height) throw new Error('Could not read image dimensions');
      const hasAlpha = v.hasAlpha || (v.pix_fmt === 'pal8' && m.original.mime === 'image/png');
      if (v.width > MAX_IMAGE_WIDTH) {
        const ext = hasAlpha ? 'png' : 'jpg';
        const out = this.store.tmpPath(ext);
        ctx.log(`downscaling ${v.width}x${v.height} to ${MAX_IMAGE_WIDTH} wide`);
        await downscaleImage(input, out, MAX_IMAGE_WIDTH, { timeoutMs: t.light, signal: ctx.signal });
        const delivery = await this.store.put(out, { ext, mime: ext === 'png' ? 'image/png' : 'image/jpeg' });
        const h = Math.round((v.height * MAX_IMAGE_WIDTH) / v.width / 2) * 2;
        return { ...m, delivery, width: MAX_IMAGE_WIDTH, height: h, hasAlpha };
      }
      return { ...m, delivery: undefined, width: v.width, height: v.height, hasAlpha };
    }

    if (m.kind === 'video' && info.video) return this.video(m, input, info, info.video.hasAlpha, ctx, opts);

    if (info.audio) {
      ctx.log('measuring loudness');
      const lufs = await measureLoudness(input, { timeoutMs: t.light * 4, signal: ctx.signal, trim });
      ctx.progress(0.3);
      const out = this.store.tmpPath('m4a');
      await transcodeAudio(input, out, {
        timeoutMs: t.transcode,
        signal: ctx.signal,
        durationMs: opts.durationMs,
        onProgress: (f) => ctx.progress(0.3 + f * 0.65),
        trim,
      });
      const delivery = await this.store.put(out, { ext: 'm4a', mime: 'audio/mp4' });
      ctx.log(`loudness ${lufs ?? '?'} LUFS`);
      return {
        ...m,
        kind: 'audio',
        delivery,
        durationMs: opts.durationMs,
        width: undefined,
        height: undefined,
        audio: { gainDb: m.audio?.gainDb ?? 0, pairId: m.audio?.pairId, loudnessLufs: lufs },
      };
    }
    throw new Error('No playable video or audio stream');
  }

  private async video(
    m: Media,
    input: string,
    info: Awaited<ReturnType<typeof probe>>,
    alpha: boolean,
    ctx: JobCtx<unknown>,
    opts: { signal: AbortSignal; durationMs?: number; onProgress: (f: number) => void; trim?: MediaTrim },
  ): Promise<Media> {
    const t = this.cfg.timeouts;
    const v = info.video!;
    ctx.log(
      `video ${v.codec_name} ${v.width}x${v.height} @ ${v.fps?.toFixed(2) ?? '?'} fps${alpha ? ' with alpha' : ''}${info.audio ? ', audio' : ''}`,
    );
    const ext = alpha ? 'webm' : 'mp4';
    const out = this.store.tmpPath(ext);
    try {
      if (alpha) await transcodeVp9Alpha(input, out, info, { ...opts, timeoutMs: t.transcode });
      else await transcodeH264(input, out, info, { ...opts, timeoutMs: t.transcode });
    } catch (e) {
      await rm(out, { force: true });
      throw e;
    }
    const outInfo = await probe(out, t.probe);
    const delivery = await this.store.put(out, { ext, mime: alpha ? 'video/webm' : 'video/mp4' });
    ctx.progress(0.92);
    const posterOut = this.store.tmpPath('jpg');
    let posterRef: Media['poster'];
    try {
      await poster(this.store.abs(delivery.path), posterOut, outInfo, {
        timeoutMs: t.light,
        signal: ctx.signal,
      });
      posterRef = await this.store.put(posterOut, { ext: 'jpg', mime: 'image/jpeg' });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      ctx.log(`poster failed: ${errorMessage(e)}`);
    }
    // The soundtrack is measured like an audio file, so the engine normalises it to the same level
    // (design/18 "Gain staging"). Without a measurement it plays unnormalised, as before.
    let audio = m.audio;
    if (info.audio) {
      ctx.log('measuring loudness');
      let lufs: number | undefined;
      try {
        lufs = await measureLoudness(input, { timeoutMs: t.light * 4, signal: ctx.signal, trim: opts.trim });
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        ctx.log(`loudness not measured: ${errorMessage(e)}`);
      }
      ctx.log(`loudness ${lufs ?? '?'} LUFS`);
      audio = { gainDb: m.audio?.gainDb ?? 0, pairId: m.audio?.pairId, loudnessLufs: lufs };
    }
    ctx.progress(0.98);
    return {
      ...m,
      kind: 'video',
      delivery,
      poster: posterRef,
      durationMs: outInfo.durationMs ?? opts.durationMs,
      width: outInfo.video?.width,
      height: outInfo.video?.height,
      hasAlpha: alpha,
      audio,
    };
  }
}
