/**
 * The messages between the demo's pages, its service worker and the VM host (docs/design/26-pages-demo.md, "The VM
 * hub"). Plain data, shared by apps/demo (the service worker, the host) and packages/client (the WebSocket shim keeps
 * its own copy of the socket messages, which must match these).
 */

/** The service worker asks the window clients for one hub request; the VM host answers on `port`. */
export type RelayRequest = {
  t: 'ordo-vm-fetch';
  method: string;
  /** Path and query in the hub's own terms (`/api/v1/...`). */
  path: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
};

/** The VM host's answers on the request's port, in this order: accept, head, chunks, end (or error). */
export type RelayReply =
  | { t: 'accept' }
  | { t: 'head'; status: number; statusText: string; headers: [string, string][] }
  | { t: 'chunk'; data: ArrayBuffer }
  | { t: 'end' }
  | { t: 'error'; status: number; message: string };

/** The BroadcastChannel every WebSocket shim and the VM host share. */
export const WS_CHANNEL = 'ordo-vm-ws';

/** Shim → host. `alive` lists the shim's open sockets every ALIVE_MS; the host closes the ones nobody lists. */
export type WsUp =
  | { t: 'open'; id: string; path: string; protocols: string[] }
  | { t: 'send'; id: string; data: string | ArrayBuffer }
  | { t: 'close'; id: string; code?: number; reason?: string }
  | { t: 'alive'; ids: string[] };

/** Host → shims. `host` is sent every ALIVE_MS while the host runs; a shim that stops hearing it closes its sockets. */
export type WsDown =
  | { t: 'opened'; id: string; protocol: string }
  | { t: 'msg'; id: string; data: string | ArrayBuffer }
  | { t: 'closed'; id: string; code: number; reason: string; wasClean: boolean }
  | { t: 'host'; at: number };

export const ALIVE_MS = 2000;
/** A socket nobody listed (host side), or a host not heard from (shim side), for this long is gone. */
export const ALIVE_TIMEOUT_MS = 7000;

/** The demo's hub mode as the service worker keeps it: 'vm' relays to the VM host, 'legacy' answers in the worker. */
export type DemoHubMode = 'vm' | 'legacy';
