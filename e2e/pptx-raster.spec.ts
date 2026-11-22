import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { findChromium } from '../tools/find-chromium.ts';
import {
  editorState,
  openEditor,
  openSlide,
  type PresentationRec,
  slidesOf,
  stored,
} from './editorhelpers.ts';
import { HubProcess } from './hubproc.ts';
import { hubApi } from './linkhelpers.ts';
import { CONTINENTS, continentsDeck } from './pptxdecks.ts';
import {
  apiJson,
  at,
  cacheReady,
  capture,
  importPptx,
  liveEvent,
  type OutputRec,
  type RGB,
  roleWindow,
  settledOn,
  telemetryOf,
} from './pptxlive.ts';
import { portOf } from './ports.ts';

/**
 * Many-point shapes drawn into one picture (the owner's Q53, design/29 "As built in sub-wave 3 (shape-raster)"): a one-slide deck
 * of two outlines (5,000 and 300 points), 600 small squares between them and a text box over the first outline (`pptxdecks.ts`
 * `continentsDeck`) goes through the real upload route.
 * - **a hub with its own Chromium and no LibreOffice** (port 0 of the 'pptx-raster' row, `ORDO_PRERENDER=on`): the slide stores as
 *   ONE locked picture of the 602 shapes with its provenance and the words of the text box live above it; the import says so;
 *   Audience 1 draws the picture (the outlines' and a square's colours at their places); the Presentation panel's report and the
 *   slide card say what a picture of shapes is; 'Reset slide from PowerPoint' brings the shapes back as shapes (no picture step)
 *   and a whole 'Re-import from PowerPoint…' draws the picture again;
 * - **a hub with no Chromium and no LibreOffice** (port 1): the same deck stores as today (no picture of shapes) and the import
 *   says this computer cannot draw them.
 */
const PORT = portOf('pptx-raster', 0);
const NONE_PORT = portOf('pptx-raster', 1);
const OUT = 'test-results/pptx-raster';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
/** Channel difference allowed between a shape's colour and what the screen draws. */
const TOL = 14;

type Raster = {
  pictures: number;
  stored: number;
  putBack: number;
  candidates: number;
  shapes: number;
  off?: string;
};
type ObjRec = {
  id: string;
  type: string;
  mediaId?: string;
  text?: string;
  locked?: boolean;
  origin?: { role?: string; raster?: { n?: number; from?: string } };
};
type SlideOf = { id: string; objects: ObjRec[]; pptx?: { class?: string } };
const objectsOf = (p: Pick<PresentationRec, 'sections'>, n: number): ObjRec[] =>
  (slidesOf(p)[n] as unknown as SlideOf).objects;
const pictures = (objects: ObjRec[]) =>
  objects.filter((o) => o.type === 'image' && o.origin?.role === 'raster');
const close = (got: RGB, want: readonly [number, number, number]) =>
  got.every((v, k) => Math.abs(v - want[k]!) <= TOL);

let deck: string;
let exe: string | undefined;
test.beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  deck = continentsDeck(join(OUT, 'deck'));
  exe = await findChromium({ system: true });
});

/** A hub on `port` without LibreOffice, with pictures of heavy slides on and `chromium` as its browser. */
async function rasterHub(port: number, chromium: string): Promise<HubProcess> {
  const hub = HubProcess.fresh(port);
  hub.env.ORDO_FONTS_DIR = process.env.ORDO_FONTS_DIR ?? '/usr/share/fonts';
  hub.env.ORDO_LIBREOFFICE = 'off';
  hub.env.ORDO_PRERENDER = 'on';
  hub.env.ORDO_CHROMIUM = chromium;
  // The pictures wait for the grace after End service too (design/28 5.3); a short one keeps the spec's waits short and its order fixed.
  hub.env.ORDO_PACE_GRACE_MS = '3000';
  await hub.start();
  return hub;
}

type Job = { id: string; state: string; log: string[]; error?: string; result?: Record<string, unknown> };
async function waitJob(a: APIRequestContext, id: string, timeout = 180_000): Promise<Job> {
  let job: Job | undefined;
  await expect
    .poll(
      async () => {
        job = (await (await a.get(`jobs/${id}`)).json()) as Job;
        return job.state;
      },
      { timeout },
    )
    .toMatch(/^(done|failed)$/);
  expect(job!.state, `${job!.error}\n${job!.log.join('\n')}`).toBe('done');
  return job!;
}

/** Wait until the editor has taken revision `rev` over and holds nothing unsaved. */
async function editorAt(page: Page, rev: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await editorState(page);
        return s.baseRev === rev && !s.dirty && s.draft?.rev === rev;
      },
      { timeout: 180_000 },
    )
    .toBe(true);
}

