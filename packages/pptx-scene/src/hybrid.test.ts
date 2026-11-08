import { describe, expect, it } from 'vitest';
import { elementRefs } from './hybrid.ts';
import { convertDeck } from './index.ts';
import type { Element } from './ir.ts';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  chartFrame,
  chartXml,
  para,
  run,
  solid,
  sp,
  withPart,
} from './test-util.ts';

/** A table frame (residual until M6). */
function tableFrame(o: { id: number; x: number; y: number; cx: number; cy: number }): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${o.id}" name="Table ${o.id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${o.x}" y="${o.y}"/><a:ext cx="${o.cx}" cy="${o.cy}"/></p:xfrm>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl/></a:graphicData></a:graphic></p:graphicFrame>'
  );
}

const EMU = 914_400 / 2; // half an inch

/**
 * Bottom to top: a title (below the art range), a chart (Rmin), a captioned rect overlapping the table above
 * it (baked into the art), a rect clear of everything above it (native, just above the art), the table
 * (Rmax), a footer text (above the range).
 */
function deck() {
  const parts = buildDeck({
    slides: [
      {
        rels: [{ id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }],
        shapes:
          sp({ id: 2, x: EMU, y: 0, cx: 10 * EMU, cy: EMU, txBody: body(para(run('Giving'))) }) +
          chartFrame({ id: 4, x: 2 * EMU, y: 2 * EMU, cx: 8 * EMU, cy: 6 * EMU, rId: 'rId3' }) +
          sp({
            id: 5,
            x: 11 * EMU,
            y: 9 * EMU,
            cx: 4 * EMU,
            cy: 2 * EMU,
            fill: solid('FF0000'),
            txBody: body(para(run('Total'))),
          }) +
          sp({ id: 7, x: 20 * EMU, y: 2 * EMU, cx: 2 * EMU, cy: 2 * EMU, fill: solid('0000FF') }) +
          tableFrame({ id: 6, x: 12 * EMU, y: 10 * EMU, cx: 8 * EMU, cy: 4 * EMU }) +
          sp({ id: 8, x: EMU, y: 13 * EMU, cx: 6 * EMU, cy: EMU, txBody: body(para(run('Thank you'))) }),
      },
    ],
  });
  return withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
}

describe('hybrid art (EmittedSlide.art)', () => {
  it('names the art elements, the objects it replaces and its place', () => {
    const out = convertDeck(deck());
    const s = out.slides[0]!;
    expect(s.classification.class).toBe('hybrid');
    const art = s.art!;
    expect(art.elements).toEqual([
      { from: 'slide', shapeId: 4, nth: 0 },
      { from: 'slide', shapeId: 5, nth: 0 },
      { from: 'slide', shapeId: 6, nth: 0 },
    ]);
    const objs = s.slide.objects;
    // background, title, the captioned rect (shape + text), the clear rect, the footer
    expect(objs.map((o) => o.type)).toEqual(['shape', 'text', 'shape', 'text', 'shape', 'text']);
    expect(art.at).toBe(2);
    expect(art.replaces).toEqual([objs[2]!.id, objs[3]!.id]);
    expect(art.before).toBe(objs[4]!.id);
    expect(art.text).toBe('Total');
    // The box spans the chart, the rect and the table, in logical px (1 in = 144 px on a 16:9 slide).
    expect(art.box.x).toBeCloseTo(144, 6);
    expect(art.box.y).toBeCloseTo(144, 6);
    expect(art.box.x + art.box.w).toBeCloseTo(20 * 72, 6);
    expect(art.box.y + art.box.h).toBeCloseTo(14 * 72, 6);
  });

  it('puts the art on top when nothing is above its range', () => {
    const parts = buildDeck({
      slides: [
        {
          rels: [{ id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }],
          shapes: chartFrame({ id: 4, x: 0, y: 0, cx: 4 * EMU, cy: 4 * EMU, rId: 'rId3' }),
        },
      ],
    });
    withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
    const s = convertDeck(parts).slides[0]!;
    expect(s.art).toMatchObject({ at: 1, replaces: [], text: '' });
    expect(s.art!.before).toBeUndefined();
  });

  it('gives native slides no art', () => {
    const parts = buildDeck({
      slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: EMU, cy: EMU, fill: solid('00FF00') }) }],
    });
    expect(convertDeck(parts).slides[0]!.art).toBeUndefined();
  });

  it('keeps repeated ids apart by their place', () => {
    const e = (from: Element['from'], shapeId: number) => ({ from, shapeId }) as Element;
    const els = [e('master', 4), e('slide', 4), e('slide', 9), e('slide', 4), e('layout', 4)];
    expect(elementRefs(els, [1, 3, 4, 0])).toEqual([
      { from: 'slide', shapeId: 4, nth: 0 },
      { from: 'slide', shapeId: 4, nth: 1 },
      { from: 'layout', shapeId: 4, nth: 0 },
      { from: 'master', shapeId: 4, nth: 0 },
    ]);
  });
});
