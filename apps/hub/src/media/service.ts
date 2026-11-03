import { readFile, rm, writeFile } from 'node:fs/promises';
import type { Media } from '@ordo/domain';
import { newId } from '@ordo/domain';
import type { Logger } from 'pino';
import type { HubConfig } from '../config.ts';
import { errorMessage, HttpError } from '../errors.ts';
import type { JobCtx, JobQueue } from '../jobs.ts';
import type { Library } from '../library.ts';
import { extensionAgrees, extOf, readHead, type Sniffed, sniff, type Store } from '../store.ts';
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

export type IngestOpts = {
  isBackground?: boolean;
  tags?: string[];
  loop?: boolean;
  checkExtension?: boolean;
};

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
    jobs.register<{ mediaId: string }>('media', (ctx) => this.process(ctx));
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
    const opts = {
      signal: ctx.signal,
      durationMs: info.durationMs,
      onProgress: (f: number) => ctx.progress(f * 0.9),
    };

    if (m.original.mime === 'image/gif') {
      const gi = gifInfo(await readFile(input));
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
      const lufs = await measureLoudness(input, { timeoutMs: t.light * 4, signal: ctx.signal });
      ctx.progress(0.3);
      const out = this.store.tmpPath('m4a');
      await transcodeAudio(input, out, {
        timeoutMs: t.transcode,
        signal: ctx.signal,
        durationMs: info.durationMs,
        onProgress: (f) => ctx.progress(0.3 + f * 0.65),
      });
      const delivery = await this.store.put(out, { ext: 'm4a', mime: 'audio/mp4' });
      ctx.log(`loudness ${lufs ?? '?'} LUFS`);
      return {
        ...m,
        kind: 'audio',
        delivery,
        durationMs: info.durationMs,
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
    opts: { signal: AbortSignal; durationMs?: number; onProgress: (f: number) => void },
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
    return {
      ...m,
      kind: 'video',
      delivery,
      poster: posterRef,
      durationMs: outInfo.durationMs ?? info.durationMs,
      width: outInfo.video?.width,
      height: outInfo.video?.height,
      hasAlpha: alpha,
    };
  }
}
