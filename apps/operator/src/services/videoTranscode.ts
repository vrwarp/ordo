import { useLive } from '../state/live.ts';
import type { VideoTranscodeReq, VideoTranscodeRes } from '../workers/videoTranscode.worker.ts';
import { log } from './log.ts';
import { useLaunch } from './outputs.ts';

let nextId = 1;

/** Pure helper: whether this browser context may run client WebCodecs transcoding. */
export function shouldClientTranscode(opts: {
  liveMode: 'idle' | 'live';
  hasOpenOutputs: boolean;
  hasWebCodecs: boolean;
}): boolean {
  if (!opts.hasWebCodecs) return false;
  // Never compete with local 60 fps output windows on the venue PC during a live service (ADR 0016).
  if (opts.liveMode === 'live' && opts.hasOpenOutputs) return false;
  return true;
}

/** Rename `<base>.<ext>` to `<base>.mp4` for a client-transcoded video file. */
export function mp4FileName(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,8}$/, '') || name;
  return `${base}.mp4`;
}

/**
 * Optionally transcode a video file in a dedicated WebCodecs worker before uploading (ADR 0016).
 * Returns a compliant 1080p H.264 + AAC `.mp4` `File`, or `undefined` when skipped/unsupported/failed so the
 * caller transparently uploads the raw original file to the Hub.
 */
export async function maybeTranscodeVideo(
  file: File,
  onProgress?: (frac: number) => void,
  signal?: AbortSignal,
): Promise<File | undefined> {
  if (signal?.aborted) return undefined;
  const hasWebCodecs =
    typeof Worker !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoDecoder !== 'undefined';
  const liveMode = useLive.getState().state.mode;
  const hasOpenOutputs = Object.values(useLaunch.getState().open).some(Boolean);
  if (!shouldClientTranscode({ liveMode, hasOpenOutputs, hasWebCodecs })) return undefined;

  const id = nextId++;
  const worker = new Worker(new URL('../workers/videoTranscode.worker.ts', import.meta.url), {
    type: 'module',
    name: 'ordo-video-transcode',
  });

  return new Promise<File | undefined>((resolve) => {
    let settled = false;
    const finish = (out: File | undefined) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      resolve(out);
    };
    const onAbort = () => {
      try {
        worker.postMessage({ t: 'cancel', id } satisfies VideoTranscodeReq);
      } catch {
        /* ignore */
      }
      finish(undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('error', (ev) => {
      log('warn', `client video transcode worker error: ${ev.message || 'unknown'}`);
      finish(undefined);
    });
    worker.addEventListener('message', (ev: MessageEvent<VideoTranscodeRes>) => {
      const msg = ev.data;
      if (msg.id !== id) return;
      if (msg.t === 'progress') {
        onProgress?.(msg.frac);
      } else if (msg.t === 'done') {
        onProgress?.(1);
        const out = new File([msg.buf], mp4FileName(file.name), {
          type: 'video/mp4',
          lastModified: file.lastModified,
        });
        log(
          'info',
          `client transcoded ${file.name} (${(file.size / 1e6).toFixed(1)} MB -> ${(out.size / 1e6).toFixed(1)} MB)`,
        );
        finish(out);
      } else if (msg.t === 'skip') {
        if (msg.reason !== 'already-compliant' && msg.reason !== 'cancelled')
          log('info', `client video transcode skipped for ${file.name}: ${msg.reason}`);
        finish(undefined);
      }
    });
    worker.postMessage({ t: 'start', id, file } satisfies VideoTranscodeReq);
  });
}
