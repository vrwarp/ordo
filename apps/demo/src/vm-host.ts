/**
 * The VM host (docs/design/26-pages-demo.md, "The VM hub"): runs in the operator tab of the GitHub Pages demo and
 * owns the in-browser hub, the real ordo hub inside a Linux machine (unkernel) in a Web Worker.
 *
 * - Start: resume a saved machine (the build's snapshot on a first visit, the visitor's own checkpoint later), or
 *   boot one and start the hub when no saved machine fits the visitor's disk (`startPath`). One tab owns the machine
 *   (a Web Lock); a second operator tab uses the first one's hub through the relay.
 * - HTTP: the service worker hands every `/api/v1/*` request of every demo window here (vm-wire.ts `RelayRequest`);
 *   it goes to the hub over a raw HTTP/1.1 connection into the guest (`guestHttp`), so the response's Set-Cookie can
 *   be read: a browser keeps the hub's session cookie in this tab's jar, never in `document.cookie`.
 * - WebSocket: the apps' sockets (packages/client demoSocket.ts) reach the hub's `/ws` through a BroadcastChannel and
 *   a client here (`GuestWebSocket`), one per socket.
 * - Persistence: the guest's data disk lives in IndexedDB, but it changes every second (the hub logs, checkpoints its
 *   databases), so a saved machine is a pair taken at one held instant: the machine's memory and a copy of its data
 *   disk (`checkpoint`). After a visitor's change the host takes one when the hub has been quiet for a moment, and
 *   when the tab is hidden. A load resumes the latest pair; one that missed a change boots the machine instead.
 */
import {
  checkSupport,
  createKernel,
  decodeSnapshot,
  type DiskSnapshotState,
  encodeSnapshot,
  gzipBlob,
  importDataDisk,
  type WorkerKernel,
  type KernelSnapshot,
  openDataDisk,
  openDistroDisk,
  resetDataDisk,
} from 'unkernel/web';
import { VM_GUEST } from './vm-config.ts';
import {
  ALIVE_MS,
  ALIVE_TIMEOUT_MS,
  type RelayReply,
  type RelayRequest,
  WS_CHANNEL,
  type WsDown,
  type WsUp,
} from './vm-wire.ts';

export type VmProgress = {
  stage: 'manifest' | 'download' | 'disk' | 'resume' | 'boot' | 'sign-in' | 'ready';
  /** One line for the boot screen. */
  text: string;
  /** Download progress, 0..1, when there is one. */
  frac?: number;
};

export type VmHostOptions = {
  /** The site root (where `vm/manifest.json` is). */
  root: URL;
  onProgress?: (p: VmProgress) => void;
};

export type VmHost = {
  /** How this load started the hub. */
  readonly started: 'snapshot' | 'checkpoint' | 'boot';
  /** Stop the machine and forget everything it saved (Reset demo); the page reloads after. */
  reset(): Promise<void>;
  /** Save the machine now (tests, and the page's own triggers). Resolves false when nothing needed saving or it failed. */
  checkpoint(force?: boolean): Promise<boolean>;
  /** Where saving stands (diagnostics and tests): a change not yet in a checkpoint has `lastWriteAt > checkpointAt`. */
  status(): { lastWriteAt: number; checkpointAt: number; saving: boolean };
  /** The kernel (diagnostics and tests). */
  readonly vm: WorkerKernel;
};

type Manifest = {
  version: 1;
  id: string;
  memoryMiB: number;
  kernel: { path: string; size: number };
  root: { path: string; size: number };
  data: { path: string; size: number; rawSize: number };
  snapshot: { path: string; size: number; rawSize: number };
};

/** What the host keeps about the visitor's machine (IndexedDB `ordo-vm`, key `meta`). */
type Meta = {
  /** The build (manifest id) the disk and checkpoint belong to. */
  build: string;
  /** When a change the visitor made last reached the hub (ms since epoch). */
  lastWriteAt: number;
  /** When the latest checkpoint was taken (0: none). */
  checkpointAt: number;
};

/** A saved machine: its memory and its data disk at one instant (IndexedDB `ordo-vm`, key `checkpoint`). */
type Checkpoint = { build: string; at: number; snapshot: Blob; disk: Blob };

