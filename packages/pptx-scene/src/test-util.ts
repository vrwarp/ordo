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
  /** Short type name: 'image', 'slideLayout', 'hyperlink', … */
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
        `<Relationship Id="${esc(r.id)}" Type="${relTypeUri(r.type)}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`,
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
}

/** A `p:grpSp` around `inner` shapes. */
export function grpSp(o: GroupSpec, inner: string): string {
  return (
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${o.id}" name="Group ${o.id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="${o.x}" y="${o.y}"/><a:ext cx="${o.cx}" cy="${o.cy}"/>` +
    `<a:chOff x="${o.chX ?? o.x}" y="${o.chY ?? o.y}"/><a:chExt cx="${o.chCx ?? o.cx}" cy="${o.chCy ?? o.cy}"/></a:xfrm></p:grpSpPr>` +
    `${inner}</p:grpSp>`
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
