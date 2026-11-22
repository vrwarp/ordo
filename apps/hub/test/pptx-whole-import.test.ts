/**
 * Q24.b step 5 (import-whole): heavy, eligible slides stay whole through BOTH import paths, and a hub, a browser
 * parse and the demo agree on which plan an import follows (design/29 1.9, 1.10; contract C-IW3).
 *
 * - T2 the pool: `sceneTask` with `wholeSlides: true` keeps all the pictures of a slide, without keeps 16.
 * - T3 equivalence: the hub's own parse and a browser scene of the same decks store the same presentation.
 * - T4 `nativeJob` end to end: the switch (`cfg.prerender.on`, store-2's `HubConfig.prerender`, `prerenderConfig('on' | 'off')`)
 *   times LibreOffice present and absent times Q27 (`WHOLE_WITH_LIBREOFFICE`, false by default = Q27.b; a test switch below
 *   runs the other arm, Q27.a):
 *   the job decides once, passes it to the pool, the scene check and ImportCore, and says it in its result.
 * - T5 the demo builds only from a scene that does not record the option; T6 callers without it get the base plan.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Presentation, SIZE_BUDGETS, type Slide } from '@ordo/domain';
import { parsePptxScene, type PptxClientScene } from '@ordo/importers';
import { WHOLE_OBJECTS_MAX, WHOLE_SHARE_BYTES, WHOLE_WITH_LIBREOFFICE } from '@ordo/importers/pptx-core.ts';
import { pictureGuardDeck, solidPng } from '@ordo/importers/pptx-guard.test-util.ts';
import { body, buildDeck, imageRel, para, pic, run, sp } from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { comparable, diffJson } from '../../../tools/pptx-fidelity/src/equivalence.ts';
import { demoUsesScene } from '../../demo/src/hub.ts';
import { type HubConfig, prerenderConfig } from '../src/config.ts';
import type { JobCtx, JobQueue } from '../src/jobs.ts';
import type { CpuPool } from '../src/pool.ts';
import { type ClientSceneTaskInput, clientSceneTask } from '../src/pptx/clientScene.ts';
import { nativeJob } from '../src/pptx/nativeJob.ts';
import { sceneTask } from '../src/pptx/sceneTask.ts';
import type { PptxDeps, PptxNativePayload, PptxNativeResult, SceneTaskInput } from '../src/pptx/shared.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, zipDeck } from './pptx-helpers.ts';

/**
 * The other arm of Q27 as a test switch: `WHOLE_WITH_LIBREOFFICE` is a constant (false, Q27.b, the default), so the case
 * where it is true (Q27.a) is run with the job's own question (`wholeSlidesFor`) answered the other way for LibreOffice;
 * with the switch left `undefined` every call is the real one, the default included.
 */
const q27 = vi.hoisted(() => ({ keepsWithLibreOffice: undefined as boolean | undefined }));
vi.mock('@ordo/importers/pptx-core.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ordo/importers/pptx-core.ts')>();
  return {
    ...real,
    wholeSlidesFor: (o: { prerender: boolean; lo: boolean }) =>
      q27.keepsWithLibreOffice === undefined
        ? real.wholeSlidesFor(o)
        : o.prerender === true && (!o.lo || q27.keepsWithLibreOffice),
  };
});

const IN = 914_400;
/** store-2's switch (`HubConfig.prerender`, ORDO_PRERENDER) as the hub reads it: `on` or `off`. */
const prerender = (on: boolean): Partial<HubConfig> => ({ prerender: prerenderConfig(on ? 'on' : 'off') });
const NO_LO = { libreoffice: { mode: 'off', exe: '' } } as Partial<HubConfig>;

let dir: string;
const hubs: TestHub[] = [];
beforeAll(() => {
  dir = tempDir('ordo-whole-import-');
});
afterAll(async () => {
  for (const h of hubs) await h.cleanup();
  rmSync(dir, { recursive: true, force: true });
});
async function hubOf(over: Partial<HubConfig>): Promise<TestHub> {
  const h = await startHub(over);
  hubs.push(h);
  return h;
}

