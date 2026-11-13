/**
 * The worker side of the native import's `pptx-scene` task and the import report (M3 item B), in process:
 * what the scan reads for the job, a batch's transitions, and the bounded report.
 */
import { CLIENT_M9_WRITES, CLIENT_SHEETS, importPptxClient } from '@ordo/importers';
import { ALL_M9_FIELDS, convertDeck, DECOR_PREFIX, SHEET_PREFIX } from '@ordo/pptx-scene';
import { openPackage } from '@ordo/pptx-scene/opc.ts';
import {
  body,
  buildDeck,
  grpSp,
  imageRel,
  NS_A,
  NS_P,
  NS_R,
  para,
  pic,
  pictureBg,
  run,
  solid,
  sp,
} from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { ImportLog, importResult, missingFonts, SOURCE_LOG_CHARS } from '../src/pptx/report.ts';
import { scanDeck, sceneTask } from '../src/pptx/sceneTask.ts';
import { M9_WRITES, PPTX_SHEETS } from '../src/pptx/shared.ts';

const IN = 914_400;
const enc = new TextEncoder();
const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;

describe('scanDeck', () => {
  it('lists the pictures the slides, layouts, masters and themes relate to, the metafiles per slide and the notes', () => {
    const parts = buildDeck({
      slides: [
        {
          shapes: pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' }),
          rels: [
            imageRel('rId2', 'photo.png'),
            imageRel('rId3', 'logo.emf'),
            imageRel('rId4', 'icon.svg'),
            { id: 'rId5', type: 'image', target: 'https://example.org/x.png', external: true },
            { id: 'rId6', type: 'notesSlide', target: '../notesSlides/notesSlide1.xml' },
          ],
        },
        { layout: 2 },
      ],
      layouts: [{}, { rels: [imageRel('rId7', 'layout.jpeg')] }],
      master: { bg: pictureBg('rId9'), rels: [imageRel('rId9', 'bg.png'), imageRel('rId10', 'mark.wmf')] },
      media: {
        'ppt/media/photo.png': new Uint8Array(4),
        'ppt/media/logo.emf': new Uint8Array(4),
        'ppt/media/icon.svg': new Uint8Array(4),
        'ppt/media/layout.jpeg': new Uint8Array(4),
        'ppt/media/bg.png': new Uint8Array(4),
        'ppt/media/mark.wmf': new Uint8Array(4),
        'ppt/media/unused.png': new Uint8Array(4),
      },
    });
    parts.set(
      'ppt/notesSlides/notesSlide1.xml',
      enc.encode(
        `<p:notes ${NS}><p:cSld><p:spTree>${sp({ id: 2, ph: 'type="body" idx="1"', txBody: body(para(run('Pray first'))) })}</p:spTree></p:cSld></p:notes>`,
      ),
    );
    const pkg = openPackage(parts);
    const listed = convertDeck(parts, { range: { from: 0, to: 0 } }).listed;
    const scan = scanDeck(pkg, listed);
    expect(scan.pictures.sort()).toEqual([
      'ppt/media/bg.png',
      'ppt/media/layout.jpeg',
      'ppt/media/photo.png',
    ]);
    expect(scan.picturesOver).toBe(0);
    expect(scan.metafiles).toEqual([
      [0, ['ppt/media/logo.emf', 'ppt/media/mark.wmf']],
      [1, ['ppt/media/mark.wmf']],
    ]);
    expect(scan.notes).toEqual([[0, 'Pray first']]);
    expect(scan.loop).toBe(false);
  });

  it('runs as the first pool call: deck facts and the scan, no slide converted', () => {
    const parts = buildDeck({ slides: [{}, { hidden: true }] });
    const out = sceneTask({ parts, pictureSizes: [], range: { from: 0, to: 0 }, options: {}, scan: true });
    expect(out.result.slides).toEqual([]);
    expect(out.result.listed.map((r) => [r.index, r.hidden, r.shown ?? null])).toEqual([
      [0, false, 0],
      [1, true, null],
    ]);
    expect(out.scan).toBeDefined();
    expect(out.extras).toBeUndefined();
  });

  it("returns a batch's transitions and timings", () => {
    const tr = (x: string) => `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${x}`;
    const parts = buildDeck({
      slides: [
        { after: tr('<p:transition advTm="4000"><p:dissolve/></p:transition>') },
        { after: tr('') },
        { after: tr('<p:transition><p:wipe/></p:transition>') },
      ],
    });
    const out = sceneTask({ parts, pictureSizes: [], range: { from: 0, to: 3 }, options: {} });
    expect(out.extras).toEqual([
      { index: 0, transition: { kind: 'crossfade', ms: 700 }, advanceMs: 4000 },
      {
        index: 2,
        transition: { kind: 'crossfade', ms: 700 },
        note: 'a wipe transition is shown as a crossfade',
      },
    ]);
    expect(out.scan).toBeUndefined();
  });
});

