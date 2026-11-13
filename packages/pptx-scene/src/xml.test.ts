import { describe, expect, it } from 'vitest';
import {
  child,
  children,
  decodeEntities,
  MAX_NUM_CHARS,
  MAX_TAGS_PER_PART,
  num,
  parseXml,
  rootOf,
  rootTag,
  startTags,
  textOf,
  XML_MAX_DEPTH,
  type XNode,
} from './xml.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const root = (xml: string) => rootOf(parseXml(xml, 'test.xml'))!;

describe('parseXml', () => {
  it('keeps elements, attributes and text in order', () => {
    const r = root(
      '<?xml version="1.0"?>\n<a:p x="1"><a:r><a:t>Hi </a:t></a:r><a:br/><a:r><a:t>there</a:t></a:r></a:p>',
    );
    expect(r.name).toBe('a:p');
    expect(r.attrs.x).toBe('1');
    expect(r.children.map((c) => c.name)).toEqual(['a:r', 'a:br', 'a:r']);
    expect(textOf(child(r.children[0], 'a:t'))).toBe('Hi ');
    expect(children(r, 'a:r')).toHaveLength(2);
  });

  it('keeps whitespace-only text inside elements and drops it at the top level', () => {
    const nodes = parseXml('\n<a>\n  <b/> </a>\n', 'x');
    expect(nodes.map((n) => n.name)).toEqual(['a']);
    expect(nodes[0]!.children.map((c) => (c.name === '#text' ? JSON.stringify(c.text) : c.name))).toEqual([
      '"\\n  "',
      'b',
      '" "',
    ]);
  });

  it('decodes the predefined entities and numeric references in text and attributes, once', () => {
    const r = root(
      '<a v="1 &amp; 2 &#x41;&#66;">&lt;&gt;&quot;&apos;&amp;amp; &#x2019; &nbsp; &#0; &#xD800;</a>',
    );
    expect(r.attrs.v).toBe('1 & 2 AB');
    expect(textOf(r)).toBe('<>"\'&amp; ’ &nbsp; &#0; &#xD800;');
  });

  it('reads CDATA as text, drops comments and processing instructions, normalises line ends', () => {
    const r = root('<a>x<!-- c -->y<![CDATA[<z>&amp;]]><?pi data?>\r\nq\rr</a>');
    expect(r.children).toHaveLength(1);
    expect(textOf(r)).toBe('xy<z>&amp;\nq\nr');
  });

  it('refuses a DOCTYPE and any other declaration (no entity can be defined)', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>', 'd.xml')).toThrow(/DOCTYPE/);
    expect(() => parseXml('<!doctype a><a/>', 'd.xml')).toThrow(/DOCTYPE/);
    expect(() => parseXml('<a/><!ENTITY e "x">', 'd.xml')).toThrow(/declaration/);
    const lol =
      '<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><l>&b;&b;&b;</l>';
    expect(() => parseXml(lol, 'lol.xml')).toThrow(/DOCTYPE/);
  });

  it('gives null-prototype attribute maps, so deck names cannot reach Object.prototype', () => {
    const r = root('<a __proto__="1" constructor="2" toString="3" hasOwnProperty="4"/>');
    expect(Object.getPrototypeOf(r.attrs)).toBeNull();
    expect(Object.entries(r.attrs)).toEqual([
      ['__proto__', '1'],
      ['constructor', '2'],
      ['toString', '3'],
      ['hasOwnProperty', '4'],
    ]);
    expect(({} as Record<string, unknown>).toString).toBe(Object.prototype.toString);
    const t = root('<a:__proto__><a:constructor/></a:__proto__>');
    expect(t.name).toBe('a:__proto__');
    expect(child(t, 'a:constructor')?.name).toBe('a:constructor');
    expect(child(t, 'constructor')).toBeUndefined();
  });

  it('skips attributes without a quoted value, keeps the last of duplicates', () => {
    expect({ ...root('<a b c=1 d="2" d="3" e = \'4\'/>').attrs }).toEqual({ d: '3', e: '4' });
  });

  it('reads mismatched end tags leniently and closes what is left open', () => {
    const r = root('<a><b><c></b><d/></x></a>');
    expect(r.children.map((n) => n.name)).toEqual(['b', 'd']);
    expect(root('<a><b>').children.map((n) => n.name)).toEqual(['b']);
  });

  it('throws on cut markup', () => {
    expect(() => parseXml('<a><b x="1', 'cut.xml')).toThrow(/unterminated tag/);
    expect(() => parseXml('<a><!-- x', 'cut.xml')).toThrow(/comment/);
    expect(() => parseXml('<a><![CDATA[ x', 'cut.xml')).toThrow(/CDATA/);
    expect(() => parseXml('<a>< b/></a>', 'cut.xml')).toThrow(/without a name/);
  });

  it('drops content nested deeper than the limit without recursion', () => {
    const n = 100_000;
    const xml = `${'<d>'.repeat(n)}x${'</d>'.repeat(n)}<after/>`;
    const nodes = parseXml(`<r>${xml}</r>`, 'deep.xml');
    let depth = 0;
    for (let cur: XNode | undefined = nodes[0]; cur; cur = cur.children.find((c) => c.name === 'd')) depth++;
    expect(depth).toBe(XML_MAX_DEPTH + 1);
    expect(nodes[0]!.children.map((c) => c.name)).toEqual(['d', 'after']);
  });

  it('refuses a part with too many tags', () => {
    expect(() => parseXml(`<r>${'<a/>'.repeat(MAX_TAGS_PER_PART)}</r>`, 'big.xml')).toThrow(/more than/);
  });

  it('stays linear on crafted input', () => {
    const t0 = performance.now();
    decodeEntities('&'.repeat(2_000_000));
    decodeEntities('&#x'.repeat(500_000));
    parseXml(`<a v="${'&amp'.repeat(500_000)}">${'&'.repeat(1_000_000)}</a>`, 'x');
    expect(startTags(`${'<a:t'.repeat(200_000)}`, 'a:t')).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
  });
});

