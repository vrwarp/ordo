import { describe, expect, it } from 'vitest';
import { type SlideCtx, slideContext } from './context.ts';
import { readDeck } from './deck.ts';
import { frameOf } from './frame.ts';
import { parseDeck } from './index.ts';
import type { ShapeElement } from './ir.ts';
import {
  bodyPrChain,
  chainOf,
  firstAttr,
  firstOfAny,
  geometryOf,
  inheritedXfrm,
  isFooter,
  isTitle,
  layoutPlaceholder,
  masterClass,
  masterPlaceholder,
  paraChain,
  paraChainParts,
  placeholderOf,
  presetName,
  spPrChain,
} from './inherit.ts';
import { openPackage } from './opc.ts';
import { body, buildDeck, type DeckSpec, grpSp, para, run, sp } from './test-util.ts';
import { child, path, type XNode } from './xml.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

function ctxOf(spec: DeckSpec, i = 0): SlideCtx {
  const pkg = openPackage(buildDeck(spec));
  const deck = readDeck(pkg);
  return slideContext(pkg, deck, frameOf(deck.size.cx, deck.size.cy), deck.slides[i]!, () => {});
}

/** The slide's own shape-tree elements, in order. */
function own(ctx: SlideCtx): XNode[] {
  return (path(ctx.slide, 'p:cSld', 'p:spTree')?.children ?? []).filter((c) => c.name === 'p:sp');
}

const name = (n: XNode | undefined) => child(child(n, 'p:nvSpPr'), 'p:cNvPr')?.attrs.name;

describe('placeholder matching', () => {
  const layout = {
    shapes:
      sp({ id: 2, name: 'L title', ph: 'type="title"', x: 1, y: 1, cx: 1, cy: 1 }) +
      sp({ id: 3, name: 'L body 1', ph: 'type="body" idx="1"', x: 2, y: 2, cx: 2, cy: 2 }) +
      grpSp(
        { id: 4, x: 0, y: 0, cx: 10, cy: 10 },
        sp({ id: 5, name: 'L pic 13', ph: 'type="pic" idx="13"' }),
      ) +
      sp({ id: 6, name: 'L body 2', ph: 'type="body" idx="2"' }),
  };
  const master = {
    shapes:
      sp({ id: 2, name: 'M title', ph: 'type="title"' }) +
      sp({ id: 3, name: 'M body', ph: 'type="body" idx="1"' }) +
      sp({ id: 4, name: 'M date', ph: 'type="dt" idx="10"' }),
  };

  it('reads p:ph with OOXML defaults (type obj when only idx is set)', () => {
    const ctx = ctxOf({
      layouts: [layout],
      master,
      slides: [
        { shapes: sp({ id: 2, ph: 'idx="1"' }) + sp({ id: 3, ph: 'type="ctrTitle"' }) + sp({ id: 4 }) },
      ],
    });
    const [a, b, c] = own(ctx);
    expect(placeholderOf(a!)).toEqual({ type: 'obj', idx: '1' });
    expect(placeholderOf(b!)).toEqual({ type: 'ctrTitle' });
    expect(placeholderOf(c!)).toBeUndefined();
  });

  it('finds the layout placeholder by idx, else by type, including placeholders inside groups', () => {
    const ctx = ctxOf({ layouts: [layout], master, slides: [{}] });
    expect(name(layoutPlaceholder(ctx.layout, { type: 'obj', idx: '2' }))).toBe('L body 2');
    expect(name(layoutPlaceholder(ctx.layout, { type: 'title' }))).toBe('L title');
    expect(name(layoutPlaceholder(ctx.layout, { type: 'title', idx: '99' }))).toBe('L title');
    expect(name(layoutPlaceholder(ctx.layout, { type: 'pic', idx: '13' }))).toBe('L pic 13');
    expect(layoutPlaceholder(ctx.layout, { type: 'ftr', idx: '11' })).toBeUndefined();
  });

  it('finds the master placeholder by type class', () => {
    const ctx = ctxOf({ layouts: [layout], master, slides: [{}] });
    expect(masterClass('ctrTitle')).toBe('title');
    expect(masterClass('subTitle')).toBe('body');
    expect(masterClass('obj')).toBe('body');
    expect(masterClass('sldNum')).toBe('sldNum');
    expect(name(masterPlaceholder(ctx.master, { type: 'ctrTitle' }))).toBe('M title');
    expect(name(masterPlaceholder(ctx.master, { type: 'subTitle', idx: '1' }))).toBe('M body');
    expect(name(masterPlaceholder(ctx.master, { type: 'pic', idx: '13' }))).toBe('M body');
    expect(name(masterPlaceholder(ctx.master, { type: 'dt' }))).toBe('M date');
    expect(masterPlaceholder(ctx.master, { type: 'ftr' })).toBeUndefined();
    expect(isTitle({ type: 'ctrTitle' })).toBe(true);
    expect(isTitle(undefined)).toBe(false);
    expect(isFooter({ type: 'sldNum' })).toBe(true);
    expect(isFooter({ type: 'body' })).toBe(false);
  });

  it('chains a slide placeholder to its layout and master placeholders, a layout one to the master only', () => {
    const ctx = ctxOf({ layouts: [layout], master, slides: [{ shapes: sp({ id: 2, ph: 'idx="1"' }) }] });
    const c = chainOf(ctx, own(ctx)[0]!, 'slide');
    expect(name(c.layout)).toBe('L body 1');
    expect(name(c.master)).toBe('M body');
    const lc = chainOf(
      ctx,
      path(ctx.layout, 'p:cSld', 'p:spTree')!.children.find((n) => n.name === 'p:sp')!,
      'layout',
    );
    expect(lc.layout).toBeUndefined();
    expect(name(lc.master)).toBe('M title');
    const mc = chainOf(
      ctx,
      path(ctx.master, 'p:cSld', 'p:spTree')!.children.find((n) => n.name === 'p:sp')!,
      'master',
    );
    expect(mc).toEqual({ own: mc.own, from: 'master', ph: { type: 'title' } });
  });
});

