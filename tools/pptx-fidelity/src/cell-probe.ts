/*
 * The cell probe (1b `tables-cells`, design/27 §15 "LibreOffice's cell rules"): where LibreOffice 24.2 puts the
 * lines of centred cell text in rows with room, in rows its text fills (the row grew to it) and in rows its
 * text overflows (font-independent rows after an autogrow text box: the lines are drawn taller than the rows
 * were measured), with no top or bottom margin (`marT="0" marB="0"`, the left table) and with the default
 * ones (the right table); one line, three and six paragraphs, 107 % line spacing, 2 pt spacer paragraphs
 * between lines, a larger first paragraph and two sizes in one paragraph (the 666 chart's cells), in Carlito
 * (Calibri) 10 and 12 pt. Every row is one centred cell outlined with 1 pt black lines; rows are stored 1 pt
 * tall (they grow to their text) or with room for one or two more lines.
 *
 * LibreOffice's drawing of the deck gives each row's height and each line's baseline (`LO_CELL_ROWS`,
 * `LO_CELL_BASELINES`, LibreOffice 24.2.7), which the converter's model of it (`@ordo/pptx-scene`
 * `TableElement.lo`, `tables.ts` `loLayout`, `loGrowRows` and the anchoring of the lift) is checked against
 * (`cell-probe.test.ts`). To measure it again: `npx tsx src/cell-probe.ts <out.pptx>`, `soffice --headless
 * --convert-to pdf <out.pptx>` (a private profile), then per page `pdftocairo -svg` and `pdfRowEdges` /
 * `pdfBaselines` of the SVG: the borders are stroked paths and each glyph is placed at its baseline, so both
 * are exact, not read off a picture.
 */
import {
  AUTOGROW,
  BLACK,
  deckParts,
  EMU_PER_PT,
  EMU_PER_PX,
  GROUP_PROPS,
  HEAD,
  line,
  NS,
  SLIDE_W,
  strokes,
  zipStore,
} from './table-probe.ts';

/** The sizes probed, in points (Carlito, as LibreOffice draws Calibri). */
export const CELL_SIZES = [10, 12] as const;

/** One paragraph of a probe cell: its runs' sizes (an empty paragraph has none and its end mark `endPt`). */
export interface CellPara {
  readonly runs: readonly number[];
  /** `a:lnSpc` as a share (1.07: 107 %). */
  readonly line?: number;
  readonly endPt?: number;
}

/** One row of a probe table: its paragraphs and its stored height in points (1: it grows to its text). */
export interface CellRow {
  readonly name: string;
  readonly paras: readonly CellPara[];
  readonly storedPt: number;
}

const TEXT = 'Hamburgefonstiv 0123';

/**
 * The rows of a probe slide's tables at size `pt` (`part` 'a' or 'b'). Rows stored with room hold their
 * paragraphs' worth of lines plus one or two lines of about 1.25 × the size.
 */
export function cellRows(pt: number, part: 'a' | 'b'): CellRow[] {
  const p = (n: number, extra: Partial<CellPara> = {}): CellPara[] =>
    Array.from({ length: n }, () => ({ runs: [pt], ...extra }));
  const room = (lines: number) => Math.round(lines * pt * 1.25 * 100) / 100;
  const spacer: CellPara = { runs: [], endPt: 2 };
  if (part === 'a')
    return [
      { name: 'one', paras: p(1), storedPt: 1 },
      { name: 'three', paras: p(3), storedPt: 1 },
      { name: 'room1', paras: p(3), storedPt: room(4) },
      { name: 'room2', paras: p(3), storedPt: room(5) },
      { name: 'six', paras: p(6), storedPt: 1 },
    ];
  return [
    { name: 'pct107', paras: p(4, { line: 1.07 }), storedPt: 1 },
    { name: 'pct107room', paras: p(4, { line: 1.07 }), storedPt: room(6) },
    { name: 'spacers', paras: [...p(1), spacer, ...p(1), spacer, ...p(1)], storedPt: 1 },
    { name: 'larger', paras: [{ runs: [pt + 4], line: 1.07 }, ...p(3, { line: 1.07 })], storedPt: 1 },
    { name: 'tworuns', paras: [{ runs: [pt, pt + 4] }, { runs: [pt + 4, pt] }, ...p(1)], storedPt: 1 },
  ];
}

/** A probe slide: size, part, and whether an autogrow text box comes first (font-independent rows). */
export interface CellSlide {
  readonly pt: number;
  readonly part: 'a' | 'b';
  readonly autogrow: boolean;
}

/** The slides in order: font spacing (tables alone), then font-independent (after an autogrow text box). */
export function cellSlides(): CellSlide[] {
  return [false, true].flatMap((autogrow) =>
    CELL_SIZES.flatMap((pt) => (['a', 'b'] as const).map((part) => ({ pt, part, autogrow }))),
  );
}

/** The two tables' frames in slide px (one column each): no top or bottom margin, then the default ones. */
export const CELL_TABLES = [
  { x: 60, y: 40, w: 820, mar: ' marT="0" marB="0"' },
  { x: 1040, y: 40, w: 820, mar: '' },
] as const;

