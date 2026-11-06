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

/** Every media id referenced by a playlist and its presentations, plus look holding slides and the logo. */
export function referencedMediaIds(
  playlist: Playlist,
  presentations: Record<string, Presentation>,
  looks: Look[] = [],
  logoMediaId?: string,
): Set<string> {
  const ids = new Set<string>();
  const add = (id?: string) => id && ids.add(id);
  for (const item of playlist.items) {
    if (item.kind === 'media') add(item.mediaId);
    if (item.kind === 'presentation') {
      add(item.backgroundMediaId);
      const p = presentations[item.presentationId];
      if (!p) continue;
      add(p.backgroundMediaId);
      for (const sec of p.sections)
        for (const sl of sec.slides) {
          add(sl.backgroundMediaId);
          add(sl.imported?.imageMediaId);
          for (const o of sl.objects) if (o.type === 'image') add(o.mediaId);
        }
    }
  }
  for (const l of looks) add(l.holdingMediaId);
  add(logoMediaId);
  return ids;
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
