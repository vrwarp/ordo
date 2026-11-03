/**
 * Headless smoke test of the BUILT operator app against a mocked API (not part of the vitest suite).
 *   pnpm --filter @ordo/operator build && apps/operator/node_modules/.bin/tsx apps/operator/test-smoke/smoke.ts
 * Serves dist/ on a local port, mocks /api/v1/* with page.route, visits every route and fails on any
 * page error or console error.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import {
  DEFAULT_AUDIO,
  DEFAULT_GENERAL,
  DEFAULT_KEYMAP,
  DEFAULT_LOOKS,
  DEFAULT_SURFACES,
  DEFAULT_THEME,
  parseLyrics,
  songFromParsed,
} from '@ordo/domain';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
};

const song = songFromParsed(
  parseLyrics(
    'Amazing Grace\nVerse 1\nAmazing grace\nhow sweet the sound\n\nChorus\nMy chains are gone\nI have been set free',
  ),
  {
    linesPerSlide: 2,
  },
);
const playlist = {
  id: 'pl1',
  rev: 1,
  name: 'Sunday',
  items: [
    { id: 'it1', kind: 'presentation', presentationId: song.id },
    { id: 'it2', kind: 'timer', timer: { kind: 'countdownTo', timeOfDay: '10:00' } },
  ],
};
const settings = {
  general: DEFAULT_GENERAL,
  looks: DEFAULT_LOOKS,
  outputs: [
    {
      id: 'o1',
      name: 'Audience 1',
      kind: 'output',
      hostIndex: 1,
      lookId: 'look-main',
      enabled: true,
      audioMaster: true,
      token: 't1',
    },
    {
      id: 's1',
      name: 'Stage',
      kind: 'stage',
      hostIndex: 0,
      lookId: 'look-stage',
      enabled: true,
      audioMaster: false,
      token: 't2',
    },
  ],
  audio: DEFAULT_AUDIO,
  keymap: DEFAULT_KEYMAP,
  surfaces: DEFAULT_SURFACES,
};
const snapshot = {
  seq: 1,
  presentations: [song],
  playlists: [playlist],
  media: [],
  fonts: [],
  themes: [DEFAULT_THEME],
  folders: [],
  settings,
};

function apiResponse(path: string, method: string): unknown {
  if (path === '/auth/me') return { role: 'operate', setupRequired: false, version: '0.1.0', domain: '' };
  if (path === '/library/snapshot') return snapshot;
  if (path === `/presentations/${song.id}`) return song;
  if (path.endsWith('/revisions')) return [{ rev: 1, savedAt: new Date().toISOString(), title: song.title }];
  if (path === '/settings') return settings;
  if (path === '/backup/list') return { files: ['ordo-2026-11-01.db'] };
  if (path === '/jobs') return [];
  if (path.startsWith('/fonts/google/search')) return [{ family: 'Lato', category: 'sans-serif' }];
  if (method === 'PUT' && path.startsWith('/settings/')) return null;
  return [];
}

async function main() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '');
    if (!p) p = 'index.html';
    try {
      const body = await readFile(join(dist, p));
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Expected without a hub: the WebSocket and missing files.
    if (/WebSocket|ERR_CONNECTION_REFUSED|404|Failed to load resource/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  await page.route('**/api/v1/**', async (route) => {
    const u = new URL(route.request().url());
    const path = u.pathname.replace('/api/v1', '') + (u.search || '');
    const body = apiResponse(path.split('?')[0]!, route.request().method());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const routes = [
    '#/live',
    '#/playlists/pl1',
    '#/library',
    '#/library/media',
    '#/library/fonts',
    '#/library/import',
    `#/edit/${song.id}`,
    ...[
      'outputs',
      'looks',
      'audio',
      'keys',
      'streamdeck',
      'midi',
      'messages',
      'general',
      'themes',
      'pins',
      'backups',
      'diagnostics',
    ].map((s) => `#/settings/${s}`),
    '#/checklist',
  ];
  await page.goto(`${base}#/live`);
  await page.waitForSelector('.topbar', { timeout: 10000 });
  for (const r of routes) {
    await page.evaluate((h) => {
      location.hash = h;
    }, r);
    await page.waitForTimeout(400);
    const text = await page.evaluate(() => document.body.innerText.length);
    if (text < 20) errors.push(`${r}: page looks empty`);
    console.log(`ok ${r}`);
  }
  // Interactions: select a slide in the editor canvas, open the new-song dialog, record clear-all double press.
  await page.evaluate(() => {
    location.hash = '#/library';
  });
  await page.getByText('New song').click();
  await page.locator('textarea').first().fill('Verse 1\nline one\nline two\n\nChorus\nchorus line');
  await page.waitForSelector('text=Arrangement:');
  await page.keyboard.press('Escape');
  await page.evaluate((id) => {
    location.hash = `#/edit/${id}`;
  }, song.id);
  await page.waitForSelector('canvas');
  const canvas = page.locator('.canvasbox canvas').last();
  const box = await canvas.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: fileURLToPath(new URL('./editor.png', import.meta.url)) });
  await page.evaluate(() => {
    location.hash = '#/live';
  });
  await page.waitForSelector('.topbar');
  await page.screenshot({ path: fileURLToPath(new URL('./live.png', import.meta.url)) });
  await browser.close();
  server.close();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('smoke ok');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
