import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './tools.ts';

export type ProbeStream = {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle' | 'data' | string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  channels?: number;
  duration?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
};
export type Probe = { format: { duration?: string; format_name?: string }; streams: ProbeStream[] };

export type ProbeInfo = {
  durationMs?: number;
  video?: ProbeStream & { fps?: number; hasAlpha: boolean };
  audio?: ProbeStream;
  formatName?: string;
};

const ALPHA_PIX = /^(yuva|rgba|bgra|argb|abgr|ya|gbrap|pal8)/;

function rate(s?: string): number | undefined {
  if (!s) return undefined;
  const [a, b] = s.split('/').map(Number);
  if (!a || !b) return undefined;
  return a / b;
}

export async function probe(file: string, timeoutMs: number): Promise<ProbeInfo> {
  const r = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs },
  );
  const p = JSON.parse(r.stdout) as Probe;
  // Cover art in audio files shows up as an attached-picture video stream: ignore it.
  const v = p.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = p.streams.find((s) => s.codec_type === 'audio');
  const dur = Number(p.format.duration ?? v?.duration ?? a?.duration);
  return {
    durationMs: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : undefined,
    formatName: p.format.format_name,
    video: v
      ? {
          ...v,
          fps: rate(v.avg_frame_rate) ?? rate(v.r_frame_rate),
          hasAlpha:
            v.tags?.alpha_mode === '1' ||
            v.tags?.ALPHA_MODE === '1' ||
            (!!v.pix_fmt && ALPHA_PIX.test(v.pix_fmt) && v.pix_fmt !== 'pal8'),
        }
      : undefined,
    audio: a,
  };
}

const FIT_1080 =
  "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";

function progressParser(durationMs: number | undefined, onProgress?: (f: number) => void) {
  let buf = '';
  return (chunk: string) => {
    if (!onProgress || !durationMs) return;
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
      if (m) onProgress(Math.min(1, Number(m[1]) / 1000 / durationMs));
    }
  };
}

type TOpts = {
  timeoutMs: number;
  signal?: AbortSignal;
  durationMs?: number;
  onProgress?: (f: number) => void;
};
/** The kept part of a source, in its own timeline (Media.trim). */
export type Trim = { startMs: number; endMs: number };
const BASE = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
const IN_SAFE = ['-protocol_whitelist', 'file,pipe'];

/**
 * Input options that read only [startMs, endMs] of the source, placed before its `-i`. Transcoding after an
 * input seek is frame accurate (ffmpeg decodes from the keyframe before and drops what precedes the start),
 * and the output starts at 0, so the trim is baked into the delivery.
 */
export function trimArgs(t: Trim | undefined): string[] {
  return t ? ['-ss', (t.startMs / 1000).toFixed(3), '-to', (t.endMs / 1000).toFixed(3)] : [];
}

/** H.264 High MP4, fit within 1920x1080, fps capped at 60, AAC 256k stereo, faststart. */
export async function transcodeH264(
  input: string,
  output: string,
  info: ProbeInfo,
  o: TOpts & { noAudio?: boolean; trim?: Trim },
): Promise<void> {
  const vf = [FIT_1080];
  if ((info.video?.fps ?? 0) > 60.5) vf.push('fps=60');
  vf.push('format=yuv420p');
  const audio =
    info.audio && !o.noAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '256k', '-ac', '2'] : ['-an'];
  await run(
    'ffmpeg',
    [
      ...BASE,
      ...IN_SAFE,
      ...trimArgs(o.trim),
      '-i',
      input,
      '-map',
      '0:v:0',
      ...audio,
      '-vf',
      vf.join(','),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '60',
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      '-progress',
      'pipe:1',
      '-nostats',
      output,
    ],
    {
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      onStdout: progressParser(o.durationMs, o.onProgress),
      keepStdout: false,
    },
  );
}

/** VP9 WebM with alpha (yuva420p), Opus audio. */
export async function transcodeVp9Alpha(
  input: string,
  output: string,
  info: ProbeInfo,
  o: TOpts & { noAudio?: boolean; trim?: Trim },
): Promise<void> {
  const dec: string[] = [];
  // The native VP8/VP9 decoders drop the alpha side channel; libvpx keeps it.
  if (info.video?.codec_name === 'vp9') dec.push('-c:v', 'libvpx-vp9');
  else if (info.video?.codec_name === 'vp8') dec.push('-c:v', 'libvpx');
  const vf = [FIT_1080];
  if ((info.video?.fps ?? 0) > 60.5) vf.push('fps=60');
  vf.push('format=yuva420p');
  const audio =
    info.audio && !o.noAudio ? ['-map', '0:a:0', '-c:a', 'libopus', '-b:a', '192k', '-ac', '2'] : ['-an'];
  await run(
    'ffmpeg',
    [
      ...BASE,
      ...IN_SAFE,
      ...trimArgs(o.trim),
      ...dec,
      '-i',
      input,
      '-map',
      '0:v:0',
      ...audio,
      '-vf',
      vf.join(','),
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-b:v',
      '0',
      '-crf',
      '30',
      '-deadline',
      'good',
      '-cpu-used',
      '4',
      '-row-mt',
      '1',
      '-auto-alt-ref',
      '0',
      '-g',
      '60',
      '-progress',
      'pipe:1',
      '-nostats',
      output,
    ],
    {
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      onStdout: progressParser(o.durationMs, o.onProgress),
      keepStdout: false,
    },
  );
}

