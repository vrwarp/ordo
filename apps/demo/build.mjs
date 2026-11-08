// Builds the GitHub Pages demo into <repo>/site (or ORDO_PAGES_OUT):
//   site/            the operator app (ORDO_DEMO=1)
//   site/output/     the output window
//   site/stage/      the stage window
//   site/hub-sw.js   the demo hub service worker (src/hub-sw.ts)
//   site/demo/       the sample service, made by the real hub (scripts/seed.ts; needs `pnpm build` first)
// Every path is relative, so the site works at a domain root and under /<repo>/ alike.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
// Each app's own vite (pnpm does not hoist binaries to the root on every machine). A package's `bin` is
// not in its `exports`, so it is read from the package.json, which is.
const binOf = (pkgDir, pkg, bin) => {
  const pkgJson = createRequire(join(pkgDir, 'package.json')).resolve(`${pkg}/package.json`);
  const b = JSON.parse(readFileSync(pkgJson, 'utf8')).bin;
  return join(dirname(pkgJson), typeof b === 'string' ? b : b[bin]);
};
const app = (name, outDir, empty) => {
  const dir = join(repo, 'apps', name);
  execFileSync(
    process.execPath,
    [binOf(dir, 'vite', 'vite'), 'build', '--outDir', outDir, ...(empty ? ['--emptyOutDir'] : [])],
    { cwd: dir, env, stdio: 'inherit' },
  );
};

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

execFileSync(
  process.execPath,
  [binOf(join(repo, 'apps/hub'), 'tsx', 'tsx'), join(here, 'scripts/seed.ts'), out],
  { cwd: repo, stdio: 'inherit' },
);

// GitHub Pages: serve files as they are (no Jekyll), and send unknown paths to the operator.
writeFileSync(join(out, '.nojekyll'), '');
console.log(`demo site written to ${out}`);
