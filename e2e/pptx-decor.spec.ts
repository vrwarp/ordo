import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { decodePng } from './png.ts';
import { openEditor, opOrigin, type PresentationRec, slidesOf } from './editorhelpers.ts';
import { hubApi, login } from './linkhelpers.ts';
import { CROWDED, crowdedCentre, crowdedColor, crowdedDeck } from './pptxdecks.ts';
import { portOf } from './ports.ts';
import {
  apiJson,
  at,
  cacheReady,
  capture,
  importPptx,
  liveEvent,
  type OutputRec,
  pptxHub,
  type RGB,
  roleWindow,
  settledOn,
  telemetryOf,
} from './pptxlive.ts';

/**
 * Decorations, end to end (design/27 §15 M9 decorations, decor-render): a slide of 230 text-less squares of as
 * many colours under a title (`pptxdecks.ts` `crowdedDeck`), past the slide budgets' 190 objects and the render
 * clamp's 200, so an import keeps every square only by drawing runs of them as decorations, in decoration
 * files named by their SHA-256 on the hub and in the browser alike. Until decorations were drawn and their files
 * named, the guard left the topmost squares out and listed them missing (`missing:decoration`, class hybrid).
 * On both kinds of hub:
 * - **without LibreOffice** (`ORDO_LIBREOFFICE=off`, port 0 of the 'pptx-decor' row): the deck dropped on the
 *   Import tab in 'Editable' mode is parsed in the operator and the hub builds version 1 from its scene;
 * - **with LibreOffice** (port 1 of the row): the deck through the upload route, parsed by the
 *   hub itself, read once its follow-up jobs (version 2, for the slides that wait for LibreOffice) are done;
 * the stored slide is native with nothing missing and its decoration files are in the store; taken live, the
 * Audience window shows the five topmost squares in their colours (`pptxlive.ts` `capture`, `at`); and the
 * editor canvas shows the topmost one.
 */
const PORT = portOf('pptx-decor', 0);
const LO_PORT = portOf('pptx-decor', 1);
const OUT = 'test-results/pptx-decor';
/** The five topmost squares (the last in z-order), under the title. */
const TOP = Array.from({ length: 5 }, (_, k) => CROWDED.count - 1 - k);
/** Channel difference allowed between a square's colour and what is drawn at its centre. */
const TOL = 12;

type Job = { id: string; kind: string; state: string; log: string[]; result?: { presentationId: string } };
type Shape = { id: string; type: string; decor?: { ref?: string; parts?: unknown[] } };

const close = (got: RGB, want: [number, number, number]) =>
  got.every((v, k) => Math.abs(v - want[k]!) <= TOL);

/** Every job of the hub done (the import and its follow-ups: version 2 where a slide waits for LibreOffice). */
async function settled(a: APIRequestContext): Promise<Job[]> {
  let jobs: Job[] = [];
  await expect
    .poll(
      async () => {
        const r = (await (await a.get('jobs')).json()) as Job[] | { jobs: Job[] };
        jobs = Array.isArray(r) ? r : r.jobs;
        return jobs.length > 0 && jobs.every((j) => j.state === 'done' || j.state === 'failed');
      },
      { timeout: 180_000 },
    )
    .toBe(true);
  return jobs;
}

/** The stored crowded slide: native, nothing missing, its decorations in files the store has. */
async function storedWhole(a: APIRequestContext, id: string, log: string): Promise<void> {
  const p = await apiJson<PresentationRec>(a, `presentations/${id}`);
  const [slide] = slidesOf(p);
  const pptx = (slide as unknown as { pptx?: { class?: string; missing?: string[]; pending?: boolean } })
    .pptx;
  expect(pptx?.class, log).toBe('native');
  expect(pptx?.missing ?? [], 'the import report lists nothing missing').toEqual([]);
  expect(pptx?.pending).toBeUndefined();
  expect(log).not.toMatch(/left out/);
  const decors = (slide!.objects as Shape[]).filter((o) => o.type === 'shape' && o.decor);
  expect(decors.length, 'the squares are drawn as decorations').toBeGreaterThan(0);
  const refs = decors.flatMap((o) => (o.decor?.ref ? [o.decor.ref] : []));
  expect(refs.length, 'large decorations are decoration files').toBeGreaterThan(0);
  for (const ref of refs) {
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    const f = await a.get(`files/${ref}`);
    expect(f.status(), `decoration file ${ref.slice(0, 8)}`).toBe(200);
    expect(((await f.json()) as { parts: unknown[] }).parts.length).toBeGreaterThan(0);
  }
  expect(JSON.stringify(p)).not.toContain('pptxdecor:');
}

