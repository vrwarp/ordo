import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../../../apps/hub/src/media/tools.ts';
import { PRESET_GEOMS } from '../../../../packages/renderer/src/geom/presets.gen.ts';
import { ssim } from '../../../pptx-fidelity/src/ssim.ts';
import { EXCEPTIONS } from './exceptions.ts';
import type { PageJob } from './page.ts';
import {
  CELL_H,
  CELL_W,
  type PxRect,
  probeDeck,
  probeLayout,
  SLIDE_H,
  SLIDE_W,
  slideCount,
} from './probe.ts';
import {
  baselineOf,
  type GreyPicture,
  MAX_DROP,
  MIN_SSIM,
  type PresetBaseline,
  scoreRegion,
  verdict,
} from './score.ts';

/*
 * The preset golden (design/27 §14 item 6, §15 M6 exit): every preset geometry at its default adjust values,
 * drawn by LibreOffice from a probe deck (probe.ts) and by drawGeom in headless Chromium (page.ts), scored box by
 * box with the fidelity harness's SSIM, and checked against the committed baseline.
 *
 *   pnpm --filter @ordo/geom-gen golden            compare with baseline.json; exit 1 on a failure
 *   pnpm --filter @ordo/geom-gen golden --update   rewrite baseline.json from this run
 *   ... --out DIR       keep the deck, LibreOffice's and ordo's pages, report.json (every score and region) and
 *                       compare/<preset>.png (LibreOffice | ordo) for each preset under the bar or its baseline
 *   ... --strict        a missing tool fails the run instead of skipping it (CI sets CI=true: always strict)
 *
 * A run fails when a preset is under MIN_SSIM (0.95) and not listed in exceptions.ts with its reason, or falls
 * more than MAX_DROP (0.01) below its baseline. Needs soffice (LibreOffice 24.2 made the baseline), pdftoppm,
 * ffmpeg and Chromium (Playwright's, ORDO_CHROMIUM, or /usr/bin/google-chrome).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const BASELINE = join(here, 'baseline.json');

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const strict = argv.includes('--strict') || !!process.env.CI;
const outArg = argv.indexOf('--out');
const outDir = outArg >= 0 ? argv[outArg + 1] : undefined;

function skip(why: string): number {
  if (strict) {
    console.error(`preset golden: FAILED, would skip: ${why}`);
    return 1;
  }
  console.log(`preset golden: skipped (${why})`);
  return 0;
}

async function has(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, { timeoutMs: 30_000, allowFail: true });
    return true;
  } catch {
    return false;
  }
}

async function findChromium(): Promise<string | undefined> {
  if (process.env.ORDO_CHROMIUM) return process.env.ORDO_CHROMIUM;
  try {
    const exe = (await import('@playwright/test')).chromium.executablePath();
    if (existsSync(exe)) return exe;
  } catch {
    /* not installed */
  }
  return existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
}

type Esbuild = { build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }> };

/** esbuild is not a dependency here; vite (apps/output) depends on it, so resolve it through vite. */
async function loadEsbuild(): Promise<Esbuild> {
  const name = 'esbuild';
  try {
    return (await import(name)) as Esbuild;
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    return (await import(createRequire(fromOutput.resolve('vite')).resolve(name))) as Esbuild;
  }
}

/** LibreOffice's pages of the deck: soffice to PDF, then pdftoppm at 144 dpi (as the harness draws them). */
async function libreOfficePages(deck: string, work: string): Promise<string[]> {
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

/** ordo's pages: page.ts in headless Chromium. */
async function ordoPages(job: PageJob, work: string, executablePath: string): Promise<string[]> {
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: built.outputFiles[0]!.text });
    const pngs = await page.evaluate(
      (j) => (window as unknown as { __presetPages: (j: PageJob) => Promise<string[]> }).__presetPages(j),
      job,
    );
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    const dir = join(work, 'ordo');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const out: string[] = [];
    for (let i = 0; i < pngs.length; i++) {
      const f = join(dir, `slide-${String(i + 1).padStart(3, '0')}.png`);
      await writeFile(f, Buffer.from(pngs[i]!, 'base64'));
      out.push(f);
    }
    console.log(`preset golden: ordo drew ${out.length} slides (${await browser.version()})`);
    return out;
  } finally {
    await browser.close();
  }
}

