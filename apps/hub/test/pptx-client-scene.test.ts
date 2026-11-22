/**
 * The hub's check of a scene parsed in the browser (`clientScene.ts`, design/27 §12): what it takes, what it
 * refuses (the hub then parses the deck itself), and that no input makes it throw.
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShapeObject } from '@ordo/domain';
import { type PptxClientScene, parsePptxScene } from '@ordo/importers';
import { type Converted, ImportCore } from '@ordo/importers/pptx-core.ts';
import { ImportLog } from '@ordo/importers/pptx-report.ts';
import {
  body,
  buildDeck,
  custGeom,
  denseTableDeck,
  grpSp,
  imageRel,
  para,
  pic,
  run,
  sfntFont,
  solid,
  sp,
  tableFrame,
  tc,
} from '@ordo/pptx-scene/test-util.ts';
import fc from 'fast-check';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { pictureGuardDeck } from '@ordo/importers/pptx-guard.test-util.ts';
import {
  type ClientSceneTaskInput,
  checkClientScene,
  clientSceneTask,
  SCRIPT_FACE_REFUSAL,
  tablesNeedScripts,
} from '../src/pptx/clientScene.ts';
import type { JobCtx } from '../src/jobs.ts';
import type { CpuPool } from '../src/pool.ts';
import { nativeJob } from '../src/pptx/nativeJob.ts';
import type { PptxNativePayload, PptxNativeResult, SceneTaskInput } from '../src/pptx/shared.ts';
import { startHub } from './helpers.ts';
import { storeDeck, zipDeck } from './pptx-helpers.ts';
import { nameGeoms } from '../src/pptx/geoms.ts';
import { sceneTask } from '../src/pptx/sceneTask.ts';

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

  it('refuses a decoration file whose JSON is not what its name says, and the slide loses its ref', async () => {
    // A layout of 160 text-less shapes of as many colours: one decoration, in a decoration file.
    let shapes = '';
    for (let i = 0; i < 160; i++) {
      const hex = (0x102030 + i * 0x010305).toString(16).slice(-6).padStart(6, '0');
      shapes += sp({
        id: 10 + i,
        x: (i % 16) * (IN / 2),
        y: Math.floor(i / 16) * (IN / 4),
        cx: IN / 4,
        cy: IN / 6,
        geom: i % 2 ? 'ellipse' : 'star5',
        fill: solid(hex),
      });
    }
    const parts = buildDeck({
      layouts: [{ shapes: grpSp({ id: 2, x: 0, y: 0, cx: 8 * IN, cy: 4 * IN }, shapes) }],
      slides: [{ shapes: '' }],
    });
    const z = new JSZip();
    for (const [k, v] of parts) z.file(k, v);
    const decorated = (await parsePptxScene(await z.generateAsync({ type: 'uint8array' }))).scene;
    const refs = decorated.slides[0]!.slide.objects.flatMap((o) =>
      o.type === 'shape' && o.decor?.ref ? [o.decor.ref] : [],
    );
    expect(refs.length).toBeGreaterThan(0);
    const file = decorated.geomFiles.find((g) => g.hash === refs[0])!;
    expect(JSON.parse(file.json).parts.length).toBeGreaterThan(0);
    // As sent: taken, re-hashed by its kind (a decoration file), the same name.
    const ok = checkClientScene(structuredClone(decorated), { libreoffice: true });
    expect('scene' in ok && ok.scene.geomFiles.map((f) => f.hash)).toContain(refs[0]);
    // Tampered (a paint index past the palette, a number changed, parts that are no parts): refused, and the
    // job's renaming over the files kept (`nativeJob.ts`) takes the ref off the decoration.
    for (const json of [
      file.json.replace('"p":0', '"p":64'),
      file.json.replace(/\d/, (d) => String((Number(d) + 1) % 10)),
      '{"parts":"no"}',
    ]) {
      const s = structuredClone(decorated);
      s.geomFiles = s.geomFiles.map((g) => (g.hash === refs[0] ? { ...g, json } : g));
      const out = checkClientScene(s, { libreoffice: true });
      if (!('scene' in out)) throw new Error(out.refused);
      const kept = new Map(out.scene.geomFiles.map((f) => [f.hash, f.hash]));
      expect(kept.has(refs[0]!)).toBe(false);
      const slide = nameGeoms(out.scene.slides[0]!.slide, kept);
      const left = slide.objects.flatMap((o) => (o.type === 'shape' && o.decor?.ref ? [o.decor.ref] : []));
      expect(left).not.toContain(refs[0]);
    }
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

describe("a slide past the guard (lo-forms: the guard's left-outs to LibreOffice's art on a hub with it)", () => {
  /** What a slide's plan is, apart from ids: its class and reasons, its art's elements and box, what it lists. */
  const plan = (sl: PptxClientScene['slides'][number]) => ({
    classification: sl.classification,
    art: sl.art && {
      elements: sl.art.elements,
      box: sl.art.box,
      text: sl.art.text,
      replaces: sl.art.replaces.length,
    },
    missing: sl.missing,
    notes: sl.notes,
    objects: sl.slide.objects.map((o) => o.type),
  });

  it('hub and client scenes are equal for a guard deck with LibreOffice, and the hub takes it only then', async () => {
    const parts = pictureGuardDeck();
    const z = new JSZip();
    for (const [k, v] of parts) z.file(k, v);
    const client = (await parsePptxScene(await z.generateAsync({ type: 'uint8array' }))).scene;
    const own = (libreoffice: boolean) =>
      sceneTask({
        parts: new Map(parts),
        pictureSizes: [],
        range: { from: 0, to: 1 },
        options: {},
        ...(libreoffice ? {} : { libreoffice: false }),
      }).result.slides[0]!;
    const [slide] = client.slides;
    // With LibreOffice, on both: the five topmost pictures are its art, nothing is listed missing.
    expect(slide!.art?.elements.map((r) => r.shapeId)).toEqual([17, 18, 19, 20, 21]);
    expect(slide!.missing).toBeUndefined();
    expect(plan(slide!)).toEqual(plan(own(true)));
    // Without it the hub's own parse lists them (and keeps one picture more): a scene parsed for LibreOffice
    // is refused there, and taken whole, art included, where LibreOffice is.
    expect(plan(own(false))).toMatchObject({ missing: ['decoration'], art: undefined });
    expect(checkClientScene(structuredClone(client), { libreoffice: false })).toEqual({
      refused: 'parsed for a hub with LibreOffice',
    });
    const taken = checkClientScene(structuredClone(client), { libreoffice: true });
    expect('scene' in taken && taken.scene.slides[0]!.art?.elements).toHaveLength(5);
  });
});