describe('decorations and sheets held back (the M9 rollout, until decor-render draws and stores them)', () => {
  /** A layout of 160 text-less rectangles of as many colours in one group: decorations past the object budget. */
  function decorated() {
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
    const group = grpSp({ id: 2, x: 0, y: 0, cx: 8 * IN, cy: 4 * IN }, shapes);
    return buildDeck({ layouts: [{ shapes: group }], slides: [{ shapes: '' }] });
  }

  /** One slide of `n` distinct pictures (each its own part). */
  function pictures(n: number) {
    const parts = Array.from({ length: n }, (_, i) => `q${i}.png`);
    let shapes = '';
    parts.forEach((_, i) => {
      shapes += pic({
        id: 2 + i,
        x: (i % 6) * 1.6 * IN,
        y: Math.floor(i / 6) * 1.6 * IN,
        cx: IN,
        cy: IN,
        rId: `rId${2 + i}`,
      });
    });
    return buildDeck({ slides: [{ rels: parts.map((p, i) => imageRel(`rId${2 + i}`, p)), shapes }] });
  }

  async function clientParse(parts: Map<string, Uint8Array>, name: string) {
    const zip = new JSZip();
    for (const [k, v] of parts) zip.file(k, v);
    return importPptxClient(await zip.generateAsync({ type: 'uint8array' }), name);
  }

  it('writes no decoration while no drawer draws one: every shape drawn as itself, no placeholder', async () => {
    expect(M9_WRITES.has('decor')).toBe(false);
    expect(M9_WRITES.has('decorFile')).toBe(false);
    expect([...CLIENT_M9_WRITES].sort()).toEqual([...M9_WRITES].sort());
    const parts = decorated();
    // With every field the converter draws them as decorations, in decoration files (`pptxdecor:<n>`).
    const all = convertDeck(parts, { m9Writes: ALL_M9_FIELDS });
    expect(all.decors.length).toBeGreaterThan(0);
    // The hub's batch (`M9_WRITES`): no decoration, each of the 160 shapes its own object.
    const out = sceneTask({ parts, pictureSizes: [], range: { from: 0, to: 1 }, options: {} });
    expect(out.result.decors).toEqual([]);
    const [s] = out.result.slides;
    expect(s!.slide.objects.some((o) => o.type === 'shape' && o.decor)).toBe(false);
    expect(s!.slide.objects.filter((o) => o.type === 'shape' && o.origin?.role !== 'bg')).toHaveLength(160);
    expect(s!.missing).toBeUndefined();
    expect(JSON.stringify(out.result)).not.toContain(DECOR_PREFIX);
    // The client's parse (`CLIENT_M9_WRITES`) and the scene it sends the hub: the same.
    const parsed = await clientParse(parts, 'Decorated.pptx');
    expect(JSON.stringify(parsed.clientScene)).not.toContain(DECOR_PREFIX);
    expect(JSON.stringify(parsed.presentation)).not.toContain(DECOR_PREFIX);
    const shown = parsed.clientScene.slides.flatMap((x) => x.slide.objects);
    expect(shown.some((o) => o.type === 'shape' && o.decor)).toBe(false);
  });

  it('draws no picture from a sheet: a slide of 14 distinct pictures keeps every one, on both paths', async () => {
    expect(PPTX_SHEETS).toBe(false);
    expect(CLIENT_SHEETS).toBe(PPTX_SHEETS);
    const parts = pictures(14);
    // With sheets the converter packs three into an atlas (`pptxmedia:sheet<n>`), which nothing stores yet.
    expect(convertDeck(parts).sheets.length).toBeGreaterThan(0);
    const out = sceneTask({ parts, pictureSizes: [], range: { from: 0, to: 1 }, options: {} });
    expect(out.result.sheets).toEqual([]);
    expect(JSON.stringify(out.result)).not.toContain(SHEET_PREFIX);
    const [s] = out.result.slides;
    const ids = new Set(s!.slide.objects.flatMap((o) => (o.type === 'image' ? [o.mediaId] : [])));
    expect(ids.size).toBe(14);
    expect(s!.missing).toBeUndefined();
    const parsed = await clientParse(parts, 'Pictures.pptx');
    expect(JSON.stringify(parsed.clientScene)).not.toContain(SHEET_PREFIX);
    const shown = parsed.clientScene.slides[0]!.slide.objects.filter((o) => o.type === 'image');
    expect(new Set(shown.map((o) => (o.type === 'image' ? o.mediaId : ''))).size).toBe(14);
  });
});

