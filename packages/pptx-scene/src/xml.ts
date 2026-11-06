/**
 * A small, bounded XML reader for the parts of an untrusted deck (design/27 §1 and §12).
 *
 * It keeps element order, attributes and character data, and nothing else: comments and processing
 * instructions are dropped, CDATA is character data. There is no DTD support at all: a `<!DOCTYPE` (or any
 * other markup declaration) is refused, so no entity can be defined and nothing expands beyond the five
 * predefined entities and numeric character references, each one character. Every scan is linear in the
 * part's length (no regular expression runs over a part), nesting is capped and attribute maps are
 * null-prototype objects, so `__proto__` or `constructor` in a deck is an ordinary key.
 *
 * Malformed markup is read leniently, as browsers read HTML: an end tag closes the nearest open element of
 * its name (an end tag with no open element of that name is ignored) and elements still open at the end are
 * closed. Only an unterminated tag, comment, CDATA section or processing instruction, and a declaration,
 * throw: the caller quarantines that part.
 */

/** A namespaced XML element as a small tree (order preserved). Text nodes have the name `#text`. */
export interface XNode {
  name: string;
  /** Attribute name (with its prefix, as written) to value, entities decoded. A null-prototype object. */
  attrs: Record<string, string>;
  children: XNode[];
  /** Character data of a `#text` node; '' for elements. */
  text: string;
}

/** Element nesting kept; deeper content is dropped (real slides nest a few dozen levels). */
export const XML_MAX_DEPTH = 256;
/** Markup tags (`<`) one part may hold before it is refused (a dense real slide has a few thousand). */
export const MAX_TAGS_PER_PART = 250_000;

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
    const next = xml.charCodeAt(at + open.length);
    // The name must end here: whitespace, `/` or `>` (not `<a:tab`).
    if (next === 0x2f || next === 0x3e || isSpace(next)) {
      const end = tagEnd(xml, at + open.length);
      if (end < 0) break;
      out.push([at, end + 1]);
      at = xml.indexOf(open, end + 1);
    } else at = xml.indexOf(open, at + 1);
  }
  return out;
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
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

const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);
/** The longest entity reference decoded, `&` and `;` excluded (`#x10FFFF`, `#1114111`). */
const MAX_REF = 8;

