import { useEffect, useSyncExternalStore } from 'react';
import type { Profile } from './lib/capabilities.ts';
import type { Layout } from './lib/layout.ts';

/**
 * The page registry (design/28 §3.1 "Code split", design/24 "Bundle budget"): the pages and services the
 * entry does not import statically, each loaded once and then rendered synchronously. Not React.lazy: a
 * Suspense fallback is held at least 300 ms before React reveals the content, even from a warm cache, which
 * made the venue PC's first editor open and its live view after sign-in about 0.3 s slower. A regular device
 * preloads what its capability profile can open at startup (preloadFor, from main.tsx); a phone or the
 * compact layout preloads nothing of the regular set, so it never downloads the editor, the live view, Setup
 * or the settings pages.
 */
export type ChunkState<T> = {
  readonly status: 'idle' | 'loading' | 'loaded' | 'failed';
  readonly value?: T;
  readonly error?: unknown;
};

export type Chunk<T> = {
  /** The module the loader imports (its import() literal; pages.test.ts checks they agree). */
  readonly module: string;
  /** Start (or join) the load. One memoized promise; a rejection clears it, so the next load retries. */
  load(): Promise<T>;
  /** The loaded value, or undefined. */
  get(): T | undefined;
  /** The last load's error until the next load starts. */
  error(): unknown;
  /** The current state (a new object on every change: a useSyncExternalStore snapshot). */
  state(): ChunkState<T>;
  subscribe(fn: () => void): () => void;
};

