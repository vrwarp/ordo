/**
 * Test decks as `PartSource` maps of XML strings: no zip, no files. Shared by every work item's tests;
 * add helpers, keep the existing ones' output stable.
 *
 *   const parts = buildDeck({
 *     slides: [{ bg: solidBg('003366'), shapes: sp({ id: 2, x: 0, y: 0, cx: 914400, cy: 457200,
 *       txBody: body(para(run('Hello', `sz="4000"`, solid('FFFFFF')))) }) }],
 *   });
 *
 * EMU everywhere: 914,400 per inch, 12,700 per point; the default slide is 12,192,000 x 6,858,000.
 */
import type { ShapeGeom, SlideObject } from '@ordo/domain';
import type { EmitResult } from './emit.ts';
import type { PartSource } from './opc.ts';

export const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const REL_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
/** A relationship type URI from its short name ('image', 'slideLayout', …). */
export const relTypeUri = (short: string) => `${NS_R}/${short}`;

const CT = 'application/vnd.openxmlformats-officedocument.presentationml';

/** A 1x1 transparent PNG. */
export const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

/**
 * The first bytes of a PNG of `w` x `h` pixels (signature and IHDR): enough for a header sniff. RGBA (it may
 * be transparent) by default; `opaque`: RGB, followed by the head of its image data (no `tRNS` before it).
 */
export function pngHeader(w: number, h: number, opaque = false): Uint8Array {
  const b = new Uint8Array(opaque ? 45 : 33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  b[24] = 8;
  b[25] = opaque ? 2 : 6;
  if (opaque) b.set([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54], 33); // an empty IDAT chunk (its CRC left 0)
  return b;
}

/** Text escaped for XML character data and attribute values. */
export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`,
  );
}

export interface RelSpec {
  id: string;
  /** Short type name: 'image', 'slideLayout', 'hyperlink', …, or a whole type URI (`MEDIA_REL`). */
  type: string;
  target: string;
  external?: boolean;
}

export interface SlideSpec {
  /** Inner XML of `p:spTree` after its group properties: `sp(...)`, `pic(...)`, `grpSp(...)`. */
  shapes?: string;
  /** A `p:bg` element: `solidBg(...)`, `pictureBg(...)`. */
  bg?: string;
  hidden?: boolean;
  /** Extra attributes of `p:sld`, e.g. `showMasterSp="0"`. */
  attrs?: string;
  /** Children of `p:sld` after `p:cSld`, e.g. a `p:clrMapOvr`. */
  after?: string;
  /** Relationships besides the layout's (`rId1`). */
  rels?: RelSpec[];
  /** The layout, 1-based (default 1). */
  layout?: number;
}

export interface PartSpec {
  shapes?: string;
  bg?: string;
  attrs?: string;
  rels?: RelSpec[];
  /** Layouts only: children of `p:sldLayout` after `p:cSld`, e.g. a `p:clrMapOvr` (default: masterClrMapping). */
  after?: string;
}

export interface DeckSpec {
  /** `p:sldSz` (default 16:9). */
  size?: { cx: number; cy: number };
  slides: SlideSpec[];
  /** Layouts (default one empty layout); each relates to the master as `rId1`. */
  layouts?: PartSpec[];
  /** The master's shapes and background, its `p:txStyles` inner XML and `p:clrMap` attributes. */
  master?: PartSpec & { txStyles?: string; clrMap?: string };
  /** The whole theme part (default `themeXml()`). */
  theme?: string;
  /** Inner XML of `p:defaultTextStyle`. */
  defaultTextStyle?: string;
  /** Media parts by name (`ppt/media/image1.png`); default `PNG_1X1` for every image a rel targets. */
  media?: Record<string, Uint8Array>;
}

const DEFAULT_CLRMAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

function rels(list: RelSpec[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_PKG}">${list
    .map(
      (r) =>
        `<Relationship Id="${esc(r.id)}" Type="${r.type.includes('://') ? esc(r.type) : relTypeUri(r.type)}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('')}</Relationships>`;
}

function cSld(shapes = '', bg = ''): string {
  return (
    `<p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `${shapes}</p:spTree></p:cSld>`
  );
}

/** A theme part with Office's colours and fonts unless given. */
export function themeXml(
  opts: { colors?: Record<string, string>; major?: string; minor?: string; fmtScheme?: string } = {},
): string {
  const c: Record<string, string> = {
    dk1: '<a:sysClr val="windowText" lastClr="000000"/>',
    lt1: '<a:sysClr val="window" lastClr="FFFFFF"/>',
    dk2: '<a:srgbClr val="44546A"/>',
    lt2: '<a:srgbClr val="E7E6E6"/>',
    accent1: '<a:srgbClr val="4472C4"/>',
    accent2: '<a:srgbClr val="ED7D31"/>',
    accent3: '<a:srgbClr val="A5A5A5"/>',
    accent4: '<a:srgbClr val="FFC000"/>',
    accent5: '<a:srgbClr val="5B9BD5"/>',
    accent6: '<a:srgbClr val="70AD47"/>',
    hlink: '<a:srgbClr val="0563C1"/>',
    folHlink: '<a:srgbClr val="954F72"/>',
  };
  for (const [k, v] of Object.entries(opts.colors ?? {})) c[k] = `<a:srgbClr val="${v}"/>`;
  const scheme = Object.entries(c)
    .map(([k, v]) => `<a:${k}>${v}</a:${k}>`)
    .join('');
  const fmt =
    opts.fmtScheme ??
    '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="50000"/></a:schemeClr></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
      '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
      '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
      '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
      '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
      '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
      '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="95000"/></a:schemeClr></a:solidFill>' +
      '<a:solidFill><a:schemeClr val="phClr"><a:lumMod val="80000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme>';
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:theme xmlns:a="${NS_A}" name="Test"><a:themeElements>` +
    `<a:clrScheme name="Test">${scheme}</a:clrScheme>` +
    `<a:fontScheme name="Test"><a:majorFont><a:latin typeface="${esc(opts.major ?? 'Calibri Light')}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="${esc(opts.minor ?? 'Calibri')}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>` +
    `${fmt}</a:themeElements></a:theme>`
  );
}

