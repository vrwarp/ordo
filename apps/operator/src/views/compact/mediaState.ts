import type { Media } from '@ordo/domain';

/**
 * The state word of a media row on the compact layout (design/28 §2.12 "Waiting for the service to end"). A
 * video or animated GIF that is still `uploaded` while the venue runs a service with Phones on waits for End
 * service (the hub holds heavy jobs then, apps/hub/src/pacing.ts); everything else reads its state. A job's
 * `waiting` names no media item, so this follows the hub's rule from what the phone knows: the item, the Live
 * now summary and the switch.
 */
export type MediaStateKey = `media.state.${Media['state']}` | 'media.state.waiting';

export function mediaStateKey(
  m: Pick<Media, 'state' | 'kind'> & { original?: { mime?: string } },
  venue: { live: boolean; phonesOn: boolean },
): MediaStateKey {
  const heavy = m.kind === 'video' || m.original?.mime === 'image/gif';
  if (m.state === 'uploaded' && heavy && venue.live && venue.phonesOn) return 'media.state.waiting';
  return `media.state.${m.state}`;
}
