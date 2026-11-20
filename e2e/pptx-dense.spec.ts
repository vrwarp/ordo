import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { comparable, diffJson } from '../tools/pptx-fidelity/src/equivalence.ts';
import { opOrigin, type PresentationRec, slidesOf } from './editorhelpers.ts';
import { hubApi, login } from './linkhelpers.ts';
import type { Pixels } from './png.ts';
import { denseDeck, denseFirstBox } from './pptxdecks.ts';
import {
  apiJson,
  cacheReady,
  capture,
  importPptx,
  liveEvent,
  type OutputRec,
  pptxHub,
  roleWindow,
  settledOn,
  telemetryOf,
} from './pptxlive.ts';
import { portOf } from './ports.ts';

/**
 * Dense decks, end to end (design/29 X1 and B3-B6, W9, W10 and W17): the decks of traced artwork that the converter used to refuse
 * whole import, each as much of itself as ordo can read, and what it leaves out is said. Two hubs without LibreOffice (the
 * converter's own drawing), the rows 'pptx-dense' of `ports.ts`:
 * - 0, the upload route: a slide of 150 traced discs (12 MB of path XML, past the old 8 MB part cap) imports with its objects
 *   and draws on an Audience screen (the first disc, black, covers pi/4 of its box within 0.05); a deck of 20 slides of 4 MB (80 MB
 *   of XML, past the old total of 64 MiB) imports whole; a slide part of 34 MiB (past the part cap of 32 MiB) is left out
 *   with W9 and `slide:detail`; 52,000 shapes of six elements (past the shape cap of 50,000) are cut with W10 and
 *   `element:shapes`; a deck that declares 300 MiB of XML is refused with W17 from its directory;
 * - 1, the Import tab: the 12 MB deck is parsed in the browser and what the hub stores equals what it stores when it parses the
 *   same deck itself (modulo ids and times); the 80 MB deck is declined by the browser (its 64 MiB) and parsed by the hub.
 * The decks are written at run time (`pptxdecks.ts` `denseDeck`), never committed.
 */
const PORT = portOf('pptx-dense');
const PORT_TAB = portOf('pptx-dense', 1);
const OUT = 'test-results/pptx-dense';
const OUT_TAB = 'test-results/pptx-dense-tab';

// Both tests may run for minutes (an 80 MB deck) on a machine other jobs keep busy, at niceness 19. The timeout is set for the whole
// file, not inside the test bodies: a timeout set in a body does not cover the fixtures (the browser context), which start under the
// config's 120 s ('Test timeout of 120000ms exceeded while setting up "context"', seen under a load of 11 on 4 cores).
test.describe.configure({ timeout: 900_000 });

type Job = {
  id: string;
  kind?: string;
  state: string;
  log: string[];
  error?: string;
  result?: { presentationId: string };
};
type Pres = {
  id: string;
  sections: { slides: { id: string; objects: unknown[]; pptx?: { class: string; missing?: string[] } }[] }[];
};
const slidesIn = (p: Pres) => p.sections.flatMap((s) => s.slides);

/** W9 (a slide), W10 and W17 as the owner reads them (design/29 section 3). */
const W9 =
  'Slide 1 has too much drawing detail for ordo to read, so only its text was imported. In PowerPoint, save the artwork as a picture and import again.';
const W10 = 'Slide 1 has more shapes than ordo keeps on one slide, so the topmost shapes were left out.';
const W17 =
  'ordo could not read this file: it holds more slide data than ordo reads (256 MB at most). Nothing was imported. In PowerPoint, save very detailed artwork as pictures and import again.';

/** Upload a deck and wait for the job, done or failed (`importPptx` expects done). */
async function importAny(a: APIRequestContext, file: string): Promise<Job> {
  const res = await a.post('import/document', {
    multipart: {
      file: {
        name: basename(file),
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        buffer: readFileSync(file),
      },
    },
  });
  expect(res.status(), await res.text()).toBe(202);
  const queued = (await res.json()) as { id: string };
  let job: Job | undefined;
  await expect
    .poll(
      async () => {
        job = (await (await a.get(`jobs/${queued.id}`)).json()) as Job;
        return job.state;
      },
      { timeout: 240_000, intervals: [500, 1000, 2000] },
    )
    .toMatch(/^(done|failed)$/);
  return job!;
}

/**
 * The share of pixels in a logical box (1920 x 1080) darker than `dark` in every channel. The whole box, no inset: a disc touches
 * its box at four points only, so the share of a black disc is pi/4.
 */
