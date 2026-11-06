import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyModifiers,
  type BlipReader,
  type ColorCtx,
  colorContext,
  colorIn,
  fillOf,
  MAX_GRADIENT_STOPS,
  MAX_MODIFIERS,
  PRESET_COLORS,
  readColor,
  readFill,
  styleEntry,
  styleFill,
} from './color.ts';
import { parseDeck } from './index.ts';
import type { Fill, Rgba, SlideScene } from './ir.ts';
import type { PartSource } from './opc.ts';
import { buildDeck, NS_A, type SlideSpec, scheme, solid, solidBg, sp, themeXml } from './test-util.ts';
import { readTheme } from './theme.ts';
import { parseXml, rootOf, type XNode } from './xml.ts';

// ── Probe decks ─────────────────────────────────────────────────────────────────────────────────────────
//
// Each probe is a colour element drawn as a filled cell on a white slide. `lo` is the colour LibreOffice
// 24.2 draws (read from `soffice --convert-to pdf` and `pdftoppm`), composited over white. The unit tests
// below check that the parser resolves every probe to that colour; `ORDO_LO_PROBE=1` renders the same deck
// through LibreOffice and checks the table itself (needs soffice and pdftoppm on the PATH).

const srgb = (hex: string, mods = '') =>
  mods ? `<a:srgbClr val="${hex}">${mods}</a:srgbClr>` : `<a:srgbClr val="${hex}"/>`;
const m = (name: string, val: number) => `<a:${name} val="${val}"/>`;

