import { newId, type Media, type Playlist, type PlaylistItem, type Presentation } from '@ordo/domain';

/** Local calendar date in YYYY-MM-DD format. */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Next Sunday (or today if Sunday) in local YYYY-MM-DD format. */
export function nextSundayIso(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return todayIso(d);
}

/** Whether `serviceDate` (YYYY-MM-DD) is strictly before today. */
export function isPastServiceDate(serviceDate?: string, today: string = todayIso()): boolean {
  return Boolean(serviceDate && /^\d{4}-\d{2}-\d{2}$/.test(serviceDate) && serviceDate < today);
}

/**
 * Sort playlists for day-of and mid-week picking:
 * 1. Upcoming and today's services first, soonest date first.
 * 2. Past dated services, most recent first.
 * 3. Undated playlists last, alphabetically by name.
 */
export function sortPlaylistsUpcoming(
  playlists: readonly Playlist[],
  today: string = todayIso(),
): Playlist[] {
  const upcoming: Playlist[] = [];
  const past: Playlist[] = [];
  const undated: Playlist[] = [];
  for (const p of playlists) {
    if (!p.serviceDate) undated.push(p);
    else if (p.serviceDate >= today) upcoming.push(p);
    else past.push(p);
  }
  upcoming.sort((a, b) => a.serviceDate!.localeCompare(b.serviceDate!) || a.name.localeCompare(b.name));
  past.sort((a, b) => b.serviceDate!.localeCompare(a.serviceDate!) || a.name.localeCompare(b.name));
  undated.sort((a, b) => a.name.localeCompare(b.name));
  return [...upcoming, ...past, ...undated];
}

/** Pick the active playlist for preview: explicit selection if valid, else the next upcoming service. */
export function pickDefaultPlaylist(
  playlists: readonly Playlist[],
  selectedId?: string,
  today: string = todayIso(),
): Playlist | undefined {
  if (selectedId) {
    const found = playlists.find((p) => p.id === selectedId);
    if (found) return found;
  }
  return sortPlaylistsUpcoming(playlists, today)[0];
}

/**
 * Build a duplicated playlist payload for a new service: fresh ids, clears per-service `skipped` and
 * `hiddenSlides`, and keeps `sections` (arrangement overrides) so the worship team's song flow carries forward.
 */
export function duplicatePlaylistPayload(p: Playlist): Omit<Playlist, 'createdAt' | 'updatedAt'> {
  return {
    id: newId(),
    rev: 1,
    name: `${p.name} (copy)`,
    serviceDate: nextSundayIso(),
    items: p.items.map((it): PlaylistItem => {
      if (it.kind === 'presentation') {
        const { skipped: _s, hiddenSlides: _h, ...rest } = it;
        return { ...rest, id: newId() };
      }
      const { skipped: _s, ...rest } = it;
      return { ...rest, id: newId() };
    }),
  };
}

export type ReadinessIssue = { level: 'error' | 'warn'; text: string };

/** Compute pre-service readiness issues for a playlist (used on both Playlists and Live Preview). */
export function computePlaylistReadiness(
  playlist: Playlist,
  presentations: readonly Presentation[],
  media: readonly Media[],
  unsavedItems: Record<string, unknown>,
): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  if (playlist.items.length === 0) {
    issues.push({ level: 'warn', text: 'Playlist is empty' });
    return issues;
  }
  const presMap = new Map(presentations.map((p) => [p.id, p]));
  const mediaMap = new Map(media.map((m) => [m.id, m]));
  let missingPres = 0;
  let missingMedia = 0;
  let pendingMedia = 0;
  let unsavedCount = 0;
  const seenPres = new Set<string>();
  const seenMedia = new Set<string>();
  const checkMedia = (id?: string) => {
    if (!id || seenMedia.has(id)) return;
    seenMedia.add(id);
    const m = mediaMap.get(id);
    if (!m) missingMedia++;
    else if (m.state !== 'ready') pendingMedia++;
  };
  for (const it of playlist.items) {
    if (it.kind === 'presentation') {
      const p = presMap.get(it.presentationId);
      if (!p) {
        missingPres++;
        continue;
      }
      if (!seenPres.has(p.id)) {
        seenPres.add(p.id);
        if (unsavedItems[`pres:${p.id}`]) unsavedCount++;
      }
      checkMedia(it.backgroundMediaId ?? p.backgroundMediaId);
      checkMedia(it.audioMediaId);
    } else if (it.kind === 'media') {
      checkMedia(it.mediaId);
    }
  }
  if (missingPres > 0)
    issues.push({
      level: 'error',
      text: `${missingPres} missing presentation${missingPres === 1 ? '' : 's'}`,
    });
  if (missingMedia > 0)
    issues.push({
      level: 'error',
      text: `${missingMedia} missing media file${missingMedia === 1 ? '' : 's'}`,
    });
  if (pendingMedia > 0)
    issues.push({
      level: 'warn',
      text: `${pendingMedia} media item${pendingMedia === 1 ? '' : 's'} still processing`,
    });
  if (unsavedCount > 0)
    issues.push({
      level: 'warn',
      text: `${unsavedCount} presentation${unsavedCount === 1 ? '' : 's'} with unsaved editor edits`,
    });
  return issues;
}
