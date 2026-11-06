import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  canvasPoint,
  churchDeck,
  clickObject,
  editorHub,
  editorState,
  frames,
  importDeck,
  M4_PORT,
  type Obj,
  openEditor,
  openSlide,
  saveAndReload,
  slidesOf,
} from './editorhelpers.ts';
import { uploadMedia } from './helpers.ts';
import { hubApi } from './linkhelpers.ts';
import { ffmpeg } from './pptxdecks.ts';
import { apiJson } from './pptxlive.ts';

/**
 * M4 item D, pictures (design/27 §11 item 6, §15 M4 exit "crop a photo"; apps/operator/src/views/editor/M4.md):
 * the church deck's 4:3 photo, stretched over a 16:9 box by the deck, is put back in proportion, cropped with
 * the numeric fields, then with the canvas handles (the picture scaled at its aspect and moved behind its
 * box, which stays), masked and flipped, and replaced by a portrait picture, which lands cover-cropped to the
 * box, undistorted, keeping the mask and the flip. Save and a reload give the same presentation JSON, and
 * no other slide changed. Port M4_PORT + 4.
 */
const PORT = M4_PORT + 4;
const OUT = 'test-results/editor-pictures';

type Crop = { l: number; t: number; r: number; b: number };
type Pic = Obj & { crop?: Crop; mask?: { preset?: string }; flipH?: boolean; fit?: string };
const NO_CROP: Crop = { l: 0, t: 0, r: 0, b: 0 };

/** The photo as the editor holds it now. */
async function photoNow(page: Page, slide: number, id: string): Promise<Pic> {
  const d = (await editorState(page)).draft!;
  return slidesOf(d)[slide]!.objects.find((o) => o.id === id) as Pic;
}

/** How far the shown part of a `w` x `h` picture is from the box's aspect (0: undistorted). */
function distortion(o: Pic, w: number, h: number): number {
  const c = o.crop ?? NO_CROP;
  return Math.abs((w * (1 - c.l - c.r)) / (h * (1 - c.t - c.b)) / (o.box.w / o.box.h) - 1);
}

/** Where the whole picture lies for a stretched picture (logical slide px), its south-east corner. */
function wholeSouthEast(o: Pic): { x: number; y: number } {
  const c = o.crop ?? NO_CROP;
  const fw = o.box.w / (1 - c.l - c.r);
  const fh = o.box.h / (1 - c.t - c.b);
  return { x: o.box.x - c.l * fw + fw, y: o.box.y - c.t * fh + fh };
}

/** A mouse drag on the canvas between two logical slide points, in steps (Konva sees every move). */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const a = await canvasPoint(page, from.x, from.y);
  const b = await canvasPoint(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
  await frames(page);
}