/** The deck live on Audience 1 (1920 x 1080, Canvas 2D) at cue `cue`: what the screen draws at `points`. */
async function audienceColours(
  a: APIRequestContext,
  context: BrowserContext,
  port: number,
  presentationId: string,
  cue: number,
  name: string,
  points: { centre: [number, number]; color: readonly [number, number, number] }[],
  whileLive?: () => Promise<void>,
): Promise<void> {
  const pl = await apiJson<{ id: string }>(a, 'playlists', {
    post: { name: 'Continents', items: [{ id: 'deck', kind: 'presentation', presentationId }] },
  });
  await liveEvent(a, { k: 'goLive', playlistId: pl.id });
  const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
  const audience = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
  const w = await roleWindow(context, port, audience, { width: 1920, height: 1080 }, 'renderer=2d');
  try {
    await cacheReady(w);
    await liveEvent(a, { k: 'go', cueIndex: cue, at: Date.now() });
    await settledOn(w, cue);
    await expect
      .poll(
        async () => {
          const shot = await capture(w, join(OUT, `${name}-audience.png`));
          return points.filter((p) => close(at(shot, p.centre), p.color)).length;
        },
        { timeout: 60_000, message: 'shapes of the slide the Audience draws' },
      )
      .toBe(points.length);
    expect((await telemetryOf(w)).error ?? '').toBe('');
    await whileLive?.();
  } finally {
    await w.close();
  }
  // A live service defers every import job (live safety): end it before the editor steps.
  await liveEvent(a, { k: 'endService', at: Date.now() });
}

