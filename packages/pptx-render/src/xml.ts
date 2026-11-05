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

function countUpTo(s: string, ch: string, limit: number): number {
  let n = 0;
  for (let i = s.indexOf(ch); i >= 0 && n <= limit; i = s.indexOf(ch, i + 1)) n++;
  return n;
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

export function child(n: XNode | undefined, name: string): XNode | undefined {
  return n?.children.find((c) => c.name === name);
}

export function children(n: XNode | undefined, name: string): XNode[] {
  return n ? n.children.filter((c) => c.name === name) : [];
}

export function path(n: XNode | undefined, ...names: string[]): XNode | undefined {
  let cur = n;
  for (const nm of names) cur = child(cur, nm);
  return cur;
}

/** The root element of a parsed part (the first element that is not a text node). */
export function rootOf(nodes: XNode[]): XNode | undefined {
  return nodes.find((n) => n.name !== '#text');
}

export function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
