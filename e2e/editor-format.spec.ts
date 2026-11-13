import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import pptxgen from 'pptxgenjs';
import {
  ANNOUNCEMENT_TEXT,
  canvasPoint,
  churchDeck,
  editorHub,
  editorState,
  frames,
  importDeck,
  M4_PORT,
  type Obj,
  openEditor,
  openSlide,
  saveAndReload,
  selectRange,
  selectText,
  slidesOf,
} from './editorhelpers.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi } from './linkhelpers.ts';
import { VERSE_TEXT } from './pptxdecks.ts';

/**
 * The format bar, the paragraph strip and the text box options (M4 item C; design/27 §11 items 2-4, §15 M4
 * exit), in the real editor on the imported church deck, each ending in Save and a reload with the
 * presentation JSON identical (`saveAndReload`):
 * - add a verse with a superscript number (the bar's Superscript, after which the text field has its
 *   focus and selection back; Ctrl+I in the field);
 * - number verses starting at 17 (the strip's List and 'Start at');
 * - write an RTL Hebrew line (the strip's Direction and Align);
 * - shrink to fit (the box options: the overflow edge on the canvas and the panel's note, then 'Shrink text
 *   to fit');
 * and the 4:3 guide of a deck that is not 16:9. The bar and the strip apply item A's ops (`formatRange`,
 * `setParas`). Port 8903.
 */
const PORT = M4_PORT + 3;
const OUT = 'test-results/editor-format';
/** John 3:18 (WEB), the verse added. */
const VERSE_18 = 'He who believes in him is not judged.';
/** Two verses typed into a new box and numbered from 17 (WEB). */
const NUMBERED = [
  "For God didn't send his Son into the world to judge the world.",
  'He who believes in him is not judged.',
];
/** A Hebrew line (peace and blessing to all). */
const HEBREW = 'שלום וברכה לכולם';

let hub: HubProcess;
let deck: string;

test.beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  deck = await churchDeck(join(OUT, 'deck'));
  hub = await editorHub(PORT);
});
test.afterAll(() => hub?.kill());

/**
 * Select `[start, end)` in the text field as a volunteer's keyboard does, so the Object panel's tracked
 * selection follows (React reports a textarea's selection on key and pointer events).
 */
async function select(page: Page, start: number, end: number): Promise<void> {
  await selectRange(page, start, end);
  await page.keyboard.press('Shift');
}

/** The editor canvas's guide nodes named `name` (CanvasGuides), as Konva holds them. */
async function guides(page: Page, name: string): Promise<{ x: number; y: number; w: number; h: number }[]> {
  await frames(page);
  return page.evaluate((n) => {
    type Node = { x(): number; y(): number; width(): number; height(): number };
    type Stage = { container(): HTMLElement; find(sel: string): Node[] };
    const K = (window as unknown as { Konva: { stages: Stage[] } }).Konva;
    const stage = K.stages.find((s) => s.container().closest('.canvasbox'));
    const r = (v: number) => Math.round(v * 100) / 100;
    return (stage?.find(`.${n}`) ?? []).map((g) => ({
      x: r(g.x()),
      y: r(g.y()),
      w: r(g.width()),
      h: r(g.height()),
    }));
  }, name);
}

/** The text field's focus and selection. */
const fieldSelection = (page: Page) =>
  page.evaluate(() => {
    const t = document.activeElement as HTMLTextAreaElement;
    return { id: t.id, start: t.selectionStart, end: t.selectionEnd };
  });

const textOn = (objects: Obj[], text: string) =>
  objects.find((o): o is Obj & { text: string } => o.type === 'text' && o.text === text)!;

