import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import pptxgen from 'pptxgenjs';
import { opOrigin, type PresentationRec, slidesOf } from './editorhelpers.ts';
import { hubApi, login } from './linkhelpers.ts';
import { comparable, diffJson } from '../tools/pptx-fidelity/src/equivalence.ts';
import { ffmpeg } from './pptxdecks.ts';
import { apiJson, importPptx, pptxHub } from './pptxlive.ts';
import { portOf } from './ports.ts';

/**
 * The Import tab's PowerPoint import as a volunteer runs it (design/27 §2 "Where the deck is parsed",
 * design/15 "Import"): a multi-slide deck with a table, a picture and a clip dropped on the PowerPoint drop
 * zone in 'Editable' mode is parsed in the operator's import worker and uploaded with its scene; the hub checks
 * the scene and builds version 1 from it. Checked:
 * - the hub built from the browser's scene (its job log), and Settings › Diagnostics counts the parse;
 * - what it stored equals what the hub stores when it parses the same deck itself (posted without a scene),
 *   modulo ids, media ids (compared by file) and times;
 * - the deck opens canvas-first with the stage pill 'Imported PowerPoint slide', and the slide's PowerPoint
 *   panel opens through it (Tune);
 * - with a playlist live the browser does not parse: the hub refuses the import as it always did, and the
 *   Diagnostics page counts the deck as left to the hub.
 * Own hub with the bundled fonts on its own port (e2e/ports.ts row 'pptx-import-tab'), so the table is measured with them.
 */
const PORT = portOf('pptx-import-tab');
const OUT = 'test-results/pptx-import-tab';

/** A deck with a title, a table, a picture and a clip (pptxgenjs; media made by ffmpeg). */
async function importTabDeck(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const photo = join(dir, 'photo.png');
  const clip = join(dir, 'clip.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', photo]);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=10',
    '-t',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    clip,
  ]);
  const b64 = (f: string, mime: string) => `${mime};base64,${readFileSync(f).toString('base64')}`;
  const p = new pptxgen();
  p.layout = 'LAYOUT_WIDE';
  const s1 = p.addSlide();
  s1.addText('Sunday announcements', { x: 0.8, y: 2.5, w: 11.7, h: 2, fontFace: 'Calibri', fontSize: 54 });
  const s2 = p.addSlide();
  s2.addTable(
    [
      [{ text: 'Event' }, { text: 'When' }],
      [{ text: 'Potluck lunch in the hall after the service' }, { text: 'Sunday 12:30' }],
      [{ text: 'Youth group' }, { text: 'Friday 19:00' }],
    ],
    {
      x: 1,
      y: 1.5,
      w: 11,
      colW: [7, 4],
      fontFace: 'Calibri',
      fontSize: 28,
      border: { pt: 1, color: '666666' },
    },
  );
  const s3 = p.addSlide();
  s3.addImage({ data: b64(photo, 'image/png'), x: 2.2, y: 0.8, w: 8.9, h: 5 });
  s3.addText('Our new hall', { x: 0.8, y: 6.1, w: 11.7, h: 1, fontFace: 'Calibri', fontSize: 36 });
  const s4 = p.addSlide();
  s4.addMedia({ type: 'video', data: b64(clip, 'video/mp4'), x: 1.7, y: 1.2, w: 9.9, h: 5.6 });
  const file = join(dir, 'Announcements.pptx');
  writeFileSync(file, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
  return file;
}

type Job = { id: string; kind: string; state: string; log: string[]; result?: { presentationId: string } };