/** Colour elements on a white slide with the default colour map: [name, element, LibreOffice's colour]. */
const ELEMENT_PROBES: [string, string, string][] = [
  // Elements.
  ['srgb', srgb('4472C4'), '4472C4'],
  ['srgb lower case', srgb('ff8000'), 'FF8000'],
  ['scheme accent2', scheme('accent2'), 'ED7D31'],
  ['scheme dk2', scheme('dk2'), '44546A'],
  ['scheme tx2', scheme('tx2'), '44546A'],
  ['scheme bg1', scheme('bg1'), 'FFFFFF'],
  ['sys windowText', '<a:sysClr val="windowText" lastClr="000000"/>', '000000'],
  ['sys window', '<a:sysClr val="window" lastClr="FFFFFF"/>', 'FFFFFF'],
  ['sys windowText lastClr red', '<a:sysClr val="windowText" lastClr="FF0000"/>', '000000'],
  ['sys highlight', '<a:sysClr val="highlight" lastClr="3399FF"/>', '316AC5'],
  ['sys btnFace no lastClr', '<a:sysClr val="btnFace"/>', 'ECE9D8'],
  ['prst aliceBlue', '<a:prstClr val="aliceBlue"/>', 'F0F8FF'],
  ['prst dkGray', '<a:prstClr val="dkGray"/>', 'A9A9A9'],
  ['prst ltGoldenrodYellow', '<a:prstClr val="ltGoldenrodYellow"/>', 'FAFA78'],
  ['prst medPurple', '<a:prstClr val="medPurple"/>', '9370DB'],
  ['prst teal', '<a:prstClr val="teal"/>', '008080'],
  ['prst darkBlue', '<a:prstClr val="darkBlue"/>', 'FFFFFF'],
  ['prst grey', '<a:prstClr val="grey"/>', 'FFFFFF'],
  ['scrgb 50 0 100', '<a:scrgbClr r="50000" g="0" b="100000"/>', 'BC00FF'],
  ['scrgb 21.4', '<a:scrgbClr r="21404" g="21404" b="21404"/>', '828282'],
  ['scrgb 80 60 5', '<a:scrgbClr r="80000" g="60000" b="5000"/>', 'E7CC45'],
  ['hsl red', '<a:hslClr hue="0" sat="100000" lum="50000"/>', 'FF0000'],
  ['hsl 120 50 25', '<a:hslClr hue="7200000" sat="50000" lum="25000"/>', '206020'],
  ['hsl 210 60 70', '<a:hslClr hue="12600000" sat="60000" lum="70000"/>', '85B3E0'],
  // tint and shade (linear light).
  ['black tint 95', srgb('000000', m('tint', 95000)), '454545'],
  ['black tint 50', srgb('000000', m('tint', 50000)), 'BCBCBC'],
  ['black tint 75', srgb('000000', m('tint', 75000)), '8B8B8B'],
  ['red tint 40', srgb('FF0000', m('tint', 40000)), 'FFCCCC'],
  ['4472C4 tint 60', srgb('4472C4', m('tint', 60000)), 'B0BBDE'],
  ['4472C4 tint 0', srgb('4472C4', m('tint', 0)), 'FFFFFF'],
  ['white shade 50', srgb('FFFFFF', m('shade', 50000)), 'BCBCBC'],
  ['4472C4 shade 75', srgb('4472C4', m('shade', 75000)), '3C64AC'],
  ['red shade 25', srgb('FF0000', m('shade', 25000)), '8B0000'],
  ['gray shade 95', srgb('808080', m('shade', 95000)), '7D7D7D'],
  // lum, sat, hue (HSL).
  ['4472C4 lumMod 75', srgb('4472C4', m('lumMod', 75000)), '2F5597'],
  ['4472C4 lumMod 50', srgb('4472C4', m('lumMod', 50000)), '203864'],
  ['4472C4 lighter 80', srgb('4472C4', m('lumMod', 20000) + m('lumOff', 80000)), 'DAE3F3'],
  ['4472C4 lighter 40', srgb('4472C4', m('lumMod', 60000) + m('lumOff', 40000)), '8FAADC'],
  ['black lighter 35', srgb('000000', m('lumMod', 65000) + m('lumOff', 35000)), '595959'],
  ['white lumMod 85', srgb('FFFFFF', m('lumMod', 85000)), 'D9D9D9'],
  ['white lumOff -15', srgb('FFFFFF', m('lumOff', -15000)), 'D9D9D9'],
  ['ED7D31 lumOff 120', srgb('ED7D31', m('lumOff', 120000)), 'FFFFFF'],
  ['4472C4 satMod 150', srgb('4472C4', m('satMod', 150000)), '2469E4'],
  ['4472C4 satMod 50', srgb('4472C4', m('satMod', 50000)), '647BA4'],
  ['4472C4 satOff 20', srgb('4472C4', m('satOff', 20000)), '2B6BDD'],
  ['4472C4 satOff -20', srgb('4472C4', m('satOff', -20000)), '5D79AB'],
  ['4472C4 hueMod 50', srgb('4472C4', m('hueMod', 50000)), '5BC444'],
  ['4472C4 hueOff 60', srgb('4472C4', m('hueOff', 3600000)), '9644C4'],
  ['4472C4 hueOff -20', srgb('4472C4', m('hueOff', -1200000)), '449DC4'],
  ['4472C4 hueOff 180', srgb('4472C4', m('hueOff', 10800000)), 'C44444'],
  ['4472C4 hue 120', srgb('4472C4', m('hue', 7200000)), '44C444'],
  ['4472C4 sat 50', srgb('4472C4', m('sat', 50000)), '4773C2'],
  ['4472C4 lum 30', srgb('4472C4', m('lum', 30000)), '254174'],
  ['4472C4 lum 0 lumOff 50', srgb('4472C4', m('lum', 0) + m('lumOff', 50000)), '808080'],
  // Other modifiers.
  ['4472C4 comp', srgb('4472C4', '<a:comp/>'), 'C49644'],
  ['4472C4 inv', srgb('4472C4', '<a:inv/>'), 'F9ECB4'],
  ['ED7D31 gray', srgb('ED7D31', '<a:gray/>'), '919191'],
  ['808080 gamma', srgb('808080', '<a:gamma/>'), 'BCBCBC'],
  ['808080 invGamma', srgb('808080', '<a:invGamma/>'), '343434'],
  ['4472C4 red 0', srgb('4472C4', m('red', 0)), '0071C3'],
  ['4472C4 redMod 50', srgb('4472C4', m('redMod', 50000)), '3271C3'],
  ['4472C4 redOff 20', srgb('4472C4', m('redOff', 20000)), '8B71C3'],
  ['4472C4 green 100', srgb('4472C4', m('green', 100000)), '43FFC3'],
  ['4472C4 greenMod 200', srgb('4472C4', m('greenMod', 200000)), '439AC3'],
  ['4472C4 greenOff -20', srgb('4472C4', m('greenOff', -20000)), '4300C3'],
  ['4472C4 blue 0', srgb('4472C4', m('blue', 0)), '437100'],
  ['4472C4 blueMod 50', srgb('4472C4', m('blueMod', 50000)), '437190'],
  ['4472C4 blueOff 50', srgb('4472C4', m('blueOff', 50000)), '4371FF'],
  // Alpha (over white).
  ['black alpha 50', srgb('000000', m('alpha', 50000)), '7F7F7F'],
  ['black alpha 80 alphaMod 50', srgb('000000', m('alpha', 80000) + m('alphaMod', 50000)), '999999'],
  ['black alphaOff -30', srgb('000000', m('alphaOff', -30000)), '4C4C4C'],
  ['4472C4 alpha 25', srgb('4472C4', m('alpha', 25000)), 'D0DBF0'],
  // Order matters.
  ['4472C4 tint 50 lumMod 50', srgb('4472C4', m('tint', 50000) + m('lumMod', 50000)), '405391'],
  ['4472C4 lumMod 50 tint 50', srgb('4472C4', m('lumMod', 50000) + m('tint', 50000)), 'BDBFC5'],
  // Office 2007 theme stops.
  ['accent1 tint 50 satMod 300', scheme('accent1', m('tint', 50000) + m('satMod', 300000)), 'A4B9FF'],
  ['accent1 tint 37 satMod 300', scheme('accent1', m('tint', 37000) + m('satMod', 300000)), 'BFCCFF'],
  ['accent1 tint 15 satMod 350', scheme('accent1', m('tint', 15000) + m('satMod', 350000)), 'E6ECFF'],
  ['accent1 shade 51 satMod 130', scheme('accent1', m('shade', 51000) + m('satMod', 130000)), '2451A0'],
  ['accent1 shade 93 satMod 130', scheme('accent1', m('shade', 93000) + m('satMod', 130000)), '2E69D0'],
  ['accent2 shade 30 satMod 200', scheme('accent2', m('shade', 30000) + m('satMod', 200000)), 'A94500'],
  ['accent6 tint 98 satMod 300', scheme('accent6', m('tint', 98000) + m('satMod', 300000)), '62FF01'],
  ['tx1 lumMod 85 lumOff 15', scheme('tx1', m('lumMod', 85000) + m('lumOff', 15000)), '262626'],
  // Modifiers on every kind of element.
  ['bg1 lumMod 95', scheme('bg1', m('lumMod', 95000)), 'F2F2F2'],
  ['tx1 lumMod 50 lumOff 50', scheme('tx1', m('lumMod', 50000) + m('lumOff', 50000)), '808080'],
  [
    'window lumMod 65',
    '<a:sysClr val="window" lastClr="FFFFFF"><a:lumMod val="65000"/></a:sysClr>',
    'A6A6A6',
  ],
  ['prst teal shade 50', '<a:prstClr val="teal"><a:shade val="50000"/></a:prstClr>', '005E5E'],
  [
    'hsl 210 60 70 lumMod 50',
    '<a:hslClr hue="12600000" sat="60000" lum="70000"><a:lumMod val="50000"/></a:hslClr>',
    '24598F',
  ],
  [
    'scrgb 80 60 5 tint 50',
    '<a:scrgbClr r="80000" g="60000" b="5000"><a:tint val="50000"/></a:scrgbClr>',
    'F3E7C0',
  ],
  [
    'scrgb 80 60 5 satMod 50',
    '<a:scrgbClr r="80000" g="60000" b="5000"><a:satMod val="50000"/></a:scrgbClr>',
    'BFB16E',
  ],
  ['red satMod 150', srgb('FF0000', m('satMod', 150000)), 'FF0000'],
  ['FFC000 hueOff 90 shade 80', srgb('FFC000', m('hueOff', 5400000) + m('shade', 80000)), '00E73A'],
  ['4472C4 lumMod 0', srgb('4472C4', m('lumMod', 0)), '000000'],
  ['4472C4 tint over 100', srgb('4472C4', m('tint', 150000)), '4371C3'],
];

