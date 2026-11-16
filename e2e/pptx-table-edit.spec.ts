import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import {
  canvasPoint,
  type EditorInspect,
  editorState,
  frames,
  opOrigin,
  openEditor,
  type PresentationRec,
  SECOND_PRESS_MS,
  save,
  slidesOf,
  stored,
  tableKitReady,
} from './editorhelpers.ts';
import { hubApi, login } from './linkhelpers.ts';
import type { Pixels } from './png.ts';
import { TABLE, tableCellCentre, tableCellText, tableDeck } from './pptxdecks.ts';
import { portOf } from './ports.ts';
import {
  apiJson,
  cacheReady,
  capture,
  liveEvent,
  type OutputRec,
  pptxHub,
  roleWindow,
  settledOn,
  telemetryOf,
} from './pptxlive.ts';

/**
 * A PowerPoint table imported, edited cell by cell and shown live (wave r2b sub-wave 1's integration: tables-conv
 * and editor-table together), port row 'pptx-table-edit', a hub without LibreOffice (`ORDO_LIBREOFFICE=off`):
 * the table deck (`pptxdecks.ts` `tableDeck`) dropped on the Import tab in 'Editable' mode, its bulletin one table
 * object (159 cells, past M6's 150-cell cap: before tables-conv a hub without LibreOffice listed it missing);
 * in the editor a click on the table and one on a cell select that cell, a double-click edits it on the canvas
 * and typing adds to its text (before editor-table a table took no typing), Save; live, the Audience window
 * draws the typed words in the cell, right of the words it had.
 */
const PORT = portOf('pptx-table-edit');
const OUT = 'test-results/pptx-table-edit';
/** The bulletin's body cell edited: row 5 (under the header), the Service column. */
const ROW = 5;
const COL = 2;
const TYPED = ' with the whole church';

type Cell = { text?: string };
type Table = { cells: Cell[] };
type Obj = { id: string; type: string; table?: Table };
type State = EditorInspect & { cell?: number; inline?: { objectId: string; cell?: number } };
type Job = { id: string; kind: string; state: string; log: string[]; result?: { presentationId: string } };

/** A hub without LibreOffice on `port` (the variable set for its start only). */
async function liteHub(port: number) {
  const before = process.env.ORDO_LIBREOFFICE;
  process.env.ORDO_LIBREOFFICE = 'off';
  try {
    return await pptxHub(port);
  } finally {
    if (before === undefined) delete process.env.ORDO_LIBREOFFICE;
    else process.env.ORDO_LIBREOFFICE = before;
  }
}

/** The bulletin slide's one table object. */
function bulletinTable(p: Pick<PresentationRec, 'sections'>): Obj {
  const objects = slidesOf(p)[0]!.objects as unknown as Obj[];
  const tables = objects.filter((o) => o.type === 'shape' && o.table);
  expect(tables, 'the bulletin is one table object').toHaveLength(1);
  return tables[0]!;
}

/** Dark pixels (text ink on the white cells) in a rectangle of logical px. */
function ink(img: Pixels, [x0, y0, x1, y1]: [number, number, number, number]): number {
  let n = 0;
  const sx = img.width / 1920;
  const sy = img.height / 1080;
  for (let y = Math.round(y0 * sy); y < Math.round(y1 * sy); y++)
    for (let x = Math.round(x0 * sx); x < Math.round(x1 * sx); x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i]! + img.data[i + 1]! + img.data[i + 2]! < 300) n++;
    }
  return n;
}

/** Every job of the hub done (the import). */
async function settled(a: APIRequestContext): Promise<Job[]> {
  let jobs: Job[] = [];
  await expect
    .poll(
      async () => {
        const r = (await (await a.get('jobs')).json()) as Job[] | { jobs: Job[] };
        jobs = Array.isArray(r) ? r : r.jobs;
        return jobs.length > 0 && jobs.every((j) => j.state === 'done' || j.state === 'failed');
      },
      { timeout: 240_000 },
    )
    .toBe(true);
  return jobs;
}

