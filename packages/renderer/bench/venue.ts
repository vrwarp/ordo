import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, hostname, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { budgetFor, bundle, defaultFonts, fmtStats, printSlides, runSlides } from './slides.ts';
import type { VenueReport as CompositorReport, Stats as CompositorStats } from './gpu-venue.page.ts';
import { lateContent, liveProblems } from './live.ts';
import type { Stats, VenuePageReport } from './venue.page.ts';

/**
 * Venue measurement (design/27 §13 budgets, §15 M7; procedure and results in design/14 "Measuring on venue
 * machines"): one command on a venue machine (the Windows 11 presentation PC with its iGPU, a PC with a
 * discrete GPU, a Mac) records
 * - the machine: OS, CPU, memory, Chrome, the display and its refresh;
 * - the GPU: the WebGPU adapter (vendor, architecture, whether it is a software fallback, timestamp
 *   queries), a full-frame upload at 1920x1080 and 3840x2160 (CPU ms of the call, ms until the GPU has done
 *   it) and five full-frame layers composed in one pass (GPU ms, timestamp queries), venue.page.ts;
 * - the WebGPU compositor as the render worker drives it (gpu-venue.page.ts, also `bench:gpu` on its own):
 *   uploads of a full-frame bitmap and of a lyric-band sprite at once and in strips (CPU and GPU ms per
 *   frame, frames per upload), five layers composed full-frame, as sprites and as sprites over an opaque
 *   background (the replace path), and a live run of the engine (missed frames, late flips, `uploadMs`);
 * - the asset worker's slide raster on this machine's CPU, per slide kind and size (slides.page.ts);
 * and checks them against the budgets: slide raster p95 10 ms at 1080p, 30 ms at 4K (12 ms for text over a
 * photo, the M7 exit), upload and GPU time per frame 4 ms at 4K.
 *
 *   pnpm --filter @ordo/renderer bench:venue [--channel chrome | --executable <path>] [--out <file>]
 *        [--iterations 60] [--runs 30] [--live 8] [--headless] [--swiftshader] [--font <ttf> --bold <ttf>]
 *
 * Chrome runs visible (the refresh rate, a real GPU and the live run need a shown window, which must stay in
 * front and focused) unless --headless, which skips the live run. --swiftshader
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
const cs = (s: CompositorStats) =>
  `p50 ${s.p50.toFixed(2)} p95 ${s.p95.toFixed(2)} max ${s.max.toFixed(2)} ms`;
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
  const compositorScript = await bundle('gpu-venue.page.ts');
  // Live runs need a shown window (a display paces rAF); --live runs them headless too, to check the script.
  const liveSeconds = Math.max(0, Number(arg('--live') ?? (headless ? 0 : 8)));
  const browser = await chromium.launch({ headless, args, channel, executablePath });
  let page: VenuePageReport;
  let compositor: CompositorReport | { error: string } | undefined;
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
    // 1b. The WebGPU compositor as the render worker drives it, on a tab of its own.
    if (page.gpu.available) {
      try {
        const tab2 = await browser.newPage({ viewport: null });
        tab2.on('pageerror', (e) => console.error('page error:', e.message));
        await tab2.route('https://venue.test/**', (route) =>
          route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
        );
        await tab2.goto('https://venue.test/');
        await tab2.bringToFront();
        await tab2.addScriptTag({ content: compositorScript });
        compositor = await tab2.evaluate(
          ([src, live]) =>
            (window as unknown as { __venue(s: string, n: number): Promise<CompositorReport> }).__venue(
              src as string,
              live as number,
            ),
          [compositorScript, liveSeconds] as const,
        );
      } catch (err) {
        compositor = { error: String((err as Error)?.message ?? err) };
      }
    }
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
    compositor,
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
  const comp = compositor && 'sizes' in compositor ? compositor : undefined;
  if (compositor && !comp) console.log(`  compositor: failed (${(compositor as { error: string }).error})`);
  for (const s of comp?.sizes ?? []) {
    console.log(`  compositor ${s.width}x${s.height}:`);
    for (const u of s.uploads)
      console.log(
        `    upload ${u.name}, ${u.budget}: ${u.frames.toFixed(1)} frame(s) each; per frame CPU ${cs(u.cpuMs)}; done (latency) ${cs(u.doneMs)}; empty submit ${cs(u.emptyMs)}`,
      );
    for (const c of s.compose) console.log(`    compose ${c.name}: GPU ${cs(c.gpuMs)} (${c.source})`);
    for (const l of s.live)
      console.log(
        `    live ${l.seconds} s, ${l.budget}${headless ? ' (headless: not paced by a display)' : ''}: presented ${l.presented}, missed ${l.missed}, late flips ${l.lateFlips}, ${lateContent(l)}, rAF interval ${cs(l.intervalMs)}, uploadMs ${l.uploadMs}`,
      );
  }
  printSlides(slides);

  // 3. Budgets (design/27 §13).
  const over: string[] = [];
  for (const row of slides.rows)
    if (row.raster.p95 > budgetFor(row))
      over.push(`${row.kind} at ${row.width}: raster p95 ${ms(row.raster.p95)} ms`);
  const k4 = g.sizes.find((s) => s.width === 3840);
  // The renderer's own path at 4K: a full-frame upload in its default strips, and the compositions.
  const c4 = comp?.sizes.find((s) => s.width === 3840);
  const strips = c4?.uploads.find((u) => u.name === 'full-frame bitmap' && u.budget === 'default strips');
  if (strips && strips.cpuMs.p95 > 4)
    over.push(`4K upload in strips ${ms(strips.cpuMs.p95)} ms CPU per frame (p95)`);
  // Done latency minus an empty submit's round trip bounds the copies' GPU time (fence and IPC excluded).
  const stripGpu = strips ? Math.max(0, strips.doneMs.p95 - strips.emptyMs.p50) : undefined;
  // The compositor's composition must be of the order of venue.page.ts's own five-layer pass: a figure ten
  // times smaller times a pass that draws nothing (the check gpu-venue.page.ts makes before timing).
  const five = c4?.compose.find((c) => c.name.startsWith('five'));
  if (five && k4?.composeGpuMs && five.gpuMs.p50 * 10 < k4.composeGpuMs.p50)
    over.push(
      `4K compose ${ms(five.gpuMs.p50)} ms is not of the order of the plain five-layer pass (${ms(k4.composeGpuMs.p50)} ms): check the measurement`,
    );
  if (!swiftshader) {
    if (stripGpu !== undefined && stripGpu > 4)
      over.push(`4K upload in strips ${ms(stripGpu)} ms GPU per frame (p95 done minus empty submit)`);
    for (const c of c4?.compose ?? [])
      if (c.gpuMs.p95 > 4) over.push(`4K compose, ${c.name}: ${ms(c.gpuMs.p95)} ms GPU (p95)`);
    if (!c4 && k4?.composeGpuMs && k4.composeGpuMs.p50 > 4)
      over.push(`4K compose ${ms(k4.composeGpuMs.p50)} ms GPU`);
  }
  // A live run on a shown window measures only when it ran paced and its late content flipped.
  if (!headless)
    for (const s of comp?.sizes ?? [])
      for (const l of s.live)
        over.push(...liveProblems(l, page.machine.frameMs, `live ${s.width}x${s.height}, ${l.budget}`));
  console.log(over.length ? `  over budget: ${over.join('; ')}` : '  every figure within its budget');

  // 4. One line for the table in design/14 "Measuring on venue machines".
  const r = (kind: string, w: number) =>
    slides.rows.find((x) => x.kind.startsWith(kind) && x.width === w)?.raster;
  const k1 = g.sizes.find((s) => s.width === 1920);
  const compose4 = (name: string) => c4?.compose.find((c) => c.name.startsWith(name))?.gpuMs.p95;
  const live4 = c4?.live.find((l) => l.budget === 'default strips');
  console.log(
    '\nRow for design/14 (machine | GPU | slide raster p50/p95 at 1080p, 4K: photo, lyric, table, scene | one full-frame copy, done p50 1080p / 4K | 4K upload in strips per frame p95, CPU / GPU | 4K compose GPU p95: 5 full-frame / sprites / replace | live 4K: missed, late flips):',
  );
  console.log(
    `| ${report.host}: ${report.cpu.model}, ${report.os} | ${g.adapter ? `${g.adapter.vendor} ${g.adapter.architecture} ${g.adapter.description}`.trim() : 'none'}${swiftshader ? ' (SwiftShader)' : ''} | ${['sermon', 'lyric', 'table', 'scene'].map((k) => `${p(r(k, 1920))}`).join(', ')}; ${['sermon', 'lyric', 'table', 'scene'].map((k) => `${p(r(k, 3840))}`).join(', ')} | ${ms(k1?.uploadDoneMs.p50)} / ${ms(k4?.uploadDoneMs.p50)} | ${ms(strips?.cpuMs.p95)} / ${ms(stripGpu)} | ${ms(compose4('five'))} / ${ms(compose4('four sprites over a full'))} / ${ms(compose4('four sprites over an opaque'))} | ${live4 ? `${live4.missed}, ${live4.lateFlips}` : '-'} |`,
  );

  const date = report.at.slice(0, 10);
  const out = arg('--out') ?? join('venue-results', `${report.host.replace(/[^\w.-]+/g, '_')}-${date}.json`);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nbench:venue: wrote ${out}`);
  return 0;
}

process.exit(await main());
