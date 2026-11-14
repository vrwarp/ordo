/**
 * Builds the demo's sample service with the real hub, so every entity is exactly what a hub writes:
 * starts apps/hub/dist (run `pnpm build` first) on a scratch data directory, creates the content through
 * its API, then writes the library snapshot and every file it references to `<out>/demo/`.
 *
 *   npx tsx apps/demo/scripts/seed.ts <out-dir>
 *
 * The content is public domain or invented: hymns by Newton, Heber and Robinson; Luke 10 in the World
 * English Bible; a welcome loop; backgrounds drawn here.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { newId } from '@ordo/domain';
import type { LibrarySnapshot } from '@ordo/protocol';

const out = resolve(process.argv[2] ?? 'site');
const REPO = resolve(import.meta.dirname, '../../..');
const PORT = Number(process.env.ORDO_SEED_PORT ?? 8977);
const BASE = `http://localhost:${PORT}/api/v1/`;
const PIN = '246810';

// ---------------------------------------------------------------- a tiny PNG writer for the backgrounds

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** An 8-bit RGB PNG of `raw` (rows of `w` RGB pixels, no filter bytes). */
function rgbPng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A soft diagonal gradient between three colours with a little glow: a worship-style background. */
function gradientPng(w: number, h: number, stops: [number, number, number][]): Buffer {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w) * 0.65 + (y / h) * 0.35;
      const seg = t < 0.5 ? 0 : 1;
      const f = seg === 0 ? t / 0.5 : (t - 0.5) / 0.5;
      const a = stops[seg]!;
      const b = stops[seg + 1]!;
      const dx = x / w - 0.68;
      const dy = y / h - 0.32;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.2) * 26;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) rgb[o + c] = Math.min(255, Math.round(a[c]! + (b[c]! - a[c]!) * f + glow));
    }
  }
  return rgbPng(w, h, rgb);
}

// ---------------------------------------------------------------- the aurora background (a looping video)

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as RGB;
/** A colour along evenly spaced stops, `t` in 0..1. */
function along(stops: RGB[], t: number): RGB {
  const f = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(f);
  const a = stops[i]!;
  const b = stops[i + 1]!;
  return [0, 1, 2].map((c) => a[c]! + (b[c]! - a[c]!) * (f - i)) as RGB;
}
const smooth = (e: number, v: number) => {
  const t = Math.min(1, Math.max(0, v / e));
  return t * t * (3 - 2 * t);
};

/**
 * A ribbon of the aurora: its top and bottom edges as waves across the frame (fractions of its height) that
 * move with the phase, its colours from left to right, and its opacity. Every wave turns a whole number of
 * times per loop, so the last frame runs into the first.
 */
type Ribbon = {
  top: (x: number, p: number) => number;
  bottom: (x: number, p: number) => number;
  colors: RGB[];
  alpha: number;
};
const TAU = Math.PI * 2;
const RIBBONS: Ribbon[] = [
  {
    top: (x, p) => 0.38 + 0.07 * Math.sin(TAU * 1.1 * x + p) + 0.035 * Math.sin(TAU * 2.3 * x - 2 * p + 1),
    bottom: () => 1.2,
    colors: ['#7c3aed', '#c026d3', '#6366f1', '#3b82f6'].map(hex),
    alpha: 0.68,
  },
  {
    top: (x, p) => 0.46 + 0.065 * Math.sin(TAU * 1.3 * x + p + 2) + 0.03 * Math.sin(TAU * 2.9 * x + 2 * p),
    bottom: (x, p) => 0.86 + 0.05 * Math.sin(TAU * 1.7 * x - p + 0.5),
    colors: ['#00f5a0', '#00e5ff', '#10b981', '#06b6d4'].map(hex),
    alpha: 0.78,
  },
  {
    top: (x, p) => 0.55 + 0.06 * Math.sin(TAU * 1.5 * x - p + 4) + 0.025 * Math.sin(TAU * 3.1 * x + p),
    bottom: (x, p) => 0.77 + 0.045 * Math.sin(TAU * 1.2 * x + 2 * p + 1),
    colors: ['#38bdf8', '#34d399', '#a855f7'].map(hex),
    alpha: 0.66,
  },
];

