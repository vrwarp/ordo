/**
 * The operator's static import graph for the code-split tests (entry.test.ts, compactImports.test.ts): every
 * static import (`import ... from`, `import '...'`, `export ... from`; not `import type`, an all-type import
 * list or `import()`), followed through the repository's sources; packages are named, not followed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(APP, '../..');

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

/** Every module `entry` reaches statically, with the chain that first reached it. */
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

export function rel(file: string): string {
  return relative(REPO, file).replaceAll('\\', '/');
}