function blackShare(img: Pixels, box: { x: number; y: number; w: number; h: number }, dark = 48): number {
  const sx = img.width / 1920;
  const sy = img.height / 1080;
  const x0 = Math.ceil(box.x * sx);
  const y0 = Math.ceil(box.y * sy);
  const x1 = Math.floor((box.x + box.w) * sx);
  const y1 = Math.floor((box.y + box.h) * sy);
  let n = 0;
  let black = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      n++;
      if (img.data[o]! < dark && img.data[o + 1]! < dark && img.data[o + 2]! < dark) black++;
    }
  return n ? black / n : 0;
}

/** A hub without LibreOffice: the slide is the converter's drawing, as on the lite image. */
async function hubWithoutLibreOffice(port: number) {
  const before = process.env.ORDO_LIBREOFFICE;
  process.env.ORDO_LIBREOFFICE = 'off';
  try {
    return await pptxHub(port);
  } finally {
    if (before === undefined) delete process.env.ORDO_LIBREOFFICE;
    else process.env.ORDO_LIBREOFFICE = before;
  }
}

test('dense decks import through the upload route, each as much of itself as ordo can read, and the rest is said', async ({
  context,
}) => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const decks = join(OUT, 'decks');
  const hub = await hubWithoutLibreOffice(PORT);
  try {
    const a = await hubApi(PORT);
    const presentation = async (job: Job) => apiJson<Pres>(a, `presentations/${job.result!.presentationId}`);

    // 12 MB of traced artwork on one slide: imported with its objects (the base refused its part).
    const traced = await importAny(a, denseDeck(decks, 'traced'));
    expect(traced.state, traced.log.join('\n')).toBe('done');
    const tracedPres = await presentation(traced);
    const tracedSlides = slidesIn(tracedPres);
    expect(tracedSlides).toHaveLength(1);
    console.log(
      `traced slide: ${tracedSlides[0]!.objects.length} objects, class ${tracedSlides[0]!.pptx?.class}`,
    );
    expect(tracedSlides[0]!.objects.length).toBeGreaterThanOrEqual(100);
    expect(['native', 'hybrid']).toContain(tracedSlides[0]!.pptx?.class);
    expect(traced.log.join('\n')).not.toContain('too much drawing detail');

    // 20 slides of about 4 MB each: 80 MB of XML, past the base's 64 MiB, imported whole.
    const eighty = await importAny(a, denseDeck(decks, 'eighty'));
    expect(eighty.state, eighty.log.join('\n')).toBe('done');
    expect(slidesIn(await presentation(eighty))).toHaveLength(20);

    // A slide part of 34 MiB: W9 once, the slide kept as its text (here none) and listed as `slide:detail`.
    const part34 = await importAny(a, denseDeck(decks, 'part34'));
    expect(part34.state, part34.log.join('\n')).toBe('done');
    expect(part34.log.filter((l) => l.includes(W9))).toHaveLength(1);
    const part34Slides = slidesIn(await presentation(part34));
    expect(part34Slides).toHaveLength(1);
    expect(part34Slides[0]!.pptx?.missing).toContain('slide:detail');

    // 52,000 shapes of six elements: past the shape cap of 50,000: W10 once, `element:shapes`.
    const lean = await importAny(a, denseDeck(decks, 'lean52k'));
    expect(lean.state, lean.log.join('\n')).toBe('done');
    expect(lean.log.filter((l) => l.includes(W10))).toHaveLength(1);
    const leanSlides = slidesIn(await presentation(lean));
    expect(leanSlides[0]!.pptx?.missing).toContain('element:shapes');

    // A deck that declares 300 MiB of XML (ten entries of 30 MiB, garbage bytes): refused from its directory, W17.
    const declared = await importAny(a, denseDeck(decks, 'declared'));
    expect(declared.state).toBe('failed');
    expect(declared.error ?? '').toBe(W17);
    expect(declared.log.join('\n')).toContain(W17);
    expect(declared.log.join('\n')).not.toMatch(/inflate|invalid|zip entries/i);

    // The traced slide on an Audience screen: the first disc is black and covers pi/4 of its box.
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: { name: 'Dense', items: [{ id: 'deck', kind: 'presentation', presentationId: tracedPres.id }] },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const hd = await roleWindow(
      context,
      PORT,
      outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!,
      { width: 1920, height: 1080 },
      'renderer=2d',
    );
    await cacheReady(hd);
    await expect.poll(async () => (await telemetryOf(hd)).compositor).toBe('2d');
    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
    await settledOn(hd, 0);
    const box = denseFirstBox(150);
    let share = 0;
    await expect
      .poll(
        async () => {
          share = blackShare(await capture(hd, join(OUT, 'cue0-1080p.png')), box);
          return Math.abs(share - Math.PI / 4) <= 0.05;
        },
        { timeout: 30_000, intervals: [300, 700, 1500] },
      )
      .toBe(true)
      .catch(() => undefined);
    console.log(`traced disc: black share ${share.toFixed(3)} (pi/4 ${(Math.PI / 4).toFixed(3)})`);
    expect(Math.abs(share - Math.PI / 4), 'the first disc covers pi/4 of its box').toBeLessThanOrEqual(0.05);
    expect((await telemetryOf(hd)).error ?? '').toBe('');
  } finally {
    hub.kill();
  }
});

