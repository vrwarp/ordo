import {
  type Box,
  type ImageObject,
  LOGICAL_HEIGHT,
  LOGICAL_WIDTH,
  type Media,
  type Play,
  playingObject,
  type Presentation,
  type Slide,
  type SlideObject,
  type SlideSound,
} from '@ordo/domain';
import { addObject, getSlide, newImage, updateSlide } from './ops.ts';

/*
 * Pure editing operations for media that plays in place (design/27 §8, §11 item 14): a video an ImageObject
 * plays in its box (`play`) and a slide's own sound (`Slide.audio`). Each returns a new presentation (or
 * slide, or object) and goes through `change()`, so every edit is one undo step and saves with the
 * presentation.
 */

/** What 'Add video to slide' plays: starts with the slide, plays once and holds its last frame. */
export function defaultPlay(mediaId: string): Play {
  return { mediaId, start: 'auto', loop: false, onEnd: 'hold' };
}

/** A video's box: its own size, scaled down to fit the slide, centred; 16:9 full slide when unknown. */
export function videoBox(m: Pick<Media, 'width' | 'height'>): Box {
  const known = !!m.width && !!m.height;
  const w0 = known ? m.width! : LOGICAL_WIDTH;
  const h0 = known ? m.height! : LOGICAL_HEIGHT;
  const s = Math.min(1, LOGICAL_WIDTH / w0, LOGICAL_HEIGHT / h0);
  const w = Math.max(1, Math.round(w0 * s));
  const h = Math.max(1, Math.round(h0 * s));
  return {
    x: Math.round((LOGICAL_WIDTH - w) / 2),
    y: Math.round((LOGICAL_HEIGHT - h) / 2),
    w,
    h,
    rotation: 0,
  };
}

/**
 * 'Add video to slide': an ImageObject showing the video's poster (its `mediaId` is the video, which every
 * drawer shows as its poster, so an older build draws the poster too) that plays the video in its box.
 */
export function newVideo(m: Pick<Media, 'id' | 'width' | 'height'>): ImageObject {
  return { ...newImage(m.id, videoBox(m)), play: defaultPlay(m.id) };
}

/**
 * Add `video` on top of the slide. `playing` is the object that already played on it, if any: a slide plays
 * one video (the first object with `play`, in z order), so the new one then shows only its poster.
 */
export function addVideo(
  p: Presentation,
  slideId: string,
  video: Pick<Media, 'id' | 'width' | 'height'>,
): { p: Presentation; id: string; playing?: ImageObject & { play: Play } } {
  const slide = getSlide(p, slideId);
  if (!slide) return { p, id: '' };
  const playing = playingObject(slide);
  const o = newVideo(video);
  return { p: addObject(p, slideId, o), id: o.id, ...(playing ? { playing } : {}) };
}

/** The play options an edit may change (the clip itself changes with `replaceVideo`). */
export type PlayPatch = Partial<Omit<Play, 'mediaId'>>;

/** `play` with `patch` applied; a key set to undefined goes back to its default (removed). */
export function patchPlay(play: Play, patch: PlayPatch): Play {
  const out: Record<string, unknown> = { ...play, ...patch };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as Play;
}

/** Change the play options of an object that plays a video; anything else is left as it is. */
export function setPlay(o: SlideObject, patch: PlayPatch): SlideObject {
  if (o.type !== 'image' || !o.play) return o;
  return { ...o, play: patchPlay(o.play, patch) };
}

/**
 * Replace the clip an object plays. The object then shows the new video's own poster: a poster taken from
 * the old clip would show a frame the new one does not have. The play options are kept.
 */
export function replaceVideo(o: SlideObject, video: Pick<Media, 'id'>): SlideObject {
  if (o.type !== 'image' || !o.play) return o;
  return { ...o, mediaId: video.id, play: { ...o.play, mediaId: video.id } };
}

/** Play the video an ImageObject already shows the poster of (a Pro7 video fill, an earlier pick). */
export function playInPlace(o: SlideObject): SlideObject {
  if (o.type !== 'image' || o.play) return o;
  return { ...o, play: defaultPlay(o.mediaId) };
}

/** 'Use poster only': the object keeps showing its poster and no longer plays. */
export function posterOnly(o: SlideObject): SlideObject {
  if (o.type !== 'image' || !o.play) return o;
  const { play: _play, ...rest } = o;
  return rest;
}

/**
 * 'Play this one instead': a slide plays one video, so every other object on the slide shows its poster
 * only and `objectId` becomes the one that plays.
 */
export function makePlaying(p: Presentation, slideId: string, objectId: string): Presentation {
  return updateSlide(p, slideId, (s) => {
    if (!s.objects.some((o) => o.id === objectId && o.type === 'image' && o.play)) return s;
    return { ...s, objects: s.objects.map((o) => (o.id === objectId ? o : posterOnly(o))) };
  });
}

// ---- the slide's own sound ----

/**
 * Choose the slide's sound. A new sound starts with the slide and plays once on this slide; replacing one
 * keeps its options.
 */
export function setSlideSound(s: Slide, sound: Pick<Media, 'id'>): Slide {
  return {
    ...s,
    audio: s.audio ? { ...s.audio, mediaId: sound.id } : { mediaId: sound.id, start: 'auto', loop: false },
  };
}

export type SoundPatch = Partial<Omit<SlideSound, 'mediaId'>>;

/**
 * Change the slide sound's options; a key set to undefined goes back to its default, and `slides` 1 (this
 * slide only) is the default.
 */
export function patchSlideSound(s: Slide, patch: SoundPatch): Slide {
  if (!s.audio) return s;
  const out: Record<string, unknown> = { ...s.audio, ...patch };
  if (out.slides === 1) delete out.slides;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return { ...s, audio: out as SlideSound };
}

export function removeSlideSound(s: Slide): Slide {
  if (!s.audio) return s;
  const { audio: _audio, ...rest } = s;
  return rest;
}
