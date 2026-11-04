import { mkdirSync } from 'node:fs';
import { type APIRequestContext, expect, type Locator, type Page, request, test } from '@playwright/test';
import { rotaterAngle } from '../../apps/operator/src/views/editor/touchGeometry.ts';
import { HubProcess } from '../hubproc.ts';

/**
 * iPad touch editing (design/15 "Touch"): reordering by long-press drag and by buttons, the slide editor
 * under a finger (move, resize, rotate, double-tap to edit, toolbar nudge, undo, save), and the edited
 * field staying above the software keyboard. Runs in the webkit-ipad projects (WebKit, iPad Pro 11,
 * landscape and portrait).
 *
 * Playwright drives a real tap (`locator.tap`) but has no touch move, so drags are dispatched in the page
 * as the sequence iPadOS produces: pointer events (pointerType "touch", what the Sortable listens to) and
 * TouchEvents built with document.createTouch (what Konva listens to). Synthetic events are untrusted, so
 * this does not prove the browser's own gesture arbitration (scroll vs drag); `touch-action: none` on the
 * handles and the stage is what makes that work on the device.
 *
 * WebKit headless shows no software keyboard; it is simulated by shrinking the viewport (which shrinks the
 * visual viewport the same way the keyboard does) while a field has focus.
 */

const PIN = '246810';
const BASE = Number(process.env.ORDO_E2E_TOUCH_PORT ?? 9124);

function portFor(n: number): number {
  return BASE + n + (test.info().project.name.includes('portrait') ? 10 : 0);
}

async function startHub(port: number) {
  const hub = HubProcess.fresh(port);
  await hub.start();
  const api = await request.newContext({ baseURL: `http://localhost:${port}/api/v1/` });
  const r = await api.post('auth/pin', { data: { pin: PIN } });
  expect(r.ok(), await r.text()).toBe(true);
  return { hub, api, url: `http://localhost:${port}/` };
}

async function json<T>(p: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await p;
  if (!r.ok()) throw new Error(`${r.url()} -> ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

const SONG = (title: string) => `${title}

Verse 1
First line of verse one
Second line of verse one

Chorus
Chorus line alpha
Chorus line beta

Verse 2
Verse two line one

Bridge
Bridge line
`;

type Section = { id: string; label: string; short: string };
type Box = { x: number; y: number; w: number; h: number; rotation: number };
type Pres = {
  id: string;
  rev: number;
  sections: (Section & {
    slides: { id: string; objects: { id: string; type: string; box: Box; text?: string }[] }[];
  })[];
  arrangements: { id: string; name: string; sectionIds: string[] }[];
};

async function song(api: APIRequestContext, title: string): Promise<Pres> {
  const s = await json<{ id: string }>(api.post('import/songselect', { data: { text: SONG(title) } }));
  return json<Pres>(api.get(`presentations/${s.id}`));
}

async function signIn(page: Page, url: string): Promise<void> {
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(url);
  await page.locator('input.pin').fill(PIN);
  await page.getByRole('button', { name: 'OK' }).tap();
  await expect(page.getByRole('link', { name: 'Library' })).toBeVisible({ timeout: 20_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.ORDO_E2E_SHOTS ?? test.info().outputPath('shots');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${test.info().project.name}-${name}.png` });
}

type Pt = { x: number; y: number };

/**
 * One finger: down at `from`, hold `holdMs`, move along to `to` in steps, lift. Dispatches pointer events
 * (pointerType "touch") and TouchEvents to the element under the first contact, as iPadOS does.
 */
