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
 *
 * Two readers, one tree. The NODE READER is the default and the reference: one `XNode` per element and per run
 * of text, and a part is refused past `MAX_TAGS_PER_PART` tags (a count of `<` before anything is built). The
 * PACKED READER (`parseXml` with `ParseOptions.pack`, which only the converter's package asks for: design/29
 * §2.3 X1) reads traced artwork as numbers. Traced artwork is a custom geometry of hundreds of thousands of
 * `a:pt` points, one node each (a slide of 1.5 million tags held 472 MB of a 512 MB heap), so an `a:path` that
 * is a child of an `a:pathLst` and is written in the strict form below becomes ONE node whose commands and
 * points are two typed arrays (`PackedPath`), read through `pathCommands` and nowhere else. The strict form is
 * what real tools write: no whitespace, comment, text or CDATA between the commands of the path; only the
 * commands `a:moveTo` and `a:lnTo` (one `a:pt`), `a:quadBezTo` (two), `a:cubicBezTo` (three), `a:arcTo` (its
 * four attributes `wR hR stAng swAng`, no child) and `a:close` (no attribute); each `a:pt` with exactly `x`
 * and `y`, written with one space between the attributes and `/>` right after the last; every number a
 * canonical integer (`-?[0-9]{1,15}`, no leading zero, no `-0`, no sign but minus, no entity), so the string a
 * reader makes from a number is the string the node reader would have read. A path that departs from this in
 * any way (a guide name, a decimal, a space, an unknown child, a deeper tree than `XML_MAX_DEPTH` leaves room
 * for, a missing end tag) is read again from its start tag by the ordinary loop: the tree is the node
 * reader's, node for node, and that fallback is the whole safety argument. `unpackPaths` rebuilds the node
 * reader's tree from a packed one, so the two can be compared on any input; both give the same refusals for
 * every reason that is not a bound, and the packed reader's own bounds (`ParseOptions.pack`) are counted
 * where the loop builds, since no count before it can tell the packed children from the rest.
 */

/** A namespaced XML element as a small tree (order preserved). Text nodes have the name `#text`. */
export interface XNode {
  name: string;
  /** Attribute name (with its prefix, as written) to value, entities decoded. A null-prototype object. */
  attrs: Record<string, string>;
  children: XNode[];
  /** Character data of a `#text` node; '' for elements. */
  text: string;
  /**
   * An `a:path` read in the packed form (`parseXml` with `ParseOptions.pack`): its commands and points as two typed
   * arrays, and `children` empty. Read it only through `pathCommands`.
   */
  packed?: PackedPath;
}

/**
 * A path's commands and points as numbers. `ops` holds one byte per command (0 close, 1 moveTo, 2 lnTo, 3 quadBezTo,
 * 4 cubicBezTo, 5 arcTo); `nums` holds, in document order, the x and y of every point of a command, or the four numbers
 * wR, hR, stAng, swAng of an arcTo.
 */
export interface PackedPath {
  ops: Uint8Array;
  nums: Float64Array;
}

/** What `parseXml` is asked for besides the part's text. */
export interface ParseOptions {
  /** Read the commands of every `a:path` of an `a:pathLst` as numbers, within these bounds (see `XmlBoundError`). */
  pack?: { maxElements: number; maxPathItems: number };
}

/** A part past one of the packed reader's bounds: `kind` says which (`elements`, `points`, or `bytes` for the part's size). */
export class XmlBoundError extends Error {
  kind: 'elements' | 'points' | 'bytes';
  constructor(kind: 'elements' | 'points' | 'bytes', message: string) {
    super(message);
    this.name = 'XmlBoundError';
    this.kind = kind;
  }
}

/** One child of an `a:path` as the converter's readers see it (`pathCommands`). */
export interface PathCommand {
  name: string;
  /** How many children the command has (text nodes included, as the node form counts them). */
  kids: number;
  /** The `a:pt` children, in order, as the strings of their x and y attributes (undefined: the attribute is missing). */
  pts: [x: string | undefined, y: string | undefined][];
  attrs: Record<string, string>;
}

const EMPTY_ATTRS: Record<string, string> = Object.freeze(Object.create(null));

