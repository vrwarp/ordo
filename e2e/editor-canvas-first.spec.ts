import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  churchDeck,
  editorHub,
  editorState,
  importDeck,
  M4_PORT,
  type Obj,
  openEditor,
  openSlide,
  slidesOf,
} from './editorhelpers.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi } from './linkhelpers.ts';

/**
 * The canvas-first editor (#24: the Tune drawer closed by default, the floating bar, the hidden backing text
 * field, the non-modal Find) on the church deck, the way a volunteer works it (design/15 "Slide canvas",
 * "Keys", "Errors", "Clipboard"):
 * - clipboard HTML from another page that claims to carry ordo objects the editor cannot use (no text, no
 *   style, a box no screen draws) is left out with a message; the slide, the canvas and the top bar stay
 *   (before, the object was added and the floating bar's read of its missing text blanked the whole app).
 * Port M4_PORT + 11.
 */
const PORT = M4_PORT + 11;
const OUT = 'test-results/editor-canvas-first';
let hub: HubProcess;
let deck: string;

test.beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  deck = await churchDeck(join(OUT, 'deck'));
  hub = await editorHub(PORT);
});
test.afterAll(() => hub?.kill());

/** The open slide's objects in the editor's draft. */
async function slideObjects(page: Page): Promise<Obj[]> {
  const s = await editorState(page);
  return slidesOf(s.draft!).find((x) => x.id === s.slideId)!.objects;
}

/** A paste of `html` (and `text`) on the canvas, as the system clipboard delivers one. */
async function pasteHtml(page: Page, html: string, text = ''): Promise<void> {
  await page.evaluate(
    ([h, t]) => {
      (document.activeElement as HTMLElement | null)?.blur();
      const data = new DataTransfer();
      data.setData('text/html', h!);
      if (t) data.setData('text/plain', t);
      document.body.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    [html, text],
  );
}

test('hostile objects pasted from another page are left out with a message; the canvas and the top bar stay', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  const before = await slideObjects(page);

  // A page's clipboard HTML in ordo's object format: a text object with no text and no style, a shape no
  // screen can draw, and a key no schema has.
  const payload = {
    objects: [
      { id: 'evil-1', type: 'text', box: { x: 100, y: 100, w: 400, h: 200, rotation: 0 }, opacity: 1 },
      {
        id: 'evil-2',
        type: 'shape',
        shape: 'rect',
        box: { x: 0, y: 0, w: 1e300, h: 10, rotation: 0 },
        opacity: 1,
        radius: 0,
        onload: 'alert(1)',
      },
    ],
  };
  const attr = JSON.stringify(payload).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  await pasteHtml(page, `<meta charset="utf-8"><div data-ordo-objects="${attr}">Lyrics</div>`, 'Lyrics');

  await expect(page.locator('.toast').filter({ hasText: 'could not be used on a slide' })).toBeVisible();
  await expect(page.locator('.toast').last()).toContainText('2 pasted objects');
  // Nothing was added; the slide, the canvas and the top bar are all still there and working.
  expect((await slideObjects(page)).map((o) => o.id)).toEqual(before.map((o) => o.id));
  await expect(page.locator('.canvasbox canvas').first()).toBeVisible();
  // The top bar: nothing changed, so it says Saved.
  await expect(
    page.locator('.ed-toolbar-calm').getByRole('button', { name: 'Saved', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-page-error], [data-pane-error]')).toHaveCount(0);
  await page.screenshot({ path: join(OUT, 'after-hostile-paste.png') });
});
