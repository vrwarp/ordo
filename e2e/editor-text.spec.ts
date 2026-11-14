import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import pptxgen from 'pptxgenjs';
import {
  editorHub,
  importDeck,
  type Obj,
  openEditor,
  openSlide,
  saveAndReload,
  selectRange,
  selectText,
  slidesOf,
} from './editorhelpers.ts';
import { portOf } from './ports.ts';
import { hubApi } from './linkhelpers.ts';
import { VERSE_TEXT, VERSES, zipParts } from './pptxdecks.ts';

/**
 * M4 item A, the text ops (apps/operator/src/views/editor/M4.md; design/27 §15 M4 exit), port row 'editor-text', on
 * synthetic decks:
 * - a typo fixed inside a bold coloured word of a shrink-to-fit box keeps the word's formatting and the
 *   box's text size (PowerPoint's stored fit scale);
 * - a theme applied to a scripture deck keeps its verse superscripts (the runs' structural formatting),
 *   while the deck's own faces and colours give way to the theme's.
 * Each ends in `saveAndReload`: after Save and a reload the presentation JSON is identical.
 */
const PORT = portOf('editor-text');
const OUT = 'test-results/editor-text';

const SHRINK = {
  before: 'Potluck lunch on ',
  date: 'Sunday 12 May',
  after: ' in the hall after the morning service',
  second: 'Bring a dish to share with everyone',
};
const SHRINK_TEXT = `${SHRINK.before}${SHRINK.date}${SHRINK.after}\n${SHRINK.second}`;

/**
 * One announcement slide whose box shrinks its text on overflow, with the stored scale PowerPoint writes
 * once it has fitted the text (85 % font, 10 % less line spacing), the date bold and red inside plain text.
 */
async function shrinkDeck(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const p = new pptxgen();
  p.layout = 'LAYOUT_WIDE';
  const s = p.addSlide();
  s.background = { color: 'FFFFFF' };
  s.addText(
    [
      { text: SHRINK.before },
      { text: SHRINK.date, options: { bold: true, color: 'C00000' } },
      { text: SHRINK.after, options: { breakLine: true } },
      { text: SHRINK.second },
    ],
    {
      x: 0.8,
      y: 1.5,
      w: 11.7,
      h: 1.6,
      fontFace: 'Calibri',
      fontSize: 44,
      color: '222222',
      valign: 'top',
      fit: 'shrink',
    },
  );
  const raw = join(dir, 'raw.pptx');
  writeFileSync(raw, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
  const parts = join(dir, 'parts');
  rmSync(parts, { recursive: true, force: true });
  execFileSync('unzip', ['-q', '-o', raw, '-d', parts]);
  const files = new Map<string, Uint8Array>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const f = join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else files.set(relative(parts, f).split('\\').join('/'), readFileSync(f));
    }
  };
  walk(parts);
  const slide = 'ppt/slides/slide1.xml';
  const xml = new TextDecoder().decode(files.get(slide)!);
  expect(xml).toContain('<a:normAutofit/>');
  files.set(
    slide,
    new TextEncoder().encode(
      xml.replace('<a:normAutofit/>', '<a:normAutofit fontScale="85000" lnSpcReduction="10000"/>'),
    ),
  );
  const file = join(dir, 'Shrink deck.pptx');
  writeFileSync(file, zipParts(files));
  return file;
}

const text = (s: { objects: Obj[] }, t: string) => s.objects.find((o) => o.type === 'text' && o.text === t)!;

test('a typo fixed inside a bold coloured date of a shrink-to-fit box keeps its formatting and its text size', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const out = join(OUT, 'shrink');
  rmSync(out, { recursive: true, force: true });
  const deck = await shrinkDeck(join(out, 'deck'));
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const p = await importDeck(a, deck);
    const slides = slidesOf(p);
    const box = text(slides[0]!, SHRINK_TEXT);
    expect(box, 'the announcement is one text box').toBeDefined();
    expect(box.style).toMatchObject({ autofit: 'shrink', fitScale: { font: 0.85, spacing: 0.9 } });
    const at = SHRINK.before.length;
    const bold = box.runs?.find((r) => r.start <= at && r.end >= at + SHRINK.date.length);
    expect(bold, 'the date is one bold red run').toMatchObject({ fontWeight: 700 });
    expect(bold!.color).toBeDefined();

    await openEditor(page, PORT, p.id);
    await openSlide(page, 1);
    await selectText(page, box);
    const two = at + 'Sunday 1'.length;
    await selectRange(page, two, two + 1);
    await page.keyboard.type('9');
    const saved = await saveAndReload(page, a, p.id);

    const fixed = slidesOf(saved)[0]!.objects.find((o) => o.id === box.id)!;
    expect(fixed.text).toBe(SHRINK_TEXT.replace('Sunday 12 May', 'Sunday 19 May'));
    // The date keeps its run (bold, red) and the box its style, the stored fit scale included: the text
    // is drawn at the size PowerPoint fitted it while it fits (textOps.test.ts proves the engine's side).
    expect(fixed.runs).toEqual(box.runs);
    expect(fixed.style).toEqual(box.style);
    expect(fixed.paras).toEqual(box.paras);
    // Nothing else changed.
    const before = new Map(slides[0]!.objects.map((o) => [o.id, o]));
    for (const o of slidesOf(saved)[0]!.objects) if (o.id !== box.id) expect(o).toEqual(before.get(o.id));
  } finally {
    hub.kill();
  }
});

