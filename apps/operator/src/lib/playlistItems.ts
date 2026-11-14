import type { PlaylistItem } from '@ordo/domain';
import type { OperatorPlaylist } from '../views/live/useOperatorPlaylist.ts';

/*
 * A playlist item's title and subtitle, shared by the live view's playlist pane and the playlist editor. Their
 * own module: views/live/PlaylistPane.tsx imports the controller and startService, which the playlist editor
 * (on a phone's compact path) must not pull in (design/28 §3.1 "Code split").
 */

export function itemTitle(it: PlaylistItem, op: Pick<OperatorPlaylist, 'presentation' | 'media'>): string {
  switch (it.kind) {
    case 'presentation':
      return op.presentation(it.presentationId)?.title ?? 'Missing presentation';
    case 'media':
      return op.media(it.mediaId)?.name ?? 'Missing media';
    case 'timer':
      return (
        it.timer.label ??
        (it.timer.kind === 'elapsed' ? 'Elapsed timer' : `Countdown to ${it.timer.timeOfDay}`)
      );
    case 'action':
      return `Action: ${it.action}`;
  }
}

export function itemSubtitle(it: PlaylistItem, op: Pick<OperatorPlaylist, 'presentation' | 'media'>): string {
  if (it.kind === 'presentation') {
    const p = op.presentation(it.presentationId);
    const a = p?.arrangements.find((x) => x.id === it.arrangementId) ?? p?.arrangements[0];
    return a ? a.name : '';
  }
  if (it.kind === 'media') {
    const m = op.media(it.mediaId);
    if (!m) return '';
    const st = m.state !== 'ready' ? ` · ${m.state}` : '';
    return `${m.kind}${(it.loop ?? m.loop) ? ' · loop' : ''}${st}`;
  }
  return '';
}
