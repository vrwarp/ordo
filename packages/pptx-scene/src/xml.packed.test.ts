import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import {
  MAX_PACKED_ELEMENTS_PER_PART,
  MAX_PACKED_PATH_ITEMS_PER_PART,
  MAX_TAGS_PER_PART,
  type ParseOptions,
  parseXml,
  pathCommands,
  unpackPaths,
  XML_MAX_DEPTH,
  XmlBoundError,
  type XNode,
} from './xml.ts';

/**
 * The packed tokenizer (design/29 §2.3 X1, §2.5): an `a:path` of an `a:pathLst` becomes two typed arrays while the part
 * is tokenised, and the node reader (`parseXml` without options) is the reference every packed result is held to:
 * `unpackPaths(packed)` deep-equals the node reader's tree for every input both accept, both refuse the same inputs
 * for every reason that is not a bound, and every form the packed reader does not know is read by the node reader's
 * loop from the path's start tag (so the fallback is the whole safety argument).
 */
const PACK: ParseOptions = {
  pack: { maxElements: MAX_PACKED_ELEMENTS_PER_PART, maxPathItems: MAX_PACKED_PATH_ITEMS_PER_PART },
};
const packed = (xml: string, part = 'p.xml') => parseXml(xml, part, PACK);
const plain = (xml: string, part = 'p.xml') => parseXml(xml, part);

