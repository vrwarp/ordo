import { describe, expect, it } from 'vitest';
import { MAX_SLIDES, readDeck, slideParts } from './deck.ts';
import { emitSlides, parseDeck } from './index.ts';
import { noteList } from './log.ts';
import { NS } from './markup.ts';
import { openPackage, type PartSource } from './opc.ts';
import { buildDeck, type SlideSpec, solidBg } from './test-util.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SLIDE_REL = `${NS.r}/slide`;
const P14_SECTIONS = '{521415D9-36F7-43E2-AB2F-B90AF26B5E84}';

function within<T>(ms: number, f: () => T): T {
  const t0 = performance.now();
  const v = f();
  expect(performance.now() - t0).toBeLessThan(budgetMs(ms));
  return v;
}

/** `buildDeck` with the presentation part edited: `f` gets and returns its XML. */
function withPresentation(slides: SlideSpec[], f: (xml: string) => string): PartSource {
  const parts = buildDeck({ slides });
  parts.set('ppt/presentation.xml', enc(f(dec(parts.get('ppt/presentation.xml')))));
  return parts;
}

/** Replace `p:sldIdLst` with these `[id, rId]` entries (`buildDeck` relates slide N as `rId<N+1>`). */
const listing = (entries: [number, string][]) => (xml: string) =>
  xml.replace(
    /<p:sldIdLst>.*<\/p:sldIdLst>/,
    `<p:sldIdLst>${entries.map(([id, rid]) => `<p:sldId id="${id}" r:id="${rid}"/>`).join('')}</p:sldIdLst>`,
  );

const order = (parts: PartSource) =>
  readDeck(openPackage(parts)).slides.map((s) => [s.part.replace('ppt/slides/', ''), s.shown ?? null]);

describe('readDeck: size', () => {
  it('reads p:sldSz, else the one default', () => {
    const size = (cx: string, cy: string) =>
      readDeck(
        openPackage(
          withPresentation([{}], (x) => x.replace(/<p:sldSz [^>]*\/>/, `<p:sldSz cx="${cx}" cy="${cy}"/>`)),
        ),
      ).size;
    expect(size('9144000', '6858000')).toEqual({ cx: 9_144_000, cy: 6_858_000 });
    expect(size('0', '6858000')).toEqual({ cx: 12_192_000, cy: 6_858_000 });
    expect(size('9144000', 'NaN')).toEqual({ cx: 12_192_000, cy: 6_858_000 });
    expect(size('60000000', '6858000')).toEqual({ cx: 12_192_000, cy: 6_858_000 });
    expect(
      readDeck(openPackage(withPresentation([{}], (x) => x.replace(/<p:sldSz [^>]*\/>/, '')))).size,
    ).toEqual({ cx: 12_192_000, cy: 6_858_000 });
  });
});

