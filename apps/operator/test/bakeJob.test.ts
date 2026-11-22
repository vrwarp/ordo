/**
 * The job runner of the bake worker (apps/operator/src/workers/bakeJob.ts), driven with fakes for every dependency
 * (J1 to J10) and for a slide kept in a slide file (JF1 to JF8, Q54). The real worker runs only in the e2e spec and
 * in the measures: a worker file has side effects on import and cannot be unit tested, so everything it does is
 * here, behind dependencies.
 */
import type { Slide } from '@ordo/domain';
import { pictureSource, prerenderKey } from '@ordo/domain/prerender.ts';
import { SLIDE_FILE_LIMITS, slideFileOf } from '@ordo/domain/slidefile.ts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BAKE_JOB_DEADLINE_MS, FILE_READ_DEADLINE_MS } from '../src/services/bakeConsts.ts';
import {
  type BakeFont,
  type BakeJobDeps,
  type BakeJobIn,
  type BakeOut,
  createBakeRunner,
  createFileReader,
  FILE_PART_MAX_BYTES,
  PAGE_ANSWER_MS,
} from '../src/workers/bakeJob.ts';

// ---- fixtures ----

const rect = (i: number) => ({
  id: `r${i}`,
  type: 'shape',
  box: { x: (i % 40) * 40, y: Math.floor(i / 40) * 40, w: 30, h: 30, rotation: 0 },
  shape: 'rect',
  fill: { r: 200, g: 0, b: 0, a: 1 },
  opacity: 1,
  radius: 0,
});
const image = (id: string, mediaId: string) => ({
  id,
  type: 'image',
  box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
  mediaId,
  fit: 'contain',
  opacity: 1,
  radius: 0,
});
const heavySlide = (n = 250): Slide =>
  ({
    id: 's1',
    objects: [...Array.from({ length: n }, (_, i) => rect(i)), image('pic', 'photo')],
    prerender: { why: ['count'], live: [] },
  }) as unknown as Slide;

const FONT: BakeFont = {
  family: 'Inter',
  weight: 400,
  style: 'normal',
  hash: 'inter-regular',
  url: 'https://hub/f/inter',
};

function job(over: Partial<BakeJobIn> = {}): BakeJobIn {
  return {
    kind: 'slide',
    id: 1,
    presentationId: 'p',
    slideId: 's1',
    key: 'k1',
    slide: heavySlide(),
    live: [],
    images: { photo: 'photo-file' },
    deadlineMs: BAKE_JOB_DEADLINE_MS,
    standIns: 'allow',
    madeBy: 'operator 0.10.0 operate Linux',
    ...over,
  };
}

type Timer = { fn: () => void; ms: number; id: number; dead: boolean };