test('a deck dropped on the Import tab is parsed in the browser and stored as the hub stores it', async ({
  page,
}) => {
  test.setTimeout(300_000);
  rmSync(OUT, { recursive: true, force: true });
  const deck = await importTabDeck(join(OUT, 'deck'));
  const hub = await pptxHub(PORT);
  try {
    const a = await hubApi(PORT);
    await login(page, opOrigin(PORT));
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    await page.locator('input[name="pptx-import-mode"][value="native"]').check();
    await page.locator('input[type=file][accept*=".pptx"]').setInputFiles(deck);
    const card = page.locator('[data-pptx-import]').first();
    await expect(card.getByText(/^done$/)).toBeVisible({ timeout: 120_000 });

    // The hub built version 1 from the browser's scene, and the browser counted its parse.
    const jobs = (await (await a.get('jobs')).json()) as Job[] | { jobs: Job[] };
    const job = (Array.isArray(jobs) ? jobs : jobs.jobs).find((j) => j.kind === 'pptx-native')!;
    const full = await apiJson<Job>(a, `jobs/${job.id}`);
    expect(full.log.join('\n')).toMatch(/parsed in the browser: the hub checked its scene/);
    const fromBrowser = await apiJson<PresentationRec>(a, `presentations/${full.result!.presentationId}`);

    // The same deck parsed by the hub itself (no scene): the same presentation.
    const hubJob = await importPptx(a, deck);
    const fromHub = await apiJson<PresentationRec>(a, `presentations/${hubJob.result!.presentationId}`);
    const media = (await apiJson<{ id: string; original: { hash: string } }[]>(a, 'media')).map(
      (m) => [m.id, m.original.hash] as const,
    );
    const fileOf = new Map(media);
    expect(slidesOf(fromBrowser).length).toBe(4);
    // Modulo ids, media ids (by their file), times and the import log: no difference at all.
    const same = (p: PresentationRec) => comparable({ ...p, title: '' }, (id) => fileOf.get(id));
    expect(diffJson(same(fromHub), same(fromBrowser))).toEqual([]);
    // The table, the picture and the clip are there as objects.
    const kinds = slidesOf(fromBrowser).map((s) => s.objects.map((o) => o.type).join(','));
    expect(kinds[1]).toMatch(/text/);
    expect(slidesOf(fromBrowser)[2]!.objects.some((o) => o.type === 'image')).toBe(true);
    expect(
      slidesOf(fromBrowser)[3]!.objects.some((o) => o.type === 'image' && (o as { play?: unknown }).play),
    ).toBe(true);

    // Canvas-first editor: the stage pill on the imported slide, its PowerPoint panel through it.
    await card.getByRole('button', { name: 'Open presentation' }).click();
    const pill = page.locator('[data-pptx-stage-pill]');
    await expect(pill).toContainText('Imported PowerPoint slide');
    await pill.getByRole('button', { name: /PowerPoint options/ }).click();
    await expect(page.locator('[data-pptx-card]')).toBeVisible();
    await expect(page.locator('[data-pptx-card] [data-class]')).toHaveAttribute('data-class', 'native');

    // Settings › Diagnostics counts the parse.
    await page.evaluate(() => {
      location.hash = '#/settings/diagnostics';
    });
    await expect(page.locator('[data-import-parsed]')).toHaveText('1');

    // With a playlist live the browser does not parse: the hub refuses the import, as it did before.
    const song = await (
      await a.post('import/songselect', { data: { text: 'Live song\n\nVerse 1\nLine one' } })
    ).json();
    const pl = await (
      await a.post('playlists', {
        data: { name: 'Live', items: [{ id: 'i1', kind: 'presentation', presentationId: song.id }] },
      })
    ).json();
    expect(
      (await a.post('live/events', { data: { id: 'gl', event: { k: 'goLive', playlistId: pl.id } } })).ok(),
    ).toBe(true);
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    // The nav's Live link with its dot: the operator knows the playlist is live.
    await expect(page.getByRole('link', { name: '● Live' })).toBeVisible({ timeout: 20_000 });
    await page.locator('input[type=file][accept*=".pptx"]').setInputFiles(deck);
    await expect(page.getByText(/Imports are disabled while a playlist is live/).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.evaluate(() => {
      location.hash = '#/settings/diagnostics';
    });
    await expect(page.locator('[data-import-reason="live"]')).toContainText('a playlist was live');
    await expect(page.locator('[data-import-parsed]')).toHaveText('1');
  } finally {
    hub.kill();
  }
});
