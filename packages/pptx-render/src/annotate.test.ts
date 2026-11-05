import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { annotatePptx, withoutIccp, withoutJpegIcc } from './annotate.ts';
import { decodeMarker, encodeMarker, MARK_START, MAX_MARKED_RUNS } from './markers.ts';

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

async function deck(slideBody: string, extra: Record<string, string> = {}): Promise<Uint8Array> {
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
      const { end: _end, ...rest } = a.paras[i]!;
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

  it('lists slide pictures drawn in an ellipse or a rounded rectangle, in presentation order', async () => {
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
      }),
    );
    expect(a.pictures).toEqual([
      { slide: 0, x: 0, y: 10, w: 200, h: 100, shape: 'ellipse' },
      // A tenth of the shorter side.
      { slide: 0, x: 1, y: 10, w: 200, h: 100, shape: 'roundRect', radius: 10 },
    ]);
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
