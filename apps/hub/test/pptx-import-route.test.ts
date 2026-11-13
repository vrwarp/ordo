/**
 * `POST /import/document` and the native PowerPoint import (design/27 §2, §3.2; M3 item H): a .pptx is
 * imported as editable slides unless pictures are asked for, with the native import's options in the job
 * payload. The jobs themselves are stand-ins here (items B and D test them): this checks what the route
 * queues, with which payload, and what it refuses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Presentation, PptxRenderer, type ShapeObject, type Slide } from '@ordo/domain';
import {
  CLIENT_M9_WRITES,
  CONVERTER_VERSION as CLIENT_CONVERTER_VERSION,
  importPptxClient,
  PPTX_CLIENT_LIMITS,
  parsePptxScene,
  type PptxClientScene,
} from '@ordo/importers';
import type { Job } from '@ordo/protocol';
import { RESCUE_NOTE } from '@ordo/pptx-scene/rescue.ts';
import { body, buildDeck, custGeom, para, run, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocPayload } from '../src/imports.ts';
import type { JobCtx, JobQueue } from '../src/jobs.ts';
import type { CpuPool } from '../src/pool.ts';
import { PptxImports } from '../src/pptx/index.ts';
import { nativeJob } from '../src/pptx/nativeJob.ts';
import { CLIENT_SCENE_LIMITS, type ClientSceneTaskInput, clientSceneTask } from '../src/pptx/clientScene.ts';
import { sceneTask } from '../src/pptx/sceneTask.ts';
import {
  CONVERTER_VERSION,
  M9_WRITES,
  type PptxDeps,
  type PptxNativePayload,
  type PptxNativeResult,
  type SceneTaskInput,
} from '../src/pptx/shared.ts';
import { documentImportForm } from '../src/routes.ts';
import { comparable, diffJson } from '../../../tools/pptx-fidelity/src/equivalence.ts';
import { fixtures } from './fixtures.ts';
import { type Client, EDIT_PIN, login, startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf } from './pptx-helpers.ts';

const fx = tempDir('ordo-fx-');

/** A deck built from parts (no real deck: design/27 §12), zipped like an upload; one slide by default. */
async function deckBytes(
  parts = buildDeck({
    slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: 914_400, cy: 914_400, fill: solid('336699') }) }],
  }),
): Promise<Uint8Array<ArrayBuffer>> {
  const z = new JSZip();
  for (const [k, v] of parts) z.file(k, v);
  return new Uint8Array(await z.generateAsync({ type: 'uint8array' }));
}

const IN = 914_400;
const pt = (x: number, y: number) => `<a:pt x="${x}" y="${y}"/>`;
/** A closed polygon of `n` points in 7-digit EMU (a traced outline's), different for each `k` (as pptx-geoms.test.ts). */
function polygon(n: number, k = 0): string {
  let s = `<a:moveTo>${pt(1_000_000 + k, 1_000_000)}</a:moveTo>`;
  for (let i = 1; i < n; i++)
    s += `<a:lnTo>${pt(1_000_000 + ((i * 7_919 + k * 31) % 9_000_000), 1_000_000 + ((i * 104_729) % 5_000_000))}</a:lnTo>`;
  return `${s}<a:close/>`;
}
const deco = (id: number, n: number, k = 0, w = 2) =>
  sp({
    id,
    x: id * 10_000,
    y: 0,
    cx: w * IN,
    cy: (w * IN) / 2,
    geom: 'none',
    fill: custGeom({ paths: `<a:path w="10000000" h="6000000">${polygon(n, k)}</a:path>` }) + solid('FF0000'),
  });
/** The geometry refs of a slide's shapes that have a geometry (not its background rect). */
const refsOf = (s: Slide) =>
  s.objects
    .filter((o): o is ShapeObject => o.type === 'shape' && o.geom !== undefined)
    .map((o) => o.geom?.ref);
const textBox = (id: number, text: string) =>
  sp({ id, x: IN, y: IN, cx: 6 * IN, cy: IN, txBody: body(para(run(text))) });
const textsOf = (s: Slide) => s.objects.flatMap((o) => (o.type === 'text' ? [o.text] : []));

let hub: TestHub;
let ed: Client;
let deck: Uint8Array<ArrayBuffer>;
/** What the stand-in jobs were given, by job id. */
const seen = new Map<string, { kind: string; payload: unknown }>();

