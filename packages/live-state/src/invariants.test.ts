import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type LiveEvent,
  type Presentation,
  type ResolvedPlaylist,
  parseLyrics,
  songFromParsed,
} from '@ordo/domain';
import { checkInvariants } from './invariants.ts';
import { initialState, reduce } from './index.ts';

function resolved(): ResolvedPlaylist {
  const a: Presentation = {
    ...songFromParsed(parseLyrics('Verse 1\na b\n\nChorus\nc d')),
    backgroundMediaId: 'bg',
  };
  const f = { hash: 'h', bytes: 1, mime: 'x', path: 'p' };
  const media = (id: string, kind: 'video' | 'audio' | 'image') => ({
    id,
    rev: 1,
    name: id,
    tags: [],
    kind,
    original: f,
    state: 'ready' as const,
    loop: false,
    isBackground: false,
  });
  return {
    playlist: {
      id: 'pl',
      rev: 1,
      name: 'x',
      items: [
        { id: 'i0', kind: 'presentation', presentationId: a.id },
        { id: 'i1', kind: 'media', mediaId: 'vid', onEnd: 'advance' },
        { id: 'i2', kind: 'timer', timer: { kind: 'countdownTo', timeOfDay: '10:00' } },
        { id: 'i3', kind: 'media', mediaId: 'aud' },
        { id: 'i4', kind: 'action', action: 'clearAll' },
      ],
    },
    presentations: { [a.id]: a },
    media: { bg: media('bg', 'image'), vid: media('vid', 'video'), aud: media('aud', 'audio') },
    fonts: [],
    looks: [],
    files: [],
    manifestId: 'm',
  };
}

const at = fc.integer({ min: 0, max: 1e7 });
const ev: fc.Arbitrary<LiveEvent> = fc.oneof(
  at.map((a) => ({ k: 'next' as const, at: a })),
  at.map((a) => ({ k: 'prev' as const, at: a })),
  fc.record({ cueIndex: fc.integer({ min: 0, max: 8 }), at }).map((r) => ({ k: 'go' as const, ...r })),
  fc.record({ cueIndex: fc.integer({ min: 0, max: 8 }) }).map((r) => ({ k: 'select' as const, ...r })),
  fc
    .constantFrom('slide', 'lowerThird', 'props', 'media', 'background', 'audio', 'all')
    .map((layer) => ({ k: 'clear' as const, layer, at: 5 })),
  fc
    .record({ cueIndex: fc.integer({ min: 0, max: 8 }), at })
    .map((r) => ({ k: 'media.ended' as const, ...r })),
  fc
    .record({ cueIndex: fc.integer({ min: 0, max: 8 }), at })
    .map((r) => ({ k: 'audio.ended' as const, ...r })),
  at.map((a) => ({ k: 'media.play' as const, at: a })),
  at.map((a) => ({ k: 'nextItem' as const, at: a })),
  at.map((a) => ({ k: 'prevItem' as const, at: a })),
  fc
    .record({ sectionIndex: fc.integer({ min: 0, max: 4 }), at })
    .map((r) => ({ k: 'goToSection' as const, ...r })),
  fc
    .record({ id: fc.string({ minLength: 1, maxLength: 4 }), text: fc.string({ maxLength: 20 }), at })
    .map((r) => ({ k: 'message.send' as const, ...r })),
  at.map((a) => ({ k: 'logo' as const, at: a })),
  at.map((a) => ({ k: 'endService' as const, at: a })),
);

describe('live-state invariants', () => {
  it('hold for the initial state and after goLive', () => {
    expect(checkInvariants(initialState())).toEqual([]);
    expect(checkInvariants(reduce(initialState(), { k: 'goLive', resolved: resolved() }))).toEqual([]);
  });

  it('hold after any sequence of events (property)', () => {
    const r = resolved();
    fc.assert(
      fc.property(fc.array(ev, { maxLength: 80 }), (events) => {
        let s = reduce(initialState(), { k: 'goLive', resolved: r });
        for (const e of events) {
          s = reduce(s, e.k === 'endService' ? e : e);
          if (e.k === 'endService') s = reduce(s, { k: 'goLive', resolved: r });
          const v = checkInvariants(s);
          if (v.length) throw new Error(`${e.k}: ${v.join('; ')}`);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('reports corrupt states without throwing', () => {
    const s = reduce(initialState(), { k: 'goLive', resolved: resolved() });
    expect(checkInvariants({ ...s, live: 99 })).toEqual([expect.stringContaining('live 99 out of range')]);
    expect(checkInvariants({ ...s, cues: null } as never)).toEqual(['cues is not an array']);
    expect(checkInvariants(null as never)[0]).toMatch(/threw/);
  });
});
