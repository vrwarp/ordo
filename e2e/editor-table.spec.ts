import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { m9Table } from '../packages/domain/src/m9.test-util.ts';
import {
  canvasPoint,
  editorHub,
  type EditorInspect,
  editorState,
  frames,
  openEditor,
  type PresentationRec,
  SECOND_PRESS_MS,
  save,
  slidesOf,
  stored,
  tableKitReady,
} from './editorhelpers.ts';
import { hubApi } from './linkhelpers.ts';
import type { Pixels } from './png.ts';
import { portOf } from './ports.ts';
import {
  apiJson,
  cacheReady,
  capture,
  liveEvent,
  type OutputRec,
  roleWindow,
  settledOn,
} from './pptxlive.ts';

/**
 * A table edited cell by cell (design/15 "Table editing"), port row 'editor-table': an order of service made as
 * an M9 table through the hub API (`m9Table()`, as bottom-third-m9.spec.ts makes one), then in the editor a
 * double-click on a cell and typing in it, Tab to the next cell (its text replaced), 'Row below' and 'Cell fill'
 * from the table bar, Save; the presentation goes live and the Audience screen draws the new fill and the new
 * row; Find finds the typed text in its cell; undo takes every edit back, one step each. Then the Presenter
 * Notes Studio over a selected cell and over a selected text box: the canvas is not shown there, so its keys
 * leave the hidden slide alone.
 */
const PORT = portOf('editor-table');
const OUT = 'test-results/editor-table';
const white = { r: 255, g: 255, b: 255, a: 1 };
const GREEN = { r: 0, g: 176, b: 80 };
const BOX = { x: 120, y: 160, w: 1320, h: 410, rotation: 0 };

/** The fixture table in the hub's bundled Inter (the output's page waits for every face it was sent). */
function interTable() {
  const t = m9Table();
  t.base = { ...t.base, fontFamily: 'Inter' };
  t.styles = t.styles?.map(({ fontFamily: _f, fallbackFonts: _fb, ...s }) => s);
  t.runStyles = t.runStyles?.map(({ fontFamily: _f, ...s }) => s);
  return t;
}

type Cell = { text?: string; fill?: number };
type Table = { rows: number[]; cells: Cell[]; fills?: { color: { r: number; g: number; b: number } }[] };
type State = EditorInspect & { cell?: number; inline?: { objectId: string; cell?: number } };

const tableOf = (p: Pick<PresentationRec, 'sections'>) =>
  (slidesOf(p)[0]!.objects[0] as unknown as { table: Table }).table;
const state = (page: Page) => editorState(page) as Promise<State>;
const draftTable = async (page: Page) => tableOf((await state(page)).draft!);

/** Pixels of `img` within `tol` of `c` in the rect (x, y, w, h) of slide coordinates (1920x1080). */
function near(img: Pixels, rect: [number, number, number, number], c: typeof GREEN, tol = 40): number {
  const k = img.width / 1920;
  let n = 0;
  for (let y = Math.round(rect[1] * k); y < Math.round((rect[1] + rect[3]) * k); y++)
    for (let x = Math.round(rect[0] * k); x < Math.round((rect[0] + rect[2]) * k); x++) {
      const i = (y * img.width + x) * 4;
      const d =
        Math.abs(img.data[i]! - c.r) + Math.abs(img.data[i + 1]! - c.g) + Math.abs(img.data[i + 2]! - c.b);
      if (d <= tol) n++;
    }
  return n;
}

