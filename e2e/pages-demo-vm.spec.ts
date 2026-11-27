import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { portOf } from './ports.ts';

/**
 * The GitHub Pages demo's VM hub (docs/design/26-pages-demo.md, "The VM hub"): the real hub, in a Linux machine
 * (unkernel) in the operator tab, resumed from the build's snapshot. Served as Pages serves a project site, static
 * files under /ordo/, with range requests (the machine reads its system image by range, as from Pages).
 * Needs `pnpm build && pnpm build:pages` with the VM hub (CI builds it); skipped when site/vm/ is missing.
 * Its port: e2e/ports.ts row 'pages-demo-vm'.
 *
 * One visitor's path: the first visit resumes the build's snapshot signed in; the hub's diagnostics export, the VM
 * logs download and the hub console work; a ProPresenter import goes through the
 * relay into the real hub; the hub is saved and a reload resumes that save; Go live, the output window follows the
 * hub over its socket (bus 'hub', not the fallback bus); a change the hub had no time to save boots the machine on
 * the visitor's disk on the next load and keeps it; Reset demo starts again from the build's snapshot.
 */
const SITE = resolve('site');
const PORT = portOf('pages-demo-vm');
const BASE = `http://localhost:${PORT}/ordo/`;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

test.skip(
  !existsSync(join(SITE, 'vm/manifest.json')),
  'site/vm is not built (pnpm build && pnpm build:pages)',
);

let server: Server;
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', BASE);
    if (!url.pathname.startsWith('/ordo/')) {
      res.writeHead(404).end('not found');
      return;
    }
    let path = join(SITE, decodeURIComponent(url.pathname.slice('/ordo/'.length)));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    if (!path.startsWith(SITE) || !existsSync(path)) {
      res.writeHead(404).end('not found');
      return;
    }
    const st = statSync(path);
    const head = {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, {
        ...head,
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'content-length': end - start + 1,
      });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, 'content-length': st.size });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(path).pipe(res);
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', () => r()));
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

type VmStatus = { lastWriteAt: number; checkpointAt: number; saving: boolean };
type VmWindow = { __ordoVm?: { started: string; status(): VmStatus } | null };

/** Wait until the operator app runs on the VM hub; returns how this load started it. */
async function vmUp(page: Page, timeout = 60_000): Promise<string> {
  await expect(page.locator('[data-demo-banner]')).toBeVisible({ timeout });
  return page.evaluate(() => (window as unknown as VmWindow).__ordoVm?.started ?? 'none');
}

/** Wait until the host saved every change the hub took (a checkpoint newer than the last write). */
async function saved(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = (window as unknown as VmWindow).__ordoVm!.status();
          return s.checkpointAt >= s.lastWriteAt && !s.saving;
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
}

const venueName = (page: Page) =>
  page.evaluate(
    async () =>
      ((await (await fetch('api/v1/settings/general')).json()) as { venueName?: string }).venueName ?? '',
  );

