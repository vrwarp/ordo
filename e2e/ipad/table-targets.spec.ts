import { expect, test } from '@playwright/test';
import { m9Table } from '../../packages/domain/src/m9.test-util.ts';
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

    // 'Leader' (the header row's last cell): a tap selects the table, a tap on the table selected its cell (once
    // the table's drawer, loaded with the first table, has drawn it).
    const tools = page.locator(TABLE_TOOLS);
    await expect(async () => {
      const b = (await stage.boundingBox())!;
      await stage.tap({ position: { x: (1290 / 1920) * b.width, y: (195 / 1080) * b.height } });
      await expect(tools.getByLabel('Cell text')).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30_000 });
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
