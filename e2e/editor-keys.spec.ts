import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  ANNOUNCEMENT_TEXT,
  CHURCH,
  churchDeck,
  clickObject,
  editorHub,
  editorState,
  frames,
  importDeck,
  type Obj,
  openEditor,
  openSlide,
  opOrigin,
  saveAndReload,
  selectRange,
  slidesOf,
} from './editorhelpers.ts';
import { portOf } from './ports.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi, login } from './linkhelpers.ts';
import { apiJson } from './pptxlive.ts';

/**
 * The editor's keyboard for a volunteer without a mouse (design/15 "Accessibility"; `editorKeys.ts`), in the
 * real editor on the imported church deck, ending in Save and a reload with the presentation JSON identical:
 * - the arrows in the Align radio group choose an alignment and do not nudge the box;
 * - Enter on the focused Bold button makes the selection bold (the editor no longer swallows it);
 * - Bold, then Ctrl+Z in the text field takes the Bold back (the editor's undo, not the field's), also after
 *   typing (the typed text stays); Ctrl+Y brings it back; a selection made in the same moment is kept;
 * - Backspace on a focused format button deletes nothing;
 * - in the Find dialog, Enter on 'Replace all' replaces, and Delete on its Close button does not delete the
 *   text box selected behind the dialog;
 * - in the Presenter Notes Studio over a selected text box and over a selected picture, and in the Lyric
 *   Script over a selected lyric box, the canvas is not shown, so its keys leave the hidden slide alone (with
 *   the box copied first, Ctrl+V pastes nothing there); Up and Down move between slides in the studio.
 * Its port: e2e/ports.ts row 'editor-keys'.
 */
const PORT = portOf('editor-keys');
const OUT = 'test-results/editor-keys';

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
const byId = async (page: Page, id: string) => (await slideObjects(page)).find((o) => o.id === id)!;

/** Select `[start, end)` in the text field so the Object panel's tracked selection follows. */
async function select(page: Page, start: number, end: number): Promise<void> {
  await selectRange(page, start, end);
  await page.keyboard.press('Shift');
}

