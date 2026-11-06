/**
 * The render copy (design/27 §5 "Render copy", M3 item D): the minimal deck LibreOffice prints for the
 * slides that need it. It replaces the main-thread `pptxForRendering` of `@ordo/importers` and runs on the
 * hub's CPU pool (task `pptx-render-copy`), with linear tag scans and the part budgets of §12.
 *
 * - Only the needed slides are listed in `p:sldIdLst`, in page order: page k of the PDF is `pages[k - 1]`,
 *   so hidden slides can never shift a page. Every page is its own slide part and shown (`show` removed:
 *   LibreOffice does not print hidden slides).
 * - An art slide appears twice, once over a forced white background and once over a second colour (the slide's own
 *   `p:bg` replaces whatever the slide, layout or master had, master shapes are hidden with `showMasterSp`),
 *   and keeps only the art's own elements (`keep`): everything else on the slide is removed, and a layout or
 *   master element of the art is copied to the bottom of the slide's tree with its relationships.
 * - A picture-class slide is kept whole, apart from media payloads.
 * - A picture page holds one picture part alone (a metafile LibreOffice converts), contain-fitted at its own
 *   aspect over a forced background; `rect` says where.
 * - Media payloads (`a:videoFile`, `a:audioFile`, `p14:media` …) and their relationships are removed, posters
 *   stay; so are `p:timing`, `p:transition`, ActiveX controls and every relationship that is External or of a
 *   type outside a short allow-list: `vbaProject.bin`, OLE binaries (their preview pictures stay), embedded
 *   workbooks and fonts, notes, comments, tags and custom XML never reach LibreOffice.
 * - Fields (`a:fld`) become plain runs of their stored text, as the native import draws them: a slide number
 *   must not become the copy's page number.
 * - The outline strip of design/20 is applied to slides, layouts and masters: LibreOffice draws a coloured
 *   outline on filled text as hollow letters, so filled text loses its outline (`<a:noFill/>` text keeps it).
 *
 * Every XML part is written again from its parsed tree (`Package.xml`: Transitional, the usual prefixes,
 * alternate content reduced to the branch ordo reads), so LibreOffice never parses a deck's own markup: no
 * declaration, no entity, nothing the reader refused. Parts get generated names (`ppt/<dir>/<kind><n>.<ext>`)
 * and every relationship part and the content types are rebuilt; deck part names never reach the copy.
 *
 * Pure like the rest of the package: parts in, parts out; the hub zips them with the spilled media.
 */
import { readDeck, type SlideRef } from './deck.ts';
import type { ElementRef, RectEmu } from './ir.ts';
import { clean, noteList } from './log.ts';
import { NS, USUAL_PREFIX } from './markup.ts';
import { openPackage, type Package, type PartSource, type Rel, relType, SLIDE_CONTENT_TYPE } from './opc.ts';
import { child, num, path, type XNode } from './xml.ts';

/** One printed page of the render copy. */
export type RenderCopyPage =
  /** A picture-class slide (or a reference picture): the slide as it is, media payloads removed. */
  | { index: number; mode: 'whole' }
  /** One of an art slide's two pages: only `keep` printed, over a forced background (`PAGE_BACKGROUNDS`). */
  | { index: number; mode: 'art'; background: PageBackground; keep: ElementRef[] }
  /**
   * A picture part alone (a metafile to convert), contain-fitted at its own aspect over a forced background,
   * on a page that uses slide `index`'s layout. `rect` (slide EMU) is filled in by the copy: where it went.
   */
  | { index: number; mode: 'picture'; part: string; background: PageBackground; rect?: RectEmu };

/**
 * The forced backgrounds of art and picture pages, RGB. An art picture is printed over white and over a
 * second colour. That colour is yellow, not black: LibreOffice draws text of automatic colour white on a
 * background of luminance 156 or less (verified with 24.2), so over black a table's or a placeholder's
 * automatic black text would come back white. Yellow (luminance 226) keeps every automatic colour as on white
 * and differs from white in the blue channel by the full 255 levels, which carries the alpha.
 */
export const PAGE_BACKGROUNDS = {
  white: [255, 255, 255],
  yellow: [255, 255, 0],
  black: [0, 0, 0],
} as const satisfies Record<string, readonly [number, number, number]>;
export type PageBackground = keyof typeof PAGE_BACKGROUNDS;

/** A page background as an `a:srgbClr` value. */
function hexOf(bg: PageBackground): string {
  return PAGE_BACKGROUNDS[bg].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');
}

export interface RenderCopyOptions {
  /** The pixel size of a picture part whose bytes are not in the source (a picture page's aspect). */
  pictureSize?: (part: string) => { w: number; h: number } | undefined;
}

/**
 * The size of an EMF (its frame, in 0.01 mm) or of a placeable WMF (its bounding box) from its first bytes;
 * undefined for anything else (a WMF without a placeable header has no size of its own).
 */