/** The commands of a packed path, by `PackedPath.ops` code: the element name and how many `a:pt` it holds. */
const OP_NAMES = ['a:close', 'a:moveTo', 'a:lnTo', 'a:quadBezTo', 'a:cubicBezTo', 'a:arcTo'] as const;
const OP_POINTS = [0, 1, 1, 2, 3, 0] as const;
const OP_CLOSE = 0;
const OP_MOVE = 1;
const OP_LINE = 2;
const OP_QUAD = 3;
const OP_CUBIC = 4;
const OP_ARC = 5;
const ARC_ATTRS = ['wR', 'hR', 'stAng', 'swAng'] as const;

/**
 * The children of an `a:path` in order, for either form of the path (the only way a reader reads them: a packed path has
 * no `children`). For the node form every child in order, text nodes included, with the command's `a:pt` children as
 * string pairs and its own attributes; for the packed form the same values made from the numbers on demand.
 */
export function pathCommands(p: XNode): Iterable<PathCommand> {
  return p.packed ? packedCommands(p.packed) : nodeCommands(p);
}

function* nodeCommands(p: XNode): Generator<PathCommand> {
  for (const c of p.children) {
    const pts: PathCommand['pts'] = [];
    for (const k of c.children) if (k.name === 'a:pt') pts.push([k.attrs.x, k.attrs.y]);
    yield { name: c.name, kids: c.children.length, pts, attrs: c.attrs };
  }
}

function* packedCommands(p: PackedPath): Generator<PathCommand> {
  const { ops, nums } = p;
  let k = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const name = OP_NAMES[op]!;
    if (op === OP_ARC) {
      const attrs: Record<string, string> = Object.create(null);
      for (let j = 0; j < 4; j++) attrs[ARC_ATTRS[j]!] = String(nums[k + j]);
      k += 4;
      yield { name, kids: 0, pts: [], attrs };
      continue;
    }
    const n = OP_POINTS[op]!;
    const pts: PathCommand['pts'] = [];
    for (let j = 0; j < n; j++, k += 2) pts.push([String(nums[k]), String(nums[k + 1])]);
    yield { name, kids: n, pts, attrs: EMPTY_ATTRS };
  }
}

/** The nodes the node reader makes for the commands of a packed path (`unpackPaths`). */
function commandNodes(p: PackedPath): XNode[] {
  const out: XNode[] = [];
  for (const c of packedCommands(p)) {
    const kids: XNode[] = [];
    for (const [x, y] of c.pts) {
      const attrs: Record<string, string> = Object.create(null);
      attrs.x = x!;
      attrs.y = y!;
      kids.push({ name: 'a:pt', attrs, children: [], text: '' });
    }
    const attrs: Record<string, string> = Object.create(null);
    Object.assign(attrs, c.attrs);
    out.push({ name: c.name, attrs, children: kids, text: '' });
  }
  return out;
}

/**
 * The trees `parseXml` makes without packing: every packed path becomes the nodes the node reader would have made. A new
 * tree; the argument is not changed. For tests and tools that compare the two readers: no reader of the converter needs it.
 */
export function unpackPaths(nodes: XNode[]): XNode[] {
  const one = (n: XNode): XNode => {
    if (n.packed) return { name: n.name, attrs: n.attrs, children: commandNodes(n.packed), text: n.text };
    if (!n.children.length) return n;
    return { name: n.name, attrs: n.attrs, children: n.children.map(one), text: n.text };
  };
  return nodes.map(one);
}

/** Element nesting kept; deeper content is dropped (real slides nest a few dozen levels). */
export const XML_MAX_DEPTH = 256;
/** Markup tags (`<`) one part may hold before it is refused (a dense real slide has a few thousand). */
export const MAX_TAGS_PER_PART = 250_000;
/**
 * Nodes (elements and the text between them) one part may hold when it is read with packing: the packed reader counts
 * what it builds, not the `<` it meets (`parseXml`'s `pack` option), and a path read as numbers builds nothing per command.
 */