describe('import report', () => {
  it('counts the classes and bounds the notes and fonts it shows', () => {
    const r = importResult({
      presentationId: 'p',
      classes: ['native', 'native', 'hybrid', 'picture'],
      compact: 1,
      pending: 2,
      loJobId: 'j',
      missingFonts: Array.from({ length: 30 }, (_, i) => `Font ${i}`),
      notes: Array.from({ length: 30 }, (_, i) => `note ${i}\n[error] forged`),
    });
    expect(r).toMatchObject({
      slides: 4,
      native: 2,
      hybrid: 1,
      picture: 1,
      compact: 1,
      pending: 2,
      loJobId: 'j',
    });
    expect(r.missingFonts).toHaveLength(20);
    expect(r.notes).toHaveLength(20);
    expect(r.notes[0]).toBe('note 0 [error] forged');
  });

  it('names the fonts the library does not have (no drawer uses a bundled substitute yet)', () => {
    expect(
      missingFonts(
        [
          'Calibri',
          'Century Gothic',
          'Tahoma',
          'century gothic',
          'Arial',
          'Open Sans',
          'Inter',
          'sans-serif',
          '',
        ],
        ['Open Sans'],
      ),
    ).toEqual(['Calibri', 'Century Gothic', 'Tahoma', 'Arial', 'Inter']);
    // The bundled faces count once the hub has registered them (ORDO_FONTS_DIR), as library rows.
    expect(missingFonts(['Calibri', 'Carlito', 'Inter'], ['Carlito', 'Inter'])).toEqual(['Calibri']);
  });

  it('keeps source.log bounded and one line per entry', () => {
    const log = new ImportLog();
    log.add('warn', 'a\nb c');
    log.add('info', 'plain');
    for (let i = 0; i < 2_000; i++) log.add('info', 'x'.repeat(300));
    const text = log.toString();
    expect(text.length).toBeLessThanOrEqual(SOURCE_LOG_CHARS);
    const lines = text.split('\n');
    expect(lines[0]).toBe('[warn] a b c');
    expect(lines[1]).toBe('plain');
    expect(lines.at(-1)).toMatch(/^… \d+ more line\(s\)$/);
    expect(log.warnings()).toEqual(['a b c']);
  });
});
