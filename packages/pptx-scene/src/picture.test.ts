import { describe, expect, it } from 'vitest';
import { parseDeck } from './index.ts';
import type { PictureElement } from './ir.ts';
import { extensionOf, pictureSize, readInsets } from './picture.ts';
import { buildDeck, imageRel, type PicSpec, pic, pngHeader, type RelSpec } from './test-util.ts';
import { parseXml, rootOf } from './xml.ts';

const IN = 914_400;

function picturesOf(shapes: string, rels: RelSpec[], media: Record<string, Uint8Array> = {}) {
  const s = parseDeck(buildDeck({ slides: [{ shapes, rels }], media })).slides[0]!;
  expect(s.error).toBeUndefined();
  return s;
}

const p = (o: Partial<PicSpec> = {}) => pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2', ...o });

describe('readInsets', () => {
  it('reads fractions of 100,000, keeps negatives, bounds them and drops all-zero rects', () => {
    const n = (attrs: string) => rootOf(parseXml(`<a:srcRect ${attrs}/>`, 't'));
    expect(readInsets(n('l="10000" t="-5000" r="250000"'))).toEqual({ l: 0.1, t: -0.05, r: 1, b: 0 });
    expect(readInsets(n('l="0"'))).toBeUndefined();
    expect(readInsets(undefined)).toBeUndefined();
  });
});

describe('pictureSize', () => {
  it('reads PNG, JPEG, GIF, BMP and WebP headers', () => {
    expect(pictureSize(pngHeader(1920, 1080))).toEqual({ w: 1920, h: 1080, alpha: true });
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3,
    ]);
    expect(pictureSize(jpeg)).toEqual({ w: 640, h: 480, alpha: false });
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0, 0x10, 0]);
    expect(pictureSize(gif)).toEqual({ w: 32, h: 16 }); // too short to tell transparency
    const bmp = new Uint8Array(30);
    bmp.set([0x42, 0x4d]);
    new DataView(bmp.buffer).setInt32(18, 300, true);
    new DataView(bmp.buffer).setInt32(22, -200, true);
    new DataView(bmp.buffer).setUint16(28, 24, true);
    expect(pictureSize(bmp)).toEqual({ w: 300, h: 200, alpha: false });
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
    webp.set([99, 0, 0, 49, 0, 0], 24); // 100 x 50
    expect(pictureSize(webp)).toEqual({ w: 100, h: 50, alpha: false });
  });

  it('tells whether a picture may be transparent, from its header only', () => {
    const alpha = (b: Uint8Array) => pictureSize(b)?.alpha;
    // PNG: an alpha channel; else a tRNS chunk before the image data; unknown when the bytes end first.
    expect(alpha(pngHeader(8, 8))).toBe(true);
    const rgb = pngHeader(8, 8, true);
    expect(alpha(rgb)).toBe(false);
    const chunk = (type: string, len = 0) => [0, 0, 0, len, ...[...type].map((c) => c.charCodeAt(0))];
    const withChunks = (...cs: number[][]) => Uint8Array.from([...rgb.subarray(0, 33), ...cs.flat()]);
    expect(alpha(withChunks([...chunk('gAMA', 4), 0, 0, 0, 0, 0, 0, 0, 0], chunk('tRNS')))).toBe(true);
    expect(alpha(withChunks([...chunk('gAMA', 4), 0, 0, 0, 0, 0, 0, 0, 0], chunk('IDAT')))).toBe(false);
    expect(alpha(rgb.subarray(0, 33))).toBeUndefined();
    // Endless chunks before the image data: bounded, unknown.
    expect(
      alpha(withChunks(...Array.from({ length: 300 }, () => [...chunk('tEXt'), 0, 0, 0, 0]))),
    ).toBeUndefined();
    // GIF: the transparent flag of the first frame's graphic control extension.
    const gif = (gce: number[]) =>
      Uint8Array.from([
        0x47,
        0x49,
        0x46,
        0x38,
        0x39,
        0x61,
        8,
        0,
        8,
        0,
        0x80,
        0,
        0,
        ...new Array(6).fill(0),
        ...gce,
      ]);
    expect(alpha(gif([0x21, 0xf9, 4, 1, 0, 0, 0, 0, 0x2c]))).toBe(true);
    expect(alpha(gif([0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c]))).toBe(false);
    expect(alpha(gif([0x21, 0xfe, 2, 0x41, 0x42, 0, 0x2c]))).toBe(false); // a comment, then the image
    // BMP: 32 bits a pixel may carry alpha. WebP: VP8L's alpha_is_used, VP8X's alpha flag.
    const bmp = new Uint8Array(30);
    bmp.set([0x42, 0x4d]);
    new DataView(bmp.buffer).setInt32(18, 2, true);
    new DataView(bmp.buffer).setInt32(22, 2, true);
    new DataView(bmp.buffer).setUint16(28, 32, true);
    expect(alpha(bmp)).toBe(true);
    const vp8x = new Uint8Array(30);
    vp8x.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
    vp8x[20] = 0x10;
    expect(alpha(vp8x)).toBe(true);
    const vp8l = new Uint8Array(30);
    vp8l.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c]);
    vp8l[20] = 0x2f;
    new DataView(vp8l.buffer).setUint32(21, (1 << 28) | (9 << 14) | 9, true);
    expect(pictureSize(vp8l)).toEqual({ w: 10, h: 10, alpha: true });
  });

  it('returns undefined for empty, truncated or unknown bytes, and stops on a broken JPEG', () => {
    expect(pictureSize(new Uint8Array(0))).toBeUndefined();
    expect(pictureSize(pngHeader(10, 10).slice(0, 20))).toBeUndefined();
    expect(pictureSize(Uint8Array.from([0xff, 0xd8, 0x00, 0x00, 0, 0]))).toBeUndefined();
    const loop = new Uint8Array(100_000).fill(0xff);
    loop[1] = 0xd8;
    expect(pictureSize(loop)).toBeUndefined();
  });
});

