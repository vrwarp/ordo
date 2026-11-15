import type { ShapeObject, TableData } from '@ordo/domain';
import { cellRich } from '@ordo/domain/table.ts';
import { buildDeck, sfntFont, tableFrame, tc } from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parsePptxScene } from './pptx-client.ts';
import { deckFaceNeeds, type FaceFile, FaceUnreadable, faceSourceOf, loadDeckFaces } from './pptx-faces.ts';

const IN = 914_400;

/** A cell's line spacing as a share of single: its paragraph's, else its box's (`lineHeight` / 1.2). */
const cellSpacing = (t: TableData, i: number) => {
  const c = cellRich(t, i)!;
  return c.paras?.[0]?.lineSpacing ?? c.style.lineHeight / 1.2;
};

async function zip(parts: Map<string, Uint8Array>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [k, v] of parts) z.file(k, v);
  return z.generateAsync({ type: 'uint8array' });
}

const tableDeck = (typeface: string, text = 'Wide wide wide') =>
  buildDeck({
    slides: [
      {
        shapes: tableFrame({
          id: 4,
          x: IN,
          y: IN,
          cols: [IN],
          rows: [{ h: 1, cells: [tc(text, { rPrChildren: `<a:latin typeface="${typeface}"/>` })] }],
        }),
      },
    ],
  });

describe("the browser parse measures tables with the library's faces (as the hub)", () => {
  const library: FaceFile[] = [
    { family: 'Wide Face', weight: 400, italic: false, url: 'f/wide' },
    { family: 'Unused Face', weight: 400, italic: false, url: 'f/unused' },
  ];

  it('fetches only the faces a deck with a table names, and measures its cells with them (the line spacing they store)', async () => {
    // "Wide" half an em wide, its line 1.4 of the size (hhea): the cell's lines are spaced by it, as the
    // hub's pool task spaces them (apps/hub/test/pptx-faces.test.ts); without faces the widths are estimated
    // (noted) and the office model's single spacing stays.
    const tall = sfntFont(Object.fromEntries([...'Wide w'].map((c) => [c, 500])), {
      vertical: { ascender: 1100, descender: -300 },
    });
    const fetched: string[] = [];
    const get = async (url: string) => {
      fetched.push(url);
      return url === 'f/wide' ? tall : undefined;
    };
    const parse = await parsePptxScene(await zip(tableDeck('Wide Face')), {
      loadFaces: (parts) => loadDeckFaces(parts, library, get),
    });
    expect(fetched).toEqual(['f/wide']);
    const tableOf = (p: typeof parse) =>
      (p.scene.slides[0]!.slide.objects.find((o) => o.type === 'shape' && o.table) as ShapeObject).table!;
    // One table object (M9 tables-conv): its rows as the deck stores them, the drawer grows them.
    expect(tableOf(parse).rows).toHaveLength(1);
    expect(cellSpacing(tableOf(parse), 0)).toBeCloseTo(1.4 / 1.2, 6);
    const estimated = (p: typeof parse) =>
      p.scene.slides[0]!.notes.some((n) => n.includes('estimated widths') && n.includes('Wide Face'));
    expect(estimated(parse)).toBe(false);
    const plain = await parsePptxScene(await zip(tableDeck('Wide Face')));
    expect(cellSpacing(tableOf(plain), 0)).toBeCloseTo(1, 6);
    expect(estimated(plain)).toBe(true);
  });

  it('needs nothing for a deck without a table, and leaves a deck whose face only the hub reads to the hub', async () => {
    const noTable = buildDeck({ slides: [{ shapes: '' }] });
    expect(deckFaceNeeds(noTable)).toBeUndefined();
    const needs = deckFaceNeeds(tableDeck('Wide Face'))!;
    expect(needs.has('Wide Face')).toBe(true);
    expect(needs.has('Inter')).toBe(true);
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
    await expect(loadDeckFaces(tableDeck('Wide Face'), library, async () => woff2)).rejects.toBeInstanceOf(
      FaceUnreadable,
    );
    // A face that cannot be fetched is missing, as a file the hub cannot read.
    const none = await loadDeckFaces(tableDeck('Wide Face'), library, async () => {
      throw new Error('offline');
    });
    expect(none?.('Wide Face', false, false)).toBeUndefined();
  });

  it('chooses faces as the hub does: slant first, then the nearest weight', () => {
    const m = (a: number) => () => ({ advance: (cp: number) => (cp === 0x61 ? a : undefined) });
    const faces = faceSourceOf([
      { family: 'T', weight: 400, italic: false, metrics: m(0.5) },
      { family: 'T', weight: 700, italic: false, metrics: m(0.6) },
      { family: 'T', weight: 400, italic: true, metrics: m(0.45) },
    ]);
    expect(faces('t', true, false)?.advance(0x61)).toBe(0.6);
    expect(faces('T', true, true)?.advance(0x61)).toBe(0.45);
    expect(faces('U', false, false)).toBeUndefined();
  });
});
