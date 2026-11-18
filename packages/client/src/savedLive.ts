import type { Cue, LiveState, Presentation, ResolvedPlaylist } from '@ordo/domain';

/**
 * How a window keeps the running service on its own computer (design/29 §2.3 M2, A22; live-by-ref).
 *
 * Before: every GO cloned the whole state, the resolved copy included (tens of megabytes), into IndexedDB.
 * Now a GO writes a small record (`slimState`: no copy, no cue list) and the copy is written ONCE per service,
 * in pieces: one record per presentation, the cue list, the head (the copy without its presentations), and, last,
 * a marker that names them. A load reads the marker and joins what it names; a torn write never names an
 * incomplete copy, and a copy it cannot join completely is `undefined` (the window then waits for the hub, as a
 * window with no cache does: the cache is a convenience, never a requirement).
 */

/** The window's JSON store (`JsonKv` of the output, the stage's `KV`, the operator's `JsonStore`). */
export type CopyKv = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
};

export type CopyMarker = { id: string; presentations: string[]; cues: boolean; at: number };
export type LoadedCopy = { id: string; resolved: ResolvedPlaylist; cues: Cue[] };

/** The state without its copy and its cue list: what a GO writes (as big as its slim fields, whatever the service). */
export type SlimState = Omit<LiveState, 'resolved' | 'cues'>;

export function slimState(state: LiveState): SlimState {
  const { resolved: _r, cues: _c, ...rest } = state;
  return rest;
}

/** The slim state, the cue list and the copy joined back into the state a window applies. */
export function joinSaved(slim: SlimState, copy: Pick<LoadedCopy, 'resolved' | 'cues'>): LiveState {
  return { ...slim, cues: copy.cues, resolved: copy.resolved };
}

/** The copy without its presentations, and its presentations by id (the objects themselves). */
export function splitResolved(resolved: ResolvedPlaylist): {
  head: Omit<ResolvedPlaylist, 'presentations'> & { presentations: Record<string, never> };
  parts: Map<string, Presentation>;
} {
  const parts = new Map<string, Presentation>(Object.entries(resolved.presentations));
  return { head: { ...resolved, presentations: {} }, parts };
}

export function joinResolved(
  head: Omit<ResolvedPlaylist, 'presentations'>,
  parts: Map<string, Presentation>,
): ResolvedPlaylist {
  return { ...head, presentations: Object.fromEntries(parts) } as ResolvedPlaylist;
}

const markerKey = (scope: string) => `copy:${scope}`;
const headKey = (scope: string, id: string) => `copy:${scope}:${id}:head`;
const cuesKey = (scope: string, id: string) => `copy:${scope}:${id}:cues`;
const partKey = (scope: string, id: string, pid: string) => `copy:${scope}:${id}:p:${pid}`;

const isMarker = (m: unknown): m is CopyMarker =>
  !!m &&
  typeof m === 'object' &&
  typeof (m as CopyMarker).id === 'string' &&
  Array.isArray((m as CopyMarker).presentations) &&
  (m as CopyMarker).presentations.every((p) => typeof p === 'string');

export type SaveOptions = {
  /** Aborts the save at its next put (a newer copy arrived, or the window is ending). */
  signal?: AbortSignal;
  /** A put that took longer than this many ms is followed by a pause of one task (default 2 ms). */
  yieldAfterMs?: number;
  /** The clock for `at` and the pacing (tests). */
  now?: () => number;
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Save the copy and the cue list of the service under `id`, in pieces, off the GO. Order: the presentations,
 * the cue list, the head, then the marker; then the records of the previous id are removed (best effort: a
 * record is set to `null`, the stores have no delete). One put is one task and a long one is followed by a pause
 * of one task. Resolves `'present'` when the marker already names `id`, `'aborted'` when `opts.signal` fired,
 * `'failed'` on any store error (never rejects: a failing store is a diagnostic, not a fault).
 */
export async function saveCopy(
  kv: CopyKv,
  scope: string,
  id: string,
  resolved: ResolvedPlaylist,
  cues: Cue[],
  opts: SaveOptions = {},
): Promise<'saved' | 'present' | 'aborted' | 'failed'> {
  const now = opts.now ?? (() => performance.now());
  const slow = opts.yieldAfterMs ?? 2;
  let prev: CopyMarker | undefined;
  try {
    const existing = await kv.get<unknown>(markerKey(scope));
    if (isMarker(existing)) {
      if (existing.id === id) return 'present';
      prev = existing;
    }
    const { head, parts } = splitResolved(resolved);
    const put = async (key: string, value: unknown): Promise<boolean> => {
      if (opts.signal?.aborted) return false;
      const t0 = now();
      await kv.set(key, value);
      if (now() - t0 > slow) await tick();
      return !opts.signal?.aborted;
    };
    for (const [pid, p] of parts) if (!(await put(partKey(scope, id, pid), p))) return 'aborted';
    if (!(await put(cuesKey(scope, id), cues))) return 'aborted';
    if (!(await put(headKey(scope, id), head))) return 'aborted';
    const marker: CopyMarker = { id, presentations: [...parts.keys()], cues: true, at: Date.now() };
    if (!(await put(markerKey(scope), marker))) return 'aborted';
    if (prev) {
      for (const pid of prev.presentations) await kv.set(partKey(scope, prev.id, pid), null).catch(() => undefined);
      await kv.set(cuesKey(scope, prev.id), null).catch(() => undefined);
      await kv.set(headKey(scope, prev.id), null).catch(() => undefined);
    }
    return 'saved';
  } catch {
    return 'failed';
  }
}

/**
 * The saved copy of this scope, joined, or `undefined` when there is none or it is not complete (no marker, a
 * missing head, cue list or presentation). Never throws.
 */
export async function loadCopy(kv: CopyKv, scope: string): Promise<LoadedCopy | undefined> {
  try {
    const marker = await kv.get<unknown>(markerKey(scope));
    if (!isMarker(marker)) return undefined;
    const head = await kv.get<Omit<ResolvedPlaylist, 'presentations'>>(headKey(scope, marker.id));
    if (!head || typeof head !== 'object') return undefined;
    const cues = marker.cues ? await kv.get<Cue[]>(cuesKey(scope, marker.id)) : [];
    if (!Array.isArray(cues)) return undefined;
    const parts = new Map<string, Presentation>();
    for (const pid of marker.presentations) {
      const p = await kv.get<Presentation>(partKey(scope, marker.id, pid));
      if (!p || typeof p !== 'object') return undefined;
      parts.set(pid, p);
    }
    return { id: marker.id, resolved: joinResolved(head, parts), cues };
  } catch {
    return undefined;
  }
}

/** The id the marker of this scope names, if it is a marker (a cheap read: no part is read). */
export async function savedCopyId(kv: CopyKv, scope: string): Promise<string | undefined> {
  try {
    const m = await kv.get<unknown>(markerKey(scope));
    return isMarker(m) ? m.id : undefined;
  } catch {
    return undefined;
  }
}