export function metafileSize(head: Uint8Array): { w: number; h: number } | undefined {
  if (head.length < 16) return undefined;
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let w = 0;
  let h = 0;
  if (head.length >= 44 && dv.getUint32(0, true) === 1 && dv.getUint32(40, true) === 0x464d4520) {
    w = dv.getInt32(32, true) - dv.getInt32(24, true);
    h = dv.getInt32(36, true) - dv.getInt32(28, true);
  } else if (dv.getUint32(0, true) === 0x9ac6cdd7) {
    w = dv.getInt16(10, true) - dv.getInt16(6, true);
    h = dv.getInt16(12, true) - dv.getInt16(8, true);
  }
  return w > 0 && h > 0 && w <= 1e9 && h <= 1e9 ? { w, h } : undefined;
}

export interface RenderCopyResult {
  /** The copy's parts by name (content types and relationships included), ready to zip. */
  parts: Map<string, Uint8Array>;
  /**
   * Media parts the copy references whose bytes are not in the source (spilled to disk): [name in the copy,
   * part of the deck] pairs. The hub adds their bytes under the copy's name.
   */
  media: [string, string][];
  /** The printed pages in order: page k of the PDF is `pages[k - 1]`. */
  pages: RenderCopyPage[];
  /** Text runs whose outline was removed (the job log counts them). */
  outlines: number;
  /** What could not be honoured (sanitised short lines). */
  notes: string[];
  /** The deck's slide size in EMU (`p:sldSz`): the hub sizes the pages from it. */
  slideSize: { cx: number; cy: number };
}

/** Bounds of one copy (design/27 §12): every art slide twice, at most 2,000 slides. */
export const RENDER_COPY_LIMITS = {
  /** Pages printed. */
  pages: 4_000,
  /** Parts written (slides, layouts, masters, themes, charts, diagrams, pictures). */
  parts: 20_000,
  /** XML written in all, in UTF-16 code units (the input is at most 64 MB of XML). */
  xmlChars: 256 * 1024 * 1024,
} as const;

const PRESENTATION_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const RELS_CONTENT_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';
const NS_PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

/**
 * Relationship types the copy keeps (their last segment): what draws a slide, a layout, a master, a chart or
 * SmartArt. Everything else (OLE objects, embedded packages, `vbaProject`, ActiveX, fonts, media payloads,
 * notes, comments, tags, custom XML, properties, hyperlinks) is dropped, and External targets always are.
 */
const KEPT_RELS: ReadonlySet<string> = new Set([
  'slideMaster',
  'slideLayout',
  'theme',
  'themeOverride',
  'image',
  'chart',
  'chartUserShapes',
  'chartStyle',
  'chartColorStyle',
  'diagramData',
  'diagramLayout',
  'diagramQuickStyle',
  'diagramColors',
  'diagramDrawing',
  'tableStyles',
]);

/** Targets never copied, whatever relationship names them (design/27 §12 "Relationships"). */
function refusedTarget(pkg: Package, part: string): boolean {
  const n = part.toLowerCase();
  if (n.endsWith('.bin') || n.startsWith('ppt/embeddings/') || n.startsWith('customxml/')) return true;
  if (n.startsWith('ppt/activex/') || n.endsWith('.svg')) return true;
  const ct = (pkg.contentType(part) ?? '').toLowerCase();
  return (
    ct.includes('vbaproject') || ct.includes('oleobject') || ct.includes('activex') || ct.includes('svg')
  );
}

/** The copy would pass `RENDER_COPY_LIMITS`: the whole copy fails, not one page. */
export class RenderCopyLimitError extends Error {}

/** Media payload elements (the clip of a poster picture), removed with their relationships. */
const MEDIA_ELEMENTS: ReadonlySet<string> = new Set([
  'a:videoFile',
  'a:audioFile',
  'a:wavAudioFile',
  'a:quickTimeFile',
  'a:audioCd',
  'p14:media',
]);

/** Run properties the outline strip looks into. */
const RUN_PROPS: ReadonlySet<string> = new Set(['a:rPr', 'a:defRPr', 'a:endParaRPr']);

/** Shape-tree elements that become IR elements (`walk.ts`). */
const LEAVES: ReadonlySet<string> = new Set(['p:sp', 'p:cxnSp', 'p:pic', 'p:graphicFrame']);
const NV: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  'p:sp': 'p:nvSpPr',
  'p:cxnSp': 'p:nvCxnSpPr',
  'p:pic': 'p:nvPicPr',
  'p:graphicFrame': 'p:nvGraphicFramePr',
  'p:grpSp': 'p:nvGrpSpPr',
});

// ── XML writing ─────────────────────────────────────────────────────────────────────────────────────────

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Characters XML 1.0 cannot hold (a decoded `&#1;`), dropped. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

