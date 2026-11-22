/**
 * The native import with the hub's own headless Chromium (Q53, H6, RS1-RS4 of the track): a synthetic deck with a 5,000-point
 * outline and 600 small shapes imports to ONE picture; a text-bearing many-point shape in a family no library face covers puts the
 * run back as shapes (the picture is complete or not made); a hub with no Chromium (or only LibreOffice) imports as today and says
 * so; Reset slide brings the shapes back and a whole Re-import makes the picture again. Skipped, and said so, when no Chromium is
 * found (ORDO_CHROMIUM, ORDO_TEST_CHROMIUM, Playwright); under CI a missing one fails (find-chromium.ts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { firstText, type ImageObject, importedText, type Slide, strapText } from '@ordo/domain';
import { buildDeck, custGeom, body, para, run, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { presentationDoc } from '../../operator/src/lib/search.ts';
import { slideText } from '../../stage/src/model.ts';
import { findChromium } from '../../../tools/find-chromium.ts';
import type { PptxNativeResult } from '../src/pptx/shared.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

const exe = await findChromium({ system: true });
if (exe === undefined)
  console.warn(
    'pptx-rasters-import.test.ts SKIPPED: no Chromium found (ORDO_CHROMIUM, ORDO_TEST_CHROMIUM, Playwright)',
  );
const maybe = exe === undefined ? describe.skip : describe;

const IN = 914_400;
const ON = { setting: 'on', on: true, store: true } as const;

function poly(cost: number, phase = 0, w = 100_000, h = 100_000): string {
  const n = cost - 2;
  const pt = (i: number) => {
    const a = (2 * Math.PI * i) / (n + 1) + phase * 0.01;
    return `<a:pt x="${Math.round(w / 2 + (w / 2) * Math.cos(a))}" y="${Math.round(h / 2 + (h / 2) * Math.sin(a))}"/>`;
  };
  let d = `<a:moveTo>${pt(0)}</a:moveTo>`;
  for (let i = 1; i <= n; i++) d += `<a:lnTo>${pt(i)}</a:lnTo>`;
  return `<a:path w="${w}" h="${h}">${d}<a:close/></a:path>`;
}

const blob = (id: number, cost: number, x: number, y: number, cx: number, cy: number, txBody = '') =>
  sp({
    id,
    x,
    y,
    cx,
    cy,
    geom: 'none',
    fill: custGeom({ paths: poly(cost, id) }) + solid('3366AA'),
    ...(txBody ? { txBody } : {}),
  });

/** A 5,000-point outline of one path, 600 small shapes and a 300-point shape above them. */
function continentDeck(extra = ''): Map<string, Uint8Array> {
  const small = Array.from({ length: 600 }, (_, k) =>
    sp({
      id: 10 + k,
      x: IN + (k % 30) * 150_000,
      y: 4 * IN + Math.floor(k / 30) * 150_000,
      cx: 120_000,
      cy: 120_000,
      fill: solid(k % 2 ? 'AA3366' : '33AA66'),
    }),
  ).join('');
  // A run starts at a many-point shape and takes the small shapes between it and the next one (Q53.e): the outline, the 600
  // small shapes, then a second many-point shape above them; the extra shape, if any, is above that.
  return buildDeck({
    slides: [
      {
        shapes:
          blob(2, 5_000, IN, IN, 4 * IN, 3 * IN) +
          small +
          blob(3, 300, 6 * IN, 4 * IN, 2 * IN, 2 * IN) +
          extra,
      },
    ],
  });
}

const rasterPictures = (s: Slide): ImageObject[] =>
  s.objects.filter((o): o is ImageObject => o.type === 'image' && o.origin?.role === 'raster');

/** Processes whose command line names `dir` (the hub's data folder, where the browser's profile lives). */
function processesUnder(dir: string): number {
  let n = 0;
  for (const pid of readdirSync('/proc').filter((f) => /^\d+$/.test(f))) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dir)) n++;
    } catch {
      /* gone */
    }
  }
  return n;
}

