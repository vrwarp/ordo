import {
  LOOK_LOWER_THIRD,
  LOOK_MAIN,
  LOOK_STAGE,
  LOOK_STREAM,
  type Look,
  type ResolvedPlaylist,
} from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { clipLive, cueOf, withClips } from './fixtures.scene.test-util.ts';
import { media } from './fixtures.test-util.ts';
import { planFrame } from './plan.ts';

/**
 * The planner's half of a clip playing inside its slide (design/27 §7.2 "Arming and slot ownership"): the
 * media desc is marked `inSlide` and the slide desc carries the video only when the look draws authored
 * slides and the slide layer shows the clip's own cue. The reducer's side (item A) is built by hand here.
 */

const hiddenSlides: Look = {
  ...LOOK_MAIN,
  id: 'hidden',
  layers: { ...LOOK_MAIN.layers, slide: { mode: 'hidden' } },
};

describe('planner: a clip playing inside its slide', () => {
  it('marks the media desc inSlide, keeps it for transport and audio, and gives the slide its video', () => {
    const i = cueOf('c1');
    const p = planFrame(clipLive('c1'), LOOK_MAIN);
    // The media layer draws nothing; its desc is kept under the usual key for arming and transport.
    expect(p.media.key).toBe('');
    expect(p.media.desc).toMatchObject({
      key: `md|${i}|vid|d2`,
      cueIndex: i,
      kind: 'video',
      state: 'playing',
      startedAt: 1000,
      inSlide: { objectId: 'v1' },
      audio: { gainDb: -3, loudnessLufs: -20 },
    });
    expect(p.media.desc?.inSlide?.showWhenStopped).toBeUndefined();
    expect(p.slide.desc?.video).toEqual({ objectId: 'v1', mediaId: 'vid', hash: 'd2' });
    // The slide keeps its key: the scene is the same content as the slide drawn with its poster.
    const still = planFrame(clipLive('c1', null), LOOK_MAIN);
    expect(still.slide.desc?.video).toBeUndefined();
    expect(p.slide.key).toBe(still.slide.key);
    expect(p.slide.key).not.toBe('');
    // The clamped slide the asset worker draws still has the object's play.
    const o = p.slide.desc?.slide.objects.find((x) => x.id === 'v1');
    expect(o?.type === 'image' ? o.play?.mediaId : undefined).toBe('vid');
  });

  it("carries the object's 'Hide while not playing'", () => {
    const p = planFrame(clipLive('c2', { state: 'paused' }), LOOK_MAIN);
    expect(p.media.desc?.inSlide).toEqual({ objectId: 'v2', showWhenStopped: false });
    expect(p.media.desc?.state).toBe('paused');
    expect(p.slide.desc?.video).toEqual({ objectId: 'v2', mediaId: 'vid2', hash: 'd3' });
  });

  it('plays in the slide even where the look hides the media layer: only the slide mode decides', () => {
    const look: Look = {
      ...LOOK_MAIN,
      id: 'no-media',
      layers: { ...LOOK_MAIN.layers, media: { visible: false } },
    };
    const p = planFrame(clipLive('c1'), look);
    expect(p.media.desc?.inSlide).toEqual({ objectId: 'v1' });
    expect(p.slide.desc?.video?.objectId).toBe('v1');
  });

  it('in lyric-only and hidden slide modes nothing draws the clip; the desc stays for the audio master', () => {
    for (const look of [LOOK_STAGE, LOOK_LOWER_THIRD, LOOK_STREAM, hiddenSlides]) {
      const p = planFrame(clipLive('c1'), look);
      expect(p.media.key).toBe('');
      expect(p.media.desc?.key).toBe(`md|${cueOf('c1')}|vid|d2`);
      expect(p.media.desc?.inSlide).toBeUndefined();
      expect(p.slide.desc?.video).toBeUndefined();
    }
  });

  it('is not inSlide when the slide layer shows another cue, the object is gone, or plays something else', () => {
    // The slide layer shows c3 while c1's clip is on the media layer.
    const other = planFrame(clipLive('c1', {}, { slideOnLayer: 'c3' }), LOOK_MAIN);
    expect(other.media.key).toBe('');
    expect(other.media.desc?.inSlide).toBeUndefined();
    expect(other.slide.desc?.video).toBeUndefined();
    // The media content names an object the slide does not have, or one playing another clip.
    for (const m of [{ objectId: 'nope' }, { objectId: 'title' }, { mediaId: 'bgv', objectId: 'v1' }]) {
      const p = planFrame(clipLive('c1', m), LOOK_MAIN);
      expect(p.media.key).toBe('');
      expect(p.media.desc?.inSlide).toBeUndefined();
      expect(p.slide.desc?.video).toBeUndefined();
    }
  });

  it('a media content without objectId (a playlist media cue) is planned as before', () => {
    const p = planFrame(clipLive('c1', { objectId: undefined }), LOOK_MAIN);
    expect(p.media.key).toBe(`md|${cueOf('c1')}|vid|d2`);
    expect(p.media.desc?.inSlide).toBeUndefined();
    expect(p.slide.desc?.video).toBeUndefined();
    expect(planFrame(clipLive('c1', { objectId: undefined }), LOOK_STREAM).media.key).toBe('');
  });

  it('an image media or a video without a delivery is never inSlide', () => {
    const img = planFrame(clipLive('c1', { mediaId: 'hold', mediaKind: 'image' }), LOOK_MAIN);
    expect(img.media.desc?.inSlide).toBeUndefined();
    const noDelivery: ResolvedPlaylist = {
      ...withClips,
      media: { ...media, vid: { ...media.vid!, delivery: undefined } },
    };
    const p = planFrame({ ...clipLive('c1'), resolved: noDelivery }, LOOK_MAIN);
    expect(p.media.desc).toBeNull();
    expect(p.slide.desc?.video).toBeUndefined();
  });
});
