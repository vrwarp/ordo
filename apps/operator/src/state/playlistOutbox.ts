import { ApiFailure, api } from '@ordo/client';
import type { Playlist } from '@ordo/domain';
import { create } from 'zustand';
import { deviceProfile } from '../lib/capabilities.ts';
import { same } from '../lib/jsonEqual.ts';
import { journalPut, journalRemove } from './draftJournal.ts';
import { upsertLocal, useLibrary } from './library.ts';
import { currentRole } from './session.ts';
import { errorText, toast } from './toasts.ts';
import { removeUnsaved, upsertUnsaved } from './unsaved.ts';

export type PlaylistOutboxEntry = {
  id: string;
  baseRev: number;
  draft: Playlist;
  status: 'pending' | 'saving' | 'error';
  error?: string;
};

type PlaylistOutboxState = {
  entries: Record<string, PlaylistOutboxEntry>;
};

export const usePlaylistOutbox = create<PlaylistOutboxState>(() => ({ entries: {} }));

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<boolean>>();

function playlistContent(p: Playlist): Omit<Playlist, 'rev' | 'createdAt' | 'updatedAt'> {
  const {
    rev: _r,
    createdAt: _c,
    updatedAt: _u,
    ...rest
  } = p as Playlist & {
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  return rest;
}

function syncOutboxRegistry(entry: PlaylistOutboxEntry | undefined, id: string): void {
  const regKey = `playlist:${id}`;
  if (!entry) {
    removeUnsaved(regKey);
    journalRemove(regKey);
    return;
  }
  upsertUnsaved({
    key: regKey,
    kind: 'playlist',
    id,
    label: `Playlist: ${entry.draft.name || 'Untitled'}`,
    route: { name: 'playlists', id },
    saving: entry.status === 'saving',
    debouncePending: entry.status !== 'error',
    error: entry.error,
    save: () => flushPlaylist(id),
    discard: () => discardPlaylistDraft(id),
  });
  journalPut(regKey, {
    kind: 'playlist',
    id,
    baseRev: entry.baseRev,
    draft: entry.draft,
    updatedAt: Date.now(),
  });
}

export function updatePlaylistDraft(basePlaylist: Playlist, fn: (p: Playlist) => Playlist): void {
  const id = basePlaylist.id;
  const cur = usePlaylistOutbox.getState().entries[id];
  const prev = cur?.draft ?? basePlaylist;
  const baseRev = cur?.baseRev ?? basePlaylist.rev;
  const next = fn(prev);
  const remote = useLibrary.getState().data.playlists.find((p) => p.id === id) ?? basePlaylist;
  if (same(playlistContent(next), playlistContent(remote)) && cur?.status !== 'saving') {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
    usePlaylistOutbox.setState((s) => {
      if (!(id in s.entries)) return s;
      const entries = { ...s.entries };
      delete entries[id];
      return { entries };
    });
    syncOutboxRegistry(undefined, id);
    return;
  }
  const entry: PlaylistOutboxEntry = {
    id,
    baseRev,
    draft: next,
    status: cur?.status === 'saving' ? 'saving' : 'pending',
  };
  usePlaylistOutbox.setState((s) => ({
    entries: { ...s.entries, [id]: entry },
  }));
  syncOutboxRegistry(entry, id);
  const oldTimer = timers.get(id);
  if (oldTimer) clearTimeout(oldTimer);
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      void flushPlaylist(id);
    }, 600),
  );
}

export async function flushPlaylist(id: string): Promise<boolean> {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  const running = inFlight.get(id);
  if (running) return running;
  const cur = usePlaylistOutbox.getState().entries[id];
  if (!cur) return true;

  const task = (async (): Promise<boolean> => {
    const sent = cur.draft;
    const rev = cur.baseRev;
    const savingEntry: PlaylistOutboxEntry = { ...cur, status: 'saving', error: undefined };
    usePlaylistOutbox.setState((s) => ({ entries: { ...s.entries, [id]: savingEntry } }));
    syncOutboxRegistry(savingEntry, id);
    try {
      const saved = await api<Playlist>(`/playlists/${id}`, {
        method: 'PUT',
        json: { ...sent, rev },
      });
      upsertLocal('playlists', saved);
      const after = usePlaylistOutbox.getState().entries[id];
      // If more edits arrived while PUT was in flight, schedule another flush on the new rev.
      if (after && after.draft !== sent && !same(playlistContent(after.draft), playlistContent(saved))) {
        const nextEntry: PlaylistOutboxEntry = {
          id,
          baseRev: saved.rev,
          draft: { ...after.draft, rev: saved.rev },
          status: 'pending',
        };
        usePlaylistOutbox.setState((s) => ({ entries: { ...s.entries, [id]: nextEntry } }));
        syncOutboxRegistry(nextEntry, id);
        inFlight.delete(id);
        return flushPlaylist(id);
      }
      usePlaylistOutbox.setState((s) => {
        const entries = { ...s.entries };
        delete entries[id];
        return { entries };
      });
      syncOutboxRegistry(undefined, id);
      return true;
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409) {
        toast(
          'The playlist was changed elsewhere. Reloaded the latest version; redo your last change.',
          'warn',
          8000,
        );
        try {
          const fresh = await api<Playlist>(`/playlists/${id}`);
          upsertLocal('playlists', fresh);
          discardPlaylistDraft(id);
          return false;
        } catch {
          /* fall through to error retention */
        }
      } else if (e instanceof ApiFailure && e.status === 423) {
        toast(
          deviceProfile(currentRole()) === 'edit'
            ? 'This playlist is live at the venue. It can be edited again after the service.'
            : 'This playlist is live and locked until End service.',
          'warn',
        );
      } else {
        toast(`Could not save the playlist: ${errorText(e)}`, 'error');
      }
      const after = usePlaylistOutbox.getState().entries[id];
      if (after) {
        const errEntry: PlaylistOutboxEntry = {
          ...after,
          status: 'error',
          error: errorText(e),
        };
        usePlaylistOutbox.setState((s) => ({ entries: { ...s.entries, [id]: errEntry } }));
        syncOutboxRegistry(errEntry, id);
      }
      return false;
    } finally {
      inFlight.delete(id);
    }
  })();

  inFlight.set(id, task);
  return task;
}

export function discardPlaylistDraft(id: string): void {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  usePlaylistOutbox.setState((s) => {
    if (!(id in s.entries)) return s;
    const entries = { ...s.entries };
    delete entries[id];
    return { entries };
  });
  syncOutboxRegistry(undefined, id);
}

export function restorePlaylistDraftFromJournal(id: string, baseRev: number, draft: Playlist): void {
  const remote = useLibrary.getState().data.playlists.find((p) => p.id === id);
  if (!remote || same(playlistContent(draft), playlistContent(remote))) {
    journalRemove(`playlist:${id}`);
    return;
  }
  const entry: PlaylistOutboxEntry = {
    id,
    baseRev,
    draft,
    status: 'error',
    error: 'Unsaved from previous session',
  };
  usePlaylistOutbox.setState((s) => ({
    entries: { ...s.entries, [id]: entry },
  }));
  syncOutboxRegistry(entry, id);
}

export function resetPlaylistOutboxForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  inFlight.clear();
  for (const id of Object.keys(usePlaylistOutbox.getState().entries)) {
    removeUnsaved(`playlist:${id}`);
    journalRemove(`playlist:${id}`);
  }
  usePlaylistOutbox.setState({ entries: {} });
}
