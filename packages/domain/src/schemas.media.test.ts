import { describe, expect, it } from 'vitest';
import { playingObject, slideMediaIds, stillFile } from './resolve.ts';
import { type Media, Play, Slide, SlideSound } from './schemas.ts';

/** Media playing in place (design/27 §3.1, §8): ImageObject.play and Slide.audio. */

const box = { x: 100, y: 100, w: 800, h: 450, rotation: 0 };
const image = (id: string, play?: unknown) => ({
  id,
  type: 'image',
  box,
  mediaId: `${id}-poster`,
  ...(play ? { play } : {}),
});

describe('Play and SlideSound', () => {
  it('parse every field', () => {
    expect(
      Play.parse({
        mediaId: 'clip',
        start: 'click',
        loop: true,
        onEnd: 'black',
        gainDb: -1.9,
        muted: true,
        showWhenStopped: false,
      }),
    ).toEqual({
      mediaId: 'clip',
      start: 'click',
      loop: true,
      onEnd: 'black',
      gainDb: -1.9,
      muted: true,
      showWhenStopped: false,
    });
    expect(SlideSound.parse({ mediaId: 'song', slides: 3, start: 'auto' })).toEqual({
      mediaId: 'song',
      slides: 3,
      start: 'auto',
    });
  });

  it('degrade enum values a later release adds instead of failing the slide', () => {
    expect(Play.parse({ mediaId: 'clip', start: 'onHover', onEnd: 'rewind' })).toEqual({
      mediaId: 'clip',
      start: 'auto',
      onEnd: 'hold',
    });
    expect(SlideSound.parse({ mediaId: 'song', start: 'withPrevious' }).start).toBe('auto');
    expect(Play.parse({ mediaId: 'clip' })).toEqual({ mediaId: 'clip' });
  });

  it('are bounded', () => {
    expect(Play.safeParse({ mediaId: 'clip', gainDb: 101 }).success).toBe(false);
    expect(Play.safeParse({ start: 'auto' }).success).toBe(false);
    expect(SlideSound.safeParse({ mediaId: 'song', slides: 0 }).success).toBe(false);
    expect(SlideSound.safeParse({ mediaId: 'song', slides: 1.5 }).success).toBe(false);
    expect(SlideSound.safeParse({ mediaId: 'song', slides: 1000 }).success).toBe(false);
  });

  it('travel on ImageObject and Slide, and a slide without them parses as before', () => {
    const s = Slide.parse({
      id: 's',
      objects: [image('a'), image('v', { mediaId: 'clip', loop: true })],
      audio: { mediaId: 'song', slides: 2 },
    });
    const v = s.objects[1]!;
    expect(v.type === 'image' && v.play).toEqual({ mediaId: 'clip', loop: true });
    expect(s.audio).toEqual({ mediaId: 'song', slides: 2 });
    const plain = Slide.parse({ id: 's', objects: [image('a')] });
    expect('play' in plain.objects[0]!).toBe(false);
    expect('audio' in plain).toBe(false);
  });
});

describe('slide media helpers', () => {
  const slide = Slide.parse({
    id: 's',
    objects: [image('a'), image('v1', { mediaId: 'clip1' }), image('v2', { mediaId: 'clip2' })],
    audio: { mediaId: 'song' },
  });

  it('play the first object with play, in z order', () => {
    expect(playingObject(slide)?.id).toBe('v1');
    expect(playingObject({ objects: [image('a')] } as never)).toBeUndefined();
  });

  it('list the media a slide plays when shown', () => {
    expect(slideMediaIds(slide)).toEqual(['clip1', 'song']);
    expect(slideMediaIds({ ...slide, audio: { mediaId: 'clip1' } })).toEqual(['clip1']);
    expect(slideMediaIds({ objects: [], audio: undefined })).toEqual([]);
  });

  it('show an image as itself and a video as its poster', () => {
    const f = (hash: string) => ({ hash, bytes: 1, mime: 'x', path: `media/${hash}` });
    const m = (over: Partial<Media>) => ({ id: 'm', original: f('orig'), ...over }) as Media;
    expect(stillFile(m({ kind: 'image' }))?.hash).toBe('orig');
    expect(stillFile(m({ kind: 'image', delivery: f('del') }))?.hash).toBe('del');
    expect(stillFile(m({ kind: 'video', delivery: f('mp4'), poster: f('jpg') }))?.hash).toBe('jpg');
    expect(stillFile(m({ kind: 'video' }))).toBeUndefined();
    expect(stillFile(m({ kind: 'audio' }))).toBeUndefined();
  });
});