const DISK = { name: 'ordo-vm', version: 'v1' } as const;
const KV_DB = 'ordo-vm';
const OWNER_LOCK = 'ordo-vm-owner';
/** A change is saved once the hub has been quiet this long, and at the latest this long after it. */
const QUIET_MS = 3000;
const MAX_DIRTY_MS = 20_000;
/** After a boot, the first checkpoint waits this long. */
const BOOT_SETTLE_MS = 20_000;
/** A resumed hub that has not answered in this long is given up for a boot. */
const RESUME_HEALTHY_MS = 60_000;

// ---------------------------------------------------------------- small IndexedDB key-value store

function kvOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(KV_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await kvOpen();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
async function kvPut(entries: Record<string, unknown>, remove: string[] = []): Promise<void> {
  const db = await kvOpen();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite', { durability: 'strict' });
      const s = tx.objectStore('kv');
      for (const [k, v] of Object.entries(entries)) s.put(v, k);
      for (const k of remove) s.delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
function deleteDb(name: string): Promise<void> {
  return new Promise((done) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => done();
  });
}

// ---------------------------------------------------------------- downloads

async function download(url: string, onFrac?: (f: number) => void): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length') ?? 0);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    if (total) onFrac?.(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

async function gunzip(data: Blob | Uint8Array): Promise<Uint8Array> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gzip(bytes: Uint8Array): Promise<Blob> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

// ---------------------------------------------------------------- HTTP/1.1 into the guest

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bytes read from a guest socket on demand. */
class ByteReader {
  private buf = new Uint8Array(0);
  private done = false;
  private readonly r: ReadableStreamDefaultReader<Uint8Array>;
  constructor(r: ReadableStreamDefaultReader<Uint8Array>) {
    this.r = r;
  }
  private async more(): Promise<boolean> {
    if (this.done) return false;
    const { value, done } = await this.r.read();
    if (done) {
      this.done = true;
      return false;
    }
    const n = new Uint8Array(this.buf.byteLength + value.byteLength);
    n.set(this.buf);
    n.set(value, this.buf.byteLength);
    this.buf = n;
    return true;
  }
  /** Up to the next CRLFCRLF (consumed), or null at EOF. */
  async head(): Promise<string | null> {
    for (;;) {
      for (let i = 0; i + 3 < this.buf.byteLength; i++)
        if (
          this.buf[i] === 13 &&
          this.buf[i + 1] === 10 &&
          this.buf[i + 2] === 13 &&
          this.buf[i + 3] === 10
        ) {
          const h = dec.decode(this.buf.subarray(0, i));
          this.buf = this.buf.subarray(i + 4);
          return h;
        }
      if (this.buf.byteLength > 65536) throw new Error('guest HTTP: header too large');
      if (!(await this.more())) return null;
    }
  }
  async line(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buf.byteLength; i++)
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const l = dec.decode(this.buf.subarray(0, i));
          this.buf = this.buf.subarray(i + 2);
          return l;
        }
      if (!(await this.more())) throw new Error('guest HTTP: connection closed in a chunk header');
    }
  }
  /** Exactly n bytes (n > 0), in pieces as they arrive. */
  async *exactly(n: number): AsyncGenerator<Uint8Array> {
    while (n > 0) {
      if (this.buf.byteLength === 0 && !(await this.more()))
        throw new Error('guest HTTP: connection closed early');
      const take = Math.min(n, this.buf.byteLength);
      yield this.buf.slice(0, take);
      this.buf = this.buf.subarray(take);
      n -= take;
    }
  }
  async need(n: number): Promise<Uint8Array> {
    while (this.buf.byteLength < n) if (!(await this.more())) throw new Error('guest: connection closed');
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async *rest(): AsyncGenerator<Uint8Array> {
    if (this.buf.byteLength) yield this.buf.slice();
    this.buf = new Uint8Array(0);
    while (await this.more()) {
      yield this.buf.slice();
      this.buf = new Uint8Array(0);
    }
  }
}

type GuestResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: AsyncGenerator<Uint8Array>;
};

/** Request headers the host sets itself or that must not reach the guest. */
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'te',
  'trailer',
  'cookie',
  'origin',
  'accept-encoding',
]);
/** Response headers a service worker's synthesized response must not carry. */
const DROP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'trailer',
  'upgrade',
  'set-cookie',
]);

