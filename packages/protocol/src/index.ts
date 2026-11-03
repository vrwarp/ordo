import { z } from 'zod';
import { LiveCommand, LiveEvent, type LiveState, type ResolvedPlaylist, Id } from '@ordo/domain';

export const PROTOCOL_VERSION = 1;

/** Version of the hub and the browser apps, deployed together from one image. A mismatch on hello means a stale tab. */
export const APP_VERSION = '0.1.0';

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

export const ClientMessage = z.discriminatedUnion('t', [
  Hello,
  TimePing,
  LiveEventMsg,
  LiveResync,
  HealthMsg,
  RtcSignal,
  AdoptMsg,
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
  | (z.infer<typeof RtcSignal> & { from: string });

// ---- fallback bus (operator <-> outputs via postMessage) ----
export type FallbackHello = { t: 'fallback.hello'; v: 1; seq: number; operatorMs: number };
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
export type FallbackHub = { t: 'fallback.hub'; v: 1; hubUp: boolean };
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
