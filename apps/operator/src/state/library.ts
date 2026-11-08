import type { Playlist } from '@ordo/domain';
import { api } from '@ordo/client';
import { ROUTES, type Settings } from '@ordo/protocol';
import { create } from 'zustand';
import type { CoreToMain, LibKey, LibOp } from '../core/protocol.ts';
import {
  applyLibOp,
  applyLibPatch,
  EMPTY_SETTINGS,
  emptyLibrary,
  withDefaults,
} from '../core/libraryStore.ts';
import type { LibraryData } from '../lib/libraryData.ts';

export { EMPTY_SETTINGS };

/**
 * The main thread's read model of the library (design/25). The core worker owns the library: the hub
 * snapshot, `library.delta` updates, the IndexedDB copy and the search index. It posts the whole library
 * once and then only changed entities; local writes after a successful API call are applied here at once
 * and forwarded to the core.
 */
type LibraryState = {
  data: LibraryData;
  /** Something to show: the cache or the hub answered. */
  loaded: boolean;
  /** The core tried (cache and hub), whatever the outcome: the UI can stop waiting. */
  attempted: boolean;
  source: 'none' | 'cache' | 'hub';
  error?: string;
  /** Revision of the core's library this read model reflects. */
  rev: number;
};

export const useLibrary = create<LibraryState>(() => ({
  data: emptyLibrary(),
  loaded: false,
  attempted: false,
  source: 'none',
  rev: -1,
}));

let sink: ((op: LibOp) => void) | undefined;
let reload: (() => void) | undefined;

/** Wire local writes and reloads to the core (set by the controller). */
export function connectLibrary(opts: { op: (op: LibOp) => void; reload: () => void } | undefined): void {
  sink = opts?.op;
  reload = opts?.reload;
}

/** Apply a library message from the core worker. */
export function applyCoreLibrary(m: Extract<CoreToMain, { t: 'lib' }>): void {
  if (m.full) {
    const { data, source } = m.full;
    useLibrary.setState({
      data: { ...data, settings: withDefaults(data.settings) },
      loaded: source !== 'none' || useLibrary.getState().loaded,
      attempted: true,
      source,
      error: m.error,
      rev: m.rev,
    });
    return;
  }
  if (m.patch) {
    const st = useLibrary.getState();
    const data = applyLibPatch(st.data, m.patch);
    useLibrary.setState({
      data,
      rev: m.rev,
      error: m.error,
      loaded: true,
      attempted: true,
      source: st.source === 'none' ? 'hub' : st.source,
    });
    return;
  }
  useLibrary.setState({ error: m.error, attempted: true, rev: m.rev });
}

/** Ask the core to fetch the hub snapshot again. */
export function loadLibrary(): void {
  reload?.();
}

function local(op: LibOp): void {
  useLibrary.setState((s) => ({ data: applyLibOp(s.data, op) }));
  sink?.(op);
}

export function upsertLocal<K extends LibKey>(key: K, entity: LibraryData[K][number]): void {
  local({ k: 'upsert', key, entity });
}

export function removeLocal(key: LibKey, id: string): void {
  local({ k: 'remove', key, id });
}

export function settings(): Settings {
  return useLibrary.getState().data.settings;
}

export function playlistById(id: string | undefined): Playlist | undefined {
  return id ? useLibrary.getState().data.playlists.find((p) => p.id === id) : undefined;
}

/** PUT one settings document and update the local copy (and the core's). */
export async function saveSettings<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  const res = await api<Settings[K] | undefined>(`${ROUTES.settings}/${key}`, { method: 'PUT', json: value });
  local({ k: 'settings', key, value: settingsResult(key, value, res) });
}

/** The hub may answer a settings PUT with the document, the whole settings, or nothing. */
function settingsResult<K extends keyof Settings>(key: K, sent: Settings[K], res: unknown): Settings[K] {
  if (!res || typeof res !== 'object' || res instanceof Blob) return sent;
  const r = res as Record<string, unknown>;
  if (!Array.isArray(res) && 'looks' in r && 'outputs' in r && key in r) return r[key] as Settings[K];
  if (Array.isArray(sent) !== Array.isArray(res)) return sent;
  return res as Settings[K];
}
