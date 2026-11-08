import type { Media, Presentation } from '@ordo/domain';

/**
 * Media library hygiene (design/27 §11 item 15): pictures an import made for presentations (PowerPoint
 * pictures tagged `pptx`, document pages tagged `document`) are hidden from the media list unless the
 * operator asks for them, and deleting media that presentations use names them first.
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

/** The confirmation that names the presentations a deletion would break. */
export function mediaInUseText(name: string, users: readonly { title: string }[]): string {
  const shown = users.slice(0, 5).map((u) => `“${u.title}”`);
  const more = users.length > shown.length ? ` and ${users.length - shown.length} more` : '';
  const what = users.length === 1 ? 'the presentation' : `${users.length} presentations:`;
  return (
    `“${name}” is used by ${what} ${shown.join(', ')}${more}. ` +
    'Without it they cannot go live until it is replaced. Delete it anyway?'
  );
}
