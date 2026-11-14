import { describe, expect, it } from 'vitest';
import { emitSlides, parseDeck } from './index.ts';
import { noteList } from './log.ts';
import { NS } from './markup.ts';
import {
  decodeText,
  externalHost,
  MAX_EXTERNAL_NOTES,
  MAX_PART_NAME_CHARS,
  openPackage,
  type PartSource,
  relIdOf,
  relsPartOf,
  resolveTarget,
  XML_CACHE_BYTES,
  XML_NODE_BYTES,
} from './opc.ts';
import { body, buildDeck, grpSp, imageRel, para, pic, run, scheme, solid, solidBg, sp } from './test-util.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const IN = 914_400;
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const rels = (list: string) => `<Relationships xmlns="${REL}">${list}</Relationships>`;

/** Run `f`, failing when it takes longer than `ms` (design/27 §14: each limit test under 5 s). */
function within<T>(ms: number, f: () => T): T {
  const t0 = performance.now();
  const v = f();
  expect(performance.now() - t0).toBeLessThan(budgetMs(ms));
  return v;
}

/** A part source that counts how often each part's bytes are read (an XML part's are read once per parse). */
class CountingSource extends Map<string, Uint8Array> {
  reads = new Map<string, number>();
  override get(name: string): Uint8Array | undefined {
    this.reads.set(name, (this.reads.get(name) ?? 0) + 1);
    return super.get(name);
  }
}

/** A copy of `parts` with every XML and relationships part passed through `f`. */
function mapXml(parts: PartSource, f: (name: string, xml: string) => string): PartSource {
  const out: PartSource = new Map();
  for (const [name, b] of parts)
    out.set(name, /\.(xml|rels)$/.test(name) ? enc(f(name, new TextDecoder().decode(b))) : b);
  return out;
}

describe('relationship targets', () => {
  it('resolve inside the package', () => {
    expect(relsPartOf('ppt/slides/slide1.xml')).toBe('ppt/slides/_rels/slide1.xml.rels');
    expect(relsPartOf('')).toBe('_rels/.rels');
    expect(resolveTarget('ppt/slides/slide1.xml', '../media/image%201.png')).toBe('ppt/media/image 1.png');
    expect(resolveTarget('ppt/slides/slide1.xml', '/ppt/media/a.png#frag')).toBe('ppt/media/a.png');
    expect(resolveTarget('ppt/slides/slide1.xml', '../../../../etc/passwd')).toBe('etc/passwd');
    expect(resolveTarget('ppt/slides/slide1.xml', '..%2F..%2F..%2Fx.png')).toBe('x.png');
    expect(resolveTarget('ppt/slides/slide1.xml', '.\\..\\media\\b.png')).toBe('ppt/media/b.png');
    expect(resolveTarget('ppt/slides/slide1.xml', '../media/bad%zz.png')).toBe('ppt/media/bad%zz.png');
    expect(resolveTarget('', 'ppt/presentation.xml')).toBe('ppt/presentation.xml');
    expect(resolveTarget('ppt/a.xml', '..')).toBeUndefined();
  });

  it('log external targets by host only', () => {
    expect(externalHost('https://example.com/a/b?c')).toBe('example.com');
    expect(externalHost('https://user:secret@Video.Example.org:8443/p/q.mp4?token=1')).toBe(
      'video.example.org',
    );
    expect(externalHost('http://[::1]:80/x')).toBe('[::1]');
    expect(externalHost('\\\\fileserver\\share\\clip.mp4')).toBe('fileserver');
    expect(externalHost('file:///C:/x.mp4')).toBe('a local file');
    expect(externalHost('C:\\Users\\me\\clip.mp4')).toBe('a local file');
    expect(externalHost('../clip.mp4')).toBe('a local file');
    expect(externalHost('mailto:someone@example.com')).toBe('mailto:');
    expect(externalHost('https://evil\n[warn] forged/x')).not.toMatch(/\n/);
  });

  it('read a relationship id under any prefix', () => {
    const el = (attrs: Record<string, string>) => ({
      name: 'p:sldId',
      attrs: Object.assign(Object.create(null), attrs),
      children: [],
      text: '',
    });
    expect(relIdOf(el({ id: '256', 'r:id': 'rId2' }))).toBe('rId2');
    expect(relIdOf(el({ id: '256', 'rel:id': 'rId3' }))).toBe('rId3');
    expect(relIdOf(el({ 'xml:id': 'x', id: '256' }))).toBeUndefined();
    expect(relIdOf(el({ 'r:embed': 'rId4' }), 'embed')).toBe('rId4');
  });
});