describe('xfrm, bodyPr and shape-property chains', () => {
  it('takes xfrm from own, else the layout, else the master', () => {
    const ctx = ctxOf({
      layouts: [{ shapes: sp({ id: 2, ph: 'type="body" idx="1"', x: 20, y: 20, cx: 20, cy: 20 }) }],
      master: {
        shapes:
          sp({ id: 2, ph: 'type="title"', x: 30, y: 30, cx: 30, cy: 30 }) +
          sp({ id: 3, ph: 'type="body" idx="1"', x: 40, y: 40, cx: 40, cy: 40 }),
      },
      slides: [
        {
          shapes:
            sp({ id: 2, ph: 'idx="1"', x: 10, y: 10, cx: 10, cy: 10 }) +
            sp({ id: 3, ph: 'idx="1"' }) +
            sp({ id: 4, ph: 'type="title"' }) +
            sp({ id: 5, ph: 'type="ftr" idx="11"' }),
        },
      ],
    });
    const off = (n: XNode | undefined) => child(n, 'a:off')?.attrs.x;
    const [a, b, c, d] = own(ctx).map((n) => inheritedXfrm(chainOf(ctx, n, 'slide')));
    expect([off(a), off(b), off(c), d]).toEqual(['10', '20', '30', undefined]);
  });

  it('lists bodyPr and spPr nearest first', () => {
    const ctx = ctxOf({
      layouts: [
        {
          shapes: sp({
            id: 2,
            ph: 'type="body" idx="1"',
            fill: '<a:noFill/>',
            txBody: body(para(''), 'anchor="ctr" lIns="0"'),
          }),
        },
      ],
      master: {
        shapes: sp({
          id: 2,
          ph: 'type="body" idx="1"',
          txBody: body(para(''), 'anchor="b" tIns="1" lIns="5"'),
        }),
      },
      slides: [{ shapes: sp({ id: 2, ph: 'idx="1"', txBody: body(para(run('x')), 'tIns="7"') }) }],
    });
    const c = chainOf(ctx, own(ctx)[0]!, 'slide');
    const b = bodyPrChain(c);
    expect(b).toHaveLength(3);
    expect([
      firstAttr(b, 'tIns'),
      firstAttr(b, 'lIns'),
      firstAttr(b, 'anchor'),
      firstAttr(b, 'bIns'),
    ]).toEqual(['7', '0', 'ctr', undefined]);
    expect(spPrChain(c)).toHaveLength(3);
    expect(firstOfAny(spPrChain(c), ['a:solidFill', 'a:noFill'])?.name).toBe('a:noFill');
  });

  it('reads the nearest geometry with its guide values', () => {
    const ctx = ctxOf({
      layouts: [{ shapes: sp({ id: 2, ph: 'type="pic" idx="1"', geom: 'ellipse' }) }],
      slides: [
        {
          shapes:
            sp({ id: 2, ph: 'type="pic" idx="1"' }) +
            sp({ id: 3, geom: 'roundRect' }).replace(
              '<a:avLst/>',
              '<a:avLst><a:gd name="adj" fmla="val 25000"/><a:gd name="x" fmla="*/ 1 2 3"/></a:avLst>',
            ) +
            sp({ id: 4, geom: 'none' }),
        },
      ],
    });
    const [a, b, c] = own(ctx).map((n) => geometryOf(chainOf(ctx, n, 'slide')));
    expect(a).toEqual({ geom: 'ellipse' });
    expect(b).toEqual({ geom: 'roundRect', adj: [['adj', 25_000]] });
    expect(c).toEqual({ geom: 'rect' });
  });
});