describe('p:pic', () => {
  it('resolves the part, crop, fill rect, alpha and pixel size; extLst and an empty a:lum are not effects', () => {
    const s = picturesOf(
      p({
        srcRect: 'l="10000" r="-20000"',
        blip: '<a:alphaModFix amt="40000"/><a:lum/><a:extLst><a:ext uri="{x}"/></a:extLst>',
      }),
      [imageRel('rId2', 'image1.png')],
      { 'ppt/media/image1.png': pngHeader(400, 300) },
    );
    const e = s.elements[0] as PictureElement;
    expect(e).toMatchObject({ kind: 'picture', geom: 'rect', support: 'native' });
    expect(e.picture).toEqual({
      part: 'ppt/media/image1.png',
      crop: { l: 0.1, t: 0, r: -0.2, b: 0 },
      alpha: 0.4,
      px: { w: 400, h: 300, alpha: true },
    });
  });

  it('lists recolouring effects and notes formats a browser cannot draw', () => {
    const s = picturesOf(
      p({ blip: '<a:grayscl/><a:lum bright="20000"/>' }) + p({ id: 3, rId: 'rId3' }),
      [imageRel('rId2', 'image1.png'), imageRel('rId3', 'image2.tiff')],
      { 'ppt/media/image2.tiff': new Uint8Array(0) },
    );
    const [a, b] = s.elements as PictureElement[];
    expect(a!.picture.effects).toEqual(['a:grayscl', 'a:lum']);
    // M6: both are baked into a derived picture, so the picture is native.
    expect(a!.picture.recolor).toEqual([{ kind: 'grayscale' }, { kind: 'lum', bright: 0.2, contrast: 0 }]);
    expect(a!.reasons).toBeUndefined();
    expect(a!.support).toBe('native');
    expect(b).toMatchObject({ support: 'approx', reasons: ['pic:tiff'] });
    expect(b!.picture.px).toBeUndefined(); // spilled: no bytes
  });

  it('reads duotone, clrChange and biLevel with their colours, and keeps other effects approx', () => {
    const duotone =
      '<a:duotone><a:prstClr val="black"/><a:schemeClr val="accent1"><a:tint val="45000"/></a:schemeClr></a:duotone>';
    const change =
      '<a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom><a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange>';
    const s = picturesOf(
      p({ blip: duotone + change + '<a:biLevel thresh="25000"/>' }) +
        p({ id: 3, blip: '<a:duotone><a:prstClr val="black"/></a:duotone><a:blur rad="5000"/>' }),
      [imageRel('rId2', 'image1.png')],
    );
    const [a, b] = s.elements as PictureElement[];
    expect(a!.support).toBe('native');
    const [d, c, bl] = a!.picture.recolor!;
    expect(d).toMatchObject({ kind: 'duotone', dark: { r: 0, g: 0, b: 0, a: 1 } });
    expect(d?.kind === 'duotone' && d.light.r).toBeGreaterThan(150); // accent1 tinted towards white
    expect(c).toEqual({
      kind: 'clrChange',
      from: { r: 255, g: 255, b: 255, a: 1 },
      to: { r: 255, g: 255, b: 255, a: 0 },
    });
    expect(bl).toEqual({ kind: 'biLevel', threshold: 0.25 });
    // A duotone missing its second colour is left out; a blur is not drawn: approx.
    expect(b!.picture.recolor).toBeUndefined();
    expect(b).toMatchObject({ support: 'approx', reasons: ['recolor'] });
  });

  it('reads the resolution a PNG or JPEG header states', () => {
    const png = new Uint8Array(33 + 21 + 12);
    png.set(pngHeader(10, 20, false).subarray(0, 33));
    const dv = new DataView(png.buffer);
    dv.setUint32(33, 9);
    png.set([0x70, 0x48, 0x59, 0x73], 37); // pHYs
    dv.setUint32(41, 5906); // 150 dpi in pixels per metre
    dv.setUint32(45, 5906);
    png[49] = 1;
    dv.setUint32(54, 0);
    png.set([0x49, 0x44, 0x41, 0x54], 58);
    const got = pictureSize(png)!;
    expect(got.dpi?.x).toBeCloseTo(150, 0);
    // JPEG: SOI, APP0 JFIF with 72 dpi, then a frame header.
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 72, 0, 72, 0, 0, 0xff, 0xc0, 0,
      11, 8, 0, 30, 0, 40, 1, 1, 0x11, 0,
    ]);
    expect(pictureSize(jpeg)).toEqual({ w: 40, h: 30, alpha: false, dpi: { x: 72, y: 72 } });
    // Units 0 (only an aspect): no resolution.
    jpeg[13] = 0;
    expect(pictureSize(jpeg)?.dpi).toBeUndefined();
  });

  it('reads a metafile as a residual element with approx support (converted in M3)', () => {
    const s = picturesOf(p(), [imageRel('rId2', 'image1.emf')], {
      'ppt/media/image1.emf': new Uint8Array(4),
    });
    expect(s.elements[0]).toMatchObject({
      kind: 'residual',
      what: 'metafile',
      support: 'approx',
      reasons: ['metafile'],
    });
    expect(s.notes.join(' ')).toMatch(/emf picture is converted by LibreOffice/);
  });

  it('logs a linked picture with its host only and a missing part, and draws neither', () => {
    const s = picturesOf(p() + p({ id: 3, rId: 'rId3' }), [
      { id: 'rId2', type: 'image', target: 'https://example.org/secret/path.png?q=1', external: true },
      { id: 'rId3', type: 'image', target: '../media/gone.png', external: true },
    ]);
    expect(s.elements).toEqual([]);
    expect(s.notes.join(' ')).toMatch(/linked picture \(example\.org\)/);
    expect(s.notes.join(' ')).not.toMatch(/secret/);
    const missing = picturesOf(p(), [imageRel('rId9', 'x.png')]);
    expect(missing.notes.join(' ')).toMatch(/picture part is missing/);
  });

  it('records the media a poster stands for', () => {
    const video = p().replace(
      '<p:nvPr/>',
      '<p:nvPr><a:videoFile r:link="rId3"/><p:extLst><p:ext uri="{x}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId4"/></p:ext></p:extLst></p:nvPr>',
    );
    const s = picturesOf(
      video,
      [
        imageRel('rId2', 'poster.png'),
        { id: 'rId3', type: 'video', target: '../media/media1.mp4' },
        { id: 'rId4', type: 'media', target: '../media/media1.mp4' },
      ],
      { 'ppt/media/media1.mp4': new Uint8Array(0) },
    );
    expect((s.elements[0] as PictureElement).media).toEqual({ kind: 'video', part: 'ppt/media/media1.mp4' });
  });

  it('clips to every preset of the table (M6) and notes a preset it does not know', () => {
    const s = picturesOf(
      p({ geom: 'ellipse' }) + p({ id: 3, geom: 'hexagon' }) + p({ id: 4, geom: 'noSuchShape' }),
      [imageRel('rId2', 'a.png')],
    );
    expect((s.elements[0] as PictureElement).support).toBe('native');
    expect((s.elements[1] as PictureElement).support).toBe('native');
    expect(s.elements[2]).toMatchObject({ support: 'approx', reasons: ['mask:noSuchShape'] });
  });

  it('names extensions in lower case', () => {
    expect(extensionOf('ppt/media/Image1.JPEG')).toBe('jpeg');
    expect(extensionOf('ppt/media.d/image')).toBe('');
  });
});