test('many-point shapes come in as one picture: stored, drawn on the screen, reset to shapes and drawn again', async ({
  page,
  context,
}) => {
  test.setTimeout(900_000);
  test.skip(exe === undefined, 'no Chromium found (ORDO_CHROMIUM, ORDO_TEST_CHROMIUM, Playwright)');
  const hub = await rasterHub(PORT, exe!);
  try {
    const a = await hubApi(PORT);
    const job = await importPptx(a, deck);
    const result = job.result as { presentationId: string; rasters?: Raster };
    // The import's own words: one picture of the 602 shapes (the two outlines and the 600 squares between them), none put back.
    expect(result.rasters).toMatchObject({
      pictures: 1,
      stored: 1,
      putBack: 0,
      candidates: 2,
      shapes: CONTINENTS.shapes,
    });
    expect(result.rasters!.off).toBeUndefined();
    expect(job.log.join('\n')).toMatch(/1 of 1 picture\(s\) of shapes stored/);

    const p = await stored(a, result.presentationId);
    expect(slidesOf(p)).toHaveLength(CONTINENTS.slides);
    const first = objectsOf(p, 0);
    const [picture] = pictures(first);
    expect(pictures(first)).toHaveLength(1);
    // The slide is the background, ONE locked picture and the text box live above it; no shape of the picture is an object.
    expect(first.map((o) => o.type)).toEqual(['shape', 'image', 'text']);
    expect(picture!.locked).toBe(true);
    expect(picture!.origin?.raster).toMatchObject({ n: CONTINENTS.shapes, from: 'slide' });
    expect(first.at(-1)!.text).toBe(CONTINENTS.title);
    expect((slidesOf(p)[0] as unknown as SlideOf).pptx?.class).toBe('native');
    expect(p.rev).toBe(1);
    // The second slide has no picture of shapes.
    expect(pictures(objectsOf(p, 1))).toHaveLength(0);
    const media = await apiJson<{ id: string; state: string; kind: string }[]>(a, 'media');
    expect(media.find((m) => m.id === picture!.mediaId)).toMatchObject({ kind: 'image', state: 'ready' });

    // The Audience screen draws the picture: both outlines' colours and the colours of two squares, each at its own place.
    let waiting: string | undefined;
    let mediaWhileLive = -1;
    await audienceColours(
      a,
      context,
      PORT,
      p.id,
      0,
      'live',
      [CONTINENTS.outlineA, CONTINENTS.outlineB, ...CONTINENTS.squares, CONTINENTS.background],
      async () => {
        // Live safety (design/29): while a service is live the picture step never starts. The same deck uploaded now (a presentation of its
        // own: the live one is locked) goes back to the queue before it does any work and says why; it runs after End service (and its
        // short grace) and finds the picture the first import made.
        const res = await a.post('import/document', {
          multipart: {
            file: {
              name: 'Continents again.pptx',
              mimeType: PPTX_MIME,
              buffer: readFileSync(deck),
            },
          },
        });
        expect(res.status(), await res.text()).toBe(202);
        waiting = ((await res.json()) as { id: string }).id;
        await expect
          .poll(async () => JSON.stringify(await (await a.get(`jobs/${waiting}`)).json()), {
            timeout: 60_000,
          })
          .toContain('a service is live');
        const held = (await (await a.get(`jobs/${waiting}`)).json()) as Job;
        expect(held.state).toBe('queued');
        expect(held.result).toBeUndefined();
        mediaWhileLive = (await apiJson<unknown[]>(a, 'media')).length;
      },
    );
    const second = await waitJob(a, waiting!);
    // It found the picture the first import had made: no new picture was drawn or stored, and the slide is the same.
    expect((second.result as { rasters?: Raster }).rasters).toMatchObject({
      reused: 1,
      stored: 0,
      putBack: 0,
    });
    expect((await apiJson<unknown[]>(a, 'media')).length).toBe(mediaWhileLive);
    const settledDeck = await stored(a, p.id);
    expect(pictures(objectsOf(settledDeck, 0))).toHaveLength(1);
    expect(objectsOf(settledDeck, 0).map((o) => o.type)).toEqual(['shape', 'image', 'text']);

    // The editor: the Presentation panel says how many shapes were drawn into pictures; the slide card says what the picture is.
    await openEditor(page, PORT, p.id);
    await openSlide(page, 1);
    await page.getByRole('button', { name: 'Presentation', exact: true }).click();
    const report = page.getByRole('region', { name: 'Imported from PowerPoint' });
    await expect(report.locator('[data-rasters]').first()).toContainText(
      `${CONTINENTS.shapes} shapes were drawn into 1 picture`,
    );
    // A whole Re-import says it draws the pictures again (Q67); closed without starting it.
    await report.getByRole('button', { name: 'Re-import from PowerPoint…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('[data-plan]')).toBeVisible();
    await expect(dialog.locator('[data-rasters]')).toContainText('drawn into pictures again');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Slide', exact: true }).click();
    const card = page.getByRole('region', { name: 'From PowerPoint' });
    await expect(card.locator('[data-raster-picture]')).toContainText(
      'A picture of shapes made when the file was imported.',
    );
    const reset = card.getByRole('button', { name: 'Reset slide from PowerPoint' });
    await expect(reset).toBeEnabled();
    await expect(card).toContainText('Brings the shapes back as shapes.');
    await reset.click();
    await expect(page.getByRole('dialog')).toContainText('Pictures drawn from shapes become shapes again');
    await page.getByRole('dialog').getByRole('button', { name: 'Reset slide' }).click();
    await editorAt(page, settledDeck.rev + 1);

    // Reset slide: the shapes are shapes (or today's boxes) again and no picture was made; the other slide is as it was.
    const afterReset = await stored(a, p.id);
    const shapes = objectsOf(afterReset, 0);
    expect(pictures(shapes)).toHaveLength(0);
    expect(shapes.length).toBeGreaterThan(50);
    expect(shapes.some((o) => o.type === 'text' && o.text === CONTINENTS.title)).toBe(true);
    expect(objectsOf(afterReset, 1)).toEqual(objectsOf(p, 1));
    await expect(card.locator('[data-raster-picture]')).toBeHidden();

    // A whole Re-import draws the picture again (the recipe's picture is found, nothing new is drawn for the same shapes).
    const mediaBefore = (await apiJson<unknown[]>(a, 'media')).length;
    const again = await a.post(`presentations/${p.id}/pptx-reimport`, { data: {} });
    expect(again.status(), await again.text()).toBe(202);
    await waitJob(a, ((await again.json()) as { id: string }).id);
    const redrawn = await stored(a, p.id);
    expect(pictures(objectsOf(redrawn, 0))).toHaveLength(1);
    expect(pictures(objectsOf(redrawn, 0))[0]!.mediaId).toBe(picture!.mediaId);
    expect((await apiJson<unknown[]>(a, 'media')).length).toBe(mediaBefore);
  } finally {
    hub.kill();
  }
});

test('a hub with no Chromium and no LibreOffice stores the same deck as today and says it cannot draw the pictures', async () => {
  test.setTimeout(300_000);
  const hub = await rasterHub(NONE_PORT, join(OUT, 'no-such-chromium'));
  try {
    const a = await hubApi(NONE_PORT);
    const job = await importPptx(a, deck);
    const result = job.result as { presentationId: string; rasters?: Raster };
    expect(result.rasters).toMatchObject({ off: 'no-maker', pictures: 0, stored: 0, candidates: 2 });
    const p = await stored(a, result.presentationId);
    expect(slidesOf(p)).toHaveLength(CONTINENTS.slides);
    expect(pictures(objectsOf(p, 0))).toHaveLength(0);
    // Today's slide: the outlines and the squares are objects, the words are text.
    expect(objectsOf(p, 0).length).toBeGreaterThan(50);
    expect(objectsOf(p, 0).some((o) => o.type === 'text' && o.text === CONTINENTS.title)).toBe(true);
  } finally {
    hub.kill();
  }
});
