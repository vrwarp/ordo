import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LYRIC_STYLE, type Slide } from '@ordo/domain';
import { extractZip } from '@ordo/importers/zip-stream.ts';
import pptxgen from 'pptxgenjs';
import { afterAll, describe, expect, it } from 'vitest';
import { budgetColumns, hubClasses, parseCensusArgs, runCensus } from './census.ts';
import { listDecks } from './decks.ts';
import { zipStore } from './table-probe.ts';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function work(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'ordo-census-test-'));
  dirs.push(d);
  return d;
}

const MAIN = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const MAIN_OF = {
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
} as const;

/** A deck of two shown slides and a hidden one, as .pptx bytes. */
async function deckBytes(): Promise<Uint8Array> {
  const p = new pptxgen();
  p.layout = 'LAYOUT_16x9';
  p.addSlide().addText('Amazing grace', { x: 1, y: 1, w: 6, h: 1, fontSize: 40 });
  const hidden = p.addSlide();
  hidden.hidden = true;
  hidden.addText('Hidden', { x: 1, y: 1, w: 4, h: 1 });
  p.addSlide().addText('How sweet the sound', { x: 1, y: 1, w: 6, h: 1, fontSize: 32 });
  return new Uint8Array((await p.write({ outputType: 'nodebuffer' })) as Buffer);
}

/** The same deck as a slide show or a template: its main part's content type as PowerPoint writes it. */
async function asKind(pptx: string, kind: keyof typeof MAIN_OF, dir: string): Promise<Uint8Array> {
  const zip = await extractZip(pptx, { dir, spill: () => false });
  const files = [...zip.files.entries()].map(([name, data]): [string, Uint8Array] => {
    if (name !== '[Content_Types].xml') return [name, data];
    const xml = new TextDecoder().decode(data);
    if (!xml.includes(MAIN)) throw new Error('no main part');
    return [name, new TextEncoder().encode(xml.replace(MAIN, MAIN_OF[kind]))];
  });
  return zipStore(files);
}

const box = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
const text = (t: string): Slide['objects'][number] => ({
  id: 't',
  type: 'text',
  box,
  text: t,
  style: DEFAULT_LYRIC_STYLE,
  opacity: 1,
});
const outline = (ref: string): Slide['objects'][number] =>
  ({
    id: ref,
    type: 'shape',
    shape: 'rect',
    box,
    radius: 0,
    opacity: 1,
    geom: { ref },
  }) as Slide['objects'][number];
const slide = (objects: Slide['objects']): Slide => ({ id: 's', objects }) as Slide;

describe('hubClasses', () => {
  it("models the hub's budget ladder: never a picture for a size, what it leaves out said (M9)", () => {
    const geoms = [
      { id: 'pptxgeom:1', file: { paths: 'x'.repeat(60) } },
      { id: 'pptxgeom:2', file: { paths: 'y'.repeat(60) } },
    ];
    const rect = (i: number): Slide['objects'][number] =>
      ({
        ...outline('r'),
        id: `r${i}`,
        geom: undefined,
        fill: { r: 1, g: 2, b: 3, a: 1 },
      }) as Slide['objects'][number];
    const got = hubClasses(
      [
        { class: 'native', slide: slide([text('Grace')]), notes: [] },
        // Its text alone is over 64 KB: kept whole, nothing to leave out.
        {
          class: 'hybrid',
          // (The hub's sanitizer keeps 10,000 characters a text object.)
          slide: slide([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ ...text('x'.repeat(9_000)), id: `t${i}` }))),
          notes: [],
        },
        { class: 'native', slide: slide([outline('pptxgeom:1')]), notes: [] },
        // The same file again costs nothing; a new one passes the budget of 100 bytes: its shape is left out.
        { class: 'native', slide: slide([outline('pptxgeom:1')]), notes: [] },
        { class: 'native', slide: slide([text('Grace'), outline('pptxgeom:2')]), notes: [] },
        { class: 'picture', slide: slide([text('Kept for search')]), notes: [] },
        // Text and 700 rectangles past 64 KB: the rectangles go first.
        {
          class: 'native',
          slide: slide([text('Grace'), ...Array.from({ length: 700 }, (_, i) => rect(i))]),
          notes: [],
        },
      ],
      geoms,
      100,
    );
    expect(got.map((h) => [h.hub, h.hubWhy, h.level, h.missing])).toEqual([
      ['native', null, 'full', []],
      ['hybrid', null, 'minimal', []],
      ['native', null, 'full', []],
      ['native', null, 'full', []],
      ['hybrid', 'geoms', 'full', ['decoration']],
      ['picture', null, 'full', []],
      ['hybrid', 'slide', 'minimal', ['decoration']],
    ]);
    expect(got[0]!.stored).toBeGreaterThan(400);
    expect(got[1]!.slide.objects).toHaveLength(8);
    expect(got[1]!.stored).toBeGreaterThan(64 * 1024);
    expect(got[4]!.slide.objects.map((o) => o.type)).toEqual(['text']);
    expect(got[5]!.stored).toBe(0);
    expect(got[5]!.slide.objects).toEqual([]);
    expect(got[6]!.stored).toBeLessThanOrEqual(64 * 1024);
    expect(got[6]!.slide.objects.filter((o) => o.type === 'text')).toHaveLength(1);
  });
});