const imagesOf = (s: Slide) => s.objects.filter((o) => o.type === 'image');
const zipped = async (parts: Map<string, Uint8Array>) => {
  const z = new JSZip();
  for (const [k, v] of parts) z.file(k, v);
  return z.generateAsync({ type: 'uint8array' });
};
/** One slide of `n` distinct small pictures, all on the slide (a grid of 25 columns), each its own colour. */
function manyPictures(n: number) {
  let shapes = '';
  const media: Record<string, Uint8Array> = {};
  for (let i = 0; i < n; i++) {
    shapes += pic({
      id: 2 + i,
      x: (i % 25) * 0.5 * IN,
      y: Math.floor(i / 25) * 0.4 * IN,
      cx: 0.4 * IN,
      cy: 0.3 * IN,
      rId: `rId${2 + i}`,
    });
    media[`ppt/media/m${i}.png`] = solidPng(8, 8, [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256]);
  }
  const rels = Array.from({ length: n }, (_, i) => imageRel(`rId${2 + i}`, `../media/m${i}.png`));
  return buildDeck({ slides: [{ rels, shapes }], media });
}
const textDeck = () =>
  buildDeck({
    slides: [
      { shapes: sp({ id: 2, x: IN, y: IN, cx: 4 * IN, cy: IN, txBody: body(para(run('Amazing grace'))) }) },
    ],
  });

type Call = { kind: string; input: Record<string, unknown> };
/** A pool that runs the tasks in this process and writes down what each was asked. */
function poolOf(calls: Call[]): Pick<CpuPool, 'run'> {
  return {
    run: (async (kind: string, input: unknown) => {
      calls.push({ kind, input: input as Record<string, unknown> });
      return kind === 'pptx-client-scene'
        ? clientSceneTask(input as ClientSceneTaskInput)
        : sceneTask(input as SceneTaskInput);
    }) as CpuPool['run'],
  };
}
/** The follow-up queue of a hub with LibreOffice, kept from starting a real soffice: it only records. */
const quietJobs = { enqueue: () => ({ id: 'lo-follow-up' }) } as unknown as JobQueue;

/** What the job did with the pool and the scene check: each task's `wholeSlides`, only where it was written. */
const asked = (calls: Call[], kind: string) => [
  ...new Set(
    calls
      // The scan reads no slide and the rescue no geometry: neither is told (`nativeJob.ts`).
      .filter((c) => c.kind === kind && !c.input.scan && !c.input.rescue)
      .map((c) => ('wholeSlides' in c.input ? c.input.wholeSlides : undefined)),
  ),
];

/** One run of the job, as the queue runs it (`nativeJob`), over a fake pool; the deck stored first, the scene beside it. */
async function runNative(
  hub: TestHub,
  parts: Map<string, Uint8Array>,
  name: string,
  o: { scene?: PptxClientScene; quiet?: boolean; deckFile?: string } = {},
) {
  // A deck zipped once and stored on two hubs has one hash (a zip carries its time: two zips of the same parts may not).
  const hash = await storeDeck(hub, o.deckFile ?? (await zipDeck(parts, dir, `${name}.pptx`)));
  let sceneHash: string | undefined;
  if (o.scene) {
    const tmp = hub.store.tmpPath('json');
    writeFileSync(tmp, JSON.stringify(o.scene));
    sceneHash = (await hub.store.put(tmp, { ext: 'json', mime: 'application/json' })).hash;
  }
  const calls: Call[] = [];
  const logs: string[] = [];
  let cur: PptxNativePayload = {
    hash,
    name: `${name}.pptx`,
    options: {},
    ...(sceneHash ? { sceneHash } : {}),
  };
  const deps = { ...hub.imports.pptx.deps, ...(o.quiet ? { jobs: quietJobs } : {}) } as PptxDeps;
  const result = (await nativeJob(deps, { pool: poolOf(calls) })({
    id: `whole-${name}-${Math.random().toString(36).slice(2)}`,
    payload: cur,
    signal: new AbortController().signal,
    progress: () => undefined,
    log: (l: string) => {
      logs.push(l);
    },
    setPayload: (next) => {
      cur = next;
    },
  } as JobCtx<PptxNativePayload>)) as PptxNativeResult;
  const p = hub.lib.presentations.must(result.presentationId);
  return { result, p, slide: slidesOf(p)[0]!, logs, calls };
}

