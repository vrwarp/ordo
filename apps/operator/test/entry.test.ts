/**
 * The operator's entry (design/28 §3.1 "Code split", §7): what src/main.tsx imports statically, followed
 * through every static import (`import ... from`, `import '...'`, `export ... from`; not `import type`, an
 * all-type import list or `import()`), never reaches the canvas editor or what only it reaches, Konva, the live
 * view, the settings and Setup pages, the output and control-surface services, @ordo/surfaces, the renderer's
 * barrel or its preset geometry. The bundle report checks the same on the build (tools/bundle-report.mjs
 * compact violations); this test fails before a build, naming the import chain.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(APP, '../..');

/** Static import specifiers of a module's source. */
export function staticSpecifiers(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  const re =
    /^\s*(import|export)\s+(type\s+)?([^;'"]*?)\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  for (const m of code.matchAll(re)) {
    if (m[5]) {
      out.push(m[5]);
      continue;
    }
    if (m[2]) continue; // import type / export type
    const clause = m[3] ?? '';
    if (m[1] === 'export' && !/^\s*(\*|\{)/.test(clause)) continue;
    const braces = /\{([^}]*)\}/.exec(clause);
    const rest = clause.replace(/\{[^}]*\}/, '').replace(/[\s,]/g, '');
    if (braces && !rest) {
      const names = braces[1]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    }
    out.push(m[4]!);
  }
  return out;
}

/** A specifier resolved from a file: a source file of the repository, or a package name (not followed). */
function resolveSpecifier(from: string, spec: string): { file?: string; pkg?: string } {
  if (spec.startsWith('.')) return { file: resolve(dirname(from), spec) };
  const ws = /^@ordo\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (ws) return { file: join(REPO, 'packages', ws[1]!, 'src', ws[2] ?? 'index.ts') };
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
  return { pkg: name };
}

/** Every module main.tsx reaches statically, with the chain that first reached it. */
export function reach(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: [string, string[]][] = [[entry, [rel(entry)]]];
  while (queue.length) {
    const [file, chain] = queue.shift()!;
    const key = rel(file);
    if (seen.has(key)) continue;
    seen.set(key, chain);
    if (!/\.(tsx?|mts|js|mjs)$/.test(file) || !existsSync(file)) continue;
    for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
      const r = resolveSpecifier(file, spec);
      if (r.pkg) {
        const k = `pkg:${r.pkg}`;
        if (!seen.has(k)) seen.set(k, [...chain, k]);
      } else if (r.file) queue.push([r.file, [...chain, rel(r.file)]]);
    }
  }
  return seen;
}

function rel(file: string): string {
  return relative(REPO, file).replaceAll('\\', '/');
}

const OP = 'apps/operator/src/';
/** What the entry must never reach (design/28 §3.1, §7). */
const FORBIDDEN: { why: string; test: (m: string) => boolean }[] = [
  { why: 'the canvas editor', test: (m) => m === `${OP}views/editor/EditorView.tsx` },
  {
    why: 'what only the editor reaches',
    test: (m) =>
      [
        'views/editor/SlideCanvas.tsx',
        'views/editor/FloatingContextBar.tsx',
        'views/editor/UnifiedTypography.tsx',
        'views/editor/ObjectPanel.tsx',
        'components/ColorPicker.tsx',
      ].some((p) => m === OP + p),
  },
  { why: 'Konva', test: (m) => m === 'pkg:konva' || m === 'pkg:react-konva' },
  { why: 'the live view', test: (m) => m.startsWith(`${OP}views/live/`) },
  { why: 'the settings pages', test: (m) => m.startsWith(`${OP}views/settings/`) },
  { why: 'Setup', test: (m) => m.startsWith(`${OP}views/setup/`) },
  {
    why: 'the operate services',
    test: (m) =>
      ['outputs', 'surfaces', 'programView', 'cacheCheck', 'reacquire'].some(
        (s) => m === `${OP}services/${s}.ts`,
      ),
  },
  { why: '@ordo/surfaces', test: (m) => m.startsWith('packages/surfaces/') },
  { why: "the renderer's barrel", test: (m) => m === 'packages/renderer/src/index.ts' },
  { why: "the renderer's preset geometry", test: (m) => m.startsWith('packages/renderer/src/geom/') },
];

/** The entry's violations, each with its import chain. */
export function violations(entry = join(APP, 'src/main.tsx')): string[] {
  const out: string[] = [];
  for (const [m, chain] of reach(entry))
    for (const f of FORBIDDEN) if (f.test(m)) out.push(`${f.why}: ${chain.join(' -> ')}`);
  return out;
}

describe('the operator entry', () => {
  it('reaches no editor, live, settings, Setup, output or control-surface code statically', () => {
    expect(violations()).toEqual([]);
  });

  it('still reaches what the first paint needs (the walk follows real imports)', () => {
    const r = reach(join(APP, 'src/main.tsx'));
    for (const m of [
      `${OP}App.tsx`,
      `${OP}pages.ts`,
      `${OP}views/library/LibraryView.tsx`,
      `${OP}views/auth/LoginView.tsx`,
      `${OP}lib/layout.ts`,
      'packages/renderer/src/text/fonts.ts',
      'pkg:react',
    ])
      expect(r.has(m), m).toBe(true);
  });

  it('sees through the import forms it must (a probe of the parser)', () => {
    expect(
      staticSpecifiers(`import a from './a.ts';
import { type B } from './b.ts';
import type { C } from './c.ts';
import { type D, e } from './d.ts';
export { f } from './f.ts';
export * from './g.ts';
export type { H } from './h.ts';
import './i.css';
const j = () => import('./j.ts');
// import k from './k.ts';
import {
  l,
  m,
} from './l.ts';`),
    ).toEqual(['./a.ts', './d.ts', './f.ts', './g.ts', './i.css', './l.ts']);
  });

  it('uses no React.lazy in App.tsx or pages.ts (the registry renders loaded pages synchronously)', () => {
    for (const f of ['src/App.tsx', 'src/pages.ts']) {
      const code = readFileSync(join(APP, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/\blazy\(/);
    }
  });
});
