// The picture maker's browser inside the built hub image (docker-pr.yml, "The picture maker's browser draws a 4K
// picture inside the image"). It starts the image's own Chromium the way the hub's picture driver does (the same
// flags, `nice -n 19`, its own process group, the DevTools protocol on a pipe, the container's default /dev/shm),
// loads the built picture page the hub ships (dist/raster-page.js) and draws a 3840 x 2160 canvas with a many-point
// outline three times in the one browser, as an import with several pictures does. It fails (exit 1) when the
// browser crashes or exits, the page does not start, a picture is the wrong size or no PNG, or it takes too long.
//
// A plain Node script with no dependency, copied into the container by the workflow; tools/image-smoke/
// raster-canvas.test.ts runs it against a real Chromium and keeps FLAGS equal to the driver's `rasterArgs`.
//
// ORDO_CHROMIUM names the browser (the image sets it), RASTER_PAGE the built page, SMOKE_DRAWS the number of pictures,
// READY_MS how long the page may take to start (the tests shorten it).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// rasterArgs(PROFILE, {}) of apps/hub/src/pptx/rasterPage.ts (the test pins the two equal). No --disable-dev-shm-usage:
// the hub does not pass it, so the container's default 64 MB /dev/shm is what the picture maker gets.
const FLAGS = [
  '--headless',
  '--remote-debugging-pipe',
  '--user-data-dir=PROFILE',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--in-process-gpu',
  '--renderer-process-limit=1',
  '--disable-features=SpareRendererForSitePerProcess',
  '--enable-features=NetworkServiceInProcess2',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-component-update',
  '--mute-audio',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--js-flags=--max-old-space-size=1024',
  '--allow-file-access-from-files',
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--no-sandbox',
  'about:blank',
];

const exe = process.env.ORDO_CHROMIUM || 'chromium';
const pageFile = process.env.RASTER_PAGE || '/app/apps/hub/dist/raster-page.js';
const draws = Math.max(1, Number(process.env.SMOKE_DRAWS) || 3);
const W = 3840;
const H = 2160;
const TOTAL_MS = 120_000;
// How long the page may take to expose `window.__raster` (the driver waits 15 s; the test shortens it).
const READY_MS = Math.max(100, Number(process.env.READY_MS) || 15_000);

let proc;
let work;
let stderr = '';

function cleanup() {
  try {
    if (proc?.pid) process.kill(-proc.pid, 'SIGKILL');
  } catch {
    // already gone
  }
  if (work) rmSync(work, { recursive: true, force: true });
}

function fail(message) {
  console.error(`raster smoke failed: ${message}`);
  const tail = stderr.trim().split('\n').slice(-6).join('\n');
  if (tail) console.error(`the browser's last words:\n${tail}`);
  cleanup();
  process.exit(1);
}

if (!existsSync(pageFile)) fail(`the picture page ${pageFile} is not in the image`);

try {
  const shm = statfsSync('/dev/shm');
  console.log(`/dev/shm: ${Math.round((shm.bsize * shm.blocks) / 1048576)} MB`);
} catch {
  console.log('/dev/shm: not readable');
}

work = mkdtempSync(join(tmpdir(), 'ordo-raster-smoke-'));
const profile = join(work, 'profile');
mkdirSync(profile, { recursive: true });
const html = join(profile, 'index.html');
writeFileSync(
  html,
  `<!doctype html><meta charset="utf-8"><body><script src="${pathToFileURL(pageFile).href}"></script></body>`,
);

const watchdog = setTimeout(() => fail(`no answer within ${TOTAL_MS / 1000} s`), TOTAL_MS);

proc = spawn('nice', ['-n', '19', exe, ...FLAGS.map((f) => f.replace('PROFILE', join(profile, 'data')))], {
  stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  detached: true,
  env: { PATH: process.env.PATH, HOME: profile, LANG: 'C.UTF-8' },
});
proc.stderr.on('data', (d) => {
  stderr = (stderr + d.toString('utf8')).slice(-4000);
});
const out = proc.stdio[3];
const input = proc.stdio[4];

let nextId = 0;
let buf = Buffer.alloc(0);
const pending = new Map();
let gone;
proc.on('error', (e) => fail(`the browser did not start (${e.message})`));
proc.on('exit', (code, sig) => {
  gone = `the browser exited (${sig ?? code})`;
  for (const p of pending.values()) p.reject(new Error(gone));
  pending.clear();
});
out.on('error', () => undefined);
input.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0)) {
    let m;
    try {
      m = JSON.parse(buf.subarray(0, i).toString('utf8'));
    } catch {
      m = {};
    }
    buf = buf.subarray(i + 1);
    const p = m.id === undefined ? undefined : pending.get(m.id);
    if (!p) continue;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
    else p.resolve(m.result);
  }
});

function send(method, params = {}, sessionId) {
  if (gone) return Promise.reject(new Error(gone));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
}

// One picture: a gradient field, a 45,000-point outline filled and stroked, the PNG read back (the work of one
// many-point shape of an import), answered as numbers.
const PICTURE = `(async () => {
  const w = ${W};
  const h = ${H};
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#1e78c8');
  grad.addColorStop(1, '#f0dc28');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const n = 45000;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const r = 900 + 60 * Math.sin(a * 37);
    const x = w / 2 + r * Math.cos(a) * 1.6;
    const y = h / 2 + r * Math.sin(a);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.closePath();
  g.fillStyle = 'rgba(30, 30, 30, 0.8)';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#ffffff';
  g.stroke();
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
  const png = new Uint8Array(await blob.arrayBuffer());
  const v = new DataView(png.buffer);
  c.width = 0;
  c.height = 0;
  return { bytes: png.length, signature: Array.from(png.slice(0, 8)).join(','), w: v.getUint32(16), h: v.getUint32(20) };
})()`;

async function evaluate(expression, sessionId) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`the page failed: ${(d.exception?.description ?? d.text).split('\n')[0]}`);
  }
  return r.result.value;
}

try {
  const t0 = Date.now();
  const version = await send('Browser.getVersion');
  console.log(`browser: ${version.product} (started in ${Date.now() - t0} ms)`);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const nav = await send('Page.navigate', { url: pathToFileURL(html).href }, sessionId);
  if (nav.errorText) throw new Error(`could not open the picture page: ${nav.errorText}`);
  const ready = await evaluate(
    `new Promise((ok) => { const t = Date.now(); const poll = () => typeof window.__raster === 'object' ? ok(true) : Date.now() - t > ${READY_MS} ? ok(false) : setTimeout(poll, 20); poll(); })`,
    sessionId,
  );
  if (!ready)
    throw new Error(`the picture page did not start (no 'window.__raster' after ${READY_MS / 1000} s)`);
  console.log('the picture page started');
  for (let i = 1; i <= draws; i++) {
    const t = Date.now();
    const p = await evaluate(PICTURE, sessionId);
    if (p.signature !== '137,80,78,71,13,10,26,10') throw new Error(`picture ${i} is not a PNG`);
    if (p.w !== W || p.h !== H) throw new Error(`picture ${i} is ${p.w} x ${p.h}, not ${W} x ${H}`);
    console.log(`picture ${i}: ${p.w} x ${p.h}, ${p.bytes} bytes, ${Date.now() - t} ms`);
  }
  if (gone) throw new Error(gone);
  clearTimeout(watchdog);
  cleanup();
  console.log(`the image's Chromium drew ${draws} pictures of ${W} x ${H}`);
  process.exit(0);
} catch (e) {
  clearTimeout(watchdog);
  fail(e.message);
}
