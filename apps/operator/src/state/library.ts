import { DEFAULT_AUDIO, DEFAULT_GENERAL, DEFAULT_KEYMAP, DEFAULT_LOOKS, DEFAULT_SURFACES, type Playlist } from '@ordo/domain';
import { api } from '@ordo/client';
import { JsonStore } from '@ordo/cache';
import { type LibraryDelta, type LibrarySnapshot, ROUTES, type Settings } from '@ordo/protocol';
import { create } from 'zustand';
import { applyLibraryDelta, fromSnapshot, type LibraryData } from '../lib/libraryData.ts';
import { SearchIndex } from '../lib/search.ts';

export const jsonStore = new JsonStore('ordo-operator');
const KEY = 'library';

export const EMPTY_SETTINGS: Settings = {
  general: DEFAULT_GENERAL,
  looks: DEFAULT_LOOKS,
  outputs: [],
  audio: DEFAULT_AUDIO,
  keymap: DEFAULT_KEYMAP,
  surfaces: DEFAULT_SURFACES,
};

type LibraryState = {
  data: LibraryData;
  loaded: boolean;
  source: 'none' | 'cache' | 'hub';
  error?: string;
};

const empty: LibraryData = {
  seq: 0,
  presentations: [],
  playlists: [],
  media: [],
  fonts: [],
  themes: [],
  folders: [],
  settings: EMPTY_SETTINGS,
  jobs: {},
};

export const useLibrary = create<LibraryState>(() => ({ data: empty, loaded: false, source: 'none' }));

export const searchIndex = new SearchIndex();

/** Fill missing settings keys with defaults so the UI never sees undefined documents. */
function withDefaults(s: Partial<Settings> | undefined): Settings {
  return {
    general: { ...DEFAULT_GENERAL, ...(s?.general ?? {}) },
    looks: s?.looks?.length ? s.looks : DEFAULT_LOOKS,
    outputs: s?.outputs ?? [],
    audio: { ...DEFAULT_AUDIO, ...(s?.audio ?? {}) },
    keymap: s?.keymap && Object.keys(s.keymap).length ? s.keymap : DEFAULT_KEYMAP,
    surfaces: { ...DEFAULT_SURFACES, ...(s?.surfaces ?? {}) },
  };
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const { data, source } = useLibrary.getState();
    if (source !== 'hub') return;
    void jsonStore.set(KEY, { ...data, jobs: {} }).catch(() => undefined);
  }, 1000);
}

export async function loadCachedLibrary(): Promise<boolean> {
  try {
    const cached = await jsonStore.get<LibraryData>(KEY);
    if (cached && useLibrary.getState().source === 'none') {
      useLibrary.setState({
        data: { ...cached, settings: withDefaults(cached.settings), jobs: {} },
        loaded: true,
        source: 'cache',
      });
      return true;
    }
  } catch {
    /* IndexedDB unavailable */
  }
  return false;
}

export async function loadLibrary(): Promise<void> {
  try {
    const snap = await api<LibrarySnapshot>(ROUTES.snapshot);
    const data = fromSnapshot(snap);
    data.settings = withDefaults(snap.settings);
    data.jobs = useLibrary.getState().data.jobs;
    useLibrary.setState({ data, loaded: true, source: 'hub', error: undefined });
    persist();
  } catch (e) {
    useLibrary.setState({ error: e instanceof Error ? e.message : String(e) });
    if (!useLibrary.getState().loaded) await loadCachedLibrary();
  }
}

export async function refetchSettings(): Promise<void> {
  try {
    const s = await api<Settings>(ROUTES.settings);
    useLibrary.setState((st) => ({ data: { ...st.data, settings: withDefaults(s) } }));
    persist();
  } catch {
    /* edit role cannot read settings; snapshot has them */
  }
}

export function applyDelta(d: LibraryDelta): void {
  const st = useLibrary.getState();
  const r = applyLibraryDelta(st.data, d.changes);
  if (r.data !== st.data) {
    r.data.settings = withDefaults(r.data.settings);
    useLibrary.setState({ data: r.data });
    persist();
  }
  if (r.refetchSettings) void refetchSettings();
}

/** Local patch after a successful API write (the delta will confirm). */
export function patchLibrary(fn: (d: LibraryData) => LibraryData): void {
  useLibrary.setState((s) => ({ data: fn(s.data) }));
  persist();
}

export function upsertLocal<K extends 'presentations' | 'playlists' | 'media' | 'fonts' | 'themes' | 'folders'>(
  key: K,
  entity: LibraryData[K][number],
): void {
  patchLibrary((d) => {
    const list = d[key] as { id: string }[];
    const i = list.findIndex((x) => x.id === entity.id);
    const out = i < 0 ? [...list, entity] : list.map((x, k) => (k === i ? entity : x));
    return { ...d, [key]: out };
  });
}

export function removeLocal(key: 'presentations' | 'playlists' | 'media' | 'fonts' | 'themes' | 'folders', id: string): void {
  patchLibrary((d) => ({ ...d, [key]: (d[key] as { id: string }[]).filter((x) => x.id !== id) }));
}

export function settings(): Settings {
  return useLibrary.getState().data.settings;
}

export function playlistById(id: string | undefined): Playlist | undefined {
  return id ? useLibrary.getState().data.playlists.find((p) => p.id === id) : undefined;
}

/** PUT one settings document and update the local copy. */
export async function saveSettings<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  const res = await api<Settings[K] | undefined>(`${ROUTES.settings}/${key}`, { method: 'PUT', json: value });
  const v = settingsResult(key, value, res);
  useLibrary.setState((s) => ({ data: { ...s.data, settings: { ...s.data.settings, [key]: v } } }));
  persist();
}

/** The hub may answer a settings PUT with the document, the whole settings, or nothing. */
function settingsResult<K extends keyof Settings>(key: K, sent: Settings[K], res: unknown): Settings[K] {
  if (!res || typeof res !== 'object' || res instanceof Blob) return sent;
  const r = res as Record<string, unknown>;
  if (!Array.isArray(res) && 'looks' in r && 'outputs' in r && key in r) return r[key] as Settings[K];
  if (Array.isArray(sent) !== Array.isArray(res)) return sent;
  return res as Settings[K];
}
