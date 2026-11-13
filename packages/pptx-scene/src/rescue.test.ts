/**
 * The text rescue (M9 `ladder`): a slide's own text bodies as text objects, with no geometry, picture or
 * chart read; bounded and never throwing on hostile slides.
 */
import { Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { convertDeck } from './index.ts';
import { RESCUE_DEPTH, RESCUE_NOTE, rescueDeck } from './rescue.ts';
import {
  body,
  buildDeck,
  custGeom,
  grpSp,
  imageRel,
  para,
  pic,
  pngHeader,
  run,
  solid,
  sp,
  tableFrame,
  tc,
} from './test-util.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const IN = 914_400;
const enc = new TextEncoder();
const dec = new TextDecoder();
const texts = (s: Slide) => s.objects.flatMap((o) => (o.type === 'text' ? [o.text] : []));

/** A slide of every kind of element: text boxes, a group, a table, a custom shape with text and a picture. */
function everything() {
  return buildDeck({
    slides: [
      { shapes: sp({ id: 2, x: IN, y: IN, cx: 4 * IN, cy: IN, txBody: body(para(run('First slide'))) }) },
      {
        rels: [imageRel('rId2', 'photo.png')],
        shapes:
          pic({ id: 3, x: 0, y: 0, cx: 4 * IN, cy: 3 * IN, rId: 'rId2' }) +
          sp({
            id: 4,
            x: IN,
            y: IN,
            cx: 6 * IN,
            cy: IN,
            txBody: body(para(run('Amazing grace', 'sz="4400" b="1"', solid('C00000')))),
          }) +
          grpSp(
            { id: 5, x: 0, y: 4 * IN, cx: 4 * IN, cy: IN },
            sp({ id: 6, x: 0, y: 4 * IN, cx: 2 * IN, cy: IN, txBody: body(para(run('In a group'))) }),
          ) +
          sp({
            id: 7,
            x: 5 * IN,
            y: 4 * IN,
            cx: 2 * IN,
            cy: IN,
            geom: 'none',
            fill: custGeom({
              paths:
                '<a:path w="10" h="10"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="10"/></a:lnTo></a:path>',
            }),
            txBody: body(para(run('On a custom shape'))),
          }) +
          tableFrame({
            id: 8,
            x: IN,
            y: 5 * IN,
            cols: [IN, IN],
            rows: [
              { h: IN / 2, cells: [tc('Hymn'), tc('42')] },
              { h: IN / 2, cells: [tc('Psalm'), tc('23')] },
            ],
          }),
      },
    ],
    media: { 'ppt/media/photo.png': pngHeader(64, 64, true) },
  });
}

describe('rescueDeck (M9 ladder)', () => {
  it("keeps a slide's text bodies in their boxes and nothing else, as hybrid with the slide missing", () => {
    const parts = everything();
    const out = rescueDeck(parts, { range: { from: 1, to: 2 } });
    expect(out.listed).toHaveLength(2);
    expect(out.slides).toHaveLength(1);
    const s = out.slides[0]!;
    expect(s).toMatchObject({ index: 1, shown: 1, hidden: false, missing: ['slide'] });
    expect(s.classification.class).toBe('hybrid');
    expect(s.notes).toContain(RESCUE_NOTE);
    expect(texts(s.slide)).toEqual([
      'Amazing grace',
      'In a group',
      'On a custom shape',
      'Hymn  42\nPsalm  23',
    ]);
    expect(s.slide.objects.every((o) => o.type === 'text')).toBe(true);
    expect(out.media).toEqual([]);
    expect(out.geoms).toEqual([]);
    expect(Slide.safeParse(s.slide).success).toBe(true);
    // Where the converter puts the shape, with its dominant run's size, weight and colour.
    const title = s.slide.objects[0]!;
    if (title.type !== 'text') throw new Error('not text');
    expect(title.box.x).toBeCloseTo(144, 0);
    expect(title.box.w).toBeCloseTo(864, 0);
    expect(title.style).toMatchObject({ fontWeight: 700, color: { r: 192, g: 0, b: 0, a: 1 } });
    const full = convertDeck(parts, { range: { from: 1, to: 2 } }).slides[0]!;
    const own = full.slide.objects.find((o) => o.type === 'text' && o.text === 'Amazing grace')!;
    expect(title.style.fontSizePx).toBeCloseTo(own.type === 'text' ? own.style.fontSizePx : 0, 5);
  });

  it('reads groups to depth 4 and at most 1,000 text objects; a broken slide is empty, never a throw', () => {
    let nested = sp({ id: 100, x: 0, y: 0, cx: IN, cy: IN, txBody: body(para(run('deep'))) });
    for (let d = 0; d < RESCUE_DEPTH + 3; d++)
      nested = grpSp({ id: 200 + d, x: 0, y: 0, cx: IN, cy: IN }, nested);
    const shallow = grpSp(
      { id: 300, x: 0, y: 0, cx: IN, cy: IN },
      sp({ id: 301, x: 0, y: 0, cx: IN, cy: IN, txBody: body(para(run('shallow'))) }),
    );
    const many = Array.from({ length: 1_200 }, (_, i) =>
      sp({ id: 1_000 + i, x: 0, y: 0, cx: IN, cy: IN, txBody: body(para(run(`t${i}`))) }),
    ).join('');
    const parts = buildDeck({ slides: [{ shapes: nested + shallow }, { shapes: many }, { shapes: '' }] });
    parts.set('ppt/slides/slide3.xml', enc.encode('<p:sld xmlns:p="x"><p:cSld><p:spTree><broken'));
    const out = rescueDeck(parts);
    expect(texts(out.slides[0]!.slide)).toEqual(['shallow']);
    expect(out.slides[1]!.slide.objects).toHaveLength(1_000);
    expect(out.slides[2]!.slide.objects).toEqual([]);
    for (const s of out.slides) expect(Slide.safeParse(s.slide).success).toBe(true);
  });

  it('never throws on mutated slides and stays within its bounds (fuzz)', () => {
    const base = everything();
    const xml = dec.decode(base.get('ppt/slides/slide2.xml')!);
    let seed = 7;
    const r = () => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed / 2 ** 32;
    };
    const tokens = [
      '<p:grpSp>',
      '</p:grpSp>',
      '<a:t>',
      '<a:off x="NaN" y="1e308"/>',
      '<a:ext cx="-5"/>',
      '&#xD800;',
      '<p:ph type="title"/>',
      '"',
      '<',
    ];
    const t0 = performance.now();
    for (let k = 0; k < 400; k++) {
      let s = xml;
      for (let m = 0; m < 1 + Math.floor(r() * 6); m++) {
        const at = Math.floor(r() * s.length);
        const op = r();
        if (op < 0.4) s = s.slice(0, at) + tokens[Math.floor(r() * tokens.length)] + s.slice(at);
        else if (op < 0.7) s = s.slice(0, at) + s.slice(at + Math.floor(r() * 40));
        else s = s.slice(0, at);
      }
      const parts = new Map(base);
      parts.set('ppt/slides/slide2.xml', enc.encode(s));
      const out = rescueDeck(parts, { range: { from: 1, to: 2 } });
      for (const sl of out.slides) {
        expect(sl.slide.objects.length).toBeLessThanOrEqual(1_000);
        expect(Slide.safeParse(sl.slide).success).toBe(true);
      }
    }
    expect(performance.now() - t0).toBeLessThan(budgetMs(20_000));
  });
});
