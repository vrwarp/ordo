/**
 * The library's faces for the `pptx-scene` task (design/27 §15 M6 tables): a table row grows to its text
 * measured with the faces the outputs draw it with, read by the worker only when a table asks for them.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Font } from '@ordo/domain';
import { buildDeck, sfntFont, tableFrame, tc } from '@ordo/pptx-scene/test-util.ts';
import { afterAll, describe, expect, it } from 'vitest';
import { metricTables } from '../src/fonts/sfnt.ts';
import { FACE_LIMITS, libraryFaces, type SceneFontFile, sceneFontFiles } from '../src/pptx/faces.ts';
import { sceneTask } from '../src/pptx/sceneTask.ts';

const IN = 914_400;
const dir = mkdtempSync(join(tmpdir(), 'ordo-faces-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, bytes: Uint8Array): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

/** A WOFF 1.0 container around a TTF (zlib per table), as `fonts.test.ts` builds one. */
function toWoff(ttf: Uint8Array): Uint8Array {
  const b = Buffer.from(ttf);
  const n = b.readUInt16BE(4);
  const tables: { tag: string; data: Buffer }[] = [];
  for (let i = 0; i < n; i++) {
    const e = 12 + i * 16;
    tables.push({
      tag: b.toString('latin1', e, e + 4),
      data: b.subarray(b.readUInt32BE(e + 8), b.readUInt32BE(e + 8) + b.readUInt32BE(e + 12)),
    });
  }
  const head = Buffer.alloc(44 + n * 20);
  head.write('wOFF', 0, 'latin1');
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt16BE(n, 12);
  const datas: Buffer[] = [];
  let off = head.length;
  tables.forEach((t, i) => {
    const comp = deflateSync(t.data);
    const use = comp.length < t.data.length ? comp : t.data;
    const e = 44 + i * 20;
    head.write(t.tag, e, 'latin1');
    head.writeUInt32BE(off, e + 4);
    head.writeUInt32BE(use.length, e + 8);
    head.writeUInt32BE(t.data.length, e + 12);
    const pad = Buffer.alloc((4 - (use.length % 4)) % 4);
    datas.push(use, pad);
    off += use.length + pad.length;
  });
  return new Uint8Array(Buffer.concat([head, ...datas]));
}

