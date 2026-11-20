import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../../../../apps/hub/src/media/tools.ts';
import { SLIDE_H, SLIDE_W } from './probe.ts';
import type { GreyPicture } from './score.ts';

/*
 * What the preset golden (run.ts) and the warp probe golden (warps-run.ts) share of the tools they drive:
 * soffice (LibreOffice 24.2 made both baselines), pdftoppm and ffmpeg. Moved out of run.ts unchanged (the strict
 * flag and the label of the message are parameters of `skip`; the preset golden's report is the proof of the move).
 */

/** The outcome of a run that cannot start: 1 under `strict` (a failure), else 0 with a note that it was skipped. */
export function skip(label: string, why: string, strict: boolean): number {
  if (strict) {
    console.error(`${label}: FAILED, would skip: ${why}`);
    return 1;
  }
  console.log(`${label}: skipped (${why})`);
  return 0;
}

/** Whether a tool runs (`cmd args` exits without a spawn error). */
export async function has(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, { timeoutMs: 30_000, allowFail: true });
    return true;
  } catch {
    return false;
  }
}

/** LibreOffice's pages of the deck: soffice to PDF, then pdftoppm at 144 dpi (as the harness draws them). */
export async function libreOfficePages(deck: string, work: string): Promise<string[]> {
  const lo = join(work, 'libreoffice');
  await rm(lo, { recursive: true, force: true });
  await mkdir(lo, { recursive: true });
  await run(
    'soffice',
    [
      `-env:UserInstallation=file://${join(work, 'lo-profile')}`,
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--nologo',
      '--convert-to',
      'pdf',
      '--outdir',
      lo,
      deck,
    ],
    { timeoutMs: 300_000, group: true, env: { PATH: process.env.PATH, HOME: work, LANG: 'C.UTF-8' } },
  );
  const pdf = (await readdir(lo)).find((f) => f.endsWith('.pdf'));
  if (!pdf) throw new Error('LibreOffice produced no PDF');
  await run('pdftoppm', ['-r', '144', '-png', join(lo, pdf), join(lo, 'page')], { timeoutMs: 300_000 });
  const pages = (await readdir(lo)).filter((f) => /^page-\d+\.png$/.test(f));
  pages.sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  const out: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const f = join(lo, `slide-${String(i + 1).padStart(3, '0')}.png`);
    await rename(join(lo, pages[i]!), f);
    out.push(f);
  }
  return out;
}

/** A page as greyscale pixels (ffmpeg), cut to the slide (LibreOffice's page is 1921 px wide). */
export async function grey(file: string, work: string): Promise<GreyPicture> {
  const raw = join(work, 'grey.raw');
  await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-i',
      file,
      '-vf',
      `crop=${SLIDE_W}:${SLIDE_H}:0:0,format=gray`,
      '-f',
      'rawvideo',
      raw,
    ],
    { timeoutMs: 60_000 },
  );
  const px = new Uint8Array(await readFile(raw));
  if (px.length !== SLIDE_W * SLIDE_H) throw new Error(`${file}: not a ${SLIDE_W}x${SLIDE_H} page`);
  return { w: SLIDE_W, h: SLIDE_H, px };
}
