import { type APIRequestContext, expect, test } from '@playwright/test';
import { editorHub, editorState, opOrigin, type PresentationRec } from './editorhelpers.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi, login } from './linkhelpers.ts';
import { portOf } from './ports.ts';

/**
 * Unsaved drafts across tabs and reload recovery (design/15 "Unsaved drafts"):
 * - Switching top-nav tabs, Library sub-tabs, Settings sub-tabs, and multiple presentations keeps all pending
 *   edits, workspace modes, and 200-step undo stacks without blocking navigation;
 * - Non-editor views (`Library`, `Playlists`, `Previews`) keep showing the saved hub version with an `unsaved`
 *   badge/banner;
 * - The top Nav `● N unsaved ▾` pill opens a popover with Open / Save / Discard and Save all;
 * - Clicking `← Library` or `← Back to Themes` while dirty prompts Save / Discard / Keep draft;
 * - Going live prompts Save & Go live / Discard & Go live / Cancel only for service-relevant drafts;
 * - Reloading the page offers "Restore unsaved drafts? [Restore] [Discard all]" from `ordo-drafts` IndexedDB.
 */
const PORT = portOf('editor-unsaved');
let hub: HubProcess;

test.beforeAll(async () => {
  hub = await editorHub(PORT);
});
test.afterAll(() => hub?.kill());

async function createSong(a: APIRequestContext, title: string, verse: string): Promise<PresentationRec> {
  const r = await a.post('import/songselect', {
    data: { text: `${title}\n\nVerse 1\n${verse}\n` },
  });
  expect(r.ok()).toBe(true);
  return (await r.json()) as PresentationRec;
}