/** A page as greyscale pixels (ffmpeg), cut to the slide (LibreOffice's page is 1921 px wide). */
async function grey(file: string, work: string): Promise<GreyPicture> {
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

/** LibreOffice's and ordo's drawing of one region side by side (ffmpeg), for a preset that needs a look. */
async function sideBySide(lo: string, ordo: string, region: PxRect, file: string): Promise<void> {
  const cut = `crop=${region.w}:${region.h}:${region.x}:${region.y}`;
  await run(
    'ffmpeg',
    ['-v', 'error', '-y', '-i', lo, '-i', ordo, '-lavfi', `[0:v]${cut}[a];[1:v]${cut}[b];[a][b]hstack`, file],
    { timeoutMs: 60_000 },
  );
}

async function readBaseline(): Promise<PresetBaseline | undefined> {
  if (!existsSync(BASELINE)) return undefined;
  return JSON.parse(await readFile(BASELINE, 'utf8')) as PresetBaseline;
}

async function main(): Promise<number> {
  for (const [cmd, args] of [
    ['soffice', ['--version']],
    ['pdftoppm', ['-v']],
    ['ffmpeg', ['-version']],
  ] as const)
    if (!(await has(cmd, [...args]))) return skip(`${cmd} is not installed`);
  const executablePath = await findChromium();
  if (!executablePath) return skip('no Chromium (npx playwright install chromium, or set ORDO_CHROMIUM)');

  const work = outDir ? resolve(outDir) : join(tmpdir(), `ordo-preset-golden-${process.pid}`);
  await mkdir(work, { recursive: true });
  try {
    const names = [...PRESET_GEOMS.keys()].sort();
    const shapes = probeLayout(names);
    const deck = join(work, 'presets.pptx');
    await writeFile(deck, probeDeck(shapes));
    const version = (await run('soffice', ['--version'], { timeoutMs: 30_000 })).stdout.trim();
    const lo = await libreOfficePages(deck, work);
    console.log(`preset golden: ${version} drew ${lo.length} slides`);
    const ordo = await ordoPages({ shapes, slides: slideCount(shapes) }, work, executablePath);
    if (lo.length !== ordo.length)
      throw new Error(`LibreOffice drew ${lo.length} slides, ordo ${ordo.length}`);

    const scores = new Map<string, number>();
    const rows: { name: string; slide: number; ssim: number; region: PxRect }[] = [];
    for (let i = 0; i < lo.length; i++) {
      const [ref, cand] = [await grey(lo[i]!, work), await grey(ordo[i]!, work)];
      for (const s of shapes.filter((x) => x.slide === i)) {
        const region = scoreRegion(s.cell, s.box, ref, cand);
        const score = await ssim(lo[i]!, ordo[i]!, region);
        scores.set(s.name, score);
        rows.push({ name: s.name, slide: i + 1, ssim: score, region });
      }
    }
    if (scores.size !== names.length) throw new Error(`scored ${scores.size} of ${names.length} presets`);

    const sorted = [...rows].sort((a, b) => a.ssim - b.ssim);
    const passing = rows.filter((r) => r.ssim >= MIN_SSIM).length;
    const mean = rows.reduce((t, r) => t + r.ssim, 0) / rows.length;
    console.log(
      `preset golden: ${passing} of ${rows.length} presets at SSIM >= ${MIN_SSIM} (mean ${mean.toFixed(4)}, min ${sorted[0]!.ssim.toFixed(4)} ${sorted[0]!.name}); cells ${CELL_W}x${CELL_H}`,
    );
    for (const r of sorted.filter((x) => x.ssim < MIN_SSIM))
      console.log(
        `  ${r.name} (slide ${r.slide}): ${r.ssim.toFixed(4)}${Object.hasOwn(EXCEPTIONS, r.name) ? ' (listed in exceptions.ts)' : ''}`,
      );
    await writeFile(join(work, 'report.json'), `${JSON.stringify({ version, rows }, null, 2)}\n`);

    if (update) {
      await writeFile(
        BASELINE,
        `${JSON.stringify({ libreoffice: version, ...baselineOf(scores) }, null, 2)}\n`,
      );
      console.log(`preset golden: wrote ${BASELINE}`);
    }
    const baseline = update ? undefined : await readBaseline();
    const v = verdict(scores, baseline, EXCEPTIONS);
    if (outDir) {
      // LibreOffice | ordo for every preset under the bar or below its baseline.
      const look = rows.filter((r) => {
        const base = baseline?.presets[r.name];
        return r.ssim < MIN_SSIM || (base !== undefined && r.ssim < base - MAX_DROP);
      });
      if (look.length) await mkdir(join(work, 'compare'), { recursive: true });
      for (const r of look)
        await sideBySide(
          lo[r.slide - 1]!,
          ordo[r.slide - 1]!,
          r.region,
          join(work, 'compare', `${r.name}.png`),
        );
      if (look.length)
        console.log(
          `preset golden: LibreOffice | ordo of ${look.length} preset(s) in ${join(work, 'compare')}`,
        );
    }
    for (const n of v.notes) console.log(`  note: ${n}`);
    for (const f of v.failures) console.error(`  FAIL: ${f}`);
    if (v.failures.length) {
      console.error(
        `preset golden: ${v.failures.length} failure(s) (a drop of more than ${MAX_DROP}, or an unlisted preset under ${MIN_SSIM}); rerun with --out DIR to see them`,
      );
      return 1;
    }
    console.log('preset golden: ok');
    return 0;
  } finally {
    if (!outDir) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`preset golden: ${(e as Error).stack ?? e}`);
    process.exit(1);
  },
);