describe('startTags', () => {
  it('finds whole start tags, quotes respected, names not prefixes of others', () => {
    const xml = '<a:t x=">">1</a:t><a:tab/><a:t/>';
    expect(startTags(xml, 'a:t').map(([s, e]) => xml.slice(s, e))).toEqual(['<a:t x=">">', '<a:t/>']);
  });
});

describe('rootTag', () => {
  it('reads the root start tag alone, past the declaration, instructions and comments', () => {
    const t = rootTag(
      '\ufeff<?xml version="1.0"?>\n<!-- a > b --><?pi x?><p:sld xmlns:p="u" show="0"><p:cSld>',
    );
    expect(t?.name).toBe('p:sld');
    expect(t?.attrs.show).toBe('0');
    expect(t?.children).toEqual([]);
    expect(rootTag('<p:sld a="x>y"/>')?.attrs.a).toBe('x>y');
    expect(Object.getPrototypeOf(rootTag('<a __proto__="1"/>')?.attrs)).toBeNull();
  });

  it('gives up on a declaration, an end tag, a cut tag or no tag at all', () => {
    expect(rootTag('<!DOCTYPE x><x/>')).toBeUndefined();
    expect(rootTag('</x>')).toBeUndefined();
    expect(rootTag('<?xml version="1.0"?><p:sld show="0')).toBeUndefined();
    expect(rootTag('<!-- never closed')).toBeUndefined();
    expect(rootTag('text only')).toBeUndefined();
    expect(rootTag('< x/>')).toBeUndefined();
  });
});

describe('num', () => {
  it(`reads finite numbers of at most ${MAX_NUM_CHARS} characters`, () => {
    expect(num('12700')).toBe(12_700);
    expect(num(' -2.5e3 ')).toBe(-2_500);
    expect(num('1e400')).toBeUndefined();
    expect(num('x')).toBeUndefined();
    expect(num(undefined)).toBeUndefined();
    expect(num(`${'0'.repeat(MAX_NUM_CHARS - 1)}7`)).toBe(7);
    // A longer value is not read at all: a 7M-digit size in a shared style is asked for by every run.
    const huge = '1'.repeat(7_000_000);
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) expect(num(huge)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(budgetMs(1_000));
  });
});
