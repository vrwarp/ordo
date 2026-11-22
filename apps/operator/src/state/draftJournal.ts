import { JsonStore } from '@ordo/cache';
import type { Playlist, Presentation, Theme } from '@ordo/domain';
import type { Settings } from '@ordo/protocol';

export type EditorUiPersist = {
  tab?: 'object' | 'slide' | 'presentation';
  drawerOpen?: boolean;
  stageLens?: 'canvas' | string;
  songMode?: 'reflow' | 'canvas' | null;
  deckMode?: 'canvas' | 'notes';
  notesDockOpen?: boolean | null;
  zoom?: 'fit' | 0.5 | 0.75 | 1;
};

export type JournalEntry =
  | {
      kind: 'presentation';
      id: string;
      base: Presentation;
      draft: Presentation;
      slideId?: string;
      ui?: EditorUiPersist;
      updatedAt: number;
    }
  | {
      kind: 'theme';
      id: string;
      base: Theme;
      draft: Theme;
      editing?: boolean;
      updatedAt: number;
    }
  | {
      kind: 'settings';
      key: keyof Settings;
      base: Settings[keyof Settings];
      draft: Settings[keyof Settings];
      page?: string;
      updatedAt: number;
    }
  | {
      kind: 'playlist';
      id: string;
      baseRev: number;
      draft: Playlist;
      updatedAt: number;
    };

const INDEX_KEY = 'index';
const DEBOUNCE_MS = 400;

export type DraftStoreBackend = Pick<JsonStore, 'get' | 'set'>;

let store: DraftStoreBackend = new JsonStore('ordo-drafts');
/** Active keys persisted (or pending write) in the journal. */
let activeKeys = new Set<string>();
let indexLoaded = false;
let pending = new Map<string, JournalEntry | null>();
let timer: ReturnType<typeof setTimeout> | undefined;
let chain: Promise<void> = Promise.resolve();
let bypassUnload = false;

/** Swap the underlying store for deterministic unit tests. */
export function setDraftJournalBackendForTests(next?: DraftStoreBackend): void {
  clearTimeout(timer);
  timer = undefined;
  pending = new Map();
  activeKeys = new Set();
  indexLoaded = false;
  chain = Promise.resolve();
  bypassUnload = false;
  store = next ?? new JsonStore('ordo-drafts');
}

/** Suppress `beforeunload` during an intentional reload (automated hub version update, Discard & Sign out). */
export function markBypassBeforeUnload(bypass = true): void {
  bypassUnload = bypass;
}

export function shouldBypassBeforeUnload(): boolean {
  return bypassUnload;
}

async function ensureIndex(): Promise<void> {
  if (indexLoaded) return;
  indexLoaded = true;
  try {
    const existing = await store.get<unknown>(INDEX_KEY);
    if (Array.isArray(existing)) {
      for (const k of existing) if (typeof k === 'string') activeKeys.add(k);
    }
  } catch {
    /* IndexedDB unavailable (SSR / Node tests without a stub) */
  }
}

function enqueueCommit(): Promise<void> {
  if (pending.size === 0) return chain;
  const batch = new Map(pending);
  pending.clear();
  chain = chain.then(async () => {
    await ensureIndex();
    for (const [k, v] of batch) {
      if (v === null) activeKeys.delete(k);
      else activeKeys.add(k);
    }
    try {
      await store.set(INDEX_KEY, [...activeKeys]);
      for (const [k, v] of batch) {
        await store.set(k, v);
      }
    } catch {
      /* storage unavailable or quota exceeded: in-memory drafts remain intact */
    }
  });
  return chain;
}

/** Schedule a debounced write of one unsaved draft entry to IndexedDB. */
export function journalPut(key: string, entry: JournalEntry): void {
  pending.set(key, entry);
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void enqueueCommit();
  }, DEBOUNCE_MS);
}

/** Remove an entry from the IndexedDB draft journal (after Save or Discard). */
export function journalRemove(key: string): void {
  pending.set(key, null);
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void enqueueCommit();
  }, DEBOUNCE_MS);
}

/** Immediately flush all queued journal writes (before reload, visibility hidden, or test assertions). */
export function journalFlushNow(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  return enqueueCommit();
}

/** Read all persisted journal entries currently stored in IndexedDB. */
export async function journalReadAll(): Promise<{ key: string; entry: JournalEntry }[]> {
  await journalFlushNow();
  await ensureIndex();
  const keys = [...activeKeys];
  const out: { key: string; entry: JournalEntry }[] = [];
  for (const key of keys) {
    try {
      const entry = await store.get<JournalEntry | null>(key);
      if (entry && typeof entry === 'object' && 'kind' in entry) {
        out.push({ key, entry });
      }
    } catch {
      /* ignore corrupt or unavailable entry */
    }
  }
  return out;
}

/** Wipe every entry from the IndexedDB draft journal (e.g. Discard all on startup, or Discard & Sign out). */
export async function journalClearAll(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  pending.clear();
  chain = chain.then(async () => {
    await ensureIndex();
    const oldKeys = [...activeKeys];
    activeKeys.clear();
    try {
      await store.set(INDEX_KEY, []);
      for (const k of oldKeys) await store.set(k, null);
    } catch {
      /* ignore */
    }
  });
  await chain;
}

if (typeof document !== 'undefined') {
  // iPadOS Safari may evict a backgrounded tab without firing beforeunload: flush queued writes on hide.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void journalFlushNow();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    void journalFlushNow();
  });
}
