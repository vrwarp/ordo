import type { Media, Playlist, Presentation } from '@ordo/domain';

/**
 * Media library hygiene (design/27 §11 item 15): pictures an import made for presentations (PowerPoint
 * pictures tagged `pptx`, document pages tagged `document`) are hidden from the media list unless the
 * operator asks for them, and deleting media that presentations or playlists use names them first.
 */

/** Tags of the pictures imports make for presentations. */
export const PRESENTATION_PICTURE_TAGS: readonly string[] = ['pptx', 'document'];

/** A picture an import made for a presentation (a page, a PowerPoint picture or art). */
export function isPresentationPicture(m: Pick<Media, 'tags'>): boolean {
  return Array.isArray(m.tags) && m.tags.some((t) => PRESENTATION_PICTURE_TAGS.includes(t));
}

/**
 * The presentations that use a media item, by title: any JSON string equal to its id (backgrounds,
 * pictures, imported pages, reference pictures, clips), the hub's own test for `DELETE /media/:id`.
 */
export function presentationsUsing(
  mediaId: string,
  presentations: readonly Presentation[],
): { id: string; title: string }[] {
  const quoted = JSON.stringify(mediaId);
  return presentations
    .filter((p) => JSON.stringify(p).includes(quoted))
    .map((p) => ({ id: p.id, title: p.title }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/**
 * The playlists whose items use a media item, by name: a media item, an item's background or its music (the
 * pre-service loop's), the hub's own test for `DELETE /media/:id`.
 */
export function playlistsUsing(
  mediaId: string,
  playlists: readonly Playlist[],
): { id: string; name: string }[] {
  const quoted = JSON.stringify(mediaId);
  return playlists
    .filter((p) => JSON.stringify(p).includes(quoted))
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function usersText(kind: string, names: readonly string[]): string {
  const shown = names.slice(0, 5).map((n) => `“${n}”`);
  const more = names.length > shown.length ? ` and ${names.length - shown.length} more` : '';
  const what = names.length === 1 ? `the ${kind}` : `${names.length} ${kind}s:`;
  return `${what} ${shown.join(', ')}${more}`;
}

/** The confirmation that names the presentations and playlists a deletion would break. */
export function mediaInUseText(
  name: string,
  users: readonly { title: string }[],
  lists: readonly { name: string }[] = [],
): string {
  const parts = [
    ...(users.length
      ? [
          usersText(
            'presentation',
            users.map((u) => u.title),
          ),
        ]
      : []),
    ...(lists.length
      ? [
          usersText(
            'playlist',
            lists.map((l) => l.name),
          ),
        ]
      : []),
  ];
  // A playlist's music is left out with a warning at Go live; a missing picture or media item refuses it.
  const after = lists.length
    ? 'Until it is replaced they go live without it, or cannot go live.'
    : 'Without it they cannot go live until it is replaced.';
  return `“${name}” is used by ${parts.join(' and ')}. ${after} Delete it anyway?`;
}
