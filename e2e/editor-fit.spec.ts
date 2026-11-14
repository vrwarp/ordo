import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import {
  ANNOUNCEMENT_TEXT,
  canvasPoint,
  churchDeck,
  clickObject,
  editorHub,
  editorState,
  frames,
  importDeck,
  M4_PORT,
  type Obj,
  openEditor,
  openSlide,
  type PresentationRec,
  slidesOf,
} from './editorhelpers.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi } from './linkhelpers.ts';

/**
 * The canvas-first editor's own surfaces (#24) on the windows a church uses (design/15 "Canvas-first layout",
 * "Top bar", "Floating bar", "Paint picker"; four of #24's regressions):
 * - the paint picker open on None leaves the main thread idle, and a gradient pin dragged past another stop
 *   keeps moving that stop;
 * - at 1024x768 and 1280x720 every top-bar control can be clicked, for a deck and for a song in Slide Canvas
 *   mode, and reaching one by keyboard never scrolls the editor sideways;
 * - the floating bar (and the Stage lens under the stage) fits its pane with the Slide drawer open, and the
 *   bar never covers the selection's handles at Fit, 75 % and 50 %;
 * - the font select is named "Font" (or "Font (mixed)", showing Mixed, for a selection of several fonts).
 * Port M4_PORT + 11.
 */
const PORT = M4_PORT + 11;
const OUT = 'test-results/editor-fit';
/** CI machines are slower: timing bounds are scaled there. */
const SLOW = process.env.CI ? 3 : 1;
let hub: HubProcess;
let deck: string;

test.beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  deck = await churchDeck(join(OUT, 'deck'));
  hub = await editorHub(PORT);
});
test.afterAll(() => hub?.kill());

/** Main-thread busy time (CDP TaskDuration, seconds) over `ms` of wall time. */
async function busySeconds(page: Page, ms: number): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const at = async () =>
    (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0;
  const t0 = await at();
  await page.waitForTimeout(ms);
  const t1 = await at();
  await cdp.detach();
  return Math.round((t1 - t0) * 1000) / 1000;
}

/**
 * Every visible control under `root` that a click at its centre does not reach: off the window, or covered
 * (by the slide list, the drawer, or clipped away). Each entry is "name: why".
 */
function unreachable(page: Page, root: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    const scope = document.querySelector(sel);
    if (!scope) return [`${sel}: missing`];
    for (const el of scope.querySelectorAll<HTMLElement>('button, select, input, a')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 24);
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx < 0 || cx > innerWidth || cy < 0 || cy > innerHeight) {
        out.push(`${name}: off the window (${Math.round(cx)}, ${Math.round(cy)})`);
        continue;
      }
      const hit = document.elementFromPoint(cx, cy);
      if (!(hit === el || el.contains(hit)))
        out.push(`${name}: covered by ${hit?.tagName}.${(hit as HTMLElement | null)?.className ?? ''}`);
    }
    return out;
  }, root);
}

/** The editor never scrolls sideways: the slide list stays at the window's left edge. */
function sideways(page: Page): Promise<{ scrollLeft: number; slideListLeft: number }> {
  return page.evaluate(() => {
    const ed = document.querySelector('.editor') as HTMLElement;
    const list = document.querySelector('.ed-slides')?.getBoundingClientRect();
    return { scrollLeft: ed.scrollLeft, slideListLeft: Math.round(list?.left ?? 0) };
  });
}

async function songOf(a: APIRequestContext): Promise<PresentationRec> {
  const r = await a.post('import/songselect', {
    data: {
      text: 'Morning Hymn\n\nVerse 1\nWake the dawn and sing the light\nPraise the One who made the day\n',
    },
  });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as PresentationRec;
}

function announcement(p: PresentationRec): Obj {
  return slidesOf(p)[1]!.objects.find((o) => o.type === 'text' && o.text === ANNOUNCEMENT_TEXT)!;
}

/** Select [start, end) of the selected box's text from the keyboard, in its text field (the canvas's own). */
async function selectByKeys(page: Page, start: number, end: number): Promise<void> {
  await page.locator('#ordo-text-editor').focus();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < start; i++) await page.keyboard.press('ArrowRight');
  for (let i = start; i < end; i++) await page.keyboard.press('Shift+ArrowRight');
}

async function selectObject(page: Page, o: Obj): Promise<void> {
  await expect(async () => {
    await clickObject(page, o);
    expect((await editorState(page)).objectId).toBe(o.id);
  }).toPass({ timeout: 15_000 });
}

