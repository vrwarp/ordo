import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import {
  canvasPoint,
  type EditorInspect,
  editorState,
  frames,
  opOrigin,
  openEditor,
  openSlide,
  SECOND_PRESS_MS,
  save,
  tableKitReady,
} from './editorhelpers.ts';
import { hubApi, login } from './linkhelpers.ts';
import type { Pixels } from './png.ts';
import { PLAN, TABLE, tableCellCentre, tableDeck } from './pptxdecks.ts';
import { portOf } from './ports.ts';
import {
  apiJson,
  at,
  cacheReady,
  capture,
  importPptx,
  liveEvent,
  type OutputRec,
  pptxHub,
  type RGB,
  roleWindow,
  settledOn,
  telemetryOf,
} from './pptxlive.ts';

/**
 * PowerPoint tables imported as one table object, end to end (design/27 §15 M9 "The table object imported",
 * tables-conv, tables-flip). The deck (`pptxdecks.ts` `tableDeck`, written by pptxgenjs) has two table-only
 * slides: a 159-cell bulletin with a navy header row and a merged cell, past M6's 150-cell cap, so before the
 * table object LibreOffice's art drew it on a hub with LibreOffice and a hub without it listed it missing; and a
 * 140-cell reading plan, within the cap but past 64 KB as its M6 group, which sub-wave 1's interim rule kept as
 * LibreOffice's page on a hub with LibreOffice. Every table is the table object on every kind of hub (the owner's
 * answer to question 3 of the LibreOffice inventory, 2026-11-15). On three hubs of the 'pptx-tables' row:
 * - **port 0, without LibreOffice** (`ORDO_LIBREOFFICE=off`): the deck dropped on the Import tab in 'Editable'
 *   mode, parsed in the operator, version 1 built by the hub from the browser's scene;
 * - **port 1, without LibreOffice**: the same deck through the upload route, parsed by the hub;
 * - **port 2, with LibreOffice**: the upload route; both slides the table object here too, nothing waiting for
 *   LibreOffice (no follow-up), no slide noting LibreOffice's page, and the reading plan's cells editable in the
 *   editor (a double-click on a cell, typing, Save).
 * Each: both slides stored as table objects, nothing missing in the import report; live, the Audience window
 * shows the bulletin's header fill and its text, the Lobby and the Bottom-Third Stream draw no band of its cells
 * (a slide whose only text is a table has no strap), and the Stage shows the deck's title, not its cells.
 */
const TAB_PORT = portOf('pptx-tables', 0);
const UPLOAD_PORT = portOf('pptx-tables', 1);
const LO_PORT = portOf('pptx-tables', 2);
const OUT = 'test-results/pptx-tables';
/** Channel difference allowed between the header's fill and what is drawn at a header cell's centre. */
const TOL = 12;
/** The note sub-wave 1's interim rule gave a table slide kept as LibreOffice's page: no slide carries it now. */
const PAGE_NOTE = 'its tables as shapes would be over 64 KB: LibreOffice draws its page';
/** Any note of a slide kept as LibreOffice's page for its size (`ImportCore.pageForBudget`). */
const PAGE = /LibreOffice draws its page/;

type Job = { id: string; kind: string; state: string; log: string[]; result?: { presentationId: string } };
type Table = { cells: { text?: string; colSpan?: number }[]; fills?: unknown[] };
type Obj = { id: string; type: string; table?: Table };
type StoredSlide = {
  id: string;
  objects: Obj[];
  pptx?: { class?: string; missing?: string[]; pending?: boolean; notes?: string[]; artText?: string };
  imported?: { imageMediaId?: string };
};
type Presentation = { id: string; title: string; sections: { slides: StoredSlide[] }[] };

const close = (got: RGB, want: readonly [number, number, number]) =>
  got.every((v, k) => Math.abs(v - want[k]!) <= TOL);

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

/** Every job of the hub done (the import and its follow-ups: version 2 where a slide waits for LibreOffice). */
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

/** The slide's one table object. */
function tableOf(s: StoredSlide): Table {
  const tables = s.objects.filter((o) => o.type === 'shape' && o.table);
  expect(tables, 'one table object').toHaveLength(1);
  return tables[0]!.table!;
}

