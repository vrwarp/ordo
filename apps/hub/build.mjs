// Bundle the hub into dist/main.js (Node 22 ESM). Native modules stay external and are installed
// next to the bundle in the Docker image.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
// Start from an empty dist: an entry that was removed (the old import.worker.js) must not linger next to
// the bundle, where a stale file could be loaded or shipped.
rmSync(join(here, 'dist'), { recursive: true, force: true });
mkdirSync(join(here, 'dist'), { recursive: true });

// Two entries: the hub (supervisor and both of its child processes run main.js), and the CPU pool's
// worker thread (pool.ts resolves `./cpu.worker.js` next to itself).
await build({
  entryPoints: [join(here, 'src/main.ts'), join(here, 'src/cpu.worker.ts')],
  outdir: join(here, 'dist'),
  entryNames: '[name]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  external: ['better-sqlite3', '@node-rs/argon2'],
  banner: {
    js: [
      "import { createRequire as __ordoCreateRequire } from 'node:module';",
      'const require = __ordoCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

// Keep the Google Fonts list next to the bundle for reference (it is also inlined).
cpSync(join(here, 'src/fonts/google-fonts.json'), join(here, 'dist/google-fonts.json'));