test('the editor by keyboard: radio arrows, Enter on buttons, Ctrl+Z after a format, dialogs keep their keys', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = slidesOf(p)[1]!.objects.find((o) => o.type === 'text' && o.text === ANNOUNCEMENT_TEXT)!;
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  await expect(async () => {
    await clickObject(page, note);
    expect((await editorState(page)).objectId).toBe(note.id);
  }).toPass({ timeout: 15_000 });
  await page.getByRole('button', { name: 'More object options' }).click();
  await page.locator('summary', { hasText: 'Lists, indents & paragraph spacing' }).click();
  const bar = page.getByRole('toolbar', { name: 'Typography' });
  const bold = bar.getByRole('button', { name: 'Bold' });
  const field = page.locator('#ordo-text-editor');

  // ---- The arrows in the Align radio group choose, and the box stays where it is.
  await field.focus();
  await select(page, 0, 7);
  const box0 = (await byId(page, note.id)).box;
  const align = page.getByRole('radiogroup', { name: 'Align' });
  // The group's tab stop: the checked choice (the first when the selection is mixed).
  const checked = align.locator('[aria-checked="true"]');
  const had = (await checked.count()) ? await checked.textContent() : null;
  await (had ? checked : align.getByRole('radio').first()).focus();
  await page.keyboard.press('ArrowRight');
  await expect(align.locator('[role="radio"]:focus')).toHaveAttribute('aria-checked', 'true');
  if (had) await expect(checked).not.toHaveText(had);
  expect((await byId(page, note.id)).box, 'the arrow chose an alignment, not a nudge').toEqual(box0);

  // ---- Enter on the focused Bold button makes 'Potluck' bold.
  await select(page, 0, 7);
  const runs0 = (await byId(page, note.id)).runs ?? [];
  await bold.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => JSON.stringify((await byId(page, note.id)).runs ?? []))
    .not.toBe(JSON.stringify(runs0));
  const boldRuns = (await byId(page, note.id)).runs ?? [];
  expect(boldRuns.some((r) => r.start === 0 && r.end === 7 && r.fontWeight === 700)).toBe(true);
  // The bar gives the field its focus back.
  await expect(field).toBeFocused();

  // ---- Ctrl+Z in the field takes the Bold back; Ctrl+Y brings it back.
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => JSON.stringify((await byId(page, note.id)).runs ?? []))
    .toBe(JSON.stringify(runs0));
  expect((await byId(page, note.id)).text).toBe(ANNOUNCEMENT_TEXT);
  await page.keyboard.press('Control+y');
  await expect
    .poll(async () => JSON.stringify((await byId(page, note.id)).runs ?? []))
    .toBe(JSON.stringify(boldRuns));
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => JSON.stringify((await byId(page, note.id)).runs ?? []))
    .toBe(JSON.stringify(runs0));

  // ---- A selection made right after Ctrl+Y or Ctrl+Z (the next click, Shift+End, keys typed in the same
  // frame) is kept: the editor puts the field's range back as it handles the key, never a frame later over
  // a newer selection (which then took the next typing to the old place).
  const kept = await field.evaluate(async (el) => {
    const t = el as HTMLTextAreaElement;
    const key = (k: string) =>
      t.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true }),
      );
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    t.focus();
    t.setSelectionRange(0, 7);
    key('y');
    t.setSelectionRange(3, 3);
    await frames();
    const afterRedo = [t.selectionStart, t.selectionEnd];
    t.setSelectionRange(0, 7);
    key('z');
    t.setSelectionRange(5, 5);
    await frames();
    return { afterRedo, afterUndo: [t.selectionStart, t.selectionEnd] };
  });
  expect(kept).toEqual({ afterRedo: [3, 3], afterUndo: [5, 5] });
  await expect
    .poll(async () => JSON.stringify((await byId(page, note.id)).runs ?? []))
    .toBe(JSON.stringify(runs0));

  // ---- Typed text, then a Bold by mouse, then Ctrl+Z: the Bold goes, the typed text stays.
  await select(page, ANNOUNCEMENT_TEXT.length, ANNOUNCEMENT_TEXT.length);
  await page.keyboard.type(' today');
  const typed = `${ANNOUNCEMENT_TEXT} today`;
  await expect.poll(async () => (await byId(page, note.id)).text).toBe(typed);
  // A pause, so the typing is its own undo step (typing coalesces within 800 ms).
  await page.waitForTimeout(900);
  const lunch = CHURCH.announcement.before.indexOf('lunch');
  await select(page, lunch, lunch + 'lunch'.length);
  const runsTyped = JSON.stringify((await byId(page, note.id)).runs ?? []);
  await bold.click();
  await expect.poll(async () => JSON.stringify((await byId(page, note.id)).runs ?? [])).not.toBe(runsTyped);
  await expect(field).toBeFocused();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => JSON.stringify((await byId(page, note.id)).runs ?? [])).toBe(runsTyped);
  expect((await byId(page, note.id)).text, 'the field’s own undo did not take letters back').toBe(typed);

  // ---- Backspace on a focused format button deletes nothing.
  await select(page, 0, 7);
  const count = (await slideObjects(page)).length;
  await bold.focus();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  expect((await slideObjects(page)).length).toBe(count);
  expect((await byId(page, note.id)).text).toBe(typed);

  // ---- The Find dialog keeps its keys while the text box stays selected behind it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+f');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Find', { exact: true }).fill('12 May');
  await dialog.getByLabel('Replace with').fill('19 May');
  const replaceAll = dialog.getByRole('button', { name: 'Replace all' });
  await expect(replaceAll).toBeEnabled();
  await replaceAll.focus();
  await page.keyboard.press('Enter');
  await expect(dialog.locator('[data-find-done]')).toContainText('Replaced');
  await expect.poll(async () => (await byId(page, note.id)).text).toContain('19 May');
  expect((await editorState(page)).objectId).toBe(note.id);
  // Both of its Close buttons: the header's ✕ and the footer's.
  for (const close of await dialog.getByRole('button', { name: 'Close', exact: true }).all()) {
    await close.focus();
    await page.keyboard.press('Delete');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ArrowDown');
  }
  await page.waitForTimeout(300);
  expect((await slideObjects(page)).length, 'Delete in the dialog deleted nothing behind it').toBe(count);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // ---- Saved, and the same after a reload.
  const saved = await saveAndReload(page, a, p.id);
  const after = slidesOf(saved)[1]!.objects.find((o) => o.id === note.id)!;
  expect(after.text).toBe(typed.replace('12 May', '19 May'));
});

