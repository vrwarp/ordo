/**
 * The bundle report's compact section (tools/bundle-report.mjs; design/24 "Bundle budget", design/28 §7) on fake
 * dist trees: the first load's sums, the start chunks and the headroom, a violation, the 300,000 B budget in
 * --check, and --write keeping the compact budget.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'bundle-report.mjs');
const roots: string[] = [];

type Files = Record<string, string | Buffer>;

/** A fake repository root with apps/operator/dist and tools/bundle-baseline.json. */
function fakeRoot(files: Files, baseline: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'bundle-report-'));
  roots.push(root);
  for (const [p, body] of Object.entries(files)) {
    const f = join(root, 'apps/operator/dist', p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body);
  }
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'tools/bundle-baseline.json'), JSON.stringify(baseline));
  return root;
}

const map = (...sources: string[]) => JSON.stringify({ version: 3, sources, mappings: '' });
const html =
  '<script type="module" crossorigin src="./assets/index-AAAAAAAA.js"></script><link rel="stylesheet" href="./assets/index-CCCCCCCC.css">';
const sw = (compact: string[]) => `const FILES = [];\nconst FILES_COMPACT = ${JSON.stringify(compact)};\n`;

function tree(entryBody: string | Buffer, extra: Files = {}): Files {
  return {
    'index.html': html,
    'sw.js': sw(['assets/index-AAAAAAAA.js', 'assets/PreviewsView-EEEEEEEE.js', 'index.html']),
    'assets/index-AAAAAAAA.js': entryBody,
    'assets/index-AAAAAAAA.js.map': map('../../src/main.tsx', '../../src/App.tsx'),
    'assets/shared-BBBBBBBB.js': 'export const s = 1;',
    'assets/shared-BBBBBBBB.js.map': map('../../src/lib/layout.ts'),
    'assets/index-CCCCCCCC.css': 'body{color:red}',
    'assets/core.worker-DDDDDDDD.js': 'self.onmessage = () => {};',
    'assets/core.worker-DDDDDDDD.js.map': map('../../src/workers/core.worker.ts'),
    'assets/PreviewsView-EEEEEEEE.js': 'export const p = 1;',
    'assets/PreviewsView-EEEEEEEE.js.map': map('../../src/views/editor/PreviewsView.tsx'),
    'assets/Compact-FFFFFFFF.js': 'import "./shared-BBBBBBBB.js";\nexport const c = 1;',
    'assets/Compact-FFFFFFFF.js.map': map('../../src/views/compact/index.ts'),
    'assets/EditorView-GGGGGGGG.js': 'export const e = 1;',
    'assets/EditorView-GGGGGGGG.js.map': map('../../src/views/editor/EditorView.tsx'),
    ...extra,
  };
}

const BASE = {
  budget: 0.02,
  compact: { firstLoadGzip: 300_000 },
  apps: { operator: { initial: 1_000_000, initialGzip: 1, css: 1 } },
};