describe('the pool task (T2: the converter option reaches convertDeck)', () => {
  const convert = (parts: Map<string, Uint8Array>, extra: Partial<SceneTaskInput> = {}) =>
    sceneTask({ parts: new Map(parts), pictureSizes: [], range: { from: 0, to: 1 }, options: {}, ...extra })
      .result.slides[0]!;

  it('keeps all 400 pictures of a slide with wholeSlides; without it the guard\u2019s 15, or 16 without LibreOffice', () => {
    const parts = manyPictures(400);
    expect(imagesOf(convert(parts, { wholeSlides: true }).slide)).toHaveLength(400);
    expect(imagesOf(convert(parts, { wholeSlides: true, libreoffice: false }).slide)).toHaveLength(400);
    expect(imagesOf(convert(parts).slide)).toHaveLength(15);
    expect(imagesOf(convert(parts, { wholeSlides: false }).slide)).toHaveLength(15);
    expect(imagesOf(convert(parts, { libreoffice: false }).slide)).toHaveLength(16);
  });

  it('plans no art and lists nothing missing for a slide kept whole, on a hub with LibreOffice or without', () => {
    const parts = pictureGuardDeck(24);
    for (const lo of [true, false]) {
      const sl = convert(parts, { wholeSlides: true, ...(lo ? {} : { libreoffice: false }) });
      expect(imagesOf(sl.slide), `lo ${lo}`).toHaveLength(24);
      expect(sl.art, `lo ${lo}`).toBeUndefined();
      expect(sl.missing, `lo ${lo}`).toBeUndefined();
    }
  });

  it('is read from the input alone: a text deck is the same slide with or without it', () => {
    const parts = textDeck();
    const shape = (s: ReturnType<typeof convert>) => ({
      classification: s.classification,
      art: s.art,
      missing: s.missing,
      notes: s.notes,
      objects: s.slide.objects.map((o) => (o.type === 'text' ? o.text : o.type)),
    });
    expect(shape(convert(parts, { wholeSlides: true }))).toEqual(shape(convert(parts)));
  });
});

