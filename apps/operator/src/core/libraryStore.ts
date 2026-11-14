import {
  DEFAULT_AUDIO,
  DEFAULT_GENERAL,
  DEFAULT_KEYMAP,
  DEFAULT_LOOKS,
  DEFAULT_SURFACES,
  upgradeStoredSurfaces,
} from '@ordo/domain';
import type { LibraryDelta, LibrarySnapshot, Settings } from '@ordo/protocol';
import { applyLibraryDelta, fromSnapshot, type LibraryData } from '../lib/libraryData.ts';
import { LIB_KEYS, type LibKey, type LibOp, type LibPatch } from './protocol.ts';

export const EMPTY_SETTINGS: Settings = {
  general: DEFAULT_GENERAL,
  looks: DEFAULT_LOOKS,
  outputs: [],
  audio: DEFAULT_AUDIO,
  keymap: DEFAULT_KEYMAP,
  surfaces: DEFAULT_SURFACES,
};

export function emptyLibrary(): LibraryData {
  return {
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
}

/** Fill missing settings keys with defaults so the UI never sees undefined documents. */
export function withDefaults(s: Partial<Settings> | undefined): Settings {
  return {
    general: { ...DEFAULT_GENERAL, ...(s?.general ?? {}) },
    looks: s?.looks?.length ? s.looks : DEFAULT_LOOKS,
    outputs: s?.outputs ?? [],
    audio: { ...DEFAULT_AUDIO, ...(s?.audio ?? {}) },
    keymap: s?.keymap && Object.keys(s.keymap).length ? s.keymap : DEFAULT_KEYMAP,
    // A copy cached before MIDI became opt-in reads as the hub reads it (`upgradeStoredSurfaces`).
    surfaces: {
      ...DEFAULT_SURFACES,
      ...((upgradeStoredSurfaces(s?.surfaces) as Settings['surfaces']) ?? {}),
    },
  };
}

/** Apply one local write to library data (shared by the worker store and the main read model). */
export function applyLibOp(d: LibraryData, op: LibOp): LibraryData {
  switch (op.k) {
    case 'upsert': {
      const list = d[op.key] as { id: string }[];
      const i = list.findIndex((x) => x.id === op.entity.id);
      const out = i < 0 ? [...list, op.entity] : list.map((x, k) => (k === i ? op.entity : x));
      return { ...d, [op.key]: out };
    }
    case 'remove':
      return { ...d, [op.key]: (d[op.key] as { id: string }[]).filter((x) => x.id !== op.id) };
    case 'settings':
      return { ...d, settings: { ...d.settings, [op.key]: op.value } };
  }
}

/** Apply a posted patch to library data (main read model). Untouched entities keep their identity. */
export function applyLibPatch(d: LibraryData, p: LibPatch): LibraryData {
  let out: LibraryData = { ...d };
  for (const key of LIB_KEYS) {
    const ups = p.upsert?.[key];
    const rem = p.remove?.[key];
    if (!ups?.length && !rem?.length) continue;
    let list = (out[key] as { id: string }[]).slice();
    if (rem?.length) {
      const gone = new Set(rem);
      list = list.filter((x) => !gone.has(x.id));
    }
    if (ups?.length) {
      const idx = new Map(list.map((x, i) => [x.id, i]));
      for (const e of ups) {
        const i = idx.get(e.id);
        if (i === undefined) {
          idx.set(e.id, list.length);
          list.push(e);
        } else list[i] = e;
      }
    }
    out = { ...out, [key]: list };
  }
  if (p.settings) out.settings = p.settings;
  if (p.jobs) out.jobs = p.jobs;
  if (p.seq !== undefined) out.seq = p.seq;
  return out;
}

/**
 * The changes between two versions of the library, by reference identity: `applyLibraryDelta` and
 * `applyLibOp` keep untouched entities, so only changed ones are posted.
 */
export function diffLibrary(a: LibraryData, b: LibraryData): LibPatch | null {
  const p: LibPatch = {};
  let any = false;
  for (const key of LIB_KEYS) {
    const la = a[key] as { id: string }[];
    const lb = b[key] as { id: string }[];
    if (la === lb) continue;
    const before = new Map(la.map((x) => [x.id, x]));
    const ups: { id: string }[] = [];
    for (const e of lb) {
      if (before.get(e.id) !== e) ups.push(e);
      before.delete(e.id);
    }
    if (ups.length) {
      p.upsert = { ...p.upsert, [key]: ups };
      any = true;
    }
    if (before.size) {
      p.remove = { ...p.remove, [key]: [...before.keys()] };
      any = true;
    }
  }
  if (a.settings !== b.settings) {
    p.settings = b.settings;
    any = true;
  }
  if (a.jobs !== b.jobs) {
    p.jobs = b.jobs;
    any = true;
  }
  if (a.seq !== b.seq) {
    p.seq = b.seq;
    any = true;
  }
  return any ? p : null;
}

export type LibraryStoreDeps = {
  fetchSnapshot(): Promise<LibrarySnapshot>;
  fetchSettings(): Promise<Settings>;
  cacheGet(): Promise<LibraryData | undefined>;
  cacheSet(d: LibraryData): Promise<void>;
  /** Called (coalesced by the caller) whenever the data changed. */
  onChange(): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

/**
 * The core worker's library: hub snapshot, `library.delta` updates, local writes from the UI, and the
 * IndexedDB copy used when the hub is unreachable at startup (design/15, design/17).
 */
export class LibraryStore {
  data: LibraryData = emptyLibrary();
  source: 'none' | 'cache' | 'hub' = 'none';
  error?: string;
  /** Bumped on every change; the main thread's read model carries the same number. */
  rev = 0;
  private persistTimer?: unknown;
  private loading?: Promise<void>;
  /**
   * Local writes applied before any copy loaded (the 1.5 s after a core restart): the cached copy, when it
   * arrives, goes underneath them instead of replacing them (review item 26).
   */
  private early: LibOp[] = [];

  private deps: LibraryStoreDeps;
  constructor(deps: LibraryStoreDeps) {
    this.deps = deps;
  }

  async loadCached(): Promise<boolean> {
    try {
      const cached = await this.deps.cacheGet();
      if (cached && this.source === 'none') {
        let data: LibraryData = { ...cached, settings: withDefaults(cached.settings), jobs: {} };
        for (const op of this.early) data = applyLibOp(data, op);
        this.early = [];
        this.set(data, 'cache');
        return true;
      }
    } catch {
      /* IndexedDB unavailable */
    }
    return false;
  }

  /** Fetch the hub snapshot (coalesced). Falls back to the cached copy when the hub cannot be reached. */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const snap = await this.deps.fetchSnapshot();
        const data = fromSnapshot(snap);
        data.settings = withDefaults(snap.settings);
        data.jobs = this.data.jobs;
        this.error = undefined;
        // The hub's snapshot follows the API calls behind any early local write: it already holds them.
        this.early = [];
        this.set(data, 'hub');
        this.persist();
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        if (this.source === 'none') await this.loadCached();
        this.deps.onChange();
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  applyDelta(d: LibraryDelta): void {
    const r = applyLibraryDelta(this.data, d.changes);
    if (r.data !== this.data) {
      r.data.settings = withDefaults(r.data.settings);
      this.set(r.data, this.source);
      this.persist();
    }
    if (r.refetchSettings) void this.refetchSettings();
  }

  async refetchSettings(): Promise<void> {
    try {
      const s = await this.deps.fetchSettings();
      this.set({ ...this.data, settings: withDefaults(s) }, this.source);
      this.persist();
    } catch {
      /* edit role cannot read settings; snapshot has them */
    }
  }

  applyOp(op: LibOp): void {
    if (this.source === 'none' && this.early.length < 100) this.early.push(op);
    this.set(applyLibOp(this.data, op), this.source);
    this.persist();
  }

  get settings(): Settings {
    return this.data.settings;
  }

  list<K extends LibKey>(key: K): LibraryData[K] {
    return this.data[key];
  }

  private set(data: LibraryData, source: LibraryStore['source']): void {
    this.data = data;
    this.source = source;
    this.rev++;
    this.deps.onChange();
  }

  private persist(): void {
    const clear = this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    if (this.persistTimer !== undefined) clear(this.persistTimer);
    this.persistTimer = set(() => {
      this.persistTimer = undefined;
      if (this.source !== 'hub') return;
      void this.deps.cacheSet({ ...this.data, jobs: {} }).catch(() => undefined);
    }, 1000);
  }
}
