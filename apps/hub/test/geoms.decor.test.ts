/**
 * Decoration files on the hub (design/27 M9 `DecorData.ref`, decor-render; `pptx/geoms.ts`, the import core's
 * `pptx-geoms.ts`): a decoration whose parts are large is stored once as a shape file, named by the SHA-256 of
 * its JSON in place of the converter's placeholder (`pptxdecor:<n>`), kept while a stored presentation names it,
 * and shipped with a goLive as geometry files are.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DECOR_LIMITS,
  DecorFile,
  drawnShapeFileRefs,
  isGeomFileRef,
  localDigest,
  type Presentation,
  resolvePlaylist,
  type ShapeObject,
  type Slide,
} from '@ordo/domain';
import { m9Decor } from '@ordo/domain/m9.test-util.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { geomRefsIn } from '../src/libproc.ts';
import { librarySource } from '../src/live.ts';
import { liveFiles } from '../src/liveproc.ts';
import { decorFileOf, type NamedGeomFile, nameGeoms, storeGeomFiles } from '../src/pptx/geoms.ts';
import { startHub, type TestHub } from './helpers.ts';

const decorShape = (id: string, ref?: string): ShapeObject => ({
  id,
  type: 'shape',
  box: { x: 0, y: 0, w: 1920, h: 48, rotation: 0 },
  shape: 'line',
  opacity: 1,
  radius: 0,
  decor: { ...m9Decor(), ...(ref ? { parts: [], ref } : {}) },
  locked: true,
});

describe('decoration files (geoms.ts)', () => {
  it('names a decoration file by the SHA-256 of its JSON, its parts re-tokenised as stored parts are', () => {
    const parts = m9Decor().parts;
    const f = decorFileOf({ parts })!;
    expect(f.hash).toBe(createHash('sha256').update(f.bytes).digest('hex'));
    expect(DecorFile.parse(JSON.parse(new TextDecoder().decode(f.bytes))).parts).toHaveLength(parts.length);
    // A string with junk in it is the same file once re-tokenised.
    const dirty = parts.map((p, i) => (i === 0 ? { ...p, d: `${p.d} <script>` } : p));
    expect(decorFileOf({ parts: dirty })!.hash).toBe(f.hash);
    for (const bad of [undefined, {}, { parts: [] }, { parts: [{ d: 'nope', p: 0 }] }, { paths: parts }])
      expect(decorFileOf(bad)).toBeUndefined();
    // A part may name any of the 64 paints a decoration can hold (its own palette is checked where it is
    // drawn); one past them is dropped.
    const tri = 'M 0 0 L 10 0 L 5 10 Z';
    const named = decorFileOf({
      parts: [
        { d: tri, p: 63, s: 1 },
        { d: tri, p: 64, s: 1 },
      ],
    })!;
    expect(DecorFile.parse(JSON.parse(new TextDecoder().decode(named.bytes))).parts.map((p) => p.p)).toEqual([
      63,
    ]);
    // Past the decoration's point cap (16,384 of all its parts) or 256 parts: refused, not cut.
    const ring = (n: number) => `M 0 0 ${'L 1 1 '.repeat(n - 2)}Z`;
    const many = Array.from({ length: 5 }, () => ({ d: ring(4_000), p: 0, s: 1 as const }));
    expect(decorFileOf({ parts: many.slice(0, 4) })).toBeDefined();
    expect(5 * 4_000).toBeGreaterThan(DECOR_LIMITS.points);
    expect(decorFileOf({ parts: many })).toBeUndefined();
    expect(decorFileOf({ parts: Array.from({ length: 257 }, () => ({ d: tri, p: 0 })) })).toBeUndefined();
    // A hostile value never throws.
    const getter = {
      get parts(): never {
        throw new Error('hostile');
      },
    };
    expect(decorFileOf(getter)).toBeUndefined();
  });

  it('puts names in place of decoration placeholders and drops unknown ones', () => {
    const name = 'c'.repeat(64);
    const slide: Slide = {
      id: 's',
      objects: [decorShape('a', 'pptxdecor:1'), decorShape('b', 'pptxdecor:9'), decorShape('c')],
    };
    const named = nameGeoms(slide, new Map([['pptxdecor:1', name]]));
    const decors = named.objects.map((o) => (o as ShapeObject).decor);
    expect(decors[0]!.ref).toBe(name);
    // An unknown placeholder: the decoration loses it, and with no parts of its own the field (its legacy
    // line, nothing, as an older build draws it).
    expect(decors[1]).toBeUndefined();
    expect(named.objects[1]).toMatchObject({ id: 'b', type: 'shape', shape: 'line', locked: true });
    expect(named.objects[2]).toBe(slide.objects[2]);
    // Named already: the same slide back.
    expect(nameGeoms(named, new Map([[name, name]]))).toBe(named);
  });
});

describe('a DecorFile on the hub', () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  }, 60_000);
  afterAll(async () => {
    await hub?.cleanup();
  });

  it('is stored once, kept by GC and shipped by goLive', async () => {
    const f = decorFileOf({ parts: m9Decor().parts }) as NamedGeomFile;
    const files = new Map([[f.hash, f]]);
    const warn: string[] = [];
    const first = await storeGeomFiles(hub.store, hub.lib, files, [f.hash, f.hash], (m) => warn.push(m));
    const again = await storeGeomFiles(hub.store, hub.lib, files, [f.hash], (m) => warn.push(m));
    expect(first).toEqual({ written: 1, failed: [] });
    expect(again).toEqual({ written: 0, failed: [] });
    expect(warn).toEqual([]);
    const row = hub.lib.getFile(f.hash)!;
    expect(row).toMatchObject({ hash: f.hash, mime: 'application/json' });
    expect(
      createHash('sha256')
        .update(readFileSync(hub.store.abs(row.path)))
        .digest('hex'),
    ).toBe(f.hash);

    // A presentation names it: the store keeps it.
    const slide: Slide = nameGeoms(
      { id: 's1', objects: [decorShape('d', 'pptxdecor:1')] },
      new Map([['pptxdecor:1', f.hash]]),
    );
    expect(drawnShapeFileRefs(slide)).toEqual([f.hash]);
    expect(isGeomFileRef(drawnShapeFileRefs(slide)[0])).toBe(true);
    const p = hub.lib.savePresentation(
      {
        id: 'p-decor',
        rev: 1,
        title: 'Decorated',
        kind: 'slides',
        sections: [{ id: 'sec', label: 'Slides', short: 'S', slides: [slide] }],
        arrangements: [],
      } as unknown as Presentation,
      { create: true },
    );
    expect(hub.lib.fileReferenced(f.hash)).toBe(true);
    await hub.store.release(f.hash);
    expect(hub.lib.getFile(f.hash)).toBeDefined();

    // goLive lists it with the geometry files, and the live process serves it.
    expect([...geomRefsIn({ [p.id]: p })]).toEqual([f.hash]);
    const pl = hub.lib.playlists.insert({
      id: 'pl-decor',
      rev: 1,
      name: 'Decorated',
      items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }],
    });
    const r = resolvePlaylist(librarySource(hub.lib).goLiveInputs(pl.id), pl.id, { digest: localDigest });
    expect(r.geoms?.map((g) => g.hash)).toEqual([f.hash]);
    expect(r.files.some((x) => x.hash === f.hash)).toBe(true);
    expect(liveFiles(r, undefined).has(f.hash)).toBe(true);
    expect(r.degraded ?? []).toEqual([]);

    // Once no presentation names it, the store lets it go.
    hub.lib.presentations.delete(p.id);
    expect(hub.lib.fileReferenced(f.hash)).toBe(false);
    await hub.store.release(f.hash);
    expect(hub.lib.getFile(f.hash)).toBeUndefined();
  });
});
