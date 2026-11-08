import type { StageLayout, StageText, TimerDisplay } from './model.ts';

/**
 * Messages between the stage window's main thread (the host) and its link worker (design/16, design/25).
 *
 * The host owns only the DOM: React renders the view model the worker posts, fonts are added to
 * `document.fonts` (a worker's FontFaceSet does not reach the DOM), rAF frame statistics, wake lock,
 * fullscreen and the opener handle. The link worker owns the socket, the live mirror, config, the service
 * cache, timers and clock text, persistence, invariant checks and health. Plain unions (they carry
 * ArrayBuffers and MessagePorts); both ends are built together.
 */

export type Bus = 'hub' | 'fallback' | 'none';

export type ViewMessage = { id: string; text: string };

/** Everything the stage draws, computed by the link worker. */
export type StageView = {
  /** A live state has been applied (from the hub, the operator or the IndexedDB cache). */
  ready: boolean;
  bus: Bus;
  layout: StageLayout;
  current: StageText | null;
  next: StageText | null;
  /** The displayed slide's notes when the look shows them (`layout.notes`), cut to `NOTES_MAX`. */
  notes: string | null;
  clock: string;
  countdown: TimerDisplay | null;
  elapsed: TimerDisplay | null;
  remaining: TimerDisplay | null;
  /** Active operator messages, newest first (fades are animated by the host). */
  messages: ViewMessage[];
  title?: string;
  /** Hub clock offset and fallback flag, so the host's own hub time agrees with the worker's. */
  clockOffset: number;
  clockFallback: boolean;
};

export type WorkerStat = {
  name: string;
  generation: number;
  restarts: number;
  lastReason?: string;
  gaveUp: boolean;
};

/** What the host measures and sends every second. */
export type HostStats = {
  presented: number;
  missed: number;
  fps: number;
  longTasks: number;
  workers: WorkerStat[];
  /** Fonts the host failed to add to document.fonts since the last report. */
  fontErrors: string[];
};

export type FontPayload = {
  hash: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  data: ArrayBuffer;
};

// ---- main -> link ----
export type MainToLink =
  | {
      t: 'init';
      outputId: string;
      token: string;
      testMode: boolean;
      /** Supervisor generation of this link worker (0 on the first start). */
      generation: number;
      /** End of the host's window.postMessage relay to the opener; absent without an opener. */
      bridge?: MessagePort;
      /** Why the previous page reloaded itself, for the log. */
      reloadReason?: string;
      /** Font hashes already in document.fonts (a restarted worker need not send them again). */
      loadedFonts: string[];
    }
  /** A fallback-bus port handed over by the operator (offerPort / acceptPorts). */
  | { t: 'busPort'; port: MessagePort }
  /** The opener window is gone (or back): checked on the main thread, which can see it. */
  | { t: 'opener'; closed: boolean }
  | { t: 'host'; stats: HostStats }
  /** Main-thread watchdog tick, every 250 ms: the worker reports the longest gap between ticks. */
  | { t: 'tick' }
  | { t: 'fontAck'; hash: string; ok: boolean; error?: string }
  /** Test hooks (`?test=1` only). */
  | { t: 'chaos'; k: 'delta'; msg: unknown }
  | { t: 'chaos'; k: 'state'; msg: unknown }
  /** The current state with its live cue out of range (shape-valid, invariant-violating). */
  | { t: 'chaos'; k: 'badState' };

// ---- link -> main ----
export type LinkToMain =
  | { t: 'view'; view: StageView }
  | { t: 'font'; font: FontPayload }
  /** Telemetry for diagnostics and tests (about once a second). */
  | { t: 'diag'; diag: Record<string, unknown> }
  /** Crash-only restart of the whole window (persistent invariant violation, new app version). */
  | { t: 'reload'; reason: string }
  /** A newer stage window took this output's place: stop and close. */
  | { t: 'close'; reason: string };
