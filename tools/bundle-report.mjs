#!/usr/bin/env node
/**
 * Bundle report and budget (design/24 "Bundle budget"): what each built app loads before it can draw, after
 * `pnpm build`.
 *
 *   node tools/bundle-report.mjs                    print every app's chunks
 *   node tools/bundle-report.mjs --json out.json    also write them as JSON (for a PR body or a CI artifact)
 *   node tools/bundle-report.mjs --check            fail when an app's initial JavaScript, or the operator's
 *                                                   regular total (what the venue PC loads before its Shell),
 *                                                   grew more than the baseline's budget (2 %) over
 *                                                   tools/bundle-baseline.json, or the operator's compact first
 *                                                   load is over its budget (300 KB gzip) or holds code a phone
 *                                                   must never load
 *   node tools/bundle-report.mjs --write            record the current sizes as the baseline (a PR whose
 *                                                   growth was accepted re-records it, and says why)
 *   --root <dir>                                    read <dir>/apps/<name>/dist and <dir>/tools/ (tests)
 *   --compact-start <module,...>                    the compact start modules instead of pageSets.ts's (tests)
 *
 * Per app (apps/<name>/dist): `initial` is the entry script of index.html and every chunk it imports
 * statically (what the browser fetches and parses before the first paint), with its gzip size; `css` the
 * stylesheets index.html links; `workers` each worker entry (`*.worker-*.js`); `lazy` every other chunk,
 * named by what its source map says it holds (`importer`: @ordo/importers' PowerPoint parse; `table drawer`,
 * `decor drawer`: the renderer's table and decoration drawers, loaded per object kind; `decor files`: the
 * decoration files' store, which the editor canvas loads the first time a slide names one; `editor`,
 * `live view`, `operate services`, `renderer`) or by its file name.
 *
 * The operator also gets `compact` (design/28 §3.1, §7), what a phone loads: `firstLoad` (the initial chunks,
 * the static closure of every chunk whose map lists a COMPACT_START module, the core worker and the CSS, raw and
 * gzip), `precache` (FILES_COMPACT of dist/sw.js: what a phone's service worker downloads), `chunks` (each
 * COMPACT_START chunk), `headroomGzip` (300,000 B minus the first load's gzip: what is left for the compact shell
 * and P1's views) and `violations` (a file of either set whose source map lists a COMPACT_FORBIDDEN source, or a
 * worker other than COMPACT_WORKERS; apps/operator/src/pageSets.ts). Only file sizes are read: no build, no
 * network. Plain Node 22 (it strips the types of pageSets.ts), no dependencies.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  COMPACT_START,
  COMPACT_WORKERS,
  forbiddenEntry,
  normalizeSource,
  workerName,
} from '../apps/operator/src/pageSets.ts';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(argOf('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const BASELINE = join(root, 'tools/bundle-baseline.json');
const APPS = ['operator', 'output', 'stage'];
/** The compact first load's budget (design/28 §7), when the baseline file names none. */
const COMPACT_BUDGET_GZIP = 300_000;
const compactStart = argOf('--compact-start')?.split(',').filter(Boolean) ?? COMPACT_START;

/** What a lazy chunk holds, by a source its map lists (the first that matches). */
const LABELS = [
  ['packages/importers/src/pptx-client.ts', 'importer'],
  ['packages/renderer/src/table/draw.ts', 'table drawer'],
  ['packages/renderer/src/decor/draw.ts', 'decor drawer'],
  ['packages/renderer/src/decor/files.ts', 'decor files'],
  ['src/views/editor/EditorView.tsx', 'editor'],
  ['src/views/live/LiveView.tsx', 'live view'],
  ['src/services/operateServices.ts', 'operate services'],
  ['packages/renderer/src/index.ts', 'renderer'],
];

const kb = (n) =>
  `${(n / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kB`;
const bytes = (n) => `${n.toLocaleString('en-US')} B`;

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

/** A built file's sources, from its map (none when it has no map or the map does not parse). */
function sourcesOf(dir, file) {
  const map = join(dir, `${file}.map`);
  if (!existsSync(map)) return [];
  try {
    return (JSON.parse(readFileSync(map, 'utf8')).sources ?? []).map((s) => normalizeSource(String(s)));
  } catch {
    return [];
  }
}