function run(root: string, ...args: string[]) {
  const out = join(root, 'out.json');
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json', out, ...args], {
    encoding: 'utf8',
  });
  const json = JSON.parse(readFileSync(out, 'utf8'));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, report: json };
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('bundle report: the compact first load', () => {
  it('sums the initial chunks, the core worker and the CSS; lists the precache', () => {
    const entry = 'import "./shared-BBBBBBBB.js";\nconsole.log(1);';
    const root = fakeRoot(tree(entry), BASE);
    // No start module here (the default is the compact chunk, the next test's case).
    const { report, status } = run(root, '--check', '--compact-start', '');
    const c = report.operator.compact;
    expect(c.firstLoad.files).toEqual([
      'core.worker-DDDDDDDD.js',
      'index-AAAAAAAA.js',
      'index-CCCCCCCC.css',
      'shared-BBBBBBBB.js',
    ]);
    const dist = join(root, 'apps/operator/dist/assets');
    const gz = (f: string) => gzipSync(readFileSync(join(dist, f))).length;
    const raw = (f: string) => readFileSync(join(dist, f)).length;
    expect(c.firstLoad.gzip).toBe(c.firstLoad.files.reduce((n: number, f: string) => n + gz(f), 0));
    expect(c.firstLoad.raw).toBe(c.firstLoad.files.reduce((n: number, f: string) => n + raw(f), 0));
    expect(c.headroomGzip).toBe(300_000 - c.firstLoad.gzip);
    expect(c.chunks).toEqual([]);
    expect(c.precache.files).toEqual([
      'assets/PreviewsView-EEEEEEEE.js',
      'assets/index-AAAAAAAA.js',
      'index.html',
    ]);
    expect(c.violations).toEqual([]);
    expect(status).toBe(0);
  });

  it('a COMPACT_START module joins the first load with its imports, and is listed with its size', () => {
    const root = fakeRoot(tree('console.log(1);'), BASE);
    const { report } = run(root, '--compact-start', 'src/views/compact/index.ts');
    const c = report.operator.compact;
    expect(c.firstLoad.files).toContain('Compact-FFFFFFFF.js');
    expect(c.firstLoad.files).toContain('shared-BBBBBBBB.js');
    expect(c.chunks).toEqual([
      { source: 'src/views/compact/index.ts', raw: expect.any(Number), gzip: expect.any(Number) },
    ]);
  });

  it('a barrel start module (index.ts that only re-exports) is found by its folder’s files', () => {
    const files = tree('console.log(1);', {
      'assets/Compact-FFFFFFFF.js.map': map('../../src/views/compact/Frame.tsx', '../../src/i18n/x.ts'),
    });
    const { report } = run(fakeRoot(files, BASE), '--compact-start', 'src/views/compact/index.ts');
    const c = report.operator.compact;
    expect(c.firstLoad.files).toContain('Compact-FFFFFFFF.js');
    expect(c.chunks).toEqual([
      { source: 'src/views/compact/index.ts', raw: expect.any(Number), gzip: expect.any(Number) },
    ]);
    expect(c.violations).toEqual([]);
  });

  it('a start module that no chunk holds is a violation (the first load would be under-counted)', () => {
    const { report, status } = run(
      fakeRoot(tree('console.log(1);'), BASE),
      '--check',
      '--compact-start',
      'src/views/gone/index.ts',
    );
    expect(report.operator.compact.violations).toEqual([
      'src/views/gone/index.ts: the compact start module is in no chunk',
    ]);
    expect(status).toBe(1);
  });

  it('a compact file whose map lists the editor is a violation, and --check fails on it', () => {
    const root = fakeRoot(tree('import "./EditorView-GGGGGGGG.js";'), BASE);
    const { report, status, stderr } = run(root, '--check');
    expect(report.operator.compact.violations).toEqual([
      'EditorView-GGGGGGGG.js: views/editor/EditorView.tsx (src/views/editor/EditorView.tsx)',
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain('compact violation');
  });

  it('a precached worker other than core and thumb is a violation', () => {
    const files = tree('console.log(1);', {
      'sw.js': sw(['assets/import.worker-HHHHHHHH.js', 'index.html']),
      'assets/import.worker-HHHHHHHH.js': 'x',
    });
    const { report } = run(fakeRoot(files, BASE));
    expect(report.operator.compact.violations).toEqual([
      'import.worker-HHHHHHHH.js: the worker import.worker',
    ]);
  });

  it('--check fails over 300,000 B gzip and passes under it', () => {
    const big = fakeRoot(tree(randomBytes(310_000)), BASE);
    const over = run(big, '--check');
    expect(over.report.operator.compact.firstLoad.gzip).toBeGreaterThan(300_000);
    expect(over.status).toBe(1);
    expect(over.stderr).toContain('compact first load');
    const small = fakeRoot(tree(randomBytes(100_000)), BASE);
    expect(run(small, '--check').status).toBe(0);
  });

  it('--write records the sizes and keeps the compact budget', () => {
    const root = fakeRoot(tree('console.log(1);'), { ...BASE, compact: { firstLoadGzip: 250_000 } });
    execFileSync(process.execPath, [SCRIPT, '--root', root, '--write'], { encoding: 'utf8' });
    const b = JSON.parse(readFileSync(join(root, 'tools/bundle-baseline.json'), 'utf8'));
    expect(b.compact).toEqual({ firstLoadGzip: 250_000 });
    expect(b.budget).toBe(0.02);
    expect(b.apps.operator.initial).toBe(
      readFileSync(join(root, 'apps/operator/dist/assets/index-AAAAAAAA.js')).length,
    );
  });
});
