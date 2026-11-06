/**
 * PowerPoint fidelity: draw decks with LibreOffice (the ground truth for now) and with pptx-preview (with
 * and without ordo's corrections), score every slide against LibreOffice, and write a report.
 *
 *   pnpm --filter @ordo/pptx-fidelity start -- [--corpus] [--out DIR] [--chromium PATH] [--raw]
 *        [--fresh-lo] [--baseline summary.json] [deck.pptx | dir]...
 *
 * Folders are searched with their subfolders for .pptx/.pptm/.ppsx/.potx decks; a deck either renderer cannot
 * draw is recorded in its notes and the run goes on.
 *
 * --corpus      include the synthetic decks (src/corpus.ts)
 * --raw         also draw with pptx-preview unmodified, to show what the corrections are worth
 * --fresh-lo    redraw the LibreOffice pictures even when they exist (they are the slow part)
 * --baseline    compare with an earlier summary.json and print the change per deck
 *
 * Real decks stay outside the repository: pass their paths. The score is SSIM of greyscale pictures at
 * 960x540 (1 = identical), computed by ffmpeg.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pptxForRendering } from '@ordo/importers';
import { renderWithPptxPreview } from '@ordo/pptx-render';
import { pdfToPngs, pptxToPdf } from '../../../apps/hub/src/media/ffmpeg.ts';
import { run } from '../../../apps/hub/src/media/tools.ts';
import { buildCorpus } from './corpus.ts';
import { type DeckScore, writeReport } from './report.ts';

type Args = {
  out: string;
  corpus: boolean;
  raw: boolean;
  freshLo: boolean;
  chromium?: string;
  baseline?: string;
  decks: string[];
};

function parseArgs(argv: string[]): Args {
  const a: Args = { out: 'tmp/pptx-fidelity', corpus: false, raw: false, freshLo: false, decks: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--out') a.out = argv[++i]!;
    else if (v === '--corpus') a.corpus = true;
    else if (v === '--raw') a.raw = true;
    else if (v === '--fresh-lo') a.freshLo = true;
    else if (v === '--chromium') a.chromium = argv[++i];
    else if (v === '--baseline') a.baseline = argv[++i];
    else if (v === '--') continue;
    else if (v.startsWith('--')) throw new Error(`unknown option ${v}`);
    else a.decks.push(v);
  }
  return a;
}

async function findChromium(given?: string): Promise<string> {
  if (given) return given;
  if (process.env.ORDO_CHROMIUM) return process.env.ORDO_CHROMIUM;
  try {
    const exe = (await import('@playwright/test')).chromium.executablePath();
    if (existsSync(exe)) return exe;
  } catch {
    /* not installed */
  }
  return 'chromium';
}

/** PresentationML files: decks, slide shows, templates, macro-enabled decks. */
const DECK_RE = /\.(pptx|pptm|ppsx|ppsm|potx|potm)$/i;

/** Decks given as files, or found in folders (and their subfolders), each with a name unique in the run. */
async function decksIn(paths: string[]): Promise<{ file: string; name: string }[]> {
  const out: { file: string; name: string }[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const f of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (f.isDirectory()) await walk(join(dir, f.name), `${prefix}${f.name}__`);
      else if (DECK_RE.test(f.name)) out.push({ file: join(dir, f.name), name: prefix + f.name });
    }
  };
  for (const p of paths) {
    if ((await stat(p)).isDirectory()) await walk(p, '');
    else out.push({ file: p, name: basename(p) });
  }
  return out;
}