describe('readDeck: order, hidden slides and the shown index', () => {
  it('follows p:sldIdLst, not part names, and leaves out slides it does not list', () => {
    const parts = withPresentation(
      [{}, {}, {}, {}],
      listing([
        [300, 'rId5'],
        [301, 'rId3'],
        [302, 'rId2'],
      ]),
    );
    expect(order(parts)).toEqual([
      ['slide4.xml', 0],
      ['slide2.xml', 1],
      ['slide1.xml', 2],
    ]);
  });

  it('hides slides with show="0" or "false" in place, without a shown index', () => {
    const parts = buildDeck({
      slides: [
        { hidden: true },
        {},
        { attrs: 'show="false"' },
        { attrs: 'show="1"' },
        {},
        { attrs: 'show=" 0 "' },
      ],
    });
    const deck = readDeck(openPackage(parts));
    expect(deck.slides.map((s) => [s.index, s.hidden, s.shown])).toEqual([
      [0, true, undefined],
      [1, false, 0],
      [2, true, undefined],
      [3, false, 1],
      [4, false, 2],
      [5, true, undefined],
    ]);
  });

  it('reads a slide listed twice once, but counts each shown listing as LibreOffice prints it', () => {
    // LibreOffice prints a page per listing: slide1, slide2, slide1 again, slide3 → pages 0-3 (verified).
    const parts = withPresentation(
      [{}, {}, {}, { hidden: true }],
      listing([
        [256, 'rId2'],
        [257, 'rId3'],
        [258, 'rId2'],
        [259, 'rId5'],
        [260, 'rId5'],
        [261, 'rId4'],
      ]),
    );
    expect(order(parts)).toEqual([
      ['slide1.xml', 0],
      ['slide2.xml', 1],
      ['slide4.xml', null],
      ['slide3.xml', 3],
    ]);
    // The same part through two relationships (one spelled in another case) is one slide too.
    const twice = buildDeck({ slides: [{}, {}] });
    twice.set(
      'ppt/_rels/presentation.xml.rels',
      enc(
        dec(twice.get('ppt/_rels/presentation.xml.rels')).replace(
          '</Relationships>',
          `<Relationship Id="rId99" Type="${SLIDE_REL}" Target="SLIDES/Slide1.xml"/></Relationships>`,
        ),
      ),
    );
    twice.set(
      'ppt/presentation.xml',
      enc(
        dec(twice.get('ppt/presentation.xml')).replace(
          '</p:sldIdLst>',
          '<p:sldId id="400" r:id="rId99"/></p:sldIdLst>',
        ),
      ),
    );
    expect(order(twice)).toEqual([
      ['slide1.xml', 0],
      ['slide2.xml', 1],
    ]);
  });

  it('reads the slide list entry whatever prefix the relationships namespace has', () => {
    const declared = withPresentation([{}, {}], (x) =>
      x.replace(`xmlns:r="${NS.r}"`, `xmlns:rel="${NS.r}"`).replaceAll(' r:id=', ' rel:id='),
    );
    expect(order(declared)).toEqual([
      ['slide1.xml', 0],
      ['slide2.xml', 1],
    ]);
    // Not even declared: read as `annotate.ts` reads it.
    const undeclared = withPresentation([{}], (x) =>
      x.replace(`xmlns:r="${NS.r}"`, '').replaceAll(' r:id=', ' q:id='),
    );
    expect(order(undeclared)).toEqual([['slide1.xml', 0]]);
  });

  it('reads slides by the number in their names when the list names none', () => {
    const slides = Array.from({ length: 12 }, () => ({}));
    const empty = withPresentation(slides, (x) => x.replace(/<p:sldIdLst>.*<\/p:sldIdLst>/, '<p:sldIdLst/>'));
    const { notes, log } = noteList();
    const deck = readDeck(openPackage(empty, log));
    expect(deck.slides.map((s) => s.part.replace('ppt/slides/', ''))).toEqual(
      Array.from({ length: 12 }, (_, i) => `slide${i + 1}.xml`),
    );
    expect(deck.slides.map((s) => s.shown)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(notes).toContain('the slide list is empty: slides are read in the order of their part names');
    // Without slide relationships either: the content types' slide parts.
    const bare = withPresentation([{}, {}, {}], (x) => x.replace(/<p:sldIdLst>.*<\/p:sldIdLst>/, ''));
    bare.set('ppt/_rels/presentation.xml.rels', enc(`<Relationships xmlns="${REL}"/>`));
    expect(order(bare)).toEqual([
      ['slide1.xml', 0],
      ['slide2.xml', 1],
      ['slide3.xml', 2],
    ]);
  });

  it('skips list entries that name no slide part, an external target or another kind of part', () => {
    const parts = withPresentation([{}, {}], (x) =>
      x.replace(
        '</p:sldIdLst>',
        '<p:sldId id="500" r:id="rIdNone"/><p:sldId id="501"/><p:sldId id="502" r:id="rIdExt"/><p:sldId id="503" r:id="rIdLayout"/></p:sldIdLst>',
      ),
    );
    parts.set(
      'ppt/_rels/presentation.xml.rels',
      enc(
        dec(parts.get('ppt/_rels/presentation.xml.rels')).replace(
          '</Relationships>',
          `<Relationship Id="rIdExt" Type="${SLIDE_REL}" Target="https://example.com/s.xml" TargetMode="External"/>` +
            `<Relationship Id="rIdLayout" Type="${SLIDE_REL}" Target="slideLayouts/slideLayout1.xml"/></Relationships>`,
        ),
      ),
    );
    const { notes, log } = noteList();
    expect(readDeck(openPackage(parts, log)).slides.map((s) => s.part)).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
    ]);
    expect(notes).toContain('3 slide list entries name no slide part');
    expect(notes).toContain('1 listed part is not a slide');
  });

  it('reads the show flag past a long head, and leaves an unreadable slide shown for the quarantine', () => {
    const parts = buildDeck({ slides: [{ hidden: true }, {}, {}] });
    const padded = dec(parts.get('ppt/slides/slide1.xml')).replace(
      '<p:sld ',
      `<!--${' '.repeat(100_000)}--><p:sld `,
    );
    parts.set('ppt/slides/slide1.xml', enc(padded));
    parts.set('ppt/slides/slide2.xml', enc('<!DOCTYPE p:sld><p:sld show="0"/>'));
    const scene = parseDeck(parts);
    expect(scene.slides.map((s) => [s.hidden, s.shown])).toEqual([
      [true, undefined],
      [false, 0],
      [false, 1],
    ]);
    expect(scene.slides[1]!.error).toMatch(/DOCTYPE/);
  });

  it('reads at most 2,000 slides, quickly, from a list of any length', () => {
    const n = MAX_SLIDES + 1;
    const parts: PartSource = new Map();
    const relsList: string[] = [];
    const ids: string[] = [];
    for (let i = 1; i <= n; i++) {
      parts.set(`ppt/slides/slide${i}.xml`, enc(`<p:sld xmlns:p="${NS.p}"${i % 3 ? '' : ' show="0"'}/>`));
      relsList.push(`<Relationship Id="rId${i}" Type="${SLIDE_REL}" Target="slides/slide${i}.xml"/>`);
      ids.push(`<p:sldId id="${255 + i}" r:id="rId${i}"/>`);
    }
    // And 100,000 repeats of the first slide.
    ids.push(`<p:sldId id="1" r:id="rId1"/>`.repeat(100_000));
    parts.set(
      'ppt/_rels/presentation.xml.rels',
      enc(`<Relationships xmlns="${REL}">${relsList.join('')}</Relationships>`),
    );
    parts.set(
      'ppt/presentation.xml',
      enc(
        `<p:presentation xmlns:p="${NS.p}" xmlns:r="${NS.r}"><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`,
      ),
    );
    const { notes, log } = noteList();
    const deck = within(5000, () => readDeck(openPackage(parts, log)));
    expect(deck.slides).toHaveLength(MAX_SLIDES);
    expect(deck.slides.at(-1)!.part).toBe(`ppt/slides/slide${MAX_SLIDES}.xml`);
    expect(deck.slides.filter((s) => s.hidden)).toHaveLength(Math.floor(MAX_SLIDES / 3));
    expect(notes).toContain(`only the first ${MAX_SLIDES} slides are read`);
    const scene = within(5000, () => parseDeck(parts));
    expect(scene.slides).toHaveLength(MAX_SLIDES);
  });

  it('reads a deck whose slides are all hidden', () => {
    const scene = parseDeck(
      buildDeck({ slides: [{ hidden: true, bg: solidBg('FF0000') }, { hidden: true }] }),
    );
    expect(scene.slides.map((s) => [s.hidden, s.shown, s.error])).toEqual([
      [true, undefined, undefined],
      [true, undefined, undefined],
    ]);
    const out = emitSlides(scene);
    expect(out.slides.map((s) => s.shown)).toEqual([undefined, undefined]);
  });
});

