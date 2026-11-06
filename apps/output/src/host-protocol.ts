import type { AudioSettings } from '@ordo/domain';
import type { RtcSignalIn } from '@ordo/client';
import type { ClientMessageBody } from '@ordo/client';

/**
 * Messages between the output window's main thread (the host) and its link worker (design/25).
 *
 * The host owns only what the platform forces onto the main thread: the canvas, media elements,
 * the audio engine, fullscreen, wake lock, keys, the diagnostics overlay and the program-view
 * RTCPeerConnection. The link worker owns everything else and drives the host with commands.
 * Plain TypeScript unions (they carry Blobs and MessagePorts); both ends are built together.
 */

export type WorkerName = 'link' | 'render' | 'asset';

export type WorkerStat = {
  name: WorkerName;
  generation: number;
  restarts: number;
  lastReason?: string;
  gaveUp: boolean;
};

export type Transport = {
  state: 'playing' | 'paused' | 'ended';
  startedAt: number;
  positionMs: number;
  loop: boolean;
};

export type AudioRoute = { pairId?: string; gainDb?: number; loudnessLufs?: number };

/** Media element commands (slots 0-1 backgrounds, 2-3 media videos, 4-5 audio cues). */
export type MediaCommand =
  | {
      k: 'load';
      slot: number;
      key: string;
      hash: string;
      /** The OPFS copy when the service cache has it, else the element streams `url`. */
      blob?: Blob;
      url: string;
      loop: boolean;
      muted: boolean;
      /** The link's slot generation (SlotMirror.gen): every `vframe` of this load is tagged with it. */
      gen: number;
    }
  | { k: 'apply'; slot: number; transport: Transport }
  | { k: 'pauseAt'; slot: number; at: number }
  /** Keep an armed video paused on its first frame. */
  | { k: 'holdPaused'; slot: number }
  /** Route the slot's sound: through the audio engine on the master, muted elsewhere. */
  | { k: 'route'; slot: number; master: boolean; audio: AudioRoute }
  /**
   * Take the slot's picture out of the renderer (design/27 §7.2): at hub time `at` (now when absent) the
   * host sends the renderer `vclear` for the slot, after every frame it already sent, and sends no frame
   * of `key` again until it plays or another key loads. An in-slide clip whose media layer cleared, or one
   * hidden while not playing (`showWhenStopped: false`); its slide then shows its poster, or nothing.
   */
  | { k: 'vclear'; slot: number; key: string; at?: number }
  | { k: 'unload'; slot: number };

export type AudioCommand =
  | { k: 'config'; master: boolean; settings?: AudioSettings }
  | { k: 'fadeOut'; ms: number };

/** What the link worker publishes for diagnostics, `__ordo.telemetry()` and `__ordo.state()`. */
export type LinkView = {
  telemetry: Record<string, unknown>;
  state: Record<string, unknown>;
  diag: Record<string, unknown>;
  log: string[];
  /** Live content is held again after a render-worker rebuild: the hold canvas may be removed. */
  covered: boolean;
};

// ---- main -> link ----
export type MainToLink =
  | {
      t: 'init';
      outputId: string;
      token: string;
      width: number;
      height: number;
      testMode: boolean;
      /** Supervisor generation of this link worker (0 on the first start). */
      generation: number;
      /** End of the host's legacy window.postMessage relay to the opener (fallback bus). */
      bridge: MessagePort;
      /** The newest bus port the opener handed over, if any (re-sent to a restarted link worker). */
      busPort?: MessagePort;
      /** Why the window was last reloaded by itself (crash-only restart), for the log. */
      reloadReason?: string;
    }
  /** Fresh channel ends to the render and asset workers, after any worker (re)start. */
  | { t: 'ports'; render: MessagePort; asset: MessagePort; gens: Record<WorkerName, number> }
  /** A new fallback-bus port from the opener (offerPort/acceptPorts). */
  | { t: 'busPort'; port: MessagePort }
  /** Main-thread watchdog tick, every 250 ms. */
  | { t: 'tick' }
  | { t: 'host'; status: HostStatus }
  | { t: 'opener'; closed: boolean }
  /**
   * A media element event. `n` numbers it for the link's acknowledgement; events a dead link worker never
   * acknowledged are sent again (`replay`) to its successor.
   */
  | { t: 'media'; ev: MediaEvent; n?: number; replay?: boolean }
  /** A message the host wants sent to the hub (program-view answers and candidates). */
  | { t: 'hubSend'; msg: ClientMessageBody }
  /** Test hooks (`?test=1` only). */
  | { t: 'chaos'; action: 'injectDelta'; delta: unknown }
  | { t: 'chaos'; action: 'verifyCache' };

export type MediaEvent =
  | { k: 'loaded'; slot: number; key: string }
  | { k: 'loadError'; slot: number; key: string; error: string }
  | { k: 'ended'; slot: number; key: string }
  | { k: 'error'; slot: number; key: string; error: string };

export type SlotStatus = {
  id: number;
  key: string;
  srcId: string;
  dropped: number;
  positionMs: number;
  durationMs?: number;
  error?: string;
  /** The element played to its end (and is not looping). */
  ended?: boolean;
  paused?: boolean;
  /** The element has its first frame (the key is loaded). */
  ready?: boolean;
  hash?: string;
};

export type HostStatus = {
  slots: SlotStatus[];
  audio?: 'ok' | 'lost' | 'none';
  meters?: number[];
  longTasks: number;
  workers: WorkerStat[];
  /** Main-thread animation frames so far: the page is being painted (renderer stall detection). */
  rafTicks: number;
  visible: boolean;
  hold: boolean;
  compositor?: 'webgpu' | '2d';
  renderNote?: string;
  fatal?: string;
  /** The last crash-only reload the host refused (within the reload window), and what it did instead. */
  reloadRefused?: string;
  /** Lines logged on the main thread since the last status. */
  log: string[];
};

// ---- link -> main ----
export type LinkToMain =
  | { t: 'view'; view: LinkView }
  | { t: 'media'; cmd: MediaCommand }
  | { t: 'audio'; cmd: AudioCommand }
  /** Hub clock offset for media scheduling (hub ms = Date.now() + offset). */
  | { t: 'clock'; offset: number }
  | { t: 'title'; text: string }
  | { t: 'rtc'; m: RtcSignalIn }
  | { t: 'fatal'; title: string; detail: string }
  | { t: 'close'; reason: string }
  /**
   * Crash-only restart: reload the window (the host applies a reload budget). When the budget refuses
   * the reload, the host restarts `fallback` instead, if named.
   */
  | { t: 'reload'; reason: string; fallback?: WorkerName }
  /** Media events up to `n` were handled (the host stops keeping them for replay). */
  | { t: 'mediaAck'; n: number }
  /** Ask the host's supervisor to restart a worker (e.g. the renderer presents nothing). */
  | { t: 'restartWorker'; name: WorkerName; reason: string }
  /** Ask the opener for a fresh fallback-bus port. */
  | { t: 'portRequest' };

export type ChaosHooks = {
  killWorker(name: WorkerName): void;
  injectDelta(delta: unknown): void;
  verifyCache(): void;
};
