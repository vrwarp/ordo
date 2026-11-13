/**
 * Geometry files of a native import (design/27 §3.1 `ShapeGeom.ref`, §3.4, §15 M6 round 2; `geoms.ts`): a
 * large traced outline is stored once in the content store and named on every slide that draws it, the
 * slides stay within the 64 KB budget, the goLive manifest lists the files and the live process serves them.
 */
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  GeomFile,
  isGeomFileRef,
  localDigest,
  type Presentation,
  resolvePlaylist,
  type ShapeObject,
  type Slide,
  slideBytes,
} from '@ordo/domain';
import { buildDeck, custGeom, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLiveDb } from '../src/db.ts';
import { geomRefsIn } from '../src/libproc.ts';
import { LibraryLink } from '../src/librarylink.ts';
import { librarySource } from '../src/live.ts';
import { liveFiles } from '../src/liveproc.ts';
import { geomFileOf, nameGeoms, storeGeomFiles } from '../src/pptx/geoms.ts';
import { nativeJob } from '../src/pptx/nativeJob.ts';
import { sceneTask } from '../src/pptx/sceneTask.ts';
import type { PptxNativePayload, PptxNativeResult } from '../src/pptx/shared.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

const IN = 914_400;
const pt = (x: number, y: number) => `<a:pt x="${x}" y="${y}"/>`;
/** A closed polygon of `n` points in 7-digit EMU (a traced outline's), different for each `k`. */
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

describe('geoms.ts', () => {
  const paths = [{ d: 'M 0 0 L 10 0 L 10 10 Z', w: 10, h: 10 }];

  it('names a file by the SHA-256 of its JSON, re-tokenised and checked as stored paths are', () => {
    const f = geomFileOf({ paths })!;
    expect(new TextDecoder().decode(f.bytes)).toBe(JSON.stringify({ paths }));
    expect(f.hash).toBe(createHash('sha256').update(f.bytes).digest('hex'));
    expect(geomFileOf({ paths: [{ ...paths[0]!, d: 'M 0 0 L 10 0 L 10 10 Z <x>' }] })!.hash).toBe(f.hash);
    for (const bad of [undefined, {}, { paths: [] }, { paths: [{ d: 'nope', w: 1, h: 1 }] }])
      expect(geomFileOf(bad)).toBeUndefined();
    // At most 8 paths are kept, as inline.
    const nine = geomFileOf({ paths: Array(9).fill(paths[0]) })!;
    expect(JSON.parse(new TextDecoder().decode(nine.bytes)).paths).toHaveLength(8);
  });

  it('puts names in place of placeholders, drops unknown ones, and leaves other objects as they are', () => {
    const text = { id: 't', type: 'text' } as unknown as Slide['objects'][number];
    const slide = {
      id: 's',
      objects: [
        { id: 'a', type: 'shape', geom: { ref: 'pptxgeom:1' } },
        { id: 'b', type: 'shape', geom: { ref: 'pptxgeom:9', preset: 'star5' } },
        { id: 'c', type: 'shape', geom: { ref: 'pptxgeom:9' } },
        { id: 'd', type: 'image', mask: { ref: 'pptxgeom:1' } },
        text,
      ],
    } as unknown as Slide;
    const out = nameGeoms(slide, new Map([['pptxgeom:1', 'f'.repeat(64)]]));
    expect(
      out.objects.map(
        (o) => (o as { geom?: unknown; mask?: unknown }).geom ?? (o as { mask?: unknown }).mask,
      ),
    ).toEqual([{ ref: 'f'.repeat(64) }, { preset: 'star5' }, undefined, { ref: 'f'.repeat(64) }, undefined]);
    expect(out.objects[4]).toBe(text);
    const plain = { id: 's', objects: [text] } as unknown as Slide;
    expect(nameGeoms(plain, new Map())).toBe(plain);
  });

  it('stores each file once, skips one the store has, and warns once for those it could not store', async () => {
    const a = geomFileOf({ paths })!;
    const b = geomFileOf({ paths: [{ ...paths[0]!, w: 20 }] })!;
    const files = new Map([
      [a.hash, a],
      [b.hash, b],
    ]);
    const put: string[] = [];
    const store = {
      putBytes: async (buf: Uint8Array) => {
        const hash = createHash('sha256').update(buf).digest('hex');
        if (hash === b.hash) throw new Error('disk full');
        put.push(hash);
        return { hash, bytes: buf.length, mime: 'application/json', path: `media/${hash}.json` };
      },
    };
    const warned: string[] = [];
    const lib = {
      getFile: (h: string) => (h === 'have' ? { hash: h, bytes: 1, mime: 'x', path: 'p' } : undefined),
    };
    const r = await storeGeomFiles(store, lib, files, [a.hash, a.hash, b.hash, 'have', 'unknown'], (m) =>
      warned.push(m),
    );
    expect(put).toEqual([a.hash]);
    expect(r).toEqual({ written: 1, failed: [b.hash] });
    expect(warned).toEqual([
      '1 shape outline file(s) could not be stored (disk full): those shapes are drawn plain',
    ]);
  });

  it('finds the files a stored value names (geomRefsIn), only SHA-256 names', () => {
    const p = {
      sections: [
        {
          slides: [
            {
              objects: [
                { geom: { ref: 'a'.repeat(64) } },
                { mask: { ref: 'pptxgeom:1' } },
                { ref: 'b'.repeat(64) },
              ],
            },
          ],
        },
      ],
    };
    expect([...geomRefsIn(p)]).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect([...geomRefsIn(p, new Set(), 1)]).toEqual(['a'.repeat(64)]);
  });
});

