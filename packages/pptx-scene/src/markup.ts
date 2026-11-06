/**
 * Every part is read as one dialect (design/27 §1 `opc.ts`, §4 "Alternate content"): Transitional OOXML with
 * the usual prefixes and Markup Compatibility applied. `Package.xml` runs `normalizePart` once on each part it
 * parses, so no other module deals with Strict URIs, a deck's own choice of prefixes, or both branches of an
 * `mc:AlternateContent`.
 *
 * - **Strict → Transitional** (port of `pptx-render/src/annotate.ts` `strictToTransitional`): namespace and
 *   relationship-type URIs under `http://purl.oclc.org/ooxml/` become their Transitional form wherever they are
 *   an attribute value (declarations, `Type`, `a:graphicData uri`), and in DrawingML/PresentationML parts a
 *   Strict percentage (`val="90%"`) becomes thousandths (`val="90000"`).
 * - **Usual prefixes.** Elements and attributes of a known namespace get its usual prefix (`p:`, `a:`, `r:`,
 *   `mc:`, `p14:` …; none for the package's relationships and content types), whatever prefix, or default
 *   namespace, the deck declared. A deck may write `<pml:sld xmlns:pml="…presentationml/2006/main">` or
 *   `rel:id`; LibreOffice reads both by namespace (verified), and so does every module here. Names of
 *   namespaces this table does not know, and undeclared prefixes, stay as written.
 * - **Alternate content.** Each `mc:AlternateContent` keeps only the branch to read: the first `mc:Choice`
 *   whose `Requires` prefixes all name namespaces in `UNDERSTOOD_NAMESPACES`, else the first `mc:Fallback`,
 *   else nothing. The wrapper stays (classification counts it); the branch keeps its element name, and a kept
 *   Choice's `Requires` is rewritten with the usual prefixes. Never both branches (`annotate.ts` walks both;
 *   that is not ported).
 *
 * Linear and iterative: one pass over the tree with a chain of namespace scopes. Attribute maps stay
 * null-prototype objects.
 *
 * Owned by work item A (reading).
 */
import type { XNode } from './xml.ts';

/** Namespace URIs by their usual prefix (Transitional). */
export const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  dgm: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  p14: 'http://schemas.microsoft.com/office/powerpoint/2010/main',
  p15: 'http://schemas.microsoft.com/office/powerpoint/2012/main',
  a14: 'http://schemas.microsoft.com/office/drawing/2010/main',
  a16: 'http://schemas.microsoft.com/office/drawing/2014/main',
  dsp: 'http://schemas.microsoft.com/office/drawing/2008/diagram',
  asvg: 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
} as const;

/** The package's own vocabularies, written without a prefix. */
export const NS_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const NS_XML = 'http://www.w3.org/XML/1998/namespace';

/** Namespace URI → the prefix every module reads it under ('' for none). */
export const USUAL_PREFIX: ReadonlyMap<string, string> = new Map([
  ...Object.entries(NS).map(([prefix, uri]) => [uri, prefix] as [string, string]),
  [NS_RELATIONSHIPS, ''],
  [NS_CONTENT_TYPES, ''],
]);

/** Usual prefix → namespace URI, for a `Requires` prefix the deck forgot to declare. */
const USUAL_URI: ReadonlyMap<string, string> = new Map(Object.entries(NS));

/**
 * Namespaces whose `mc:Choice` is read instead of its Fallback. LibreOffice takes the Choice for the prefixes
 * a14 (maths), p14 and p15 (verified: by literal prefix, where this goes by namespace) and for `v` (VML),
 * which this parser does not read. Anything newer (am3d, cx charts, aink, p159 …) takes its Fallback picture.
 */
export const UNDERSTOOD_NAMESPACES: ReadonlySet<string> = new Set([
  NS.a,
  NS.p,
  NS.r,
  NS.mc,
  NS.a14,
  NS.p14,
  NS.p15,
]);

/** The namespace and relationship-type root of Strict OOXML (ISO/IEC 29500 Strict). */
export const STRICT_ROOT = 'http://purl.oclc.org/ooxml/';
const STRICT_AREAS: ReadonlySet<string> = new Set([
  'drawingml',
  'presentationml',
  'spreadsheetml',
  'wordprocessingml',
  'officeDocument',
]);
/** Strict names that differ in Transitional (the rest only move under `…/2006/`). */
const STRICT_RENAMED: ReadonlyMap<string, string> = new Map([
  [
    'officeDocument/relationships/metadata/thumbnail',
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail',
  ],
  [
    'officeDocument/relationships/metadata/core-properties',
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  ],
  [
    'officeDocument/relationships/extendedProperties',
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  ],
  [
    'officeDocument/relationships/customProperties',
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties',
  ],
  [
    'officeDocument/extendedProperties',
    'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  ],
  [
    'officeDocument/customProperties',
    'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
  ],
]);

/** `[A-Za-z0-9/-]+`, as `annotate.ts` matches the rest of a Strict URI. */
function uriTail(s: string): boolean {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x2f ||
      c === 0x2d;
    if (!ok) return false;
  }
  return true;
}

