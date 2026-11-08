import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERAL, DEFAULT_LOOKS } from './defaults.ts';
import { type GoLiveInputs, GoLiveRejection, localDigest, resolvePlaylist } from './goLive.ts';
import { parseLyrics, songFromParsed } from './lyrics.ts';
import type { Media } from './schemas.ts';

const song = songFromParsed(parseLyrics('Verse 1\na\nb\n\nChorus\nc\nd'), { title: 'Song' });
const bg: Media = {
  id: 'bg',
  name: 'Background',
  kind: 'image',
  state: 'ready',
  original: { hash: 'a'.repeat(64), bytes: 10, mime: 'image/png' },
  tags: [],
  isBackground: true,
  loop: false,
} as unknown as Media;

const PLAYLIST = {
  id: 'pl',
  rev: 3,
  name: 'Sunday',
  items: [{ id: 'i', kind: 'presentation', presentationId: song.id, backgroundMediaId: 'bg' }],
};
const inputs = (over: Partial<GoLiveInputs> = {}): GoLiveInputs => ({
  playlist: PLAYLIST,
  presentation: (id: string) => (id === song.id ? song : undefined),
  media: (id: string) => (id === 'bg' ? bg : undefined),
  fonts: () => [],
  looks: DEFAULT_LOOKS,
  general: DEFAULT_GENERAL,
  ...over,
});

describe('resolvePlaylist (shared by the hub and the operator PC)', () => {
  it('freezes the playlist, its presentations, media and files, with the given digest', () => {
    const r = resolvePlaylist(inputs(), 'pl', { digest: localDigest });
    expect(r.playlist.rev).toBe(3);
    expect(Object.keys(r.presentations)).toEqual([song.id]);
    expect(Object.keys(r.media)).toEqual(['bg']);
    expect(r.files.map((f) => f.hash)).toEqual(['a'.repeat(64)]);
    expect(r.manifestId).toMatch(/^pc[0-9a-f]{24}$/);
    // Same inputs, same id; a playlist edit changes it.
    expect(resolvePlaylist(inputs(), 'pl', { digest: localDigest }).manifestId).toBe(r.manifestId);
    const edited = inputs({ playlist: { ...PLAYLIST, rev: 4 } });
    expect(resolvePlaylist(edited, 'pl', { digest: localDigest }).manifestId).not.toBe(r.manifestId);
  });

  it('refuses a missing playlist, a missing presentation and media that is not ready', () => {
    expect(() => resolvePlaylist(undefined, 'pl', { digest: localDigest })).toThrow(GoLiveRejection);
    expect(() =>
      resolvePlaylist(inputs({ presentation: () => undefined }), 'pl', { digest: localDigest }),
    ).toThrow(/no longer exists/);
    expect(() =>
      resolvePlaylist(inputs({ media: () => ({ ...bg, state: 'processing' }) as Media }), 'pl', {
        digest: localDigest,
      }),
    ).toThrow(/still processing/);
  });

  it('quarantines a broken slide instead of refusing the service', () => {
    const broken = { ...song, sections: [{ ...song.sections[0]!, slides: [{ id: 's1', objects: 'nope' }] }] };
    const r = resolvePlaylist(inputs({ presentation: () => broken }), 'pl', { digest: localDigest });
    expect(r.degraded?.[0]?.reason).toMatch(/invalid/);
  });
});
