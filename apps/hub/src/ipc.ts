/**
 * Messages between the supervisor and its two children over the Node IPC channel (child_process.fork).
 * Children never talk to each other over IPC: the supervisor relays, caches the last value of each kind
 * and replays it to a restarted child, so a restart never misses the locks or the library address.
 */
import type { Change } from './library.ts';

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
  | { t: 'changes'; changes: Change[] }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; msg: string };

/** Supervisor -> child. */
export type ToChild =
  | { t: 'library'; url?: string; state: ChildState }
  | { t: 'live'; url?: string; state: ChildState }
  | LocksMsg
  | { t: 'changes'; changes: Change[] }
  | { t: 'status'; processes: ProcessStatus[] }
  | { t: 'shutdown' };

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