test('the paint picker on None leaves the main thread idle; a dragged gradient pin keeps its stop', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  await page.getByRole('button', { name: 'Shapes' }).click();
  await page.getByRole('menuitem', { name: 'Rectangle' }).click();
  const fbar = page.getByRole('toolbar', { name: 'Contextual format bar' });
  await fbar.getByRole('button', { name: 'Shape fill' }).click();
  const pop = page.getByRole('dialog', { name: 'Paint picker' });
  await expect(pop).toBeVisible();
  await page.waitForTimeout(300);
  const solid = await busySeconds(page, 2000);
  await pop.getByRole('tab', { name: 'None' }).click();
  await expect(pop.getByText('No fill applied.')).toBeVisible();
  await page.waitForTimeout(300);
  const none = await busySeconds(page, 2000);
  test.info().annotations.push({ type: 'busy s per 2 s', description: `solid ${solid}, none ${none}` });
  expect(solid, 'Solid is idle').toBeLessThan(0.4 * SLOW);
  expect(none, 'None is as idle as Solid (no render loop)').toBeLessThan(0.4 * SLOW);

  // A linear gradient with a third stop in the middle; the first stop dragged past it to 80 %.
  await pop.getByRole('tab', { name: 'Linear' }).click();
  const ramp = pop.locator('.grad-ramp-bar');
  const rb = (await ramp.boundingBox())!;
  await page.mouse.click(rb.x + rb.width / 2, rb.y + rb.height / 2);
  const shapeGradient = async () => {
    const s = await editorState(page);
    const slide = slidesOf(s.draft!).find((x) => x.id === s.slideId)!;
    const o = slide.objects[slide.objects.length - 1] as Obj & {
      gradient?: { stops: { at: number; color: { r: number; g: number; b: number } }[] };
    };
    return o.gradient!.stops;
  };
  await expect.poll(async () => (await shapeGradient()).map((s) => s.at)).toEqual([0, 0.5, 1]);
  const first = (await shapeGradient())[0]!.color;
  const pins = pop.locator('.grad-ramp-pins');
  const pb = (await pins.boundingBox())!;
  const pin = (await pop.getByRole('button', { name: 'Select gradient stop 1' }).boundingBox())!;
  await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2);
  await page.mouse.down();
  await page.mouse.move(pb.x + pb.width * 0.8, pin.y + pin.height / 2, { steps: 12 });
  await page.mouse.up();
  const after = await shapeGradient();
  expect(after.map((s) => s.at)).toEqual([0.5, 0.8, 1]);
  expect(after[1]!.color, 'the dragged stop is the one at 80 %').toEqual(first);
  expect(after[0]!.at).toBe(0.5);
  // The sliders and the hex field stay on the dragged stop.
  await expect(pop.getByText('Stop 2')).toBeVisible();
  const hex = `#${[first.r, first.g, first.b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  await expect(pop.getByLabel('Active stop hex color')).toHaveValue(new RegExp(hex, 'i'));
});

test('every top-bar control can be clicked at 1024x768 and 1280x720, for a deck and a song', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const song = await songOf(a);
  const report: Record<string, unknown> = {};
  for (const [w, h] of [
    [1024, 768],
    [1280, 720],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openEditor(page, PORT, p.id);
    await openSlide(page, 3);
    const deckBad = await unreachable(page, '.editor > .toolbar');
    await page.screenshot({ path: join(OUT, `topbar-deck-${w}.png`) });

    // Reaching each control by keyboard never scrolls the editor sideways.
    const shifts: string[] = [];
    const n = await page
      .locator('.editor > .toolbar')
      .locator('button:visible, select:visible, input:visible')
      .count();
    for (let i = 0; i < n; i++) {
      await page
        .locator('.editor > .toolbar')
        .locator('button:visible, select:visible, input:visible')
        .nth(i)
        .focus();
      const s = await sideways(page);
      if (s.scrollLeft !== 0 || s.slideListLeft < 0) shifts.push(`${i}: ${JSON.stringify(s)}`);
    }
    await page.locator('.editor > .toolbar input').first().blur();

    // The Slide and Presentation panels open from the top bar with nothing selected.
    const panels = page.getByRole('button', { name: 'Panels' });
    if (w < 1250) {
      await expect(panels, 'the Panels menu replaces Slide, Presentation and Tune').toBeVisible({
        timeout: 5_000,
      });
      await panels.click();
      await page.getByRole('menuitem', { name: 'Slide' }).click();
      await expect(page.getByLabel('Inspector drawer')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Tune', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Tune', exact: true }).click();
      await expect(page.getByLabel('Inspector drawer')).toHaveCount(0);
      await panels.click();
      await page.getByRole('menuitem', { name: 'Presentation' }).click();
      await expect(page.getByLabel('Inspector drawer')).toBeVisible();
      await page.getByRole('button', { name: 'Tune', exact: true }).click();
    } else {
      await expect(panels).toBeHidden();
      await page.getByRole('button', { name: 'Slide', exact: true }).click();
      await expect(page.getByLabel('Inspector drawer')).toBeVisible();
      await page.getByRole('button', { name: 'Tune', exact: true }).click();
    }
    await expect(page.getByLabel('Inspector drawer')).toHaveCount(0);

    // A song in Slide Canvas mode: its mode switch is on the bar too; zoom and Find stay reachable.
    await page.evaluate((id) => {
      location.hash = `#/edit/${encodeURIComponent(id)}`;
    }, song.id);
    await page.getByRole('button', { name: 'Slide Canvas' }).click();
    await expect(page.locator('.canvasbox canvas').first()).toBeVisible();
    await frames(page);
    const songBad = await unreachable(page, '.editor > .toolbar');
    await expect(page.getByLabel('Canvas zoom')).toBeVisible();
    await page.screenshot({ path: join(OUT, `topbar-song-${w}.png`) });
    report[`${w}x${h}`] = { deckBad, songBad, shifts };
    expect.soft(deckBad, `deck at ${w}x${h}: every control reachable`).toEqual([]);
    expect.soft(songBad, `song (Slide Canvas) at ${w}x${h}: every control reachable`).toEqual([]);
    expect.soft(shifts, `focusing a control at ${w}x${h} scrolls nothing`).toEqual([]);
  }
  test.info().annotations.push({ type: 'top bar', description: JSON.stringify(report) });
});

