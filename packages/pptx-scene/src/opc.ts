/**
 * The package (OPC) layer: part lookup, text decoding, XML parsing with a bounded per-part cache, content
 * types and relationships (design/27 §1 `opc.ts`, §12).
 *
 * - **Parts** are found by name without case; the first of names that differ only by case wins. A zip entry
 *   stored percent-encoded (`image%201.png`) is also found under its decoded name, as targets are decoded.
 * - **XML** is read as one dialect (`markup.ts`): Strict OOXML as Transitional (URIs, `"90%"` percentages),
 *   the usual prefixes whatever the deck declared, and each `mc:AlternateContent` reduced to its branch.
 * - **Content types**: an `Override` naming a part that is not in the package is ignored.
 * - **Relationships** resolve inside the package only: fragment dropped, percent-decoded, `.`/`..` applied
 *   (never above the root), a leading `/` meaning the root, matched to a stored part without case. A
 *   duplicate `Id` keeps the first. `TargetMode="External"` targets are never resolved or fetched; each is
 *   noted with its host only.
 *
 * Owned by work item A (reading).
 */
import { type Log, clean } from './log.ts';
import { isPercentPart, normalizePart, STRICT_ROOT, transitionalUri } from './markup.ts';
import { parseXml, rootOf, type XNode } from './xml.ts';

/** A deck's parts by zip entry name (no leading slash), as `extractZip` returns them in `files`. */
export type PartSource = Map<string, Uint8Array>;

/** An XML part larger than this is refused (design/27 §12). */
export const MAX_XML_PART_BYTES = 8 * 1024 * 1024;
/** A relationship target longer than this is ignored (real ones are a few dozen characters). */
export const MAX_TARGET_CHARS = 2_048;
/** External targets noted per package; the rest are counted in one note. */
export const MAX_EXTERNAL_NOTES = 20;
/**
 * Parsed parts are kept while the text they came from totals at most this many characters (least recently
 * used dropped first; the newest is always kept). A parsed tree takes several times its text, and a slide is
 * read only while it is converted, but layouts, masters and themes are read for every slide.
 */
export const XML_CACHE_CHARS = 16 * 1024 * 1024;

/** The content type of a slide part. */
export const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';

/** A relationship, its target resolved inside the package. */
export interface Rel {
  id: string;
  /** The full type URI, Transitional. Compare with `relType` (its last segment) or `relOfType`. */
  type: string;
  /** The target part name (resolved, normalised, the stored name when present); the raw target when external. */
  target: string;
  external: boolean;
}

export interface Package {
  /** The stored name of a part, matched case-insensitively (the first entry wins on a case-only clash). */
  find(name: string): string | undefined;
  has(name: string): boolean;
  /** A part's bytes (empty when the extractor spilled it to disk). */
  bytes(name: string): Uint8Array | undefined;
  /** An XML part's text, decoded (by BOM, else the declared encoding, else UTF-8). Throws when over budget. */
  text(name: string): string | undefined;
  /**
   * The root element of an XML part, read as Transitional with the usual prefixes and alternate content
   * resolved (`markup.ts`), parsed once and cached; undefined when the part is missing. Throws when it is over
   * budget or malformed (the caller quarantines the slide that needs it).
   */
  xml(name: string): XNode | undefined;
  /** The relationships of a part ('' for the package's own `_rels/.rels`), in document order. */
  rels(source: string): Rel[];
  rel(source: string, id: string): Rel | undefined;
  /**
   * The first internal relationship of `source` of a type: a short name compared with `relType`
   * ('slideLayout', 'theme', …) or a full type URI (Strict or Transitional).
   */
  relOfType(source: string, type: string): Rel | undefined;
  contentType(name: string): string | undefined;
  /** Parts named by a content-type `Override` of this type (without case), in document order. */
  partsOfType(contentType: string): string[];
  log: Log;
}

export interface PackageOptions {
  /** Characters of XML text whose parsed trees are kept (default `XML_CACHE_CHARS`). */
  cacheChars?: number;
}

/** The last segment of a relationship type URI: 'slideLayout', 'image', 'officeDocument', … */
export function relType(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1);
}

/** The relationships part of `part` ('' is the package root). */
export function relsPartOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

function percentDecoded(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // an escape that does not decode is read as written
  }
}

/**
 * A relationship target resolved against its source part: fragment dropped, percent-decoded, `.` and `..`
 * applied (never above the root), leading `/` meaning the package root. Undefined when nothing is left.
 */
export function resolveTarget(source: string, target: string): string | undefined {
  let t = target;
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  t = percentDecoded(t).replaceAll('\\', '/');
  const out = t.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const seg of t.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.length ? out.join('/') : undefined;
}

/**
 * The host of an external target, for a log line: never the path, query or user information. A drive
 * path, a relative path or a `file:` URL without a host is 'a local file'; a URL without a host
 * (`mailto:`) is its scheme.
 */
