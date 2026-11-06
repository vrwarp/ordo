import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  ANNOUNCEMENT_TEXT,
  CHURCH,
  churchDeck,
  editorHub,
  editorState,
  importDeck,
  M4_PORT,
  type Obj,
  openEditor,
  openSlide,
  save,
  saveAndReload,
  selectRange,
  selectText,
  slidesOf,
  stored,
} from './editorhelpers.ts';
import { hubApi } from './linkhelpers.ts';

/**
 * Two volunteers editing one presentation (M4 item H; design/27 §11 item 17, §15 M4): two editor pages open
 * the church deck at the same revision. The first fixes the announcement's date and saves; the second, still
 * on the revision both opened, changes the welcome title and saves: the hub refuses it (409), the editor
 * merges the first one's save with its draft and saves again, so both edits are stored. Then the first edits
 * the same welcome title differently: the conflict dialog names it by slide number, and 'Reload theirs'
 * takes the stored version over. It ends with a save and a reload, the presentation JSON identical. Port 8908.
 */
const PORT = M4_PORT + 8;
const OUT = 'test-results/editor-merge';

/** Select `[start, end)` of a text object's field on the open slide and type over it. */
async function typeOver(page: Page, o: Obj, start: number, end: number, text: string): Promise<void> {
  await selectText(page, o);
  await selectRange(page, start, end);
  await page.keyboard.type(text);
}

test('two editors save different slides: both edits stored; the same box on both shows the dialog', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await churchDeck(join(OUT, 'deck'));
  const hub = await editorHub(PORT);
  const second = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  try {
    const a = await hubApi(PORT);
    const p = await importDeck(a, deck);
    const slides = slidesOf(p);
    const title = slides[0]!.objects.find((o) => o.type === 'text' && o.text === CHURCH.welcome.title)!;
    const note = slides[1]!.objects.find((o) => o.type === 'text' && o.text === ANNOUNCEMENT_TEXT)!;
    const caption = slides[3]!.objects.find((o) => o.type === 'text' && o.text === CHURCH.photo.caption)!;
    expect([title, note, caption].every(Boolean)).toBe(true);

    // ---- Both volunteers open the presentation at the same revision.
    const other = await second.newPage();
    await openEditor(page, PORT, p.id);
    await openEditor(other, PORT, p.id);
    expect((await editorState(page)).baseRev).toBe(p.rev);
    expect((await editorState(other)).baseRev).toBe(p.rev);

    // ---- The first fixes the date on slide 2 ('12' → '19') and saves.
    await openSlide(page, 2);
    const two = CHURCH.announcement.before.length + 'Sunday 1'.length;
    await typeOver(page, note, two, two + 1, '9');
    await save(page);
    const first = await stored(a, p.id);
    expect(first.rev).toBe(p.rev + 1);
    const fixed = ANNOUNCEMENT_TEXT.replace('Sunday 12 May', 'Sunday 19 May');

    // ---- The second, still on the revision both opened, adds '!' to the welcome title and saves: merged.
    await openSlide(other, 1);
    await typeOver(other, title, CHURCH.welcome.title.length, CHURCH.welcome.title.length, '!');
    expect((await editorState(other)).baseRev).toBe(p.rev);
    await save(other);
    await expect(
      other.getByText('Saved together with the changes someone else saved meanwhile.'),
    ).toBeVisible();
    const both = await stored(a, p.id);
    expect(both.rev).toBe(first.rev + 1);
    const textOf = (rec: typeof both, slide: number, id: string) =>
      slidesOf(rec)[slide]!.objects.find((o) => o.id === id)?.text;
    expect(textOf(both, 0, title.id), 'the second editor’s edit').toBe(`${CHURCH.welcome.title}!`);
    expect(textOf(both, 1, note.id), 'the first editor’s edit').toBe(fixed);
    // The date keeps its run; nothing else changed and nothing is doubled.
    expect(slidesOf(both)[1]!.objects.find((o) => o.id === note.id)!.runs).toEqual(note.runs);
    expect(slidesOf(both).map((s) => s.objects.length)).toEqual(slides.map((s) => s.objects.length));
    for (const i of [2, 3, 4, 5]) expect(slidesOf(both)[i]).toEqual(slides[i]);
    for (const [i, o] of slides[0]!.objects.entries())
      if (o.id !== title.id) expect(slidesOf(both)[0]!.objects[i]).toEqual(o);
    // The second editor holds what is stored, saved.
    const s2 = await editorState(other);
    expect(s2).toMatchObject({ dirty: false, conflict: false, baseRev: both.rev });
    expect(s2.draft).toEqual(both);

    // ---- The first, still on its own save, changes the same title differently: the dialog says so.
    await openSlide(page, 1);
    const morning = CHURCH.welcome.title.indexOf('Morning');
    await typeOver(page, title, morning, morning + 'Morning'.length, 'Evening');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Changed by someone else');
    await expect(dialog.getByRole('listitem')).toHaveText([
      `Slide 1: both changed the text box “${CHURCH.welcome.title}”`,
    ]);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Save mine anyway' })).toBeVisible();
    expect((await stored(a, p.id)).rev, 'nothing was saved').toBe(both.rev);
    expect(await editorState(page)).toMatchObject({ conflict: true, dirty: true, baseRev: first.rev });

    // 'Reload theirs' takes the stored version over (both edits), and the first editor carries on from it.
    await dialog.getByRole('button', { name: 'Reload theirs (discard mine)' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await editorState(page)).baseRev).toBe(both.rev);
    expect((await editorState(page)).draft).toEqual(both);
    await openSlide(page, 4);
    await typeOver(page, caption, CHURCH.photo.caption.length, CHURCH.photo.caption.length, ' is open');
    const saved = await saveAndReload(page, a, p.id);
    expect(textOf(saved, 0, title.id)).toBe(`${CHURCH.welcome.title}!`);
    expect(textOf(saved, 1, note.id)).toBe(fixed);
    expect(textOf(saved, 3, caption.id)).toBe(`${CHURCH.photo.caption} is open`);
  } finally {
    await second.close();
    hub.kill();
  }
});
