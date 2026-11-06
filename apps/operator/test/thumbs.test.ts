import type { Media, Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { slideImages, stillHash } from '../src/services/thumbs.ts';

const file = (hash: string, mime: string) => ({ hash, bytes: 10, mime, path: `files/${hash}` });
const media = (id: string, m: Partial<Media>): Media => ({
  id,
  rev: 1,
  name: id,
  tags: [],
  kind: 'image',
  original: file(`${id}-orig`, 'image/png'),
  state: 'ready',
  loop: false,
  isBackground: false,
  ...m,
});
const library: Record<string, Media> = {
  photo: media('photo', {}),
  clip: media('clip', {
    kind: 'video',
    original: file('clip-orig', 'video/quicktime'),
    delivery: file('clip-mp4', 'video/mp4'),
    poster: file('clip-jpg', 'image/jpeg'),
  }),
  raw: media('raw', { kind: 'video', original: file('raw-orig', 'video/mp4') }),
  song: media('song', { kind: 'audio', original: file('song-orig', 'audio/mpeg') }),
};
const image = (id: string, mediaId: string) =>
  ({
    id,
    type: 'image',
    box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
    mediaId,
    fit: 'contain',
    opacity: 1,
    radius: 0,
  }) as const;

describe('thumbnail pictures (design/27 §8: what outputs draw)', () => {
  it('shows an image itself and a video by its poster, the same file an output draws', () => {
    expect(stillHash(library.photo)).toBe('photo-orig');
    expect(stillHash(library.clip)).toBe('clip-jpg');
    expect(stillHash(library.raw)).toBeUndefined();
    expect(stillHash(library.song)).toBeUndefined();
    expect(stillHash(undefined)).toBeUndefined();
  });

  it('maps a slide image object whose media is a video to the poster', () => {
    const slide: Slide = {
      id: 's',
      objects: [image('a', 'photo'), image('b', 'clip'), image('c', 'raw'), image('d', 'gone')],
    };
    expect(slideImages(slide, (id) => library[id])).toEqual({ photo: 'photo-orig', clip: 'clip-jpg' });
  });
});
