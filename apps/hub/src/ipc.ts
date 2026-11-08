/**
 * Messages between the supervisor and its two children over the Node IPC channel (child_process.fork).
 * Children never talk to each other over IPC: the supervisor relays, caches the last value of each kind
 * and replays it to a restarted child, so a restart never misses the locks or the library address.
 */
import type { Change } from './library.ts';
import type { LibraryStats } from './libstats.ts';

export type ChildName = 'live' | 'library';

/** Edit locks and mode of the live service, as the library process needs them. */
export type LocksMsg = {
  t: 'locks';
  mode: 'idle' | 'live';
  playlistId?: string;
  presentations: string[];
  media: string[];
};

export type ChildState = 'starting' | 'up' | 'down' | 'failed' | 'stopped';
export type ProcessStatus = {
  name: ChildName;
  state: ChildState;
  pid?: number;
  /** Restarts since the supervisor started. */
  restarts: number;
  /** Crashes in the current budget window. */
  recentCrashes: number;
  lastExit?: { code: number | null; signal: string | null; at: number };
};

/** Child -> supervisor. */
export type FromChild =
  | { t: 'ready'; url: string }
  /** Every HEARTBEAT_MS from a timer: a child whose event loop is stuck stops sending it. */
  | { t: 'beat' }
  | LocksMsg
  /** `seq`: the library sequence after these changes (the live process's read-your-writes barrier). */
  | { t: 'changes'; changes: Change[]; seq?: number }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  /** The library's size for hub health (design/27 §3.4), after changes, at most every few seconds. */
  | LibraryStatsMsg;

/** Supervisor -> child. */
export type ToChild =
  | { t: 'library'; url?: string; state: ChildState }
  | { t: 'live'; url?: string; state: ChildState }
  | LocksMsg
  | { t: 'changes'; changes: Change[]; seq?: number }
  | { t: 'status'; processes: ProcessStatus[] }
  | { t: 'shutdown' }
  | LibraryStatsMsg;

/** Library process -> supervisor -> live process (cached and replayed to a restarted live process). */
export type LibraryStatsMsg = { t: 'stats'; library: LibraryStats };

export const HEARTBEAT_MS = 500;

export function sendToParent(m: FromChild): void {
  if (process.send && process.connected) {
    try {
      process.send(m);
    } catch {
      /* the supervisor is gone; 'disconnect' handles it */
    }
  }
}

export function isToChild(x: unknown): x is ToChild {
  return typeof x === 'object' && x !== null && typeof (x as { t?: unknown }).t === 'string';
}