function escText(s: string): string {
  return s.replace(NOT_XML, '').replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function escAttr(s: string): string {
  return s
    .replace(NOT_XML, '')
    .replace(/[&<>"\t\n\r]/g, (c) =>
      c === '&'
        ? '&amp;'
        : c === '<'
          ? '&lt;'
          : c === '>'
            ? '&gt;'
            : c === '"'
              ? '&quot;'
              : `&#${c.charCodeAt(0)};`,
    );
}

/** Whether a namespace declaration is one the writer replaces with the usual ones on the root. */
function usualDeclaration(key: string, value: string): boolean {
  if (key !== 'xmlns' && !key.startsWith('xmlns:')) return false;
  if (USUAL_PREFIX.has(value)) return true;
  return key.length > 6 && Object.hasOwn(NS, key.slice(6));
}

/** The prefix of a qualified name ('' for none). */
function prefixOf(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? '' : name.slice(0, colon);
}

/** A name of `XML_NAME` characters only (what the reader can hand over is wider). */
const XML_NAME = /^[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?$/;

/**
 * A parsed part as XML. Names are the usual prefixes (`Package.xml`), so the root declares every usual
 * namespace and the deck's own declarations of known namespaces (or of the usual prefixes) are dropped;
 * other declarations stay as written. An element or attribute whose prefix is declared nowhere in scope, or
 * whose name is not an XML name, is left out: LibreOffice would refuse the whole part.
 */
export function writeXml(root: XNode, rootDecls: Readonly<Record<string, string>> = NS): string {
  const out: string[] = [XML_HEAD];
  const base = new Set(['xml', 'xmlns', ...Object.keys(rootDecls)]);
  const write = (n: XNode, isRoot: boolean, scope: ReadonlySet<string>) => {
    if (n.name === '#text') {
      out.push(escText(n.text));
      return;
    }
    let own: Set<string> | undefined;
    for (const k in n.attrs)
      if (k.startsWith('xmlns:') && !usualDeclaration(k, n.attrs[k]!))
        (own ??= new Set(scope)).add(k.slice(6));
    const inScope = own ?? scope;
    const p = prefixOf(n.name);
    if (!XML_NAME.test(n.name) || (p && !inScope.has(p))) return;
    let tag = `<${n.name}`;
    if (isRoot) for (const [px, uri] of Object.entries(rootDecls)) tag += ` xmlns:${px}="${escAttr(uri)}"`;
    for (const k in n.attrs) {
      const v = n.attrs[k]!;
      if (usualDeclaration(k, v) || !XML_NAME.test(k)) continue;
      const ap = prefixOf(k);
      if (ap && !inScope.has(ap)) continue;
      tag += ` ${k}="${escAttr(v)}"`;
    }
    if (!n.children.length) {
      out.push(`${tag}/>`);
      return;
    }
    out.push(`${tag}>`);
    for (const c of n.children) write(c, false, inScope);
    out.push(`</${n.name}>`);
  };
  write(root, true, base);
  return out.join('');
}

/** An element node (null-prototype attributes). */
function el(name: string, attrs: Record<string, string> = {}, children: XNode[] = []): XNode {
  const a: Record<string, string> = Object.create(null);
  for (const k of Object.keys(attrs)) a[k] = attrs[k]!;
  return { name, attrs: a, children, text: '' };
}

/**
 * `n` with `f` applied to every element, top down: `f` returns the node to keep (itself, or a replacement
 * whose children are then visited) or null to drop it. Unchanged subtrees are shared, never copied; the
 * input is never modified (`Package.xml` trees are cached and shared).
 */
function mapTree(n: XNode, f: (n: XNode) => XNode | null): XNode | null {
  if (n.name === '#text') return n;
  const m = f(n);
  if (!m) return null;
  let changed = m !== n;
  const kids: XNode[] = [];
  for (const c of m.children) {
    const r = mapTree(c, f);
    if (r !== c) changed = true;
    if (r) kids.push(r);
  }
  return changed ? { ...m, children: kids } : n;
}

/** Every value of an `r:` attribute in a tree (the relationship ids it uses). */
function relIdsIn(root: XNode): Set<string> {
  const ids = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    for (const k in n.attrs) if (k.startsWith('r:')) ids.add(n.attrs[k]!);
    for (const c of n.children) if (c.name !== '#text') stack.push(c);
  }
  return ids;
}

// ── Element edits ───────────────────────────────────────────────────────────────────────────────────────

/** What the edits of one part counted. */
interface EditStats {
  outlines: number;
}

/**
 * The edits every slide, layout and master gets: media payload elements removed; filled text loses its
 * outline (design/20); with `fields`, `a:fld` becomes a plain run of its stored text.
 */
function commonEdits(stats: EditStats, fields: boolean): (n: XNode) => XNode | null {
  return (n) => {
    if (MEDIA_ELEMENTS.has(n.name)) return null;
    if (fields && n.name === 'a:fld')
      return el(
        'a:r',
        {},
        n.children.filter((c) => c.name === 'a:rPr' || c.name === 'a:t'),
      );
    if (RUN_PROPS.has(n.name) && n.children.some((c) => c.name === 'a:ln')) {
      if (n.children.some((c) => c.name === 'a:noFill')) return n; // hollow text keeps its outline
      stats.outlines++;
      return { ...n, children: n.children.filter((c) => c.name !== 'a:ln') };
    }
    return n;
  };
}

/** Whether a child of `p:sld`/`p:sldLayout` is a transition or timing (alone or in alternate content). */
function isTiming(n: XNode): boolean {
  if (n.name === 'p:timing' || n.name === 'p:transition') return true;
  if (n.name !== 'mc:AlternateContent') return false;
  const branch = n.children.find((c) => c.name !== '#text');
  return !!branch && branch.children.some((c) => c.name === 'p:transition' || c.name === 'p:timing');
}

const on = (v: string | undefined) => v === '1' || v === 'true';

/** Whether a shape-tree leaf has any characters in its text body. */
function hasText(leaf: XNode): boolean {
  const stack = [leaf];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.name === 'a:t' && n.children.some((c) => c.name === '#text' && c.text.length > 0)) return true;
    for (const c of n.children) if (c.name !== '#text') stack.push(c);
  }
  return false;
}

