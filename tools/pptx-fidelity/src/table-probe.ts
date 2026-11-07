/*
 * The table row probe (design/27 §15 M6 tables, `--lo-compat` rule `cellRows`): table cells of one face and
 * size per slide, in the configurations real charts use (one line, three and seven paragraphs, 1 pt spacer
 * paragraphs between them, space after, 107 % line spacing, soft breaks, a 14 pt title over smaller text,
 * an empty cell), every row stored 1 pt tall so that it grows to its text, every cell centred (`anchor="ctr"`)
 * and outlined with 1 pt black lines; every slide once with its tables alone and once under a text box
 * that grows to its text. LibreOffice's drawing of the deck gives its row heights (`LO_PROBE_ROWS`,
 * LibreOffice 24.2.7), which the converter's LibreOffice row rule (`@ordo/pptx-scene` `TableElement.lo`,
 * `tables.ts` `LoLines`) is checked against (`table-probe.test.ts`). Two layouter slides follow
 * (`LAYOUT_SLIDES`, R2): merges from the first row and column against ones from the second, and 3 mm
 * columns, for LibreOffice's `TableLayouter` rules (`tables.ts` `loColumns`, `loGrowRows`;
 * `LO_PROBE_LAYOUT`).
 *
 * The deck is written here as XML (every byte of a cell is the probe's) in a zip stored without
 * compression. Slide space is 1920x1080 px at 6350 EMU per px, LibreOffice's PDF page at 144 dpi.
 *
 * `npx tsx src/table-probe.ts <out.pptx>` writes the deck. To measure it again: `soffice --headless
 * --convert-to pdf <out.pptx>`, then per page `pdftocairo -svg` and `pdfRowHeights` (`pdfColWidths`) of
 * the SVG: the tables' borders are stroked paths, so their positions are exact, not read off a picture.
 */

export const SLIDE_W = 1920;
export const SLIDE_H = 1080;
export const EMU_PER_PX = 6350;
const EMU_PER_PT = 12_700;

/** The faces probed, as decks name them (LibreOffice draws Calibri with Carlito, Arial with Liberation Sans). */
export const PROBE_FACES = [
  { family: 'Calibri', bold: false },
  { family: 'Calibri', bold: true },
  { family: 'Arial', bold: false },
] as const;
/** The sizes probed, in points. */
export const PROBE_SIZES = [6, 7, 8, 9, 14, 18] as const;

/** One paragraph of a probe cell: its runs' size (0: an empty paragraph whose end mark has `endPt`). */
export interface ProbePara {
  readonly pt: number;
  /** Soft breaks (`a:br`) inside the paragraph: it draws `breaks + 1` lines. */
  readonly breaks?: number;
  /** `a:spcAft` in points. */
  readonly after?: number;
  /** `a:lnSpc` as a share (1.07: 107 %). */
  readonly line?: number;
  /** The end mark's size of an empty paragraph. */
  readonly endPt?: number;
}

/** The rows of one probe slide's two tables, by name (the names `LO_PROBE_ROWS` uses). */
export function probeRows(pt: number): { left: [string, ProbePara[]][]; right: [string, ProbePara[]][] } {
  const n = (k: number, p: ProbePara) => Array.from({ length: k }, () => p);
  const spaced = (k: number) => {
    const out: ProbePara[] = [];
    for (let i = 0; i < k; i++) out.push(...(i ? [{ pt: 0, endPt: 1 }] : []), { pt });
    return out;
  };
  return {
    left: [
      ['one', [{ pt }]],
      ['three', n(3, { pt })],
      ['seven', n(7, { pt })],
      ['spacers', spaced(3)],
    ],
    right: [
      ['after', n(3, { pt, after: 6 })],
      ['pct107', n(3, { pt, line: 1.07 })],
      ['breaks', [{ pt, breaks: 2 }]],
      ['title', [{ pt: 14 }, { pt }]],
      ['empty', [{ pt: 0, endPt: pt }]],
    ],
  };
}

