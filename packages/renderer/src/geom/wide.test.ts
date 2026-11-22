import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The wide draw (`drawShapeWide`, geom/wide.ts; the owner's Q53 and Q56.d): it draws a geometry the CALLER built
 * with no 8-path, 4,096-point clamp, so it is for the hub's picture page and nothing live. These pins keep it
 * there (RM-W1) and keep it from picking up the stored-geometry code that would cut a wide outline again (RM-W2's
 * static half; the recorded mutation is in the track's notes).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');

/** Every .ts/.tsx source file under a folder (not node_modules, dist or test output). */
function sources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test-results') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(path);
  }
  return out;
}

/** The module specifiers a source file imports, re-exports or dynamically imports. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

const ALLOWED_IN_GEOM = new Set(['wide.test.ts', 'wide.browser.test.ts', 'wide.page.test-util.ts']);

describe('drawShapeWide has no caller on a live path (RM-W1)', () => {
  it('geom/wide.ts exists and exports drawShapeWide, and shape.ts exports the two hooks it uses', () => {
    const wide = join(here, 'wide.ts');
    expect(existsSync(wide), 'packages/renderer/src/geom/wide.ts').toBe(true);
    expect(readFileSync(wide, 'utf8')).toMatch(/export function drawShapeWide\(/);
    const shape = readFileSync(join(here, '../shape.ts'), 'utf8');
    expect(shape).toMatch(/export function planFrom\(/);
    expect(shape).toMatch(/export function styleLines\(/);
  });

  it('no module under the renderer, the output, the operator, the stage or the live state imports it (but its own tests)', () => {
    const roots = [
      'packages/renderer/src',
      'packages/live-state',
      'apps/output/src',
      'apps/operator/src',
      'apps/stage/src',
    ];
    const callers: string[] = [];
    for (const root of roots) {
      for (const file of sources(join(repo, root))) {
        const rel = relative(repo, file);
        const inGeom = dirname(file) === here;
        if (inGeom && ALLOWED_IN_GEOM.has(file.slice(here.length + 1))) continue;
        for (const spec of specifiers(readFileSync(file, 'utf8'))) {
          const toWide = /(^|\/)geom\/wide(\.ts)?$/.test(spec) || (inGeom && /^\.\/wide(\.ts)?$/.test(spec));
          if (toWide) callers.push(`${rel} imports ${spec}`);
        }
      }
    }
    expect(callers).toEqual([]);
  });

  it('the renderer barrel and the geometry barrel do not export it', () => {
    for (const file of ['../index.ts', 'index.ts']) {
      const text = readFileSync(join(here, file), 'utf8');
      expect(text, file).not.toMatch(/\bwide\b|drawShapeWide/);
    }
  });
});

describe('the wide draw never takes the stored-geometry path (RM-W2, static half)', () => {
  it('geom/wide.ts imports neither the stored-geometry reader nor the geometry cost refusal', () => {
    // Code only: the header comment names these on purpose.
    const text = readFileSync(join(here, 'wide.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const imported = specifiers(text);
    for (const forbidden of ['stored.ts', 'built.ts', 'cost.ts'])
      expect(
        imported.filter((s) => s.endsWith(forbidden)),
        forbidden,
      ).toEqual([]);
    expect(text).not.toMatch(/\b(?:clampGeom|pathsGeometry|storedGeometry|geomAwaited)\b/);
  });
});
