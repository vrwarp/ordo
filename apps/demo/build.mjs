// Builds the GitHub Pages demo into <repo>/site (or ORDO_PAGES_OUT):
//   site/            the operator app (ORDO_DEMO=1)
//   site/output/     the output window
//   site/stage/      the stage window
//   site/hub-sw.js   the demo hub service worker (src/hub-sw.ts)
//   site/demo/       the sample service, made by the real hub (scripts/seed.ts; needs `pnpm build` first)
// Every path is relative, so the site works at a domain root and under /<repo>/ alike.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const out = resolve(process.env.ORDO_PAGES_OUT ?? join(repo, 'site'));

if (!existsSync(join(repo, 'apps/hub/dist/main.js'))) {
  console.error('apps/hub/dist is missing: run `pnpm build` first (the sample service is made by the hub).');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
const env = { ...process.env, ORDO_DEMO: '1' };
const viteBin = join(repo, 'node_modules/.bin/vite');
const app = (name, outDir, empty) =>
  execFileSync(viteBin, ['build', '--outDir', outDir, ...(empty ? ['--emptyOutDir'] : [])], {
    cwd: join(repo, 'apps', name),
    env,
    stdio: 'inherit',
  });

app('operator', out, true);
app('output', join(out, 'output'), true);
app('stage', join(out, 'stage'), true);

await build({
  root: here,
  configFile: false,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: out,
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: join(here, 'src/hub-sw.ts'),
      formats: ['iife'],
      name: 'ordoDemoHub',
      fileName: () => 'hub-sw.js',
    },
  },
});

execFileSync(join(repo, 'node_modules/.bin/tsx'), [join(here, 'scripts/seed.ts'), out], {
  cwd: repo,
  stdio: 'inherit',
});

// GitHub Pages: serve files as they are (no Jekyll), and send unknown paths to the operator.
writeFileSync(join(out, '.nojekyll'), '');
console.log(`demo site written to ${out}`);