describe('the job decides once and passes it on (T4: the switch, LibreOffice present and absent, Q27)', () => {
  it('on, no LibreOffice: the slide is whole, has its record, the log says it and result.whole counts it', async () => {
    const hub = await hubOf({ ...prerender(true), ...NO_LO });
    const r = await runNative(hub, pictureGuardDeck(24), 'on-nolo');
    expect(imagesOf(r.slide)).toHaveLength(24);
    expect(r.slide.pptx).toMatchObject({ class: 'native' });
    expect(r.slide.pptx?.missing).toBeUndefined();
    expect(r.slide.pptx?.pending).toBeUndefined();
    expect(r.slide.prerender?.why.length).toBeGreaterThan(0);
    // Hooks only (Q24.a, Q24.c): nothing is baked or filed here.
    expect(Object.keys(r.slide.prerender!).sort()).toEqual(['live', 'why']);
    expect(r.slide.prerender?.live).toEqual([]);
    expect(r.result.whole).toBe(1);
    expect(r.p.source?.log).toMatch(/1 slide is very detailed and was kept whole/);
    expect(asked(r.calls, 'pptx-scene')).toEqual([true]);
  });

  it('on, LibreOffice present, Q27.a (the other arm, the test switch): the same, and no art waits for LibreOffice', async () => {
    q27.keepsWithLibreOffice = true;
    try {
      const hub = await hubOf(prerender(true));
      const r = await runNative(hub, pictureGuardDeck(24), 'on-lo', { quiet: true });
      expect(imagesOf(r.slide)).toHaveLength(24);
      expect(r.slide.pptx?.pending).toBeUndefined();
      expect(r.slide.prerender?.live).toEqual([]);
      expect(r.result.whole).toBe(1);
      expect(r.result.pending).toBe(0);
      expect(r.result.loJobId).toBeUndefined();
      expect(asked(r.calls, 'pptx-scene')).toEqual([true]);
    } finally {
      q27.keepsWithLibreOffice = undefined;
    }
  });

  it('on, LibreOffice present, Q27.b (the default, the constant): today’s plan exactly, as an off hub stores it', async () => {
    expect(WHOLE_WITH_LIBREOFFICE).toBe(false);
    try {
      const hub = await hubOf(prerender(true));
      const parts = pictureGuardDeck(24);
      const deckFile = await zipDeck(parts, dir, 'q27b.pptx');
      const r = await runNative(hub, parts, 'on-lo-b', { quiet: true, deckFile });
      expect(imagesOf(r.slide)).toHaveLength(15);
      expect(r.slide.pptx).toMatchObject({ class: 'hybrid', pending: true });
      expect(r.slide.prerender).toBeUndefined();
      expect(r.result.whole).toBeUndefined();
      expect(asked(r.calls, 'pptx-scene')).toEqual([undefined]);
      // And the same presentation a hub with the switch off stores (modulo ids, times, the log).
      const off = await hubOf(prerender(false));
      const base = await runNative(off, parts, 'off-lo-b', { quiet: true, deckFile });
      const fileOf = (h: TestHub) => (id: string) => h.lib.media.get(id)?.original.hash;
      expect(
        diffJson(
          comparable({ ...r.p, title: '' }, fileOf(hub)),
          comparable({ ...base.p, title: '' }, fileOf(off)),
        ),
      ).toEqual([]);
      // Q27.b affects a hub with LibreOffice only: without it the same hub keeps the slide whole.
      const nolo = await hubOf({ ...prerender(true), ...NO_LO });
      const lite = await runNative(nolo, pictureGuardDeck(24), 'on-nolo-b');
      expect(imagesOf(lite.slide)).toHaveLength(24);
      expect(lite.result.whole).toBe(1);
    } finally {
      q27.keepsWithLibreOffice = undefined;
    }
  });

  it('off (on: false), absent (auto: the constant is false) or with no LibreOffice: the plan of before, no record, no result.whole', async () => {
    const cases: [string, Partial<HubConfig>, boolean][] = [
      ['off with LibreOffice', prerender(false), true],
      ['off without LibreOffice', { ...prerender(false), ...NO_LO }, false],
      ['no switch at all', {}, true],
    ];
    for (const [name, cfg, lo] of cases) {
      const hub = await hubOf(cfg);
      const r = await runNative(hub, pictureGuardDeck(24), name.replaceAll(' ', '-'), { quiet: true });
      expect(imagesOf(r.slide), name).toHaveLength(lo ? 15 : 16);
      expect(r.slide.prerender, name).toBeUndefined();
      expect(r.result, name).not.toHaveProperty('whole');
      expect(r.p.source?.log, name).not.toMatch(/kept whole/);
      expect(asked(r.calls, 'pptx-scene'), name).toEqual([undefined]);
    }
  });

  it('writes the option into the pool inputs only when it is on (the libreoffice pattern)', async () => {
    const hub = await hubOf({ ...prerender(true), ...NO_LO });
    const r = await runNative(hub, textDeck(), 'keys-on');
    expect(asked(r.calls, 'pptx-scene')).toEqual([true]);
    const off = await hubOf({ ...prerender(false), ...NO_LO });
    const q = await runNative(off, textDeck(), 'keys-off');
    const batches = q.calls.filter((x) => x.kind === 'pptx-scene' && !x.input.scan);
    expect(batches.length).toBeGreaterThan(0);
    for (const c of batches) expect(Object.keys(c.input)).not.toContain('wholeSlides');
  });

  it('asks the scene check the same question, and a scene parsed the other way is not used: the hub parses the deck itself', async () => {
    const parts = pictureGuardDeck(24);
    const bytes = await zipped(parts);
    // Parsed here for a hub that keeps slides whole, without LibreOffice (as its operator would, C-IW4).
    const whole = (await parsePptxScene(bytes, { libreoffice: false, wholeSlides: true })).scene;
    const plain = (await parsePptxScene(bytes, { libreoffice: false })).scene;
    const on = await hubOf({ ...prerender(true), ...NO_LO });
    const used = await runNative(on, parts, 'scene-equal', { scene: whole });
    expect(asked(used.calls, 'pptx-client-scene')).toEqual([true]);
    expect(used.logs.some((l) => /parsed in the browser: the hub checked/.test(l))).toBe(true);
    expect(imagesOf(used.slide)).toHaveLength(24);
    // The other way: the scene does not record the option, the hub keeps slides whole: parsed here, whole.
    const refused = await runNative(on, parts, 'scene-plain', { scene: plain });
    expect(refused.logs.join('\n')).toContain(
      'the scene parsed in the browser was not used (parsed with another whole-slide option): parsed here',
    );
    expect(imagesOf(refused.slide)).toHaveLength(24);
    // And a hub that keeps nothing whole refuses a whole scene, whichever the picture counts: its own plan.
    const off = await hubOf({ ...prerender(false), ...NO_LO });
    const back = await runNative(off, parts, 'scene-whole-off', { scene: whole });
    expect(back.logs.join('\n')).toContain('parsed with another whole-slide option');
    expect(imagesOf(back.slide)).toHaveLength(16);
    expect(back.slide.prerender).toBeUndefined();
    expect(asked(back.calls, 'pptx-client-scene')).toEqual([undefined]);
  });
});