/** Every node of a tree, in document order (iterative: a test must not recurse on what it tests). */
function allNodes(nodes: XNode[]): XNode[] {
  const out: XNode[] = [];
  const stack = [...nodes].reverse();
  for (let n = stack.pop(); n; n = stack.pop()) {
    out.push(n);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}
const packedPaths = (nodes: XNode[]) => allNodes(nodes).filter((n) => n.packed);
const pathNodes = (nodes: XNode[]) => allNodes(nodes).filter((n) => n.name === 'a:path');

const pt = (x: number | string, y: number | string, q = '"') => `<a:pt x=${q}${x}${q} y=${q}${y}${q}/>`;
const geom = (paths: string) => `<a:custGeom><a:pathLst>${paths}</a:pathLst></a:custGeom>`;
const M1 = `<a:moveTo>${pt(1, 2)}</a:moveTo>`;
const ALL_COMMANDS =
  `<a:path w="100" h="200" fill="none" stroke="0" extrusionOk="0">${M1}<a:lnTo>${pt(3, 4)}</a:lnTo>` +
  `<a:quadBezTo>${pt(5, 6)}${pt(7, 8)}</a:quadBezTo>` +
  `<a:cubicBezTo>${pt(9, 10)}${pt(11, 12)}${pt(13, 14)}</a:cubicBezTo>` +
  `<a:arcTo wR="15" hR="16" stAng="17" swAng="18"/><a:close/></a:path>`;

/** The outcome of one read: its tree (unpacked) or its error message. */
type Outcome = { tree: XNode[] } | { error: string };
function outcome(read: () => XNode[]): Outcome {
  try {
    return { tree: unpackPaths(read()) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

describe('packed paths: the forms that pack (T1)', () => {
  it('reads every command kind as ops and numbers, and keeps the path as the node reader keeps it', () => {
    const root = packed(geom(ALL_COMMANDS))[0]!;
    const path = root.children[0]!.children[0]!;
    expect(path.name).toBe('a:path');
    expect(path.children).toEqual([]);
    expect(path.attrs).toEqual({ w: '100', h: '200', fill: 'none', stroke: '0', extrusionOk: '0' });
    expect(Array.from(path.packed!.ops)).toEqual([1, 2, 3, 4, 5, 0]);
    expect(Array.from(path.packed!.nums)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
  });

  it('shows a packed path to the readers exactly as the node form shows it', () => {
    const a = [...pathCommands(pathNodes(packed(geom(ALL_COMMANDS)))[0]!)];
    const b = [...pathCommands(pathNodes(plain(geom(ALL_COMMANDS)))[0]!)];
    expect(a).toEqual(b);
    expect(a.map((c) => c.name)).toEqual([
      'a:moveTo',
      'a:lnTo',
      'a:quadBezTo',
      'a:cubicBezTo',
      'a:arcTo',
      'a:close',
    ]);
    expect(a[2]!.pts).toEqual([
      ['5', '6'],
      ['7', '8'],
    ]);
    expect(a[2]!.kids).toBe(2);
    expect(a[4]!.attrs).toEqual({ wR: '15', hR: '16', stAng: '17', swAng: '18' });
  });

  it('packs single and double quotes, x before y and y before x, negatives, zero and 15 digits', () => {
    const body =
      `<a:moveTo>${pt(-7, 0, "'")}</a:moveTo>` +
      `<a:lnTo><a:pt y="2" x="1"/></a:lnTo>` +
      `<a:lnTo>${pt('999999999999999', '-999999999999999')}</a:lnTo>` +
      `<a:lnTo><a:pt y='-5' x='-6'/></a:lnTo><a:arcTo stAng="0" swAng="-5400000" wR="10" hR="20"/>`;
    const nodes = packed(geom(`<a:path>${body}</a:path>`));
    const p = packedPaths(nodes);
    expect(p).toHaveLength(1);
    expect(Array.from(p[0]!.packed!.ops)).toEqual([1, 2, 2, 2, 5]);
    expect(Array.from(p[0]!.packed!.nums)).toEqual([
      -7, 0, 1, 2, 999999999999999, -999999999999999, -6, -5, 10, 20, 0, -5400000,
    ]);
    expect(unpackPaths(nodes)).toEqual(plain(geom(`<a:path>${body}</a:path>`)));
  });

  it('packs a path with no children', () => {
    const x = geom('<a:path w="1" h="1"></a:path>');
    const p = packedPaths(packed(x));
    expect(p).toHaveLength(1);
    expect(p[0]!.packed!.ops.length).toBe(0);
    expect(unpackPaths(packed(x))).toEqual(plain(x));
  });
});

/** 8 path bodies x 5 wrappers: 40 parts. */
const BODIES: string[] = [
  ALL_COMMANDS,
  `<a:path w="10" h="10">${M1}<a:lnTo>${pt(5, 5)}</a:lnTo></a:path><a:path w="20" h="20" fill="none">${M1}<a:close/></a:path>`,
  `<a:path w="10" h="10">${M1}${Array.from({ length: 50 }, (_, i) => `<a:lnTo>${pt(i, 50 - i)}</a:lnTo>`).join('')}</a:path>`,
  `<a:path w="3" h="3"><a:moveTo>${pt(-1, 0, "'")}</a:moveTo><a:lnTo>${pt(-2, -3, "'")}</a:lnTo><a:close/></a:path>`,
  `<a:path w="3" h="3"><a:moveTo><a:pt y="9" x="8"/></a:moveTo><a:lnTo><a:pt y="1" x="2"/></a:lnTo></a:path>`,
  `<a:path w="9" h="9">${M1}<a:arcTo wR="1" hR="1" stAng="0" swAng="5400000"/><a:close/>${M1}<a:close/></a:path>`,
  '<a:path w="1" h="1"></a:path>',
  `<a:path fill="none" w="999999999999999" h="1">${M1}<a:lnTo>${pt('999999999999999', '-999999999999999')}</a:lnTo></a:path>`,
];
const WRAPPERS: ((g: string) => string)[] = [
  (g) => g,
  (g) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="1" name="a &amp; b"/></p:nvSpPr><p:spPr>${g}</p:spPr><p:txBody><a:p><a:r><a:t>Hello &amp; goodbye</a:t></a:r></a:p></p:txBody></p:sp>`,
  (g) => `<p:grpSp><p:sp><p:spPr>${g}</p:spPr></p:sp><p:sp><p:spPr/></p:sp></p:grpSp>`,
  (g) =>
    `<mc:AlternateContent><mc:Choice Requires="x"><p:sp><p:spPr>${g}</p:spPr></p:sp></mc:Choice><mc:Fallback/></mc:AlternateContent>`,
  (g) => `<r><a:t><![CDATA[x < y]]>&#65;&lt;</a:t>${g}<a:t>&quot;q&quot;</a:t></r>`,
];
const T2_PARTS: string[] = BODIES.flatMap((b) => WRAPPERS.map((w) => w(geom(b))));

describe('packed paths: the oracle (T2)', () => {
  it('has 40 hand-written parts', () => {
    expect(T2_PARTS).toHaveLength(40);
  });

  it.each(T2_PARTS.map((x, i) => [i, x] as const))(
    'part %i: the unpacked tree is the node reader’s, and every path packed',
    (_i, xml) => {
      const p = packed(xml);
      expect(unpackPaths(p)).toEqual(plain(xml));
      // Every path of these parts is in the strict form: none is read as nodes.
      expect(packedPaths(p)).toHaveLength(pathNodes(p).length);
      expect(packedPaths(p).length).toBeGreaterThan(0);
    },
  );
});

/** The forms the packed reader does not know: each is read by the node reader's loop. */
const FALLBACKS: [string, string][] = [
  ['whitespace between commands', geom(`<a:path>\n  ${M1}\n  <a:close/>\n</a:path>`)],
  ['whitespace inside a tag', geom(`<a:path><a:moveTo><a:pt  x="1" y="2" /></a:moveTo></a:path>`)],
  ['a text node', geom(`<a:path>${M1}x<a:close/></a:path>`)],
  ['a comment', geom(`<a:path>${M1}<!-- c --><a:close/></a:path>`)],
  ['an empty CDATA section', geom(`<a:path>${M1}<![CDATA[]]><a:close/></a:path>`)],
  ['a CDATA section with text', geom(`<a:path>${M1}<![CDATA[ x ]]><a:close/></a:path>`)],
  ['a processing instruction', geom(`<a:path>${M1}<?pi x?><a:close/></a:path>`)],
  ['an unknown child', geom(`<a:path>${M1}<a:foo/><a:close/></a:path>`)],
  ['a third attribute on a:pt', geom(`<a:path><a:moveTo><a:pt x="1" y="2" z="3"/></a:moveTo></a:path>`)],
  ['a missing x', geom(`<a:path><a:moveTo><a:pt y="2"/></a:moveTo></a:path>`)],
  ['a missing y', geom(`<a:path><a:moveTo><a:pt x="2"/></a:moveTo></a:path>`)],
  ['a guide name for x', geom(`<a:path><a:moveTo>${pt('w', 2)}</a:moveTo></a:path>`)],
  ['a leading zero', geom(`<a:path><a:moveTo>${pt('01', 2)}</a:moveTo></a:path>`)],
  ['-0', geom(`<a:path><a:moveTo>${pt('-0', 2)}</a:moveTo></a:path>`)],
  ['a plus sign', geom(`<a:path><a:moveTo>${pt('+5', 2)}</a:moveTo></a:path>`)],
  ['a decimal', geom(`<a:path><a:moveTo>${pt('1.5', 2)}</a:moveTo></a:path>`)],
  ['an exponent', geom(`<a:path><a:moveTo>${pt('1e3', 2)}</a:moveTo></a:path>`)],
  ['a character reference', geom(`<a:path><a:moveTo>${pt('&#49;', 2)}</a:moveTo></a:path>`)],
  ['16 digits', geom(`<a:path><a:moveTo>${pt('1234567890123456', 2)}</a:moveTo></a:path>`)],
  ['an empty number', geom(`<a:path><a:moveTo>${pt('', 2)}</a:moveTo></a:path>`)],
  ['a lnTo with no a:pt', geom(`<a:path>${M1}<a:lnTo/></a:path>`)],
  ['a lnTo with two a:pt', geom(`<a:path>${M1}<a:lnTo>${pt(1, 2)}${pt(3, 4)}</a:lnTo></a:path>`)],
  ['a moveTo with none', geom(`<a:path><a:moveTo/></a:path>`)],
  ['a quadBezTo with one a:pt', geom(`<a:path><a:quadBezTo>${pt(1, 2)}</a:quadBezTo></a:path>`)],
  [
    'a cubicBezTo with four a:pt',
    geom(`<a:path><a:cubicBezTo>${pt(1, 2).repeat(4)}</a:cubicBezTo></a:path>`),
  ],
  ['a nested a:path', geom(`<a:path><a:path><a:close/></a:path></a:path>`)],
  [
    'an a:path in a:gradFill',
    '<a:gradFill><a:gsLst/><a:path path="circle"><a:fillToRect l="50000" t="50000"/></a:path></a:gradFill>',
  ],
  ['an a:path of another parent', '<a:foo><a:path><a:close/></a:path></a:foo>'],
  ['a self-closing a:path', geom('<a:path w="1" h="1"/>')],
  ['an arcTo with a missing attribute', geom(`<a:path><a:arcTo wR="1" hR="2" stAng="3"/></a:path>`)],
  [
    'an arcTo with a fifth attribute',
    geom(`<a:path><a:arcTo wR="1" hR="2" stAng="3" swAng="4" x="5"/></a:path>`),
  ],
  [
    'an arcTo with a child',
    geom(`<a:path><a:arcTo wR="1" hR="2" stAng="3" swAng="4">${pt(1, 2)}</a:arcTo></a:path>`),
  ],
  ['a close with an attribute', geom(`<a:path><a:close x="1"/></a:path>`)],
  ['a mismatched end tag', geom(`<a:path><a:moveTo>${pt(1, 2)}</a:lnTo></a:path>`)],
  ['a pt that is not self-closing', geom(`<a:path><a:moveTo><a:pt x="1" y="2"></a:pt></a:moveTo></a:path>`)],
  ['an unterminated path (end of input)', `<a:custGeom><a:pathLst><a:path>${M1}`],
  ['an unterminated path (closed by the list)', geom(`<a:path>${M1}`)],
  ['a path ended by an end tag with a space', geom(`<a:path>${M1}</a:path >`)],
  [
    'a path with a dropped-depth child',
    `${'<d>'.repeat(XML_MAX_DEPTH - 2)}<a:pathLst><a:path>${M1}</a:path></a:pathLst>`,
  ],
];
const DEEP_FITS = `${'<d>'.repeat(XML_MAX_DEPTH - 3)}<a:pathLst><a:path>${M1}<a:close/></a:path></a:pathLst>`;

describe('packed paths: every other form is the node reader’s (T3)', () => {
  it.each(FALLBACKS)('%s', (_label, xml) => {
    const p = packed(xml);
    expect(packedPaths(p)).toEqual([]);
    expect(unpackPaths(p)).toEqual(plain(xml));
    expect(p).toEqual(plain(xml));
  });

  it('keeps the depth rule: a path whose points would be dropped is read as nodes, one that fits is packed', () => {
    // A path whose a:pt would sit past XML_MAX_DEPTH: the node reader drops them (the commands stay).
    const over = packed(`${'<d>'.repeat(XML_MAX_DEPTH - 2)}<a:pathLst><a:path>${M1}</a:path></a:pathLst>`);
    expect(packedPaths(over)).toEqual([]);
    const overPath = pathNodes(over)[0]!;
    expect(overPath.children.map((c) => c.name)).toEqual(['a:moveTo']);
    expect(overPath.children[0]!.children).toEqual([]);
    // One level shallower, every point is within the rule and the path packs.
    const fits = packed(DEEP_FITS);
    expect(packedPaths(fits)).toHaveLength(1);
    expect(unpackPaths(fits)).toEqual(plain(DEEP_FITS));
  });
});

/** Every input of T2 and T3, and the cuts and declarations of T4. */
const ALL_INPUTS = [...T2_PARTS, ...FALLBACKS.map((f) => f[1]), DEEP_FITS];

describe('packed paths: the refusals (T4)', () => {
  it('gives the node reader’s error (or none) for every input cut at 30 places', () => {
    let cuts = 0;
    let refused = 0;
    for (const xml of ALL_INPUTS) {
      for (let k = 0; k <= 30; k++) {
        const cut = xml.slice(0, Math.floor((xml.length * k) / 30));
        const a = outcome(() => packed(cut));
        const b = outcome(() => plain(cut));
        expect(a).toEqual(b);
        cuts++;
        if ('error' in b) refused++;
      }
    }
    // The cuts do cut markup: a good share of them are refused by both readers.
    expect(cuts).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(100);
  });

  it('gives the node reader\u2019s error for a tag whose quotes never balance', () => {
    const x = geom(`<a:path><a:moveTo><a:pt x="1' y="2"/></a:moveTo></a:path>`);
    const b = outcome(() => plain(x));
    expect(b).toEqual({ error: 'p.xml: unterminated tag' });
    expect(outcome(() => packed(x))).toEqual(b);
  });

  it('refuses a DOCTYPE and other declarations outside and inside a path, in both modes', () => {
    for (const x of [
      `<!DOCTYPE x>${geom(`<a:path>${M1}</a:path>`)}`,
      geom(`<a:path>${M1}<!DOCTYPE x [<!ENTITY e "v">]><a:close/></a:path>`),
      geom(`<a:path>${M1}<!ELEMENT x ANY></a:path>`),
      geom(`<a:path><!DOCTYPE x>${M1}</a:path>`),
    ]) {
      const a = outcome(() => packed(x));
      const b = outcome(() => plain(x));
      expect('error' in b).toBe(true);
      expect(a).toEqual(b);
    }
    expect((outcome(() => packed('<!DOCTYPE x><a/>')) as { error: string }).error).toMatch(
      /DOCTYPE \(refused\)/,
    );
  });
});

describe('packed paths: the bounds (T5)', () => {
  it('keeps the unpacked reader’s 250,000-tag bound (the pin)', () => {
    expect(() => plain(`<r>${'<a/>'.repeat(MAX_TAGS_PER_PART)}</r>`)).toThrow(/more than/);
  });

  it('reads a part of 1.2 million a:pt within the default bounds (the unpacked reader refuses it)', () => {
    expect(2 * 1_200_000).toBeLessThanOrEqual(MAX_PACKED_PATH_ITEMS_PER_PART);
    const lnTo = `<a:lnTo>${pt(1, 2)}</a:lnTo>`;
    const xml = geom(`<a:path w="1" h="1">${M1}${lnTo.repeat(1_199_999)}</a:path>`);
    expect(() => plain(xml)).toThrow(/more than 250000 XML tags/);
    const t0 = performance.now();
    const p = packed(xml);
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    const path = packedPaths(p);
    expect(path).toHaveLength(1);
    expect(path[0]!.packed!.ops.length).toBe(1_200_000);
    expect(path[0]!.packed!.nums.length).toBe(2_400_000);
  });

  it('refuses a part past the element bound with kind elements, naming the part and the number', () => {
    const xml = `<r>${'<a:b/>'.repeat(MAX_PACKED_ELEMENTS_PER_PART + 1)}</r>`;
    let err: unknown;
    try {
      packed(xml, 'ppt/slides/slide9.xml');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(XmlBoundError);
    expect((err as XmlBoundError).kind).toBe('elements');
    expect((err as XmlBoundError).message).toContain('ppt/slides/slide9.xml');
    expect((err as XmlBoundError).message).toContain(String(MAX_PACKED_ELEMENTS_PER_PART));
  });

  it('counts the text nodes of a part too (what the cache holds is nodes)', () => {
    const small: ParseOptions = { pack: { maxElements: 100, maxPathItems: 1000 } };
    expect(() => parseXml(`<r>${'<a:b> </a:b>'.repeat(40)}</r>`, 'p.xml', small)).not.toThrow();
    expect(() => parseXml(`<r>${'<a:b> </a:b>'.repeat(60)}</r>`, 'p.xml', small)).toThrow(XmlBoundError);
  });

  it('refuses a path with more items than the bound with kind points (the option is lowered, 4 million is never built)', () => {
    const small: ParseOptions = { pack: { maxElements: 1_000_000, maxPathItems: 1000 } };
    const path = (n: number) => geom(`<a:path>${M1}${`<a:lnTo>${pt(1, 2)}</a:lnTo>`.repeat(n)}</a:path>`);
    // 1 + n commands and 1 + n points: under the bound at n = 400, over it at n = 600.
    expect(() => parseXml(path(400), 'p.xml', small)).not.toThrow();
    let err: unknown;
    try {
      parseXml(path(600), 'ppt/slides/slide2.xml', small);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(XmlBoundError);
    expect((err as XmlBoundError).kind).toBe('points');
    expect((err as XmlBoundError).message).toContain('ppt/slides/slide2.xml');
    expect((err as XmlBoundError).message).toContain('1000');
  });

  it('counts the nodes of a path that fell back to the node reader as elements', () => {
    const small: ParseOptions = { pack: { maxElements: 150, maxPathItems: 1_000_000 } };
    const lnTo = `<a:lnTo>${pt(1, 2)}</a:lnTo>`;
    const strict = geom(`<a:path>${M1}${lnTo.repeat(200)}</a:path>`);
    const loose = geom(`<a:path>\n${M1}${lnTo.repeat(200)}</a:path>`);
    expect(() => parseXml(strict, 'p.xml', small)).not.toThrow();
    let err: unknown;
    try {
      parseXml(loose, 'p.xml', small);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(XmlBoundError);
    expect((err as XmlBoundError).kind).toBe('elements');
  });
});

describe('packed paths: a failed pack stays linear (T6)', () => {
  const time = (fn: () => void) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it('a path of 300,000 commands that fails at its last byte is read once packed and once as nodes', () => {
    const xml = geom(`<a:path>${'<a:close/>'.repeat(300_000)}<a:foo/></a:path>`);
    let tree: XNode[] = [];
    expect(time(() => (tree = packed(xml)))).toBeLessThan(budgetMs(5_000));
    expect(packedPaths(tree)).toEqual([]);
    const path = pathNodes(tree)[0]!;
    expect(path.children).toHaveLength(300_001);
    expect(path.children[300_000]!.name).toBe('a:foo');
    // The node reader refuses 300,000 tags at its pre-pass (the bound packing lifts): a size it accepts is compared whole.
    const small = geom(`<a:path>${'<a:close/>'.repeat(60_000)}<a:foo/></a:path>`);
    expect(packed(small)).toEqual(plain(small));
  });

  it('10,000 paths that each fail at their last byte', () => {
    const one = `<a:path>${'<a:close/>'.repeat(5)}<a:foo/></a:path>`;
    const xml = geom(one.repeat(10_000));
    let a: XNode[] = [];
    expect(time(() => (a = packed(xml)))).toBeLessThan(budgetMs(5_000));
    expect(a).toEqual(plain(xml));
  });

  it('100,000 a:path nested in each other', () => {
    const n = 100_000;
    const xml = `<a:pathLst>${'<a:path>'.repeat(n)}${'</a:path>'.repeat(n)}</a:pathLst>`;
    let a: XNode[] = [];
    expect(time(() => (a = packed(xml)))).toBeLessThan(budgetMs(5_000));
    expect(a).toEqual(plain(xml));
  });

  it('a 2 MB attribute value on an a:pt', () => {
    const xml = geom(`<a:path><a:moveTo><a:pt x="${'1'.repeat(2_000_000)}" y="1"/></a:moveTo></a:path>`);
    let a: XNode[] = [];
    expect(time(() => (a = packed(xml)))).toBeLessThan(budgetMs(5_000));
    expect(a).toEqual(plain(xml));
  });

  it('200,000 <a:pt openers with no end', () => {
    const xml = `<a:custGeom><a:pathLst><a:path><a:moveTo>${'<a:pt '.repeat(200_000)}`;
    let a: Outcome = { error: '' };
    expect(time(() => (a = outcome(() => packed(xml))))).toBeLessThan(budgetMs(5_000));
    expect(a).toEqual(outcome(() => plain(xml)));
    expect('error' in a).toBe(true);
    // The same openers as complete tags: 200,000 pt (a failed pack, then the node loop).
    const closed = `<a:custGeom><a:pathLst><a:path><a:moveTo>${'<a:pt x="1"/>'.repeat(60_000)}</a:moveTo></a:path></a:pathLst></a:custGeom>`;
    let b: XNode[] = [];
    expect(time(() => (b = packed(closed)))).toBeLessThan(budgetMs(5_000));
    expect(b).toEqual(plain(closed));
  });
});

describe('packed paths: structure (T7) and the unpacked pin (T8)', () => {
  const lnTo = `<a:lnTo>${pt(1, 2)}</a:lnTo>`;

  it('holds a dense part as one node per path, not one per point', () => {
    const paths = 3;
    const body = `<a:path>${M1}${lnTo.repeat(100_000)}</a:path>`;
    const nodes = packed(geom(body.repeat(paths)));
    // custGeom, pathLst, and the paths: nothing else.
    expect(allNodes(nodes)).toHaveLength(2 + paths);
    expect(packedPaths(nodes)).toHaveLength(paths);
  });

  it('builds the node form for a dense path when no options are given (annotate.ts reads it so)', () => {
    const nodes = plain(geom(`<a:path>${M1}${lnTo.repeat(1000)}</a:path>`));
    const path = pathNodes(nodes)[0]!;
    expect(path.packed).toBeUndefined();
    expect(path.children).toHaveLength(1001);
    expect(path.children[0]!.children[0]!.attrs).toEqual({ x: '1', y: '2' });
    expect(allNodes(nodes)).toHaveLength(2 + 1 + 2 * 1001);
  });
});

// ── T9: fuzz parity ─────────────────────────────────────────────────────────────────────────────────────

const SEED = 20261118;
const numberArb = fc.oneof(
  { weight: 14, arbitrary: fc.integer({ min: -1_000_000, max: 1_000_000 }).map(String) },
  { weight: 1, arbitrary: fc.integer({ min: -999_999_999_999_999, max: 999_999_999_999_999 }).map(String) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '0',
      '-0',
      '007',
      '+5',
      '1.5',
      '1e3',
      'w',
      '&#49;',
      '',
      '1234567890123456',
      '-',
      '--1',
      ' 1',
    ),
  },
);
const quoteArb = fc.constantFrom('"', '"', '"', "'");
const ptArb = fc
  .record({
    x: numberArb,
    y: numberArb,
    yFirst: fc.boolean(),
    q: quoteArb,
    extra: fc.constantFrom('', '', '', '', ' z="1"'),
    gap: fc.constantFrom('', '', '', '', ' '),
    open: fc.constantFrom('/>', '/>', '/>', '/>', '></a:pt>'),
  })
  .map((r) => {
    const a = `x=${r.q}${r.x}${r.q}`;
    const b = `y=${r.q}${r.y}${r.q}`;
    return `<a:pt ${r.yFirst ? `${b} ${a}` : `${a} ${b}`}${r.extra}${r.gap}${r.open}`;
  });
const commandArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: ptArb.map((p) => `<a:moveTo>${p}</a:moveTo>`) },
  { weight: 6, arbitrary: ptArb.map((p) => `<a:lnTo>${p}</a:lnTo>`) },
  { weight: 2, arbitrary: fc.tuple(ptArb, ptArb).map(([a, b]) => `<a:quadBezTo>${a}${b}</a:quadBezTo>`) },
  {
    weight: 2,
    arbitrary: fc.tuple(ptArb, ptArb, ptArb).map(([a, b, c]) => `<a:cubicBezTo>${a}${b}${c}</a:cubicBezTo>`),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(numberArb, numberArb, numberArb, numberArb, fc.boolean())
      .map(
        ([a, b, c, d, drop]) => `<a:arcTo wR="${a}" hR="${b}" stAng="${c}"${drop ? '' : ` swAng="${d}"`}/>`,
      ),
  },
  { weight: 3, arbitrary: fc.constant('<a:close/>') },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      '\n',
      ' ',
      '<!-- c -->',
      '<?pi x?>',
      '<![CDATA[]]>',
      '<![CDATA[ x ]]>',
      'text',
      '&amp;',
      '<a:foo/>',
      '<a:foo><a:pt x="1" y="2"/></a:foo>',
      '<a:lnTo/>',
      '<a:moveTo>',
      '</a:lnTo>',
      '<a:close x="1"/>',
    ),
  },
);
/** Strict-form commands only (canonical integers, no extras): the paths that pack. */
const strictPtArb = fc
  .record({
    x: fc.integer({ min: -1_000_000, max: 1_000_000 }),
    y: fc.integer({ min: -999_999_999_999_999, max: 999_999_999_999_999 }),
    yFirst: fc.boolean(),
    q: quoteArb,
  })
  .map(
    (r) =>
      `<a:pt ${r.yFirst ? `y=${r.q}${r.y}${r.q} x=${r.q}${r.x}${r.q}` : `x=${r.q}${r.x}${r.q} y=${r.q}${r.y}${r.q}`}/>`,
  );
const strictCommandArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: strictPtArb.map((p) => `<a:moveTo>${p}</a:moveTo>`) },
  { weight: 6, arbitrary: strictPtArb.map((p) => `<a:lnTo>${p}</a:lnTo>`) },
  {
    weight: 2,
    arbitrary: fc.tuple(strictPtArb, strictPtArb).map(([a, b]) => `<a:quadBezTo>${a}${b}</a:quadBezTo>`),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(strictPtArb, strictPtArb, strictPtArb)
      .map(([a, b, c]) => `<a:cubicBezTo>${a}${b}${c}</a:cubicBezTo>`),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.integer(), fc.integer(), fc.integer(), fc.integer())
      .map(([a, b, c, d]) => `<a:arcTo wR="${a}" hR="${b}" stAng="${c}" swAng="${d}"/>`),
  },
  { weight: 2, arbitrary: fc.constant('<a:close/>') },
);
const pathArb = fc
  .record({
    attrs: fc.constantFrom(
      '',
      ' w="100" h="100"',
      ' w="5" h="5" fill="none" stroke="0" extrusionOk="0"',
      " fill='none'",
    ),
    // Half of the paths are strict-form paths (they pack), half mix in every form that makes the packed reader fall back.
    strict: fc.boolean(),
    strictCommands: fc.array(strictCommandArb, { maxLength: 24 }),
    commands: fc.array(commandArb, { maxLength: 24 }),
    selfClose: fc.constantFrom(false, false, false, false, false, true),
  })
  .map((r) =>
    r.selfClose
      ? `<a:path${r.attrs}/>`
      : `<a:path${r.attrs}>${(r.strict ? r.strictCommands : r.commands).join('')}</a:path>`,
  );
