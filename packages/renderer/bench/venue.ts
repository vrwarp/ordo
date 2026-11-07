import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, hostname, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { budgetFor, bundle, defaultFonts, fmtStats, printSlides, runSlides } from './slides.ts';
import type { Stats, VenuePageReport } from './venue.page.ts';

/**
 * Venue measurement (design/27 §13 budgets, §15 M7; procedure and results in design/14 "Measuring on venue
 * machines"): one command on a venue machine (the Windows 11 presentation PC with its iGPU, a PC with a
 * discrete GPU, a Mac) records
 * - the machine: OS, CPU, memory, Chrome, the display and its refresh;
 * - the GPU: the WebGPU adapter (vendor, architecture, whether it is a software fallback, timestamp
 *   queries), a full-frame upload at 1920x1080 and 3840x2160 (CPU ms of the call, ms until the GPU has done
 *   it) and five full-frame layers composed in one pass (GPU ms, timestamp queries), venue.page.ts;
 * - the asset worker's slide raster on this machine's CPU, per slide kind and size (slides.page.ts);
 * and checks them against the budgets: slide raster p95 10 ms at 1080p, 30 ms at 4K (12 ms for text over a
 * photo, the M7 exit), upload and GPU time per frame 4 ms at 4K.
 *
 *   pnpm --filter @ordo/renderer bench:venue [--channel chrome | --executable <path>] [--out <file>]
 *        [--iterations 60] [--runs 30] [--headless] [--swiftshader] [--font <ttf> --bold <ttf>]
 *
 * Chrome runs visible (the refresh rate and a real GPU need a shown window) unless --headless. --swiftshader
 * runs WebGPU on SwiftShader in this container: it checks that the script works and measures the CPU, never
 * a GPU. The JSON goes to --out (default venue-results/<host>-<date>.json); a summary line for design/14's
 * table is printed at the end.
 */

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string) => process.argv.includes(name);