export const MAX_PACKED_ELEMENTS_PER_PART = 500_000;
/** Commands and points of one packed part in all (an arcTo counts as two points); never reached inside the part-size bound. */
export const MAX_PACKED_PATH_ITEMS_PER_PART = 4_000_000;

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

/**
 * What a packed path is being built into while it is scanned: the two typed arrays (grown by doubling, reused by every path
 * of the part, copied exactly to the path that keeps them) and the part's running count of commands and points. A path
 * that departs from the strict form is abandoned with `abandon`, which takes its items back.
 */
class Packer {
  private ops = new Uint8Array(256);
  private nums = new Float64Array(512);
  private nOps = 0;
  private nNums = 0;
  private items = 0;
  private base = 0;
  private readonly part: string;
  private readonly maxItems: number;
  constructor(part: string, maxItems: number) {
    this.part = part;
    this.maxItems = maxItems;
  }
  begin(): void {
    this.nOps = 0;
    this.nNums = 0;
    this.base = this.items;
  }
  abandon(): void {
    this.items = this.base;
  }
  take(): PackedPath {
    return { ops: this.ops.slice(0, this.nOps), nums: this.nums.slice(0, this.nNums) };
  }
  private count(n: number): void {
    this.items += n;
    if (this.items > this.maxItems)
      throw new XmlBoundError(
        'points',
        `${this.part} has more than ${this.maxItems} path commands and points`,
      );
  }
  op(code: number): void {
    if (this.nOps === this.ops.length) {
      const bigger = new Uint8Array(this.ops.length * 2);
      bigger.set(this.ops);
      this.ops = bigger;
    }
    this.ops[this.nOps++] = code;
    this.count(1);
  }
  private num(v: number): void {
    if (this.nNums === this.nums.length) {
      const bigger = new Float64Array(this.nums.length * 2);
      bigger.set(this.nums);
      this.nums = bigger;
    }
    this.nums[this.nNums++] = v;
  }
  point(x: number, y: number): void {
    this.num(x);
    this.num(y);
    this.count(1);
  }
  arc(wR: number, hR: number, stAng: number, swAng: number): void {
    this.num(wR);
    this.num(hR);
    this.num(stAng);
    this.num(swAng);
    this.count(2);
  }
}

/** The value `quotedInt` read. */
let intValue = 0;

/**
 * `="N"` or `='N'` at `at`, N a canonical integer (`-?[0-9]{1,15}`: no leading zero, no `-0`, no plus, no entity, so the
 * string a reader makes from the number is the string that was written): the index past the closing quote, the number in
 * `intValue`; -1 for anything else.
 */
function quotedInt(xml: string, at: number): number {
  if (xml.charCodeAt(at) !== 0x3d) return -1;
  const q = xml.charCodeAt(at + 1);
  if (q !== 0x22 && q !== 0x27) return -1;
  let j = at + 2;
  let c = xml.charCodeAt(j);
  const neg = c === 0x2d;
  if (neg) c = xml.charCodeAt(++j);
  if (c < 0x30 || c > 0x39) return -1;
  let v = 0;
  if (c === 0x30) {
    if (neg) return -1;
    j++;
  } else {
    for (let digits = 0; c >= 0x30 && c <= 0x39; c = xml.charCodeAt(++j)) {
      if (++digits > 15) return -1;
      v = v * 10 + (c - 0x30);
    }
  }
  if (xml.charCodeAt(j) !== q) return -1;
  intValue = neg ? -v : v;
  return j + 1;
}

/** `<a:pt x=".." y=".."/>` (or y first) at `at`: the index past it, the point added; -1 for any other form. */
function packPoint(xml: string, at: number, pk: Packer): number {
  if (!xml.startsWith('<a:pt ', at)) return -1;
  const c = xml.charCodeAt(at + 6);
  const second = c === 0x78 ? ' y' : c === 0x79 ? ' x' : '';
  if (!second) return -1;
  let i = quotedInt(xml, at + 7);
  if (i < 0) return -1;
  const first = intValue;
  if (!xml.startsWith(second, i)) return -1;
  i = quotedInt(xml, i + 2);
  if (i < 0 || !xml.startsWith('/>', i)) return -1;
  if (c === 0x78) pk.point(first, intValue);
  else pk.point(intValue, first);
  return i + 2;
}

