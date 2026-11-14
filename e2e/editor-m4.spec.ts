import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  ANNOUNCEMENT_TEXT,
  CHURCH,
  churchDeck,
  editorHub,
  importDeck,
  openEditor,
  openSlide,
  saveAndReload,
  selectRange,
  selectText,
  slidesOf,
} from './editorhelpers.ts';
import { portOf } from './ports.ts';

const PORT = portOf('editor-m4');
import { hubApi } from './linkhelpers.ts';

/**
 * The M4 editor specs' common path (apps/operator/src/views/editor/M4.md; design/27 §15 M4 exit), on the
 * editor as M3 left it: the church deck imported as editable slides carries where each object came from
 * (`origin`: a shape and its text as one group), and a typo fixed inside its bold coloured date keeps the
 * date's formatting and its text size through Save and a reload, with the presentation JSON identical.
 * Each M4 item adds its own spec with the same helpers and a row of its own in e2e/ports.ts.
 */
const OUT = 'test-results/editor-m4';

test('an imported church deck: fix a typo inside a bold coloured date, save, reload, same presentation', async ({
  page,
}) => {
  test.setTimeout(240_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await churchDeck(join(OUT, 'deck'));
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const p = await importDeck(a, deck);
    const slides = slidesOf(p);
    expect(slides).toHaveLength(6);
    expect(slides.map((s) => s.pptx?.class)).toEqual(Array(6).fill('native'));
    expect(slides[5]!.hidden).toBe(true);
    expect(slides.map((s) => s.notes)).toEqual([
      CHURCH.welcome.notes,
      CHURCH.announcement.notes,
      CHURCH.verses.notes,
      CHURCH.photo.notes,
      CHURCH.pair.notes,
      CHURCH.hidden.notes,
    ]);
    // Every imported object says where it came from; the rounded box and its text are one group.
    for (const s of slides) for (const o of s.objects) expect(o.origin?.src, `${s.id} ${o.id}`).toBe('pptx');
    const pair = slides[4]!.objects.filter((o) => o.origin?.shapeId !== undefined && o.origin.role !== 'bg');
    expect(pair.map((o) => o.type).sort()).toEqual(['shape', 'text']);
    expect(pair[0]!.origin!.group).toBeDefined();
    expect(pair[1]!.origin!.group).toBe(pair[0]!.origin!.group);

    const note = slides[1]!.objects.find((o) => o.type === 'text' && o.text === ANNOUNCEMENT_TEXT)!;
    const dateAt = CHURCH.announcement.before.length;
    const dateEnd = dateAt + CHURCH.announcement.date.length;
    const bold = note.runs?.find((r) => r.start <= dateAt && r.end >= dateEnd && r.fontWeight === 700);
    expect(bold, 'the date is a bold run').toBeDefined();
    const style = { ...note.style };

    // ---- The editor: the announcement slide, its text box, the typo '12' → '19' typed over the '2'.
    await openEditor(page, PORT, p.id);
    await openSlide(page, 2);
    await selectText(page, note);
    const two = dateAt + 'Sunday 1'.length;
    await selectRange(page, two, two + 1);
    await page.keyboard.type('9');
    const saved = await saveAndReload(page, a, p.id);

    const fixed = slidesOf(saved)[1]!.objects.find((o) => o.id === note.id)!;
    expect(fixed.text).toBe(ANNOUNCEMENT_TEXT.replace('Sunday 12 May', 'Sunday 19 May'));
    // The date keeps its formatting (bold, colour: the same run) and the box its style and text size.
    expect(fixed.runs).toEqual(note.runs);
    expect(fixed.style).toEqual(style);
    // Nothing else changed: every other slide is as imported.
    for (const [i, s] of slidesOf(saved).entries()) if (i !== 1) expect(s).toEqual(slides[i]);
  } finally {
    hub.kill();
  }
});
