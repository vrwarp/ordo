import { expect, test } from '@playwright/test';
import { m9Table } from '../../packages/domain/src/m9.test-util.ts';
import { verticalTable } from '../../packages/domain/src/vertical-table.test-util.ts';
import { editorState, SECOND_PRESS_MS, tableKitReady } from '../editorhelpers.ts';
import { portOf } from '../ports.ts';
import { auditTargets, type Miss, TABLE_TOOLS, TABLET_EXCEPTIONS } from '../touchaudit.ts';
import { json, shot, signInByTapping, startHub, tabletSlot } from './ipadhelpers.ts';

/**
 * A table's tools are 44 px touch targets on a tablet (design/15 "Touch" and "Table editing"), in the three
 * tablet projects (webkit-ipad, webkit-ipad-portrait, chromium-tablet): a table tapped, then a cell of it, the
 * docked Object panel shows the Table section (the cell's text, its format, Cell fill, Rows & columns), and every
 * visible control of the editor is audited (e2e/touchaudit.ts, with the iPad audit's named exceptions).
 */
const white = { r: 255, g: 255, b: 255, a: 1 };

test("a table's cell tools are 44 px touch targets", async ({ page }) => {
  test.setTimeout(180_000);
  const { hub, api, url } = await startHub(portOf('ipad-table-targets', tabletSlot()));
  const misses: Miss[] = [];
  try {
    const p = await json<{ id: string }>(
      api.post('presentations', {
        data: {
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
                      box: { x: 120, y: 160, w: 1320, h: 410, rotation: 0 },
                      shape: 'rect',
                      fill: white,
                      opacity: 1,
                      radius: 0,
                      table: m9Table(),
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    await signInByTapping(page, url);
    await page.evaluate((id) => {
      location.hash = `#/edit/${encodeURIComponent(id)}`;
    }, p.id);
    const stage = page.locator('.canvasbox .konvajs-content');
    await expect(stage).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    // 'Leader' (the header row's last cell): a tap selects the table, a tap on the table selected its cell (the
    // canvas's table kit, loaded with the first table, waited for once).
    const tools = page.locator(TABLE_TOOLS);
    await tableKitReady(page);
    const b = (await stage.boundingBox())!;
    const leader = { x: (1290 / 1920) * b.width, y: (195 / 1080) * b.height };
    await stage.tap({ position: leader });
    await expect.poll(async () => (await editorState(page)).objectId).toBe('table');
    await page.waitForTimeout(SECOND_PRESS_MS);
    await stage.tap({ position: leader });
    await expect(tools.getByLabel('Cell text')).toBeVisible();
    expect((await editorState(page)).cell).toBe(2);
    await expect(tools.getByRole('button', { name: 'Row below' })).toBeVisible();
    await tools.scrollIntoViewIfNeeded();
    misses.push(
      ...(await auditTargets(
        page,
        'table cell selected',
        '.editor',
        TABLET_EXCEPTIONS.map(([s]) => s),
      )),
    );
    await shot(page, 'targets-table');
  } finally {
    hub.kill();
  }
  test.info().annotations.push({ type: 'under 44 px', description: JSON.stringify(misses) });
  expect(misses, 'controls under 44 px (not a named exception)').toEqual([]);
});

/**
 * The narrow vertical cell of an imported table (sub-wave 1c, rule V: East Asian vertical cells are the table
 * object, drawn horizontally as LibreOffice 24.2 draws them): on a tablet a tap selects the table, a tap on it
 * selected selects the cell (the Korean bulletin's '1년차', centred over four rows of a 70 px column), and typing in
 * the panel's Cell text edits it; saved, the cell keeps its vert.
 */
test('a tap and typing edit the narrow East Asian vertical cell (eaVert) of an imported table', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { hub, api, url } = await startHub(portOf('ipad-table-targets', tabletSlot()));
  try {
    const box = { x: 200, y: 150, w: 520, h: 320, rotation: 0 };
    const p = await json<{ id: string }>(
      api.post('presentations', {
        data: {
          title: 'Two years',
          kind: 'slides',
          sections: [
            {
              id: 'sec',
              label: 'Years',
              short: 'Y',
              slides: [
                {
                  id: 'years',
                  objects: [
                    {
                      id: 'table',
                      type: 'shape',
                      box,
                      shape: 'rect',
                      opacity: 1,
                      radius: 0,
                      table: verticalTable(),
                      origin: { src: 'pptx', role: 'table' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    await signInByTapping(page, url);
    await page.evaluate((id) => {
      location.hash = `#/edit/${encodeURIComponent(id)}`;
    }, p.id);
    const stage = page.locator('.canvasbox .konvajs-content');
    await expect(stage).toBeVisible({ timeout: 20_000 });
    await tableKitReady(page);
    const b = (await stage.boundingBox())!;
    // The middle of the vertical cell: column 0 (70 px), rows 0-3 (40 px each).
    const narrow = { x: ((box.x + 35) / 1920) * b.width, y: ((box.y + 80) / 1080) * b.height };
    await stage.tap({ position: narrow });
    await expect.poll(async () => (await editorState(page)).objectId).toBe('table');
    await page.waitForTimeout(SECOND_PRESS_MS);
    await stage.tap({ position: narrow });
    const field = page.locator(TABLE_TOOLS).getByLabel('Cell text');
    await expect(field).toBeVisible();
    expect((await editorState(page)).cell).toBe(0);
    await expect(field).toHaveValue('1년차');
    await field.tap();
    await page.keyboard.press('End');
    await page.keyboard.type(' 첫해');
    await expect(field).toHaveValue('1년차 첫해');
    await page.getByRole('button', { name: 'Save', exact: true }).tap();
    type Stored = {
      sections: {
        slides: {
          objects: { table?: { cells: { text?: string; style?: number }[]; styles?: { vert?: string }[] } }[];
        }[];
      }[];
    };
    await expect
      .poll(
        async () => {
          const t = (await json<Stored>(api.get(`presentations/${p.id}`))).sections[0]!.slides[0]!.objects[0]!
            .table!;
          const c = t.cells[0]!;
          return [c.text, c.style === undefined ? undefined : t.styles?.[c.style]?.vert];
        },
        { timeout: 20_000, message: 'saved: the typed text, the cell still eaVert' },
      )
      .toEqual(['1년차 첫해', 'eaVert']);
    await shot(page, 'targets-vertical-cell');
  } finally {
    hub.kill();
  }
});