test('crop the church photo numerically and with the handles, mask, flip and replace it undistorted', async ({
  page,
}) => {
  test.setTimeout(300_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await churchDeck(join(OUT, 'deck'));
  const portrait = join(OUT, 'portrait-3x5.png');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=600x1000', '-frames:v', '1', portrait]);
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const p = await importDeck(a, deck);
    const slides = slidesOf(p);
    const photo = slides[3]!.objects.find((o) => o.type === 'image' && o.origin?.role === 'picture') as Pic;
    expect(photo, 'the photo slide has its picture').toBeDefined();
    const media = await apiJson<{ width: number; height: number }>(a, `media/${photo.mediaId}`);
    expect(media.width / media.height).toBeCloseTo(4 / 3, 2);
    // The deck stretched it over a 16:9 box.
    expect(distortion(photo, media.width, media.height)).toBeGreaterThan(0.2);
    const tall = await uploadMedia(a, portrait, 'image/png');

    await openEditor(page, PORT, p.id);
    await openSlide(page, 4);
    await expect(async () => {
      await clickObject(page, photo);
      expect((await editorState(page)).objectId).toBe(photo.id);
    }).toPass({ timeout: 15_000 });
    const panel = page.locator('[data-crop-control]');
    await expect(panel).toBeVisible();

    // ---- Back in proportion: a cover crop to the box, centred.
    await panel.getByRole('button', { name: 'Keep proportions' }).click();
    let now = await photoNow(page, 3, photo.id);
    expect(distortion(now, media.width, media.height)).toBeLessThan(1e-3);
    expect(now.crop!.l).toBe(0);
    expect(now.crop!.t).toBeCloseTo(now.crop!.b, 5);
    expect(now.box).toEqual(photo.box);
    await expect(panel.getByRole('button', { name: 'Keep proportions' })).toHaveCount(0);

    // ---- Numerically: 10 % off the left, then 4 % off the bottom on top of the proportional crop.
    const left = panel.getByLabel('Left');
    await left.fill('10');
    await left.press('Enter');
    await expect.poll(async () => (await photoNow(page, 3, photo.id)).crop?.l).toBe(0.1);
    const bottom = panel.getByLabel('Bottom');
    const b0 = (await photoNow(page, 3, photo.id)).crop!.b;
    await bottom.fill(String(Math.round(b0 * 1000) / 10 + 4));
    await bottom.press('Enter');
    await expect.poll(async () => (await photoNow(page, 3, photo.id)).crop?.b).toBeCloseTo(b0 + 0.04, 3);
    // 'Reset crop' gives the whole picture back; 'Keep proportions' crops it to the box again.
    await panel.getByRole('button', { name: 'Reset crop' }).click();
    await expect.poll(async () => (await photoNow(page, 3, photo.id)).crop).toBeUndefined();
    await panel.getByRole('button', { name: 'Keep proportions' }).click();
    now = await photoNow(page, 3, photo.id);
    expect(distortion(now, media.width, media.height)).toBeLessThan(1e-3);

    // ---- With the handles: the picture scaled from its south-east corner and moved, the box fixed.
    const mode = panel.getByRole('button', { name: 'Crop on the slide' });
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    await frames(page);
    const before = now;
    const se = wholeSouthEast(before);
    await drag(page, se, { x: se.x + 120, y: se.y + 120 });
    await page.screenshot({ path: join(OUT, 'crop-on-the-slide.png') });
    now = await photoNow(page, 3, photo.id);
    expect(now.box).toEqual(photo.box);
    expect(now.crop!.r).toBeGreaterThan(before.crop!.r + 0.02);
    expect(now.crop!.b).toBeGreaterThan(before.crop!.b + 0.02);
    expect(now.crop!.l).toBeCloseTo(before.crop!.l, 5);
    expect(distortion(now, media.width, media.height)).toBeLessThan(1e-3);
    // Moving the picture left behind the box shows more of its right side.
    const scaled = now;
    const centre = { x: photo.box.x + photo.box.w / 2, y: photo.box.y + photo.box.h / 2 };
    await drag(page, centre, { x: centre.x - 60, y: centre.y });
    now = await photoNow(page, 3, photo.id);
    expect(now.box).toEqual(photo.box);
    expect(now.crop!.l).toBeGreaterThan(scaled.crop!.l + 0.01);
    expect(now.crop!.r).toBeLessThan(scaled.crop!.r - 0.01);
    expect(distortion(now, media.width, media.height)).toBeLessThan(1e-3);
    // The arrow keys move it too (Shift: 10 px): the box keeps its place.
    const moved = now;
    await page.keyboard.press('Shift+ArrowLeft');
    await expect
      .poll(async () => (await photoNow(page, 3, photo.id)).crop!.l)
      .toBeCloseTo(moved.crop!.l + (10 * (1 - moved.crop!.l - moved.crop!.r)) / photo.box.w, 4);
    now = await photoNow(page, 3, photo.id);
    expect(now.box).toEqual(photo.box);
    // The fields follow the handles.
    await expect(panel.getByLabel('Left')).toHaveValue(String(Math.round(now.crop!.l * 1000) / 10));
    // Escape ends crop mode; the picture stays selected.
    await page.keyboard.press('Escape');
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    expect((await editorState(page)).objectId).toBe(photo.id);

    // ---- Mask and flip.
    await panel.getByRole('radio', { name: 'Ellipse' }).check();
    const flip = panel.getByRole('button', { name: 'Flip horizontal' });
    await flip.click();
    await expect(flip).toHaveAttribute('aria-pressed', 'true');
    now = await photoNow(page, 3, photo.id);
    expect(now.mask).toEqual({ preset: 'ellipse' });
    expect(now.flipH).toBe(true);
    // The crop fields name the sides as seen: mirrored, the left field shows the source's right share.
    await expect(panel.getByLabel('Left')).toHaveValue(String(Math.round(now.crop!.r * 1000) / 10));

    // ---- Replace with a portrait picture: cover-cropped to the box, undistorted; mask and flip kept.
    // The Object panel's image section (a fieldset, so a locked picture disables it at once).
    const image = page.locator('fieldset', { has: page.locator('h4', { hasText: /^Image$/ }) });
    await image.getByRole('button', { name: 'Replace', exact: true }).click();
    await page.getByRole('dialog').locator('.thumb', { hasText: 'portrait-3x5' }).click();
    await expect.poll(async () => (await photoNow(page, 3, photo.id)).mediaId).toBe(tall.id);
    now = await photoNow(page, 3, photo.id);
    const tallMedia = await apiJson<{ width: number; height: number }>(a, `media/${tall.id}`);
    expect(distortion(now, tallMedia.width, tallMedia.height)).toBeLessThan(1e-3);
    expect(now.crop!.l).toBe(0);
    expect(now.crop!.r).toBe(0);
    expect(now.box).toEqual(photo.box);
    expect(now).toMatchObject({ mask: { preset: 'ellipse' }, flipH: true, fit: photo.fit });

    await frames(page);
    await page.screenshot({ path: join(OUT, 'replaced.png') });
    const saved = await saveAndReload(page, a, p.id);
    const after = slidesOf(saved)[3]!.objects.find((o) => o.id === photo.id) as Pic;
    expect(after).toEqual(now);
    // Nothing else changed.
    for (const [i, s] of slidesOf(saved).entries()) if (i !== 3) expect(s).toEqual(slides[i]);
    expect(slidesOf(saved)[3]!.objects.filter((o) => o.id !== photo.id)).toEqual(
      slides[3]!.objects.filter((o) => o.id !== photo.id),
    );
  } finally {
    hub.kill();
  }
});
