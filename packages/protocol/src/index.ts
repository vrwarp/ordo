import { z } from 'zod';
import { LiveCommand, LiveEvent, type LiveState, type ResolvedPlaylist, Id } from '@ordo/domain';

export const PROTOCOL_VERSION = 1;

/** Version of the hub and the browser apps, deployed together from one image. A mismatch on hello means a stale tab. */
export const APP_VERSION = '0.12.0';

export const Role = z.enum(['operate', 'edit', 'output', 'stage']);
export type Role = z.infer<typeof Role>;

/** Health an output or stage window reports once per second. */
export const OutputHealth = z.object({
  presented: z.number(),
  missed: z.number(),
  longTasks: z.number(),
  lateFlips: z.number().default(0),
  armed: z.number().optional(),
  armedOk: z.boolean().optional(),
  armError: z.string().optional(),
  live: z.number().optional(),
  cache: z.object({ ready: z.number(), total: z.number() }),
  gpuLost: z.number().default(0),
  videoDropped: z.number().default(0),
  fps: z.number().optional(),
  audio: z.enum(['ok', 'lost', 'none']).optional(),
  meters: z.array(z.number()).optional(),
  mediaPositionMs: z.number().optional(),
  mediaDurationMs: z.number().optional(),
  error: z.string().optional(),
  appVersion: z.string().optional(),
  bus: z.enum(['hub', 'fallback']).optional(),
  /** Recent log lines of this window (newest last), for the operator's diagnostics panel. */
  recentLog: z.array(z.string().max(300)).max(50).optional(),
  /** Which compositor is drawing: webgpu or 2d. */
  compositor: z.enum(['webgpu', '2d']).optional(),
  /** MB of GPU memory in the compositor's layer and scene textures (design/27 §13: ≤ 400 at 4K). */
  gpuMB: z.number().min(0).max(1e6).optional(),
  /** Slide raster times of the asset worker over the last slides it drew, ms (design/27 §13). */
  rasterMs: z.object({ n: z.number(), p50: z.number(), p95: z.number(), max: z.number() }).optional(),
  /**
   * How many of those slides the drawing estimate puts past the raster budget by their content (design/27
   * §13 named exception): counted in `rasterMs`, left out of the `raster` alarm.
   */
  rasterHeavy: z.number().min(0).max(1e6).optional(),
  /**
   * The raster times the `raster` alarm read: those of the slides whose content fits the budget, when some
   * are past it (`rasterHeavy`); what the alarm's text quotes. Absent: the alarm read `rasterMs`.
   */
  rasterAlarmMs: z.object({ n: z.number(), p50: z.number(), p95: z.number(), max: z.number() }).optional(),
  /** The longest per-frame texture upload in budgeted strips over the last minute, render worker CPU ms (WebGPU). */
  uploadMs: z.number().min(0).max(1e6).optional(),
  /**
   * Frames that uploaded content on screen whole by design (a refresh of the live slide, recovery after a
   * device loss) and the longest of the last minute, ms: for the tech, never an alarm.
   */
  wholeUploads: z.object({ count: z.number().min(0), maxMs: z.number().min(0).max(1e6) }).optional(),
  /** This output's performance budgets at its size (design/27 §13): raster p95, upload per frame, GPU memory. */
  budgets: z.object({ rasterP95Ms: z.number(), uploadMs: z.number(), gpuMB: z.number() }).optional(),
  /**
   * Budgets passed now ('raster', 'upload'). Plain strings, so an alarm a newer output adds
   * never fails an older hub's parse of the whole report.
   */
  alarms: z.array(z.string().max(40)).max(8).optional(),
  /** Ms since the main thread last ran the watchdog tick, as measured by the output's link worker. */
  mainThreadStallMs: z.number().optional(),
  /** Supervised workers of the window (design/25): restarts and give-ups per worker. */
  workers: z
    .array(
      z.object({
        name: z.string().max(40),
        generation: z.number(),
        restarts: z.number(),
        lastReason: z.string().max(300).optional(),
        gaveUp: z.boolean(),
      }),
    )
    .max(8)
    .optional(),
  /** Slides and media that failed to rasterize or decode and are skipped for the rest of the service. */
  quarantined: z.object({ count: z.number(), items: z.array(z.string().max(300)).max(20) }).optional(),
  /** Font families requested by drawn text that are not loaded (drawn in the fallback font). */
  fontFallbacks: z.array(z.string().max(200)).max(20).optional(),
  /**
   * Characters drawn this service that no face the output has covers, so the computer's own fallback face
   * drew them (design/27 §10): a sample, how many distinct ones, and their scripts (ISO 15924).
   */
  fontCoverage: z
    .object({
      chars: z.string().max(200),
      count: z.number(),
      scripts: z.array(z.string().max(8)).max(16),
    })
    .optional(),
  /** Service-cache files found corrupt or truncated and fetched again. */
  cacheRepairs: z.number().optional(),
  /** What carries the window's fallback bus: a handed-over MessagePort, or the window.postMessage relay. */
  busTransport: z.enum(['port', 'window']).optional(),
  // ---- units (design/13 "Output health: units"; design/14 "Late units", wave r2b) ----
  /** Units (slow parts drawn ahead in slices) the window's asset worker has made since it started. */
  unitsMade: z.number().int().min(0).max(1e9).optional(),
  /**
   * Slides this window showed before all their units were ready, whose late parts came in a moment later
   * (faded in; W49 "Parts of 2 slides appeared a moment late on this screen.").
   */
  unitsLate: z.number().int().min(0).max(1e9).optional(),
  /** Bytes the asset worker's unit cache holds now (at most 192 MiB). */
  unitCacheBytes: z.number().min(0).max(1e12).optional(),
});
export type OutputHealth = z.infer<typeof OutputHealth>;
export type OutputHealthEntry = OutputHealth & {
  outputId: string;
  connected: boolean;
  lastSeen: number;
  name?: string;
};

