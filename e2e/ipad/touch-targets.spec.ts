import { expect, type Page, test } from '@playwright/test';
import { BASE, json, SONG, shot, signInByTapping, startHub } from './ipadhelpers.ts';

/**
 * Touch targets on the iPad (design/15 "Touch": every control is 44 px, which #24's class rules had undone): an audit of every visible
 * control of the editor in both orientations (the webkit-ipad projects: 1194x834 and 834x1194), on each
 * surface a volunteer touches: the canvas with its object tools, the docked panel's tabs, the slides list
 * with the selected card's actions, the Stage lens, the paint picker (solid and gradient) and the Lyric
 * Script. A control passes when its box is at least 44 px tall and 44 px wide, apart from the named
 * exceptions below, each with its reason.
 */
type Miss = { where: string; what: string; w: number; h: number };

/**
 * Controls allowed under 44 px, by CSS selector, and why. Everything else must be a 44 px target.
 * - The picker's colour swatches: a 32 px grid of quick picks (the hex field and the colour square beside
 *   them are full-size); 44 px squares would not fit eight to a row in the 296 px popover.
 * - The gradient ramp's stop pins: drag handles on a 270 px ramp, picked with the stop bar's full-size
 *   fields and buttons too.
 * - A colour pill's chip: 32 px under a finger by the owner's own touch rule (styles.css); beside it in
 *   its pill are the full-size hex field (a solid colour) or the summary button (opening the same picker).
 */
const EXCEPTIONS: [selector: string, why: string][] = [
  ['.color-swatch-btn', 'colour swatch grid (32 px quick picks beside full-size fields)'],
  ['.grad-ramp-pin', 'gradient stop pins (drag handles; the stop bar is the touch way)'],
  [
    '.color-pill-chip',
    "a colour pill's chip (the owner's 32 px touch size; its hex field or summary is full-size)",
  ],
];

async function audit(page: Page, where: string, root: string): Promise<Miss[]> {
  return page.evaluate(
    ({ where, root, except }) => {
      const out: { where: string; what: string; w: number; h: number }[] = [];
      const sel =
        'button, select, a.btn, [role="tab"], [role="menuitem"], input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="hidden"])';
      for (const scope of document.querySelectorAll(root))
        for (const el of scope.querySelectorAll<HTMLElement>(sel)) {
          if (except.some((x) => el.matches(x))) continue;
          if (el.id === 'ordo-text-editor') continue; // the canvas's text field, not a target
          // A field in a boxed label is reached by a tap anywhere on its label: the label is the target.
          const r = (el.tagName === 'INPUT' ? (el.closest('label') ?? el) : el).getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
          if (Math.round(r.height) >= 44 && Math.round(r.width) >= 44) continue;
          const what = `${el.tagName.toLowerCase()}.${String(el.className).split(' ').filter(Boolean).join('.')} "${(
            el.getAttribute('aria-label') ??
            el.textContent ??
            ''
          )
            .trim()
            .slice(0, 24)}"`;
          out.push({ where, what, w: Math.round(r.width), h: Math.round(r.height) });
        }
      return out;
    },
    { where, root, except: EXCEPTIONS.map(([s]) => s) },
  );
}

test('every control of the editor is a 44 px touch target, apart from the named exceptions', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const portrait = test.info().project.name.includes('portrait');
  const { hub, api, url } = await startHub(BASE + 30 + (portrait ? 1 : 0));
  const misses: Miss[] = [];
  try {
    const song = await json<{ id: string }>(api.post('import/songselect', { data: { text: SONG } }));
    await signInByTapping(page, url);
    await page.evaluate((id) => {
      location.hash = `#/edit/${encodeURIComponent(id)}`;
    }, song.id);
    const stage = page.locator('.canvasbox .konvajs-content');
    await expect(stage).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    // The canvas with nothing selected: top bar, slides list (the selected card's actions), Stage lens and
    // the docked panel on its Slide and Presentation tabs.
    await expect(page.locator('.ed-slide-inline-actions')).toBeVisible();
    misses.push(...(await audit(page, 'canvas', '.editor')));
    for (const tab of ['Slide', 'Presentation']) {
      await page.locator('.ed-drawer-hdr').getByRole('button', { name: tab, exact: true }).tap();
      misses.push(...(await audit(page, `panel ${tab}`, '.editor > .props')));
    }
    await shot(page, 'targets-canvas');

    // A lyric selected: the object tools by it and the docked Object panel.
    const sb = (await stage.boundingBox())!;
    await stage.tap({ position: { x: sb.width / 2, y: sb.height / 2 } });
    await expect(page.locator('.ed-objtools')).toBeVisible();
    misses.push(...(await audit(page, 'object selected', '.editor')));
    await shot(page, 'targets-object');

    // A rectangle's fill in the paint picker: solid, then a linear gradient.
    await page.getByRole('button', { name: /^Add/ }).first().tap();
    await page.getByRole('menuitem', { name: 'Rect' }).tap();
    const pill = page.getByRole('button', { name: 'Shape fill' }).first();
    await pill.scrollIntoViewIfNeeded();
    await pill.tap();
    const pop = page.getByRole('dialog', { name: 'Paint picker' });
    await expect(pop).toBeVisible();
    misses.push(...(await audit(page, 'paint picker solid', '.color-popover')));
    await pop.getByRole('tab', { name: 'Linear' }).tap();
    await expect(pop.getByText('Gradient Ramp')).toBeVisible();
    misses.push(...(await audit(page, 'paint picker linear', '.color-popover')));
    await shot(page, 'targets-paint');
    await page.locator('.ed-title').tap();
    await expect(pop).toHaveCount(0);

    // The Lyric Script.
    await page.getByRole('button', { name: 'Lyric Script' }).tap();
    await expect(page.locator('.ed-reflow')).toBeVisible();
    misses.push(...(await audit(page, 'lyric script', '.editor')));
    await shot(page, 'targets-script');
  } finally {
    hub.kill();
  }
  test.info().annotations.push({ type: 'under 44 px', description: JSON.stringify(misses) });
  expect(misses, 'controls under 44 px (not a named exception)').toEqual([]);
});
