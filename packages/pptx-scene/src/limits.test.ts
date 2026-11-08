/**
 * Limit cases of design/27 §14.3 for shared parts: work per run, paragraph, shape or slide must not grow with
 * the length of a deck string or the size of a node that a shared part (the presentation's defaultTextStyle,
 * a layout, a master, a theme) holds once and every slide reads again. Each case is a crafted deck within the
 * §12 part budgets (≤ 8 MB, ≤ 250k tags) and must convert in under 5 s.
 */
import { describe, expect, it } from 'vitest';
import { convertDeck, parseDeck } from './index.ts';
import type { ShapeElement } from './ir.ts';
import { body, buildDeck, type DeckSpec, para, run, sp, xfrm } from './test-util.ts';

const IN = 914_400;
/** About 7 MB of one attribute: within the 8 MB part budget, with the rest of the part. */
const HUGE = 7_000_000;

/** Convert a deck and fail when it takes 5 s or more (design/27 §14.3). */
function within5s(spec: DeckSpec) {
  const parts = buildDeck(spec);
  const t0 = performance.now();
  const out = convertDeck(parts);
  const ms = performance.now() - t0;
  expect(ms).toBeLessThan(5_000);
  return out;
}

/** One text box on one slide, `paras` its paragraphs, under the presentation's `defaultTextStyle`. */
const textDeck = (defaultTextStyle: string, paras: string): DeckSpec => ({
  defaultTextStyle,
  slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: IN, cy: IN, txBody: body(paras) }) }],
});

const runs = (n: number) => para(run('x').repeat(n));

describe('deck strings in a shared style node, read again by every run and paragraph', () => {
  it('a 7M-character typeface, inherited by 3,500 runs', () => {
    const dts = `<a:lvl1pPr><a:defRPr><a:latin typeface="${'F'.repeat(HUGE)}"/></a:defRPr></a:lvl1pPr>`;
    const out = within5s(textDeck(dts, runs(3_500)));
    expect(out.slides[0]!.slide.objects.filter((o) => o.type === 'text')).toHaveLength(1);
  });

  it('a 7M-character bullet typeface and bullet character, inherited by 3,000 paragraphs', () => {
    const font = `<a:lvl1pPr><a:buFont typeface="${'F'.repeat(HUGE / 2)}"/><a:buChar char="${'y'.repeat(HUGE / 2)}"/></a:lvl1pPr>`;
    const scene = (() => {
      const parts = buildDeck(textDeck(font, para(run('x')).repeat(3_000)));
      const t0 = performance.now();
      const s = parseDeck(parts);
      expect(performance.now() - t0).toBeLessThan(5_000);
      return s;
    })();
    const p = (scene.slides[0]!.elements[0] as ShapeElement).text!.paras[0]!;
    expect(p.bullet).toMatchObject({ kind: 'char', char: 'y' });
    expect((p.bullet as { font?: string }).font).toBe('F'.repeat(128));
  });

  it('a 7M-digit size, inherited by 3,000 runs', () => {
    const out = within5s(
      textDeck(`<a:lvl1pPr><a:defRPr sz="${'1'.repeat(HUGE)}"/></a:lvl1pPr>`, runs(3_000)),
    );
    // Not a number: the default size.
    expect(out.slides[0]!.slide.objects.find((o) => o.type === 'text')).toMatchObject({
      style: { fontSizePx: 36 },
    });
  });
});

describe('large shared nodes, read again by every shape, run or slide', () => {
  /** A gradient whose stop list holds `junk` other children before its two stops. */
  const gradient = (junk: number) =>
    `<a:gradFill><a:gsLst>${'<a:x/>'.repeat(junk)}<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>` +
    '<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>';

  it('a layout placeholder gradient with 200,000 other children, inherited by 1,000 shapes', () => {
    const layoutPh = `<p:sp><p:nvSpPr><p:cNvPr id="2" name=""/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(0, 0, IN, IN)}${gradient(200_000)}</p:spPr></p:sp>`;
    const slidePh = (i: number) =>
      `<p:sp><p:nvSpPr><p:cNvPr id="${10 + i}" name=""/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>${body(para(run('x')))}</p:sp>`;
    const spec = {
      layouts: [{ shapes: layoutPh }],
      slides: [{ shapes: Array.from({ length: 1_000 }, (_, i) => slidePh(i)).join('') }],
    };
    within5s(spec);
    // The stops are past the scan bound: none found, no fill.
    const e = parseDeck(buildDeck(spec)).slides[0]!.elements[0] as ShapeElement;
    expect(e.fill).toEqual({ kind: 'none' });
  });

  it('a run gradient with 200,000 other children in defaultTextStyle, inherited by 3,000 runs', () => {
    within5s(textDeck(`<a:lvl1pPr><a:defRPr>${gradient(200_000)}</a:defRPr></a:lvl1pPr>`, runs(3_000)));
  });

  it('a master colour map with 600,000 attributes, read for each of 300 slides', () => {
    const attrs = Array.from({ length: 600_000 }, (_, i) => `x${i.toString(36)}="dk1"`).join(' ');
    const out = within5s({
      master: { clrMap: `bg1="dk1" tx1="lt1" ${attrs}` },
      slides: Array.from({ length: 300 }, () => ({})),
    });
    expect(out.slides).toHaveLength(300);
    // The real mapping still applies: bg1 → dk1 makes the master's background black.
    expect(out.slides[0]!.slide.objects[0]).toMatchObject({ fill: { r: 0, g: 0, b: 0, a: 1 } });
  });

  it('a layout decoration of 60,000 runs, under each of 300 slides, is read once', () => {
    const deco = sp({ id: 9, x: 0, y: 0, cx: IN, cy: IN, txBody: body(runs(60_000)) });
    const parts = buildDeck({ layouts: [{ shapes: deco }], slides: Array.from({ length: 300 }, () => ({})) });
    const t0 = performance.now();
    const scene = parseDeck(parts);
    expect(performance.now() - t0).toBeLessThan(5_000);
    const texts = scene.slides.map((s) => (s.elements[0] as ShapeElement).text);
    expect(texts[0]!.paras[0]!.runs).toHaveLength(60_000);
    // Shared, not read again: every slide's element holds the same text body.
    for (const t of texts) expect(t).toBe(texts[0]);
  });
});
