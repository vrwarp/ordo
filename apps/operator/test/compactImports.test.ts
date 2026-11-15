/**
 * The compact chunk's reach (design/28 §3.1 "Code split", §10; src/views/compact/): what its modules import
 * statically, followed through every static import (test/importGraph.ts), reaches nothing of the canvas editor
 * but LookPreviews (the previews the P0 bodies show, imported as it is), nor the live view, the settings pages,
 * Setup, the venue PC's playlist editor or the output, control-surface and program-view services. The bundle
 * report's compact violations check the same on the build.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP, reach } from './importGraph.ts';

const OP = 'apps/operator/src/';
const COMPACT = join(APP, 'src/views/compact');

const FORBIDDEN: { why: string; test: (m: string) => boolean }[] = [
  {
    why: 'the canvas editor (LookPreviews aside)',
    test: (m) => m.startsWith(`${OP}views/editor/`) && m !== `${OP}views/editor/LookPreviews.tsx`,
  },
  { why: 'the live view', test: (m) => m.startsWith(`${OP}views/live/`) },
  { why: 'the settings pages', test: (m) => m.startsWith(`${OP}views/settings/`) },
  { why: 'Setup', test: (m) => m.startsWith(`${OP}views/setup/`) },
  { why: "the venue PC's playlist editor", test: (m) => m.startsWith(`${OP}views/playlists/`) },
  {
    why: 'the output, control-surface and program-view services',
    test: (m) => ['surfaces', 'outputs', 'programView'].some((s) => m === `${OP}services/${s}.ts`),
  },
  { why: 'Konva', test: (m) => m === 'pkg:konva' || m === 'pkg:react-konva' },
];

function compactModules(): string[] {
  return readdirSync(COMPACT)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => join(COMPACT, f));
}

describe('the compact chunk', () => {
  it('reaches no editor (but LookPreviews), live, settings, Setup, playlist-editor or output code', () => {
    const bad: string[] = [];
    for (const file of compactModules())
      for (const [m, chain] of reach(file))
        for (const f of FORBIDDEN) if (f.test(m)) bad.push(`${f.why}: ${chain.join(' -> ')}`);
    expect([...new Set(bad)]).toEqual([]);
  });

  it('the walk follows real imports: it reaches LookPreviews, the library store and the catalog', () => {
    const r = reach(join(COMPACT, 'index.ts'));
    for (const m of [
      `${OP}views/compact/CompactFrame.tsx`,
      `${OP}views/compact/PreviewP0.tsx`,
      `${OP}views/editor/LookPreviews.tsx`,
      `${OP}state/library.ts`,
      `${OP}i18n/en.ts`,
    ])
      expect(r.has(m), m).toBe(true);
  });

  it('offers no write in P0: no Edit, New, Upload, Rename, Delete or Archive control', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of compactModules()) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
      expect(src, file).not.toMatch(/\bapi\(/);
      expect(src, file).not.toMatch(/name:\s*'edit'/);
    }
  });
});
