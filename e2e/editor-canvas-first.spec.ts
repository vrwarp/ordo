import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  ANNOUNCEMENT_TEXT,
  canvasPoint,
  churchDeck,
  clickObject,
  editorHub,
  editorState,
  importDeck,
  M4_PORT,
  type Obj,
  openEditor,
  openSlide,
  slidesOf,
} from './editorhelpers.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi } from './linkhelpers.ts';

/**
 * The canvas-first editor (#24: the Tune drawer closed by default, the floating bar, the hidden backing text
 * field, the non-modal Find) on the church deck, the way a volunteer works it (design/15 "Slide canvas",
 * "Keys", "Errors", "Clipboard"):
 * - clipboard HTML from another page that claims to carry ordo objects the editor cannot use (no text, no
 *   style, a box no screen draws) is left out with a message; the slide, the canvas and the top bar stay
 *   (before, the unusable object was added to the slide, and the hub refused the save).
 * - b1: after Escape ends inline editing, the keys go back to the slide: ArrowRight nudges the box, Delete
 *   deletes it, a second Escape drops the selection (before, the focus stayed in the hidden 1x1 backing
 *   field: the arrows moved an invisible caret and Delete removed a letter).
 * - Find's match row starts inline editing at the match on the canvas (before, it focused the hidden field,
 *   so what was typed edited the match with no caret on screen), and the card is docked in the stage pane,
 *   clear of the open Tune drawer's tabs (before, it was fixed over them).
 * - An input method (Chrome's IME through CDP Input.imeSetComposition): the hidden text field the canvas
 *   types through sits at the caret on the stage, where the candidate window opens (before, at the window's
 *   bottom-left); Escape while composing cancels the composition, not inline editing; Enter in Find while
 *   composing confirms the candidate and does not jump to the next match.
 * Port M4_PORT + 11.
 */
const PORT = M4_PORT + 11;
const OUT = 'test-results/editor-canvas-first';
let hub: HubProcess;
let deck: string;

test.beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  deck = await churchDeck(join(OUT, 'deck'));
  hub = await editorHub(PORT);
});
test.afterAll(() => hub?.kill());

/** The open slide's objects in the editor's draft. */
async function slideObjects(page: Page): Promise<Obj[]> {
  const s = await editorState(page);
  return slidesOf(s.draft!).find((x) => x.id === s.slideId)!.objects;
}

/** A paste of `html` (and `text`) on the canvas, as the system clipboard delivers one. */
async function pasteHtml(page: Page, html: string, text = ''): Promise<void> {
  await page.evaluate(
    ([h, t]) => {
      (document.activeElement as HTMLElement | null)?.blur();
      const data = new DataTransfer();
      data.setData('text/html', h!);
      if (t) data.setData('text/plain', t);
      document.body.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    [html, text],
  );
}

test('hostile objects pasted from another page are left out with a message; the canvas and the top bar stay', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  const before = await slideObjects(page);

  // A page's clipboard HTML in ordo's object format: a text object with no text and no style, a shape no
  // screen can draw, and a key no schema has.
  const payload = {
    objects: [
      { id: 'evil-1', type: 'text', box: { x: 100, y: 100, w: 400, h: 200, rotation: 0 }, opacity: 1 },
      {
        id: 'evil-2',
        type: 'shape',
        shape: 'rect',
        box: { x: 0, y: 0, w: 1e300, h: 10, rotation: 0 },
        opacity: 1,
        radius: 0,
        onload: 'alert(1)',
      },
    ],
  };
  const attr = JSON.stringify(payload).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  await pasteHtml(page, `<meta charset="utf-8"><div data-ordo-objects="${attr}">Lyrics</div>`, 'Lyrics');

  await expect(page.locator('.toast').filter({ hasText: 'could not be used on a slide' })).toBeVisible();
  await expect(page.locator('.toast').last()).toContainText('2 pasted objects');
  // Nothing was added; the slide, the canvas and the top bar are all still there and working.
  expect((await slideObjects(page)).map((o) => o.id)).toEqual(before.map((o) => o.id));
  await expect(page.locator('.canvasbox canvas').first()).toBeVisible();
  // The top bar: nothing changed, so it says Saved.
  await expect(
    page.locator('.ed-toolbar-calm').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-page-error], [data-pane-error]')).toHaveCount(0);
  await page.screenshot({ path: join(OUT, 'after-hostile-paste.png') });
});