function parseHead(head: string): { status: number; statusText: string; headers: [string, string][] } {
  const lines = head.split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(lines[0] ?? '');
  if (!m) throw new Error(`guest HTTP: bad status line ${JSON.stringify(lines[0])}`);
  const headers: [string, string][] = [];
  for (const l of lines.slice(1)) {
    const c = l.indexOf(':');
    if (c > 0) headers.push([l.slice(0, c).trim().toLowerCase(), l.slice(c + 1).trim()]);
  }
  return { status: Number(m[1]), statusText: m[2] ?? '', headers };
}

// ---------------------------------------------------------------- a WebSocket client into the guest

/** RFC 6455, client side, over a guest socket: text and binary messages, ping/pong, close. No extensions. */
class GuestWebSocket {
  private readonly w: WritableStreamDefaultWriter<Uint8Array>;
  private closing = false;
  private ended = false;
  onMessage?: (data: string | ArrayBuffer) => void;
  onClose?: (code: number, reason: string, wasClean: boolean) => void;

  private readonly sock: { writable: WritableStream<Uint8Array>; close(): Promise<void> };
  private readonly reader: ByteReader;
  readonly protocol: string;

  private constructor(
    sock: { writable: WritableStream<Uint8Array>; close(): Promise<void> },
    reader: ByteReader,
    protocol: string,
  ) {
    this.sock = sock;
    this.reader = reader;
    this.protocol = protocol;
    this.w = sock.writable.getWriter();
  }

  static async open(
    connect: () => Promise<{
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      close(): Promise<void>;
    }>,
    path: string,
    headers: [string, string][],
    protocols: string[],
  ): Promise<GuestWebSocket> {
    const sock = await connect();
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: localhost:${VM_GUEST.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...(protocols.length ? [`Sec-WebSocket-Protocol: ${protocols.join(', ')}`] : []),
      ...headers.map(([k, v]) => `${k}: ${v}`),
    ];
    const w = sock.writable.getWriter();
    await w.write(enc.encode(`${lines.join('\r\n')}\r\n\r\n`));
    w.releaseLock();
    const reader = new ByteReader(sock.readable.getReader());
    const head = await reader.head();
    if (head === null) throw new Error('guest WebSocket: closed during the handshake');
    const h = parseHead(head);
    if (h.status !== 101) {
      await sock.close().catch(() => undefined);
      throw new Error(`guest WebSocket: HTTP ${h.status}`);
    }
    const ws = new GuestWebSocket(
      sock,
      reader,
      h.headers.find(([k]) => k === 'sec-websocket-protocol')?.[1] ?? '',
    );
    void ws.readLoop();
    return ws;
  }

  private async readLoop(): Promise<void> {
    let code = 1006;
    let reason = '';
    let clean = false;
    const parts: Uint8Array[] = [];
    let msgOp = 0;
    try {
      for (;;) {
        const [b0, b1] = await this.reader.need(2);
        const fin = (b0! & 0x80) !== 0;
        const op = b0! & 0x0f;
        let len = b1! & 0x7f;
        if (len === 126) {
          const e = await this.reader.need(2);
          len = (e[0]! << 8) | e[1]!;
        } else if (len === 127) {
          const e = await this.reader.need(8);
          len = Number(new DataView(e.buffer, e.byteOffset, 8).getBigUint64(0));
        }
        const mask = b1! & 0x80 ? await this.reader.need(4) : null;
        const payload = len ? await this.reader.need(len) : new Uint8Array(0);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
        if (op === 0x8) {
          code = payload.length >= 2 ? (payload[0]! << 8) | payload[1]! : 1005;
          reason = dec.decode(payload.subarray(2));
          clean = true;
          if (!this.closing) await this.frame(0x8, payload.subarray(0, 2)).catch(() => undefined);
          break;
        }
        if (op === 0x9) {
          await this.frame(0xa, payload);
          continue;
        }
        if (op === 0xa) continue;
        if (op !== 0) msgOp = op;
        parts.push(payload);
        if (!fin) continue;
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const all = new Uint8Array(total);
        let o = 0;
        for (const p of parts) {
          all.set(p, o);
          o += p.byteLength;
        }
        parts.length = 0;
        this.onMessage?.(msgOp === 1 ? dec.decode(all) : all.buffer);
      }
    } catch {
      /* reset or closed: 1006 */
    }
    this.end(code, reason, clean);
  }

