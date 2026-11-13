import { buildDeck, sfntFont, tableFrame, tc } from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parsePptxScene } from './pptx-client.ts';
import { deckFaceNeeds, type FaceFile, FaceUnreadable, faceSourceOf, loadDeckFaces } from './pptx-faces.ts';

const IN = 914_400;

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
  const wide = sfntFont(Object.fromEntries([...'Wide w'].map((c) => [c, 500])));
  const library: FaceFile[] = [
    { family: 'Wide Face', weight: 400, italic: false, url: 'f/wide' },
    { family: 'Unused Face', weight: 400, italic: false, url: 'f/unused' },
  ];

  it('fetches only the faces a deck with a table names, and grows the row to its text', async () => {
    const fetched: string[] = [];
    const get = async (url: string) => {
      fetched.push(url);
      return url === 'f/wide' ? wide : undefined;
    };
    const parse = await parsePptxScene(await zip(tableDeck('Wide Face')), {
      loadFaces: (parts) => loadDeckFaces(parts, library, get),
    });
    expect(fetched).toEqual(['f/wide']);
    const text = parse.scene.slides[0]!.slide.objects.find((o) => o.type === 'text')!;
    // As the hub's pool task measures it (apps/hub/test/pptx-faces.test.ts): three lines plus the margins.
    expect(text.box.h).toBeCloseTo(3 * 1.2 * 36 + 14.4, 6);
    // A narrow face fits the text on one line; without faces the widths are estimated and it wraps.
    const narrow = sfntFont(Object.fromEntries([...'Wide w'].map((c) => [c, 200])));
    const lib = [{ family: 'Narrow Face', weight: 400, italic: false, url: 'f/narrow' }];
    const one = await parsePptxScene(await zip(tableDeck('Narrow Face')), {
      loadFaces: (parts) => loadDeckFaces(parts, lib, async () => narrow),
    });
    const plain = await parsePptxScene(await zip(tableDeck('Narrow Face')));
    const h = (p: typeof one) => p.scene.slides[0]!.slide.objects.find((o) => o.type === 'text')!.box.h;
    expect(h(one)).toBeCloseTo(1.2 * 36 + 14.4, 6);
    expect(h(plain)).toBeGreaterThan(h(one) + 30);
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