/**
 * Whether a shape-tree leaf is an element of the IR (`walk.ts`), so `ElementRef.nth` counts the same nodes:
 * layout and master placeholders are templates; a slide placeholder without text or a picture fill is not
 * drawn; a non-placeholder needs a position.
 */
function isElement(leaf: XNode, from: ElementRef['from']): boolean {
  const nv = child(leaf, NV[leaf.name] ?? '');
  if (!nv) return false;
  const ph = path(nv, 'p:nvPr', 'p:ph');
  if (ph) {
    if (from !== 'slide') return false;
    if (leaf.name !== 'p:sp') return true;
    return hasText(leaf) || !!path(leaf, 'p:spPr', 'a:blipFill');
  }
  const xfrm = leaf.name === 'p:graphicFrame' ? child(leaf, 'p:xfrm') : path(leaf, 'p:spPr', 'a:xfrm');
  return !!xfrm;
}

function idOf(leaf: XNode): number {
  const v = num(path(leaf, NV[leaf.name] ?? '', 'p:cNvPr')?.attrs.id);
  return v !== undefined && Number.isFinite(v) ? Math.max(0, Math.min(2_147_483_647, Math.floor(v))) : 0;
}

/**
 * The children of a shape tree (or group, or alternate-content branch) that hold a kept element: leaves in
 * `keep` (`<id>#<nth>`), groups and alternate content with a kept descendant (their own properties stay).
 * `seen` counts the elements of the source by id, in the walk's order.
 */
function keptChildren(
  tree: XNode,
  from: ElementRef['from'],
  keep: ReadonlySet<string>,
  seen: Map<number, number>,
  depth = 0,
): XNode[] {
  const out: XNode[] = [];
  if (depth > 32) return out;
  for (const n of tree.children) {
    if (n.name === 'mc:AlternateContent') {
      const branch = n.children.find((c) => c.name !== '#text');
      if (!branch) continue;
      const kids = keptChildren(branch, from, keep, seen, depth + 1);
      if (kids.length) out.push({ ...n, children: [{ ...branch, children: kids }] });
    } else if (n.name === 'p:grpSp') {
      const nv = child(n, 'p:nvGrpSpPr');
      if (!nv || on(child(nv, 'p:cNvPr')?.attrs.hidden)) continue;
      const kids = keptChildren(n, from, keep, seen, depth + 1);
      if (kids.length) {
        const props = n.children.filter((c) => c.name === 'p:nvGrpSpPr' || c.name === 'p:grpSpPr');
        out.push({ ...n, children: [...props, ...kids] });
      }
    } else if (LEAVES.has(n.name) && isElement(n, from)) {
      const id = idOf(n);
      const nth = seen.get(id) ?? 0;
      seen.set(id, nth + 1);
      if (keep.has(`${id}#${nth}`)) out.push(n);
    }
  }
  return out;
}

function solidBackground(hex: string): XNode {
  return el('p:bg', {}, [
    el('p:bgPr', {}, [el('a:solidFill', {}, [el('a:srgbClr', { val: hex })]), el('a:effectLst')]),
  ]);
}

// ── Part names and relationships ────────────────────────────────────────────────────────────────────────

/** A relationship of a part of the copy: id, type, target part in the copy. */
interface CopyRel {
  id: string;
  type: string;
  target: string;
}

/** A relationship target from `from` to `to` (both copy names), relative and percent-encoded. */
function relativeTarget(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => '..');
  return [...up, ...b.slice(i)].map((s) => (s === '..' ? s : encodeURIComponent(s))).join('/');
}

function relsXml(rels: readonly CopyRel[], owner: string): string {
  return `${XML_HEAD}<Relationships xmlns="${NS_PKG_RELS}">${rels
    .map(
      (r) =>
        `<Relationship Id="${escAttr(r.id)}" Type="${escAttr(r.type)}" Target="${escAttr(owner ? relativeTarget(owner, r.target) : r.target)}"/>`,
    )
    .join('')}</Relationships>`;
}

/** Where a part of a kind lives in the copy, and the stem of its generated name. */
const PLACES: readonly [RegExp, string, string][] = [
  [/presentationml\.slideLayout\+xml$/, 'ppt/slideLayouts', 'slideLayout'],
  [/presentationml\.slideMaster\+xml$/, 'ppt/slideMasters', 'slideMaster'],
  [/officedocument\.theme\+xml$/, 'ppt/theme', 'theme'],
  [/themeOverride\+xml$/, 'ppt/theme', 'themeOverride'],
  [/drawingml\.chart\+xml$/, 'ppt/charts', 'chart'],
  [/chartstyle\+xml$/, 'ppt/charts', 'style'],
  [/chartcolorstyle\+xml$/, 'ppt/charts', 'colors'],
  [/drawingml\.chartshapes\+xml$/, 'ppt/drawings', 'drawing'],
  [/diagramData\+xml$/, 'ppt/diagrams', 'data'],
  [/diagramLayout\+xml$/, 'ppt/diagrams', 'layout'],
  [/diagramStyle\+xml$/, 'ppt/diagrams', 'quickStyle'],
  [/diagramColors\+xml$/, 'ppt/diagrams', 'colors'],
  [/drawing\+xml$/, 'ppt/diagrams', 'drawing'],
  [/tableStyles\+xml$/, 'ppt', 'tableStyles'],
];