describe('a dense table slide (M9: every table is the table object, on every hub)', () => {
  it("an older operator's scene with tableGroupBytes is accepted, the field dropped: the table object on a hub with LibreOffice", async () => {
    // An operator of the interim rule's build (M9 tables-conv) sent, with LibreOffice, what the slide's tables
    // would add as their M6 group; the hub takes its scene and stores the slide as the table object all the same.
    const parts = denseTableDeck(28);
    const z = new JSZip();
    for (const [k, v] of parts) z.file(k, v);
    const client = (await parsePptxScene(await z.generateAsync({ type: 'uint8array' }))).scene;
    const older = structuredClone(client);
    (older.slides[0] as unknown as Record<string, unknown>).tableGroupBytes = 90_000;
    const taken = checkClientScene(older, { libreoffice: true });
    if (!('scene' in taken)) throw new Error(`refused: ${taken.refused}`);
    const slide = taken.scene.slides[0]!;
    // The import core's steps 3-4 as the hub's job runs them on a checked scene (`nativeJob.ts`).
    const core = new ImportCore({ lo: true, log: new ImportLog(), warn: () => {}, geomFileBytes: 1 << 20 });
    const converted = new Map<number, Converted>([[slide.index, { s: slide, media: new Map() }]]);
    const drafts = core.drafts(taken.scene.listed, converted, taken.scene.scan);
    core.budget(drafts);
    const d = drafts[0]!;
    expect(d.cls).toBe('native');
    const tables = d.slide.objects.filter((o) => o.type === 'shape' && (o as ShapeObject).table);
    expect(tables).toHaveLength(1);
    expect((tables[0] as ShapeObject).table!.cells).toHaveLength(140);
    expect(d.notes.some((n) => /LibreOffice draws its page/.test(n))).toBe(false);
    // The field is not this hub's: the schema drops it.
    expect(slide).not.toHaveProperty('tableGroupBytes');
    // The hub's own parse of the deck weighs no M6 group either.
    const own = sceneTask({ parts: new Map(parts), pictureSizes: [], range: { from: 0, to: 1 }, options: {} })
      .result.slides[0]!;
    expect(own).not.toHaveProperty('tableGroupBytes');
  });

  /** The import core's steps 3-5 on a checked scene, as the hub's job runs them (`nativeJob.ts`). */
  async function storedOn(scene: PptxClientScene, lo: boolean) {
    const taken = checkClientScene(scene, { libreoffice: lo });
    if (!('scene' in taken)) throw new Error(`refused: ${taken.refused}`);
    const slide = taken.scene.slides[0]!;
    const core = new ImportCore({ lo, log: new ImportLog(), warn: () => {}, geomFileBytes: 1 << 20 });
    const converted = new Map<number, Converted>([[slide.index, { s: slide, media: new Map() }]]);
    const drafts = core.drafts(taken.scene.listed, converted, taken.scene.scan);
    core.budget(drafts);
    const cls = drafts[0]!.cls;
    const { p } = core.assemble(drafts, new Map(), {
      id: 'p',
      title: 'Plan',
      hash: 'h'.repeat(64),
      sections: [],
      slideRect: { x: 0, y: 0, w: 1920, h: 1080 },
      scan: { loop: false },
      hasAlpha: () => false,
      clipIds: new Set(),
      libraryFamilies: [],
    });
    return { cls, slide: p.sections[0]!.slides[0]! };
  }
  const tableIn = (objects: readonly unknown[]) =>
    (objects as ShapeObject[]).find((o) => o.type === 'shape' && !!o.table)!;
  async function denseScene(lo: boolean): Promise<PptxClientScene> {
    const z = new JSZip();
    for (const [k, v] of denseTableDeck(12)) z.file(k, v);
    return (await parsePptxScene(await z.generateAsync({ type: 'uint8array' }), { libreoffice: lo })).scene;
  }

  for (const lo of [false, true])
    it(`an r2b-sw1m operator's scene with tables in the grow form is stored as sent, on a hub ${lo ? 'with' : 'without'} LibreOffice`, async () => {
      // CONVERTER_VERSION stayed 2 through sub-wave 1b (plan section 11, 3 since Q24.b), so a hub of 1b took the scene
      // of an operator of sub-wave 1: its table objects carry the deck's a:tr rows and no rowRule (the drawer grows
      // them). Nothing re-lays them out: the rows and the grow rule stay as sent (review 1b, lens 4).
      const grow = structuredClone(await denseScene(lo));
      const t = tableIn(grow.slides[0]!.slide.objects);
      expect(t.table!.rowRule).toBe('fixed');
      const { rowRule: _, ...table } = t.table!;
      t.table = { ...table, rows: table.rows.map((h) => +((h * 2) / 3).toFixed(3)) };
      t.box = { ...t.box, h: t.table.rows.reduce((s, h) => s + h, 0) };
      const { cls, slide } = await storedOn(grow, lo);
      expect(cls).toBe('native');
      const st = tableIn(slide.objects);
      expect(st.table!.rowRule ?? 'grow').toBe('grow');
      expect(st.table!.rows).toEqual(t.table.rows);
      // The box as the schema rounds it (0.01 px).
      expect(Math.abs(st.box.h - t.box.h)).toBeLessThan(0.01);
      expect(slide.pptx!.version).toBe(3);
    });

  it("an older operator's scene with tableGroupBytes is accepted on a hub without LibreOffice too: the table object", async () => {
    const older = structuredClone(await denseScene(false));
    (older.slides[0] as unknown as Record<string, unknown>).tableGroupBytes = 90_000;
    const { cls, slide } = await storedOn(older, false);
    expect(cls).toBe('native');
    expect(tableIn(slide.objects).table!.cells).toHaveLength(60);
    expect(slide).not.toHaveProperty('tableGroupBytes');
  });
});

