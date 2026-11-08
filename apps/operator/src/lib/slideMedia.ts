import { type Media, playingObject, type Slide } from '@ordo/domain';

/**
 * Why a slide's own clip or sound will not play as authored (design/27 §8): goLive leaves a clip that is
 * still processing or failed out of the service, and the slide then shows its poster (a sound stays
 * silent). Undefined when it is ready.
 */
export function clipNotice(what: 'video' | 'sound', m: Media | undefined): string | undefined {
  const instead = what === 'video' ? 'the slide shows its poster' : 'the slide plays no sound';
  if (!m) return `The ${what} is missing from the library: ${instead}.`;
  if (what === 'video' && m.kind !== 'video') return `This media is not a video: ${instead}.`;
  if (what === 'sound' && m.kind !== 'audio' && m.kind !== 'video')
    return `This media has no sound: ${instead}.`;
  if (m.state === 'failed') return `The ${what} could not be processed: ${instead}.`;
  if (m.state !== 'ready')
    return `The ${what} is still processing: ${instead} until it is ready (a service already live needs Go live again).`;
  return undefined;
}

export type SlideMediaTag = {
  kind: 'video' | 'audio';
  /** Set when the clip will not play as authored (amber tag). */
  notice?: string;
  /** What the tag says to a pointer or a screen reader. */
  title: string;
};

/**
 * The `video` / `audio` tags of a slide thumbnail (design/27 §11 item 14): the clip its playing object plays
 * in place (the first ImageObject with `play`, as the runtime picks it) and its own sound.
 */
export function slideMediaTags(
  slide: Pick<Slide, 'objects' | 'audio'> | undefined,
  media: (id: string) => Media | undefined,
): SlideMediaTag[] {
  if (!slide) return [];
  const out: SlideMediaTag[] = [];
  const obj = playingObject(slide);
  if (obj) {
    const m = media(obj.play.mediaId);
    const notice = clipNotice('video', m);
    out.push({
      kind: 'video',
      ...(notice ? { notice } : {}),
      title: notice ?? `Plays ${m?.name ?? 'a video'} in the slide`,
    });
  }
  if (slide.audio) {
    const m = media(slide.audio.mediaId);
    const notice = clipNotice('sound', m);
    const n = slide.audio.slides ?? 1;
    out.push({
      kind: 'audio',
      ...(notice ? { notice } : {}),
      title: notice ?? `Plays ${m?.name ?? 'a sound'}${n > 1 ? ` across ${n} slides` : ''}`,
    });
  }
  return out;
}