const MAP_ATTRS = (o: Record<string, string>) =>
  Object.entries({
    bg1: 'lt1',
    tx1: 'dk1',
    bg2: 'lt2',
    tx2: 'dk2',
    accent1: 'accent1',
    accent2: 'accent2',
    accent3: 'accent3',
    accent4: 'accent4',
    accent5: 'accent5',
    accent6: 'accent6',
    hlink: 'hlink',
    folHlink: 'folHlink',
    ...o,
  })
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
const override = (o: Record<string, string>) =>
  `<p:clrMapOvr><a:overrideClrMapping ${MAP_ATTRS(o)}/></p:clrMapOvr>`;
const styleRef = (idx: number, color: string) =>
  `<p:style><a:lnRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef><a:fillRef idx="${idx}">${color}</a:fillRef>` +
  `<a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>`;

/** A cell: by its colour element (drawn as the shape's own fill) or by a `p:style` fill reference. */
interface Cell {
  name: string;
  color?: string;
  style?: string;
  lo: string;
}

interface ProbeSlide {
  /** Names the slide's background and master probes. */
  label: string;
  cells: Cell[];
  spec: Omit<SlideSpec, 'shapes'>;
  /** LibreOffice's background colour, read from the cell left free for it. */
  bg: string;
  /** The master's decoration (`schemeClr tx1`) as LibreOffice draws it on this slide. */
  master: string;
}

/** Theme fill and background styles with modifiers on `phClr` (Office 2007's are like these). */
const PROBE_FMT =
  '<a:fmtScheme name="Probe"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  `<a:solidFill>${scheme('phClr', m('tint', 50000) + m('satMod', 300000))}</a:solidFill>` +
  `<a:solidFill>${scheme('phClr', m('shade', 51000) + m('satMod', 130000))}</a:solidFill></a:fillStyleLst>` +
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  `<a:solidFill>${scheme('phClr', m('shade', 60000) + m('satMod', 120000))}</a:solidFill>` +
  `<a:solidFill>${scheme('phClr', m('lumMod', 80000))}</a:solidFill></a:bgFillStyleLst></a:fmtScheme>`;

const COLS = 12;
const ROWS = 8;
/** The last cell of every slide is the master's decoration; the one before it is left for the background. */
const MASTER_CELL = COLS * ROWS - 1;
const BG_CELL = COLS * ROWS - 2;
const PER_SLIDE = BG_CELL;

const PROBE_SLIDES: ProbeSlide[] = [];
for (let i = 0; i < ELEMENT_PROBES.length; i += PER_SLIDE)
  PROBE_SLIDES.push({
    label: `elements ${i / PER_SLIDE + 1}`,
    cells: ELEMENT_PROBES.slice(i, i + PER_SLIDE).map(([name, color, lo]) => ({ name, color, lo })),
    spec: { bg: solidBg('FFFFFF') },
    bg: 'FFFFFF',
    master: '000000',
  });