describe("the live process's copy of the library (librarylink.ts)", () => {
  it("answers a goLive's file lookups from the bundle's geometry files, nothing else", async () => {
    const hash = 'a'.repeat(64);
    const file = { hash, bytes: 10, mime: 'application/json', path: `media/aa/${hash}.json` };
    const bundle = {
      playlist: { id: 'pl', name: 'x', items: [] },
      presentations: {},
      media: {},
      files: { [hash]: file },
      fonts: [],
      looks: [],
      general: {},
    };
    const fetcher = (async (url: string) =>
      String(url).includes('/internal/golive/pl')
        ? Response.json(bundle)
        : new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const link = new LibraryLink(
      openLiveDb(join(tempDir(), 'live.db')),
      pino({ level: 'silent' }),
      's',
      fetcher,
    );
    link.setLibrary('http://library', 'up');
    await link.prepare('pl');
    const inputs = link.goLiveInputs('pl')!;
    expect(inputs.file!(hash)).toEqual(file);
    for (const other of ['b'.repeat(64), '__proto__', 'constructor'])
      expect(inputs.file!(other)).toBeUndefined();
  });
});

describe('pptx-native: geometry files', () => {
  let hub: TestHub;
  let dir: string;
  beforeAll(async () => {
    hub = await startHub();
    dir = tempDir('ordo-geoms-');
  }, 60_000);
  afterAll(async () => {
    await hub?.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function importDeck(
    parts: Map<string, Uint8Array>,
  ): Promise<{ result: PptxNativeResult; p: Presentation }> {
    const file = await zipDeck(parts, dir, `${Math.random().toString(36).slice(2)}.pptx`);
    const hash = await storeDeck(hub, file);
    const job = await waitJob(hub, hub.imports.pptx.queueNative(hash, 'Template.pptx', {}).id);
    if (job.state !== 'done') throw new Error(`import failed: ${job.error}\n${job.log.join('\n')}`);
    const result = job.result as PptxNativeResult;
    return { result, p: hub.lib.presentations.must(result.presentationId) };
  }

  // Three outlines of about 60 KB of path text each, on a slide twice and on the next at another size: about
  // 240 KB of slide JSON inline.
  const slides = [
    { shapes: deco(2, 4_000) + deco(3, 4_000, 0, 1) + deco(4, 4_000, 1) },
    { shapes: deco(2, 4_000, 0, 3) + deco(3, 4_000, 2) },
  ];

  it('stores each outline once, names it on every slide that draws it, and keeps the slides native', async () => {
    const { result, p } = await importDeck(buildDeck({ slides }));
    expect(result).toMatchObject({ native: 2, picture: 0, compact: 0 });
    const [s1, s2] = slidesOf(p) as [Slide, Slide];
    const r1 = refsOf(s1);
    const r2 = refsOf(s2);
    expect([...r1, ...r2].every(isGeomFileRef)).toBe(true);
    expect(r1[0]).toBe(r1[1]);
    expect(r2[0]).toBe(r1[0]);
    expect(new Set([...r1, ...r2]).size).toBe(3);
    for (const s of [s1, s2]) expect(slideBytes(s)).toBeLessThan(16 * 1024);
    for (const ref of new Set([...r1, ...r2])) {
      const f = hub.lib.getFile(ref!)!;
      expect(f).toMatchObject({ hash: ref, mime: 'application/json' });
      const bytes = readFileSync(hub.store.abs(f.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref);
      expect(GeomFile.parse(JSON.parse(bytes.toString('utf8'))).paths[0]!.d.length).toBeGreaterThan(30_000);
    }
    // goLive lists the files in the manifest, and the live process serves them.
    const pl = hub.lib.playlists.insert({
      id: 'pl-geoms',
      rev: 1,
      name: 'Template',
      items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }],
    });
    const r = resolvePlaylist(librarySource(hub.lib).goLiveInputs(pl.id), pl.id, { digest: localDigest });
    const names = new Set([...r1, ...r2]);
    expect(new Set(r.geoms?.map((g) => g.hash))).toEqual(names);
    for (const n of names) expect(r.files.some((f) => f.hash === n)).toBe(true);
    for (const n of names) expect(liveFiles(r, undefined).has(n!)).toBe(true);
    expect(r.degraded ?? []).toEqual([]);
    // The same deck again: the same names, no new file.
    const outlines = () => hub.lib.allFiles().filter((f) => f.mime === 'application/json').length;
    const before = outlines();
    const again = await importDeck(buildDeck({ slides }));
    expect(slidesOf(again.p).flatMap(refsOf)).toEqual([...r1, ...r2]);
    expect(outlines()).toBe(before);
  });

  it("a slide past the import's outline-file budget keeps its text and pictures: only the shapes naming new files go", async () => {
    const file = await zipDeck(buildDeck({ slides }), dir, 'budget.pptx');
    const hash = await storeDeck(hub, file);
    const lines: string[] = [];
    const payload: PptxNativePayload = { hash, name: 'Template.pptx', options: {} };
    const ctx = {
      id: 'direct',
      payload,
      signal: new AbortController().signal,
      log: (m: string) => lines.push(m),
      progress: () => {},
      setPayload: (pl: PptxNativePayload) => {
        ctx.payload = pl;
      },
    };
    // Room for the first slide's two files, not the second slide's new one.
    const out = (await nativeJob(hub.imports.pptx.deps, { limits: { geomFileBytes: 160_000 } })(
      ctx,
    )) as PptxNativeResult;
    // M9 ladder: never a picture; the shape naming the file past the budget is left out and listed missing.
    expect(out).toMatchObject({ native: 1, hybrid: 1, picture: 0, compact: 0 });
    const p = hub.lib.presentations.must(out.presentationId);
    const [s1, s2] = slidesOf(p) as [Slide, Slide];
    expect(refsOf(s2)).toEqual([refsOf(s1)[0]]);
    expect(s2.pptx).toMatchObject({ class: 'hybrid', missing: ['decoration'] });
    expect(s2.pptx!.pending).toBeUndefined();
    expect(s2.pptx!.notes).toEqual(['over the import budget of shape outlines: 1 shape(s) left out']);
    expect(out.notes.some((n) => /slide 2's shape outlines pass/.test(n))).toBe(true);
  });

  it('names the files in the pool worker and bounds what one batch returns: past it, the shapes naming new files go', async () => {
    // The worker names the files (SHA-256 of their re-tokenised JSON): the job gets names and bytes only.
    const scene = sceneTask({
      parts: buildDeck({ slides }),
      pictureSizes: [],
      options: {},
      range: { from: 0, to: 2 },
    });
    expect(scene.result.geoms).toEqual([]);
    expect(scene.geomFiles?.length).toBeGreaterThanOrEqual(3);
    for (const g of scene.geomFiles!) expect(createHash('sha256').update(g.bytes).digest('hex')).toBe(g.hash);
    expect(new Set(scene.geomFiles!.map((g) => g.hash)).size).toBe(3);
    // A bound that holds slide 1's two files and not slide 2's new third one.
    const sizes = new Map(scene.geomFiles!.map((g) => [g.hash, g.bytes.length]));
    const [a, b, c] = [...sizes.values()] as [number, number, number];
    const bound = a + b + Math.floor(c / 2);
    const bounded = sceneTask({
      parts: buildDeck({ slides }),
      pictureSizes: [],
      options: {},
      range: { from: 0, to: 2 },
      geomBytes: bound,
    });
    expect(bounded.geomOver).toEqual([1]);
    expect(new Set(bounded.geomFiles!.map((g) => g.hash)).size).toBe(2);
    // Through the job: slide 2 loses the shape whose new file the bound left out (M9: never a picture).
    const file = await zipDeck(buildDeck({ slides }), dir, 'batch-bound.pptx');
    const hash = await storeDeck(hub, file);
    const payload: PptxNativePayload = { hash, name: 'Template.pptx', options: {} };
    const ctx = {
      id: 'direct-batch',
      payload,
      signal: new AbortController().signal,
      log: () => {},
      progress: () => {},
      setPayload: (pl: PptxNativePayload) => {
        ctx.payload = pl;
      },
    };
    const out = (await nativeJob(hub.imports.pptx.deps, { limits: { batchGeomBytes: bound } })(
      ctx,
    )) as PptxNativeResult;
    expect(out).toMatchObject({ native: 1, hybrid: 1, picture: 0, compact: 0 });
    const [s1, s2] = slidesOf(hub.lib.presentations.must(out.presentationId)) as [Slide, Slide];
    expect(refsOf(s2)).toEqual([refsOf(s1)[0]]);
    expect(s2.pptx).toMatchObject({ class: 'hybrid', missing: ['decoration'] });
    expect(s2.pptx!.notes).toEqual(['over the import budget of shape outlines: 1 shape(s) left out']);
  });

  it('leaves out a shape whose outline file could not be stored, not a shape that never draws, keeping the slide', async () => {
    // Distinct outlines (k 7-9), so the store has none of them yet.
    const fresh = [{ shapes: deco(2, 4_000, 7) + deco(3, 4_000, 8) }, { shapes: deco(2, 4_000, 9) }];
    const file = await zipDeck(buildDeck({ slides: fresh }), dir, 'store-fails.pptx');
    const hash = await storeDeck(hub, file);
    const deps = hub.imports.pptx.deps;
    const store = Object.create(deps.store) as typeof deps.store;
    let refused = 0;
    store.putBytes = async (bytes, opts) => {
      if (opts?.mime === 'application/json' && refused++ === 0) throw new Error('disk full');
      return deps.store.putBytes(bytes, opts);
    };
    const payload: PptxNativePayload = { hash, name: 'Template.pptx', options: {} };
    const ctx = {
      id: 'direct-store',
      payload,
      signal: new AbortController().signal,
      log: () => {},
      progress: () => {},
      setPayload: (pl: PptxNativePayload) => {
        ctx.payload = pl;
      },
    };
    const out = (await nativeJob({ ...deps, store }, {})(ctx)) as PptxNativeResult;
    // The first file (slide 1's first shape's) was refused: that shape is left out, slide 2 stays native.
    expect(out).toMatchObject({ native: 1, hybrid: 1, picture: 0, compact: 0 });
    const [s1, s2] = slidesOf(hub.lib.presentations.must(out.presentationId)) as [Slide, Slide];
    expect(refsOf(s1)).toHaveLength(1);
    expect(refsOf(s1).every(isGeomFileRef)).toBe(true);
    expect(s1.pptx).toMatchObject({ class: 'hybrid', missing: ['decoration'] });
    expect(s1.pptx!.notes).toContain('its shape outlines could not be stored: 1 shape(s) left out');
    expect(refsOf(s2).every(isGeomFileRef)).toBe(true);
  });
});