/** Whether the canvas's inline text editor is up. */
const inlineEditing = (page: Page) => page.locator('[data-testid="ordo-inline-canvas-editor"]').count();
/** The church deck's announcement on slide 2 (bold red date inside plain text). */
const noteOf = (p: Parameters<typeof slidesOf>[0]) =>
  slidesOf(p)[1]!.objects.find((o) => o.type === 'text' && o.text === ANNOUNCEMENT_TEXT)!;

test('b1: after Escape ends inline editing, the arrows nudge the box, Delete deletes it, Escape deselects', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = noteOf(p);
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  await expect(page.getByLabel('Inspector drawer')).toHaveCount(0);
  await expect(async () => {
    await clickObject(page, note);
    expect((await editorState(page)).objectId).toBe(note.id);
  }).toPass({ timeout: 15_000 });

  // Double-click into the text, then Escape: editing ends, the box stays selected.
  const at = await canvasPoint(page, note.box.x + 40, note.box.y + 30);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => inlineEditing(page)).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(() => inlineEditing(page)).toBe(0);
  expect((await editorState(page)).objectId).toBe(note.id);
  // The hidden backing field no longer holds the focus.
  expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-backing-text') ?? false)).toBe(
    false,
  );
  const count = (await slideObjects(page)).length;
  const x0 = (await slideObjects(page)).find((o) => o.id === note.id)!.box.x;

  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await slideObjects(page)).find((o) => o.id === note.id)?.box.x).toBe(x0 + 1);
  expect((await slideObjects(page)).find((o) => o.id === note.id)!.text).toBe(ANNOUNCEMENT_TEXT);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await slideObjects(page)).length).toBe(count - 1);
  expect((await slideObjects(page)).some((o) => o.id === note.id)).toBe(false);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await slideObjects(page)).length).toBe(count);

  // Again: edit, Escape ends the editing, the next Escape drops the selection.
  const back = (await slideObjects(page)).find((o) => o.id === note.id)!;
  await expect(async () => {
    await clickObject(page, back);
    expect((await editorState(page)).objectId).toBe(note.id);
  }).toPass({ timeout: 15_000 });
  const at2 = await canvasPoint(page, back.box.x + 40, back.box.y + 30);
  await page.mouse.dblclick(at2.x, at2.y);
  await expect.poll(() => inlineEditing(page)).toBe(1);
  await page.keyboard.press('Escape');
  await expect.poll(() => inlineEditing(page)).toBe(0);
  expect((await editorState(page)).objectId).toBe(note.id);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await editorState(page)).objectId).toBeUndefined();
});

test("Find: a match row starts inline editing there; the card is docked in the stage, clear of the drawer's tabs", async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = noteOf(p);
  await openEditor(page, PORT, p.id);

  // The Slide drawer open (nothing selected), then Find: the card sits in the stage pane, not over the drawer.
  await page.getByRole('button', { name: 'Tune', exact: true }).click();
  const drawer = page.getByLabel('Inspector drawer');
  await expect(drawer).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+f');
  const card = page.getByRole('dialog').filter({ hasText: 'Find and replace' });
  await expect(card).toBeVisible();
  const c = (await card.boundingBox())!;
  const stage = (await page.locator('.stagewrap').boundingBox())!;
  expect(c.x).toBeGreaterThanOrEqual(stage.x);
  expect(c.x + c.width).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
  for (const name of ['Object', 'Slide', 'Presentation']) {
    const t = (await drawer.getByRole('button', { name, exact: true }).boundingBox())!;
    const overlap =
      t.x < c.x + c.width && c.x < t.x + t.width && t.y < c.y + c.height && c.y < t.y + t.height;
    expect(overlap, `the Find card covers the drawer's ${name} tab`).toBe(false);
  }
  // The drawer's tabs still take a click with the card open.
  await drawer.getByRole('button', { name: 'Presentation', exact: true }).click();
  await drawer.getByRole('button', { name: 'Close inspector' }).click();

  // A row: slide 2 opens and inline editing starts with 'hall' selected; typing replaces it on the canvas.
  await card.getByLabel('Find', { exact: true }).fill('hall');
  await card.locator('[data-find-row]').first().getByRole('button').click();
  await expect.poll(async () => (await editorState(page)).slideId).toBe(slidesOf(p)[1]!.id);
  await expect.poll(() => inlineEditing(page)).toBe(1);
  // The canvas's editor takes the focus (its text field) on the next frame.
  await expect(page.locator('#ordo-text-editor')).toBeFocused();
  await page.keyboard.type('room');
  await expect
    .poll(async () => (await slideObjects(page)).find((o) => o.id === note.id)?.text)
    .toBe(ANNOUNCEMENT_TEXT.replace('hall', 'room'));
  // Escape ends the editing (the card stays), the next closes the card, the next drops the selection.
  await page.keyboard.press('Escape');
  await expect.poll(() => inlineEditing(page)).toBe(0);
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  expect((await editorState(page)).objectId).toBe(note.id);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await editorState(page)).objectId).toBeUndefined();
});