describe('paragraph-property chain', () => {
  const styles =
    '<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>' +
    '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr><a:lvl2pPr><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle>' +
    '<p:otherStyle><a:defPPr><a:defRPr sz="1000"/></a:defPPr></p:otherStyle>';
  const spec = (shapes: string): DeckSpec => ({
    master: {
      txStyles: styles,
      shapes: sp({
        id: 2,
        ph: 'type="body" idx="1"',
        txBody: body(para(''), '', '<a:lvl1pPr><a:defRPr sz="3000"/></a:lvl1pPr>'),
      }),
    },
    defaultTextStyle:
      '<a:defPPr><a:defRPr sz="1800"/></a:defPPr><a:lvl1pPr><a:defRPr sz="1900"/></a:lvl1pPr>',
    slides: [{ shapes }],
  });
  const sizes = (ctx: SlideCtx, n: XNode, level = 0) =>
    paraChain(ctx, chainOf(ctx, n, 'slide'), level).map((p) => child(p, 'a:defRPr')?.attrs.sz);

  it('runs own lstStyle → layout → master placeholder → txStyles → defaultTextStyle for placeholders', () => {
    const ctx = ctxOf(
      spec(
        sp({
          id: 2,
          ph: 'idx="1"',
          txBody: body(para(run('x')), '', '<a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr>'),
        }),
      ),
    );
    expect(sizes(ctx, own(ctx)[0]!)).toEqual(['2000', '3000', '2800', '1900', '1800']);
    expect(sizes(ctx, own(ctx)[0]!, 1)).toEqual(['2400', '1800']);
  });

  it('uses defaultTextStyle, never otherStyle, for text that is not in a placeholder', () => {
    const ctx = ctxOf(spec(sp({ id: 2, txBody: body(para(run('x'))) })));
    expect(sizes(ctx, own(ctx)[0]!)).toEqual(['1900', '1800']);
  });

  it('uses titleStyle for titles and otherStyle for footers, and splits local styles from the rest', () => {
    const ctx = ctxOf(
      spec(sp({ id: 2, ph: 'type="ctrTitle"' }) + sp({ id: 3, ph: 'type="sldNum" idx="12"' })),
    );
    const [title, num] = own(ctx);
    expect(sizes(ctx, title!)).toEqual(['4400', '1900', '1800']);
    expect(sizes(ctx, num!)).toEqual(['1000', '1900', '1800']);
    const parts = paraChainParts(ctx, chainOf(ctx, title!, 'slide'), 0);
    expect(parts.local).toEqual([]);
    expect(parts.styles).toHaveLength(3);
  });
});

describe('bounded work on shared nodes', () => {
  /** A slide body placeholder inheriting everything from the layout's placeholder `idx="1"`. */
  const slidePh = (i: number) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${10 + i}" name=""/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
    '<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>';
  const layoutPh = (spPr: string) =>
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name=""/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>${spPr}</p:spPr></p:sp>`;
  const inheriting = (spPr: string) =>
    parseDeck(
      buildDeck({
        layouts: [{ shapes: layoutPh(spPr) }],
        slides: [{ shapes: Array.from({ length: 1_000 }, (_, i) => slidePh(i)).join('') }],
      }),
    ).slides[0]!;

  it('looks up a bullet in a 150,000-child defaultTextStyle level through its index, once per paragraph', () => {
    const dts = `<a:lvl1pPr>${'<a:x/>'.repeat(150_000)}<a:buChar char="»"/></a:lvl1pPr>`;
    const txt = body(Array.from({ length: 2_000 }, () => para(run('x'))).join(''));
    const t0 = performance.now();
    const shape = sp({ id: 2, x: 0, y: 0, cx: 914_400, cy: 914_400, txBody: txt });
    const s = parseDeck(buildDeck({ defaultTextStyle: dts, slides: [{ shapes: shape }] })).slides[0]!;
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    const text = (s.elements[0] as ShapeElement).text!;
    expect(text.paras).toHaveLength(2_000);
    expect(text.paras[1_999]!.bullet).toMatchObject({ kind: 'char', char: '»' });
  });

  it('reads an inherited 150,000-command custom geometry once, not once per inheriting shape', () => {
    const path = `<a:custGeom><a:pathLst><a:path w="10" h="10">${'<a:close/>'.repeat(150_000)}</a:path></a:pathLst></a:custGeom>`;
    const t0 = performance.now();
    const s = inheriting(path);
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    expect(s.elements).toHaveLength(1_000);
    expect(s.elements[999]).toMatchObject({ kind: 'shape', geom: 'custom' });
    expect((s.elements[999] as ShapeElement).coverage).toBeUndefined(); // over the bound: not rated
  });

  it('stops reading an inherited 150,000-child avLst after the guides it keeps', () => {
    const geom = `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 5000"/>${'<a:x/>'.repeat(150_000)}</a:avLst></a:prstGeom>`;
    const t0 = performance.now();
    const s = inheriting(geom);
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    expect(s.elements[999]).toMatchObject({ geom: 'roundRect', adj: [['adj', 5_000]] });
  });
});

describe('preset names', () => {
  it('keeps letters and digits only, so a deck cannot put control characters in notes and reasons', () => {
    expect(presetName('star5')).toBe('star5');
    expect(presetName(undefined)).toBe('rect');
    expect(presetName('star5\n12:00:00 [error] forged\r\u001b[31m')).toBe('other');
    expect(presetName('x'.repeat(41))).toBe('other');
  });
});