/** One entity reference's character, or undefined (kept as written). */
function entity(ref: string): string | undefined {
  if (ref.charCodeAt(0) !== 0x23) return PREDEFINED.get(ref);
  const hex = ref.charCodeAt(1) === 0x78; // `x`
  const digits = ref.slice(hex ? 2 : 1);
  if (!digits || !(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return undefined;
  const cp = Number.parseInt(digits, hex ? 16 : 10);
  if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
  return String.fromCodePoint(cp);
}

/**
 * Character data with references decoded. An `&` that does not start a known reference stays as written
 * (`&nbsp;` is not XML). Linear: a reference's `;` is looked for only within `MAX_REF` characters.
 */
export function decodeEntities(s: string): string {
  let at = s.indexOf('&');
  if (at < 0) return s;
  let out = '';
  let last = 0;
  for (; at >= 0; at = s.indexOf('&', at + 1)) {
    let semi = -1;
    const stop = Math.min(s.length, at + 2 + MAX_REF);
    for (let j = at + 1; j < stop; j++)
      if (s.charCodeAt(j) === 0x3b) {
        semi = j;
        break;
      }
    if (semi < 0) continue;
    const v = entity(s.slice(at + 1, semi));
    if (v === undefined) continue;
    out += s.slice(last, at) + v;
    last = semi + 1;
    at = semi;
  }
  return out + s.slice(last);
}

/** XML end-of-line handling: CR LF and lone CR are LF. */
function eol(s: string): string {
  return s.includes('\r') ? s.replace(/\r\n?/g, '\n') : s;
}

/** A tag's name and attributes, from the text between `<` and `>` (or `/>`). */
function readTag(inner: string, part: string): XNode {
  let i = 0;
  while (i < inner.length && !isSpace(inner.charCodeAt(i))) i++;
  const name = inner.slice(0, i);
  if (!name) throw new Error(`${part}: a tag without a name`);
  const attrs: Record<string, string> = Object.create(null);
  const n = inner.length;
  while (i < n) {
    while (i < n && isSpace(inner.charCodeAt(i))) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && inner.charCodeAt(i) !== 0x3d && !isSpace(inner.charCodeAt(i))) i++;
    const key = inner.slice(start, i);
    while (i < n && isSpace(inner.charCodeAt(i))) i++;
    if (inner.charCodeAt(i) !== 0x3d) continue; // a name without a value: skipped
    i++;
    while (i < n && isSpace(inner.charCodeAt(i))) i++;
    const q = inner.charCodeAt(i);
    if (q !== 0x22 && q !== 0x27) {
      // An unquoted value is not XML: skip it.
      while (i < n && !isSpace(inner.charCodeAt(i))) i++;
      continue;
    }
    const close = inner.indexOf(q === 0x22 ? '"' : "'", i + 1);
    if (close < 0) break; // cannot happen: tagEnd balanced the quotes
    if (key) attrs[key] = decodeEntities(eol(inner.slice(i + 1, close)));
    i = close + 1;
  }
  return { name, attrs, children: [], text: '' };
}

const EMPTY_ATTRS: Record<string, string> = Object.freeze(Object.create(null));

/** Parse one XML part; throws on a part too large to be a real slide, on a declaration and on cut markup. */
export function parseXml(xml: string, part: string): XNode[] {
  if (countUpTo(xml, '<', MAX_TAGS_PER_PART) > MAX_TAGS_PER_PART)
    throw new Error(`${part} has more than ${MAX_TAGS_PER_PART} XML tags`);
  const top: XNode[] = [];
  const open: XNode[] = [];
  /** Elements open below the depth limit: not kept, only counted so their end tags pair up. */
  let dropped = 0;
  let text = '';
  const flush = () => {
    if (!text) return;
    const parent = open[open.length - 1];
    if (parent && !dropped) parent.children.push({ name: '#text', attrs: EMPTY_ATTRS, children: [], text });
    text = '';
  };
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const stop = lt < 0 ? n : lt;
    if (stop > i) text += decodeEntities(eol(xml.slice(i, stop)));
    if (lt < 0) break;
    const c1 = xml.charCodeAt(lt + 1);
    if (c1 === 0x21) {
      // `<!`: a comment, CDATA, or a declaration (refused).
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        if (end < 0) throw new Error(`${part}: unterminated comment`);
        i = end + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9);
        if (end < 0) throw new Error(`${part}: unterminated CDATA section`);
        text += eol(xml.slice(lt + 9, end));
        i = end + 3;
        continue;
      }
      const decl = xml.slice(lt + 2, lt + 9).toUpperCase();
      throw new Error(
        decl === 'DOCTYPE' ? `${part} has a DOCTYPE (refused)` : `${part}: markup declaration refused`,
      );
    }
    if (c1 === 0x3f) {
      // `<?`: a processing instruction or the XML declaration, dropped.
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new Error(`${part}: unterminated processing instruction`);
      i = end + 2;
      continue;
    }
    const gt = tagEnd(xml, lt + 1);
    if (gt < 0) throw new Error(`${part}: unterminated tag`);
    flush();
    if (c1 === 0x2f) {
      // An end tag: close the nearest open element of that name.
      const name = xml.slice(lt + 2, gt).trim();
      if (dropped) dropped--;
      else
        for (let k = open.length - 1; k >= 0; k--)
          if (open[k]!.name === name) {
            open.length = k;
            break;
          }
      i = gt + 1;
      continue;
    }
    const selfClosing = xml.charCodeAt(gt - 1) === 0x2f;
    if (dropped || open.length > XML_MAX_DEPTH) {
      if (!selfClosing) dropped++;
    } else {
      const node = readTag(xml.slice(lt + 1, selfClosing ? gt - 1 : gt), part);
      const parent = open[open.length - 1];
      (parent ? parent.children : top).push(node);
      if (!selfClosing) open.push(node);
    }
    i = gt + 1;
  }
  return top;
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

/** The concatenated character data directly inside `n` (an `a:t`'s text). */
export function textOf(n: XNode | undefined): string {
  if (!n) return '';
  let s = '';
  for (const c of n.children) if (c.name === '#text') s += c.text;
  return s;
}

export function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