test('the Pages demo runs the real hub in the browser: resume, relay, save, live outputs, boot, reset', async ({
  context,
  page,
}) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The VM host's own steps (vm-host.ts logs them at debug level): what a failure shows of where the start stood.
  page.on('console', (m) => {
    if (/^\[vm\] (\d+ ms|checkpoint|the saved|the machine)/.test(m.text())) console.log(`  ${m.text()}`);
  });

  // First visit: the build's snapshot, signed in, the sample service, and the app's hub socket connected.
  await page.goto(BASE);
  expect(await vmUp(page)).toBe('snapshot');
  await expect(page.getByText('Hub connected')).toBeVisible({ timeout: 30_000 });
  const health = await page.evaluate(async () => (await fetch('api/v1/health')).json());
  expect(health).toMatchObject({ ok: true, library: 'up' });
  await page.evaluate(() => {
    location.hash = '#/library';
  });
  await expect(page.getByText('Amazing Grace', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  // Diagnostics. The hub's own export goes through the relay as on a server.
  const exported = await page.evaluate(async () => {
    const r = await fetch('api/v1/diagnostics/export');
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type'), zip: b[0] === 0x50 && b[1] === 0x4b };
  });
  expect(exported).toMatchObject({ status: 200, zip: true });
  // The demo dialog's VM logs: one .tar.gz with the hub's log, the machine's and this page's side.
  await page.locator('[data-demo-banner]').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'Download VM logs' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^ordo-vm-logs-[0-9a-f]+-.+\.tar\.gz$/);
  const logs = test.info().outputPath('vm-logs.tar.gz');
  await download.saveAs(logs);
  const listed = execFileSync('tar', ['tzf', logs], { encoding: 'utf8' });
  for (const f of [
    'hub.log',
    'supervisor.json',
    'dmesg.txt',
    'ps.txt',
    'system.txt',
    'page.json',
    'host.log',
  ])
    expect(listed, `${f} in the VM logs`).toContain(`/${f}`);
  const pageJson = JSON.parse(
    execFileSync('tar', ['xzOf', logs, '--wildcards', '*/page.json'], { encoding: 'utf8' }),
  ) as { started: string; build: { id: string } };
  expect(pageJson.started).toBe('snapshot');
  const hubLog = execFileSync('tar', ['xzOf', logs, '--wildcards', '*/hub.log'], { encoding: 'utf8' });
  expect(hubLog).toContain('child process ready');
  expect(readFileSync(logs).byteLength).toBeGreaterThan(1000);
  // The hub console: a root shell in the machine.
  await page.getByRole('button', { name: 'Hub console' }).click();
  const consoleBox = page.locator('[data-vm-console]');
  await expect(consoleBox).toBeVisible();
  // The shell's prompt names its working directory, the hub's data folder.
  await expect(consoleBox.locator('.xterm-rows')).toContainText('/data/ordo', { timeout: 30_000 });
  await consoleBox.locator('.xterm').click();
  await page.keyboard.type('echo ordo-$((6*7)) $(whoami) $(test -f /data/ordo/ordo.db && echo db)\n');
  await expect(consoleBox.locator('.xterm-rows')).toContainText('ordo-42 root db', { timeout: 30_000 });
  await consoleBox.locator('[data-vm-console-close]').click();
  await expect(consoleBox).toHaveCount(0);

  // A ProPresenter bundle, uploaded through the relay and imported by the real hub.
  await page.evaluate(() => {
    location.hash = '#/library/import';
  });
  await page
    .locator('input[type=file][accept*=".zip"]')
    .setInputFiles(resolve('packages/importers/test-fixtures/pro7/RestBildExportFromPP.probundle'));
  await expect(page.getByText(/^done$/).first()).toBeVisible({ timeout: 180_000 });
  await page.evaluate(() => {
    location.hash = '#/library';
  });
  await expect(page.getByText('TestBild', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // Saved once the hub is quiet; a reload resumes that save, with the import.
  await saved(page);
  await page.reload();
  expect(await vmUp(page)).toBe('checkpoint');
  await expect(page.getByText('Hub connected')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    location.hash = '#/library';
  });
  await expect(page.getByText('TestBild', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // Go live on the hub (it prepares the service first), launch the outputs: the output follows the hub's socket.
  await page.evaluate(() => {
    location.hash = '#/playlists';
  });
  await page.getByText('Sample service').first().click();
  await page.getByRole('button', { name: 'Go live', exact: true }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(async () => ((await (await fetch('api/v1/health')).json()) as { mode: string }).mode),
      { timeout: 180_000 },
    )
    .toBe('live');
  await page.getByRole('button', { name: 'Launch outputs' }).click();
  const outs = () => context.pages().filter((p) => !p.isClosed() && p.url().includes('/ordo/output/'));
  await expect.poll(() => outs().length, { timeout: 30_000 }).toBe(1);
  const out = outs()[0]!;
  await expect
    .poll(
      () =>
        out
          .evaluate(
            () => (window as unknown as { __ordo?: { state(): { bus: string } } }).__ordo?.state().bus,
          )
          .catch(() => undefined),
      { timeout: 60_000 },
    )
    .toBe('hub');
  const showing = () =>
    out
      .evaluate(
        () =>
          (window as unknown as { __ordo: { state(): { held: { live: string }[] } } }).__ordo.state().held[1]
            ?.live ?? '',
      )
      .catch(() => '');
  await expect
    .poll(
      async () => {
        if (!(await showing())) {
          await page.bringToFront();
          await page.keyboard.press('Space');
        }
        return (await showing()).length > 0;
      },
      { timeout: 60_000, intervals: [3000] },
    )
    .toBe(true);
  await page.bringToFront();
  await page.getByRole('button', { name: 'End service' }).click();
  await page.locator('.backdrop button', { hasText: 'End service' }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(async () => ((await (await fetch('api/v1/health')).json()) as { mode: string }).mode),
      { timeout: 60_000 },
    )
    .not.toBe('live');
  await out.close();

  // A change the hub had no time to save: the next load boots the machine on the visitor's disk, and keeps it.
  await saved(page);
  await page.evaluate(async () => {
    const g = (await (await fetch('api/v1/settings/general')).json()) as Record<string, unknown>;
    const r = await fetch('api/v1/settings/general', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-ordo': '1' },
      body: JSON.stringify({ ...g, venueName: 'Booted on my disk' }),
    });
    if (!r.ok) throw new Error(`PUT settings: ${r.status}`);
  });
  await page.reload();
  expect(await vmUp(page, 600_000)).toBe('boot');
  expect(await venueName(page)).toBe('Booted on my disk');
  await page.evaluate(() => {
    location.hash = '#/library';
  });
  await expect(page.getByText('TestBild', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // Reset: the build's snapshot again, the visitor's work gone.
  await page.locator('[data-demo-banner]').click();
  await page.getByRole('button', { name: 'Reset demo' }).click();
  await Promise.all([
    page.waitForEvent('load', { timeout: 60_000 }),
    page.locator('.backdrop button', { hasText: 'Reset' }).click(),
  ]);
  expect(await vmUp(page)).toBe('snapshot');
  await page.evaluate(() => {
    location.hash = '#/library';
  });
  await expect(page.getByText('Amazing Grace', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('TestBild', { exact: true })).toHaveCount(0);
  expect(await venueName(page)).not.toBe('Booted on my disk');
  expect(errors).toEqual([]);
});