  private end(code: number, reason: string, clean: boolean): void {
    if (this.ended) return;
    this.ended = true;
    void this.sock.close().catch(() => undefined);
    this.onClose?.(code, reason, clean);
  }

  private frame(op: number, payload: Uint8Array): Promise<void> {
    const n = payload.byteLength;
    const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
    const f = new Uint8Array(head + 4 + n);
    f[0] = 0x80 | op;
    if (n < 126) f[1] = 0x80 | n;
    else if (n < 65536) {
      f[1] = 0x80 | 126;
      f[2] = n >> 8;
      f[3] = n & 255;
    } else {
      f[1] = 0x80 | 127;
      new DataView(f.buffer).setBigUint64(2, BigInt(n));
    }
    const mask = crypto.getRandomValues(new Uint8Array(4));
    f.set(mask, head);
    for (let i = 0; i < n; i++) f[head + 4 + i] = payload[i]! ^ mask[i & 3]!;
    return this.w.write(f);
  }

  send(data: string | ArrayBuffer): void {
    if (this.closing || this.ended) return;
    const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
    this.frame(typeof data === 'string' ? 1 : 2, bytes).catch(() => this.end(1006, '', false));
  }

  close(code = 1000, reason = ''): void {
    if (this.closing || this.ended) return;
    this.closing = true;
    const r = enc.encode(reason).subarray(0, 123);
    const p = new Uint8Array(2 + r.byteLength);
    p[0] = code >> 8;
    p[1] = code & 255;
    p.set(r, 2);
    this.frame(0x8, p).catch(() => undefined);
    setTimeout(() => this.end(code, reason, false), 3000);
  }
}

// ---------------------------------------------------------------- the host