test('with the non-modal Find open the canvas keeps its shortcuts, and Escape closes Find first', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = slidesOf(p)[1]!.objects.find((o) => o.type === 'text' && o.text === ANNOUNCEMENT_TEXT)!;
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  const count = (await slideObjects(page)).length;
  const find = page.getByRole('dialog');
  /** Select the note on the canvas, open Find with Ctrl+F, then leave the focus on the page (a canvas click). */
  const selectThenFind = async () => {
    await expect(async () => {
      await clickObject(page, note);
      expect((await editorState(page)).objectId).toBe(note.id);
    }).toPass({ timeout: 15_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+f');
    await expect(find.getByLabel('Find', { exact: true })).toBeFocused();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };

  // One Escape closes Find and keeps the selection; the next one drops the selection.
  await selectThenFind();
  await page.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
  expect((await editorState(page)).objectId).toBe(note.id);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await editorState(page)).objectId).toBeUndefined();

  // With Find open, Delete and Ctrl+Z still act on the slide, and Find stays open. The next click must not be
  // a double-click with the first (Konva's 400 ms window): that would start editing the text, whose hidden
  // field takes the focus a frame later, after Ctrl+F has opened Find.
  await page.waitForTimeout(500);
  await selectThenFind();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await slideObjects(page)).length).toBe(count - 1);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await slideObjects(page)).length).toBe(count);
  await expect(find).toBeVisible();
});

test('arrow up and down navigate slides when nothing has focus', async ({ page }) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const slides = slidesOf(p);
  await openEditor(page, PORT, p.id);
  await openSlide(page, 1);

  // Deselect any object and blur focus so document.activeElement is body
  await page.evaluate(() => {
    (
      window as unknown as {
        __ordo?: { editor?: { selectObject?: (id: string | undefined) => void } };
      }
    ).__ordo?.editor?.selectObject?.(undefined);
    (document.activeElement as HTMLElement | null)?.blur();
  });

  await expect.poll(async () => (await editorState(page)).slideId).toBe(slides[0]!.id);

  // ArrowDown goes to slide 2
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await editorState(page)).slideId).toBe(slides[1]!.id);

  // ArrowDown goes to slide 3
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await editorState(page)).slideId).toBe(slides[2]!.id);

  // ArrowUp goes back to slide 2
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await editorState(page)).slideId).toBe(slides[1]!.id);

  // PageDown / PageUp also navigate
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await editorState(page)).slideId).toBe(slides[2]!.id);
  await page.keyboard.press('PageUp');
  await expect.poll(async () => (await editorState(page)).slideId).toBe(slides[1]!.id);
});

/**
 * Every key the slide canvas takes for a selection: the arrows' nudge, Enter (inline editing), Escape
 * (deselect), Delete and Backspace, duplicate, paste, copy and cut (design/15 "Keyboard"). In the Presenter
 * Notes Studio and the Lyric Script the canvas is not shown, so none of them may act on what it had selected.
 * Each test copies the selected object on the canvas first (`copyOnCanvas`), so Ctrl+V has a copy to paste.
 */
const CANVAS_KEYS = [
  'ArrowRight',
  'ArrowDown',
  'Shift+ArrowLeft',
  'Enter',
  'Escape',
  'Delete',
  'Backspace',
  'Control+d',
  'Control+v',
  'Control+c',
  'Control+x',
];

/**
 * The focus on the page and no text selected, as once the button that opened the studio has gone with the
 * canvas: the keys go to the window's handlers, and so do the copy and paste events of Ctrl+C and Ctrl+V (a
 * caret left in the top bar's text would take those events, and the editor would read it as a button's).
 */
async function focusPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    getSelection()?.removeAllRanges();
  });
}

/** The objects of slide `slideId` as the editor holds them. */
async function objectsOf(page: Page, slideId: string): Promise<Obj[]> {
  return slidesOf((await editorState(page)).draft!).find((s) => s.id === slideId)!.objects;
}

/**
 * Click `o` on the canvas until the editor has it selected (never once it is: a click on a selected text box
 * starts typing in it).
 */
