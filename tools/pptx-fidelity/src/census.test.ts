import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LYRIC_STYLE, type Slide } from '@ordo/domain';
import { extractZip } from '@ordo/importers/zip-stream.ts';
import pptxgen from 'pptxgenjs';
import { afterAll, describe, expect, it } from 'vitest';
import { lineArtD } from '@ordo/renderer/units.test-util.ts';
import {
  budgetColumns,
  hubClasses,
  legacyColumns,
  noLoDraws,
  parseCensusArgs,
  runCensus,
  wholeColumns,
} from './census.ts';
import { LINE_ART_HOLES_PATH } from './gen/line-art-holes.ts';
import { listDecks } from './decks.ts';
import { type NativeDeck, type NativeSlide, withHubBudget } from './native.ts';
import { dataUri, testPicture } from './png.ts';
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

describe('legacyColumns (M9 leaf-legacy)', () => {
  const red = { r: 255, g: 0, b: 0, a: 1 };
  const shape = (id: string, kind: string, d: string, extra: Record<string, unknown> = {}) =>
    ({
      id,
      type: 'shape',
      shape: kind,
      box,
      radius: 0,
      opacity: 1,
      fill: red,
      geom: { paths: [{ d, w: 100, h: 100 }] },
      ...extra,
    }) as Slide['objects'][number];
  // A frame: an outline and one big hole (even-odd ink 0.19 of the box).
  const frame = 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 5 5 L 95 5 L 95 95 L 5 95 Z';
  const full = 'M 0 0 L 100 0 L 100 100 L 0 100 Z';

  it('counts a filled legacy rect or ellipse over a geometry that fills under half its box', () => {
    expect(
      legacyColumns(
        slide([
          shape('a', 'rect', frame),
          shape('b', 'ellipse', frame),
          // Its legacy is a line, an outline only, or the geometry fills its box: none of these.
          shape('c', 'line', frame),
          shape('d', 'rect', frame, { fill: undefined, stroke: { width: 2, color: red } }),
          shape('e', 'rect', full),
          { ...shape('f', 'rect', frame), geom: { preset: 'frame' } } as Slide['objects'][number],
          // A table's grid: its fills' bounding box is its legacy shape by design.
          shape('g', 'rect', frame, { origin: { src: 'pptx', shapeId: 2, role: 'grid' } }),
        ]),
      ),
    ).toEqual({ legacyFills: 2 });
    // 2,049 squares filling the box, stored as a chain of three pieces: past the renderer's nesting bound,
    // the share is unknown, and a rect over it counts.
    const squares = Array.from({ length: 2_049 }, () => full);
    const pieces = [0, 819, 1_638].map((at, k) => ({
      d: squares.slice(at, at + 819).join(' '),
      w: 100,
      h: 100,
      ...(k ? { cont: true } : {}),
    }));
    expect(
      legacyColumns(
        slide([{ ...shape('g', 'rect', full), geom: { paths: pieces } } as Slide['objects'][number]]),
      ),
    ).toEqual({
      legacyFills: 1,
    });
    // Within both bounds (801 squares, each tested against the others' 5 points: 3.2M of UNION_NESTING_WORK's
    // 4M), an odd count fills the box: its rect is its legacy and does not count.
    const within = { d: squares.slice(0, 801).join(' '), w: 100, h: 100 };
    expect(
      legacyColumns(
        slide([{ ...shape('h', 'rect', full), geom: { paths: [within] } } as Slide['objects'][number]]),
      ),
    ).toEqual({});
    expect(legacyColumns(slide([]))).toEqual({});
  });

  it('counts an object past the drawing budget alone that no unit draws (r2a repair, r2b effect units)', () => {
    // One full-slide line art of 8 paths with 20 x 15 holes each: about 1.2 x GEOM_COST.slide alone. 62a1c3a
    // counted it alone (no geometry unit drew it); a sliced unit draws it now, one path's fill a step.
    const art = {
      id: 'art',
      type: 'shape',
      box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
      shape: 'line',
      opacity: 1,
      radius: 0,
      fill: red,
      geom: {
        paths: Array.from({ length: 8 }, (_, i) => ({
          d: lineArtD({ w: 4000, h: 3000, cols: 20, rows: 15, wall: 0.1 + 0.02 * i }),
          w: 4000,
          h: 3000,
        })),
      },
    } as Slide['objects'][number];
    expect(legacyColumns(slide([art]))).toEqual({ budgetLegacy: 1 });
    // One sub-path stroked 500 px wide: its one outline alone is past the per-call bound (GEOM_COST.geometry),
    // so no unit draws it and its legacy copy stays (the ratchet fails this anywhere).
    let d = 'M 1000 1000';
    for (let k = 1; k < 250; k++) {
      const a = (k / 250) * Math.PI * 2 * 37;
      const r = k % 2 ? 1000 : 50;
      d += ` L ${(1000 + r * Math.cos(a)).toFixed(1)} ${(1000 + r * Math.sin(a)).toFixed(1)}`;
    }
    const hostile = {
      ...art,
      id: 'hostile',
      shape: 'rect',
      stroke: { width: 500, color: red },
      geom: { paths: [{ d: `${d} Z`, w: 2000, h: 2000 }] },
    } as Slide['objects'][number];
    expect(legacyColumns(slide([hostile]))).toEqual({ budgetLegacy: 1, unitsLeft: 1, unitsAlone: 1 });
  });

  it('counts nothing for want of unit area: two full-frame line-art shapes are a direct part and a frame', () => {
    // At r2b2-base the second one's unit passed the slide's one frame of unit area and was counted `unitsLeft`
    // (r2a MUST c(2)); outputs now draw the bottom one from a frame, the top one directly, both whole.
    const art = (id: string, wall: number) =>
      ({
        id,
        type: 'shape',
        box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
        shape: 'line',
        opacity: 1,
        radius: 0,
        fill: red,
        geom: {
          paths: Array.from({ length: 8 }, (_, i) => ({
            d: lineArtD({ w: 4000, h: 3000, cols: 20, rows: 15, wall: wall + 0.02 * i }),
            w: 4000,
            h: 3000,
          })),
        },
      }) as Slide['objects'][number];
    const cols = legacyColumns(slide([art('a', 0.1), art('b', 0.12)]));
    expect(cols.budgetLegacy).toBeGreaterThanOrEqual(1);
    expect(cols).not.toHaveProperty('unitsLeft');
    expect(cols).not.toHaveProperty('unitsAlone');
  });

  it("counts what the slide budget draws as legacy shapes, and the guard deck's line art draws no fill", async () => {
    const dir = await work();
    const out = join(dir, 'guard.jsonl');
    await runCensus([join(import.meta.dirname, '../../..', LINE_ART_HOLES_PATH)], out);
    const row = JSON.parse((await readFile(out, 'utf8')).trim()) as { slides: Record<string, unknown>[] };
    // At b50d486 its three line-art paths were rects of their fills: legacyFills 3.
    expect(row.slides[0]).toMatchObject({ n: 1, class: 'native', budgetLegacy: 1 });
    expect(row.slides[0]).not.toHaveProperty('legacyFills');
  }, 120_000);
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

  it("rates the guard's left-outs as LibreOffice's art with it, and as missing without it (lo-forms)", async () => {
    const dir = await work();
    const p = new pptxgen();
    p.layout = 'LAYOUT_16x9';
    const slide = p.addSlide();
    for (let i = 0; i < 20; i++)
      slide.addImage({
        data: dataUri(testPicture(40 + i, 30, i / 20)),
        x: (i % 5) * 2,
        y: Math.floor(i / 5),
        w: 1.5,
        h: 0.8,
      });
    await writeFile(join(dir, 'pictures.pptx'), (await p.write({ outputType: 'nodebuffer' })) as Buffer);
    const row = async (noLibreOffice: boolean) => {
      const out = join(dir, `census-${noLibreOffice}.jsonl`);
      await runCensus([join(dir, 'pictures.pptx')], out, () => {}, { noLibreOffice });
      return (
        (JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>).slides as Record<
          string,
          unknown
        >[]
      )[0]!;
    };
    const lo = await row(false);
    expect(lo.class).toBe('hybrid');
    expect(lo.reasons).toContain('art:budget:pictures');
    expect(lo.missing).toBeUndefined();
    const noLo = await row(true);
    expect(noLo.reasons).toContain('missing:decoration');
    expect(noLo.reasons).not.toContain('art:budget:pictures');
    expect(noLo.missing).toEqual(['decoration']);
  }, 120_000);
});

