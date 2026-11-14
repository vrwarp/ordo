import { lyricSlide, type Media, type Playlist, type Presentation, type Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  FIELD_MESSAGES,
  fieldRefusalError,
  mediaPatchRefusal,
  playlistRefusal,
  presentationRefusal,
} from './capfields.ts';

const cue = { id: 'c1', channel: 2, type: 'programChange' as const, number: 5, value: 127 };
const pptx = { fileId: 'f'.repeat(64), index: 0, class: 'native' as const, version: 1 };

function deck(slides: Slide[], extra: Partial<Presentation> = {}): Presentation {
  return {
    id: 'p',
    rev: 3,
    title: 'Deck',
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: 'sec', label: 'Main', short: 'M', slides }],
    arrangements: [],
    archived: false,
    ...extra,
  };
}
const slide = (id: string, extra: Partial<Slide> = {}): Slide => ({
  ...lyricSlide('Amazing grace'),
  id,
  ...extra,
});
const words = (s: Slide, t: string): Slide => ({ ...s, notes: t });

describe('presentationRefusal (design/28 §3.2 per field)', () => {
  const stored = deck([slide('a', { midiCues: [cue] }), slide('b'), slide('c', { pptx })], {
    source: { kind: 'pptx', fileId: 'f'.repeat(64) } as Presentation['source'],
  });
  const keep = (p: Presentation) => deck(p.sections[0]!.slides, { source: p.source });
  const rows: [string, Presentation, ReturnType<typeof presentationRefusal>][] = [
    ['unchanged', keep(stored), undefined],
    [
      'words changed, cues kept',
      deck(
        stored.sections[0]!.slides.map((s) => words(s, 'x')),
        { source: stored.source },
      ),
      undefined,
    ],
    [
      'a kept slide with its cues changed',
      deck([slide('a', { midiCues: [{ ...cue, value: 1 }] }), slide('b'), slide('c', { pptx })], {
        source: stored.source,
      }),
      { field: 'midiCues', slideId: 'a' },
    ],
    [
      'a kept slide with cues added',
      deck([slide('a', { midiCues: [cue] }), slide('b', { midiCues: [cue] }), slide('c', { pptx })], {
        source: stored.source,
      }),
      { field: 'midiCues', slideId: 'b' },
    ],
    [
      'a slide with cues removed',
      deck([slide('b'), slide('c', { pptx })], { source: stored.source }),
      { field: 'midiCues', slideId: 'a' },
    ],
    [
      'a new slide with cues',
      deck([...stored.sections[0]!.slides, slide('n', { midiCues: [cue] })], { source: stored.source }),
      { field: 'midiCues', slideId: 'n' },
    ],
    [
      'a new slide without cues (absent and empty alike)',
      deck([...stored.sections[0]!.slides, slide('n'), slide('m', { midiCues: [] })], {
        source: stored.source,
      }),
      undefined,
    ],
    [
      'a pending follow-up set on a kept slide',
      deck([slide('a', { midiCues: [cue] }), slide('b'), slide('c', { pptx: { ...pptx, pending: true } })], {
        source: stored.source,
      }),
      { field: 'pptx', slideId: 'c' },
    ],
    [
      'a new slide with PowerPoint data',
      deck([...stored.sections[0]!.slides, slide('n', { pptx: { ...pptx, pending: true } })], {
        source: stored.source,
      }),
      { field: 'pptx', slideId: 'n' },
    ],
    ['the source changed', deck(stored.sections[0]!.slides), { field: 'source' }],
    [
      'a duplicate id that disagrees',
      deck([...stored.sections[0]!.slides, slide('a')], { source: stored.source }),
      { field: 'midiCues', slideId: 'a' },
    ],
  ];
  for (const [what, next, want] of rows)
    it(what, () => {
      expect(presentationRefusal(stored, next)).toEqual(want);
    });

  it('a new presentation carries no cues, no PowerPoint data and no source', () => {
    expect(presentationRefusal(undefined, deck([slide('a'), slide('b')]))).toBeUndefined();
    expect(presentationRefusal(undefined, deck([slide('a', { midiCues: [cue] })]))).toEqual({
      field: 'midiCues',
      slideId: 'a',
    });
    expect(presentationRefusal(undefined, deck([slide('a', { pptx })]))).toEqual({
      field: 'pptx',
      slideId: 'a',
    });
    expect(presentationRefusal(undefined, deck([], { source: stored.source }))).toEqual({ field: 'source' });
  });

  it('a slide’s sound and auto-advance time, and the loop timing, stay as stored (review of P0, C1)', () => {
    // Before: a light session's PUT adding a looping +100 dB slide sound and a 1 ms auto-advance answered 200.
    const sound = { mediaId: 'm1', loop: true, gainDb: 100, start: 'auto' as const };
    const base = deck([slide('a'), slide('b', { audio: { mediaId: 'm0' }, durationMs: 5000 })], {
      loop: { defaultSlideMs: 8000 },
    });
    const kept = (a: Slide, b: Slide, extra: Partial<Presentation> = {}) =>
      deck([a, b], { loop: base.loop, ...extra });
    const b0 = base.sections[0]!.slides[1]!;
    expect(presentationRefusal(base, kept(slide('a', { audio: sound }), b0))).toEqual({
      field: 'slide.audio',
      slideId: 'a',
    });
    expect(
      presentationRefusal(base, kept(slide('a'), { ...b0, audio: { mediaId: 'm0', gainDb: 6 } })),
    ).toEqual({ field: 'slide.audio', slideId: 'b' });
    expect(presentationRefusal(base, kept(slide('a', { durationMs: 1 }), b0))).toEqual({
      field: 'durationMs',
      slideId: 'a',
    });
    expect(presentationRefusal(base, kept(slide('a'), { ...b0, durationMs: undefined }))).toEqual({
      field: 'durationMs',
      slideId: 'b',
    });
    expect(presentationRefusal(base, kept(slide('a'), b0, { loop: { defaultSlideMs: 1 } }))).toEqual({
      field: 'loopTiming',
    });
    // The words of a slide with a sound and a time still change.
    expect(presentationRefusal(base, kept(words(slide('a'), 'x'), words(b0, 'y')))).toBeUndefined();
    // A new presentation or a new slide carries none of them.
    expect(presentationRefusal(undefined, deck([slide('n', { audio: sound })]))).toEqual({
      field: 'slide.audio',
      slideId: 'n',
    });
    expect(presentationRefusal(undefined, deck([slide('n', { durationMs: 3000 })]))).toEqual({
      field: 'durationMs',
      slideId: 'n',
    });
    expect(presentationRefusal(undefined, deck([], { loop: { defaultSlideMs: 1 } }))).toEqual({
      field: 'loopTiming',
    });
    for (const f of ['slide.audio', 'durationMs', 'loopTiming'] as const)
      expect(FIELD_MESSAGES[f]).toMatch(/phone/);
  });

  it('a new presentation may name a typed source without a file (the seam for P2’s new song from text)', () => {
    for (const kind of ['manual', 'paste', 'songselect'] as const)
      expect(presentationRefusal(undefined, deck([], { source: { kind } }))).toBeUndefined();
    for (const source of [
      { kind: 'paste' as const, fileId: 'f'.repeat(64) },
      { kind: 'pptx' as const },
      { kind: 'pro7' as const },
      { kind: 'manual' as const, renderer: 'libreoffice' },
      { kind: 'manual' as const, native: { version: 1, slides: 1, native: 1, hybrid: 0, picture: 0 } },
    ])
      expect(
        presentationRefusal(undefined, deck([], { source: source as Presentation['source'] })),
        JSON.stringify(source),
      ).toEqual({ field: 'source' });
    // A stored presentation's source stays as stored, typed or not.
    const typed = deck([], { source: { kind: 'paste' } });
    expect(presentationRefusal(typed, deck([], { source: { kind: 'manual' } }))).toEqual({ field: 'source' });
    expect(presentationRefusal(deck([]), deck([], { source: { kind: 'paste' } }))).toEqual({
      field: 'source',
    });
  });

  it('keys whose value is undefined count as absent', () => {
    const s = slide('c', { pptx: { ...pptx, notes: undefined } });
    expect(presentationRefusal(deck([slide('c', { pptx })]), deck([s]))).toBeUndefined();
  });
});