/** The screen rectangles of the selection's Transformer handles (resize anchors and the rotate handle). */
function handleRects(page: Page): Promise<{ name: string; x: number; y: number; w: number; h: number }[]> {
  return page.evaluate(() => {
    type KNode = {
      visible(): boolean;
      name(): string;
      getClientRect(): { x: number; y: number; width: number; height: number };
      find(sel: string): KNode[];
      findOne(sel: string): KNode | undefined;
      container(): HTMLElement;
    };
    const K = (window as unknown as { Konva: { stages: KNode[] } }).Konva;
    const stage = K.stages.find((s) => s.container().closest('.canvasbox'));
    if (!stage) return [];
    const at = stage.container().getBoundingClientRect();
    const tr = stage.findOne('Transformer');
    if (!tr) return [];
    return tr
      .find('._anchor')
      .filter((n) => n.visible())
      .map((n) => {
        const r = n.getClientRect();
        return { name: n.name().split(' ')[0]!, x: at.x + r.x, y: at.y + r.y, w: r.width, h: r.height };
      });
  });
}

const overlaps = (
  a: DOMRect | { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && b.x < a.x + a.width && a.y < b.y + b.h && b.y < a.y + a.height;

test('the floating bar fits its pane with the drawer open, and never covers the handles', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = announcement(p);
  const report: Record<string, unknown> = {};
  for (const [w, h] of [
    [1280, 720],
    [1024, 768],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await openEditor(page, PORT, p.id);
    await openSlide(page, 2);
    await selectObject(page, note);
    await page.waitForTimeout(400);
    // A word selected inline (the bar's Selection scope), then the Slide panel opened for the notes.
    const at = await canvasPoint(page, note.box.x + 60, note.box.y + 40);
    await page.mouse.dblclick(at.x, at.y);
    await page.waitForTimeout(300);
    await page.keyboard.press('Shift+End');
    if (w < 1250) {
      await page.getByRole('button', { name: 'Panels' }).click({ timeout: 5_000 });
      await page.getByRole('menuitem', { name: 'Slide' }).click();
    } else await page.getByRole('button', { name: 'Slide', exact: true }).click();
    await expect(page.getByLabel('Inspector drawer')).toBeVisible();
    const bar = page.getByRole('toolbar', { name: 'Contextual format bar' });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Selection ×' })).toBeVisible();
    await frames(page);
    const bad = [
      ...(await unreachable(page, '.ed-floating-bar')),
      ...(await unreachable(page, '.ed-lens-dock')),
    ];
    const sizes = await page.evaluate(() => {
      const box = document.querySelector('.canvasbox')!.getBoundingClientRect();
      const b = document.querySelector('.ed-floating-bar')!.getBoundingClientRect();
      return {
        pane: [Math.round(box.left), Math.round(box.right)],
        bar: [Math.round(b.left), Math.round(b.right)],
      };
    });
    await page.screenshot({ path: join(OUT, `bar-drawer-${w}.png`) });
    report[`${w}x${h}`] = { bad, sizes };
    expect
      .soft(bad, `every floating-bar and Stage lens control reachable at ${w}x${h} with the drawer open`)
      .toEqual([]);
    expect.soft(sizes.bar[0]!, 'the bar starts inside the pane').toBeGreaterThanOrEqual(sizes.pane[0]!);
    expect.soft(sizes.bar[1]!, 'the bar ends inside the pane').toBeLessThanOrEqual(sizes.pane[1]!);
  }

  // At Fit, 75 % and 50 % (drawer open and closed) the bar never covers a handle of the selection.
  await page.setViewportSize({ width: 1280, height: 720 });
  for (const drawer of [true, false]) {
    if (!drawer) await page.getByRole('button', { name: 'Tune', exact: true }).click();
    for (const zoom of ['fit', '0.75', '0.5']) {
      await page.getByLabel('Canvas zoom').selectOption(zoom);
      await frames(page);
      await page.waitForTimeout(200);
      const handles = await handleRects(page);
      expect(handles.length, 'the selection shows its handles').toBeGreaterThan(0);
      const rects = await page
        .locator('.ed-floating-bar .ed-floating-inner, .ed-floating-bar .ed-floating-overflow')
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
      const covered = handles.filter((hd) => rects.some((r) => overlaps(r, hd))).map((hd) => hd.name);
      report[`handles ${drawer ? 'drawer' : 'no drawer'} ${zoom}`] = { covered, n: handles.length };
      expect.soft(covered, `handles covered at ${zoom} (drawer ${drawer ? 'open' : 'closed'})`).toEqual([]);
    }
  }
  test.info().annotations.push({ type: 'floating bar', description: JSON.stringify(report) });
});

test('the font select is named Font, and Font (mixed) showing Mixed for a mixed selection', async ({
  page,
}) => {
  const a = await hubApi(PORT);
  const p = await importDeck(a, deck);
  const note = announcement(p);
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  await selectObject(page, note);
  const fbar = page.getByRole('toolbar', { name: 'Contextual format bar' });
  const font = fbar.getByRole('combobox', { name: 'Font', exact: true });
  await expect(font).toBeVisible();
  const boxFont = await font.inputValue();

  // "Potluck" in Georgia, then a selection over "Potluck lunch": two fonts.
  await selectByKeys(page, 0, 7);
  await expect(fbar.getByRole('button', { name: 'Selection ×' })).toBeVisible();
  await fbar.getByRole('combobox', { name: 'Font', exact: true }).selectOption('Georgia');
  await expect
    .poll(async () => {
      const s = await editorState(page);
      const o = slidesOf(s.draft!)[1]!.objects.find((x) => x.id === note.id) as Obj & {
        runs?: { start: number; end: number; fontFamily?: string }[];
      };
      return (o.runs ?? []).some((r) => r.start === 0 && r.end >= 7 && r.fontFamily === 'Georgia');
    })
    .toBe(true);
  await selectByKeys(page, 0, 13);
  const mixed = fbar.getByRole('combobox', { name: 'Font (mixed)' });
  await expect(mixed).toBeVisible();
  expect(await mixed.inputValue(), 'a mixed selection shows Mixed, not the box font').toBe('');
  await expect(mixed.locator('option:checked')).toHaveText('Mixed');

  // The drawer's Typography card names it the same way.
  await fbar.getByRole('button', { name: 'More object options' }).click();
  const typo = page.getByRole('toolbar', { name: 'Typography' });
  await expect(typo.getByRole('combobox', { name: /^Font( \(mixed\))?$/ })).toBeVisible();

  // Picking a font applies it to the whole selection: one font again.
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await selectByKeys(page, 0, 13);
  await fbar.getByRole('combobox', { name: 'Font (mixed)' }).selectOption(boxFont);
  await selectByKeys(page, 0, 13);
  await expect(fbar.getByRole('combobox', { name: 'Font', exact: true })).toHaveValue(boxFont);
});
