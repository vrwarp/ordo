import type { Media } from '@ordo/domain';

type Kind = Media['kind'];

/**
 * File types a media picker offers per kind. Together they are the media tab's MEDIA_ACCEPT; the wildcard
 * MIME types keep the iPad's Photos source (photos arrive as JPEG, videos as MOV or MP4: design/15 "Touch").
 */
const ACCEPT: Record<Kind, string[]> = {
  video: ['video/*', '.mov', '.mp4', '.m4v', '.webm'],
  image: ['image/*', '.gif', '.jpg', '.jpeg', '.png', '.webp', '.svg'],
  audio: ['audio/*', '.wav', '.mp3', '.aac', '.flac', '.ogg', '.m4a'],
};

/** The `accept` list of a picker limited to `kinds`: an image picker opens images only. */
export function mediaAccept(kinds: readonly Kind[]): string {
  const wild = kinds.map((k) => ACCEPT[k][0]!);
  const ext = kinds.flatMap((k) => ACCEPT[k].slice(1));
  return [...wild, ...ext].join(',');
}

/** The hub's extension table (apps/hub/src/store.ts `EXT_KIND`), for the media kinds. */
const EXT_KIND: Record<string, Kind> = {
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  avif: 'image',
  wav: 'audio',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
};

/** The media kind a file will become: by extension as the hub decides, else by its MIME type. */
export function fileKind(f: { name: string; type?: string }): Kind | undefined {
  const dot = f.name.lastIndexOf('.');
  const byExt = dot >= 0 ? EXT_KIND[f.name.slice(dot + 1).toLowerCase()] : undefined;
  if (byExt) return byExt;
  const top = (f.type ?? '').split('/')[0];
  return top === 'image' || top === 'video' || top === 'audio' ? top : undefined;
}

/** Split dropped files into those a picker for `kinds` takes and the others (which are not uploaded). */
export function filesForKinds<F extends { name: string; type?: string }>(
  files: F[],
  kinds: readonly Kind[],
): { ok: F[]; rejected: F[] } {
  const ok: F[] = [];
  const rejected: F[] = [];
  for (const f of files) {
    const k = fileKind(f);
    (k && kinds.includes(k) ? ok : rejected).push(f);
  }
  return { ok, rejected };
}

/** "images", "videos", "images or videos": what a picker for `kinds` takes, for its messages. */
export function kindsText(kinds: readonly Kind[]): string {
  const words = kinds.map((k) => (k === 'audio' ? 'sounds' : `${k}s`));
  return words.length <= 1 ? (words[0] ?? 'media') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}