export function chunk<T>(module: string, load: () => Promise<T>): Chunk<T> {
  let current: ChunkState<T> = { status: 'idle' };
  let pending: Promise<T> | undefined;
  const subs = new Set<() => void>();
  const set = (s: ChunkState<T>) => {
    current = s;
    for (const fn of [...subs]) fn();
  };
  return {
    module,
    load() {
      if (current.status === 'loaded') return Promise.resolve(current.value as T);
      if (pending) return pending;
      set({ status: 'loading' });
      const p = Promise.resolve()
        .then(load)
        .then(
          (value) => {
            pending = undefined;
            set({ status: 'loaded', value });
            return value;
          },
          (error: unknown) => {
            pending = undefined;
            set({ status: 'failed', error });
            throw error;
          },
        );
      pending = p;
      return p;
    },
    get: () => current.value,
    error: () => current.error,
    state: () => current,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/**
 * A chunk's state, loading it (once, in an effect) only while `enabled`: a hook that loaded unconditionally
 * would make a phone fetch regular chunks (the planner's prototype fetched the operate services there).
 */
export function useChunk<T>(c: Chunk<T>, enabled = true): ChunkState<T> {
  const s = useSyncExternalStore(c.subscribe, c.state, c.state);
  useEffect(() => loadIfEnabled(c, enabled), [c, enabled]);
  return s;
}

/** useChunk's effect: start the load of an idle chunk, only while enabled (a failed one waits for Retry). */
export function loadIfEnabled(c: Chunk<unknown>, enabled: boolean): void {
  if (enabled && c.state().status === 'idle') void c.load().catch(() => undefined);
}

/** The lazily loaded pages: the registry keys App and LibraryView render through PageHost. */
export const PAGES = {
  live: chunk('./views/live/LiveView.tsx', () => import('./views/live/LiveView.tsx').then((m) => m.LiveView)),
  edit: chunk('./views/editor/EditorView.tsx', () =>
    import('./views/editor/EditorView.tsx').then((m) => m.EditorView),
  ),
  playlists: chunk('./views/playlists/PlaylistsView.tsx', () =>
    import('./views/playlists/PlaylistsView.tsx').then((m) => m.PlaylistsView),
  ),
  previews: chunk('./views/editor/PreviewsView.tsx', () =>
    import('./views/editor/PreviewsView.tsx').then((m) => m.PreviewsView),
  ),
  settings: chunk('./views/settings/SettingsView.tsx', () =>
    import('./views/settings/SettingsView.tsx').then((m) => m.SettingsView),
  ),
  setup: chunk('./views/setup/DeviceSetupView.tsx', () =>
    import('./views/setup/DeviceSetupView.tsx').then((m) => m.DeviceSetupView),
  ),
  themes: chunk('./views/library/ThemesTab.tsx', () =>
    import('./views/library/ThemesTab.tsx').then((m) => m.ThemesTab),
  ),
  fonts: chunk('./views/library/FontsTab.tsx', () =>
    import('./views/library/FontsTab.tsx').then((m) => m.FontsTab),
  ),
  import: chunk('./views/library/ImportTab.tsx', () =>
    import('./views/library/ImportTab.tsx').then((m) => m.ImportTab),
  ),
};

export type PageName = keyof typeof PAGES;

/** The regular pages a device of this capability profile can open (allowedForRole's widest role, operate). */
export const REGULAR_PAGES: Record<Profile, readonly PageName[]> = {
  full: ['live', 'edit', 'playlists', 'previews', 'settings', 'setup', 'themes', 'fonts', 'import'],
  edit: ['edit', 'playlists', 'previews', 'settings', 'themes', 'fonts', 'import'],
};

/** The compact layout's own pages (P0: none; the compact shell adds its chunk). */
export const COMPACT_PAGES: readonly PageName[] = [];

/**
 * What a device loads at startup, beside the session request: a phone (on either layout) or the compact
 * layout loads the compact set; a regular device every regular page its capability profile can open, and the
 * operate services on the full profile. Names only (pages.test.ts); preloadFor starts the loads.
 */
export function preloadSet(
  layout: Layout,
  capabilityProfile: Profile,
  phone: boolean,
): { pages: readonly PageName[]; operate: boolean } {
  if (phone || layout === 'compact') return { pages: COMPACT_PAGES, operate: false };
  return { pages: REGULAR_PAGES[capabilityProfile], operate: capabilityProfile === 'full' };
}

export function preloadFor(layout: Layout, capabilityProfile: Profile, phone: boolean): Chunk<unknown>[] {
  const set = preloadSet(layout, capabilityProfile, phone);
  const chunks: Chunk<unknown>[] = set.pages.map((k) => PAGES[k] as Chunk<unknown>);
  for (const c of chunks) void c.load().catch(() => undefined);
  return chunks;
}

/** Every chunk a set needs, loaded (true), with the first error if one failed. */
export function setState(chunks: readonly Chunk<unknown>[]): { ready: boolean; error?: unknown } {
  let ready = true;
  for (const c of chunks) {
    const s = c.state();
    if (s.status === 'failed') return { ready: false, error: s.error };
    if (s.status !== 'loaded') ready = false;
  }
  return { ready };
}

/** Hook form of setState, loading each chunk while `enabled` (the full profile's gate in App). */
export function useChunks(
  chunks: readonly Chunk<unknown>[],
  enabled: boolean,
): { ready: boolean; error?: unknown } {
  const key = useSyncExternalStore(
    (fn) => {
      const offs = chunks.map((c) => c.subscribe(fn));
      return () => {
        for (const off of offs) off();
      };
    },
    () => chunks.map((c) => c.state().status).join(),
    () => '',
  );
  useEffect(() => {
    for (const c of chunks) loadIfEnabled(c, enabled);
  }, [chunks, enabled]);
  void key;
  return setState(chunks);
}

/** Load every failed chunk of a set again (the error card's Retry). */
export function retryChunks(chunks: readonly Chunk<unknown>[]): void {
  for (const c of chunks) if (c.state().status === 'failed') void c.load().catch(() => undefined);
}

/** The registry's state for the end-to-end specs: `window.__ordo.pages()`. */
export function pagesState(): { name: string; module: string; status: ChunkState<unknown>['status'] }[] {
  const all = Object.entries(PAGES) as [string, Chunk<unknown>][];
  return all.map(([name, c]) => ({ name, module: c.module, status: c.state().status }));
}

if (typeof window !== 'undefined') {
  // Added to the object that is there, never spread into a new one (lib/layout.ts does the same).
  const w = window as unknown as { __ordo?: Record<string, unknown> };
  w.__ordo ??= {};
  Object.defineProperty(w.__ordo, 'pages', { configurable: true, enumerable: true, value: pagesState });
}
