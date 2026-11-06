import { describe, expect, it } from 'vitest';
import { apply, decompose, multiply, xfrmAffine } from './frame.ts';
import { parseDeck } from './index.ts';
import type { Affine, Element, ShapeElement, SlideScene } from './ir.ts';
import {
  body,
  buildDeck,
  type DeckSpec,
  grpSp,
  imageRel,
  para,
  pic,
  run,
  scheme,
  solid,
  solidBg,
  sp,
  themeXml,
} from './test-util.ts';
import { alternateBranch, boxAffine, MAX_SHAPES_PER_SLIDE, pathCoverage } from './walk.ts';
import { parseXml, rootOf } from './xml.ts';

const IN = 914_400;
const SLIDE = { cx: 12_192_000, cy: 6_858_000 };

function slideOf(spec: DeckSpec, i = 0): SlideScene {
  const s = parseDeck(buildDeck(spec)).slides[i]!;
  expect(s.error).toBeUndefined();
  return s;
}

/** An element's box in slide EMU: [x, y, cx, cy], rotation, flips. */
function placed(e: Element) {
  const p = decompose(e.xf);
  return {
    x: Math.round(p.cx - p.w / 2),
    y: Math.round(p.cy - p.h / 2),
    cx: Math.round(p.w),
    cy: Math.round(p.h),
    rot: Math.round(p.rot * 1000) / 1000,
  };
}

const rect = (id: number, x: number, color: string, extra: Partial<Parameters<typeof sp>[0]> = {}) =>
  sp({ id, name: `R${id}`, x, y: 0, cx: IN, cy: IN, fill: solid(color), ...extra });

describe('walk order and decorations', () => {
  const deco = (from: string) => ({ shapes: rect(9, 0, from === 'master' ? '00FF00' : '0000FF') });

  it('draws master decorations, then layout decorations, then the slide, bottom first', () => {
    const s = slideOf({
      master: deco('master'),
      layouts: [deco('layout')],
      slides: [{ shapes: rect(2, IN, 'FF0000') }],
    });
    expect(s.elements.map((e) => e.from)).toEqual(['master', 'layout', 'slide']);
  });

  it('hides the master decorations when the layout says showMasterSp="0", and both when the slide does', () => {
    const layoutOff = slideOf({
      master: deco('master'),
      layouts: [{ ...deco('layout'), attrs: 'showMasterSp="0"' }],
      slides: [{ shapes: rect(2, IN, 'FF0000') }],
    });
    expect(layoutOff.elements.map((e) => e.from)).toEqual(['layout', 'slide']);
    const slideOff = slideOf({
      master: deco('master'),
      layouts: [deco('layout')],
      slides: [{ attrs: 'showMasterSp="0"', shapes: rect(2, IN, 'FF0000') }],
    });
    expect(slideOff.elements.map((e) => e.from)).toEqual(['slide']);
  });

  it('never draws layout or master placeholders', () => {
    const ph = sp({
      id: 3,
      ph: 'type="title"',
      x: 0,
      y: 0,
      cx: IN,
      cy: IN,
      fill: solid('FF0000'),
      txBody: body(para(run('Click to add title'))),
    });
    const s = slideOf({ master: { shapes: ph }, layouts: [{ shapes: ph }], slides: [{}] });
    expect(s.elements).toEqual([]);
  });

  it('keeps hidden shapes flagged', () => {
    const s = slideOf({
      slides: [{ shapes: rect(2, 0, 'FF0000').replace('name="R2"', 'name="R2" hidden="1"') }],
    });
    expect(s.elements[0]!.hidden).toBe(true);
  });
});