async function pngsIn(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir))
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** LibreOffice, as the hub draws a deck: outline repair, PDF export, 144 dpi pages. */
async function drawWithLibreOffice(deck: string, outDir: string): Promise<string[]> {
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

async function drawWithPptxPreview(
  deck: string,
  outDir: string,
  chromium: string,
  fixes: boolean,
): Promise<{ pages: string[]; styled: number; notes: string[] }> {
  const work = join(outDir, '.work');
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try {
    const r = await renderWithPptxPreview(deck, work, { chromium, timeoutMs: 300_000, fixes });
    const out: string[] = [];
    for (let i = 0; i < r.pages.length; i++) {
      const f = join(outDir, `slide-${String(i + 1).padStart(4, '0')}.png`);
      await copyFile(r.pages[i]!, f);
      out.push(f);
    }
    return { pages: out, styled: r.styled, notes: r.notes };
  } catch (e) {
    return { pages: [], styled: 0, notes: [`failed: ${(e as Error).message}`] };
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** A PNG's size from its header. */
async function pngSize(file: string): Promise<{ w: number; h: number } | undefined> {
  const b = await readFile(file);
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/**
 * SSIM of two pictures in greyscale at 960x540 (ffmpeg). The reference is first cut to the other's
 * proportions: LibreOffice rounds a slide up to a whole pixel (1921x1080, 1440x811), a blank last column
 * or row.
 */
async function ssim(a: string, b: string): Promise<number> {
  const size = await pngSize(b);
  const ratio = size ? `${size.w}/${size.h}` : '';
  const crop = size ? `crop='min(iw,trunc(ih*${ratio}+0.5))':'min(ih,trunc(iw/(${ratio})+0.5))':0:0,` : '';
  const r = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      a,
      '-i',
      b,
      '-lavfi',
      `[0:v]${crop}scale=960:540:flags=area,format=gray[a];[1:v]scale=960:540:flags=area,format=gray[b];[a][b]ssim`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 60_000 },
  );
  const m = /All:([0-9.]+)/.exec(r.stderr);
  return m ? Number(m[1]) : 0;
}

async function scoreAll(lo: string[], other: string[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < lo.length; i++) out.push(other[i] ? await ssim(lo[i]!, other[i]!) : 0);
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const out = resolve(a.out);
  await mkdir(out, { recursive: true });
  const chromium = await findChromium(a.chromium);
  const decks = await decksIn(a.decks);
  if (a.corpus)
    decks.unshift(...(await buildCorpus(join(out, 'corpus'))).map((f) => ({ file: f, name: basename(f) })));
  if (!decks.length) throw new Error('no decks: pass .pptx files or folders, or --corpus');

  const scores: DeckScore[] = [];
  // Letters of any script stay (decks named only in Burmese or Arabic would all be "_"), and each name is
  // unique in the run: a deck's folder keeps its LibreOffice pictures for the next run to reuse.
  const taken = new Set<string>();
  for (const { file: deck, name: given } of decks) {
    const base = given.replace(DECK_RE, '').replace(/[^\p{L}\p{M}\p{N}_.-]+/gu, '_');
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}_${i}`;
    taken.add(name.toLowerCase());
    const dir = join(out, name);
    const loDir = join(dir, 'libreoffice');
    let lo = await pngsIn(loDir);
    const loNotes: string[] = [];
    if (!lo.length || a.freshLo) {
      await rm(loDir, { recursive: true, force: true });
      await mkdir(loDir, { recursive: true });
      // One deck LibreOffice cannot draw must not end the run: it is a finding.
      try {
        lo = await drawWithLibreOffice(deck, loDir);
      } catch (e) {
        lo = [];
        loNotes.push(`libreoffice failed: ${(e as Error).message.slice(0, 300)}`);
      }
    }
    const ppvDir = join(dir, 'pptx-preview');
    await rm(ppvDir, { recursive: true, force: true });
    await mkdir(ppvDir, { recursive: true });
    const t0 = performance.now();
    const ppv = await drawWithPptxPreview(deck, ppvDir, chromium, true);
    const ms = performance.now() - t0;
    let raw: { pages: string[]; notes: string[] } | undefined;
    if (a.raw) {
      const rawDir = join(dir, 'raw');
      await rm(rawDir, { recursive: true, force: true });
      await mkdir(rawDir, { recursive: true });
      raw = await drawWithPptxPreview(deck, rawDir, chromium, false);
    }
    const fixed = await scoreAll(lo, ppv.pages);
    const rawScores = raw ? await scoreAll(lo, raw.pages) : undefined;
    const s: DeckScore = {
      name,
      slides: lo.length,
      ppvSlides: ppv.pages.length,
      ssim: mean(fixed),
      ...(rawScores ? { rawSsim: mean(rawScores) } : {}),
      ms: Math.round(ms),
      styled: ppv.styled,
      notes: [...loNotes, ...ppv.notes],
      perSlide: lo.map((f, i) => ({
        n: i + 1,
        ssim: fixed[i]!,
        ...(rawScores ? { raw: rawScores[i]! } : {}),
        libreoffice: relative(out, f),
        ppv: ppv.pages[i] ? relative(out, ppv.pages[i]!) : undefined,
        ...(raw?.pages[i] ? { rawPpv: relative(out, raw.pages[i]!) } : {}),
      })),
    };
    scores.push(s);
    // The scores so far, after every deck: a long run that is stopped still leaves its results.
    await writeFile(
      join(out, 'summary.partial.json'),
      JSON.stringify({ createdAt: new Date().toISOString(), chromium, decks: scores }),
    );
    const rawText = s.rawSsim !== undefined ? `  unmodified ${s.rawSsim.toFixed(3)}` : '';
    console.log(
      `${name.padEnd(40)} ${String(s.slides).padStart(3)} slides  ssim ${s.ssim.toFixed(3)}${rawText}  ${s.ms} ms`,
    );
  }
  const summary = {
    createdAt: new Date().toISOString(),
    chromium,
    mean: mean(scores.map((s) => s.ssim)),
    decks: scores,
  };
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  await writeReport(join(out, 'report.html'), summary);
  console.log(
    `\nmean ssim ${summary.mean.toFixed(3)} over ${scores.length} deck(s); report: ${join(out, 'report.html')}`,
  );
  if (a.baseline) {
    const base = JSON.parse(await readFile(a.baseline, 'utf8')) as { decks: DeckScore[] };
    for (const s of scores) {
      const b = base.decks.find((d) => d.name === s.name);
      if (b)
        console.log(
          `${s.name.padEnd(40)} ${b.ssim.toFixed(3)} -> ${s.ssim.toFixed(3)} (${s.ssim >= b.ssim ? '+' : ''}${(s.ssim - b.ssim).toFixed(3)})`,
        );
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