function labelOf(dir, file) {
  const sources = sourcesOf(dir, file);
  for (const [src, label] of LABELS) if (sources.some((s) => s.endsWith(src))) return label;
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
  const closure = (start) => {
    const seen = new Set();
    const queue = [...start];
    while (queue.length) {
      const f = queue.shift();
      if (seen.has(f) || !existsSync(join(assets, f))) continue;
      seen.add(f);
      queue.push(...staticImports(readFileSync(join(assets, f), 'utf8')));
    }
    return seen;
  };
  const initial = closure([...entries, ...preloads]);
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
  const r = {
    initial: [...initial].reduce((n, f) => n + size(f), 0),
    initialGzip: [...initial].reduce((n, f) => n + gz(f), 0),
    css: css.reduce((n, f) => n + size(f), 0),
    workers,
    lazy,
  };
  if (name !== 'operator') return r;

  // The regular total: every script but the workers (what the venue PC's full profile loads, preloaded).
  const pageJs = js.filter((f) => !workerName(f));
  r.regularTotal = {
    files: pageJs.length,
    raw: pageJs.reduce((n, f) => n + size(f), 0),
    gzip: pageJs.reduce((n, f) => n + gz(f), 0),
  };

  // The compact path (design/28 §7). A start module's chunk is the one whose map lists it; a barrel
  // (`<dir>/index.ts` that only re-exports, which leaves no code and so no source in the map) is found by the
  // files of its folder. A start module no chunk holds is a violation: the first load would be under-counted.
  const startOf = (s) =>
    compactStart.find(
      (m) => s === m || (/\/index\.tsx?$/.test(m) && s.startsWith(m.replace(/index\.tsx?$/, ''))),
    );
  const startChunks = js.filter((f) => !workerName(f) && sourcesOf(assets, f).some((s) => startOf(s)));
  const core = js.filter((f) => workerName(f) === 'core.worker');
  const first = new Set([...initial, ...closure(startChunks), ...closure(core), ...css]);
  const sum = (files, of) => [...files].reduce((n, f) => n + of(f), 0);
  const sw = join(dist, 'sw.js');
  let precacheFiles = [];
  if (existsSync(sw)) {
    const m = /const FILES_COMPACT = (\[[^\]]*\]);/.exec(readFileSync(sw, 'utf8'));
    if (m) precacheFiles = JSON.parse(m[1]);
  }
  const distSize = (f) => (existsSync(join(dist, f)) ? readFileSync(join(dist, f)).length : 0);
  const distGz = (f) => (existsSync(join(dist, f)) ? gzipSync(readFileSync(join(dist, f))).length : 0);
  const violations = [];
  const check = (f) => {
    const w = workerName(f);
    if (w) {
      if (!COMPACT_WORKERS.includes(w)) violations.push(`${f}: the worker ${w}`);
      return;
    }
    for (const s of sourcesOf(assets, f)) {
      const e = forbiddenEntry(s);
      if (e) violations.push(`${f}: ${e} (${s})`);
    }
  };
  for (const m of compactStart)
    if (!startChunks.some((f) => sourcesOf(assets, f).some((s) => startOf(s) === m)))
      violations.push(`${m}: the compact start module is in no chunk`);
  for (const f of first) check(f);
  for (const f of precacheFiles) if (f.startsWith('assets/') && !first.has(f.slice(7))) check(f.slice(7));
  const firstGzip = sum(first, gz);
  r.compact = {
    firstLoad: { files: [...first].sort(), raw: sum(first, size), gzip: firstGzip },
    precache: {
      files: [...precacheFiles].sort(),
      raw: sum(precacheFiles, distSize),
      gzip: sum(precacheFiles, distGz),
    },
    chunks: startChunks.map((f) => ({
      source: startOf(sourcesOf(assets, f).find((s) => startOf(s)) ?? ''),
      raw: size(f),
      gzip: gz(f),
    })),
    headroomGzip: COMPACT_BUDGET_GZIP - firstGzip,
    violations: [...new Set(violations)],
  };
  return r;
}

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
  if (r.regularTotal)
    console.log(
      `  regular total (every script but the workers): ${kb(r.regularTotal.raw)} (gzip ${kb(r.regularTotal.gzip)}) in ${r.regularTotal.files} files`,
    );
  if (r.compact) {
    const c = r.compact;
    console.log(
      `  compact first load: ${kb(c.firstLoad.raw)} (gzip ${kb(c.firstLoad.gzip)}) in ${c.firstLoad.files.length} files; headroom ${bytes(c.headroomGzip)} gzip under ${bytes(COMPACT_BUDGET_GZIP)}`,
    );
    for (const ch of c.chunks) console.log(`    start ${ch.source}: ${kb(ch.raw)} (gzip ${kb(ch.gzip)})`);
    console.log(
      `  compact precache: ${kb(c.precache.raw)} (gzip ${kb(c.precache.gzip)}) in ${c.precache.files.length} files`,
    );
    for (const v of c.violations) console.log(`  compact violation: ${v}`);
  }
}
const at = args.indexOf('--json');
if (at >= 0 && args[at + 1]) {
  mkdirSync(dirname(args[at + 1]), { recursive: true });
  writeFileSync(args[at + 1], `${JSON.stringify(report, null, 1)}\n`);
}