/** 640x360 (fit) JPEG poster at 1 s or the midpoint of short clips. */
export async function poster(input: string, output: string, info: ProbeInfo, o: TOpts): Promise<void> {
  const t = info.durationMs ? Math.min(1, info.durationMs / 2000) : 0;
  const dec = info.video?.codec_name === 'vp9' && info.video.hasAlpha ? ['-c:v', 'libvpx-vp9'] : [];
  await run(
    'ffmpeg',
    [
      ...BASE,
      ...IN_SAFE,
      '-ss',
      t.toFixed(3),
      ...dec,
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2',
      '-q:v',
      '3',
      output,
    ],
    { timeoutMs: o.timeoutMs, signal: o.signal },
  );
}

/** First frame as PNG (still GIFs). */
export async function firstFramePng(input: string, output: string, o: TOpts): Promise<void> {
  await run('ffmpeg', [...BASE, ...IN_SAFE, '-i', input, '-frames:v', '1', output], o);
}

/** Downscale an image to `maxWidth` wide (PNG keeps alpha, JPEG otherwise). */
export async function downscaleImage(
  input: string,
  output: string,
  maxWidth: number,
  o: TOpts,
): Promise<void> {
  const args = [
    ...BASE,
    ...IN_SAFE,
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    `scale=${maxWidth}:-2:flags=lanczos`,
  ];
  if (output.endsWith('.jpg')) args.push('-q:v', '2');
  await run('ffmpeg', [...args, output], o);
}

/**
 * Integrated loudness (LUFS) from ffmpeg's loudnorm measurement pass, over the first audio stream (the one
 * the delivery keeps) of the kept part of an audio file or a video's soundtrack.
 */
export async function measureLoudness(
  input: string,
  o: TOpts & { trim?: Trim },
): Promise<number | undefined> {
  const r = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      ...IN_SAFE,
      ...trimArgs(o.trim),
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-af',
      'loudnorm=print_format=json',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: o.timeoutMs, signal: o.signal, keepStdout: false },
  );
  const m = /\{[^{}]*"input_i"[^{}]*\}/s.exec(r.stderr);
  if (!m) return undefined;
  const v = Number((JSON.parse(m[0]) as { input_i: string }).input_i);
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined;
}

/** AAC 256k stereo in MP4 (m4a). */
export async function transcodeAudio(
  input: string,
  output: string,
  o: TOpts & { trim?: Trim },
): Promise<void> {
  await run(
    'ffmpeg',
    [
      ...BASE,
      ...IN_SAFE,
      ...trimArgs(o.trim),
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      '256k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '-map_metadata',
      '-1',
      '-progress',
      'pipe:1',
      '-nostats',
      output,
    ],
    {
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      onStdout: progressParser(o.durationMs, o.onProgress),
      keepStdout: false,
    },
  );
}

/** Scale and pad an image onto an exact 1920x1080 frame (document pages). */
export async function fitPage(input: string, output: string, o: TOpts): Promise<void> {
  await run(
    'ffmpeg',
    [
      ...BASE,
      ...IN_SAFE,
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black',
      output,
    ],
    o,
  );
}

/** Render every PDF page to PNG at 144 dpi; returns the page files in order. */
export async function pdfToPngs(pdf: string, outDir: string, o: TOpts): Promise<string[]> {
  await run('pdftoppm', ['-r', '144', '-png', pdf, join(outDir, 'page')], o);
  const files = (await readdir(outDir)).filter((f) => /^page-\d+\.png$/.test(f));
  files.sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  return files.map((f) => join(outDir, f));
}

/** LibreOffice headless conversion of a PPTX to PDF, with a throwaway profile. */
export async function pptxToPdf(pptx: string, outDir: string, o: TOpts): Promise<string> {
  const profile = join(outDir, 'lo-profile');
  await run(
    'soffice',
    [
      `-env:UserInstallation=file://${profile}`,
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--nologo',
      '--convert-to',
      'pdf',
      '--outdir',
      outDir,
      pptx,
    ],
    { ...o, env: { PATH: process.env.PATH, HOME: outDir, LANG: 'C.UTF-8' } },
  );
  const pdf = (await readdir(outDir)).find((f) => f.toLowerCase().endsWith('.pdf'));
  if (!pdf) throw new Error('LibreOffice produced no PDF');
  return join(outDir, pdf);
}

/**
 * Parse a GIF's frame count and whether the first frame uses a transparent colour. Later frames are
 * ignored: encoders (ffmpeg included) use transparency there for inter-frame delta compression.
 */
export function gifInfo(b: Uint8Array): {
  frames: number;
  transparent: boolean;
  width: number;
  height: number;
} {
  let frames = 0;
  let transparent = false;
  if (b.length < 13) return { frames: 0, transparent: false, width: 0, height: 0 };
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  let p = 13;
  const flags = b[10]!;
  if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
  const skipSub = () => {
    while (p < b.length) {
      const n = b[p]!;
      p += 1;
      if (n === 0) return;
      p += n;
    }
  };
  while (p < b.length) {
    const t = b[p]!;
    if (t === 0x3b) break;
    if (t === 0x21) {
      const label = b[p + 1];
      if (frames === 0 && label === 0xf9 && b[p + 2] === 4 && (b[p + 3]! & 1) === 1) transparent = true;
      p += 2;
      skipSub();
    } else if (t === 0x2c) {
      frames++;
      const lf = b[p + 9]!;
      p += 10;
      if (lf & 0x80) p += 3 * (1 << ((lf & 7) + 1));
      p += 1; // LZW min code size
      skipSub();
    } else break;
  }
  return { frames, transparent, width, height };
}