export async function startVmHost(opts: VmHostOptions): Promise<VmHost | null> {
  const t0 = performance.now();
  const progress = (p: VmProgress) => {
    if (p.frac === undefined)
      console.debug(`[vm] ${(performance.now() - t0).toFixed(0)} ms: ${p.stage}: ${p.text}`);
    opts.onProgress?.(p);
  };
  const support = await checkSupport();
  if (!support.ok) throw new Error(`This browser cannot run the demo's hub: ${support.problems.join('; ')}`);

  console.debug(`[vm] ${(performance.now() - t0).toFixed(0)} ms: support checked`);
  // One tab owns the machine. The lock is held until this tab goes away.
  const owner = await new Promise<boolean>((resolve) => {
    void navigator.locks.request(OWNER_LOCK, { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      return lock ? new Promise<void>(() => {}) : undefined;
    });
  });
  console.debug(`[vm] ${(performance.now() - t0).toFixed(0)} ms: owner ${owner}`);
  if (!owner) return null;

  progress({ stage: 'manifest', text: 'Preparing the hub' });
  const base = new URL('vm/', opts.root);
  const mr = await fetch(new URL('manifest.json', base), { cache: 'no-cache' });
  if (!mr.ok) throw new Error(`vm/manifest.json: HTTP ${mr.status}`);
  const manifest = (await mr.json()) as Manifest;
  const at = (p: string) => new URL(p, base).href;
  const rootUrl = at(manifest.root.path);

  progress({ stage: 'download', text: 'Downloading the hub', frac: 0 });
  const template = await download(at(manifest.data.path));

  // Which saved machine fits the visitor's disk (`Meta`).
  let meta = await kvGet<Meta>('meta');
  let snapshotBytes: Uint8Array | undefined;
  let started: VmHost['started'] = 'boot';
  const fresh = async () => {
    progress({ stage: 'download', text: 'Downloading the hub', frac: 0 });
    const gz = await download(at(manifest.snapshot.path), (f) =>
      progress({ stage: 'download', text: 'Downloading the hub', frac: f }),
    );
    progress({ stage: 'disk', text: 'Preparing the hub’s disk' });
    await resetDataDisk(DISK);
    await importDataDisk(template, DISK);
    meta = { build: manifest.id, lastWriteAt: 0, checkpointAt: 0 };
    await kvPut({ meta }, ['checkpoint']);
    snapshotBytes = await gunzip(gz);
    started = 'snapshot';
  };
  if (!meta || meta.build !== manifest.id) await fresh();
  else {
    const cp = await kvGet<Checkpoint>('checkpoint');
    if (cp && cp.build === manifest.id && cp.at >= meta.lastWriteAt) {
      progress({ stage: 'disk', text: 'Restoring your hub' });
      await importDataDisk(new Uint8Array(await cp.disk.arrayBuffer()), DISK);
      snapshotBytes = await gunzip(cp.snapshot);
      started = 'checkpoint';
    } else if (!cp && meta.lastWriteAt === 0) await fresh();
    else started = 'boot';
  }

  const dataSpec = { kind: 'data' as const, template, ...DISK, mode: 'persistent' as const };
  let vm: WorkerKernel | undefined;
  if (snapshotBytes) {
    progress({ stage: 'resume', text: 'Starting the hub' });
    const snap: KernelSnapshot = decodeSnapshot(snapshotBytes);
    snapshotBytes = undefined;
    try {
      // The snapshot's disk records as this browser's disks report them. The bytes are the same (the manifest's
      // files, or the checkpoint's own copy of the disk), only how they are reached differs.
      const distro = await openDistroDisk(rootUrl);
      const data = await openDataDisk({ template, ...DISK, mode: 'persistent' });
      const disks: DiskSnapshotState[] = [distro.snapshotState(), data.snapshotState()];
      data.detach();
      snap.disks = disks;
      vm = (await createKernel({
        restore: snap,
        worker: true,
        transferRestore: true,
        distro: rootUrl,
        disks: [dataSpec],
        log: (m) => console.debug('[vm]', m),
      })) as WorkerKernel;
    } catch (e) {
      console.warn('[vm] the saved machine did not resume; booting it', e);
      started = 'boot';
    }
  }
  /** Boot the machine on the visitor's disk and start the hub, as the container's entrypoint does. */
  const bootMachine = async (): Promise<WorkerKernel> => {
    progress({ stage: 'boot', text: 'Booting the hub (this takes a minute)' });
    const k = await createKernel({
      worker: true,
      distro: rootUrl,
      disks: [dataSpec],
      memoryMiB: manifest.memoryMiB,
      log: (m) => console.debug('[vm]', m),
    });
    const r = await k.exec('sh', ['-c', VM_GUEST.startCommand], { user: 'root' });
    if (r.exitCode !== 0) throw new Error(`the hub did not start: ${r.stderr}`);
    return k;
  };
  let kernel: WorkerKernel = vm ?? (await bootMachine());

  // ------------------------------------------------ HTTP into the guest

  // The hub's cookies, kept for this build across reloads (the hub keeps its sessions on its disk; a fresh start
  // has none of them).
  const JAR_KEY = `ordo-vm-cookies:${manifest.id}`;
  const jar = new Map<string, string>();
  try {
    const saved = (started as VmHost['started']) === 'snapshot' ? null : localStorage.getItem(JAR_KEY);
    for (const [k, v] of saved ? (JSON.parse(saved) as [string, string][]) : []) jar.set(k, v);
  } catch {
    /* no storage: sign in below */
  }
  const saveJar = () => {
    try {
      localStorage.setItem(JAR_KEY, JSON.stringify([...jar]));
    } catch {
      /* no storage */
    }
  };
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const takeCookies = (headers: [string, string][]) => {
    for (const [k, v] of headers) {
      if (k !== 'set-cookie') continue;
      const [pair, ...attrs] = v.split(';');
      const eq = pair!.indexOf('=');
      if (eq <= 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const gone = attrs.some((a) => {
        const [ak, av] = a.split('=').map((s) => s.trim().toLowerCase());
        return (
          (ak === 'max-age' && Number(av) <= 0) || (ak === 'expires' && Date.parse(av ?? '') < Date.now())
        );
      });
      if (gone || value === '') jar.delete(name);
      else jar.set(name, value);
      saveJar();
    }
  };

  const guestHttp = async (
    method: string,
    path: string,
    headers: [string, string][],
    body: Uint8Array | null,
    withCookies = true,
  ): Promise<GuestResponse> => {
    const sock = await kernel.connect(VM_GUEST.port);
    const lines = [`${method} ${path} HTTP/1.1`, `Host: localhost:${VM_GUEST.port}`, 'Connection: close'];
    for (const [k, v] of headers) if (!DROP_REQUEST.has(k.toLowerCase())) lines.push(`${k}: ${v}`);
    if (withCookies && jar.size) lines.push(`Cookie: ${cookieHeader()}`);
    if (body || !['GET', 'HEAD'].includes(method)) lines.push(`Content-Length: ${body?.byteLength ?? 0}`);
    const w = sock.writable.getWriter();
    await w.write(enc.encode(`${lines.join('\r\n')}\r\n\r\n`));
    if (body?.byteLength) await w.write(body);
    w.releaseLock();
    const reader = new ByteReader(sock.readable.getReader());
    let h: ReturnType<typeof parseHead>;
    for (;;) {
      const head = await reader.head();
      if (head === null) throw new Error('the hub closed the connection without an answer');
      h = parseHead(head);
      if (h.status >= 200 || h.status === 101) break;
    }
    takeCookies(h.headers);
    const get = (k: string) => h.headers.find(([n]) => n === k)?.[1];
    const close = () => void sock.close().catch(() => undefined);
    async function* bodyOf(): AsyncGenerator<Uint8Array> {
      try {
        if (method === 'HEAD' || h.status === 204 || h.status === 304) return;
        if (/chunked/i.test(get('transfer-encoding') ?? '')) {
          for (;;) {
            const size = Number.parseInt((await reader.line()).split(';')[0]!, 16);
            if (!size) break;
            yield* reader.exactly(size);
            await reader.line();
          }
          return;
        }
        const len = get('content-length');
        if (len !== undefined) {
          if (Number(len) > 0) yield* reader.exactly(Number(len));
          return;
        }
        yield* reader.rest();
      } finally {
        close();
      }
    }
    return { ...h, body: bodyOf() };
  };

  const hubJson = async (method: string, path: string, json?: unknown, timeoutMs = 30_000) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the hub did not answer ${path} in ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([hubJsonNow(method, path, json), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  const hubJsonNow = async (method: string, path: string, json?: unknown) => {
    const r = await guestHttp(
      method,
      `/api/v1/${path}`,
      [
        ['x-ordo', '1'],
        ...(json === undefined ? [] : ([['content-type', 'application/json']] as [string, string][])),
      ],
      json === undefined ? null : enc.encode(JSON.stringify(json)),
    );
    const parts: Uint8Array[] = [];
    for await (const p of r.body) parts.push(p);
    const text = dec.decode(await new Blob(parts as BlobPart[]).arrayBuffer());
    return { status: r.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  console.debug(`[vm] ${(performance.now() - t0).toFixed(0)} ms: machine running (${started})`);
  /** Wait until the hub answers with its library process up (a booted machine takes a while). */
  const healthy = async (limitMs: number): Promise<boolean> => {
    const end = Date.now() + limitMs;
    let said = Date.now();
    for (;;) {
      let why = '';
      try {
        const h = await hubJson('GET', 'health', undefined, 8000);
        if (h.status === 200 && h.json.library === 'up') return true;
        why = `HTTP ${h.status}, library ${String(h.json.library)}`;
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
      if (Date.now() - said > 10_000) {
        console.debug(`[vm] ${(performance.now() - t0).toFixed(0)} ms: waiting for the hub (${why})`);
        said = Date.now();
      }
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  if (!(await healthy(started === 'boot' ? 15 * 60_000 : RESUME_HEALTHY_MS))) {
    if (started === 'boot') throw new Error('the hub did not start');
    // A resumed hub that never answers: boot the machine on the visitor's disk instead (the disk is consistent).
    console.warn('[vm] the resumed hub did not answer; booting the machine');
    await kernel.stop().catch(() => undefined);
    started = 'boot';
    kernel = await bootMachine();
    if (!(await healthy(15 * 60_000))) throw new Error('the hub did not start');
  }
  (globalThis as { __ordoVmKernel?: WorkerKernel }).__ordoVmKernel = kernel;
  const machine = kernel;
  void machine.exited.then((x) => console.warn('[vm] the machine ended', x));

  console.debug(`[vm] ${(performance.now() - t0).toFixed(0)} ms: hub healthy`);
  // The demo signs the operator in with its published PIN, so the visitor never types it.
  progress({ stage: 'sign-in', text: 'Signing in' });
  const me = await hubJson('GET', 'auth/me');
  if (me.json.role !== 'operate') {
    const s = await hubJson('POST', 'auth/pin', { pin: VM_GUEST.pin, remember: true });
    if (s.status !== 200) throw new Error(`signing in to the demo hub: HTTP ${s.status}`);
  }

  // ------------------------------------------------ persistence

  let dirtySince = 0;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<boolean> | undefined;
  let stopped = false;

  const markWrite = () => {
    const now = Date.now();
    if (!dirtySince) dirtySince = now;
    meta = { ...meta!, lastWriteAt: now };
    void kvPut({ meta });
    clearTimeout(quietTimer);
    const wait = Math.max(0, Math.min(QUIET_MS, dirtySince + MAX_DIRTY_MS - now));
    quietTimer = setTimeout(() => void checkpoint(), wait);
  };

  /** The guest's files written back and its disks saved (one sync at a time; callers that arrive meanwhile share the next). */
  let syncing: Promise<unknown> | undefined;
  let syncAgain: Promise<unknown> | undefined;
  const durable = (): Promise<unknown> => {
    if (!syncing) {
      syncing = machine.sync({ timeout: 5000 }).finally(() => {
        syncing = undefined;
      });
      return syncing;
    }
    syncAgain ??= syncing.then(() => {
      syncAgain = undefined;
      return durable();
    });
    return syncAgain;
  };

  const checkpoint = async (force = false): Promise<boolean> => {
    if (stopped) return false;
    if (saving) return saving;
    if (!force && !dirtySince) return false;
    saving = (async () => {
      const at = Date.now();
      const wasDirty = dirtySince;
      dirtySince = 0;
      let captured: { snap: KernelSnapshot; parts: BlobPart[] } | undefined;
      let heldMs = 0;
      try {
        // Held at the snapshot's consistent point: the disk copy and the memory are of the same instant. The hub is
        // paused for as long as the copy takes, then goes on.
        await kernel.snapshot({
          commit: async (snap) => {
            const d = await kernel.exportDisk(0);
            captured = { snap, parts: d.parts };
          },
          hold: async () => {
            heldMs = Date.now() - at;
            return 'continue' as const;
          },
        });
        if (!captured) throw new Error('nothing captured');
        const memory = encodeSnapshot(captured.snap);
        captured.snap = undefined as unknown as KernelSnapshot;
        const [snapshot, disk] = await Promise.all([gzip(memory), gzipBlob(captured.parts)]);
        const cp: Checkpoint = { build: meta!.build, at, snapshot, disk };
        meta = { ...meta!, checkpointAt: at };
        await kvPut({ checkpoint: cp, meta });
        console.debug(
          `[vm] checkpoint saved: ${(snapshot.size / 1048576).toFixed(1)} MiB machine, ${(disk.size / 1048576).toFixed(1)} MiB disk; hub paused ${heldMs} ms, saved in ${Date.now() - at} ms`,
        );
        return true;
      } catch (e) {
        console.warn('[vm] checkpoint failed; retrying soon', e);
        if (wasDirty && !dirtySince) dirtySince = wasDirty;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => void checkpoint(), QUIET_MS);
        return false;
      } finally {
        saving = undefined;
        // A change that reached the hub while this save ran is not in it: save again once the hub is quiet.
        if (dirtySince && !stopped) {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => void checkpoint(), QUIET_MS);
        }
      }
    })();
    return saving;
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void durable();
      void checkpoint();
    }
  });
  addEventListener('pagehide', () => void durable());
  // A booted hub works for a while after it answers (its processes finish starting): save it once that has settled,
  // so a later load resumes a quiet hub rather than one in the middle of its start.
  if (started === 'boot') setTimeout(() => void checkpoint(true), BOOT_SETTLE_MS);

  const reset = async () => {
    stopped = true;
    clearTimeout(quietTimer);
    await kernel.stop().catch(() => undefined);
    await resetDataDisk(DISK).catch(() => undefined);
    await deleteDb(KV_DB);
  };

  // ------------------------------------------------ the relay

  const answer = async (req: RelayRequest, port: MessagePort) => {
    const post = (m: RelayReply, transfer: Transferable[] = []) => port.postMessage(m, transfer);
    post({ t: 'accept' });
    try {
      const guestPath = req.path;
      if (req.method === 'POST' && /^\/api\/v1\/demo\/reset\/?$/.test(guestPath)) {
        await reset();
        post({ t: 'head', status: 204, statusText: 'No Content', headers: [] });
        post({ t: 'end' });
        return;
      }
      const r = await guestHttp(
        req.method,
        guestPath,
        req.headers,
        req.body ? new Uint8Array(req.body) : null,
      );
      post({
        t: 'head',
        status: r.status,
        statusText: r.statusText,
        headers: r.headers.filter(([k]) => !DROP_RESPONSE.has(k)),
      });
      for await (const chunk of r.body) {
        const data = chunk.buffer.byteLength === chunk.byteLength ? chunk.buffer : chunk.slice().buffer;
        post({ t: 'chunk', data: data as ArrayBuffer }, [data as ArrayBuffer]);
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && r.status < 400) {
        markWrite();
        // As a hub on a server: a change is on disk once it is answered. The guest writes back its files and the data
        // disk saves to IndexedDB before the response ends (tens of milliseconds), so a tab closed right after keeps it.
        await durable();
      }
      post({ t: 'end' });
    } catch (e) {
      post({ t: 'error', status: 502, message: e instanceof Error ? e.message : String(e) });
    }
  };
  navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as RelayRequest | undefined;
    if (m?.t === 'ordo-vm-fetch' && ev.ports[0] && !stopped) void answer(m, ev.ports[0]);
  });
  navigator.serviceWorker.startMessages();

  // ------------------------------------------------ WebSockets

  const bc = new BroadcastChannel(WS_CHANNEL);
  const sockets = new Map<string, { ws?: GuestWebSocket; seen: number; queued: (string | ArrayBuffer)[] }>();
  const down = (m: WsDown) => bc.postMessage(m);
  bc.onmessage = (ev: MessageEvent<WsUp>) => {
    const m = ev.data;
    if (stopped) return;
    if (m.t === 'open') {
      const entry = { seen: Date.now(), queued: [] as (string | ArrayBuffer)[] } as {
        ws?: GuestWebSocket;
        seen: number;
        queued: (string | ArrayBuffer)[];
      };
      sockets.set(m.id, entry);
      // An output or stage window carries its token in the URL; only the operator's sockets use the session.
      const headers: [string, string][] = /[?&]token=/.test(m.path) ? [] : [['Cookie', cookieHeader()]];
      GuestWebSocket.open(() => kernel.connect(VM_GUEST.port), m.path, headers, m.protocols)
        .then((ws) => {
          if (!sockets.has(m.id)) return ws.close(1001, 'gone');
          entry.ws = ws;
          ws.onMessage = (data) => down({ t: 'msg', id: m.id, data });
          ws.onClose = (code, reason, wasClean) => {
            sockets.delete(m.id);
            down({ t: 'closed', id: m.id, code, reason, wasClean });
          };
          down({ t: 'opened', id: m.id, protocol: ws.protocol });
          for (const q of entry.queued) ws.send(q);
          entry.queued.length = 0;
        })
        .catch(() => {
          sockets.delete(m.id);
          down({ t: 'closed', id: m.id, code: 1006, reason: '', wasClean: false });
        });
    } else if (m.t === 'send') {
      // A live command changes what the hub keeps (live.db): save the machine as after an API write.
      if (typeof m.data === 'string' && m.data.includes('"t":"live.event"')) {
        markWrite();
        setTimeout(() => void durable(), 1500);
      }
      const s = sockets.get(m.id);
      if (s?.ws) s.ws.send(m.data);
      else s?.queued.push(m.data);
    } else if (m.t === 'close') {
      const s = sockets.get(m.id);
      sockets.delete(m.id);
      s?.ws?.close(m.code ?? 1000, m.reason ?? '');
    } else if (m.t === 'alive') {
      const now = Date.now();
      for (const id of m.ids) {
        const s = sockets.get(id);
        if (s) s.seen = now;
      }
    }
  };
  setInterval(() => {
    if (stopped) return;
    down({ t: 'host', at: Date.now() });
    const now = Date.now();
    for (const [id, s] of sockets)
      if (now - s.seen > ALIVE_TIMEOUT_MS) {
        sockets.delete(id);
        s.ws?.close(1001, 'the window went away');
      }
  }, ALIVE_MS);

  progress({ stage: 'ready', text: 'Ready' });
  const status = () => ({
    lastWriteAt: meta!.lastWriteAt,
    checkpointAt: meta!.checkpointAt,
    saving: saving !== undefined,
  });
  return { started, reset, checkpoint, status, vm: kernel };
}
