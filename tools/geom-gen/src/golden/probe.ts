/*
 * The preset probe deck of the preset golden (design/27 §14 item 6, §15 M6 exit): every preset geometry at its
 * default adjust values, six to a 16:9 slide, each in a known box with its own solid fill and a dark outline, so
 * LibreOffice's drawing of the deck and drawGeom's drawing of the same boxes can be compared preset by preset.
 *
 * The deck is written here as XML (no generator library: every byte of the shape is the probe's), stored in a
 * zip without compression. Slide space is 1920x1080 px at 6350 EMU per px, which is what LibreOffice's PDF of a
 * 13.333 x 7.5 in slide becomes at 144 dpi (pdftoppm -r 144, as the fidelity harness draws LibreOffice pages).
 */

/** Slide size in px (the PDF page at 144 dpi) and EMU per px. */
export const SLIDE_W = 1920;
export const SLIDE_H = 1080;
export const EMU_PER_PX = 6350;

/** Cells per slide (3 x 2) and their size in px. */
export const COLS = 3;
export const ROWS = 2;
export const CELL_W = SLIDE_W / COLS;
export const CELL_H = SLIDE_H / ROWS;

/**
 * The shape's box in its cell: 360x240 px (3:2, so a formula that mixes up w, h, ss and ls shows), placed so the
 * callouts' leader lines (up to 0.47 w left of the box and 0.13 h below it) and the wave's swing (0.29 h above and
 * below) stay inside the cell.
 */
export const BOX_W = 360;
export const BOX_H = 240;
export const BOX_X = 200;
export const BOX_Y = 150;

/** The outline: 3 px (1.5 pt), round joins and flat caps, written explicitly so neither side picks a default. */
export const OUTLINE_PX = 3;
export const OUTLINE_RGB = { r: 0x20, g: 0x20, b: 0x20 } as const;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface PxRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One preset of the probe: its slide (0-based), cell and box in slide px, and its fill. */
export interface ProbeShape {
  readonly name: string;
  readonly slide: number;
  readonly cell: PxRect;
  readonly box: PxRect;
  readonly fill: Rgb;
}

/** A fill per index: hues a golden angle apart at one saturation and lightness (HSL), so neighbours differ. */
export function probeFill(i: number): Rgb {
  const h = (i * 137.508) % 360;
  const s = 0.55;
  const l = 0.6;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const sextants: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r1, g1, b1] = sextants[Math.min(5, Math.floor(hp))]!;
  const m = l - c / 2;
  const to = (v: number) => Math.round((v + m) * 255);
  return { r: to(r1), g: to(g1), b: to(b1) };
}

/** The probe's layout: `names` in order, six to a slide, row by row. */
export function probeLayout(names: readonly string[]): ProbeShape[] {
  const per = COLS * ROWS;
  return names.map((name, i) => {
    const slot = i % per;
    const cell = { x: (slot % COLS) * CELL_W, y: Math.floor(slot / COLS) * CELL_H, w: CELL_W, h: CELL_H };
    return {
      name,
      slide: Math.floor(i / per),
      cell,
      box: { x: cell.x + BOX_X, y: cell.y + BOX_Y, w: BOX_W, h: BOX_H },
      fill: probeFill(i),
    };
  });
}

/** Slides of a layout. */
export function slideCount(shapes: readonly ProbeShape[]): number {
  return shapes.reduce((n, s) => Math.max(n, s.slide + 1), 0);
}

