/*
 * A small XML reader for the vendored preset file (trusted, well-formed, about 540 KB). Elements, attributes,
 * comments, processing instructions and character data; namespace prefixes are kept in names (the preset
 * file uses default namespaces only). A DOCTYPE or any other markup declaration is refused, and only the
 * five predefined entities and numeric references are decoded.
 */

export interface XmlElement {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
}

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

function decode(s: string, at: number): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10));
    const e = ENTITIES.get(ref);
    if (e === undefined) throw new Error(`unknown entity ${m} near offset ${at}`);
    return e;
  });
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const SPACE = /[ \t\r\n]*/y;
const ATTR_VALUE = /"([^"<]*)"|'([^'<]*)'/y;

/** Parses a document and returns its root element. */
export function parseXml(text: string): XmlElement {
  type Open = { name: string; attrs: Map<string, string>; children: XmlElement[] };
  const stack: Open[] = [];
  let root: XmlElement | undefined;
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`${msg} at offset ${i}`);
  };
  const match = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = i;
    const m = re.exec(text);
    if (m) i = re.lastIndex;
    return m;
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      if (text.slice(i).trim() !== '') fail('text after the root element');
      break;
    }
    if (stack.length === 0 && text.slice(i, lt).trim() !== '' && text.charCodeAt(i) !== 0xfeff)
      fail('text outside the root');
    i = lt;
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i);
      if (end < 0) fail('unterminated processing instruction');
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      if (end < 0) fail('unterminated comment');
      i = end + 3;
    } else if (text.startsWith('<!', i)) {
      fail('markup declarations (DOCTYPE, CDATA) are not read');
    } else if (text.startsWith('</', i)) {
      i += 2;
      const name = match(NAME)?.[0] ?? fail('bad end tag');
      match(SPACE);
      if (text[i] !== '>') fail('bad end tag');
      i++;
      const open = stack.pop();
      if (!open || open.name !== name) fail(`end tag </${name}> does not match`);
      const el: XmlElement = { name: open!.name, attrs: open!.attrs, children: open!.children };
      if (stack.length > 0) stack[stack.length - 1]!.children.push(el);
      else root = el;
    } else {
      i++;
      const name = match(NAME)?.[0] ?? fail('bad start tag');
      const attrs = new Map<string, string>();
      for (;;) {
        const before = i;
        match(SPACE);
        if (text[i] === '>' || text.startsWith('/>', i)) break;
        if (i === before) fail('expected whitespace before an attribute');
        const an = match(NAME)?.[0] ?? fail('bad attribute name');
        match(SPACE);
        if (text[i] !== '=') fail('expected =');
        i++;
        match(SPACE);
        const v = match(ATTR_VALUE) ?? fail('bad attribute value');
        if (attrs.has(an)) fail(`duplicate attribute ${an}`);
        attrs.set(an, decode(v[1] ?? v[2] ?? '', i));
      }
      if (root !== undefined) fail('a second root element');
      if (text.startsWith('/>', i)) {
        i += 2;
        const el: XmlElement = { name, attrs, children: [] };
        if (stack.length > 0) stack[stack.length - 1]!.children.push(el);
        else root = el;
      } else {
        i++;
        stack.push({ name, attrs, children: [] });
      }
    }
  }
  if (stack.length > 0) fail(`unclosed <${stack[stack.length - 1]!.name}>`);
  return root ?? fail('no root element');
}
