import { z } from 'zod';
import { LiveCommand, LiveEvent, type LiveState, type ResolvedPlaylist, Id } from '@ordo/domain';

export const PROTOCOL_VERSION = 1;

/** Version of the hub and the browser apps, deployed together from one image. A mismatch on hello means a stale tab. */
export const APP_VERSION = '0.2.0';

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
  /** Service-cache files found corrupt or truncated and fetched again. */
  cacheRepairs: z.number().optional(),
  /** What carries the window's fallback bus: a handed-over MessagePort, or the window.postMessage relay. */
  busTransport: z.enum(['port', 'window']).optional(),
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
  appVersion: z.string(),
  lastSeq: z.number().optional(),
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
export const LiveResync = z.object({ t: z.literal('live.resync'), v: z.literal(PROTOCOL_VERSION) });
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

// ---- hub -> client (trusted, typed only) ----
export type Welcome = { t: 'welcome'; v: 1; hubMs: number; seq: number; role: Role; appVersion: string };
export type TimePong = { t: 'time.pong'; v: 1; c: number; s: number };
export type LiveStateMsg = { t: 'live.state'; v: 1; seq: number; state: LiveState };
export type LiveDeltaMsg = {
  t: 'live.delta';
  v: 1;
  seq: number;
  fromSeq: number;
  event: LiveEvent /** id of the client command that produced it */;
  id?: string;
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

// ---- fallback bus (operator <-> outputs via postMessage) ----
/**
 * `hold`: the operator PC started this service itself while the hub was unreachable (design/17 "Going live
 * without the hub"). Windows stay with the operator for the whole service: a hub that comes back is not
 * followed until the operator lets go (`fallback.hub { hubUp: true }`), and its state is never applied
 * over the held service.
 */
export type FallbackHello = { t: 'fallback.hello'; v: 1; seq: number; operatorMs: number; hold?: boolean };
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
export type FallbackHub = { t: 'fallback.hub'; v: 1; hubUp: boolean; hold?: boolean };
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
