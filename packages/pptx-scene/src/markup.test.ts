import { describe, expect, it } from 'vitest';
import {
  chooseAlternate,
  isPercentPart,
  NS,
  type NormalizeOptions,
  normalizePart,
  transitionalUri,
  UNDERSTOOD_NAMESPACES,
} from './markup.ts';
import { parseXml, rootOf, type XNode } from './xml.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const MC = NS.mc;
const PLAIN: NormalizeOptions = { strict: false, percents: false };

function read(xml: string, o: NormalizeOptions = PLAIN): XNode {
  const root = rootOf(parseXml(xml, 'test.xml'))!;
  normalizePart(root, o);
  return root;
}

/** Element names of a tree, depth first, `#text` left out. */
function names(n: XNode): string[] {
  const out: string[] = [];
  const walk = (x: XNode) => {
    if (x.name === '#text') return;
    out.push(x.name);
    for (const c of x.children) walk(c);
  };
  walk(n);
  return out;
}

describe('Strict OOXML', () => {
  it('maps namespace and relationship-type URIs to Transitional', () => {
    expect(transitionalUri('http://purl.oclc.org/ooxml/presentationml/main')).toBe(NS.p);
    expect(transitionalUri('http://purl.oclc.org/ooxml/drawingml/main')).toBe(NS.a);
    expect(transitionalUri('http://purl.oclc.org/ooxml/officeDocument/relationships')).toBe(NS.r);
    expect(transitionalUri('http://purl.oclc.org/ooxml/officeDocument/relationships/slideLayout')).toBe(
      `${NS.r}/slideLayout`,
    );
    expect(transitionalUri('http://purl.oclc.org/ooxml/drawingml/chart')).toBe(
      'http://schemas.openxmlformats.org/drawingml/2006/chart',
    );
    expect(
      transitionalUri('http://purl.oclc.org/ooxml/officeDocument/relationships/extendedProperties'),
    ).toBe('http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties');
    // Not Strict, or not a URI it knows: unchanged.
    expect(transitionalUri(NS.p)).toBe(NS.p);
    expect(transitionalUri('http://purl.oclc.org/ooxml/other/main')).toBe(
      'http://purl.oclc.org/ooxml/other/main',
    );
    expect(transitionalUri('http://purl.oclc.org/ooxml/drawingml/main?x')).toBe(
      'http://purl.oclc.org/ooxml/drawingml/main?x',
    );
  });

  it('reads Strict percentages as thousandths in DrawingML and PresentationML parts only', () => {
    expect(isPercentPart('ppt/slides/slide1.xml')).toBe(true);
    expect(isPercentPart('PPT/SlideMasters/slideMaster1.xml')).toBe(true);
    expect(isPercentPart('ppt/theme/theme1.xml')).toBe(true);
    expect(isPercentPart('ppt/presentation.xml')).toBe(false);
    expect(isPercentPart('ppt/slides/_rels/slide1.xml.rels')).toBe(false);
    expect(isPercentPart('ppt/slides/x/slide1.xml')).toBe(false);

    const xml =
      '<p:sld xmlns:p="http://purl.oclc.org/ooxml/presentationml/main" xmlns:a="http://purl.oclc.org/ooxml/drawingml/main">' +
      '<a:lumMod val="75%"/><a:alpha val="12.5%"/><a:off val="-5%"/><a:x val="abc%"/><a:y val="1.%"/>' +
      '<p:cNvPr name="50%" descr="7%"/></p:sld>';
    const strict = read(xml, { strict: true, percents: true });
    expect(strict.attrs['xmlns:p']).toBe(NS.p);
    const attr = (i: number, k: string) => strict.children[i]!.attrs[k];
    expect(attr(0, 'val')).toBe('75000');
    expect(attr(1, 'val')).toBe('12500');
    expect(attr(2, 'val')).toBe('-5000');
    expect(attr(3, 'val')).toBe('abc%');
    expect(attr(4, 'val')).toBe('1.%');
    // The deck's own words are not percentages.
    expect(attr(5, 'name')).toBe('50%');
    expect(attr(5, 'descr')).toBe('7%');
    // Without `percents` (another part), only the URIs change.
    const other = read(xml, { strict: true, percents: false });
    expect(other.children[0]!.attrs.val).toBe('75%');
    expect(other.attrs['xmlns:a']).toBe(NS.a);
  });
});