const rPr = (tag: 'rPr' | 'endParaRPr', pt: number) =>
  `<a:${tag} lang="en-US" sz="${Math.round(pt * 100)}" dirty="0">${BLACK}<a:latin typeface="Calibri"/></a:${tag}>`;

function paraXml(p: CellPara): string {
  const pPr =
    '<a:pPr algn="l">' +
    (p.line ? `<a:lnSpc><a:spcPct val="${Math.round(p.line * 100_000)}"/></a:lnSpc>` : '') +
    '</a:pPr>';
  if (!p.runs.length) return `<a:p>${pPr}${rPr('endParaRPr', p.endPt ?? 1)}</a:p>`;
  // Two runs share the text: each draws half of it.
  const words = TEXT.split(' ');
  const texts = p.runs.length === 1 ? [TEXT] : [`${words[0]} `, words.slice(1).join(' ')];
  const runs = p.runs.map((pt, i) => `<a:r>${rPr('rPr', pt)}<a:t>${texts[i] ?? ''}</a:t></a:r>`).join('');
  return `<a:p>${pPr}${runs}${rPr('endParaRPr', p.runs.at(-1)!)}</a:p>`;
}

function tableXml(id: number, at: (typeof CELL_TABLES)[number], rows: readonly CellRow[]): string {
  const e = (px: number) => String(Math.round(px * EMU_PER_PX));
  const cell = (r: CellRow) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${r.paras.map(paraXml).join('')}</a:txBody>` +
    `<a:tcPr anchor="ctr"${at.mar}>${line('lnL')}${line('lnR')}${line('lnT')}${line('lnB')}<a:noFill/></a:tcPr></a:tc>`;
  const h = (r: CellRow) => Math.round(r.storedPt * EMU_PER_PT);
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/>` +
    '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
    `<p:xfrm><a:off x="${e(at.x)}" y="${e(at.y)}"/><a:ext cx="${e(at.w)}" cy="${rows.reduce((s, r) => s + h(r), 0)}"/></p:xfrm>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
    `<a:tblPr/><a:tblGrid><a:gridCol w="${e(at.w)}"/></a:tblGrid>` +
    rows.map((r) => `<a:tr h="${h(r)}">${cell(r)}</a:tr>`).join('') +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
  );
}

/** One cell probe slide's XML: its two tables (after the autogrow text box when it has one). */
export function cellSlideXml(s: CellSlide): string {
  const rows = cellRows(s.pt, s.part);
  return (
    `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GROUP_PROPS}` +
    (s.autogrow ? AUTOGROW : '') +
    tableXml(2, CELL_TABLES[0], rows) +
    tableXml(3, CELL_TABLES[1], rows) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

/** The cell probe deck (.pptx bytes), with `docProps/app.xml` as PowerPoint writes it. */
export function cellProbeDeck(): Uint8Array {
  const enc = new TextEncoder();
  return zipStore(deckParts(cellSlides().map(cellSlideXml)).map(([name, xml]) => [name, enc.encode(xml)]));
}

/** One probe table as LibreOffice drew it: per row its height and its lines' baselines from the row's top. */
export type CellRowsLo = readonly (readonly [number, readonly number[]])[];

/**
 * LibreOffice 24.2.7's drawing of the cell probe deck, in 1/100 mm (its logic unit; the PDF's points divided by
 * the page's drawing scale, 0.998969, rounded: every value was within 0.13 of a whole one), per slide of
 * `cellSlides()`, the left table (no top or bottom margin) then the right one (the default margins): per row
 * its height (`pdfRowEdges`) and the baselines of its lines from the row's top (`pdfBaselines`). The rows are
 * the converter's model's (`loLayout`, `loGrowRows`; a stored row truncated to whole 1/100 mm), the lines at
 * the face's ascent and descent at 600 dpi, summed and then converted (10 pt Carlito: 428), centred
 * `trunc((inner - drawn) / 2)` below the inner top, and a block taller than the inner height (the
 * font-independent rows) starting there, its first baseline 1/100 mm above the face's ascent
 * (`tables.ts` `loBlockTop`).
 */
export const LO_CELL_PROBE: readonly (readonly [CellRowsLo, CellRowsLo])[] = [
  [
    [
      [429, [334]],
      [1285, [334, 762, 1190]],
      [1763, [573, 1001, 1429]],
      [2204, [794, 1222, 1650]],
      [2569, [334, 762, 1190, 1618, 2046, 2474]],
    ],
    [
      [683, [461]],
      [1539, [461, 889, 1317]],
      [1763, [573, 1001, 1429]],
      [2204, [794, 1222, 1650]],
      [2823, [461, 889, 1317, 1745, 2173, 2601]],
    ],
  ],
  [
    [
      [1829, [363, 820, 1277, 1734]],
      [2645, [771, 1228, 1685, 2142]],
      [1463, [334, 851, 1368]],
      [2015, [512, 1006, 1463, 1920]],
      [1631, [470, 1071, 1536]],
    ],
    [
      [2083, [490, 947, 1404, 1861]],
      [2645, [771, 1228, 1685, 2142]],
      [1717, [461, 978, 1495]],
      [2269, [639, 1133, 1590, 2047]],
      [1885, [597, 1198, 1663]],
    ],
  ],
  [
    [
      [517, [402]],
      [1549, [402, 918, 1434]],
      [2116, [686, 1202, 1718]],
      [2645, [950, 1466, 1982]],
      [3097, [402, 918, 1434, 1950, 2466, 2982]],
    ],
    [
      [771, [529]],
      [1803, [529, 1045, 1561]],
      [2116, [686, 1202, 1718]],
      [2645, [950, 1466, 1982]],
      [3351, [529, 1045, 1561, 2077, 2593, 3109]],
    ],
  ],
  [
    [
      [2209, [438, 990, 1542, 2094]],
      [3175, [921, 1473, 2025, 2577]],
      [1727, [402, 1007, 1612]],
      [2395, [586, 1176, 1728, 2280]],
      [1897, [538, 1228, 1782]],
    ],
    [
      [2463, [565, 1117, 1669, 2221]],
      [3175, [921, 1473, 2025, 2577]],
      [1981, [529, 1134, 1739]],
      [2649, [713, 1303, 1855, 2407]],
      [2151, [665, 1355, 1909]],
    ],
  ],
  [
    [
      [425, [333]],
      [1273, [333, 761, 1189]],
      [1763, [573, 1001, 1429]],
      [2204, [794, 1222, 1650]],
      [2545, [333, 761, 1189, 1617, 2045, 2473]],
    ],
    [
      [679, [460]],
      [1527, [460, 888, 1316]],
      [1763, [573, 1001, 1429]],
      [2204, [794, 1222, 1650]],
      [2799, [460, 888, 1316, 1744, 2172, 2600]],
    ],
  ],
  [
    [
      [1813, [362, 819, 1276, 1733]],
      [2645, [771, 1228, 1685, 2142]],
      [1443, [333, 850, 1367]],
      [1994, [511, 1005, 1462, 1919]],
      [1611, [469, 1070, 1535]],
    ],
    [
      [2067, [489, 946, 1403, 1860]],
      [2645, [771, 1228, 1685, 2142]],
      [1697, [460, 977, 1494]],
      [2248, [638, 1132, 1589, 2046]],
      [1865, [596, 1197, 1662]],
    ],
  ],
  [
    [
      [509, [401]],
      [1525, [401, 917, 1433]],
      [2116, [686, 1202, 1718]],
      [2645, [950, 1466, 1982]],
      [3049, [401, 917, 1433, 1949, 2465, 2981]],
    ],
    [
      [763, [528]],
      [1779, [528, 1044, 1560]],
      [2116, [686, 1202, 1718]],
      [2645, [950, 1466, 1982]],
      [3303, [528, 1044, 1560, 2076, 2592, 3108]],
    ],
  ],
  [
    [
      [2173, [437, 989, 1541, 2093]],
      [3175, [921, 1473, 2025, 2577]],
      [1695, [401, 1006, 1611]],
      [2354, [585, 1175, 1727, 2279]],
      [1863, [537, 1227, 1781]],
    ],
    [
      [2427, [564, 1116, 1668, 2220]],
      [3175, [921, 1473, 2025, 2577]],
      [1949, [528, 1133, 1738]],
      [2608, [712, 1302, 1854, 2406]],
      [2117, [664, 1354, 1908]],
    ],
  ],
];

const at4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * The y of each table's horizontal borders on one page, in PDF points from the page's top, sorted: from
 * `pdftocairo -svg` of LibreOffice's PDF (left of the slide's middle: the left table).
 */
export function pdfRowEdges(svg: string): [number[], number[]] {
  const ys: [Set<number>, Set<number>] = [new Set(), new Set()];
  for (const s of strokes(svg))
    if (Math.abs(s.y0 - s.y1) <= 1e-6) ys[s.x0 < SLIDE_W / 4 ? 0 : 1].add(at4(s.y0));
  return ys.map((set) => [...set].sort((p, q) => p - q)) as [number[], number[]];
}

/**
 * Every distinct glyph baseline on one page, per table, in PDF points from the page's top, sorted: the y of
 * each glyph `pdftocairo -svg` places (`<use xlink:href="#glyph-…" x=".." y=".."/>`), rounded to 1/10,000 pt.
 */
export function pdfBaselines(svg: string): [number[], number[]] {
  const ys: [Set<number>, Set<number>] = [new Set(), new Set()];
  for (const m of svg.matchAll(/<use xlink:href="#glyph-[^"]*" x="([\d.]+)" y="([\d.]+)"/g)) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    ys[x < SLIDE_W / 4 ? 0 : 1].add(at4(y));
  }
  return ys.map((set) => [...set].sort((p, q) => p - q)) as [number[], number[]];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) throw new Error('usage: cell-probe.ts <out.pptx>');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, cellProbeDeck());
}