async function fingerDrag(page: Page, from: Pt, to: Pt, opts: { holdMs?: number; steps?: number } = {}) {
  await page.evaluate(
    async ({ from, to, holdMs, steps }) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const target = document.elementFromPoint(from.x, from.y) as HTMLElement;
      if (!target) throw new Error('nothing under the finger');
      const id = 7;
      const doc = document as unknown as {
        createTouch(...a: unknown[]): Touch;
        createTouchList(...t: Touch[]): TouchList;
      };
      const touch = (p: Pt) => doc.createTouch(window, target, id, p.x, p.y, p.x, p.y);
      const fire = (type: string, p: Pt, ended = false) => {
        const pe = type.replace('touch', 'pointer').replace('start', 'down').replace('end', 'up');
        target.dispatchEvent(
          new PointerEvent(pe, {
            pointerId: id,
            pointerType: 'touch',
            isPrimary: true,
            clientX: p.x,
            clientY: p.y,
            button: 0,
            buttons: ended ? 0 : 1,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
        const t = touch(p);
        const list = ended ? doc.createTouchList() : doc.createTouchList(t);
        target.dispatchEvent(
          new TouchEvent(type, {
            touches: list,
            targetTouches: list,
            changedTouches: doc.createTouchList(t),
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
      };
      fire('touchstart', from);
      await wait(holdMs);
      for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        fire('touchmove', { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
        await wait(16);
      }
      await wait(50);
      fire('touchend', to, true);
      await wait(50);
    },
    { from, to, holdMs: opts.holdMs ?? 0, steps: opts.steps ?? 12 },
  );
}

async function center(l: Locator): Promise<Pt> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'webkit', 'iPad touch spec runs in the webkit-ipad projects');
});

test('reorder a playlist and an arrangement by long-press drag and by the buttons', async ({ page }) => {
  const { hub, api, url } = await startHub(portFor(0));
  try {
    const a = await song(api, 'Alpha Song');
    const b = await song(api, 'Beta Song');
    const pl = await json<{ id: string }>(
      api.post('playlists', {
        data: {
          name: 'Touch Sunday',
          items: [
            { id: 'it-a', kind: 'presentation', presentationId: a.id },
            { id: 'it-b', kind: 'presentation', presentationId: b.id },
            { id: 'it-t', kind: 'timer', timer: { kind: 'elapsed', label: 'Elapsed' } },
          ],
        },
      }),
    );
    const order = async () =>
      (await json<{ items: { id: string }[] }>(api.get(`playlists/${pl.id}`))).items.map((i) => i.id);
    await signIn(page, url);
    await page.evaluate((id) => {
      location.hash = `#/playlists/${id}`;
    }, pl.id);
    const rows = page.locator('[data-playlist-item]');
    await expect(rows).toHaveCount(3);
    await shot(page, 'playlist');

    // A quick swipe on the grip is a scroll, not a drag: nothing moves.
    const grip = (i: number) => rows.nth(i).locator('.sort-handle');
    const g0 = await center(grip(0));
    const last = await rows.nth(2).boundingBox();
    await fingerDrag(page, g0, { x: g0.x, y: last!.y + last!.height - 4 }, { holdMs: 0 });
    await page.waitForTimeout(900);
    expect(await order()).toEqual(['it-a', 'it-b', 'it-t']);

    // Long press (300 ms) then drag the first item below the last: B, timer, A.
    await fingerDrag(page, g0, { x: g0.x, y: last!.y + last!.height - 4 }, { holdMs: 400 });
    await expect(rows.nth(2)).toHaveAttribute('data-playlist-item', 'it-a');
    await expect.poll(order, { timeout: 10_000 }).toEqual(['it-b', 'it-t', 'it-a']);

    // The same with the buttons: A up once: B, A, timer.
    await rows.nth(2).getByRole('button', { name: 'Move up' }).tap();
    await expect.poll(order, { timeout: 10_000 }).toEqual(['it-b', 'it-a', 'it-t']);

    // Arrangement of Alpha: select its row, Edit, drag V1 after V2, save.
    await rows.nth(1).locator('.ellipsis').first().tap();
    await page.getByRole('button', { name: 'Edit', exact: true }).tap();
    const chips = page.locator('[data-arr-chip]');
    await expect(chips).toHaveCount(4);
    await shot(page, 'arrangement');
    const labels = async () =>
      chips.locator('.arr-chip-label').evaluateAll((els) => els.map((e) => e.textContent));
    expect(await labels()).toEqual(['V1', 'C', 'V2', 'B']);
    const from = await center(chips.nth(0).locator('.sort-handle'));
    const v2 = (await chips.nth(2).boundingBox())!;
    await fingerDrag(page, from, { x: v2.x + v2.width - 4, y: v2.y + v2.height / 2 }, { holdMs: 400 });
    expect(await labels()).toEqual(['C', 'V2', 'V1', 'B']);
    await page.getByRole('button', { name: 'Save arrangement' }).tap();
    const shorts = async () => {
      const p = await json<Pres>(api.get(`presentations/${a.id}`));
      const pl2 = await json<{ items: { id: string; arrangementId?: string }[] }>(
        api.get(`playlists/${pl.id}`),
      );
      const arrId = pl2.items.find((i) => i.id === 'it-a')?.arrangementId;
      const arr = p.arrangements.find((x) => x.id === arrId) ?? p.arrangements[0];
      const byId = new Map(p.sections.map((s) => [s.id, s.short]));
      return arr?.sectionIds.map((id) => byId.get(id));
    };
    await expect.poll(shorts, { timeout: 10_000 }).toEqual(['C', 'V2', 'V1', 'B']);

    // And by the buttons: pick V1, Later: C V2 B V1.
    await page.getByRole('button', { name: 'Edit', exact: true }).tap();
    await expect(chips).toHaveCount(4);
    await chips.nth(2).locator('.arr-chip-label').tap();
    await page.getByRole('button', { name: 'Later →' }).tap();
    expect(await labels()).toEqual(['C', 'V2', 'B', 'V1']);
    await page.getByRole('button', { name: 'Save arrangement' }).tap();
    await expect.poll(shorts, { timeout: 10_000 }).toEqual(['C', 'V2', 'B', 'V1']);
  } finally {
    hub.kill();
  }
});

test('edit a text box by touch: move, resize, rotate, double-tap, nudge, undo, save', async ({ page }) => {
  const { hub, api, url } = await startHub(portFor(1));
  try {
    const p = await song(api, 'Editor Song');
    const obj0 = p.sections[0]!.slides[0]!.objects.find((o) => o.type === 'text')!;
    await signIn(page, url);
    await page.evaluate((id) => {
      location.hash = `#/edit/${id}`;
    }, p.id);
    const stage = page.locator('.konvajs-content');
    await expect(stage).toBeVisible();
    await expect(page.locator('.canvasbox')).toHaveCSS('touch-action', 'none');
    const sb = (await stage.boundingBox())!;
    const scale = sb.width / 1920;
    const at = (x: number, y: number): Pt => ({ x: sb.x + x * scale, y: sb.y + y * scale });
    const field = (name: string) =>
      page.locator('.props label.field', { hasText: new RegExp(`^${name}`) }).locator('input');
    const val = async (name: string) => Number(await field(name).first().inputValue());

    // Tap selects the box; the Object tab shows its geometry.
    const b0 = obj0.box;
    await stage.tap({ position: { x: (b0.x + b0.w / 2) * scale, y: (b0.y + b0.h / 2) * scale } });
    await expect(page.locator('#ordo-text-editor')).toBeVisible();
    await shot(page, 'editor-selected');

    // Move: drag the body 200 x 100 slide px.
    await fingerDrag(
      page,
      at(b0.x + b0.w / 2, b0.y + b0.h / 2),
      at(b0.x + b0.w / 2 - 200, b0.y + b0.h / 2 - 100),
    );
    await expect.poll(() => val('X')).toBeLessThan(b0.x - 150);
    const moved = { x: await val('X'), y: await val('Y') };
    expect(Math.abs(moved.x - (b0.x - 200))).toBeLessThanOrEqual(12);
    expect(Math.abs(moved.y - (b0.y - 100))).toBeLessThanOrEqual(12);

    // Resize: the bottom-right anchor 300 x 200 slide px inwards.
    const br = at(moved.x + b0.w, moved.y + b0.h);
    await fingerDrag(page, br, { x: br.x - 300 * scale, y: br.y - 200 * scale });
    await expect.poll(() => val('W')).toBeLessThan(b0.w - 200);
    const size = { w: await val('W'), h: await val('H') };
    expect(Math.abs(size.w - (b0.w - 300))).toBeLessThanOrEqual(15);
    expect(Math.abs(size.h - (b0.h - 200))).toBeLessThanOrEqual(15);

    // Rotate: the rotate handle sits 64 screen px out from the box, above it unless that is off the
    // slide (this box is now near the top, so it flips below: touchGeometry.ts). Drag it a quarter turn.
    const cx = moved.x + size.w / 2;
    const cy = moved.y + size.h / 2;
    const c = at(cx, cy);
    const angle = rotaterAngle({ x: moved.x, y: moved.y, w: size.w, h: size.h, rotation: 0 }, scale, 64);
    const dir = (deg: number) => ({
      x: Math.sin((deg * Math.PI) / 180),
      y: -Math.cos((deg * Math.PI) / 180),
    });
    const half = {
      0: (size.h / 2) * scale,
      180: (size.h / 2) * scale,
      90: (size.w / 2) * scale,
      270: (size.w / 2) * scale,
    }[angle]!;
    const d0 = dir(angle);
    const rot = { x: c.x + d0.x * (half + 64), y: c.y + d0.y * (half + 64) };
    const d1 = dir(angle + 90);
    await fingerDrag(page, rot, { x: c.x + d1.x * 200, y: c.y + d1.y * 200 }, { steps: 20 });
    await expect.poll(() => val('Rotation')).toBe(90);
    const geo = { x: await val('X'), y: await val('Y'), w: await val('W'), h: await val('H') };

    // Double-tap the box: its text field takes focus; type new text.
    await page.locator('#ordo-text-editor').evaluate((e) => (e as HTMLElement).blur());
    await stage.tap({ position: { x: cx * scale, y: cy * scale } });
    await page.waitForTimeout(80);
    await stage.tap({ position: { x: cx * scale, y: cy * scale } });
    await expect(page.locator('#ordo-text-editor')).toBeFocused();
    await page.locator('#ordo-text-editor').fill('Touched text');

    // Nudge with the toolbar (50 px steps), undo it, nudge down once.
    await page.locator('#ordo-text-editor').evaluate((e) => (e as HTMLElement).blur());
    await page.getByLabel('Nudge step').selectOption('50');
    const nudge = page.locator('.ed-nudge button');
    await nudge.nth(3).tap(); // Right
    await nudge.nth(3).tap();
    await expect.poll(() => val('X')).toBe(geo.x + 100);
    await page.getByRole('button', { name: /Undo/ }).tap();
    await expect.poll(() => val('X')).toBe(geo.x);
    await nudge.nth(2).tap(); // Down
    await expect.poll(() => val('Y')).toBe(geo.y + 50);
    await shot(page, 'editor-edited');

    await page.getByRole('button', { name: 'Save', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible({ timeout: 10_000 });
    const saved = await json<Pres>(api.get(`presentations/${p.id}`));
    const o = saved.sections[0]!.slides[0]!.objects.find((x) => x.id === obj0.id)!;
    expect(o.box).toEqual({ x: geo.x, y: geo.y + 50, w: geo.w, h: geo.h, rotation: 90 });
    expect(o.text).toBe('Touched text');
  } finally {
    hub.kill();
  }
});

test('a focused property field stays above the (simulated) software keyboard', async ({ page }) => {
  const { hub, api, url } = await startHub(portFor(2));
  try {
    const p = await song(api, 'Keyboard Song');
    await signIn(page, url);
    await page.evaluate((id) => {
      location.hash = `#/edit/${id}`;
    }, p.id);
    await shot(page, 'editor');
    const stage = page.locator('.konvajs-content');
    await expect(stage).toBeVisible();
    const sb = (await stage.boundingBox())!;
    await stage.tap({ position: { x: sb.width / 2, y: sb.height / 2 } });
    await expect(page.locator('#ordo-text-editor')).toBeVisible();

    // The last text-like field in the property panel (far down: it needs the panel to scroll).
    const fields = page.locator('.props input[type="number"], .props input[type="text"], .props select');
    const target = fields.last();
    await target.scrollIntoViewIfNeeded();
    await target.tap();
    await expect(target).toBeFocused();
    const vp = page.viewportSize()!;
    // An iPad keyboard is ~ 400 px in portrait and ~ 360 in landscape (logical px).
    const kb = vp.height > vp.width ? 400 : 360;
    // Before the "keyboard", put the field low in the panel, where the keyboard will cover it.
    await target.evaluate((el) => {
      const sc = el.closest('.props') as HTMLElement;
      const r = el.getBoundingClientRect();
      sc.scrollTop -= Math.max(0, innerHeight - 40 - r.bottom);
    });
    await page.setViewportSize({ width: vp.width, height: vp.height - kb });
    await expect
      .poll(
        () =>
          target.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const vv = window.visualViewport!;
            return r.top >= vv.offsetTop && r.bottom <= vv.offsetTop + vv.height;
          }),
        { timeout: 5_000 },
      )
      .toBe(true);
    await shot(page, 'editor-keyboard');
    await page.setViewportSize(vp);

    // Library screens for the record.
    await page.evaluate(() => {
      location.hash = '#/library';
    });
    await expect(page.getByText('Keyboard Song').first()).toBeVisible();
    await shot(page, 'library');
    await page.evaluate(() => {
      location.hash = '#/library/media';
    });
    await expect(page.getByRole('button', { name: /Choose video, images or audio/ })).toBeVisible();
    await shot(page, 'media');
  } finally {
    hub.kill();
  }
});