describe('readDeck: sections, styles and fonts', () => {
  const sections = (list: string) =>
    `<p:extLst><p:ext uri="{EXAMPLE}"><x/></p:ext><p:ext uri="${P14_SECTIONS}"><p14:sectionLst xmlns:p14="${NS.p14}">${list}</p14:sectionLst></p:ext></p:extLst>`;
  const section = (name: string, ids: number[]) =>
    `<p14:section name="${name}" id="{${name.length}}"><p14:sldIdLst>${ids.map((id) => `<p14:sldId id="${id}"/>`).join('')}</p14:sldIdLst></p14:section>`;

  it('reads p14:sectionLst into slide indexes, each slide in its first section', () => {
    const parts = withPresentation([{}, { hidden: true }, {}, {}], (x) =>
      x.replace(
        '</p:presentation>',
        `${sections(
          section('Welcome', [256, 999]) +
            section('Worship &amp; Word', [257, 258, 256]) +
            section('Empty', []) +
            section('Line&#10;break', [259]),
        )}</p:presentation>`,
      ),
    );
    expect(readDeck(openPackage(parts)).sections).toEqual([
      { name: 'Welcome', slides: [0] },
      { name: 'Worship & Word', slides: [1, 2] },
      { name: 'Empty', slides: [] },
      { name: 'Line break', slides: [3] },
    ]);
    expect(parseDeck(parts).sections).toHaveLength(4);
  });

  it('reads the default text style and the embedded font list', () => {
    const parts = withPresentation([{}], (x) =>
      x.replace(
        '</p:presentation>',
        '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Montserrat"/><p:regular r:id="rId90"/></p:embeddedFont>' +
          '<p:embeddedFont><p:font typeface="Montserrat"/></p:embeddedFont><p:embeddedFont><p:font typeface="Bad&#7;Name"/></p:embeddedFont>' +
          '</p:embeddedFontLst><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>',
      ),
    );
    const deck = readDeck(openPackage(parts));
    expect(deck.embeddedFonts).toEqual(['Montserrat', 'Bad Name']);
    expect(deck.defaultTextStyle?.children[0]?.name).toBe('a:lvl1pPr');
  });
});

