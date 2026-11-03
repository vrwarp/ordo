import type { BudgetRow, ClientMessageBody, RtcSignalIn } from '@ordo/client';
import type { LiveState, ResolvedPlaylist } from '@ordo/domain';
import type { Job, OutputHealthEntry, Settings } from '@ordo/protocol';
import type { Action, KeyFace } from '@ordo/surfaces';
import type { LibraryData } from '../lib/libraryData.ts';
import type { Authority, Reconcile } from '../lib/liveCore.ts';
import type { SearchDoc } from '../lib/search.ts';

/**
 * Messages between the operator's main thread (host: React, keys, HID/MIDI, window handles) and its core
 * worker (hub socket, live state, fallback-bus authority, library, cache fill, budgets). design/25.
 *
 * The worker posts a view model in slices, and only the slices that changed. Big immutable objects (the
 * resolved playlist, library entities) are posted once and referenced by revision afterwards, so a GO
 * costs the main thread one small structured clone.
 */

export type Source = 'keyboard' | 'streamdeck' | 'midi' | 'ui';

/** Controller methods the main thread may call on the core (args are structured-cloneable). */
export type CallName =
  | 'go'
  | 'select'
  | 'goToSection'
  | 'clear'
  | 'goLive'
  | 'endService'
  | 'sendMessage'
  | 'dismissMessage'
  | 'lowerThird'
  | 'timerStart'
  | 'timerStop'
  | 'timerReset'
  | 'media'
  | 'resolveConflict'
  | 'activateFallback';

export type LibKey = 'presentations' | 'playlists' | 'media' | 'fonts' | 'themes' | 'folders';
export const LIB_KEYS: readonly LibKey[] = [
  'presentations',
  'playlists',
  'media',
  'fonts',
  'themes',
  'folders',
];

/** Changes to the library since the last post (entities by reference identity on the worker side). */
export type LibPatch = {
  seq?: number;
  upsert?: Partial<Record<LibKey, { id: string }[]>>;
  remove?: Partial<Record<LibKey, string[]>>;
  settings?: Settings;
  jobs?: Record<string, Job>;
};

/** A local library write the main thread made after a successful API call (the hub delta confirms). */
export type LibOp =
  | { k: 'upsert'; key: LibKey; entity: { id: string } }
  | { k: 'remove'; key: LibKey; id: string }
  | { k: 'settings'; key: keyof Settings; value: unknown };

export type SearchFilter = {
  kind?: 'presentation' | 'media';
  includeArchived?: boolean;
  folderId?: string | null;
  tag?: string;
  limit?: number;
};
/** A search result without its (large) normalized haystack. */
export type SearchHit = Omit<SearchDoc, 'h' | 't'>;

export type ChaosMsg =
  | { k: 'dispatchLater'; action: Action; delayMs: number }
  | { k: 'throw'; reason: string }
  | { k: 'hang'; ms: number };

export type MainToCore =
  | { t: 'init'; role: 'operate' | 'edit'; appVersion: string; generation: number; test: boolean }
  | { t: 'action'; aid: string; action: Action; source: Source }
  | { t: 'call'; aid: string; name: CallName; args: unknown[] }
  | { t: 'hub.send'; m: ClientMessageBody }
  | { t: 'hub.kick' }
  /** A fresh fallback-bus port for one window (transferred; the window holds the other end). */
  | { t: 'bus.port'; outputId: string; port: MessagePort }
  /** Legacy path: a port the main thread bridges to window.postMessage for a window without a port. */
  | { t: 'bus.relay'; outputId: string; port: MessagePort }
  | { t: 'bus.drop'; outputId: string }
  /** Main-thread watchdog tick (every 250 ms). */
  | { t: 'tick'; at: number; hidden?: boolean }
  | { t: 'lib.op'; op: LibOp }
  | { t: 'lib.reload' }
  | { t: 'search'; reqId: number; q: string; f: SearchFilter }
  | { t: 'deck.key'; reqId: number; face: KeyFace; w: number; h: number }
  | { t: 'deck.strip'; reqId: number; title: string; sub: string; w: number; h: number }
  | { t: 'budget.reset'; kind: string }
  | { t: 'cache.retry' }
  | { t: 'chaos'; c: ChaosMsg };

/**
 * The live part of the view model. `state.resolved` and `state.cues` (both change only at goLive) are
 * stripped and posted separately by revision.
 */
export type LiveSlice = {
  state: LiveState;
  resolvedRev: number;
  cuesRev: number;
  authority: Authority;
  reconcile: Reconcile;
  pending: number;
  hubConnected: boolean;
  everConnected: boolean;
  ownCache: { ready: number; total: number; failed: number; manifestId?: string };
  clock: { offset: number; rtt: number; fallback: boolean };
};

export type EndpointInfo = {
  /** Channel the bus currently uses: the one that last heard the window ('both' before it spoke). */
  active: 'port' | 'window' | 'both' | 'none';
  port: boolean;
  relay: boolean;
  /** Ms since the last message from the window on any channel (-1: never). */
  sinceRxMs: number;
  ready: boolean;
};

export type CoreStats = {
  generation: number;
  /** Ms since the main thread's last 250 ms tick, as seen by the core worker. */
  mainThreadStallMs: number;
  /** Largest stall in the last minute. */
  mainThreadStallMaxMs: number;
  endpoints: Record<string, EndpointInfo>;
  persistFailures: number;
};

export type ViewModelMsg = {
  t: 'vm';
  live?: LiveSlice;
  /** Posted only when the resolved playlist object changes. */
  resolved?: { rev: number; value: ResolvedPlaylist | undefined };
  /** Posted only when the cue list object changes. */
  cues?: { rev: number; value: LiveState['cues'] };
  health?: Record<string, OutputHealthEntry>;
  budgets?: BudgetRow[];
  stats?: CoreStats;
};

export type UiEvent =
  | { k: 'clearAllUntil'; until?: number }
  | { k: 'conflict'; hubPlaylist?: string; localPlaylist?: string }
  | { k: 'goLiveError'; reason: string };

export type CoreToMain =
  | { t: 'ready'; generation: number }
  | ViewModelMsg
  | {
      t: 'lib';
      rev: number;
      full?: { data: LibraryData; source: 'none' | 'cache' | 'hub' };
      patch?: LibPatch;
      error?: string;
    }
  | { t: 'ack'; aid: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'toast'; text: string; kind: 'info' | 'warn' | 'error' | 'ok'; ms?: number }
  | { t: 'ui'; e: UiEvent }
  | { t: 'hub'; e: 'welcome'; appVersion: string }
  | { t: 'hub'; e: 'bye'; reason: string }
  | { t: 'rtc'; m: RtcSignalIn }
  | { t: 'search.res'; reqId: number; hits: SearchHit[] }
  | { t: 'deck.res'; reqId: number; px: Uint8ClampedArray | null }
  /** The window's bus has been silent: offer it a fresh port. */
  | { t: 'bus.need'; outputId: string };