/** The sky the ribbons move over: a night gradient, two soft glows and a few stars (still). */
function auroraSky(w: number, h: number): Float32Array {
  const sky = new Float32Array(w * h * 3);
  const stops = ['#070c24', '#0c173d', '#121136', '#08081a'].map(hex);
  const glows: { cx: number; cy: number; r: number; c: RGB; a: number }[] = [
    { cx: 0.35, cy: 0.4, r: 0.55, c: hex('#00f5a0'), a: 0.4 },
    { cx: 0.7, cy: 0.45, r: 0.55, c: hex('#a855f7'), a: 0.36 },
  ];
  for (let y = 0; y < h; y++) {
    const base = along(stops, y / h);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const px = [...base];
      for (const g of glows) {
        const d = Math.hypot(x / w - g.cx, (y / h - g.cy) * (h / w)) / g.r;
        const a = g.a * Math.max(0, 1 - d) ** 2;
        for (let c = 0; c < 3; c++) px[c] = px[c]! + (g.c[c]! - px[c]!) * a;
      }
      sky[o] = px[0]!;
      sky[o + 1] = px[1]!;
      sky[o + 2] = px[2]!;
    }
  }
  const stars: [number, number, number][] = [
    [0.09, 0.08, 1.5],
    [0.22, 0.14, 2.5],
    [0.39, 0.07, 1.5],
    [0.57, 0.12, 2],
    [0.72, 0.06, 2.5],
    [0.86, 0.15, 1.5],
    [0.95, 0.09, 1.5],
    [0.15, 0.2, 1.5],
    [0.46, 0.19, 2],
    [0.79, 0.22, 2],
  ];
  const k = w / 1920;
  for (const [sx, sy, sr] of stars) {
    const r = Math.max(1, sr * k);
    for (let y = Math.floor(sy * h - r - 1); y <= sy * h + r + 1; y++)
      for (let x = Math.floor(sx * w - r - 1); x <= sx * w + r + 1; x++) {
        const a = 0.8 * Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x - sx * w, y - sy * h)));
        const o = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) sky[o + c] = sky[o + c]! + (255 - sky[o + c]!) * a;
      }
  }
  return sky;
}

/** One frame of the aurora at phase `p` (radians; one loop is 2π) as RGB bytes. */
function auroraFrame(w: number, h: number, sky: Float32Array, p: number, out: Uint8Array): void {
  const px = Float32Array.from(sky);
  const edge = 0.03 * h;
  for (const rb of RIBBONS) {
    for (let x = 0; x < w; x++) {
      const fx = x / w;
      const top = rb.top(fx, p) * h;
      const bottom = rb.bottom(fx, p) * h;
      const col = along(rb.colors, fx);
      // A faint glow rises above the ribbon, as an aurora's light does.
      const y0 = Math.max(0, Math.floor(top - 6 * edge));
      const y1 = Math.min(h, Math.ceil(bottom));
      for (let y = y0; y < y1; y++) {
        const inside = smooth(edge, y - top) * smooth(edge, bottom - y);
        const glow = (y < top ? 0.35 * (1 - (top - y) / (6 * edge)) ** 2 : 0.35) * smooth(edge, bottom - y);
        const a = rb.alpha * Math.max(inside, glow);
        if (a <= 0) continue;
        const o = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) px[o + c] = px[o + c]! + (col[c]! - px[o + c]!) * a;
      }
    }
  }
  for (let i = 0; i < px.length; i++) out[i] = Math.min(255, Math.max(0, Math.round(px[i]!)));
}

/**
 * The aurora as a seamless 8 s loop for song 2's background (720p H.264, which the hub transcodes like any
 * upload): an SVG background shows only its first frame on Audience screens (design/14 "Pictures"), a video
 * moves there. When ffmpeg cannot make it here, the first frame as a still picture.
 */