describe('openPackage', () => {
  it('finds parts case-insensitively, the first of a case clash winning, and resolves relationships', () => {
    const pkg = openPackage(
      new Map([
        ['ppt/slides/slide1.xml', enc('<p:sld/>')],
        [
          'ppt/slides/_rels/slide1.xml.rels',
          enc(
            '<Relationships><Relationship Id="rId1" Type="http://x/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
              '<Relationship Id="rId1" Type="http://x/image" Target="dup.png"/>' +
              '<Relationship Id="rId2" Type="http://x/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>',
          ),
        ],
        ['PPT/slideLayouts/SlideLayout1.xml', enc('<p:sldLayout/>')],
        ['ppt/slidelayouts/slidelayout1.xml', enc('<p:other/>')],
      ]),
    );
    expect(pkg.find('ppt/slideLayouts/slideLayout1.xml')).toBe('PPT/slideLayouts/SlideLayout1.xml');
    // Even spelled exactly as the second of the clash: the first is the part.
    expect(pkg.find('ppt/slidelayouts/slidelayout1.xml')).toBe('PPT/slideLayouts/SlideLayout1.xml');
    expect(pkg.rels('ppt/slides/slide1.xml')).toHaveLength(2);
    expect(pkg.relOfType('ppt/slides/slide1.xml', 'slideLayout')?.target).toBe(
      'PPT/slideLayouts/SlideLayout1.xml',
    );
    expect(pkg.xml(pkg.relOfType('ppt/slides/slide1.xml', 'slideLayout')!.target)?.name).toBe('p:sldLayout');
    expect(pkg.rel('ppt/slides/slide1.xml', 'rId2')).toMatchObject({
      external: true,
      target: 'https://example.com',
    });
  });

  it('decodes UTF-16 parts and refuses oversized ones', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'<a x="é"/>'].flatMap((c) => [c.charCodeAt(0), 0])]);
    const pkg = openPackage(
      new Map([
        ['a.xml', utf16],
        ['big.xml', new Uint8Array(8 * 1024 * 1024 + 1)],
      ]),
    );
    expect(pkg.xml('a.xml')?.attrs.x).toBe('é');
    expect(() => pkg.xml('big.xml')).toThrow(/8 MB/);
    expect(pkg.xml('missing.xml')).toBeUndefined();
  });

  it('decodes by BOM, by UTF-16 markup, else by the declared encoding, else UTF-8', () => {
    const be = new Uint8Array([...'<a/>'].flatMap((c) => [0, c.charCodeAt(0)]));
    expect(decodeText(new Uint8Array([0xfe, 0xff, ...be]))).toBe('<a/>');
    expect(decodeText(new Uint8Array([0, 0x3c, 0, 0x3f, 0, 0x78]))).toBe('<?x');
    expect(decodeText(new Uint8Array([0x3c, 0, 0x3f, 0, 0x78, 0]))).toBe('<?x');
    const latin = [...'<?xml version="1.0" encoding="windows-1252"?><a x="'].map((c) => c.charCodeAt(0));
    expect(decodeText(new Uint8Array([...latin, 0xe9, 0x22, 0x2f, 0x3e]))).toContain('x="é"');
    expect(decodeText(enc('\ufeff<?xml version="1.0" encoding="UTF-8"?><a>é</a>'))).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><a>é</a>',
    );
    // An unknown label is read as UTF-8.
    expect(decodeText(enc('<?xml version="1.0" encoding="no-such"?><a>é</a>'))).toContain('é');
  });

  it('finds entries stored percent-encoded under their decoded names', () => {
    const pkg = openPackage(
      new Map([
        ['ppt/slides/slide1.xml', enc('<p:sld/>')],
        [
          'ppt/slides/_rels/slide1.xml.rels',
          enc(rels(`<Relationship Id="rId2" Type="${NS.r}/image" Target="../media/image%201.png"/>`)),
        ],
        ['ppt/media/image%201.png', new Uint8Array(1)],
      ]),
    );
    expect(pkg.rel('ppt/slides/slide1.xml', 'rId2')?.target).toBe('ppt/media/image%201.png');
    expect(pkg.has('ppt/media/image 1.png')).toBe(true);
  });

  it('matches relationship types by name or by full URI, Strict or Transitional', () => {
    const pkg = openPackage(
      new Map([
        ['a.xml', enc('<x/>')],
        [
          '_rels/a.xml.rels',
          enc(
            rels(
              `<Relationship Id="r1" Type="http://example.com/theme" Target="t0.xml"/>` +
                `<Relationship Id="r2" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/theme" Target="t1.xml"/>` +
                `<Relationship Id="r3" Type="${NS.r}/image" Target="https://x.example/i.png" TargetMode="external"/>`,
            ),
          ),
        ],
      ]),
    );
    expect(pkg.relOfType('a.xml', 'theme')?.target).toBe('t0.xml');
    expect(pkg.relOfType('a.xml', `${NS.r}/theme`)?.target).toBe('t1.xml');
    expect(pkg.relOfType('a.xml', 'http://purl.oclc.org/ooxml/officeDocument/relationships/theme')?.id).toBe(
      'r2',
    );
    expect(pkg.rel('a.xml', 'r2')?.type).toBe(`${NS.r}/theme`);
    // TargetMode is compared without case; external targets are never relationships of a type.
    expect(pkg.rel('a.xml', 'r3')?.external).toBe(true);
    expect(pkg.relOfType('a.xml', 'image')).toBeUndefined();
  });

  it('reads content types, ignoring overrides that name missing parts', () => {
    const CT = 'application/vnd.openxmlformats-officedocument.presentationml';
    const pkg = openPackage(
      new Map([
        [
          '[Content_Types].xml',
          enc(
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
              '<Default Extension="XML" ContentType="application/xml"/><Default Extension="__proto__" ContentType="x/proto"/>' +
              `<Override PartName="/ppt/slides/slide9.xml" ContentType="${CT}.slide+xml"/>` +
              `<Override PartName="/PPT/Slides/Slide1.xml" ContentType="${CT}.slide+xml"/>` +
              `<Override PartName="/ppt/slides/slide2.xml" ContentType="${CT.toUpperCase()}.SLIDE+XML"/>` +
              `<Override PartName="/ppt/slides/slide2.xml" ContentType="${CT}.notesSlide+xml"/></Types>`,
          ),
        ],
        ['ppt/slides/slide1.xml', enc('<p:sld/>')],
        ['ppt/slides/slide2.xml', enc('<p:sld/>')],
        ['ppt/slides/slide3.xml', enc('<p:sld/>')],
        ['x.__proto__', enc('')],
      ]),
    );
    expect(pkg.contentType('ppt/slides/slide1.xml')).toBe(`${CT}.slide+xml`);
    expect(pkg.contentType('ppt/slides/slide3.xml')).toBe('application/xml');
    expect(pkg.contentType('x.__proto__')).toBe('x/proto');
    expect(pkg.contentType('ppt/slides/slide9.xml')).toBeUndefined();
    expect(pkg.partsOfType(`${CT}.slide+xml`)).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']);
  });

  it('charges parsed trees by their elements, not only by their text', () => {
    // Two parts of 1,000 empty elements: about 4,000 characters, but 300 KB of estimated tree each.
    const parts = new Map([
      ['a.xml', enc(`<a>${'<b/>'.repeat(999)}</a>`)],
      ['b.xml', enc(`<a>${'<b/>'.repeat(999)}</a>`)],
    ]);
    const tight = openPackage(parts, undefined, { cacheBytes: 1_500 * XML_NODE_BYTES });
    const a = tight.xml('a.xml');
    tight.xml('b.xml'); // over the budget: a dropped
    expect(tight.xml('a.xml')).not.toBe(a);
    const roomy = openPackage(parts, undefined, { cacheBytes: 2_100 * XML_NODE_BYTES });
    const a2 = roomy.xml('a.xml');
    roomy.xml('b.xml');
    expect(roomy.xml('a.xml')).toBe(a2);
    // The default budget holds a slide's working set: its layout, master and theme, each at the tag limit.
    expect(XML_CACHE_BYTES).toBeGreaterThanOrEqual(3 * (8 * 1024 * 1024 + 250_000 * XML_NODE_BYTES));
  });

  it('never evicts pinned parts; the others go least recently used first', () => {
    const big = (root: string) => enc(`<${root}>${'<b/>'.repeat(999)}</${root}>`);
    const parts = new Map([
      ['l.xml', big('l')],
      ['m.xml', big('m')],
      ['o.xml', big('o')],
      ['p.xml', big('p')],
    ]);
    // Room for one tree: pinned ones stay over the budget, unpinned ones go when another comes.
    const pkg = openPackage(parts, undefined, { cacheBytes: 1_100 * XML_NODE_BYTES });
    pkg.pin(['L.XML', 'm.xml']); // found without case
    const l = pkg.xml('l.xml');
    const m = pkg.xml('m.xml');
    const o = pkg.xml('o.xml');
    expect(pkg.xml('l.xml')).toBe(l);
    expect(pkg.xml('m.xml')).toBe(m);
    expect(pkg.xml('o.xml')).toBe(o); // the newest is kept
    pkg.pin(['m.xml']); // l is not pinned any more
    pkg.xml('p.xml'); // over the budget: l and o go, m stays
    expect(pkg.xml('m.xml')).toBe(m);
    expect(pkg.xml('l.xml')).not.toBe(l);
    expect(pkg.xml('o.xml')).not.toBe(o);
  });

  it("holds a slide's relationships only while it is the slide being read, and indexes them by type", () => {
    const parts = new CountingSource([
      ['s1.xml', enc('<p:sld/>')],
      ['s2.xml', enc('<p:sld/>')],
      ['_rels/s1.xml.rels', enc(rels(`<Relationship Id="r1" Type="${NS.r}/slideLayout" Target="l.xml"/>`))],
      ['_rels/s2.xml.rels', enc(rels(`<Relationship Id="r1" Type="${NS.r}/slideLayout" Target="l.xml"/>`))],
      ['_rels/l.xml.rels', enc(rels(`<Relationship Id="r1" Type="${NS.r}/slideMaster" Target="m.xml"/>`))],
      ['l.xml', enc('<p:sldLayout/>')],
    ]);
    const pkg = openPackage(parts);
    pkg.xml('s1.xml', { keep: false });
    expect(pkg.relOfType('s1.xml', 'slideLayout')?.target).toBe('l.xml');
    expect(pkg.rel('s1.xml', 'r1')?.target).toBe('l.xml');
    expect(pkg.relOfType('l.xml', `${NS.r}/slideMaster`)?.target).toBe('m.xml');
    expect(parts.reads.get('_rels/s1.xml.rels')).toBe(1);
    pkg.xml('s2.xml', { keep: false });
    pkg.rels('s2.xml');
    pkg.rels('l.xml');
    pkg.rels('s1.xml'); // no longer the slide being read: its list was not kept
    expect(parts.reads.get('_rels/s1.xml.rels')).toBe(2);
    expect(parts.reads.get('_rels/s2.xml.rels')).toBe(1);
    expect(parts.reads.get('_rels/l.xml.rels')).toBe(1);
  });

  it('parses a part read with keep: false without caching it, but answers from the cache when it is there', () => {
    const pkg = openPackage(new Map([['a.xml', enc('<a/>')]]));
    const once = pkg.xml('a.xml', { keep: false });
    expect(pkg.xml('a.xml', { keep: false })).not.toBe(once);
    const kept = pkg.xml('a.xml');
    expect(pkg.xml('a.xml', { keep: false })).toBe(kept);
  });

  it('keeps parsed parts within its cache budget, least recently used dropped first', () => {
    const pkg = openPackage(
      new Map([
        ['a.xml', enc(`<a>${'x'.repeat(100)}</a>`)],
        ['b.xml', enc(`<b>${'x'.repeat(100)}</b>`)],
        ['c.xml', enc('<!DOCTYPE c><c/>')],
      ]),
      undefined,
      { cacheBytes: 1_000 },
    );
    const a = pkg.xml('a.xml');
    expect(pkg.xml('a.xml')).toBe(a);
    pkg.xml('b.xml'); // a dropped
    const again = pkg.xml('a.xml');
    expect(again).not.toBe(a);
    expect(again).toEqual(a);
    expect(() => pkg.xml('c.xml')).toThrow(/DOCTYPE/);
    expect(() => pkg.xml('c.xml')).toThrow(/DOCTYPE/);
  });

  it('notes external targets with their host only, a bounded number of times', () => {
    const list = Array.from(
      { length: 50 },
      (_, i) =>
        `<Relationship Id="h${i}" Type="${NS.r}/hyperlink" Target="https://u:pw@host${i}.example/secret?k=${i}" TargetMode="External"/>`,
    ).join('');
    const { notes, log } = noteList();
    const pkg = openPackage(
      new Map([
        ['a.xml', enc('<x/>')],
        ['_rels/a.xml.rels', enc(rels(list + list))],
      ]),
      log,
    );
    expect(pkg.rels('a.xml')).toHaveLength(50);
    expect(notes[0]).toBe('external hyperlink target (host0.example) is not fetched');
    expect(notes).toHaveLength(MAX_EXTERNAL_NOTES + 1);
    expect(notes.at(-1)).toBe('more external targets are not listed');
    expect(notes.join('\n')).not.toMatch(/secret|pw|k=/);
  });

  it('ignores relationship targets too long to be real', () => {
    const { notes, log } = noteList();
    const pkg = openPackage(
      new Map([
        ['a.xml', enc('<x/>')],
        [
          '_rels/a.xml.rels',
          enc(rels(`<Relationship Id="r1" Type="${NS.r}/image" Target="${'a/'.repeat(5000)}x.png"/>`)),
        ],
      ]),
      log,
    );
    expect(pkg.rels('a.xml')).toEqual([]);
    expect(notes[0]).toMatch(/too long/);
  });

  it('ignores internal targets whose part names are longer than 512 characters', () => {
    const long = `${'x'.repeat(MAX_PART_NAME_CHARS)}.png`;
    const ok = `${'x'.repeat(MAX_PART_NAME_CHARS - 20)}.png`;
    const { notes, log } = noteList();
    const pkg = openPackage(
      new Map([
        ['a.xml', enc('<x/>')],
        [long, enc('')],
        [ok, enc('')],
        [
          '_rels/a.xml.rels',
          enc(
            rels(
              `<Relationship Id="r1" Type="${NS.r}/image" Target="${long}"/>` +
                `<Relationship Id="r2" Type="${NS.r}/image" Target="${ok}"/>`,
            ),
          ),
        ],
      ]),
      log,
    );
    expect(pkg.rels('a.xml').map((r) => r.id)).toEqual(['r2']);
    expect(notes[0]).toMatch(/too long/);
  });
});

