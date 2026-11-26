import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from 'mediabunny';

export type VideoTranscodeReq = { t: 'start'; id: number; file: File } | { t: 'cancel'; id: number };

export type VideoTranscodeRes =
  | { t: 'progress'; id: number; frac: number }
  | { t: 'done'; id: number; buf: ArrayBuffer }
  | { t: 'skip'; id: number; reason: string };

const MAX_W = 1920;
const MAX_H = 1080;
const MAX_FPS = 60.5;
const MAX_DURATION_S = 4 * 3600;
const MAX_COMPLIANT_BPS = 20_000_000;
const AUDIO_BITRATE = 256_000;

/** Fit `(w, h)` within 1920x1080 preserving aspect ratio with even dimensions (never upscaling). */
function fit1080Even(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  const fw = Math.max(2, Math.floor((w * scale) / 2) * 2);
  const fh = Math.max(2, Math.floor((h * scale) / 2) * 2);
  return { width: fw, height: fh };
}

const active = new Map<number, { cancel: () => Promise<void> }>();

function reply(msg: VideoTranscodeRes, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

async function run(id: number, file: File): Promise<void> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    reply({ t: 'skip', id, reason: 'no-webcodecs' });
    return;
  }
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });
  let canceled = false;
  let conversion: Conversion | undefined;
  active.set(id, {
    cancel: async () => {
      canceled = true;
      await conversion?.cancel().catch(() => undefined);
    },
  });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      reply({ t: 'skip', id, reason: 'no-video-track' });
      return;
    }
    if (await videoTrack.canBeTransparent()) {
      reply({ t: 'skip', id, reason: 'alpha' });
      return;
    }
    const duration = await input.computeDuration().catch(() => 0);
    if (duration > MAX_DURATION_S) {
      reply({ t: 'skip', id, reason: 'too-long' });
      return;
    }

    const displayW = await videoTrack.getDisplayWidth();
    const displayH = await videoTrack.getDisplayHeight();
    if (!(displayW > 0 && displayH > 0)) {
      reply({ t: 'skip', id, reason: 'no-dimensions' });
      return;
    }
    const [rotation, flip, par, hdr, stats, audioTrack] = await Promise.all([
      videoTrack.getRotation(),
      videoTrack.getFlip(),
      videoTrack.getPixelAspectRatio(),
      videoTrack.hasHighDynamicRange().catch(() => false),
      videoTrack.computePacketStats(120).catch(() => undefined),
      input.getPrimaryAudioTrack(),
    ]);
    const fps = stats?.averagePacketRate ?? 0;
    const estBps = stats?.averageBitrate ?? (duration > 0 ? Math.round((file.size * 8) / duration) : 0);
    const squarePar = par.num === par.den;
    const audioOk =
      !audioTrack ||
      (audioTrack.codec === 'aac' && audioTrack.numberOfChannels >= 1 && audioTrack.numberOfChannels <= 2);

    // Already compliant 8-bit progressive H.264 + AAC MP4/MOV: skip client re-encode and let the Hub
    // remux losslessly with `-c copy +faststart` in ~1 s.
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const isMp4ish = ext === 'mp4' || ext === 'm4v' || ext === 'mov';
    if (
      isMp4ish &&
      videoTrack.codec === 'avc' &&
      !hdr &&
      rotation === 0 &&
      !flip &&
      squarePar &&
      displayW <= MAX_W &&
      displayH <= MAX_H &&
      displayW % 2 === 0 &&
      displayH % 2 === 0 &&
      fps <= MAX_FPS &&
      estBps > 0 &&
      estBps <= MAX_COMPLIANT_BPS &&
      audioOk
    ) {
      reply({ t: 'skip', id, reason: 'already-compliant' });
      return;
    }

    const { width, height } = fit1080Even(displayW, displayH);
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });
    conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: 'avc',
        width,
        height,
        fit: 'fill',
        allowTransformationMetadata: false,
        frameRate: fps > MAX_FPS ? 60 : undefined,
        quality: QUALITY_HIGH,
        keyFrameInterval: 1,
        forceTranscode: true,
      },
      audio: audioTrack
        ? {
            codec: 'aac',
            bitrate: AUDIO_BITRATE,
            numberOfChannels: Math.min(2, Math.max(1, audioTrack.numberOfChannels || 2)),
          }
        : { discard: true },
    });
    if (canceled) {
      reply({ t: 'skip', id, reason: 'cancelled' });
      return;
    }
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((d) => d.reason).join(',');
      reply({ t: 'skip', id, reason: reasons || 'unsupported-config' });
      return;
    }
    let lastSent = -1;
    conversion.onProgress = (frac: number) => {
      const clamped = Math.max(0, Math.min(1, frac));
      if (clamped - lastSent >= 0.01 || clamped === 1) {
        lastSent = clamped;
        reply({ t: 'progress', id, frac: clamped });
      }
    };
    await conversion.execute();
    if (canceled || !target.buffer || target.buffer.byteLength === 0) {
      reply({ t: 'skip', id, reason: canceled ? 'cancelled' : 'empty-output' });
      return;
    }
    reply({ t: 'done', id, buf: target.buffer }, [target.buffer]);
  } catch (e) {
    reply({ t: 'skip', id, reason: e instanceof Error ? e.message : String(e) });
  } finally {
    active.delete(id);
    input.dispose();
  }
}

self.addEventListener('message', (ev: MessageEvent<VideoTranscodeReq>) => {
  const msg = ev.data;
  if (msg.t === 'start') {
    void run(msg.id, msg.file);
  } else if (msg.t === 'cancel') {
    void active.get(msg.id)?.cancel();
  }
});