/** A probe slide: face and size, and whether a text box that grows to its text comes before the tables. */
export interface ProbeSlide {
  readonly family: string;
  readonly bold: boolean;
  readonly pt: number;
  readonly autogrow: boolean;
}

/**
 * The slides in order: every face at every size with the tables alone on the slide, then all of them again
 * under a text box with `a:spAutoFit` (LibreOffice then sizes the rows with font-independent spacing).
 */
export function probeSlides(): ProbeSlide[] {
  return [false, true].flatMap((autogrow) =>
    PROBE_FACES.flatMap((f) => PROBE_SIZES.map((pt) => ({ family: f.family, bold: f.bold, pt, autogrow }))),
  );
}

/** The two tables' frames in slide px: left and right, each one column. */
export const TABLES = [
  { x: 60, y: 60, w: 820 },
  { x: 1040, y: 60, w: 820 },
] as const;

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';
const TEXT = 'Hamburgefonstiv 0123';

const BLACK = '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>';
const line = (tag: string) =>
  `<a:${tag} w="${EMU_PER_PT}" cap="flat" cmpd="sng" algn="ctr">${BLACK}<a:prstDash val="solid"/></a:${tag}>`;

function rPr(tag: 'rPr' | 'endParaRPr', s: ProbeSlide, pt: number): string {
  return (
    `<a:${tag} lang="en-US" sz="${Math.round(pt * 100)}"${s.bold ? ' b="1"' : ''} dirty="0">${BLACK}` +
    `<a:latin typeface="${s.family}"/></a:${tag}>`
  );
}

function paraXml(s: ProbeSlide, p: ProbePara): string {
  const pPr =
    '<a:pPr algn="l">' +
    (p.line ? `<a:lnSpc><a:spcPct val="${Math.round(p.line * 100_000)}"/></a:lnSpc>` : '') +
    (p.after ? `<a:spcAft><a:spcPts val="${Math.round(p.after * 100)}"/></a:spcAft>` : '') +
    '</a:pPr>';
  if (!p.pt) return `<a:p>${pPr}${rPr('endParaRPr', s, p.endPt ?? 1)}</a:p>`;
  let runs = `<a:r>${rPr('rPr', s, p.pt)}<a:t>${TEXT}</a:t></a:r>`;
  for (let i = 0; i < (p.breaks ?? 0); i++)
    runs += `<a:br>${rPr('rPr', s, p.pt)}</a:br><a:r>${rPr('rPr', s, p.pt)}<a:t>${TEXT}</a:t></a:r>`;
  return `<a:p>${pPr}${runs}${rPr('endParaRPr', s, p.pt)}</a:p>`;
}

function tableXml(s: ProbeSlide, id: number, at: (typeof TABLES)[number], rows: [string, ProbePara[]][]) {
  const e = (px: number) => String(Math.round(px * EMU_PER_PX));
  const cell = (paras: ProbePara[]) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paras.map((p) => paraXml(s, p)).join('')}</a:txBody>` +
    `<a:tcPr anchor="ctr">${line('lnL')}${line('lnR')}${line('lnT')}${line('lnB')}<a:noFill/></a:tcPr></a:tc>`;
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/>` +
    '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
    `<p:xfrm><a:off x="${e(at.x)}" y="${e(at.y)}"/><a:ext cx="${e(at.w)}" cy="${rows.length * EMU_PER_PT}"/></p:xfrm>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
    `<a:tblPr/><a:tblGrid><a:gridCol w="${e(at.w)}"/></a:tblGrid>` +
    rows.map(([, paras]) => `<a:tr h="${EMU_PER_PT}">${cell(paras)}</a:tr>`).join('') +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
  );
}

const GROUP_PROPS =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** A text box at the slide's bottom that grows to its one line of text (`a:spAutoFit`). */
const AUTOGROW =
  '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Note"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>' +
  `<a:xfrm><a:off x="${60 * EMU_PER_PX}" y="${960 * EMU_PER_PX}"/><a:ext cx="${600 * EMU_PER_PX}" cy="${60 * EMU_PER_PX}"/></a:xfrm>` +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0">' +
  `<a:spAutoFit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1800" dirty="0">${BLACK}` +
  '<a:latin typeface="Calibri"/></a:rPr><a:t>Note</a:t></a:r></a:p></p:txBody></p:sp>';