/** Every dependency a fake; each call is written in `calls` in order. */
function harness(over: Partial<BakeJobDeps> = {}) {
  const posts: BakeOut[] = [];
  const calls: string[] = [];
  const blobs = new Map<string, Blob>();
  const canvas = { width: 3840 };
  let disposed = 0;
  let decoderDeps: Parameters<BakeJobDeps['createDecoder']>[0] | undefined;
  let frameDeps: Parameters<BakeJobDeps['framePictures']>[0] | undefined;
  let bakeOpts: Parameters<BakeJobDeps['bakeSlide']>[1] | undefined;
  let bakedSlide: Slide | undefined;
  let prepared: { slides: readonly Slide[]; scale: number } | undefined;
  let clock = 0;
  const timers: Timer[] = [];
  let timerSeq = 0;
  const state = {
    gate: undefined as Promise<void> | undefined,
    sync: 0,
  };
  const deps: BakeJobDeps = {
    env: {
      fonts: {
        sync: async () => {
          state.sync++;
          calls.push('sync');
        },
      },
      ready: async () => {
        calls.push('ready');
        return true;
      },
    },
    bakeSlides: ((slide: Slide) => {
      calls.push('bakeSlides');
      return { slide: { ...slide, objects: [] }, under: [{ id: 'u1', objects: [] }] };
    }) as never,
    bakeSlide: (async (slide: Slide, opts: Parameters<BakeJobDeps['bakeSlide']>[1]) => {
      calls.push('bakeSlide');
      bakedSlide = slide;
      bakeOpts = opts;
      if (state.gate) await state.gate;
      return {
        ok: true,
        canvas,
        opaque: true,
        width: 3840,
        height: 2160,
        standIns: ['carlito'],
        dropped: 0,
        stats: { ms: { draw: 5, total: 9 }, objects: 1, turns: 1, longestTurn: 1 },
      };
    }) as never,
    encodePicture: (async () => {
      calls.push('encode');
      canvas.width = 0;
      return {
        ok: true,
        opaque: true,
        stats: { ms: { png3840: 3 } },
        pictures: [
          { size: 1920, width: 1920, height: 1080, type: 'image/png', blob: new Blob(['a']), bytes: 1 },
          { size: 3840, width: 3840, height: 2160, type: 'image/png', blob: new Blob(['bb']), bytes: 2 },
          { size: 640, width: 640, height: 360, type: 'image/webp', blob: new Blob(['ccc']), bytes: 3 },
        ],
      };
    }) as never,
    failureText: ((f: { reason: string; detail: string }) =>
      f.detail ? `${f.reason}: ${f.detail}` : f.reason) as never,
    prepareSlides: (async (j: { slides: readonly Slide[]; scale: number }) => {
      calls.push('prepare');
      prepared = j;
      return [];
    }) as never,
    jobSlides: ((j: { slide?: Slide }, u: readonly Slide[] = []) => [
      ...(j.slide ? [j.slide] : []),
      ...u,
    ]) as never,
    setGeometryUnits: (on) => {
      calls.push(`units:${on}`);
    },
    fileBlob: async (hash) => blobs.get(hash),
    createDecoder: (d) => {
      decoderDeps = d;
      return 'decoder';
    },
    framePictures: (d) => {
      frameDeps = d;
      return 'pictures';
    },
    createBitmapCache: () => ({
      cache: 'cache',
      dispose: () => {
        disposed++;
      },
    }),
    createImageBitmap: 'cib',
    post: (m) => {
      posts.push(m);
    },
    now: () => clock,
    yieldNow: async () => undefined,
    setTimer: (fn, ms) => {
      const t: Timer = { fn, ms, id: ++timerSeq, dead: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as Timer).dead = true;
    },
    ...over,
  };
  const runner = createBakeRunner(deps);
  const fire = (atLeastMs: number) => {
    for (const t of timers)
      if (!t.dead && t.ms >= atLeastMs) {
        t.dead = true;
        t.fn();
      }
  };
  const failed = () => posts.filter((p) => p.t === 'failed') as Extract<BakeOut, { t: 'failed' }>[];
  const made = () => posts.filter((p) => p.t === 'made') as Extract<BakeOut, { t: 'made' }>[];
  return {
    deps,
    runner,
    posts,
    calls,
    blobs,
    canvas,
    timers,
    fire,
    failed,
    made,
    state,
    tick: (ms: number) => {
      clock += ms;
    },
    get disposed() {
      return disposed;
    },
    get decoderDeps() {
      return decoderDeps;
    },
    get frameDeps() {
      return frameDeps;
    },
    get bakeOpts() {
      return bakeOpts;
    },
    get bakedSlide() {
      return bakedSlide;
    },
    get prepared() {
      return prepared;
    },
  };
}

