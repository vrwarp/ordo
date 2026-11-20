import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import type { Slide } from '../packages/domain/src/index.ts';
import { effectsSlide } from '../packages/renderer/src/units.effects.test-util.ts';
import {
  canvasPoint,
  clickObject,
  editorReady,
  editorState,
  frames,
  openEditor,
  opOrigin,
  wholeSettled,
} from './editorhelpers.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi } from './linkhelpers.ts';
import { decodePng, type Pixels } from './png.ts';
import { LINE_ART_BLACK_BOX, lineArtDeck, lineArtInk } from './pptxdecks.ts';
import { portOf } from './ports.ts';
import { apiJson, importPptx, liveEvent, pptxHub } from './pptxlive.ts';

/**
 * The desktop editor draws what the slide's drawing budget would draw as a lighter copy whole (design/15 "Canvas
 * drawing", views/editor/wholeDraw.ts): line art and shadows past the budget, one object an idle moment, the
 * selected one at once, never while a service is live, and not with `?editor=light`. Each case reads the editor's
 * canvas as a picture (nothing selected, so no handles, unless it says so) and waits for the canvas's own status
 * (`window.__ordo.editor().whole`, `wholeSettled`), never for a sleep. The shadows are found by comparing the
 * slide with the same slide whose three late panels have no shadow (what the editor drew before): the soft
 * frame's 60 px fade lies under the panels' edges, so no constant colour says where a shadow is.
 * One hub without LibreOffice for the file (the deck is the converter's drawing), on its row of `ports.ts`.
 */
const PORT = portOf('editor-whole');
const OUT = 'test-results/editor-whole';
/** The panels the budget draws without their shadow (p9, p10, p11 of units.effects.test-util.ts). */
const LATE = ['p9', 'p10', 'p11'];
/** Slide points below the late panels' bottom edges (logical px of the 1920x1080 slide): p11's, then p10's and p11's. */
const POINTS = [
  { x: 1700, y: 985 },
  { x: 1300, y: 985 },
];
/** A late panel's shadow darkens these points by at least this many levels in every channel. */
const DARKER = 20;
/** The same slide with no late shadow: the capture is within this many levels of the reference. */
const SAME = 8;
/** The black share of the line art's box may differ from its ink coverage by this much (edges, overlap). */
const INK_TOLERANCE = 0.05;
/** The note under the Object panel's name row (OQ-LE2, the owner's words): shown for the selected object the editor draws as the lighter copy. */
const NOTE = 'Too detailed to draw here while you edit; the screens draw it whole.';

let hub: HubProcess;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const before = process.env.ORDO_LIBREOFFICE;
  process.env.ORDO_LIBREOFFICE = 'off';
  hub = await pptxHub(PORT);
  if (before === undefined) delete process.env.ORDO_LIBREOFFICE;
  else process.env.ORDO_LIBREOFFICE = before;
});

test.afterAll(() => {
  hub?.kill();
});

// ---- pictures ------------------------------------------------------------------------------------------

/** The editor's canvas, as a picture. */
async function capture(page: Page): Promise<Pixels> {
  return decodePng(await page.locator('.canvasbox .konvajs-content').screenshot());
}

/** The mean colour of a 5 x 5 block of device px at a slide point (logical px of the 1920x1080 slide). */
function colourAt(img: Pixels, p: { x: number; y: number }): [number, number, number] {
  const cx = Math.round((p.x / 1920) * img.width);
  const cy = Math.round((p.y / 1080) * img.height);
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = cy - 2; y <= cy + 2; y++)
    for (let x = cx - 2; x <= cx + 2; x++) {
      const o = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) sum[c]! += img.data[o + c]!;
      n++;
    }
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}

