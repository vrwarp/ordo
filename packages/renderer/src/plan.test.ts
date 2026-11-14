import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LYRIC_STYLE,
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  LOOK_STAGE,
  LOOK_STREAM,
  type Look,
  type Presentation,
  type ResolvedPlaylist,
  type Slide,
  expandCues,
} from '@ordo/domain';
import { fadeMsFor, lookSignature, planFrame, planPreview, resolveLook } from './plan.ts';
import { liveState, resolved, slideLive } from './fixtures.test-util.ts';

describe('look visibility rules', () => {
  it('main look: background video, authored slide, crossfade', () => {
    const p = planFrame(slideLive(0), LOOK_MAIN);
    expect(p.background.key).toBe('bg|bgv|d1');
    expect(p.background.desc?.kind).toBe('video');
    expect(p.slide.key).toMatch(/^sl\|m1\|look-main\|0\|s1\|$/);
    expect(p.slide.fadeMs).toBe(300);
    expect(p.slideCue).toBe(0);
    expect(p.clearColor).toEqual(LOOK_MAIN.clearColor);
  });

  it('lower-third look hides backgrounds and media, keeps song lyrics, and handles non-song slides', () => {
    const song = planFrame(slideLive(0), LOOK_LOWER_THIRD);
    expect(song.background.key).toBe('');
    expect(song.slide.key).not.toBe('');
    // With nonSong: 'text' (default), non-song slides show bottom-third text
    const talk = planFrame(slideLive(2), LOOK_LOWER_THIRD);
    expect(talk.slide.key).not.toBe('');
    expect(talk.slideCue).toBe(2);
    // With nonSong: 'none', non-song slides are dropped
    const dropLook: Look = {
      ...LOOK_LOWER_THIRD,
      layers: {
        ...LOOK_LOWER_THIRD.layers,
        slide:
          LOOK_LOWER_THIRD.layers.slide.mode === 'lyricOnly'
            ? { ...LOOK_LOWER_THIRD.layers.slide, nonSong: 'none' }
            : LOOK_LOWER_THIRD.layers.slide,
      },
    };
    const talkDropped = planFrame(slideLive(2), dropLook);
    expect(talkDropped.slide.key).toBe('');
  });

  it('lower-third look shows its holding slide instead of the background', () => {
    const look: Look = { ...LOOK_LOWER_THIRD, holdingMediaId: 'hold' };
    const p = planFrame(slideLive(0), look);
    expect(p.background.key).toBe('bg|hold|h1');
    expect(p.background.desc?.holding).toBe(true);
    const black = planFrame({ ...slideLive(0), black: true }, look);
    expect(black.background.key).toBe('');
  });

  it('stream look uses the key colour and never shows media', () => {
    const s = liveState();
    const withMedia = {
      ...s,
      layers: {
        ...s.layers,
        media: {
          content: {
            kind: 'media' as const,
            cueIndex: 4,
            mediaId: 'vid',
            mediaKind: 'video' as const,
            loop: false,
            onEnd: 'hold' as const,
            state: 'playing' as const,
            startedAt: 1000,
            positionMs: 0,
          },
          at: 1000,
          seq: 2,
        },
      },
    };
    const p = planFrame(withMedia, LOOK_STREAM);
    expect(p.clearColor).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(p.media.key).toBe('');
    // The content is kept for the audio master even though this look hides it.
    expect(p.media.desc?.key).toBe('md|4|vid|d2');
    expect(p.media.desc?.audio).toEqual({ pairId: undefined, gainDb: -3, loudnessLufs: -20 });
    const main = planFrame(withMedia, LOOK_MAIN);
    expect(main.media.key).toBe('md|4|vid|d2');
  });

  it('stage look cuts and includes the next slide in the key', () => {
    const p = planFrame(slideLive(0), LOOK_STAGE);
    expect(p.slide.fadeMs).toBe(0);
    expect(p.slide.desc?.nextSlide?.id).toBe('s2');
    expect(p.slide.key.endsWith('|s2')).toBe(true);
  });

  it('authored look draws nothing for an empty slide', () => {
    const p = planFrame(slideLive(3), LOOK_MAIN);
    expect(p.slide.key).toBe('');
    expect(p.slideCue).toBe(3);
  });

  it('lower thirds follow the look rule', () => {
    const s = { ...slideLive(0) };
    s.layers = {
      ...s.layers,
      lowerThird: { content: { kind: 'lowerThird', text: 'Pastor Sam' }, at: 5, seq: 3 },
    };
    expect(planFrame(s, LOOK_MAIN).lowerThird.key).toContain('Pastor Sam');
    expect(planFrame(s, LOOK_STAGE).lowerThird.key).toBe('');
  });

  it('idle draws only the clear colour', () => {
    const p = planFrame({ ...slideLive(0), mode: 'idle' }, LOOK_MAIN);
    expect(p.idle).toBe(true);
    expect([p.background.key, p.slide.key, p.lowerThird.key, p.media.key]).toEqual(['', '', '', '']);
  });

  it('keys change with the look signature', () => {
    const a = planFrame(slideLive(0), LOOK_MAIN, { lookSig: lookSignature(LOOK_MAIN, 1920, 1080) });
    const edited = { ...LOOK_MAIN, clearColor: { r: 1, g: 2, b: 3, a: 1 } };
    const b = planFrame(slideLive(0), edited, { lookSig: lookSignature(edited, 1920, 1080) });
    expect(a.slide.key).not.toBe(b.slide.key);
  });
});