describe('libraryFaces', () => {
  const regular = file('r.ttf', sfntFont({ a: 500 }));
  const bold = file('b.woff', toWoff(sfntFont({ a: 600 })));
  const italic = file('i.ttf', sfntFont({ a: 450 }));
  const latin = file('latin.ttf', sfntFont({ x: 400 }));
  const greek = file('greek.ttf', sfntFont({ α: 700 }));
  const files: SceneFontFile[] = [
    ['Test Sans', 400, false, regular],
    ['Test Sans', 700, false, bold],
    ['Test Sans', 400, true, italic],
    ['Subset Sans', 400, false, latin],
    ['Subset Sans', 400, false, greek],
  ];

  it('gives the face of the weight and slant asked for, TTF or WOFF, matching the family without case', () => {
    const faces = libraryFaces(files);
    expect(faces('test sans', false, false)?.advance(0x61)).toBe(0.5);
    expect(faces('Test Sans', true, false)?.advance(0x61)).toBe(0.6);
    expect(faces('Test Sans', false, true)?.advance(0x61)).toBe(0.45);
    // No bold italic: the italic (the slant first), then the nearest weight.
    expect(faces('Test Sans', true, true)?.advance(0x61)).toBe(0.45);
    expect(faces('Other', false, false)).toBeUndefined();
  });

  it("tries a family's subsets of one weight and slant in turn", () => {
    const f = libraryFaces(files)('Subset Sans', false, false)!;
    expect(f.advance(0x78)).toBe(0.4);
    expect(f.advance(0x3b1)).toBe(0.7);
    expect(f.advance(0x41)).toBeUndefined();
  });

  it('reads no more files than its limits and survives files it cannot read', () => {
    const broken = file('broken.ttf', new Uint8Array([1, 2, 3]));
    const many: SceneFontFile[] = Array.from({ length: FACE_LIMITS.files + 5 }, (_, i) => [
      `F${i}`,
      400,
      false,
      regular,
    ]);
    const faces = libraryFaces([
      ...many,
      ['Broken', 400, false, broken],
      ['Gone', 400, false, join(dir, 'missing.ttf')],
    ]);
    let found = 0;
    for (let i = 0; i < many.length; i++) if (faces(`F${i}`, false, false)) found++;
    // One file read once serves every family listing it; a broken or missing file is no face.
    expect(found).toBe(many.length);
    expect(faces('Broken', false, false)).toBeUndefined();
    expect(faces('Gone', false, false)).toBeUndefined();
  });

  it("reads pair kerning and LibreOffice's vertical metrics from TTF and WOFF faces (R1)", () => {
    const kerned = sfntFont(
      { A: 600, V: 600 },
      { kern: { pairs: [['A', 'V', -80]] }, vertical: { ascender: 800, descender: -200 } },
    );
    const faces = libraryFaces([
      ['Kern Sans', 400, false, file('k.ttf', kerned)],
      ['Kern Sans', 700, false, file('k.woff', toWoff(kerned))],
    ]);
    for (const bold of [false, true]) {
      const f = faces('Kern Sans', bold, false)!;
      expect(f.kern?.(0x41, 0x56)).toBeCloseTo(-0.08, 9);
      expect([f.ascent, f.descent]).toEqual([0.8, 0.2]);
    }
  });

  it('leaves out a kerning table past the table limit and measures the face without it', () => {
    const bytes = sfntFont({ A: 600, V: 600 }, { kern: { pairs: [['A', 'V', -80]] } });
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < view.getUint16(4); i++) {
      const e = 12 + i * 16;
      if (String.fromCharCode(...bytes.subarray(e, e + 4)) === 'GPOS')
        view.setUint32(e + 12, 5 * 1024 * 1024);
    }
    const tables = metricTables(bytes);
    expect(tables.has('GPOS')).toBe(false);
    expect(tables.has('hmtx')).toBe(true);
    const f = libraryFaces([['Big Kern', 400, false, file('big.ttf', bytes)]])('Big Kern', false, false)!;
    expect(f.advance(0x41)).toBe(0.6);
    expect(f.kern).toBeUndefined();
  });

  it("lists the library's fonts for the task", () => {
    const font = (family: string, style: 'normal' | 'italic'): Font => ({
      id: family,
      family,
      weight: 400,
      style,
      file: { hash: 'h', bytes: 1, mime: 'font/ttf', path: `fonts/${family}.ttf` },
      source: 'upload',
    });
    expect(sceneFontFiles([font('A', 'normal'), font('B', 'italic')], (p) => `/store/${p}`)).toEqual([
      ['A', 400, false, '/store/fonts/A.ttf'],
      ['B', 400, true, '/store/fonts/B.ttf'],
    ]);
  });
});

describe('sceneTask with the library faces', () => {
  it("grows a table row to its text measured with the library's face", () => {
    // Every character of "Wide" half an em wide: 18 px at 36 px; a 1 in cell (144 px, 115.2 px inside its
    // margins) holds 6 of them on a line.
    const wide = file('wide.ttf', sfntFont(Object.fromEntries([...'Wide w'].map((c) => [c, 500]))));
    const parts = buildDeck({
      slides: [
        {
          shapes: tableFrame({
            id: 4,
            x: IN,
            y: IN,
            cols: [IN],
            rows: [
              { h: 1, cells: [tc('Wide wide wide', { rPrChildren: '<a:latin typeface="Wide Face"/>' })] },
            ],
          }),
        },
      ],
    });
    const out = sceneTask({
      parts,
      pictureSizes: [],
      range: { from: 0, to: 1 },
      options: {},
      fonts: [['Wide Face', 400, false, wide]],
    });
    const text = out.result.slides[0]!.slide.objects.find((o) => o.type === 'text')!;
    // Three lines ("Wide " fits 5 of 6, the next word wraps): 3 × 1.2 × 36 px, plus 14.4 px of margins.
    expect(text.box.h).toBeCloseTo(3 * 1.2 * 36 + 14.4, 6);
  });
});