beforeAll(async () => {
  hub = await startHub();
  ed = await login(hub.url, EDIT_PIN);
  deck = await deckBytes();
  for (const kind of ['pptx-native', 'document'])
    hub.jobs.register<unknown>(kind, async (ctx) => {
      seen.set(ctx.id, { kind, payload: ctx.payload });
      return { presentationId: 'stand-in' };
    });
});
afterAll(async () => {
  await hub.cleanup();
});
beforeEach(() => seen.clear());

async function post(file: Uint8Array<ArrayBuffer>, name: string, fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([file]), name);
  return ed.fetch('/import/document', { method: 'POST', body: fd });
}

async function queued(res: Response): Promise<{ job: Job; payload: unknown }> {
  expect(res.status).toBe(202);
  const job = (await res.json()) as Job;
  await hub.jobs.idle();
  const got = seen.get(job.id);
  expect(got?.kind).toBe(job.kind);
  return { job, payload: got?.payload };
}

describe('POST /import/document', () => {
  it('imports a PowerPoint as editable slides by default', async () => {
    const { job, payload } = await queued(await post(deck, 'Sunday Service.pptx'));
    expect(job.kind).toBe('pptx-native');
    const p = payload as PptxNativePayload;
    expect(p).toEqual({ hash: p.hash, name: 'Sunday Service.pptx', options: {} });
    // The deck is stored by its SHA-256 before the job starts.
    expect(hub.lib.getFile(p.hash)).toBeTruthy();
  });

  it('keeps the native options in the payload', async () => {
    const { job, payload } = await queued(
      await post(deck, 'a.pptx', { renderer: 'native', extendBackgrounds: '0', transitionSounds: '1' }),
    );
    expect(job.kind).toBe('pptx-native');
    expect((payload as PptxNativePayload).options).toEqual({
      extendBackgrounds: false,
      transitionSounds: true,
    });
  });

  it('imports pictures when LibreOffice or pptx-preview is asked for', async () => {
    const lo = await queued(await post(deck, 'b.pptx', { renderer: 'libreoffice', extendBackgrounds: '1' }));
    expect(lo.job.kind).toBe('document');
    expect(lo.payload).toEqual({ hash: (lo.payload as DocPayload).hash, name: 'b.pptx', ext: 'pptx' });
    const ppv = await queued(await post(deck, 'c.pptx', { renderer: 'pptx-preview' }));
    expect(ppv.job.kind).toBe('document');
    expect((ppv.payload as DocPayload).renderer).toBe('pptx-preview');
  });

  it('imports a PDF as pictures whatever the PowerPoint choice', async () => {
    const pdf = new Uint8Array(readFileSync(fixtures.pdf(fx, 1)));
    for (const renderer of [undefined, 'native']) {
      const { job, payload } = await queued(await post(pdf, 'Notices.pdf', renderer ? { renderer } : {}));
      expect(job.kind).toBe('document');
      expect(payload).toMatchObject({ name: 'Notices.pdf', ext: 'pdf' });
      expect((payload as DocPayload).renderer).toBeUndefined();
    }
  });

  it('refuses unknown values, queues nothing and keeps no upload', async () => {
    const uploads = join(hub.dir, 'uploads');
    const { readdirSync, existsSync } = await import('node:fs');
    const files = () => (existsSync(uploads) ? readdirSync(uploads).length : 0);
    const before = files();
    const jobs = hub.jobs.list().length;
    const bad: Record<string, string>[] = [
      { renderer: 'keynote' },
      { extendBackgrounds: 'maybe' },
      { renderer: 'NATIVE' },
    ];
    for (const fields of bad) {
      const res = await post(deck, 'x.pptx', fields);
      expect(res.status).toBe(400);
    }
    expect(hub.jobs.list().length).toBe(jobs);
    expect(files()).toBe(before);
  });

  it('accepts a client-parsed scene file and builds version 1 without running pptx-scene on the hub pool', async () => {
    const parsed = await importPptxClient(deck, 'Client Parsed.pptx');
    const fd = new FormData();
    fd.append('renderer', 'native');
    fd.append(
      'clientScene',
      new Blob([JSON.stringify(parsed.clientScene)], { type: 'application/json' }),
      'scene.json',
    );
    fd.append('file', new Blob([deck]), 'Client Parsed.pptx');
    const { job, payload } = await queued(await ed.fetch('/import/document', { method: 'POST', body: fd }));
    expect(job.kind).toBe('pptx-native');
    const p = payload as PptxNativePayload;
    expect(p.sceneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hub.lib.getFile(p.sceneHash!)).toBeTruthy();

    // Run nativeJob with a pool that throws if pptx-scene is ever called on the hub: the scene is only checked
    // there (`pptx-client-scene`, off the event loop).
    let poolCalled = false;
    const kinds: string[] = [];
    const noScenePool = {
      run: (async (kind: string, input: unknown) => {
        kinds.push(kind);
        if (kind === 'pptx-client-scene') return clientSceneTask(input as ClientSceneTaskInput);
        poolCalled = true;
        throw new Error('pptx-scene should not run on the hub when sceneHash is present');
      }) as CpuPool['run'],
    };
    let cur = p;
    const handler = nativeJob(hub.imports.pptx.deps, { pool: noScenePool });
    const out = (await handler({
      id: 'client-scene-job',
      payload: cur,
      signal: new AbortController().signal,
      progress: () => undefined,
      log: () => undefined,
      setPayload: (next) => {
        cur = next;
      },
    } as JobCtx<PptxNativePayload>)) as PptxNativeResult;

    expect(poolCalled).toBe(false);
    expect(kinds).toEqual(['pptx-client-scene']);
    expect(out.slides).toBe(1);
    expect(out.native).toBe(1);
    const saved = hub.lib.presentations.get(out.presentationId);
    expect(saved?.title).toBe('Client Parsed');
  });

  it('uses a client scene only from its own converter, parsed for the LibreOffice it has (M9)', async () => {
    // The client parses with the hub's converter version and stored fields (design/27 M9 `M9_WRITES`).
    expect(CLIENT_CONVERTER_VERSION).toBe(CONVERTER_VERSION);
    expect([...CLIENT_M9_WRITES].sort()).toEqual([...M9_WRITES].sort());

    // A scene parsed for a hub without LibreOffice, on this hub with it: the hub parses the deck itself.
    const parsed = await importPptxClient(deck, 'Lite Parsed.pptx', { libreoffice: false });
    const fd = new FormData();
    fd.append('renderer', 'native');
    fd.append(
      'clientScene',
      new Blob([JSON.stringify(parsed.clientScene)], { type: 'application/json' }),
      'scene.json',
    );
    fd.append('file', new Blob([deck]), 'Lite Parsed.pptx');
    const { payload } = await queued(await ed.fetch('/import/document', { method: 'POST', body: fd }));
    const p = payload as PptxNativePayload;
    expect(p.sceneHash).toMatch(/^[0-9a-f]{64}$/);
    let poolCalled = false;
    const pool = {
      run: (async (kind: string, input: unknown) => {
        if (kind === 'pptx-client-scene') return clientSceneTask(input as ClientSceneTaskInput);
        poolCalled = true;
        throw new Error('stop here: the hub parses the deck itself');
      }) as CpuPool['run'],
    };
    const handler = nativeJob(hub.imports.pptx.deps, { pool });
    await Promise.resolve(
      handler({
        id: 'lite-scene-job',
        payload: p,
        signal: new AbortController().signal,
        progress: () => undefined,
        log: () => undefined,
        setPayload: () => undefined,
      } as JobCtx<PptxNativePayload>),
    ).catch(() => undefined);
    expect(poolCalled).toBe(true);
  });

  /**
   * Posts `bytes` with `scene` as the client parsed it and runs the job on it, with a pool that converts no
   * slide (only the text rescue runs, in-process): the result, its slides and the pool's calls.
   */
  async function importClientScene(
    bytes: Uint8Array<ArrayBuffer>,
    name: string,
    scene: PptxClientScene,
    o: { hubMayParse?: boolean } = {},
  ) {
    const fd = new FormData();
    fd.append('renderer', 'native');
    fd.append('clientScene', new Blob([JSON.stringify(scene)], { type: 'application/json' }), 'scene.json');
    fd.append('file', new Blob([bytes]), name);
    const { payload } = await queued(await ed.fetch('/import/document', { method: 'POST', body: fd }));
    const p = payload as PptxNativePayload;
    expect(p.sceneHash).toMatch(/^[0-9a-f]{64}$/);
    const calls: { range: { from: number; to: number }; rescue: boolean }[] = [];
    const pool = {
      run: (async (kind: string, input: SceneTaskInput) => {
        if (kind === 'pptx-client-scene') return clientSceneTask(input as unknown as ClientSceneTaskInput);
        calls.push({ range: input.range, rescue: !!input.rescue });
        if (!input.rescue && !o.hubMayParse)
          throw new Error('pptx-scene converts no slide on the hub when sceneHash is present');
        return sceneTask(input);
      }) as CpuPool['run'],
    };
    let cur = p;
    const logs: string[] = [];
    const result = (await nativeJob(hub.imports.pptx.deps, { pool })({
      id: `scene-${Math.random().toString(36).slice(2)}`,
      payload: cur,
      signal: new AbortController().signal,
      progress: () => undefined,
      log: (line: string) => {
        logs.push(line);
      },
      setPayload: (next) => {
        cur = next;
      },
    } as JobCtx<PptxNativePayload>)) as PptxNativeResult;
    return {
      result,
      slides: slidesOf(hub.lib.presentations.must(result.presentationId)),
      calls,
      sceneHash: p.sceneHash!,
      logs,
    };
  }

  it('drops a scene over its size bound before it is stored: the hub parses the deck (design/27 §12)', async () => {
    const scene = (await importPptxClient(deck, 'Big Scene.pptx')).clientScene;
    const was = CLIENT_SCENE_LIMITS.bytes;
    CLIENT_SCENE_LIMITS.bytes = 1_000;
    try {
      const fd = new FormData();
      fd.append('renderer', 'native');
      fd.append('clientScene', new Blob([JSON.stringify(scene)], { type: 'application/json' }), 'scene.json');
      fd.append('file', new Blob([deck]), 'Big Scene.pptx');
      const { job, payload } = await queued(await ed.fetch('/import/document', { method: 'POST', body: fd }));
      expect(job.kind).toBe('pptx-native');
      expect((payload as PptxNativePayload).sceneHash).toBeUndefined();
      expect(hub.lib.getFile((payload as PptxNativePayload).hash)).toBeTruthy();
    } finally {
      CLIENT_SCENE_LIMITS.bytes = was;
    }
  });

  it('parses the deck on the hub when the scene is malformed, and says why in the job log', async () => {
    const bytes = await deckBytes(
      buildDeck({ slides: ['One', 'Two'].map((t) => ({ shapes: textBox(2, t) })) }),
    );
    const good = (await importPptxClient(bytes, 'Malformed.pptx')).clientScene;
    const bad: unknown[] = [
      { ...good, scan: {} },
      { ...good, listed: good.listed.map((r) => ({ ...r, part: `ppt/slides/${'x'.repeat(600)}.xml` })) },
      { ...good, slides: [{ ...good.slides[0]!, slide: { id: 'x', objects: 'none' } }] },
      { ...good, version: 1 },
      { ...good, m9Writes: [] },
    ];
    for (const scene of bad) {
      const { result, slides, calls, logs } = await importClientScene(
        bytes,
        'Malformed.pptx',
        scene as PptxClientScene,
        { hubMayParse: true },
      );
      expect(calls.some((c) => !c.rescue)).toBe(true);
      expect(result.slides).toBe(2);
      expect(slides.map(textsOf)).toEqual([['One'], ['Two']]);
      expect(logs.some((l) => /scene parsed in the browser was not used/.test(l))).toBe(true);
    }
  });

  it('checks every shape file again: one whose name is not what it holds is dropped, its shapes keep no ref', async () => {
    const bytes = await deckBytes(buildDeck({ slides: [{ shapes: deco(2, 4_000) }] }));
    const scene = (await importPptxClient(bytes, 'Forged.pptx')).clientScene;
    expect(scene.geomFiles).toHaveLength(1);
    const g = scene.geomFiles[0]!;
    // Same name, other content: the store would have kept a file under a name that is not its hash.
    g.json = g.json.replace(/\d/, (d) => String((Number(d) + 1) % 10));
    const { slides, calls, sceneHash } = await importClientScene(bytes, 'Forged.pptx', scene);
    expect(calls).toEqual([]);
    expect(refsOf(slides[0]!)).toEqual([]);
    expect(hub.lib.getFile(g.hash)).toBeUndefined();
    // The scene is released once version 1 is saved (it holds every slide's text and notes).
    expect(hub.lib.getFile(sceneHash)).toBeUndefined();
  });

  it("leaves out only the shapes a client scene's slide past its outline-file bound was given no file for (M9 ladder)", async () => {
    // Three outlines of about 60 KB each (pptx-geoms.test.ts): two on slide 1, a third new on slide 2.
    const bytes = await deckBytes(
      buildDeck({
        slides: [
          { shapes: deco(2, 4_000) + deco(3, 4_000, 0, 1) + deco(4, 4_000, 1) },
          { shapes: deco(2, 4_000, 0, 3) + deco(3, 4_000, 2) },
        ],
      }),
    );
    const sizes = (await importPptxClient(bytes, 'Outlines.pptx')).clientScene.geomFiles.map(
      (g) => new TextEncoder().encode(g.json).length,
    );
    expect(sizes).toHaveLength(3);
    // A client bound that holds slide 1's two files and not slide 2's new third one.
    const limits = PPTX_CLIENT_LIMITS as { batchGeomBytes: number };
    const was = limits.batchGeomBytes;
    limits.batchGeomBytes = sizes[0]! + sizes[1]! + Math.floor(sizes[2]! / 2);
    let scene: PptxClientScene;
    try {
      scene = (await importPptxClient(bytes, 'Outlines.pptx')).clientScene;
    } finally {
      limits.batchGeomBytes = was;
    }
    expect(scene.geomOver).toEqual([1]);
    const { result, slides, calls } = await importClientScene(bytes, 'Outlines.pptx', scene);
    expect(calls).toEqual([]);
    // As the hub's own parse past its budget (pptx-geoms.test.ts): never a picture, never a legacy shape where
    // a traced outline was; the shape is left out and listed missing.
    expect(result).toMatchObject({ native: 1, hybrid: 1, picture: 0, compact: 0 });
    const [s1, s2] = slides as [Slide, Slide];
    expect(refsOf(s2)).toEqual([refsOf(s1)[0]]);
    // The shape whose file never arrived is gone, not kept as a legacy shape where its outline was.
    expect(s2.objects.flatMap((o) => (o.type === 'shape' ? [o.geom?.ref ?? 'none'] : []))).toEqual([
      'none',
      refsOf(s1)[0],
    ]);
    expect(s2.pptx).toMatchObject({ class: 'hybrid', missing: ['decoration'] });
    expect(s2.pptx!.pending).toBeUndefined();
    expect(s2.pptx!.notes).toEqual(['over the import budget of shape outlines: 1 shape(s) left out']);
    expect(result.notes.some((n) => /slide 2's shape outlines pass/.test(n))).toBe(true);
  });

  it('stores what its own parse stores when it builds from a client scene (public golden decks)', async () => {
    // The hub-vs-client equivalence of the import core (tools/pptx-fidelity `--equivalence` runs it over the
    // worship corpus): each deck through the hub's own parse and through a browser scene, compared modulo ids,
    // media ids (by file), times, the import log and digests.
    const decks = [
      'golden-pptx/challenging-features/tables/table_styles_and_cells.pptx',
      'golden-pptx/challenging-features/charts/chart_2d_basic.pptx',
      'golden-pptx/church-announcements-ministry/twc_worship_announcements.pptx',
      'golden-pptx/church-worship-lyrics/hymn_dark_base_sans.pptx',
    ];
    const pool = {
      run: (async (kind: string, input: unknown) =>
        kind === 'pptx-client-scene'
          ? clientSceneTask(input as ClientSceneTaskInput)
          : sceneTask(input as SceneTaskInput)) as CpuPool['run'],
    };
    const run = async (payload: PptxNativePayload) => {
      let cur = payload;
      const logs: string[] = [];
      const out = (await nativeJob(hub.imports.pptx.deps, { pool })({
        id: `eq-${Math.random().toString(36).slice(2)}`,
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
      return { p: hub.lib.presentations.must(out.presentationId), logs };
    };
    for (const rel of decks) {
      const bytes = new Uint8Array(readFileSync(join(import.meta.dirname, '../../..', rel)));
      const name = rel.split('/').pop()!;
      const scene = (await parsePptxScene(bytes)).scene;
      const fd = new FormData();
      fd.append('renderer', 'native');
      fd.append('clientScene', new Blob([JSON.stringify(scene)], { type: 'application/json' }), 'scene.json');
      fd.append('file', new Blob([bytes]), name);
      const withScene = (await queued(await ed.fetch('/import/document', { method: 'POST', body: fd })))
        .payload as PptxNativePayload;
      const own = (await queued(await post(bytes, name))).payload as PptxNativePayload;
      const client = await run(withScene);
      expect(client.logs.join('\n')).toMatch(/parsed in the browser: the hub checked its scene/);
      const hubOwn = await run(own);
      const fileOf = (id: string) => hub.lib.media.get(id)?.original.hash;
      const same = (p: Presentation) => comparable({ ...p, title: '' }, fileOf);
      expect(diffJson(same(hubOwn.p), same(client.p)), rel).toEqual([]);
    }
  });

  it('gives the text rescue to a slide the client could not read or did not send, never a picture (M9 ladder)', async () => {
    const bytes = await deckBytes(
      buildDeck({ slides: ['Slide 1', 'Slide 2', 'Slide 3'].map((t) => ({ shapes: textBox(2, t) })) }),
    );
    const scene = (await importPptxClient(bytes, 'Rescue.pptx')).clientScene;
    // Slide 2 as the client's converter leaves a slide it cannot read (`readSlide`); slide 3 not sent at all.
    const s2 = scene.slides.find((s) => s.index === 1)!;
    s2.classification = { tier: 'fallback', class: 'picture', reasons: ['unreadable'] };
    s2.slide = { ...s2.slide, objects: [] };
    scene.slides = scene.slides.filter((s) => s.index !== 2);
    const { result, slides, calls } = await importClientScene(bytes, 'Rescue.pptx', scene);
    // Only the rescue ran on the hub, once for the two slides.
    expect(calls).toEqual([{ range: { from: 1, to: 3 }, rescue: true }]);
    expect(result).toMatchObject({ slides: 3, native: 1, hybrid: 2, picture: 0 });
    expect(slides.map(textsOf)).toEqual([['Slide 1'], ['Slide 2'], ['Slide 3']]);
    for (const s of slides.slice(1)) {
      expect(s.pptx).toMatchObject({ class: 'hybrid', missing: ['slide'] });
      expect(s.pptx!.pending).toBeUndefined();
      expect(s.pptx!.notes).toContain(RESCUE_NOTE);
    }
  });

  it('does not widen the stored renderer: native lives only in the form and the payload', () => {
    expect(PptxRenderer.safeParse('native').success).toBe(false);
    expect(PptxRenderer.options).toEqual(['libreoffice', 'pptx-preview']);
  });
});

describe('documentImportForm', () => {
  it('reads the renderer and the options', () => {
    expect(documentImportForm({})).toEqual({ renderer: 'native', options: {} });
    expect(documentImportForm({ renderer: '' })).toEqual({ renderer: 'native', options: {} });
    expect(documentImportForm({ renderer: 'libreoffice', extendBackgrounds: 'false' })).toEqual({
      renderer: 'libreoffice',
      options: { extendBackgrounds: false },
    });
    expect(documentImportForm({ extendBackgrounds: 'on', transitionSounds: 'off' }).options).toEqual({
      extendBackgrounds: true,
      transitionSounds: false,
    });
    expect(documentImportForm({ extendBackgrounds: '' }).options).toEqual({});
  });

  it('refuses what it does not know with a 400', () => {
    const bad: Record<string, string>[] = [
      { renderer: 'keynote' },
      { transitionSounds: 'yes' },
      { extendBackgrounds: '2' },
    ];
    for (const f of bad)
      expect(() => documentImportForm(f)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('reads only its own fields, never inherited ones', () => {
    const fields = Object.create({ renderer: 'keynote', extendBackgrounds: 'maybe' }) as Record<
      string,
      string
    >;
    expect(documentImportForm(fields)).toEqual({ renderer: 'native', options: {} });
  });
});

describe('queueReference', () => {
  it('names the slides that switch to the picture only when asked', () => {
    const queued: unknown[] = [];
    const jobs = {
      register: () => undefined,
      enqueue: (_kind: string, payload: unknown) => {
        queued.push(payload);
        return { id: 'j' } as never;
      },
    } as unknown as JobQueue;
    // No reference job is active (`queueReference` joins an active one: pptx-integrate-review.test.ts).
    const lib = { db: { prepare: () => ({ all: () => [] }) } };
    const pptx = new PptxImports({ jobs, lib, locked: () => false } as unknown as PptxDeps);
    pptx.queueReference('p1', 'h');
    pptx.queueReference('p1', 'h', 'edit@1', []);
    pptx.queueReference('p1', 'h', undefined, ['s1']);
    expect(queued).toEqual([
      { presentationId: 'p1', hash: 'h' },
      { presentationId: 'p1', hash: 'h', by: 'edit@1', showPicture: [] },
      { presentationId: 'p1', hash: 'h', showPicture: ['s1'] },
    ]);
  });
});
