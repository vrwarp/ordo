import { describe, expect, it } from 'vitest';
import { externalHost, openPackage, relsPartOf, resolveTarget } from './opc.ts';

const enc = (s: string) => new TextEncoder().encode(s);

describe('relationship targets', () => {
  it('resolve inside the package', () => {
    expect(relsPartOf('ppt/slides/slide1.xml')).toBe('ppt/slides/_rels/slide1.xml.rels');
    expect(relsPartOf('')).toBe('_rels/.rels');
    expect(resolveTarget('ppt/slides/slide1.xml', '../media/image%201.png')).toBe('ppt/media/image 1.png');
    expect(resolveTarget('ppt/slides/slide1.xml', '/ppt/media/a.png#frag')).toBe('ppt/media/a.png');
    expect(resolveTarget('ppt/slides/slide1.xml', '../../../../etc/passwd')).toBe('etc/passwd');
    expect(resolveTarget('', 'ppt/presentation.xml')).toBe('ppt/presentation.xml');
    expect(resolveTarget('ppt/a.xml', '..')).toBeUndefined();
  });

  it('log external targets by host only', () => {
    expect(externalHost('https://example.com/a/b?c')).toBe('example.com');
    expect(externalHost('file:///C:/x.mp4')).toBe('a local file');
  });
});

describe('openPackage', () => {
  it('finds parts case-insensitively, the first of a case clash winning, and resolves relationships', () => {
    const pkg = openPackage(
      new Map([
        ['ppt/slides/slide1.xml', enc('<p:sld/>')],
        [
          'ppt/slides/_rels/slide1.xml.rels',
          enc(
            '<Relationships><Relationship Id="rId1" Type="http://x/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
              '<Relationship Id="rId1" Type="http://x/image" Target="dup.png"/>' +
              '<Relationship Id="rId2" Type="http://x/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>',
          ),
        ],
        ['PPT/slideLayouts/SlideLayout1.xml', enc('<p:sldLayout/>')],
        ['ppt/slidelayouts/slidelayout1.xml', enc('<p:other/>')],
      ]),
    );
    expect(pkg.find('ppt/slideLayouts/slideLayout1.xml')).toBe('PPT/slideLayouts/SlideLayout1.xml');
    expect(pkg.rels('ppt/slides/slide1.xml')).toHaveLength(2);
    expect(pkg.relOfType('ppt/slides/slide1.xml', 'slideLayout')?.target).toBe(
      'PPT/slideLayouts/SlideLayout1.xml',
    );
    expect(pkg.xml(pkg.relOfType('ppt/slides/slide1.xml', 'slideLayout')!.target)?.name).toBe('p:sldLayout');
    expect(pkg.rel('ppt/slides/slide1.xml', 'rId2')).toMatchObject({
      external: true,
      target: 'https://example.com',
    });
  });

  it('decodes UTF-16 parts and refuses oversized ones', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'<a x="é"/>'].flatMap((c) => [c.charCodeAt(0), 0])]);
    const pkg = openPackage(
      new Map([
        ['a.xml', utf16],
        ['big.xml', new Uint8Array(8 * 1024 * 1024 + 1)],
      ]),
    );
    expect(pkg.xml('a.xml')?.attrs.x).toBe('é');
    expect(() => pkg.xml('big.xml')).toThrow(/8 MB/);
    expect(pkg.xml('missing.xml')).toBeUndefined();
  });
});