/** One probe slide's XML: its two tables (after the autogrow text box when it has one). */
export function slideXml(s: ProbeSlide): string {
  const rows = probeRows(s.pt);
  return (
    `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GROUP_PROPS}` +
    (s.autogrow ? AUTOGROW : '') +
    tableXml(s, 2, TABLES[0], rows.left) +
    tableXml(s, 3, TABLES[1], rows.right) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

/**
 * One cell of a layouter slide's table: its `a:tc` attributes (spans, covered), its `a:tcPr` margin
 * attributes, and how many paragraphs of text it holds (0: one empty paragraph).
 */
export interface LayoutCell {
  readonly attrs?: string;
  readonly mar?: string;
  readonly lines: number;
}

/** A layouter slide's table: its grid columns in EMU and its rows of cells (one `a:tc` per column). */
export interface LayoutTable {
  readonly cols: readonly number[];
  readonly rows: readonly (readonly LayoutCell[])[];
}

/** Calibri 14 pt, so that a line of the probe's text fits a 400 px column with any margins here. */
export const LAYOUT_FACE: ProbeSlide = { family: 'Calibri', bold: false, pt: 14, autogrow: false };
/** Margins of 508/100 mm each (a cell minimum of 1,116/100 mm) and none (a minimum of 1 mm). */
const WIDE = ' marL="182880" marR="182880"';
const TIGHT = ' marL="0" marR="0"';
/** A 3 mm grid column (300/100 mm): narrower than any cell's minimum with the default margins. */
const NARROW = 300 * 360;
const PX400 = 400 * EMU_PER_PX;

/**
 * The layouter slides (R2), after the probe slides, for LibreOffice 24.2's `TableLayouter` rules: each
 * with a left and a right table. `mergedRows`: a cell of three paragraphs over two rows of one line,
 * merged from the first row on the left (LibreOffice puts its whole height on its last row) and from the
 * second on the right (its height less the row before). `narrowColumn`: a 3 mm column under a merge of
 * wide margins, the merge from the first column on the left (its whole minimum on the narrow column); on
 * the right from the second column, over the narrow column and another 3 mm one, the first widened to
 * its own cell's minimum with the default margins (608/100 mm) and the second to the merge's minimum less
 * that (the narrow columns' cells are empty: text in them would have 1 mm).
 */
export const LAYOUT_SLIDES: readonly {
  readonly name: string;
  /** What LibreOffice's drawing of it is measured for (`LO_PROBE_LAYOUT`). */
  readonly measure: 'rows' | 'cols';
  readonly tables: readonly [LayoutTable, LayoutTable];
}[] = [
  {
    name: 'mergedRows',
    measure: 'rows',
    tables: [
      {
        cols: [PX400, PX400],
        rows: [
          [{ lines: 1 }, { attrs: 'rowSpan="2"', lines: 3 }],
          [{ lines: 1 }, { attrs: 'vMerge="1"', lines: 0 }],
          [{ lines: 1 }, { lines: 1 }],
        ],
      },
      {
        cols: [PX400, PX400],
        rows: [
          [{ lines: 1 }, { lines: 1 }],
          [{ lines: 1 }, { attrs: 'rowSpan="2"', lines: 3 }],
          [{ lines: 1 }, { attrs: 'vMerge="1"', lines: 0 }],
        ],
      },
    ],
  },
  {
    name: 'narrowColumn',
    measure: 'cols',
    tables: [
      {
        cols: [PX400, NARROW, PX400],
        rows: [
          [
            { attrs: 'gridSpan="2"', mar: WIDE, lines: 1 },
            { attrs: 'hMerge="1"', lines: 0 },
            { mar: TIGHT, lines: 1 },
          ],
          [
            { mar: TIGHT, lines: 1 },
            { mar: TIGHT, lines: 0 },
            { mar: TIGHT, lines: 1 },
          ],
        ],
      },
      {
        cols: [PX400, NARROW, NARROW],
        rows: [
          [
            { mar: TIGHT, lines: 1 },
            { attrs: 'gridSpan="2"', mar: WIDE, lines: 0 },
            { attrs: 'hMerge="1"', lines: 0 },
          ],
          [{ mar: TIGHT, lines: 1 }, { lines: 0 }, { mar: TIGHT, lines: 0 }],
        ],
      },
    ],
  },
];

function layoutTableXml(id: number, x: number, t: LayoutTable): string {
  const s = LAYOUT_FACE;
  const cell = (c: LayoutCell) => {
    const paras: ProbePara[] = c.lines
      ? Array.from({ length: c.lines }, () => ({ pt: s.pt }))
      : [{ pt: 0, endPt: s.pt }];
    return (
      `<a:tc${c.attrs ? ` ${c.attrs}` : ''}><a:txBody><a:bodyPr/><a:lstStyle/>` +
      `${paras.map((p) => paraXml(s, p)).join('')}</a:txBody><a:tcPr anchor="ctr"${c.mar ?? ''}>` +
      `${line('lnL')}${line('lnR')}${line('lnT')}${line('lnB')}<a:noFill/></a:tcPr></a:tc>`
    );
  };
  const cx = t.cols.reduce((a, w) => a + w, 0);
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/>` +
    '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
    `<p:xfrm><a:off x="${x * EMU_PER_PX}" y="${60 * EMU_PER_PX}"/><a:ext cx="${cx}" cy="${t.rows.length * EMU_PER_PT}"/></p:xfrm>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
    `<a:tblPr/><a:tblGrid>${t.cols.map((w) => `<a:gridCol w="${w}"/>`).join('')}</a:tblGrid>` +
    t.rows.map((r) => `<a:tr h="${EMU_PER_PT}">${r.map(cell).join('')}</a:tr>`).join('') +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
  );
}

/** A layouter slide's XML: its two tables at the probe tables' places. */
export function layoutSlideXml(l: (typeof LAYOUT_SLIDES)[number]): string {
  return (
    `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GROUP_PROPS}` +
    layoutTableXml(2, TABLES[0].x, l.tables[0]) +
    layoutTableXml(3, TABLES[1].x, l.tables[1]) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

const CLR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

function themeXml(): string {
  const clr = (n: string, v: string) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const ln = `<a:ln w="9525">${solid}</a:ln>`;
  const font = '<a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>';
  return (
    `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Probe"><a:themeElements>` +
    '<a:clrScheme name="Probe"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
    clr('dk2', '44546A') +
    clr('lt2', 'E7E6E6') +
    ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47']
      .map((v, i) => clr(`accent${i + 1}`, v))
      .join('') +
    clr('hlink', '0563C1') +
    clr('folHlink', '954F72') +
    `</a:clrScheme><a:fontScheme name="Probe"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont>` +
    `</a:fontScheme><a:fmtScheme name="Probe"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>` +
    `<a:lnStyleLst>${ln}${ln}${ln}</a:lnStyleLst><a:effectStyleLst>` +
    '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3) +
    `</a:effectStyleLst><a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme>` +
    '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  );
}

function relsXml(rels: readonly [string, string, string][]): string {
  return (
    `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels
      .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
      .join('') +
    '</Relationships>'
  );
}

/**
 * The probe deck's parts, by name, in the order they are written. `app` (default on) writes
 * `docProps/app.xml` as PowerPoint does: LibreOffice lays out a document PowerPoint wrote with
 * font-independent line spacing (see `LO_PROBE_ROWS`), and almost every real deck has one.
 */
export function probeParts(app = true): [string, string][] {
  const slides = [...probeSlides().map(slideXml), ...LAYOUT_SLIDES.map(layoutSlideXml)];
  const nums = slides.map((_, i) => i + 1);
  const types =
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT}.theme+xml"/>` +
    (app ? `<Override PartName="/docProps/app.xml" ContentType="${CT}.extended-properties+xml"/>` : '') +
    nums
      .map(
        (i) =>
          `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="${CT}.presentationml.slide+xml"/>`,
      )
      .join('') +
    '</Types>';
  const presentation =
    `${HEAD}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${nums.map((i) => `<p:sldId id="${255 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_W * EMU_PER_PX}" cy="${SLIDE_H * EMU_PER_PX}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    '</p:presentation>';
  const master =
    `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>` +
    `<a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP_PROPS}</p:spTree></p:cSld>` +
    `<p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
    '</p:sldMaster>';
  const layout =
    `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP_PROPS}</p:spTree>` +
    '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
  const parts: [string, string][] = [
    ['[Content_Types].xml', types],
    [
      '_rels/.rels',
      relsXml([
        ['rId1', 'officeDocument', 'ppt/presentation.xml'],
        ...(app ? [['rId2', 'extended-properties', 'docProps/app.xml'] as [string, string, string]] : []),
      ]),
    ],
    ['ppt/presentation.xml', presentation],
    [
      'ppt/_rels/presentation.xml.rels',
      relsXml([
        ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
        ['rId2', 'theme', 'theme/theme1.xml'],
        ...nums.map((i): [string, string, string] => [`rId${i + 2}`, 'slide', `slides/slide${i}.xml`]),
      ]),
    ],
    ['ppt/theme/theme1.xml', themeXml()],
    ['ppt/slideMasters/slideMaster1.xml', master],
    [
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      relsXml([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'theme', '../theme/theme1.xml'],
      ]),
    ],
    ['ppt/slideLayouts/slideLayout1.xml', layout],
    [
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      relsXml([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    ],
  ];
  if (app)
    parts.push([
      'docProps/app.xml',
      `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
        '<Application>Microsoft Office PowerPoint</Application><AppVersion>16.0000</AppVersion></Properties>',
    ]);
  slides.forEach((xml, i) => {
    parts.push([`ppt/slides/slide${i + 1}.xml`, xml]);
    parts.push([
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    ]);
  });
  return parts;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of `files` stored without compression, dated 1980-01-01, so the same parts give the same bytes. */
export function zipStore(files: readonly [string, Uint8Array][]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_DATE = (1 << 5) | 1;
  for (const [name, data] of files) {
    const n = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, n.length, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(14, DOS_DATE, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, n.length, true);
    dir.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), n, data);
    central.push(new Uint8Array(dir.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
  let at = 0;
  for (const a of all) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

/** The probe deck (.pptx bytes); `app` as `probeParts`. */
export function probeDeck(app = true): Uint8Array {
  const enc = new TextEncoder();
  return zipStore(probeParts(app).map(([name, xml]) => [name, enc.encode(xml)]));
}

/**
 * The straight strokes of a page from `pdftocairo -svg` of LibreOffice's PDF (the tables' borders), in PDF
 * points: `matrix(a, 0, 0, -a, 0, ty)` maps a path's (x, y) to (a·x, ty - a·y).
 */
function strokes(svg: string): { x0: number; y0: number; x1: number; y1: number }[] {
  const re =
    /<path fill="none"[^>]*?d="M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+) "[^>]*?transform="matrix\(([\d.]+), 0, 0, -([\d.]+), 0, ([\d.]+)\)"/g;
  const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const m of svg.matchAll(re)) {
    const [x0, y0, x1, y1, a, , ty] = m.slice(1).map(Number) as number[];
    out.push({ x0: a! * x0!, y0: ty! - a! * y0!, x1: a! * x1!, y1: ty! - a! * y1! });
  }
  return out;
}

/** Differences of the sorted distinct positions of each table's set, to 1/10,000 pt. */
function gaps(sets: [Set<number>, Set<number>]): [number[], number[]] {
  return sets.map((set) => {
    const v = [...set].sort((p, q) => p - q);
    return v.slice(1).map((y, i) => Math.round((y - v[i]!) * 10_000) / 10_000);
  }) as [number[], number[]];
}

const at4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * Row heights in PDF points of each probe table on one page, from `pdftocairo -svg` of LibreOffice's PDF:
 * the y of every horizontal stroke (a table border), grouped by table (left of the slide's middle or
 * right), differences of the sorted distinct positions.
 */
export function pdfRowHeights(svg: string): [number[], number[]] {
  const ys: [Set<number>, Set<number>] = [new Set(), new Set()];
  for (const s of strokes(svg))
    if (Math.abs(s.y0 - s.y1) <= 1e-6) ys[s.x0 < SLIDE_W / 4 ? 0 : 1].add(at4(s.y0));
  return gaps(ys);
}

/**
 * Column widths in PDF points of each table on one page (the layouter slides), as `pdfRowHeights` but
 * from the x of every vertical stroke.
 */
export function pdfColWidths(svg: string): [number[], number[]] {
  const xs: [Set<number>, Set<number>] = [new Set(), new Set()];
  for (const s of strokes(svg))
    if (Math.abs(s.x0 - s.x1) <= 1e-6) xs[s.x0 < SLIDE_W / 4 ? 0 : 1].add(at4(s.x0));
  return gaps(xs);
}

/**
 * LibreOffice 24.2.7's row heights of the probe deck in PDF points (`pdfRowHeights`, rounded to 0.01 pt),
 * per slide of `probeSlides()`: the left table's rows (one, three, seven, spacers), then the right one's
 * (after, pct107, breaks, title, empty). The PDF page is LibreOffice's slide scaled by 0.99897, so these
 * are about 0.1 % short of LibreOffice's own sizes.
 */
export const LO_PROBE_ROWS: readonly (readonly [readonly number[], readonly number[]])[] = [
  [
    [14.53, 29.14, 58.36, 31.52],
    [41.14, 30.67, 29.14, 31.55, 14.53],
  ],
  [
    [15.74, 32.79, 66.89, 35.17],
    [44.8, 34.58, 32.79, 32.76, 15.75],
  ],
  [
    [17.05, 36.7, 76.0, 39.08],
    [48.7, 38.74, 36.7, 34.07, 17.05],
  ],
  [
    [18.15, 40.01, 83.73, 42.39],
    [52.02, 42.3, 40.01, 35.17, 18.15],
  ],
  [
    [24.24, 58.28, 126.35, 60.66],
    [70.28, 61.85, 58.28, 41.26, 24.24],
  ],
  [
    [29.16, 73.06, 160.84, 75.44],
    [85.06, 77.65, 73.06, 46.18, 29.17],
  ],
  [
    [14.53, 29.14, 58.36, 31.52],
    [41.14, 30.67, 29.14, 31.55, 14.53],
  ],
  [
    [15.74, 32.79, 66.89, 35.17],
    [44.8, 34.58, 32.79, 32.76, 15.75],
  ],
  [
    [17.05, 36.7, 76.0, 39.08],
    [48.7, 38.74, 36.7, 34.07, 17.05],
  ],
  [
    [18.15, 40.01, 83.73, 42.39],
    [52.02, 42.3, 40.01, 35.17, 18.15],
  ],
  [
    [24.24, 58.28, 126.35, 60.66],
    [70.28, 61.85, 58.28, 41.26, 24.24],
  ],
  [
    [29.16, 73.06, 160.84, 75.44],
    [85.06, 77.65, 73.06, 46.18, 29.17],
  ],
  [
    [13.96, 27.44, 54.4, 29.59],
    [39.45, 28.8, 27.44, 29.68, 13.96],
  ],
  [
    [15.01, 30.58, 61.73, 32.73],
    [42.59, 32.2, 30.58, 30.73, 15.01],
  ],
  [
    [16.23, 34.23, 70.25, 36.39],
    [46.24, 36.11, 34.23, 31.94, 16.23],
  ],
  [
    [17.3, 37.46, 77.79, 39.62],
    [49.47, 39.5, 37.46, 33.02, 17.3],
  ],
  [
    [22.94, 54.37, 117.23, 56.52],
    [66.38, 57.6, 54.37, 38.65, 22.93],
  ],
  [
    [27.36, 67.62, 148.16, 69.77],
    [79.63, 71.78, 67.62, 43.07, 27.35],
  ],
  [
    [14.41, 28.8, 57.57, 31.18],
    [40.8, 30.24, 28.8, 31.2, 14.41],
  ],
  [
    [15.6, 32.37, 65.89, 34.75],
    [44.37, 34.07, 32.37, 32.39, 15.6],
  ],
  [
    [16.79, 35.93, 74.22, 38.31],
    [47.94, 37.89, 35.93, 33.59, 16.79],
  ],
  [
    [18.04, 39.67, 82.94, 42.05],
    [51.68, 41.88, 39.68, 34.83, 18.04],
  ],
  [
    [24.01, 57.6, 124.77, 59.98],
    [69.6, 61.08, 57.6, 40.8, 24.01],
  ],
  [
    [28.8, 71.96, 158.27, 74.33],
    [83.96, 76.46, 71.95, 45.59, 28.8],
  ],
  [
    [14.41, 28.8, 57.57, 31.18],
    [40.8, 30.24, 28.8, 31.2, 14.41],
  ],
  [
    [15.6, 32.37, 65.89, 34.75],
    [44.37, 34.07, 32.37, 32.39, 15.6],
  ],
  [
    [16.79, 35.93, 74.22, 38.31],
    [47.94, 37.89, 35.93, 33.59, 16.79],
  ],
  [
    [18.04, 39.67, 82.94, 42.05],
    [51.68, 41.88, 39.68, 34.83, 18.04],
  ],
  [
    [24.01, 57.6, 124.77, 59.98],
    [69.6, 61.08, 57.6, 40.8, 24.01],
  ],
  [
    [28.8, 71.96, 158.27, 74.33],
    [83.96, 76.46, 71.95, 45.59, 28.8],
  ],
  [
    [14.41, 28.8, 57.57, 31.18],
    [40.8, 30.24, 28.8, 31.2, 14.41],
  ],
  [
    [15.6, 32.37, 65.89, 34.75],
    [44.37, 34.07, 32.37, 32.39, 15.6],
  ],
  [
    [16.79, 35.93, 74.22, 38.31],
    [47.94, 37.89, 35.93, 33.59, 16.79],
  ],
  [
    [18.04, 39.67, 82.94, 42.05],
    [51.68, 41.88, 39.68, 34.83, 18.04],
  ],
  [
    [24.01, 57.6, 124.77, 59.98],
    [69.6, 61.08, 57.6, 40.8, 24.01],
  ],
  [
    [28.8, 71.96, 158.27, 74.33],
    [83.96, 76.46, 71.95, 45.59, 28.8],
  ],
];

/**
 * LibreOffice 24.2.7's sizes of the layouter slides in PDF points (`pdfRowHeights`, `pdfColWidths`, rounded
 * to 0.01 pt; the page is the slide at 0.99897, as for `LO_PROBE_ROWS`), per slide of `LAYOUT_SLIDES`, the
 * left table then the right one: `mergedRows`' rows (row 1 holds the whole merge from the first row, 2,055
 * of 1/100 mm; from the second row, row 2 holds 2,055 less row 1's 855), `narrowColumn`'s columns (the 3 mm
 * column is the merge's 1,116/100 mm from the first column; from the second, 608 and 1,116 less 608).
 */
export const LO_PROBE_LAYOUT: readonly (readonly [readonly number[], readonly number[]])[] = [
  [
    [24.24, 58.28, 24.24],
    [24.24, 24.24, 34.04],
  ],
  [
    [199.78, 31.6, 199.78],
    [199.78, 17.21, 14.39],
  ],
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) throw new Error('usage: table-probe.ts <out.pptx> [--no-app]');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, probeDeck(process.argv[3] !== '--no-app'));
}