/** The presentation live on Audience 1 (1920 x 1080, Canvas 2D): its five topmost squares in their colours. */
async function audienceShowsTop(
  a: APIRequestContext,
  context: BrowserContext,
  port: number,
  presentationId: string,
  name: string,
): Promise<void> {
  const pl = await apiJson<{ id: string }>(a, 'playlists', {
    post: { name: 'Crowded', items: [{ id: 'deck', kind: 'presentation', presentationId }] },
  });
  await liveEvent(a, { k: 'goLive', playlistId: pl.id });
  const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
  const audience = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
  const w = await roleWindow(context, port, audience, { width: 1920, height: 1080 }, 'renderer=2d');
  try {
    await cacheReady(w);
    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
    await settledOn(w, 0);
    // The decoration files are read by the asset worker's prepare step before the slide is drawn; a file
    // not cached yet draws the slide again once it is: poll the capture.
    await expect
      .poll(
        async () => {
          const shot = await capture(w, join(OUT, `${name}-audience.png`));
          return TOP.map((i) => close(at(shot, crowdedCentre(i)), crowdedColor(i)));
        },
        { timeout: 30_000 },
      )
      .toEqual(TOP.map(() => true));
    expect((await telemetryOf(w)).error ?? '').toBe('');
  } finally {
    await w.close();
  }
}

/** The screen colour at a slide point (1920 x 1080) of the editor's canvas, from a 1 x 1 screenshot. */
async function canvasRgb(page: Page, [x, y]: [number, number]): Promise<RGB> {
  const b = (await page.locator('.canvasbox .konvajs-content').first().boundingBox())!;
  const clip = { x: Math.round(b.x + (x / 1920) * b.width), y: Math.round(b.y + (y / 1080) * b.height) };
  const d = decodePng(await page.screenshot({ clip: { ...clip, width: 1, height: 1 } })).data;
  return [d[0]!, d[1]!, d[2]!];
}

/** The editor's canvas shows the topmost square (its decoration file read by the canvas). */
async function editorShowsTop(page: Page, port: number, id: string): Promise<void> {
  await openEditor(page, port, id);
  const top = CROWDED.count - 1;
  await expect
    .poll(() => canvasRgb(page, crowdedCentre(top)).then((c) => close(c, crowdedColor(top))), {
      timeout: 20_000,
    })
    .toBe(true);
}

test('a crowded slide imported in the browser for a hub without LibreOffice draws every square', async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  rmSync(join(OUT, 'client'), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = crowdedDeck(join(OUT, 'client'));
  const before = process.env.ORDO_LIBREOFFICE;
  process.env.ORDO_LIBREOFFICE = 'off';
  let hub: Awaited<ReturnType<typeof pptxHub>>;
  try {
    hub = await pptxHub(PORT);
  } finally {
    if (before === undefined) delete process.env.ORDO_LIBREOFFICE;
    else process.env.ORDO_LIBREOFFICE = before;
  }
  try {
    const a = await hubApi(PORT);
    await login(page, opOrigin(PORT));
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    // The tab parses for the hub's kind once it has heard the hub's capabilities (`hubHasLibreOffice`: unknown
    // counts as with LibreOffice, and this hub would refuse that scene): wait for the text it shows a hub
    // without LibreOffice before dropping the deck.
    await expect(page.getByText(/anything it cannot draw is listed on the import card/)).toBeVisible({
      timeout: 30_000,
    });
    await page.locator('input[name="pptx-import-mode"][value="native"]').check();
    await page.locator('input[type=file][accept*=".pptx"]').setInputFiles(deck);
    const card = page.locator('[data-pptx-import]').first();
    await expect(card.getByText(/^done$/)).toBeVisible({ timeout: 120_000 });
    const jobs = await settled(a);
    const native = jobs.find((j) => j.kind === 'pptx-native')!;
    const full = await apiJson<Job>(a, `jobs/${native.id}`);
    const log = full.log.join('\n');
    // Version 1 built from the browser's scene: its decoration files named there, checked by the hub.
    expect(log).toMatch(/parsed in the browser: the hub checked its scene/);
    const id = full.result!.presentationId;
    await storedWhole(a, id, log);
    await audienceShowsTop(a, context, PORT, id, 'client');
    await editorShowsTop(page, PORT, id);
  } finally {
    hub!.kill();
  }
});

test('a crowded slide uploaded to a hub with LibreOffice draws every square after version 2', async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  rmSync(join(OUT, 'hub'), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = crowdedDeck(join(OUT, 'hub'));
  const hub = await pptxHub(LO_PORT);
  try {
    const a = await hubApi(LO_PORT);
    // The upload route, parsed by the hub itself (no client scene), then its follow-ups.
    const job = await importPptx(a, deck);
    await settled(a);
    const full = await apiJson<Job>(a, `jobs/${job.id}`);
    const log = full.log.join('\n');
    expect(log).not.toMatch(/parsed in the browser/);
    const id = job.result!.presentationId;
    await storedWhole(a, id, log);
    await audienceShowsTop(a, context, LO_PORT, id, 'hub');
    await editorShowsTop(page, LO_PORT, id);
  } finally {
    hub.kill();
  }
});
