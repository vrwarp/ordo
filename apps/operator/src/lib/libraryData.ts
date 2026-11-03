import type { Font, Media, Playlist, Presentation, Theme } from '@ordo/domain';
import type { Folder, Job, LibraryDelta, LibrarySnapshot, Settings } from '@ordo/protocol';

export type LibraryData = {
  seq: number;
  presentations: Presentation[];
  playlists: Playlist[];
  media: Media[];
  fonts: Font[];
  themes: Theme[];
  folders: Folder[];
  settings: Settings;
  jobs: Record<string, Job>;
};

export function fromSnapshot(s: LibrarySnapshot): LibraryData {
  return {
    seq: s.seq,
    presentations: s.presentations,
    playlists: s.playlists,
    media: s.media,
    fonts: s.fonts,
    themes: s.themes,
    folders: s.folders,
    settings: s.settings,
    jobs: {},
  };
}

function upsert<T extends { id: string }>(list: T[], id: string, entity: T | undefined, deleted?: boolean): T[] {
  const i = list.findIndex((x) => x.id === id);
  if (deleted) return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
  if (!entity) return list;
  if (i < 0) return [...list, entity];
  const out = list.slice();
  out[i] = entity;
  return out;
}

const SETTINGS_KEYS = ['general', 'looks', 'outputs', 'audio', 'keymap', 'surfaces'] as const;

/**
 * Apply a `library.delta` to the cached library. Returns the new data and whether settings need a
 * refetch (a settings change that did not carry its value).
 */
export function applyLibraryDelta(
  d: LibraryData,
  changes: LibraryDelta['changes'],
): { data: LibraryData; refetchSettings: boolean } {
  let out = d;
  let refetchSettings = false;
  for (const c of changes) {
    switch (c.kind) {
      case 'presentation':
        out = {
          ...out,
          presentations: upsert(out.presentations, c.id, c.entity as Presentation, c.deleted),
        };
        break;
      case 'playlist':
        out = { ...out, playlists: upsert(out.playlists, c.id, c.entity as Playlist, c.deleted) };
        break;
      case 'media':
        out = { ...out, media: upsert(out.media, c.id, c.entity as Media, c.deleted) };
        break;
      case 'font':
        out = { ...out, fonts: upsert(out.fonts, c.id, c.entity as Font, c.deleted) };
        break;
      case 'theme':
        out = { ...out, themes: upsert(out.themes, c.id, c.entity as Theme, c.deleted) };
        break;
      case 'folder':
        out = { ...out, folders: upsert(out.folders, c.id, c.entity as Folder, c.deleted) };
        break;
      case 'job': {
        if (c.deleted) {
          const { [c.id]: _gone, ...rest } = out.jobs;
          out = { ...out, jobs: rest };
        } else if (c.entity) out = { ...out, jobs: { ...out.jobs, [c.id]: c.entity as Job } };
        break;
      }
      case 'settings': {
        const key = (SETTINGS_KEYS as readonly string[]).includes(c.id)
          ? (c.id as keyof Settings)
          : undefined;
        if (key && c.entity !== undefined) out = { ...out, settings: { ...out.settings, [key]: c.entity } };
        else if (!key && c.entity && typeof c.entity === 'object' && 'looks' in (c.entity as object))
          out = { ...out, settings: c.entity as Settings };
        else refetchSettings = true;
        break;
      }
    }
  }
  return { data: out, refetchSettings };
}

/** Ids of presentations referenced by a playlist (used for the live lock). */
export function playlistPresentationIds(p: Playlist | undefined): Set<string> {
  const ids = new Set<string>();
  if (!p) return ids;
  for (const it of p.items) if (it.kind === 'presentation') ids.add(it.presentationId);
  return ids;
}
