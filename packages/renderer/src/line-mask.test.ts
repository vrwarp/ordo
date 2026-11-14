import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LYRIC_STYLE,
  type ImageObject,
  type Slide,
  type TextObject,
  type TextStyle,
  rgbaCss,
} from '@ordo/domain';
import { clampObject, clampStyle, isRichStyle } from './clamp.ts';
import { pictureShape, pictureTarget } from './picture.ts';
import { objectReach, richTextReach } from './sprite.ts';
import { LEGACY_FONT_ENV } from './text/fonts.ts';
import { type LineMaskStrap, paintPlan, paintRich } from './text/paint.ts';
import { clampTextObject } from './text/rich.ts';
import { recordingCtx } from './text/test-util.ts';
import type { RichLayout, Seg } from './text/types.ts';
import { drawImageFit, drawSlide2D } from './text2d.ts';

function textObj(text: string, style: Partial<TextStyle> = {}, extra: Partial<TextObject> = {}): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 100, y: 50, w: 400, h: 200, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      fontSizePx: 20,
      lineHeight: 1.2,
      padding: 0,
      ...style,
    },
    opacity: 1,
    ...extra,
  });
}

function seg(p: Partial<Seg> & Pick<Seg, 'start' | 'end' | 'x' | 'w'>): Seg {
  return { run: -1, level: 0, font: '400 20px "Inter"', sizePx: 20, shift: 0, ...p };
}

function makeLayout(lines: RichLayout['lines']): RichLayout {
  return {
    lines,
    fontScale: 1,
    spacingScale: 1,
    overflow: false,
    ink: { x: 100, y: 50, w: 400, h: 200, rotation: 0 },
  };
}

