import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * design/27 §1: pptx-scene is pure TypeScript with no runtime dependency (no DOM, no zip, no fs), so it runs
 * on the hub's CPU pool and in Node alike. Code outside tests imports only its own modules, types from
 * `@ordo/domain`, and the few domain modules that are plain tables and functions shared with the renderer
 * (the Wingdings/Symbol bullet table, the script fallback families and the script scan, design/27 §1 and
 * §10; the stored path data tokeniser, §3.1), which import nothing at run time but each other.
 */
const PURE_DOMAIN = ['bullets.ts', 'defaults.ts', 'pathdata.ts', 'readable.ts'];
const IMPORT = /^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm;
const IMPURE = /\brequire\(|\bimport\(|\bprocess\.|\bdocument\.|\bwindow\.|\bfetch\(/;

describe('package purity', () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it.each(sources)('%s imports only its own modules, @ordo/domain types and pure domain tables', (file) => {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(IMPORT)) {
      const [, , typeOnly, spec] = m;
      if (spec!.startsWith('./')) continue;
      if (!typeOnly && PURE_DOMAIN.some((p) => spec === `@ordo/domain/${p}`)) continue;
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
});