describe('usual prefixes', () => {
  it('renames elements and attributes of known namespaces, whatever the deck declared', () => {
    const root = read(
      `<pml:sld xmlns:pml="${NS.p}" xmlns:dml="${NS.a}" xmlns:rel="${NS.r}" xmlns:x="urn:unknown">` +
        '<pml:cSld><pml:spTree><dml:blip rel:embed="rId2" x:keep="1" xml:space="preserve" plain="1"/></pml:spTree></pml:cSld></pml:sld>',
    );
    expect(names(root)).toEqual(['p:sld', 'p:cSld', 'p:spTree', 'a:blip']);
    const blip = root.children[0]!.children[0]!.children[0]!;
    expect(Object.keys(blip.attrs)).toEqual(['r:embed', 'x:keep', 'xml:space', 'plain']);
    expect(Object.getPrototypeOf(blip.attrs)).toBeNull();
  });

  it('reads a default namespace, and a redeclaration below it, by scope', () => {
    const root = read(
      `<sld xmlns="${NS.p}" xmlns:a="${NS.a}"><cSld><a:t>x</a:t>` +
        '<inner xmlns="urn:other"><deep/></inner>' +
        `<q:x xmlns:q="${NS.a}"><q:y xmlns:q="urn:other"/></q:x></cSld></sld>`,
    );
    expect(names(root)).toEqual(['p:sld', 'p:cSld', 'a:t', 'inner', 'deep', 'a:x', 'q:y']);
  });

  it('leaves the package vocabularies unprefixed and unknown or undeclared prefixes as written', () => {
    const rels = read(
      '<pr:Relationships xmlns:pr="http://schemas.openxmlformats.org/package/2006/relationships"><pr:Relationship Id="a"/></pr:Relationships>',
    );
    expect(names(rels)).toEqual(['Relationships', 'Relationship']);
    const loose = read('<p:sld><a:t/><foo:bar/></p:sld>');
    expect(names(loose)).toEqual(['p:sld', 'a:t', 'foo:bar']);
  });

  it('keeps the first of two attributes that end up with one name', () => {
    const root = read(
      `<p:pic xmlns:p="${NS.p}" xmlns:r="${NS.r}" xmlns:q="${NS.r}" r:embed="one" q:embed="two"/>`,
    );
    expect(root.attrs['r:embed']).toBe('one');
  });

  it('is not fooled by prototype names', () => {
    const root = read(
      `<__proto__:sld xmlns:__proto__="${NS.p}" xmlns:constructor="${NS.a}" __proto__="1" constructor:x="2">` +
        '<constructor:t>x</constructor:t></__proto__:sld>',
    );
    expect(names(root)).toEqual(['p:sld', 'a:t']);
    expect(Object.entries(root.attrs)).toContainEqual(['__proto__', '1']);
    expect(root.attrs['a:x']).toBe('2');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(root.attrs)).toBeNull();
  });
});