describe('budgetColumns (M9, decor-conv)', () => {
  it("counts a slide's decorations, sheet pictures, culled elements and plate objects, zeros left out", () => {
    const box = { x: 0, y: 0, w: 1, h: 1, rotation: 0 };
    const slide = {
      objects: [
        {
          id: 'a',
          type: 'shape',
          box,
          shape: 'line',
          opacity: 1,
          radius: 0,
          decor: { w: 1, h: 1, paints: [{}], parts: [] },
        },
        { id: 'b', type: 'image', box, mediaId: 'pptxmedia:sheet1', fit: 'stretch', opacity: 1, radius: 0 },
        { id: 'c', type: 'image', box, mediaId: 'pptxmedia:1', fit: 'stretch', opacity: 1, radius: 0 },
      ],
    } as unknown as Slide;
    const notes = [
      '12 element(s) outside the slide are not imported',
      '2 shape(s) that show nothing are not imported',
      "2 object(s) past the slide's drawing budget are drawn whole from a geometry unit on outputs; their legacy shapes elsewhere",
      "1 object(s) past the slide's drawing budget are drawn without their effects until effect units are made",
    ];
    expect(budgetColumns(slide, notes)).toEqual({ decors: 1, sheets: 1, culled: 14, plate: 3 });
    expect(budgetColumns({ objects: [] }, [])).toEqual({});
  });
});

describe('census', () => {
  it('reads its options', () => {
    expect(parseCensusArgs(['--out', 'c.jsonl', 'a', 'b'])).toEqual({
      out: 'c.jsonl',
      paths: ['a', 'b'],
      hubBudget: false,
      noLibreOffice: false,
    });
    expect(parseCensusArgs(['--hub-budget', '--no-libreoffice', '--out', 'c.jsonl', 'a'])).toMatchObject({
      hubBudget: true,
      noLibreOffice: true,
    });
    expect(() => parseCensusArgs(['a'])).toThrow(/usage/);
    expect(() => parseCensusArgs(['--out', 'c.jsonl'])).toThrow(/no decks/);
    expect(() => parseCensusArgs(['--out', 'c', '--hub', 'a'])).toThrow(/unknown option/);
  });

  it('census reads .ppsx and .potx (DECK_RE) and lists dangling links as unreadable', async () => {
    const dir = await work();
    const decks = join(dir, 'decks');
    const scratch = join(dir, 'scratch');
    await mkdir(decks);
    const pptx = join(decks, 'a-hymns.pptx');
    await writeFile(pptx, await deckBytes());
    await writeFile(join(decks, 'b-show.ppsx'), await asKind(pptx, 'ppsx', scratch));
    await writeFile(join(decks, 'c-template.potx'), await asKind(pptx, 'potx', scratch));
    await writeFile(join(decks, 'notes.txt'), 'not a deck');
    await symlink(join(dir, 'gone.pptx'), join(decks, 'd-gone.pptx'));

    const listed = await listDecks([decks]);
    expect(listed.map((d) => [d.name, d.exists])).toEqual([
      ['a-hymns.pptx', true],
      ['b-show.ppsx', true],
      ['c-template.potx', true],
      ['d-gone.pptx', false],
    ]);

    const out = join(dir, 'census.jsonl');
    const counts = await runCensus([decks], out);
    expect(counts).toEqual({ decks: 4, unreadable: 1, errors: 0, slides: 6 });
    const rows = (await readFile(out, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => [r.deck, r.name, r.ext, r.folder])).toEqual([
      [1, 'a-hymns.pptx', 'pptx', decks],
      [2, 'b-show.ppsx', 'ppsx', decks],
      [3, 'c-template.potx', 'potx', decks],
      [4, 'd-gone.pptx', 'pptx', decks],
    ]);
    for (const r of rows.slice(0, 3)) {
      expect(r.error).toBeUndefined();
      const slides = r.slides as Record<string, unknown>[];
      // The hidden slide is left out; shown slides are numbered as the harness numbers them.
      expect(slides.map((s) => [s.n, s.i, s.class, s.hub, s.hubWhy])).toEqual([
        [1, 0, 'native', 'native', null],
        [2, 2, 'native', 'native', null],
      ]);
      expect(slides[0]!.stored as number).toBeGreaterThan(slides[0]!.bytes as number);
    }
    // A dangling link is listed, without slides, and is no converter error.
    expect(rows[3]).toEqual({
      folder: decks,
      deck: 4,
      name: 'd-gone.pptx',
      ext: 'pptx',
      unreadable: 'missing target',
    });
  }, 120_000);
});
