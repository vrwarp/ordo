import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractPptxText, pptxForRendering } from './pptx.ts';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const sp = (inner: string, xfrm?: string, ph?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr>${ph ?? ''}</p:nvPr></p:nvSpPr>` +
  `<p:spPr>${xfrm ?? ''}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${inner}</p:txBody></p:sp>`;
const xf = (x: number, y: number, cx: number, cy: number) =>
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const slide = (shapes: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`;
const rels = (items: [string, string, string][]) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, t]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${t}"/>`)
    .join('')}</Relationships>`;

async function makePptx(): Promise<Uint8Array> {
  const zip = new JSZip();
  // 16:9 at 12192000 x 6858000 EMU (13.333 in x 7.5 in).
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels([
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'slide', 'slides/slide2.xml'],
    ]),
  );
  zip.file(
    'ppt/slides/slide1.xml',
    slide(
      sp(
        '<a:p><a:r><a:rPr lang="en" sz="4400"/><a:t>Hello &amp; welcome</a:t></a:r><a:br/><a:r><a:t>to church</a:t></a:r></a:p><a:p><a:r><a:t>Second para</a:t></a:r></a:p>',
        xf(609600, 342900, 10972800, 1143000),
      ) +
        sp('<a:p><a:r><a:t>From layout</a:t></a:r></a:p>', undefined, '<p:ph type="body" idx="1"/>') +
        sp('<a:p><a:endParaRPr sz="2000"/></a:p>', xf(0, 0, 100, 100)) +
        `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="6096000" y="3429000"/><a:ext cx="3048000" cy="1714500"/><a:chOff x="0" y="0"/><a:chExt cx="6096000" cy="3429000"/></a:xfrm></p:grpSpPr>` +
        sp('<a:p><a:r><a:t>Grouped</a:t></a:r></a:p>', xf(0, 0, 6096000, 3429000)) +
        `</p:grpSp>`,
    ),
  );
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout2.xml']]),
  );
  zip.file(
    'ppt/slides/slide2.xml',
    slide(sp('<a:p><a:r><a:t>Title from master</a:t></a:r></a:p>', undefined, '<p:ph type="ctrTitle"/>')),
  );
  zip.file(
    'ppt/slides/_rels/slide2.xml.rels',
    rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout2.xml']]),
  );
  zip.file(
    'ppt/slideLayouts/slideLayout2.xml',
    `<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld><p:spTree>${sp('', xf(838200, 1825625, 10515600, 4351338), '<p:ph idx="1"/>')}</p:spTree></p:cSld></p:sldLayout>`,
  );
  zip.file(
    'ppt/slideLayouts/_rels/slideLayout2.xml.rels',
    rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
  );
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    `<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld><p:spTree>${sp('', xf(838200, 365125, 10515600, 1325563), '<p:ph type="title"/>')}</p:spTree></p:cSld></p:sldMaster>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}

describe('extractPptxText', () => {
  it('extracts text boxes in slide order with scaled geometry', async () => {
    const res = await extractPptxText(await makePptx());
    expect(res.slideSize).toEqual({ cx: 12192000, cy: 6858000 });
    expect(res.slides.map((s) => s.index)).toEqual([1, 2]);
    // Slide order follows sldIdLst: slide2.xml comes first.
    expect(res.slides[0]!.boxes).toEqual([
      { text: 'Title from master', box: { x: 132, y: 57.5, w: 1656, h: 208.75, rotation: 0 } },
    ]);
    const b = res.slides[1]!.boxes;
    expect(b.map((x) => x.text)).toEqual([
      'Hello & welcome\nto church\nSecond para',
      'From layout',
      'Grouped',
    ]);
    expect(b[0]!.box).toEqual({ x: 96, y: 54, w: 1728, h: 180, rotation: 0 });
    // 44 pt on a 7.5 in tall slide: 44 * 12700 * 1080 / 6858000 = 88 px.
    expect(b[0]!.fontSizePx).toBe(88);
    expect(b[1]!.box).toEqual({ x: 132, y: 287.5, w: 1656, h: 685.25, rotation: 0 });
    // Child extents are halved by the group transform and offset to the slide centre.
    expect(b[2]!.box).toEqual({ x: 960, y: 540, w: 480, h: 270, rotation: 0 });
  });

  it('rejects files that are not presentations', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<x/>');
    await expect(extractPptxText(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow();
  });
});

describe('pptxForRendering', () => {
  const run = (fill: string, text: string) =>
    `<a:r><a:rPr lang="en-US" sz="2800" b="1"><a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>${fill}</a:rPr><a:t>${text}</a:t></a:r>`;
  const slide = (body: string) =>
    `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p>${body}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

  it('drops the outline of filled text (LibreOffice draws it hollow), keeps hollow text as it is', async () => {
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      slide(
        run('<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>', 'Main Idea') +
          run('<a:noFill/>', 'Hollow on purpose'),
      ),
    );
    zip.file('ppt/media/image1.png', new Uint8Array([1, 2, 3]));
    const r = await pptxForRendering(await zip.generateAsync({ type: 'uint8array' }));
    expect(r.outlines).toBe(1);
    const out = await JSZip.loadAsync(r.bytes);
    const xml = await out.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain(
      '<a:rPr lang="en-US" sz="2800" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Main Idea',
    );
    expect(xml).toContain('<a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln><a:noFill/>');
    expect([...(await out.file('ppt/media/image1.png')!.async('uint8array'))]).toEqual([1, 2, 3]);
  });

  it('returns the input untouched when no text has an outline', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', slide('<a:r><a:rPr sz="2800"/><a:t>Plain</a:t></a:r>'));
    const buf = await zip.generateAsync({ type: 'uint8array' });
    const r = await pptxForRendering(buf);
    expect(r).toEqual({ bytes: buf, outlines: 0 });
    expect(r.bytes).toBe(buf);
  });
});