const state = (page: Page) => editorState(page) as Promise<State>;

test('a PowerPoint table imported on a hub without LibreOffice, a cell edited on the canvas, live on the Audience screen', async ({
  context,
  page,
}) => {
  test.setTimeout(300_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await tableDeck(OUT);
  const hub = await liteHub(PORT);
  try {
    const a = await hubApi(PORT);

    // 1. The Import tab, 'Editable': parsed in the browser, the hub builds the presentation.
    await login(page, opOrigin(PORT));
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    await expect(page.getByText(/anything it cannot draw is listed on the import card/)).toBeVisible({
      timeout: 30_000,
    });
    await page.locator('input[name="pptx-import-mode"][value="native"]').check();
    await page.locator('input[type=file][accept*=".pptx"]').setInputFiles(deck);
    await expect(
      page
        .locator('[data-pptx-import]')
        .first()
        .getByText(/^done$/),
    ).toBeVisible({
      timeout: 120_000,
    });
    const native = (await settled(a)).find((j) => j.kind === 'pptx-native')!;
    const id = (await apiJson<Job>(a, `jobs/${native.id}`)).result!.presentationId;
    const imported = await stored(a, id);
    const table = bulletinTable(imported);
    const cell = table.table!.cells.findIndex((c) => c.text === tableCellText(ROW, COL));
    expect(cell, 'the edited cell').toBeGreaterThan(0);

    // 2. The editor: a click selects the table, a click on it selected selects the cell under it (the canvas's
    // table kit waited for once), a double-click edits the cell; End and typing add to its text.
    await openEditor(page, PORT, id);
    await frames(page);
    const [cx, cy] = tableCellCentre(ROW, COL);
    const at = await canvasPoint(page, cx, cy);
    await tableKitReady(page);
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await state(page)).objectId).toBe(table.id);
    await page.waitForTimeout(SECOND_PRESS_MS);
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await state(page)).cell).toBe(cell);
    await page.waitForTimeout(SECOND_PRESS_MS);
    await page.mouse.dblclick(at.x, at.y);
    await expect(page.getByTestId('ordo-inline-canvas-editor')).toBeVisible();
    await expect.poll(async () => (await state(page)).inline).toEqual({ objectId: table.id, cell });
    await expect(page.locator('#ordo-text-editor')).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(TYPED);
    const want = `${tableCellText(ROW, COL)}${TYPED}`;
    await expect
      .poll(async () => bulletinTable((await state(page)).draft!).table!.cells[cell]!.text)
      .toBe(want);
    await page.keyboard.press('Escape');
    await save(page);
    expect(bulletinTable(await stored(a, id)).table!.cells[cell]!.text).toBe(want);

    // 3. Live: the Audience window draws the typed words in the cell, right of the words it had (empty white
    // before the edit: the words had about 150 px of the column's 648).
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: { name: 'Bulletin', items: [{ id: 'deck', kind: 'presentation', presentationId: id }] },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const rec = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
    const w = await roleWindow(context, PORT, rec, { width: 1920, height: 1080 }, 'renderer=2d');
    try {
      await cacheReady(w);
      await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
      await settledOn(w, 0);
      const left = (TABLE.x + TABLE.cols[0] + TABLE.cols[1]) * 144;
      const half = (TABLE.rowH * 144) / 2;
      const words: [number, number, number, number] = [left, cy - half, left + 170, cy + half];
      const added: [number, number, number, number] = [left + 190, cy - half, left + 420, cy + half];
      await expect
        .poll(
          async () => {
            const shot = await capture(w, join(OUT, 'audience.png'));
            return { words: ink(shot, words) > 40, added: ink(shot, added) > 40 };
          },
          { timeout: 30_000, message: 'Audience draws the cell with its typed words' },
        )
        .toEqual({ words: true, added: true });
      expect((await telemetryOf(w)).error ?? '').toBe('');
    } finally {
      await liveEvent(a, { k: 'endService', at: Date.now() });
      await w.close();
    }
  } finally {
    hub.kill();
  }
});
