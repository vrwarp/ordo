import { describe, expect, it } from 'vitest';
import type { Media, Playlist, Presentation } from '@ordo/domain';
import {
  computePlaylistReadiness,
  duplicatePlaylistPayload,
  isPastServiceDate,
  pickDefaultPlaylist,
  sortPlaylistsUpcoming,
} from './playlists.ts';

const pl = (id: string, name: string, serviceDate?: string, items: Playlist['items'] = []): Playlist => ({
  id,
  rev: 1,
  name,
  serviceDate,
  items,
});

describe('playlists helpers', () => {
  it('sorts upcoming/today services soonest first, then past newest first, then undated', () => {
    const today = '2026-11-22';
    const input = [
      pl('u', 'Sample service'),
      pl('p1', 'Nov 08', '2026-11-08'),
      pl('f2', 'Nov 29', '2026-11-29'),
      pl('p2', 'Nov 15', '2026-11-15'),
      pl('f1', 'Today', '2026-11-22'),
    ];
    expect(sortPlaylistsUpcoming(input, today).map((p) => p.id)).toEqual(['f1', 'f2', 'p2', 'p1', 'u']);
  });

  it('pickDefaultPlaylist prefers explicit selection, else next upcoming service', () => {
    const today = '2026-11-22';
    const list = [pl('sample', 'Sample'), pl('next', 'Sunday', '2026-11-22')];
    expect(pickDefaultPlaylist(list, undefined, today)?.id).toBe('next');
    expect(pickDefaultPlaylist(list, 'sample', today)?.id).toBe('sample');
    expect(pickDefaultPlaylist(list, 'missing', today)?.id).toBe('next');
  });

  it('isPastServiceDate flags strictly past dates only', () => {
    expect(isPastServiceDate('2026-11-21', '2026-11-22')).toBe(true);
    expect(isPastServiceDate('2026-11-22', '2026-11-22')).toBe(false);
    expect(isPastServiceDate('2026-11-29', '2026-11-22')).toBe(false);
    expect(isPastServiceDate(undefined, '2026-11-22')).toBe(false);
  });

  it('duplicatePlaylistPayload clears skipped and hiddenSlides while keeping sections', () => {
    const src = pl('p1', 'Sunday', '2026-11-15', [
      {
        id: 'i1',
        kind: 'presentation',
        presentationId: 'song1',
        sections: ['s1', 's2'],
        hiddenSlides: ['sl2'],
        skipped: true,
      },
      { id: 'i2', kind: 'media', mediaId: 'm1', skipped: true },
    ]);
    const copy = duplicatePlaylistPayload(src);
    expect(copy.id).not.toBe('p1');
    expect(copy.items[0]?.id).not.toBe('i1');
    expect(copy.items[0]?.skipped).toBeUndefined();
    if (copy.items[0]?.kind === 'presentation') {
      expect(copy.items[0].sections).toEqual(['s1', 's2']);
      expect(copy.items[0].hiddenSlides).toBeUndefined();
    }
    expect(copy.items[1]?.skipped).toBeUndefined();
  });

  it('computePlaylistReadiness reports missing presentations, processing media, and unsaved drafts', () => {
    const pres: Presentation = {
      id: 'p1',
      rev: 1,
      title: 'Song 1',
      kind: 'song',
      meta: { tags: [] },
      sections: [],
      arrangements: [],
      archived: false,
    };
    const m: Media = {
      id: 'm1',
      rev: 1,
      name: 'Intro.mp4',
      tags: [],
      kind: 'video',
      original: { hash: 'h', bytes: 1, mime: 'video/mp4', path: 'x' },
      state: 'processing',
      loop: false,
      isBackground: false,
    };
    const list = pl('pl1', 'Sunday', '2026-11-22', [
      { id: 'i1', kind: 'presentation', presentationId: 'p1' },
      { id: 'i2', kind: 'presentation', presentationId: 'missing' },
      { id: 'i3', kind: 'media', mediaId: 'm1' },
    ]);
    const issues = computePlaylistReadiness(list, [pres], [m], { 'pres:p1': true });
    expect(issues.map((i) => i.text)).toEqual([
      '1 missing presentation',
      '1 media item still processing',
      '1 presentation with unsaved editor edits',
    ]);
  });
});
