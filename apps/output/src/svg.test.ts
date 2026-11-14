/**
 * The window's draw of an SVG without its still (`svg.ts`, design/14 "Pictures"): bounded by size before
 * anything is decoded, since the window also runs the hub link and the video slots (2026-11-13 review).
 */
import { SVG_SCREEN_MAX_BYTES } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { svgBitmap } from './svg.ts';

describe('svgBitmap', () => {
  it('refuses an SVG past SVG_SCREEN_MAX_BYTES before decoding it', async () => {
    const big = new Blob([
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9">',
      ' '.repeat(SVG_SCREEN_MAX_BYTES),
      '</svg>',
    ]);
    // No DOM here: a decode would fail on `Image`, so the size refusal is what this sees.
    await expect(svgBitmap(big)).rejects.toThrow(/without a still: screens draw one of at most 2 MB/);
  });
});
