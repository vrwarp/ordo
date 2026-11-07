/**
 * LibreOffice's pictures of a deck, the harness's reference (design/27 §14.1): the deck's render copy
 * (`pptxForRendering`: outline repair, as the hub's), exported to PDF by `soffice --convert-to pdf` with a
 * throwaway profile, and its pages drawn at 144 dpi by `pdftoppm`. Moved here from the hub's
 * `media/ffmpeg.ts` (M9 plan, lo-dependencies §3): this unhardened soffice call was only ever the
 * harness's, and the hub keeps one LibreOffice path of its own (`pptx/fallback.ts`, sandboxed and bounded).
 * The harness runs it on decks the person running it chose; the hub never does.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pptxForRendering } from '@ordo/importers';
import { pdfToPngs } from '../../../apps/hub/src/media/ffmpeg.ts';
import { run } from '../../../apps/hub/src/media/tools.ts';

/** LibreOffice headless conversion of a PPTX to PDF in `outDir`, with a throwaway profile there. */
export async function pptxToPdf(pptx: string, outDir: string, o: { timeoutMs: number }): Promise<string> {
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

/** LibreOffice, as the hub draws a deck: outline repair, PDF export, 144 dpi pages `slide-NNNN.png`. */
export async function drawWithLibreOffice(deck: string, outDir: string): Promise<string[]> {
  const work = join(outDir, '.work');
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(work, { recursive: true });
  const input = join(work, 'slides.pptx');
  const prepared = await pptxForRendering(new Uint8Array(await readFile(deck)));
  await writeFile(input, prepared.bytes);
  const pdf = await pptxToPdf(input, work, { timeoutMs: 300_000 });
  const pages = await pdfToPngs(pdf, work, { timeoutMs: 300_000 });
  const out: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const f = join(outDir, `slide-${String(i + 1).padStart(4, '0')}.png`);
    await rename(pages[i]!, f);
    out.push(f);
  }
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return out;
}