describe('playlistRefusal', () => {
  const timer = { kind: 'countdownTo' as const, timeOfDay: '10:00' };
  const stored: Playlist = {
    id: 'pl',
    rev: 2,
    name: 'Sunday',
    items: [
      { id: 'i1', kind: 'presentation', presentationId: 'p1', audioMediaId: 'm1', keepBackground: true },
      { id: 'i2', kind: 'media', mediaId: 'v1', loop: true },
      { id: 'i3', kind: 'action', action: 'clearAll' },
      { id: 'i4', kind: 'timer', timer: { kind: 'elapsed' } },
    ],
  };
  const with_ = (items: Playlist['items']): Playlist => ({ ...stored, items });
  const it1 = stored.items[0]!;
  const rows: [string, Playlist, ReturnType<typeof playlistRefusal>][] = [
    ['unchanged', with_(stored.items), undefined],
    ['reordered', with_([...stored.items].reverse()), undefined],
    [
      'a presentation item added bare',
      with_([
        ...stored.items,
        { id: 'n', kind: 'presentation', presentationId: 'p2', keepBackground: false },
      ]),
      undefined,
    ],
    [
      'keepBackground changed',
      with_([{ ...it1, keepBackground: false } as Playlist['items'][0], ...stored.items.slice(1)]),
      { field: 'keepBackground', itemId: 'i1' },
    ],
    [
      'the music changed',
      with_([{ ...it1, audioMediaId: 'm2' } as Playlist['items'][0], ...stored.items.slice(1)]),
      { field: 'audioMediaId', itemId: 'i1' },
    ],
    [
      'a countdown added',
      with_([
        ...stored.items,
        { id: 'n', kind: 'presentation', presentationId: 'p2', countdownTimer: timer },
      ]),
      { field: 'countdownTimer', itemId: 'n' },
    ],
    [
      'a media item stops looping',
      with_([it1, { id: 'i2', kind: 'media', mediaId: 'v1' }, ...stored.items.slice(2)]),
      { field: 'loop', itemId: 'i2' },
    ],
    [
      'a media item gets an end action',
      with_([
        it1,
        { id: 'i2', kind: 'media', mediaId: 'v1', loop: true, onEnd: 'advance' },
        ...stored.items.slice(2),
      ]),
      { field: 'onEnd', itemId: 'i2' },
    ],
    [
      'an action item removed',
      with_([it1, stored.items[1]!, stored.items[3]!]),
      { field: 'item.action', itemId: 'i3' },
    ],
    [
      'a timer item changed',
      with_([...stored.items.slice(0, 3), { id: 'i4', kind: 'timer', timer }]),
      { field: 'item.timer', itemId: 'i4' },
    ],
    [
      'an action item added',
      with_([...stored.items, { id: 'n', kind: 'action', action: 'clearAll' }]),
      { field: 'item.action', itemId: 'n' },
    ],
    [
      'a presentation item removed (the plan changes, not show control)',
      with_(stored.items.slice(1)),
      undefined,
    ],
  ];
  for (const [what, next, want] of rows)
    it(what, () => {
      expect(playlistRefusal(stored, next)).toEqual(want);
    });
});

