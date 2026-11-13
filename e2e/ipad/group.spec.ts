import { expect, type Page, test } from '@playwright/test';
import { BASE, json, signInByTapping, startHub } from './ipadhelpers.ts';

/**
 * A group under a finger (M4 item B; design/27 §11 item 5, design/15 "Touch"): a tap on a shape's text
 * selects the shape and its text together, a long press selects the text alone (Alt-click's touch
 * equivalent), 'Select the group' in the panel takes the pair back, and a finger drag moves both. Runs in
 * the webkit-ipad projects; the touches are dispatched in the page as `touch.spec.ts` does (pointer events
 * with pointerType "touch" and TouchEvents, as iPadOS sends them). Hubs on ORDO_E2E_IPAD_PORT + 20 / + 21.
 */

type Box = { x: number; y: number; w: number; h: number; rotation: number };
type Obj = {
  id: string;
  type: string;
  box: Box;
  origin?: { src: string; group?: number };
  [k: string]: unknown;
};
type Pres = { id: string; rev: number; sections: { slides: { id: string; objects: Obj[] }[] }[] };
type Pt = { x: number; y: number };

const SONG = `Group Song

Verse 1
A line under a box
Another line
`;

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'webkit', 'iPad touch spec runs in the webkit-ipad projects');
});

/** One finger: down at `from`, hold `holdMs`, move to `to` in steps, lift (pointer events and TouchEvents). */
async function finger(page: Page, from: Pt, to: Pt, holdMs = 0, steps = 12): Promise<void> {
  await page.evaluate(
    async ({ from, to, holdMs, steps }) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const target = document.elementFromPoint(from.x, from.y) as HTMLElement;
      if (!target) throw new Error('nothing under the finger');
      const id = 11;
      const doc = document as unknown as {
        createTouch(...a: unknown[]): Touch;
        createTouchList(...t: Touch[]): TouchList;
      };
      const fire = (type: string, p: Pt, ended = false) => {
        const pe = type.replace('touch', 'pointer').replace('start', 'down').replace('end', 'up');
        const init = { clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, composed: true };
        target.dispatchEvent(
          new PointerEvent(pe, {
            ...init,
            pointerId: id,
            pointerType: 'touch',
            isPrimary: true,
            button: 0,
            buttons: ended ? 0 : 1,
          }),
        );
        const t = doc.createTouch(window, target, id, p.x, p.y, p.x, p.y);
        const list = ended ? doc.createTouchList() : doc.createTouchList(t);
        target.dispatchEvent(
          new TouchEvent(type, {
            ...init,
            // WebKit takes the TouchLists it made itself; the DOM types ask for Touch[].
            touches: list as unknown as Touch[],
            targetTouches: list as unknown as Touch[],
            changedTouches: doc.createTouchList(t) as unknown as Touch[],
          }),
        );
      };
      fire('touchstart', from);
      await wait(holdMs);
      if (to.x !== from.x || to.y !== from.y)
        for (let i = 1; i <= steps; i++) {
          const k = i / steps;
          fire('touchmove', { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
          await wait(16);
        }
      await wait(50);
      fire('touchend', to, true);
      await wait(50);
    },
    { from, to, holdMs, steps },
  );
}

const editor = (page: Page) =>
  page.evaluate(() => {
    const e = (
      window as unknown as { __ordo: { editor(): { objectIds: string[]; draft?: Pres } } }
    ).__ordo.editor();
    return { objectIds: e.objectIds, draft: e.draft };
  });

test('a tap selects a shape with its text, a long press the text alone, a drag moves both', async ({
  page,
}) => {
  const portrait = test.info().project.name.includes('portrait');
  const { hub, api, url } = await startHub(BASE + 20 + (portrait ? 1 : 0));
  try {
    const made = await json<{ id: string }>(api.post('import/songselect', { data: { text: SONG } }));
    const p = await json<Pres>(api.get(`presentations/${made.id}`));
    const slide = p.sections[0]!.slides[0]!;
    const text = slide.objects.find((o) => o.type === 'text')!;
    // A box behind the lyric, grouped with it: what an imported PowerPoint shape with its text becomes.
    const shape: Obj = {
      id: 'pair-shape',
      type: 'shape',
      box: { ...text.box },
      shape: 'rect',
      fill: { r: 31, g: 78, b: 121, a: 1 },
      opacity: 1,
      radius: 0,
      origin: { src: 'pptx', role: 'shape', group: 1 },
    } as Obj;
    text.origin = { src: 'pptx', group: 1 };
    slide.objects = [shape, ...slide.objects];
    await json(api.put(`presentations/${p.id}`, { data: p }));

    await signInByTapping(page, url);
    await page.evaluate((id) => {
      location.hash = `#/edit/${id}`;
    }, p.id);
    const stage = page.locator('.konvajs-content');
    await expect(stage).toBeVisible({ timeout: 20_000 });
    const sb = (await stage.boundingBox())!;
    const scale = sb.width / 1920;
    const c = {
      x: sb.x + (text.box.x + text.box.w / 2) * scale,
      y: sb.y + (text.box.y + text.box.h / 2) * scale,
    };

    // A tap: the pair.
    await expect(async () => {
      await stage.tap({ position: { x: c.x - sb.x, y: c.y - sb.y } });
      expect((await editor(page)).objectIds).toEqual(['pair-shape', text.id]);
    }).toPass({ timeout: 15_000 });
    await expect(page.locator('[data-group-note]')).toContainText('2 objects selected');
    await expect(page.locator('.ed-objtools')).toBeVisible();

    // A long press: the text alone; 'Select the group' takes the pair back.
    await finger(page, c, c, 800);
    await expect.poll(async () => (await editor(page)).objectIds).toEqual([text.id]);
    await expect(page.locator('[data-group-note]')).toContainText('Selected alone');
    await page.getByRole('button', { name: 'Select the group' }).tap();
    await expect.poll(async () => (await editor(page)).objectIds).toEqual(['pair-shape', text.id]);

    // A finger drag moves both by the same delta.
    await finger(page, c, { x: c.x - 150 * scale, y: c.y - 80 * scale });
    await expect
      .poll(async () => (await editor(page)).draft!.sections[0]!.slides[0]!.objects[0]!.box.x)
      .not.toBe(text.box.x);
    const moved = (await editor(page)).draft!.sections[0]!.slides[0]!.objects;
    const sh = moved.find((o) => o.id === 'pair-shape')!.box;
    const tx = moved.find((o) => o.id === text.id)!.box;
    expect(Math.abs(sh.x - (text.box.x - 150))).toBeLessThanOrEqual(12);
    expect(Math.abs(sh.y - (text.box.y - 80))).toBeLessThanOrEqual(12);
    expect(tx).toEqual(sh);

    await page.getByRole('button', { name: 'Save', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 10_000 });
    const saved = await json<Pres>(api.get(`presentations/${p.id}`));
    expect(saved.sections[0]!.slides[0]!.objects.find((o) => o.id === text.id)!.box).toEqual(tx);
  } finally {
    await api.dispose();
    hub.kill();
  }
});