/** Content types of picture parts by extension, for a part the deck's content types do not name. */
const IMAGE_TYPES: ReadonlyMap<string, string> = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['jpe', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['bmp', 'image/bmp'],
  ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'],
  ['emf', 'image/x-emf'],
  ['wmf', 'image/x-wmf'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp'],
  ['wdp', 'image/vnd.ms-photo'],
]);

/** A part's extension: letters and digits only, at most 8, lower case. */
function extOf(part: string): string {
  const base = part.slice(part.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

function isXmlPart(part: string, contentType: string | undefined): boolean {
  const ext = extOf(part);
  if (ext === 'xml' || ext === 'rels') return true;
  return !!contentType && /[+/]xml$/i.test(contentType) && !IMAGE_TYPES.has(ext);
}

// ── The copy ────────────────────────────────────────────────────────────────────────────────────────────

class CopyBuilder {
  readonly parts = new Map<string, Uint8Array>();
  readonly media: [string, string][] = [];
  readonly notes = noteList(50);
  readonly stats: EditStats = { outlines: 0 };
  /** Copy name and content type by deck part (each part is copied once). */
  private names = new Map<string, string>();
  private types = new Map<string, string>();
  private queue: string[] = [];
  private counters = new Map<string, number>();
  private xmlChars = 0;
  private enc = new TextEncoder();
  /** Layouts the pages use, and their masters (only those are copied, with their layouts filtered). */
  readonly usedLayouts = new Set<string>();
  readonly usedMasters = new Set<string>();

  constructor(readonly pkg: Package) {}

  /** Write an XML part of the copy. */
  put(name: string, xml: string, contentType: string | undefined): void {
    this.xmlChars += xml.length;
    if (this.xmlChars > RENDER_COPY_LIMITS.xmlChars)
      throw new RenderCopyLimitError(
        `the render copy is larger than ${RENDER_COPY_LIMITS.xmlChars / 1024 ** 2} M characters`,
      );
    this.count();
    this.parts.set(name, this.enc.encode(xml));
    if (contentType) this.types.set(name, contentType);
  }

  /** One more part, within `RENDER_COPY_LIMITS.parts`. */
  private count(): void {
    if (this.parts.size + this.media.length >= RENDER_COPY_LIMITS.parts)
      throw new RenderCopyLimitError(`the render copy has more than ${RENDER_COPY_LIMITS.parts} parts`);
  }

  /** A fresh name in a directory: `<dir>/<stem><n>.<ext>`. */
  fresh(dir: string, stem: string, ext: string): string {
    const k = `${dir}/${stem}`;
    const n = (this.counters.get(k) ?? 0) + 1;
    this.counters.set(k, n);
    return `${dir}/${stem}${n}.${ext}`;
  }

  /** The copy's name for a deck part, queued for copying on first use. */
  nameOf(part: string): string {
    let name = this.names.get(part);
    if (name !== undefined) return name;
    const ct = this.pkg.contentType(part);
    const ext = extOf(part) || (isXmlPart(part, ct) ? 'xml' : 'bin');
    const place = ct ? PLACES.find(([re]) => re.test(ct)) : undefined;
    name = place
      ? this.fresh(place[1], place[2], ext)
      : IMAGE_TYPES.has(ext)
        ? this.fresh('ppt/media', 'image', ext)
        : this.fresh('ppt/parts', 'part', ext);
    this.names.set(part, name);
    this.queue.push(part);
    return name;
  }

  /**
   * The relationships of `source` the copy keeps (internal, of a kept type, to a part that may be copied, and
   * accepted by `accept`), each mapped to the target's copy name (which queues the target).
   */
  keptRels(source: string, accept: (r: Rel) => boolean = () => true): CopyRel[] {
    const out: CopyRel[] = [];
    for (const r of this.pkg.rels(source))
      if (this.keeps(r) && accept(r)) out.push({ id: r.id, type: r.type, target: this.nameOf(r.target) });
    return out;
  }

  keeps(r: Rel): boolean {
    return (
      !r.external &&
      KEPT_RELS.has(relType(r.type)) &&
      this.pkg.has(r.target) &&
      !refusedTarget(this.pkg, r.target)
    );
  }

  /** Copy every queued part (and what they relate to). */
  drain(): void {
    while (this.queue.length) {
      const part = this.queue.shift()!;
      this.copyPart(part);
    }
  }

  private copyPart(part: string): void {
    const name = this.names.get(part)!;
    const ct = this.pkg.contentType(part);
    if (!isXmlPart(part, ct)) {
      const bytes = this.pkg.bytes(part);
      const type = ct ?? IMAGE_TYPES.get(extOf(part)) ?? 'application/octet-stream';
      this.count();
      if (bytes?.length) this.parts.set(name, bytes);
      else this.media.push([name, part]);
      this.types.set(name, type);
      return;
    }
    let root: XNode | undefined;
    try {
      root = this.pkg.xml(part);
    } catch (e) {
      this.notes.log(`${clean(part, 120)} could not be read: ${clean((e as Error).message, 120)}`);
      return;
    }
    if (!root) return;
    let rels: CopyRel[];
    if (root.name === 'p:sldLayout' || root.name === 'p:sldMaster') {
      const edited = this.templateTree(part, root);
      // A master keeps only the layouts the pages use; layouts and masters keep the rest of their relationships.
      const master = root.name === 'p:sldMaster';
      rels = this.keptRels(
        part,
        (r) => !master || relType(r.type) !== 'slideLayout' || this.usedLayouts.has(r.target),
      );
      this.put(name, writeXml(edited), ct);
    } else {
      rels = this.keptRels(part);
      this.put(name, writeXml(root), ct);
    }
    if (rels.length) this.put(relsName(name), relsXml(rels, name), RELS_CONTENT_TYPE);
  }

  /** A layout or master as the copy prints it: outlines stripped, media and timing removed, layouts filtered. */
  private templateTree(part: string, root: XNode): XNode {
    const used = (rid: string | undefined) => {
      const r = rid === undefined ? undefined : this.pkg.rel(part, rid);
      return !!r && this.usedLayouts.has(r.target);
    };
    const edit = commonEdits(this.stats, false);
    return (
      mapTree(root, (n) => {
        if (n === root) return { ...n, children: n.children.filter((c) => !isTiming(c)) };
        if (n.name === 'p:sldLayoutIdLst')
          return {
            ...n,
            children: n.children.filter((c) => c.name !== 'p:sldLayoutId' || used(c.attrs['r:id'])),
          };
        return edit(n);
      }) ?? root
    );
  }

  contentTypes(): string {
    const overrides = [...this.types]
      .filter(([name]) => !name.endsWith('.rels'))
      .map(
        ([name, ct]) => `<Override PartName="/${escAttr(encodePath(name))}" ContentType="${escAttr(ct)}"/>`,
      );
    return (
      `${XML_HEAD}<Types xmlns="${NS_CONTENT_TYPES}">` +
      `<Default Extension="rels" ContentType="${RELS_CONTENT_TYPE}"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`
    );
  }
}

function encodePath(name: string): string {
  return name
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function relsName(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** The slide part of one page, its relationships and the layout it uses; the page as printed. */
function writePage(
  b: CopyBuilder,
  ref: SlideRef,
  page: RenderCopyPage,
  k: number,
  size: { cx: number; cy: number },
  opts: RenderCopyOptions,
): RenderCopyPage {
  const pkg = b.pkg;
  const root = pkg.xml(ref.part);
  if (root?.name !== 'p:sld') throw new Error('not a slide');
  const name = `ppt/slides/slide${k}.xml`;
  const layoutRel = pkg.relOfType(ref.part, 'slideLayout');
  const layoutPart = layoutRel && b.keeps(layoutRel) ? layoutRel.target : undefined;
  const masterRel = layoutPart ? pkg.relOfType(layoutPart, 'slideMaster') : undefined;
  const masterPart = masterRel && b.keeps(masterRel) ? masterRel.target : undefined;
  if (!layoutPart || !masterPart) throw new Error('the slide has no layout or master');
  b.usedLayouts.add(layoutPart);
  b.usedMasters.add(masterPart);
  if (page.mode === 'picture') return writePicturePage(b, page, name, layoutRel!, size, opts);

  const attrs: Record<string, string> = Object.create(null);
  for (const key in root.attrs) if (key !== 'show') attrs[key] = root.attrs[key]!;
  const extraRels: CopyRel[] = [];
  let cSld: XNode | undefined = child(root, 'p:cSld');
  if (page.mode === 'art') {
    attrs.showMasterSp = '0';
    cSld = artTree(b, ref, page, cSld, layoutPart, masterPart, extraRels);
  }
  const children: XNode[] = [];
  for (const c of root.children) {
    if (c.name === '#text' || isTiming(c)) continue;
    children.push(c.name === 'p:cSld' && cSld ? cSld : c);
  }
  const edit = commonEdits(b.stats, true);
  const edited =
    mapTree({ ...root, attrs, children }, (n) =>
      n.name === 'p:controls' || n.name === 'p:custDataLst' ? null : edit(n),
    ) ?? root;
  b.put(name, writeXml(edited), SLIDE_CONTENT_TYPE);
  // Only what the page still uses: a removed element's picture or clip is not copied.
  const used = relIdsIn(edited);
  const rels = [
    ...b.keptRels(ref.part, (r) => used.has(r.id) || relType(r.type) === 'slideLayout'),
    ...extraRels,
  ];
  b.put(relsName(name), relsXml(rels, name), RELS_CONTENT_TYPE);
  return page;
}

/** A picture page: one `p:pic` of the part, contain-fitted at its aspect, over the forced background. */
function writePicturePage(
  b: CopyBuilder,
  page: Extract<RenderCopyPage, { mode: 'picture' }>,
  name: string,
  layoutRel: Rel,
  size: { cx: number; cy: number },
  opts: RenderCopyOptions,
): RenderCopyPage {
  const part = b.pkg.find(page.part);
  if (part === undefined || refusedTarget(b.pkg, part)) throw new Error('the picture is not in the deck');
  const bytes = b.pkg.bytes(part);
  const px = (bytes?.length ? metafileSize(bytes.subarray(0, 64)) : undefined) ?? opts.pictureSize?.(part);
  const aspect = px ? px.w / px.h : size.cx / size.cy;
  const s = Math.min(size.cx / aspect, size.cy);
  const rect = {
    cx: Math.max(1, Math.round(s * aspect)),
    cy: Math.max(1, Math.round(s)),
    x: 0,
    y: 0,
  };
  rect.x = Math.round((size.cx - rect.cx) / 2);
  rect.y = Math.round((size.cy - rect.cy) / 2);
  const xfrm = el('a:xfrm', {}, [
    el('a:off', { x: String(rect.x), y: String(rect.y) }),
    el('a:ext', { cx: String(rect.cx), cy: String(rect.cy) }),
  ]);
  const picture = el('p:pic', {}, [
    el('p:nvPicPr', {}, [el('p:cNvPr', { id: '2', name: 'Picture' }), el('p:cNvPicPr'), el('p:nvPr')]),
    el('p:blipFill', {}, [
      el('a:blip', { 'r:embed': 'rIdOrdoPicture' }),
      el('a:stretch', {}, [el('a:fillRect')]),
    ]),
    el('p:spPr', {}, [xfrm, el('a:prstGeom', { prst: 'rect' }, [el('a:avLst')])]),
  ]);
  const group = [
    el('p:nvGrpSpPr', {}, [el('p:cNvPr', { id: '1', name: '' }), el('p:cNvGrpSpPr'), el('p:nvPr')]),
    el('p:grpSpPr'),
  ];
  const bg = solidBackground(hexOf(page.background));
  const sld = el('p:sld', { showMasterSp: '0' }, [
    el('p:cSld', {}, [bg, el('p:spTree', {}, [...group, picture])]),
    el('p:clrMapOvr', {}, [el('a:masterClrMapping')]),
  ]);
  b.put(name, writeXml(sld), SLIDE_CONTENT_TYPE);
  const rels: CopyRel[] = [
    { id: layoutRel.id, type: layoutRel.type, target: b.nameOf(layoutRel.target) },
    {
      id: 'rIdOrdoPicture',
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
      target: b.nameOf(part),
    },
  ];
  b.put(relsName(name), relsXml(rels, name), RELS_CONTENT_TYPE);
  return { ...page, rect };
}

/**
 * An art page's `p:cSld`: the forced background, then the layout's and master's art elements (copied, their
 * relationships renamed into the slide's), then the slide's own art elements.
 */
function artTree(
  b: CopyBuilder,
  ref: SlideRef,
  page: Extract<RenderCopyPage, { mode: 'art' }>,
  cSld: XNode | undefined,
  layoutPart: string,
  masterPart: string,
  extraRels: CopyRel[],
): XNode {
  const keep = (from: ElementRef['from']) =>
    new Set(page.keep.filter((r) => r.from === from).map((r) => `${r.shapeId}#${r.nth}`));
  const tree = path(cSld, 'p:spTree');
  const own = tree ? keptChildren(tree, 'slide', keep('slide'), new Map()) : [];
  const decos: XNode[] = [];
  for (const [from, part] of [
    ['master', masterPart],
    ['layout', layoutPart],
  ] as const) {
    const want = keep(from);
    if (!want.size) continue;
    const t = path(b.pkg.xml(part), 'p:cSld', 'p:spTree');
    if (!t) continue;
    const kept = keptChildren(t, from, want, new Map());
    const ids = new Map<string, string>();
    const renamed = (rid: string) => {
      let id = ids.get(rid);
      if (id !== undefined) return id;
      const r = b.pkg.rel(part, rid);
      id = r && b.keeps(r) ? `rIdOrdo${from === 'master' ? 'M' : 'L'}${ids.size + 1}` : 'rIdOrdoNone';
      ids.set(rid, id);
      if (r && id !== 'rIdOrdoNone') extraRels.push({ id, type: r.type, target: b.nameOf(r.target) });
      return id;
    };
    for (const n of kept) {
      const copy = mapTree(n, (x) => {
        let attrs: Record<string, string> | undefined;
        for (const k in x.attrs)
          if (k.startsWith('r:')) {
            attrs ??= Object.assign(Object.create(null), x.attrs) as Record<string, string>;
            attrs[k] = renamed(x.attrs[k]!);
          }
        return attrs ? { ...x, attrs } : x;
      });
      if (copy) decos.push(copy);
    }
  }
  const missing = page.keep.length - countLeaves([...decos, ...own]);
  if (missing > 0) b.notes.log(`slide ${ref.index + 1}: ${missing} art element(s) not found`);
  const props = (tree?.children ?? []).filter((c) => c.name === 'p:nvGrpSpPr' || c.name === 'p:grpSpPr');
  const spTree = el('p:spTree', {}, [...props, ...decos, ...own]);
  const bg = solidBackground(hexOf(page.background));
  return el('p:cSld', cSld?.attrs ?? {}, [bg, spTree]);
}

/** The shape-tree leaves in a list of kept nodes. */
function countLeaves(nodes: readonly XNode[]): number {
  let n = 0;
  const stack = [...nodes];
  while (stack.length) {
    const x = stack.pop()!;
    if (LEAVES.has(x.name)) n++;
    else for (const c of x.children) if (c.name !== '#text') stack.push(c);
  }
  return n;
}

/**
 * Build the render copy of `src` for `pages` (`RenderCopyPage.index` is `SlideRef.index`). Throws only when
 * the deck has no readable presentation part (or the copy would pass `RENDER_COPY_LIMITS`); a page whose
 * slide cannot be read is dropped with a note, so `RenderCopyResult.pages` is what was printed.
 */
export function buildRenderCopy(
  src: PartSource,
  pages: readonly RenderCopyPage[],
  opts: RenderCopyOptions = {},
): RenderCopyResult {
  const deckNotes = noteList(50);
  const pkg = openPackage(src, deckNotes.log);
  const deck = readDeck(pkg);
  if (pages.length > RENDER_COPY_LIMITS.pages)
    throw new Error(`more than ${RENDER_COPY_LIMITS.pages} pages to print`);
  const b = new CopyBuilder(pkg);
  const byIndex = new Map(deck.slides.map((r) => [r.index, r]));
  const printed: RenderCopyPage[] = [];
  for (const page of pages) {
    const ref = byIndex.get(page.index);
    if (!ref) {
      b.notes.log(`slide ${page.index + 1} is not in the deck`);
      continue;
    }
    try {
      printed.push(writePage(b, ref, page, printed.length + 1, deck.size, opts));
    } catch (e) {
      if (e instanceof RenderCopyLimitError) throw e;
      b.notes.log(`slide ${ref.index + 1} could not be copied: ${clean((e as Error).message, 120)}`);
    }
  }

  // The presentation: its masters (only those the pages use), the pages, sizes and default text style.
  const presPart = deck.presentationPart;
  const pres = pkg.xml(presPart)!;
  const presName = 'ppt/presentation.xml';
  const presRels: CopyRel[] = [];
  const masterIds: XNode[] = [];
  for (const m of child(pres, 'p:sldMasterIdLst')?.children ?? []) {
    if (m.name !== 'p:sldMasterId') continue;
    const r = b.pkg.rel(presPart, m.attrs['r:id'] ?? '');
    if (!r || !b.keeps(r) || !b.usedMasters.has(r.target)) continue;
    if (presRels.some((x) => x.id === r.id)) continue;
    presRels.push({ id: r.id, type: r.type, target: b.nameOf(r.target) });
    masterIds.push(m);
  }
  // A master a page uses that the list does not name (a damaged deck) is listed too.
  let extra = 0;
  for (const part of b.usedMasters) {
    const name = b.nameOf(part);
    if (presRels.some((x) => x.target === name)) continue;
    const id = `rIdOrdoMaster${++extra}`;
    presRels.push({
      id,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
      target: name,
    });
    masterIds.push(el('p:sldMasterId', { id: String(2_147_483_648 + 100_000 + extra), 'r:id': id }));
  }
  const theme = pkg.relOfType(presPart, 'theme');
  if (theme && b.keeps(theme))
    presRels.push({ id: theme.id, type: theme.type, target: b.nameOf(theme.target) });
  const tableStyles = pkg.relOfType(presPart, 'tableStyles');
  if (tableStyles && b.keeps(tableStyles))
    presRels.push({ id: tableStyles.id, type: tableStyles.type, target: b.nameOf(tableStyles.target) });
  const sldIds: XNode[] = printed.map((_, i) => {
    const id = `rIdOrdoPage${i + 1}`;
    presRels.push({ id, type: REL_SLIDE, target: `ppt/slides/slide${i + 1}.xml` });
    return el('p:sldId', { id: String(256 + i), 'r:id': id });
  });
  const keepChild = (name: string) => child(pres, name);
  const presAttrs: Record<string, string> = Object.create(null);
  for (const key in pres.attrs) if (key !== 'conformance') presAttrs[key] = pres.attrs[key]!;
  const presTree = el('p:presentation', presAttrs, [
    el('p:sldMasterIdLst', {}, masterIds),
    el('p:sldIdLst', {}, sldIds),
    ...['p:sldSz', 'p:notesSz', 'p:defaultTextStyle']
      .map(keepChild)
      .filter((n): n is XNode => n !== undefined),
  ]);
  b.drain();
  b.put(presName, writeXml(presTree), PRESENTATION_CONTENT_TYPE);
  b.put(relsName(presName), relsXml(presRels, presName), RELS_CONTENT_TYPE);
  b.put(
    '_rels/.rels',
    relsXml([{ id: 'rId1', type: REL_OFFICE_DOCUMENT, target: presName }], ''),
    RELS_CONTENT_TYPE,
  );
  b.put('[Content_Types].xml', b.contentTypes(), undefined);
  for (const n of deckNotes.notes) b.notes.log(n);
  return {
    parts: b.parts,
    media: b.media,
    pages: printed,
    outlines: b.stats.outlines,
    notes: b.notes.notes,
    slideSize: deck.size,
  };
}
