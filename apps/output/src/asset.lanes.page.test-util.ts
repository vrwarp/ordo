import { DEFAULT_LYRIC_STYLE, LOOK_MAIN, type Slide, type TextStyle } from '@ordo/domain';
import {
  type AssetJob,
  type FromAsset,
  type PictureTarget,
  pictureTarget,
  preparePicture,
  preparePictureSteps,
} from '@ordo/renderer';
import { type ImageDecoderCtor, createDecoder } from './decode.ts';

/**
 * Headless Chromium side of asset.lanes.browser.test.ts (design/27 §7.5):
 *
 * - `__lanes.props`: the real asset worker (bundled) at 4K, its pictures in OPFS. A heavy slide (two large
 *   photos and text) is sent, and a props job a few milliseconds later, as the link sends one 150 ms before
 *   its second. Each props bitmap must reach the "renderer" (a port here) within that lead plus one frame,
 *   while the slide is still decoding and preparing. Reported: when each arrived, and the lane timings.
 * - `__lanes.geometry`: the crop-aware decode against the whole-file decode for targets that cover, crop
 *   and contain, with coloured markers whose centroids must land in the same place; and banded preparation
 *   against one pass, which must be identical byte for byte, masked and mirrored pictures included (M6 merge
 *   review: their mask is cut once, without a band's clip); a turned masked one is reported with its
 *   premultiplied difference (Chromium anti-aliases a turned picture's own edge differently under a clip).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A photo-like JPEG: gradients, discs, text and noise, with 64 px colour markers centred at `markers`. */
async function photo(w: number, h: number, markers: [number, number][] = []): Promise<Blob> {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d')!;
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#203060');
  g.addColorStop(0.5, '#b08050');
  g.addColorStop(1, '#407060');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  for (let i = 0; i < 500; i++) {
    x.fillStyle = `hsla(${(i * 37) % 360},60%,${35 + (i % 4) * 8}%,0.35)`;
    x.beginPath();
    x.arc((i * 7919) % w, (i * 104729) % h, 8 + (i % 40) * 7, 0, 7);
    x.fill();
  }
  x.font = `${Math.round(w / 70)}px sans-serif`;
  x.fillStyle = '#eee';
  for (let i = 0; i < 30; i++)
    x.fillText('Amazing grace, how sweet the sound', (i * 997) % (w / 2), ((i + 1) * h) / 31);
  const n = x.getImageData(0, 0, Math.min(w, 1024), Math.min(h, 1024));
  for (let i = 0; i < n.data.length; i += 4) {
    const v = ((i * 2654435761) >>> 24) / 255 - 0.5;
    n.data[i]! += v * 24;
    n.data[i + 1]! += v * 24;
    n.data[i + 2]! += v * 24;
  }
  for (let yy = 0; yy < h; yy += 1024) for (let xx = 0; xx < w; xx += 1024) x.putImageData(n, xx, yy);
  const colours = ['#ff0000', '#00ff00', '#0000ff', '#ff00ff'];
  markers.forEach(([mx, my], i) => {
    x.fillStyle = colours[i % 4]!;
    x.fillRect(mx - 32, my - 32, 64, 64);
  });
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

async function putOpfs(hash: string, blob: Blob): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('ordo-cache', { create: true });
  const fh = await dir.getFileHandle(hash, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });
const style: TextStyle = { ...DEFAULT_LYRIC_STYLE, fontSizePx: 72, padding: 0, valign: 'top' };

function heavySlide(key: string): AssetJob {
  const slide: Slide = {
    id: key,
    objects: [
      {
        id: 'a',
        type: 'image',
        box: box(0, 0, 1920, 1080),
        mediaId: 'big',
        fit: 'cover',
        opacity: 1,
        radius: 0,
      },
      {
        id: 'b',
        type: 'image',
        box: box(960, 0, 960, 1080),
        mediaId: 'side',
        fit: 'cover',
        opacity: 1,
        radius: 0,
      },
      {
        id: 't',
        type: 'text',
        box: box(100, 700, 1720, 300),
        text: 'Amazing grace, how sweet the sound\nThat saved a wretch like me',
        style,
        opacity: 1,
      },
    ],
  };
  return {
    kind: 'slide',
    layer: 1,
    key,
    cueIndex: 1,
    slide,
    isSong: false,
    look: LOOK_MAIN,
    images: { big: 'big-photo', side: 'side-photo' },
  };
}