async function auroraBackground(): Promise<{ name: string; data: Buffer; mime: string }> {
  const w = 1280;
  const h = 720;
  const fps = 24;
  const frames = 8 * fps;
  const sky = auroraSky(w, h);
  const frame = new Uint8Array(w * h * 3);
  const dir = mkdtempSync(join(tmpdir(), 'ordo-demo-aurora-'));
  const file = join(dir, 'aurora.mp4');
  try {
    const ff = spawn(
      'ffmpeg',
      [
        ...['-hide_banner', '-loglevel', 'error', '-y'],
        ...['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(fps), '-i', '-'],
        ...['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'],
        ...['-movflags', '+faststart', file],
      ],
      { stdio: ['pipe', 'ignore', 'inherit'] },
    );
    const done = new Promise<number>((res) => {
      ff.on('error', () => res(-1));
      ff.on('close', (code) => res(code ?? -1));
    });
    ff.stdin.on('error', () => undefined);
    for (let i = 0; i < frames && ff.exitCode === null; i++) {
      auroraFrame(w, h, sky, (TAU * i) / frames, frame);
      if (!ff.stdin.write(frame)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
    if ((await done) === 0) return { name: 'Aurora Waves.mp4', data: readFileSync(file), mime: 'video/mp4' };
    console.warn('demo seed: ffmpeg could not make the aurora video; using its first frame as a still');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  auroraFrame(w, h, sky, 0, frame);
  return { name: 'Aurora Waves.png', data: rgbPng(w, h, frame), mime: 'image/png' };
}

// ---------------------------------------------------------------- content

const HYMNS = [
  `Amazing Grace\n\nVerse 1\nAmazing grace! How sweet the sound\nThat saved a wretch like me\n\nChorus\nI once was lost, but now am found\nWas blind, but now I see\n\nVerse 2\n'Twas grace that taught my heart to fear\nAnd grace my fears relieved\n\nVerse 3\nThrough many dangers, toils and snares\nI have already come\n`,
  `Holy, Holy, Holy\n\nVerse 1\nHoly, holy, holy! Lord God Almighty!\nEarly in the morning our song shall rise to Thee\n\nVerse 2\nHoly, holy, holy! All the saints adore Thee\nCasting down their golden crowns around the glassy sea\n\nVerse 3\nHoly, holy, holy! Merciful and mighty\nGod in three Persons, blessed Trinity\n`,
  `Come Thou Fount\n\nVerse 1\nCome, Thou Fount of every blessing\nTune my heart to sing Thy grace\n\nChorus\nStreams of mercy, never ceasing\nCall for songs of loudest praise\n\nVerse 2\nHere I raise my Ebenezer\nHither by Thy help I'm come\n`,
];

const white = { r: 255, g: 255, b: 255, a: 1 };
const gold = { r: 232, g: 196, b: 128, a: 1 };
const shadow = { dx: 0, dy: 4, blur: 14, color: { r: 0, g: 0, b: 0, a: 0.6 } };
function text(
  t: string,
  box: [number, number, number, number],
  size: number,
  opts: { weight?: number; align?: 'left' | 'center'; color?: typeof white; valign?: 'top' | 'middle' } = {},
) {
  return {
    id: newId(),
    type: 'text',
    box: { x: box[0], y: box[1], w: box[2], h: box[3], rotation: 0 },
    text: t,
    style: {
      fontFamily: 'Inter',
      fontWeight: opts.weight ?? 600,
      fontStyle: 'normal',
      fontSizePx: size,
      color: opts.color ?? white,
      align: opts.align ?? 'left',
      valign: opts.valign ?? 'top',
      lineHeight: 1.25,
      letterSpacing: 0,
      padding: 0,
      shadow,
      transform: 'none',
    },
    opacity: 1,
  };
}
function slides(
  title: string,
  kind: 'slides' | 'loop',
  label: string,
  objs: unknown[][],
  extra: Record<string, unknown>,
) {
  return {
    id: newId(),
    rev: 1,
    title,
    kind,
    meta: { tags: [] },
    sections: [
      { id: newId(), label, short: label[0], slides: objs.map((objects) => ({ id: newId(), objects })) },
    ],
    arrangements: [],
    ...(kind === 'loop' ? { loop: { defaultSlideMs: 8000 } } : {}),
    archived: false,
    source: { kind: 'manual' },
    ...extra,
  };
}

// ---------------------------------------------------------------- hub

async function main() {
  const data = mkdtempSync(join(tmpdir(), 'ordo-demo-seed-'));
  const hub = spawn('node', [join(REPO, 'apps/hub/dist/main.js'), '--single'], {
    cwd: REPO,
    env: {
      ...process.env,
      ORDO_DATA: data,
      ORDO_PORT: String(PORT),
      ORDO_HOST: '127.0.0.1',
      ORDO_DOMAIN: 'localhost',
      ORDO_DEV_PIN: PIN,
      ORDO_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${BASE}health`)).ok) break;
      } catch {
        /* starting */
      }
      if (i > 150) throw new Error('the hub did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
    const login = await fetch(`${BASE}auth/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: PIN }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const api = async <T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      headers.set('cookie', cookie);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(init.json);
      }
      const r = await fetch(BASE + path, { ...init, headers, body });
      if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status} ${await r.text()}`);
      return (r.headers.get('content-type') ?? '').includes('json')
        ? ((await r.json()) as T)
        : (undefined as T);
    };
    const upload = async (name: string, buf: Buffer, mime: string, isBackground: boolean) => {
      const fd = new FormData();
      fd.append('isBackground', String(isBackground));
      fd.append('file', new Blob([new Uint8Array(buf)], { type: mime }), name);
      const m = await api<{ id: string }>('media', { method: 'POST', body: fd });
      // A video is transcoded first: up to 3 minutes on a loaded runner.
      for (let i = 0; i < 900; i++) {
        const s = await api<{ state: string }>(`media/${m.id}`);
        if (s.state === 'ready') return m;
        if (s.state === 'failed') throw new Error(`media ${name} failed`);
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`media ${name} did not finish`);
    };

    // Settings: a demo venue with one audience screen and the stage display.
    const general = await api<Record<string, unknown>>('settings/general');
    await api('settings/general', { method: 'PUT', json: { ...general, venueName: 'ordo demo' } });
    const outputs = await api<{ kind: string; hostIndex: number; enabled: boolean }[]>('settings/outputs');
    await api('settings/outputs', {
      method: 'PUT',
      json: outputs.map((o) => ({ ...o, enabled: o.kind === 'stage' || o.hostIndex === 1 })),
    });

    const dusk = await upload(
      'Dusk.png',
      gradientPng(1920, 1080, [
        [13, 27, 62],
        [59, 42, 107],
        [10, 61, 92],
      ]),
      'image/png',
      true,
    );
    const amber = await upload(
      'Amber.png',
      gradientPng(1920, 1080, [
        [61, 31, 15],
        [138, 90, 43],
        [43, 26, 18],
      ]),
      'image/png',
      true,
    );
    const auroraFile = await auroraBackground();
    const aurora = await upload(auroraFile.name, auroraFile.data, auroraFile.mime, true);

    const songs: { id: string; rev: number }[] = [];
    for (const h of HYMNS) songs.push(await api('import/songselect', { method: 'POST', json: { text: h } }));
    // The first song gets the dusk background; the second the moving aurora.
    const first = await api<Record<string, unknown> & { rev: number }>(`presentations/${songs[0]!.id}`);
    await api(`presentations/${songs[0]!.id}`, {
      method: 'PUT',
      json: { ...first, backgroundMediaId: dusk.id },
    });
    if (songs[1]) {
      const second = await api<Record<string, unknown> & { rev: number }>(`presentations/${songs[1]!.id}`);
      await api(`presentations/${songs[1]!.id}`, {
        method: 'PUT',
        json: { ...second, backgroundMediaId: aurora.id },
      });
    }

    const verses: [string, number][] = [
      [
        'Behold, a certain lawyer stood up and tested him, saying, “Teacher, what shall I do to inherit eternal life?”',
        25,
      ],
      [
        'He answered, “You shall love the Lord your God with all your heart, with all your soul, with all your strength, and with all your mind; and your neighbor as yourself.”',
        27,
      ],
      [
        'But a certain Samaritan, as he traveled, came where he was. When he saw him, he was moved with compassion.',
        33,
      ],
    ];
    const reading = await api<{ id: string }>('presentations', {
      method: 'POST',
      json: slides(
        'Luke 10:25–37',
        'slides',
        'Reading',
        verses.map(([t, v]) => [
          text(t, [200, 260, 1520, 500], 64, { weight: 500, align: 'center', valign: 'middle' }),
          text(`Luke 10:${v} · WEB`, [200, 860, 1520, 60], 34, { align: 'center', color: gold }),
        ]),
        { backgroundMediaId: amber.id, meta: { tags: ['scripture'] } },
      ),
    });
    const card = (kicker: string, title: string, body: string) => [
      {
        id: newId(),
        type: 'shape',
        box: { x: 160, y: 300, w: 12, h: 420, rotation: 0 },
        shape: 'rect',
        fill: { r: 214, g: 170, b: 92, a: 1 },
        opacity: 1,
        radius: 0,
      },
      text(kicker.toUpperCase(), [210, 300, 1400, 60], 36, { weight: 700, color: gold }),
      text(title, [210, 370, 1500, 180], 96, { weight: 700 }),
      text(body, [210, 560, 1400, 160], 44, { weight: 400 }),
    ];
    const loop = await api<{ id: string }>('presentations', {
      method: 'POST',
      json: slides(
        'Welcome loop',
        'loop',
        'Announcements',
        [
          card(
            'Welcome',
            'We’re glad you’re here',
            'This is the ordo demo. Press Go live, then Launch outputs.',
          ),
          card(
            'Try it',
            'Import a ProPresenter file',
            'Library → Import accepts .pro, .probundle and .proPlaylist.',
          ),
          card(
            'Nothing leaves',
            'It all runs in your browser',
            'Click "demo" in the top bar to reset and start again from this sample.',
          ),
        ],
        { backgroundMediaId: dusk.id },
      ),
    });
    await api('playlists', {
      method: 'POST',
      json: {
        name: 'Sample service',
        items: [
          { id: newId(), kind: 'presentation', presentationId: loop.id },
          { id: newId(), kind: 'presentation', presentationId: songs[1]!.id },
          { id: newId(), kind: 'presentation', presentationId: songs[0]!.id },
          { id: newId(), kind: 'presentation', presentationId: reading.id },
          { id: newId(), kind: 'presentation', presentationId: songs[2]!.id },
        ],
      },
    });

    // Export: the snapshot and every file it references.
    const snap = await api<LibrarySnapshot>('library/snapshot');
    const hashes = new Set<string>();
    for (const m of snap.media) for (const f of [m.original, m.delivery, m.poster]) if (f) hashes.add(f.hash);
    for (const f of snap.fonts) hashes.add(f.file.hash);
    rmSync(join(out, 'demo'), { recursive: true, force: true });
    mkdirSync(join(out, 'demo', 'files'), { recursive: true });
    for (const h of hashes) {
      const r = await fetch(`${BASE}files/${h}`, { headers: { cookie } });
      if (!r.ok) throw new Error(`file ${h}: ${r.status}`);
      writeFileSync(join(out, 'demo', 'files', h), Buffer.from(await r.arrayBuffer()));
    }
    writeFileSync(join(out, 'demo', 'seed.json'), JSON.stringify({ snapshot: snap, files: [...hashes] }));
    console.log(
      `demo seed: ${snap.presentations.length} presentations, ${snap.playlists.length} playlist(s), ${snap.media.length} media, ${hashes.size} file(s)`,
    );
  } finally {
    hub.kill('SIGKILL');
    rmSync(data, { recursive: true, force: true });
  }
}

await main();