/** Lets the pending promises of the runner run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

// ---- J1, J2 order and success ----

describe('the order of a job and its success (J1, J2)', () => {
  it('J1 syncs the fonts and awaits the blank face before the first bake; units once; the options', async () => {
    const h = harness();
    h.runner.setFonts([FONT]);
    await h.runner.run(job());
    const at = (c: string) => h.calls.indexOf(c);
    expect(at('sync')).toBeGreaterThanOrEqual(0);
    expect(at('sync')).toBeLessThan(at('ready'));
    expect(at('ready')).toBeLessThan(at('bakeSlide'));
    expect(at('units:true')).toBeLessThan(at('bakeSlides'));
    expect(at('bakeSlides')).toBeLessThan(at('prepare'));
    expect(at('prepare')).toBeLessThan(at('bakeSlide'));
    expect(at('bakeSlide')).toBeLessThan(at('encode'));
    // the prepare steps run over the slides the renderer named, at scale 2
    expect(h.prepared?.scale).toBe(2);
    expect(h.prepared?.slides.map((s) => s.id)).toEqual(['s1', 'u1']);
    // what bakeSlide is given
    expect(h.bakeOpts).toMatchObject({
      scale: 2,
      deadlineMs: 60000,
      standIns: 'allow',
      live: [],
      pictures: 'pictures',
    });
    expect(h.bakeOpts?.env).toBe(h.deps.env);
    expect(typeof h.bakeOpts?.cancelled).toBe('function');
    expect(h.bakeOpts?.cancelled?.()).toBe(false);
    // the frame provider over the output app's decoder, at 3840x2160, the job's own images
    expect(h.frameDeps).toMatchObject({
      cache: 'cache',
      decoder: 'decoder',
      images: { photo: 'photo-file' },
      out: { w: 3840, h: 2160 },
    });
    expect(typeof h.frameDeps?.steps.slice).toBe('function');
    expect(typeof h.frameDeps?.steps.check).toBe('function');
    expect(h.decoderDeps).toMatchObject({ createImageBitmap: 'cib' });
    expect(typeof h.decoderDeps?.rasterSvg).toBe('function');
    // a second job: no new sync, no second unit switch
    await h.runner.run(job({ id: 2 }));
    expect(h.calls.filter((c) => c === 'sync')).toHaveLength(1);
    expect(h.calls.filter((c) => c === 'units:true')).toHaveLength(1);
  });

  it('J2 posts the phases, then one made with the pictures in the encoder order; the canvas and the bitmaps are closed', async () => {
    const h = harness();
    await h.runner.run(job());
    expect(h.posts.map((p) => p.t)).toEqual(['phase', 'phase', 'phase', 'made']);
    expect(h.posts.filter((p) => p.t === 'phase').map((p) => (p as { phase: string }).phase)).toEqual([
      'files',
      'drawing',
      'encoding',
    ]);
    const [m] = h.made();
    expect(m?.id).toBe(1);
    expect(m?.pictures.map((p) => [p.size, p.type, p.bytes])).toEqual([
      [1920, 'image/png', 1],
      [3840, 'image/png', 2],
      [640, 'image/webp', 3],
    ]);
    expect(m?.opaque).toBe(true);
    expect(m?.standIns).toEqual(['carlito']);
    expect(m?.ms).toMatchObject({ draw: 5, png3840: 3 });
    expect(h.canvas.width).toBe(0);
    expect(h.disposed).toBe(1);
    expect(h.runner.busy).toBe(false);
  });
});

// ---- J3 reasons ----

describe('every reason is a failed message and nothing else (J3)', () => {
  const BAKE: string[] = [
    'profile',
    'busy',
    'animated',
    'cut',
    'files',
    'font',
    'coverage',
    'media',
    'draw',
    'fonts',
    'frame',
    'canvas',
    'blank',
    'time',
    'cancelled',
  ];
  for (const reason of BAKE)
    it(`the renderer's "${reason}" is posted with its detail and its line, and nothing is encoded`, async () => {
      const h = harness({
        bakeSlide: (async () => ({
          ok: false,
          reason,
          detail: `the ${reason} detail`,
          stats: { ms: {}, objects: 0, turns: 0, longestTurn: 0 },
        })) as never,
      });
      await h.runner.run(job());
      expect(h.failed()).toEqual([
        {
          t: 'failed',
          id: 1,
          reason,
          detail: `the ${reason} detail`,
          text: `${reason}: the ${reason} detail`,
        },
      ]);
      expect(h.made()).toEqual([]);
      expect(h.calls).not.toContain('encode');
      expect(h.disposed).toBe(1);
    });

  for (const reason of ['size', 'verify', 'canvas'])
    it(`the encoder's "${reason}" is posted and the canvas is closed`, async () => {
      const h = harness({
        encodePicture: (async () => ({
          ok: false,
          reason,
          detail: 'the encoder said so',
          stats: { ms: {} },
        })) as never,
      });
      await h.runner.run(job());
      expect(h.failed()).toEqual([
        { t: 'failed', id: 1, reason, detail: 'the encoder said so', text: `${reason}: the encoder said so` },
      ]);
      expect(h.made()).toEqual([]);
      expect(h.canvas.width).toBe(0);
      expect(h.disposed).toBe(1);
    });
});

// ---- J4 throws ----

describe('a bad slide never kills the worker (J4)', () => {
  const THROWERS = ['prepare', 'bake', 'encode', 'cache', 'bakeSlides', 'fonts'] as const;
  const harnessThrowing = (where: (typeof THROWERS)[number], err: Error) => {
    const boom = async () => {
      throw err;
    };
    return harness({
      ...(where === 'prepare' ? { prepareSlides: boom as never } : {}),
      ...(where === 'bake' ? { bakeSlide: boom as never } : {}),
      ...(where === 'encode' ? { encodePicture: boom as never } : {}),
      ...(where === 'cache'
        ? {
            createBitmapCache: () => {
              throw err;
            },
          }
        : {}),
      ...(where === 'bakeSlides'
        ? {
            bakeSlides: (() => {
              throw err;
            }) as never,
          }
        : {}),
      ...(where === 'fonts' ? { env: { fonts: { sync: boom }, ready: async () => true } } : {}),
    });
  };

  for (const where of THROWERS)
    it(`a throw in ${where} is a failed "draw", the runner returns normally and makes the next picture`, async () => {
      const h = harnessThrowing(where, new TypeError('secret slide text in a message'));
      h.runner.setFonts([FONT]);
      await h.runner.run(job());
      expect(h.failed()).toHaveLength(1);
      expect(h.failed()[0]).toMatchObject({ id: 1, reason: 'draw' });
      // the fault's name, never its message
      expect(h.failed()[0]?.detail).toBe('TypeError');
      expect(JSON.stringify(h.posts)).not.toContain('secret slide text');
      expect(h.runner.busy).toBe(false);
      expect(h.canvas.width === 0 || h.canvas.width === 3840).toBe(true);
    });

  it('a file that is not there when the decoder reads it is a failed "files" (the page may have it a moment later)', async () => {
    const h = harness();
    h.deps.bakeSlide = (async () => {
      await h.decoderDeps?.read('abcdef0123456789');
      throw new Error('not reached');
    }) as never;
    await h.runner.run(job());
    expect(h.failed()[0]).toMatchObject({ reason: 'files' });
    expect(h.failed()[0]?.detail).toContain('abcdef01');
  });

  it('property: wherever and whatever it throws, exactly one failed, no throw out of run, and the worker is free again', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...THROWERS),
        fc.oneof(
          fc.constant(new Error('x')),
          fc.constant(new RangeError('y')),
          fc.constant(Object.assign(new Error('z'), { name: 'Weird' })),
        ),
        async (where, err) => {
          const h = harnessThrowing(where, err);
          await h.runner.run(job());
          expect(h.failed()).toHaveLength(1);
          expect(h.made()).toEqual([]);
          expect(h.runner.busy).toBe(false);
          await h.runner.run(job({ id: 2 }));
          expect(h.runner.busy).toBe(false);
        },
      ),
      { numRuns: 40 },
    );
  });
});

// ---- J5, J6 cancel and busy ----

describe('cancel and one at a time (J5, J6)', () => {
  it('J5 a cancel is seen by the bake, the result is "cancelled", and the next job runs normally', async () => {
    const g = gate();
    const h = harness();
    h.state.gate = g.p;
    h.deps.bakeSlide = (async (_s: Slide, opts: { cancelled?: () => boolean }) => {
      h.calls.push('bakeSlide');
      await g.p;
      return opts.cancelled?.()
        ? {
            ok: false,
            reason: 'cancelled',
            detail: 'stopped',
            stats: { ms: {}, objects: 0, turns: 0, longestTurn: 0 },
          }
        : {
            ok: true,
            canvas: h.canvas,
            opaque: true,
            width: 3840,
            height: 2160,
            standIns: [],
            dropped: 0,
            stats: { ms: {} },
          };
    }) as never;
    const first = h.runner.run(job());
    await settle();
    expect(h.runner.busy).toBe(true);
    h.runner.cancel(1);
    g.open();
    await first;
    expect(h.failed()).toEqual([
      { t: 'failed', id: 1, reason: 'cancelled', detail: 'stopped', text: 'cancelled: stopped' },
    ]);
    expect(h.runner.busy).toBe(false);
    // a cancel of one job does not stop the next
    h.state.gate = undefined;
    h.deps.bakeSlide = (async () => ({
      ok: true,
      canvas: h.canvas,
      opaque: true,
      width: 3840,
      height: 2160,
      standIns: [],
      dropped: 0,
      stats: { ms: {} },
    })) as never;
    await h.runner.run(job({ id: 2 }));
    expect(h.made().map((m) => m.id)).toEqual([2]);
  });

  it('J5 the prepare steps see the cancel too: the host check throws and the job ends "cancelled"', async () => {
    const h = harness({
      prepareSlides: (async (_j: unknown, host: { check(): void }) => {
        host.check();
        return [];
      }) as never,
    });
    h.runner.cancel(1);
    await h.runner.run(job());
    expect(h.failed()).toEqual([expect.objectContaining({ id: 1, reason: 'cancelled' })]);
    expect(h.calls).not.toContain('bakeSlide');
  });

  it('J6 a second bake while one runs answers busy for the second and leaves the first alone', async () => {
    const g = gate();
    const h = harness();
    h.state.gate = g.p;
    const first = h.runner.run(job());
    await settle();
    await h.runner.run(job({ id: 2 }));
    expect(h.failed()).toEqual([expect.objectContaining({ id: 2, reason: 'busy' })]);
    g.open();
    await first;
    expect(h.made().map((m) => m.id)).toEqual([1]);
    expect(h.failed()).toHaveLength(1);
    expect(h.runner.busy).toBe(false);
  });
});

// ---- J7 files and SVG ----

describe('files and SVG (J7)', () => {
  const blob = new Blob(['x']);
  const response = (ok: boolean) => ({ ok, blob: async () => blob });

  it('reads the service-file cache first, then the hub with the session cookie; a miss, a 404 and an error are undefined', async () => {
    const urls: string[] = [];
    const inits: unknown[] = [];
    const reader = (cache: 'hit' | 'miss' | 'throws', fetchResult: 'ok' | '404' | 'throws') =>
      createFileReader({
        caches: {
          open: async () => {
            if (cache === 'throws') throw new Error('no Cache API');
            return {
              match: async (req: string) =>
                cache === 'hit' ? { blob: async () => new Blob([req]) } : undefined,
            };
          },
        },
        fetch: async (url, init) => {
          urls.push(url);
          inits.push(init);
          if (fetchResult === 'throws') throw new Error('offline');
          return response(fetchResult === 'ok');
        },
      });
    const hit = await reader('hit', 'ok')('abc');
    expect(await hit?.text()).toBe('/__ordo_cache/abc');
    expect(urls).toEqual([]);
    expect(await reader('miss', 'ok')('abc')).toBe(blob);
    expect(urls).toEqual(['/api/v1/files/abc']);
    expect(inits[0]).toEqual({ credentials: 'same-origin' });
    expect(await reader('throws', 'ok')('abc', 'https://hub/api/v1/files/abc')).toBe(blob);
    expect(urls[1]).toBe('https://hub/api/v1/files/abc');
    expect(await reader('miss', '404')('abc')).toBeUndefined();
    expect(await reader('miss', 'throws')('abc')).toBeUndefined();
    expect(await createFileReader({ fetch: async () => response(true) })('abc')).toBe(blob);
  });

  it('a file the reader cannot find is "missing" for the frame provider, so the picture is reported as media not as a draw fault', async () => {
    const h = harness();
    h.deps.bakeSlide = (async () => {
      await settle();
      return { ok: false, reason: 'media', detail: 'file abcdef01', stats: { ms: {} } };
    }) as never;
    const run = h.runner.run(job());
    await settle();
    await expect(h.decoderDeps?.read('abcdef0123')).rejects.toThrow(/unavailable/);
    let err: unknown;
    try {
      await h.decoderDeps?.read('abcdef0123');
    } catch (e) {
      err = e;
    }
    expect(h.frameDeps?.isMissing(err)).toBe(true);
    expect(h.frameDeps?.isMissing(new Error('bad image'))).toBe(false);
    h.blobs.set('present', new Blob(['png']));
    expect(await h.frameDeps?.has('present')).toBe(true);
    expect(await h.frameDeps?.has('absent')).toBe(false);
    expect((await h.decoderDeps?.read('present'))?.source).toBeDefined();
    await run;
    expect(h.failed()[0]).toMatchObject({ reason: 'media' });
  });

  it('an SVG the worker cannot decode is drawn by the page: a decode message, the bitmap back; no answer or no bitmap is a rejection', async () => {
    const g = gate();
    const h = harness();
    h.state.gate = g.p;
    const run = h.runner.run(job());
    await settle();
    const svg = new Blob(['<svg/>']);
    const ok = h.decoderDeps?.rasterSvg?.('h1', svg);
    const none = h.decoderDeps?.rasterSvg?.('h2', svg);
    const slow = h.decoderDeps?.rasterSvg?.('h3', svg);
    const asked = h.posts.filter((p) => p.t === 'decode') as Extract<BakeOut, { t: 'decode' }>[];
    expect(asked.map((a) => [a.id, a.hash, a.blob])).toEqual([
      [1, 'h1', svg],
      [1, 'h2', svg],
      [1, 'h3', svg],
    ]);
    const bmp = { close: () => undefined } as unknown as ImageBitmap;
    h.runner.decoded(asked[0]?.seq as number, bmp);
    h.runner.decoded(asked[1]?.seq as number, undefined);
    await expect(ok).resolves.toBe(bmp);
    await expect(none).rejects.toThrow();
    // an answer for nobody is ignored and its bitmap closed
    let closed = 0;
    h.runner.decoded(9999, { close: () => closed++ } as unknown as ImageBitmap);
    expect(closed).toBe(1);
    // no answer within 15 s
    expect(h.timers.some((t) => t.ms === PAGE_ANSWER_MS && !t.dead)).toBe(true);
    h.fire(PAGE_ANSWER_MS);
    await expect(slow).rejects.toThrow(/in time/);
    g.open();
    await run;
  });
});

// ---- J8, J10 kinds and records ----

describe('what this build makes (J8, J10, H-W4)', () => {
  it('J8 an unknown kind (a plate, later) is refused with the reason "kind" and nothing is drawn', async () => {
    const h = harness();
    await h.runner.run({ ...job(), kind: 'plate' } as unknown as BakeJobIn);
    expect(h.failed()).toEqual([expect.objectContaining({ id: 1, reason: 'kind' })]);
    expect(h.failed()[0]?.text).toMatch(/^kind: /);
    expect(h.calls).toEqual([]);
  });

  it('J10 a slide with no record is "kind": there is nothing to make', async () => {
    const h = harness();
    const { prerender: _, ...bare } = heavySlide();
    await h.runner.run(job({ slide: bare as Slide }));
    expect(h.failed()).toEqual([expect.objectContaining({ reason: 'kind' })]);
    expect(h.calls).not.toContain('bakeSlide');
  });
});

// ---- J9 fonts ----

describe('fonts (J9)', () => {
  it('the same list is not synced again; a changed list is synced before the next bake', async () => {
    const h = harness();
    h.runner.setFonts([FONT]);
    await h.runner.run(job());
    h.runner.setFonts([{ ...FONT }]);
    await h.runner.run(job({ id: 2 }));
    expect(h.state.sync).toBe(1);
    h.runner.setFonts([FONT, { ...FONT, weight: 700, hash: 'inter-bold' }]);
    await h.runner.run(job({ id: 3 }));
    expect(h.state.sync).toBe(2);
    expect(h.calls.lastIndexOf('sync')).toBeLessThan(h.calls.lastIndexOf('bakeSlide'));
    // a font list that is not a list is an empty one
    h.runner.setFonts(undefined as never);
    await h.runner.run(job({ id: 4 }));
    expect(h.made()).toHaveLength(4);
  });
});

// ---- JF1 to JF8: a slide kept in a slide file (Q54) ----

describe('a slide kept in a slide file (JF1-JF8, Q54)', () => {
  const FILES: Record<string, string> = { photo: 'photo-file' };

  function fileJob(n = 1357) {
    const full: Slide = {
      id: 's1',
      objects: [...Array.from({ length: n }, (_, i) => rect(i)), image('pic', 'photo')],
      prerender: { why: ['count'], live: [] },
    } as unknown as Slide;
    const file = slideFileOf(full);
    const standIn: Slide = {
      id: 's1',
      objects: full.objects.slice(0, 200),
      prerender: { why: ['count'], live: [], file: { ref: file.name, bytes: file.bytes } },
    } as unknown as Slide;
    const listedKey = prerenderKey(
      pictureSource(full, [], {
        mediaFile: (m) => FILES[m],
        fonts: [{ family: FONT.family, file: { hash: FONT.hash } }],
      }),
    );
    return { full, file, standIn, listedKey };
  }

  function fileHarness(f: ReturnType<typeof fileJob>, over: Partial<BakeJobDeps> = {}) {
    const order: string[] = [];
    let inflight = 0;
    let most = 0;
    const store = new Map<string, string>([[f.file.name, JSON.stringify(f.file.head)]]);
    for (const p of f.file.pages) store.set(p.name, JSON.stringify(p.page));
    const h = harness({
      fileBlob: async (hash) => {
        inflight++;
        most = Math.max(most, inflight);
        order.push(hash);
        await Promise.resolve();
        inflight--;
        const text = store.get(hash);
        return text === undefined ? undefined : new Blob([text]);
      },
      ...over,
    });
    h.runner.setFonts([FONT]);
    return { h, order, store, most: () => most };
  }

  const jobOf = (f: ReturnType<typeof fileJob>, over: Partial<BakeJobIn> = {}): BakeJobIn =>
    job({
      slide: f.standIn,
      images: {},
      key: f.listedKey,
      file: { ref: f.file.name, listedKey: f.listedKey, bytes: f.file.bytes },
      ...over,
    });

  /** Answers the worker's question about the files of the slide's pictures, as the page does. */
  const answerMedia = (h: ReturnType<typeof harness>) => {
    const iv = setInterval(() => {
      const ask = h.posts.find((p) => p.t === 'media') as Extract<BakeOut, { t: 'media' }> | undefined;
      if (ask) {
        clearInterval(iv);
        h.runner.media(
          ask.id,
          Object.fromEntries(ask.ids.filter((m) => FILES[m]).map((m) => [m, FILES[m] as string])),
        );
      }
    }, 1);
    return () => clearInterval(iv);
  };

  it('JF1 reads the head then each page, one at a time, then bakes the FULL slide, not the stand-in (JF4)', async () => {
    const f = fileJob();
    const { h, order, most } = fileHarness(f);
    const stop = answerMedia(h);
    await h.runner.run(jobOf(f));
    stop();
    expect(order).toEqual([f.file.name, ...f.file.head.pages]);
    expect(f.file.head.pages.length).toBeGreaterThanOrEqual(3);
    expect(most()).toBe(1);
    expect(h.made()).toHaveLength(1);
    expect(h.bakedSlide?.objects).toHaveLength(1358);
    expect(h.bakedSlide?.objects).not.toHaveLength(200);
  });

  it('JF1 refuses a slide file past the bounds before reading a part', async () => {
    const f = fileJob(10);
    const a = fileHarness(f);
    await a.h.runner.run(
      jobOf(f, { file: { ref: f.file.name, listedKey: f.listedKey, bytes: SLIDE_FILE_LIMITS.bytes + 1 } }),
    );
    expect(a.h.failed()[0]).toMatchObject({ reason: 'size' });
    expect(a.order).toEqual([]);
    // a head that names 130 pages, or more than 20,000 objects
    const pages = Array.from({ length: 130 }, (_, i) => i.toString(16).padStart(64, '0'));
    const b = fileHarness(f);
    b.store.set(f.file.name, JSON.stringify({ v: 1, pages, count: 10 }));
    await b.h.runner.run(jobOf(f));
    expect(b.h.failed()[0]).toMatchObject({ reason: 'draw' });
    expect(b.order).toEqual([f.file.name]);
    const c = fileHarness(f);
    c.store.set(f.file.name, JSON.stringify({ v: 1, pages: f.file.head.pages, count: 20_001 }));
    await c.h.runner.run(jobOf(f));
    expect(c.h.failed()[0]).toMatchObject({ reason: 'draw' });
    expect(c.h.calls).not.toContain('bakeSlide');
  });

  it('JF1 honours a cancel between pages', async () => {
    const f = fileJob();
    const cancelAfterFirstPage = fileHarness(f);
    const real = cancelAfterFirstPage.h.deps.fileBlob;
    let reads = 0;
    cancelAfterFirstPage.h.deps.fileBlob = async (hash) => {
      reads++;
      if (reads === 2) cancelAfterFirstPage.h.runner.cancel(1);
      return real(hash);
    };
    await cancelAfterFirstPage.h.runner.run(jobOf(f));
    expect(cancelAfterFirstPage.h.failed()[0]).toMatchObject({ reason: 'cancelled' });
    expect(reads).toBeLessThan(f.file.head.pages.length + 1);
    expect(cancelAfterFirstPage.h.calls).not.toContain('bakeSlide');
  });

  it('JF2 a part that is not the head\'s makes the job fail with "file: ..." and nothing is made', async () => {
    const f = fileJob();
    const w = fileHarness(f);
    const [first, second] = f.file.head.pages as [string, string];
    // the second page's name serves the first page's body: the content is not the name
    w.store.set(second, w.store.get(first) as string);
    await w.h.runner.run(jobOf(f));
    expect(w.h.failed()).toHaveLength(1);
    expect(w.h.failed()[0]).toMatchObject({ reason: 'draw' });
    expect(w.h.failed()[0]?.detail).toMatch(/^file: /);
    expect(w.h.made()).toEqual([]);
    expect(w.h.calls).not.toContain('bakeSlide');
  });

  it('JF3 the key is computed in the worker: equal to the hub\'s listed key it bakes, different it is "stale" and makes nothing', async () => {
    const f = fileJob(300);
    const ok = fileHarness(f);
    const stop = answerMedia(ok.h);
    await ok.h.runner.run(jobOf(f));
    stop();
    expect(ok.h.made()).toHaveLength(1);
    const stale = fileHarness(f);
    const stop2 = answerMedia(stale.h);
    await stale.h.runner.run(
      jobOf(f, { file: { ref: f.file.name, listedKey: 'a'.repeat(64), bytes: f.file.bytes } }),
    );
    stop2();
    expect(stale.h.failed()).toEqual([expect.objectContaining({ reason: 'stale' })]);
    expect(stale.h.failed()[0]?.text).toMatch(/^stale: /);
    expect(stale.h.made()).toEqual([]);
    expect(stale.h.calls).not.toContain('bakeSlide');
  });

  it('JF5 names the files through the page: one media message with the ids of the full slide; a media the library lacks is a missing picture, not a throw', async () => {
    const f = fileJob(300);
    const w = fileHarness(f);
    const stop = answerMedia(w.h);
    await w.h.runner.run(jobOf(f));
    stop();
    const asks = w.h.posts.filter((p) => p.t === 'media') as Extract<BakeOut, { t: 'media' }>[];
    expect(asks).toHaveLength(1);
    expect(asks[0]?.ids).toEqual(['photo']);
    expect(w.h.frameDeps?.images).toEqual({ photo: 'photo-file' });
    // the library lacks it: no file for that id
    const g = fileHarness(f);
    const iv = setInterval(() => {
      const ask = g.h.posts.find((p) => p.t === 'media') as Extract<BakeOut, { t: 'media' }> | undefined;
      if (ask) {
        clearInterval(iv);
        g.h.runner.media(ask.id, {});
      }
    }, 1);
    // the hub's key was made with the file: without it the key differs, so the slide is stale, not thrown
    await g.h.runner.run(jobOf(f));
    expect(g.h.failed()[0]).toMatchObject({ reason: 'stale' });
    // no answer from the page at all: "media"
    const n = fileHarness(f);
    const run = n.h.runner.run(jobOf(f));
    await settle();
    n.h.fire(PAGE_ANSWER_MS);
    await run;
    expect(n.h.failed()[0]).toMatchObject({ reason: 'media' });
  });

  it('JF6 the full slide is dropped before the encode phase and at most one part is read at a time', async () => {
    const f = fileJob(600);
    const w = fileHarness(f);
    const seen: boolean[] = [];
    const encode = w.h.deps.encodePicture;
    w.h.deps.encodePicture = ((...a: Parameters<typeof encode>) => {
      seen.push(w.h.runner.holdsSlide);
      return encode(...a);
    }) as never;
    let during = false;
    const bake = w.h.deps.bakeSlide;
    w.h.deps.bakeSlide = ((...a: Parameters<typeof bake>) => {
      during = w.h.runner.holdsSlide;
      return bake(...a);
    }) as never;
    const stop = answerMedia(w.h);
    await w.h.runner.run(jobOf(f));
    stop();
    expect(during).toBe(true);
    expect(seen).toEqual([false]);
    expect(w.h.runner.holdsSlide).toBe(false);
    expect(w.most()).toBe(1);
  });

  it("JF7 the read time counts for its own limit, not for the bake's deadline", async () => {
    const f = fileJob(300);
    const w = fileHarness(f);
    const stop = answerMedia(w.h);
    const real = w.h.deps.fileBlob;
    w.h.deps.fileBlob = async (hash) => {
      w.h.tick(10_000);
      return real(hash);
    };
    await w.h.runner.run(jobOf(f));
    stop();
    // 10 s a part, five parts: the bake still gets its whole deadline
    expect(w.h.bakeOpts?.deadlineMs).toBe(BAKE_JOB_DEADLINE_MS);
    expect(w.h.made().length + w.h.failed().length).toBe(1);
    // past the read limit (a longer file, so there are more parts to read): a "time" failure that says what was slow
    const big = fileJob(1357);
    const slow = fileHarness(big);
    const real2 = slow.h.deps.fileBlob;
    slow.h.deps.fileBlob = async (hash) => {
      slow.h.tick(FILE_READ_DEADLINE_MS / 2 + 1);
      return real2(hash);
    };
    await slow.h.runner.run(jobOf(big));
    expect(slow.h.failed()[0]).toMatchObject({ reason: 'time', detail: 'file read' });
    expect(slow.h.calls).not.toContain('bakeSlide');
  });

  it('JF8 hostile parts never throw: a page that is not JSON, a duplicate page, a page of 300 KiB, a head that is not a head', async () => {
    const f = fileJob(600);
    const [p1] = f.file.head.pages as [string, ...string[]];
    const cases: [string, (s: Map<string, string>) => void][] = [
      ['a page that is not JSON', (s) => s.set(p1, 'not json {')],
      [
        'a page of 300 KiB',
        (s) => s.set(p1, JSON.stringify({ v: 1, objects: [], pad: 'x'.repeat(FILE_PART_MAX_BYTES + 10) })),
      ],
      ['a head that is not a head', (s) => s.set(f.file.name, JSON.stringify({ hello: 'world' }))],
      ['a head that is not JSON', (s) => s.set(f.file.name, '<html>')],
      ['a duplicated page', (s) => s.set(f.file.name, JSON.stringify({ ...f.file.head, pages: [p1, p1] }))],
      [
        'a head with no pages for objects',
        (s) => s.set(f.file.name, JSON.stringify({ ...f.file.head, pages: [] })),
      ],
    ];
    for (const [name, mutate] of cases) {
      const w = fileHarness(f);
      mutate(w.store);
      await expect(w.h.runner.run(jobOf(f))).resolves.toBeUndefined();
      expect(w.h.failed(), name).toHaveLength(1);
      expect(w.h.failed()[0]?.reason, name).toBe('draw');
      expect(w.h.failed()[0]?.detail, name).toMatch(/^file: /);
      expect(w.h.made(), name).toEqual([]);
      expect(w.h.runner.busy).toBe(false);
    }
    // a part that the hub no longer has: the full copy is missing
    const gone = fileHarness(f);
    gone.store.delete(f.file.name);
    await gone.h.runner.run(jobOf(f));
    expect(gone.h.failed()[0]).toMatchObject({
      reason: 'files',
      detail: 'the full copy of this slide is missing on the hub',
    });
  });
});
