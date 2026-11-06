import { crc32, deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  annotatePptx,
  completeGroupTransforms,
  pictureSize,
  placeOrphanPlaceholders,
  withPlaceholderColor,
  autoNumber,
  moveGroupOrigins,
  placeSlides,
  previewOrder,
  strictToTransitional,
  stripColorProfiles,
  withoutIccp,
  withoutJpegIcc,
} from './annotate.ts';
import { decodeMarker, encodeMarker, MARK_START, MAX_MARKED_RUNS } from './markers.ts';
import { parseXml, rootOf } from './xml.ts';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (type: string, target: string) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/${type}" Target="${target}"/></Relationships>`;
const run = (text: string, rPr = '') =>
  `<a:r><a:rPr lang="en-US"${rPr ? `>${rPr}</a:rPr>` : '/>'}<a:t>${text}</a:t></a:r>`;
const sp = (opts: { ph?: string; spPr?: string; style?: string; body: string; lstStyle?: string }) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr>${opts.ph ?? ''}</p:nvPr></p:nvSpPr>` +
  `<p:spPr>${opts.spPr ?? ''}</p:spPr>${opts.style ?? ''}<p:txBody><a:bodyPr/><a:lstStyle>${opts.lstStyle ?? ''}</a:lstStyle>${opts.body}</p:txBody></p:sp>`;
const shadow = (dist: number, dir: number, color = '<a:srgbClr val="000000"/>') =>
  `<a:effectLst><a:outerShdw blurRad="25400" dist="${dist}" dir="${dir}">${color}</a:outerShdw></a:effectLst>`;

async function deck(slideBody: string, extra: Record<string, string | Uint8Array> = {}): Promise<Uint8Array> {
  const z = new JSZip();
  z.file(
    'ppt/presentation.xml',
    `<?xml version="1.0"?><p:presentation ${NS}><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
  );
  z.file(
    'ppt/theme/theme1.xml',
    `<?xml version="1.0"?><a:theme ${NS}><a:themeElements>` +
      '<a:clrScheme name="t"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme>' +
      '<a:fontScheme name="t"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface=""/></a:majorFont>' +
      '<a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="SimSun"/></a:minorFont></a:fontScheme>' +
      '<a:fmtScheme name="t"><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
      '<a:effectStyle><a:effectLst><a:outerShdw blurRad="12700" dist="12700" dir="5400000"><a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>' +
      '</a:effectStyleLst></a:fmtScheme></a:themeElements></a:theme>',
  );
  z.file(
    'ppt/slideMasters/slideMaster1.xml',
    `<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld><p:spTree>` +
      sp({ ph: '<p:ph type="title"/>', body: '<a:p><a:endParaRPr/></a:p>' }) +
      `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/>` +
      '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
      '<p:bodyStyle><a:lvl1pPr><a:defRPr><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:bodyStyle>' +
      '<p:otherStyle><a:lvl1pPr><a:defRPr><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>',
  );
  z.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels('theme', '../theme/theme1.xml'));
  z.file(
    'ppt/slideLayouts/slideLayout1.xml',
    `<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld><p:spTree>` +
      sp({
        ph: '<p:ph idx="1"/>',
        lstStyle: '<a:lvl1pPr><a:defRPr><a:latin typeface="Tahoma"/></a:defRPr></a:lvl1pPr>',
        body: '<a:p><a:endParaRPr/></a:p>',
      }) +
      // Every placeholder a slide has is on its layout: pptx-preview draws no slide when one is not.
      sp({ ph: '<p:ph type="title"/>', body: '<a:p><a:endParaRPr/></a:p>' }) +
      '</p:spTree></p:cSld></p:sldLayout>',
  );
  z.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    rels('slideMaster', '../slideMasters/slideMaster1.xml'),
  );
  z.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${slideBody}</p:spTree></p:cSld></p:sld>`,
  );
  z.file('ppt/slides/_rels/slide1.xml.rels', rels('slideLayout', '../slideLayouts/slideLayout1.xml'));
  for (const [k, v] of Object.entries(extra)) z.file(k, v);
  return z.generateAsync({ type: 'uint8array' });
}

/** A content-types part listing these slides (`slide1`...). */
const types = (slides: string[]) =>
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  slides
    .map(
      (n) =>
        `<Override PartName="/ppt/slides/${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join('') +
  '</Types>';