describe('every part read as one dialect', () => {
  /** A deck using what the reader normalises: theme colours with modifiers, pictures, groups, decorations. */
  function deck(): PartSource {
    return buildDeck({
      master: {
        shapes: sp({
          id: 9,
          x: 0,
          y: 0,
          cx: IN,
          cy: IN,
          fill: solid(scheme('accent2', '<a:lumMod val="75000"/>')),
        }),
      },
      slides: [
        {
          bg: solidBg(scheme('accent1', '<a:lumMod val="50000"/><a:lumOff val="10000"/>')),
          rels: [imageRel('rId2', 'image1.png')],
          shapes:
            sp({
              id: 2,
              x: IN,
              y: IN,
              cx: 4 * IN,
              cy: IN,
              fill: '<a:noFill/>',
              txBody: body(
                para(run('Amazing grace', 'sz="4000"', solid(scheme('accent6', '<a:alpha val="60000"/>')))),
              ),
            }) +
            pic({ id: 3, x: 6 * IN, y: 0, cx: 2 * IN, cy: IN, rId: 'rId2' }) +
            grpSp(
              { id: 4, x: 0, y: 3 * IN, cx: 2 * IN, cy: 2 * IN, chX: 0, chY: 0, chCx: IN, chCy: IN },
              sp({ id: 5, x: 0, y: 0, cx: IN, cy: IN, geom: 'ellipse', fill: solid('336699') }),
            ),
        },
        { hidden: true, bg: solidBg('000000') },
      ],
    });
  }
  const emitted = (parts: PartSource) => {
    const scene = parseDeck(parts);
    for (const s of scene.slides) expect(s.error).toBeUndefined();
    return emitSlides(scene).slides.map((s) => ({ slide: s.slide, digest: s.digest, shown: s.shown }));
  };

  it('reads a Strict deck as its Transitional twin, percentages included', () => {
    const want = emitted(deck());
    const strict = mapXml(deck(), (name, xml) => {
      let s = xml
        .replaceAll(NS.p, 'http://purl.oclc.org/ooxml/presentationml/main')
        .replaceAll(NS.a, 'http://purl.oclc.org/ooxml/drawingml/main')
        .replaceAll(NS.r, 'http://purl.oclc.org/ooxml/officeDocument/relationships');
      if (/^ppt\/(slides|slideMasters|slideLayouts|theme)\/[^/]+\.xml$/.test(name))
        s = s.replace(
          /(<a:(?:lumMod|lumOff|alpha) val=")(\d+)"/g,
          (_m, pre: string, n: string) => `${pre}${Number(n) / 1000}%"`,
        );
      return s;
    });
    expect(new TextDecoder().decode(strict.get('ppt/slides/slide1.xml'))).toContain('val="50%"');
    expect(new TextDecoder().decode(strict.get('_rels/.rels'))).toContain('purl.oclc.org');
    const scene = parseDeck(strict);
    expect(scene.notes).toContain('Strict OOXML read as Transitional');
    expect(emitted(strict)).toEqual(want);
  });

  it('reads a deck with its own prefixes, or default namespaces, as one with the usual ones', () => {
    const want = emitted(deck());
    const own = mapXml(deck(), (name, xml) =>
      name.endsWith('.rels') || name.startsWith('[')
        ? xml
        : xml
            .replaceAll('xmlns:p=', 'xmlns:pml=')
            .replaceAll('<p:', '<pml:')
            .replaceAll('</p:', '</pml:')
            .replaceAll('xmlns:a=', 'xmlns:dml=')
            .replaceAll('<a:', '<dml:')
            .replaceAll('</a:', '</dml:')
            .replaceAll('xmlns:r=', 'xmlns:rel=')
            .replaceAll(' r:', ' rel:'),
    );
    expect(new TextDecoder().decode(own.get('ppt/presentation.xml'))).toContain(
      '<pml:sldId id="256" rel:id=',
    );
    expect(emitted(own)).toEqual(want);

    const dflt = mapXml(deck(), (name, xml) =>
      name.startsWith('ppt/slides/') && !name.endsWith('.rels')
        ? xml.replaceAll('xmlns:p=', 'xmlns=').replaceAll('<p:', '<').replaceAll('</p:', '</')
        : xml,
    );
    expect(emitted(dflt)).toEqual(want);
  });

  it('reads one branch of alternate content in the shape tree', () => {
    const MC = NS.mc;
    const ac = (requires: string, ns: string) =>
      `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:${requires}="${ns}" Requires="${requires}">` +
      sp({ id: 5, name: 'Choice', x: 0, y: 0, cx: IN, cy: IN, fill: solid('FF0000') }) +
      `</mc:Choice><mc:Fallback>${sp({ id: 6, name: 'Fallback', x: IN, y: 0, cx: IN, cy: IN, fill: solid('0000FF') })}</mc:Fallback></mc:AlternateContent>`;
    const scene = parseDeck(
      buildDeck({
        slides: [
          { shapes: ac('cx1', 'http://schemas.microsoft.com/office/drawing/2014/chartex') },
          { shapes: ac('am3d', 'http://schemas.microsoft.com/office/drawing/2017/model3d') },
          { shapes: ac('p14', NS.p14) },
          { shapes: ac('a14', NS.a14) },
        ],
      }),
    );
    expect(scene.slides.map((s) => s.elements.map((e) => e.name))).toEqual([
      ['Fallback'],
      ['Fallback'],
      ['Choice'],
      ['Choice'],
    ]);
    for (const s of scene.slides) expect(s.classification.reasons).toContain('altcontent');
    // An understood Choice is the only branch any module sees.
    const pkg = openPackage(buildDeck({ slides: [{ shapes: ac('p14', NS.p14) }] }));
    const tree = pkg.xml('ppt/slides/slide1.xml')!.children[0]!.children[0]!;
    const alt = tree.children.find((c) => c.name === 'mc:AlternateContent')!;
    expect(alt.children.map((c) => c.name)).toEqual(['mc:Choice']);
    expect(alt.children[0]!.children[0]!.name).toBe('p:sp');
  });
});

describe('hostile packages', () => {
  it('is not polluted by prototype names in part names, ids, types and attributes', () => {
    const parts = buildDeck({
      slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: solid('FF0000') }) }],
    });
    parts.set('__proto__', enc('<x/>'));
    parts.set('constructor', enc('<x/>'));
    parts.set(
      'ppt/slides/_rels/slide1.xml.rels',
      enc(
        rels(
          `<Relationship Id="rId1" Type="${NS.r}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
            `<Relationship Id="__proto__" Type="${NS.r}/__proto__" Target="/__proto__"/>` +
            `<Relationship Id="constructor" Type="${NS.r}/image" Target="../../constructor"/>`,
        ),
      ),
    );
    const slide = new TextDecoder()
      .decode(parts.get('ppt/slides/slide1.xml'))
      .replace('<p:sld ', `<p:sld __proto__="1" a:__proto__="2" xmlns:__proto__="${NS.p}" `);
    parts.set('ppt/slides/slide1.xml', enc(slide));
    const pkg = openPackage(parts);
    expect(pkg.rel('ppt/slides/slide1.xml', '__proto__')?.target).toBe('__proto__');
    expect(pkg.rel('ppt/slides/slide1.xml', 'constructor')?.target).toBe('constructor');
    expect(pkg.rel('ppt/slides/slide1.xml', 'toString')).toBeUndefined();
    expect(pkg.relOfType('ppt/slides/slide1.xml', '__proto__')?.id).toBe('__proto__');
    const root = pkg.xml('ppt/slides/slide1.xml')!;
    expect(Object.entries(root.attrs)).toContainEqual(['__proto__', '1']);
    expect(root.attrs['a:__proto__']).toBe('2');
    const scene = parseDeck(parts);
    expect(scene.slides[0]!.elements).toHaveLength(1);
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(({} as Record<string, unknown>)['1']).toBeUndefined();
  });

  it('follows cyclic relationships only as far as the slide, layout, master and theme', () => {
    const parts = buildDeck({ slides: [{}, {}] });
    // Slide 1 is its own layout; the layout's master is the layout; the master's theme is the master.
    parts.set(
      'ppt/slides/_rels/slide1.xml.rels',
      enc(rels(`<Relationship Id="rId1" Type="${NS.r}/slideLayout" Target="slide1.xml"/>`)),
    );
    parts.set(
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      enc(rels(`<Relationship Id="rId1" Type="${NS.r}/slideMaster" Target="slideLayout1.xml"/>`)),
    );
    parts.set(
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      enc(rels(`<Relationship Id="rId1" Type="${NS.r}/theme" Target="slideMaster1.xml"/>`)),
    );
    const { notes, log } = noteList();
    const scene = within(5000, () => parseDeck(parts, { log }));
    expect(scene.slides.map((s) => s.error)).toEqual([undefined, undefined]);
    expect(scene.slides[0]!.layoutPart).toBeUndefined();
    expect(scene.slides[1]!.layoutPart).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(scene.slides[1]!.masterPart).toBeUndefined();
    expect(notes).toContain('ppt/slides/slide1.xml is not a p:sldLayout part: not used');
  });

  it("parses a slide's layout, master and theme once when each is near the tag limit", () => {
    // design/27 §12: a slide reads its layout, master and theme; at the tag limit each is charged about
    // 70 MB, together more than the 192 MB the cache had, which then parsed all three again for every slide.
    const slides = 6;
    const built = buildDeck({ slides: Array.from({ length: slides }, () => ({})) });
    const junk = (n: number) => `<p:extLst><p:ext uri="x">${'<a:y/>'.repeat(n)}</p:ext></p:extLst>`;
    const shared = {
      layout: 'ppt/slideLayouts/slideLayout1.xml',
      master: 'ppt/slideMasters/slideMaster1.xml',
      theme: 'ppt/theme/theme1.xml',
    };
    const parts = new CountingSource(
      mapXml(built, (name, xml) => {
        if (name === shared.layout || name === shared.master)
          return xml.replace('</p:cSld>', `</p:cSld>${junk(235_000)}`);
        if (name === shared.theme)
          return xml.replace(
            '</a:theme>',
            `<a:extLst><a:ext uri="x">${'<a:y/>'.repeat(235_000)}</a:ext></a:extLst></a:theme>`,
          );
        return xml;
      }),
    );
    const scene = within(5000, () => parseDeck(parts));
    expect(scene.slides.map((s) => s.error)).toEqual(new Array(slides).fill(undefined));
    expect(scene.slides.every((s) => s.layoutPart === shared.layout && s.masterPart === shared.master)).toBe(
      true,
    );
    for (const part of Object.values(shared)) expect(parts.reads.get(part)).toBe(1);
    // Each slide's relationships were read once, for that slide.
    expect(parts.reads.get('ppt/slides/_rels/slide1.xml.rels')).toBe(1);
  });

  it('finds the one relationship a slide needs among 150,000 others without reading them again', () => {
    const pad = Array.from(
      { length: 150_000 },
      (_, k) => `<Relationship Id="j${k}" Type="x" Target="z"/>`,
    ).join('');
    // Each slide asks its layout for its master and the master for its theme: once a scan of 150,000 each.
    const parts = mapXml(buildDeck({ slides: Array.from({ length: 1_000 }, () => ({})) }), (name, xml) =>
      name.includes('slideLayout1.xml.rels') || name.includes('slideMaster1.xml.rels')
        ? xml.replace(/(<Relationships[^>]*>)/, `$1${pad}`)
        : xml,
    );
    const scene = within(5000, () => parseDeck(parts));
    expect(scene.slides.every((s) => s.masterPart === 'ppt/slideMasters/slideMaster1.xml')).toBe(true);
  });

  it('copes with 10,000 media parts and relationships', () => {
    const n = 10_000;
    const parts = buildDeck({ slides: [{}] });
    const list = [
      `<Relationship Id="rId1" Type="${NS.r}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    ];
    for (let i = 0; i < n; i++) {
      parts.set(`ppt/media/image${i}.png`, new Uint8Array(0));
      list.push(`<Relationship Id="rId${i + 2}" Type="${NS.r}/image" Target="../media/image${i}.png"/>`);
    }
    parts.set('ppt/slides/_rels/slide1.xml.rels', enc(rels(list.join(''))));
    const scene = within(5000, () => {
      const pkg = openPackage(parts);
      expect(pkg.rels('ppt/slides/slide1.xml')).toHaveLength(n + 1);
      expect(pkg.rel('ppt/slides/slide1.xml', `rId${n + 1}`)?.target).toBe(`ppt/media/image${n - 1}.png`);
      return parseDeck(parts);
    });
    expect(scene.slides[0]!.error).toBeUndefined();
  });

  it('quarantines a part with a DOCTYPE, an entity bomb or too much depth, never the deck', () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;">]><p:sld>&lol1;</p:sld>';
    const parts = buildDeck({ slides: [{}, {}, {}] });
    parts.set('ppt/slides/slide1.xml', enc(bomb));
    const deep = `<p:sld xmlns:p="${NS.p}"><p:cSld><p:spTree>${'<p:grpSp>'.repeat(20_000)}${'</p:grpSp>'.repeat(20_000)}</p:spTree></p:cSld></p:sld>`;
    parts.set('ppt/slides/slide2.xml', enc(deep));
    parts.set('ppt/slides/slide3.xml', new Uint8Array(9 * 1024 * 1024).fill(0x20));
    const scene = within(5000, () => parseDeck(parts));
    expect(scene.slides).toHaveLength(3);
    expect(scene.slides[0]!.error).toMatch(/DOCTYPE/);
    expect(scene.slides[1]!.error).toBeUndefined();
    expect(scene.slides[2]!.error).toMatch(/8 MB/);
    // In the presentation part, the deck cannot be read at all: a clean error.
    const p = buildDeck({ slides: [{}] });
    p.set(
      'ppt/presentation.xml',
      enc(bomb.replace('p:sld', 'p:presentation').replace('</p:sld>', '</p:presentation>')),
    );
    expect(() => parseDeck(p)).toThrow(/DOCTYPE/);
  });

  it('keeps control characters in part names out of its notes', () => {
    const parts = buildDeck({ slides: [{}] });
    const bad = 'ppt/slideLayouts/x\u0007\n[warn] 12:00:00 forged.xml';
    parts.set(
      'ppt/slides/_rels/slide1.xml.rels',
      enc(rels(`<Relationship Id="rId1" Type="${NS.r}/slideLayout" Target="/${encodeURI(bad)}"/>`)),
    );
    parts.set(bad, enc('<!DOCTYPE x><x/>'));
    const { notes, log } = noteList();
    const scene = parseDeck(parts, { log });
    expect(scene.slides[0]!.error).toBeUndefined();
    const note = notes.find((n) => n.includes('forged'));
    expect(note).toBeDefined();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking they are gone
    expect(note).not.toMatch(/[\u0000-\u001f]/);
  });
});
