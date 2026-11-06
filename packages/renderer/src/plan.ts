import {
  type LiveState,
  type Look,
  type Media,
  type MediaContent,
  type MediaOnEnd,
  type Presentation,
  type Rgba,
  type Slide,
  type Transition,
  playableFile,
} from '@ordo/domain';
import { clampLook, clampSlide, clampText } from './clamp.ts';
import { drawableContent } from './content.ts';
import { lyricTextFor } from './text2d.ts';

/**
 * What each layer of an output shows for a live state under a look. Pure: the output's main thread runs
 * it for the live state and for the state that a GO to the armed cue would produce, and arms the keys.
 * A key identifies prepared content; '' means the layer is empty.
 */

export type BackgroundDesc = {
  layer: 'background';
  key: string;
  mediaId: string;
  hash: string;
  mime: string;
  kind: 'image' | 'video';
  holding: boolean;
};

export type SlideDesc = {
  layer: 'slide';
  key: string;
  cueIndex: number;
  presentationId: string;
  slideId: string;
  slide: Slide;
  nextSlide?: Slide;
  isSong: boolean;
  /**
   * The slide's video plays in place, in the box of ImageObject `objectId` (design/27 §7.2): set when the
   * media layer's desc is `inSlide` for this slide. `w` x `h` is the clip's delivered size (Media.width,
   * height) when known: the plane fits the video with it, never with the poster's. The hub delivers square
   * pixels (anamorphic sources resampled at ingest), so it is the shape on screen.
   */
  video?: { objectId: string; mediaId: string; hash: string; w?: number; h?: number };
};

export type LowerThirdDesc = { layer: 'lowerThird'; key: string; text: string };

export type MediaDesc = {
  layer: 'media';
  key: string;
  cueIndex: number;
  mediaId: string;
  hash: string;
  mime: string;
  kind: 'image' | 'video';
  loop: boolean;
  onEnd: MediaOnEnd;
  state: 'playing' | 'paused' | 'ended';
  startedAt: number;
  positionMs: number;
  durationMs?: number;
  audio: { pairId?: string; gainDb?: number; loudnessLufs?: number };
  /**
   * The video plays inside the live slide, in ImageObject `objectId` (design/27 §7.2). The media layer's
   * key is then '' (the slide layer draws it as a scene) and this desc is kept for arming, transport,
   * audio and `media.ended`. `showWhenStopped: false` is the object's "Hide while not playing": no frame
   * of the clip shows while the reducer's state is not 'playing' (and its poster is not in the base).
   */
  inSlide?: { objectId: string; showWhenStopped?: false };
};

export type AudioDesc = {
  key: string;
  cueIndex: number;
  mediaId: string;
  hash: string;
  mime: string;
  loop: boolean;
  state: 'playing' | 'paused' | 'ended';
  startedAt: number;
  positionMs: number;
  audio: { pairId?: string; gainDb?: number; loudnessLufs?: number };
};

export type LayerPlan<D> = {
  /** Render key ('' when the layer draws nothing on this output). */
  key: string;
  /** The content, kept even when invisible (the audio master still plays a hidden media video). */
  desc: D | null;
  /** Hub ms at which the content takes effect. */
  at: number;
  /** Crossfade duration, 0 for a cut. */
  fadeMs: number;
};

export type FramePlan = {
  idle: boolean;
  black: boolean;
  clearColor: Rgba;
  background: LayerPlan<BackgroundDesc>;
  slide: LayerPlan<SlideDesc>;
  lowerThird: LayerPlan<LowerThirdDesc>;
  media: LayerPlan<MediaDesc>;
  audio: LayerPlan<AudioDesc>;
  /** Cue index of the slide on the slide layer (even if this look hides it), -1 if none. */
  slideCue: number;
};

export type PlanOptions = {
  /** Changes whenever the look's content changes, so keys (and cached rasters) follow look edits. */
  lookSig?: string;
  /** Extra media not in the resolved playlist (e.g. the logo or a holding slide from the output config). */
  media?: (id: string) => Media | undefined;
};

/** The crossfade duration a look uses for a layer change; looks with a cut transition always cut. */
export function fadeMsFor(look: Look, transition?: Transition): number {
  if (look.transition.kind === 'cut') return 0;
  const t = transition ?? look.transition;
  return t.kind === 'crossfade' ? t.ms : 0;
}

