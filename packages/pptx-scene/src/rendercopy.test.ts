import { describe, expect, it } from 'vitest';
import { readDeck } from './deck.ts';
import { convertDeck } from './index.ts';
import { openPackage, type PartSource } from './opc.ts';
import {
  buildRenderCopy,
  metafileSize,
  RENDER_COPY_LIMITS,
  type RenderCopyPage,
  writeXml,
} from './rendercopy.ts';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  chartFrame,
  chartXml,
  imageRel,
  para,
  partText,
  pic,
  pictureBg,
  run,
  solid,
  sp,
  withPart,
} from './test-util.ts';
import { parseXml, rootOf } from './xml.ts';

const EMU = 914_400 / 2;
const text = (parts: Map<string, Uint8Array>, name: string) => partText(parts, name);

/** Every XML part of a copy parses with the package's own reader (no declaration, well formed). */
function parsesBack(parts: Map<string, Uint8Array>): void {
  for (const [name, bytes] of parts)
    if (/\.(xml|rels)$/.test(name)) {
      const xml = new TextDecoder().decode(bytes);
      expect(xml.startsWith('<?xml')).toBe(true);
      expect(rootOf(parseXml(xml, name))).toBeDefined();
    }
}

function chartDeck(): PartSource {
  const parts = buildDeck({
    slides: [
      { shapes: sp({ id: 2, x: 0, y: 0, cx: EMU, cy: EMU, txBody: body(para(run('One'))) }) },
      {
        bg: pictureBg('rId2'),
        rels: [imageRel('rId2', 'photo.png'), { id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }],
        shapes:
          sp({ id: 2, x: EMU, y: 0, cx: 10 * EMU, cy: EMU, txBody: body(para(run('Giving'))) }) +
          chartFrame({ id: 4, x: 2 * EMU, y: 2 * EMU, cx: 8 * EMU, cy: 6 * EMU, rId: 'rId3' }) +
          sp({ id: 7, x: 20 * EMU, y: 2 * EMU, cx: 2 * EMU, cy: 2 * EMU, fill: solid('0000FF') }),
      },
    ],
  });
  return withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
}

