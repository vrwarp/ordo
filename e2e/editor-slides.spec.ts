import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import pptxgen from 'pptxgenjs';
import {
  ANNOUNCEMENT_TEXT,
  CHURCH,
  churchDeck,
  editorHub,
  editorState,
  frames,
  importDeck,
  M4_PORT,
  type Obj,
  opOrigin,
  openEditor,
  openSlide,
  type PresentationRec,
  saveAndReload,
  slidesOf,
} from './editorhelpers.ts';
import { uploadMedia } from './helpers.ts';
import { hubApi, login } from './linkhelpers.ts';
import { ffmpeg } from './pptxdecks.ts';
import { apiJson, liveEvent } from './pptxlive.ts';

/**
 * M4 item E, the slide and presentation ops (apps/operator/src/views/editor/M4.md; design/27 §11 items 7-9,
 * §15 M4 exit), on synthetic decks imported as editable slides: the announcement date changed by Find and
 * replace keeping its bold red run; a slide hidden in the slide list (dimmed), skipped by Next in the live
 * view and shown by a click; the background replaced on all slides with a picture of another aspect, as
 * the presentation's cover-fit background and as an imported 4:3 deck's background pictures, re-cropped
 * with the picture replace rule (item D's `replacePicture`), never distorted. Each ends in Save and a
 * reload with the presentation JSON identical. Port 8905.
 */
const PORT = M4_PORT + 5;
const OUT = 'test-results/editor-slides';

type Pic = Obj & { fit?: string; crop?: { l: number; t: number; r: number; b: number } };
type Live = { live?: number; cues: { hidden?: boolean }[] };

/** How far a picture is drawn from its own aspect in its box: 0 when it is not distorted. */
function distortion(o: Pic, w: number, h: number): number {
  const c = o.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const shown = ((1 - c.l - c.r) * w) / ((1 - c.t - c.b) * h);
  return Math.abs(shown / (o.box.w / o.box.h) - 1);
}

