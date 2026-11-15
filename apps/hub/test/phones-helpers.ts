/**
 * Shared by the phones tests (design/28 P0): both hub processes in this test process, wired as the supervisor
 * wires them (as review2.test.ts's twoProcesses), and the sign-ins a phone and the venue PC make.
 */
import { join } from 'node:path';
import type { HubConfig } from '../src/config.ts';
import { createLibraryProcess, type LibraryProcess } from '../src/libproc.ts';
import { createLiveProcess, type LiveProcess } from '../src/liveproc.ts';
import { type Client, client, EDIT_PIN, OPERATE_PIN, TEST_TOOLS, tempDir } from './helpers.ts';

export type TwoProcesses = {
  base: string;
  lib: LibraryProcess;
  live: LiveProcess;
  close(): Promise<void>;
};

/** Both processes, the library's changes relayed to the live process after `ipcDelayMs`. */
export async function twoProcesses(
  ipcDelayMs = 0,
  overrides: Partial<HubConfig> = {},
  libOpts: Partial<Parameters<typeof createLibraryProcess>[1]> = {},
): Promise<TwoProcesses> {
  const dir = tempDir();
  const secret = 'test-secret';
  const cfg: Partial<HubConfig> = {
    dataDir: dir,
    domain: 'localhost',
    devPin: `${OPERATE_PIN}:${EDIT_PIN}`,
    logToStdout: false,
    logLevel: 'warn',
    scheduleBackups: false,
    appsDir: join(dir, 'no-apps'),
    importRoots: [join(dir, 'import')],
    host: '127.0.0.1',
    port: 0,
    healthIntervalMs: 100,
    toolProbe: TEST_TOOLS,
    ...overrides,
  };
  let live: LiveProcess | undefined;
  let relay: (changes: never[], seq: number) => void = () => undefined;
  const lib = await createLibraryProcess(cfg, {
    secret,
    onChanges: (changes, seq) => setTimeout(() => relay(changes as never[], seq), ipcDelayMs),
    ...libOpts,
  });
  live = await createLiveProcess(cfg, {
    secret,
    libraryUrl: lib.url,
    onLocks: (m) => lib.setLocks(m),
  });
  relay = (changes, seq) => live?.onLibraryChanges(changes, seq);
  const l = live;
  return {
    base: l.url,
    lib,
    live: l,
    async close() {
      await l.close();
      await lib.close();
      live = undefined;
    },
  };
}

/** A phone's sign-in: `cap: 'light'` (no remember), as the compact layout sends it to a hub that lists caps. */
export async function phone(base: string, pin = EDIT_PIN, cap: 'light' | 'view' = 'light'): Promise<Client> {
  const c = client(base);
  const res = await c.fetch('/auth/pin', { method: 'POST', json: { pin, cap } });
  if (!res.ok) throw new Error(`phone sign-in failed ${res.status} ${await res.text()}`);
  return c;
}

/** The `{ error }` body of a refusal. */
export async function refusal(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as { error?: Record<string, unknown> };
  return body.error ?? {};
}