maybe("the native import draws pictures of many-point shapes with the hub's own Chromium", () => {
  let hub: TestHub;
  let dir: string;
  beforeAll(async () => {
    // The test probe answers for every tool; the one for Chromium names the real executable the picture driver launches.
    hub = await startHub({
      prerender: ON,
      chromium: { path: exe!, sandbox: false },
      // The bundled faces of this computer (Inter, Carlito, ...) are the library's: the page draws the words of a pictured shape with them.
      fontsDir: '/usr/share/fonts',
      // A hub without LibreOffice (a hub with it keeps LibreOffice's art and plans no pictures, M-SR5): the pictures are planned.
      toolProbe: ((t: string) =>
        t === 'chromium'
          ? { state: 'available', exe }
          : { state: t === 'libreoffice' ? 'absent' : 'available' }) as never,
    });
    dir = tempDir('ordo-rasters-import-');
  });
  afterAll(async () => {
    await hub?.cleanup();
  });

  async function importDeck(h: TestHub, parts: Map<string, Uint8Array>, name = 'Shapes.pptx') {
    const file = await zipDeck(parts, dir, `${Math.random().toString(36).slice(2)}.pptx`);
    const hash = await storeDeck(h, file);
    const job = await waitJob(h, h.imports.pptx.queueNative(hash, name, {}).id, 180_000);
    if (job.state !== 'done') throw new Error(`import failed: ${job.error}\n${job.log.join('\n')}`);
    const result = job.result as PptxNativeResult;
    return { job, hash, result, p: h.lib.presentations.must(result.presentationId) };
  }

  it('H6: one picture is stored, the slide is complete at version 1, and nothing is left running', async () => {
    const { result, p, job } = await importDeck(hub, continentDeck());
    expect(result.rasters).toMatchObject({ pictures: 1, stored: 1, putBack: 0, candidates: 2 });
    expect(result.rasters!.shapes).toBe(602);
    const [slide] = slidesOf(p);
    const pictures = rasterPictures(slide!);
    expect(pictures).toHaveLength(1);
    // The pictured shapes are not objects any more (the 600 small ones drawn in and the outline); the slide is one picture.
    expect(slide!.objects.map((o) => [o.type, o.origin?.role])).toEqual([
      ['shape', 'bg'],
      ['image', 'raster'],
    ]);
    const m = hub.lib.media.must(pictures[0]!.mediaId);
    expect(m).toMatchObject({ kind: 'image', state: 'ready' });
    expect(m.hasAlpha).toBe(true);
    expect(pictures[0]!.locked).toBe(true);
    expect(pictures[0]!.origin?.raster).toMatchObject({ n: 602, from: 'slide' });
    expect(slide!.pptx).toMatchObject({ class: 'native' });
    expect(p.rev).toBe(1);
    expect(job.log.join('\n')).toMatch(/1 of 1 picture\(s\) of shapes stored/);
    // Nothing waits on a picture after the import: no job queued or running, and no browser process of this hub's folder.
    expect(hub.jobs.deferred()).toHaveLength(0);
    expect(processesUnder(hub.dir)).toBe(0);
  }, 240_000);

  it('Re-import of the unchanged deck stores no new media (the recipe hash finds the picture)', async () => {
    const parts = continentDeck();
    const first = await importDeck(hub, parts, 'Again.pptx');
    const before = hub.lib.media.list().length;
    const job = await waitJob(
      hub,
      hub.imports.pptx.queueReimport(first.p.id, first.hash, {}, 'test').id,
      180_000,
    );
    expect(job.state, job.error).toBe('done');
    expect(hub.lib.media.list().length).toBe(before);
  }, 300_000);

  it('a text-bearing many-point shape in a family no library face covers puts the whole run back as shapes, and says so', async () => {
    const words = body(
      para(run('Hello shapes', 'sz="2400" lang="en-US"', '<a:latin typeface="Nonexistent Family XYZ"/>')),
    );
    const { result, p } = await importDeck(
      hub,
      continentDeck(blob(5, 300, 6 * IN, IN, 3 * IN, 2 * IN, words)),
      'Font.pptx',
    );
    expect(result.rasters).toMatchObject({ pictures: 1, stored: 0, putBack: 1 });
    expect(result.rasters!.reasons).toContain('font');
    const [slide] = slidesOf(p);
    expect(rasterPictures(slide!)).toHaveLength(0);
    // The shapes are back (a valid slide: no image with an unmapped id, the words are text again).
    expect(slide!.objects.some((o) => o.type === 'text' || o.type === 'shape')).toBe(true);
    expect(slide!.objects.some((o) => o.type === 'image')).toBe(false);
    expect(JSON.stringify(slide)).not.toMatch(/pptxmedia:/);
    expect(processesUnder(hub.dir)).toBe(0);
  }, 240_000);

  it('M-SR8 words arm: the words of six text-bearing shapes drawn into a picture reach artText, the cue label, the Stage and search (Q68)', async () => {
    const family = hub.lib.listFonts().find((f) => f.family === 'Inter')?.family;
    expect(family, 'the hub library holds Inter (the bundled default)').toBeDefined();
    const WORDS = ['Mercy', 'Grace', 'Peace', 'Hope', 'Faith', 'Love'];
    const six = WORDS.map((w, k) =>
      blob(
        20 + k,
        300,
        IN + (k % 3) * 3 * IN,
        IN + Math.floor(k / 3) * 3 * IN,
        2 * IN,
        2 * IN,
        body(para(run(w, 'sz="2400" lang="en-US"', `<a:latin typeface="${family}"/>`))),
      ),
    ).join('');
    const { result, p } = await importDeck(hub, buildDeck({ slides: [{ shapes: six }] }), 'Words.pptx');
    expect(result.rasters).toMatchObject({ pictures: 1, stored: 1, putBack: 0, candidates: 6, words: 6 });
    const [slide] = slidesOf(p);
    // The slide is ONE picture and no text object: the words are in the picture.
    expect(slide!.objects.some((o) => o.type === 'text')).toBe(false);
    expect(rasterPictures(slide!)).toHaveLength(1);
    // Slide.pptx.artText keeps them (bounded), and every reader of a picture slide's text finds them.
    for (const w of WORDS) expect(slide!.pptx?.artText).toContain(w);
    for (const read of [importedText, firstText, strapText, slideText]) {
      const text = read(slide as never);
      for (const w of WORDS) expect(text, `${read.name} finds ${w}`).toContain(w);
    }
    // Search: the presentation's haystack (normalised) holds every word.
    for (const w of WORDS) expect(presentationDoc(p).h).toContain(w.toLowerCase());
    expect(JSON.stringify(slide)).not.toMatch(/pptxmedia:/);
  }, 240_000);

  it('Reset slide brings the shapes back as shapes (no picture step) and a whole Re-import makes the picture again', async () => {
    const first = await importDeck(hub, continentDeck(), 'Reset.pptx');
    const [s0] = slidesOf(first.p);
    expect(rasterPictures(s0!)).toHaveLength(1);
    const reset = await waitJob(
      hub,
      hub.imports.pptx.queueReimport(
        first.p.id,
        first.hash,
        { slideIds: [s0!.id], reset: [s0!.id], rasters: 'off' },
        'test',
      ).id,
      180_000,
    );
    expect(reset.state, reset.error).toBe('done');
    const after = hub.lib.presentations.must(first.p.id);
    const [s1] = slidesOf(after);
    // RS1: the outline is a shape (or today's box) again and no picture is made by this job.
    expect(rasterPictures(s1!)).toHaveLength(0);
    // Today's slide (the decoration runs and the budgets decide how the 602 shapes are drawn): many objects, no image of shapes.
    expect(s1!.objects.length).toBeGreaterThan(50);
    expect(s1!.objects.some((o) => o.type === 'image' && o.origin?.role === 'raster')).toBe(false);
    // RS2: a whole Re-import turns the unedited, reset slide into a picture again (the recipe's picture is found, not drawn).
    const again = await waitJob(
      hub,
      hub.imports.pptx.queueReimport(first.p.id, first.hash, {}, 'test').id,
      180_000,
    );
    expect(again.state, again.error).toBe('done');
    const [s2] = slidesOf(hub.lib.presentations.must(first.p.id));
    expect(rasterPictures(s2!)).toHaveLength(1);
  }, 600_000);
});