export function externalHost(target: string): string {
  const t = target.slice(0, MAX_TARGET_CHARS).trim();
  let authority: string | undefined;
  let scheme: string | undefined;
  if (t.startsWith('\\\\') || t.startsWith('//')) authority = t.slice(2);
  else {
    const m = /^([a-z][a-z0-9+.-]{1,30}):/i.exec(t);
    if (m) {
      scheme = m[1]!.toLowerCase();
      const rest = t.slice(m[0].length);
      if (rest.startsWith('//')) authority = rest.slice(2);
    }
  }
  if (authority !== undefined) {
    let end = 0;
    while (end < authority.length && end < 300 && !'/\\?#'.includes(authority[end]!)) end++;
    let host = authority.slice(0, end);
    host = host.slice(host.lastIndexOf('@') + 1);
    host = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d{0,10}$/, '');
    if (host) return clean(host.toLowerCase(), 100);
  }
  return scheme && scheme !== 'file' ? clean(`${scheme}:`, 40) : 'a local file';
}

/** The `encoding` of an XML declaration at the start of `b`, lower case, or undefined. */
function declaredEncoding(b: Uint8Array): string | undefined {
  const at = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  if (b[at] !== 0x3c || b[at + 1] !== 0x3f) return undefined;
  let head = '';
  for (let i = at; i < Math.min(b.length, at + 200); i++) head += String.fromCharCode(b[i]!);
  const end = head.indexOf('?>');
  if (end < 0) return undefined;
  return /\sencoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/.exec(head.slice(0, end))?.[1]?.toLowerCase();
}

/**
 * A part's text: UTF-16 by BOM (or by `<?` written in UTF-16), else the encoding its XML declaration
 * names when that is not UTF-8 or UTF-16 (`windows-1252`, `iso-8859-1`), else UTF-8. A BOM is dropped.
 */
export function decodeText(b: Uint8Array): string {
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0x3c && b[1] === 0 && b[2] === 0x3f && b[3] === 0))
    return new TextDecoder('utf-16le').decode(b);
  if ((b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0 && b[1] === 0x3c && b[2] === 0 && b[3] === 0x3f))
    return new TextDecoder('utf-16be').decode(b);
  const label = declaredEncoding(b);
  if (
    label &&
    label !== 'utf-8' &&
    label !== 'utf8' &&
    !label.startsWith('utf-16') &&
    !label.startsWith('ucs')
  )
    try {
      return new TextDecoder(label).decode(b);
    } catch {
      /* an unknown label: UTF-8 */
    }
  return new TextDecoder('utf-8').decode(b);
}

/** The relationship id an element names (`r:id` or `r:<local>`), whatever prefix the deck bound it to. */
export function relIdOf(el: XNode | undefined, local = 'id'): string | undefined {
  if (!el) return undefined;
  const v = el.attrs[`r:${local}`];
  if (v !== undefined) return v;
  // Parts read through `Package.xml` carry `r:` for a declared relationships namespace; a deck that never
  // declared its prefix still means a relationship id here (as `annotate.ts` reads `sldId`).
  const suffix = `:${local}`;
  for (const k in el.attrs) if (k.endsWith(suffix) && !k.startsWith('xml')) return el.attrs[k];
  return undefined;
}

interface Cached {
  value: XNode | Error | undefined;
  chars: number;
}