describe('a scene whose table cells need a script face only this computer has (rule H, sub-wave 1c)', () => {
  const KO = '이야기를 나누는 시간';
  const koCell = (text: string) =>
    tc(text, {
      rPr: 'lang="ko-KR"',
      rPrChildren: '<a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/>',
    });
  const table = (text: string) =>
    tableFrame({ id: 4, x: IN, y: IN, cols: [4 * IN], rows: [{ h: 1, cells: [koCell(text)] }] });
  /** A Korean table cell; Korean only in a text box (its table Latin); Korean in a table inside a group. */
  const decks = {
    table: () => buildDeck({ slides: [{ shapes: table(KO) }] }),
    boxOnly: () =>
      buildDeck({
        slides: [
          {
            shapes:
              table('Amazing grace') +
              sp({
                id: 9,
                x: IN,
                y: 4 * IN,
                cx: 6 * IN,
                cy: IN,
                txBody: body(para(run(KO, 'lang="ko-KR"'))),
              }),
          },
        ],
      }),
  };
  const zip = async (parts: Map<string, Uint8Array>) => {
    const z = new JSZip();
    for (const [k, v] of parts) z.file(k, v);
    return z.generateAsync({ type: 'uint8array' });
  };
  const sceneFile = async (parts: Map<string, Uint8Array>, name: string) => {
    const s = (await parsePptxScene(await zip(parts), { libreoffice: true })).scene;
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(s));
    return { scene: s, file };
  };

  it("the pool task refuses it when the hub measures that script with its computer's face; else, and for boxes, it is used", async () => {
    const t = await sceneFile(decks.table(), 'ko-table.json');
    expect(clientSceneTask({ file: t.file, libreoffice: true, systemOnlyScripts: ['Hang'] })).toEqual({
      refused: SCRIPT_FACE_REFUSAL,
    });
    expect(SCRIPT_FACE_REFUSAL).toBe('its tables need a script face only this computer has');
    expect('scene' in clientSceneTask({ file: t.file, libreoffice: true, systemOnlyScripts: [] })).toBe(true);
    expect('scene' in clientSceneTask({ file: t.file, libreoffice: true })).toBe(true);
    // A face for another script only (Han): the Hangul cell is measured as the browser measures it.
    expect('scene' in clientSceneTask({ file: t.file, libreoffice: true, systemOnlyScripts: ['Hani'] })).toBe(
      true,
    );
    // Hangul in a text box only: text boxes are not measured, so the browser's scene is the hub's.
    const b = await sceneFile(decks.boxOnly(), 'ko-box.json');
    expect('scene' in clientSceneTask({ file: b.file, libreoffice: true, systemOnlyScripts: ['Hang'] })).toBe(
      true,
    );
  });

  it('reads table cells only, in groups too, and never throws', () => {
    const cell = (text: string) => ({ type: 'shape', table: { cells: [{}, { text }] } });
    const slide = (objects: unknown[]) => ({ slide: { objects } });
    expect(tablesNeedScripts([slide([cell('가')])], ['Hang'])).toBe(true);
    expect(tablesNeedScripts([slide([cell('一')])], ['Hang'])).toBe(false);
    expect(tablesNeedScripts([slide([cell('一')])], ['Hani', 'Hang'])).toBe(true);
    expect(tablesNeedScripts([slide([{ type: 'text', text: '가' }])], ['Hang'])).toBe(false);
    expect(tablesNeedScripts([slide([{ type: 'group', objects: [cell('あ')] }])], ['Hira'])).toBe(true);
    expect(tablesNeedScripts([slide([cell('가')])], [])).toBe(false);
    for (const junk of [
      null,
      1,
      'x',
      { table: { cells: 'x' } },
      { objects: 'x' },
      { table: { cells: [null] } },
    ])
      expect(tablesNeedScripts([slide([junk])], ['Hang'])).toBe(false);
  });

  it('through a hub: the same decision whether the import starts before its faces settle or after; the deck is not opened for it', async () => {
    const hangul = join(dir, 'hangul-1c.ttf');
    writeFileSync(
      hangul,
      // A Hangul face: it maps the letters rule H checks a face for (`SYSTEM_FACE_LETTERS`).
      sfntFont(Object.fromEntries([...new Set(`${KO}가나다라마바사아자하한글`)].map((c) => [c, 1000])), {
        vertical: { ascender: 1000, descender: -260 },
      }),
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hub = await startHub({
      systemFaces: async (script) => {
        await gate;
        return script === 'Hang' ? { file: hangul, index: 0 } : undefined;
      },
    });
    try {
      const run = async (parts: Map<string, Uint8Array>, name: string) => {
        const hash = await storeDeck(hub, await zipDeck(parts, dir, `${name}.pptx`));
        const s = await sceneFile(parts, `${name}.json`);
        const tmp = hub.store.tmpPath('json');
        writeFileSync(tmp, readFileSync(s.file));
        const sceneHash = (await hub.store.put(tmp, { ext: 'json', mime: 'application/json' })).hash;
        // The deck is away while the scene is checked: the check reads the scene file only.
        const deckFile = hub.store.abs(hub.lib.getFile(hash)!.path);
        renameSync(deckFile, `${deckFile}.away`);
        const checked: Record<string, unknown>[] = [];
        const pool = {
          run: (async (kind: string, input: SceneTaskInput) => {
            if (kind === 'pptx-client-scene') {
              checked.push({
                ...(input as unknown as Record<string, unknown>),
                deckThere: existsSync(deckFile),
              });
              const out = clientSceneTask(input as unknown as ClientSceneTaskInput);
              renameSync(`${deckFile}.away`, deckFile);
              return out;
            }
            return sceneTask(input);
          }) as CpuPool['run'],
        };
        const logs: string[] = [];
        let cur: PptxNativePayload = { hash, name: `${name}.pptx`, options: {}, sceneHash };
        const job = nativeJob(hub.imports.pptx.deps, { pool })({
          id: `scene-${name}`,
          payload: cur,
          signal: new AbortController().signal,
          progress: () => undefined,
          log: (line: string) => {
            logs.push(line);
          },
          setPayload: (next) => {
            cur = next;
          },
        } as JobCtx<PptxNativePayload>) as Promise<PptxNativeResult>;
        return { job, logs, checked };
      };
      // Started during start-up: it waits for the faces before the scene is checked.
      const early = await run(decks.table(), 'ko-early');
      await new Promise((r) => setTimeout(r, 200));
      expect(early.checked).toEqual([]);
      release();
      await early.job;
      const refusal = `the scene parsed in the browser was not used (${SCRIPT_FACE_REFUSAL}): parsed here`;
      expect(early.logs).toContain(refusal);
      expect(early.checked).toHaveLength(1);
      expect(early.checked[0]).toMatchObject({
        libreoffice: true,
        systemOnlyScripts: ['Hang'],
        deckThere: false,
      });
      expect(Object.keys(early.checked[0]!).sort()).toEqual([
        'deckThere',
        'file',
        'libreoffice',
        'systemOnlyScripts',
      ]);
      // After start-up: the same decision; a deck with Hangul only in a box keeps the browser's scene.
      const later = await run(decks.table(), 'ko-later');
      await later.job;
      expect(later.logs).toContain(refusal);
      const box = await run(decks.boxOnly(), 'ko-box');
      await box.job;
      expect(box.logs.some((l) => /parsed in the browser: the hub checked/.test(l))).toBe(true);
      expect(box.logs.join('\n')).not.toMatch(/was not used/);
    } finally {
      release();
      await hub.cleanup();
    }
  }, 180_000);
});