function propsJob(key: string, text: string): AssetJob {
  return {
    kind: 'props',
    layer: 4,
    key,
    model: { key, items: [{ id: 'clock', text, style, box: box(1500, 40, 380, 100) }], empty: false },
    look: LOOK_MAIN,
    images: {},
  };
}

export type PropsRun = {
  offsetMs: number;
  /** From sending the props job to its bitmap reaching the renderer's port. */
  propsMs: number;
  /** From sending the slide job to its bitmap reaching the renderer's port. */
  slideMs: number;
  /** The props bitmap reached the renderer before the slide's. */
  propsFirst: boolean;
  slide?: Extract<FromAsset, { t: 'done' }>;
  props?: Extract<FromAsset, { t: 'done' }>;
};

async function propsScenario(workerUrl: string, width: number, height: number, offsets: number[]) {
  await putOpfs('big-photo', await photo(6000, 4000));
  await putOpfs('side-photo', await photo(4000, 3000));
  const worker = new Worker(workerUrl);
  const errors: string[] = [];
  worker.onerror = (e) => errors.push(e.message);
  const render = new MessageChannel();
  const link = new MessageChannel();
  const arrivals = new Map<string, number>();
  render.port2.onmessage = (
    e: MessageEvent<{ key: string; bitmap: ImageBitmap; over?: ImageBitmap | null }>,
  ) => {
    arrivals.set(e.data.key, performance.now());
    e.data.bitmap.close();
    e.data.over?.close();
  };
  const replies: FromAsset[] = [];
  link.port2.onmessage = (e: MessageEvent<FromAsset>) => replies.push(e.data);
  worker.postMessage({ t: 'init', width, height, token: '', apiPrefix: '/api/v1' });
  worker.postMessage({ t: 'ports', render: render.port1, link: link.port1 }, [render.port1, link.port1]);
  const until = async (ok: () => boolean, ms = 20_000) => {
    const end = performance.now() + ms;
    while (!ok()) {
      if (performance.now() > end) throw new Error(`timed out; replies ${JSON.stringify(replies.slice(-3))}`);
      await sleep(2);
    }
  };
  // Warm the code paths (and the text engine) once, untimed.
  link.port2.postMessage({ t: 'job', job: propsJob('pr|warmup', '10:00'), role: 'live' });
  link.port2.postMessage({ t: 'job', job: heavySlide('sl|warmup'), role: 'armed' });
  await until(() => arrivals.has('sl|warmup') && arrivals.has('pr|warmup'));
  const runs: PropsRun[] = [];
  for (const [i, offset] of offsets.entries()) {
    // Nothing cached: the slide decodes and prepares both photos again.
    link.port2.postMessage({ t: 'prune', keep: [] });
    await sleep(50);
    const sk = `sl|heavy|${i}`;
    const pk = `pr|${i}`;
    const t0 = performance.now();
    link.port2.postMessage({ t: 'job', job: heavySlide(sk), role: 'armed' });
    await sleep(offset);
    const tp = performance.now();
    link.port2.postMessage({ t: 'job', job: propsJob(pk, `10:${String(i).padStart(2, '0')}`) });
    const done = (k: string) =>
      replies.find((r): r is Extract<FromAsset, { t: 'done' }> => r.t === 'done' && r.key === k);
    // The bitmaps reach the renderer's port, the results the link's: both, for both jobs.
    await until(() => arrivals.has(sk) && arrivals.has(pk) && !!done(sk) && !!done(pk));
    runs.push({
      offsetMs: offset,
      propsMs: arrivals.get(pk)! - tp,
      slideMs: arrivals.get(sk)! - t0,
      propsFirst: arrivals.get(pk)! < arrivals.get(sk)!,
      slide: done(sk),
      props: done(pk),
    });
  }
  worker.terminate();
  return { runs, errors, failures: replies.filter((r) => r.t === 'error') };
}

/** Weighted centroid of the pixels near `rgb` (a marker), in the target's pixels. */
function centroid(
  d: Uint8ClampedArray,
  w: number,
  rgb: [number, number, number],
): [number, number] | undefined {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.abs(d[i]! - rgb[0]) + Math.abs(d[i + 1]! - rgb[1]) + Math.abs(d[i + 2]! - rgb[2]);
    if (dist > 150) continue;
    const wgt = 1 - dist / 150;
    const p = i / 4;
    sx += (p % w) * wgt;
    sy += Math.floor(p / w) * wgt;
    n += wgt;
  }
  return n > 4 ? [sx / n, sy / n] : undefined;
}