test('an input method: the candidate window opens at the caret, Escape and Enter while composing are its own', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = noteOf(p);
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  await expect(async () => {
    await clickObject(page, note);
    expect((await editorState(page)).objectId).toBe(note.id);
  }).toPass({ timeout: 15_000 });
  const at = await canvasPoint(page, note.box.x + 40, note.box.y + 30);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => inlineEditing(page)).toBe(1);
  const field = page.locator('#ordo-text-editor');
  await expect(field).toBeFocused();

  // The field the canvas types through (where the IME anchors its window) is on the stage, by the text.
  const stage = (await page.locator('.canvasbox .konvajs-content').first().boundingBox())!;
  const f = (await field.boundingBox())!;
  const noteTop = await canvasPoint(page, note.box.x, note.box.y);
  const noteEnd = await canvasPoint(page, note.box.x + note.box.w, note.box.y + note.box.h);
  expect(f.x).toBeGreaterThanOrEqual(Math.floor(noteTop.x) - 1);
  expect(f.x).toBeLessThanOrEqual(Math.ceil(noteEnd.x) + 1);
  expect(f.y).toBeGreaterThanOrEqual(Math.floor(noteTop.y) - 1);
  expect(f.y).toBeLessThanOrEqual(Math.ceil(noteEnd.y) + 1);
  expect(f.y + f.height).toBeLessThanOrEqual(stage.y + stage.height + 1);

  // Escape while composing belongs to the input method: inline editing goes on, and the word is kept.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(await inlineEditing(page)).toBe(1);
  await cdp.send('Input.insertText', { text: '日本' });
  await expect
    .poll(async () => (await slideObjects(page)).find((o) => o.id === note.id)?.text)
    .toContain('日本');
  // Without a composition, Escape ends inline editing.
  await page.keyboard.press('Escape');
  await expect.poll(() => inlineEditing(page)).toBe(0);

  // Enter in Find while composing confirms the candidate: the active match stays.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+f');
  const card = page.getByRole('dialog').filter({ hasText: 'Find and replace' });
  const input = card.getByLabel('Find', { exact: true });
  await input.fill('the');
  await expect.poll(async () => card.locator('[data-find-row]').count()).toBeGreaterThan(1);
  const active = () =>
    card
      .locator('[data-find-row]')
      .evaluateAll((rows) => rows.findIndex((r) => r.classList.contains('active')));
  await input.press('End');
  await cdp.send('Input.imeSetComposition', { text: ' ', selectionStart: 1, selectionEnd: 1 });
  await expect(input).toHaveValue('the ');
  await expect.poll(async () => card.locator('[data-find-row]').count()).toBeGreaterThan(1);
  expect(await active()).toBe(0);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(await active()).toBe(0);
  // Once the candidate is confirmed, Enter goes to the next match.
  await cdp.send('Input.insertText', { text: ' ' });
  await expect(input).toHaveValue('the ');
  await input.press('Enter');
  await expect.poll(active).toBe(1);
  await cdp.detach();
});
