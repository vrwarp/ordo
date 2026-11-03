import { describe, expect, it } from 'vitest';
import { LOOK_LOWER_THIRD, LOOK_MAIN, LOOK_STAGE, LOOK_STREAM, type Look } from '@ordo/domain';
import { fadeMsFor, lookSignature, planFrame, resolveLook } from './plan.ts';
import { liveState, slideLive } from './fixtures.test-util.ts';

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

  it('lower-third look hides backgrounds and media, keeps song lyrics, drops non-song slides', () => {
    const song = planFrame(slideLive(0), LOOK_LOWER_THIRD);
    expect(song.background.key).toBe('');
    expect(song.slide.key).not.toBe('');
    const talk = planFrame(slideLive(2), LOOK_LOWER_THIRD);
    expect(talk.slide.key).toBe('');
    expect(talk.slideCue).toBe(2);
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
    s.layers = { ...s.layers, lowerThird: { content: { kind: 'lowerThird', text: 'Pastor Sam' }, at: 5, seq: 3 } };
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
