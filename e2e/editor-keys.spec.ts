import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  ANNOUNCEMENT_TEXT,
  CHURCH,
  churchDeck,
  clickObject,
  editorHub,
  editorState,
  importDeck,
  M4_PORT,
  type Obj,
  openEditor,
  openSlide,
  saveAndReload,
  selectRange,
  slidesOf,
} from './editorhelpers.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi } from './linkhelpers.ts';

/**
 * The editor's keyboard for a volunteer without a mouse (design/15 "Accessibility"; `editorKeys.ts`), in the
 * real editor on the imported church deck, ending in Save and a reload with the presentation JSON identical:
 * - the arrows in the Align radio group choose an alignment and do not nudge the box;
 * - Enter on the focused Bold button makes the selection bold (the editor no longer swallows it);
 * - Bold, then Ctrl+Z in the text field takes the Bold back (the editor's undo, not the field's), also after
 *   typing (the typed text stays); Ctrl+Y brings it back;
 * - Backspace on a focused format button deletes nothing;
 * - in the Find dialog, Enter on 'Replace all' replaces, and Delete on its Close button does not delete the
 *   text box selected behind the dialog.
 * Port 8909.
 */
const PORT = M4_PORT + 9;
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
  const bar = page.getByRole('toolbar', { name: 'Text format' });
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