const partArb = fc
  .record({
    paths: fc.array(pathArb, { minLength: 1, maxLength: 6 }),
    wrap: fc.constantFrom(0, 1, 2, 3, 4),
    // One part in four is cut at a random place (fc.option's freq is the weight of the nil value, not of the cut).
    cut: fc.oneof(
      { weight: 3, arbitrary: fc.constant(undefined) },
      { weight: 1, arbitrary: fc.double({ min: 0, max: 1, noNaN: true }) },
    ),
  })
  .map((r) => {
    const list = `<a:pathLst>${r.paths.join('')}</a:pathLst>`;
    const wrapped = [
      `<a:custGeom>${list}</a:custGeom>`,
      `<p:sp><p:spPr><a:custGeom><a:avLst/>${list}</a:custGeom></p:spPr><p:txBody><a:p><a:t>t</a:t></a:p></p:txBody></p:sp>`,
      `<x>${list}</x>`,
      `<a:custGeom>${list}${list}</a:custGeom>`,
      `<a:gradFill><a:path path="circle"><a:fillToRect/></a:path></a:gradFill><a:custGeom>${list}</a:custGeom>`,
    ][r.wrap]!;
    return r.cut === undefined ? wrapped : wrapped.slice(0, Math.floor(wrapped.length * r.cut));
  });

describe('packed paths: fuzz parity with the node reader (T9)', () => {
  it('gives equal trees and equal refusals for 3,000 generated path-heavy parts', () => {
    // eslint-disable-next-line no-console
    console.info(`xml.packed fuzz seed ${SEED}`);
    let packedTotal = 0;
    let accepted = 0;
    let refused = 0;
    const t0 = performance.now();
    fc.assert(
      fc.property(partArb, (xml) => {
        let raw: XNode[] | undefined;
        const a = outcome(() => (raw = packed(xml)));
        const b = outcome(() => plain(xml));
        expect(a).toEqual(b);
        if ('tree' in b) accepted++;
        else refused++;
        if (raw) packedTotal += packedPaths(raw as XNode[]).length;
      }),
      { numRuns: 3000, seed: SEED },
    );
    expect(performance.now() - t0).toBeLessThan(budgetMs(20_000));
    // The generator exercises both sides: parts that parse, parts that are refused, and paths that pack.
    expect(accepted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(50);
    expect(packedTotal).toBeGreaterThan(1000);
  });
});