export function openPackage(src: PartSource, log: Log = () => {}, opts: PackageOptions = {}): Package {
  const cacheChars = opts.cacheChars ?? XML_CACHE_CHARS;
  const lower = new Map<string, string>();
  for (const name of src.keys()) {
    const k = name.toLowerCase();
    if (!lower.has(k)) lower.set(k, name);
  }
  // Entries stored percent-encoded are also found under their decoded names (after every real name).
  for (const name of src.keys()) {
    const d = percentDecoded(name).toLowerCase();
    if (!lower.has(d)) lower.set(d, name);
  }
  // Always through the folded map, so a name spelled like the second of a case clash still finds the first.
  const find = (name: string) => lower.get(name.toLowerCase());

  const text = (name: string): string | undefined => {
    const real = find(name);
    if (real === undefined) return undefined;
    const b = src.get(real)!;
    if (b.length > MAX_XML_PART_BYTES) throw new Error(`${clean(real)} is larger than 8 MB`);
    return decodeText(b);
  };

  const cache = new Map<string, Cached>();
  let cached = 0;
  let strictNoted = false;
  const remember = (real: string, entry: Cached) => {
    cache.set(real, entry);
    cached += entry.chars;
    for (const [k, v] of cache) {
      if (cached <= cacheChars || k === real) break;
      cache.delete(k);
      cached -= v.chars;
    }
  };
  const parse = (real: string): Cached => {
    let chars = 0;
    try {
      const t = text(real) ?? '';
      chars = t.length;
      const root = rootOf(parseXml(t, clean(real)));
      if (root) {
        const strict = t.includes(STRICT_ROOT);
        if (strict && !strictNoted) {
          strictNoted = true;
          log('Strict OOXML read as Transitional');
        }
        normalizePart(root, { strict, percents: strict && isPercentPart(real) });
      }
      return { value: root, chars };
    } catch (e) {
      return { value: e instanceof Error ? e : new Error(String(e)), chars };
    }
  };
  const xml = (name: string): XNode | undefined => {
    const real = find(name);
    if (real === undefined) return undefined;
    let entry = cache.get(real);
    if (entry) {
      cache.delete(real); // most recently used last
      cache.set(real, entry);
    } else {
      entry = parse(real);
      remember(real, entry);
    }
    if (entry.value instanceof Error) throw entry.value;
    return entry.value;
  };

  const externals = new Set<string>();
  let moreExternals = 0;
  const noteExternal = (type: string, target: string) => {
    const msg = `external ${clean(relType(type), 40) || 'link'} target (${externalHost(target)}) is not fetched`;
    if (externals.has(msg)) return;
    if (externals.size < MAX_EXTERNAL_NOTES) {
      externals.add(msg);
      log(msg);
    } else if (++moreExternals === 1) log('more external targets are not listed');
  };

  const relsCache = new Map<string, { list: Rel[]; byId: Map<string, Rel> }>();
  const relsOf = (source: string) => {
    let r = relsCache.get(source);
    if (r) return r;
    r = { list: [], byId: new Map() };
    relsCache.set(source, r);
    let root: XNode | undefined;
    try {
      root = xml(relsPartOf(source));
    } catch (e) {
      log(`${clean(relsPartOf(source))} could not be read: ${clean((e as Error).message)}`);
    }
    let long = 0;
    for (const n of root?.children ?? []) {
      if (n.name !== 'Relationship') continue;
      const id = n.attrs.Id;
      const raw = n.attrs.Target;
      if (!id || raw === undefined || r.byId.has(id)) continue;
      if (raw.length > MAX_TARGET_CHARS) {
        long++;
        continue;
      }
      const type = n.attrs.Type ?? '';
      const external = n.attrs.TargetMode?.toLowerCase() === 'external';
      if (external) noteExternal(type, raw);
      const target = external ? raw : resolveTarget(source, raw);
      if (target === undefined) continue;
      const rel: Rel = { id, type, target: external ? target : (find(target) ?? target), external };
      r.list.push(rel);
      r.byId.set(id, rel);
    }
    if (long) log(`${clean(relsPartOf(source))}: ${long} relationship target(s) too long, ignored`);
    return r;
  };

  let types: { defaults: Map<string, string>; overrides: Map<string, string> } | undefined;
  const contentTypes = () => {
    if (types) return types;
    types = { defaults: new Map(), overrides: new Map() };
    let root: XNode | undefined;
    try {
      root = xml('[Content_Types].xml');
    } catch (e) {
      log(`[Content_Types].xml could not be read: ${clean((e as Error).message)}`);
    }
    for (const n of root?.children ?? []) {
      const ct = n.attrs.ContentType;
      if (!ct) continue;
      if (n.name === 'Default' && n.attrs.Extension) {
        const ext = n.attrs.Extension.toLowerCase();
        if (!types.defaults.has(ext)) types.defaults.set(ext, ct);
      } else if (n.name === 'Override' && n.attrs.PartName) {
        const p = resolveTarget('', n.attrs.PartName);
        // An override naming a missing part is ignored.
        const real = p === undefined ? undefined : find(p);
        if (real !== undefined && !types.overrides.has(real)) types.overrides.set(real, ct);
      }
    }
    return types;
  };

  return {
    find,
    has: (name) => find(name) !== undefined,
    bytes: (name) => {
      const real = find(name);
      return real === undefined ? undefined : src.get(real);
    },
    text,
    xml,
    rels: (source) => relsOf(source).list,
    rel: (source, id) => relsOf(source).byId.get(id),
    relOfType: (source, type) => {
      const full = type.includes('/') ? transitionalUri(type) : undefined;
      return relsOf(source).list.find(
        (r) => !r.external && (full === undefined ? relType(r.type) === type : r.type === full),
      );
    },
    contentType: (name) => {
      const real = find(name);
      if (real === undefined) return undefined;
      const t = contentTypes();
      const dot = real.lastIndexOf('.');
      return (
        t.overrides.get(real) ?? (dot >= 0 ? t.defaults.get(real.slice(dot + 1).toLowerCase()) : undefined)
      );
    },
    partsOfType: (contentType) => {
      const want = contentType.toLowerCase();
      const out: string[] = [];
      for (const [part, ct] of contentTypes().overrides) if (ct.toLowerCase() === want) out.push(part);
      return out;
    },
    log,
  };
}