describe('legacyColumns: the slides the underlay frame splits (M4)', () => {
  const squares = (n: number) =>
    Array.from(
      { length: n },
      (_, i) =>
        ({
          id: `s${i}`,
          type: 'shape',
          shape: 'rect',
          box: { x: (i % 20) * 90, y: Math.floor(i / 20) * 60, w: 80, h: 50, rotation: 0 },
          radius: 0,
          opacity: 1,
          fill: { r: i % 256, g: 7, b: 9, a: 1 },
        }) as Slide['objects'][number],
    );

  it('lists a slide of 340 objects: the frame under the 200 the live clamp keeps, at 3840 and at 1920, with its rule', () => {
    expect(legacyColumns(slide(squares(340)))).toEqual({
      frame: 140,
      frame_objects: 1,
      frameBytes: 3840 * 2160 * 4,
      frame1080: 140,
      frame1080_objects: 1,
    });
  });

  it('says nothing of a slide the counts hold: 200 objects, and an empty slide', () => {
    expect(legacyColumns(slide(squares(200)))).toEqual({});
    expect(legacyColumns(slide([]))).toEqual({});
  });
});

describe('the Q24.b columns (step 2 of import-whole)', () => {
  const info = (o: Partial<Parameters<typeof wholeColumns>[0]> = {}) => ({
    kept: true,
    anchorKinds: [] as ('clip' | 'background' | 'bound')[],
    bgOwn: false,
    objects: 20,
    pictures: 2,
    ...o,
  });

  it('reads --whole and --whole-anchors (own | motion, default motion) and leaves the old options as they were', () => {
    expect(parseCensusArgs(['--whole', '--out', 'c.jsonl', 'a'])).toMatchObject({
      whole: true,
      wholeAnchors: 'motion',
    });
    expect(parseCensusArgs(['--whole', '--whole-anchors', 'own', '--out', 'c.jsonl', 'a'])).toMatchObject({
      whole: true,
      wholeAnchors: 'own',
    });
    expect(parseCensusArgs(['--out', 'c.jsonl', 'a']).whole).toBeUndefined();
    expect(() => parseCensusArgs(['--whole', '--whole-anchors', 'all', '--out', 'c.jsonl', 'a'])).toThrow(
      /own|motion/,
    );
    expect(() => parseCensusArgs(['--whole-anchors', 'own', '--out', 'c.jsonl', 'a'])).toThrow(/--whole/);
  });

  it('names the decision per slide: kept or not and why, the picture background, the pictures, heavy, and what the base plan cuts', () => {
    // Kept whole and heavy: what the guard and the picture limit cut today is named.
    expect(
      wholeColumns(
        info({ objects: 410, pictures: 30, cut: { elements: 222, pictures: 14 } }),
        { objects: [] },
        80_000,
      ),
    ).toEqual({
      wholeKept: true,
      planned: 410,
      pictures: 30,
      heavy: true,
      wouldCut: 222,
      wouldCutPictures: 14,
    });
    // Kept out: the reason and the background, nothing cut (the slide is planned as today).
    expect(
      wholeColumns(
        info({ kept: false, anchorKinds: ['clip'], bgOwn: true, objects: 230, pictures: 3 }),
        { objects: [] },
        90_000,
      ),
    ).toEqual({
      wholeKept: false,
      planned: 230,
      anchorKinds: ['clip'],
      bgOwn: true,
      pictures: 3,
      heavy: true,
    });
    // A small slide: only the decision and its pictures; zeros left out.
    expect(wholeColumns(info(), { objects: [] }, 5_000)).toEqual({
      wholeKept: true,
      planned: 20,
      pictures: 2,
    });
    expect(wholeColumns(info({ pictures: 0 }), { objects: [] }, 5_000)).toEqual({
      wholeKept: true,
      planned: 20,
    });
    // Heavy by each of the three bounds alone.
    expect(wholeColumns(info({ objects: 201, pictures: 0 }), { objects: [] }, 100).heavy).toBe(true);
    expect(wholeColumns(info({ objects: 5, pictures: 17 }), { objects: [] }, 100).heavy).toBe(true);
    expect(wholeColumns(info({ objects: 5, pictures: 1 }), { objects: [] }, 65_537).heavy).toBe(true);
    expect(wholeColumns(info({ objects: 200, pictures: 16 }), { objects: [] }, 65_536).heavy).toBeUndefined();
    // Both reasons of a slide kept out are named, in the converter's order.
    expect(
      wholeColumns(
        info({ kept: false, anchorKinds: ['clip', 'bound'], objects: 1_200 }),
        { objects: [] },
        400_000,
      ).anchorKinds,
    ).toEqual(['clip', 'bound']);
  });

  /** A deck of three slides: 230 text boxes; 20 pictures of their own; one line of text. */
  async function crowdedDeck(dir: string, bgPicture = false): Promise<string> {
    const p = new pptxgen();
    p.layout = 'LAYOUT_16x9';
    const crowd = p.addSlide();
    for (let i = 0; i < 230; i++)
      crowd.addText(`Word ${i}`, {
        x: (i % 10) * 0.9,
        y: Math.floor(i / 10) * 0.2,
        w: 0.8,
        h: 0.18,
        fontSize: 8,
      });
    const pics = p.addSlide();
    if (bgPicture) pics.background = { data: dataUri(testPicture(64, 36, 0.3)) };
    for (let i = 0; i < 20; i++)
      pics.addImage({
        data: dataUri(testPicture(40 + i, 30, i / 20)),
        x: (i % 5) * 2,
        y: Math.floor(i / 5),
        w: 1.5,
        h: 0.8,
      });
    p.addSlide().addText('Amazing grace', { x: 1, y: 1, w: 6, h: 1, fontSize: 40 });
    const file = join(dir, bgPicture ? 'crowded-bg.pptx' : 'crowded.pptx');
    await writeFile(file, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
    return file;
  }
  async function rowsOf(file: string, dir: string, opts: Parameters<typeof runCensus>[3]) {
    const out = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
    await runCensus([file], out, () => {}, opts);
    return JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown> & {
      slides: Record<string, unknown>[];
    };
  }

  it('with --whole a crowded deck says what the converter keeps whole and what the base plan would cut; without it, nothing changes', async () => {
    const dir = await work();
    const file = await crowdedDeck(dir);
    const row = await rowsOf(file, dir, { whole: { anchors: 'motion' } });
    const [crowd, pics, plain] = row.slides;
    expect(crowd).toMatchObject({ wholeKept: true, heavy: true });
    expect(crowd!.objects as number).toBeGreaterThanOrEqual(230);
    expect(crowd!.wouldCut as number).toBeGreaterThan(0);
    expect(pics).toMatchObject({ wholeKept: true, pictures: 20, heavy: true });
    expect(pics!.wouldCut as number).toBeGreaterThan(0);
    expect(pics!.wouldCutPictures as number).toBeGreaterThan(0);
    expect(plain).toMatchObject({ wholeKept: true });
    expect(plain!.heavy).toBeUndefined();
    expect(plain!.wouldCut).toBeUndefined();
    // The deck's bytes of heavy slides, summed.
    expect(row.heavyBytes as number).toBe((crowd!.bytes as number) + (pics!.bytes as number));
    // Without the option none of the columns is written, and the slides are as they were.
    const off = await rowsOf(file, dir, {});
    for (const s of off.slides) {
      expect(s.wholeKept).toBeUndefined();
      expect(s.wouldCut).toBeUndefined();
      expect(s.heavy).toBeUndefined();
    }
    expect(off.heavyBytes).toBeUndefined();
    expect(off.slides[0]!.objects as number).toBeLessThan(crowd!.objects as number);
  }, 180_000);

  it("the picture background is counted either way (bgOwn) and keeps a slide out only under the arm 'own'", async () => {
    const dir = await work();
    const file = await crowdedDeck(dir, true);
    const motion = await rowsOf(file, dir, { whole: { anchors: 'motion' } });
    expect(motion.slides[1]).toMatchObject({ bgOwn: true, wholeKept: true });
    expect(motion.slides[1]!.anchorKinds).toBeUndefined();
    const own = await rowsOf(file, dir, { whole: { anchors: 'own' } });
    expect(own.slides[1]).toMatchObject({ bgOwn: true, wholeKept: false, anchorKinds: ['background'] });
    expect(own.slides[0]).toMatchObject({ wholeKept: true });
  }, 180_000);
});

describe('hubClasses with the whole option (Q24.b, step 8a)', () => {
  const rect = (i: number): Slide['objects'][number] =>
    ({
      ...outline('r'),
      id: `r${i}`,
      geom: undefined,
      fill: { r: 1, g: 2, b: 3, a: 1 },
    }) as Slide['objects'][number];
  const crowded = slide([text('Grace'), ...Array.from({ length: 700 }, (_, i) => rect(i))]);

  it('models the ladder that keeps a heavy slide whole: hub native, level grid, hubWhole, nothing left out', () => {
    const [off] = hubClasses([{ class: 'native', slide: crowded, notes: [] }]);
    expect(off).not.toHaveProperty('hubWhole');
    expect(off!.level).not.toBe('full');
    const [on] = hubClasses([{ class: 'native', slide: crowded, notes: [] }], [], undefined, true);
    expect(on).toMatchObject({ hub: 'native', level: 'grid', hubWhole: true, missing: [] });
    expect(on!.slide.objects).toHaveLength(701);
  });
});

describe('noLoDraws: what a hub without LibreOffice stores of a slide, drawn where it differs (M9, Q24.b)', () => {
  const rect = (i: number): Slide['objects'][number] =>
    ({
      ...outline('r'),
      id: `r${i}`,
      geom: undefined,
      fill: { r: 1, g: 2, b: 3, a: 1 },
    }) as Slide['objects'][number];
  const crowded = slide([text('Grace'), ...Array.from({ length: 700 }, (_, i) => rect(i))]);
  const deck = (): NativeDeck => ({
    slides: [
      {
        index: 0,
        shown: 0,
        hidden: false,
        tier: 'T1',
        class: 'native',
        reasons: [],
        convertMs: 0,
        notes: [],
        slide: crowded,
        textFeatures: [],
        compat: [],
      } as unknown as NativeSlide,
    ],
    slideRect: { x: 0, y: 0, w: 1920, h: 1080 },
    media: [],
    geoms: [],
    notes: [],
    embeddedFonts: false,
    textFeatures: [],
    extractMs: 0,
    parseMs: 0,
    emitMs: 0,
  });

  it('without the whole option the hub stores the crowded slide simplified, so its draw differs from the converter\u2019s', () => {
    const d = deck();
    noLoDraws(d, { loCompat: false, whole: false });
    expect(d.slides[0]!.noLoDraw).toBeDefined();
    expect(d.slides[0]!.noLoDraw!.objects.length).toBeLessThan(701);
  });

  it('with the whole option the hub keeps it whole, so the slide drawn is what it stores: no separate draw', () => {
    const d = withHubBudget(deck(), undefined, { whole: true });
    expect(d.slides[0]!.slide.objects).toHaveLength(701);
    noLoDraws(d, { loCompat: false, whole: true });
    expect(d.slides[0]!.noLoDraw).toBeUndefined();
  });
});