describe('placeholders', () => {
  const master = {
    shapes:
      sp({ id: 2, ph: 'type="title"', x: IN, y: IN, cx: 8 * IN, cy: IN }) +
      sp({
        id: 3,
        ph: 'type="body" idx="1"',
        x: IN,
        y: 2 * IN,
        cx: 8 * IN,
        cy: 4 * IN,
        fill: solid('336699'),
      }),
  };

  it('takes the position from the layout or the master, and the whole slide when none has one', () => {
    const s = slideOf({
      master,
      layouts: [
        { shapes: sp({ id: 2, ph: 'type="body" idx="1"', x: 2 * IN, y: 3 * IN, cx: 4 * IN, cy: IN }) },
      ],
      slides: [
        {
          shapes:
            sp({ id: 2, ph: 'type="title"', txBody: body(para(run('T'))) }) +
            sp({ id: 3, ph: 'idx="1"', txBody: body(para(run('B'))) }) +
            sp({ id: 4, ph: 'type="subTitle" idx="7"', txBody: body(para(run('S'))) }).replace(
              'type="subTitle" idx="7"',
              'type="tbl" idx="7"',
            ) +
            sp({ id: 5, ph: 'type="ftr" idx="11"', txBody: body(para(run('F'))) }) +
            sp({ id: 6, ph: 'type="sldNum" idx="12"', txBody: body(para(run('3'))) }),
        },
      ],
    });
    expect(s.elements.map((e) => e.shapeId)).toEqual([2, 3, 4]);
    expect(placed(s.elements[0]!)).toMatchObject({ x: IN, y: IN, cx: 8 * IN, cy: IN });
    expect(placed(s.elements[1]!)).toMatchObject({ x: 2 * IN, y: 3 * IN, cx: 4 * IN, cy: IN });
    // tbl has no layout placeholder and its master class (body) has a position: the master's.
    expect(placed(s.elements[2]!)).toMatchObject({ x: IN, y: 2 * IN });
  });

  it('gives a placeholder nothing positions the whole slide', () => {
    const s = slideOf({
      slides: [{ shapes: sp({ id: 2, ph: 'type="body" idx="3"', txBody: body(para(run('x'))) }) }],
    });
    expect(placed(s.elements[0]!)).toMatchObject({ x: 0, y: 0, cx: SLIDE.cx, cy: SLIDE.cy });
  });

  it('does not draw an empty slide placeholder (prompt text only), even with an inherited fill', () => {
    const s = slideOf({
      master,
      slides: [
        {
          shapes:
            sp({ id: 3, ph: 'idx="1"', txBody: body(para('', '', 'lang="en-US"')) }) +
            sp({ id: 4, ph: 'idx="1"' }),
        },
      ],
    });
    expect(s.elements).toEqual([]);
  });

  it('inherits geometry, fill and line from the layout and master placeholders', () => {
    const s = slideOf({
      master,
      layouts: [
        {
          shapes: sp({
            id: 3,
            ph: 'type="body" idx="1"',
            geom: 'ellipse',
            ln: `<a:ln w="38100">${solid('FF0000')}</a:ln>`,
          }),
        },
      ],
      slides: [{ shapes: sp({ id: 3, ph: 'idx="1"', txBody: body(para(run('x'))) }) }],
    });
    const e = s.elements[0] as ShapeElement;
    expect(e.geom).toBe('ellipse');
    expect(e.fill).toEqual({ kind: 'solid', color: { r: 0x33, g: 0x66, b: 0x99, a: 1 } });
    expect(e.line).toMatchObject({
      width: 38_100,
      fill: { kind: 'solid', color: { r: 255, g: 0, b: 0, a: 1 } },
    });
  });
});

