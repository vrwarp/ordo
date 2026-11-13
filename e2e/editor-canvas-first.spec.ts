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
  frames,
  importDeck,
  M4_PORT,
  type Obj,
  openEditor,
  openSlide,
  opOrigin,
  slidesOf,
} from './editorhelpers.ts';
import { uploadMedia } from './helpers.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi, login } from './linkhelpers.ts';
import { decodePng } from './png.ts';
import { ffmpeg } from './pptxdecks.ts';

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
 * - b4: the top bar's Background on an imported slide shows the picked picture (the Slide panel's Replace…
 *   for this slide); before, it set a background the slide's own PowerPoint background shape still covered.
 * - b6: a contrast choice on a themed lyric, from the floating bar or the drawer, survives a theme change as
 *   chosen; before, the floating bar's Soft shadow was dropped and the drawer's got the theme's outline back.
 * - The editing overlay on its own layer and the cached object nodes: on the shape+text slide the caret
 *   still blinks, typing shows, and the rounded box (a cached node) stays drawn under the text.
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

/** The screen colour at a slide point (1920x1080), from a 1x1 screenshot of the canvas. */
async function screenRgbAt(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const b = (await page.locator('.canvasbox .konvajs-content').first().boundingBox())!;
  const clip = { x: Math.round(b.x + (x / 1920) * b.width), y: Math.round(b.y + (y / 1080) * b.height) };
  const d = decodePng(await page.screenshot({ clip: { ...clip, width: 1, height: 1 } })).data;
  return [d[0]!, d[1]!, d[2]!];
}

test('b4: the top bar’s Background shows the picked picture on an imported slide, one undo step', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const s2 = slidesOf(p)[1]!;
  expect(s2.objects[0]!.origin?.role, 'the imported white background is a bottom bg shape').toBe('bg');
  const red = join(OUT, 'red-series-art.png');
  ffmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=1920x1080', '-frames:v', '1', '-pix_fmt', 'rgb24', red]);
  await uploadMedia(a, red, 'image/png', true);

  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  const before = await screenRgbAt(page, 40, 1040);
  await page.getByRole('button', { name: 'Background', exact: true }).click();
  await page.getByRole('dialog').locator('.thumb', { hasText: 'red-series-art' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(async () =>
      slidesOf((await editorState(page)).draft!)[1]!.objects.some((o) => o.origin?.role === 'bg'),
    )
    .toBe(false);
  await frames(page);
  await expect
    .poll(async () => {
      const [r, g, b] = await screenRgbAt(page, 40, 1040);
      return r > 200 && g < 60 && b < 60;
    }, `the slide corner shows the red picture (it was ${before})`)
    .toBe(true);
  // One undo step puts the PowerPoint background back.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect.poll(async () => slidesOf((await editorState(page)).draft!)[1]).toEqual(s2);
});

const SONG = `Contrast Test Song

Verse 1
Praise God from whom all blessings flow
Praise Him all creatures here below

Verse 2
Praise Him above ye heavenly host
Praise Father Son and Holy Ghost
`;

test('b6: a contrast choice on a themed lyric survives a theme change, from the floating bar and from the drawer', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  // Two outline-only themes (no shadow), as a church's lower-third style is.
  const base = await (await a.get('themes/theme-default')).json();
  const { shadow: _s, ...outlineOnly } = base.text;
  for (const [id, name] of [
    ['theme-evening', 'Evening'],
    ['theme-evening-2', 'Evening 2'],
  ]) {
    const r0 = await a.post('themes', { data: { ...base, id, name, rev: undefined, text: outlineOnly } });
    expect(r0.ok(), await r0.text()).toBe(true);
  }
  const song = (await (await a.post('import/songselect', { data: { text: SONG } })).json()) as { id: string };
  await login(page, opOrigin(PORT));
  await page.evaluate((pid) => {
    location.hash = `#/edit/${encodeURIComponent(pid)}`;
  }, song.id);
  await expect.poll(async () => (await editorState(page).catch(() => undefined))?.id).toBe(song.id);
  type Rec = Parameters<typeof slidesOf>[0] & { themeId?: string };
  const draft = async () => (await editorState(page)).draft as unknown as Rec;
  const lyricOf = (q: Rec, i: number) => {
    const sl = slidesOf(q)[i]!;
    return { slide: sl, lyric: sl.objects.find((o) => o.id === sl.lyricObjectId || o.type === 'text')! };
  };

  await page.getByLabel('Theme:').selectOption('theme-evening');
  await expect.poll(async () => (await draft()).themeId).toBe('theme-evening');
  await page.getByRole('button', { name: 'Slide Canvas' }).click();
  await expect(page.locator('.canvasbox canvas').first()).toBeVisible();

  // Slide 1: Soft shadow from the floating bar's contrast menu.
  await page.locator('.ed-slide').nth(0).click();
  await frames(page);
  const one = lyricOf(await draft(), 0);
  await expect(async () => {
    await clickObject(page, one.lyric);
    expect((await editorState(page)).objectId).toBe(one.lyric.id);
  }).toPass({ timeout: 15_000 });
  const fbar = page.getByRole('toolbar', { name: 'Contextual format bar' });
  await fbar.getByRole('button', { name: /^(Clean|Shadow|Outline|Heavy) ▾$/ }).click();
  await page.getByRole('menuitem', { name: 'Shadow' }).click();
  await expect.poll(async () => !!lyricOf(await draft(), 0).lyric.style?.shadow).toBe(true);

  // Slide 2: Soft Shadow from the drawer's readability cards.
  await page.locator('.ed-slide').nth(1).click();
  await frames(page);
  const two = lyricOf(await draft(), 1);
  await expect(async () => {
    await clickObject(page, two.lyric);
    expect((await editorState(page)).objectId).toBe(two.lyric.id);
  }).toPass({ timeout: 15_000 });
  await page.getByRole('button', { name: 'More object options' }).click();
  await page.getByRole('button', { name: /Soft Shadow/ }).click();
  await expect.poll(async () => !!lyricOf(await draft(), 1).lyric.style?.shadow).toBe(true);
  for (const i of [0, 1])
    expect(new Set(lyricOf(await draft(), i).slide.overrides)).toEqual(
      new Set(['style.outline', 'style.shadow']),
    );

  // The song's theme changes to Evening 2 (outline only): both lyrics keep a shadow and no outline.
  await page.getByRole('button', { name: 'Lyric Script', exact: true }).click();
  await page.getByLabel('Theme:').selectOption('theme-evening-2');
  await expect.poll(async () => (await draft()).themeId).toBe('theme-evening-2');
  const after = await draft();
  for (const i of [0, 1]) {
    const st = lyricOf(after, i).lyric.style ?? {};
    expect(!!st.shadow, `slide ${i + 1} keeps its shadow`).toBe(true);
    expect(st.outline, `slide ${i + 1} has no outline`).toBeUndefined();
  }
});