async function selectOnCanvas(page: Page, o: Pick<Obj, 'id' | 'box'>): Promise<void> {
  await expect(async () => {
    if ((await editorState(page)).objectId !== o.id) await clickObject(page, o);
    expect((await editorState(page)).objectId).toBe(o.id);
  }).toPass({ timeout: 15_000 });
}

/**
 * Ctrl+C on the canvas with `o` selected. The clipboard now holds it: Ctrl+V on the canvas pastes a copy, and
 * Ctrl+Z takes the copy away again. Then `o` is selected again.
 */
async function copyOnCanvas(page: Page, slideId: string, o: Pick<Obj, 'id' | 'box'>): Promise<void> {
  const before = await objectsOf(page, slideId);
  await focusPage(page);
  await page.keyboard.press('Control+c');
  await focusPage(page);
  await page.keyboard.press('Control+v');
  await expect
    .poll(async () => (await objectsOf(page, slideId)).length, {
      message: 'Ctrl+V on the canvas pastes a copy',
    })
    .toBe(before.length + 1);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => objectsOf(page, slideId)).toEqual(before);
  // The canvas reads two clicks on one spot within 400 ms as a double-click, which starts typing in a text box.
  await page.waitForTimeout(500);
  await selectOnCanvas(page, o);
  expect((await editorState(page)).inline, 'selected, not typed in').toBeUndefined();
}

/**
 * Press every canvas key on the page (`focusPage`): slide `slideId` stays as it was, the same slide is open,
 * `objectId` stays selected, no text box is being typed in, and `shown` stays on screen.
 */
async function keysLeaveHiddenSlide(
  page: Page,
  slideId: string,
  before: Obj[],
  objectId: string,
  shown: Locator,
): Promise<void> {
  for (const key of CANVAS_KEYS) {
    await focusPage(page);
    await page.keyboard.press(key);
    await frames(page);
    const s = await editorState(page);
    const slide = slidesOf(s.draft!).find((x) => x.id === slideId)!;
    expect(slide.objects, `${key}: the hidden slide unchanged`).toEqual(before);
    expect(s.slideId, `${key}: the same slide open`).toBe(slideId);
    expect(s.objectId, `${key}: the selection unchanged`).toBe(objectId);
    expect(s.inline, `${key}: no hidden text box is being typed in`).toBeUndefined();
    await expect(shown, `${key}: still shown`).toHaveCount(1);
  }
}