describe('mediaPatchRefusal', () => {
  const cur = { id: 'm', loop: false, isBackground: true, audio: { gainDb: -3 } } as unknown as Media;
  it('name and tags only; playback fields as stored', () => {
    expect(mediaPatchRefusal(cur, { ...cur, name: 'x', tags: ['a'] })).toBeUndefined();
    expect(mediaPatchRefusal(cur, { ...cur, loop: true })).toEqual({ field: 'loop' });
    expect(mediaPatchRefusal(cur, { ...cur, isBackground: false })).toEqual({ field: 'isBackground' });
    expect(mediaPatchRefusal(cur, { ...cur, audio: { gainDb: 0 } } as Media)).toEqual({ field: 'audio' });
    expect(
      mediaPatchRefusal(cur, { ...cur, audio: { gainDb: -3, pairId: undefined } } as Media),
    ).toBeUndefined();
  });
});

describe('the refusal', () => {
  it('is 403 cap with the field, the id and a message the phone shows', () => {
    const e = fieldRefusalError({ field: 'midiCues', slideId: 's1' });
    expect(e.status).toBe(403);
    expect(e.code).toBe('cap');
    expect(e.message).toBe("A phone can't change a slide's lighting (MIDI) cues.");
    expect(e.extra).toEqual({ field: 'midiCues', slideId: 's1' });
    for (const m of Object.values(FIELD_MESSAGES)) expect(m).toMatch(/^A phone can't /);
  });
});