PROBE_SLIDES.push(
  {
    // The slide's own colour map: its shapes, the master's background and decoration follow it.
    label: 'slide map',
    spec: {
      after: override({ bg1: 'dk1', tx1: 'lt1', bg2: 'dk2', tx2: 'lt2', accent1: 'accent6' }),
    },
    cells: [
      { name: 'slide map bg1', color: scheme('bg1'), lo: '000000' },
      { name: 'slide map tx1', color: scheme('tx1'), lo: 'FFFFFF' },
      { name: 'slide map bg2', color: scheme('bg2'), lo: '44546A' },
      { name: 'slide map tx2 lumMod 60', color: scheme('tx2', m('lumMod', 60000)), lo: '8D8888' },
      { name: 'slide map accent1', color: scheme('accent1'), lo: '70AD47' },
      { name: 'slide map dk1', color: scheme('dk1'), lo: '000000' },
    ],
    bg: 'FFFFFF',
    master: '000000',
  },
  {
    // The layout's colour map, for a slide that keeps its master's mapping.
    label: 'layout map',
    spec: { layout: 2 },
    cells: [
      { name: 'layout map bg1', color: scheme('bg1'), lo: '44546A' },
      { name: 'layout map tx1', color: scheme('tx1'), lo: 'E7E6E6' },
      { name: 'layout map accent1', color: scheme('accent1'), lo: 'A5A5A5' },
      { name: 'layout map accent2', color: scheme('accent2'), lo: 'ED7D31' },
    ],
    bg: '44546A',
    master: 'E7E6E6',
  },
  {
    // The slide's colour map over its layout's.
    label: 'both maps',
    spec: { layout: 2, after: override({ accent1: 'accent4' }) },
    cells: [
      { name: 'both maps bg1', color: scheme('bg1'), lo: 'FFFFFF' },
      { name: 'both maps tx1', color: scheme('tx1'), lo: '000000' },
      { name: 'both maps accent1', color: scheme('accent1'), lo: 'FFC000' },
    ],
    bg: '44546A',
    master: 'E7E6E6',
  },
  {
    // Style references: phClr takes the reference's colour, then its own modifiers.
    label: 'style refs',
    spec: { bg: `<p:bg><p:bgRef idx="1002">${scheme('accent5')}</p:bgRef></p:bg>` },
    cells: [
      { name: 'fillRef 1 accent2', style: styleRef(1, scheme('accent2')), lo: 'ED7D31' },
      { name: 'fillRef 2 accent1', style: styleRef(2, scheme('accent1')), lo: 'A4B9FF' },
      {
        name: 'fillRef 3 accent1 lumMod 75',
        style: styleRef(3, scheme('accent1', m('lumMod', 75000))),
        lo: '173C7C',
      },
      { name: 'fillRef 2 srgb C00000', style: styleRef(2, srgb('C00000')), lo: 'FF9F9F' },
      {
        name: 'fillRef 1 accent1 alpha 50',
        style: styleRef(1, scheme('accent1', m('alpha', 50000))),
        lo: '4472C4',
      },
      { name: 'fillRef 2 prst teal', style: styleRef(2, '<a:prstClr val="teal"/>'), lo: 'ACDCDC' },
    ],
    bg: '3E7DB4',
    master: '000000',
  },
);

/**
 * Where the parser deliberately differs from LibreOffice (design/27 §4): probe name → [the parser's colour,
 * why]. LibreOffice's own colour stays in the table above, so the LibreOffice run still checks it.
 */
const DIFFERENT: ReadonlyMap<string, [string, string]> = new Map([
  ['sys windowText lastClr red', ['FF0000', 'sysClr uses lastClr; LibreOffice uses a fixed palette']],
  ['sys highlight', ['3399FF', 'sysClr uses lastClr; LibreOffice uses a fixed palette']],
  ['prst ltGoldenrodYellow', ['FAFAD2', "ECMA-376's value; LibreOffice has FAFA78"]],
  ['prst darkBlue', ['00008B', 'an ECMA-376 name LibreOffice does not know (it draws no fill)']],
  ['prst grey', ['808080', 'an ECMA-376 name LibreOffice does not know (it draws no fill)']],
  ['slide map background', ['000000', "the slide's colour map applies to the inherited background"]],
  ['slide map master tx1', ['FFFFFF', "the slide's colour map applies to master shapes"]],
  ['both maps background', ['FFFFFF', "the slide's colour map applies to the inherited background"]],
  ['both maps master tx1', ['000000', "the slide's colour map applies to master shapes"]],
  ['fillRef 1 accent1 alpha 50', ['A2B9E2', "phClr keeps the reference's alpha; LibreOffice drops it"]],
]);

const SLIDE_CX = 12_192_000;
const SLIDE_CY = 6_858_000;
const CELL_CX = SLIDE_CX / COLS;
const CELL_CY = SLIDE_CY / ROWS;
const NO_LINE = '<a:ln><a:noFill/></a:ln>';

function cellBox(i: number) {
  const x = Math.round((i % COLS) * CELL_CX + CELL_CX * 0.15);
  const y = Math.round(Math.floor(i / COLS) * CELL_CY + CELL_CY * 0.15);
  return { x, y, cx: Math.round(CELL_CX * 0.7), cy: Math.round(CELL_CY * 0.7) };
}

/** The probe deck: one cell per probe, the master's decoration in the last cell of every slide. */
function probeDeck(): PartSource {
  return buildDeck({
    theme: themeXml({ fmtScheme: PROBE_FMT }),
    master: {
      shapes: sp({
        id: 2,
        name: 'master tx1',
        ...cellBox(MASTER_CELL),
        fill: solid(scheme('tx1')),
        ln: NO_LINE,
      }),
    },
    layouts: [
      {},
      { after: override({ bg1: 'dk2', tx1: 'lt2', bg2: 'dk1', tx2: 'lt1', accent1: 'accent3' }) },
    ],
    slides: PROBE_SLIDES.map((s) => ({
      ...s.spec,
      shapes: s.cells
        .map((c, i) =>
          sp({
            id: 10 + i,
            name: c.name,
            ...cellBox(i),
            ...(c.color ? { fill: solid(c.color) } : {}),
            ...(c.style ? { style: c.style } : {}),
            ln: NO_LINE,
          }),
        )
        .join(''),
    })),
  });
}

/** Every probe with its slide (0-based), cell and LibreOffice colour: cells, then background and master. */
function probeTable(): { slide: number; cell: number; name: string; lo: string }[] {
  return PROBE_SLIDES.flatMap((s, slide) => [
    ...s.cells.map((c, cell) => ({ slide, cell, name: c.name, lo: c.lo })),
    { slide, cell: BG_CELL, name: `${s.label} background`, lo: s.bg },
    { slide, cell: MASTER_CELL, name: `${s.label} master tx1`, lo: s.master },
  ]);
}

