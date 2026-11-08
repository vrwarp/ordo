/**
 * The worker side of the native import's `pptx-scene` task and the import report (M3 item B), in process:
 * what the scan reads for the job, a batch's transitions, and the bounded report.
 */
import { convertDeck } from '@ordo/pptx-scene';
import { openPackage } from '@ordo/pptx-scene/opc.ts';
import {
  body,
  buildDeck,
  imageRel,
  NS_A,
  NS_P,
  NS_R,
  para,
  pic,
  pictureBg,
  run,
  sp,
} from '@ordo/pptx-scene/test-util.ts';
import { describe, expect, it } from 'vitest';
import { ImportLog, importResult, missingFonts, SOURCE_LOG_CHARS } from '../src/pptx/report.ts';
import { scanDeck, sceneTask } from '../src/pptx/sceneTask.ts';

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