describe('readDeck: the presentation part', () => {
  it('is the package officeDocument, else a presentation content type, else ppt/presentation.xml', () => {
    const moved = buildDeck({ slides: [{}] });
    moved.set('deck/main.xml', moved.get('ppt/presentation.xml')!);
    moved.delete('ppt/presentation.xml');
    moved.set(
      'deck/_rels/main.xml.rels',
      enc(dec(moved.get('ppt/_rels/presentation.xml.rels')).replaceAll('Target="', 'Target="../ppt/')),
    );
    moved.set(
      '_rels/.rels',
      enc(dec(moved.get('_rels/.rels')).replace('ppt/presentation.xml', 'deck/main.xml')),
    );
    const deck = readDeck(openPackage(moved));
    expect(deck.presentationPart).toBe('deck/main.xml');
    expect(deck.slides.map((s) => s.part)).toEqual(['ppt/slides/slide1.xml']);

    // A root relationship to a slide instead: the usual part is found.
    const wrong = buildDeck({ slides: [{}] });
    wrong.set(
      '_rels/.rels',
      enc(dec(wrong.get('_rels/.rels')).replace('ppt/presentation.xml', 'ppt/slides/slide1.xml')),
    );
    expect(readDeck(openPackage(wrong)).presentationPart).toBe('ppt/presentation.xml');
    expect(() => readDeck(openPackage(new Map([['ppt/presentation.xml', enc('<p:sld/>')]])))).toThrow(
      /no presentation part/,
    );
  });
});

describe('slideParts', () => {
  it('follows the slide to its layout, master and theme', () => {
    const pkg = openPackage(buildDeck({ slides: [{}] }));
    const p = slideParts(pkg, 'ppt/slides/slide1.xml');
    expect([p.slide.name, p.layout?.name, p.master?.name, p.theme?.name]).toEqual([
      'p:sld',
      'p:sldLayout',
      'p:sldMaster',
      'a:theme',
    ]);
    expect([p.layoutPart, p.masterPart, p.themePart]).toEqual([
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/theme/theme1.xml',
    ]);
    expect(() => slideParts(pkg, 'ppt/slideLayouts/slideLayout1.xml')).toThrow(/not a slide/);
    expect(() => slideParts(pkg, 'ppt/slides/none.xml')).toThrow(/missing/);
  });
});
