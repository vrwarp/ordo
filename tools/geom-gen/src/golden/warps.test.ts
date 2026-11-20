import { describe, expect, it } from 'vitest';
import { TEXT_WARPS } from '../../../../packages/domain/src/schemas.ts';
import { readZip } from '../../../../packages/importers/src/zip.ts';
import { parseDeck } from '../../../../packages/pptx-scene/src/index.ts';
import { EMU_PER_PX, probeDeck, probeParts, SLIDE_H, SLIDE_W, shapeXml, slideCount } from './probe.ts';
import { WARP_BOXES, WARP_TEXT, warpDeck, warpLayout, warpShapeXml } from './warps.ts';

/*
 * The warp probe's deck (warps.ts): one text box per WordArt warp at its default adjust values, in ordo's own words
 * ("WordArt Ag", Liberation Sans 40 pt, no fill, no outline, wrap none, zero insets, centred in the box), three decks for
 * three box shapes. LibreOffice draws it and warps-run.ts measures where the ink falls.
 */

const names = [...TEXT_WARPS].sort();

describe('warp probe layout', () => {
  it('has the three boxes of the measure, as a grid of cells each', () => {
    expect(WARP_BOXES.map((b) => [b.key, b.w, b.h, b.cols, b.rows])).toEqual([
      ['360x240', 360, 240, 3, 2],
      ['600x120', 600, 120, 2, 3],
      ['240x300', 240, 300, 3, 2],
    ]);
    expect(WARP_TEXT).toBe('WordArt Ag');
  });

  it('puts every warp in its own cell with its box in the middle and at least 90 px clear on every side', () => {
    for (const box of WARP_BOXES) {
      const shapes = warpLayout(names, box);
      expect(shapes.length, box.key).toBe(40);
      expect(slideCount(shapes), box.key).toBe(7);
      expect(shapes.map((s) => s.name)).toEqual(names);
      const cells = new Set<string>();
      const cw = SLIDE_W / box.cols;
      const ch = SLIDE_H / box.rows;
      for (const [i, s] of shapes.entries()) {
        expect(s.slide, `${box.key} ${s.name}`).toBe(Math.floor(i / (box.cols * box.rows)));
        cells.add(`${s.slide} ${s.cell.x} ${s.cell.y}`);
        expect([s.cell.w, s.cell.h]).toEqual([cw, ch]);
        expect(s.cell.x % cw).toBe(0);
        expect(s.cell.y % ch).toBe(0);
        expect(s.cell.x + s.cell.w).toBeLessThanOrEqual(SLIDE_W);
        expect(s.cell.y + s.cell.h).toBeLessThanOrEqual(SLIDE_H);
        expect([s.box.w, s.box.h]).toEqual([box.w, box.h]);
        // The box is centred with whole pixels (floor of half the difference).
        expect([s.box.x - s.cell.x, s.box.y - s.cell.y]).toEqual([
          Math.floor((cw - box.w) / 2),
          Math.floor((ch - box.h) / 2),
        ]);
        // LibreOffice's ink overshot a box by at most 38 px (planning measure): the cells leave 90 px.
        expect(s.box.x - s.cell.x, `${box.key} left`).toBeGreaterThanOrEqual(90);
        expect(s.box.y - s.cell.y, `${box.key} top`).toBeGreaterThanOrEqual(90);
        expect(s.cell.x + s.cell.w - (s.box.x + s.box.w), `${box.key} right`).toBeGreaterThanOrEqual(90);
        expect(s.cell.y + s.cell.h - (s.box.y + s.box.h), `${box.key} bottom`).toBeGreaterThanOrEqual(90);
      }
      expect(cells.size).toBe(40);
    }
  });

  it('lays out whatever names it is given, six or fewer to a slide, in the order given', () => {
    const few = warpLayout(['textWave1', 'textPlain', 'textArchUp'], WARP_BOXES[0]!);
    expect(few.map((s) => [s.name, s.slide])).toEqual([
      ['textWave1', 0],
      ['textPlain', 0],
      ['textArchUp', 0],
    ]);
    expect(warpLayout([], WARP_BOXES[1]!)).toEqual([]);
  });
});

