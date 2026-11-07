import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lyricSlide, newId, type Presentation } from '@ordo/domain';
import { APP_VERSION } from '@ordo/protocol';
import WebSocket from 'ws';
import type { HubConfig } from '../src/config.ts';
import { createHub, type Hub } from '../src/hub.ts';
import type { ToolProbe } from '../src/tools.ts';

export const OPERATE_PIN = '111111';
export const EDIT_PIN = '222222';

export type TestHub = Hub & { url: string; dir: string; cleanup(): Promise<void> };

/**
 * The server tools a test hub sees (design/27 M9, `tools.ts`): LibreOffice and poppler-utils 'available'
 * without looking for them, so the PowerPoint tests behave the same on any machine (those that really run
 * LibreOffice skip without it). A test of their absence passes `libreoffice: { mode: 'off', exe: '' }`, or
 * `toolProbe: undefined` to detect them for real.
 */
export const TEST_TOOLS: ToolProbe = () => ({ state: 'available' });

export function tempDir(prefix = 'ordo-hub-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function startHub(overrides: Partial<HubConfig> = {}): Promise<TestHub> {
  const dir = overrides.dataDir ?? tempDir();
  const hub = await createHub({
    dataDir: dir,
    domain: 'localhost',
    devPin: `${OPERATE_PIN}:${EDIT_PIN}`,
    logToStdout: false,
    logLevel: 'warn',
    scheduleBackups: false,
    appsDir: join(dir, 'no-apps'),
    importRoots: [join(dir, 'import')],
    host: '127.0.0.1',
    healthIntervalMs: 100,
    toolProbe: TEST_TOOLS,
    ...overrides,
  });
  const url = await hub.listen(0);
  let cleaned = false;
  return Object.assign(hub, {
    url,
    dir,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await hub.close();
      if (!overrides.dataDir) rmSync(dir, { recursive: true, force: true });
    },
  });
}

export type Client = {
  cookie: string;
  fetch(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  json<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>;
};

export function client(base: string, cookie = '', headers: Record<string, string> = {}): Client {
  const c: Client = {
    cookie,
    async fetch(path, init = {}) {
      const h = new Headers(init.headers);
      for (const [k, v] of Object.entries(headers)) h.set(k, v);
      if (c.cookie) h.set('cookie', c.cookie);
      let body = init.body;
      if (init.json !== undefined) {
        h.set('content-type', 'application/json');
        body = JSON.stringify(init.json);
      }
      const res = await fetch(`${base}/api/v1${path}`, { ...init, headers: h, body, redirect: 'manual' });
      const set = res.headers.getSetCookie();
      for (const sc of set) {
        const [kv] = sc.split(';');
        const [k] = kv!.split('=');
        const parts = c.cookie ? c.cookie.split('; ').filter((p) => !p.startsWith(`${k}=`)) : [];
        parts.push(kv!);
        c.cookie = parts.join('; ');
      }
      return res;
    },
    async json(path, init) {
      const res = await c.fetch(path, init);
      const text = await res.text();
      if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
      return (text ? JSON.parse(text) : undefined) as never;
    },
  };
  return c;
}

export async function login(base: string, pin: string, extra: Record<string, unknown> = {}): Promise<Client> {
  const c = client(base);
  const res = await c.fetch('/auth/pin', { method: 'POST', json: { pin, ...extra } });
  if (!res.ok) throw new Error(`login failed ${res.status} ${await res.text()}`);
  return c;
}

export type WsClient = {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  send(m: Record<string, unknown>): void;
  next(pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
};

export async function connectWs(
  base: string,
  opts: { cookie?: string; token?: string; hello?: Record<string, unknown> | false; origin?: string } = {},
): Promise<WsClient> {
  const url = `${base.replace(/^http/, 'ws')}/ws${opts.token ? `?token=${encodeURIComponent(opts.token)}` : ''}`;
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = opts.origin;
  const ws = new WebSocket(url, { headers });
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    pred: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }[] = [];
  const consumed = new Set<number>();
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as Record<string, unknown>;
    messages.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        consumed.add(messages.length - 1);
        w.resolve(m);
        return;
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`ws upgrade ${res.statusCode}`)));
  });
  const c: WsClient = {
    ws,
    messages,
    send: (m) => ws.send(JSON.stringify({ v: 1, ...m })),
    next(pred, timeoutMs = 5000) {
      // Consume from already-received messages first (in order).
      for (let i = 0; i < messages.length; i++) {
        if (!consumed.has(i) && pred(messages[i]!)) {
          consumed.add(i);
          return Promise.resolve(messages[i]!);
        }
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () =>
            reject(
              new Error(
                `timeout waiting for message; got ${JSON.stringify(messages.slice(-5)).slice(0, 800)}`,
              ),
            ),
          timeoutMs,
        );
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      });
    },
    close: () => ws.close(),
  };
  if (opts.hello !== false)
    c.send({ t: 'hello', appVersion: APP_VERSION, ...(opts.hello ?? { role: 'operate' }) });
  return c;
}

export const byType = (t: string) => (m: Record<string, unknown>) => m.t === t;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function song(title = 'Amazing Grace'): Presentation {
  const sid = newId();
  return {
    id: newId(),
    rev: 1,
    title,
    kind: 'song',
    meta: { tags: [] },
    sections: [
      {
        id: sid,
        label: 'Verse 1',
        short: 'V1',
        slides: [lyricSlide('Amazing grace'), lyricSlide('how sweet')],
      },
    ],
    arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
    archived: false,
  };
}
