import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  ANNOUNCEMENT_TEXT,
  CHURCH,
  churchDeck,
  editorHub,
  importDeck,
  M4_PORT,
  openEditor,
  openSlide,
  saveAndReload,
  selectRange,
  selectText,
  slidesOf,
} from './editorhelpers.ts';
import { hubApi } from './linkhelpers.ts';
import { apiJson, liveEvent, type OutputRec, roleWindow } from './pptxlive.ts';

/**
 * M4 item G, the stage (apps/operator/src/views/editor/M4.md; design/27 §11 item 13, §6 "Bands, stage and
 * readable text"; design/16): a Hebrew line typed into the church deck's announcement in the editor (saved,
 * and after a reload the same presentation), the stage look's 'Notes' turned on in the look editor, and
 * then, live, the stage screen shows the live slide's notes in their own box under the next slide, clear
 * of the current lyrics, following the live slide, and draws the Hebrew line right to left beside the
 * English one, each paragraph taking its direction from its own text. Port 8907.
 */
const PORT = M4_PORT + 7;
const OUT = 'test-results/editor-stage';
const HEBREW = 'ברוכים הבאים!';

type Box = { x: number; y: number; width: number; height: number };
const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;

/** The direction a paragraph resolved to, and where its first and last characters were drawn. */
async function paragraph(stage: Page, region: string, text: string) {
  return stage.locator(`${region} .para`, { hasText: text }).evaluate((el) => {
    const node = el.firstChild as Text;
    const at = (i: number) => {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      return r.getBoundingClientRect();
    };
    const css = getComputedStyle(el);
    return {
      dir: el.getAttribute('dir'),
      rtl: el.matches(':dir(rtl)'),
      direction: css.direction,
      bidi: css.unicodeBidi,
      first: at(0).left,
      last: at(node.length - 1).left,
    };
  });
}

test('the stage shows the live slide’s notes and a Hebrew line right to left', async ({ page, context }) => {
  test.setTimeout(300_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await churchDeck(join(OUT, 'deck'));
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const p = await importDeck(a, deck);
    const slides = slidesOf(p);
    const note = slides[1]!.objects.find((o) => o.type === 'text' && o.text === ANNOUNCEMENT_TEXT)!;

    // ---- The editor: a Hebrew line added to the announcement, saved, and the same after a reload.
    await openEditor(page, PORT, p.id);
    await openSlide(page, 2);
    await selectText(page, note);
    await selectRange(page, ANNOUNCEMENT_TEXT.length, ANNOUNCEMENT_TEXT.length);
    await page.keyboard.press('Enter');
    await page.keyboard.type(HEBREW);
    const saved = await saveAndReload(page, a, p.id);
    const edited = slidesOf(saved)[1]!.objects.find((o) => o.id === note.id)!;
    expect(edited.text).toBe(`${ANNOUNCEMENT_TEXT}\n${HEBREW}`);
    expect(edited.runs?.filter((r) => r.end <= ANNOUNCEMENT_TEXT.length)).toEqual(
      note.runs?.filter((r) => r.end <= ANNOUNCEMENT_TEXT.length),
    );

    // A sermon's worth of notes on the photo slide (written through the API: the stage only reads them).
    const LONG = Array.from(
      { length: 60 },
      (_, i) => `Point ${i + 1}: tell the story of the new hall and thank the builders by name.`,
    ).join('\n');
    const withLong = structuredClone(saved);
    slidesOf(withLong)[3]!.notes = LONG;
    await apiJson(a, `presentations/${p.id}`, { put: withLong });

    // ---- The look editor: the stage look's 'Notes' on by default.
    await page.evaluate(() => {
      location.hash = '#/settings/looks';
    });
    await page.getByRole('button', { name: 'Stage', exact: true }).click();
    const notesOn = page.getByRole('checkbox', { name: /^Notes: show the live slide’s notes/ });
    await expect(notesOn).toBeChecked();
    // The default box is shown, under the next slide; nothing covers the lyrics.
    await expect(page.getByText('Notes box (default: under the next slide)')).toBeVisible();
    await expect(page.locator('[data-stage-notes] .banner')).toHaveCount(0);
    const looks = await apiJson<{ id: string; layers: { props: { notes?: boolean } } }[]>(
      a,
      'settings/looks',
    );
    expect(looks.find((l) => l.id === 'look-stage')?.layers.props.notes).toBe(true);

    // ---- Live: the deck in a playlist, the announcement on screen, the stage window open.
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: { name: 'Sunday', items: [{ id: 'deck', kind: 'presentation', presentationId: p.id }] },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    await liveEvent(a, { k: 'go', cueIndex: 1, at: Date.now() });
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const stage = await roleWindow(
      context,
      PORT,
      outs.find((o) => o.kind === 'stage')!,
      { width: 1920, height: 1080 },
      'test=1',
    );
    await stage.bringToFront();

    // The live slide's notes, in their own box under the next slide, clear of the current lyrics.
    const notes = stage.locator('.notes');
    await expect(notes).toHaveText(CHURCH.announcement.notes, { timeout: 30_000 });
    await expect(stage.locator('.current')).toContainText(HEBREW);
    const nb = (await notes.boundingBox())!;
    const cb = (await stage.locator('.current').boundingBox())!;
    expect(apart(nb, cb), 'the notes never cover the current lyrics').toBe(true);
    expect(nb.y).toBeGreaterThanOrEqual(cb.y + cb.height);
    expect(nb.y + nb.height).toBeLessThanOrEqual(1080);
    await stage.screenshot({ path: join(OUT, 'stage-announcement.png') });

    // The Hebrew line reads right to left (its first letter drawn right of its '!'); the English line
    // before it left to right; each paragraph takes its direction from its own text.
    const he = await paragraph(stage, '.current', HEBREW);
    expect(he).toMatchObject({ dir: 'auto', rtl: true, direction: 'rtl', bidi: 'plaintext' });
    expect(he.first, 'the Hebrew line runs right to left').toBeGreaterThan(he.last);
    const en = await paragraph(stage, '.current', CHURCH.announcement.second);
    expect(en).toMatchObject({ dir: 'auto', rtl: false, direction: 'ltr' });
    expect(en.first).toBeLessThan(en.last);

    // The notes follow the live slide.
    await liveEvent(a, { k: 'go', cueIndex: 2, at: Date.now() });
    await expect(notes).toHaveText(CHURCH.verses.notes);
    // Long notes are cut to the same box, never shrunk, their start in view and their cut end faded.
    await liveEvent(a, { k: 'go', cueIndex: 3, at: Date.now() });
    await expect(notes).toContainText('Point 1: tell the story');
    await expect(stage.locator('.notes-clip')).toHaveAttribute('data-cut', '1');
    expect(await notes.boundingBox()).toEqual(nb);
    const long = await stage.locator('.notes-clip').evaluate((clip) => {
      const first = clip.querySelector('.para')!;
      return {
        size: getComputedStyle(first).fontSize,
        startGap: first.getBoundingClientRect().top - clip.getBoundingClientRect().top,
      };
    });
    expect(long.size).toBe('32px');
    expect(long.startGap).toBeCloseTo(0, 0);
    await stage.screenshot({ path: join(OUT, 'stage-long-notes.png') });
    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
    await expect(notes).toHaveText(CHURCH.welcome.notes);
    await stage.close();
  } finally {
    hub.kill();
  }
});
