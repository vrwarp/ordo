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
  Media,
  parseLyrics,
  Presentation,
  songFromParsed,
} from '@ordo/domain';
import { APP_VERSION } from '@ordo/protocol';

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
// Media playing in place (design/27 §8): a video, a picture and a sound, and slides that use them.
const file = (hash: string, mime: string) => ({ hash, bytes: 1, mime, path: hash });
const media = [
  Media.parse({
    id: 'm-clip',
    name: 'Welcome clip',
    kind: 'video',
    original: file('clip-o', 'video/mp4'),
    delivery: file('clip-d', 'video/mp4'),
    poster: file('clip-p', 'image/jpeg'),
    state: 'ready',
    width: 1280,
    height: 720,
    durationMs: 5000,
  }),
  Media.parse({
    id: 'm-photo',
    name: 'Sunrise photo',
    kind: 'image',
    original: file('photo', 'image/jpeg'),
    state: 'ready',
  }),
  Media.parse({
    id: 'm-song',
    name: 'Walk-in music',
    kind: 'audio',
    original: file('song', 'audio/mp4'),
    state: 'ready',
  }),
];
const news = Presentation.parse({
  id: 'news',
  title: 'Announcements',
  kind: 'slides',
  sections: [
    {
      id: 'news-s',
      label: 'News',
      short: 'N',
      slides: [
        {
          id: 'news-1',
          objects: [
            {
              id: 'news-v',
              type: 'image',
              box: { x: 320, y: 180, w: 1280, h: 720, rotation: 0 },
              mediaId: 'm-clip',
              play: { mediaId: 'm-clip', start: 'auto', loop: false, onEnd: 'hold' },
            },
          ],
          audio: { mediaId: 'm-song', slides: 2 },
        },
        { id: 'news-2', objects: [] },
      ],
    },
  ],
  arrangements: [{ id: 'news-a', name: 'Default', sectionIds: ['news-s'] }],
});
const playlist = {
  id: 'pl1',
  rev: 1,
  name: 'Sunday',
  items: [
    { id: 'it1', kind: 'presentation', presentationId: song.id },
    { id: 'it2', kind: 'timer', timer: { kind: 'countdownTo', timeOfDay: '10:00' } },
    { id: 'it3', kind: 'presentation', presentationId: news.id },
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
  presentations: [song, news],
  playlists: [playlist],
  media,
  fonts: [],
  themes: [DEFAULT_THEME],
  folders: [],
  settings,
};

function apiResponse(path: string, method: string): unknown {
  if (path === '/auth/me') return { role: 'operate', setupRequired: false, version: APP_VERSION, domain: '' };
  if (path === '/library/snapshot') return snapshot;
  if (path === `/presentations/${song.id}`) return song;
  if (path === `/presentations/${news.id}`) return news;
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
  // Media playing in place (design/27 §11 item 14): add a video to a slide and set its options, give the
  // slide a sound; picture pickers list images only.
  const props = page.locator('.props');
  await page.getByRole('button', { name: '+ Video' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByText('Welcome clip').waitFor();
  if (await dialog.getByText('Sunrise photo').count()) errors.push('the video picker lists a picture');
  await dialog.getByText('Welcome clip').click();
  await props.getByRole('heading', { name: 'Video' }).waitFor();
  await props.getByLabel('Start').selectOption('click');
  await props.getByText('Play (F8) starts it').waitFor();
  await props.getByLabel('Hide while not playing').check();
  await props.getByRole('option', { name: 'Rewind and hide the video' }).waitFor({ state: 'attached' });
  await props.getByRole('button', { name: 'Replace', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByText('Sunrise photo').waitFor();
  if (await dialog.getByText('Welcome clip').count()) errors.push('the poster picker lists a video');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Slide', exact: true }).click();
  const sound = props.getByRole('region', { name: 'Sound' });
  await sound.getByRole('button', { name: 'Choose' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByText('Walk-in music').click();
  await sound.getByLabel('Plays across (slides)').fill('3');
  await sound.getByLabel('Plays across (slides)').press('Enter');
  await sound.getByLabel('Loop').check();
  await page.screenshot({ path: fileURLToPath(new URL('./editor-media.png', import.meta.url)) });
  // Undo takes back the last edit only.
  await page.getByTitle('Ctrl+Z').click();
  if (await sound.getByLabel('Loop').isChecked()) errors.push('undo did not take back the sound loop');
  await page.evaluate(() => {
    location.hash = '#/live';
  });
  await page.waitForSelector('.topbar');
  // The slide grid tags the announcement slide that plays a video and a sound.
  await page.locator('.pl-item', { hasText: 'Announcements' }).click();
  await page.locator('.thumb .tag', { hasText: 'audio' }).waitFor();
  // Thumbnails use content-visibility: read the DOM text, not the rendered text.
  const tags = await page.locator('.thumb .cap .tag').allTextContents();
  if (tags.join(',') !== 'video,audio') errors.push(`slide tags: ${tags.join(',')}`);
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
