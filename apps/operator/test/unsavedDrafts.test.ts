import { DEFAULT_THEME, type Playlist, type Presentation, type TextObject, type Theme } from '@ordo/domain';
import { API_PREFIX } from '@ordo/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceRelevantUnsaved, startService } from '../src/lib/startService.ts';
import {
  type DraftStoreBackend,
  journalFlushNow,
  journalReadAll,
  setDraftJournalBackendForTests,
  shouldBypassBeforeUnload,
} from '../src/state/draftJournal.ts';
import { checkStartupDraftRecovery, resetDraftRecoveryForTests } from '../src/state/draftRecovery.ts';
import { emptyLibrary } from '../src/core/libraryStore.ts';
import { useLibrary } from '../src/state/library.ts';
import { useLive } from '../src/state/live.ts';
import {
  flushPlaylist,
  resetPlaylistOutboxForTests,
  updatePlaylistDraft,
  usePlaylistOutbox,
} from '../src/state/playlistOutbox.ts';
import {
  dirtySettingsPagesSnapshot,
  resetSettingsDraftsForTests,
  revertSettingsDraft,
  saveSettingsDraft,
  setSettingsDraft,
} from '../src/state/settingsDrafts.ts';
import {
  closeThemeEditor,
  discardThemeDraft,
  openThemeEditor,
  resetThemeDraftsForTests,
  saveThemeDraft,
  updateThemeDraft,
  useThemeDrafts,
} from '../src/state/themeDrafts.ts';
import { useToasts } from '../src/state/toasts.ts';
import {
  clearUnsavedRegistryForTests,
  hasAnyPendingWork,
  useUnsaved,
  visibleUnsavedItems,
} from '../src/state/unsaved.ts';
import {
  change,
  discardPresentationById,
  enterPresentation,
  redo,
  resetEditorSessionsForTests,
  savePresentationById,
  setEditorUi,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import { getSlide, updateObject } from '../src/views/editor/ops.ts';

const box = { x: 100, y: 100, w: 800, h: 300, rotation: 0 };
const makeText = (id: string, t: string): TextObject => ({
  id,
  type: 'text',
  box,
  text: t,
  style: { ...DEFAULT_THEME.textBoxDefaults },
  opacity: 1,
});

const makeDeck = (id: string, title: string, slideText = 'Initial'): Presentation => ({
  id,
  rev: 2,
  title,
  kind: 'song',
  themeId: 'theme-1',
  meta: { tags: [] },
  sections: [
    {
      id: `${id}-sec`,
      label: 'Verse 1',
      short: 'V1',
      slides: [{ id: `${id}-s1`, objects: [makeText(`${id}-t1`, slideText)] }],
    },
  ],
  arrangements: [{ id: `${id}-arr`, name: 'Default', sectionIds: [`${id}-sec`] }],
  archived: false,
});

const makeTheme = (id: string, name: string): Theme => ({
  ...structuredClone(DEFAULT_THEME),
  id,
  name,
  rev: 1,
});

const makePlaylist = (id: string, name: string, presentationIds: string[]): Playlist => ({
  id,
  rev: 1,
  name,
  items: presentationIds.map((pid, idx) => ({
    id: `it-${idx}`,
    kind: 'presentation',
    presentationId: pid,
  })),
});

class MemoryJournal implements DraftStoreBackend {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

function slideTextOf(p: Presentation | undefined, id: string): string | undefined {
  return (getSlide(p!, `${id}-s1`)?.objects[0] as TextObject | undefined)?.text;
}

describe('unsaved drafts across tabs, multiple presentations, themes, settings, Go live, and journal recovery', () => {
  let journal: MemoryJournal;
  let storedPresentations: Map<string, Presentation>;
  let storedThemes: Map<string, Theme>;
  let storedPlaylists: Map<string, Playlist>;
  let failPlaylistPut = false;

  beforeEach(() => {
    journal = new MemoryJournal();
    setDraftJournalBackendForTests(journal);
    resetDraftRecoveryForTests();
    resetEditorSessionsForTests();
    resetThemeDraftsForTests();
    resetSettingsDraftsForTests();
    resetPlaylistOutboxForTests();
    clearUnsavedRegistryForTests();
    useToasts.setState({ list: [] });
    failPlaylistPut = false;

    const p1 = makeDeck('p1', 'Way Maker', 'Way maker line 1');
    const p2 = makeDeck('p2', 'Amazing Grace', 'Amazing grace how sweet');
    const t1 = makeTheme('theme-1', 'Sunday Sans');
    const pl1 = makePlaylist('pl1', 'Sunday Morning', ['p1']);

    storedPresentations = new Map([
      ['p1', structuredClone(p1)],
      ['p2', structuredClone(p2)],
    ]);
    storedThemes = new Map([['theme-1', structuredClone(t1)]]);
    storedPlaylists = new Map([['pl1', structuredClone(pl1)]]);

    const lib = emptyLibrary();
    lib.presentations = [p1, p2];
    lib.themes = [t1];
    lib.playlists = [pl1];
    useLibrary.setState({ data: lib, loaded: true, attempted: true, source: 'hub', rev: 1 });
    useLive.setState({ hubConnected: true });

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const path = url.slice(API_PREFIX.length);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

      const presMatch = /^\/presentations\/([^/]+)$/.exec(path);
      if (presMatch) {
        const id = presMatch[1]!;
        const cur = storedPresentations.get(id);
        if (!cur) return json(404, { error: { code: 'not_found', message: 'Not found' } });
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as Presentation;
          if (body.rev !== cur.rev) {
            return json(409, {
              error: { code: 'conflict', message: 'Conflict', rev: cur.rev, current: cur },
            });
          }
          const saved = { ...body, rev: cur.rev + 1 };
          storedPresentations.set(id, saved);
          return json(200, saved);
        }
        return json(200, cur);
      }

      const themeMatch = /^\/themes\/([^/]+)$/.exec(path);
      if (themeMatch && init?.method === 'PUT') {
        const id = themeMatch[1]!;
        const body = JSON.parse(String(init.body)) as Theme;
        const cur = storedThemes.get(id);
        const saved = { ...body, rev: (cur?.rev ?? 1) + 1 };
        storedThemes.set(id, saved);
        return json(200, saved);
      }

      const plMatch = /^\/playlists\/([^/]+)$/.exec(path);
      if (plMatch && init?.method === 'PUT') {
        if (failPlaylistPut) return json(500, { error: { code: 'internal', message: 'Disk full' } });
        const id = plMatch[1]!;
        const body = JSON.parse(String(init.body)) as Playlist;
        const saved = { ...body, rev: body.rev + 1 };
        storedPlaylists.set(id, saved);
        return json(200, saved);
      }

      if (path.startsWith('/settings/') && init?.method === 'PUT') {
        return json(200, JSON.parse(String(init.body)));
      }

      return json(404, { error: { code: 'not_found', message: path } });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps multiple dirty presentations, their 200-step undo stacks, and workspace UI across tab and deck switches', async () => {
    await enterPresentation('p1');
    change((p) => updateObject(p, 'p1-s1', 'p1-t1', (o) => ({ ...(o as TextObject), text: 'Step 1' })));
    change((p) => updateObject(p, 'p1-s1', 'p1-t1', (o) => ({ ...(o as TextObject), text: 'Step 2' })));
    setEditorUi({ songMode: 'canvas', zoom: 0.75, drawerOpen: true, tab: 'presentation' });

    // Switch to a second presentation and edit it too.
    await enterPresentation('p2');
    expect(useEditor.getState().id).toBe('p2');
    expect(useEditor.getState().dirty).toBe(false);
    change((p) => updateObject(p, 'p2-s1', 'p2-t1', (o) => ({ ...(o as TextObject), text: 'Grace edited' })));

    // Both presentations are listed as unsaved in the shell registry.
    expect(
      visibleUnsavedItems()
        .map((i) => i.key)
        .sort(),
    ).toEqual(['pres:p1', 'pres:p2']);

    // Simulate returning from another tab to p1: draft, UI state, and multi-step undo are intact!
    await enterPresentation('p1');
    const st1 = useEditor.getState();
    expect(st1.dirty).toBe(true);
    expect(slideTextOf(st1.draft, 'p1')).toBe('Step 2');
    expect(st1.ui).toMatchObject({
      songMode: 'canvas',
      zoom: 0.75,
      drawerOpen: true,
      tab: 'presentation',
    });

    // Undo step by step on p1: undoing back to base marks p1 clean automatically!
    undo();
    expect(slideTextOf(useEditor.getState().draft, 'p1')).toBe('Step 1');
    expect(useEditor.getState().dirty).toBe(true);
    undo();
    expect(slideTextOf(useEditor.getState().draft, 'p1')).toBe('Way maker line 1');
    expect(useEditor.getState().dirty).toBe(false);
    expect(visibleUnsavedItems().map((i) => i.key)).toEqual(['pres:p2']);

    // Redo re-marks p1 dirty.
    redo();
    expect(useEditor.getState().dirty).toBe(true);
    expect(
      visibleUnsavedItems()
        .map((i) => i.key)
        .sort(),
    ).toEqual(['pres:p1', 'pres:p2']);

    // Save parked p2 in the background while p1 stays open in the editor!
    expect(await savePresentationById('p2')).toBe(true);
    expect(visibleUnsavedItems().map((i) => i.key)).toEqual(['pres:p1']);
    expect(slideTextOf(storedPresentations.get('p2'), 'p2')).toBe('Grace edited');
    expect(useEditor.getState().id).toBe('p1');

    // Discard p1.
    await discardPresentationById('p1');
    expect(useEditor.getState().dirty).toBe(false);
    expect(slideTextOf(useEditor.getState().draft, 'p1')).toBe('Way maker line 1');
    expect(visibleUnsavedItems()).toEqual([]);
  });

  it('preserves Lyric Theme and Settings drafts (including shared surfaces sub-pages) across tab switches', async () => {
    const t1 = useLibrary.getState().data.themes[0]!;
    openThemeEditor(t1);
    expect(useThemeDrafts.getState().entries['theme-1']?.dirty).toBe(false);

    updateThemeDraft('theme-1', (prev) => ({ ...prev, name: 'Modern Gold' }));
    // Leave designer ("Keep draft"): draft remains parked and visible in Nav unsaved items.
    closeThemeEditor();
    expect(useThemeDrafts.getState().editingId).toBeNull();
    expect(useThemeDrafts.getState().entries['theme-1']?.dirty).toBe(true);
    expect(visibleUnsavedItems().some((i) => i.key === 'theme:theme-1')).toBe(true);

    // Re-opening the same theme restores the unsaved draft instead of overwriting with library copy.
    openThemeEditor(t1);
    expect(useThemeDrafts.getState().entries['theme-1']?.draft.name).toBe('Modern Gold');

    // Settings: edit Stage messages AND MIDI on the shared `surfaces` document + General.
    setSettingsDraft(
      'surfaces',
      (prev) => ({ ...prev, messagePresets: ['Parents needed in nursery'] }),
      'messages',
    );
    setSettingsDraft('surfaces', (prev) => ({ ...prev, midiEnabled: true }), 'midi');
    setSettingsDraft('general', (prev) => ({ ...prev, venueName: 'Grace Chapel' }), 'general');

    const dirtyPages = dirtySettingsPagesSnapshot();
    expect([...dirtyPages].sort()).toEqual(['general', 'messages', 'midi']);
    expect(
      useUnsaved.getState().items['settings:surfaces'] !== undefined &&
        useUnsaved.getState().items['settings:general'] !== undefined,
    ).toBe(true);

    // Saving theme and reverting settings cleans up everything.
    expect(await saveThemeDraft('theme-1')).toBe(true);
    revertSettingsDraft('surfaces');
    expect(await saveSettingsDraft('general')).toBe(true);
    expect(visibleUnsavedItems()).toEqual([]);
    discardThemeDraft('theme-1');
  });

  it('keeps debounced playlist edits out of the Nav pill unless a save fails, while still guarding unload', async () => {
    const pl = useLibrary.getState().data.playlists[0]!;
    updatePlaylistDraft(pl, (p) => ({ ...p, name: 'Easter Sunday' }));
    // Protected by beforeunload immediately, but hidden from Nav pill during normal 600ms debounce.
    expect(hasAnyPendingWork()).toBe(true);
    expect(visibleUnsavedItems()).toEqual([]);

    failPlaylistPut = true;
    expect(await flushPlaylist('pl1')).toBe(false);
    // Failed background save surfaces in Nav pill so user never loses playlist changes!
    expect(usePlaylistOutbox.getState().entries['pl1']?.status).toBe('error');
    expect(visibleUnsavedItems().map((i) => i.key)).toEqual(['playlist:pl1']);

    failPlaylistPut = false;
    expect(await flushPlaylist('pl1')).toBe(true);
    expect(visibleUnsavedItems()).toEqual([]);
  });

  it('prompts on Go live only for service-relevant drafts, leaving unrelated drafts parked', async () => {
    // p2 is NOT in playlist pl1; general settings do not affect live outputs.
    await enterPresentation('p2');
    change((p) =>
      updateObject(p, 'p2-s1', 'p2-t1', (o) => ({ ...(o as TextObject), text: 'Next week sermon' })),
    );
    setSettingsDraft('general', (prev) => ({ ...prev, venueName: 'New Name' }), 'general');
    expect(serviceRelevantUnsaved('pl1')).toEqual([]);

    // Now dirty p1 (which IS in pl1) and outputs settings.
    await enterPresentation('p1');
    change((p) =>
      updateObject(p, 'p1-s1', 'p1-t1', (o) => ({ ...(o as TextObject), text: 'Fixed typo before live' })),
    );
    setSettingsDraft('outputs', (prev) => [...prev], 'outputs');
    // Setting identical array clears dirty; make a real change to outputs:
    setSettingsDraft(
      'outputs',
      [
        {
          id: 'out-1',
          name: 'Main Auditorium',
          kind: 'output',
          hostIndex: 1,
          lookId: 'look-main',
          enabled: true,
          audioMaster: true,
        },
      ],
      'outputs',
    );

    expect(
      serviceRelevantUnsaved('pl1')
        .map((i) => i.key)
        .sort(),
    ).toEqual(['pres:p1', 'settings:outputs']);

    const confirmMod = await import('../src/components/Confirm.tsx');
    // 1. Cancel aborts Go live and leaves drafts untouched.
    const spy = vi
      .spyOn(confirmMod, 'choiceDialog')
      .mockResolvedValueOnce('cancel')
      .mockResolvedValueOnce('save');
    expect(await startService('pl1')).toBe(false);
    expect(
      visibleUnsavedItems()
        .map((i) => i.key)
        .sort(),
    ).toEqual(['pres:p1', 'pres:p2', 'settings:general', 'settings:outputs']);

    // 2. Save & Go live saves ONLY p1 and outputs, leaving unrelated p2 and general parked!
    expect(await startService('pl1')).toBe(true);
    expect(slideTextOf(storedPresentations.get('p1'), 'p1')).toBe('Fixed typo before live');
    expect(
      visibleUnsavedItems()
        .map((i) => i.key)
        .sort(),
    ).toEqual(['pres:p2', 'settings:general']);
    spy.mockRestore();
  });

  it('persists dirty drafts to IndexedDB journal and restores or discards them via startup recovery dialog', async () => {
    await enterPresentation('p1');
    change((p) =>
      updateObject(p, 'p1-s1', 'p1-t1', (o) => ({ ...(o as TextObject), text: 'Recovered lyric' })),
    );
    setEditorUi({ songMode: 'canvas', zoom: 0.5 });
    openThemeEditor(useLibrary.getState().data.themes[0]!);
    updateThemeDraft('theme-1', (prev) => ({ ...prev, name: 'Recovered Theme' }));

    await journalFlushNow();
    const persisted = await journalReadAll();
    expect(persisted.map((x) => x.key).sort()).toEqual(['pres:p1', 'theme:theme-1']);

    // Simulate a hard browser reload: wipe in-memory stores without clearing the IndexedDB journal!
    useEditor.setState({ id: undefined, base: undefined, draft: undefined, dirty: false });
    useThemeDrafts.setState({ editingId: null, entries: {} });
    clearUnsavedRegistryForTests();
    resetDraftRecoveryForTests();
    expect(shouldBypassBeforeUnload()).toBe(false);

    // Mock choiceDialog to choose 'restore' on startup!
    const confirmMod = await import('../src/components/Confirm.tsx');
    const spy = vi.spyOn(confirmMod, 'choiceDialog').mockResolvedValueOnce('restore');

    await checkStartupDraftRecovery('operate');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(
      visibleUnsavedItems()
        .map((i) => i.key)
        .sort(),
    ).toEqual(['pres:p1', 'theme:theme-1']);

    await enterPresentation('p1');
    expect(slideTextOf(useEditor.getState().draft, 'p1')).toBe('Recovered lyric');
    expect(useEditor.getState().ui.songMode).toBe('canvas');
    expect(useEditor.getState().ui.zoom).toBe(0.5);
    expect(useThemeDrafts.getState().entries['theme-1']?.draft.name).toBe('Recovered Theme');

    spy.mockRestore();
  });
});