test('a table cell typed in, Tab, a row below and a fill, saved, live on the Audience screen, found and undone', async ({
  context,
  page,
}) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const p = await apiJson<{ id: string }>(a, 'presentations', {
      post: {
        title: 'Order of service',
        kind: 'slides',
        sections: [
          {
            id: 'sec',
            label: 'Order',
            short: 'O',
            slides: [
              {
                id: 'order',
                objects: [
                  {
                    id: 'table',
                    type: 'shape',
                    box: BOX,
                    shape: 'rect',
                    fill: white,
                    opacity: 1,
                    radius: 0,
                    table: interTable(),
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const original = tableOf(await stored(a, p.id));
    await openEditor(page, PORT, p.id);
    await frames(page);

    // 'Leader' (cell 2) sits in the header row's last column: x 1140-1440, y 160-230 of the slide.
    const leader = await canvasPoint(page, 1290, 195);
    // A click selects the table; a click on the table selected selects the cell under it (the canvas's table
    // kit, loaded with the first table, waited for once).
    await tableKitReady(page);
    await page.mouse.click(leader.x, leader.y);
    await expect.poll(async () => (await state(page)).objectId).toBe('table');
    await page.waitForTimeout(SECOND_PRESS_MS);
    await page.mouse.click(leader.x, leader.y);
    await expect.poll(async () => (await state(page)).cell).toBe(2);
    expect((await state(page)).objectId).toBe('table');
    await page.waitForTimeout(SECOND_PRESS_MS);
    const fbar = page.getByRole('toolbar', { name: 'Contextual format bar' });
    await expect(fbar.getByText('Row 1, column 4')).toBeVisible();

    // 1. A double-click edits the cell on the canvas; End and typing add to its text.
    await page.mouse.dblclick(leader.x, leader.y);
    await expect(page.getByTestId('ordo-inline-canvas-editor')).toBeVisible();
    await expect.poll(async () => (await state(page)).inline).toEqual({ objectId: 'table', cell: 2 });
    await expect(page.locator('#ordo-text-editor')).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' (all)');
    await expect.poll(async () => (await draftTable(page)).cells[2]!.text).toBe('Leader (all)');

    // 2. Tab: the next cell ('10:00', the next row's first), its text selected, so typing replaces it.
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await state(page)).inline).toEqual({ objectId: 'table', cell: 3 });
    await page.keyboard.type('9:55');
    await expect.poll(async () => (await draftTable(page)).cells[3]!.text).toBe('9:55');
    expect((await draftTable(page)).cells[2]!.text).toBe('Leader (all)');

    // 3. Row below (the table bar's Rows & columns): a row under the cell's, the table one row taller.
    await fbar.getByRole('button', { name: 'Rows & columns' }).click();
    await page.getByRole('menuitem', { name: 'Row below' }).click();
    await expect.poll(async () => (await draftTable(page)).rows.length).toBe(original.rows.length + 1);
    expect((await state(page)).cell).toBe(3);

    // 4. Cell fill: the selected cell green.
    await fbar.getByRole('button', { name: 'Cell fill' }).click();
    const pop = page.getByRole('dialog', { name: 'Paint picker' });
    await expect(pop).toBeVisible();
    await pop.getByRole('tab', { name: 'Solid' }).click();
    await pop.getByLabel('Hex color value').fill('#00b050');
    await pop.getByLabel('Hex color value').press('Enter');
    await expect
      .poll(async () => {
        const t = await draftTable(page);
        const k = t.cells[3]!.fill;
        return k === undefined ? undefined : t.fills?.[k]?.color;
      })
      .toMatchObject(GREEN);
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);

    // 5. Save: the hub has every edit.
    await save(page);
    const saved = tableOf(await stored(a, p.id));
    expect(saved.cells[2]!.text).toBe('Leader (all)');
    expect(saved.cells[3]!.text).toBe('9:55');
    expect(saved.rows).toHaveLength(original.rows.length + 1);

    // 6. Go live: the Audience screen draws the green cell and the new row (the last row, 'Benediction', moves
    // down by a row: where the slide was black under the table, the table's white is drawn).
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: {
        name: `Table ${Date.now()}`,
        items: [{ id: 'order', kind: 'presentation', presentationId: p.id }],
      },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const audience = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
    const w = await roleWindow(context, PORT, audience, { width: 960, height: 540 }, 'renderer=2d');
    await cacheReady(w);
    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
    await settledOn(w, 0);
    const shot = await capture(w, `${OUT}/audience.png`);
    // Cell 3 is in the table's first column (x 120-300) and second row (from y 230).
    expect(near(shot, [140, 240, 140, 40], GREEN), 'the green cell').toBeGreaterThan(400);
    // Below the old bottom edge (y 570), inside the table's width: white now, where the slide was black.
    expect(near(shot, [400, 590, 600, 40], { r: 255, g: 255, b: 255 }), 'the new row').toBeGreaterThan(2000);
    await liveEvent(a, { k: 'endService', at: Date.now() });
    await w.close();

    // 7. Find finds the typed text, in its cell.
    await page.bringToFront();
    await page.getByTitle('Find and replace (Ctrl+F)').first().click();
    await page.getByPlaceholder('Search deck text…').fill('(all)');
    await expect(page.locator('[data-find-count]')).toHaveText('1 match on 1 slide.');
    await expect(page.locator('[data-find-row]')).toContainText('Leader (all)');
    await page.keyboard.press('Escape');

    // 8. Undo takes the fill, the row, the replaced cell and the typing back, one step each.
    await page.getByTitle('Undo (Ctrl+Z)').first().click();
    await expect.poll(async () => (await draftTable(page)).cells[3]!.fill).toBe(original.cells[3]!.fill);
    await page.getByTitle('Undo (Ctrl+Z)').first().click();
    await expect.poll(async () => (await draftTable(page)).rows.length).toBe(original.rows.length);
    await page.getByTitle('Undo (Ctrl+Z)').first().click();
    await expect.poll(async () => (await draftTable(page)).cells[3]!.text).toBe('10:00');
    await page.getByTitle('Undo (Ctrl+Z)').first().click();
    await expect.poll(async () => (await draftTable(page)).cells[2]!.text).toBe('Leader');
    expect(await draftTable(page)).toEqual(original);
  } finally {
    hub.kill();
  }
});

test('the Presenter Notes Studio over a selected cell or text box: the canvas keys leave the hidden slide alone', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const textBox = { x: 120, y: 700, w: 900, h: 200, rotation: 0 };
    const p = await apiJson<{ id: string }>(a, 'presentations', {
      post: {
        title: 'Order of service, with notes',
        kind: 'slides',
        sections: [
          {
            id: 'sec',
            label: 'Order',
            short: 'O',
            slides: [
              {
                id: 'order',
                notes: 'Preach grace',
                objects: [
                  {
                    id: 'table',
                    type: 'shape',
                    box: BOX,
                    shape: 'rect',
                    fill: white,
                    opacity: 1,
                    radius: 0,
                    table: interTable(),
                  },
                  {
                    id: 'words',
                    type: 'text',
                    box: textBox,
                    text: 'Welcome',
                    style: { fontFamily: 'Inter', fontSizePx: 64, color: white },
                    opacity: 1,
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
    await frames(page);
    const before = slidesOf((await state(page)).draft!)[0]!.objects;
    const studio = page.locator('[data-deck-notes-studio]');
    /** The slide as the editor holds it, and the selection. */
    const held = async () => {
      const s = await state(page);
      return {
        objects: slidesOf(s.draft!)[0]!.objects,
        objectId: s.objectId,
        cell: s.cell,
        inline: s.inline,
      };
    };
    // Every key the slide canvas takes for a selection: the table's (Tab, the arrows, Enter, Escape), a nudge,
    // Delete and Backspace, duplicate and cut (design/15 "Table editing", "Keyboard").
    const KEYS = [
      'Tab',
      'Shift+Tab',
      'ArrowRight',
      'ArrowDown',
      'Shift+ArrowLeft',
      'Enter',
      'Escape',
      'Delete',
      'Backspace',
      'Control+d',
      'Control+x',
    ];
    const pressInStudio = async (want: { objectId: string; cell?: number }) => {
      for (const key of KEYS) {
        await page.keyboard.press(key);
        await frames(page);
        const h = await held();
        expect(h.objects, `${key} in the studio: the slide unchanged`).toEqual(before);
        expect(
          { objectId: h.objectId, cell: h.cell, inline: h.inline },
          `${key}: the selection unchanged`,
        ).toEqual({
          ...want,
          inline: undefined,
        });
        await expect(studio, `${key}: the studio still shown`).toHaveCount(1);
      }
    };

    // 1. Cell 2 selected on the canvas, then the dock's Manuscript Studio: the button goes away with the canvas,
    // so the focus falls to the page, where the window's key handler reads keys as the canvas's.
    const leader = await canvasPoint(page, 1290, 195);
    await tableKitReady(page);
    await page.mouse.click(leader.x, leader.y);
    await expect.poll(async () => (await state(page)).objectId).toBe('table');
    await page.waitForTimeout(SECOND_PRESS_MS);
    await page.mouse.click(leader.x, leader.y);
    await expect.poll(async () => (await state(page)).cell).toBe(2);
    await page.waitForTimeout(SECOND_PRESS_MS);
    await expect(page.locator('[data-notes-dock]')).toHaveAttribute('data-notes-dock', 'expanded');
    await page.getByRole('button', { name: /Manuscript Studio/ }).click();
    await expect(studio).toHaveCount(1, { timeout: 20_000 });
    await pressInStudio({ objectId: 'table', cell: 2 });

    // 2. Back on the canvas the keys are the canvas's again: Tab moves to the next cell.
    await page
      .getByRole('button', { name: /Slide Canvas/ })
      .first()
      .click();
    await expect(studio).toHaveCount(0);
    await frames(page);
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await state(page)).cell).toBe(3);

    // 3. The text box selected, then the slide list's Presenter Notes: no nudge, no delete, no copy.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const words = await canvasPoint(page, textBox.x + textBox.w / 2, textBox.y + textBox.h / 2);
    await page.mouse.click(words.x, words.y);
    await expect.poll(async () => (await state(page)).objectId).toBe('words');
    await page
      .getByRole('button', { name: /Presenter Notes/ })
      .first()
      .click();
    await expect(studio).toHaveCount(1, { timeout: 20_000 });
    await pressInStudio({ objectId: 'words' });
  } finally {
    hub.kill();
  }
});
