import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * design/27 §1: pptx-scene is pure TypeScript with no runtime dependency (no DOM, no zip, no fs), so it runs
 * on the hub's CPU pool and in Node alike. Code outside tests imports only its own modules, types from
 * `@ordo/domain`, and the few domain modules that are plain tables and functions shared with the renderer
 * (the Wingdings/Symbol bullet table, the script fallback families and the script scan, design/27 §1 and
 * §10; the stored path data tokeniser, §3.1), which import nothing at run time but each other. Since M6
 * also the renderer's geometry engine without its drawer (`@ordo/renderer/geom`: the preset table, the
 * compiler, the evaluator, arcs and the path builder; M6 repair: the drawing estimate, `cost.ts`), so a custGeom
 * means in the converter what it means when drawn; those import nothing at run time but each other.
 */
const PURE_DOMAIN = ['bullets.ts', 'defaults.ts', 'pathdata.ts', 'readable.ts'];
const PURE_GEOM = ['compile.ts', 'eval.ts', 'arc.ts', 'path.ts', 'ops.ts', 'presets.gen.ts', 'cost.ts'];
const IMPORT = /^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm;
const IMPURE = /\brequire\(|\bimport\(|\bprocess\.|\bdocument\.|\bwindow\.|\bfetch\(/;

describe('package purity', () => {
  const dir = import.meta.dirname;
  // Tests and their browser pages (`*.page.test-util.ts`, bundled for Chromium) are not the package.
  const sources = readdirSync(dir).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.page.test-util.ts'),
  );

  it.each(sources)('%s imports only its own modules, @ordo/domain types and pure domain tables', (file) => {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(IMPORT)) {
      const [, , typeOnly, spec] = m;
      if (spec!.startsWith('./')) continue;
      if (!typeOnly && PURE_DOMAIN.some((p) => spec === `@ordo/domain/${p}`)) continue;
      if (PURE_GEOM.some((p) => spec === `@ordo/renderer/geom/${p}`)) continue;
      expect(`${file}: ${spec} ${typeOnly ? 'type' : 'value'}`).toBe(`${file}: @ordo/domain type`);
    }
    expect(src).not.toMatch(IMPURE);
  });

  it.each(PURE_DOMAIN)('domain %s imports nothing at run time but the other pure modules', (file) => {
    const src = readFileSync(join(dir, '../../domain/src', file), 'utf8');
    for (const m of src.matchAll(IMPORT)) {
      const [, , typeOnly, spec] = m;
      if (typeOnly) continue;
      expect(`${file}: ${spec}`).toMatch(new RegExp(`^${file}: \\./(${PURE_DOMAIN.join('|')})$`));
    }
    expect(src).not.toMatch(IMPURE);
  });

  it.each(PURE_GEOM)(
    'renderer geom/%s imports nothing at run time but the other pure geometry modules',
    (file) => {
      const src = readFileSync(join(dir, '../../renderer/src/geom', file), 'utf8');
      for (const m of src.matchAll(IMPORT)) {
        const [, , typeOnly, spec] = m;
        if (typeOnly) continue;
        expect(`${file}: ${spec}`).toMatch(
          new RegExp(`^${file}: \\./(${PURE_GEOM.join('|').replaceAll('.', '\\.')})$`),
        );
      }
      expect(src).not.toMatch(IMPURE);
    },
  );
});
