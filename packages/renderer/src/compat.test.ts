import { describe, expect, it } from 'vitest';
import { LOOK_MAIN, type Slide } from '@ordo/domain';
import { richSlide } from '@ordo/domain/rich.test-util.ts';
import * as prev from '@ordo/domain/schemas.prev.test-util.ts';
import { drawSlide2D } from './text2d.ts';
import { recordingCtx } from './text/test-util.ts';

/**
 * design/27 §14.7: a slide written with the new fields, as the previous release reads it (main's 0.5.0:
 * every key it does not know stripped), still draws its text; and the rich slide itself draws through the
 * rich engine. 0.5.0 already has rich text, so it keeps the rich slide whole (clamp.m9.test.ts checks M9's).
 */

const img = { width: 160, height: 90 } as unknown as CanvasImageSource;

function drawn(slide: Slide) {
  const ctx = recordingCtx();
  drawSlide2D(ctx, slide, { scale: 0.5, look: LOOK_MAIN, images: () => img });
  return ctx.ops;
}

describe('previous-release compatibility (design/27 §14.7)', () => {
  it('the slide as the previous release reads it still draws its text, shapes and pictures', () => {
    const stripped = prev.Slide.parse(richSlide()) as Slide;
    const ops = drawn(stripped);
    const text = ops.filter((o) => o.op === 'fillText').map((o) => o.args[0] as string);
    // Lines wrap between words: compare the letters.
    expect(text.join('').replace(/\s+/g, '')).toContain('ForGodsoloved');
    expect(ops.some((o) => o.op === 'fill')).toBe(true);
    expect(ops.some((o) => o.op === 'drawImage')).toBe(true);
  });

  it('the rich slide draws non-empty through the rich engine', () => {
    const ops = drawn(richSlide());
    const fills = ops.filter((o) => o.op === 'fillText');
    expect(fills.map((o) => o.args[0]).join(' ')).toContain('loved');
    // Rich text is laid out in logical px and drawn under the scale transform.
    expect(fills.every((o) => o.transform[0] === 0.5)).toBe(true);
  });
});
