/**
 * The hub's check of a scene parsed in the browser (`clientScene.ts`, design/27 §12): what it takes, what it
 * refuses (the hub then parses the deck itself), and that no input makes it throw.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type PptxClientScene, parsePptxScene } from '@ordo/importers';
import {
  body,
  buildDeck,
  custGeom,
  imageRel,
  para,
  pic,
  run,
  solid,
  sp,
} from '@ordo/pptx-scene/test-util.ts';
import fc from 'fast-check';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { checkClientScene, clientSceneTask } from '../src/pptx/clientScene.ts';

const IN = 914_400;
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

let scene: PptxClientScene;
const dir = mkdtempSync(join(tmpdir(), 'ordo-scene-'));

beforeAll(async () => {
  let path = `<a:moveTo><a:pt x="0" y="0"/></a:moveTo>`;
  for (let i = 1; i < 3_000; i++)
    path += `<a:lnTo><a:pt x="${(i * 7_919) % 9_000_000}" y="${(i * 104_729) % 5_000_000}"/></a:lnTo>`;
  const parts = buildDeck({
    slides: [
      {
        shapes: [
          sp({ id: 2, x: IN, y: IN, cx: 4 * IN, cy: IN, txBody: body(para(run('Amazing grace'))) }),
          pic({ id: 3, x: IN, y: 2 * IN, cx: 2 * IN, cy: 2 * IN, rId: 'rId2' }),
          sp({
            id: 4,
            x: 0,
            y: 0,
            cx: 2 * IN,
            cy: IN,
            geom: 'none',
            fill: `${custGeom({ paths: `<a:path w="10000000" h="6000000">${path}<a:close/></a:path>` })}${solid('FF0000')}`,
          }),
        ].join(''),
        rels: [imageRel('rId2', '../media/image1.png')],
      },
      { shapes: sp({ id: 2, x: IN, y: IN, cx: 4 * IN, cy: IN, txBody: body(para(run('How sweet'))) }) },
    ],
    media: { 'ppt/media/image1.png': PNG },
  });
  const z = new JSZip();
  for (const [k, v] of parts) z.file(k, v);
  scene = (await parsePptxScene(await z.generateAsync({ type: 'uint8array' }))).scene;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const copy = (): PptxClientScene => structuredClone(scene);

describe('checkClientScene', () => {
  it("takes a scene of this hub's converter, its shape files re-hashed as the store names them", () => {
    expect(scene.geomFiles.length).toBe(1);
    const out = checkClientScene(copy(), { libreoffice: true });
    expect('scene' in out).toBe(true);
    if (!('scene' in out)) return;
    expect(out.scene.slides).toHaveLength(2);
    expect(out.scene.geomFiles.map((f) => f.hash)).toEqual(scene.geomFiles.map((g) => g.hash));
    expect(new TextDecoder().decode(out.scene.geomFiles[0]!.bytes)).toBe(scene.geomFiles[0]!.json);
  });

  it('refuses another converter, other stored fields and the other LibreOffice state', () => {
    expect(checkClientScene({ ...copy(), version: 1 }, { libreoffice: true })).toEqual({
      refused: 'parsed by another converter version',
    });
    expect(checkClientScene({ ...copy(), m9Writes: ['vectorFonts'] }, { libreoffice: true })).toEqual({
      refused: 'parsed with other stored fields',
    });
    expect(checkClientScene(copy(), { libreoffice: false })).toEqual({
      refused: 'parsed for a hub with LibreOffice',
    });
  });

  it('refuses part names past the bound before they reach a payload, and a listing out of order', () => {
    const long = `ppt/media/${'a'.repeat(600)}.png`;
    for (const mutate of [
      (s: PptxClientScene) => {
        s.scan.pictures.push(long);
      },
      (s: PptxClientScene) => {
        s.listed[0]!.part = long;
      },
      (s: PptxClientScene) => {
        s.media.push({ id: 'pptxmedia:9', part: long });
      },
      (s: PptxClientScene) => {
        s.slides[0]!.metafiles = [{ part: long, object: s.slides[0]!.slide.objects[1] as never }];
      },
      (s: PptxClientScene) => {
        s.listed.reverse();
      },
      (s: PptxClientScene) => {
        s.slides.push(structuredClone(s.slides[0]!));
      },
      (s: PptxClientScene) => {
        s.extras.push({ index: 99 });
      },
    ]) {
      const s = copy();
      mutate(s);
      expect('refused' in checkClientScene(s, { libreoffice: true })).toBe(true);
    }
  });

  it('builds from each slide as the schema parsed it, and refuses a slide whose objects the schema filled in', () => {
    const s = copy();
    // A value the schema replaces (`transition` catches to undefined): the checked slide holds the parse.
    (s.slides[1]!.slide as unknown as Record<string, unknown>).transition = { kind: 'no such kind' };
    const out = checkClientScene(s, { libreoffice: true });
    expect('scene' in out).toBe(true);
    if (!('scene' in out)) return;
    expect('transition' in out.scene.slides[1]!.slide && out.scene.slides[1]!.slide.transition).toBeFalsy();
    expect(out.scene.slides[1]!.slide.objects.length).toBe(scene.slides[1]!.slide.objects.length);
    // No objects at all: the schema would default them to [], but the converter always writes them.
    const t = copy();
    t.slides[0]!.slide = { id: 'x' } as never;
    expect(checkClientScene(t, { libreoffice: true })).toEqual({ refused: 'slides.0: not a slide' });
  });

  it('drops a shape file whose JSON is not what its name says, or not storable, and keeps the rest', () => {
    const s = copy();
    const g = s.geomFiles[0]!;
    s.geomFiles = [
      { hash: g.hash, json: g.json.replace(/\d/, (d) => String((Number(d) + 1) % 10)) },
      { hash: 'a'.repeat(64), json: '{"paths":"no"}' },
      { hash: 'b'.repeat(64), json: '{' },
    ];
    const out = checkClientScene(s, { libreoffice: true });
    expect('scene' in out && out.scene.geomFiles).toEqual([]);
  });

  it('reads the stored file in the pool task within its bound', () => {
    const file = join(dir, 'scene.json');
    writeFileSync(file, JSON.stringify(scene));
    expect('scene' in clientSceneTask({ file, libreoffice: true })).toBe(true);
    expect(clientSceneTask({ file, libreoffice: true, maxBytes: 100 })).toEqual({
      refused: 'larger than a scene may be',
    });
    writeFileSync(file, '{"version":');
    expect(clientSceneTask({ file, libreoffice: true })).toEqual({ refused: 'not JSON' });
    expect(clientSceneTask({ file: join(dir, 'gone.json'), libreoffice: true })).toEqual({
      refused: 'the scene file could not be read',
    });
  });

  it('never throws on a mutated scene, and takes only what passes its schema (fuzz)', () => {
    const base = JSON.parse(JSON.stringify(scene)) as Record<string, unknown>;
    const paths: string[][] = [];
    const walk = (v: unknown, at: string[], depth: number) => {
      if (depth > 7 || paths.length > 4_000) return;
      paths.push(at);
      if (Array.isArray(v)) {
        for (const [i, x] of v.slice(0, 4).entries()) walk(x, [...at, String(i)], depth + 1);
      } else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) walk(x, [...at, k], depth + 1);
    };
    walk(base, [], 0);
    const hostile = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant('__proto__'),
      fc.string({ maxLength: 700 }),
      fc.double(),
      fc.integer(),
      fc.constant(Number.NaN),
      fc.constant(1e308),
      fc.array(fc.anything({ maxDepth: 2 }), { maxLength: 5 }),
      fc.dictionary(fc.string({ maxLength: 8 }), fc.anything({ maxDepth: 1 }), { maxKeys: 4 }),
    );
    const t0 = performance.now();
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(paths.length - 1), hostile), { minLength: 1, maxLength: 4 }),
        (edits) => {
          const s = structuredClone(base);
          for (const [i, v] of edits) {
            const at = paths[i]!;
            if (!at.length) continue;
            let o: unknown = s;
            for (const k of at.slice(0, -1))
              o = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;
            // An earlier edit may have replaced a parent with a value of another kind.
            if (o && typeof o === 'object') (o as Record<string, unknown>)[at[at.length - 1]!] = v;
          }
          const out = checkClientScene(s, { libreoffice: true });
          expect('scene' in out || typeof out.refused === 'string').toBe(true);
        },
      ),
      { numRuns: 400, seed: 11 },
    );
    expect(performance.now() - t0).toBeLessThan(budgetMs(20_000));
  });
});