/** A deck's parts. Slide N is `ppt/slides/slideN.xml`, layout N `ppt/slideLayouts/slideLayoutN.xml`. */
export function buildDeck(spec: DeckSpec): PartSource {
  const enc = new TextEncoder();
  const parts = new Map<string, Uint8Array>();
  const put = (name: string, xml: string) => parts.set(name, enc.encode(xml));
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const layouts = spec.layouts?.length ? spec.layouts : [{}];
  const size = spec.size ?? { cx: 12_192_000, cy: 6_858_000 };
  const overrides: string[] = [
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
  ];
  const media = new Set<string>();
  const noteMedia = (owner: string, list: RelSpec[] = []) => {
    for (const r of list)
      if (r.type === 'image' && !r.external) {
        const dir = owner.slice(0, owner.lastIndexOf('/'));
        const segs = dir.split('/');
        for (const s of r.target.split('/')) s === '..' ? segs.pop() : segs.push(s);
        media.add(segs.join('/'));
      }
  };

  put('_rels/.rels', rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]));
  const presRels: RelSpec[] = [{ id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' }];
  const sldIds = spec.slides.map((_, i) => {
    presRels.push({ id: `rId${i + 2}`, type: 'slide', target: `slides/slide${i + 1}.xml` });
    return `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`;
  });
  presRels.push({ id: `rId${spec.slides.length + 2}`, type: 'theme', target: 'theme/theme1.xml' });
  put('ppt/_rels/presentation.xml.rels', rels(presRels));
  put(
    'ppt/presentation.xml',
    `${head}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst><p:sldSz cx="${size.cx}" cy="${size.cy}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      `${spec.defaultTextStyle !== undefined ? `<p:defaultTextStyle>${spec.defaultTextStyle}</p:defaultTextStyle>` : ''}</p:presentation>`,
  );

  const m = spec.master ?? {};
  const masterRels: RelSpec[] = [
    ...layouts.map((_, i) => ({
      id: `rId${i + 1}`,
      type: 'slideLayout',
      target: `../slideLayouts/slideLayout${i + 1}.xml`,
    })),
    { id: `rId${layouts.length + 1}`, type: 'theme', target: '../theme/theme1.xml' },
    ...(m.rels ?? []),
  ];
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels(masterRels));
  noteMedia('ppt/slideMasters/slideMaster1.xml', m.rels);
  put(
    'ppt/slideMasters/slideMaster1.xml',
    `${head}<p:sldMaster ${NS}${m.attrs ? ` ${m.attrs}` : ''}>${cSld(m.shapes, m.bg ?? '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>')}` +
      `<p:clrMap ${m.clrMap ?? DEFAULT_CLRMAP}/><p:sldLayoutIdLst>${layouts
        .map((_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`)
        .join(
          '',
        )}</p:sldLayoutIdLst><p:txStyles>${m.txStyles ?? '<p:titleStyle/><p:bodyStyle/><p:otherStyle/>'}</p:txStyles></p:sldMaster>`,
  );
  put('ppt/theme/theme1.xml', spec.theme ?? themeXml());

  layouts.forEach((l, i) => {
    const name = `ppt/slideLayouts/slideLayout${i + 1}.xml`;
    const lrels = [
      { id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' },
      ...(l.rels ?? []),
    ];
    put(`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, rels(lrels));
    noteMedia(name, l.rels);
    overrides.push(`<Override PartName="/${name}" ContentType="${CT}.slideLayout+xml"/>`);
    put(
      name,
      `${head}<p:sldLayout ${NS}${l.attrs ? ` ${l.attrs}` : ''}>${cSld(l.shapes, l.bg)}${l.after ?? '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'}</p:sldLayout>`,
    );
  });

  spec.slides.forEach((s, i) => {
    const name = `ppt/slides/slide${i + 1}.xml`;
    const srels = [
      { id: 'rId1', type: 'slideLayout', target: `../slideLayouts/slideLayout${s.layout ?? 1}.xml` },
      ...(s.rels ?? []),
    ];
    put(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels(srels));
    noteMedia(name, s.rels);
    overrides.push(`<Override PartName="/${name}" ContentType="${CT}.slide+xml"/>`);
    const attrs = `${s.hidden ? ' show="0"' : ''}${s.attrs ? ` ${s.attrs}` : ''}`;
    put(
      name,
      `${head}<p:sld ${NS}${attrs}>${cSld(s.shapes, s.bg)}${s.after ?? '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'}</p:sld>`,
    );
  });

  for (const name of media) parts.set(name, PNG_1X1);
  for (const [name, bytes] of Object.entries(spec.media ?? {})) parts.set(name, bytes);
  put(
    '[Content_Types].xml',
    `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
      `<Default Extension="jpeg" ContentType="image/jpeg"/>${overrides.join('')}</Types>`,
  );
  return parts;
}

// ── Elements ────────────────────────────────────────────────────────────────────────────────────────────

/** An `a:xfrm`. `rot` in degrees. */
export function xfrm(
  x: number,
  y: number,
  cx: number,
  cy: number,
  o: { rot?: number; flipH?: boolean; flipV?: boolean } = {},
): string {
  const attrs = `${o.rot ? ` rot="${Math.round(o.rot * 60_000)}"` : ''}${o.flipH ? ' flipH="1"' : ''}${o.flipV ? ' flipV="1"' : ''}`;
  return `<a:xfrm${attrs}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

/** `<a:solidFill>` of an sRGB hex colour (`'FF0000'`) or of a colour element. */
export function solid(color: string): string {
  return `<a:solidFill>${color.startsWith('<') ? color : `<a:srgbClr val="${color}"/>`}</a:solidFill>`;
}

/** An `a:schemeClr` with optional modifier elements. */
export function scheme(name: string, mods = ''): string {
  return mods ? `<a:schemeClr val="${name}">${mods}</a:schemeClr>` : `<a:schemeClr val="${name}"/>`;
}

export interface ShapeSpec {
  id: number;
  name?: string;
  /** Position and size in EMU; omit all four to inherit them (placeholders). */
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
  /** `a:prstGeom prst` (default 'rect'); 'none' writes no geometry. */
  geom?: string;
  /** Fill element(s) inside `p:spPr`, e.g. `solid('FF0000')` or `<a:noFill/>`. */
  fill?: string;
  /** An `a:ln` element. */
  ln?: string;
  /** A placeholder: `type="title"`, `type="body" idx="1"`, … (the attributes of `p:ph`). */
  ph?: string;
  /** A `p:txBody` (see `body`). */
  txBody?: string;
  /** A `p:style` element. */
  style?: string;
  /** Mark it a text box (`txBox="1"`). */
  txBox?: boolean;
}

/** A `p:sp`. */
export function sp(o: ShapeSpec): string {
  const pos =
    o.x !== undefined || o.cx !== undefined
      ? xfrm(o.x ?? 0, o.y ?? 0, o.cx ?? 0, o.cy ?? 0, { rot: o.rot, flipH: o.flipH, flipV: o.flipV })
      : '';
  const geom =
    o.geom === 'none' || (o.geom === undefined && o.ph)
      ? ''
      : `<a:prstGeom prst="${o.geom ?? 'rect'}"><a:avLst/></a:prstGeom>`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${o.id}" name="${esc(o.name ?? `Shape ${o.id}`)}"/><p:cNvSpPr${o.txBox ? ' txBox="1"' : ''}/>` +
    `<p:nvPr>${o.ph !== undefined ? `<p:ph ${o.ph}/>` : ''}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${pos}${geom}${o.fill ?? ''}${o.ln ?? ''}</p:spPr>${o.style ?? ''}${o.txBody ?? ''}</p:sp>`
  );
}

/** A `p:txBody` with body properties (attributes of `a:bodyPr`) and a list style. */
export function body(paras: string, bodyPr = '', lstStyle = ''): string {
  return `<p:txBody><a:bodyPr${bodyPr ? ` ${bodyPr}` : ''}/><a:lstStyle>${lstStyle}</a:lstStyle>${paras}</p:txBody>`;
}

/** An `a:p`. `pPr` are attributes of `a:pPr`; `endRPr` attributes of `a:endParaRPr`. */
export function para(runs: string, pPr = '', endRPr = ''): string {
  return `<a:p>${pPr ? `<a:pPr ${pPr}/>` : ''}${runs}${endRPr ? `<a:endParaRPr ${endRPr}/>` : ''}</a:p>`;
}

/** An `a:r`. `rPr` are attributes of `a:rPr`, `rPrChildren` its children (fills, `a:latin`, …). */
export function run(text: string, rPr = '', rPrChildren = ''): string {
  const props = rPr || rPrChildren ? `<a:rPr lang="en-US"${rPr ? ` ${rPr}` : ''}>${rPrChildren}</a:rPr>` : '';
  return `<a:r>${props}<a:t>${esc(text)}</a:t></a:r>`;
}

/** An `a:br`. */
export const br = '<a:br/>';

export interface PicSpec {
  id: number;
  name?: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  /** The relationship id of the image. */
  rId: string;
  /** Attributes of `a:srcRect` (`l="10000" r="10000"`). */
  srcRect?: string;
  /** Children of `a:blip` (`<a:alphaModFix amt="50000"/>`). */
  blip?: string;
  geom?: string;
}

/** A `p:pic` stretched over its box. */
export function pic(o: PicSpec): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${o.id}" name="${esc(o.name ?? `Picture ${o.id}`)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${o.rId}">${o.blip ?? ''}</a:blip>${o.srcRect !== undefined ? `<a:srcRect ${o.srcRect}/>` : ''}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(o.x, o.y, o.cx, o.cy)}<a:prstGeom prst="${o.geom ?? 'rect'}"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

export interface GroupSpec {
  id: number;
  x: number;
  y: number;
  cx: number;
  cy: number;
  /** Child space; defaults to the group's own offset and extent (no scaling). */
  chX?: number;
  chY?: number;
  chCx?: number;
  chCy?: number;
  /** The group's rotation in degrees and flips (M6). */
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
}

/** A `p:grpSp` around `inner` shapes. */
export function grpSp(o: GroupSpec, inner: string): string {
  const attrs = `${o.rot ? ` rot="${Math.round(o.rot * 60_000)}"` : ''}${o.flipH ? ' flipH="1"' : ''}${o.flipV ? ' flipV="1"' : ''}`;
  return (
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${o.id}" name="Group ${o.id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm${attrs}><a:off x="${o.x}" y="${o.y}"/><a:ext cx="${o.cx}" cy="${o.cy}"/>` +
    `<a:chOff x="${o.chX ?? o.x}" y="${o.chY ?? o.y}"/><a:chExt cx="${o.chCx ?? o.cx}" cy="${o.chCy ?? o.cy}"/></a:xfrm></p:grpSpPr>` +
    `${inner}</p:grpSp>`
  );
}

export interface CxnSpec {
  id: number;
  x: number;
  y: number;
  cx: number;
  cy: number;
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
  /** `a:prstGeom prst` (default 'straightConnector1') and its `a:avLst` inner XML. */
  geom?: string;
  av?: string;
  /** The ends glued to shapes: `a:stCxn`, `a:endCxn` (`cNvPr id`, site index). */
  start?: { id: number; idx: number };
  end?: { id: number; idx: number };
  /** The `a:ln` element (default 1 pt black). */
  ln?: string;
}

/** A `p:cxnSp` connector (M6). */
export function cxnSp(o: CxnSpec): string {
  const ref = (name: string, r?: { id: number; idx: number }) =>
    r ? `<a:${name} id="${r.id}" idx="${r.idx}"/>` : '';
  return (
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${o.id}" name="Connector ${o.id}"/><p:cNvCxnSpPr>${ref('stCxn', o.start)}${ref('endCxn', o.end)}</p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr>` +
    `<p:spPr>${xfrm(o.x, o.y, o.cx, o.cy, { rot: o.rot, flipH: o.flipH, flipV: o.flipV })}` +
    `<a:prstGeom prst="${o.geom ?? 'straightConnector1'}"><a:avLst>${o.av ?? ''}</a:avLst></a:prstGeom>` +
    `${o.ln ?? `<a:ln w="12700">${solid('000000')}</a:ln>`}</p:spPr></p:cxnSp>`
  );
}

/** An `a:custGeom` from its `a:avLst`/`a:gdLst` inner XML, `a:path` elements, `a:rect` and `a:cxnLst` (M6). */
export function custGeom(o: {
  av?: string;
  gd?: string;
  paths: string;
  rect?: string;
  cxn?: string;
}): string {
  return (
    `<a:custGeom><a:avLst>${o.av ?? ''}</a:avLst><a:gdLst>${o.gd ?? ''}</a:gdLst><a:ahLst/>` +
    `<a:cxnLst>${o.cxn ?? ''}</a:cxnLst>${o.rect ? `<a:rect ${o.rect}/>` : '<a:rect l="l" t="t" r="r" b="b"/>'}` +
    `<a:pathLst>${o.paths}</a:pathLst></a:custGeom>`
  );
}

/** A solid slide background. */
export function solidBg(color: string): string {
  return `<p:bg><p:bgPr>${solid(color)}<a:effectLst/></p:bgPr></p:bg>`;
}

/** A stretched picture background (`rId` relates to the image). */
export function pictureBg(rId: string): string {
  return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${rId}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
}

/** An image relationship to `ppt/media/<file>` from a slide, layout or master. */
export function imageRel(id: string, file: string): RelSpec {
  return { id, type: 'image', target: `../media/${file}` };
}

/** Text of a part, for assertions. */
export function partText(parts: PartSource, name: string): string {
  return new TextDecoder().decode(parts.get(name));
}

// ── Charts and extra parts (M3 item D) ──────────────────────────────────────────────────────────────────

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

/** A `p:graphicFrame` holding a chart (`rId` relates to the chart part). */
export function chartFrame(o: {
  id: number;
  x: number;
  y: number;
  cx: number;
  cy: number;
  rId: string;
}): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${o.id}" name="Chart ${o.id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${o.x}" y="${o.y}"/><a:ext cx="${o.cx}" cy="${o.cy}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="${o.rId}"/></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/**
 * A column chart part with its values cached (LibreOffice draws it without the embedded workbook): bars of
 * `color`, no chart or plot background, so everything around the bars is transparent.
 */
export function chartXml(values: number[] = [3, 5, 2], color = 'C00000'): string {
  const pts = (f: (v: number, i: number) => string) =>
    values.map((v, i) => `<c:pt idx="${i}"><c:v>${f(v, i)}</c:v></c:pt>`).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
    '<c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>' +
    `<c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:spPr>${solid(color)}</c:spPr>` +
    `<c:cat><c:strRef><c:f>Sheet1!$A$2</c:f><c:strCache><c:ptCount val="${values.length}"/>${pts((_, i) => String.fromCharCode(65 + (i % 26)))}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>Sheet1!$B$2</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts((v) => String(v))}</c:numCache></c:numRef></c:val>` +
    '</c:ser><c:gapWidth val="80"/><c:axId val="1"/><c:axId val="2"/></c:barChart>' +
    '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>' +
    '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln><a:noFill/></a:ln></c:spPr></c:majorGridlines><c:crossAx val="1"/></c:valAx>' +
    '<c:spPr><a:noFill/></c:spPr></c:plotArea><c:plotVisOnly val="1"/></c:chart><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>'
  );
}

/** Add a part (with a content-type override when `contentType` is given) to a built deck. */
export function withPart(
  parts: PartSource,
  name: string,
  content: string | Uint8Array,
  contentType?: string,
): PartSource {
  parts.set(name, typeof content === 'string' ? new TextEncoder().encode(content) : content);
  if (contentType) {
    const ct = partText(parts, '[Content_Types].xml');
    parts.set(
      '[Content_Types].xml',
      new TextEncoder().encode(
        ct.replace(
          '</Types>',
          `<Override PartName="/${esc(name)}" ContentType="${esc(contentType)}"/></Types>`,
        ),
      ),
    );
  }
  return parts;
}

export const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

// ── Video and sound (M5 hub scope, `media.ts`, `timing.ts`) ───────────────────────────────────────────────

/** PowerPoint 2010's media relationship type (`p14:media r:embed`). */
export const MEDIA_REL = 'http://schemas.microsoft.com/office/2007/relationships/media';
const NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
/** The slide's colour map override, which `SlideSpec.after` replaces: put it before a `timingXml`. */
export const CLRMAP_OVR = '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>';

export interface MediaPicSpec extends Omit<PicSpec, 'srcRect' | 'blip'> {
  /** The element under `p:nvPr`: `a:videoFile` or `a:audioFile`; 'p14' writes only `p14:media`. */
  kind: 'video' | 'audio' | 'p14';
  /** The relationship of `p14:media r:embed` (none when absent). */
  embed?: string;
  /** The relationship of `a:videoFile`/`a:audioFile r:link` (none when absent). */
  link?: string;
  /** `p14:trim` attributes, in ms. */
  trim?: { st?: number; end?: number };
}

/** A video or sound: a `p:pic` poster (`rId`) with its media elements, as PowerPoint 2010+ writes it. */
export function mediaPic(o: MediaPicSpec): string {
  const el =
    o.kind === 'p14' || o.link === undefined
      ? ''
      : `<a:${o.kind === 'video' ? 'videoFile' : 'audioFile'} r:link="${o.link}"/>`;
  const trim = o.trim
    ? `<p14:trim${o.trim.st !== undefined ? ` st="${o.trim.st}"` : ''}${o.trim.end !== undefined ? ` end="${o.trim.end}"` : ''}/>`
    : '';
  const p14 =
    o.embed === undefined
      ? ''
      : `<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="${NS_P14}" r:embed="${o.embed}">${trim}</p14:media></p:ext></p:extLst>`;
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${o.id}" name="${esc(o.name ?? `Media ${o.id}`)}"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr>` +
    `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr>${el}${p14}</p:nvPr></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${o.rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(o.x, o.y, o.cx, o.cy)}<a:prstGeom prst="${o.geom ?? 'rect'}"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

/** The relationships of an embedded clip, as PowerPoint writes them: `p14:media` and `a:videoFile`/`a:audioFile`. */
export function clipRels(
  kind: 'video' | 'audio',
  file: string,
  ids: { embed: string; link: string },
): RelSpec[] {
  return [
    { id: ids.embed, type: MEDIA_REL, target: `../media/${file}` },
    { id: ids.link, type: kind, target: `../media/${file}` },
  ];
}

export interface MediaTimingSpec {
  /** The picture's `p:cNvPr id`. */
  spid: number;
  kind: 'video' | 'audio';
  /**
   * auto: an after-previous play effect first in the main sequence; with: a with-previous one; click: an
   * on-click play effect; trigger: "When clicked on" (an interactive sequence); late: an after-previous play
   * effect after a click effect; none: no effect starts it.
   */
  start?: 'auto' | 'with' | 'click' | 'trigger' | 'late' | 'none';
  loop?: boolean;
  rewind?: boolean;
  vol?: number;
  mute?: boolean;
  showWhenStopped?: boolean;
  numSld?: number;
  fullScrn?: boolean;
  narration?: boolean;
}

/** A slide's `p:timing` for these clips, as PowerPoint writes it (put after `CLRMAP_OVR` in `SlideSpec.after`). */
export function timingXml(media: MediaTimingSpec[], extra = ''): string {
  let id = 2;
  const play = (spid: number, nodeType: string, cmd = 'playFrom(0.0)') =>
    `<p:par><p:cTn id="${++id}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${++id}" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="${nodeType}">` +
    `<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:cmd type="call" cmd="${cmd}"><p:cBhvr><p:cTn id="${++id}" dur="1000" fill="hold"/>` +
    `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:cmd></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
  const group = (inner: string, auto: boolean) =>
    `<p:par><p:cTn id="${++id}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>${auto ? '<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : ''}</p:stCondLst><p:childTnLst>${inner}</p:childTnLst></p:cTn></p:par>`;
  const groups: string[] = [];
  const auto = media.filter((m) => m.start === 'auto' || m.start === 'with');
  if (auto.length)
    groups.push(
      group(auto.map((m) => play(m.spid, m.start === 'with' ? 'withEffect' : 'afterEffect')).join(''), true),
    );
  for (const m of media.filter((x) => x.start === 'click'))
    groups.push(group(play(m.spid, 'clickEffect'), false));
  const late = media.filter((m) => m.start === 'late');
  if (late.length)
    groups.push(
      group(
        `<p:par><p:cTn id="${++id}" presetID="10" presetClass="entr" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn></p:par>${late.map((m) => play(m.spid, 'afterEffect')).join('')}`,
        false,
      ),
    );
  const main = groups.length
    ? `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${groups.join('')}</p:childTnLst></p:cTn>` +
      '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>'
    : '';
  const nodes = media
    .map((m) => {
      const node = m.kind === 'video' ? 'video' : 'audio';
      const attrs = `${m.fullScrn ? ' fullScrn="1"' : ''}${m.narration ? ' isNarration="1"' : ''}`;
      const media = `${m.vol !== undefined ? ` vol="${m.vol}"` : ''}${m.mute ? ' mute="1"' : ''}${m.showWhenStopped === false ? ' showWhenStopped="0"' : ''}${m.numSld !== undefined ? ` numSld="${m.numSld}"` : ''}`;
      return (
        `<p:${node}${attrs}><p:cMediaNode${media}><p:cTn id="${++id}"${m.loop ? ' repeatCount="indefinite"' : ''} fill="${m.rewind ? 'remove' : 'hold'}" display="0">` +
        `<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${m.spid}"/></p:tgtEl></p:cMediaNode></p:${node}>`
      );
    })
    .join('');
  const triggers = media
    .filter((m) => m.start === 'trigger')
    .map(
      (m) =>
        `<p:seq concurrent="1" nextAc="seek"><p:cTn id="${++id}" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq">` +
        `<p:stCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${m.spid}"/></p:tgtEl></p:cond></p:stCondLst><p:childTnLst>${play(m.spid, 'clickEffect', 'togglePause')}</p:childTnLst></p:cTn>` +
        `<p:nextCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${m.spid}"/></p:tgtEl></p:cond></p:nextCondLst></p:seq>`,
    )
    .join('');
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>${main}${nodes}${triggers}${extra}</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
}

// ── Tables (M6, `tables.ts`) ──────────────────────────────────────────────────────────────────────────────

const NS_TABLE = 'http://schemas.openxmlformats.org/drawingml/2006/table';

/**
 * An `a:tc`: its text as one run per paragraph (`\n` splits them; `rPr` attributes and `rPrChildren` of each
 * run, `pPr` attributes of each paragraph), `tcPr` attributes of its cell properties, `attrs` its own.
 */
export function tc(
  text = '',
  o: { tcPr?: string; attrs?: string; rPr?: string; rPrChildren?: string; pPr?: string } = {},
): string {
  const paras = text
    .split('\n')
    .map((t) => (t ? para(run(t, o.rPr ?? '', o.rPrChildren ?? ''), o.pPr) : para('', o.pPr)))
    .join('');
  return `<a:tc${o.attrs ? ` ${o.attrs}` : ''}><a:txBody><a:bodyPr/><a:lstStyle/>${paras}</a:txBody><a:tcPr${o.tcPr ?? ''}/></a:tc>`;
}

/** An `a:tc` with child elements in its `a:tcPr` (lines, fill): `tcPrAttrs` then `inner`. */
export function tcWith(
  text: string,
  inner: string,
  o: { tcPrAttrs?: string; attrs?: string; rPr?: string } = {},
): string {
  const paras = text
    .split('\n')
    .map((t) => (t ? para(run(t, o.rPr ?? '')) : para('')))
    .join('');
  return `<a:tc${o.attrs ? ` ${o.attrs}` : ''}><a:txBody><a:bodyPr/><a:lstStyle/>${paras}</a:txBody><a:tcPr${o.tcPrAttrs ?? ''}>${inner}</a:tcPr></a:tc>`;
}

/** A `p:graphicFrame` holding a table: column widths, rows of a height and `tc(...)` cells, `a:tblPr` inside. */
export function tableFrame(o: {
  id: number;
  x: number;
  y: number;
  cols: number[];
  rows: { h: number; cells: string[] }[];
  tblPr?: string;
}): string {
  const cx = o.cols.reduce((s, w) => s + w, 0);
  const cy = o.rows.reduce((s, r) => s + r.h, 0);
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${o.id}" name="Table ${o.id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${o.x}" y="${o.y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="${NS_TABLE}"><a:tbl>${o.tblPr ?? '<a:tblPr/>'}<a:tblGrid>${o.cols
      .map((w) => `<a:gridCol w="${w}"/>`)
      .join('')}</a:tblGrid>${o.rows
      .map((r) => `<a:tr h="${r.h}">${r.cells.join('')}</a:tr>`)
      .join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/** Add `ppt/tableStyles.xml` (`a:tblStyleLst` holding `styles`) with the presentation's relationship to it. */
export function withTableStyles(parts: PartSource, styles: string): PartSource {
  const relsName = 'ppt/_rels/presentation.xml.rels';
  parts.set(
    relsName,
    new TextEncoder().encode(
      partText(parts, relsName).replace(
        '</Relationships>',
        `<Relationship Id="rIdTs" Type="${relTypeUri('tableStyles')}" Target="tableStyles.xml"/></Relationships>`,
      ),
    ),
  );
  return withPart(
    parts,
    'ppt/tableStyles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}">${styles}</a:tblStyleLst>`,
    'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  );
}

/** Pair kerning for `sfntFont` (R1): `[left, right, x advance in font units]` per pair. */
export interface KernSpec {
  pairs: [string, string, number][];
  /**
   * How it is stored: `GPOS` PairPos format 1 (pairs), format 2 (`classes`: each character's class on its
   * side, the pair values per class pair), either wrapped in an Extension lookup, or the legacy `kern`
   * table. Default 'pairs'.
   */
  table?: 'pairs' | 'classes' | 'extension' | 'legacy';
  /** The script the `GPOS` 'kern' feature is under (default 'latn'). */
  script?: string;
  /** The feature's tag (default 'kern'). */
  feature?: string;
}

/**
 * A minimal TrueType font: `head` (units per em), `hhea`, `hmtx` and a `cmap` (format 4, or 12 with
 * `format: 12`) mapping each character of `advances` to its own glyph with that advance in font units.
 * Glyph 0 is .notdef. Enough for `metrics.ts`; nothing draws with it. With `kern` it has pair kerning
 * (`GPOS`, or a legacy `kern` table), with `vertical` an `hhea` ascender and descender, with `os2` an
 * `OS/2` table's typo and win metrics.
 */
export function sfntFont(
  advances: Record<string, number>,
  o: {
    upm?: number;
    format?: 4 | 12;
    notdef?: number;
    kern?: KernSpec;
    vertical?: { ascender: number; descender: number };
    os2?: { typo: [number, number]; win: [number, number]; useTypo?: boolean };
  } = {},
): Uint8Array {
  const upm = o.upm ?? 1000;
  const chars = Object.keys(advances)
    .map((c) => c.codePointAt(0)!)
    .sort((a, b) => a - b);
  const glyphOf = new Map(chars.map((cp, i) => [cp, i + 1]));
  const u16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const head = new Array(54).fill(0);
  head.splice(18, 2, ...u16(upm));
  const hhea = new Array(36).fill(0);
  hhea.splice(34, 2, ...u16(chars.length + 1));
  if (o.vertical)
    hhea.splice(4, 4, ...u16(o.vertical.ascender & 0xffff), ...u16(o.vertical.descender & 0xffff));
  const hmtx = [...u16(o.notdef ?? 500), 0, 0];
  for (const cp of chars) hmtx.push(...u16(advances[String.fromCodePoint(cp)]!), 0, 0);
  let sub: number[];
  if (o.format === 12) {
    sub = [...u16(12), 0, 0, ...u32(16 + chars.length * 12), 0, 0, 0, 0, ...u32(chars.length)];
    for (const cp of chars) sub.push(...u32(cp), ...u32(cp), ...u32(glyphOf.get(cp)!));
  } else {
    // One segment per character (idDelta maps it to its glyph), then the closing 0xFFFF segment.
    const segs = [...chars.map((cp) => [cp, cp, (glyphOf.get(cp)! - cp) & 0xffff]), [0xffff, 0xffff, 1]];
    const n = segs.length;
    sub = [...u16(4), ...u16(16 + n * 8), 0, 0, ...u16(n * 2), 0, 0, 0, 0, 0, 0];
    for (const s of segs) sub.push(...u16(s[1]!));
    sub.push(0, 0);
    for (const s of segs) sub.push(...u16(s[0]!));
    for (const s of segs) sub.push(...u16(s[2]!));
    for (const _ of segs) sub.push(0, 0);
  }
  const cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(o.format === 12 ? 10 : 1), ...u32(12), ...sub];
  const tables: [string, number[]][] = [
    ['cmap', cmap],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
  ];
  if (o.os2) {
    const os2 = new Array(78).fill(0);
    os2.splice(62, 2, ...u16(o.os2.useTypo ? 0x80 : 0));
    os2.splice(68, 4, ...u16(o.os2.typo[0] & 0xffff), ...u16(o.os2.typo[1] & 0xffff));
    os2.splice(74, 4, ...u16(o.os2.win[0]), ...u16(o.os2.win[1]));
    tables.push(['OS/2', os2]);
  }
  if (o.kern) {
    const glyph = (c: string) => glyphOf.get(c.codePointAt(0)!) ?? 0;
    const pairs = o.kern.pairs.map(([a, b, v]) => [glyph(a), glyph(b), v] as const);
    if (o.kern.table === 'legacy') tables.push(['kern', legacyKern(pairs)]);
    else tables.push(['GPOS', gpos(pairs, o.kern)]);
    tables.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  const out = [...u32(0x00010000), ...u16(tables.length), 0, 0, 0, 0, 0, 0];
  let off = 12 + tables.length * 16;
  const body: number[] = [];
  for (const [tag, data] of tables) {
    out.push(...[...tag].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...u32(off), ...u32(data.length));
    body.push(...data);
    while (body.length % 4) body.push(0);
    off = 12 + tables.length * 16 + body.length;
  }
  return Uint8Array.from([...out, ...body]);
}

const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const be32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

/** A legacy `kern` table (version 0, one horizontal format 0 subtable) of glyph pairs. */
function legacyKern(pairs: readonly (readonly [number, number, number])[]): number[] {
  const sorted = [...pairs].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const body = [...be16(sorted.length), 0, 0, 0, 0, 0, 0];
  for (const [a, b, v] of sorted) body.push(...be16(a), ...be16(b), ...be16(v & 0xffff));
  return [...be16(0), ...be16(1), ...be16(0), ...be16(6 + body.length), ...be16(0x0001), ...body];
}

/** A `GPOS` table with one 'kern' feature of one pair-adjustment lookup (see `KernSpec`). */
function gpos(pairs: readonly (readonly [number, number, number])[], spec: KernSpec): number[] {
  const firsts = [...new Set(pairs.map((p) => p[0]))].sort((a, b) => a - b);
  const coverage = [...be16(1), ...be16(firsts.length), ...firsts.flatMap(be16)];
  let sub: number[];
  if (spec.table === 'classes') {
    // Each glyph its own class on each side (class 0: every other glyph).
    const seconds = [...new Set(pairs.map((p) => p[1]))].sort((a, b) => a - b);
    const classDef = (gs: number[]) => [
      ...be16(2),
      ...be16(gs.length),
      ...gs.flatMap((g, i) => [...be16(g), ...be16(g), ...be16(i + 1)]),
    ];
    const c1 = classDef(firsts);
    const c2 = classDef(seconds);
    const n1 = firsts.length + 1;
    const n2 = seconds.length + 1;
    const records: number[] = [];
    for (let i = 0; i < n1; i++)
      for (let j = 0; j < n2; j++) {
        const hit = pairs.find((p) => p[0] === firsts[i - 1] && p[1] === seconds[j - 1]);
        records.push(...be16((hit?.[2] ?? 0) & 0xffff));
      }
    const head = 16 + records.length;
    sub = [
      ...be16(2),
      ...be16(head + c1.length + c2.length),
      ...be16(0x0004),
      ...be16(0),
      ...be16(head),
      ...be16(head + c1.length),
      ...be16(n1),
      ...be16(n2),
      ...records,
      ...c1,
      ...c2,
      ...coverage,
    ];
  } else {
    const sets = firsts.map((f) => {
      const ps = pairs.filter((p) => p[0] === f).sort((p, q) => p[1] - q[1]);
      return [...be16(ps.length), ...ps.flatMap((p) => [...be16(p[1]), ...be16(p[2] & 0xffff)])];
    });
    const head = 10 + firsts.length * 2;
    const offsets: number[] = [];
    let at = head;
    for (const set of sets) {
      offsets.push(at);
      at += set.length;
    }
    sub = [
      ...be16(1),
      ...be16(at),
      ...be16(0x0004),
      ...be16(0),
      ...be16(firsts.length),
      ...offsets.flatMap(be16),
      ...sets.flat(),
      ...coverage,
    ];
  }
  // An Extension lookup (type 9) points at the pair subtable with a 32-bit offset.
  const ext = spec.table === 'extension';
  const lookup = [...be16(ext ? 9 : 2), ...be16(0), ...be16(1), ...be16(8)];
  const subtable = ext ? [...be16(1), ...be16(2), ...be32(8), ...sub] : sub;
  const lookupList = [...be16(1), ...be16(4), ...lookup, ...subtable];
  const feature = [...be16(0), ...be16(1), ...be16(0)];
  const featureList = [
    ...be16(1),
    ...[...(spec.feature ?? 'kern')].map((c) => c.charCodeAt(0)),
    ...be16(8),
    ...feature,
  ];
  const langSys = [...be16(0), ...be16(0xffff), ...be16(1), ...be16(0)];
  const script = [...be16(4), ...be16(0), ...langSys];
  const scriptList = [
    ...be16(1),
    ...[...(spec.script ?? 'latn')].map((c) => c.charCodeAt(0)),
    ...be16(8),
    ...script,
  ];
  const at1 = 10;
  const at2 = at1 + scriptList.length;
  const at3 = at2 + featureList.length;
  return [
    ...be16(1),
    ...be16(0),
    ...be16(at1),
    ...be16(at2),
    ...be16(at3),
    ...scriptList,
    ...featureList,
    ...lookupList,
  ];
}

/**
 * The emitted slides with each geometry file's paths back in place of its placeholder (`ShapeGeom.ref`,
 * `EmitResult.geoms`, M6 round 2): what a drawer draws once it has read the files, for tests of the paths
 * themselves. The result's own slides are left as they are.
 */
export function inlineGeoms<T extends Pick<EmitResult, 'slides' | 'geoms'>>(out: T): T {
  const files = new Map(out.geoms.map((g) => [g.id, g.file]));
  const inline = (g: ShapeGeom | undefined): ShapeGeom | undefined => {
    const file = g?.ref === undefined ? undefined : files.get(g.ref);
    if (!g || !file) return g;
    const { ref: _ref, ...rest } = g;
    return { ...rest, paths: file.paths.map((p) => ({ ...p })) };
  };
  const slides = out.slides.map((s) => ({
    ...s,
    slide: {
      ...s.slide,
      objects: s.slide.objects.map((o): SlideObject => {
        if (o.type === 'shape' && o.geom?.ref !== undefined) return { ...o, geom: inline(o.geom)! };
        if (o.type === 'image' && o.mask?.ref !== undefined) return { ...o, mask: inline(o.mask)! };
        return o;
      }),
    },
  }));
  return { ...out, slides };
}

/**
 * An `a:path` of line art (M9 leaf-legacy; like the leaf template's, design/27 §3.2 legacy values): one outline
 * of `w` x `h` (path space) holding `cols` x `rows` holes, each a rounded rectangle of four lines and four
 * corners of two cubic curves each, filling its cell but for a `gap` share of its sides, so the even-odd fill is
 * the thin lines between the holes (about `1 − (1 − gap)²` of the box). Each hole wobbles by a fixed pattern
 * (no randomness: the same arguments always write the same string). Points as the converter counts them
 * (`lineArtPoints`): 5 for the outline, 30 a hole; commands with a point (what `walk.ts` `pathCoverage` reads):
 * 4 and 13.
 */
export function lineArtPath(
  o: { w?: number; h?: number; cols?: number; rows?: number; gap?: number; seed?: number } = {},
): string {
  const w = o.w ?? 100_000;
  const h = o.h ?? 60_000;
  const cols = o.cols ?? 20;
  const rows = o.rows ?? 15;
  const gap = o.gap ?? 0.12;
  const seed = o.seed ?? 0;
  const r = (v: number) => Math.round(v);
  const p = (x: number, y: number) => `<a:pt x="${r(x)}" y="${r(y)}"/>`;
  const line = (x: number, y: number) => `<a:lnTo>${p(x, y)}</a:lnTo>`;
  // A quarter turn about (cx, cy) from `from` (radians, y down) as two cubics of an eighth turn each.
  const K = (4 / 3) * Math.tan(Math.PI / 16);
  const corner = (cx: number, cy: number, rad: number, from: number) => {
    let out = '';
    for (let k = 0; k < 2; k++) {
      const a = from + (k * Math.PI) / 4;
      const b = a + Math.PI / 4;
      const [ax, ay] = [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
      const [bx, by] = [cx + rad * Math.cos(b), cy + rad * Math.sin(b)];
      out +=
        `<a:cubicBezTo>${p(ax - K * rad * Math.sin(a), ay + K * rad * Math.cos(a))}` +
        `${p(bx + K * rad * Math.sin(b), by - K * rad * Math.cos(b))}${p(bx, by)}</a:cubicBezTo>`;
    }
    return out;
  };
  let d = `<a:moveTo>${p(0, 0)}</a:moveTo>${line(w, 0)}${line(w, h)}${line(0, h)}<a:close/>`;
  const cw = w / cols;
  const ch = h / rows;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      // A fixed wobble per hole: its corners rounder or sharper, the hole a little off its cell's centre.
      const k = (i * 7 + j * 13 + seed * 5) % 11;
      const x0 = i * cw + cw * (gap / 2) * (0.6 + 0.2 * (k % 5));
      const y0 = j * ch + ch * (gap / 2) * (0.6 + 0.2 * ((k + 2) % 5));
      const x1 = x0 + cw * (1 - gap);
      const y1 = y0 + ch * (1 - gap);
      const rad = Math.min(cw, ch) * (1 - gap) * (0.1 + 0.05 * (k % 4));
      d +=
        `<a:moveTo>${p(x0 + rad, y0)}</a:moveTo>${line(x1 - rad, y0)}${corner(x1 - rad, y0 + rad, rad, -Math.PI / 2)}` +
        `${line(x1, y1 - rad)}${corner(x1 - rad, y1 - rad, rad, 0)}` +
        `${line(x0 + rad, y1)}${corner(x0 + rad, y1 - rad, rad, Math.PI / 2)}` +
        `${line(x0, y0 + rad)}${corner(x0 + rad, y0 + rad, rad, Math.PI)}<a:close/>`;
    }
  return `<a:path w="${w}" h="${h}">${d}</a:path>`;
}

/**
 * The even-odd ink of `lineArtPath` with the same options: the share of its box the lines between the holes
 * fill (the outline less every hole, a rounded rectangle of its cell's size less the gap, less its four
 * corners' `(4 − π) rad²`; the cubics' quarter turns are within 0.03 % of a circle's).
 */
export function lineArtInk(o: { cols?: number; rows?: number; gap?: number; seed?: number } = {}): number {
  const w = 100_000;
  const h = 60_000;
  const cols = o.cols ?? 20;
  const rows = o.rows ?? 15;
  const gap = o.gap ?? 0.12;
  const seed = o.seed ?? 0;
  const cw = w / cols;
  const ch = h / rows;
  let holes = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const k = (i * 7 + j * 13 + seed * 5) % 11;
      const rad = Math.min(cw, ch) * (1 - gap) * (0.1 + 0.05 * (k % 4));
      holes += cw * (1 - gap) * ch * (1 - gap) - (4 - Math.PI) * rad * rad;
    }
  return 1 - holes / (w * h);
}

/** The points of `lineArtPath` as the converter counts them (moveTo, lnTo and close 1, cubicBezTo 3). */
export function lineArtPoints(cols = 20, rows = 15): number {
  return 5 + 30 * cols * rows;
}
