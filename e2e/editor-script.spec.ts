import { expect, type Page, test } from '@playwright/test';
import {
  editorHub,
  editorState,
  M4_PORT,
  type Obj,
  opOrigin,
  type PresentationRec,
  saveAndReload,
  slidesOf,
} from './editorhelpers.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi, login } from './linkhelpers.ts';

/**
 * The Lyric Script (design/15 "Lyric Script"; songScript.ts), the desktop default for songs:
 * - Split at Cursor and Alt+Enter cut only at the caret of the field that has the focus: Alt+Enter at the end
 *   of a verse gives an empty next slide with the focus in it, ✂ on a verse whose field never had the caret
 *   does nothing; neither cuts a word in two (#24 cut at the text's middle: 'sweet the so' | 'und').
 * - On a formatted song (numbered lines, a bold word), typing in the field and Alt+Enter keep the numbers a
 *   paragraph style (never typed into the words: '1. 1. Amazing grace') and the bold on its word, on both
 *   halves, through Save and a reload.
 * Lyrics: "Amazing Grace" (John Newton, 1779), public domain. Port M4_PORT + 10.
 */
const PORT = M4_PORT + 10;
let hub: HubProcess;
test.beforeAll(async () => {
  hub = await editorHub(PORT);
});
test.afterAll(() => hub?.kill());

const SONG = `Amazing Grace

Verse 1
Amazing grace how sweet the sound
That saved a wretch like me

Verse 2
I once was lost but now am found
Was blind but now I see
`;
const V1 = 'Amazing grace how sweet the sound\nThat saved a wretch like me';
const V2 = 'I once was lost but now am found\nWas blind but now I see';

const lyricOf = (s: ReturnType<typeof slidesOf>[number]): Obj =>
  s.objects.find((o) => o.id === s.lyricObjectId) ?? s.objects.find((o) => o.type === 'text')!;
const texts = (p: PresentationRec) => slidesOf(p).map((s) => lyricOf(s)?.text ?? '');
const bold = (o: Obj) =>
  (o.runs ?? []).filter((r) => r.fontWeight === 700).map((r) => (o.text ?? '').slice(r.start, r.end));

async function openSong(page: Page, id: string): Promise<void> {
  await login(page, opOrigin(PORT));
  await page.evaluate((pid) => {
    location.hash = `#/edit/${encodeURIComponent(pid)}`;
  }, id);
  await expect
    .poll(async () => {
      const s = await editorState(page).catch(() => undefined);
      return s?.id === id && !!s.draft;
    })
    .toBe(true);
  await expect(page.locator('textarea[data-reflow-slide]').first()).toBeVisible();
}

const draft = async (page: Page) => (await editorState(page)).draft as PresentationRec;
const field = (page: Page, slideId: string) => page.locator(`textarea[data-reflow-slide="${slideId}"]`);

test('Split at Cursor and Alt+Enter cut only at the focused caret, never a word in two', async ({ page }) => {
  const a = await hubApi(PORT);
  const song = (await (await a.post('import/songselect', { data: { text: SONG } })).json()) as { id: string };
  await openSong(page, song.id);
  const p0 = await draft(page);
  expect(texts(p0)).toEqual([V1, V2]);
  const [s1, s2] = slidesOf(p0);

  // Alt+Enter at the end of verse 1: an empty next slide, the focus in its field.
  await field(page, s1!.id).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Alt+Enter');
  await expect.poll(async () => texts(await draft(page))).toEqual([V1, '', V2]);
  const empty = slidesOf(await draft(page))[1]!;
  await expect(field(page, empty.id)).toBeFocused();

  // ✂ of verse 2, whose field never had the caret: nothing happens.
  const card2 = field(page, s2!.id).locator('xpath=..');
  await card2.getByRole('button', { name: /Split at Cursor/ }).click();
  await page.waitForTimeout(300);
  expect(texts(await draft(page))).toEqual([V1, '', V2]);

  // A caret inside verse 2 (after 'found') with ✂: the cut is there, at a line break.
  await field(page, s2!.id).click();
  await field(page, s2!.id).evaluate((el, at) => (el as HTMLTextAreaElement).setSelectionRange(at, at), 32);
  await card2.getByRole('button', { name: /Split at Cursor/ }).click();
  await expect
    .poll(async () => texts(await draft(page)))
    .toEqual([V1, '', 'I once was lost but now am found', 'Was blind but now I see']);

  // Alt+Enter with the caret at the start of a field does nothing.
  await field(page, s1!.id).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Alt+Enter');
  await page.waitForTimeout(300);
  expect(texts(await draft(page))).toHaveLength(4);
  const words = new Set(`${V1} ${V2}`.split(/\s+/));
  const broken = texts(await draft(page))
    .flatMap((t) => t.split(/\s+/))
    .filter((w) => w && !words.has(w));
  expect(broken, 'every word on the slides is a whole word of the song').toEqual([]);
});

test('typing and Alt+Enter in a formatted song keep its numbers and bold through Save and a reload', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const song = (await (await a.post('import/songselect', { data: { text: SONG } })).json()) as { id: string };
  // Format verse 1 as a volunteer would in the Slide Canvas: numbered lines, 'sweet' bold.
  const full = (await (await a.get(`presentations/${song.id}`)).json()) as PresentationRec;
  const v1 = slidesOf(full)[0]!;
  const lyric = lyricOf(v1);
  lyric.paras = [{ bullet: { auto: 'arabicPeriod' } }, { bullet: { auto: 'arabicPeriod' } }];
  lyric.runs = [{ start: 18, end: 23, fontWeight: 700 }];
  expect((await a.put(`presentations/${song.id}`, { data: full })).ok()).toBe(true);

  await openSong(page, song.id);
  const f = field(page, v1.id);
  // The field shows the words as stored: no '1.' typed into them.
  await expect(f).toHaveValue(V1);

  // Type a word at the end of the first line, then cut before 'That' with Alt+Enter.
  await f.click();
  await f.evaluate((el, at) => (el as HTMLTextAreaElement).setSelectionRange(at, at), 33);
  await page.keyboard.type(' (Amen)');
  await f.evaluate((el, at) => (el as HTMLTextAreaElement).setSelectionRange(at, at), 41);
  await page.keyboard.press('Alt+Enter');
  await expect
    .poll(async () => texts(await draft(page)))
    .toEqual(['Amazing grace how sweet the sound (Amen)', 'That saved a wretch like me', V2]);

  const saved = await saveAndReload(page, a, song.id);
  const [x, y] = slidesOf(saved);
  const lx = lyricOf(x!);
  const ly = lyricOf(y!);
  expect(lx.text).toBe('Amazing grace how sweet the sound (Amen)');
  expect(bold(lx)).toEqual(['sweet']);
  expect(lx.paras).toEqual([{ bullet: { auto: 'arabicPeriod' } }]);
  expect(ly.text).toBe('That saved a wretch like me');
  expect(ly.paras).toEqual([{ bullet: { auto: 'arabicPeriod' } }]);
  expect(bold(ly)).toEqual([]);
  for (const t of texts(saved)) expect(t).not.toMatch(/^\d+\./m);
});