describe('buildRenderCopy: art pages', () => {
  it('prints only the art, twice, over forced white and black backgrounds', () => {
    const parts = chartDeck();
    const art = convertDeck(parts).slides[1]!.art!;
    const pages: RenderCopyPage[] = [
      { index: 1, mode: 'art', background: 'white', keep: art.elements },
      { index: 1, mode: 'art', background: 'black', keep: art.elements },
      { index: 1, mode: 'art', background: 'yellow', keep: art.elements },
    ];
    const copy = buildRenderCopy(parts, pages);
    expect(text(copy.parts, 'ppt/slides/slide3.xml')).toContain('<a:srgbClr val="FFFF00"/>');
    expect(copy.pages).toEqual(pages);
    expect(copy.slideSize).toEqual({ cx: 12_192_000, cy: 6_858_000 });
    parsesBack(copy.parts);
    const white = text(copy.parts, 'ppt/slides/slide1.xml');
    const black = text(copy.parts, 'ppt/slides/slide2.xml');
    for (const [xml, hex] of [
      [white, 'FFFFFF'],
      [black, '000000'],
    ] as const) {
      expect(xml).toContain('showMasterSp="0"');
      expect(xml).toContain(`<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex}"/>`);
      expect(xml).toContain('<p:cNvPr id="4"');
      expect(xml).not.toContain('<p:cNvPr id="2"');
      expect(xml).not.toContain('<p:cNvPr id="7"');
      expect(xml).not.toContain('blipFill'); // the picture background is never in the art
    }
    // The slide's relationships: its layout and the chart only (the photo is not printed).
    const rels = text(copy.parts, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toContain('relationships/slideLayout');
    expect(rels).toContain('relationships/chart');
    expect(rels).not.toContain('relationships/image');
    expect(copy.parts.has('ppt/charts/chart1.xml')).toBe(true);
    expect(text(copy.parts, 'ppt/charts/chart1.xml')).toContain('<c:barChart>');
    expect([...copy.parts.keys()].some((k) => k.startsWith('ppt/media/'))).toBe(false);
    // The copy is a deck: two pages, in order, none hidden.
    const deck = readDeck(openPackage(copy.parts));
    expect(deck.slides.map((s) => [s.part, s.hidden])).toEqual([
      ['ppt/slides/slide1.xml', false],
      ['ppt/slides/slide2.xml', false],
      ['ppt/slides/slide3.xml', false],
    ]);
    expect(text(copy.parts, '[Content_Types].xml')).toContain(
      '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>',
    );
  });

  it('copies a layout element of the art to the bottom of the page with its relationships', () => {
    const parts = buildDeck({
      layouts: [
        {
          rels: [imageRel('rId2', 'logo.png')],
          shapes: pic({ id: 10, x: 0, y: 0, cx: EMU, cy: EMU, rId: 'rId2' }),
        },
      ],
      slides: [
        {
          rels: [{ id: 'rId2', type: 'chart', target: '../charts/chart1.xml' }],
          shapes: chartFrame({ id: 4, x: 0, y: 0, cx: 4 * EMU, cy: 4 * EMU, rId: 'rId2' }),
        },
      ],
    });
    withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
    const keep = [
      { from: 'layout' as const, shapeId: 10, nth: 0 },
      { from: 'slide' as const, shapeId: 4, nth: 0 },
    ];
    const copy = buildRenderCopy(parts, [{ index: 0, mode: 'art', background: 'white', keep }]);
    expect(copy.notes).toEqual([]);
    const xml = text(copy.parts, 'ppt/slides/slide1.xml');
    // The logo first (bottom), its picture renamed into the slide's relationships, then the chart.
    expect(xml.indexOf('<p:cNvPr id="10"')).toBeLessThan(xml.indexOf('<p:cNvPr id="4"'));
    expect(xml).toContain('r:embed="rIdOrdoL1"');
    const rels = text(copy.parts, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toMatch(/Id="rIdOrdoL1" Type="[^"]*\/image" Target="\.\.\/media\/image1\.png"/);
    expect(rels).toMatch(/Id="rId2" Type="[^"]*\/chart"/);
    expect(copy.parts.get('ppt/media/image1.png')!.length).toBeGreaterThan(0);
  });

  it('notes art elements it cannot find', () => {
    const copy = buildRenderCopy(chartDeck(), [
      { index: 1, mode: 'art', background: 'white', keep: [{ from: 'slide', shapeId: 99, nth: 0 }] },
    ]);
    expect(copy.notes).toEqual(['slide 2: 1 art element(s) not found']);
  });
});

describe('buildRenderCopy: whole pages and page order', () => {
  it('lists exactly the pages asked, in that order, a hidden slide shown', () => {
    const box = (c: string) => sp({ id: 2, x: 0, y: 0, cx: EMU, cy: EMU, fill: solid(c) });
    const parts = buildDeck({
      slides: [{ shapes: box('FF0000') }, { hidden: true, shapes: box('00FF00') }, { shapes: box('0000FF') }],
    });
    const copy = buildRenderCopy(parts, [
      { index: 2, mode: 'whole' },
      { index: 1, mode: 'whole' },
      { index: 7, mode: 'whole' },
    ]);
    expect(copy.pages.map((p) => p.index)).toEqual([2, 1]);
    expect(copy.notes).toEqual(['slide 8 is not in the deck']);
    expect(text(copy.parts, 'ppt/slides/slide1.xml')).toContain('0000FF');
    const hidden = text(copy.parts, 'ppt/slides/slide2.xml');
    expect(hidden).toContain('00FF00');
    expect(hidden).not.toMatch(/show=/);
    const pres = text(copy.parts, 'ppt/presentation.xml');
    expect(pres.match(/<p:sldId /g)).toHaveLength(2);
    expect(readDeck(openPackage(copy.parts)).slides.every((s) => !s.hidden)).toBe(true);
  });

  it('keeps a picture-class slide whole, background included', () => {
    const copy = buildRenderCopy(chartDeck(), [{ index: 1, mode: 'whole' }]);
    const xml = text(copy.parts, 'ppt/slides/slide1.xml');
    expect(xml).toContain('<p:bg><p:bgPr><a:blipFill');
    for (const id of [2, 4, 7]) expect(xml).toContain(`<p:cNvPr id="${id}"`);
    expect(copy.parts.get('ppt/media/image1.png')!.length).toBeGreaterThan(0);
    expect(text(copy.parts, '[Content_Types].xml')).toContain(
      '<Override PartName="/ppt/media/image1.png" ContentType="image/png"/>',
    );
  });

  it('hands spilled pictures back by name instead of bytes', () => {
    const parts = chartDeck();
    parts.set('ppt/media/photo.png', new Uint8Array(0)); // spilled to disk
    const copy = buildRenderCopy(parts, [{ index: 1, mode: 'whole' }]);
    expect(copy.media).toEqual([['ppt/media/image1.png', 'ppt/media/photo.png']]);
    expect(copy.parts.has('ppt/media/image1.png')).toBe(false);
  });
});

describe('buildRenderCopy: what never reaches LibreOffice', () => {
  const video =
    '<p:pic><p:nvPicPr><p:cNvPr id="9" name="Video"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rId5"/>' +
    '<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId6"/></p:ext></p:extLst>' +
    '</p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
  const ole =
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="11" name="Object"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">' +
    '<p:oleObj r:id="rId7" progId="Excel.Sheet.12"><p:embed/><p:pic><p:nvPicPr><p:cNvPr id="0" name=""/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId8"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr/></p:pic></p:oleObj></a:graphicData></a:graphic></p:graphicFrame>';
  const link =
    '<p:sp><p:nvSpPr><p:cNvPr id="12" name="Link"><a:hlinkClick r:id="rId9"/></p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr>' +
    `${body(para(run('Visit')))}</p:sp>`;

  function hostileDeck(): PartSource {
    const parts = buildDeck({
      slides: [
        {
          rels: [
            imageRel('rId2', 'poster.png'),
            { id: 'rId5', type: 'video', target: '../media/clip.mp4' },
            { id: 'rId6', type: 'media', target: '../media/clip.mp4' },
            { id: 'rId7', type: 'oleObject', target: '../embeddings/oleObject1.bin' },
            imageRel('rId8', 'preview.emf'),
            { id: 'rId9', type: 'hyperlink', target: 'https://tracker.example/x', external: true },
            { id: 'rId10', type: 'image', target: 'https://tracker.example/pixel.png', external: true },
          ],
          shapes: video + ole + link,
          after:
            '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition><p:fade/></p:transition><p:timing><p:tnLst/></p:timing>',
        },
      ],
      media: {
        'ppt/media/clip.mp4': new Uint8Array([0, 0, 0, 24]),
        'ppt/media/preview.emf': new Uint8Array(64),
      },
    });
    parts.set('ppt/embeddings/oleObject1.bin', new Uint8Array([0xd0, 0xcf]));
    parts.set('ppt/vbaProject.bin', new Uint8Array([1, 2, 3]));
    const presRels = text(parts, 'ppt/_rels/presentation.xml.rels').replace(
      '</Relationships>',
      '<Relationship Id="rId99" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
    );
    parts.set('ppt/_rels/presentation.xml.rels', new TextEncoder().encode(presRels));
    return parts;
  }

  it('drops External targets, macros, OLE binaries, clips, timing and transitions', () => {
    const copy = buildRenderCopy(hostileDeck(), [{ index: 0, mode: 'whole' }]);
    parsesBack(copy.parts);
    const all = [...copy.parts.values()].map((b) => new TextDecoder().decode(b)).join('\n');
    expect(all).not.toMatch(/External|tracker\.example|vbaProject|oleObject|\/video"|\/media"/);
    expect([...copy.parts.keys()].filter((k) => /\.(bin|mp4)$/.test(k))).toEqual([]);
    const xml = text(copy.parts, 'ppt/slides/slide1.xml');
    expect(xml).not.toMatch(/videoFile|p14:media|p:timing|p:transition/);
    // The poster and the OLE preview picture stay.
    const rels = text(copy.parts, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toMatch(/Id="rId2" Type="[^"]*\/image"/);
    expect(rels).toMatch(/Id="rId8" Type="[^"]*\/image"/);
    expect(xml).toContain('progId="Excel.Sheet.12"');
  });

  it('strips the outline of filled text, keeps it on hollow text, and freezes fields', () => {
    const outlined = `<a:ln w="25400">${solid('000000')}</a:ln>`;
    const parts = buildDeck({
      master: {
        txStyles: `<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400">${outlined}${solid('FFFFFF')}</a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle/><p:otherStyle/>`,
      },
      slides: [
        {
          shapes: sp({
            id: 2,
            x: 0,
            y: 0,
            cx: 4 * EMU,
            cy: EMU,
            txBody: body(
              para(
                run('Filled', '', `${outlined}${solid('FFFFFF')}`) +
                  run('Hollow', '', `${outlined}<a:noFill/>`),
              ) + para('<a:fld id="{1}" type="slidenum"><a:rPr lang="en-US"/><a:pPr/><a:t>12</a:t></a:fld>'),
            ),
          }),
        },
      ],
    });
    const copy = buildRenderCopy(parts, [{ index: 0, mode: 'whole' }]);
    expect(copy.outlines).toBe(2);
    const xml = text(copy.parts, 'ppt/slides/slide1.xml');
    expect(xml.match(/<a:ln /g)).toHaveLength(1); // the hollow run's
    expect(xml).toContain('<a:r><a:rPr lang="en-US"/><a:t>12</a:t></a:r>');
    expect(xml).not.toContain('a:fld');
    expect(text(copy.parts, 'ppt/slideMasters/slideMaster1.xml')).not.toContain('<a:ln ');
  });
});

describe('buildRenderCopy: picture pages', () => {
  function emf(w: number, h: number): Uint8Array {
    const b = new Uint8Array(88);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 1, true);
    dv.setUint32(4, 88, true);
    dv.setInt32(24, 0, true);
    dv.setInt32(28, 0, true);
    dv.setInt32(32, w, true);
    dv.setInt32(36, h, true);
    dv.setUint32(40, 0x464d4520, true);
    return b;
  }

  it('places a metafile alone, contain-fitted at its own aspect, and says where', () => {
    const parts = buildDeck({ slides: [{}], media: { 'ppt/media/chart.emf': emf(20_000, 10_000) } });
    const pages: RenderCopyPage[] = [
      { index: 0, mode: 'picture', part: 'ppt/media/chart.emf', background: 'white' },
      { index: 0, mode: 'picture', part: 'ppt/media/chart.emf', background: 'black' },
    ];
    const copy = buildRenderCopy(parts, pages);
    expect(copy.pages).toEqual(
      pages.map((p) => ({ ...p, rect: { x: 0, y: 381_000, cx: 12_192_000, cy: 6_096_000 } })),
    );
    const xml = text(copy.parts, 'ppt/slides/slide2.xml');
    expect(xml).toContain('<a:srgbClr val="000000"/>');
    expect(xml).toContain('<a:off x="0" y="381000"/><a:ext cx="12192000" cy="6096000"/>');
    expect(text(copy.parts, 'ppt/slides/_rels/slide2.xml.rels')).toContain('Target="../media/image1.emf"');
    expect(text(copy.parts, '[Content_Types].xml')).toContain('ContentType="image/x-emf"');
  });

  it('reads EMF and placeable WMF sizes', () => {
    expect(metafileSize(emf(300, 200))).toEqual({ w: 300, h: 200 });
    const wmf = new Uint8Array(22);
    const dv = new DataView(wmf.buffer);
    dv.setUint32(0, 0x9ac6cdd7, true);
    dv.setInt16(6, -100, true);
    dv.setInt16(8, 0, true);
    dv.setInt16(10, 500, true);
    dv.setInt16(12, 300, true);
    expect(metafileSize(wmf)).toEqual({ w: 600, h: 300 });
    expect(metafileSize(new Uint8Array(64))).toBeUndefined();
  });
});

describe('writeXml', () => {
  const root = (xml: string) => rootOf(parseXml(xml, 'x'))!;

  it('declares the usual namespaces once and leaves out what LibreOffice would refuse', () => {
    const xml = writeXml(
      root(
        '<p:sld xmlns:p="urn:other" xmlns:x="urn:x" xmlns:constructor="urn:c"><x:a/><constructor:b/><nope:c/>' +
          '<p:d nope:attr="1" ok="&#1;v&amp;&lt;"/></p:sld>',
      ),
    );
    expect(xml).toContain('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"');
    expect(xml).not.toContain('urn:other');
    expect(xml).toContain('xmlns:constructor="urn:c"');
    expect(xml).toContain('<x:a/><constructor:b/><p:d ok="v&amp;&lt;"/>');
    expect(xml).not.toContain('nope');
  });

  it('refuses a copy past its page budget', () => {
    const pages = Array.from({ length: RENDER_COPY_LIMITS.pages + 1 }, () => ({
      index: 0,
      mode: 'whole' as const,
    }));
    expect(() => buildRenderCopy(buildDeck({ slides: [{}] }), pages)).toThrow(/more than 4000 pages/);
  });
});
