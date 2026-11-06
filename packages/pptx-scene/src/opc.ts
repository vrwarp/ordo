/**
 * The package (OPC) layer: part lookup, text decoding, XML parsing with a per-part cache, content types and
 * relationships (design/27 §1 `opc.ts`, §12).
 *
 * Owned by work item A (reading). Still to port from `pptx-render/src/annotate.ts`: Strict→Transitional
 * (1478-1539: namespace and relationship-type URIs, `"90%"` percentages), content-type repair, a log line
 * per External target (host only).
 */
import { type Log, clean } from './log.ts';
import { parseXml, rootOf, type XNode } from './xml.ts';

/** A deck's parts by zip entry name (no leading slash), as `extractZip` returns them in `files`. */
export type PartSource = Map<string, Uint8Array>;

/** An XML part larger than this is refused (design/27 §12). */
export const MAX_XML_PART_BYTES = 8 * 1024 * 1024;

/** A relationship, its target resolved inside the package. */
export interface Rel {
  id: string;
  /** The full type URI. Compare with `relType` (its last segment), which Strict and Transitional share. */
  type: string;
  /** The target part name (resolved, normalised, no leading slash); the raw target when external. */
  target: string;
  external: boolean;
}

export interface Package {
  /** The stored name of a part, matched case-insensitively (the first entry wins on a case-only clash). */
  find(name: string): string | undefined;
  has(name: string): boolean;
  /** A part's bytes (empty when the extractor spilled it to disk). */
  bytes(name: string): Uint8Array | undefined;
  /** An XML part's text, decoded (UTF-8 or UTF-16 by BOM). Throws when the part is over budget. */
  text(name: string): string | undefined;
  /**
   * The root element of an XML part, parsed once and cached; undefined when the part is missing. Throws when
   * it is over budget or malformed (the caller quarantines the slide that needs it).
   */
  xml(name: string): XNode | undefined;
  /** The relationships of a part ('' for the package's own `_rels/.rels`), in document order. */
  rels(source: string): Rel[];
  rel(source: string, id: string): Rel | undefined;
  /** The first internal relationship of `source` whose `relType` is `type` ('slideLayout', 'theme', …). */
  relOfType(source: string, type: string): Rel | undefined;
  contentType(name: string): string | undefined;
  log: Log;
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

/**
 * A relationship target resolved against its source part: fragment dropped, percent-decoded, `.` and `..`
 * applied (never above the root), leading `/` meaning the package root. Undefined when nothing is left.
 */
export function resolveTarget(source: string, target: string): string | undefined {
  let t = target;
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  try {
    t = decodeURIComponent(t);
  } catch {
    /* keep it as written */
  }
  t = t.replaceAll('\\', '/');
  const out = t.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const seg of t.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.length ? out.join('/') : undefined;
}

/** The host of an external target, for a log line (never the whole URL). */
export function externalHost(target: string): string {
  const m = /^[a-z][a-z0-9+.-]{0,20}:\/\/([^/?#]{0,253})/i.exec(target);
  return clean(m?.[1] || 'a local file', 100);
}

function decode(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder('utf-8').decode(b); // strips a UTF-8 BOM
}

export function openPackage(src: PartSource, log: Log = () => {}): Package {
  const lower = new Map<string, string>();
  for (const name of src.keys()) {
    const k = name.toLowerCase();
    if (!lower.has(k)) lower.set(k, name);
  }
  const find = (name: string) => (src.has(name) ? name : lower.get(name.toLowerCase()));
  const xmlCache = new Map<string, XNode | Error | undefined>();
  const relsCache = new Map<string, { list: Rel[]; byId: Map<string, Rel> }>();

  const text = (name: string): string | undefined => {
    const real = find(name);
    if (real === undefined) return undefined;
    const b = src.get(real)!;
    if (b.length > MAX_XML_PART_BYTES) throw new Error(`${clean(real)} is larger than 8 MB`);
    return decode(b);
  };

  const xml = (name: string): XNode | undefined => {
    const real = find(name);
    if (real === undefined) return undefined;
    if (!xmlCache.has(real)) {
      try {
        xmlCache.set(real, rootOf(parseXml(text(real) ?? '', clean(real))));
      } catch (e) {
        xmlCache.set(real, e instanceof Error ? e : new Error(String(e)));
      }
    }
    const v = xmlCache.get(real);
    if (v instanceof Error) throw v;
    return v;
  };

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
    for (const n of root?.children ?? []) {
      if (n.name !== 'Relationship') continue;
      const id = n.attrs.Id;
      const raw = n.attrs.Target;
      if (!id || raw === undefined || r.byId.has(id)) continue;
      const external = n.attrs.TargetMode === 'External';
      const target = external ? raw : resolveTarget(source, raw);
      if (target === undefined) continue;
      const rel: Rel = {
        id,
        type: n.attrs.Type ?? '',
        target: external ? target : (find(target) ?? target),
        external,
      };
      r.list.push(rel);
      r.byId.set(id, rel);
    }
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
    relOfType: (source, type) => relsOf(source).list.find((r) => !r.external && relType(r.type) === type),
    contentType: (name) => {
      const real = find(name);
      if (real === undefined) return undefined;
      const t = contentTypes();
      const dot = real.lastIndexOf('.');
      return (
        t.overrides.get(real) ?? (dot >= 0 ? t.defaults.get(real.slice(dot + 1).toLowerCase()) : undefined)
      );
    },
    log,
  };
}