// ---- client -> hub ----
export const Hello = z.object({
  t: z.literal('hello'),
  v: z.literal(PROTOCOL_VERSION),
  role: Role,
  outputId: Id.optional(),
  /**
   * Which window of the output this is: absent for the output's own window (an Audience screen, the Stage
   * Display), 'lectern' for a Pulpit Lectern (`/stage?view=lectern`) on the stage output's link. A lectern
   * follows the stage output without being its window: it neither replaces the Stage Display window nor is
   * replaced by one (`bye 'superseded'`), and the output's health and connection are the display's (design/16).
   */
  view: z.literal('lectern').optional(),
  appVersion: z.string(),
  lastSeq: z.number().optional(),
  /**
   * The id (SHA-256 of its bytes) of the resolved copy of the running service this window holds, if it does
   * (design/29 §2.3 M2, live-by-ref): a hub that knows it sends the live state without the copy. Lenient on
   * purpose: a hello that fails its parse is answered with bye 'version' (the window reloads), so a value that is
   * not a string reads as absent and a string of any shape is kept and only compared for equality.
   */
  resolvedId: z.string().optional().catch(undefined),
});
export const TimePing = z.object({
  t: z.literal('time.ping'),
  v: z.literal(PROTOCOL_VERSION),
  c: z.number(),
});
export const LiveEventMsg = z.object({
  t: z.literal('live.event'),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  event: LiveCommand,
});
export const LiveResync = z.object({
  t: z.literal('live.resync'),
  v: z.literal(PROTOCOL_VERSION),
  /** The resolved copy the window holds (as `Hello.resolvedId`); absent: it holds none. */
  resolvedId: z.string().optional().catch(undefined),
});
export const HealthMsg = z.object({
  t: z.literal('health'),
  v: z.literal(PROTOCOL_VERSION),
  health: OutputHealth,
});
export const RtcSignal = z.object({
  t: z.literal('rtc.signal'),
  v: z.literal(PROTOCOL_VERSION),
  to: z.string(),
  from: z.string().optional(),
  sdp: z.any().optional(),
  ice: z.any().optional(),
});
export const AdoptMsg = z.object({
  t: z.literal('live.adopt'),
  v: z.literal(PROTOCOL_VERSION),
  state: z.any(),
  force: z.boolean().optional(),
});

