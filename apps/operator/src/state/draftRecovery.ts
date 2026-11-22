import type { Playlist, Presentation, Theme } from '@ordo/domain';
import { choiceDialog } from '../components/Confirm.tsx';
import { same } from '../lib/jsonEqual.ts';
import { type JournalEntry, journalClearAll, journalReadAll, journalRemove } from './draftJournal.ts';
import { useLibrary } from './library.ts';
import { restorePlaylistDraftFromJournal } from './playlistOutbox.ts';
import { restoreSettingsDraftFromJournal } from './settingsDrafts.ts';
import { restoreThemeDraftFromJournal } from './themeDrafts.ts';
import { toast } from './toasts.ts';

let checkedThisLoad = false;

export function resetDraftRecoveryForTests(): void {
  checkedThisLoad = false;
}

function presContent(p: Presentation) {
  const { rev: _r, createdAt: _c, updatedAt: _u, ...rest } = p;
  return rest;
}

function themeContent(t: Theme) {
  const { rev: _r, ...rest } = t;
  return rest;
}

function playlistContent(p: Playlist) {
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

const SETTINGS_LABELS: Record<string, string> = {
  outputs: 'Screens settings',
  looks: 'Looks settings',
  audio: 'Audio settings',
  keys: 'Keyboard settings',
  streamdeck: 'Stream Deck settings',
  midi: 'MIDI settings',
  messages: 'Stage messages settings',
  general: 'General settings',
  pins: 'PINs settings',
};

function describeEntry(entry: JournalEntry): string {
  switch (entry.kind) {
    case 'presentation':
      return `Presentation: ${entry.draft.title || 'Untitled presentation'}`;
    case 'theme':
      return `Theme: ${entry.draft.name || 'Untitled'}`;
    case 'settings':
      return SETTINGS_LABELS[entry.page ?? ''] ?? `${entry.key} settings`;
    case 'playlist':
      return `Playlist: ${entry.draft.name || 'Untitled'}`;
  }
}

/**
 * Inspect `ordo-drafts` once the library has loaded (and no live service is running on this operator PC,
 * so a modal never blocks live keys). Drops entries that already match the hub, and prompts
 * "Restore unsaved drafts? [Restore] [Discard all]" when unrecovered work remains.
 */
export async function checkStartupDraftRecovery(role: 'operate' | 'edit'): Promise<void> {
  if (checkedThisLoad) return;
  checkedThisLoad = true;

  const stored = await journalReadAll();
  if (stored.length === 0) return;

  const lib = useLibrary.getState().data;
  const recoverable: { key: string; entry: JournalEntry }[] = [];

  for (const item of stored) {
    const { key, entry } = item;
    switch (entry.kind) {
      case 'presentation': {
        const remote = lib.presentations.find((p) => p.id === entry.id);
        if (!remote || same(presContent(entry.draft), presContent(remote))) {
          journalRemove(key);
        } else {
          recoverable.push(item);
        }
        break;
      }
      case 'theme': {
        const remote = lib.themes.find((t) => t.id === entry.id);
        if (!remote || same(themeContent(entry.draft), themeContent(remote))) {
          journalRemove(key);
        } else {
          recoverable.push(item);
        }
        break;
      }
      case 'settings': {
        if (role !== 'operate' || same(entry.draft, lib.settings[entry.key])) {
          journalRemove(key);
        } else {
          recoverable.push(item);
        }
        break;
      }
      case 'playlist': {
        const remote = lib.playlists.find((p) => p.id === entry.id);
        if (!remote || same(playlistContent(entry.draft), playlistContent(remote))) {
          journalRemove(key);
        } else {
          recoverable.push(item);
        }
        break;
      }
    }
  }

  if (recoverable.length === 0) return;

  const choice = await choiceDialog<'restore' | 'discard'>({
    title: 'Restore unsaved drafts?',
    text: `Unsaved changes from an earlier session were found:\n${recoverable.map((r) => `• ${describeEntry(r.entry)}`).join('\n')}`,
    choices: [
      { value: 'discard', label: 'Discard all', tone: 'danger' },
      { value: 'restore', label: 'Restore', tone: 'primary', autoFocus: true },
    ],
  });

  if (choice === 'discard') {
    await journalClearAll();
    toast('Discarded unsaved drafts.', 'ok');
    return;
  }

  const hasPres = recoverable.some((r) => r.entry.kind === 'presentation');
  const editorMod = hasPres ? await import('../views/editor/editorStore.ts') : undefined;

  for (const { entry } of recoverable) {
    switch (entry.kind) {
      case 'presentation':
        editorMod?.restorePresentationDraftFromJournal(
          entry.id,
          entry.base,
          entry.draft,
          entry.slideId,
          entry.ui,
        );
        break;
      case 'theme':
        restoreThemeDraftFromJournal(entry.id, entry.base, entry.draft, entry.editing);
        break;
      case 'settings':
        restoreSettingsDraftFromJournal(entry.key, entry.base, entry.draft, entry.page);
        break;
      case 'playlist':
        restorePlaylistDraftFromJournal(entry.id, entry.baseRev, entry.draft);
        break;
    }
  }

  toast(
    recoverable.length === 1 ? 'Restored 1 unsaved draft.' : `Restored ${recoverable.length} unsaved drafts.`,
    'ok',
  );
}