test('add a verse with a superscript number', async ({ page }) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const verses = textOn(slidesOf(p)[2]!.objects, VERSE_TEXT);
  const raisedOf = (o: Obj) =>
    (o.runs ?? []).filter((r) => (r.baseline as number) > 0).map((r) => o.text!.slice(r.start, r.end));
  expect(raisedOf(verses), 'the import raises the verse numbers').toEqual(['16', '17']);

  await openEditor(page, PORT, p.id);
  await openSlide(page, 3);
  await selectText(page, verses);
  const end = VERSE_TEXT.length;
  await select(page, end, end);
  // Enter starts the verse's own paragraph; the number is typed with the text, then raised.
  await page.keyboard.type(`\n18 ${VERSE_18}`);
  const at = end + 1;
  await select(page, at, at + 2);
  const sup = page.getByRole('button', { name: 'Superscript' });
  await expect(sup).toBeEnabled();
  await expect(sup).toHaveAttribute('aria-pressed', 'false');
  await sup.click();
  await expect(sup).toHaveAttribute('aria-pressed', 'true');
  // The text field has its focus and its selection back.
  expect(await fieldSelection(page)).toEqual({ id: 'ordo-text-editor', start: at, end: at + 2 });
  // Ctrl+I in the text field: 'not judged' in italics.
  const stress = `${VERSE_TEXT}\n18 ${VERSE_18}`.indexOf('not judged');
  await select(page, stress, stress + 'not judged'.length);
  await page.keyboard.press('Control+i');
  await expect(page.getByRole('button', { name: 'Italic', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const saved = await saveAndReload(page, a, p.id);
  const o = slidesOf(saved)[2]!.objects.find((x) => x.id === verses.id)!;
  expect(o.text).toBe(`${VERSE_TEXT}\n18 ${VERSE_18}`);
  expect(raisedOf(o)).toEqual(['16', '17', '18']);
  expect(o.style).toEqual(verses.style);
  const italic = (o.runs ?? [])
    .filter((r) => r.fontStyle === 'italic')
    .map((r) => o.text!.slice(r.start, r.end));
  expect(italic).toEqual(['not judged']);
  // The rest of the slide is as imported.
  for (const x of slidesOf(saved)[2]!.objects)
    if (x.id !== verses.id) expect(slidesOf(p)[2]!.objects).toContainEqual(x);
});

test('number verses starting at 17', async ({ page }) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  await openEditor(page, PORT, p.id);
  await openSlide(page, 3);
  // A new text box with two verses, numbered from 17.
  await page.getByRole('button', { name: '+ Text' }).click();
  await expect.poll(async () => (await editorState(page)).objectId).toBeTruthy();
  const id = (await editorState(page)).objectId!;
  const field = page.locator('#ordo-text-editor');
  await field.fill(NUMBERED.join('\n'));
  await page.getByRole('button', { name: 'More object options' }).click();
  await page.locator('summary', { hasText: 'Lists, indents & paragraph spacing' }).click();
  await select(page, 0, NUMBERED.join('\n').length);
  await page.getByLabel('List').selectOption('auto:arabicPeriod');
  const startAt = page.getByLabel('Start at');
  await expect(startAt).toHaveValue('1');
  await startAt.fill('17');
  await startAt.press('Tab');
  await expect(startAt).toHaveValue('17');

  const saved = await saveAndReload(page, a, p.id);
  const o = slidesOf(saved)[2]!.objects.find((x) => x.id === id)!;
  expect(o.text).toBe(NUMBERED.join('\n'));
  expect(o.paras).toHaveLength(2);
  for (const para of o.paras!) {
    expect(para).toMatchObject({ bullet: { auto: 'arabicPeriod', startAt: 17 } });
    // A hanging indent wide enough for '18.'.
    expect(para!.indentPx as number).toBeGreaterThan(0);
    expect(para!.firstLinePx).toBe(-(para!.indentPx as number));
  }
});

test('write an RTL Hebrew line', async ({ page }) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = textOn(slidesOf(p)[1]!.objects, ANNOUNCEMENT_TEXT);
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  await selectText(page, note);
  const end = ANNOUNCEMENT_TEXT.length;
  await select(page, end, end);
  await page.keyboard.type(`\n${HEBREW}`);
  await page.getByRole('button', { name: 'More object options' }).click();
  await page.locator('summary', { hasText: 'Lists, indents & paragraph spacing' }).click();
  await select(page, end + 1, end + 1 + HEBREW.length);
  const dir = page.getByRole('radiogroup', { name: 'Direction' });
  await dir.getByRole('radio', { name: 'Right to left' }).click();
  await expect(dir.getByRole('radio', { name: 'Right to left' })).toHaveAttribute('aria-checked', 'true');
  const align = page.getByRole('radiogroup', { name: 'Align' });
  await align.getByRole('radio', { name: 'Right', exact: true }).click();
  await expect(align.getByRole('radio', { name: 'Right', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // The first line keeps its own paragraph style.
  await select(page, 0, 0);
  await expect(dir.getByRole('radio', { name: 'Right to left' })).toHaveAttribute('aria-checked', 'false');

  const saved = await saveAndReload(page, a, p.id);
  const o = slidesOf(saved)[1]!.objects.find((x) => x.id === note.id)!;
  expect(o.text).toBe(`${ANNOUNCEMENT_TEXT}\n${HEBREW}`);
  expect(o.paras![2]).toMatchObject({ rtl: true, align: 'right' });
  for (const i of [0, 1]) expect(o.paras?.[i] ?? null).toEqual(note.paras?.[i] ?? null);
  expect(o.runs).toEqual(note.runs);
});

test('shrink to fit: the overflow edge and the note, then Shrink text to fit', async ({ page }) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = textOn(slidesOf(p)[1]!.objects, ANNOUNCEMENT_TEXT);
  expect(note.style?.autofit).not.toBe('shrink');
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  await selectText(page, note);
  expect(await guides(page, 'text-overflow')).toEqual([]);
  const tooFull = 'Bring a friend\nStay for coffee\nChildren meet in the hall\nPrayer at six';
  const end = ANNOUNCEMENT_TEXT.length;
  await select(page, end, end);
  await page.keyboard.type(`\n${tooFull}`);
  const warn = page.getByText('Text does not fit: turn on Shrink text to fit or enlarge the box.');
  await expect(warn).toBeVisible();
  await expect.poll(() => guides(page, 'text-overflow')).toHaveLength(1);
  const edge = (await guides(page, 'text-overflow'))[0]!;
  expect(edge.w).toBe(note.box.w);
  expect(edge.h).toBe(note.box.h);

  await page.getByRole('button', { name: 'More object options' }).click();
  await page.getByLabel('Shrink text to fit').check();
  await expect(warn).toBeHidden();
  await expect.poll(() => guides(page, 'text-overflow')).toEqual([]);

  const saved = await saveAndReload(page, a, p.id);
  const o = slidesOf(saved)[1]!.objects.find((x) => x.id === note.id)!;
  expect(o.text).toBe(`${ANNOUNCEMENT_TEXT}\n${tooFull}`);
  expect(o.style).toEqual({ ...note.style, autofit: 'shrink' });
  // After the reload the box fits, and the editor says nothing.
  await openSlide(page, 2);
  await selectText(page, note);
  await expect(page.getByText(/Text does not fit/)).toBeHidden();
  expect(await guides(page, 'text-overflow')).toEqual([]);
});

test('a 4:3 deck shows its area on the canvas, the bars outside it shaded', async ({ page }) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const x = new pptxgen();
  x.layout = 'LAYOUT_4x3';
  x.addSlide().addText('Welcome', { x: 1, y: 3, w: 8, h: 1.5, fontFace: 'Calibri', fontSize: 44 });
  const file = join(OUT, 'four-three.pptx');
  writeFileSync(file, (await x.write({ outputType: 'nodebuffer' })) as Buffer);
  const p = await importDeck(a, file);
  type Rect = { x: number; y: number; w: number; h: number };
  const rect = (p as { source?: { native?: { slideRect?: Rect } } }).source?.native?.slideRect;
  expect(rect, 'a 4:3 deck is centred in the 16:9 frame').toBeDefined();
  for (const [k, v] of Object.entries({ x: 240, y: 0, w: 1440, h: 1080 }))
    expect(rect![k as keyof Rect]).toBeCloseTo(v, 2);
  await openEditor(page, PORT, p.id);
  await expect.poll(() => guides(page, 'deck-area')).toEqual([{ x: 240, y: 0, w: 1440, h: 1080 }]);
  expect(await guides(page, 'deck-bar')).toEqual([
    { x: 0, y: 0, w: 240, h: 1080 },
    { x: 1680, y: 0, w: 240, h: 1080 },
  ]);
  // A 16:9 deck has none.
  const wide = await importDeck(a, deck);
  await page.evaluate((id) => {
    location.hash = `#/edit/${encodeURIComponent(id)}`;
  }, wide.id);
  await expect.poll(async () => (await editorState(page)).id).toBe(wide.id);
  await expect.poll(() => guides(page, 'deck-area')).toEqual([]);
});

test('inline canvas text editing selects words on the canvas and formats them via FormatBar without losing focus', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = textOn(slidesOf(p)[1]!.objects, ANNOUNCEMENT_TEXT);

  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  await selectText(page, note);

  // Double-click the text box on the canvas to enter canvas-native inline editing.
  const pt = await canvasPoint(page, note.box.x + 80, note.box.y + 40);
  await page.mouse.dblclick(pt.x, pt.y);
  const inlineOverlay = page.getByTestId('ordo-inline-canvas-editor');
  await expect(inlineOverlay).toBeVisible();

  // Double-click near the start of 'Potluck' on the canvas overlay to select that word.
  const wordPt = await canvasPoint(page, note.box.x + 40, note.box.y + 30);
  await page.mouse.click(wordPt.x, wordPt.y);
  await page.mouse.click(wordPt.x, wordPt.y);
  await expect
    .poll(() => fieldSelection(page))
    .toEqual({
      id: 'ordo-text-editor',
      start: 0,
      end: 'Potluck'.length,
    });

  // Format the selected canvas word using FormatBar (Italic + Size +) without dismissing inline editing.
  const italicBtn = page.getByRole('button', { name: 'Italic' });
  await expect(italicBtn).toBeEnabled();
  await italicBtn.click();
  await expect(italicBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(inlineOverlay).toBeVisible();

  const sizePlusBtn = page.getByRole('button', { name: 'Size + (larger text)' });
  await sizePlusBtn.click();
  await expect(inlineOverlay).toBeVisible();

  const saved = await saveAndReload(page, a, p.id);
  const updated = textOn(slidesOf(saved)[1]!.objects, ANNOUNCEMENT_TEXT);
  const potluckRun = (updated.runs ?? []).find((r) => r.start === 0 && r.end === 'Potluck'.length);
  expect(potluckRun).toMatchObject({
    start: 0,
    end: 'Potluck'.length,
    fontStyle: 'italic',
  });
  expect(potluckRun?.sizeScale).toBeGreaterThan(1);
});

test('rich copy and paste preserves Ordo runs, converts external scripture HTML, and copies slide objects across slides', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = textOn(slidesOf(p)[1]!.objects, ANNOUNCEMENT_TEXT);

  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  await selectText(page, note);

  // 1. Format 'Potluck' as Bold + Superscript, copy it, and paste it at the end of the text box.
  const start = note.text.indexOf('Potluck');
  const end = start + 'Potluck'.length;
  await select(page, start, end);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByRole('button', { name: 'Superscript' }).click();

  await page.evaluate(
    ([s, e]) => {
      const el = document.getElementById('ordo-text-editor') as HTMLTextAreaElement;
      el.focus();
      el.setSelectionRange(s, e);
      const dt = new DataTransfer();
      el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: dt }));
      el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    },
    [start, end] as const,
  );

  // 2. Paste external scripture HTML with superscript verse number and bold phrase at the end.
  await page.evaluate(() => {
    const el = document.getElementById('ordo-text-editor') as HTMLTextAreaElement;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    const dt = new DataTransfer();
    dt.setData('text/html', '<p><sup class="versenum">16&nbsp;</sup><b>Amen</b></p>');
    dt.setData('text/plain', '16 Amen');
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  });

  // 3. Copy the selected object on Slide 2 and paste it onto Slide 1.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const dt = new DataTransfer();
    window.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: dt }));
    (window as unknown as { __clipHtml: string; __clipText: string }).__clipHtml = dt.getData('text/html');
    (window as unknown as { __clipText: string }).__clipText = dt.getData('text/plain');
  });

  await openSlide(page, 1);
  const beforeCount = (await editorState(page)).draft!.sections[0]!.slides[0]!.objects.length;
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const dt = new DataTransfer();
    const w = window as unknown as { __clipHtml: string; __clipText: string };
    dt.setData('text/html', w.__clipHtml);
    dt.setData('text/plain', w.__clipText);
    window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  });

  await expect
    .poll(async () => (await editorState(page)).draft!.sections[0]!.slides[0]!.objects.length)
    .toBe(beforeCount + 1);

  const saved = await saveAndReload(page, a, p.id);
  const s1Objects = slidesOf(saved)[0]!.objects;
  const pastedObj = s1Objects[s1Objects.length - 1]!;
  expect(pastedObj.type).toBe('text');
  if (pastedObj.type === 'text') {
    const pastedText = pastedObj.text ?? '';
    expect(pastedText).toContain('Potluck16 Amen');
    // Verify the pasted '16 ' has baseline: 0.3 and 'Amen' has fontWeight: 700
    const amenIdx = pastedText.lastIndexOf('Amen');
    const verseIdx = pastedText.lastIndexOf('16 ');
    const verseRun = (pastedObj.runs ?? []).find((r) => r.start <= verseIdx && r.end >= verseIdx + 2);
    const amenRun = (pastedObj.runs ?? []).find((r) => r.start <= amenIdx && r.end >= amenIdx + 4);
    expect(verseRun?.baseline).toBe(0.3);
    expect(amenRun?.fontWeight).toBe(700);
  }
});