/**
 * The stored deck as the rule says, on every kind of hub: the bulletin one native table object (159 cells, the
 * merge, the header's fill), the reading plan one native table object (140 cells), nothing missing or waiting,
 * no note of LibreOffice's page. Returns the presentation.
 */
async function storedAsTheRuleSays(a: APIRequestContext, id: string): Promise<Presentation> {
  const p = await apiJson<Presentation>(a, `presentations/${id}`);
  const slides = p.sections.flatMap((s) => s.slides);
  expect(slides).toHaveLength(2);
  const [bulletin, plan] = slides as [StoredSlide, StoredSlide];
  expect(bulletin.pptx?.class).toBe('native');
  expect(bulletin.pptx?.missing ?? [], 'the import report lists nothing missing').toEqual([]);
  expect(bulletin.pptx?.pending).toBeUndefined();
  const t = tableOf(bulletin);
  expect(t.cells).toHaveLength(TABLE.rows * TABLE.cols.length - 1);
  expect(t.cells.filter((c) => c.colSpan === 2)).toHaveLength(1);
  expect(t.cells.slice(0, 5).map((c) => c.text)).toEqual([...TABLE.headerText]);
  expect(t.fills?.length ?? 0, "the header's fill").toBeGreaterThan(0);
  expect(plan.pptx?.missing ?? []).toEqual([]);
  expect(plan.pptx?.pending, 'nothing waits for LibreOffice').toBeUndefined();
  expect(plan.pptx?.class).toBe('native');
  expect(tableOf(plan).cells).toHaveLength(PLAN.rows * PLAN.cols);
  expect(plan.imported, "no LibreOffice's page").toBeUndefined();
  for (const s of [bulletin, plan]) {
    expect(s.pptx?.notes ?? []).not.toContain(PAGE_NOTE);
    expect((s.pptx?.notes ?? []).filter((n) => PAGE.test(n))).toEqual([]);
  }
  return p;
}

/** The reading plan's cell edited on port 2: row 1, column 2 (from 0: the first row, the second column). */
const PLAN_ROW = 0;
const PLAN_COL = 1;
const PLAN_TYPED = ' and Psalm 119';

/**
 * The reading plan's cells are editable: in the editor (slide 2) a click selects the table, a click on it selected
 * selects the cell, a double-click edits it on the canvas, and typing adds to its text; Save stores it.
 */
async function planCellEdited(
  page: Page,
  port: number,
  a: APIRequestContext,
  p: Presentation,
): Promise<void> {
  const plan = p.sections.flatMap((s) => s.slides)[1]!;
  const obj = plan.objects.find((o) => o.type === 'shape' && o.table)!;
  const text = `Day ${PLAN_ROW + 1}: Psalm ${PLAN_ROW * PLAN.cols + PLAN_COL + 1}, verses ${PLAN_COL + 1}-${PLAN_COL + 9}`;
  const cell = obj.table!.cells.findIndex((c) => c.text === text);
  expect(cell, 'the edited cell').toBeGreaterThan(0);
  type State = EditorInspect & { cell?: number; inline?: { objectId: string; cell?: number } };
  const state = async () => (await editorState(page)) as State;
  await openEditor(page, port, p.id);
  await openSlide(page, 2);
  await frames(page);
  // pptxdecks.ts: the plan at (0.4 in, 0.4 in), five columns of 2.5 in, rows of 0.24 in at least.
  const at = await canvasPoint(
    page,
    (0.4 + 2.5 * PLAN_COL + 1.25) * 144,
    (0.4 + 0.24 * PLAN_ROW + 0.12) * 144,
  );
  await tableKitReady(page);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await state()).objectId).toBe(obj.id);
  await page.waitForTimeout(SECOND_PRESS_MS);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await state()).cell).toBe(cell);
  await page.waitForTimeout(SECOND_PRESS_MS);
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.getByTestId('ordo-inline-canvas-editor')).toBeVisible();
  await expect.poll(async () => (await state()).inline).toEqual({ objectId: obj.id, cell });
  await page.keyboard.press('End');
  await page.keyboard.type(PLAN_TYPED);
  await page.keyboard.press('Escape');
  await save(page);
  const after = await apiJson<Presentation>(a, `presentations/${p.id}`);
  const t = tableOf(after.sections.flatMap((s) => s.slides)[1]!);
  expect(t.cells[cell]!.text).toBe(`${text}${PLAN_TYPED}`);
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