/** A face each platform has, for the raster bench (the font changes the figures a little; record it). */
function platformFonts(): { regular: string; bold: string } {
  if (platform() === 'win32')
    return { regular: 'C:\\Windows\\Fonts\\arial.ttf', bold: 'C:\\Windows\\Fonts\\arialbd.ttf' };
  if (platform() === 'darwin')
    return {
      regular: '/System/Library/Fonts/Supplemental/Arial.ttf',
      bold: '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    };
  return defaultFonts();
}

const ms = (x: number | undefined) => (x === undefined ? '-' : x.toFixed(2));
const p = (s: Stats | undefined) => (s ? `${ms(s.p50)} / ${ms(s.p95)}` : '-');

async function main(): Promise<number> {
  const swiftshader = has('--swiftshader');
  const headless = has('--headless') || swiftshader;
  const channel = arg('--channel') ?? (platform() === 'linux' ? undefined : 'chrome');
  const executablePath = arg('--executable');
  const fonts = platformFonts();
  const regular = arg('--font') ?? fonts.regular;
  const bold = arg('--bold') ?? fonts.bold;
  if (!existsSync(regular) || !existsSync(bold)) {
    console.error(`bench:venue: font not found (${regular}); pass --font <regular.ttf> --bold <bold.ttf>`);
    return 1;
  }
  const args = swiftshader
    ? [
        '--enable-unsafe-webgpu',
        '--use-angle=swiftshader',
        '--use-vulkan=swiftshader',
        '--enable-features=Vulkan',
      ]
    : ['--enable-unsafe-webgpu'];

  // 1. The machine, its display and its GPU, on a secure page (WebGPU needs one).
  const script = await bundle('venue.page.ts');
  const browser = await chromium.launch({ headless, args, channel, executablePath });
  let page: VenuePageReport;
  let version = '';
  try {
    version = browser.version();
    const tab = await browser.newPage({ viewport: null });
    tab.on('pageerror', (e) => console.error('page error:', e.message));
    await tab.route('https://venue.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
    );
    await tab.goto('https://venue.test/');
    await tab.addScriptTag({ content: script });
    page = await tab.evaluate(
      ([frames, runs]) =>
        (window as unknown as { __venue(f: boolean, r: number): Promise<VenuePageReport> }).__venue(
          frames as boolean,
          runs as number,
        ),
      [!headless, Math.max(5, Number(arg('--runs') ?? 30))] as const,
    );
  } finally {
    await browser.close();
  }

  // 2. The asset worker's slide raster on this machine's CPU.
  const slides = await runSlides({
    iterations: Math.max(5, Number(arg('--iterations') ?? 60)),
    sizes: [1920, 3840],
    regular,
    bold,
    channel,
    executablePath,
    headless,
  });

  const cpu = cpus();
  const report = {
    at: new Date().toISOString(),
    host: hostname(),
    os: `${platform()} ${release()}`,
    cpu: { model: cpu[0]?.model ?? '?', cores: cpu.length },
    memoryGB: Math.round(totalmem() / 2 ** 30),
    browser: version,
    swiftshader,
    fonts: { regular, bold },
    ...page,
    slides,
  };

  console.log(
    `bench:venue: ${report.host}, ${report.os}, ${report.cpu.model} (${report.cpu.cores} threads), ${report.memoryGB} GB`,
  );
  console.log(
    `  Chrome ${version}; screen ${page.machine.screen.width}x${page.machine.screen.height} @${page.machine.screen.devicePixelRatio}x${page.machine.frameMs ? `, frame ${page.machine.frameMs.toFixed(2)} ms` : ''}`,
  );
  const g = page.gpu;
  if (!g.available) console.log(`  GPU: none (${g.error})`);
  else {
    console.log(
      `  GPU: ${JSON.stringify(g.adapter ?? {})}${g.isFallbackAdapter ? ' SOFTWARE FALLBACK' : ''}${swiftshader ? ' (SwiftShader: CPU, not a venue GPU)' : ''}; timestamp queries ${g.timestampQuery ? 'yes' : 'no'}`,
    );
    for (const s of g.sizes)
      console.log(
        `  ${s.width}x${s.height}: upload CPU ${fmtStats(s.uploadCpuMs)}; upload done ${fmtStats(s.uploadDoneMs)}${s.composeGpuMs ? `; compose 5 layers GPU ${fmtStats(s.composeGpuMs)}` : ''}`,
      );
  }
  printSlides(slides);

  // 3. Budgets (design/27 §13).
  const over: string[] = [];
  for (const row of slides.rows)
    if (row.raster.p95 > budgetFor(row))
      over.push(`${row.kind} at ${row.width}: raster p95 ${ms(row.raster.p95)} ms`);
  const k4 = g.sizes.find((s) => s.width === 3840);
  if (k4 && !swiftshader) {
    if (k4.uploadDoneMs.p50 > 4)
      over.push(`4K upload ${ms(k4.uploadDoneMs.p50)} ms (one copy; the renderer uploads in strips)`);
    if (k4.composeGpuMs && k4.composeGpuMs.p50 > 4) over.push(`4K compose ${ms(k4.composeGpuMs.p50)} ms GPU`);
  }
  console.log(over.length ? `  over budget: ${over.join('; ')}` : '  every figure within its budget');

  // 4. One line for the table in design/14 "Measuring on venue machines".
  const r = (kind: string, w: number) =>
    slides.rows.find((x) => x.kind.startsWith(kind) && x.width === w)?.raster;
  const k1 = g.sizes.find((s) => s.width === 1920);
  console.log(
    '\nRow for design/14 (machine | GPU | slide raster p50/p95 at 1080p, 4K: photo, lyric, table, scene | upload done p50 1080p / 4K | compose 4K):',
  );
  console.log(
    `| ${report.host}: ${report.cpu.model}, ${report.os} | ${g.adapter ? `${g.adapter.vendor} ${g.adapter.architecture} ${g.adapter.description}`.trim() : 'none'} | ${['sermon', 'lyric', 'table', 'scene'].map((k) => `${p(r(k, 1920))}`).join(', ')}; ${['sermon', 'lyric', 'table', 'scene'].map((k) => `${p(r(k, 3840))}`).join(', ')} | ${ms(k1?.uploadDoneMs.p50)} / ${ms(k4?.uploadDoneMs.p50)} | ${ms(k4?.composeGpuMs?.p50)} |`,
  );

  const date = report.at.slice(0, 10);
  const out = arg('--out') ?? join('venue-results', `${report.host.replace(/[^\w.-]+/g, '_')}-${date}.json`);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nbench:venue: wrote ${out}`);
  return 0;
}

process.exit(await main());