describe('transitions', () => {
  it('cut looks always cut; otherwise the presentation override wins', () => {
    expect(fadeMsFor(LOOK_STAGE, { kind: 'crossfade', ms: 500 })).toBe(0);
    expect(fadeMsFor(LOOK_MAIN, { kind: 'crossfade', ms: 800 })).toBe(800);
    expect(fadeMsFor(LOOK_MAIN, { kind: 'cut' })).toBe(0);
    expect(fadeMsFor(LOOK_MAIN)).toBe(300);
  });
});

describe('resolveLook', () => {
  it('prefers config looks, then playlist looks, then the fallback', () => {
    const custom = { ...LOOK_MAIN, name: 'Custom main' };
    expect(resolveLook('look-main', [[custom], [LOOK_MAIN]], LOOK_STAGE).name).toBe('Custom main');
    expect(resolveLook('look-stage', [[custom], [LOOK_STAGE]], LOOK_MAIN).id).toBe('look-stage');
    expect(resolveLook('nope', [[custom]], LOOK_STAGE).id).toBe('look-stage');
  });
});

describe('send to preview (prd/03)', () => {
  const song = resolved.presentations.song!;
  const mediaLookup = (id: string) => resolved.media[id];

  it('shows the named slide under the look at once, with the background when the look shows it', () => {
    const p = planPreview(song, 's2', LOOK_MAIN, { media: mediaLookup });
    expect(p.idle).toBe(false);
    expect(p.slide.desc?.slideId).toBe('s2');
    expect(p.slide.key).toMatch(/^pv\|song\|1\|look-main\|s2\|$/);
    expect(p.slide.at).toBe(0);
    expect(p.slide.fadeMs).toBe(300);
    expect(p.slideCue).toBe(-1);
    expect(p.background.key).toBe('bg|bgv|d1');
    expect(p.media.key).toBe('');
    // A slide-level background wins over the presentation's.
    const withSlideBg = {
      ...song,
      sections: [
        { ...song.sections[0]!, slides: [{ ...song.sections[0]!.slides[0]!, backgroundMediaId: 'bgi' }] },
      ],
    };
    expect(planPreview(withSlideBg, 's1', LOOK_MAIN, { media: mediaLookup }).background.key).toBe(
      'bg|bgi|i1',
    );
  });

  it('defaults to the first slide and carries the next slide on stage looks', () => {
    const p = planPreview(song, undefined, LOOK_STAGE, { media: mediaLookup });
    expect(p.slide.desc?.slideId).toBe('s1');
    expect(p.slide.desc?.nextSlide?.id).toBe('s2');
    expect(p.slide.fadeMs).toBe(0);
    // Stage hides backgrounds and has no holding slide.
    expect(p.background.key).toBe('');
  });

  it('uses the holding slide where the look hides backgrounds, and is idle for an unknown slide', () => {
    const lobby: Look = { ...LOOK_LOWER_THIRD, holdingMediaId: 'hold' };
    const p = planPreview(song, 's1', lobby, { media: mediaLookup });
    expect(p.background.key).toBe('bg|hold|h1');
    expect(p.background.desc?.holding).toBe(true);
    expect(planPreview(song, 'nope', LOOK_MAIN).idle).toBe(true);
    // Without a media lookup the slide still renders, just without its background.
    expect(planPreview(song, 's1', LOOK_MAIN).background.key).toBe('');
  });
});

