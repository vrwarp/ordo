import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { BakeBenchCase } from './bake.page.ts';

/**
 * Bake bench (design 29 section 1.4, bake-render M1 to M3): one bake of a synthetic slide at 3840 (and 1920) on a
 * software canvas in headless Chromium (bake.page.ts), each run on a fresh page, timed by phase (draw, compose, alpha
 * scan, 3840 PNG, 1920 copy, 1920 PNG, 640 WebP, round trip, total), with the bytes of the three pictures, and the
 * browser's memory sampled from this side: the sum of VmRSS over the browser's process tree every 50 ms, the peak
 * above the idle sum, and the renderer process's VmHWM.
 *
 *   pnpm --filter @ordo/renderer bench:bake [--runs 5] [--cases collage300,crowded340] [--scales 2,1]
 *       [--font /path/to/a.ttf] [--deadline 60000]
 *
 * Run it inside the bench lock: its numbers are milliseconds. This machine draws on the CPU, 1.5 to 2 times slower
 * than the runs of PR #29 on some 3840 rows: a venue PC confirms every 4K figure. Text uses the font file given
 * (default: the system's Liberation Sans, read and registered under the library family 'Inter'; nothing is installed).
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const runs = Math.max(1, Number(arg('--runs') ?? 5));
const cases = (
  arg('--cases') ??
  'collage300,collage300x,crowded340,objects1000,objects1357,objects20000,text,shadows20,photo-bg,photo-full'
).split(',');
const scales = (arg('--scales') ?? '2').split(',').map(Number);
const deadline = arg('--deadline') ? Number(arg('--deadline')) : undefined;
const fontPath = arg('--font') ?? '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf';

async function loadEsbuild(): Promise<typeof import('esbuild')> {
  try {
    return await import('esbuild');
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    return (await import(
      createRequire(fromOutput.resolve('vite')).resolve('esbuild')
    )) as typeof import('esbuild');
  }
}

/** Every descendant of `pid` (the browser), by reading /proc. */
function tree(pid: number): number[] {
  const kids = new Map<number, number[]>();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const list = kids.get(ppid) ?? [];
      list.push(Number(d));
      kids.set(ppid, list);
    } catch {
      /* gone */
    }
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? []) {
      out.push(k);
      walk(k);
    }
  };
  walk(pid);
  return out;
}

function status(pid: number, key: string): number {
  try {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

const rssOf = (pids: number[]) => pids.reduce((s, p) => s + status(p, 'VmRSS'), 0);
const f = (n: number) => (n < 10 ? n.toFixed(2) : n.toFixed(0));
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

async function main(): Promise<number> {
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'bake.page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  const script = built.outputFiles[0]!.text;
  const font = Array.from(readFileSync(fontPath));
  const browser = await chromium
    .launch({ headless: true })
    .catch(() => chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' }));
  const rows: (BakeBenchCase & { peakMb: number; hwmMb: number })[] = [];
  try {
    console.log(
      `bench:bake: ${await browser.version()}, ${runs} fresh run(s) per case, load ${process.env.BENCH_LOAD ?? readFileSync('/proc/loadavg', 'utf8').split(' ')[0]}, software 4K canvas on this CPU`,
    );
    for (const name of cases)
      for (const scale of scales)
        for (let run = 1; run <= runs; run++) {
          const page = await browser.newPage();
          page.on('pageerror', (e) => console.error('page error:', e.message));
          try {
            await page.setContent('<!doctype html><html><body></body></html>');
            await page.addScriptTag({ content: script });
            const roots = tree(process.pid).filter(
              (p) =>
                /chrom/i.test(readFileSync(`/proc/${p}/cmdline`, 'utf8')) &&
                !readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('--type='),
            );
            const browserPid = roots[0] ?? 0;
            const idle = rssOf([browserPid, ...tree(browserPid)]);
            let peak = idle;
            const timer = setInterval(() => {
              peak = Math.max(peak, rssOf([browserPid, ...tree(browserPid)]));
            }, 50);
            for (const p of tree(browserPid))
              if (/--type=renderer/.test(readFileSync(`/proc/${p}/cmdline`, 'utf8'))) {
                try {
                  writeFileSync(`/proc/${p}/clear_refs`, '5');
                } catch {
                  /* not allowed */
                }
              }
            let r: BakeBenchCase;
            try {
              r = await page.evaluate(
                ([n, s, fb, d]) =>
                  (
                    window as unknown as {
                      __bakeBench(n: string, s: number, f: ArrayBuffer, d?: number): Promise<BakeBenchCase>;
                    }
                  ).__bakeBench(
                    n as string,
                    s as number,
                    new Uint8Array(fb as number[]).buffer,
                    d as number | undefined,
                  ),
                [name, scale, font, deadline] as const,
              );
            } finally {
              clearInterval(timer);
            }
            const hwm = Math.max(0, ...tree(browserPid).map((p) => status(p, 'VmHWM')));
            const row = { ...r, peakMb: Math.round((peak - idle) / 1024), hwmMb: Math.round(hwm / 1024) };
            rows.push(row);
            console.log(
              `  ${name} @${scale * 1920} run ${run}: ${r.objects} objects, ${r.ok ? 'made' : `NOT MADE (${r.reason}: ${r.detail})`}, total ${f(r.ms.total ?? 0)} ms (draw ${f(r.ms.draw ?? 0)}, compose ${f(r.ms.compose ?? 0)}, alpha ${f(r.ms.alpha ?? 0)}, png3840 ${f(r.ms.png3840 ?? 0)}, copy1920 ${f(r.ms.copy1920 ?? 0)}, png1920 ${f(r.ms.png1920 ?? 0)}, webp640 ${f(r.ms.webp640 ?? 0)}, verify ${f(r.ms.verify ?? 0)}), turns longest ${f(r.longestTurn)} ms, bytes ${r.bytes.png3840 ?? '-'} / ${r.bytes.png1920 ?? '-'} / ${r.bytes.webp640 ?? '-'}${r.bytes.rgba3840 ? ` (RGBA ${r.bytes.rgba3840})` : ''}${r.opaque === undefined ? '' : r.opaque ? ' opaque' : ' alpha'}, decodes ${r.decodes}, browser memory peak +${row.peakMb} MB, renderer VmHWM ${row.hwmMb} MB`,
            );
          } finally {
            await page.close();
          }
        }
  } finally {
    await browser.close();
  }
  console.log('\nmedian of the runs:');
  for (const name of cases)
    for (const scale of scales) {
      const rs = rows.filter((r) => r.name === name && r.scale === scale);
      if (!rs.length) continue;
      const m = (g: (r: (typeof rows)[number]) => number) => f(median(rs.map(g)));
      console.log(
        `  ${name} @${scale * 1920}: made ${rs.filter((r) => r.ok).length}/${rs.length}, total ${m((r) => r.ms.total ?? 0)} ms, draw ${m((r) => r.ms.draw ?? 0)}, png3840 ${m((r) => r.ms.png3840 ?? 0)}, copy1920 ${m((r) => r.ms.copy1920 ?? 0)}, webp640 ${m((r) => r.ms.webp640 ?? 0)}, alpha ${m((r) => r.ms.alpha ?? 0)}, verify ${m((r) => r.ms.verify ?? 0)}, bytes png3840 ${m((r) => r.bytes.png3840 ?? 0)}, memory +${m((r) => r.peakMb)} MB (VmHWM ${m((r) => r.hwmMb)})`,
      );
    }
  console.log(`\n${JSON.stringify(rows)}`);
  return 0;
}

process.exit(await main());
