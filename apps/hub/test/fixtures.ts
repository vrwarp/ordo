import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Tiny generated media fixtures (ffmpeg lavfi sources); cached per directory. */
export function ffmpeg(dir: string, name: string, args: string[]): string {
  const out = join(dir, name);
  if (!existsSync(out))
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, out], {
      stdio: 'pipe',
      timeout: 60_000,
    });
  return out;
}

/** 1 s of 160x120 test pattern with a tone. */
const TEST_AV = [
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x120:rate=25:duration=1',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=1',
];

export const fixtures = {
  video: (d: string) =>
    ffmpeg(d, 'clip.mov', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=30:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      '-shortest',
    ]),
  fastVideo: (d: string) =>
    ffmpeg(d, 'fast.mp4', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=2560x1440:rate=120:duration=0.5',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
    ]),
  alpha: (d: string) =>
    ffmpeg(d, 'alpha.webm', [
      '-f',
      'lavfi',
      '-i',
      'color=c=red@0.5:s=64x64:d=0.5,format=yuva420p',
      '-c:v',
      'libvpx-vp9',
      '-pix_fmt',
      'yuva420p',
      '-auto-alt-ref',
      '0',
    ]),
  png: (d: string) => ffmpeg(d, 'still.png', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x48', '-frames:v', '1']),
  wide: (d: string) =>
    ffmpeg(d, 'wide.jpg', ['-f', 'lavfi', '-i', 'color=c=green:s=4000x200', '-frames:v', '1']),
  gif: (d: string) => ffmpeg(d, 'anim.gif', ['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=0.5']),
  stillGif: (d: string) =>
    ffmpeg(d, 'one.gif', ['-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1']),
  wav: (d: string) => ffmpeg(d, 'tone.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']),
  /** Formats of old church clips and PowerPoint media: ASF (WMV, WMA), MPEG program stream, AIFF, old AVI. */
  wmv: (d: string) => ffmpeg(d, 'clip.wmv', [...TEST_AV, '-c:v', 'wmv2', '-c:a', 'wmav2', '-shortest']),
  wma: (d: string) =>
    ffmpeg(d, 'tone.wma', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'wmav2']),
  mpg: (d: string) =>
    ffmpeg(d, 'clip.mpg', [...TEST_AV, '-c:v', 'mpeg1video', '-c:a', 'mp2', '-f', 'mpeg', '-shortest']),
  vob: (d: string) =>
    ffmpeg(d, 'clip.vob', [...TEST_AV, '-c:v', 'mpeg2video', '-c:a', 'mp2', '-f', 'vob', '-shortest']),
  /** An MPEG program stream with no sound. */
  silentMpg: (d: string) =>
    ffmpeg(d, 'silent.mpg', [...TEST_AV.slice(0, 4), '-c:v', 'mpeg1video', '-f', 'mpeg']),
  aiff: (d: string) => ffmpeg(d, 'tone.aiff', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']),
  avi: (d: string) =>
    ffmpeg(d, 'old.avi', [...TEST_AV, '-c:v', 'msmpeg4v2', '-c:a', 'pcm_s16le', '-shortest']),
  /** A DVD-style anamorphic clip: 720x480 coded, sample aspect ratio 32:27, so 16:9 on screen. */
  anamorphic: (d: string) =>
    ffmpeg(d, 'anamorphic.vob', [
      ...['-f', 'lavfi', '-i', 'testsrc2=size=720x480:rate=25:duration=1,setsar=32/27'],
      ...['-c:v', 'mpeg2video', '-f', 'vob'],
    ]),
  /** The same ratio with alpha (WebM stores it as a display width, a whole number: 432 * 32 / 27 = 512). */
  anamorphicAlpha: (d: string) =>
    ffmpeg(d, 'anamorphic-alpha.webm', [
      ...['-f', 'lavfi', '-i', 'testsrc2=size=432x288:rate=25:duration=0.5,format=yuva420p,setsar=32/27'],
      ...['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0'],
    ]),
  /** 2 s WMV: black and silent for 1 s, then white with a tone (trim tests can tell the halves apart). */
  halves: (d: string) =>
    ffmpeg(d, 'halves.wmv', [
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x48:r=25:d=1[a];color=c=white:s=64x48:r=25:d=1[b];[a][b]concat=n=2:v=1:a=0[out0];' +
        'aevalsrc=0:d=1:s=44100[c];sine=frequency=440:duration=1:sample_rate=44100[d];[c][d]concat=n=2:v=0:a=1[out1]',
      '-c:v',
      'wmv2',
      '-c:a',
      'wmav2',
    ]),
  pdf: (d: string, pages = 2) => {
    const out = join(d, `doc${pages}.pdf`);
    if (!existsSync(out)) writeFileSync(out, minimalPdf(pages));
    return out;
  },
  /** A two-slide PPTX via python-pptx, or undefined when it is unavailable. */
  pptx: (d: string): string | undefined => {
    const out = join(d, 'deck.pptx');
    if (existsSync(out)) return out;
    const py = `
import sys
from pptx import Presentation
from pptx.util import Inches, Pt
p = Presentation()
p.slide_width = Inches(13.333); p.slide_height = Inches(7.5)
for t in ['Welcome to church', 'Announcements']:
    s = p.slides.add_slide(p.slide_layouts[6])
    tb = s.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(2))
    tb.text_frame.text = t
    tb.text_frame.paragraphs[0].runs[0].font.size = Pt(40)
p.save(sys.argv[1])
`;
    const r = spawnSync('python3', ['-c', py, out], { timeout: 30_000 });
    return r.status === 0 ? out : undefined;
  },
};

/** A minimal valid PDF with N 16:9 pages, each with a filled rectangle. */
export function minimalPdf(pages: number): Buffer {
  const objs: string[] = [];
  const kids: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  for (let i = 0; i < pages; i++) {
    const pageNo = 3 + i * 2;
    const content = `${0.2 + i * 0.3} 0.4 0.8 rg 100 100 ${200 + i * 100} 200 re f`;
    objs[pageNo] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Contents ${pageNo + 1} 0 R /Resources << >> >>`;
    objs[pageNo + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    kids.push(`${pageNo} 0 R`);
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) body += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
