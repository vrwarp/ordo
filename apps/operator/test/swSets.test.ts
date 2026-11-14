/**
 * The precache sets (src/sw/sets.ts; design/28 §3.1): `all` is today's list; `compact` is the entry's static
 * closure, the compact lazy modules' closures, the compact workers with the files they load, and every file that
 * is not script, on a fake Rollup bundle.
 */
import { describe, expect, it } from 'vitest';
import { allFiles, compactFiles, type SetBundle } from '../src/sw/sets.ts';
import { COMPACT_LAZY, COMPACT_START } from '../src/pageSets.ts';

const ROOT = '/repo/apps/operator';
const chunk = (fileName: string, imports: string[], o: { entry?: boolean; facade?: string } = {}) => ({
  type: 'chunk' as const,
  fileName,
  isEntry: !!o.entry,
  isDynamicEntry: !o.entry && !!o.facade,
  facadeModuleId: o.facade ? `${ROOT}/${o.facade}` : null,
  imports,
});
const asset = (fileName: string, source = '') => ({ type: 'asset' as const, fileName, source });

const bundle: SetBundle = {
  'index.html': asset('index.html'),
  'assets/index.css': asset('assets/index.css'),
  'assets/index.js': chunk('assets/index.js', ['assets/shared.js'], { entry: true, facade: 'index.html' }),
  'assets/index.js.map': asset('assets/index.js.map'),
  'assets/shared.js': chunk('assets/shared.js', []),
  'assets/PlaylistsView.js': chunk('assets/PlaylistsView.js', ['assets/arr.js', 'assets/shared.js'], {
    facade: 'src/views/playlists/PlaylistsView.tsx',
  }),
  'assets/arr.js': chunk('assets/arr.js', []),
  'assets/PreviewsView.js': chunk('assets/PreviewsView.js', ['assets/look.js'], {
    facade: 'src/views/editor/PreviewsView.tsx',
  }),
  'assets/look.js': chunk('assets/look.js', []),
  'assets/EditorView.js': chunk('assets/EditorView.js', ['assets/konva.js', 'assets/look.js'], {
    facade: 'src/views/editor/EditorView.tsx',
  }),
  'assets/konva.js': chunk('assets/konva.js', []),
  'assets/LiveView.js': chunk('assets/LiveView.js', [], { facade: 'src/views/live/LiveView.tsx' }),
  'assets/core.worker-aaaa1111.js': asset('assets/core.worker-aaaa1111.js', 'self.onmessage=()=>{}'),
  'assets/thumb.worker-bbbb2222.js': asset(
    'assets/thumb.worker-bbbb2222.js',
    'const t=()=>import("./table-cccc3333.js");',
  ),
  'assets/table-cccc3333.js': asset('assets/table-cccc3333.js', ''),
  'assets/import.worker-dddd4444.js': asset('assets/import.worker-dddd4444.js', ''),
};

describe('precache sets', () => {
  it('all: every file but maps and the worker itself, as before', () => {
    expect(allFiles(bundle)).toEqual(
      Object.keys(bundle)
        .filter((f) => !f.endsWith('.map'))
        .sort(),
    );
    expect(allFiles({ 'assets/a.js': chunk('assets/a.js', [], { entry: true }) })).toEqual([
      'assets/a.js',
      'index.html',
    ]);
  });

  it('compact: the entry, the compact lazy modules, their imports, the compact workers and the rest', () => {
    const lazy = ['src/views/playlists/PlaylistsView.tsx', 'src/views/editor/PreviewsView.tsx'];
    expect(compactFiles(bundle, { root: ROOT, start: [], lazy })).toEqual(
      [
        'index.html',
        'assets/index.css',
        'assets/index.js',
        'assets/shared.js',
        'assets/PlaylistsView.js',
        'assets/arr.js',
        'assets/PreviewsView.js',
        'assets/look.js',
        'assets/core.worker-aaaa1111.js',
        'assets/thumb.worker-bbbb2222.js',
        'assets/table-cccc3333.js',
      ].sort(),
    );
  });

  it('never the editor, its Konva chunk, the live view or the import worker', () => {
    const c = compactFiles(bundle, { root: ROOT });
    for (const f of [
      'assets/EditorView.js',
      'assets/konva.js',
      'assets/LiveView.js',
      'assets/import.worker-dddd4444.js',
    ])
      expect(c).not.toContain(f);
  });

  it('P0: the compact chunk starts with the shell and nothing is lazy (its tab bodies are in that chunk)', () => {
    expect(COMPACT_START).toEqual(['src/views/compact/index.ts']);
    expect(COMPACT_LAZY).toEqual([]);
    // The defaults: the playlists and previews pages are no longer on the compact path.
    const c = compactFiles(bundle, { root: ROOT });
    expect(c).not.toContain('assets/PlaylistsView.js');
    expect(c).not.toContain('assets/PreviewsView.js');
  });

  it('a module the shell starts (COMPACT_START) joins with its imports', () => {
    const c = compactFiles(bundle, { root: ROOT, start: ['src/views/live/LiveView.tsx'], lazy: [] });
    expect(c).toContain('assets/LiveView.js');
    expect(c).not.toContain('assets/PlaylistsView.js');
  });
});