/** A real PNG of w x h grey pixels, with a resolution (pixels per inch) when one is given. */
function png(w: number, h: number, dpi?: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    Buffer.from(data).copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(Math.round((dpi ?? 0) / 0.0254), 0);
  phys.writeUInt32BE(Math.round((dpi ?? 0) / 0.0254), 4);
  phys[8] = 1;
  const rows = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) rows[y * (w + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(dpi ? [chunk('pHYs', phys)] : []),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** The marked text runs of slide 1 with their styles, in document order. */
async function marked(bytes: Uint8Array, runs: unknown[]): Promise<[string, unknown][]> {
  const xml = await (await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml')!.async('string');
  const out: [string, unknown][] = [];
  for (const m of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)) {
    const text = m[1]!;
    const id = decodeMarker(text);
    const st = id === undefined ? undefined : { ...(runs[id] as Record<string, unknown>) };
    if (st) {
      delete st.p;
      delete st.b;
      if (st.size === 18) delete st.size;
    }
    out.push([text.slice(id === undefined ? 0 : 9), st]);
  }
  return out;
}

describe('markers', () => {
  it('round-trip every id and are invisible format characters', () => {
    for (const id of [0, 1, 3, 4, 255, 4096, MAX_MARKED_RUNS - 1]) {
      const m = encodeMarker(id);
      expect(m).toHaveLength(9);
      expect(m.startsWith(MARK_START)).toBe(true);
      expect(/^[⁠-⁤]+$/.test(m)).toBe(true);
      expect(decodeMarker(`x${m}y`, 1)).toBe(id);
    }
    expect(() => encodeMarker(MAX_MARKED_RUNS)).toThrow();
    expect(decodeMarker('plain')).toBeUndefined();
    expect(decodeMarker(`${MARK_START}⁠x`)).toBeUndefined();
  });
});

describe('annotatePptx', () => {
  it('resolves typefaces through the run, layout placeholder, master text styles and theme', async () => {
    const body =
      sp({ ph: '<p:ph type="title"/>', body: `<a:p>${run('Title')}</a:p>` }) +
      sp({ ph: '<p:ph idx="1"/>', body: `<a:p>${run('From the layout')}</a:p>` }) +
      sp({
        body: `<a:p>${run('Explicit', '<a:latin typeface="Century Gothic"/><a:ea typeface="PMingLiU"/>')}</a:p>`,
      }) +
      sp({ body: `<a:p>${run('Theme reference', '<a:latin typeface="+mj-lt"/>')}</a:p>` });
    const a = await annotatePptx(await deck(body));
    expect(a.notes).toEqual([]);
    expect(await marked(a.bytes, a.runs)).toEqual([
      ['Title', { latin: 'Aptos Display' }],
      // The layout's placeholder sets the Latin face; the East Asian one still comes from the master.
      ['From the layout', { latin: 'Tahoma', ea: 'SimSun' }],
      ['Explicit', { latin: 'Century Gothic', ea: 'PMingLiU' }],
      // A shape that is not a placeholder takes the master's other style: the theme's body fonts.
      ['Theme reference', { latin: 'Aptos Display', ea: 'SimSun' }],
    ]);
    expect(a.families).toEqual(['Aptos Display', 'Century Gothic', 'PMingLiU', 'SimSun', 'Tahoma']);
    expect(a.slideWidthPt).toBe(960);
    expect(a.slideHeightPt).toBe(540);
  });

  it('carries superscripts, a shadow on the text of an unfilled shape, and theme shadows', async () => {
    const body =
      sp({
        spPr: `<a:noFill/>${shadow(50800, 2700000)}`,
        body: `<a:p>${run('18', '')}${run('Now', '')}</a:p>`.replace(
          '<a:rPr lang="en-US"/>',
          '<a:rPr lang="en-US" baseline="30000"/>',
        ),
      }) +
      sp({
        spPr: `<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>${shadow(50800, 2700000)}`,
        body: `<a:p>${run('Boxed')}</a:p>`,
      }) +
      sp({ style: '<p:style><a:effectRef idx="2"/></p:style>', body: `<a:p>${run('Themed')}</a:p>` }) +
      sp({
        body: `<a:p>${run('Own', `${shadow(12700, 0, '<a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr>')}`)}</a:p>`,
      }) +
      sp({
        spPr: `<a:noFill/>${shadow(50800, 2700000)}`,
        body: `<a:p>${run('Both', shadow(12700, 0))}</a:p>`,
      });
    const a = await annotatePptx(await deck(body));
    const runs = await marked(a.bytes, a.runs);
    const by = Object.fromEntries(runs) as Record<string, { baseline?: number; shadows?: unknown[] }>;
    expect(by['18']!.baseline).toBe(30000);
    expect(by.Now!.baseline).toBeUndefined();
    // 50800 EMU at 45 degrees: 4 pt down and right; 25400 EMU of blur is 2 pt.
    const cast = { dx: 2.83, dy: 2.83, blur: 2, color: 'rgba(0,0,0,1)' };
    expect(by['18']!.shadows).toEqual([cast]);
    expect(by.Boxed!.shadows).toBeUndefined();
    expect(by.Themed!.shadows).toEqual([{ dx: 0, dy: 1, blur: 1, color: 'rgba(0,0,0,0.5)' }]);
    // A run's own shadow; accent1 (#4472C4) at half luminance.
    expect(by.Own!.shadows).toEqual([{ dx: 1, dy: 0, blur: 2, color: 'rgba(32,56,100,1)' }]);
    // The run's own shadow on top of the one its unfilled shape casts.
    expect(by.Both!.shadows).toEqual([{ dx: 1, dy: 0, blur: 2, color: 'rgba(0,0,0,1)' }, cast]);
  });

  it('marks table cells and fields, and leaves empty runs, layouts and masters consistent', async () => {
    const table =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr h="100"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/>' +
      `<a:p>${run('Cell')}</a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const body =
      table +
      sp({
        body: '<a:p><a:fld id="{1}" type="slidenum"><a:rPr lang="en-US"/><a:t>7</a:t></a:fld><a:r><a:rPr/><a:t/></a:r></a:p>',
      });
    const a = await annotatePptx(await deck(body));
    expect(await marked(a.bytes, a.runs)).toEqual([
      ['Cell', { latin: 'Aptos', ea: 'SimSun' }],
      ['7', { latin: 'Aptos', ea: 'SimSun' }],
    ]);
    const xml = await (await JSZip.loadAsync(a.bytes)).file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('<a:t/>');
  });

  it('gives table cell paragraphs their cell margins, with the defaults', async () => {
    const cell = (tcPr: string, text: string) =>
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(text)}</a:p></a:txBody>${tcPr}</a:tc>`;
    const body =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr h="100">' +
      cell('<a:tcPr marL="68580" marR="12700" marT="0" marB="0" anchor="ctr"/>', 'Own') +
      cell('<a:tcPr/>', 'Default') +
      `</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>${sp({ body: `<a:p>${run('Box')}</a:p>` })}`;
    const a = await annotatePptx(await deck(body));
    const xml = await (await JSZip.loadAsync(a.bytes)).file('ppt/slides/slide1.xml')!.async('string');
    const cells: Record<string, unknown> = {};
    for (const t of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g))
      cells[t[1]!.slice(9)] = a.paras[a.runs[decodeMarker(t[1]!)!]!.p!]!.cell;
    expect(cells).toEqual({ Own: [5.4, 0, 1, 0], Default: [7.2, 3.6, 7.2, 3.6], Box: undefined });
  });

  it('resolves line spacing and text box margins with their inheritance and defaults', async () => {
    const body =
      // Layout placeholder idx 1 sets nothing for spacing; the master body style says 90 %.
      sp({ ph: '<p:ph idx="1"/>', body: `<a:p>${run('Inherited')}</a:p>` }) +
      sp({
        spPr: '',
        body:
          '<a:bodyPr lIns="0" tIns="12700"><a:normAutofit fontScale="92500" lnSpcReduction="10000"/></a:bodyPr>' +
          `<a:p><a:pPr><a:lnSpc><a:spcPct val="150000"/></a:lnSpc><a:spcBef><a:spcPct val="50000"/></a:spcBef></a:pPr>${run('Shrunk', '')}</a:p>`.replace(
            '<a:rPr lang="en-US"/>',
            '<a:rPr lang="en-US" sz="4400" spc="-50"/>',
          ) +
          `<a:p><a:pPr><a:lnSpc><a:spcPts val="3600"/></a:lnSpc></a:pPr>${run('Exact')}</a:p>` +
          '<a:p><a:endParaRPr lang="en-US" sz="2000"/></a:p>',
      }).replace('<p:txBody><a:bodyPr/>', '<p:txBody>');
    const z = await JSZip.loadAsync(await deck(body));
    const master = await z.file('ppt/slideMasters/slideMaster1.xml')!.async('string');
    z.file(
      'ppt/slideMasters/slideMaster1.xml',
      master
        .replace(
          '<p:bodyStyle><a:lvl1pPr>',
          '<p:bodyStyle><a:lvl1pPr><a:lnSpc><a:spcPct val="90000"/></a:lnSpc>',
        )
        .replace(
          '<a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:defRPr>',
          '<a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:defRPr sz="3200">',
        ),
    );
    const a = await annotatePptx(await z.generateAsync({ type: 'uint8array' }));
    const xml = await (await JSZip.loadAsync(a.bytes)).file('ppt/slides/slide1.xml')!.async('string');
    const by: Record<string, { p?: number; b?: number; size?: number; spc?: number }> = {};
    for (const m of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)) by[m[1]!.slice(9)] = a.runs[decodeMarker(m[1]!)!]!;
    const para = (i: number) => {
      const { end: _end, align: _align, bullet: _bullet, ...rest } = a.paras[i]!;
      return rest;
    };
    expect(para(by.Inherited!.p!)).toEqual({ lnSpcPct: 90_000 });
    // The stored shrink to fit stays with the box: the page re-fits the text with the fonts it has.
    expect(para(by.Shrunk!.p!)).toEqual({ lnSpcPct: 150_000, spcBef: { em: 0.5 } });
    expect(para(by.Exact!.p!)).toEqual({ lnSpcPt: 36 });
    // Sizes: the master's body style for the placeholder, the run's own, the default of 18 pt elsewhere.
    expect(by.Inherited!.size).toBe(32);
    expect(by.Shrunk).toMatchObject({ size: 44, spc: -0.5 });
    expect(by.Exact!.size).toBe(18);
    // PowerPoint's defaults (7.2 pt left and right, 3.6 pt top and bottom) where nothing is said.
    const inherited = a.bodies[by.Inherited!.b!]!;
    expect(inherited).toEqual({ insets: [7.2, 3.6, 7.2, 3.6], anchor: 't', paras: [by.Inherited!.p] });
    const shrunk = a.bodies[by.Shrunk!.b!]!;
    expect(shrunk).toMatchObject({ insets: [0, 1, 7.2, 3.6], anchor: 't' });
    expect(shrunk.autofit).toEqual({ fontScale: 0.925, lnSpcReduction: 0.1 });
    // Every paragraph of the box, the empty one too; its height comes from its end mark.
    expect(shrunk.paras).toHaveLength(3);
    expect(a.paras[shrunk.paras[2]!]!.end?.size).toBe(20);
  });

  it('resolves paragraph alignment through the list styles, justified included, left by default', async () => {
    const body =
      sp({ body: `<a:p><a:pPr algn="just"/>${run('Justified')}</a:p>` }) +
      sp({ lstStyle: '<a:lvl1pPr algn="ctr"/>', body: `<a:p>${run('Centred')}</a:p>` }) +
      sp({ body: `<a:p>${run('Plain')}</a:p>` });
    const a = await annotatePptx(await deck(body));
    const xml = await (await JSZip.loadAsync(a.bytes)).file('ppt/slides/slide1.xml')!.async('string');
    const align: Record<string, unknown> = {};
    for (const t of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g))
      align[t[1]!.slice(9)] = a.paras[a.runs[decodeMarker(t[1]!)!]!.p!]!.align;
    expect(align).toEqual({ Justified: 'just', Centred: 'ctr', Plain: 'l' });
  });

  it('carries gradient text, colours from list styles and boxes whose lines do not wrap', async () => {
    const stops =
      '<a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst>';
    const linear = `<a:gradFill>${stops}<a:lin ang="5400000" scaled="0"/></a:gradFill>`;
    const radial = `<a:gradFill>${stops}<a:path path="circle"><a:fillToRect l="100000" t="0" r="0" b="100000"/></a:path></a:gradFill>`;
    const solid = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
    const body =
      sp({ body: `<a:p>${run('Linear', linear)}${run('Radial', radial)}</a:p>` }) +
      sp({
        lstStyle: `<a:lvl1pPr><a:defRPr>${linear}</a:defRPr></a:lvl1pPr>`,
        body: `<a:p>${run('Inherits')}${run('Solid', solid('00FF00'))}</a:p>`,
      }) +
      sp({
        lstStyle: `<a:lvl1pPr><a:defRPr>${solid('0000FF')}</a:defRPr></a:lvl1pPr>`,
        body: `<a:p>${run('Listed')}${run('Own', solid('00FF00'))}</a:p>`,
      }).replace('<a:bodyPr/>', '<a:bodyPr wrap="none"/>') +
      sp({ ph: '<p:ph idx="1"/>', body: `<a:p>${run('Mastered')}</a:p>` }) +
      sp({
        body: `<a:p>${run('Hollow', `<a:ln w="25400">${solid('FFFFFF')}</a:ln><a:noFill/>`)}${run('Unseen', '<a:noFill/>')}</a:p>`,
      });
    const z = await JSZip.loadAsync(await deck(body));
    const master = await z.file('ppt/slideMasters/slideMaster1.xml')!.async('string');
    // The master's body style colours placeholder text: pptx-preview reads that one itself.
    z.file(
      'ppt/slideMasters/slideMaster1.xml',
      master.replace(
        '<p:bodyStyle><a:lvl1pPr><a:defRPr>',
        `<p:bodyStyle><a:lvl1pPr><a:defRPr>${solid('00FF00')}`,
      ),
    );
    const a = await annotatePptx(await z.generateAsync({ type: 'uint8array' }));
    const by = Object.fromEntries(await marked(a.bytes, a.runs)) as Record<
      string,
      { gradient?: string; color?: string; hollow?: unknown }
    >;
    // DrawingML's 90 degrees runs top to bottom, CSS's 180.
    const down = 'linear-gradient(180deg, rgba(255,0,0,1) 0%, rgba(0,0,255,1) 100%)';
    expect(by.Linear!.gradient).toBe(down);
    // A path gradient radiates from the centre of its fill rectangle: here the top-right corner.
    expect(by.Radial!.gradient).toBe(
      'radial-gradient(circle farthest-corner at 100% 0%, rgba(255,0,0,1) 0%, rgba(0,0,255,1) 100%)',
    );
    expect(by.Inherits).toEqual({ latin: 'Aptos', ea: 'SimSun', gradient: down });
    expect(by.Solid!.gradient).toBeUndefined();
    expect(by.Listed!.color).toBe('rgba(0,0,255,1)');
    expect(by.Own!.color).toBeUndefined();
    expect(by.Mastered!.color).toBeUndefined();
    // Hollow text: its outline only (2 pt of white), or nothing at all.
    expect(by.Hollow!.hollow).toEqual({ width: 2, color: 'rgba(255,255,255,1)' });
    expect(by.Unseen!.hollow).toEqual({ width: 0 });
    expect(by.Listed!.hollow).toBeUndefined();
    const nowrap = a.runs.map((r) => (r.b === undefined ? undefined : a.bodies[r.b]!.nowrap));
    expect(nowrap.filter((n) => n)).toHaveLength(2);
    expect(a.bodies[a.runs.find((r) => r.gradient)!.b!]!.nowrap).toBeUndefined();
  });

  it('resolves bullets through the chain and counts automatic numbers from startAt, by level', async () => {
    const num = (type: string, at = '') => `<a:buAutoNum type="${type}"${at ? ` startAt="${at}"` : ''}/>`;
    const p = (text: string, pPr = '') => `<a:p>${pPr ? `<a:pPr${pPr}</a:pPr>` : ''}${run(text)}</a:p>`;
    const body =
      // Verses numbered (17), (18)... with an empty paragraph between that neither counts nor breaks.
      sp({
        body:
          p('V17', `>${num('arabicParenBoth', '17')}`) +
          '<a:p><a:pPr>' +
          num('arabicParenBoth', '17') +
          '</a:pPr><a:endParaRPr/></a:p>' +
          p('V18', `>${num('arabicParenBoth', '17')}`) +
          p('Sub-a', ` lvl="1">${num('alphaLcParenR')}`) +
          p('Sub-b', ` lvl="1">${num('alphaLcParenR')}`) +
          p('V19', `>${num('arabicParenBoth', '17')}`) +
          p('Sub-a again', ` lvl="1">${num('alphaLcParenR')}`) +
          p('Unnumbered', '><a:buNone/>') +
          p('Restart', `>${num('romanUcPeriod', '4')}`),
      }) +
      // The layout's list says no bullet, nearer than the master's character bullet.
      sp({ ph: '<p:ph idx="1"/>', body: p('Layout none') }) +
      // A bullet character the slide sets itself; nothing anywhere for a plain text box.
      sp({ body: p('Char', '><a:buChar char="•"/>') + p('Plain') });
    const z = await JSZip.loadAsync(await deck(body));
    const master = await z.file('ppt/slideMasters/slideMaster1.xml')!.async('string');
    z.file(
      'ppt/slideMasters/slideMaster1.xml',
      master.replace('<p:bodyStyle><a:lvl1pPr>', '<p:bodyStyle><a:lvl1pPr><a:buChar char="■"/>'),
    );
    const layout = await z.file('ppt/slideLayouts/slideLayout1.xml')!.async('string');
    z.file('ppt/slideLayouts/slideLayout1.xml', layout.replace('<a:lvl1pPr>', '<a:lvl1pPr><a:buNone/>'));
    const a = await annotatePptx(await z.generateAsync({ type: 'uint8array' }));
    const xml = await (await JSZip.loadAsync(a.bytes)).file('ppt/slides/slide1.xml')!.async('string');
    const bullets: Record<string, unknown> = {};
    for (const t of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g))
      bullets[t[1]!.slice(9)] = a.paras[a.runs[decodeMarker(t[1]!)!]!.p!]!.bullet;
    expect(bullets).toEqual({
      V17: { num: '(17)' },
      V18: { num: '(18)' },
      'Sub-a': { num: 'a)' },
      'Sub-b': { num: 'b)' },
      V19: { num: '(19)' },
      'Sub-a again': { num: 'a)' },
      Unnumbered: { none: true },
      Restart: { num: 'IV.' },
      'Layout none': { none: true },
      Char: { char: true },
      Plain: { none: true },
    });
    expect(autoNumber('alphaUcPeriod', 28)).toBe('BB.');
    expect(autoNumber('romanLcParenBoth', 14)).toBe('(xiv)');
    expect(autoNumber('arabicPlain', 3)).toBe('3');
    expect(autoNumber('circleNumDbPlain', 2)).toBe('\u2461');
    expect(autoNumber('hebrew2Minus', 2)).toBe('2.');
  });

  it('moves group origins out of the range pptx-preview reads as twentieths of a point', async () => {
    const xfrm = (x: number, y: number, ch = '') =>
      `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="9342300" cy="3213300"/>${ch}</a:xfrm>`;
    const group = (ch: [number, number], kids: string) =>
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${xfrm(
        2820321,
        1725369,
        `<a:chOff x="${ch[0]}" y="${ch[1]}"/><a:chExt cx="9342300" cy="4575366"/>`,
      )}</p:grpSpPr>${kids}</p:grpSp>`;
    // A Google Slides group: its title at the group's origin, a caption below it.
    const body =
      group(
        [0, 0],
        sp({ spPr: xfrm(0, 0), body: `<a:p>${run('Title')}</a:p>` }) +
          sp({ spPr: xfrm(1053187, 3568941), body: `<a:p>${run('Caption')}</a:p>` }),
      ) +
      // A group whose coordinates pptx-preview reads right is left alone.
      group([914400, 914400], sp({ spPr: xfrm(914400, 1828800), body: `<a:p>${run('Fine')}</a:p>` }));
    const a = await annotatePptx(await deck(body));
    const xml = await (await JSZip.loadAsync(a.bytes)).file('ppt/slides/slide1.xml')!.async('string');
    const offs = [...xml.matchAll(/<a:(off|chOff) x="(-?\d+)" y="(-?\d+)"\/>/g)].map((m) => [
      m[1],
      Number(m[2]),
      Number(m[3]),
    ]);
    // x and y moved by 20001: every child keeps its place relative to the origin.
    expect(offs).toEqual([
      ['off', 2820321, 1725369],
      ['chOff', 20001, 20001],
      ['off', 20001, 20001],
      ['off', 1073188, 3588942],
      ['off', 2820321, 1725369],
      ['chOff', 914400, 914400],
      ['off', 914400, 1828800],
    ]);
    // The runs are still marked.
    expect([...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]!.slice(9))).toEqual([
      'Title',
      'Caption',
      'Fine',
    ]);
    // Nothing to move, or tags the tree does not match: the part as it is.
    const plain = `<p:spTree ${NS}>${body.slice(body.lastIndexOf('<p:grpSp>'))}</p:spTree>`;
    expect(moveGroupOrigins(plain, rootOf(parseXml(plain, 'x')))).toBe(plain);
    const first = `<p:spTree ${NS}>${body.slice(0, body.lastIndexOf('<p:grpSp>'))}</p:spTree>`;
    expect(moveGroupOrigins(`${first}<a:off x="0" y="0"/>`, rootOf(parseXml(first, 'x')))).toBe(
      `${first}<a:off x="0" y="0"/>`,
    );
  });

  it("gives a text box its exact size: its own, its layout placeholder's, none in a group", async () => {
    const xfrm = (cx: number, cy: number) =>
      `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
    const body =
      sp({ spPr: xfrm(127000, 63500), body: `<a:p>${run('Own')}</a:p>` }) +
      sp({ ph: '<p:ph idx="1"/>', body: `<a:p>${run('Placed')}</a:p>` }) +
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="7" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp({ spPr: xfrm(127000, 63500), body: `<a:p>${run('Grouped')}</a:p>` })}</p:grpSp>`;
    const z = await JSZip.loadAsync(await deck(body));
    const layout = await z.file('ppt/slideLayouts/slideLayout1.xml')!.async('string');
    z.file(
      'ppt/slideLayouts/slideLayout1.xml',
      layout.replace('<p:spPr></p:spPr>', `<p:spPr>${xfrm(254000, 127000)}</p:spPr>`),
    );
    const a = await annotatePptx(await z.generateAsync({ type: 'uint8array' }));
    const xml = await (await JSZip.loadAsync(a.bytes)).file('ppt/slides/slide1.xml')!.async('string');
    const size: Record<string, unknown> = {};
    for (const m of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g))
      size[m[1]!.slice(9)] = a.bodies[a.runs[decodeMarker(m[1]!)!]!.b!]!.size;
    expect(size).toEqual({ Own: { w: 10, h: 5 }, Placed: { w: 20, h: 10 }, Grouped: undefined });
  });

  it('lists slide pictures drawn in an ellipse or a rounded rectangle, by the slide pptx-preview draws', async () => {
    const pic = (prst: string, x: number, av = '') =>
      `<p:pic><p:nvPicPr><p:cNvPr id="4" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/></p:blipFill>` +
      `<p:spPr><a:xfrm><a:off x="${x}" y="127000"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst>${av}</a:avLst></a:prstGeom></p:spPr></p:pic>`;
    const body =
      pic('ellipse', 0) + pic('rect', 0) + pic('roundRect', 12700, '<a:gd name="adj" fmla="val 10000"/>');
    const pres =
      `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId7"/></p:sldIdLst>` +
      '<p:sldSz cx="12192000" cy="6858000"/></p:presentation>';
    const a = await annotatePptx(
      await deck(body, {
        'ppt/presentation.xml': pres,
        'ppt/_rels/presentation.xml.rels': rels('slide', 'slides/slide1.xml').replace('rId1', 'rId7'),
        '[Content_Types].xml': types(['slide1']),
      }),
    );
    expect(a.slideOrder).toEqual([0]);
    expect(a.pictures).toEqual([
      { slide: 0, x: 0, y: 10, w: 200, h: 100, shape: 'ellipse' },
      // A tenth of the shorter side.
      { slide: 0, x: 1, y: 10, w: 200, h: 100, shape: 'roundRect', radius: 10 },
    ]);
  });

  it('places background pictures as PowerPoint does: tiled, cropped, in a fill rectangle, inherited', async () => {
    const twoRels = (first: string, target: string) =>
      rels(first, target).replace(
        '</Relationships>',
        `<Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/></Relationships>`,
      );
    const withBg = (root: string, bg: string, spTree = '<p:spTree/>') =>
      `<?xml version="1.0"?><p:${root} ${NS}><p:cSld><p:bg>${bg}</p:bg>${spTree}</p:cSld></p:${root}>`;
    const blip = (inner: string, blipInner = '') =>
      `<p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rId2">${blipInner}</a:blip>${inner}</a:blipFill><a:effectLst/></p:bgPr>`;
    // 960 x 540 points; a 150 x 100 picture at 300 pixels per inch is 36 x 24 points.
    const slideTile = withBg(
      'sld',
      blip('<a:srcRect/><a:tile tx="127000" ty="-254000" sx="50000" sy="200000" flip="xy" algn="ctr"/>'),
    );
    const a = await annotatePptx(
      await deck('', {
        'ppt/slides/slide1.xml': slideTile,
        'ppt/slides/_rels/slide1.xml.rels': twoRels('slideLayout', '../slideLayouts/slideLayout1.xml'),
        'ppt/media/image1.png': png(150, 100, 300),
        '[Content_Types].xml': types(['slide1']),
      }),
    );
    const w = 18 / 960;
    const h = 48 / 540;
    expect(a.backgrounds).toHaveLength(1);
    const t = a.backgrounds[0]!.tile!;
    expect(t.flip).toBe('xy');
    expect(t.w).toBeCloseTo(w, 9);
    expect(t.h).toBeCloseTo(h, 9);
    // Centred, then moved 10 points right and 20 up.
    expect(t.x).toBeCloseTo((1 - w) / 2 + 10 / 960, 9);
    expect(t.y).toBeCloseTo((1 - h) / 2 - 20 / 540, 9);

    // The slide has no background: its layout's, stretched into a fill rectangle and cropped; a picture
    // without a stated resolution tiles at 96 pixels per inch.
    const layout = (bg: string) => withBg('sldLayout', bg);
    const inherited = await annotatePptx(
      await deck('', {
        'ppt/slideLayouts/slideLayout1.xml': layout(
          blip(
            '<a:srcRect l="10000" r="-20000"/><a:stretch><a:fillRect t="34000" b="11000"/></a:stretch>',
            '<a:alphaModFix amt="46000"/>',
          ),
        ),
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels': twoRels(
          'slideMaster',
          '../slideMasters/slideMaster1.xml',
        ),
        'ppt/media/image1.png': png(96, 48),
        '[Content_Types].xml': types(['slide1']),
      }),
    );
    expect(inherited.backgrounds).toEqual([
      { slide: 0, rect: { l: 0, t: 0.34, r: 0, b: 0.11 }, crop: { l: 0.1, t: 0, r: -0.2, b: 0 } },
    ]);

    // From the master, tiled at the picture's own size; a plainly stretched picture needs nothing; a
    // slide's own colour hides the picture behind it.
    const master = (await JSZip.loadAsync(await deck(''))).file('ppt/slideMasters/slideMaster1.xml')!;
    const masterXml = (await master.async('string')).replace(
      '<p:cSld>',
      `<p:cSld><p:bg>${blip('<a:tile/>')}</p:bg>`,
    );
    const fromMaster = (slide: string) =>
      deck('', {
        'ppt/slides/slide1.xml': slide,
        'ppt/slideMasters/slideMaster1.xml': masterXml,
        'ppt/slideMasters/_rels/slideMaster1.xml.rels': twoRels('theme', '../theme/theme1.xml'),
        'ppt/media/image1.png': png(96, 48),
        '[Content_Types].xml': types(['slide1']),
      });
    const tiled = await annotatePptx(await fromMaster(withBg('sld', '').replace('<p:bg></p:bg>', '')));
    expect(tiled.backgrounds).toEqual([
      { slide: 0, tile: { w: 72 / 960, h: 36 / 540, x: 0, y: 0, flip: 'none' } },
    ]);
    const coloured = withBg('sld', '<p:bgPr><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></p:bgPr>');
    expect((await annotatePptx(await fromMaster(coloured))).backgrounds).toEqual([]);
    const stretched = await annotatePptx(
      await deck('', {
        'ppt/slides/slide1.xml': withBg('sld', blip('<a:srcRect/><a:stretch><a:fillRect/></a:stretch>')),
        'ppt/slides/_rels/slide1.xml.rels': twoRels('slideLayout', '../slideLayouts/slideLayout1.xml'),
        'ppt/media/image1.png': png(96, 48),
        '[Content_Types].xml': types(['slide1']),
      }),
    );
    expect(stretched.backgrounds).toEqual([]);
  });

  it("writes a theme's picture background into the part that refers to it, which pptx-preview then draws", async () => {
    const base = await JSZip.loadAsync(await deck(''));
    const theme = (await base.file('ppt/theme/theme1.xml')!.async('string')).replace(
      '</a:effectStyleLst>',
      '</a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
        '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>' +
        '<a:blipFill><a:blip r:embed="rId5"/><a:tile sx="50000" sy="50000"/></a:blipFill></a:bgFillStyleLst>',
    );
    const master = (await base.file('ppt/slideMasters/slideMaster1.xml')!.async('string')).replace(
      '<p:cSld>',
      '<p:cSld><p:bg><p:bgRef idx="1003"><a:schemeClr val="bg2"/></p:bgRef></p:bg>',
    );
    const layout = (idx: number) =>
      `<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld><p:bg><p:bgRef idx="${idx}"/></p:bg><p:spTree/></p:cSld></p:sldLayout>`;
    const a = await annotatePptx(
      await deck('', {
        'ppt/theme/theme1.xml': theme,
        'ppt/theme/_rels/theme1.xml.rels': rels('image', '../media/image1.png').replace('rId1', 'rId5'),
        'ppt/media/image1.png': png(96, 48),
        'ppt/slideMasters/slideMaster1.xml': master,
        // A gradient with no colour for its placeholder stays as pptx-preview draws it.
        'ppt/slideLayouts/slideLayout2.xml': layout(1002),
        'ppt/slideLayouts/_rels/slideLayout2.xml.rels': rels(
          'slideMaster',
          '../slideMasters/slideMaster1.xml',
        ),
        // A gradient with one is written into the part.
        'ppt/slideLayouts/slideLayout3.xml': layout(1002).replace(
          '<p:bgRef idx="1002"/>',
          '<p:bgRef idx="1002"><a:srgbClr val="112233"><a:lumMod val="50000"/></a:srgbClr></p:bgRef>',
        ),
        'ppt/slideLayouts/_rels/slideLayout3.xml.rels': rels(
          'slideMaster',
          '../slideMasters/slideMaster1.xml',
        ),
        '[Content_Types].xml': types(['slide1']),
      }),
    );
    const z = await JSZip.loadAsync(a.bytes);
    const m = await z.file('ppt/slideMasters/slideMaster1.xml')!.async('string');
    expect(m).toContain(
      '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rIdOrdoBg"/><a:tile sx="50000" sy="50000"/></a:blipFill><a:effectLst/></p:bgPr></p:bg>',
    );
    expect(await z.file('ppt/slideMasters/_rels/slideMaster1.xml.rels')!.async('string')).toContain(
      '<Relationship Id="rIdOrdoBg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>',
    );
    expect(await z.file('ppt/slideLayouts/slideLayout2.xml')!.async('string')).toContain(
      '<p:bgRef idx="1002"/>',
    );
    expect(await z.file('ppt/slideLayouts/slideLayout3.xml')!.async('string')).toContain(
      '<p:bg><p:bgPr><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="112233"><a:lumMod val="50000"/></a:srgbClr></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>',
    );
    // The placeholder's own changes follow the colour's.
    expect(
      withPlaceholderColor(
        '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="88000"/></a:schemeClr></a:gs><a:schemeClr val="bg1"/>',
        '<a:schemeClr val="bg2"><a:shade val="50000"/></a:schemeClr>',
      ),
    ).toBe(
      '<a:gs pos="0"><a:schemeClr val="bg2"><a:shade val="50000"/><a:tint val="88000"/></a:schemeClr></a:gs><a:schemeClr val="bg1"/>',
    );
    expect(withPlaceholderColor('<a:schemeClr val="phClr"/>', '<a:schemeClr val="bg2"/>')).toBe(
      '<a:schemeClr val="bg2"></a:schemeClr>',
    );
    expect(withPlaceholderColor('<a:schemeClr val="phClr"/>', 'two<a:b/>')).toBeUndefined();
    // A picture the theme recolours stays as pptx-preview draws it (a flat colour): it ignores duotone.
    const toned = await annotatePptx(
      await deck('', {
        'ppt/theme/theme1.xml': theme.replace(
          '<a:blip r:embed="rId5"/>',
          '<a:blip r:embed="rId5"><a:duotone><a:schemeClr val="phClr"/><a:prstClr val="white"/></a:duotone></a:blip>',
        ),
        'ppt/theme/_rels/theme1.xml.rels': rels('image', '../media/image1.png').replace('rId1', 'rId5'),
        'ppt/media/image1.png': png(96, 48),
        'ppt/slideMasters/slideMaster1.xml': master,
        '[Content_Types].xml': types(['slide1']),
      }),
    );
    expect(
      await (await JSZip.loadAsync(toned.bytes)).file('ppt/slideMasters/slideMaster1.xml')!.async('string'),
    ).toContain('<p:bgRef idx="1003"><a:schemeClr val="bg2"/></p:bgRef>');
    // The slide shows its master's background, now a tiled picture.
    expect(a.backgrounds).toEqual([
      { slide: 0, tile: { w: 36 / 960, h: 18 / 540, x: 0, y: 0, flip: 'none' } },
    ]);
  });

  it('reads the pixel size and resolution of PNG, JPEG, GIF and BMP pictures', () => {
    expect(pictureSize(png(150, 100, 300))).toEqual({ w: 150, h: 100, dpiX: 300, dpiY: 300 });
    expect(pictureSize(png(3, 2))).toEqual({ w: 3, h: 2, dpiX: 96, dpiY: 96 });
    // JFIF at 75 dots per inch, then a baseline frame of 128 x 64.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 75, 0, 75, 0, 0, 0xff, 0xc0, 0,
      11, 8, 0, 64, 0, 128, 1, 1, 0x11, 0,
    ]);
    expect(pictureSize(jpeg)).toEqual({ w: 128, h: 64, dpiX: 75, dpiY: 75 });
    expect(pictureSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 0, 7, 0]))).toEqual({
      w: 5,
      h: 7,
      dpiX: 96,
      dpiY: 96,
    });
    const bmp = new Uint8Array(54);
    bmp.set([0x42, 0x4d]);
    new DataView(bmp.buffer).setInt32(18, 10, true);
    new DataView(bmp.buffer).setInt32(22, -20, true);
    expect(pictureSize(bmp)).toEqual({ w: 10, h: 20, dpiX: 96, dpiY: 96 });
    expect(pictureSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
    // A JPEG whose segments run past the end has no size.
    expect(pictureSize(jpeg.subarray(0, 24))).toBeUndefined();
  });

  it('lists slide pictures cut to a custom outline, with the outline in points of the picture', async () => {
    const pic = (path: string, flip = '') =>
      `<p:pic><p:nvPicPr><p:cNvPr id="4" name="P"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/></p:blipFill>` +
      `<p:spPr><a:xfrm${flip}><a:off x="127000" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm><a:custGeom><a:avLst/><a:gdLst/>` +
      `<a:pathLst>${path}</a:pathLst></a:custGeom></p:spPr></p:pic>`;
    const pt = (x: number | string, y: number) => `<a:pt x="${x}" y="${y}"/>`;
    const shape =
      `<a:path w="1000" h="500"><a:moveTo>${pt(500, 0)}</a:moveTo><a:lnTo>${pt(1000, 0)}</a:lnTo>` +
      `<a:cubicBezTo>${pt(1000, 250)}${pt(750, 500)}${pt(500, 500)}</a:cubicBezTo><a:close/></a:path>`;
    const body =
      pic(shape) +
      pic(shape, ' flipH="1"') +
      // Arcs and guide names are not drawn: those pictures stay rectangles.
      pic(
        '<a:path w="10" h="10"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:arcTo wR="5" hR="5" stAng="0" swAng="5400000"/></a:path>',
      ) +
      pic(`<a:path w="10" h="10"><a:moveTo>${pt('w', 0)}</a:moveTo></a:path>`);
    const a = await annotatePptx(await deck(body, { '[Content_Types].xml': types(['slide1']) }));
    expect(a.pictures).toEqual([
      { slide: 0, x: 10, y: 0, w: 200, h: 100, shape: 'path', d: 'M100 0 L200 0 C200 50 150 100 100 100 Z' },
    ]);
  });

  it('lists the slides that hide their master and layout shapes, by the slide pptx-preview draws', async () => {
    const slide = (attrs: string) =>
      `<?xml version="1.0"?><p:sld ${NS}${attrs}><p:cSld><p:spTree/></p:cSld></p:sld>`;
    const hidingLayout = `<?xml version="1.0"?><p:sldLayout ${NS} showMasterSp="0"><p:cSld><p:spTree/></p:cSld></p:sldLayout>`;
    const a = await annotatePptx(
      await deck('', {
        '[Content_Types].xml': types(['slide1', 'slide2', 'slide3', 'slide10']),
        'ppt/slides/slide1.xml': slide(' showMasterSp="0"'),
        'ppt/slides/slide2.xml': slide(''),
        'ppt/slides/_rels/slide2.xml.rels': rels('slideLayout', '../slideLayouts/slideLayout1.xml'),
        'ppt/slides/slide3.xml': slide(''),
        'ppt/slides/_rels/slide3.xml.rels': rels('slideLayout', '../slideLayouts/slideLayout2.xml'),
        'ppt/slideLayouts/slideLayout2.xml': hidingLayout,
        'ppt/slideLayouts/_rels/slideLayout2.xml.rels': rels(
          'slideMaster',
          '../slideMasters/slideMaster1.xml',
        ),
        'ppt/slides/slide10.xml': slide(' show="1" showMasterSp="false"'),
      }),
    );
    expect(a.hiddenMasterShapes).toEqual([
      { slide: 0, layout: true },
      { slide: 2, layout: false },
      { slide: 3, layout: true },
    ]);
  });

  it('renames pictures pptx-preview would not load, and every relationship to them', async () => {
    const rel = (target: string) =>
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/image" Target="${target}"/><Relationship Id="rId3" Type="${REL}/hyperlink" Target="https://example.org/media/Slide-1-image-1.png" TargetMode="External"/></Relationships>`;
    const a = await annotatePptx(
      await deck('', {
        'ppt/media/Slide-1-image-1.png': 'x',
        'ppt/media/image1.png': 'y',
        'ppt/slides/_rels/slide1.xml.rels': rel('../media/Slide-1-image-1.png'),
      }),
    );
    const z = await JSZip.loadAsync(a.bytes);
    expect(z.file('ppt/media/Slide-1-image-1.png')).toBeNull();
    expect(await z.file('ppt/media/image-ordo-Slide-1-image-1.png')!.async('string')).toBe('x');
    expect(z.file('ppt/media/image1.png')).not.toBeNull();
    const rels = await z.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
    expect(rels).toContain('Target="../media/image-ordo-Slide-1-image-1.png"');
    expect(rels).toContain('Target="https://example.org/media/Slide-1-image-1.png"');
  });

  it("gives charts without a title the one PowerPoint shows, not pptx-preview's placeholder", async () => {
    const C =
      'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
    const ser = (name: string) =>
      `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx></c:ser>`;
    const chart = (inner: string) =>
      `<?xml version="1.0"?><c:chartSpace ${C}><c:chart>${inner}</c:chart></c:chartSpace>`;
    const a = await annotatePptx(
      await deck('', {
        'ppt/charts/chart1.xml': chart(
          `<c:autoTitleDeleted val="1"/><c:plotArea>${ser('Attendance')}</c:plotArea>`,
        ),
        'ppt/charts/chart2.xml': chart(
          `<c:autoTitleDeleted val="0"/><c:plotArea>${ser('Giving')}</c:plotArea>`,
        ),
        'ppt/charts/chart3.xml': chart(`<c:plotArea>${ser('One')}${ser('Two')}</c:plotArea>`),
        'ppt/charts/chart4.xml': chart(
          `<c:title><c:tx><c:rich><a:p><a:r><a:t>Own</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea>${ser('X')}</c:plotArea>`,
        ),
        // Automatic titles: a title element with no text of its own.
        'ppt/charts/chart5.xml': chart(
          `<c:title><c:overlay val="0"/></c:title><c:plotArea>${ser('Offering')}</c:plotArea>`,
        ),
        'ppt/charts/chart6.xml': chart(
          `<c:title><c:overlay val="0"/></c:title><c:plotArea>${ser('A')}${ser('B')}</c:plotArea>`,
        ),
        // An axis title is not the chart's.
        'ppt/charts/chart7.xml': chart(
          `<c:autoTitleDeleted val="1"/><c:plotArea>${ser('Y')}<c:valAx><c:title><c:tx><c:rich><a:p><a:r><a:t>People</a:t></a:r></a:p></c:rich></c:tx></c:title></c:valAx></c:plotArea>`,
        ),
      }),
    );
    const z = await JSZip.loadAsync(a.bytes);
    const title = async (n: number) =>
      /<c:title>[\s\S]*?<a:t>([^<]*)<\/a:t>/.exec(
        await z.file(`ppt/charts/chart${n}.xml`)!.async('string'),
      )?.[1];
    expect(await title(1)).toBe(' ');
    expect(await title(2)).toBe('Giving');
    expect(await title(3)).toBe(' ');
    expect(await title(4)).toBe('Own');
    expect(await title(5)).toBe('Offering');
    expect(await title(6)).toBe('Chart Title');
    expect(await title(7)).toBe(' ');
  });

  it('maps the slides pptx-preview draws (by part name) to the presentation order, without hidden ones', async () => {
    const sld = (attrs: string) =>
      `<?xml version="1.0"?><p:sld ${NS}${attrs}><p:cSld><p:spTree/></p:cSld></p:sld>`;
    const presRels =
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      ['slide1', 'slide2', 'slide10', 'slide3']
        .map((n, i) => `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/${n}.xml"/>`)
        .join('') +
      '</Relationships>';
    // Presentation order: slide10, slide3 (hidden), slide1, slide2.
    const pres =
      `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId4"/><p:sldId id="257" r:id="rId5"/>` +
      '<p:sldId id="258" r:id="rId2"/><p:sldId id="259" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>';
    const a = await annotatePptx(
      await deck('', {
        'ppt/presentation.xml': pres,
        'ppt/_rels/presentation.xml.rels': presRels,
        'ppt/slides/slide2.xml': sld(''),
        'ppt/slides/slide3.xml': sld(' show="0"'),
        'ppt/slides/slide10.xml': sld(''),
        '[Content_Types].xml': types(['slide10', 'slide2', 'slide1', 'slide3']),
      }),
    );
    // pptx-preview draws slide1, slide2, slide3, slide10; they go to places 1, 2, (hidden), 0.
    expect(a.slideOrder).toEqual([1, 2, -1, 0]);
  });

  it('reads a Strict OOXML deck as the Transitional one pptx-preview knows', async () => {
    /** The deck as Strict OOXML writes it: other namespace and relationship URIs, percentages as `N%`. */
    const strict = async (bytes: Uint8Array) => {
      const z = await JSZip.loadAsync(bytes);
      for (const name of Object.keys(z.files)) {
        if (z.files[name]!.dir) continue;
        const xml = await z.file(name)!.async('string');
        z.file(
          name,
          xml
            .replaceAll(
              'http://schemas.openxmlformats.org/drawingml/2006/main',
              'http://purl.oclc.org/ooxml/drawingml/main',
            )
            .replaceAll(
              'http://schemas.openxmlformats.org/presentationml/2006/main',
              'http://purl.oclc.org/ooxml/presentationml/main',
            )
            .replaceAll(REL, 'http://purl.oclc.org/ooxml/officeDocument/relationships'),
        );
      }
      return z.generateAsync({ type: 'uint8array' });
    };
    const presRels =
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/>` +
      `<Relationship Id="rId3" Type="${REL}/extendedProperties" Target="../docProps/app.xml"/></Relationships>`;
    // The relationships prefix is the writer's choice (`rel`, not `r`).
    const pres =
      `<?xml version="1.0"?><p:presentation ${NS.replace('xmlns:r=', 'xmlns:rel=')}>` +
      '<p:sldIdLst><p:sldId id="256" rel:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>';
    const body = sp({
      ph: '<p:ph type="title"/>',
      spPr: '<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75%"/></a:schemeClr></a:solidFill>',
      body: `<a:p><a:pPr><a:lnSpc><a:spcPct val="90.5%"/></a:lnSpc></a:pPr>${run('Strict')}</a:p>`,
    });
    const a = await annotatePptx(
      await strict(
        await deck(body, {
          'ppt/presentation.xml': pres,
          'ppt/_rels/presentation.xml.rels': presRels,
          '[Content_Types].xml': types(['slide1']),
        }),
      ),
    );
    expect(a.notes).toEqual(['Strict OOXML: 9 parts rewritten to Transitional']);
    const z = await JSZip.loadAsync(a.bytes);
    const slide = await z.file('ppt/slides/slide1.xml')!.async('string');
    expect(slide).not.toContain('purl.oclc.org');
    expect(slide).toContain('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"');
    expect(slide).toContain('<a:lumMod val="75000"/>');
    expect(slide).toContain('<a:spcPct val="90500"/>');
    expect(await z.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')).toContain(
      `Type="${REL}/slideLayout"`,
    );
    expect(await z.file('ppt/_rels/presentation.xml.rels')!.async('string')).toContain(
      `Type="${REL}/extended-properties"`,
    );
    expect(await marked(a.bytes, a.runs)).toEqual([['Strict', { latin: 'Aptos Display' }]]);
    expect(a.paras[0]?.lnSpcPct).toBe(90_500);
    expect(a.slideOrder).toEqual([0]);
  });

  it('rewrites Strict URIs and percentages only where they are', () => {
    expect(
      strictToTransitional(
        '<Relationships><Relationship Type="http://purl.oclc.org/ooxml/officeDocument/relationships/metadata/thumbnail"/>' +
          '<Relationship Type="http://purl.oclc.org/ooxml/officeDocument/relationships/chart"/></Relationships>',
        false,
      ),
    ).toBe(
      '<Relationships><Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>' +
        `<Relationship Type="${REL}/chart"/></Relationships>`,
    );
    expect(
      strictToTransitional(
        '<a:graphicData uri="http://purl.oclc.org/ooxml/drawingml/chart"><a:gs pos="50%"/><a:t> w="5%" </a:t></a:graphicData>',
        true,
      ),
    ).toBe(
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><a:gs pos="50000"/><a:t> w="5%" </a:t></a:graphicData>',
    );
  });

  it('completes group transforms: pptx-preview reads all four of offset, size and child offset and size', async () => {
    const grp = (xfrm: string) => `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr>${xfrm}</p:grpSpPr></p:grpSp>`;
    const whole =
      '<a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/><a:chOff x="5" y="6"/><a:chExt cx="7" cy="8"/></a:xfrm>';
    expect(completeGroupTransforms(grp(whole))).toBe(grp(whole));
    expect(
      completeGroupTransforms(
        grp(
          '<a:xfrm rot="60000"><a:off x="10" y="20"/><a:ext cx="30" cy="40"/><a:chExt cx="300" cy="400"/></a:xfrm>',
        ) +
          grp('<a:xfrm><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></a:xfrm>') +
          grp('<a:xfrm/>') +
          '<p:grpSpPr/>',
      ),
    ).toBe(
      grp(
        '<a:xfrm rot="60000"><a:off x="10" y="20"/><a:ext cx="30" cy="40"/><a:chOff x="0" y="0"/><a:chExt cx="300" cy="400"/></a:xfrm>',
      ) +
        grp(
          '<a:xfrm><a:off x="10" y="20"/><a:ext cx="30" cy="40"/><a:chOff x="0" y="0"/><a:chExt cx="30" cy="40"/></a:xfrm>',
        ) +
        grp(
          '<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm>',
        ) +
        '<p:grpSpPr/>',
    );
    // In a deck: the slide's group is repaired before its text is marked.
    const a = await annotatePptx(
      await deck(
        '<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9" cy="9"/></a:xfrm></p:grpSpPr>' +
          `${sp({ body: `<a:p>${run('In a group')}</a:p>` })}</p:grpSp>`,
      ),
    );
    expect(a.notes).toEqual(['ppt/slides/slide1.xml: group transforms completed']);
    const slide = await (await JSZip.loadAsync(a.bytes)).file('ppt/slides/slide1.xml')!.async('string');
    // The child space it gets starts at 0, which pptx-preview would read as points: it is moved on.
    expect(slide).toContain('<a:chOff x="20001" y="20001"/><a:chExt cx="9" cy="9"/>');
    expect((await marked(a.bytes, a.runs)).map(([t]) => t)).toEqual(['In a group']);
  });

  it('places or drops slide placeholders pptx-preview cannot find on their layout', async () => {
    const ph = (attrs: string, spPr = '<p:spPr/>') =>
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr><p:ph ${attrs}/></p:nvPr></p:nvSpPr>${spPr}<p:txBody><a:bodyPr/><a:p/></p:txBody></p:sp>`;
    const own = '<p:spPr><a:xfrm><a:off x="1" y="1"/><a:ext cx="1" cy="1"/></a:xfrm></p:spPr>';
    const footer = rootOf(
      parseXml('<a:xfrm flipH="1"><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></a:xfrm>', 'xfrm'),
    );
    const layout = { idx: new Set(['1']), type: new Set(['title']) };
    const keep =
      ph('type="body" idx="1"') + ph('type="title"') + ph('type="dt" idx="13"', own) + ph('idx="14"', '');
    const r = placeOrphanPlaceholders(
      keep +
        ph('type="ftr" idx="11"') +
        ph('type="sldNum" idx="12"', '<p:spPr bwMode="auto"></p:spPr>') +
        ph('type="pic" idx="15"'),
      layout,
      (p) => (p.type === 'ftr' ? footer : undefined),
      { cx: 100, cy: 50 },
    );
    expect(r).toEqual({
      xml:
        keep +
        ph(
          'type="ftr" idx="11"',
          '<p:spPr><a:xfrm flipH="1"><a:off x="10" y="20"/><a:ext cx="30" cy="40"/></a:xfrm></p:spPr>',
        ) +
        // Nothing places it: the whole slide, so its text is still drawn.
        ph(
          'type="pic" idx="15"',
          '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="50"/></a:xfrm></p:spPr>',
        ),
      placed: 2,
      dropped: 1,
    });
    // In a deck: a footer with nothing to inherit its place from (the layout and master have none) is dropped.
    const a = await annotatePptx(
      await deck(sp({ ph: '<p:ph type="ftr" idx="7"/>', body: `<a:p>${run('F')}</a:p>` })),
    );
    expect(a.notes).toEqual(['ppt/slides/slide1.xml: placeholders not on the layout: 0 placed, 1 dropped']);
    expect(await marked(a.bytes, a.runs)).toEqual([]);
  });

  it('removes embedded colour profiles from JPEG and PNG pictures, and only those', () => {
    const seg = (marker: number, payload: number[]) => [
      0xff,
      marker,
      (payload.length + 2) >> 8,
      (payload.length + 2) & 255,
      ...payload,
    ];
    const ascii = (t: string) => Array.from(t, (c) => c.charCodeAt(0));
    const app0 = seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const icc = seg(0xe2, [...ascii('ICC_PROFILE'), 0, 1, 1, 9, 9, 9]);
    const sos = [0xff, 0xda, 0, 2, 0xff, 0xe2, 1, 2, 0xff, 0xd9];
    const jpeg = Uint8Array.from([0xff, 0xd8, ...app0, ...icc, ...sos]);
    expect(Array.from(withoutJpegIcc(jpeg)!)).toEqual([0xff, 0xd8, ...app0, ...sos]);
    expect(withoutJpegIcc(Uint8Array.from([0xff, 0xd8, ...app0, ...sos]))).toBeUndefined();
    const chunk = (type: string, data: number[]) => [
      0,
      0,
      0,
      data.length,
      ...ascii(type),
      ...data,
      1,
      2,
      3,
      4,
    ];
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const rest = [...chunk('IDAT', [7, 7]), ...chunk('IEND', [])];
    const png = Uint8Array.from([...sig, ...ihdr, ...chunk('iCCP', [...ascii('p'), 0, 0, 5]), ...rest]);
    expect(Array.from(withoutIccp(png)!)).toEqual([...sig, ...ihdr, ...rest]);
    expect(withoutIccp(Uint8Array.from([...sig, ...ihdr, ...rest]))).toBeUndefined();
    expect(withoutIccp(jpeg)).toBeUndefined();
  });

  it('drops content-type entries for parts the package does not have (pptxgenjs, multi-slide decks)', async () => {
    const types =
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
      '</Types>';
    const a = await annotatePptx(await deck('', { '[Content_Types].xml': types }));
    const out = await (await JSZip.loadAsync(a.bytes)).file('[Content_Types].xml')!.async('string');
    expect(out).toContain('slideMaster1.xml');
    expect(out).not.toContain('slideMaster2.xml');
    expect(a.notes).toEqual(['[Content_Types].xml: 1 entry for missing parts removed']);
  });

  it('gives slides with their own colour mapping copies of their layout and master with that mapping', async () => {
    const slide = (ovr: string) =>
      `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld>` +
      `<p:clrMapOvr>${ovr}</p:clrMapOvr></p:sld>`;
    const dark = '<a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"/>';
    const toLayout1 = rels('slideLayout', '../slideLayouts/slideLayout1.xml');
    const a = await annotatePptx(
      await deck('', {
        '[Content_Types].xml': types(['slide1', 'slide2', 'slide3', 'slide4']),
        'ppt/slides/slide1.xml': slide(dark),
        'ppt/slides/slide2.xml': slide('<a:masterClrMapping/>'),
        'ppt/slides/_rels/slide2.xml.rels': toLayout1,
        'ppt/slides/slide3.xml': slide(dark),
        'ppt/slides/_rels/slide3.xml.rels': toLayout1,
        // The master's own mapping: nothing to copy.
        'ppt/slides/slide4.xml': slide('<a:overrideClrMapping bg1="lt1" tx1="dk1"/>'),
        'ppt/slides/_rels/slide4.xml.rels': toLayout1,
      }),
    );
    const z = await JSZip.loadAsync(a.bytes);
    const text = (p: string) => z.file(p)!.async('string');
    expect(await text('ppt/slides/_rels/slide1.xml.rels')).toContain(
      'Target="../slideLayouts/slideLayout2.xml"',
    );
    expect(await text('ppt/slides/_rels/slide3.xml.rels')).toContain(
      'Target="../slideLayouts/slideLayout2.xml"',
    );
    expect(await text('ppt/slides/_rels/slide2.xml.rels')).toContain(
      'Target="../slideLayouts/slideLayout1.xml"',
    );
    expect(await text('ppt/slides/_rels/slide4.xml.rels')).toContain(
      'Target="../slideLayouts/slideLayout1.xml"',
    );
    expect(await text('ppt/slideLayouts/slideLayout2.xml')).toBe(
      await text('ppt/slideLayouts/slideLayout1.xml'),
    );
    expect(await text('ppt/slideLayouts/_rels/slideLayout2.xml.rels')).toContain(
      'Target="../slideMasters/slideMaster2.xml"',
    );
    const master = await text('ppt/slideMasters/slideMaster2.xml');
    expect(master).toContain('<p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1"/>');
    expect(master.replace(/<p:clrMap [^>]*>/, '')).toBe(
      (await text('ppt/slideMasters/slideMaster1.xml')).replace(/<p:clrMap [^>]*>/, ''),
    );
    expect(await text('ppt/slideMasters/_rels/slideMaster2.xml.rels')).toContain('../theme/theme1.xml');
    expect(z.file('ppt/slideLayouts/slideLayout3.xml')).toBeNull();
    const ct = await text('[Content_Types].xml');
    expect(ct).toContain(
      '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    );
    expect(ct).toContain(
      '<Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    );
    expect(a.notes).toEqual([]);
  });

  it('resolves text colours of a slide with its own colour mapping through it', async () => {
    const body = sp({
      body: `<a:p>${run('Hi', `<a:effectLst><a:outerShdw dist="12700" dir="0"><a:schemeClr val="tx1"/></a:outerShdw></a:effectLst>`)}</a:p>`,
    });
    const a = await annotatePptx(
      await deck('', {
        '[Content_Types].xml': types(['slide1']),
        'ppt/slides/slide1.xml':
          `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld>` +
          '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"/></p:clrMapOvr></p:sld>',
      }),
    );
    expect(a.runs[a.runs.length - 1]?.shadows?.[0]?.color).toBe('rgba(255,255,255,1)');
  });

  it('leaves a part it cannot align unmarked and returns an untouched deck when nothing is marked', async () => {
    const odd = sp({ body: `<a:p>${run('Kept')}</a:p>` }).replace(
      '<p:txBody>',
      '<!-- <a:t>not a run</a:t> --><p:txBody>',
    );
    const a = await annotatePptx(await deck(odd));
    expect(a.runs).toEqual([]);
    expect(a.notes.join('\n')).toMatch(/slide1\.xml: 2 text tags but 1 parsed/);
    const input = await deck('');
    const b = await annotatePptx(input);
    expect(b.bytes).toBe(input);
  });
});