/** A PNG of `w`x`h` without alpha (an opaque picture is a 16:9 deck's `backgroundMediaId`). */
function picture(file: string, w: number, h: number): string {
  ffmpeg(['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}`, '-frames:v', '1', '-pix_fmt', 'rgb24', file]);
  return file;
}

/** A sermon-series deck: three titled slides on one background picture, 16:9 or 4:3. */
async function seriesDeck(dir: string, layout: 'LAYOUT_WIDE' | 'LAYOUT_4x3', bg: string): Promise<string> {
  const p = new pptxgen();
  p.layout = layout;
  const wide = layout === 'LAYOUT_WIDE';
  for (const title of ['Week 1: Hope', 'Week 2: Peace', 'Week 3: Joy']) {
    const s = p.addSlide();
    s.background = { data: `image/png;base64,${readFileSync(bg).toString('base64')}` };
    s.addText(title, {
      x: 0.5,
      y: 2.5,
      w: wide ? 12.3 : 9,
      h: 1.5,
      fontFace: 'Calibri',
      fontSize: 48,
      color: 'FFFFFF',
      align: 'center',
    });
  }
  const file = join(dir, `Series ${wide ? '16x9' : '4x3'}.pptx`);
  writeFileSync(file, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
  return file;
}

/** The editor's draft now. */
const draft = async (page: Page) => (await editorState(page)).draft!;

test.describe.configure({ mode: 'serial' });

test('change the announcement date by find and replace, hide a slide: dimmed, skipped by Next, shown by a click', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const out = join(OUT, 'find-hide');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const deck = await churchDeck(join(out, 'deck'));
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const p = await importDeck(a, deck);
    const slides = slidesOf(p);
    const note = slides[1]!.objects.find((o) => o.type === 'text' && o.text === ANNOUNCEMENT_TEXT)!;
    const dateAt = CHURCH.announcement.before.length;
    expect(
      note.runs?.find((r) => r.start <= dateAt && r.fontWeight === 700),
      'the date is bold',
    ).toBeDefined();

    await openEditor(page, PORT, p.id);

    // ---- Find… (Ctrl+F outside a text field): the matches by slide before replacing.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+f');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Find and replace' })).toBeVisible();
    await expect(dialog.getByLabel('Find', { exact: true })).toBeFocused();
    await dialog.getByLabel('Find', { exact: true }).fill('12 May');
    await dialog.getByLabel('Replace with').fill('19 May');
    await expect(dialog.locator('[data-find-count]')).toHaveText('1 match on 1 slide.');
    const rows = dialog.locator('[data-find-row]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Slide 2');
    await expect(rows.first().locator('mark')).toHaveText('12 May');
    // Whole words: '12 Ma' is not a whole word; the count follows as it is typed.
    await dialog.getByLabel('Find', { exact: true }).fill('12 Ma');
    await dialog.getByLabel('Whole words').check();
    await expect(dialog.locator('[data-find-count]')).toHaveText('No matches.');
    await expect(dialog.getByRole('button', { name: 'Replace all' })).toBeDisabled();
    await dialog.getByLabel('Find', { exact: true }).fill('12 May');
    await dialog.getByRole('button', { name: 'Replace all' }).click();
    await expect(dialog.locator('[data-find-done]')).toContainText('Replaced 1 match on 1 slide');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    let now = slidesOf(await draft(page))[1]!.objects.find((o) => o.id === note.id)!;
    expect(now.text).toBe(ANNOUNCEMENT_TEXT.replace('Sunday 12 May', 'Sunday 19 May'));
    // The date keeps its run (bold, red) and the box its style and text size.
    expect(now.runs).toEqual(note.runs);
    expect(now.style).toEqual(note.style);
    // One undo step puts it back, one redo replaces again.
    await page.keyboard.press('Control+z');
    now = slidesOf(await draft(page))[1]!.objects.find((o) => o.id === note.id)!;
    expect(now.text).toBe(ANNOUNCEMENT_TEXT);
    await page.keyboard.press('Control+y');
    now = slidesOf(await draft(page))[1]!.objects.find((o) => o.id === note.id)!;
    expect(now.text).toBe(ANNOUNCEMENT_TEXT.replace('Sunday 12 May', 'Sunday 19 May'));

    // ---- Hide the photo slide (4): dimmed in the slide list beside the deck's own hidden slide (6).
    await openSlide(page, 4);
    const toggle = page.locator('[data-hide-slide]');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const items = page.locator('.ed-slide');
    await expect(items.nth(3)).toHaveClass(/hidden-slide/);
    await expect(items.nth(5)).toHaveClass(/hidden-slide/);
    await expect(page.locator('.ed-slide.hidden-slide')).toHaveCount(2);
    const pic = items.nth(3).locator('img, .ph').first();
    await expect.poll(() => pic.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.4');
    await expect(items.nth(3).locator('.tag', { hasText: 'Hidden' })).toBeVisible();
    await frames(page);
    await page.screenshot({ path: join(out, 'hidden.png') });

    const saved = await saveAndReload(page, a, p.id);
    const after = slidesOf(saved);
    expect(after[1]!.objects.find((o) => o.id === note.id)!.runs).toEqual(note.runs);
    expect(after.map((s) => s.hidden === true)).toEqual([false, false, false, true, false, true]);
    // Nothing else changed.
    expect(after[1]!.objects.filter((o) => o.id !== note.id)).toEqual(
      slides[1]!.objects.filter((o) => o.id !== note.id),
    );
    for (const i of [0, 2, 4, 5]) expect(after[i]).toEqual(slides[i]);
    expect({ ...after[3], hidden: undefined }).toEqual({ ...slides[3], hidden: undefined });

    // ---- Live: Next skips the hidden slides, a double-click in the slide grid shows one.
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: { name: 'Sunday', items: [{ id: 'deck', kind: 'presentation', presentationId: p.id }] },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    const live = async () => (await apiJson<{ state: Live }>(a, 'live')).state;
    expect((await live()).cues.map((c) => c.hidden === true)).toEqual([
      false,
      false,
      false,
      true,
      false,
      true,
    ]);
    await liveEvent(a, { k: 'go', cueIndex: 2, at: Date.now() });
    await expect.poll(async () => (await live()).live).toBe(2);
    const op = await page.context().newPage();
    await login(op, opOrigin(PORT));
    await op.evaluate(() => {
      location.hash = '#/live';
    });
    const hiddenThumbs = op.locator('.thumb.hidden-slide');
    await expect(hiddenThumbs).toHaveCount(2, { timeout: 20_000 });
    await op.bringToFront();
    await op.keyboard.press('Space');
    await expect.poll(async () => (await live()).live).toBe(4);
    await hiddenThumbs.first().dblclick();
    await expect.poll(async () => (await live()).live).toBe(3);
    await op.close();
  } finally {
    hub.kill();
  }
});

test('replace the background on all slides with a picture of another aspect (the cover-fit default)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const out = join(OUT, 'background-16x9');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const bg = picture(join(out, 'series-16x9.png'), 1920, 1080);
  const deck = await seriesDeck(out, 'LAYOUT_WIDE', bg);
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const p = await importDeck(a, deck);
    const slides = slidesOf(p);
    // One opaque 16:9 picture on every slide is the presentation's background (the pickers swap it).
    const old = p.backgroundMediaId as string;
    expect(old).toBeDefined();
    expect(slides.every((s) => !s.backgroundMediaId)).toBe(true);
    const fourThree = await uploadMedia(
      a,
      picture(join(out, 'new-series-4x3.png'), 800, 600),
      'image/png',
      true,
    );
    const portrait = await uploadMedia(
      a,
      picture(join(out, 'portrait-3x5.png'), 600, 1000),
      'image/png',
      true,
    );

    await openEditor(page, PORT, p.id);
    await openSlide(page, 1);
    const section = page.locator('[data-slide-background]');
    await expect(section).toContainText("The presentation's default");
    // All slides using it: the presentation's background, which every slide shows.
    await section.getByRole('radio', { name: 'All 3 slides using it' }).check();
    await section.getByRole('button', { name: 'Replace…' }).click();
    await page.getByRole('dialog').locator('.thumb', { hasText: 'new-series-4x3' }).click();
    await expect.poll(async () => (await draft(page)).backgroundMediaId).toBe(fourThree.id);
    expect(slidesOf(await draft(page)).every((s) => !s.backgroundMediaId)).toBe(true);
    await expect(section).toContainText('new-series-4x3');

    // This slide only: slide 2 gets its own, a portrait picture (cover-fit too).
    await openSlide(page, 2);
    await section.getByRole('radio', { name: 'This slide' }).check();
    await section.getByRole('button', { name: 'Replace…' }).click();
    await page.getByRole('dialog').locator('.thumb', { hasText: 'portrait-3x5' }).click();
    await expect.poll(async () => slidesOf(await draft(page))[1]!.backgroundMediaId).toBe(portrait.id);
    await expect(section).toContainText('This slide only');
    expect((await draft(page)).backgroundMediaId).toBe(fourThree.id);
    await frames(page);
    await page.screenshot({ path: join(out, 'replaced.png') });

    const saved = await saveAndReload(page, a, p.id);
    expect(saved.backgroundMediaId).toBe(fourThree.id);
    expect(slidesOf(saved).map((s) => s.backgroundMediaId)).toEqual([undefined, portrait.id, undefined]);
    // The objects are as imported (a backgroundMediaId is drawn cover-fit: no picture to re-crop).
    for (const [i, s] of slidesOf(saved).entries()) expect(s.objects).toEqual(slides[i]!.objects);
  } finally {
    hub.kill();
  }
});