function pixels(b: ImageBitmap): Uint8ClampedArray {
  const c = new OffscreenCanvas(b.width, b.height);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(b, 0, 0);
  return x.getImageData(0, 0, b.width, b.height).data;
}

export type GeometryCase = {
  name: string;
  scaled: boolean;
  cropped: boolean;
  meanDiff: number;
  psnr: number;
  /** Marker centroid distance between the two paths, px (max over the markers both show). */
  markerShift: number;
  markers: number;
};

async function geometryScenario() {
  const iw = 6000;
  const ih = 4000;
  const marks: [number, number][] = [
    [3000, 2000],
    [4700, 3100],
    [5200, 2600],
    [1500, 900],
  ];
  const blob = await photo(iw, ih, marks);
  const full = await createImageBitmap(blob);
  const targets: [string, PictureTarget][] = [
    ['cover 1080p', pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'cover' }, 1)!],
    [
      'crop, stretched, sub-pixel box',
      pictureTarget(
        { box: box(100.3, 50.6, 480.2, 270.1), fit: 'stretch', crop: { l: 0.6, t: 0.5, r: 0.1, b: 0.1 } },
        1,
      )!,
    ],
    ['contain, sub-pixel box', pictureTarget({ box: box(300.7, 120.2, 800.4, 600.3), fit: 'contain' }, 1)!],
    ['cover overflowing', pictureTarget({ box: box(-400, -300, 1400, 900), fit: 'cover' }, 1)!],
  ];
  const colours: [number, number, number][] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 0, 255],
  ];
  const cases: GeometryCase[] = [];
  for (const [name, t] of targets) {
    const d = createDecoder({
      read: async () => ({ blob, source: 'opfs' }),
      createImageBitmap: (...a: unknown[]) =>
        (createImageBitmap as (...b: unknown[]) => Promise<ImageBitmap>)(...a),
      ImageDecoder: (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder,
    });
    const want = preparePicture(full, t)!;
    const src = await d.decode('photo', { targets: [t] });
    const got = d.prepare(src, t)!;
    src.close();
    const a = pixels(want);
    const b = pixels(got);
    let sum = 0;
    let se = 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      if ((i & 3) === 3) continue;
      const e = Math.abs(a[i]! - b[i]!);
      sum += e;
      se += e * e;
      n++;
    }
    let shift = 0;
    let seen = 0;
    for (const c of colours) {
      const p = centroid(a, t.w, c);
      const q = centroid(b, t.w, c);
      if (!p || !q) continue;
      seen++;
      shift = Math.max(shift, Math.hypot(p[0] - q[0], p[1] - q[1]));
    }
    cases.push({
      name,
      scaled: d.stats.scaled > 0,
      cropped: d.stats.cropped > 0,
      meanDiff: sum / n,
      psnr: se ? 10 * Math.log10((255 * 255 * n) / se) : Number.POSITIVE_INFINITY,
      markerShift: shift,
      markers: seen,
    });
    want.close();
    got.close();
  }
  // Bands: a 4K cover target, a sub-pixel one, masked and mirrored ones and a turned masked one, in bands of
  // 2^19 pixels, against one pass.
  const bands: { name: string; differing: number; steps: number; levels: number }[] = [];
  for (const [name, t] of [
    ['4K cover', pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'cover' }, 2)!],
    ['sub-pixel contain', pictureTarget({ box: box(300.7, 120.2, 800.4, 600.3), fit: 'contain' }, 2)!],
    [
      'ellipse mask, mirrored',
      pictureTarget(
        { box: box(200.5, 100, 1200, 900), fit: 'stretch', mask: { preset: 'ellipse' }, flipH: true },
        2,
      )!,
    ],
    [
      'star mask, mirrored, cropped',
      pictureTarget(
        {
          box: box(-150, 140.3, 1300, 800),
          fit: 'cover',
          crop: { l: 0.1, t: 0, r: 0.2, b: 0.1 },
          mask: { preset: 'star5' },
          flipV: true,
        },
        2,
      )!,
    ],
    [
      'turned star mask',
      pictureTarget(
        {
          box: { ...box(300, 200, 900, 700), rotation: 30 },
          fit: 'cover',
          mask: { preset: 'star5' },
          flipV: true,
        },
        2,
      )!,
    ],
  ] as const) {
    const one = pixels(preparePicture(full, t)!);
    const g = preparePictureSteps(full, t, undefined, 1 << 19);
    let steps = 1;
    let r = g.next();
    while (!r.done) {
      steps++;
      r = g.next();
    }
    const banded = pixels(r.value!);
    let differing = 0;
    let levels = 0;
    for (let i = 0; i < one.length; i += 4) {
      let d = Math.abs(one[i + 3]! - banded[i + 3]!);
      for (let c = 0; c < 3; c++)
        d = Math.max(
          d,
          Math.round(Math.abs(one[i + c]! * one[i + 3]! - banded[i + c]! * banded[i + 3]!) / 255),
        );
      if (one[i] !== banded[i] || one[i + 1] !== banded[i + 1] || one[i + 2] !== banded[i + 2] || d)
        differing++;
      levels = Math.max(levels, d);
    }
    bands.push({ name, differing, steps, levels });
  }
  full.close();
  return { cases, bands };
}