describe('the hub’s own parse and a browser scene store the same presentation (T3: equivalence)', () => {
  const golden = [
    'golden-pptx/challenging-features/tables/table_styles_and_cells.pptx',
    'golden-pptx/challenging-features/charts/chart_2d_basic.pptx',
    'golden-pptx/church-worship-lyrics/hymn_dark_base_sans.pptx',
  ];
  const decks = async () => [
    ...(await Promise.all(
      golden.map(
        async (rel) =>
          [
            rel.split('/').pop()!,
            new Uint8Array(readFileSync(join(import.meta.dirname, '../../..', rel))),
          ] as const,
      ),
    )),
    ['crowded-pictures.pptx', await zipped(pictureGuardDeck(24))] as const,
  ];

  // Without LibreOffice slides are kept whole; with it that is Q27.a only (the test switch), and under Q27.b (the default)
  // the browser parse and the hub both follow today's plan: nothing is kept whole, and the two still store the same.
  const arms: [label: string, lo: boolean, keeps: boolean, switchOn: boolean][] = [
    ['without LibreOffice', false, true, false],
    ['with LibreOffice (Q27.b, the default)', true, false, false],
    ['with LibreOffice (Q27.a, the test switch)', true, true, true],
  ];
  for (const [label, lo, keeps, switchOn] of arms)
    it(`on a hub ${label}: the crowded deck and three golden decks (modulo ids, times, the log)`, async () => {
      q27.keepsWithLibreOffice = switchOn ? true : undefined;
      const tag = label.replace(/\W+/g, '-');
      try {
        const hub = await hubOf({ ...prerender(true), ...(lo ? {} : NO_LO) });
        let recorded = 0;
        for (const [name, bytes] of await decks()) {
          const scene = (
            await parsePptxScene(bytes, { wholeSlides: keeps, ...(lo ? {} : { libreoffice: false }) })
          ).scene;
          const parts = new Map<string, Uint8Array>();
          const z = await JSZip.loadAsync(bytes);
          for (const [k, f] of Object.entries(z.files)) if (!f.dir) parts.set(k, await f.async('uint8array'));
          const deckFile = await zipDeck(parts, dir, `${tag}-${name}`);
          const own = await runNative(hub, parts, `own-${name}-${tag}`, { quiet: true, deckFile });
          const client = await runNative(hub, parts, `client-${name}-${tag}`, {
            scene,
            quiet: true,
            deckFile,
          });
          expect(client.logs.join('\n'), name).toMatch(/parsed in the browser: the hub checked its scene/);
          const fileOf = (id: string) => hub.lib.media.get(id)?.original.hash;
          const same = (p: Presentation) => comparable({ ...p, title: '' }, fileOf);
          expect(diffJson(same(own.p), same(client.p)), name).toEqual([]);
          expect(client.result.whole, name).toBe(own.result.whole);
          recorded += slidesOf(own.p).filter((s) => s.prerender).length;
        }
        // The crowded deck is the case that exercises the option: it was kept whole on both paths, or on neither (Q27.b).
        if (keeps) expect(recorded).toBeGreaterThanOrEqual(1);
        else expect(recorded).toBe(0);
      } finally {
        q27.keepsWithLibreOffice = undefined;
      }
    }, 240_000);
});