describe('a hub that cannot draw the pictures imports as today and says why', () => {
  let dir: string;
  beforeAll(() => {
    dir = tempDir('ordo-rasters-off-');
  });
  const matrix: [string, (t: string) => { state: 'available' | 'absent' }, string | undefined][] = [
    ['no Chromium and no LibreOffice', () => ({ state: 'absent' }), 'no-maker'],
    [
      'no Chromium, with LibreOffice',
      (t) => ({ state: t === 'chromium' ? 'absent' : 'available' }),
      'libreoffice',
    ],
    // Chromium present too: a hub with LibreOffice still keeps LibreOffice's art while RASTER_WITH_LIBREOFFICE is false (M-SR5).
    ['Chromium and LibreOffice', () => ({ state: 'available' }), 'libreoffice'],
  ];
  for (const [name, probe, off] of matrix) {
    it(`${name}: the report line says so and the slide is today's`, async () => {
      const hub = await startHub({ prerender: ON, toolProbe: probe as never });
      try {
        const file = await zipDeck(continentDeck(), dir, `${Math.random().toString(36).slice(2)}.pptx`);
        const hash = await storeDeck(hub, file);
        const job = await waitJob(hub, hub.imports.pptx.queueNative(hash, 'Off.pptx', {}).id, 120_000);
        expect(job.state, job.error).toBe('done');
        const result = job.result as PptxNativeResult;
        expect(result.rasters).toMatchObject({ off, pictures: 0, stored: 0, candidates: 2 });
        const [slide] = slidesOf(hub.lib.presentations.must(result.presentationId));
        expect(rasterPictures(slide!)).toHaveLength(0);
      } finally {
        await hub.cleanup();
      }
    }, 180_000);
  }
});
