import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * A stand-in for Chromium that speaks just enough of the DevTools pipe protocol (fd 3 in, fd 4 out, NUL-terminated
 * JSON) for the driver's tests: it answers the launch calls, forks a child that sleeps in the same process group
 * (so a group kill can be seen to take the child too) and answers a picture by its mode, read from a file next to
 * the script (the driver gives a browser a fixed environment): 'ok' draws a PNG of the recipe's size, 'hang' never
 * answers, 'crash' exits at the first picture, 'hang-launch' never answers the first launch call (a browser that is
 * slow to start, so a launch can be seen to be cut). The child's pid goes to `<script>.pids`.
 */

const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const zlib = require('node:zlib');
const cp = require('node:child_process');
const me = process.argv.find((a) => a.endsWith('stub-chromium')) || __filename;
const modeFile = __filename + '.mode';
const mode = () => { try { return fs.readFileSync(modeFile, 'utf8').trim(); } catch { return 'ok'; } };
const child = cp.spawn('sleep', ['300'], { stdio: 'ignore' });
fs.appendFileSync(__filename + '.pids', process.pid + ' ' + child.pid + '\\n');
const input = fs.createReadStream(null, { fd: 3 });
const out = fs.createWriteStream(null, { fd: 4 });
const send = (m) => out.write(JSON.stringify(m) + '\\0');
let n = 0;
let png = null;
const crcTable = (() => { const t = []; for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]); };
const makePng = (w, h) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; const raw = Buffer.alloc((1 + 4 * w) * h, 0); for (let y = 0; y < h; y++) raw[y * (1 + 4 * w) + 1 + 3] = 255; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); };
let buf = Buffer.alloc(0);
input.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0)) {
    const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
    buf = buf.subarray(i + 1);
    handle(msg);
  }
});
function handle(m) {
  const r = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'Browser.getVersion': if (mode() === 'hang-launch') return; return r({ product: 'Stub/1' });
    case 'Target.createTarget': return r({ targetId: 'T' + ++n });
    case 'Target.attachToTarget': return r({ sessionId: 'S' + n });
    case 'Page.navigate': return r({ frameId: 'F' });
    case 'Runtime.evaluate': {
      const e = m.params.expression;
      if (e.startsWith('window.__raster.setFonts')) return r({ result: { value: { loaded: 0, failed: [] } } });
      if (e.startsWith('window.__raster.draw')) {
        const md = mode();
        if (md === 'hang') return;
        if (md === 'crash') process.exit(3);
        const url = /draw\\(("[^"]*")\\)/.exec(e)[1];
        const rec = JSON.parse(fs.readFileSync(new URL(JSON.parse(url)), 'utf8'));
        png = makePng(rec.w, rec.h);
        return r({ result: { value: { ok: true, w: rec.w, h: rec.h, bytes: png.length, chunks: 1, ms: 1 } } });
      }
      if (e.startsWith('window.__raster.take')) return r({ result: { value: png ? png.toString('base64') : '' } });
      if (e.startsWith('window.__raster.release')) return r({ result: { value: null } });
      return r({ result: { value: true } });
    }
    default: return r({});
  }
}
`;

/** Writes the stub into `dir` and returns its path; `setMode` changes how it answers a picture. */
export function makeStub(dir: string): {
  exe: string;
  setMode(mode: 'ok' | 'hang' | 'crash' | 'hang-launch'): void;
  pidsFile: string;
} {
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'stub-chromium');
  writeFileSync(exe, SCRIPT);
  chmodSync(exe, 0o755);
  return {
    exe,
    pidsFile: `${exe}.pids`,
    setMode: (mode) => writeFileSync(`${exe}.mode`, mode),
  };
}