test('a dense deck on the Import tab: the browser parses 12 MB and declines 80 MB, and the hub stores what it would have', async ({
  page,
}) => {
  rmSync(OUT_TAB, { recursive: true, force: true });
  mkdirSync(OUT_TAB, { recursive: true });
  const traced = denseDeck(join(OUT_TAB, 'decks'), 'traced');
  const eighty = denseDeck(join(OUT_TAB, 'decks'), 'eighty');
  const hub = await hubWithoutLibreOffice(PORT_TAB);
  try {
    const a = await hubApi(PORT_TAB);
    await login(page, opOrigin(PORT_TAB));
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    await page.locator('input[name="pptx-import-mode"][value="native"]').check();

    const jobsNow = async () => {
      const jobs = (await (await a.get('jobs')).json()) as Job[] | { jobs: Job[] };
      return (Array.isArray(jobs) ? jobs : jobs.jobs).filter((j) => j.kind === 'pptx-native');
    };

    // The 12 MB deck: parsed in the browser, the hub checked its scene.
    await page.locator('input[type=file][accept*=".pptx"]').setInputFiles(traced);
    const card = page.locator('[data-pptx-import]', { hasText: 'Dense traced' }).first();
    await expect(card.getByText(/^done$/)).toBeVisible({ timeout: 300_000 });
    const first = (await jobsNow())[0]!;
    const full = await apiJson<Job>(a, `jobs/${first.id}`);
    expect(full.log.join('\n')).toMatch(/parsed in the browser: the hub checked its scene/);
    const fromBrowser = await apiJson<PresentationRec>(a, `presentations/${full.result!.presentationId}`);

    // The same deck parsed by the hub itself (posted without a scene): the same presentation.
    const hubJob = await importPptx(a, traced);
    const fromHub = await apiJson<PresentationRec>(a, `presentations/${hubJob.result!.presentationId}`);
    const media = (await apiJson<{ id: string; original: { hash: string } }[]>(a, 'media')).map(
      (m) => [m.id, m.original.hash] as const,
    );
    const fileOf = new Map(media);
    expect(slidesOf(fromBrowser)).toHaveLength(1);
    expect(slidesOf(fromBrowser)[0]!.objects.length).toBeGreaterThanOrEqual(100);
    const same = (p: PresentationRec) => comparable({ ...p, title: '' }, (id) => fileOf.get(id));
    expect(diffJson(same(fromHub), same(fromBrowser))).toEqual([]);

    // The 80 MB deck: past the browser's 64 MiB of slide XML, so the browser declines it and the hub parses it.
    const seen = new Set((await jobsNow()).map((j) => j.id));
    await page.locator('input[type=file][accept*=".pptx"]').setInputFiles(eighty);
    const card80 = page.locator('[data-pptx-import]', { hasText: 'Dense eighty' }).first();
    await expect(card80.getByText(/^done$/)).toBeVisible({ timeout: 600_000 });
    const second = (await jobsNow()).find((j) => !seen.has(j.id) && j.id !== hubJob.id)!;
    const full80 = await apiJson<Job>(a, `jobs/${second.id}`);
    expect(full80.log.join('\n')).not.toMatch(/parsed in the browser/);
    expect(
      slidesOf(await apiJson<PresentationRec>(a, `presentations/${full80.result!.presentationId}`)),
    ).toHaveLength(20);

    // Settings > Diagnostics: one deck parsed here, one left to the hub (the browser could not read it).
    await page.evaluate(() => {
      location.hash = '#/settings/diagnostics';
    });
    await expect(page.locator('[data-import-parsed]')).toHaveText('1');
    await expect(page.locator('[data-import-hub]')).toHaveText('1');
    await expect(page.locator('[data-import-reason="failed"]')).toBeVisible();
  } finally {
    hub.kill();
  }
});