describe('TextStyle.lineMask clamp and rich routing', () => {
  it('clamps and preserves solid fill lineMask', () => {
    const raw: TextStyle = {
      ...DEFAULT_LYRIC_STYLE,
      lineMask: {
        style: 'lineWidth',
        heightOffsetPx: 20,
        vOffsetPx: 10,
        widthOffsetPx: 30,
        hOffsetPx: -5,
        fill: { r: 255, g: 100, b: 50, a: 0.8 },
      },
    };
    const clamped = clampStyle(raw);
    expect(clamped.lineMask).toEqual({
      style: 'lineWidth',
      heightOffsetPx: 20,
      vOffsetPx: 10,
      widthOffsetPx: 30,
      hOffsetPx: -5,
      fill: { r: 255, g: 100, b: 50, a: 0.8 },
    });
    expect(isRichStyle(clamped)).toBe(true);
  });

  it('clamps and preserves gradient lineMask', () => {
    const raw: TextStyle = {
      ...DEFAULT_LYRIC_STYLE,
      lineMask: {
        style: 'maxLineWidth',
        gradient: {
          kind: 'linear',
          angle: 45,
          stops: [
            { at: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
            { at: 1, color: { r: 255, g: 255, b: 255, a: 1 } },
          ],
        },
      },
    };
    const clamped = clampStyle(raw);
    expect(clamped.lineMask?.style).toBe('maxLineWidth');
    expect(clamped.lineMask?.gradient?.stops).toHaveLength(2);
    expect(isRichStyle(clamped)).toBe(true);
  });

  it('clamps out-of-range offsets and falls back to fullWidth', () => {
    const raw: TextStyle = {
      ...DEFAULT_LYRIC_STYLE,
      lineMask: {
        style: 'invalidStyle' as unknown as 'fullWidth',
        heightOffsetPx: 5000,
        vOffsetPx: -5000,
        widthOffsetPx: 10000,
        hOffsetPx: -10000,
        fill: { r: 0, g: 0, b: 0, a: 1 },
      },
    };
    const clamped = clampStyle(raw);
    expect(clamped.lineMask).toEqual({
      style: 'fullWidth',
      heightOffsetPx: 2000,
      vOffsetPx: -2000,
      widthOffsetPx: 4000,
      hOffsetPx: -4000,
      fill: { r: 0, g: 0, b: 0, a: 1 },
    });
  });

  it('drops lineMask when neither fill nor gradient is provided', () => {
    const raw: TextStyle = {
      ...DEFAULT_LYRIC_STYLE,
      lineMask: {
        style: 'lineWidth',
        heightOffsetPx: 10,
      } as unknown as NonNullable<TextStyle['lineMask']>,
    };
    const clamped = clampStyle(raw);
    expect(clamped.lineMask).toBeUndefined();
    expect(isRichStyle(clamped)).toBe(false);
  });
});

describe('paintPlan and paintRich with lineMask', () => {
  it('calculates fullWidth straps across object box', () => {
    const o = textObj('Line 1\nLine 2', {
      lineMask: {
        style: 'fullWidth',
        heightOffsetPx: 4,
        vOffsetPx: 2,
        widthOffsetPx: 20,
        hOffsetPx: 5,
        fill: { r: 200, g: 0, b: 0, a: 1 },
      },
    });
    const layout = makeLayout([
      {
        para: 0,
        top: 60,
        baseline: 80,
        height: 24,
        x: 150,
        w: 120,
        extraPerSpace: 0,
        segs: [seg({ start: 0, end: 6, x: 150, w: 120, sizePx: 20 })],
      },
      {
        para: 1,
        top: 90,
        baseline: 110,
        height: 24,
        x: 150,
        w: 140,
        extraPerSpace: 0,
        segs: [seg({ start: 7, end: 13, x: 150, w: 140, sizePx: 20 })],
      },
    ]);
    const plan = paintPlan(o, layout);
    expect(plan.lineMask).not.toBeNull();
    expect(plan.lineMask?.straps).toHaveLength(2);

    // F = 20
    // h = max(0, 20 * 1.2 + 4) = 28
    // y = baseline - 20 * 0.9 - 4/2 + 2 = baseline - 18 - 2 + 2 = baseline - 18
    // w = max(0, 400 + 20) = 420
    // x = 100 - 20 / 2 + 5 = 95
    const [s1, s2] = plan.lineMask!.straps as [LineMaskStrap, LineMaskStrap];
    expect(s1).toMatchObject({ x: 95, y: 80 - 18, w: 420, h: 28 });
    expect(s2).toMatchObject({ x: 95, y: 110 - 18, w: 420, h: 28 });
  });

  it('calculates lineWidth straps per individual line width', () => {
    const o = textObj('Line 1\nLine 2', {
      lineMask: {
        style: 'lineWidth',
        heightOffsetPx: 0,
        vOffsetPx: 0,
        widthOffsetPx: 10,
        hOffsetPx: 0,
        fill: { r: 0, g: 100, b: 200, a: 1 },
      },
    });
    const layout = makeLayout([
      {
        para: 0,
        top: 60,
        baseline: 80,
        height: 24,
        x: 120,
        w: 100,
        extraPerSpace: 0,
        segs: [seg({ start: 0, end: 6, x: 120, w: 100, sizePx: 20 })],
      },
      {
        para: 1,
        top: 90,
        baseline: 110,
        height: 24,
        x: 120,
        w: 180,
        extraPerSpace: 0,
        segs: [seg({ start: 7, end: 13, x: 120, w: 180, sizePx: 20 })],
      },
    ]);
    const plan = paintPlan(o, layout);
    const [s1, s2] = plan.lineMask!.straps as [LineMaskStrap, LineMaskStrap];
    // Line 1: w = 100 + 10 = 110, x = 120 - 5 = 115
    expect(s1).toMatchObject({ x: 115, y: 80 - 18, w: 110, h: 24 });
    // Line 2: w = 180 + 10 = 190, x = 120 - 5 = 115
    expect(s2).toMatchObject({ x: 115, y: 110 - 18, w: 190, h: 24 });
  });

  it('calculates maxLineWidth straps with alignments (left, center, right)', () => {
    for (const align of ['left', 'center', 'right'] as const) {
      const o = textObj('Line 1\nLine 2', {
        align,
        lineMask: {
          style: 'maxLineWidth',
          widthOffsetPx: 0,
          hOffsetPx: 0,
          fill: { r: 50, g: 50, b: 50, a: 1 },
        },
      });
      const layout = makeLayout([
        {
          para: 0,
          top: 60,
          baseline: 80,
          height: 24,
          x: 100,
          w: 100,
          extraPerSpace: 0,
          segs: [seg({ start: 0, end: 6, x: 100, w: 100, sizePx: 20 })],
        },
        {
          para: 1,
          top: 90,
          baseline: 110,
          height: 24,
          x: 100,
          w: 200,
          extraPerSpace: 0,
          segs: [seg({ start: 7, end: 13, x: 100, w: 200, sizePx: 20 })],
        },
      ]);
      const plan = paintPlan(o, layout);
      const [s1, s2] = plan.lineMask!.straps as [LineMaskStrap, LineMaskStrap];
      // maxLineW = 200. box: x = 100, w = 400.
      const expectedX = align === 'left' ? 100 : align === 'right' ? 100 + 400 - 200 : 100 + (400 - 200) / 2;
      expect(s1.w).toBe(200);
      expect(s1.x).toBe(expectedX);
      expect(s2.w).toBe(200);
      expect(s2.x).toBe(expectedX);
    }
  });

  it('skips empty/whitespace-only lines from straps', () => {
    const o = textObj('Line 1\n   \nLine 3', {
      lineMask: {
        style: 'fullWidth',
        fill: { r: 100, g: 0, b: 0, a: 1 },
      },
    });
    const layout = makeLayout([
      {
        para: 0,
        top: 60,
        baseline: 80,
        height: 24,
        x: 100,
        w: 80,
        extraPerSpace: 0,
        segs: [seg({ start: 0, end: 6, x: 100, w: 80, sizePx: 20 })],
      },
      {
        para: 1,
        top: 90,
        baseline: 110,
        height: 24,
        x: 100,
        w: 30,
        extraPerSpace: 0,
        segs: [seg({ start: 7, end: 10, x: 100, w: 30, sizePx: 20 })],
      },
      {
        para: 2,
        top: 120,
        baseline: 140,
        height: 24,
        x: 100,
        w: 80,
        extraPerSpace: 0,
        segs: [seg({ start: 11, end: 17, x: 100, w: 80, sizePx: 20 })],
      },
    ]);
    const plan = paintPlan(o, layout);
    // Only 2 straps: line 0 and line 2 (line 1 is whitespace only)
    expect(plan.lineMask!.straps).toHaveLength(2);
    expect(plan.lineMask!.straps[0]!.y).toBe(80 - 18);
    expect(plan.lineMask!.straps[1]!.y).toBe(140 - 18);
  });

  it('paints solid fill straps in paintRich before glyphs', () => {
    const ctx = recordingCtx();
    const o = textObj('Test Line', {
      lineMask: {
        style: 'lineWidth',
        fill: { r: 255, g: 0, b: 128, a: 1 },
      },
    });
    const layout = makeLayout([
      {
        para: 0,
        top: 60,
        baseline: 80,
        height: 24,
        x: 100,
        w: 150,
        extraPerSpace: 0,
        segs: [seg({ start: 0, end: 9, x: 100, w: 150, sizePx: 20 })],
      },
    ]);
    paintRich(ctx, o, layout, 1, LEGACY_FONT_ENV);
    const fills = ctx.ops.filter((op) => op.op === 'fillRect');
    expect(fills.length).toBeGreaterThanOrEqual(1);
    const strapFill = fills[0]!;
    expect(strapFill.fillStyle).toBe(rgbaCss({ r: 255, g: 0, b: 128, a: 1 }));
    expect(strapFill.args).toEqual([100, 80 - 18, 150, 24]);
  });

  it('paints gradient straps across text box in paintRich', () => {
    const ctx = recordingCtx();
    const o = textObj('Grad Line', {
      lineMask: {
        style: 'fullWidth',
        gradient: {
          kind: 'linear',
          angle: 90,
          stops: [
            { at: 0, color: { r: 10, g: 20, b: 30, a: 1 } },
            { at: 1, color: { r: 100, g: 200, b: 250, a: 1 } },
          ],
        },
      },
    });
    const layout = makeLayout([
      {
        para: 0,
        top: 60,
        baseline: 80,
        height: 24,
        x: 100,
        w: 120,
        extraPerSpace: 0,
        segs: [seg({ start: 0, end: 9, x: 100, w: 120, sizePx: 20 })],
      },
    ]);
    paintRich(ctx, o, layout, 1, LEGACY_FONT_ENV);
    const fills = ctx.ops.filter((op) => op.op === 'fillRect');
    expect(fills.length).toBeGreaterThanOrEqual(1);
    expect(typeof fills[0]!.fillStyle).toBe('object');
  });
});

describe('ImageObject shadow and softEdge', () => {
  it('clamps shadow and softEdge on image objects', () => {
    const img: ImageObject = {
      id: 'i1',
      type: 'image',
      box: { x: 50, y: 50, w: 300, h: 200, rotation: 0 },
      mediaId: 'm1',
      fit: 'contain',
      opacity: 1,
      radius: 0,
      shadow: {
        dx: 600,
        dy: -600,
        blur: 700,
        color: { r: 0, g: 0, b: 0, a: 0.7 },
      },
      softEdge: 600,
    };
    const clamped = clampObject(img) as ImageObject;
    expect(clamped.shadow).toEqual({
      dx: 500,
      dy: -500,
      blur: 500,
      color: { r: 0, g: 0, b: 0, a: 0.7 },
    });
    expect(clamped.softEdge).toBe(500);

    const imgZeroSoft: ImageObject = {
      ...img,
      id: 'i2',
      softEdge: 0,
    };
    const clampedZero = clampObject(imgZeroSoft) as ImageObject;
    expect(clampedZero.softEdge).toBeUndefined();
  });

  it('pictureShape reflects shadow and softEdge', () => {
    const shape = pictureShape({
      shadow: { dx: 10, dy: 10, blur: 5, color: { r: 0, g: 0, b: 0, a: 1 } },
      softEdge: 15,
    });
    expect(shape).toBeDefined();
    expect(shape?.shadow?.dx).toBe(10);
    expect(shape?.softEdge).toBe(15);
  });

  it('prepares pictures with a shadow or a soft edge: the soft edge in the bitmap, the shadow outside it', () => {
    const plain = pictureTarget({ box: { x: 0, y: 0, w: 200, h: 200, rotation: 0 }, fit: 'contain' }, 1)!;
    const withShadow = pictureTarget(
      {
        box: { x: 0, y: 0, w: 200, h: 200, rotation: 0 },
        fit: 'contain',
        shadow: { dx: 5, dy: 5, blur: 2, color: { r: 0, g: 0, b: 0, a: 1 } },
      },
      1,
    );
    // The shadow is drawn under the prepared bitmap: the same pixels, the same key.
    expect(withShadow).toEqual(plain);

    const withSoftEdge = pictureTarget(
      {
        box: { x: 0, y: 0, w: 200, h: 200, rotation: 0 },
        fit: 'contain',
        softEdge: 10,
      },
      1,
    );
    expect(withSoftEdge).toBeDefined();
    expect(withSoftEdge!.key).not.toBe(plain.key);
    expect(withSoftEdge!.shape).toEqual({ w: 200, h: 200, softEdge: 10 });
  });

  it('draws a picture without its effects where they cannot be made (no OffscreenCanvas), never a Canvas shadow', () => {
    const ctx = recordingCtx();
    const fakeImg = { width: 400, height: 300 } as unknown as CanvasImageSource;
    drawImageFit(
      ctx,
      fakeImg,
      { x: 100, y: 100, w: 200, h: 150, rotation: 0 },
      1,
      'contain',
      1,
      0,
      undefined,
      undefined,
      {
        shadow: { dx: 8, dy: 12, blur: 6, color: { r: 10, g: 20, b: 30, a: 0.9 } },
        softEdge: 5,
      },
    );
    const drawCalls = ctx.ops.filter((op) => op.op === 'drawImage');
    expect(drawCalls.length).toBeGreaterThanOrEqual(1);
    // Effects go through the effect layers (`drawEffected`), which need an OffscreenCanvas: here the picture
    // is drawn as a shape is without them, with no Canvas shadow left on it.
    expect(drawCalls[0]!.state.shadowBlur ?? 0).toBe(0);
    expect(drawCalls[0]!.state.shadowColor).not.toBe(rgbaCss({ r: 10, g: 20, b: 30, a: 0.9 }));
  });
});

describe('sprite planning and objectReach', () => {
  it('extends objectReach for ImageObject with shadow', () => {
    const ctx = recordingCtx();
    const img: ImageObject = {
      id: 'i',
      type: 'image',
      box: { x: 100, y: 100, w: 200, h: 150, rotation: 0 },
      mediaId: 'm',
      fit: 'contain',
      opacity: 1,
      radius: 0,
      shadow: { dx: 20, dy: 30, blur: 10, color: { r: 0, g: 0, b: 0, a: 1 } },
    };
    const reach = objectReach(ctx, img, 1);
    expect(reach).not.toBeNull();
    // As the effect layers reach (`drawEffected`): 3σ past the offset box (σ = blur/√6), the reduced
    // layer's slack (2 + 8 device px) and a pixel of anti-aliasing.
    const pad = (3 * 10) / Math.sqrt(6) + 10 + 1;
    expect(reach!.x).toBeCloseTo(Math.min(100, 120 - pad), 6);
    expect(reach!.y).toBeCloseTo(Math.min(100, 130 - pad), 6);
    expect(reach!.x + reach!.w).toBeCloseTo(320 + pad, 6);
    expect(reach!.y + reach!.h).toBeCloseTo(280 + pad, 6);
  });

  it('richTextReach extends bounds for lineMask straps', () => {
    const ctx = recordingCtx();
    const o = textObj('Hello', {
      lineMask: {
        style: 'fullWidth',
        widthOffsetPx: 100,
        heightOffsetPx: 50,
        fill: { r: 0, g: 0, b: 0, a: 1 },
      },
    });
    const reach = richTextReach(ctx, o);
    expect(reach).not.toBeNull();
    // o.box is x: 100, w: 400. widthOffsetPx = 100 -> strap w = 500, x = 100 - 50 = 50.
    expect(reach!.x).toBeLessThanOrEqual(50);
  });

  it('drawSlide2D renders presentation with lineMask text and shadowed image', () => {
    const ctx = recordingCtx();
    const fakeImg = { width: 400, height: 300 } as unknown as CanvasImageSource;
    const slide: Slide = {
      id: 'sl',
      objects: [
        {
          id: 't',
          type: 'text',
          box: { x: 50, y: 50, w: 500, h: 200, rotation: 0 },
          text: 'Masked Text Title',
          style: {
            ...DEFAULT_LYRIC_STYLE,
            fontSizePx: 32,
            lineMask: {
              style: 'lineWidth',
              fill: { r: 255, g: 255, b: 0, a: 1 },
            },
          },
          opacity: 1,
        },
        {
          id: 'img',
          type: 'image',
          box: { x: 100, y: 300, w: 400, h: 300, rotation: 0 },
          mediaId: 'pic1',
          fit: 'contain',
          opacity: 1,
          radius: 0,
          shadow: { dx: 15, dy: 15, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.8 } },
          softEdge: 10,
        },
      ],
    };
    drawSlide2D(ctx, slide, {
      scale: 1,
      images: () => fakeImg,
    });
    // Verify text line mask strap fillRect was recorded
    const strapFills = ctx.ops.filter(
      (op) => op.op === 'fillRect' && op.fillStyle === rgbaCss({ r: 255, g: 255, b: 0, a: 1 }),
    );
    expect(strapFills.length).toBeGreaterThanOrEqual(1);
    // Verify image draw was recorded
    const imgDraws = ctx.ops.filter((op) => op.op === 'drawImage');
    expect(imgDraws.length).toBeGreaterThanOrEqual(1);
  });
});