/** A Strict namespace or relationship-type URI in its Transitional form; any other string unchanged. */
export function transitionalUri(uri: string): string {
  if (!uri.startsWith(STRICT_ROOT)) return uri;
  const rest = uri.slice(STRICT_ROOT.length);
  const slash = rest.indexOf('/');
  if (slash < 0 || !STRICT_AREAS.has(rest.slice(0, slash)) || !uriTail(rest.slice(slash + 1))) return uri;
  return (
    STRICT_RENAMED.get(rest) ??
    `http://schemas.openxmlformats.org/${rest.slice(0, slash)}/2006/${rest.slice(slash + 1)}`
  );
}

/**
 * DrawingML and PresentationML parts (as `annotate.ts`, plus SmartArt drawings), whose Strict percentages are
 * thousandths in Transitional. `name` is the stored part name; compared without case.
 */
export function isPercentPart(name: string): boolean {
  const n = name.toLowerCase();
  if (!n.startsWith('ppt/') || !n.endsWith('.xml')) return false;
  const slash = n.indexOf('/', 4);
  if (slash < 0 || n.indexOf('/', slash + 1) >= 0) return false;
  return PERCENT_DIRS.has(n.slice(4, slash));
}
const PERCENT_DIRS: ReadonlySet<string> = new Set([
  'slides',
  'slidelayouts',
  'slidemasters',
  'notesslides',
  'notesmasters',
  'handoutmasters',
  'theme',
  'diagrams',
]);

/** Attributes that hold the deck's own words, never a percentage. */
const FREE_TEXT: ReadonlySet<string> = new Set(['name', 'descr', 'title']);

/** `-?\d+(\.\d+)?%` as thousandths, or undefined. */
function percent(v: string): string | undefined {
  if (v.length < 2 || v.length > 32 || v.charCodeAt(v.length - 1) !== 0x25) return undefined;
  let i = v.charCodeAt(0) === 0x2d ? 1 : 0;
  const start = i;
  let dot = -1;
  for (; i < v.length - 1; i++) {
    const c = v.charCodeAt(i);
    if (c === 0x2e && dot < 0 && i > start) dot = i;
    else if (c < 0x30 || c > 0x39) return undefined;
  }
  if (i === start || dot === v.length - 2) return undefined;
  const n = Math.round(Number(v.slice(0, -1)) * 1000);
  return Number.isFinite(n) ? String(n === 0 ? 0 : n) : undefined;
}

export interface NormalizeOptions {
  /** The part's text names the Strict root: map Strict URIs. */
  strict: boolean;
  /** Also turn Strict percentages into thousandths (`strict` and `isPercentPart`). */
  percents: boolean;
}

/** A namespace scope: the declarations of one element, chained to its ancestors'. */
interface Scope {
  up: Scope | undefined;
  own: Map<string, string> | undefined;
  /** Some binding in scope gives a known namespace another prefix than its usual one. */
  renaming: boolean;
  /** Prefix → usual prefix (null: keep), worked out once per scope. */
  memo?: Map<string, string | null>;
}

const ROOT: Scope = { up: undefined, own: new Map([['xml', NS_XML]]), renaming: false };

function resolve(scope: Scope, prefix: string): string | undefined {
  for (let s: Scope | undefined = scope; s; s = s.up) {
    const uri = s.own?.get(prefix);
    if (uri !== undefined) return uri;
  }
  return undefined;
}

/** The usual prefix for `prefix` in `scope`, or null when the name stays as written. */
function usualPrefix(scope: Scope, prefix: string): string | null {
  scope.memo ??= new Map();
  let v = scope.memo.get(prefix);
  if (v === undefined) {
    const uri = resolve(scope, prefix);
    const want = uri === undefined ? undefined : USUAL_PREFIX.get(uri);
    v = want === undefined || want === prefix ? null : want;
    scope.memo.set(prefix, v);
  }
  return v;
}

function declare(up: Scope, attrs: Record<string, string>): Scope {
  let own: Map<string, string> | undefined;
  for (const k in attrs) {
    if (k === 'xmlns') (own ??= new Map()).set('', attrs[k]!);
    else if (k.startsWith('xmlns:') && k.length > 6) (own ??= new Map()).set(k.slice(6), attrs[k]!);
  }
  if (!own) return up;
  let renaming = up.renaming;
  if (!renaming)
    for (const [prefix, uri] of own) {
      const want = USUAL_PREFIX.get(uri);
      if (want !== undefined && want !== prefix) {
        renaming = true;
        break;
      }
    }
  return { up, own, renaming };
}