test('the caret blinks on its own layer, typing shows, and the cached shape under the text stays drawn', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const PAIR = 4;
  const sl = slidesOf(p)[PAIR]!;
  const shape = sl.objects.find((o) => o.type === 'shape' && o.origin?.group !== undefined)!;
  const text = sl.objects.find((o) => o.type === 'text' && o.origin?.group === shape.origin!.group)!;
  await openEditor(page, PORT, p.id);
  await openSlide(page, PAIR + 1);
  await frames(page);
  // A point of the rounded box clear of its (vertically centred) text and of the selection's handles.
  const fillAt = { x: shape.box.x + shape.box.w * 0.25, y: shape.box.y + shape.box.h * 0.15 };
  const fill0 = await screenRgbAt(page, fillAt.x, fillAt.y);
  await expect(async () => {
    await clickObject(page, text, { alt: true });
    expect((await editorState(page)).objectIds).toEqual([text.id]);
  }).toPass({ timeout: 15_000 });
  const at = await canvasPoint(page, text.box.x + text.box.w / 2, text.box.y + text.box.h / 2);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => inlineEditing(page)).toBe(1);
  await expect(page.locator('#ordo-text-editor')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect
    .poll(async () => (await slideObjects(page)).find((o) => o.id === text.id)?.text)
    .toBe(`${text.text}!`);

  // The text box on screen over two blink phases: the caret shows in one and not in the other.
  const tl = await canvasPoint(page, text.box.x, text.box.y);
  const br = await canvasPoint(page, text.box.x + text.box.w, text.box.y + text.box.h);
  const clip = { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
  const shots = new Set<string>();
  for (let i = 0; i < 6 && shots.size < 2; i++) {
    shots.add((await page.screenshot({ clip })).toString('base64'));
    await page.waitForTimeout(300);
  }
  expect(shots.size, 'the caret blinks').toBe(2);
  // The cached rounded box is drawn as before, under the edited text.
  expect(await screenRgbAt(page, fillAt.x, fillAt.y)).toEqual(fill0);
});
