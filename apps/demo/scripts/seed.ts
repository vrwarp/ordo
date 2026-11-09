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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
/** A soft diagonal gradient between three colours with a little glow: a worship-style background. */
function gradientPng(w: number, h: number, stops: [number, number, number][]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x / w) * 0.65 + (y / h) * 0.35;
      const seg = t < 0.5 ? 0 : 1;
      const f = seg === 0 ? t / 0.5 : (t - 0.5) / 0.5;
      const a = stops[seg]!;
      const b = stops[seg + 1]!;
      const dx = x / w - 0.68;
      const dy = y / h - 0.32;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.2) * 26;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.min(255, Math.round(a[c]! + (b[c]! - a[c]!) * f + glow));
    }
  }
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

/** An animated multi-layer SVG background with CSS keyframes, glowing orbs and floating wave paths. */
function animatedWaveSvg(): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0a0e27" />
      <stop offset="50%" stop-color="#141a3e" />
      <stop offset="100%" stop-color="#050714" />
    </linearGradient>
    <linearGradient id="waveGrad1" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.38" />
      <stop offset="50%" stop-color="#8b5cf6" stop-opacity="0.48" />
      <stop offset="100%" stop-color="#06b6d4" stop-opacity="0.38" />
    </linearGradient>
    <linearGradient id="waveGrad2" x1="100%" y1="0%" x2="0%" y2="0%">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.32" />
      <stop offset="50%" stop-color="#ec4899" stop-opacity="0.28" />
      <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.32" />
    </linearGradient>
    <radialGradient id="orbGrad1" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#818cf8" stop-opacity="0.42" />
      <stop offset="100%" stop-color="#818cf8" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="orbGrad2" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#06b6d4" stop-opacity="0.35" />
      <stop offset="100%" stop-color="#06b6d4" stop-opacity="0" />
    </radialGradient>
    <style>
      @keyframes floatA {
        0%, 100% { transform: translate(0px, 0px) scale(1); }
        50% { transform: translate(140px, 70px) scale(1.18); }
      }
      @keyframes floatB {
        0%, 100% { transform: translate(0px, 0px) scale(1); }
        50% { transform: translate(-120px, -60px) scale(1.12); }
      }
      @keyframes waveA {
        0%, 100% { transform: translateY(0px) scaleY(1); }
        50% { transform: translateY(-45px) scaleY(1.1); }
      }
      @keyframes waveB {
        0%, 100% { transform: translateY(0px) scaleY(1); }
        50% { transform: translateY(40px) scaleY(0.92); }
      }
      .orb-1 { animation: floatA 16s ease-in-out infinite; transform-origin: 450px 320px; }
      .orb-2 { animation: floatB 20s ease-in-out infinite; transform-origin: 1450px 680px; }
      .wave-layer-1 { animation: waveA 14s ease-in-out infinite; transform-origin: center bottom; }
      .wave-layer-2 { animation: waveB 18s ease-in-out infinite; transform-origin: center bottom; }
    </style>
  </defs>
  <rect width="1920" height="1080" fill="url(#bgGrad)" />
  <circle class="orb-1" cx="450" cy="320" r="520" fill="url(#orbGrad1)" />
  <circle class="orb-2" cx="1450" cy="680" r="620" fill="url(#orbGrad2)" />
  <g class="wave-layer-1">
    <path d="M0,680 C320,580 640,800 960,700 C1280,600 1600,760 1920,660 L1920,1080 L0,1080 Z" fill="url(#waveGrad1)" />
  </g>
  <g class="wave-layer-2">
    <path d="M0,740 C380,820 760,660 1140,760 C1520,860 1700,720 1920,770 L1920,1080 L0,1080 Z" fill="url(#waveGrad2)" />
  </g>
</svg>`;
  return Buffer.from(svg, 'utf8');
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
      fd.append('file', new Blob([buf], { type: mime }), name);
      const m = await api<{ id: string }>('media', { method: 'POST', body: fd });
      for (let i = 0; i < 300; i++) {
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
    const auroraSvg = await upload('Aurora Waves (Animated).svg', animatedWaveSvg(), 'image/svg+xml', true);

    const songs: { id: string; rev: number }[] = [];
    for (const h of HYMNS) songs.push(await api('import/songselect', { method: 'POST', json: { text: h } }));
    // The first song gets the dusk background; the second gets the animated multi-layer SVG background.
    const first = await api<Record<string, unknown> & { rev: number }>(`presentations/${songs[0]!.id}`);
    await api(`presentations/${songs[0]!.id}`, {
      method: 'PUT',
      json: { ...first, backgroundMediaId: dusk.id },
    });
    if (songs[1]) {
      const second = await api<Record<string, unknown> & { rev: number }>(`presentations/${songs[1]!.id}`);
      await api(`presentations/${songs[1]!.id}`, {
        method: 'PUT',
        json: { ...second, backgroundMediaId: auroraSvg.id },
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
            'Reset demo at the top starts again from this sample.',
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