if (args.includes('--write')) {
  const apps = {};
  for (const [app, r] of Object.entries(report)) {
    apps[app] = { initial: r.initial, initialGzip: r.initialGzip, css: r.css };
    // The operator's regular total: since the code split the venue PC waits on its pages before the Shell
    // (App's gate), so it is budgeted as the entry was (review of P0).
    if (r.regularTotal) apps[app].regularTotal = r.regularTotal.raw;
    if (r.regularTotal) apps[app].regularTotalGzip = r.regularTotal.gzip;
  }
  const old = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
  // The budget and the compact budget are absolute: kept as they are.
  const next = {
    budget: old.budget ?? 0.02,
    compact: old.compact ?? { firstLoadGzip: COMPACT_BUDGET_GZIP },
    apps,
  };
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
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
    // The regular total, where the baseline records one (an older baseline has none: not checked).
    if (typeof b.regularTotal === 'number' && r.regularTotal) {
      const rlimit = Math.floor(b.regularTotal * (1 + budget));
      const rgrowth = ((r.regularTotal.raw - b.regularTotal) / b.regularTotal) * 100;
      const rline = `${app}: regular total ${kb(r.regularTotal.raw)} against the baseline's ${kb(b.regularTotal)} (${rgrowth >= 0 ? '+' : ''}${rgrowth.toFixed(1)} %, budget +${(budget * 100).toFixed(0)} %)`;
      if (r.regularTotal.raw > rlimit) {
        console.error(`bundle-report: over budget: ${rline}`);
        failed = true;
      } else console.log(`bundle-report: within budget: ${rline}`);
    }
  }
  const compact = report.operator?.compact;
  if (base.compact && compact) {
    const limit = Number(base.compact.firstLoadGzip) || COMPACT_BUDGET_GZIP;
    const line = `operator: compact first load ${bytes(compact.firstLoad.gzip)} gzip against ${bytes(limit)} (headroom ${bytes(limit - compact.firstLoad.gzip)})`;
    if (compact.firstLoad.gzip > limit) {
      console.error(`bundle-report: over budget: ${line}`);
      failed = true;
    } else console.log(`bundle-report: within budget: ${line}`);
    if (compact.violations.length) {
      for (const v of compact.violations)
        console.error(`bundle-report: compact violation (a phone must never load it): ${v}`);
      failed = true;
    } else console.log('bundle-report: no compact violation');
  }
  if (failed) {
    console.error(
      'Load the new code when it is first needed (a lazy route, a drawer loaded per object kind), or, when the growth is accepted, re-record the baseline with --write and say why in the PR. The compact path (apps/operator/src/pageSets.ts) must not import editor, live, settings, Setup or output code.',
    );
    process.exit(1);
  }
}
