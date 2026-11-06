import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * design/27 §1: pptx-scene is pure TypeScript with no runtime dependency (no DOM, no zip, no fs), so it runs
 * on the hub's CPU pool and in Node alike. Code outside tests imports only its own modules, and only types
 * from `@ordo/domain`.
 */
describe('package purity', () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it.each(sources)('%s imports only its own modules and @ordo/domain types', (file) => {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm)) {
      const [, , typeOnly, spec] = m;
      if (spec!.startsWith('./')) continue;
      expect(`${file}: ${spec} ${typeOnly ? 'type' : 'value'}`).toBe(`${file}: @ordo/domain type`);
    }
    expect(src).not.toMatch(/\brequire\(|\bimport\(|\bprocess\.|\bdocument\.|\bwindow\.|\bfetch\(/);
  });
});