/** How many levels darker `img` is than `ref` at the point, in the channel that is least darker (negative: lighter). */
function darkerBy(img: Pixels, ref: Pixels, p: { x: number; y: number }): number {
  const a = colourAt(img, p);
  const b = colourAt(ref, p);
  return Math.min(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** How many levels `img` differs from `ref` at the point, in the channel that differs most. */
function differsBy(img: Pixels, ref: Pixels, p: { x: number; y: number }): number {
  const a = colourAt(img, p);
  const b = colourAt(ref, p);
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** The share of pixels in a logical box darker than `dark` in every channel (as pptx-lineart.spec.ts reads it). */
function blackShare(img: Pixels, box: { x: number; y: number; w: number; h: number }, dark = 48): number {
  const sx = img.width / 1920;
  const sy = img.height / 1080;
  const x0 = Math.ceil((box.x + box.w * 0.01) * sx);
  const y0 = Math.ceil((box.y + box.h * 0.01) * sy);
  const x1 = Math.floor((box.x + box.w * 0.99) * sx);
  const y1 = Math.floor((box.y + box.h * 0.99) * sy);
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

/** The canvas has drawn the slide: its first panel's colour is there (a blank stage is black). */
async function drawn(page: Page): Promise<Pixels> {
  let img!: Pixels;
  await expect
    .poll(async () => {
      img = await capture(page);
      return colourAt(img, { x: 440, y: 280 }).some((v) => v > 30);
    })
    .toBe(true);
  return img;
}

// ---- the note under the Object panel ---------------------------------------------------------------------

/** Select the object whose box holds the slide point (logical px), as a click does; waits until it is the selection. */
async function selectAt(page: Page, id: string, at: { x: number; y: number }): Promise<void> {
  await expect(async () => {
    await clickObject(page, { box: { x: at.x, y: at.y, w: 0, h: 0, rotation: 0 } });
    expect((await editorState(page)).objectId).toBe(id);
  }).toPass({ timeout: 15_000 });
}

/** The Object tab of the inspector drawer, open (the canvas gives it room: the drawer is closed by default on a desktop). */
async function openObjectPanel(page: Page): Promise<void> {
  const drawer = page.getByLabel('Inspector drawer');
  if (!(await drawer.isVisible())) await page.getByRole('button', { name: 'Tune', exact: true }).click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Object', exact: true }).click();
}

/** The note: how many there are in the panel (0 or 1). */
const noteCount = (page: Page) => page.locator('[data-whole-note]').count();

// ---- the slides ----------------------------------------------------------------------------------------

type Created = { id: string };

/** A presentation of one slide through the hub API. */
async function create(title: string, slide: Slide): Promise<string> {
  const a = await hubApi(PORT);
  const p = await apiJson<Created>(a, 'presentations', {
    post: { title, kind: 'slides', sections: [{ id: 'sec', label: 'Slides', short: 'S', slides: [slide] }] },
  });
  return p.id;
}

/** The slide of 12 panels over a soft frame, and the same slide without the three late panels' shadows. */
const full = (): Slide => effectsSlide();
const reference = (): Slide => {
  const s = effectsSlide();
  return {
    ...s,
    objects: s.objects.map((o) =>
      LATE.includes(o.id) ? { ...o, shadow: undefined } : o,
    ) as Slide['objects'],
  };
};

let fullId: string | undefined;
let refPicture: Pixels | undefined;

/** The slide of the 12 panels as a presentation of the hub, made once (a case may run alone). */
async function fullOf(): Promise<string> {
  fullId ??= await create('Effects', full());
  return fullId;
}

/** The reference slide's picture, made once: the editor on the slide as the budget has always drawn it. */
async function referenceOf(page: Page): Promise<Pixels> {
  if (refPicture) return refPicture;
  const id = await create('Effects (no late shadows)', reference());
  await openEditor(page, PORT, id);
  await wholeSettled(page);
  refPicture = await drawn(page);
  return refPicture;
}

/** Sign in at `url` (with its query) and open the editor on presentation `id`. */
async function openAt(page: Page, url: string, id: string): Promise<void> {
  await page.goto(url);
  const pin = page.locator('input.pin');
  const launch = page.getByRole('button', { name: 'Launch outputs' });
  await expect(pin.or(launch)).toBeVisible({ timeout: 20_000 });
  if (await pin.isVisible()) {
    await pin.fill('246810');
    await page.getByRole('button', { name: 'OK' }).click();
  }
  await expect(launch).toBeVisible({ timeout: 20_000 });
  await page.evaluate((pid) => {
    location.hash = `#/edit/${encodeURIComponent(pid)}`;
  }, id);
  await editorReady(page, id);
}

// ---- the cases -----------------------------------------------------------------------------------------

// The line art's holes are a few device px wide at the editor's scale (about 0.47): at a device scale of 2 their
// edges are drawn as the harness's page draws them, and the black share (`blackShare`, dark 48) is read there.
test('(A) line art past the slide budget is drawn whole in the editor', async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await hubApi(PORT);
  const job = await importPptx(a, lineArtDeck(join(OUT, 'deck')));
  const id = job.result!.presentationId;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await lineArt(page, id);
  } finally {
    await context.close();
  }
});

async function lineArt(page: Page, id: string): Promise<void> {
  await openEditor(page, PORT, id);
  const ink = lineArtInk();
  // The black line art's geometry file arrives after the first paint, and the canvas works the budget out
  // again with it: the picture is read until the whole drawing is there.
  await expect
    .poll(
      async () => {
        await wholeSettled(page);
        return Math.abs(blackShare(await capture(page), LINE_ART_BLACK_BOX) - ink);
      },
      {
        timeout: 30_000,
        message: `the black share of the line art within ${INK_TOLERANCE} of its ink ${ink}`,
      },
    )
    .toBeLessThanOrEqual(INK_TOLERANCE);
  const w = (await editorState(page)).whole!;
  expect(w.drawn, 'the black line art is drawn whole').toBeGreaterThanOrEqual(1);
}

test('(B) shadows past the effect budget show in the editor', async ({ page }) => {
  test.setTimeout(180_000);
  const ref = await referenceOf(page);
  await openEditor(page, PORT, await fullOf());
  await expect
    .poll(
      async () => {
        await wholeSettled(page);
        const img = await capture(page);
        return Math.min(...POINTS.map((p) => darkerBy(img, ref, p)));
      },
      { timeout: 30_000, message: 'the late panels’ shadows are darker than the reference at both points' },
    )
    .toBeGreaterThanOrEqual(DARKER);
  const w = (await editorState(page)).whole!;
  expect(w).toMatchObject({
    wanted: 3,
    drawn: 3,
    pending: 0,
    blocked: 0,
    live: false,
    coarse: false,
    light: false,
  });
  expect(w.lastMs.length, 'each whole draw was timed').toBeGreaterThanOrEqual(3);
});

test('(C) while a service is live the editor keeps the lighter drawing, and draws whole at End service', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const ref = await referenceOf(page);
  // A second, small presentation in a playlist that goes live (one in a live playlist is locked).
  const small = await create('Service', {
    id: 'sv',
    objects: [
      {
        id: 'r',
        type: 'shape',
        shape: 'rect',
        box: { x: 200, y: 200, w: 600, h: 300, rotation: 0 },
        fill: { r: 20, g: 90, b: 160, a: 1 },
        opacity: 1,
        radius: 0,
      },
    ],
  } as Slide);
  const pl = await apiJson<{ id: string }>(a, 'playlists', {
    post: { name: 'Service', items: [{ id: 'service', kind: 'presentation', presentationId: small }] },
  });
  await liveEvent(a, { k: 'goLive', playlistId: pl.id });
  try {
    await openEditor(page, PORT, await fullOf());
    // The editor knows a service is live, draws nothing whole and says why.
    await expect
      .poll(async () => (await editorState(page)).whole, { timeout: 30_000 })
      .toMatchObject({ live: true, drawn: 0, pending: 0 });
    await expect.poll(async () => (await editorState(page)).whole?.blocked).toBeGreaterThanOrEqual(3);
    await frames(page);
    const during = await drawn(page);
    for (const p of POINTS)
      expect(differsBy(during, ref, p), `no late shadow at ${p.x},${p.y} while live`).toBeLessThanOrEqual(
        SAME,
      );
    // The selected object keeps the lighter copy while live, and the Object panel says so (OQ-LE2).
    const p11 = effectsSlide().objects.find((o) => o.id === 'p11')!;
    await selectAt(page, 'p11', { x: p11.box.x + p11.box.w / 2, y: p11.box.y + p11.box.h / 2 });
    await openObjectPanel(page);
    await expect(page.locator('[data-whole-note]')).toHaveText(NOTE);
    expect(await noteCount(page), 'one note').toBe(1);
  } finally {
    await liveEvent(a, { k: 'endService', at: Date.now() });
  }
  // End service: the three are queued and drawn whole.
  await expect.poll(async () => (await editorState(page)).whole?.live, { timeout: 30_000 }).toBe(false);
  await expect
    .poll(
      async () => {
        await wholeSettled(page);
        const img = await capture(page);
        return Math.min(...POINTS.map((p) => darkerBy(img, ref, p)));
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(DARKER);
  expect((await editorState(page)).whole).toMatchObject({ drawn: 3, blocked: 0, pending: 0 });
  // The whole drawing has landed: the note under the Object panel is gone, with the object still selected.
  expect((await editorState(page)).objectId).toBe('p11');
  await expect(page.locator('[data-whole-note]')).toHaveCount(0);
});

test('(D) the technician switch ?editor=light keeps the lighter drawing', async ({ page }) => {
  test.setTimeout(180_000);
  const ref = await referenceOf(page);
  await openAt(page, `${opOrigin(PORT)}/?editor=light`, await fullOf());
  await expect
    .poll(async () => (await editorState(page)).whole, { timeout: 30_000 })
    .toMatchObject({ light: true, drawn: 0, pending: 0 });
  await expect.poll(async () => (await editorState(page)).whole?.blocked).toBeGreaterThanOrEqual(3);
  await frames(page);
  const img = await drawn(page);
  for (const p of POINTS)
    expect(differsBy(img, ref, p), `no late shadow at ${p.x},${p.y} with ?editor=light`).toBeLessThanOrEqual(
      SAME,
    );
  // The Object panel says so for the selected object, and for that one only; the controls below move by the
  // note's own line and nothing more (an object the budget keeps has the panel it had).
  const first = page.locator('.ed-box-grid input').first();
  await selectAt(page, 'p0', { x: 100, y: 80 });
  await openObjectPanel(page);
  await expect(first).toBeVisible();
  expect(await noteCount(page), 'p0 is drawn as the budget draws it: no note').toBe(0);
  const without = (await first.boundingBox())!.y;
  const p11 = effectsSlide().objects.find((o) => o.id === 'p11')!;
  await selectAt(page, 'p11', { x: p11.box.x + p11.box.w / 2, y: p11.box.y + p11.box.h / 2 });
  await expect(page.locator('[data-whole-note]')).toHaveText(NOTE);
  const note = (await page.locator('[data-whole-note]').boundingBox())!;
  const withNote = (await first.boundingBox())!.y;
  // The panel's column puts 10 px between its parts: the note is one line and one gap.
  expect(
    Math.abs(withNote - without - (note.height + 10)),
    'the controls moved by the note’s line',
  ).toBeLessThanOrEqual(1);
  expect(note.height, 'one line at this panel width').toBeLessThan(40);
});

test('(E) a move keeps a whole object whole: no flash of the lighter copy', async ({ page }) => {
  test.setTimeout(180_000);
  const ref = await referenceOf(page);
  await openEditor(page, PORT, await fullOf());
  await expect.poll(async () => (await wholeSettled(page))?.drawn, { timeout: 30_000 }).toBe(3);
  const p11 = effectsSlide().objects.find((o) => o.id === 'p11')!;
  await expect(async () => {
    await clickObject(page, p11);
    expect((await editorState(page)).objectId).toBe('p11');
  }).toPass({ timeout: 15_000 });
  const drawnBefore = (await editorState(page)).whole!.drawn;
  const at = await canvasPoint(page, 1701, 985);
  // Nothing covers the point (the selection's handles and the floating bar are elsewhere).
  const covering = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x!, y!)?.closest('.canvasbox') !== null,
    [at.x, at.y],
  );
  expect(covering, 'the canvas is what lies at the point').toBe(true);

  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => {
      const s = await editorState(page);
      const o = s.draft?.sections
        .flatMap((x) => x.slides)
        .flatMap((x) => (x as { objects?: { id: string; box: { x: number } }[] }).objects ?? []);
      return o?.find((x) => x.id === 'p11')?.box.x;
    })
    .toBe(p11.box.x + 1);
  await frames(page);
  const img = await capture(page);
  expect(
    darkerBy(img, ref, { x: 1701, y: 985 }),
    'p11 keeps its shadow after the move',
  ).toBeGreaterThanOrEqual(DARKER);
  const w = (await editorState(page)).whole!;
  expect(w.drawn, 'no whole drawing was lost to the move').toBe(drawnBefore);
  expect(w.pending).toBe(0);
  // The selected object is drawn whole, so the Object panel has no note for it (OQ-LE2), at the zoom the open
  // drawer leaves the canvas with, once the whole drawings are made again there.
  await openObjectPanel(page);
  await expect.poll(async () => (await wholeSettled(page))?.drawn, { timeout: 30_000 }).toBe(3);
  expect((await editorState(page)).objectId).toBe('p11');
  expect(await noteCount(page), 'no note for an object drawn whole').toBe(0);
});
