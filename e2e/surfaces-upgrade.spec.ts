import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { HubProcess } from './hubproc.ts';
import { hubApi, login } from './linkhelpers.ts';
import { portOf } from './ports.ts';

/**
 * A venue that upgrades past MIDI becoming opt-in (2026-11-09; design/19 "MIDI"): its stored surface settings
 * have no `midiEnabled`. With MIDI mappings they read as enabled, so the pedals keep working; without any they
 * stay off, so the browser does not ask for MIDI access (`upgradeStoredSurfaces`, read in the hub's
 * `library.ts`). The spec writes such a row into a stopped hub's database, as the older build left it, starts
 * the hub and reads the settings through the API and on the Setup page. Its port: e2e/ports.ts row
 * 'surfaces-upgrade'.
 */
const PORT = portOf('surfaces-upgrade');
const OP = `http://op.localhost:${PORT}`;

type SqliteDb = {
  prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown };
  close(): void;
};
/** better-sqlite3 as the hub has it (a dependency of apps/hub, not of the suite). */
const Database = createRequire(resolve('apps/hub/package.json'))('better-sqlite3') as new (
  file: string,
) => SqliteDb;

type Surfaces = {
  midi: unknown[];
  midiEnabled?: boolean;
  streamDeckPages: unknown[];
  messagePresets: string[];
};

/** Stop the hub, write the surfaces row an older build stored (no `midiEnabled`), start it again. */
async function restartWithStoredSurfaces(hub: HubProcess, row: Omit<Surfaces, 'midiEnabled'>): Promise<void> {
  hub.kill();
  // The hub lets go of its port (and the database) once every process is gone; start() waits for that too.
  await expect
    .poll(() =>
      fetch(`http://localhost:${PORT}/api/v1/health`).then(
        () => 'up',
        () => 'down',
      ),
    )
    .toBe('down');
  const db = new Database(join(hub.dataDir, 'ordo.db'));
  try {
    db.prepare('UPDATE settings SET json = ? WHERE key = ?').run(JSON.stringify(row), 'surfaces');
    const back = db.prepare('SELECT json FROM settings WHERE key = ?').get('surfaces') as { json: string };
    expect(JSON.parse(back.json)).not.toHaveProperty('midiEnabled');
  } finally {
    db.close();
  }
  await hub.start();
}

async function surfaces(a: APIRequestContext): Promise<Surfaces> {
  const r = await a.get('settings/surfaces');
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as Surfaces;
}

/** The Web MIDI card of the Setup page. */
async function midiCard(page: Page) {
  await page.evaluate(() => {
    location.hash = '#/setup';
  });
  // The Web MIDI card, not the Controllers card around it.
  const card = page.locator('.card', { has: page.getByText('Web MIDI', { exact: true }) }).last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}

/**
 * An operator PC opening the operator app for the first time (a fresh browser profile: no library cached from
 * an earlier hub), with Web MIDI and no device plugged in: the test browser has no MIDI platform at all, so
 * access is granted at once by a stand-in, and every ask is counted, so the spec sees whether the operator
 * asked for MIDI.
 */
async function operatorPc(browser: Browser): Promise<{ page: Page; asks: () => Promise<number> }> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const w = window as unknown as { __midiAsks: number };
    w.__midiAsks = 0;
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: async () => {
        w.__midiAsks++;
        return { inputs: new Map(), outputs: new Map(), onstatechange: null, sysexEnabled: false };
      },
    });
  });
  const page = await ctx.newPage();
  return { page, asks: () => page.evaluate(() => (window as unknown as { __midiAsks: number }).__midiAsks) };
}

test('MIDI stays on after the upgrade for a venue with MIDI mappings, and off for one without', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const hub = HubProcess.fresh(PORT);
  await hub.start();
  try {
    const fresh = await surfaces(await hubApi(PORT));
    // A fresh hub: MIDI off by default, with the default mappings.
    expect(fresh.midiEnabled).toBe(false);
    expect(fresh.midi.length).toBeGreaterThan(0);
    const { midiEnabled: _drop, ...older } = fresh;

    // An older build's row with mappings: MIDI reads as on, in the settings and on Setup, and starts.
    await restartWithStoredSurfaces(hub, older);
    expect((await surfaces(await hubApi(PORT))).midiEnabled).toBe(true);
    const pc = await operatorPc(browser);
    await login(pc.page, OP);
    let card = await midiCard(pc.page);
    await expect(card.getByRole('button', { name: 'Disable MIDI' })).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('Enabled');
    expect(await pc.asks()).toBeGreaterThan(0);
    await pc.page.context().close();

    // An older build's row without mappings: MIDI stays off, and the browser is never asked.
    await restartWithStoredSurfaces(hub, { ...older, midi: [] });
    const off = await surfaces(await hubApi(PORT));
    expect(off.midiEnabled).toBe(false);
    expect(off.midi).toEqual([]);
    const pc2 = await operatorPc(browser);
    await login(pc2.page, OP);
    card = await midiCard(pc2.page);
    await expect(card).toContainText('Disabled (Default)');
    await expect(card.getByRole('button', { name: 'Enable Web MIDI' })).toBeVisible();
    expect(await pc2.asks()).toBe(0);
    await pc2.page.context().close();
  } finally {
    hub.kill();
  }
});
