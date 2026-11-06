import { describe, expect, it } from 'vitest';
import {
  type Cue,
  DEFAULT_GENERAL,
  DEFAULT_LOOKS,
  FAILED_SLIDE_REASON,
  localDigest,
  PENDING_SLIDE_REASON,
  type ResolvedPlaylist,
  resolvePlaylist,
} from '@ordo/domain';
import { degradedKey, summarizeDegraded } from '../src/lib/degraded.ts';

const cues = [
  { index: 0, itemId: 'i', itemIndex: 0, kind: 'slide', label: 'Amazing grace', sectionLabel: 'Verse 1' },
  { index: 1, itemId: 'i', itemIndex: 0, kind: 'slide', label: 'How sweet' },
] as Cue[];
const resolved = (degraded?: ResolvedPlaylist['degraded']) =>
  ({ manifestId: 'm1', degraded }) as ResolvedPlaylist;

describe('degraded summary', () => {
  it('is empty when nothing was quarantined', () => {
    expect(summarizeDegraded(resolved(), cues)).toEqual({ service: [], cues: [] });
    expect(degradedKey(resolved())).toBe('');
    expect(degradedKey(undefined)).toBe('');
  });

  it('separates service warnings from slides, collapses duplicates, labels cues', () => {
    const r = resolved([
      { cueIndex: 1, reason: 'bad box' },
      { cueIndex: -1, reason: 'cached copy from 09:12 UTC' },
      { cueIndex: -1, reason: 'cached copy from 09:12 UTC' },
      { cueIndex: 0, reason: 'bad text' },
      { cueIndex: 9, reason: 'unknown cue' },
    ]);
    const s = summarizeDegraded(r, cues);
    expect(s.service).toEqual(['cached copy from 09:12 UTC']);
    expect(s.cues.map((c) => c.label)).toEqual(['Verse 1: Amazing grace', 'How sweet', 'cue 10']);
    expect(degradedKey(r)).toBe('m1:5');
  });

  it('tells an empty slide from one waiting for its media or for LibreOffice (design/27 §5, §8)', () => {
    const r = resolved([
      { cueIndex: 0, reason: '"Deck" Verse slide 2 is invalid (objects.0.box: Required); shown empty' },
      {
        cueIndex: 1,
        reason:
          '"Announcements – slide 1 video" (slide video) is still processing; showing its poster; Go live again once it is ready',
      },
      { cueIndex: 1, reason: '"Loop" (slide background) failed; the slide shows without it' },
      { cueIndex: 0, reason: PENDING_SLIDE_REASON },
      { cueIndex: 1, reason: FAILED_SLIDE_REASON },
      { cueIndex: 0, reason: '"Deck" is damaged (title: Required); its settings were reset' },
    ]);
    expect(summarizeDegraded(r, cues).cues.map((c) => c.kind)).toEqual([
      'empty',
      'drawing',
      'other',
      'media',
      'media',
      'drawing',
    ]);
  });

  it('every slide reason goLive writes for an imported deck has its kind', () => {
    const slide = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      objects: [
        {
          id: `${id}-o`,
          type: 'image',
          box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
          mediaId: 'poster',
          fit: 'contain',
          opacity: 1,
          radius: 0,
          ...(id === 'a' ? { play: { mediaId: 'clip' } } : {}),
        },
      ],
      pptx: { fileId: 'deck', index: 0, class: 'native', version: 1 },
      ...over,
    });
    const file = { hash: 'a'.repeat(64), bytes: 1, mime: 'image/png', path: 'p' };
    const m = (id: string, kind: string, state: string) => ({
      id,
      rev: 1,
      name: id,
      tags: [],
      kind,
      original: file,
      ...(state === 'ready' ? { delivery: file } : {}),
      state,
      loop: false,
      isBackground: false,
    });
    const media: Record<string, unknown> = {
      poster: m('poster', 'image', 'ready'),
      clip: m('clip', 'video', 'processing'),
      bg: m('bg', 'video', 'failed'),
    };
    const p = {
      id: 'd',
      rev: 1,
      title: 'Deck',
      kind: 'slides',
      meta: { tags: [] },
      sections: [
        {
          id: 's',
          label: 'S',
          short: 'S',
          slides: [
            slide('a'),
            slide('b', { backgroundMediaId: 'bg' }),
            slide('c', { pptx: { fileId: 'deck', index: 2, class: 'hybrid', version: 1, pending: true } }),
            { id: 'x', objects: [{ id: 'bad', type: 'image' }] },
          ],
        },
      ],
      arrangements: [],
      archived: false,
    };
    const r = resolvePlaylist(
      {
        playlist: {
          id: 'pl',
          rev: 1,
          name: 'Sunday',
          items: [{ id: 'i', kind: 'presentation', presentationId: 'd' }],
        },
        presentation: () => p,
        media: (id) => media[id] as never,
        fonts: () => [],
        looks: DEFAULT_LOOKS,
        general: DEFAULT_GENERAL,
      },
      'pl',
      { digest: localDigest },
    );
    const kinds = summarizeDegraded(r, []).cues.map((c) => [c.cueIndex, c.kind]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        [0, 'media'],
        [1, 'media'],
        [2, 'drawing'],
        [3, 'empty'],
      ]),
    );
    expect(kinds.every(([, k]) => k !== 'other')).toBe(true);
  });

  it('caps the cue list for display', () => {
    const r = resolved(Array.from({ length: 50 }, (_, i) => ({ cueIndex: i, reason: 'x' })));
    expect(summarizeDegraded(r, [], 20).cues).toHaveLength(20);
  });
});