describe('the next slide skips hidden slides (design/27 §9)', () => {
  const slide = (id: string, hidden?: true): Slide => ({
    id,
    objects: [
      {
        id: `${id}-t`,
        type: 'text',
        box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
        text: id.toUpperCase(),
        style: DEFAULT_LYRIC_STYLE,
        opacity: 1,
      },
    ],
    ...(hidden ? { hidden } : {}),
  });
  const deck: Presentation = {
    id: 'deck',
    rev: 1,
    title: 'Deck',
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: 'm', label: 'Main', short: 'M', slides: [slide('a'), slide('h', true), slide('b')] }],
    arrangements: [],
    archived: false,
  };
  const r: ResolvedPlaylist = {
    ...resolved,
    playlist: { ...resolved.playlist, items: [{ id: 'i', kind: 'presentation', presentationId: 'deck' }] },
    presentations: { deck },
  };
  const showing = (i: number) => {
    const cues = expandCues(r);
    const s = liveState({ resolved: r, cues, live: i });
    return {
      ...s,
      layers: {
        ...s.layers,
        slide: {
          content: {
            kind: 'slide' as const,
            cueIndex: i,
            presentationId: 'deck',
            slideId: cues[i]!.slideId!,
          },
          at: 1000,
          seq: 1,
        },
      },
    };
  };

  it('the lyric-only next band shows the slide Next goes to', () => {
    expect(planFrame(showing(0), LOOK_STAGE).slide.desc?.nextSlide?.id).toBe('b');
    // A hidden slide a click showed is followed by the next shown one.
    expect(planFrame(showing(1), LOOK_STAGE).slide.desc?.nextSlide?.id).toBe('b');
    expect(planFrame(showing(2), LOOK_STAGE).slide.desc?.nextSlide).toBeUndefined();
  });

  it('so does the preview of a presentation', () => {
    expect(planPreview(deck, 'a', LOOK_STAGE).slide.desc?.nextSlide?.id).toBe('b');
    expect(planPreview(deck, 'h', LOOK_STAGE).slide.desc?.nextSlide?.id).toBe('b');
  });
});

describe('a Background override over slides imported on a colour (Cue.backgroundOverride)', () => {
  /** A ProPresenter song on its presentation's colour: each slide's bottom object is that colour. */
  const onColour: Presentation = {
    id: 'pro',
    rev: 1,
    title: 'Holy',
    kind: 'song',
    meta: { tags: [] },
    sections: [
      {
        id: 'v',
        label: 'Verse',
        short: 'V',
        slides: [
          {
            id: 'v1',
            objects: [
              {
                id: 'bd',
                type: 'shape',
                box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
                shape: 'rect',
                fill: { r: 20, g: 40, b: 120, a: 1 },
                opacity: 1,
                radius: 0,
                origin: { src: 'pro7', role: 'bg' },
              },
              {
                id: 'lyric',
                type: 'text',
                box: { x: 100, y: 400, w: 1720, h: 300, rotation: 0 },
                text: 'Holy, holy, holy',
                style: DEFAULT_LYRIC_STYLE,
                opacity: 1,
              },
            ],
          },
        ],
      },
    ],
    arrangements: [],
    archived: false,
  };
  const live = (override: boolean) => {
    const r: ResolvedPlaylist = {
      ...resolved,
      playlist: {
        ...resolved.playlist,
        items: [
          {
            id: 'i1',
            kind: 'presentation',
            presentationId: 'pro',
            ...(override ? { backgroundMediaId: 'bgv' } : {}),
          },
        ],
      },
      presentations: { pro: onColour },
    };
    const cues = expandCues(r);
    const base = liveState({ resolved: r, cues });
    return {
      ...base,
      live: 0,
      layers: {
        ...base.layers,
        slide: {
          content: { kind: 'slide' as const, cueIndex: 0, presentationId: 'pro', slideId: 'v1' },
          at: 1,
          seq: 1,
        },
        background: override
          ? { content: { kind: 'background' as const, mediaId: 'bgv' }, at: 1, seq: 1 }
          : base.layers.background,
      },
    };
  };
  const ids = (s: Slide | undefined) => s?.objects.map((o) => o.id);

  it('draws the slide without its backdrop over the override, as imported otherwise', () => {
    const over = planFrame(live(true), LOOK_MAIN);
    expect(over.background.desc?.mediaId).toBe('bgv');
    expect(ids(over.slide.desc?.slide)).toEqual(['lyric']);
    expect(ids(planFrame(live(false), LOOK_MAIN).slide.desc?.slide)).toEqual(['bd', 'lyric']);
    // A look that hides backgrounds keeps the slide as imported (its colour, not the look's clear colour).
    const hidden: Look = {
      ...LOOK_MAIN,
      layers: { ...LOOK_MAIN.layers, background: { ...LOOK_MAIN.layers.background, visible: false } },
    };
    expect(ids(planFrame(live(true), hidden).slide.desc?.slide)).toEqual(['bd', 'lyric']);
  });
});