/** What `f` returns, failing when it takes `ms` or longer. */
async function within<T>(ms: number, f: () => Promise<T> | T): Promise<T> {
  const t = performance.now();
  const v = await f();
  expect(performance.now() - t).toBeLessThan(ms);
  return v;
}

describe('annotatePptx on crafted decks (uploads are untrusted)', () => {
  const C =
    'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const ser = (name: string) =>
    `<c:ser><c:idx val="0"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx></c:ser>`;
  const chart = (inner: string) =>
    `<?xml version="1.0"?><c:chartSpace ${C}><c:chart>${inner}</c:chart></c:chartSpace>`;
  const ascii = (t: string) => Array.from(t, (c) => c.charCodeAt(0));
  const chunk = (type: string, data: number[]) => [0, 0, 0, data.length, ...ascii(type), ...data, 1, 2, 3, 4];
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const iccp = chunk('iCCP', [...ascii('p'), 0, 0, 5]);
  const iend = chunk('IEND', []);

  it('titles charts in linear time: unclosed series and titles do not backtrack', async () => {
    const bytes = await deck('', {
      'ppt/charts/chart1.xml': `<c:chartSpace ${C}><c:chart>${'<c:ser><c:tx><c:v>a'.repeat(1500)}`,
      'ppt/charts/chart2.xml': `<c:chartSpace ${C}><c:chart><c:title>${'<c:tx><c:ser><c:tx><c:v>a'.repeat(1500)}`,
    });
    const a = await within(2000, () => annotatePptx(bytes));
    const z = await JSZip.loadAsync(a.bytes);
    for (const n of [1, 2]) {
      const xml = await z.file(`ppt/charts/chart${n}.xml`)!.async('string');
      // Many series (none closed) and no title of its own that is closed: a blank title.
      expect(
        xml.startsWith(
          `<c:chartSpace ${C}><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t> </a:t>`,
        ),
      ).toBe(true);
    }
  });

  it("writes a series name into a chart title as it is: `$'`, `$&` and `$$` are not replacement patterns", async () => {
    const name = "Revenue $'000 $& $` $$";
    const a = await annotatePptx(
      await deck('', {
        'ppt/charts/chart1.xml': chart(`<c:autoTitleDeleted val="0"/><c:plotArea>${ser(name)}</c:plotArea>`),
        'ppt/charts/chart2.xml': chart(
          `<c:title><c:overlay val="0"/></c:title><c:plotArea>${ser(name)}</c:plotArea>`,
        ),
      }),
    );
    const z = await JSZip.loadAsync(a.bytes);
    for (const n of [1, 2]) {
      const xml = await z.file(`ppt/charts/chart${n}.xml`)!.async('string');
      expect(/<c:title>[\s\S]*?<a:t>([^<]*)<\/a:t>/.exec(xml)?.[1]).toBe(name);
      expect(xml.split('<c:plotArea>')).toHaveLength(2);
      expect(xml.split('</c:chartSpace>')).toHaveLength(2);
    }
  });

  it('looks placeholders up by key: thousands in a layout, tens of thousands of runs in one box', async () => {
    // A search of the layout per run took 25 s to a minute; parsing the two parts takes about one second.
    const many = Array.from(
      { length: 34_000 },
      (_, i) => `<p:sp><p:nvSpPr><p:nvPr><p:ph type="pic" idx="${i + 2}"/></p:nvPr></p:nvSpPr></p:sp>`,
    ).join('');
    const layout =
      `<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld><p:spTree>${many}` +
      sp({
        ph: '<p:ph type="body" idx="1"/>',
        lstStyle: '<a:lvl1pPr><a:defRPr><a:latin typeface="Tahoma"/></a:defRPr></a:lvl1pPr>',
        body: '<a:p><a:endParaRPr/></a:p>',
      }) +
      '</p:spTree></p:cSld></p:sldLayout>';
    // An index the layout does not have: the placeholder is found by its type, the layout's last.
    const body = sp({
      ph: '<p:ph type="body" idx="777777"/>',
      body: `<a:p>${'<a:r><a:t/></a:r>'.repeat(80_000)}${run('Real')}</a:p>`,
    });
    const bytes = await deck(body, { 'ppt/slideLayouts/slideLayout1.xml': layout });
    const a = await within(10_000, () => annotatePptx(bytes));
    expect(await marked(a.bytes, a.runs)).toEqual([['Real', { latin: 'Tahoma', ea: 'SimSun' }]]);
  });

  it('walks at most 2^18 text elements in a deck, empty ones included', async () => {
    const slide2 =
      `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${'<a:t/>'.repeat(70_000)}` +
      `${sp({ body: `<a:p>${run('Late')}</a:p>` })}</p:spTree></p:cSld></p:sld>`;
    const bytes = await deck('<a:t/>'.repeat(200_000), {
      'ppt/slides/slide2.xml': slide2,
      'ppt/slides/_rels/slide2.xml.rels': rels('slideLayout', '../slideLayouts/slideLayout1.xml'),
    });
    const a = await within(5000, () => annotatePptx(bytes));
    expect(a.runs).toEqual([]);
    expect(a.notes).toContain(
      `more than ${1 << 18} text elements; ppt/slides/slide2.xml and the parts after it are left unmarked`,
    );
  });

  it('inflates at most a budget of picture bytes to remove colour profiles', async () => {
    const png = (data: number) => {
      const head = [...sig, ...ihdr, ...iccp];
      const out = new Uint8Array(head.length + 12 + data + iend.length);
      out.set(head);
      out.set(
        [data >>> 24, (data >>> 16) & 255, (data >>> 8) & 255, data & 255, ...ascii('IDAT')],
        head.length,
      );
      out.set(iend, head.length + 12 + data);
      return out;
    };
    const z = new JSZip();
    for (let i = 1; i <= 8; i++) z.file(`ppt/media/image${i}.png`, png(300_000));
    const notes: string[] = [];
    expect(await stripColorProfiles(z, notes, 1_000_000)).toBe(true);
    const profiled = async (i: number) =>
      new TextDecoder('latin1')
        .decode(await z.file(`ppt/media/image${i}.png`)!.async('uint8array'))
        .includes('iCCP');
    // 256 KB looked at and 300 KB read for the first; the second does not fit in what is left.
    expect(await profiled(1)).toBe(false);
    for (const i of [2, 8]) expect(await profiled(i)).toBe(true);
    expect(notes).toEqual([
      '1 picture colour profile(s) removed',
      'colour profiles: pictures past 1 MB in all are left as they are',
    ]);
  });

  it("walks a picture's headers only up to its image data, and only so many", () => {
    // The rest of the file, from the image data on, is kept as it is.
    const tail = [...chunk('IDAT', [7, 7]), ...chunk('iCCP', [1]), ...iend];
    const png = Uint8Array.from([...sig, ...ihdr, ...iccp, ...tail]);
    expect(Array.from(withoutIccp(png)!)).toEqual([...sig, ...ihdr, ...tail]);
    // Thousands of chunks or segments before the image data: left as they are.
    const text = chunk('tEXt', []);
    const chunks = new Uint8Array(
      sig.length + ihdr.length + iccp.length + 100_000 * text.length + iend.length,
    );
    chunks.set([...sig, ...ihdr, ...iccp]);
    for (let i = 0; i < 100_000; i++)
      chunks.set(text, sig.length + ihdr.length + iccp.length + i * text.length);
    chunks.set(iend, chunks.length - iend.length);
    expect(withoutIccp(chunks)).toBeUndefined();
    const app = [0xff, 0xe0, 0, 2];
    const icc = [0xff, 0xe2, 0, 16, ...ascii('ICC_PROFILE'), 0, 1, 1];
    const segments = Uint8Array.from([0xff, 0xd8, ...icc, ...Array(10_000).fill(app).flat(), 0xff, 0xd9]);
    expect(withoutJpegIcc(segments)).toBeUndefined();
  });

  it('orders and places tens of thousands of slides in linear time', async () => {
    const n = 100_000;
    const names = Array.from({ length: n }, (_, i) => `slide${i + 1}`);
    const parts = names.map((s) => `ppt/slides/${s}.xml`);
    const xml = types([...names].reverse());
    // pptx-preview sorts by the number in the part name.
    const drawn = await within(5000, () => previewOrder(xml));
    expect(drawn).toEqual(parts);
    // The presentation shows them last first; the first is hidden.
    const placed = await within(5000, () => placeSlides([...parts].reverse(), drawn, new Set([parts[0]!])));
    expect(placed[0]).toBe(-1);
    expect(placed[1]).toBe(n - 2);
    expect(placed[n - 1]).toBe(0);
  });

  it('renames pictures in one pass over the content types, whatever their number', async () => {
    const n = 2000;
    const extra: Record<string, string> = {
      // 6 MB of content types: rewritten once per picture, that took nine seconds.
      '[Content_Types].xml':
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        Array.from(
          { length: n },
          (_, i) => `<Override PartName="/ppt/media/p${i}.png" ContentType="image/png"/>`,
        ).join('') +
        `<!--${' '.repeat(6_000_000)}--></Types>`,
    };
    for (let i = 0; i < n; i++) extra[`ppt/media/p${i}.png`] = `${i}`;
    const bytes = await deck('', extra);
    const a = await within(3000, () => annotatePptx(bytes));
    const z = await JSZip.loadAsync(a.bytes);
    expect(z.file('ppt/media/p0.png')).toBeNull();
    expect(await z.file(`ppt/media/image-ordo-p${n - 1}.png`)!.async('string')).toBe(`${n - 1}`);
    const ct = await z.file('[Content_Types].xml')!.async('string');
    expect(ct).toContain('PartName="/ppt/media/image-ordo-p0.png"');
    expect(ct).not.toContain('PartName="/ppt/media/p0.png"');
  });

  it('moves a compressed picture without inflating or changing it', async () => {
    const pixels = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7919) % 251);
    const z = await JSZip.loadAsync(await deck(''));
    z.file('ppt/media/Slide-1-image-1.png', pixels);
    const a = await annotatePptx(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    const out = await JSZip.loadAsync(a.bytes);
    expect(await out.file('ppt/media/image-ordo-Slide-1-image-1.png')!.async('uint8array')).toEqual(pixels);
  });

  it('reads part names and targets whose %-escapes do not decode as they are written', async () => {
    const ct =
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Override PartName="/ppt/notes/100%.xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/media/50%.png" ContentType="image/png"/></Types>';
    const slideRels =
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
      `<Relationship Id="rId2" Type="${REL}/image" Target="../media/50%.png"/></Relationships>`;
    const a = await annotatePptx(
      await deck('', {
        '[Content_Types].xml': ct,
        'ppt/media/50%.png': 'x',
        'ppt/slides/_rels/slide1.xml.rels': slideRels,
      }),
    );
    const z = await JSZip.loadAsync(a.bytes);
    expect(await z.file('ppt/media/image-ordo-50%.png')!.async('string')).toBe('x');
    expect(await z.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')).toContain(
      'Target="../media/image-ordo-50%.png"',
    );
    const types = await z.file('[Content_Types].xml')!.async('string');
    // The notes part is missing: its entry is dropped.
    expect(types).not.toContain('100%.xml');
    expect(types).toContain('PartName="/ppt/media/image-ordo-50%.png"');
  });

  it('stops when its signal aborts', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('cancelled'));
    await expect(annotatePptx(await deck(''), { signal: ctrl.signal })).rejects.toThrow('cancelled');
  });
});