/**
 * Operator asks one idle output to show a slide (prd/03 "Send to preview"). Relayed by the hub to that
 * output like rtc.signal. The output honours it only while no playlist is live, and renders with its own look.
 */
export const PreviewMsg = z.object({
  t: z.literal('preview'),
  v: z.literal(PROTOCOL_VERSION),
  to: z.string(),
  from: z.string().optional(),
  presentation: z.any().optional(),
  slideId: z.string().optional(),
  clear: z.boolean().optional(),
});

export const ClientMessage = z.discriminatedUnion('t', [
  Hello,
  TimePing,
  LiveEventMsg,
  LiveResync,
  HealthMsg,
  RtcSignal,
  AdoptMsg,
  PreviewMsg,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- pre-rendered slides' live events (design/29 §1.7, §1.11) ----
/**
 * `prerender.add`: a picture of a key of the live service the hub accepted during the service (the go-live
 * bake), kept in `state.prerendered`. The hub applies it (`LiveService.apply`) and every client reduces it from
 * `live.delta`; a client's `live.event` carrying it is refused at its parse (`LiveCommand` leaves it out).
 */
export type PrerenderAddEvent = Extract<LiveEvent, { k: 'prerender.add' }>;
/**
 * `prerender.use`: the operator's "Use the picture for this slide during this service" (operate role, an
 * ordinary `live.event`), kept in `state.drawOverride` until End service.
 */
export type PrerenderUseEvent = Extract<LiveEvent, { k: 'prerender.use' }>;
/** Live events only the hub applies: no client message may carry one. */
export const HUB_ONLY_EVENTS: readonly LiveEvent['k'][] = ['prerender.add'];

// ---- hub -> client (trusted, typed only) ----
export type Welcome = { t: 'welcome'; v: 1; hubMs: number; seq: number; role: Role; appVersion: string };
export type TimePong = { t: 'time.pong'; v: 1; c: number; s: number };
export type LiveStateMsg = {
  t: 'live.state';
  v: 1;
  seq: number;
  /** `state.resolved` is left out when the socket said it holds the copy named by `resolvedId`. */
  state: LiveState;
  /** The id of the running service's resolved copy (SHA-256 of its bytes), while a service is live. */
  resolvedId?: string;
};
export type LiveDeltaMsg = {
  t: 'live.delta';
  v: 1;
  seq: number;
  fromSeq: number;
  event: LiveEvent /** id of the client command that produced it */;
  id?: string;
  /** A goLive's: the id of the copy `event.resolved` carries (SHA-256 of its bytes). */
  resolvedId?: string;
};
export type LiveAck = { t: 'live.ack'; v: 1; id: string; seq?: number; rejected?: string };
export type LibraryDelta = {
  t: 'library.delta';
  v: 1;
  changes: { kind: LibraryKind; id: string; rev?: number; entity?: unknown; deleted?: boolean }[];
};
export type LibraryKind =
  | 'presentation'
  | 'playlist'
  | 'media'
  | 'font'
  | 'theme'
  | 'settings'
  | 'job'
  | 'folder';
export type HealthSummary = { t: 'health.summary'; v: 1; outputs: Record<string, OutputHealthEntry> };
export type Bye = { t: 'bye'; v: 1; reason: string };

export type ServerMessage =
  | Welcome
  | TimePong
  | LiveStateMsg
  | LiveDeltaMsg
  | LiveAck
  | LibraryDelta
  | HealthSummary
  | Bye
  | (z.infer<typeof RtcSignal> & { from: string })
  | (z.infer<typeof PreviewMsg> & { from: string });

// ---- going live prepared beside the running service (design/29 §2.3 M8) ----
/** The route the operator calls before goLive (operate role; the live process answers it). */
export const LIVE_PREPARE_PATH = '/live/prepare';
/** How long POST /live/prepare holds its answer for the prepare to end or its progress to move. */
export const LIVE_PREPARE_WAIT_MS = 400;
/**
 * POST /live/prepare: get a playlist ready to go live beside the running service. `saved`: go live from the
 * hub's saved copy (W41's button). `seen`: the progress the caller last saw (the answer waits until it moves,
 * or until the prepare ends; without it, until the prepare ends), at most LIVE_PREPARE_WAIT_MS.
 */
export const LivePrepareReq = z
  .object({
    playlistId: Id,
    saved: z.boolean().optional(),
    seen: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type LivePrepareReq = z.infer<typeof LivePrepareReq>;
/** The prepare's progress: once `ready` (or `failed`), the operator sends goLive, which applies at once. */
export type LivePrepareRes = {
  playlistId: string;
  state: 'preparing' | 'ready' | 'failed';
  /** 0-90 while the copy arrives, 90 while it is checked, 100 when done. */
  pct: number;
  /** Why it failed (the goLive's refusal). */
  reason?: string;
  /** When the hub's saved copy of the playlist was taken (ms since the epoch, hub clock), if it has one. */
  savedAt?: number;
  /** The prepared copy's size in bytes. */
  bytes?: number;
};

// ---- fallback bus (operator <-> outputs via postMessage) ----
/**
 * `hold`: the operator PC started this service itself while the hub was unreachable (design/17 "Going live
 * without the hub"). Windows stay with the operator for the whole service: a hub that comes back is not
 * followed until the operator lets go (`fallback.hub { hubUp: true }`), and its state is never applied
 * over the held service.
 *
 * `hubRefused`: the hub is up but refuses this operator's session (design/15 "Session expiry"), so it cannot be
 * handed the service until the operator signs in again. A window on the bus takes nothing from the hub
 * meanwhile, not even a state at its own sequence (a hub restarted from its journal equals the window without
 * having caught up). Unlike `hold` it is not remembered: the operator's silence or `hubUp` ends it, and so
 * does a hello or heartbeat without it.
 */
export type FallbackHello = {
  t: 'fallback.hello';
  v: 1;
  seq: number;
  operatorMs: number;
  hold?: boolean;
  hubRefused?: boolean;
};
export type FallbackReady = { t: 'fallback.ready'; v: 1; outputId: string; appliedSeq: number };
export type FallbackFileRequest = { t: 'fallback.file'; v: 1; hash: string; reqId: string };
export type FallbackFileResponse = {
  t: 'fallback.file.res';
  v: 1;
  reqId: string;
  hash: string;
  blob?: Blob;
  error?: string;
};
export type FallbackHub = { t: 'fallback.hub'; v: 1; hubUp: boolean; hold?: boolean; hubRefused?: boolean };
export type FallbackMessage =
  | FallbackHello
  | FallbackReady
  | FallbackFileRequest
  | FallbackFileResponse
  | FallbackHub
  | LiveStateMsg
  | LiveDeltaMsg
  | (z.infer<typeof HealthMsg> & { outputId: string });

export function msg<T extends { t: string }>(m: Omit<T, 'v'>): T {
  return { ...m, v: PROTOCOL_VERSION } as unknown as T;
}

export function parseClientMessage(raw: string): ClientMessage | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: 'bad json' };
  }
  const r = ClientMessage.safeParse(json);
  if (!r.success)
    return {
      error: r.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 500),
    };
  return r.data;
}

/** Clock offset estimate from NTP-style samples: take the sample with the minimum round trip. */
export function estimateOffset(
  samples: { c: number; s: number; r: number }[],
): { offset: number; rtt: number } | null {
  if (!samples.length) return null;
  let best = samples[0]!;
  for (const x of samples) if (x.r - x.c < best.r - best.c) best = x;
  const rtt = best.r - best.c;
  return { offset: best.s + rtt / 2 - best.r, rtt };
}

export type { LiveState, ResolvedPlaylist, LiveEvent };
export { LiveEvent as LiveEventSchema, LiveCommand as LiveCommandSchema };

/** Hostname helpers: role origins are <prefix>.<domain>. */
export function roleHost(domain: string, role: 'op' | 'hub' | 'stage' | `out${number}`): string {
  return `${role}.${domain}`;
}

export const HEADER_TOKEN = 'x-ordo-token';
export const COOKIE_SESSION = 'ordo_session';
export * from './api.ts';
