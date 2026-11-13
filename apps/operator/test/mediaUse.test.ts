import type { Media, Playlist, Presentation } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  isPresentationPicture,
  mediaInUseText,
  playlistsUsing,
  presentationsUsing,
} from '../src/lib/mediaUse.ts';
import { previewMedia } from '../src/lib/preview.ts';

const pres = (id: string, title: string, slides: unknown[], extra: Partial<Presentation> = {}) =>
  ({
    id,
    rev: 1,
    title,
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: `${id}-s`, label: 'Slides', short: 'S', slides }],
    arrangements: [],
    archived: false,
    ...extra,
  }) as Presentation;
const media = (id: string, tags: string[] = []) => ({ id, name: id, tags }) as unknown as Media;

describe('media library hygiene (design/27 §11 item 15)', () => {
  it('recognises the pictures imports made for presentations', () => {
    expect(isPresentationPicture(media('a', ['pptx']))).toBe(true);
    expect(isPresentationPicture(media('b', ['document']))).toBe(true);
    expect(isPresentationPicture(media('c', ['pro7']))).toBe(false);
    expect(isPresentationPicture(media('d'))).toBe(false);
  });

  it('names the presentations that use a media item, wherever they use it', () => {
    const list = [
      pres('p1', 'Sunday', [
        { id: 's', objects: [], imported: { fileId: 'f', page: 1, imageMediaId: 'img-1' } },
      ]),
      pres('p2', 'Advent', [{ id: 's', objects: [{ id: 'o', type: 'image', mediaId: 'img-1' }] }]),
      pres('p3', 'Easter', [], { backgroundMediaId: 'img-1' }),
      pres('p4', 'Other', [{ id: 's', objects: [{ id: 'o', type: 'image', mediaId: 'img-10' }] }]),
    ];
    expect(presentationsUsing('img-1', list).map((u) => u.title)).toEqual(['Advent', 'Easter', 'Sunday']);
    expect(presentationsUsing('img-2', list)).toEqual([]);
    expect(mediaInUseText('Logo', [{ title: 'Sunday' }])).toMatch(
      /^“Logo” is used by the presentation “Sunday”\. .*Delete it anyway\?$/,
    );
    const many = Array.from({ length: 7 }, (_, i) => ({ title: `P${i}` }));
    expect(mediaInUseText('Logo', many)).toMatch(/7 presentations: “P0”, .*“P4” and 2 more\./);
  });

  it('names the playlists whose items use a media item: their media, background or music', () => {
    const pl = (id: string, name: string, items: unknown[]) => ({ id, rev: 1, name, items }) as Playlist;
    const lists = [
      pl('l1', 'Sunday', [{ id: 'i', kind: 'presentation', presentationId: 'p', audioMediaId: 'music' }]),
      pl('l2', 'Easter', [{ id: 'i', kind: 'media', mediaId: 'music' }]),
      pl('l3', 'Other', [{ id: 'i', kind: 'presentation', presentationId: 'music-2' }]),
    ];
    expect(playlistsUsing('music', lists)).toEqual([
      { id: 'l2', name: 'Easter' },
      { id: 'l1', name: 'Sunday' },
    ]);
    expect(mediaInUseText('Organ', [], [{ name: 'Sunday' }])).toBe(
      '“Organ” is used by the playlist “Sunday”. Until it is replaced they go live without it, or cannot go live. Delete it anyway?',
    );
    expect(mediaInUseText('Organ', [{ title: 'Welcome' }], [{ name: 'Sunday' }, { name: 'Easter' }])).toMatch(
      /^“Organ” is used by the presentation “Welcome” and 2 playlists: “Sunday”, “Easter”\. /,
    );
  });

  it('previews a picture slide with its page and a reference picture', () => {
    const p = pres('p', 'Deck', [
      { id: 'a', objects: [], imported: { fileId: 'f', page: 1, imageMediaId: 'page-1' } },
      {
        id: 'b',
        objects: [],
        pptx: { fileId: 'f', index: 1, class: 'native', version: 1, refMediaId: 'ref-2', show: 'picture' },
      },
      {
        id: 'c',
        objects: [],
        pptx: { fileId: 'f', index: 2, class: 'native', version: 1, refMediaId: 'ref-3' },
      },
    ]);
    const known = new Map(['page-1', 'ref-2', 'ref-3'].map((id) => [id, media(id)]));
    const ids = (slideId?: string) => previewMedia(p, slideId, (id) => known.get(id)).map((m) => m.id);
    expect(ids('a')).toEqual(['page-1']);
    expect(ids('b')).toEqual(['ref-2']);
    // The reference picture is sent only when the slide shows it.
    expect(ids('c')).toEqual([]);
    expect(ids()).toEqual(['page-1', 'ref-2']);
  });
});