const hex = (c: Rgba) =>
  [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0').toUpperCase()).join('');
/** A colour composited over white, as a probe cell shows it. */
const overWhite = (c: Rgba) =>
  hex({ r: 255 + (c.r - 255) * c.a, g: 255 + (c.g - 255) * c.a, b: 255 + (c.b - 255) * c.a, a: 1 });
const fillHex = (f: Fill | undefined) =>
  f?.kind === 'solid' ? overWhite(f.color) : f?.kind === 'none' ? 'FFFFFF' : `(${f?.kind})`;

// ── LibreOffice run (ORDO_LO_PROBE=1) ───────────────────────────────────────────────────────────────────

/** A zip with stored (uncompressed) entries. */
function storedZip(parts: PartSource): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of parts) {
    const n = enc.encode(name);
    const crc = crc32(data);
    const head = (sig: number, size: number) => {
      const h = new DataView(new ArrayBuffer(size));
      h.setUint32(0, sig, true);
      return h;
    };
    const l = head(0x04034b50, 30 + n.length);
    l.setUint16(4, 20, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, n.length, true);
    new Uint8Array(l.buffer).set(n, 30);
    const c = head(0x02014b50, 46 + n.length);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, offset, true);
    new Uint8Array(c.buffer).set(n, 46);
    local.push(new Uint8Array(l.buffer), data);
    central.push(new Uint8Array(c.buffer));
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, parts.size, true);
  end.setUint16(10, parts.size, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
  let at = 0;
  for (const a of all) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

interface Page {
  w: number;
  h: number;
  rgb: Uint8Array;
}

/** A binary PPM (P6, maxval 255). */
function readPpm(b: Uint8Array): Page {
  const fields: string[] = [];
  let i = 0;
  while (fields.length < 4) {
    while (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09) i++;
    let s = '';
    while (b[i] !== 0x20 && b[i] !== 0x0a && b[i] !== 0x0d && b[i] !== 0x09)
      s += String.fromCharCode(b[i++]!);
    fields.push(s);
  }
  if (fields[0] !== 'P6' || fields[3] !== '255') throw new Error('not a P6 PPM');
  return { w: Number(fields[1]), h: Number(fields[2]), rgb: b.subarray(i + 1) };
}

/** Render a deck with LibreOffice (PDF, then pdftoppm at 24 dpi): one page per slide. */
function renderWithLibreOffice(parts: PartSource): Page[] {
  const dir = mkdtempSync(join(tmpdir(), 'pptx-scene-probe-'));
  try {
    writeFileSync(join(dir, 'probe.pptx'), storedZip(parts));
    const env = { PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8' };
    execFileSync(
      'soffice',
      [
        `-env:UserInstallation=file://${dir}/profile`,
        '--headless',
        '--norestore',
        '--nolockcheck',
        '--convert-to',
        'pdf',
        '--outdir',
        dir,
        join(dir, 'probe.pptx'),
      ],
      { env, stdio: 'ignore', timeout: 120_000 },
    );
    execFileSync('pdftoppm', ['-r', '24', join(dir, 'probe.pdf'), join(dir, 'page')], {
      env,
      timeout: 60_000,
    });
    return readdirSync(dir)
      .filter((f) => /^page-\d+\.ppm$/.test(f))
      .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]))
      .map((f) => readPpm(readFileSync(join(dir, f))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The colour at the centre of a cell. */
function cellColor(page: Page, cell: number): string {
  const x = Math.floor(((cell % COLS) + 0.5) * (page.w / COLS));
  const y = Math.floor((Math.floor(cell / COLS) + 0.5) * (page.h / ROWS));
  const o = (y * page.w + x) * 3;
  return hex({ r: page.rgb[o]!, g: page.rgb[o + 1]!, b: page.rgb[o + 2]!, a: 1 });
}

describe.skipIf(!process.env.ORDO_LO_PROBE)('LibreOffice probe', () => {
  it('draws every probe as the table says', () => {
    const pages = renderWithLibreOffice(probeDeck());
    expect(pages.length).toBe(PROBE_SLIDES.length);
    const got = probeTable().map((p) => ({ ...p, got: cellColor(pages[p.slide]!, p.cell) }));
    const wrong = got
      .filter((p) => p.got !== p.lo)
      .map((p) => `${p.name}: table ${p.lo}, LibreOffice ${p.got}`);
    if (process.env.ORDO_LO_PROBE_OUT)
      writeFileSync(process.env.ORDO_LO_PROBE_OUT, JSON.stringify(got, null, 1));
    expect(wrong).toEqual([]);
  }, 180_000);
});

// ── The parser against the table ────────────────────────────────────────────────────────────────────────

/** Channels within `tol` of each other (LibreOffice rounds blends over white down, we round to nearest). */
function near(a: string, b: string, tol: number): boolean {
  if (a.length !== 6 || b.length !== 6) return a === b;
  for (let i = 0; i < 6; i += 2)
    if (Math.abs(Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16)) > tol)
      return false;
  return true;
}

/** The fill the parser read for a probe cell: the background's, the master decoration's or the shape's. */
function probeFill(slide: SlideScene, cell: number, name: string): Fill | undefined {
  if (cell === BG_CELL) return slide.background.fill;
  const e = slide.elements.find((el) => el.name === (cell === MASTER_CELL ? 'master tx1' : name));
  return e?.kind === 'shape' ? e.fill : undefined;
}

describe('probe deck through parseDeck', () => {
  const scene = parseDeck(probeDeck());
  const table = probeTable();

  it('has one slide per probe slide and every probe', () => {
    expect(scene.slides.length).toBe(PROBE_SLIDES.length);
    expect(new Set(table.map((p) => p.name)).size).toBe(table.length);
    for (const name of DIFFERENT.keys()) expect(table.map((p) => p.name)).toContain(name);
  });

  it.each(table.map((p) => [p.name, p] as const))('%s', (_name, p) => {
    const fill = probeFill(scene.slides[p.slide]!, p.cell, p.name);
    const want = DIFFERENT.get(p.name)?.[0] ?? p.lo;
    const tol = fill?.kind === 'solid' && fill.color.a < 1 ? 1 : 0;
    expect(near(fillHex(fill), want, tol), `${fillHex(fill)} for ${want}`).toBe(true);
  });
});

// ── Elements, modifiers, maps and fills ─────────────────────────────────────────────────────────────────

/** One element parsed from XML (the `a:` prefix needs no declaration in tests, but one is given). */
function xml(s: string): XNode {
  const root = rootOf(parseXml(`<t xmlns:a="${NS_A}">${s}</t>`, 'test'))!;
  return root.children.find((c) => c.name !== '#text')!;
}
const THEME = readTheme(rootOf(parseXml(themeXml({ fmtScheme: PROBE_FMT }), 'theme')));
const CTX: ColorCtx = colorContext(THEME, undefined);
const color = (s: string, ctx = CTX) => readColor(xml(s), ctx);
const hexOf = (s: string, ctx = CTX) => {
  const c = color(s, ctx);
  return c ? hex(c) : undefined;
};

describe('readColor', () => {
  it('resolves nothing for an unknown name, a bad hex value or phClr outside a style', () => {
    expect(color(scheme('accent9'))).toBeUndefined();
    expect(color('<a:prstClr val="notAColour"/>')).toBeUndefined();
    expect(color('<a:prstClr val="__proto__"/>')).toBeUndefined();
    expect(color(scheme('phClr'))).toBeUndefined();
    expect(color(srgb('GG0000'))).toBeUndefined();
    expect(color(srgb('FFF'))).toBeUndefined();
    expect(color('<a:sysClr val="noSuchColour"/>')).toBeUndefined();
    expect(color('<a:bogusClr val="FF0000"/>')).toBeUndefined();
    expect(readFill(xml(`<p:spPr>${solid(scheme('accent9'))}</p:spPr>`), CTX)).toEqual({ kind: 'none' });
  });

  it('keeps alpha from 0 to 1 and channels as integers 0-255', () => {
    expect(color(srgb('4472C4', m('alpha', 25000)))).toEqual({ r: 68, g: 114, b: 196, a: 0.25 });
    expect(color(srgb('000000', m('alpha', 150000)))?.a).toBe(1); // out of range: ignored
    expect(color(srgb('000000', m('alpha', 50000) + m('alphaOff', 80000)))?.a).toBe(1);
    expect(color(srgb('000000', m('alphaMod', 200000)))?.a).toBe(1);
  });

  it('reads NaN, Infinity and unreadable values as 0, and clamps the rest as LibreOffice does', () => {
    expect(hexOf(srgb('4472C4', '<a:lumMod val="NaN"/>'))).toBe('000000');
    expect(hexOf(srgb('4472C4', '<a:lumMod val="1e999"/>'))).toBe('000000');
    expect(hexOf(srgb('4472C4', '<a:lumMod/>'))).toBe('000000');
    expect(hexOf(srgb('4472C4', m('lumMod', 99_999_999_999)))).toBe('FFFFFF');
    expect(hexOf('<a:scrgbClr r="Infinity" g="-5" b="250000"/>')).toBe('0000FF');
    expect(hexOf('<a:hslClr hue="-1" sat="999999" lum="50000"/>')).toBe('FF0000');
    expect(hexOf('<a:hslClr hue="99999999999" sat="100000" lum="50000"/>')).toBe('FF0000');
  });

  it('gives a valid colour for any modifier and value', () => {
    const names = (
      'alpha alphaMod alphaOff red redMod redOff green greenMod greenOff blue blueMod blueOff hue hueMod ' +
      'hueOff sat satMod satOff lum lumMod lumOff shade tint gray comp inv gamma invGamma'
    ).split(' ');
    const values = '0 -1 50000 100000 100001 -100000 21600000 1e9 NaN -Infinity x 7.5'.split(' ');
    const bases: [string, string][] = [
      ['a:srgbClr', 'val="4472C4"'],
      ['a:srgbClr', 'val="000000"'],
      ['a:scrgbClr', 'r="100000" g="100000" b="100000"'],
      ['a:hslClr', 'hue="0" sat="0" lum="100000"'],
    ];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return (seed >>> 16) % n;
    };
    for (let i = 0; i < 2_000; i++) {
      const mods = Array.from(
        { length: 1 + rnd(5) },
        () => `<a:${names[rnd(names.length)]} val="${values[rnd(values.length)]}"/>`,
      ).join('');
      const [tag, attrs] = bases[rnd(bases.length)]!;
      const el = `<${tag} ${attrs}>${mods}</${tag}>`;
      const c = color(el)!;
      for (const v of [c.r, c.g, c.b]) expect(Number.isInteger(v) && v >= 0 && v <= 255, el).toBe(true);
      expect(c.a >= 0 && c.a <= 1, el).toBe(true);
    }
  });

  it(`reads at most ${MAX_MODIFIERS} modifiers of one colour`, () => {
    const many = (n: number) => srgb('FFFFFF', m('lumMod', 95000).repeat(n));
    expect(hexOf(many(MAX_MODIFIERS + 10))).toBe(hexOf(many(MAX_MODIFIERS)));
    expect(hexOf(many(MAX_MODIFIERS))).not.toBe(hexOf(many(MAX_MODIFIERS - 1)));
  });

  it('reads Strict percentages', () => {
    expect(hexOf(srgb('4472C4', '<a:lumMod val="75%"/>'))).toBe('2F5597');
    expect(hexOf('<a:scrgbClr r="50%" g="0%" b="100%"/>')).toBe('BC00FF');
  });

  it('applies the modifiers of an element to a given colour', () => {
    expect(hex(applyModifiers({ r: 0, g: 0, b: 0, a: 1 }, xml(srgb('FFFFFF', m('tint', 95000)))))).toBe(
      '454545',
    );
    expect(applyModifiers({ r: 1, g: 2, b: 3, a: 0.5 }, xml(srgb('FFFFFF')))).toEqual({
      r: 1,
      g: 2,
      b: 3,
      a: 0.5,
    });
  });

  it('resolves phClr to the style colour, its alpha kept, then applies its own modifiers', () => {
    const ctx = { ...CTX, phClr: { r: 0, g: 0, b: 0, a: 0.5 } };
    expect(color(scheme('phClr', m('tint', 95000)), ctx)).toEqual({ r: 69, g: 69, b: 69, a: 0.5 });
    expect(color(scheme('phClr', m('alpha', 20000)), ctx)?.a).toBe(0.2);
  });
});

describe('PRESET_COLORS', () => {
  it("holds all 190 names of ECMA-376's table", () => {
    expect(PRESET_COLORS.size).toBe(190);
    expect(PRESET_COLORS.get('darkBlue')).toBe(PRESET_COLORS.get('dkBlue'));
    expect(PRESET_COLORS.get('lightGoldenrodYellow')).toBe(0xfafad2);
    expect(PRESET_COLORS.get('mediumVioletRed')).toBe(0xc71585);
    expect(PRESET_COLORS.get('darkSlateGrey')).toBe(0x2f4f4f);
    expect(PRESET_COLORS.get('ltSlateGrey')).toBe(0x778899);
    expect(PRESET_COLORS.get('grey')).toBe(0x808080);
    expect(PRESET_COLORS.has('medGrey')).toBe(false);
  });
});

describe('colorContext', () => {
  const map = (attrs: string) => xml(`<p:clrMap ${attrs}/>`);
  const ovr = (attrs: string) => xml(`<p:clrMapOvr><a:overrideClrMapping ${attrs}/></p:clrMapOvr>`);

  it("merges the master's map, the layout's override and the slide's override, nearest last", () => {
    const ctx = colorContext(
      THEME,
      map('bg1="dk1" tx1="lt1" accent1="accent2"'),
      ovr('accent1="accent4"'),
      ovr('tx1="dk2" accent1="accent3"'),
    );
    expect(ctx.map.get('bg1')).toBe('dk1');
    expect(ctx.map.get('tx1')).toBe('dk2');
    expect(ctx.map.get('accent1')).toBe('accent4');
    expect(ctx.map.get('bg2')).toBe('lt2');
    expect(
      colorContext(THEME, map('bg1="dk1"'), xml('<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>')).map.get(
        'bg1',
      ),
    ).toBe('dk1');
  });

  it('ignores unknown names, values that are not scheme colours and prototype keys', () => {
    const ctx = colorContext(THEME, map('bg1="bogus" tx1="tx2" foo="dk1" __proto__="dk1" constructor="lt1"'));
    expect(ctx.map.get('bg1')).toBe('lt1');
    expect(ctx.map.get('tx1')).toBe('dk1');
    expect(ctx.map.has('foo')).toBe(false);
    expect(ctx.map.size).toBe(12);
    expect(color(scheme('__proto__'), ctx)).toBeUndefined();
  });
});

describe('fills', () => {
  const grad = (stops: string, rest = '<a:lin ang="5400000" scaled="0"/>') =>
    fillOf(xml(`<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${rest}</a:gradFill>`), CTX);
  const gs = (pos: number, c: string) => `<a:gs pos="${pos}">${c}</a:gs>`;

  it('reads a linear gradient with its stops sorted by position', () => {
    expect(
      grad(
        gs(100000, srgb('FF0000')) + gs(0, srgb('0000FF')) + gs(50000, scheme('accent1', m('alpha', 50000))),
      ),
    ).toEqual({
      kind: 'gradient',
      stops: [
        { at: 0, color: { r: 0, g: 0, b: 255, a: 1 } },
        { at: 0.5, color: { r: 68, g: 114, b: 196, a: 0.5 } },
        { at: 1, color: { r: 255, g: 0, b: 0, a: 1 } },
      ],
      angle: 90,
    });
    expect(grad(gs(0, srgb('000000')) + gs(100000, srgb('FFFFFF')), '<a:lin ang="-5400000"/>')).toMatchObject(
      { angle: 270 },
    );
    expect(grad(gs(-5, srgb('000000')) + gs(250000, srgb('FFFFFF')), '')).toMatchObject({
      angle: 0,
      stops: [{ at: 0 }, { at: 1 }],
    });
  });

  it('reads a path gradient with its focus', () => {
    expect(
      grad(
        gs(0, srgb('000000')) + gs(100000, srgb('FFFFFF')),
        '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>',
      ),
    ).toMatchObject({
      kind: 'gradient',
      path: 'circle',
      focus: { l: 0.5, t: 0.5, r: 0.5, b: 0.5 },
    });
    expect(grad(gs(0, srgb('000000')) + gs(1, srgb('FFFFFF')), '<a:path path="star"/>')).toMatchObject({
      path: 'circle',
    });
  });

  it(`keeps at most ${MAX_GRADIENT_STOPS} stops; one stop is solid, none is no fill`, () => {
    const many = Array.from({ length: 40 }, (_, i) => gs(i * 1000, srgb('FF0000'))).join('');
    const g = grad(many);
    expect(g.kind === 'gradient' && g.stops.length).toBe(MAX_GRADIENT_STOPS);
    expect(grad(gs(0, srgb('00FF00')))).toEqual({ kind: 'solid', color: { r: 0, g: 255, b: 0, a: 1 } });
    expect(grad('')).toEqual({ kind: 'none' });
    expect(grad(gs(0, scheme('accent9')))).toEqual({ kind: 'none' });
  });

  it('reads patterns with their colours', () => {
    expect(
      fillOf(
        xml(
          `<a:pattFill prst="dkUpDiag"><a:fgClr>${srgb('FF0000')}</a:fgClr><a:bgClr>${scheme('accent1')}</a:bgClr></a:pattFill>`,
        ),
        CTX,
      ),
    ).toEqual({
      kind: 'pattern',
      preset: 'dkUpDiag',
      fg: { r: 255, g: 0, b: 0, a: 1 },
      bg: { r: 68, g: 114, b: 196, a: 1 },
    });
    expect(fillOf(xml('<a:pattFill prst="__proto__"/>'), CTX)).toEqual({
      kind: 'pattern',
      preset: 'pct5',
      fg: { r: 0, g: 0, b: 0, a: 1 },
      bg: { r: 255, g: 255, b: 255, a: 1 },
    });
  });

  it('reads no fill, group fills and pictures through the blip reader', () => {
    const blip: BlipReader = () => ({ part: 'ppt/media/image1.png' });
    expect(readFill(xml('<p:spPr><a:xfrm/><a:noFill/></p:spPr>'), CTX)).toEqual({ kind: 'none' });
    expect(readFill(xml('<p:spPr><a:grpFill/></p:spPr>'), CTX)).toEqual({ kind: 'group' });
    expect(readFill(xml('<p:spPr><a:blipFill/></p:spPr>'), CTX, blip)).toEqual({
      kind: 'picture',
      picture: { part: 'ppt/media/image1.png' },
    });
    expect(readFill(xml('<p:spPr><a:blipFill/></p:spPr>'), CTX)).toEqual({ kind: 'none' });
    expect(readFill(xml('<p:spPr><a:xfrm/></p:spPr>'), CTX)).toBeUndefined();
    expect(readFill(undefined, CTX)).toBeUndefined();
  });
});

describe('style references', () => {
  const ref = (name: string, idx: string, c = scheme('accent2')) =>
    xml(`<a:${name} idx="${idx}">${c}</a:${name}>`);

  it('finds the entry each reference names, with phClr standing for the reference colour', () => {
    expect(styleEntry(THEME, ref('fillRef', '2'), CTX)?.node).toBe(THEME.fills[1]);
    expect(styleEntry(THEME, ref('fillRef', '1002'), CTX)?.node).toBe(THEME.bgFills[1]);
    expect(styleEntry(THEME, ref('bgRef', '1001'), CTX)?.node).toBe(THEME.bgFills[0]);
    expect(styleEntry(THEME, ref('lnRef', '3'), CTX)?.node).toBe(THEME.lines[2]);
    expect(styleEntry(THEME, ref('effectRef', '1'), CTX)?.node).toBe(THEME.effects[0]);
    expect(styleEntry(THEME, ref('fillRef', '1'), CTX)?.ctx.phClr).toEqual({ r: 237, g: 125, b: 49, a: 1 });
    expect(
      colorIn(
        styleEntry(THEME, ref('lnRef', '1'), CTX)?.node.children[0],
        styleEntry(THEME, ref('lnRef', '1'), CTX)!.ctx,
      ),
    ).toEqual({ r: 237, g: 125, b: 49, a: 1 });
  });

  it('gives nothing for index 0, 1000, a missing index or one past the list', () => {
    for (const idx of ['0', '1000', '4', '1004', '-1', 'x'])
      expect(styleEntry(THEME, ref('fillRef', idx), CTX), idx).toBeUndefined();
    expect(styleEntry(THEME, xml('<a:fillRef/>'), CTX)).toBeUndefined();
    expect(styleFill(THEME, undefined, CTX)).toBeUndefined();
  });

  it('resolves phClr inside a gradient of the style matrix', () => {
    const theme = readTheme(
      rootOf(
        parseXml(
          themeXml({
            fmtScheme:
              `<a:fmtScheme name="g"><a:fillStyleLst><a:gradFill><a:gsLst><a:gs pos="0">${scheme('phClr', m('tint', 50000))}</a:gs>` +
              `<a:gs pos="100000">${scheme('phClr', m('shade', 50000))}</a:gs></a:gsLst><a:lin ang="0"/></a:gradFill></a:fillStyleLst></a:fmtScheme>`,
          }),
          'theme',
        ),
      ),
    );
    const f = styleFill(theme, ref('fillRef', '1', srgb('000000')), CTX);
    expect(f?.kind === 'gradient' && f.stops.map((s) => hex(s.color))).toEqual(['BCBCBC', '000000']);
  });
});
