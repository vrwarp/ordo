// Builds the GitHub Pages demo into <repo>/site (or ORDO_PAGES_OUT):
//   site/            the operator app (ORDO_DEMO=1)
//   site/output/     the output window
//   site/stage/      the stage window
//   site/hub-sw.js   the demo hub service worker (src/hub-sw.ts)
//   site/demo/       the sample service, made by the real hub (scripts/seed.ts; needs `pnpm build` first)
//   site/vm/         the VM hub: the real hub in a Linux machine and its snapshot (scripts/build-vm.ts), and the
//                    page code that runs it (vm/host.js, src/vm-host.ts)
// Every path is relative, so the site works at a domain root and under /<repo>/ alike.
//
// The VM hub needs Node 24 (unkernel's floor): this script uses its own Node when it is 24 or later, else the one
// ORDO_VM_NODE names. ORDO_VM=off leaves the VM hub out (the demo then runs its service-worker hub only).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const vmWanted = process.env.ORDO_VM !== 'off';
const seedData = join(mkdtempSync(join(tmpdir(), 'ordo-seed-')), 'data');
execFileSync(
  process.execPath,
  [binOf(join(repo, 'apps/hub'), 'tsx', 'tsx'), join(here, 'scripts/seed.ts'), out],
  {
    cwd: repo,
    stdio: 'inherit',
    env: vmWanted ? { ...process.env, ORDO_SEED_KEEP_DATA: seedData } : process.env,
  },
);

if (vmWanted) {
  const node24 =
    Number(process.versions.node.split('.')[0]) >= 24 ? process.execPath : process.env.ORDO_VM_NODE;
  if (!node24) {
    console.error(
      'The VM hub needs Node 24: run with Node 24, set ORDO_VM_NODE to a Node 24 binary, or ORDO_VM=off.',
    );
    process.exit(1);
  }
  execFileSync(node24, [join(here, 'scripts/build-vm.ts'), out, seedData], { cwd: repo, stdio: 'inherit' });
  rmSync(dirname(seedData), { recursive: true, force: true });
  // The page side: vm/host.js, loaded by the operator (packages/client demo.ts). The SDK stays a file of its own next
  // to it (vm/unkernel/web.mjs, copied by build-vm.ts): it loads its worker and the kernel relative to itself.
  await build({
    root: here,
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir: join(out, 'vm'),
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: true,
      lib: { entry: join(here, 'src/vm-host.ts'), formats: ['es'], fileName: () => 'host.js' },
      rollupOptions: {
        external: ['unkernel/web'],
        output: { paths: { 'unkernel/web': './unkernel/web.mjs' } },
      },
    },
  });
}

// GitHub Pages: serve files as they are (no Jekyll), and send unknown paths to the operator.
writeFileSync(join(out, '.nojekyll'), '');
console.log(`demo site written to ${out}`);