export type DecodeTiming = {
  source: string;
  output: string;
  path: 'whole' | 'crop-aware';
  /** Median over the repetitions: decode and prepare, and the longest task of the thread meanwhile. */
  ms: number;
  longestTaskMs: number;
  scaled: boolean;
};

/**
 * Decode and prepare a full-frame cover picture both ways (`bench/lanes.ts`): the whole file then
 * `preparePicture`, and the crop-aware decoder. The longest task is the longest gap of a 1 ms timer chain
 * running meanwhile on the same thread, which is what a props job would have waited behind.
 */
async function decodeScenario(reps: number): Promise<DecodeTiming[]> {
  const out: DecodeTiming[] = [];
  for (const [w, h] of [
    [3840, 2160],
    [6000, 4000],
  ] as const) {
    const blob = await photo(w, h);
    for (const scale of [1, 2]) {
      const t = pictureTarget({ box: box(0, 0, 1920, 1080), fit: 'cover' }, scale)!;
      const ms: Record<'whole' | 'crop-aware', number[]> = { whole: [], 'crop-aware': [] };
      const gaps: Record<'whole' | 'crop-aware', number[]> = { whole: [], 'crop-aware': [] };
      let scaled = false;
      // The two paths alternate, so a drift of the machine's load affects both alike.
      for (let r = 0; r < reps; r++)
        for (const path of r % 2 ? (['crop-aware', 'whole'] as const) : (['whole', 'crop-aware'] as const)) {
          await sleep(30);
          let last = performance.now();
          let longest = 0;
          let on = true;
          const tick = () => {
            if (!on) return;
            const now = performance.now();
            longest = Math.max(longest, now - last);
            last = now;
            setTimeout(tick, 1);
          };
          setTimeout(tick, 1);
          const t0 = performance.now();
          let bmp: ImageBitmap;
          if (path === 'whole') {
            const full = await createImageBitmap(blob);
            bmp = preparePicture(full, t)!;
            full.close();
          } else {
            const d = createDecoder({
              read: async () => ({ blob, source: 'opfs' }),
              createImageBitmap: (...a: unknown[]) =>
                (createImageBitmap as (...b: unknown[]) => Promise<ImageBitmap>)(...a),
              ImageDecoder: (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder,
            });
            const src = await d.decode('x', { targets: [t] });
            bmp = d.prepare(src, t)!;
            src.close();
            scaled = d.stats.scaled > 0;
          }
          ms[path].push(performance.now() - t0);
          await sleep(5);
          on = false;
          gaps[path].push(longest);
          bmp.close();
        }
      const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
      for (const path of ['whole', 'crop-aware'] as const)
        out.push({
          source: `${w}x${h}`,
          output: scale === 1 ? '1080p' : '4K',
          path,
          ms: med(ms[path]),
          longestTaskMs: med(gaps[path]),
          scaled: path === 'crop-aware' && scaled,
        });
    }
  }
  return out;
}

(window as unknown as { __lanes: unknown }).__lanes = {
  props: propsScenario,
  geometry: geometryScenario,
  decodes: decodeScenario,
};