type OutState = { slideCue?: number; held: { live: string }[] };
const held = (w: Page) =>
  w.evaluate(() => (window as unknown as { __ordo: { state(): OutState } }).__ordo.state());
type StageView = { ready: boolean; current: { text: string } | null };
const stageView = (w: Page) =>
  w.evaluate(() => (window as unknown as { __ordo: { view(): StageView } }).__ordo.view());

/**
 * The bulletin live: Audience 1 (1920 x 1080, Canvas 2D) shows the header's navy and the body's text; the Lobby
 * and the Bottom-Third Stream (their looks set to show every presentation's text) draw no band for it; the Stage
 * shows the deck's title, never the cells.
 */
async function liveAsATable(
  a: APIRequestContext,
  context: BrowserContext,
  port: number,
  p: Presentation,
  name: string,
): Promise<void> {
  const looks = await apiJson<{ id: string; layers: { slide: Record<string, unknown> } }[]>(
    a,
    'settings/looks',
  );
  await apiJson(a, 'settings/looks', {
    put: looks.map((l) =>
      l.id === 'look-lower-third' || l.id === 'look-stream'
        ? { ...l, layers: { ...l.layers, slide: { ...l.layers.slide, nonSong: 'text' } } }
        : l,
    ),
  });
  const pl = await apiJson<{ id: string }>(a, 'playlists', {
    post: { name: 'Bulletin', items: [{ id: 'deck', kind: 'presentation', presentationId: p.id }] },
  });
  await liveEvent(a, { k: 'goLive', playlistId: pl.id });
  const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
  const audienceRec = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
  const lobbyRec = outs.find((o) => o.lookId === 'look-lower-third');
  const streamRec = outs.find((o) => o.lookId === 'look-stream');
  const stageRec = outs.find((o) => o.kind === 'stage');
  expect(lobbyRec && streamRec && stageRec, 'a Lobby, a Stream and a Stage output').toBeTruthy();
  const audience = await roleWindow(context, port, audienceRec, { width: 1920, height: 1080 }, 'renderer=2d');
  const small = { width: 960, height: 540 };
  const lobby = await roleWindow(context, port, lobbyRec!, small, 'renderer=2d');
  const stream = await roleWindow(context, port, streamRec!, small, 'renderer=2d');
  const stage = await roleWindow(context, port, stageRec!, { width: 1280, height: 720 }, 'test=1');
  try {
    for (const w of [audience, lobby, stream]) await cacheReady(w);
    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
    await settledOn(audience, 0);
    const header = tableCellCentre(0, 2);
    const [, top] = tableCellCentre(5, 2);
    const half = (TABLE.rowH * 144) / 2;
    // A body cell's text ('Hymn 105 and prayer', left aligned) on white, under the header.
    const left = (TABLE.x + TABLE.cols[0] + TABLE.cols[1]) * 144;
    const body: [number, number, number, number] = [left, top - half, left + 260, top + half];
    await expect
      .poll(
        async () => {
          const shot = await capture(audience, join(OUT, `${name}-audience.png`));
          return { header: close(at(shot, header), TABLE.header), text: ink(shot, body) > 40 };
        },
        { timeout: 30_000, message: "Audience shows the header's fill and the cells' text" },
      )
      .toEqual({ header: true, text: true });
    expect((await telemetryOf(audience)).error ?? '').toBe('');
    // No band: the slide is live, its slide layer on the Lobby and the Stream holds nothing.
    for (const [w, label] of [
      [lobby, 'lobby'],
      [stream, 'stream'],
    ] as const) {
      await w.bringToFront();
      await expect
        .poll(
          async () => {
            const st = await held(w);
            return st.slideCue === 0 ? st.held[0]?.live : 'not yet';
          },
          { timeout: 20_000, message: `${label}: the bulletin is live and draws no band` },
        )
        .toBe('');
    }
    // The Stage: the deck's title (a non-song slide without text of its own), never the cells.
    await stage.bringToFront();
    await expect
      .poll(async () => (await stageView(stage)).current?.text ?? null, {
        timeout: 20_000,
        message: "the Stage shows the deck's title",
      })
      .toBe(p.title);
    expect(p.title).not.toMatch(/Hymn|Sunday|Psalm/);
  } finally {
    await liveEvent(a, { k: 'endService', at: Date.now() });
    for (const w of [audience, lobby, stream, stage]) await w.close();
  }
}