test('canvas-first floating bar, unified PaintPopover gradients, and stage output lens', async ({ page }) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  await openEditor(page, PORT, p.id);
  await openSlide(page, 1);

  // 1. Canvas-first starts with the inspector drawer closed; inserting a shape shows the floating context bar.
  await expect(page.getByLabel('Inspector drawer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Shapes' }).click();
  await page.getByRole('menuitem', { name: 'Rectangle' }).click();

  const fbar = page.getByRole('toolbar', { name: 'Contextual format bar' });
  await expect(fbar).toBeVisible();

  // 2. Open the unified PaintPopover from Shape fill, switch Solid -> Linear, and inspect gradient stops.
  await fbar.getByRole('button', { name: 'Shape fill' }).click();
  const pop = page.getByRole('dialog', { name: 'Paint picker' });
  await expect(pop).toBeVisible();
  await expect(pop.getByText('Deck & Theme Swatches')).toBeVisible();
  await pop.getByRole('tab', { name: 'Linear' }).click();
  await expect(pop.getByText('Gradient Ramp')).toBeVisible();
  await expect(pop.getByText('Stop 1')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);

  // 3. Click 'More…' on the floating bar to slide open the Tune drawer, and verify the floating bar steps aside.
  await fbar.getByRole('button', { name: 'More object options' }).click();
  await expect(page.getByLabel('Inspector drawer')).toBeVisible();
  await expect(fbar).toHaveCount(0);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(page.getByLabel('Inspector drawer')).toHaveCount(0);

  // 4. Switch the bottom Stage view lens to Livestream (key) and verify simulated camera backdrop.
  const lens = page.getByRole('tablist', { name: 'Stage view lens' });
  await lens.getByRole('tab', { name: /Livestream/ }).click();
  await expect(page.locator('.ed-stage-lens')).toBeVisible();
  await expect(page.getByText('SIMULATED CAMERA FEED', { exact: true })).toBeVisible();
  await lens.getByRole('tab', { name: 'Canvas' }).click();
  await expect(page.locator('.canvasbox canvas').first()).toBeVisible();
});