test('in the Presenter Notes Studio no key acts on the text box or picture selected on the hidden canvas, and Up and Down move between slides', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const a = await hubApi(PORT);
  // The church deck's photo, on a slide with a text box and notes. That slide comes last: ArrowDown, one of
  // the canvas keys, has no slide to move to from it, and ArrowUp moves to the first.
  const church = await importDeck(a, deck);
  const photo = slidesOf(church)
    .flatMap((s) => s.objects)
    .find((o) => o.type === 'image' && o.mediaId)!;
  const words = { x: 120, y: 760, w: 900, h: 200, rotation: 0 };
  const picture = { x: 1100, y: 120, w: 640, h: 480, rotation: 0 };
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const p = await apiJson<{ id: string }>(a, 'presentations', {
    post: {
      title: 'Welcome, with notes',
      kind: 'slides',
      sections: [
        {
          id: 'sec',
          label: 'Welcome',
          short: 'W',
          slides: [
            {
              id: 'intro',
              notes: CHURCH.announcement.notes,
              objects: [
                {
                  id: 'intro-words',
                  type: 'text',
                  box: words,
                  text: CHURCH.announcement.second,
                  style: { fontFamily: 'Inter', fontSizePx: 64, color: white },
                  opacity: 1,
                },
              ],
            },
            {
              id: 'welcome',
              notes: CHURCH.welcome.notes,
              objects: [
                {
                  id: 'words',
                  type: 'text',
                  box: words,
                  text: CHURCH.welcome.title,
                  style: { fontFamily: 'Inter', fontSizePx: 64, color: white },
                  opacity: 1,
                },
                {
                  id: 'photo',
                  type: 'image',
                  box: picture,
                  mediaId: photo.mediaId,
                  fit: 'cover',
                  opacity: 1,
                  radius: 0,
                },
              ],
            },
          ],
        },
      ],
    },
  });
  // A tall window: the Speaker Notes Dock opens by itself on a deck with notes (PR #28).
  await page.setViewportSize({ width: 1280, height: 900 });
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  const before = await objectsOf(page, 'welcome');
  const studio = page.locator('[data-deck-notes-studio]');

  // 1. The text box selected and copied on the canvas, then the dock's Manuscript Studio: the button goes away
  // with the canvas, so the focus falls to the page, where the window's key handler reads keys as the canvas's.
  await selectOnCanvas(page, { id: 'words', box: words });
  await copyOnCanvas(page, 'welcome', { id: 'words', box: words });
  await expect(page.locator('[data-notes-dock]')).toHaveAttribute('data-notes-dock', 'expanded');
  await page.getByRole('button', { name: /Manuscript Studio/ }).click();
  await expect(studio).toHaveCount(1, { timeout: 20_000 });
  await keysLeaveHiddenSlide(page, 'welcome', before, 'words', studio);

  // 2. Back on the canvas the keys are the canvas's again: ArrowRight nudges the box, Ctrl+Z takes it back.
  await page
    .getByRole('button', { name: /Slide Canvas/ })
    .first()
    .click();
  await expect(studio).toHaveCount(0);
  await frames(page);
  await focusPage(page);
  await page.keyboard.press('ArrowRight');
  const wordsNow = async () => (await objectsOf(page, 'welcome')).find((o) => o.id === 'words')!.box.x;
  await expect.poll(wordsNow).toBe(words.x + 1);
  await page.keyboard.press('Control+z');
  await expect.poll(wordsNow).toBe(words.x);

  // 3. The picture selected and copied, then the slide list's Presenter Notes: no nudge, no delete, no copy.
  await page.keyboard.press('Escape');
  await selectOnCanvas(page, { id: 'photo', box: picture });
  await copyOnCanvas(page, 'welcome', { id: 'photo', box: picture });
  await page
    .getByRole('button', { name: /Presenter Notes/ })
    .first()
    .click();
  await expect(studio).toHaveCount(1, { timeout: 20_000 });
  await keysLeaveHiddenSlide(page, 'welcome', before, 'photo', studio);

  // 4. Up and Down move between slides in the studio, with the picture still selected on the hidden canvas:
  // the picture does not move.
  await focusPage(page);
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await editorState(page)).slideId).toBe('intro');
  await focusPage(page);
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await editorState(page)).slideId).toBe('welcome');
  expect(await objectsOf(page, 'welcome')).toEqual(before);
  await expect(studio).toHaveCount(1);
});

test('in the Lyric Script no key acts on the lyric box selected on the hidden canvas', async ({ page }) => {
  test.setTimeout(180_000);
  const a = await hubApi(PORT);
  // One verse, one slide: Up and Down, which move between slides in the Lyric Script, have nowhere to go.
  const song = (await (
    await a.post('import/songselect', {
      data: {
        text: 'Amazing Grace\n\nVerse 1\nAmazing grace how sweet the sound\nThat saved a wretch like me\n',
      },
    })
  ).json()) as { id: string };
  await login(page, opOrigin(PORT));
  await page.evaluate((pid) => {
    location.hash = `#/edit/${encodeURIComponent(pid)}`;
  }, song.id);
  const script = page.locator('textarea[data-reflow-slide]');
  await expect(script).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(async () => (await editorState(page).catch(() => undefined))?.draft?.id).toBe(song.id);
  const slide = slidesOf((await editorState(page)).draft!)[0]!;
  const lyric = slide.objects.find((o) => o.id === slide.lyricObjectId) ?? slide.objects[0]!;

  // The lyric box selected and copied on the canvas, then the Lyric Script: what the canvas selected stays
  // selected.
  await page.getByRole('button', { name: 'Slide Canvas', exact: true }).click();
  await expect(page.locator('.canvasbox canvas').first()).toBeVisible({ timeout: 20_000 });
  await frames(page);
  await selectOnCanvas(page, lyric);
  await copyOnCanvas(page, slide.id, lyric);
  await page.getByRole('button', { name: 'Lyric Script', exact: true }).click();
  await expect(script).toHaveCount(1, { timeout: 20_000 });
  await keysLeaveHiddenSlide(page, slide.id, slide.objects, lyric.id, script);
});
