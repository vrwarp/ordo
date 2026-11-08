import { describe, expect, it } from 'vitest';
import { parseDeck } from './index.ts';
import type { Background } from './ir.ts';
import {
  buildDeck,
  type DeckSpec,
  imageRel,
  pictureBg,
  scheme,
  solid,
  solidBg,
  themeXml,
} from './test-util.ts';

function bgOf(spec: DeckSpec): Background {
  const s = parseDeck(buildDeck(spec)).slides[0]!;
  expect(s.error).toBeUndefined();
  return s.background;
}

const RED = { r: 255, g: 0, b: 0, a: 1 };

describe('readBackground', () => {
  it('looks on the slide, else the layout, else the master', () => {
    const master = { bg: solidBg('0000FF') };
    expect(
      bgOf({ master, layouts: [{ bg: solidBg('00FF00') }], slides: [{ bg: solidBg('FF0000') }] }),
    ).toEqual({
      fill: { kind: 'solid', color: RED },
      from: 'slide',
    });
    expect(bgOf({ master, layouts: [{ bg: solidBg('00FF00') }], slides: [{}] }).from).toBe('layout');
    expect(bgOf({ master, slides: [{}] })).toEqual({
      fill: { kind: 'solid', color: { r: 0, g: 0, b: 255, a: 1 } },
      from: 'master',
    });
  });

  it('resolves bgRef ≥ 1001 into bgFillStyleLst with phClr, through the slide colour map', () => {
    const bg = `<p:bg><p:bgRef idx="1002">${scheme('bg2')}</p:bgRef></p:bg>`;
    // The default theme's second background fill is phClr at lumMod 95 %: lt2 (E7E6E6) darkened.
    const out = bgOf({ slides: [{ bg }] });
    expect(out.from).toBe('slide');
    expect(out.fill.kind).toBe('solid');
    const ovr = bgOf({
      slides: [
        {
          bg: `<p:bg><p:bgRef idx="1001">${scheme('bg1')}</p:bgRef></p:bg>`,
          after:
            '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>',
        },
      ],
    });
    expect(ovr.fill).toEqual({ kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } });
  });

  it('reads bgRef idx="0" as no background, and an explicit noFill as none', () => {
    expect(bgOf({ slides: [{ bg: `<p:bg><p:bgRef idx="0">${scheme('bg1')}</p:bgRef></p:bg>` }] })).toEqual({
      fill: { kind: 'none' },
      from: 'slide',
    });
    expect(bgOf({ slides: [{ bg: '<p:bg><p:bgPr><a:noFill/><a:effectLst/></p:bgPr></p:bg>' }] })).toEqual({
      fill: { kind: 'none' },
      from: 'slide',
    });
    expect(bgOf({ master: { bg: '' }, slides: [{}] })).toEqual({ fill: { kind: 'none' }, from: 'none' });
  });

  it('resolves picture backgrounds through the relationships of the part that holds them', () => {
    const out = bgOf({
      layouts: [{ bg: pictureBg('rId7'), rels: [imageRel('rId7', 'layout-bg.png')] }],
      slides: [{}],
    });
    expect(out).toMatchObject({
      from: 'layout',
      fill: { kind: 'picture', picture: { part: 'ppt/media/layout-bg.png' } },
    });
  });

  it('resolves a theme picture fill through the theme part', () => {
    const fmt =
      '<a:fmtScheme name="T"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst/><a:effectStyleLst/>' +
      '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></a:bgFillStyleLst></a:fmtScheme>';
    const parts = buildDeck({
      theme: themeXml({ fmtScheme: fmt }).replace(
        '<a:theme ',
        '<a:theme xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
      ),
      slides: [{ bg: `<p:bg><p:bgRef idx="1002">${scheme('bg1')}</p:bgRef></p:bg>` }],
    });
    const enc = new TextEncoder();
    parts.set(
      'ppt/theme/_rels/theme1.xml.rels',
      enc.encode(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/theme-bg.jpeg"/></Relationships>',
      ),
    );
    parts.set('ppt/media/theme-bg.jpeg', new Uint8Array(0));
    const s = parseDeck(parts).slides[0]!;
    expect(s.background).toMatchObject({
      from: 'slide',
      fill: { kind: 'picture', picture: { part: 'ppt/media/theme-bg.jpeg' } },
    });
  });

  it('recolours a theme picture fill in its reference colour (a tiled texture duotoned in phClr)', () => {
    // As PowerPoint's own themes write it: bgRef 1003 in bg1 (white), the texture duotoned between phClr
    // shaded and tinted, so the slide shows a white paper texture, not the black and white source.
    const duotone =
      '<a:duotone><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr><a:schemeClr val="phClr"><a:tint val="88000"/></a:schemeClr></a:duotone>';
    const fmt =
      '<a:fmtScheme name="T"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst/><a:effectStyleLst/>' +
      '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
      `<a:blipFill><a:blip r:embed="rId1">${duotone}</a:blip><a:tile tx="0" ty="0" sx="65000" sy="65000" flip="none" algn="tl"/></a:blipFill></a:bgFillStyleLst></a:fmtScheme>`;
    const parts = buildDeck({
      theme: themeXml({ fmtScheme: fmt }).replace(
        '<a:theme ',
        '<a:theme xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
      ),
      slides: [{ bg: `<p:bg><p:bgRef idx="1003">${scheme('bg1')}</p:bgRef></p:bg>` }],
    });
    const enc = new TextEncoder();
    parts.set(
      'ppt/theme/_rels/theme1.xml.rels',
      enc.encode(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/texture.jpeg"/></Relationships>',
      ),
    );
    parts.set('ppt/media/texture.jpeg', new Uint8Array(0));
    const fill = parseDeck(parts).slides[0]!.background.fill;
    expect(fill.kind).toBe('picture');
    const recolor = fill.kind === 'picture' ? fill.picture.recolor : undefined;
    expect(recolor).toHaveLength(1);
    const d = recolor![0]!;
    expect(d.kind).toBe('duotone');
    if (d.kind !== 'duotone') return;
    // White shaded to 90 % and white tinted: both light, never the slide context's missing phClr.
    expect(d.dark.r).toBeGreaterThan(200);
    expect(d.dark.r).toBeLessThan(255);
    expect(d.light).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('keeps a slide colour override for an inherited solid background colour', () => {
    const out = bgOf({
      master: { bg: `<p:bg><p:bgPr>${solid(scheme('tx2'))}</p:bgPr></p:bg>` },
      theme: themeXml({ colors: { dk2: 'FF0000' } }),
      slides: [{}],
    });
    expect(out.fill).toEqual({ kind: 'solid', color: RED });
  });
});