/** A command that holds `n` points: `<open><a:pt/>...</close>`; the index past it, or -1. */
function packCommand(
  xml: string,
  at: number,
  open: string,
  close: string,
  op: number,
  n: number,
  pk: Packer,
): number {
  if (!xml.startsWith(open, at)) return -1;
  let i = at + open.length;
  pk.op(op);
  for (let k = 0; k < n; k++) {
    i = packPoint(xml, i, pk);
    if (i < 0) return -1;
  }
  return xml.startsWith(close, i) ? i + close.length : -1;
}

const arcValues = [0, 0, 0, 0];

/** `<a:arcTo wR=".." hR=".." stAng=".." swAng=".."/>` with the four attributes in any order: the index past it, or -1. */
function packArc(xml: string, at: number, pk: Packer): number {
  if (!xml.startsWith('<a:arcTo ', at)) return -1;
  let i = at + 9;
  let seen = 0;
  for (let k = 0; k < 4; k++) {
    let slot: number;
    if (xml.startsWith('wR', i)) {
      slot = 0;
      i += 2;
    } else if (xml.startsWith('hR', i)) {
      slot = 1;
      i += 2;
    } else if (xml.startsWith('stAng', i)) {
      slot = 2;
      i += 5;
    } else if (xml.startsWith('swAng', i)) {
      slot = 3;
      i += 5;
    } else return -1;
    if (seen & (1 << slot)) return -1;
    seen |= 1 << slot;
    i = quotedInt(xml, i);
    if (i < 0) return -1;
    arcValues[slot] = intValue;
    if (k < 3) {
      if (xml.charCodeAt(i) !== 0x20) return -1;
      i++;
    }
  }
  if (!xml.startsWith('/>', i)) return -1;
  pk.op(OP_ARC);
  pk.arc(arcValues[0]!, arcValues[1]!, arcValues[2]!, arcValues[3]!);
  return i + 2;
}

/**
 * The commands of an `a:path` in the strict form (see the module comment), from just after its start tag: the index past
 * its `</a:path>`, with the commands in `pk`; -1 at the first byte that departs from the form (the caller reads the path
 * with the ordinary loop). One forward pass over the path's own bytes.
 */
function packPath(xml: string, from: number, pk: Packer): number {
  let i = from;
  for (;;) {
    if (xml.charCodeAt(i) !== 0x3c) return -1;
    const c1 = xml.charCodeAt(i + 1);
    if (c1 === 0x2f) return xml.startsWith('</a:path>', i) ? i + 9 : -1;
    if (c1 !== 0x61 || xml.charCodeAt(i + 2) !== 0x3a) return -1;
    switch (xml.charCodeAt(i + 3)) {
      case 0x6c: // a:lnTo
        i = packCommand(xml, i, '<a:lnTo>', '</a:lnTo>', OP_LINE, 1, pk);
        break;
      case 0x6d: // a:moveTo
        i = packCommand(xml, i, '<a:moveTo>', '</a:moveTo>', OP_MOVE, 1, pk);
        break;
      case 0x71: // a:quadBezTo
        i = packCommand(xml, i, '<a:quadBezTo>', '</a:quadBezTo>', OP_QUAD, 2, pk);
        break;
      case 0x63: // a:close or a:cubicBezTo
        if (xml.charCodeAt(i + 4) === 0x6c) {
          if (!xml.startsWith('<a:close/>', i)) return -1;
          pk.op(OP_CLOSE);
          i += 10;
        } else i = packCommand(xml, i, '<a:cubicBezTo>', '</a:cubicBezTo>', OP_CUBIC, 3, pk);
        break;
      case 0x61: // a:arcTo
        i = packArc(xml, i, pk);
        break;
      default:
        return -1;
    }
    if (i < 0) return -1;
  }
}

/** The part's name, then how many nodes or items it may hold: the message of a bound (`XmlBoundError` of kind `elements`). */
function tooManyElements(part: string, max: number): never {
  throw new XmlBoundError('elements', `${part} has more than ${max} XML elements`);
}

