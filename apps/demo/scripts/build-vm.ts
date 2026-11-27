/**
 * Builds the demo's in-browser hub (docs/design/26-pages-demo.md, "The VM hub"): the real ordo hub inside a
 * Linux machine (unkernel: Linux compiled to WebAssembly) and a snapshot of that machine taken once the hub
 * answered, so a visitor's browser resumes a running hub instead of booting one.
 *
 *   node apps/demo/scripts/build-vm.ts <site-out> <seed-data-dir>
 *
 * Needs Node 24 (unkernel's floor; Node 24 runs this TypeScript file as it is), `pnpm build` done (apps/hub/dist and
 * the apps' dist), npm, tar and network access to Alpine's package mirror, the unkernel release (the Alpine image)
 * and GitHub releases (better-sqlite3's prebuilt binary); for the minimal ffmpeg (scripts/build-ffmpeg.sh, cached) also
 * bash, curl, git, make, binutils and pkg-config, and ziglang.org, ffmpeg.org, code.videolan.org,
 * chromium.googlesource.com, downloads.xiph.org and zlib.net. `<seed-data-dir>` is the hub data folder scripts/seed.ts
 * kept (ORDO_SEED_KEEP_DATA): the sample service as the real hub wrote it.
 *
 * Two machines run here:
 * 1. The system image. Alpine boots with a scratch data disk; Node, poppler and fonts are installed (GUEST_PACKAGES), and
 *    a minimal ffmpeg and ffprobe built here (scripts/build-ffmpeg.sh); the hub and the apps go to
 *    /app; the root (Alpine's image plus those changes, without unkernel's own layer) is packed into an erofs image
 *    labelled kwroot, with unkernel's distro header ("ordo"). Visitors read it lazily by range requests.
 * 2. The snapshot. That image boots with a fresh data disk; the seeded data folder goes to /data/ordo; the hub starts
 *    (supervisor, library and live processes, exactly as in the container), is signed in to and warmed, and the
 *    machine is saved and stopped. The data disk is written out as a kwsparse image (its non-zero blocks): visitors
 *    load it into IndexedDB, and resume the snapshot on it.
 *
 * Output, in `<site-out>/vm/`: `manifest.json` (what the page loads, with sizes and the build id), the system image,
 * the data disk and the snapshot (both gzip), and `unkernel/` (the SDK's browser files and the kernel).
 *
 * ORDO_VM_EXTRA_CA=<pem file> adds a CA to the guest's trust store for the package downloads (a proxy that inspects
 * TLS); it is removed again before the image is packed. ORDO_VM_CACHE=<dir> keeps downloads (default
 * <repo>/.cache/vm).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  bundledBoot,
  bundledKernelUrl,
  createImageFromKwsparse,
  createKernel,
  directBackend,
  encodeKwsparse,
  encodeSnapshot,
  fetchDistro,
  type KernelHandle,
  nodeFs,
  openDisk,
} from 'unkernel/node';
import { VM_GUEST } from '../src/vm-config.ts';

const [major] = process.versions.node.split('.').map(Number);
if ((major ?? 0) < 24) {
  console.error(`build-vm: needs Node 24 or later (unkernel's floor); this is Node ${process.versions.node}`);
  process.exit(1);
}

const here = dirname(new URL(import.meta.url).pathname);
const REPO = resolve(here, '../../..');
const [outArg, seedArg] = process.argv.slice(2);
if (!outArg || !seedArg) {
  console.error('usage: node apps/demo/scripts/build-vm.ts <site-out> <seed-data-dir>');
  process.exit(1);
}
const SITE = resolve(outArg);
const SEED = resolve(seedArg);
const OUT = join(SITE, 'vm');
const CACHE = resolve(process.env.ORDO_VM_CACHE ?? join(REPO, '.cache/vm'));
process.env.UNKERNEL_CACHE_DIR ??= join(CACHE, 'unkernel');
/**
 * What the image adds to Alpine: Node for the hub and poppler-utils (PDF pages), as in the container (Dockerfile), and
 * fonts the hub registers as bundled library fonts (ORDO_FONTS_DIR; the container's metric-compatible set where Alpine
 * has it). erofs-utils packs the image. ffmpeg is not Alpine's (93 MiB of codec libraries): a minimal static build made
 * here (scripts/build-ffmpeg.sh, `buildFfmpeg`). LibreOffice and Chromium stay out.
 */