const hex = (c: Rgb) => [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');

/** XML attribute text (preset names are [A-Za-z0-9]; escaped all the same). */
function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument';

/** The p:sp of one probe shape: prstGeom with an empty avLst, solid fill, explicit outline, no text. */
export function shapeXml(s: ProbeShape, id: number): string {
  const e = (px: number) => String(Math.round(px * EMU_PER_PX));
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${attr(s.name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${e(s.box.x)}" y="${e(s.box.y)}"/><a:ext cx="${e(s.box.w)}" cy="${e(s.box.h)}"/></a:xfrm>` +
    `<a:prstGeom prst="${attr(s.name)}"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${hex(s.fill)}"/></a:solidFill>` +
    `<a:ln w="${e(OUTLINE_PX)}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="${hex(OUTLINE_RGB)}"/></a:solidFill>` +
    `<a:prstDash val="solid"/><a:round/><a:headEnd type="none"/><a:tailEnd type="none"/></a:ln>` +
    `</p:spPr></p:sp>`
  );
}

const GROUP_PROPS =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function slideXml(shapes: readonly ProbeShape[]): string {
  return (
    `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GROUP_PROPS}` +
    shapes.map((s, i) => shapeXml(s, i + 2)).join('') +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

const CLR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

function masterXml(): string {
  return (
    `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>` +
    `<a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP_PROPS}</p:spTree></p:cSld>` +
    `<p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
    '</p:sldMaster>'
  );
}

function layoutXml(): string {
  return (
    `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP_PROPS}</p:spTree>` +
    '</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  );
}

function themeXml(): string {
  const clr = (n: string, v: string) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (w: number) =>
    `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${solid}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  const font = (latin: string) => `<a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  return (
    `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Probe"><a:themeElements>` +
    '<a:clrScheme name="Probe"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    clr('dk2', '44546A') +
    clr('lt2', 'E7E6E6') +
    clr('accent1', '4472C4') +
    clr('accent2', 'ED7D31') +
    clr('accent3', 'A5A5A5') +
    clr('accent4', 'FFC000') +
    clr('accent5', '5B9BD5') +
    clr('accent6', '70AD47') +
    clr('hlink', '0563C1') +
    clr('folHlink', '954F72') +
    '</a:clrScheme>' +
    `<a:fontScheme name="Probe"><a:majorFont>${font('Liberation Sans')}</a:majorFont>` +
    `<a:minorFont>${font('Liberation Sans')}</a:minorFont></a:fontScheme>` +
    '<a:fmtScheme name="Probe">' +
    `<a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst>` +
    '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
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

/** The parts of the probe deck, by name, in the order they are written. */
export function probeParts(shapes: readonly ProbeShape[]): [string, string][] {
  const n = slideCount(shapes);
  const slides = Array.from({ length: n }, (_, i) => i + 1);
  const types =
    `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT}.theme+xml"/>` +
    slides
      .map(
        (i) =>
          `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="${CT}.presentationml.slide+xml"/>`,
      )
      .join('') +
    '</Types>';
  const presentation =
    `${HEAD}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${slides.map((i) => `<p:sldId id="${255 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_W * EMU_PER_PX}" cy="${SLIDE_H * EMU_PER_PX}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    '</p:presentation>';
  const parts: [string, string][] = [
    ['[Content_Types].xml', types],
    ['_rels/.rels', relsXml([['rId1', 'officeDocument', 'ppt/presentation.xml']])],
    ['ppt/presentation.xml', presentation],
    [
      'ppt/_rels/presentation.xml.rels',
      relsXml([
        ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
        ['rId2', 'theme', 'theme/theme1.xml'],
        ...slides.map((i): [string, string, string] => [`rId${i + 2}`, 'slide', `slides/slide${i}.xml`]),
      ]),
    ],
    ['ppt/theme/theme1.xml', themeXml()],
    ['ppt/slideMasters/slideMaster1.xml', masterXml()],
    [
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      relsXml([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'theme', '../theme/theme1.xml'],
      ]),
    ],
    ['ppt/slideLayouts/slideLayout1.xml', layoutXml()],
    [
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      relsXml([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    ],
  ];
  for (const i of slides) {
    parts.push([`ppt/slides/slide${i}.xml`, slideXml(shapes.filter((s) => s.slide === i - 1))]);
    parts.push([
      `ppt/slides/_rels/slide${i}.xml.rels`,
      relsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    ]);
  }
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

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip of `files` stored without compression, with fixed times (1980-01-01), so the same parts always give the
 * same bytes.
 */
export function zipStore(files: readonly [string, Uint8Array][]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
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

/** The probe deck (.pptx bytes) of a layout. */
export function probeDeck(shapes: readonly ProbeShape[]): Uint8Array {
  const enc = new TextEncoder();
  return zipStore(probeParts(shapes).map(([name, xml]) => [name, enc.encode(xml)]));
}
