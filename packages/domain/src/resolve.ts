import type { ManifestFile } from './live.ts';
import type { FileRef, Font, Look, Media, Playlist, Presentation } from './schemas.ts';

/** The file an output plays or draws for a media item. */
export function playableFile(m: Media): FileRef | undefined {
  return m.delivery ?? (m.kind === 'image' ? m.original : undefined);
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
