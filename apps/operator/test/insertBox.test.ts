/**
 * The box a picture starts in when inserted or pasted (`insertBox.ts`): an SVG at the size it declares, not
 * at its still's (at least 1,920 px on its longer side), the 2026-11-13 review.
 */
import { svgRasterSizeFor } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { insertBox, svgDeclared } from '../src/views/editor/insertBox.ts';

const svg = (hash: string) => ({
  original: { hash, bytes: 300, mime: 'image/svg+xml', path: `files/${hash}` },
});
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 20 8"></svg>';
const VIEWBOX = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"></svg>';

describe('the insert box', () => {
  it('a photo: its pixel size, at most the slide width, centred', () => {
    expect(insertBox({ width: 800, height: 600 })).toEqual({ x: 560, y: 240, w: 800, h: 600, rotation: 0 });
    expect(insertBox({ width: 3840, height: 2160 })).toEqual({ x: 0, y: 0, w: 1920, h: 1080, rotation: 0 });
    expect(insertBox({})).toEqual({ x: 480, y: 270, w: 960, h: 540, rotation: 0 });
  });

  it('a 200 x 80 logo SVG starts at 200 x 80, not at its 1920 x 768 still', async () => {
    const declared = await svgDeclared(svg('logo'), async () => LOGO);
    const still = svgRasterSizeFor(declared!);
    expect(still).toEqual({ width: 1920, height: 768 });
    expect(insertBox(still, declared)).toEqual({ x: 860, y: 500, w: 200, h: 80, rotation: 0 });
  });

  it('an SVG with only a viewBox starts half the slide wide at its ratio', async () => {
    const declared = await svgDeclared(svg('vb'), async () => VIEWBOX);
    expect(insertBox({ width: 1920, height: 1080 }, declared)).toEqual({
      x: 480,
      y: 270,
      w: 960,
      h: 540,
      rotation: 0,
    });
  });

  it('reads nothing for another picture, and falls back to the media size when the SVG cannot be read', async () => {
    let reads = 0;
    const photo = { original: { hash: 'p', bytes: 9, mime: 'image/png', path: 'files/p' } };
    const read = async () => {
      reads++;
      return LOGO;
    };
    expect(await svgDeclared(photo, read)).toBeUndefined();
    expect(reads).toBe(0);
    const failed = await svgDeclared(svg('x'), async () => {
      throw new Error('offline');
    });
    expect(failed).toBeUndefined();
    expect(insertBox({ width: 1920, height: 768 }, failed).w).toBe(1920);
  });
});
