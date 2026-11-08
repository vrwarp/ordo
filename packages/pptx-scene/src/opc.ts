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
 *   noted with its host only. Each part's list is indexed by id and by type once.
 * - **Cache** (design/27 §12, §13): parsed shared parts and relationship lists are kept within an estimated
 *   budget sized for a slide's working set, least recently used dropped first; the parts the current slide
 *   inherits from are pinned (`pin`), so nothing read for a slide evicts its own layout, master or theme.
 *   A slide's tree and relationships are never kept past it, so a hostile slide cannot evict shared parts.
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
/**
 * An internal target whose resolved part name is longer than this is ignored: part names reach media ids,
 * job payloads and notes, which design/27 §12 bounds to 512 characters.
 */
export const MAX_PART_NAME_CHARS = 512;
/** External targets noted per package; the rest are counted in one note. */
export const MAX_EXTERNAL_NOTES = 20;
/**
 * What a parsed tree is charged against the cache per element, in bytes: a node with its attribute map and
 * child array retains about 280 bytes in V8, much more than its markup, so a budget in characters alone
 * lets a deck within the §12 part budgets keep gigabytes alive.
 */
export const XML_NODE_BYTES = 300;
/** What one relationship of a kept list is charged against the cache (its object, strings and indexes). */
export const REL_BYTES = 300;
/**
 * Parsed parts and relationship lists are kept while their estimated size (text characters +
 * `XML_NODE_BYTES` per element, `REL_BYTES` per relationship) totals at most this: least recently used dropped
 * first, the newest and the pinned ones (`Package.pin`: the current slide's layout, master and theme, and
 * their relationships) never. Sized for the working set of a slide: its layout, master and theme each at the
 * §12 tag limit fit, so a deck whose shared parts are that large still parses each of them once. A slide's
 * own tree (`Package.xml` `keep: false`) and relationships are never kept past it.
 */
export const XML_CACHE_BYTES = 256 * 1024 * 1024;

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
   * budget or malformed (the caller quarantines the slide that needs it). With `keep: false` a part that is
   * not cached yet is parsed without being cached (a slide, read once).
   */
  xml(name: string, opts?: { keep?: boolean }): XNode | undefined;
  /** The relationships of a part ('' for the package's own `_rels/.rels`), in document order. */
  rels(source: string): Rel[];
  rel(source: string, id: string): Rel | undefined;
  /**
   * The first internal relationship of `source` of a type: a short name compared with `relType`
   * ('slideLayout', 'theme', …) or a full type URI (Strict or Transitional). Indexed once per part.
   */
  relOfType(source: string, type: string): Rel | undefined;
  contentType(name: string): string | undefined;
  /** Parts named by a content-type `Override` of this type (without case), in document order. */
  partsOfType(contentType: string): string[];
  log: Log;
  /**
   * Pin these parts (and their relationship lists) in the cache, replacing the parts pinned before: the
   * shared parts the slide being read inherits from (`slideParts` pins its layout, master and theme as it
   * finds them), which nothing read for that slide may evict.
   */
  pin(parts: readonly (string | undefined)[]): void;
}

export interface PackageOptions {
  /** Estimated bytes of parsed trees kept (default `XML_CACHE_BYTES`; see `XML_NODE_BYTES`). */
  cacheBytes?: number;
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
  /** The estimated size charged against the cache. */
  cost: number;
}

/** One part's relationships: in document order, and indexed by id and by type (first of each). */
interface RelList {
  list: Rel[];
  byId: Map<string, Rel>;
  /** Internal relationships by short type name (`relType`) and by full Transitional URI. */
  byType: Map<string, Rel>;
}

/** A cache entry: a parsed part, or a part's relationships. `part` is the stored name it belongs to. */
type Entry = { part: string; cost: number } & ({ tree: Cached } | { rels: RelList });

/** Elements of a parsed tree (iterative: the tree is bounded by the parser, not by the stack). */
function elementCount(root: XNode | undefined): number {
  let n = 0;
  const stack = root ? [root] : [];
  while (stack.length) {
    const x = stack.pop()!;
    n++;
    for (const c of x.children) stack.push(c);
  }
  return n;
}