describe('warp probe shapes', () => {
  it('writes a centred, unwrapped, zero-inset text box with the warp, the text and the font', () => {
    const [s] = warpLayout(['textArchUp'], WARP_BOXES[0]!);
    const xml = warpShapeXml(s!, 5);
    expect(xml).toContain('<p:cNvPr id="5" name="textArchUp"/>');
    expect(xml).toContain('<p:cNvSpPr txBox="1"/>');
    expect(xml).toContain(
      `<a:off x="${Math.round(s!.box.x * EMU_PER_PX)}" y="${Math.round(s!.box.y * EMU_PER_PX)}"/>`,
    );
    expect(xml).toContain(
      `<a:ext cx="${Math.round(s!.box.w * EMU_PER_PX)}" cy="${Math.round(s!.box.h * EMU_PER_PX)}"/>`,
    );
    expect(xml).toContain(
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>',
    );
    expect(xml).toContain(
      '<a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="ctr">' +
        '<a:prstTxWarp prst="textArchUp"><a:avLst/></a:prstTxWarp><a:noAutofit/></a:bodyPr>',
    );
    expect(xml).toContain('<a:pPr algn="ctr"/>');
    expect(xml).toContain('sz="4000" b="0"');
    expect(xml).toContain('<a:srgbClr val="000000"/>');
    expect(xml).toContain('<a:latin typeface="Liberation Sans"/>');
    expect(xml).toContain(`<a:t>${WARP_TEXT}</a:t>`);
  });

  it('is the deck’s shape writer: probeParts takes it, and the default writer is the preset one', () => {
    const shapes = warpLayout(names, WARP_BOXES[0]!).slice(0, 7);
    const custom = probeParts(shapes, () => '<p:sp>X</p:sp>');
    const slide1 = custom.find(([n]) => n === 'ppt/slides/slide1.xml')![1];
    expect(slide1.match(/<p:sp>X<\/p:sp>/g)?.length).toBe(6);
    expect(probeParts(shapes)).toEqual(probeParts(shapes, shapeXml));
    expect(probeDeck(shapes)).toEqual(probeDeck(shapes, shapeXml));
  });
});

describe('warp probe decks', () => {
  it.each(WARP_BOXES.map((b) => [b.key, b] as const))(
    'the %s deck reads back: 40 text boxes with their warp at the layout’s box, 7 slides',
    async (_key, box) => {
      const parts = await readZip(warpDeck(names, box));
      const scene = parseDeck(parts);
      expect(scene.slides.length).toBe(7);
      expect(scene.frame).toMatchObject({ cx: SLIDE_W * EMU_PER_PX, cy: SLIDE_H * EMU_PER_PX });
      const shapes = warpLayout(names, box);
      const read = scene.slides.flatMap((slide, i) =>
        slide.elements.map((e) => {
          if (e.kind !== 'shape') throw new Error(`slide ${i + 1}: a ${e.kind}`);
          return { slide: i, e };
        }),
      );
      expect(read.length).toBe(40);
      for (let i = 0; i < shapes.length; i++) {
        const s = shapes[i]!;
        const { slide, e } = read[i]!;
        expect(slide).toBe(s.slide);
        expect(e.text?.warp?.preset, s.name).toBe(s.name);
        expect(e.text?.warp?.adj ?? [], s.name).toEqual([]);
        expect(e.xf).toEqual([
          s.box.w * EMU_PER_PX,
          0,
          0,
          s.box.h * EMU_PER_PX,
          s.box.x * EMU_PER_PX,
          s.box.y * EMU_PER_PX,
        ]);
        expect(e.text?.wrap).toBe(false);
        expect(e.text?.anchor).toBe('middle');
      }
    },
  );

  it('writes the same bytes every time, as a zip of the parts', async () => {
    for (const box of WARP_BOXES) {
      const a = warpDeck(names, box);
      expect(warpDeck(names, box)).toEqual(a);
      expect(a.length).toBeGreaterThan(1_000);
      const parts = await readZip(a);
      const want = probeParts(warpLayout(names, box), warpShapeXml);
      expect([...parts.keys()].sort()).toEqual(want.map(([n]) => n).sort());
      for (const [name, xml] of want) expect(new TextDecoder().decode(parts.get(name))).toBe(xml);
    }
  });
});
