import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lyricSlide, newId, type Presentation } from '@ordo/domain';
import { APP_VERSION } from '@ordo/protocol';
import WebSocket from 'ws';
import { type HubConfig, type PrerenderConfig, prerenderConfig } from '../src/config.ts';
import { afterAll } from 'vitest';
import { createHub, type Hub } from '../src/hub.ts';
import { noSystemFaces } from '../src/pptx/systemFaces.ts';
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

/**
 * The folders (`tempDir`) and hubs (`startHub`) the test file importing this module made: after its last test the
 * hubs it did not clean up are closed and every folder removed, so a run leaves no `ordo-*` folder in TMPDIR
 * (`tempdirs.test.ts`). This module is evaluated once per test file, as the file is collected, so the hook is the
 * file's first `afterAll` and runs after the file's own (after-hooks run last registered first).
 */
const madeDirs = new Set<string>();
const openHubs = new Set<TestHub>();
afterAll(async () => {
  for (const hub of [...openHubs]) await hub.cleanup();
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
  madeDirs.clear();
});

/** A new folder under TMPDIR, removed after the test file that made it. */
export function tempDir(prefix = 'ordo-hub-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  madeDirs.add(dir);
  return dir;
}

/**
 * The free-space floor of a hub a test starts (`HubConfig.minFreeBytes`): off, ORDO_MIN_FREE_GB=0. The floor would
 * refuse every upload on a CI or dev volume with less free than the floor (5 % of the volume, 5 to 25 GiB), whatever
 * the test is about; the floor has its own tests (`diskfloor.test.ts`). A test that gives its hub a volume of its own (`statfs`) is a test of the floor and
 * gets the computed one (`undefined`, never the floor of the process's environment); a test that sets
 * `minFreeBytes` itself keeps its value (`...overrides` comes after). Every hub a test starts goes through this
 * or pins its own value (`floor-off.test.ts` reads the test folder for a start that does neither).
 */
export function testFloor(overrides: Partial<HubConfig> = {}): number | undefined {
  return overrides.statfs ? undefined : 0;
}

/**
 * The pre-render state of a hub a test starts (store-2, C-S2-5): the hub of 0.10.0, independent of the process
 * environment (ORDO_PRERENDER) and of the domain constant PRERENDER_ON, so flipping the constant at the release's
 * switch commit changes no hub test: the setting auto, the constant read as false (operators told off, no picture line
 * W33), the store open (a picture is accepted, keys are computed). A test that wants another state gives `prerender`
 * itself (`prerenderConfig('on')`, `prerenderConfig('off')`) and keeps it (`...overrides` comes after).
 */
export function testPrerender(overrides: Partial<HubConfig> = {}): PrerenderConfig {
  return overrides.prerender ?? prerenderConfig(undefined, false);
}

export async function startHub(overrides: Partial<HubConfig> = {}): Promise<TestHub> {
  const dir = overrides.dataDir ?? tempDir();
  const hub = await createHub({
    minFreeBytes: testFloor(overrides),
    prerender: testPrerender(overrides),
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
    // No script face of this computer (rule H) unless a test injects one: a hub test means the same anywhere.
    systemFaces: noSystemFaces,
    ...overrides,
  });
  const url = await hub.listen(0);
  let cleaned = false;
  const test: TestHub = Object.assign(hub, {
    url,
    dir,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      openHubs.delete(test);
      await hub.close();
      if (!overrides.dataDir) rmSync(dir, { recursive: true, force: true });
    },
  });
  openHubs.add(test);
  return test;
}

export type Client = {
  cookie: string;
  fetch(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  json<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>;
};

/**
 * A hub client as the ordo apps are: it sends `x-ordo: 1` (design/28 §4) unless `opts.xOrdo` is false (a
 * client older than the hub, or a page made elsewhere).
 */
export function client(
  base: string,
  cookie = '',
  headers: Record<string, string> = {},
  opts: { xOrdo?: boolean } = {},
): Client {
  const c: Client = {
    cookie,
    async fetch(path, init = {}) {
      const h = new Headers(init.headers);
      if (opts.xOrdo !== false) h.set('x-ordo', '1');
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