export function openPackage(src: PartSource, log: Log = () => {}, opts: PackageOptions = {}): Package {
  const cacheBytes = opts.cacheBytes ?? XML_CACHE_BYTES;
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

  // One LRU over parsed parts (key `x` + part) and relationship lists (key `r` + part), oldest first.
  const cache = new Map<string, Entry>();
  let cached = 0;
  /** Stored names of the pinned parts: never evicted (`Package.pin`). */
  let pinned = new Set<string>();
  /** The last part read with `keep: false` (a slide): its relationships are held only until the next one. */
  let transient: string | undefined;
  let transientRels: { part: string; rels: RelList } | undefined;
  let strictNoted = false;
  const remember = (key: string, entry: Entry) => {
    cache.set(key, entry);
    cached += entry.cost;
    if (cached <= cacheBytes) return;
    for (const [k, v] of cache) {
      if (cached <= cacheBytes) break;
      if (k === key || pinned.has(v.part)) continue;
      cache.delete(k);
      cached -= v.cost;
    }
  };
  const lookup = (key: string): Entry | undefined => {
    const e = cache.get(key);
    if (e) {
      cache.delete(key); // most recently used last
      cache.set(key, e);
    }
    return e;
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
      return { value: root, cost: chars + XML_NODE_BYTES * elementCount(root) };
    } catch (e) {
      return { value: e instanceof Error ? e : new Error(String(e)), cost: chars };
    }
  };
  /** A part's tree: from the cache, else parsed and kept (`keep`), else parsed for this caller only. */
  const tree = (real: string, keep: boolean): XNode | undefined => {
    const hit = lookup(`x${real}`);
    let entry: Cached;
    if (hit && 'tree' in hit) entry = hit.tree;
    else {
      entry = parse(real);
      if (keep) remember(`x${real}`, { part: real, cost: entry.cost, tree: entry });
    }
    if (entry.value instanceof Error) throw entry.value;
    return entry.value;
  };
  const xml = (name: string, o: { keep?: boolean } = {}): XNode | undefined => {
    const real = find(name);
    if (real === undefined) return undefined;
    if (o.keep === false) transient = real;
    return tree(real, o.keep !== false);
  };
  /** A part read once for what is derived from it (relationships, content types): never kept. */
  const once = (name: string): XNode | undefined => {
    const real = find(name);
    return real === undefined ? undefined : tree(real, false);
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

  /** Read a part's relationships (its `.rels` tree is parsed for this and not kept). */
  const readRels = (source: string): RelList => {
    const r: RelList = { list: [], byId: new Map(), byType: new Map() };
    let root: XNode | undefined;
    try {
      root = once(relsPartOf(source));
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
      if (!external && target.length > MAX_PART_NAME_CHARS) {
        long++;
        continue;
      }
      const rel: Rel = { id, type, target: external ? target : (find(target) ?? target), external };
      r.list.push(rel);
      r.byId.set(id, rel);
      if (!external) {
        // `type` is Transitional already (`markup.ts`); keyed by its full URI and by its last segment.
        const short = `s${relType(type)}`;
        if (!r.byType.has(short)) r.byType.set(short, rel);
        if (!r.byType.has(`u${type}`)) r.byType.set(`u${type}`, rel);
      }
    }
    if (long) log(`${clean(relsPartOf(source))}: ${long} relationship target(s) too long, ignored`);
    return r;
  };
  const relsOf = (source: string): RelList => {
    if (source === transient) {
      // The slide being read: held until the next slide, never in the cache.
      if (transientRels?.part !== source) transientRels = { part: source, rels: readRels(source) };
      return transientRels.rels;
    }
    const hit = lookup(`r${source}`);
    if (hit && 'rels' in hit) return hit.rels;
    const rels = readRels(source);
    const part = find(source) ?? source;
    remember(`r${source}`, { part, cost: REL_BYTES * (rels.list.length + 1), rels });
    return rels;
  };

  let types: { defaults: Map<string, string>; overrides: Map<string, string> } | undefined;
  const contentTypes = () => {
    if (types) return types;
    types = { defaults: new Map(), overrides: new Map() };
    let root: XNode | undefined;
    try {
      root = once('[Content_Types].xml');
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
    relOfType: (source, type) =>
      relsOf(source).byType.get(type.includes('/') ? `u${transitionalUri(type)}` : `s${type}`),
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
    pin: (parts) => {
      pinned = new Set();
      for (const p of parts) {
        const real = p === undefined ? undefined : find(p);
        if (real !== undefined) pinned.add(real);
      }
    },
  };
}
