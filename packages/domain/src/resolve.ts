import type { ManifestFile } from './live.ts';
import type {
  FileRef,
  Font,
  ImageObject,
  Look,
  Media,
  Play,
  Playlist,
  Presentation,
  Slide,
} from './schemas.ts';

/** The file an output plays or draws for a media item. */
export function playableFile(m: Media): FileRef | undefined {
  return m.delivery ?? (m.kind === 'image' ? m.original : undefined);
}

/**
 * The file a media item shows as a still: an image itself, a video's poster. An ImageObject whose media is
 * a video draws this on outputs, thumbnails and the editor alike (design/27 §8 "Output").
 */
export function stillFile(m: Media): FileRef | undefined {
  if (m.kind === 'image') return m.delivery ?? m.original;
  if (m.kind === 'video') return m.poster;
  return undefined;
}

/**
 * The ImageObject a slide plays in place: the first one with `play`, in z order. Others keep showing their
 * posters (design/27 §8: one video and one sound per slide).
 */
export function playingObject(slide: Pick<Slide, 'objects'>): (ImageObject & { play: Play }) | undefined {
  for (const o of slide.objects) if (o.type === 'image' && o.play) return o as ImageObject & { play: Play };
  return undefined;
}

/**
 * Media a slide plays when it is shown: its playing object's clip and its sound. These are optional at
 * goLive: a clip still transcoding or failed leaves the slide showing its poster (design/27 §8 "Domain").
 */
export function slideMediaIds(slide: Pick<Slide, 'objects' | 'audio'>): string[] {
  const out: string[] = [];
  const play = playingObject(slide)?.play.mediaId;
  if (play) out.push(play);
  const sound = slide.audio?.mediaId;
  if (sound && sound !== play) out.push(sound);
  return out;
}

/**
 * A slide that plays a media item in place (design/27 §8): its clip (`video`), an ImageObject's poster that is
 * its own clip (`poster`: the editor's 'Add video to slide' shows the clip's poster frame) or its sound.
 */
export type SlidePlay = { presentationId: string; slideId: string; role: 'video' | 'poster' | 'sound' };

/**
 * Every media reference of a playlist's items and slides. `play` is set for what a slide plays in place:
 * the ids of `slideMediaIds`, and an ImageObject's poster when that is its own clip.
 */
function visitPlaylistMedia(
  playlist: Playlist,
  presentations: Record<string, Presentation>,
  visit: (id: string | undefined, play?: SlidePlay) => void,
): void {
  for (const item of playlist.items) {
    if (item.kind === 'media') visit(item.mediaId);
    if (item.kind !== 'presentation') continue;
    visit(item.backgroundMediaId);
    const p = presentations[item.presentationId];
    if (!p) continue;
    visit(p.backgroundMediaId);
    for (const sec of p.sections)
      for (const sl of sec.slides) {
        visit(sl.backgroundMediaId);
        visit(sl.imported?.imageMediaId);
        const at = (role: SlidePlay['role']): SlidePlay => ({ presentationId: p.id, slideId: sl.id, role });
        for (const o of sl.objects)
          if (o.type === 'image') visit(o.mediaId, o.play?.mediaId === o.mediaId ? at('poster') : undefined);
        visit(playingObject(sl)?.play.mediaId, at('video'));
        visit(sl.audio?.mediaId, at('sound'));
      }
  }
}

/** Every media id referenced by a playlist and its presentations, plus look holding slides and the logo. */
export function referencedMediaIds(
  playlist: Playlist,
  presentations: Record<string, Presentation>,
  looks: Look[] = [],
  logoMediaId?: string,
): Set<string> {
  const ids = new Set<string>();
  const add = (id?: string) => id && ids.add(id);
  visitPlaylistMedia(playlist, presentations, add);
  for (const l of looks) add(l.holdingMediaId);
  add(logoMediaId);
  return ids;
}

/**
 * Media that slides only play in place (`slideMediaIds`, and a play object's poster when it is the clip
 * itself), each with the slides that play it. These are optional at goLive (design/27 §8 "Domain"): a clip
 * still processing or failed is left out and its slide shows the poster. An id that anything else in the
 * playlist draws or plays stays required and is not listed.
 */
export function slideOnlyMedia(
  playlist: Playlist,
  presentations: Record<string, Presentation>,
): Map<string, SlidePlay[]> {
  const required = new Set<string>();
  const played = new Map<string, SlidePlay[]>();
  visitPlaylistMedia(playlist, presentations, (id, play) => {
    if (!id) return;
    if (!play) {
      required.add(id);
      return;
    }
    const list = played.get(id) ?? [];
    // One entry per slide (a presentation in the playlist twice is listed once); its poster comes first.
    if (!list.some((x) => x.slideId === play.slideId && x.presentationId === play.presentationId))
      list.push(play);
    played.set(id, list);
  });
  for (const id of required) played.delete(id);
  return played;
}

/** Font families used by any text style in the presentations or looks. */
export function referencedFontFamilies(presentations: Presentation[], looks: Look[]): Set<string> {
  const fam = new Set<string>();
  for (const p of presentations)
    for (const sec of p.sections)
      for (const sl of sec.slides)
        for (const o of sl.objects) if (o.type === 'text') fam.add(o.style.fontFamily);
  for (const l of looks) {
    if (l.layers.slide.mode === 'lyricOnly') {
      fam.add(l.layers.slide.style.fontFamily);
      if (l.layers.slide.nextSlide) fam.add(l.layers.slide.nextSlide.style.fontFamily);
    }
    for (const s of Object.values(l.layers.props.style)) fam.add(s.fontFamily);
  }
  return fam;
}

/** Manifest file list for a set of media and fonts: playable files plus video posters. */
export function manifestFiles(media: Media[], fonts: Font[]): ManifestFile[] {
  const out = new Map<string, ManifestFile>();
  const add = (f?: FileRef) => f && out.set(f.hash, { hash: f.hash, bytes: f.bytes, mime: f.mime });
  for (const m of media) {
    add(playableFile(m));
    add(m.poster);
  }
  for (const f of fonts) add(f.file);
  return [...out.values()];
}