/** Apply the library theme named `name` from the Presentation tab, confirming the dialog. */
async function applyThemeNamed(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Presentation', exact: true }).click();
  const select = page.locator('label.field', { hasText: 'Theme' }).locator('select');
  await select.selectOption({ label: name });
  await page.getByRole('button', { name: 'Apply…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Apply “${name}”`);
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * A scripture deck as worship teams set one: John 3:16-17 with raised, bold, red verse numbers, one word in
 * italics, the deck's face on the box; a second slide with a plain heading.
 */
async function scriptureDeck(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const p = new pptxgen();
  p.layout = 'LAYOUT_WIDE';
  const s = p.addSlide();
  s.background = { color: 'F2EFE6' };
  s.addText(
    VERSES.flatMap(([n, t], i) => {
      const [head, word, tail] = i === 0 ? t.split(/(only)/) : [t, '', ''];
      const last = i === VERSES.length - 1 ? {} : { breakLine: true };
      return [
        { text: n, options: { superscript: true, bold: true, color: 'C00000' } },
        { text: head!, options: word ? {} : last },
        ...(word
          ? [
              { text: word, options: { italic: true } },
              { text: tail!, options: last },
            ]
          : []),
      ];
    }),
    { x: 0.8, y: 1.2, w: 11.7, h: 5, fontFace: 'Georgia', fontSize: 44, color: '222222', valign: 'top' },
  );
  s.addNotes(SCRIPTURE_NOTES);
  const h = p.addSlide();
  h.addText('The Gospel of John', { x: 0.8, y: 2.5, w: 11.7, h: 2, fontFace: 'Georgia', fontSize: 54 });
  const file = join(dir, 'Scripture deck.pptx');
  writeFileSync(file, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
  return file;
}
const SCRIPTURE_NOTES = 'Read slowly.';

test('a theme applied to a scripture deck keeps its verse superscripts', async ({ page }) => {
  test.setTimeout(240_000);
  const out = join(OUT, 'theme');
  rmSync(out, { recursive: true, force: true });
  const deck = await scriptureDeck(join(out, 'deck'));
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const p = await importDeck(a, deck);
    const verses = slidesOf(p)[0]!;
    const lyric = verses.objects.find((o) => o.type === 'text')!;
    expect(lyric.text).toBe(VERSE_TEXT);
    // The verse numbers start each paragraph: raised, bold and red; one word is in italics.
    const starts: number[] = [];
    let at = 0;
    for (const [n, t] of VERSES) {
      starts.push(at);
      at += n.length + t.length + 1;
    }
    const runAt = (o: Obj, i: number) => o.runs?.find((r) => r.start <= i && i < r.end);
    for (const s of starts)
      expect(runAt(lyric, s), `verse number at ${s}`).toMatchObject({ baseline: 0.3, fontWeight: 700 });
    for (const s of starts) expect(runAt(lyric, s)!.color).toBeDefined();
    const only = VERSE_TEXT.indexOf('only');
    expect(runAt(lyric, only)).toMatchObject({ fontStyle: 'italic' });

    await openEditor(page, PORT, p.id);
    await openSlide(page, 1);
    await applyThemeNamed(page, 'Default');
    const saved = await saveAndReload(page, a, p.id);

    expect(saved.themeId).toBe('theme-default');
    const themed = slidesOf(saved)[0]!.objects.find((o) => o.id === lyric.id)!;
    expect(themed.text).toBe(lyric.text);
    // Every verse number is still raised and bold, the italic word still italic, the paragraph styles
    // kept; the theme's face, colour and size replace the deck's, on the box and on every run.
    for (const s of starts) {
      expect(runAt(themed, s)).toMatchObject({ baseline: 0.3, fontWeight: 700 });
      expect(runAt(themed, s)!.color).toBeUndefined();
    }
    expect(runAt(themed, only)).toMatchObject({ fontStyle: 'italic' });
    for (const r of themed.runs ?? []) {
      expect(r.fontFamily).toBeUndefined();
      expect(r.color).toBeUndefined();
      expect(r.sizeScale).toBeUndefined();
    }
    expect(themed.paras).toEqual(lyric.paras);
    expect(themed.style!.fontFamily).not.toBe(lyric.style!.fontFamily);
    expect(themed.style!.color).not.toEqual(lyric.style!.color);
    expect(slidesOf(saved).map((s) => s.notes)).toEqual(slidesOf(p).map((s) => s.notes));
    expect(slidesOf(saved)[0]!.notes).toBe(SCRIPTURE_NOTES);
  } finally {
    hub.kill();
  }
});
