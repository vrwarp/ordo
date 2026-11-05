import { XMLParser } from 'fast-xml-parser';

/** A namespaced XML element as a small tree (order preserved). Text nodes have the name `#text`. */
export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

/** Element nesting kept; deeper content is dropped (real slides nest a few dozen levels). */
const XML_MAX_DEPTH = 256;
/** Markup tags (`<`) one part may hold before it is refused (a dense real slide has a few thousand). */
export const MAX_TAGS_PER_PART = 250_000;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

// biome-ignore lint/suspicious/noExplicitAny: fast-xml-parser preserveOrder output is untyped
type Raw = any;

function toNodes(raw: Raw[], depth: number): XNode[] {
  const out: XNode[] = [];
  if (depth > XML_MAX_DEPTH || !Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    let name = '';
    for (const k of Object.keys(entry)) if (k !== ':@') name = k;
    if (!name || name === '?xml') continue;
    if (name === '#text') {
      out.push({ name, attrs: {}, children: [], text: String(entry['#text'] ?? '') });
      continue;
    }
    const attrs = (entry[':@'] ?? {}) as Record<string, string>;
    out.push({ name, attrs, children: toNodes(entry[name] as Raw[], depth + 1), text: '' });
  }
  return out;
}

/** Occurrences of `ch` (a character or a string) in `s`, counted up to `limit + 1`. */
export function countUpTo(s: string, ch: string, limit: number): number {
  let n = 0;
  for (let i = s.indexOf(ch); i >= 0 && n <= limit; i = s.indexOf(ch, i + 1)) n++;
  return n;
}

/**
 * Start tags `<name ...>` in document order, as [start, end) offsets (end is just past `>`). One linear
 * pass: a tag ends at the first `>` outside quotes, and the scan stops at a tag that never ends. Regular
 * expressions such as `<name[^>]*>` restart at every `<name` and are quadratic on a deck's crafted parts.
 */
export function startTags(xml: string, name: string): [number, number][] {
  const open = `<${name}`;
  const out: [number, number][] = [];
  for (let at = xml.indexOf(open); at >= 0; ) {
    const next = xml[at + open.length] ?? '';
    // The name must end here: whitespace, `/` or `>` (not `<a:tab`).
    if (next === '/' || next === '>' || /\s/.test(next)) {
      const end = tagEnd(xml, at + open.length);
      if (end < 0) break;
      out.push([at, end + 1]);
      at = xml.indexOf(open, end + 1);
    } else at = xml.indexOf(open, at + 1);
  }
  return out;
}

/** The offset of the `>` that closes a tag whose attributes start at `from`, or -1. */
function tagEnd(xml: string, from: number): number {
  for (let i = from; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (c === 0x3e) return i;
    if (c === 0x22 || c === 0x27) {
      i = xml.indexOf(c === 0x22 ? '"' : "'", i + 1);
      if (i < 0) return -1;
    }
  }
  return -1;
}

/** Parse one XML part; throws on a part too large to be a real slide. */
export function parseXml(xml: string, part: string): XNode[] {
  if (countUpTo(xml, '<', MAX_TAGS_PER_PART) > MAX_TAGS_PER_PART)
    throw new Error(`${part} has more than ${MAX_TAGS_PER_PART} XML tags`);
  try {
    return toNodes(parser.parse(xml) as Raw[], 0);
  } catch (e) {
    if (e instanceof RangeError) throw new Error(`${part} is nested too deeply`);
    throw e;
  }
}

/**
 * Elements with this many children are looked up through an index (name → position of its first child of
 * that name), built on the first lookup. Style nodes are shared: every run of a slide looks into the same
 * layout and master nodes, and a deck can give one of them 100,000 children.
 */
const INDEX_FROM = 32;
const byName = new WeakMap<XNode, Map<string, number>>();

function indexOf(n: XNode): Map<string, number> {
  let idx = byName.get(n);
  if (!idx) {
    idx = new Map();
    const cs = n.children;
    for (let i = 0; i < cs.length; i++) if (!idx.has(cs[i]!.name)) idx.set(cs[i]!.name, i);
    byName.set(n, idx);
  }
  return idx;
}

export function child(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  const cs = n.children;
  if (cs.length < INDEX_FROM) {
    for (const c of cs) if (c.name === name) return c;
    return undefined;
  }
  const i = indexOf(n).get(name);
  return i === undefined ? undefined : cs[i];
}

/** The first child named any of `names`, in document order. */
export function firstChild(n: XNode | undefined, names: readonly string[]): XNode | undefined {
  if (!n) return undefined;
  const cs = n.children;
  if (cs.length < INDEX_FROM) return cs.find((c) => names.includes(c.name));
  const idx = indexOf(n);
  let best: number | undefined;
  for (const nm of names) {
    const i = idx.get(nm);
    if (i !== undefined && (best === undefined || i < best)) best = i;
  }
  return best === undefined ? undefined : cs[best];
}

export function children(n: XNode | undefined, name: string): XNode[] {
  return n ? n.children.filter((c) => c.name === name) : [];
}

export function path(n: XNode | undefined, ...names: string[]): XNode | undefined {
  let cur = n;
  for (const nm of names) cur = child(cur, nm);
  return cur;
}

/** The root element of a parsed part: the first element (not text, a declaration or another `<?...?>`). */
export function rootOf(nodes: XNode[]): XNode | undefined {
  return nodes.find((n) => n.name !== '#text' && !n.name.startsWith('?') && !n.name.startsWith('!'));
}

export function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
