#!/usr/bin/env node
/**
 * Bundle report and budget (design/24 "Bundle budget"): what each built app loads before it can draw, after
 * `pnpm build`.
 *
 *   node tools/bundle-report.mjs                    print every app's chunks
 *   node tools/bundle-report.mjs --json out.json    also write them as JSON (for a PR body or a CI artifact)
 *   node tools/bundle-report.mjs --check            fail when an app's initial JavaScript grew more than the
 *                                                   baseline's budget (2 %) over tools/bundle-baseline.json
 *   node tools/bundle-report.mjs --write            record the current sizes as the baseline (a PR whose
 *                                                   growth was accepted re-records it, and says why)
 *
 * Per app (apps/<name>/dist): `initial` is the entry script of index.html and every chunk it imports
 * statically (what the browser fetches and parses before the first paint), with its gzip size; `css` the
 * stylesheets index.html links; `workers` each worker entry (`*.worker-*.js`); `lazy` every other chunk,
 * named by what its source map says it holds (`importer`: @ordo/importers' PowerPoint parse; `table drawer`:
 * the renderer's table drawer, loaded per object kind) or by its file name. Only file sizes are read: no
 * build, no network. Plain Node, no dependencies.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(root, 'tools/bundle-baseline.json');
const APPS = ['operator', 'output', 'stage'];

/** What a lazy chunk holds, by a source its map lists. */
const LABELS = [
  ['packages/importers/src/pptx-client.ts', 'importer'],
  ['packages/renderer/src/table/draw.ts', 'table drawer'],
];

const kb = (n) =>
  `${(n / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kB`;

/** The chunks a chunk imports statically (`import ... from "./x.js"` and `import "./x.js"` at its top). */
function staticImports(code) {
  const out = [];
  const re = /^\s*import\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']\.\/([^"']+\.js)["']\s*;?/;
  let rest = code;
  for (;;) {
    const m = re.exec(rest);
    if (!m) break;
    out.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return out;
}

function labelOf(dir, file) {
  const map = join(dir, `${file}.map`);
  if (existsSync(map)) {
    try {
      const sources = JSON.parse(readFileSync(map, 'utf8')).sources ?? [];
      for (const [src, label] of LABELS) if (sources.some((s) => String(s).endsWith(src))) return label;
    } catch {
      /* a map that does not parse: the file name */
    }
  }
  return file.replace(/-[\w-]{8}\.js$/, '');
}

function reportApp(name) {
  const dist = join(root, 'apps', name, 'dist');
  const html = join(dist, 'index.html');
  if (!existsSync(html)) return undefined;
  const page = readFileSync(html, 'utf8');
  const assets = join(dist, 'assets');
  const size = (f) => readFileSync(join(assets, f)).length;
  const gz = (f) => gzipSync(readFileSync(join(assets, f))).length;
  const entries = [...page.matchAll(/<script[^>]*type="module"[^>]*src="\.\/assets\/([^"]+)"/g)].map(
    (m) => m[1],
  );
  const preloads = [...page.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\.\/assets\/([^"]+)"/g)].map(
    (m) => m[1],
  );
  const css = [...page.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="\.\/assets\/([^"]+)"/g)].map(
    (m) => m[1],
  );
  const initial = new Set();
  const queue = [...entries, ...preloads];
  while (queue.length) {
    const f = queue.shift();
    if (initial.has(f) || !existsSync(join(assets, f))) continue;
    initial.add(f);
    queue.push(...staticImports(readFileSync(join(assets, f), 'utf8')));
  }
  const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
  const workers = {};
  const lazy = {};
  for (const f of js.sort()) {
    if (initial.has(f)) continue;
    if (/\.worker-[\w-]+\.js$/.test(f)) workers[f.replace(/-[\w-]{8}\.js$/, '')] = size(f);
    else {
      const label = labelOf(assets, f);
      lazy[label] = (lazy[label] ?? 0) + size(f);
    }
  }
  return {
    initial: [...initial].reduce((n, f) => n + size(f), 0),
    initialGzip: [...initial].reduce((n, f) => n + gz(f), 0),
    css: css.reduce((n, f) => n + size(f), 0),
    workers,
    lazy,
  };
}

const args = process.argv.slice(2);
const report = {};
for (const app of APPS) {
  const r = reportApp(app);
  if (r) report[app] = r;
}
if (!Object.keys(report).length) {
  console.error('bundle-report: no built app found (run pnpm build first)');
  process.exit(2);
}
for (const [app, r] of Object.entries(report)) {
  console.log(`${app}: initial ${kb(r.initial)} (gzip ${kb(r.initialGzip)}), css ${kb(r.css)}`);
  for (const [w, n] of Object.entries(r.workers)) console.log(`  worker ${w}: ${kb(n)}`);
  for (const [l, n] of Object.entries(r.lazy)) console.log(`  lazy ${l}: ${kb(n)}`);
}
const at = args.indexOf('--json');
if (at >= 0 && args[at + 1]) {
  mkdirSync(dirname(args[at + 1]), { recursive: true });
  writeFileSync(args[at + 1], `${JSON.stringify(report, null, 1)}\n`);
}

if (args.includes('--write')) {
  const apps = {};
  for (const [app, r] of Object.entries(report))
    apps[app] = { initial: r.initial, initialGzip: r.initialGzip, css: r.css };
  const old = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
  writeFileSync(BASELINE, `${JSON.stringify({ budget: old.budget ?? 0.02, apps }, null, 2)}\n`);
  console.log(`bundle-report: baseline written to ${BASELINE}`);
}

if (args.includes('--check')) {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const budget = typeof base.budget === 'number' ? base.budget : 0.02;
  let failed = false;
  for (const [app, b] of Object.entries(base.apps ?? {})) {
    const r = report[app];
    if (!r) {
      console.error(`bundle-report: ${app} is not built`);
      failed = true;
      continue;
    }
    const limit = Math.floor(b.initial * (1 + budget));
    const growth = ((r.initial - b.initial) / b.initial) * 100;
    const line = `${app}: initial ${kb(r.initial)} against the baseline's ${kb(b.initial)} (${growth >= 0 ? '+' : ''}${growth.toFixed(1)} %, budget +${(budget * 100).toFixed(0)} %)`;
    if (r.initial > limit) {
      console.error(`bundle-report: over budget: ${line}`);
      failed = true;
    } else console.log(`bundle-report: within budget: ${line}`);
  }
  if (failed) {
    console.error(
      'Load the new code when it is first needed (a lazy route, a drawer loaded per object kind), or, when the growth is accepted, re-record the baseline with --write and say why in the PR.',
    );
    process.exit(1);
  }
}