describe('mc:AlternateContent', () => {
  const ac = (choices: string, fallback = '<mc:Fallback><p:fb/></mc:Fallback>') =>
    `<p:spTree xmlns:p="${NS.p}" xmlns:mc="${MC}"><mc:AlternateContent>${choices}${fallback}</mc:AlternateContent></p:spTree>`;
  const kept = (root: XNode) => root.children[0]!.children.map((c) => c.name);
  const content = (root: XNode) => names(root.children[0]!.children[0]!).slice(1);

  it('keeps the first Choice whose namespaces are understood, else the Fallback, never both', () => {
    // Declared on the Choice, as PowerPoint writes it.
    let r = read(ac(`<mc:Choice xmlns:p14="${NS.p14}" Requires="p14"><p:choice/></mc:Choice>`));
    expect(kept(r)).toEqual(['mc:Choice']);
    expect(content(r)).toEqual(['p:choice']);
    // Unknown namespace: the Fallback.
    r = read(ac('<mc:Choice xmlns:cx1="urn:chartex" Requires="cx1"><p:choice/></mc:Choice>'));
    expect(kept(r)).toEqual(['mc:Fallback']);
    expect(content(r)).toEqual(['p:fb']);
    // Every required namespace must be understood.
    r = read(
      ac(`<mc:Choice xmlns:p14="${NS.p14}" xmlns:am3d="urn:3d" Requires="p14 am3d"><p:choice/></mc:Choice>`),
    );
    expect(kept(r)).toEqual(['mc:Fallback']);
    // The first understood Choice of several.
    r = read(
      ac(
        '<mc:Choice xmlns:aink="urn:ink" Requires="aink"><p:one/></mc:Choice>' +
          `<mc:Choice xmlns:a14="${NS.a14}" Requires="a14"><p:two/></mc:Choice>` +
          `<mc:Choice xmlns:p14="${NS.p14}" Requires="p14"><p:three/></mc:Choice>`,
      ),
    );
    expect(content(r)).toEqual(['p:two']);
    // No Requires, no understood Choice and no Fallback: nothing.
    expect(kept(read(ac('<mc:Choice><p:x/></mc:Choice>')))).toEqual(['mc:Fallback']);
    expect(kept(read(ac('<mc:Choice xmlns:z="urn:z" Requires="z"><p:x/></mc:Choice>', '')))).toEqual([]);
  });

  it('goes by namespace, not by the prefix the deck chose', () => {
    // A prefix bound to an understood namespace on an ancestor; LibreOffice goes by the literal prefix.
    const r = read(
      `<p:sld xmlns:p="${NS.p}" xmlns:mc="${MC}" xmlns:pp="${NS.p14}"><mc:AlternateContent>` +
        '<mc:Choice Requires="pp"><p:choice/></mc:Choice><mc:Fallback><p:fb/></mc:Fallback></mc:AlternateContent></p:sld>',
    );
    const choice = r.children[0]!.children[0]!;
    expect(choice.name).toBe('mc:Choice');
    expect(choice.attrs.Requires).toBe('p14'); // rewritten with the usual prefix
    // The usual prefix rebound to another namespace is not understood.
    const other = read(ac('<mc:Choice xmlns:p14="urn:not-p14" Requires="p14"><p:choice/></mc:Choice>'));
    expect(kept(other)).toEqual(['mc:Fallback']);
    // An undeclared usual prefix is read as its namespace.
    expect(kept(read(ac('<mc:Choice Requires="a14"><p:choice/></mc:Choice>')))).toEqual(['mc:Choice']);
    // The markup-compatibility namespace under another prefix.
    const m = read(
      `<p:spTree xmlns:p="${NS.p}" xmlns:compat="${MC}"><compat:AlternateContent>` +
        `<compat:Choice xmlns:p14="${NS.p14}" Requires="p14"><p:choice/></compat:Choice><compat:Fallback><p:fb/></compat:Fallback>` +
        '</compat:AlternateContent></p:spTree>',
    );
    expect(names(m)).toEqual(['p:spTree', 'mc:AlternateContent', 'mc:Choice', 'p:choice']);
  });

  it('resolves nested alternate content inside the kept branch', () => {
    const r = read(
      ac(
        `<mc:Choice xmlns:p14="${NS.p14}" Requires="p14"><p:grpSp><mc:AlternateContent>` +
          '<mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v"><p:ole/></mc:Choice>' +
          '<mc:Fallback><p:pic/></mc:Fallback></mc:AlternateContent></p:grpSp></mc:Choice>',
      ),
    );
    expect(names(r)).toEqual([
      'p:spTree',
      'mc:AlternateContent',
      'mc:Choice',
      'p:grpSp',
      'mc:AlternateContent',
      'mc:Fallback',
      'p:pic',
    ]);
  });

  it('chooses on trees not read through the package too', () => {
    const raw = rootOf(
      parseXml(
        `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${NS.p14}" Requires="p14"><a/></mc:Choice><mc:Fallback><b/></mc:Fallback></mc:AlternateContent>`,
        't',
      ),
    )!;
    expect(chooseAlternate(raw)?.name).toBe('mc:Choice');
    const fb = rootOf(
      parseXml(
        `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice Requires="cx1"><a/></mc:Choice><mc:Fallback><b/></mc:Fallback></mc:AlternateContent>`,
        't',
      ),
    )!;
    expect(chooseAlternate(fb)?.name).toBe('mc:Fallback');
    // On a normalised tree, the one branch left.
    const n = read(ac('<mc:Choice Requires="zz"><p:x/></mc:Choice>'));
    expect(chooseAlternate(n.children[0]!)?.name).toBe('mc:Fallback');
    expect(UNDERSTOOD_NAMESPACES.has(NS.p14)).toBe(true);
  });

  it('stays linear on wide and deep trees', () => {
    const t0 = performance.now();
    const wide = read(
      `<p:spTree xmlns:p="${NS.p}">${'<p:sp q:x="1" xmlns:q="urn:q"/>'.repeat(100_000)}</p:spTree>`,
    );
    expect(wide.children).toHaveLength(100_000);
    const deep = read(
      `<pml:a xmlns:pml="${NS.p}">${'<pml:b xmlns:x="urn:x">'.repeat(300)}${'</pml:b>'.repeat(300)}</pml:a>`,
    );
    expect(deep.name).toBe('p:a');
    const nested = `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice Requires="p14">`.repeat(200);
    read(`<p:x xmlns:p="${NS.p}">${nested}${'</mc:Choice></mc:AlternateContent>'.repeat(200)}</p:x>`);
    expect(performance.now() - t0).toBeLessThan(budgetMs(5000));
  });
});
