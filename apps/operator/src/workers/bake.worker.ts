/// <reference lib="webworker" />
import { BitmapCache } from '@ordo/renderer';
import { bakeSlide, bakeSlides, createBakeEnv, encodePicture, failureText } from '@ordo/renderer/bake.ts';
import { createDecoder } from '../../../output/src/decode.ts';
import { framePictures } from '../../../output/src/prepare/frame.ts';
import { jobSlides, prepareSlides } from '../../../output/src/prepare/index.ts';
import '../../../output/src/prepare/tables.ts';
import { setGeometryUnits } from '../../../output/src/prepare/units.ts';
import {
  type BakeIn,
  type BakeJobDeps,
  type BakeOut,
  createBakeRunner,
  createFileReader,
} from './bakeJob.ts';

/**
 * The bake worker (design/29 section 1.4, design/25 "Operator window"): makes ONE picture of one slide at a time with
 * the renderer's own `bakeSlide` and `encodePicture`, from library fonts only, and hands the blobs back. The main
 * thread never rasterizes. This is the only file of the bake that touches `self`: everything it does is in
 * `bakeJob.ts` behind dependencies, so the job is tested in node and the real worker runs in the e2e spec.
 *
 * Unlike the thumbnail worker it is NOT under the supervisor: it is a one-shot, created for a sweep and terminated
 * at its hard deadline, at a cancel, at Go live and 30 seconds after its last picture, and a restart by missed
 * heartbeats would race the deadline kill. It decodes pictures with the output app's decoder (a picture must be
 * what the screens draw), not the thumbnail worker's 640-pixel decode.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope & { fonts?: FontFaceSet };
const urls = new Map<string, string>();

const fileBlob = createFileReader({
  caches:
    typeof caches === 'undefined'
      ? undefined
      : (caches as unknown as Parameters<typeof createFileReader>[0]['caches']),
  fetch: (url, init) => fetch(url, init),
});

// The bake's font environment: the library's faces and the bundled ones, and a blank face last; never a face of
// the computer that makes the picture.
const env = createBakeEnv({
  set: scope.fonts,
  async data(f) {
    const b = await fileBlob(f.hash, urls.get(f.hash));
    if (!b) throw new Error('file unavailable');
    return b.arrayBuffer();
  },
});

const deps: BakeJobDeps = {
  env: env as unknown as BakeJobDeps['env'],
  bakeSlides,
  bakeSlide,
  encodePicture,
  failureText,
  prepareSlides,
  jobSlides,
  setGeometryUnits,
  fileBlob: (hash) => fileBlob(hash, urls.get(hash)),
  createDecoder: (d) => createDecoder(d as unknown as Parameters<typeof createDecoder>[0]),
  framePictures: (d) => framePictures(d as unknown as Parameters<typeof framePictures>[0]),
  createBitmapCache: () => {
    const cache = new BitmapCache<ImageBitmap>();
    return {
      cache,
      dispose: () => {
        cache.unpinAll();
        cache.prune(new Set());
      },
    };
  },
  createImageBitmap: (...a: unknown[]) =>
    (createImageBitmap as (...b: unknown[]) => Promise<ImageBitmap>)(...a),
  ImageDecoder: typeof ImageDecoder === 'undefined' ? undefined : ImageDecoder,
  post: (m: BakeOut) => scope.postMessage(m),
  now: () => performance.now(),
  yieldNow: () => new Promise<void>((r) => setTimeout(r, 0)),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  log: (line) => console.warn(line),
};

const runner = createBakeRunner(deps);

scope.onmessage = (ev: MessageEvent<BakeIn>) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'fonts':
      for (const f of m.fonts) urls.set(f.hash, f.url);
      runner.setFonts(m.fonts);
      return;
    case 'bake':
      void runner.run(m.job);
      return;
    case 'cancel':
      runner.cancel(m.id);
      return;
    case 'decoded':
      runner.decoded(m.seq, m.bitmap);
      return;
    case 'media':
      runner.media(m.id, m.files);
      return;
  }
};