function renamed(name: string, scope: Scope, element: boolean): string {
  const colon = name.indexOf(':');
  if (colon < 0 && !element) return name; // an unprefixed attribute has no namespace
  const prefix = colon < 0 ? '' : name.slice(0, colon);
  if (prefix === 'xmlns' || prefix === 'xml') return name;
  const want = usualPrefix(scope, prefix);
  if (want === null) return name;
  const local = colon < 0 ? name : name.slice(colon + 1);
  return want ? `${want}:${local}` : local;
}

/** Read one element (not its children) as Transitional with the usual prefixes; returns its scope. */
function prepare(n: XNode, up: Scope, o: NormalizeOptions): Scope {
  const attrs = n.attrs;
  if (o.strict)
    for (const k in attrs) {
      const v = attrs[k]!;
      if (v.startsWith(STRICT_ROOT)) attrs[k] = transitionalUri(v);
    }
  const scope = declare(up, attrs);
  if (scope.renaming) {
    n.name = renamed(n.name, scope, true);
    let changed = false;
    for (const k in attrs)
      if (renamed(k, scope, false) !== k) {
        changed = true;
        break;
      }
    if (changed) {
      const out: Record<string, string> = Object.create(null);
      for (const k in attrs) {
        const nk = renamed(k, scope, false);
        if (!(nk in out)) out[nk] = attrs[k]!;
      }
      n.attrs = out;
    }
  }
  if (o.percents)
    for (const k in n.attrs) {
      if (FREE_TEXT.has(k)) continue;
      const v = percent(n.attrs[k]!);
      if (v !== undefined) n.attrs[k] = v;
    }
  return scope;
}

/** `Requires` prefixes read in more than this number are not understood. */
const MAX_REQUIRES = 16;

function prefixesOf(requires: string | undefined): string[] | undefined {
  const list = (requires ?? '').trim().split(/\s+/);
  return list[0] && list.length <= MAX_REQUIRES ? list : undefined;
}

function understood(requires: string | undefined, scope: Scope): boolean {
  const list = prefixesOf(requires);
  if (!list) return false;
  for (const prefix of list) {
    const uri = resolve(scope, prefix) ?? USUAL_URI.get(prefix);
    if (uri === undefined || !UNDERSTOOD_NAMESPACES.has(uri)) return false;
  }
  return true;
}

/** Pick the branch of an `mc:AlternateContent` (its children prepared on the way). */
function choose(ac: XNode, scope: Scope, o: NormalizeOptions): [XNode, Scope] | undefined {
  let chosen: [XNode, Scope] | undefined;
  let fallback: [XNode, Scope] | undefined;
  for (const c of ac.children) {
    if (c.name === '#text') continue;
    const s = prepare(c, scope, o);
    if (c.name === 'mc:Choice') {
      if (!chosen && understood(c.attrs.Requires, s)) {
        chosen = [c, s];
        c.attrs.Requires = prefixesOf(c.attrs.Requires)!
          .map((p) => USUAL_PREFIX.get(resolve(s, p) ?? USUAL_URI.get(p) ?? '') ?? p)
          .join(' ');
      }
    } else if (c.name === 'mc:Fallback') fallback ??= [c, s];
  }
  return chosen ?? fallback;
}

/**
 * Rewrite a freshly parsed part in place: Strict URIs and percentages, the usual prefixes, and every
 * `mc:AlternateContent` reduced to the branch to read (see the module comment).
 */
export function normalizePart(root: XNode, o: NormalizeOptions): void {
  const stack: [XNode, Scope][] = [[root, ROOT]];
  while (stack.length) {
    const [n, up] = stack.pop()!;
    const scope = prepare(n, up, o);
    let kids = n.children;
    let kidScope = scope;
    if (n.name === 'mc:AlternateContent') {
      const branch = choose(n, scope, o);
      n.children = branch ? [branch[0]] : [];
      if (!branch) continue;
      kids = branch[0].children;
      kidScope = branch[1];
    }
    for (const c of kids) if (c.name !== '#text') stack.push([c, kidScope]);
  }
}

/**
 * The branch of an `mc:AlternateContent` to read. In a part read through `Package.xml` that is its only
 * element child. In a tree parsed some other way, the rule above is applied with the declarations on the
 * element and its branches and, for undeclared prefixes, the usual ones. Undefined when there is none.
 */
export function chooseAlternate(ac: XNode): XNode | undefined {
  const scope = declare(ROOT, ac.attrs);
  let chosen: XNode | undefined;
  let fallback: XNode | undefined;
  for (const c of ac.children) {
    if (c.name === 'mc:Choice' && !chosen && understood(c.attrs.Requires, declare(scope, c.attrs)))
      chosen = c;
    else if (c.name === 'mc:Fallback') fallback ??= c;
  }
  return chosen ?? fallback;
}
