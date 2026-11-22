import { DEMO } from '@ordo/client';
import { DEFAULT_THEME } from '@ordo/domain';
import { choiceDialog } from '../components/Confirm.tsx';
import { controller } from '../services/controller.ts';
import { useLibrary } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { flushPlaylist } from '../state/playlistOutbox.ts';
import { type UnsavedItem, useUnsaved } from '../state/unsaved.ts';

/** Collect dirty drafts that directly affect going live with `playlistId`. */
export function serviceRelevantUnsaved(playlistId: string): UnsavedItem[] {
  const items = useUnsaved.getState().items;
  const lib = useLibrary.getState().data;
  const playlist = lib.playlists.find((p) => p.id === playlistId);
  const relevant: UnsavedItem[] = [];
  const seen = new Set<string>();
  const add = (it: UnsavedItem | undefined) => {
    if (it && !it.debouncePending && !seen.has(it.key)) {
      seen.add(it.key);
      relevant.push(it);
    }
  };

  add(items[`playlist:${playlistId}`]);

  if (playlist) {
    const defaultThemeId = lib.settings.general.defaultThemeId ?? DEFAULT_THEME.id;
    for (const item of playlist.items) {
      if (item.kind !== 'presentation') continue;
      add(items[`pres:${item.presentationId}`]);
      const p = lib.presentations.find((x) => x.id === item.presentationId);
      const themeId = p?.themeId ?? (p?.kind === 'song' ? defaultThemeId : undefined);
      if (themeId) add(items[`theme:${themeId}`]);
    }
  }

  add(items['settings:outputs']);
  add(items['settings:looks']);
  add(items['settings:audio']);
  return relevant;
}

/**
 * Every Go live button goes through here. Flushes any pending save for `playlistId` and prompts if
 * presentations/themes in `playlistId` or Screens/Looks/Audio settings have unsaved edits (going live uses
 * the hub's saved versions and locks the playlist's presentations with 423). Resolves `true` when service launch
 * proceeded, `false` when cancelled or a save failed.
 */
export async function startService(playlistId: string): Promise<boolean> {
  await flushPlaylist(playlistId);
  const relevant = serviceRelevantUnsaved(playlistId);
  if (relevant.length > 0) {
    const choice = await choiceDialog<'save' | 'discard' | 'cancel'>({
      title: 'Unsaved changes',
      text: `These items affect this service and have unsaved changes (presentations in a live playlist are locked until End service):\n${relevant.map((it) => `• ${it.label}`).join('\n')}`,
      cancelValue: 'cancel',
      choices: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'discard', label: 'Discard & Go live', tone: 'danger' },
        { value: 'save', label: 'Save & Go live', tone: 'primary', autoFocus: true },
      ],
    });
    if (choice === 'cancel') return false;
    if (choice === 'save') {
      for (const it of relevant) {
        if (!(await it.save())) return false;
      }
    } else {
      for (const it of relevant) {
        await it.discard();
      }
    }
  }

  const s = useLive.getState();
  // The GitHub Pages demo has no hub: every service runs in the browser, without asking.
  if (DEMO) {
    controller()?.goLiveLocal(playlistId);
    return true;
  }
  if (s.hubConnected) {
    controller()?.goLive(playlistId);
    return true;
  }
  useLive.setState({ localGoLive: playlistId });
  controller()?.offlineCheck(playlistId);
  return true;
}