describe('a hostile deck on the hub (design 25: the bound, the share and the scene check; the 100-slide deck of the gate is measured by the track\u2019s script, this one is its size for a test)', () => {
  /** `slides` slides of `n` pictures each from 20 distinct files, every picture on the slide (a grid of 40 columns). */
  function crowdedSlides(slides: number, n: number) {
    const media: Record<string, Uint8Array> = {};
    for (let f = 0; f < 20; f++)
      media[`ppt/media/m${f}.png`] = solidPng(8, 8, [(f * 37) % 256, (f * 91) % 256, (f * 53) % 256]);
    const rels = Array.from({ length: 20 }, (_, f) => imageRel(`rId${2 + f}`, `../media/m${f}.png`));
    let shapes = '';
    for (let i = 0; i < n; i++)
      shapes += pic({
        id: 2 + i,
        x: (i % 40) * 0.25 * IN,
        y: Math.floor(i / 40) * 0.3 * IN,
        cx: 0.2 * IN,
        cy: 0.25 * IN,
        rId: `rId${2 + (i % 20)}`,
      });
    return buildDeck({ slides: Array.from({ length: slides }, () => ({ rels, shapes })), media });
  }

  it('10 slides of 999 pictures: the scene is used, the share holds, every other slide shows the screens\u2019 counts (200 objects, 16 distinct pictures), the presentation stays in its bound', async () => {
    // 999 pictures and the slide\u2019s one other object are the 1,000 the bound lets a slide keep whole.
    const parts = crowdedSlides(10, WHOLE_OBJECTS_MAX - 1);
    const bytes = await zipped(parts);
    const scene = (await parsePptxScene(bytes, { libreoffice: false, wholeSlides: true })).scene;
    const hub = await hubOf({ ...prerender(true), ...NO_LO });
    const t0 = performance.now();
    const r = await runNative(hub, parts, 'hostile-999', { scene, quiet: true });
    const ms = performance.now() - t0;
    expect(r.logs.join('\n')).toMatch(/parsed in the browser: the hub checked its scene/);
    const slides = slidesOf(r.p);
    expect(slides).toHaveLength(10);
    const whole = slides.filter((s) => s.prerender);
    const bytesOf = (s: Slide) => new TextEncoder().encode(JSON.stringify(s)).length;
    expect(whole.length).toBeGreaterThan(0);
    expect(whole.length).toBeLessThan(10);
    expect(whole.reduce((n, s) => n + bytesOf(s), 0)).toBeLessThanOrEqual(WHOLE_SHARE_BYTES);
    expect(r.result.whole).toBe(whole.length);
    for (const s of slides.filter((x) => !x.prerender)) {
      expect(s.objects.length).toBeLessThanOrEqual(200);
      expect(new Set(imagesOf(s).map((o) => o.mediaId)).size).toBeLessThanOrEqual(16);
    }
    expect(new TextEncoder().encode(JSON.stringify(r.p)).length).toBeLessThanOrEqual(
      SIZE_BUDGETS.presentationMax,
    );
    process.stdout.write(`T7 hub: ${ms.toFixed(0)} ms, ${whole.length} of 10 slides kept whole\n`);
  }, 240_000);

  it('10 slides of 1,000 pictures (one over the bound): none is kept whole, the plan of before, no record', async () => {
    const parts = crowdedSlides(10, WHOLE_OBJECTS_MAX);
    const bytes = await zipped(parts);
    const scene = (await parsePptxScene(bytes, { libreoffice: false, wholeSlides: true })).scene;
    const hub = await hubOf({ ...prerender(true), ...NO_LO });
    const r = await runNative(hub, parts, 'hostile-1000', { scene, quiet: true });
    expect(r.result.whole ?? 0).toBe(0);
    for (const s of slidesOf(r.p)) {
      expect(s.prerender).toBeUndefined();
      expect(new Set(imagesOf(s).map((o) => o.mediaId)).size).toBeLessThanOrEqual(16);
    }
  }, 240_000);
});

describe('the demo (T5) and callers without the option (T6)', () => {
  it('builds only from a scene that does not record wholeSlides: the demo answers prerender off', async () => {
    const bytes = await zipped(textDeck());
    const plain = (await parsePptxScene(bytes, { libreoffice: false })).scene;
    const whole = (await parsePptxScene(bytes, { libreoffice: false, wholeSlides: true })).scene;
    expect(demoUsesScene(plain)).toBe(true);
    expect(demoUsesScene(whole)).toBe(false);
    expect(demoUsesScene({ ...plain, wholeSlides: false } as unknown as PptxClientScene)).toBe(false);
    // The older refusals stay: a scene parsed with LibreOffice, one of another converter.
    expect(demoUsesScene({ ...plain, libreoffice: undefined })).toBe(false);
    expect(demoUsesScene({ ...plain, version: 2 })).toBe(false);
  });

  it('a caller that passes no option (the harness, older tests) gets the plan of before: 15 pictures and the art, no record', async () => {
    const hub = await hubOf({});
    const r = await runNative(hub, pictureGuardDeck(24), 'no-option', { quiet: true });
    expect(imagesOf(r.slide)).toHaveLength(15);
    expect(r.slide.pptx).toMatchObject({ class: 'hybrid', pending: true });
    expect(r.slide.prerender).toBeUndefined();
  });
});