test('tables imported in the browser for a hub without LibreOffice are table objects', async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  rmSync(join(OUT, 'tab'), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await tableDeck(join(OUT, 'tab'));
  const hub = await liteHub(TAB_PORT);
  try {
    const a = await hubApi(TAB_PORT);
    await login(page, opOrigin(TAB_PORT));
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    // The tab parses for the hub's kind once it has heard the hub's capabilities.
    await expect(page.getByText(/anything it cannot draw is listed on the import card/)).toBeVisible({
      timeout: 30_000,
    });
    await page.locator('input[name="pptx-import-mode"][value="native"]').check();
    await page.locator('input[type=file][accept*=".pptx"]').setInputFiles(deck);
    const card = page.locator('[data-pptx-import]').first();
    await expect(card.getByText(/^done$/)).toBeVisible({ timeout: 120_000 });
    const jobs = await settled(a);
    const native = jobs.find((j) => j.kind === 'pptx-native')!;
    const full = await apiJson<Job>(a, `jobs/${native.id}`);
    expect(full.log.join('\n')).toMatch(/parsed in the browser: the hub checked its scene/);
    const p = await storedAsTheRuleSays(a, full.result!.presentationId);
    await liveAsATable(a, context, TAB_PORT, p, 'tab');
  } finally {
    hub.kill();
  }
});

test('tables uploaded to a hub without LibreOffice are table objects', async ({ context }) => {
  test.setTimeout(300_000);
  rmSync(join(OUT, 'upload'), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await tableDeck(join(OUT, 'upload'));
  const hub = await liteHub(UPLOAD_PORT);
  try {
    const a = await hubApi(UPLOAD_PORT);
    const caps = await apiJson<{ libreoffice: { state: string } }>(a, 'capabilities');
    expect(caps.libreoffice.state).toBe('off');
    const job = await importPptx(a, deck);
    const jobs = await settled(a);
    expect(jobs.filter((j) => j.kind === 'pptx-lo')).toHaveLength(0);
    expect(job.log.join('\n')).not.toMatch(/parsed in the browser/);
    const p = await storedAsTheRuleSays(a, job.result!.presentationId);
    await liveAsATable(a, context, UPLOAD_PORT, p, 'upload');
  } finally {
    hub.kill();
  }
});

test('on a hub with LibreOffice both tables are table objects, nothing waits, and the plan edits cell by cell', async ({
  context,
  page,
}) => {
  test.setTimeout(360_000);
  rmSync(join(OUT, 'lo'), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await tableDeck(join(OUT, 'lo'));
  const hub = await pptxHub(LO_PORT);
  try {
    const a = await hubApi(LO_PORT);
    const caps = await apiJson<{ libreoffice: { state: string } }>(a, 'capabilities');
    expect(caps.libreoffice.state, 'this hub has LibreOffice').not.toBe('off');
    const job = await importPptx(a, deck);
    const jobs = await settled(a);
    expect(
      jobs.filter((j) => j.kind === 'pptx-lo'),
      'no LibreOffice follow-up: no page to draw',
    ).toHaveLength(0);
    expect(job.log.join('\n')).not.toMatch(PAGE);
    const p = await storedAsTheRuleSays(a, job.result!.presentationId);
    await planCellEdited(page, LO_PORT, a, p);
    await liveAsATable(a, context, LO_PORT, p, 'lo');
  } finally {
    hub.kill();
  }
});