test('preserves multiple presentation, theme, and settings drafts across tabs, guards Back and Go live, and recovers after reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const a = await hubApi(PORT);
  const songA = await createSong(a, 'Amazing Grace', 'Amazing grace how sweet the sound');
  const songB = await createSong(a, 'Be Thou My Vision', 'Be Thou my vision O Lord of my heart');

  const plRes = await a.post('playlists', {
    data: {
      id: 'pl-unsaved-e2e',
      rev: 1,
      name: 'Sunday Service',
      items: [{ id: 'item-a', kind: 'presentation', presentationId: songA.id }],
    },
  });
  expect(plRes.ok()).toBe(true);

  await login(page, opOrigin(PORT));

  // 1. Open Song A, rename title + edit lyric, switch workspace mode to Slide Canvas, then switch tabs!
  await page.evaluate((id) => {
    location.hash = `#/edit/${encodeURIComponent(id)}`;
  }, songA.id);
  const titleInput = page.getByLabel('Presentation title');
  await expect(titleInput).toHaveValue('Amazing Grace');
  await titleInput.fill('Amazing Grace (Edited)');
  await page.getByRole('button', { name: 'Slide Canvas' }).click();
  await expect(page.locator('.canvasbox canvas').first()).toBeVisible();

  // Top Nav pill immediately reflects 1 unsaved item.
  const navPill = page.locator('[data-unsaved-pill]');
  await expect(navPill).toContainText('1 unsaved');

  // Switch via top Nav to Library -> Themes, edit a theme, switch to Fonts, and switch back to Themes!
  await page
    .locator('.nav')
    .getByRole('link', { name: /Library/ })
    .click();
  // Library still shows the saved hub title ("Amazing Grace") + an "unsaved" badge!
  await expect(page.getByText('Amazing Grace', { exact: true })).toBeVisible();
  await expect(page.locator('.tag.amber', { hasText: 'unsaved' }).first()).toBeVisible();

  await page.getByRole('link', { name: /Themes/ }).click();
  const themeInput = page.getByPlaceholder('Theme name');
  await expect(themeInput).toBeVisible();
  await themeInput.fill('Golden Worship');
  await expect(page.locator('.tag.amber', { hasText: 'unsaved' }).first()).toBeVisible();
  // Switch to Fonts sub-tab and back to Themes: theme draft stays intact!
  await page.getByRole('link', { name: 'Fonts' }).click();
  await expect(navPill).toContainText('2 unsaved');
  await page.getByRole('link', { name: /Themes/ }).click();
  await expect(themeInput).toHaveValue('Golden Worship');
  await expect(page.locator('.tag.amber', { hasText: 'unsaved' }).first()).toBeVisible();

  // 2. Open Song B and edit it too (multiple dirty presentations!).
  await page.evaluate((id) => {
    location.hash = `#/edit/${encodeURIComponent(id)}`;
  }, songB.id);
  await expect(page.getByLabel('Presentation title')).toHaveValue('Be Thou My Vision');
  await page.getByLabel('Presentation title').fill('Be Thou My Vision (Draft)');
  await expect(navPill).toContainText('3 unsaved');

  // 3. Edit Settings -> General, switch to Screens, switch back to General: settings draft stays intact!
  await page
    .locator('.nav')
    .getByRole('link', { name: /Settings/ })
    .click();
  await page.locator('.side').getByRole('link', { name: 'General' }).click();
  const venueInput = page.getByLabel('Venue name');
  await expect(venueInput).toBeVisible();
  await venueInput.fill('Grace Community');
  await page.locator('.side').getByRole('link', { name: 'Screens' }).click();
  await expect(page.getByRole('heading', { name: 'Screens' })).toBeVisible();
  await expect(navPill).toContainText('4 unsaved');
  await page
    .locator('.side')
    .getByRole('link', { name: /General/ })
    .click();
  await expect(venueInput).toHaveValue('Grace Community');

  // 4. Return to Song A via the Nav unsaved popover: title, Slide Canvas mode, and undo stack are preserved!
  await navPill.click();
  const pop = page.locator('[data-unsaved-popover]');
  await expect(pop).toBeVisible();
  await pop.locator(`[data-unsaved-item="pres:${songA.id}"]`).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByLabel('Presentation title')).toHaveValue('Amazing Grace (Edited)');
  // Still in Slide Canvas mode (not reset to Lyric Script!).
  await expect(page.locator('.canvasbox canvas').first()).toBeVisible();
  expect((await editorState(page)).dirty).toBe(true);

  // Clicking "← Library" while dirty prompts Save / Discard / Keep draft -> Keep draft!
  await page.getByRole('link', { name: '← Library' }).click();
  await expect(page.getByRole('dialog')).toContainText('Save changes to “Amazing Grace (Edited)”');
  await page.getByRole('button', { name: 'Keep draft' }).click();
  await expect(page).toHaveURL(/#\/library$/);

  // 5. Check PreviewsView: strictly shows saved hub version + unsaved banner!
  await page.evaluate((id) => {
    location.hash = `#/previews/${encodeURIComponent(id)}`;
  }, songA.id);
  await expect(page.locator('[data-unsaved-preview-banner]')).toContainText('Showing the last saved version');

  // 6. Hard reload: flush IndexedDB journal (Wait >500ms debounce), reload, and Restore from startup dialog!
  await page.waitForTimeout(600);
  page.once('dialog', (d) => void d.accept());
  await page.reload();
  const recoveryDialog = page.getByRole('dialog');
  await expect(recoveryDialog).toContainText('Restore unsaved drafts?');
  await recoveryDialog.getByRole('button', { name: 'Restore' }).click();
  await expect(navPill).toContainText('4 unsaved');

  // 7. Go live on Sunday Service (contains Song A, NOT Song B): prompts only for Song A + Golden Worship theme!
  await page.locator('.nav').getByRole('link', { name: 'Playlists' }).click();
  await page.getByRole('button', { name: 'Go live' }).click();
  const goLiveDialog = page.getByRole('dialog');
  await expect(goLiveDialog).toContainText('Amazing Grace (Edited)');
  await expect(goLiveDialog).not.toContainText('Be Thou My Vision (Draft)');
  await expect(goLiveDialog).not.toContainText('General settings');
  await goLiveDialog.getByRole('button', { name: 'Save & Go live' }).click();

  // Song A and its theme saved; Song B and General settings stay parked!
  await expect(page).toHaveURL(/#\/live$/);
  await expect(navPill).toContainText('2 unsaved');
});