export function findSlide(
  presentations: Record<string, Presentation> | undefined,
  presentationId: string,
  slideId: string,
): { slide: Slide; presentation: Presentation } | undefined {
  const p = presentations?.[presentationId];
  if (!p || !Array.isArray(p.sections)) return undefined;
  for (const sec of p.sections) {
    if (!sec || !Array.isArray(sec.slides)) continue;
    for (const slide of sec.slides) if (slide && slide.id === slideId) return { slide, presentation: p };
  }
  return undefined;
}

/** A stable signature of a look's rendering-relevant content. */
export function lookSignature(look: Look, width = 0, height = 0): string {
  const s = JSON.stringify(look);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${look.id}.${(h >>> 0).toString(36)}.${width}x${height}`;
}

/**
 * Whether the look draws anything on the slide layer for this slide: as authored, its picture or objects
 * (`slideContent`, design/27 §5).
 */
export function slideVisible(look: Look, slide: Slide, isSong: boolean, nextSlide?: Slide): boolean {
  const rule = look.layers.slide;
  if (rule.mode === 'hidden') return false;
  if (rule.mode === 'authored') {
    const drawn = drawableContent(slide);
    return drawn.objects.length > 0 || !!drawn.pictureMediaId;
  }
  if (lyricTextFor(slide, look, isSong) !== null) return true;
  return !!(rule.nextSlide && nextSlide && lyricTextFor(nextSlide, look, isSong) !== null);
}

const EMPTY = <D>(at = 0): LayerPlan<D> => ({ key: '', desc: null, at, fadeMs: 0 });

/**
 * Whether a slide's own clip (media content with `objectId`) plays inside the slide this output draws
 * (design/27 §7.2 "Arming and slot ownership"): the look draws authored slides, the slide layer shows the
 * clip's own cue, and that slide still draws the playing ImageObject. Otherwise (lyric-only or hidden slide
 * modes, another slide on the slide layer, an imported object under the slide's PowerPoint picture) nothing
 * draws the clip.
 */
function inSlideFor(
  c: MediaContent,
  m: Media,
  slide: SlideDesc | null,
  look: Look,
): MediaDesc['inSlide'] | undefined {
  if (!c.objectId || look.layers.slide.mode !== 'authored') return undefined;
  if (c.mediaKind !== 'video' || m.kind !== 'video') return undefined;
  if (!slide || slide.cueIndex !== c.cueIndex) return undefined;
  const o = drawableContent(slide.slide).objects.find((x) => x.id === c.objectId);
  if (o?.type !== 'image' || !o.play || o.play.mediaId !== c.mediaId) return undefined;
  return o.play.showWhenStopped === false ? { objectId: o.id, showWhenStopped: false } : { objectId: o.id };
}

/**
 * Plan every layer of `state` under `look`. Slides and looks are clamped on the way in (design/25): the
 * descriptors carry clamped copies, so nothing unbounded reaches the rasterizer. Never throws.
 */
export function planFrame(state: LiveState, rawLook: Look, opts: PlanOptions = {}): FramePlan {
  const look = clampLook(rawLook);
  const sig = opts.lookSig ?? look.id;
  const resolved = state.resolved;
  const mediaById = (id: string | undefined): Media | undefined =>
    id ? (resolved?.media[id] ?? opts.media?.(id)) : undefined;
  const plan: FramePlan = {
    idle: state.mode !== 'live',
    black: state.black,
    clearColor: look.clearColor,
    background: EMPTY(state.layers.background.at),
    slide: EMPTY(state.layers.slide.at),
    lowerThird: EMPTY(state.layers.lowerThird.at),
    media: EMPTY(state.layers.media.at),
    audio: EMPTY(state.audio.at),
    slideCue: -1,
  };
  if (plan.idle) return plan;

  // Background: the cue's background when the look shows backgrounds, else the look's holding slide.
  {
    const ls = state.layers.background;
    const fadeMs = fadeMsFor(look, ls.transition);
    let mediaId: string | undefined;
    let holding = false;
    if (look.layers.background.visible) mediaId = ls.content?.mediaId;
    else if (look.holdingMediaId && !state.black) {
      mediaId = look.holdingMediaId;
      holding = true;
    }
    const m = mediaById(mediaId);
    const f = m ? playableFile(m) : undefined;
    if (m && f && (m.kind === 'image' || m.kind === 'video')) {
      plan.background = {
        key: `bg|${m.id}|${f.hash}`,
        desc: {
          layer: 'background',
          key: `bg|${m.id}|${f.hash}`,
          mediaId: m.id,
          hash: f.hash,
          mime: f.mime,
          kind: m.kind,
          holding,
        },
        at: holding ? 0 : ls.at,
        fadeMs,
      };
    } else plan.background = { key: '', desc: null, at: ls.at, fadeMs };
  }

  // Slide
  {
    const ls = state.layers.slide;
    const fadeMs = fadeMsFor(look, ls.transition);
    plan.slide = { key: '', desc: null, at: ls.at, fadeMs };
    const c = ls.content;
    const raw = c ? findSlide(resolved?.presentations, c.presentationId, c.slideId) : undefined;
    const found = raw ? { slide: clampSlide(raw.slide), presentation: raw.presentation } : undefined;
    if (c && found) {
      plan.slideCue = c.cueIndex;
      const isSong = found.presentation.kind === 'song';
      let nextSlide: Slide | undefined;
      if (look.layers.slide.mode === 'lyricOnly' && look.layers.slide.nextSlide) {
        const nc = state.cues[c.cueIndex + 1];
        if (nc?.kind === 'slide' && nc.presentationId && nc.slideId) {
          const ns = findSlide(resolved?.presentations, nc.presentationId, nc.slideId)?.slide;
          nextSlide = ns ? clampSlide(ns) : undefined;
        }
      }
      if (slideVisible(look, found.slide, isSong, nextSlide)) {
        const key = `sl|${resolved?.manifestId ?? ''}|${sig}|${c.cueIndex}|${c.slideId}|${nextSlide?.id ?? ''}`;
        plan.slide = {
          key,
          desc: {
            layer: 'slide',
            key,
            cueIndex: c.cueIndex,
            presentationId: c.presentationId,
            slideId: c.slideId,
            slide: found.slide,
            nextSlide,
            isSong,
          },
          at: ls.at,
          fadeMs,
        };
      }
    }
  }

  // Lower third
  {
    const ls = state.layers.lowerThird;
    const fadeMs = fadeMsFor(look, ls.transition);
    const text = clampText(ls.content?.text);
    if (look.layers.lowerThird.visible && text.trim()) {
      const key = `lt|${sig}|${text}`;
      plan.lowerThird = { key, desc: { layer: 'lowerThird', key, text }, at: ls.at, fadeMs };
    } else plan.lowerThird = { key: '', desc: null, at: ls.at, fadeMs };
  }

  // Media (kept for audio even when the look hides it)
  {
    const ls = state.layers.media;
    const fadeMs = fadeMsFor(look, ls.transition);
    const c = ls.content;
    const m = mediaById(c?.mediaId);
    const f = m ? playableFile(m) : undefined;
    plan.media = { key: '', desc: null, at: ls.at, fadeMs };
    if (c && m && f) {
      const cue = state.cues[c.cueIndex];
      const key = `md|${c.cueIndex}|${m.id}|${f.hash}`;
      const inSlide = c.objectId ? inSlideFor(c, m, plan.slide.desc, look) : undefined;
      if (inSlide && plan.slide.desc) {
        const size = (m.width ?? 0) > 0 && (m.height ?? 0) > 0 ? { w: m.width, h: m.height } : {};
        plan.slide.desc.video = { objectId: inSlide.objectId, mediaId: m.id, hash: f.hash, ...size };
      }
      plan.media = {
        // A slide's own clip never draws full-frame on the media layer: the slide layer plays it in its box
        // (inSlide), or, in lyric-only and hidden slide modes, nothing draws it and the audio master plays
        // its sound as for a media layer this look hides.
        key: look.layers.media.visible && !c.objectId ? key : '',
        desc: {
          layer: 'media',
          key,
          cueIndex: c.cueIndex,
          mediaId: m.id,
          hash: f.hash,
          mime: f.mime,
          kind: c.mediaKind,
          loop: c.loop,
          onEnd: c.onEnd,
          state: c.state,
          startedAt: c.startedAt,
          positionMs: c.positionMs,
          durationMs: m.durationMs,
          audio: {
            pairId: cue?.audio?.pairId ?? m.audio?.pairId,
            gainDb: cue?.audio?.gainDb ?? m.audio?.gainDb,
            loudnessLufs: m.audio?.loudnessLufs,
          },
          ...(inSlide ? { inSlide } : {}),
        },
        at: ls.at,
        fadeMs,
      };
    }
  }

  // Audio cue (rendered by nothing; the audio master plays it)
  {
    const a = state.audio.content;
    const m = mediaById(a?.mediaId);
    const f = m ? playableFile(m) : undefined;
    if (a && m && f) {
      const key = `au|${a.cueIndex}|${m.id}|${f.hash}`;
      plan.audio = {
        key,
        desc: {
          key,
          cueIndex: a.cueIndex,
          mediaId: m.id,
          hash: f.hash,
          mime: f.mime,
          loop: a.loop,
          state: a.state,
          startedAt: a.startedAt,
          positionMs: a.positionMs,
          audio: {
            pairId: a.pairId ?? m.audio?.pairId,
            gainDb: a.gainDb ?? m.audio?.gainDb,
            loudnessLufs: m.audio?.loudnessLufs,
          },
        },
        at: state.audio.at,
        fadeMs: 0,
      };
    }
  }
  return plan;
}

/**
 * The frame an idle output shows for "Send to preview" (prd/03): the presentation's slide (the first one
 * when `slideId` is not given) under this output's look, with the presentation's background when the
 * look shows backgrounds and the media is known, else the look's holding slide. Takes effect at once.
 */
export function planPreview(
  presentation: Presentation,
  slideId: string | undefined,
  rawLook: Look,
  opts: PlanOptions = {},
): FramePlan {
  const look = clampLook(rawLook);
  const sig = opts.lookSig ?? look.id;
  const slides: Slide[] = [];
  const sections = Array.isArray(presentation?.sections) ? presentation.sections : [];
  for (const sec of sections)
    if (Array.isArray(sec?.slides)) for (const s of sec.slides) if (s) slides.push(s);
  const idx = slideId ? slides.findIndex((s) => s.id === slideId) : 0;
  const rawSlide = idx >= 0 ? slides[idx] : undefined;
  const slide = rawSlide ? clampSlide(rawSlide) : undefined;
  const fadeMs = fadeMsFor(look);
  const plan: FramePlan = {
    idle: false,
    black: false,
    clearColor: look.clearColor,
    background: EMPTY(0),
    slide: EMPTY(0),
    lowerThird: EMPTY(0),
    media: EMPTY(0),
    audio: EMPTY(0),
    slideCue: -1,
  };
  if (!slide) return { ...plan, idle: true };
  const isSong = presentation.kind === 'song';
  const rawNext =
    look.layers.slide.mode === 'lyricOnly' && look.layers.slide.nextSlide ? slides[idx + 1] : undefined;
  const nextSlide = rawNext ? clampSlide(rawNext) : undefined;
  if (slideVisible(look, slide, isSong, nextSlide)) {
    const key = `pv|${presentation.id}|${presentation.rev}|${sig}|${slide.id}|${nextSlide?.id ?? ''}`;
    plan.slide = {
      key,
      desc: {
        layer: 'slide',
        key,
        cueIndex: -1,
        presentationId: presentation.id,
        slideId: slide.id,
        slide,
        nextSlide,
        isSong,
      },
      at: 0,
      fadeMs,
    };
  }
  // The slide's own background wins over the presentation's, as expandCues does for live cues.
  const bgId = look.layers.background.visible
    ? (slide.backgroundMediaId ??
      (slide.clearBackground
        ? undefined
        : typeof presentation.backgroundMediaId === 'string'
          ? presentation.backgroundMediaId
          : undefined))
    : look.holdingMediaId;
  const m = bgId ? opts.media?.(bgId) : undefined;
  const f = m ? playableFile(m) : undefined;
  if (m && f && (m.kind === 'image' || m.kind === 'video')) {
    const key = `bg|${m.id}|${f.hash}`;
    plan.background = {
      key,
      desc: {
        layer: 'background',
        key,
        mediaId: m.id,
        hash: f.hash,
        mime: f.mime,
        kind: m.kind,
        holding: !look.layers.background.visible,
      },
      at: 0,
      fadeMs,
    };
  }
  return plan;
}

/** The look an output uses: by id from the config looks, then the resolved playlist's looks, then a fallback. */
export function resolveLook(lookId: string | undefined, looks: Look[][], fallback: Look): Look {
  for (const list of looks) {
    const l = lookId ? list.find((x) => x.id === lookId) : undefined;
    if (l) return l;
  }
  return fallback;
}

/** Hash of every file a plan needs (for arm prerequisites). */
export function planFiles(p: FramePlan): string[] {
  const out: string[] = [];
  if (p.background.desc) out.push(p.background.desc.hash);
  if (p.media.desc) out.push(p.media.desc.hash);
  if (p.audio.desc) out.push(p.audio.desc.hash);
  return out;
}
