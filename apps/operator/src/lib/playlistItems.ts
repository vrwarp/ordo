import { arrangedSections, LOOP_SLIDE_MAX_MS, LOOP_SLIDE_MIN_MS, type PlaylistItem } from '@ordo/domain';
import type { OperatorPlaylist } from '../views/live/useOperatorPlaylist.ts';

/*
 * A playlist item's icon, title and subtitle, shared by the live view's playlist pane and the playlist editor.
 * Their own module: views/live/PlaylistPane.tsx imports the controller and startService, which the playlist
 * editor (on a phone's compact path) must not pull in (design/28 §3.1 "Code split").
 */

export const KIND_ICON: Record<PlaylistItem['kind'], string> = {
  presentation: '♪',
  media: '▶',
  timer: '⏱',
  action: '⚡',
};

export function formatLoopSeconds(ms: number): string {
  const clamped = Math.round(Math.max(LOOP_SLIDE_MIN_MS, Math.min(LOOP_SLIDE_MAX_MS, ms)));
  return clamped % 1000 === 0 ? `${clamped / 1000}` : `${(clamped / 1000).toFixed(1)}`;
}

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
    const parts: string[] = [];
    if (p?.kind === 'loop') {
      const defMs = p.loop?.defaultSlideMs ?? 8000;
      const hiddenSet = it.hiddenSlides?.length ? new Set(it.hiddenSlides) : undefined;
      const secs = arrangedSections(p, it.arrangementId, it.sections);
      let minMs = Infinity;
      let maxMs = -Infinity;
      for (const sec of secs) {
        for (const sl of sec.slides) {
          if (sl.hidden === true || hiddenSet?.has(sl.id)) continue;
          const raw =
            typeof sl.durationMs === 'number' && Number.isFinite(sl.durationMs) && sl.durationMs > 0
              ? sl.durationMs
              : defMs;
          const ms = Math.round(Math.max(LOOP_SLIDE_MIN_MS, Math.min(LOOP_SLIDE_MAX_MS, raw)));
          if (ms < minMs) minMs = ms;
          if (ms > maxMs) maxMs = ms;
        }
      }
      if (!Number.isFinite(minMs)) {
        parts.push(`Loop · ${formatLoopSeconds(defMs)}s`);
      } else if (minMs !== maxMs) {
        parts.push(`Loop · ${formatLoopSeconds(minMs)}–${formatLoopSeconds(maxMs)}s`);
      } else {
        parts.push(`Loop · ${formatLoopSeconds(minMs)}s`);
      }
    } else if (it.sections && p) {
      const byId = new Map(p.sections.map((s) => [s.id, s]));
      const seq = it.sections
        .map((id) => byId.get(id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .map((s) => s.short || s.label)
        .join(' · ');
      parts.push(seq ? `Custom: ${seq}` : 'Custom order');
    } else {
      const a = p?.arrangements.find((x) => x.id === it.arrangementId) ?? p?.arrangements[0];
      if (a) parts.push(a.name);
    }
    if (it.hiddenSlides?.length) {
      parts.push(`${it.hiddenSlides.length} hidden`);
    }
    return parts.join(' · ');
  }
  if (it.kind === 'media') {
    const m = op.media(it.mediaId);
    if (!m) return '';
    const st = m.state !== 'ready' ? ` · ${m.state}` : '';
    return `${m.kind}${(it.loop ?? m.loop) ? ' · loop' : ''}${st}`;
  }
  return '';
}