/** The name of an `a:path` start tag ends here: whitespace, `/` or `>`. */
function nameEnds(c: number): boolean {
  return c === 0x20 || c === 0x2f || c === 0x3e || c === 0x09 || c === 0x0a || c === 0x0d;
}

/**
 * Parse one XML part; throws on a part too large to be a real slide, on a declaration and on cut markup. Without
 * `opts.pack` this is the node reader (the reference); with it, the packed reader (see the module comment).
 */
export function parseXml(xml: string, part: string, opts?: ParseOptions): XNode[] {
  const pack = opts?.pack;
  // The node reader counts tags before it builds anything; the packed reader counts what it builds, as it builds it.
  if (!pack && countUpTo(xml, '<', MAX_TAGS_PER_PART) > MAX_TAGS_PER_PART)
    throw new Error(`${part} has more than ${MAX_TAGS_PER_PART} XML tags`);
  const maxNodes = pack ? pack.maxElements : Number.POSITIVE_INFINITY;
  const packer = pack ? new Packer(part, pack.maxPathItems) : undefined;
  let nodes = 0;
  const top: XNode[] = [];
  const open: XNode[] = [];
  /** Elements open below the depth limit: not kept, only counted so their end tags pair up. */
  let dropped = 0;
  let text = '';
  const flush = () => {
    if (!text) return;
    const parent = open[open.length - 1];
    if (parent && !dropped) {
      if (++nodes > maxNodes) tooManyElements(part, maxNodes);
      parent.children.push({ name: '#text', attrs: EMPTY_ATTRS, children: [], text });
    }
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
      if (++nodes > maxNodes) tooManyElements(part, maxNodes);
      const parent = open[open.length - 1];
      (parent ? parent.children : top).push(node);
      if (!selfClosing) {
        // The packed reader: a path of a path list is tried once, from here; a path that does not fit the strict form is
        // read by the loop below it (its children are nodes, the node reader's).
        if (
          packer &&
          parent?.name === 'a:pathLst' &&
          node.name === 'a:path' &&
          open.length + 2 <= XML_MAX_DEPTH &&
          xml.startsWith('<a:path', lt) &&
          nameEnds(xml.charCodeAt(lt + 7))
        ) {
          packer.begin();
          const end = packPath(xml, gt + 1, packer);
          if (end >= 0) {
            node.packed = packer.take();
            i = end;
            continue;
          }
          packer.abandon();
        }
        open.push(node);
      }
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

/**
 * The root element's start tag (its name and attributes, as written, no children) from the head of a part,
 * without parsing the rest: the XML declaration, processing instructions, comments and text before it are
 * skipped. Undefined when the head holds no complete start tag, or a declaration (`<!DOCTYPE`) or an end tag
 * comes first. Linear in the head's length.
 */
export function rootTag(head: string): XNode | undefined {
  let i = 0;
  for (;;) {
    const lt = head.indexOf('<', i);
    if (lt < 0) return undefined;
    const c1 = head.charCodeAt(lt + 1);
    if (c1 === 0x3f) {
      const end = head.indexOf('?>', lt + 2);
      if (end < 0) return undefined;
      i = end + 2;
    } else if (c1 === 0x21) {
      if (!head.startsWith('<!--', lt)) return undefined;
      const end = head.indexOf('-->', lt + 4);
      if (end < 0) return undefined;
      i = end + 3;
    } else {
      if (c1 === 0x2f) return undefined;
      const gt = tagEnd(head, lt + 1);
      if (gt < 0) return undefined;
      try {
        return readTag(head.slice(lt + 1, head.charCodeAt(gt - 1) === 0x2f ? gt - 1 : gt), 'root');
      } catch {
        return undefined;
      }
    }
  }
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

/**
 * The longest numeric attribute `num` reads (real ones have a dozen characters). A longer value is not a
 * number: `Number` would read every character of it, and shared style nodes are read once per run.
 */
export const MAX_NUM_CHARS = 64;

/** A numeric attribute: finite, else undefined (missing, malformed, or longer than `MAX_NUM_CHARS`). */
export function num(v: string | undefined): number | undefined {
  if (v === undefined || v.length > MAX_NUM_CHARS) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