describe('shapes', () => {
  it('reads style references: fillRef, lnRef and effectRef through the theme with phClr', () => {
    const fmt =
      '<a:fmtScheme name="T"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
      '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="dash"/></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
      '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>' +
      '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>';
    const style = `<p:style><a:lnRef idx="2">${scheme('accent1', '<a:lumMod val="50000"/>')}</a:lnRef><a:fillRef idx="1">${scheme('accent1')}</a:fillRef><a:effectRef idx="3">${scheme('accent1')}</a:effectRef><a:fontRef idx="minor">${scheme('lt1')}</a:fontRef></p:style>`;
    const s = slideOf({
      theme: themeXml({ fmtScheme: fmt }),
      slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, style }) }],
    });
    const e = s.elements[0] as ShapeElement;
    expect(e.fill).toEqual({ kind: 'solid', color: { r: 0x44, g: 0x72, b: 0xc4, a: 1 } });
    expect(e.line?.width).toBe(25_400);
    expect(e.line?.fill.kind).toBe('solid');
    expect(e.shadow).toMatchObject({
      dist: 19_050,
      blur: 57_150,
      dir: 90,
      color: { r: 0, g: 0, b: 0, a: 0.63 },
    });
  });

  it('lets an own effectLst (even empty) and own noFill override the style', () => {
    const style = `<p:style><a:lnRef idx="1">${scheme('accent1')}</a:lnRef><a:fillRef idx="1">${scheme('accent1')}</a:fillRef><a:effectRef idx="0">${scheme('accent1')}</a:effectRef><a:fontRef idx="minor"/></p:style>`;
    const s = slideOf({
      slides: [
        {
          shapes: sp({
            id: 2,
            x: 0,
            y: 0,
            cx: IN,
            cy: IN,
            style,
            fill: '<a:noFill/>',
            ln: '<a:ln><a:noFill/></a:ln>',
          }),
        },
      ],
    });
    const e = s.elements[0] as ShapeElement;
    expect(e.fill).toEqual({ kind: 'none' });
    expect(e.line).toBeUndefined();
  });

  it('marks presets M1 does not draw, custom geometry and connectors', () => {
    const s = slideOf({
      slides: [
        {
          shapes:
            rect(2, 0, 'FF0000', { geom: 'star5' }) +
            rect(3, 0, 'FF0000', { geom: 'roundRect' }) +
            sp({ id: 4, x: 0, y: 0, cx: IN, cy: IN, geom: 'none', fill: solid('FF0000') }).replace(
              '<p:spPr>',
              '<p:spPr><a:custGeom><a:pathLst/></a:custGeom>',
            ) +
            '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="5" name="C"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="0"/></a:xfrm><a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></p:spPr></p:cxnSp>',
        },
      ],
    });
    const [star, round, cust, cxn] = s.elements as ShapeElement[];
    expect([star!.support, star!.reasons]).toEqual(['approx', ['preset:star5']]);
    expect([round!.support, round!.reasons]).toEqual(['native', undefined]);
    expect(cust).toMatchObject({ geom: 'custom', support: 'approx', reasons: ['custGeom'] });
    expect(cxn).toMatchObject({ geom: 'straightConnector1', line: { width: 12_700, tail: 'triangle' } });
  });

  it('fills a useBgFill shape with a solid slide background', () => {
    const s = slideOf({
      slides: [
        { bg: solidBg('123456'), shapes: rect(2, 0, 'FF0000').replace('<p:sp>', '<p:sp useBgFill="1">') },
      ],
    });
    expect((s.elements[0] as ShapeElement).fill).toEqual({
      kind: 'solid',
      color: { r: 0x12, g: 0x34, b: 0x56, a: 1 },
    });
  });

  it('reads graphic frames as residual elements', () => {
    const frame = (uri: string) =>
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="G"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="${uri}"/></a:graphic></p:graphicFrame>`;
    const s = slideOf({
      slides: [
        {
          shapes:
            frame('http://schemas.openxmlformats.org/drawingml/2006/chart') +
            frame('http://schemas.openxmlformats.org/drawingml/2006/table'),
        },
      ],
    });
    expect(s.elements.map((e) => [e.kind, e.kind === 'residual' && e.what])).toEqual([
      ['residual', 'chart'],
      ['residual', 'table'],
    ]);
    expect(placed(s.elements[0]!)).toMatchObject({ cx: IN, cy: IN });
  });
});

describe('groups', () => {
  it('maps children through offset and scale', () => {
    // Child space 0..2in shown in a 1in box at (1in, 1in): everything at half size.
    const s = slideOf({
      slides: [
        {
          shapes: grpSp(
            { id: 10, x: IN, y: IN, cx: IN, cy: IN, chX: 0, chY: 0, chCx: 2 * IN, chCy: 2 * IN },
            rect(2, IN, 'FF0000'),
          ),
        },
      ],
    });
    expect(placed(s.elements[0]!)).toEqual({ x: 1.5 * IN, y: IN, cx: 0.5 * IN, cy: 0.5 * IN, rot: 0 });
    expect(s.elements[0]!.group).toBe(1);
  });

  it('composes rotation and flips about the group centre, and numbers each top-level group', () => {
    const rotated = grpSp({ id: 10, x: 0, y: 0, cx: 2 * IN, cy: IN }, rect(2, 0, 'FF0000')).replace(
      '<a:xfrm>',
      '<a:xfrm rot="5400000">',
    );
    const nested = grpSp(
      { id: 11, x: 0, y: 0, cx: IN, cy: IN },
      grpSp({ id: 12, x: 0, y: 0, cx: IN, cy: IN }, rect(3, 0, '00FF00')),
    );
    const s = slideOf({ slides: [{ shapes: rotated + nested + rect(4, 0, '0000FF') }] });
    const [a, b, c] = s.elements;
    // A 2in x 1in group turned a quarter: its left child (0..1in) lands above the centre.
    const [x, y] = apply(a!.xf, 0.5, 0.5);
    expect(Math.round(x)).toBe(IN);
    expect(Math.round(y)).toBe(0);
    expect(placed(a!).rot).toBe(90);
    expect([a!.group, b!.group, c!.group]).toEqual([1, 2, undefined]);
  });

  it('scales the own box of a rotated child in an unevenly scaled group, and marks it residual', () => {
    // A child rotated 45° inside a group scaled 2:1 would be sheared by the composed affine; PowerPoint and
    // LibreOffice scale its box (2 in x 1 in) and rotate that.
    const s = slideOf({
      slides: [
        {
          shapes: grpSp(
            { id: 10, x: 0, y: 0, cx: 2 * IN, cy: IN, chX: 0, chY: 0, chCx: IN, chCy: IN },
            rect(2, 0, 'FF0000', { rot: 45 }) + rect(3, 0, '00FF00', { rot: 90 }),
          ),
        },
      ],
    });
    const [a, b] = s.elements;
    expect(a).toMatchObject({ kind: 'shape', support: 'residual', reasons: ['shear'] });
    expect(placed(a!)).toEqual({ x: 0, y: 0, cx: 2 * IN, cy: IN, rot: 45 });
    expect(decompose(a!.xf).sheared).toBe(false);
    // A quarter turn is not sheared either way; its own box is still scaled along the group's axes.
    expect(b).toMatchObject({ kind: 'shape', support: 'native' });
    expect(placed(b!)).toMatchObject({ cx: 2 * IN, cy: IN, rot: 90 });
  });

  it('places a box like the composed affine when the scale is even or the box is not rotated', () => {
    const x = { x: 100, y: 200, cx: 300, cy: 400, rot: 30, flipH: true, flipV: false };
    const even: Affine = [2, 0, 0, 2, 10, 20];
    const turned: Affine = [0, 3, -3, 0, 5, 5];
    for (const m of [even, turned]) {
      const a = boxAffine(m, x);
      const b = multiply(m, xfrmAffine(x));
      for (let i = 0; i < 6; i++) expect(a[i]).toBeCloseTo(b[i]!, 6);
    }
    const uneven: Affine = [2, 0, 0, 1, 0, 0];
    const flat = { ...x, rot: 0 };
    const a = boxAffine(uneven, flat);
    const b = multiply(uneven, xfrmAffine(flat));
    for (let i = 0; i < 6; i++) expect(a[i]).toBeCloseTo(b[i]!, 6);
  });

  it('fills grpFill children with the group fill', () => {
    const g = grpSp(
      { id: 10, x: 0, y: 0, cx: IN, cy: IN },
      sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, fill: '<a:grpFill/>' }),
    ).replace('</a:xfrm></p:grpSpPr>', `</a:xfrm>${solid('FF00FF')}</p:grpSpPr>`);
    const s = slideOf({ slides: [{ shapes: g }] });
    expect((s.elements[0] as ShapeElement).fill).toEqual({
      kind: 'solid',
      color: { r: 255, g: 0, b: 255, a: 1 },
    });
  });

  it('stops at 32 nested groups and 5,000 shapes, with a note', () => {
    let deep = rect(2, 0, 'FF0000');
    for (let i = 0; i < 40; i++) deep = grpSp({ id: 100 + i, x: 0, y: 0, cx: IN, cy: IN }, deep);
    const s = slideOf({ slides: [{ shapes: deep }] });
    expect(s.elements).toEqual([]);
    expect(s.notes.join(' ')).toMatch(/nested deeper than 32/);

    const t0 = performance.now();
    const many = slideOf({ slides: [{ shapes: rect(2, 0, 'FF0000').repeat(MAX_SHAPES_PER_SLIDE + 1) }] });
    expect(many.elements).toHaveLength(MAX_SHAPES_PER_SLIDE);
    expect(many.notes.join(' ')).toMatch(/more than 5000 shapes/);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

describe('alternate content', () => {
  const ac = (requires: string) =>
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="${requires}">${rect(2, 0, 'FF0000')}</mc:Choice><mc:Fallback>${rect(3, 0, '00FF00')}</mc:Fallback></mc:AlternateContent>`;

  it('reads the first understood Choice, else the Fallback, never both', () => {
    expect(slideOf({ slides: [{ shapes: ac('p14') }] }).elements.map((e) => e.shapeId)).toEqual([2]);
    expect(slideOf({ slides: [{ shapes: ac('a14') }] }).elements.map((e) => e.shapeId)).toEqual([3]);
    expect(slideOf({ slides: [{ shapes: ac('p14 aink') }] }).elements.map((e) => e.shapeId)).toEqual([3]);
  });

  it('picks the branch without reading it', () => {
    const root = rootOf(
      parseXml(
        '<mc:AlternateContent><mc:Choice Requires="cx1"/><mc:Choice Requires="p15"/><mc:Fallback/></mc:AlternateContent>',
        't',
      ),
    )!;
    expect(alternateBranch(root)?.attrs.Requires).toBe('p15');
  });
});

