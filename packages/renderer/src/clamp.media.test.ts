import type { Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { clampPlay, clampSlide, clampSlideSound } from './clamp.ts';

/** Media playing in place (design/27 §3.1) is whitelisted and bounded on the way to the drawers. */

describe('clampPlay', () => {
  it('keeps known values and bounds numbers', () => {
    expect(
      clampPlay({
        mediaId: 'clip',
        start: 'click',
        loop: true,
        onEnd: 'black',
        gainDb: -6,
        muted: false,
        showWhenStopped: false,
      }),
    ).toEqual({
      mediaId: 'clip',
      start: 'click',
      loop: true,
      onEnd: 'black',
      gainDb: -6,
      muted: false,
      showWhenStopped: false,
    });
    expect(clampPlay({ mediaId: 'clip', gainDb: 300 })?.gainDb).toBe(100);
    expect(clampPlay({ mediaId: 'clip', gainDb: Number.NaN })?.gainDb).toBe(0);
  });

  it('degrades unknown enum values as the schema does, and drops what is not a clip', () => {
    expect(clampPlay({ mediaId: 'clip', start: 'later', onEnd: 'rewind' })).toEqual({
      mediaId: 'clip',
      start: 'auto',
      onEnd: 'hold',
    });
    expect(clampPlay({ mediaId: 'clip', loop: 'yes' })).toEqual({ mediaId: 'clip' });
    expect(clampPlay({ start: 'auto' })).toBeUndefined();
    expect(clampPlay('clip')).toBeUndefined();
    expect(clampPlay({ mediaId: 'x'.repeat(500) })?.mediaId.length).toBe(200);
  });
});

describe('clampSlideSound', () => {
  it('bounds the slide count and gain', () => {
    expect(clampSlideSound({ mediaId: 'song', slides: 0, gainDb: -500, start: 'click' })).toEqual({
      mediaId: 'song',
      slides: 1,
      gainDb: -100,
      start: 'click',
    });
    expect(clampSlideSound({ mediaId: 'song', slides: 2.6 })?.slides).toBe(3);
    expect(clampSlideSound({ mediaId: 'song', slides: 5000 })?.slides).toBe(999);
    expect(clampSlideSound({ loop: true })).toBeUndefined();
  });
});

describe('clampSlide media', () => {
  it('keeps play on image objects and the slide sound', () => {
    const slide = {
      id: 's',
      objects: [
        {
          id: 'v',
          type: 'image',
          box: { x: 0, y: 0, w: 960, h: 540, rotation: 0 },
          mediaId: 'poster',
          play: { mediaId: 'clip', start: 'click', gainDb: 900 },
          fit: 'stretch',
          opacity: 1,
          radius: 0,
        },
        {
          id: 't',
          type: 'text',
          box: { x: 0, y: 600, w: 960, h: 100, rotation: 0 },
          text: 'Title',
          play: { mediaId: 'ignored' },
          style: { fontFamily: 'Inter', fontSizePx: 40, color: { r: 0, g: 0, b: 0, a: 1 } },
        },
      ],
      audio: { mediaId: 'song', slides: 3, loop: true },
    } as unknown as Slide;
    const c = clampSlide(slide);
    const v = c.objects[0]!;
    expect(v.type === 'image' && v.play).toEqual({ mediaId: 'clip', start: 'click', gainDb: 100 });
    expect('play' in c.objects[1]!).toBe(false);
    expect(c.audio).toEqual({ mediaId: 'song', slides: 3, loop: true });
  });

  it('adds nothing to a slide without media', () => {
    const c = clampSlide({
      id: 's',
      objects: [
        {
          id: 'i',
          type: 'image',
          box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
          mediaId: 'pic',
          fit: 'contain',
          opacity: 1,
          radius: 0,
        },
      ],
    } as Slide);
    expect('play' in c.objects[0]!).toBe(false);
    expect('audio' in c).toBe(false);
  });
});