const GUEST_PACKAGES = [
  'nodejs',
  'poppler-utils',
  'font-carlito',
  'font-liberation',
  'font-inter',
  'font-dejavu',
  'erofs-utils',
];
const work = mkdtempSync(join(tmpdir(), 'ordo-vm-'));
const t0 = Date.now();
const log = (msg: string) => console.log(`[vm ${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${msg}`);
const requireHub = createRequire(join(REPO, 'apps/hub/package.json'));
const requireDemo = createRequire(join(REPO, 'apps/demo/package.json'));
const pkgVersion = (req: NodeRequire, name: string) =>
  (JSON.parse(readFileSync(req.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;

/** Run a shell command in the guest as root; throws with its output on a non-zero exit. */
async function sh(vm: KernelHandle, cmd: string, what = cmd.slice(0, 80)): Promise<string> {
  const r = await vm.exec('sh', ['-c', cmd], { user: 'root' });
  const out = `${r.stdout}${r.stderr}`;
  if (r.exitCode !== 0) throw new Error(`guest: ${what} failed (exit ${r.exitCode}):\n${out.slice(-4000)}`);
  return r.stdout;
}

async function newDataDisk(path: string, module: WebAssembly.Module): Promise<void> {
  rmSync(path, { force: true });
  rmSync(`${path}.kwsnap`, { force: true });
  const tpl = bundledBoot(module).datadisk;
  if (!tpl) throw new Error('the unkernel bundle has no data disk template');
  await createImageFromKwsparse(path, tpl);
}

async function powerOff(vm: KernelHandle): Promise<void> {
  await vm.exec('sh', ['-c', 'sync'], { user: 'root' });
  vm.write('\nsudo poweroff -f\n');
  const r = await Promise.race([vm.exited, new Promise<null>((res) => setTimeout(() => res(null), 30_000))]);
  if (!r) await vm.stop();
}

// ---------------------------------------------------------------- the files that go into /app

function stageApp(): string {
  const stage = join(work, 'stage');
  const app = join(stage, 'app');
  for (const name of ['hub', 'operator', 'output', 'stage']) {
    const dist = join(REPO, 'apps', name, 'dist');
    if (!existsSync(dist)) throw new Error(`apps/${name}/dist is missing: run \`pnpm build\` first`);
    cpSync(dist, join(app, 'apps', name, 'dist'), {
      recursive: true,
      filter: (src) => !src.endsWith('.map'),
    });
  }
  copyFileSync(join(REPO, 'apps/hub/package.json'), join(app, 'apps/hub/package.json'));
  // The hub's native modules, for the guest (linux, arm64, musl). argon2 ships per-platform npm packages; the
  // better-sqlite3 binary comes from its GitHub release once the guest's Node ABI is known (fetchSqlite).
  const hub = join(app, 'apps/hub');
  writeFileSync(
    join(hub, 'package.json'),
    JSON.stringify({ name: 'ordo-hub-vm', private: true, type: 'module' }),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--os=linux',
      '--cpu=arm64',
      '--libc=musl',
      `better-sqlite3@${pkgVersion(requireHub, 'better-sqlite3')}`,
      `@node-rs/argon2@${pkgVersion(requireHub, '@node-rs/argon2')}`,
    ],
    { cwd: hub, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  copyFileSync(join(REPO, 'apps/hub/package.json'), join(hub, 'package.json'));
  return stage;
}

/**
 * The minimal ffmpeg and ffprobe (scripts/build-ffmpeg.sh, about 5 minutes on 4 cores), kept in the cache under the
 * script's hash: a changed script builds again, an unchanged one is reused. Copied to `<stage>/ffmpeg/`.
 */
function buildFfmpeg(stage: string): void {
  const script = join(here, 'build-ffmpeg.sh');
  const key = createHash('sha256').update(readFileSync(script)).digest('hex').slice(0, 16);
  const done = join(CACHE, `ffmpeg-${key}`);
  if (!existsSync(join(done, 'ffprobe'))) {
    log('ffmpeg: building the minimal static ffmpeg (scripts/build-ffmpeg.sh)');
    rmSync(done, { recursive: true, force: true });
    execFileSync('bash', [script, `${done}.tmp`, join(CACHE, 'ffmpeg-src')], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    rmSync(done, { recursive: true, force: true });
    cpSync(`${done}.tmp`, done, { recursive: true });
    rmSync(`${done}.tmp`, { recursive: true, force: true });
  } else log(`ffmpeg: the cached build ${key}`);
  cpSync(done, join(stage, 'ffmpeg'), { recursive: true });
}

async function fetchSqlite(stage: string, abi: string): Promise<void> {
  const v = pkgVersion(requireHub, 'better-sqlite3');
  const name = `better-sqlite3-v${v}-node-v${abi}-linuxmusl-arm64.tar.gz`;
  const cached = join(CACHE, name);
  if (!existsSync(cached)) {
    const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${v}/${name}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(cached, Buffer.from(await r.arrayBuffer()));
  }
  execFileSync('tar', ['xzf', cached, '-C', join(stage, 'app/apps/hub/node_modules/better-sqlite3')]);
}

// ---------------------------------------------------------------- machine 1: the system image

/** The distro header unkernel reads from an image's first bytes (js/core/distro.ts; erofs leaves them unused): name "ordo", no prefetch hint. */
function writeDistroHeader(path: string, id: string): void {
  const size = statSync(path).size;
  const h = Buffer.alloc(128);
  h.write('KWDISTRO', 0, 'latin1');
  h.writeUInt32LE(1, 8);
  h.writeUInt32LE(128, 12);
  h.writeBigUInt64LE(BigInt(size), 16);
  h.writeBigUInt64LE(0n, 24);
  h.write(VM_GUEST.distro, 32, 'latin1');
  h.write(id, 64, 'latin1');
  const fd = openSync(path, 'r+');
  writeSync(fd, h, 0, h.length, 0);
  closeSync(fd);
}

async function buildSystemImage(module: WebAssembly.Module, stage: string): Promise<string> {
  const data = join(work, 'build-data.img');
  await newDataDisk(data, module);
  const outDir = join(work, 'image');
  mkdirSync(outDir);
  const extraCa = process.env.ORDO_VM_EXTRA_CA;
  if (extraCa) copyFileSync(extraCa, join(stage, 'extra-ca.crt'));
  log('system image: booting Alpine');
  const vm = await createKernel({
    distro: await fetchDistro('alpine'),
    disks: [await openDisk(data)],
    net: directBackend(),
    memoryMiB: 2048,
    log: () => {},
  });
  try {
    const stageMount = await vm.mount('/mnt/stage', nodeFs(stage), { readOnly: true });
    const outMount = await vm.mount('/mnt/out', nodeFs(outDir));
    if (extraCa)
      await sh(
        vm,
        'cp /etc/ssl/certs/ca-certificates.crt /tmp/ca.orig && cat /mnt/stage/extra-ca.crt >> /etc/ssl/certs/ca-certificates.crt',
      );
    log(`system image: apk add ${GUEST_PACKAGES.join(' ')}`);
    // erofs-utils is in Alpine's community repository (the image starts with main only).
    await sh(
      vm,
      `sed -n 1p /etc/apk/repositories | sed 's#/main$#/community#' >> /etc/apk/repositories && apk update -q && apk add -q ${GUEST_PACKAGES.join(' ')}`,
      'apk add',
    );
    if (extraCa) await sh(vm, 'cp /tmp/ca.orig /etc/ssl/certs/ca-certificates.crt');
    const abi = (await sh(vm, 'node -p process.versions.modules')).trim();
    const nodeVersion = (await sh(vm, 'node --version')).trim();
    log(`system image: guest Node ${nodeVersion} (ABI ${abi})`);
    await fetchSqlite(stage, abi);
    await sh(vm, 'rm -rf /app && mkdir -p /app && cp -a /mnt/stage/app/apps /app/', 'copy the app');
    await sh(
      vm,
      'install -m 755 /mnt/stage/ffmpeg/ffmpeg /mnt/stage/ffmpeg/ffprobe /usr/bin/ && mkdir -p /usr/share/licenses/ordo-ffmpeg && cp /mnt/stage/ffmpeg/SOURCES /usr/share/licenses/ordo-ffmpeg/ && ffmpeg -hide_banner -version | head -n 1 && ffprobe -hide_banner -version | head -n 1',
      'install ffmpeg',
    );
    await sh(
      vm,
      `cd /app/apps/hub && node -e "const D=require('better-sqlite3');new D(':memory:').prepare('select 1').get();require('@node-rs/argon2').hashSync('x')"`,
      'native modules check',
    );
    await sh(vm, `printf '%s\\n' '${VM_GUEST.distro}' > /usr/lib/kw-distro`);
    // The root as Alpine's image plus this machine's changes, without unkernel's own layer (/kw/layer: the base
    // puts it on top of every distro at boot). The upper directory becomes a lower one here, so its whiteouts hold.
    await sh(
      vm,
      `mkdir -p /mnt/merged && mount -t overlay overlay -o ro,lowerdir=/data/distros/alpine/upper:/run/kw-lower/kw/distro /mnt/merged`,
      'merge the root',
    );
    const kib = Number((await sh(vm, 'du -sk /mnt/merged | cut -f1')).trim());
    log(`system image: packing ${(kib / 1024).toFixed(0)} MiB into an erofs image`);
    // erofs, as unkernel's own distro images, but uncompressed: their zstd is not in Alpine's mkfs.erofs, and this
    // kernel fails lz4 clusters (-ENOMEM, 2026-11-27). The guest reads it by range, only the blocks it needs.
    await sh(
      vm,
      `rm -f /data/root.erofs && mkfs.erofs -L kwroot /data/root.erofs /mnt/merged >/dev/null && cp /data/root.erofs /mnt/out/root.erofs && umount /mnt/merged`,
      'mkfs.erofs',
    );
    await stageMount.unmount();
    await outMount.unmount();
    await powerOff(vm);
  } catch (e) {
    await vm.stop();
    throw e;
  }
  const image = join(outDir, 'root.erofs');
  const id = `ordo-${createHash('sha256').update(readFileSync(image)).digest('hex').slice(0, 16)}`;
  writeDistroHeader(image, id);
  log(`system image: ${(statSync(image).size / 1048576).toFixed(0)} MiB (${id})`);
  return image;
}

// ---------------------------------------------------------------- machine 2: the seeded hub and its snapshot

/** The hub's own HTTP API, from the host, through the guest's loopback. */
async function hubFetch(vm: KernelHandle, path: string, init: RequestInit = {}): Promise<Response> {
  return vm.fetch(`http://localhost:${VM_GUEST.port}${path}`, init);
}

async function waitHealthy(vm: KernelHandle, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await hubFetch(vm, '/api/v1/health');
      const body = await r.text();
      if (r.ok && (JSON.parse(body) as { library?: string }).library === 'up') return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > end)
      throw new Error(`the hub in the VM did not become healthy in ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function snapshotHub(
  module: WebAssembly.Module,
  image: string,
): Promise<{ snapshot: Uint8Array; data: string }> {
  const data = join(work, 'data.img');
  await newDataDisk(data, module);
  log('snapshot: booting the system image');
  const vm = await createKernel({
    distro: image,
    disks: [await openDisk(data)],
    memoryMiB: VM_GUEST.memoryMiB,
    log: () => {},
  });
  try {
    const seed = await vm.mount('/mnt/seed', nodeFs(SEED), { readOnly: true });
    await sh(
      vm,
      `rm -rf ${VM_GUEST.dataDir} && mkdir -p ${VM_GUEST.dataDir} && cp -a /mnt/seed/. ${VM_GUEST.dataDir}/`,
      'copy the seed',
    );
    await seed.unmount();
    await sh(vm, 'sync');
    log('snapshot: starting the hub');
    const started = Date.now();
    await sh(vm, VM_GUEST.startCommand, 'start the hub');
    await waitHealthy(vm, 10 * 60_000);
    log(`snapshot: hub healthy after ${((Date.now() - started) / 1000).toFixed(0)} s`);
    // Warm the routes a visitor hits first, so their first answers are not the slow first runs.
    const login = await hubFetch(vm, '/api/v1/auth/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ordo': '1' },
      body: JSON.stringify({ pin: VM_GUEST.pin }),
    });
    if (!login.ok) throw new Error(`sign-in with the demo PIN: HTTP ${login.status} ${await login.text()}`);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    for (let i = 0; i < 2; i++)
      for (const p of ['auth/me', 'capabilities', 'library/snapshot', 'settings', 'health', 'jobs'])
        await (await hubFetch(vm, `/api/v1/${p}`, { headers: { cookie, 'x-ordo': '1' } })).arrayBuffer();
    await sh(vm, `rm -f ${VM_GUEST.dataDir}/hub.log.1; sync`);
    await new Promise((r) => setTimeout(r, 4000));
    const snap = await vm.snapshot({ stop: true });
    log(
      `snapshot: ${(snap.memory.byteLength / 1048576).toFixed(0)} MiB machine, ${((snap.freeBytes ?? 0) / 1048576).toFixed(0)} MiB free`,
    );
    return { snapshot: encodeSnapshot(snap), data };
  } catch (e) {
    // What the guest says about it: the hub's log and the kernel's last messages.
    const r = await Promise.race([
      vm.exec('sh', ['-c', `tail -n 40 ${VM_GUEST.dataDir}/hub.log; dmesg | tail -n 20; ps`], {
        user: 'root',
      }),
      new Promise<null>((res) => setTimeout(() => res(null), 20_000)),
    ]).catch(() => null);
    if (r) console.error(`guest diagnostics:\n${r.stdout}${r.stderr}`);
    await vm.stop();
    throw e;
  }
}

/** The data disk's non-zero 4 KiB blocks as a kwsparse image (what the page loads into IndexedDB). */
function kwsparseOf(path: string): Uint8Array {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  const blocks: [number, Uint8Array][] = [];
  const buf = Buffer.alloc(1 << 20);
  for (let off = 0; off < size; off += buf.length) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, size - off), off);
    for (let b = 0; b < n; b += 4096) {
      const block = buf.subarray(b, b + 4096);
      if (block.some((x) => x !== 0)) blocks.push([(off + b) / 4096, Uint8Array.from(block)]);
    }
  }
  closeSync(fd);
  return encodeKwsparse({ size, blockSize: 4096, blocks });
}

// ---------------------------------------------------------------- output

async function main(): Promise<void> {
  if (!existsSync(join(SEED, 'ordo.db'))) throw new Error(`${SEED} is not a hub data folder (no ordo.db)`);
  const module = await WebAssembly.compile(readFileSync(bundledKernelUrl));
  const stage = stageApp();
  buildFfmpeg(stage);
  const image = await buildSystemImage(module, stage);
  const { snapshot, data } = await snapshotHub(module, image);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16);
  const put = (base: string, ext: string, bytes: Uint8Array) => {
    const name = `${base}.${hash(bytes)}.${ext}`;
    writeFileSync(join(OUT, name), bytes);
    return { path: name, size: bytes.byteLength };
  };
  const rootBytes = readFileSync(image);
  const root = put('root', 'erofs', rootBytes);
  const dataRaw = kwsparseOf(data);
  const dataFile = put('data', 'kwsparse.gz', gzipSync(dataRaw, { level: 9 }));
  const snapFile = put('hub', 'kwsnap.gz', gzipSync(snapshot, { level: 9 }));

  // The SDK's browser files and the kernel, as the package ships them (its entries load their chunks and the
  // kernel relative to themselves). Node-only files and the GPU renderers are left out.
  const pkg = dirname(requireDemo.resolve('unkernel/package.json'));
  const skip = new Set(['cli.mjs', 'node.mjs', 'cli-imports.mjs', 'virgl.wasm', 'kwvk-naga.wasm']);
  cpSync(join(pkg, 'dist'), join(OUT, 'unkernel'), {
    recursive: true,
    filter: (src) => {
      const base = src.split('/').pop() ?? '';
      return !base.endsWith('.d.mts') && !skip.has(base) && !(base === 'node.mjs');
    },
  });
  for (const f of ['LICENSE', 'LICENSE-MIT', 'THIRD-PARTY.md'])
    copyFileSync(join(pkg, f), join(OUT, 'unkernel', f));
  const kernel = readFileSync(join(OUT, 'unkernel/unkernel.wasm'));

  const id = hash(
    Buffer.concat([
      Buffer.from(root.path),
      Buffer.from(dataFile.path),
      Buffer.from(snapFile.path),
      kernel.subarray(0, 1 << 20),
    ]),
  );
  const manifest = {
    version: 1,
    id,
    built: new Date().toISOString(),
    unkernel: pkgVersion(requireDemo, 'unkernel'),
    memoryMiB: VM_GUEST.memoryMiB,
    kernel: { path: 'unkernel/unkernel.wasm', size: kernel.byteLength },
    root,
    data: { ...dataFile, rawSize: dataRaw.byteLength },
    snapshot: { ...snapFile, rawSize: snapshot.byteLength },
  };
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const mib = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
  log(
    `wrote ${OUT}: build ${id}; system image ${mib(root.size)}, data disk ${mib(dataFile.size)} (gzip), snapshot ${mib(snapFile.size)} (gzip), kernel ${mib(kernel.byteLength)}`,
  );
}

try {
  await main();
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(0);