test("replace an imported 4:3 deck's background pictures on all slides, re-cropped, never distorted", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const out = join(OUT, 'background-4x3');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const deck = await seriesDeck(out, 'LAYOUT_4x3', picture(join(out, 'series-4x3.png'), 1024, 768));
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const p: PresentationRec = await importDeck(a, deck);
    const slides = slidesOf(p);
    // A 4:3 deck's background is a bottom picture over the slide area on each slide (role 'bg').
    const bgs = slides.map(
      (s) => s.objects.find((o) => o.type === 'image' && o.origin?.role === 'bg') as Pic,
    );
    expect(bgs.every(Boolean)).toBe(true);
    const old = bgs[0]!.mediaId!;
    expect(bgs.every((o) => o.mediaId === old)).toBe(true);
    const area = bgs[0]!.box;
    expect(area.w / area.h).toBeCloseTo(4 / 3, 3);
    const wide = await uploadMedia(
      a,
      picture(join(out, 'new-series-16x9.png'), 1920, 1080),
      'image/png',
      true,
    );
    const media = await apiJson<{ width: number; height: number }>(a, `media/${wide.id}`);

    await openEditor(page, PORT, p.id);
    await page.getByRole('button', { name: 'Presentation', exact: true }).click();
    const all = page.locator('[data-replace-all-backgrounds]');
    await expect(all).toContainText('is the background of 3 slides');
    await all.getByRole('button', { name: 'Replace on all slides…' }).click();
    await page.getByRole('dialog').locator('.thumb', { hasText: 'new-series-16x9' }).click();
    await expect
      .poll(async () =>
        slidesOf(await draft(page)).map((s, i) => s.objects.find((o) => o.id === bgs[i]!.id)?.mediaId),
      )
      .toEqual([wide.id, wide.id, wide.id]);
    for (const [i, s] of slidesOf(await draft(page)).entries()) {
      const o = s.objects.find((x) => x.id === bgs[i]!.id) as Pic;
      // Cover-cropped to the slide area: the 16:9 picture loses its sides, its aspect kept.
      expect(distortion(o, media.width, media.height)).toBeLessThan(1e-3);
      expect(o.crop!.l).toBeCloseTo(0.125, 3);
      expect(o.crop!.r).toBeCloseTo(0.125, 3);
      expect(o.box).toEqual(bgs[i]!.box);
      // The white the picture is laid on stays under it; nothing else moved.
      expect(s.objects.map((x) => x.id)).toEqual(slides[i]!.objects.map((x) => x.id));
    }
    await frames(page);
    await page.screenshot({ path: join(out, 'replaced.png') });

    const saved = await saveAndReload(page, a, p.id);
    for (const [i, s] of slidesOf(saved).entries()) {
      const o = s.objects.find((x) => x.id === bgs[i]!.id) as Pic;
      expect(o.mediaId).toBe(wide.id);
      expect(s.objects.filter((x) => x.id !== o.id)).toEqual(slides[i]!.objects.filter((x) => x.id !== o.id));
    }
  } finally {
    hub.kill();
  }
});
