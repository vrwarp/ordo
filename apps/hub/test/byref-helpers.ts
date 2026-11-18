/**
 * Helpers of the by-reference tests (live-by-ref): a synthetic service of lyric slides built to a size, a live
 * source that serves it as a goLive bundle (the prepared path, as the live process runs it), raw sockets that
 * record every frame with its text/binary flag, and a spy that counts how often the live path serialises.
 */
import { lyricSlide, newId } from '@ordo/domain';
import { APP_VERSION } from '@ordo/protocol';
import { vi } from 'vitest';
import WebSocket from 'ws';
import type { LiveSource, RawBundle } from '../src/live.ts';
import { login, OPERATE_PIN, sleep, startHub, type TestHub } from './helpers.ts';

const enc = new TextEncoder();

/** A playlist `pl` of presentations of lyric slides, about `mib` MiB of JSON, as a goLive bundle. */
export function bigBundle(mib: number, playlistId = 'pl'): Record<string, unknown> {
  const presentations: Record<string, unknown> = {};
  const items: unknown[] = [];
  const line = 'Amazing grace how sweet the sound that saved a wretch like me ';
  let bytes = 0;
  let k = 0;
  while (bytes < mib * 1024 * 1024) {
    const slides = Array.from({ length: 50 }, (_, i) => lyricSlide(`${k}.${i} ${line.repeat(30)}`));
    const sid = newId();
    const p = {
      id: newId(),
      rev: 1,
      title: `Song ${k}`,
      kind: 'song',
      meta: { tags: [] },
      sections: [{ id: sid, label: 'Verse 1', short: 'V1', slides }],
      arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
      archived: false,
    };
    presentations[p.id] = p;
    items.push({ id: `i${k}`, kind: 'presentation', presentationId: p.id });
    bytes += JSON.stringify(p).length;
    k++;
  }
  return {
    playlist: { id: playlistId, rev: 1, name: 'Sunday service', items },
    presentations,
    media: {},
    files: {},
    fonts: [],
    looks: [],
    general: {},
  };
}

/** The same bundle as the bytes the library process would send. */
export function bundleBytes(b: Record<string, unknown>): Uint8Array {
  return enc.encode(JSON.stringify(b));
}

/** A live source that has only goLive bundles (a remote source: the goLive is prepared in the worker). */
export function bundleSource(
  bundles: Record<string, Uint8Array>,
  settings: LiveSource['settings'] = () => ({ outputs: [], surfaces: { messagePresets: [] } }),
): LiveSource {
  return {
    goLiveInputs: () => undefined,
    settings,
    async bundle(playlistId): Promise<RawBundle | undefined> {
      const bytes = bundles[playlistId];
      return bytes ? { bytes, takenAt: 1 } : undefined;
    },
  };
}

export type Frame = { text: string; binary: boolean };
export type Raw = {
  ws: WebSocket;
  frames: Frame[];
  send(m: Record<string, unknown>): void;
  /** Parsed frames of one message type. */
  of(t: string): Record<string, any>[];
  close(): void;
};

/** A socket that records every frame as it came (text or binary) and says hello as `hello` says. */
export async function rawSocket(
  hub: TestHub,
  cookie: string,
  hello: Record<string, unknown> | false = {},
): Promise<Raw> {
  const ws = new WebSocket(`${hub.url.replace(/^http/, 'ws')}/ws`, { headers: { cookie } });
  const frames: Frame[] = [];
  ws.on('message', (d, isBinary) => frames.push({ text: d.toString(), binary: isBinary }));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const r: Raw = {
    ws,
    frames,
    send: (m) => ws.send(JSON.stringify({ v: 1, ...m })),
    of: (t) => frames.map((f) => JSON.parse(f.text) as Record<string, any>).filter((m) => m.t === t),
    close: () => ws.close(),
  };
  if (hello) r.send({ t: 'hello', role: 'operate', appVersion: APP_VERSION, ...hello });
  return r;
}

export async function waitFor(check: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * Counts the JSON.stringify calls whose argument `pred` accepts, from now until `restore()`.
 * (JSON.stringify is also what the HTTP layer and the logger use; only matching arguments count.)
 */
export function stringifySpy(pred: (a: any) => boolean) {
  const real = JSON.stringify;
  let n = 0;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((
    ...args: Parameters<typeof JSON.stringify>
  ) => {
    try {
      if (args[0] && typeof args[0] === 'object' && pred(args[0])) n++;
    } catch {
      /* a predicate never breaks the caller */
    }
    return real(...args);
  }) as typeof JSON.stringify);
  return {
    count: () => n,
    restore: () => spy.mockRestore(),
  };
}

/** A message that carries the whole copy, or the copy itself (what the live path must not serialise per socket). */
export const carriesCopy = (a: any): boolean =>
  (a.t === 'live.state' && !!a.state?.resolved) ||
  (a.t === 'live.delta' && !!a.event?.resolved) ||
  (!!a.presentations && !!a.playlist && !!a.manifestId);

/** A message that is a live.state of any kind. */
export const isLiveStateMsg = (a: any): boolean => a.t === 'live.state';

export type ServiceHub = { hub: TestHub; cookie: string; bytes: Uint8Array; op: Raw };

/**
 * A hub with a service of about `mib` MiB live: the live service's source is replaced by a bundle source (the
 * prepared path), and an operate socket sends Go live. Resolves once the goLive applied.
 */
export async function liveHub(
  mib: number,
  opts: { dataDir?: string; liveByRef?: boolean; healthIntervalMs?: number } = {},
): Promise<ServiceHub> {
  const hub = await startHub({
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    ...(opts.liveByRef === undefined ? {} : { liveByRef: opts.liveByRef }),
    ...(opts.healthIntervalMs === undefined ? {} : { healthIntervalMs: opts.healthIntervalMs }),
  } as Parameters<typeof startHub>[0]);
  const bytes = bundleBytes(bigBundle(mib));
  const src = (hub.live as unknown as { source: LiveSource }).source;
  src.bundle = bundleSource({ pl: bytes }).bundle;
  const c = await login(hub.url, OPERATE_PIN);
  const op = await rawSocket(hub, c.cookie, {});
  await waitFor(() => op.of('live.state').length > 0, 10_000, 'the first state');
  op.send({ t: 'live.event', id: 'go-live', event: { k: 'goLive', playlistId: 'pl' } });
  await waitFor(() => op.of('live.ack').some((a) => a.id === 'go-live'), 30_000, 'the goLive ack');
  if (op.of('live.ack').some((a) => a.id === 'go-live' && a.rejected))
    throw new Error(`goLive refused: ${JSON.stringify(op.of('live.ack'))}`);
  return { hub, cookie: c.cookie, bytes, op };
}