describe('pictures in the walk', () => {
  it('reads p:pic with its outline and a picture placeholder with the layout geometry', () => {
    const s = slideOf({
      layouts: [
        { shapes: sp({ id: 2, ph: 'type="pic" idx="1"', x: 0, y: 0, cx: IN, cy: IN, geom: 'ellipse' }) },
      ],
      slides: [
        {
          rels: [imageRel('rId2', 'a.png')],
          shapes:
            pic({ id: 3, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' }).replace(
              '</a:prstGeom></p:spPr>',
              `</a:prstGeom><a:ln w="12700">${solid('000000')}</a:ln></p:spPr>`,
            ) +
            pic({ id: 4, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' })
              .replace('<p:nvPr/>', '<p:nvPr><p:ph type="pic" idx="1"/></p:nvPr>')
              .replace(/<a:prstGeom prst="rect"><a:avLst\/><\/a:prstGeom>/, ''),
        },
      ],
    });
    expect(s.elements[0]).toMatchObject({ kind: 'picture', geom: 'rect', line: { width: 12_700 } });
    expect(s.elements[1]).toMatchObject({ kind: 'picture', geom: 'ellipse', support: 'native' });
  });
});

describe('custom geometry coverage', () => {
  const geom = (paths: string) =>
    rootOf(parseXml(`<a:custGeom><a:pathLst>${paths}</a:pathLst></a:custGeom>`, 't'));
  const pt = (x: number | string, y: number | string) => `<a:pt x="${x}" y="${y}"/>`;
  const poly = (pts: string[], extra = '') =>
    `<a:path w="100" h="100"${extra}><a:moveTo>${pts[0]}</a:moveTo>${pts
      .slice(1)
      .map((p) => `<a:lnTo>${p}</a:lnTo>`)
      .join('')}<a:close/></a:path>`;

  it('measures the filled share of the box from the path points', () => {
    expect(pathCoverage(geom(poly([pt(0, 0), pt(100, 0), pt(100, 100), pt(0, 100)])))).toBe(1);
    expect(pathCoverage(geom(poly([pt(0, 0), pt(100, 0), pt(0, 100)])))).toBe(0.5);
    expect(pathCoverage(geom(poly([pt(0, 0), pt(100, 0), pt(100, 5), pt(0, 5)])))).toBeCloseTo(0.05);
    // Curves count by their end points; unfilled paths count nothing.
    const curve = `<a:path w="100" h="100"><a:moveTo>${pt(0, 0)}</a:moveTo><a:cubicBezTo>${pt(50, 0)}${pt(100, 50)}${pt(100, 100)}</a:cubicBezTo><a:lnTo>${pt(0, 100)}</a:lnTo><a:close/></a:path>`;
    expect(pathCoverage(geom(curve))).toBe(0.5);
    expect(pathCoverage(geom(poly([pt(0, 0), pt(100, 0), pt(100, 100)], ' fill="none"')))).toBeUndefined();
  });

  it('gives up on guide names, arcs and paths without a size', () => {
    expect(pathCoverage(geom(poly([pt(0, 0), pt('r', 0), pt('r', 'b')])))).toBeUndefined();
    expect(
      pathCoverage(
        geom(
          `<a:path w="100" h="100"><a:moveTo>${pt(0, 0)}</a:moveTo><a:arcTo wR="5" hR="5" stAng="0" swAng="5400000"/></a:path>`,
        ),
      ),
    ).toBeUndefined();
    expect(pathCoverage(geom(`<a:path><a:moveTo>${pt(0, 0)}</a:moveTo></a:path>`))).toBeUndefined();
    expect(pathCoverage(undefined)).toBeUndefined();
  });

  it('records the coverage on custom shapes', () => {
    const s = slideOf({
      slides: [
        {
          shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, geom: 'none', fill: solid('FF0000') }).replace(
            '<p:spPr>',
            `<p:spPr><a:custGeom><a:pathLst>${poly([pt(0, 0), pt(100, 0), pt(0, 100)])}</a:pathLst></a:custGeom>`,
          ),
        },
      ],
    });
    expect(s.elements[0]).toMatchObject({ geom: 'custom', coverage: 0.5 });
  });
});
