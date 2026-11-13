import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  CHURCH,
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
  type SlideRec,
  saveAndReload,
  selectRange,
  slidesOf,
} from './editorhelpers.ts';
import { hubApi } from './linkhelpers.ts';

/**
 * M4 item B (apps/operator/src/views/editor/M4.md; design/27 §11 item 5, §15 M4 exit "move and resize a
 * shape+text pair as one, then edit one member with Alt-click"): the church deck's rounded box and its
 * text are one PowerPoint shape, imported as a ShapeObject and a TextObject sharing `origin.group`. A click
 * selects both; a drag moves them together, the Transformer's corner and the group box's W field resize them
 * together (their text size stays), its rotate handle turns them about the group centre and 'Turn by' turns
 * them back, arrows nudge both; Alt-click selects the text alone to edit it; Delete
 * takes the pair away and Undo brings it back. After save and reload the presentation JSON is identical.
 * Port 8902.
 */
const PORT = M4_PORT + 2;
const OUT = 'test-results/editor-group';

type Box = Obj['box'];
const pairOf = (s: SlideRec) => {
  const shape = s.objects.find((o) => o.type === 'shape' && o.origin?.group !== undefined)!;
  const text = s.objects.find((o) => o.type === 'text' && o.origin?.group === shape.origin!.group)!;
  return { shape, text };
};
/** The open slide's pair as the editor holds it now. */
async function pairNow(page: Page, slide: number): Promise<{ shape: Obj; text: Obj }> {
  return pairOf(slidesOf((await editorState(page)).draft!)[slide]!);
}
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y, rotation: 0 };
};
const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** A mouse drag between two slide points, in steps, as a volunteer's. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await canvasPoint(page, from.x, from.y);
  const b = await canvasPoint(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + (b.x - a.x) / 4, a.y + (b.y - a.y) / 4, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();
  await frames(page);
}

test('the rounded box and its text: move and resize as one, Alt-click the text to edit it, delete and undo the pair', async ({
  page,
}) => {
  test.setTimeout(240_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await churchDeck(join(OUT, 'deck'));
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const p = await importDeck(a, deck);
    const slides = slidesOf(p);
    const PAIR = 4; // the fifth slide
    const { shape, text } = pairOf(slides[PAIR]!);
    expect(text.text).toBe(CHURCH.pair.text);
    const style = structuredClone(text.style);
    const offset = { x: text.box.x - shape.box.x, y: text.box.y - shape.box.y };

    await openEditor(page, PORT, p.id);
    await openSlide(page, PAIR + 1);

    // ---- A click on the text selects the pair; the panel says so and edits the group box.
    await expect(async () => {
      await clickObject(page, text);
      const s = await editorState(page);
      expect(s.objectIds).toEqual([shape.id, text.id]);
      expect(s.objectId).toBe(text.id);
    }).toPass({ timeout: 15_000 });
    await page.getByRole('button', { name: 'More object options' }).click();
    await frames(page);
    const note = page.locator('[data-group-note]');
    await expect(note).toContainText('2 objects selected, a group from PowerPoint');
    const groupField = (name: string) =>
      page.locator('[data-group-box] label.field', { hasText: new RegExp(`^${name}$`) }).locator('input');
    const g0 = union(shape.box, text.box);
    await expect(groupField('W')).toHaveValue(String(Math.round(g0.w * 1000) / 1000));

    // ---- Drag the pair 200 x 100 slide px: both move by the same delta (the group box snaps as one).
    const c0 = centre(text.box);
    await drag(page, c0, { x: c0.x + 200, y: c0.y + 100 });
    await expect.poll(async () => (await pairNow(page, PAIR)).shape.box.x).not.toBe(shape.box.x);
    let now = await pairNow(page, PAIR);
    const d = { x: now.shape.box.x - shape.box.x, y: now.shape.box.y - shape.box.y };
    expect(Math.abs(d.x - 200)).toBeLessThanOrEqual(12);
    expect(Math.abs(d.y - 100)).toBeLessThanOrEqual(12);
    expect(now.text.box).toEqual({ ...text.box, x: text.box.x + d.x, y: text.box.y + d.y });
    expect(now.shape.box).toMatchObject({ w: shape.box.w, h: shape.box.h });

    // ---- Resize with the Transformer's bottom-right corner, 300 x 150 slide px in: both scale about the
    // group box, the text keeps its size and its place in the box.
    const g1 = union(now.shape.box, now.text.box);
    await drag(page, { x: g1.x + g1.w, y: g1.y + g1.h }, { x: g1.x + g1.w - 300, y: g1.y + g1.h - 150 });
    await expect.poll(async () => (await pairNow(page, PAIR)).shape.box.w).toBeLessThan(shape.box.w - 200);
    now = await pairNow(page, PAIR);
    const g2 = union(now.shape.box, now.text.box);
    const sx = g2.w / g1.w;
    const sy = g2.h / g1.h;
    expect(Math.abs(g2.w - (g1.w - 300))).toBeLessThanOrEqual(15);
    expect(Math.abs(g2.h - (g1.h - 150))).toBeLessThanOrEqual(15);
    expect(now.text.box.w).toBeCloseTo(text.box.w * sx, 0);
    expect(now.text.box.h).toBeCloseTo(text.box.h * sy, 0);
    expect(now.text.box.x - now.shape.box.x).toBeCloseTo(offset.x * sx, 0);
    expect(now.text.box.y - now.shape.box.y).toBeCloseTo(offset.y * sy, 0);
    expect(now.text.style).toEqual(style);

    // ---- The group box's W field: the pair 1000 px wide exactly, the text scaled with it.
    await groupField('W').fill('1000');
    await groupField('W').press('Enter');
    const groupW = async () => {
      const q = await pairNow(page, PAIR);
      return union(q.shape.box, q.text.box).w;
    };
    await expect.poll(groupW).not.toBe(g2.w);
    now = await pairNow(page, PAIR);
    expect(union(now.shape.box, now.text.box).w).toBeCloseTo(1000, 2);
    expect(now.text.style).toEqual(style);

    // ---- A quarter turn with the Transformer's rotate handle (50 screen px above the group box, snapping at
    // 90°): both turn about the group centre. 'Turn by' -90 turns them back.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const unturned = now;
    const g3 = union(now.shape.box, now.text.box);
    const zoom = (await page.locator('.canvasbox .konvajs-content').first().boundingBox())!.width / 1920;
    const gc = centre(g3);
    const handle = { x: gc.x, y: g3.y - 50 / zoom };
    await frames(page);
    await drag(page, handle, { x: gc.x + (gc.y - handle.y), y: gc.y });
    await expect.poll(async () => (await pairNow(page, PAIR)).text.box.rotation).toBe(90);
    now = await pairNow(page, PAIR);
    expect(now.shape.box.rotation).toBe(90);
    const tc0 = centre(unturned.text.box);
    const tc1 = centre(now.text.box);
    expect(tc1.x).toBeCloseTo(gc.x - (tc0.y - gc.y), 0);
    expect(tc1.y).toBeCloseTo(gc.y + (tc0.x - gc.x), 0);
    expect(centre(now.shape.box).x).toBeCloseTo(gc.x, 0);
    expect(now.text.box.w).toBeCloseTo(unturned.text.box.w, 2);
    const turnBy = page.locator('[data-group-box] label.field', { hasText: /^Turn by/ }).locator('input');
    await turnBy.fill('-90');
    await turnBy.press('Enter');
    await expect.poll(async () => (await pairNow(page, PAIR)).text.box.rotation).toBe(0);
    await expect(turnBy).toHaveValue('0');
    now = await pairNow(page, PAIR);
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      expect(now.text.box[k]).toBeCloseTo(unturned.text.box[k], 1);
      expect(now.shape.box[k]).toBeCloseTo(unturned.shape.box[k], 1);
    }

    // ---- Arrow keys nudge the pair (focus off the field first).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const before = await pairNow(page, PAIR);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await pairNow(page, PAIR)).text.box.x).toBe(before.text.box.x + 3);
    now = await pairNow(page, PAIR);
    expect(now.shape.box.x).toBe(before.shape.box.x + 3);

    // ---- Alt-click the text: it alone is selected; edit it ('Coffee' → 'Tea'); the box shape stays.
    await frames(page);
    await expect(async () => {
      await clickObject(page, now.text, { alt: true });
      expect((await editorState(page)).objectIds).toEqual([text.id]);
    }).toPass({ timeout: 15_000 });
    await expect(note).toContainText('Selected alone: one of a group of 2 objects');
    const shapeBefore = now.shape;
    await selectRange(page, 0, 'Coffee'.length);
    await page.keyboard.type('Tea');
    await expect.poll(async () => (await pairNow(page, PAIR)).text.text).toBe('Tea after the service');
    now = await pairNow(page, PAIR);
    expect(now.shape).toEqual(shapeBefore);
    expect(now.text.style).toEqual(style);

    // ---- Delete the pair (Escape, then a click selects it again) and undo.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await editorState(page)).objectIds).toEqual([]);
    const kept = (await editorState(page)).draft!;
    await frames(page);
    await expect(async () => {
      await clickObject(page, now.text);
      expect((await editorState(page)).objectIds).toEqual([shape.id, text.id]);
    }).toPass({ timeout: 15_000 });
    await page.keyboard.press('Delete');
    await expect
      .poll(async () => slidesOf((await editorState(page)).draft!)[PAIR]!.objects.map((o) => o.id))
      .not.toContain(text.id);
    expect(slidesOf((await editorState(page)).draft!)[PAIR]!.objects.map((o) => o.id)).not.toContain(
      shape.id,
    );
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await editorState(page)).draft).toEqual(kept);

    // ---- Save and reload: the same presentation; the pair moved, resized and edited; nothing else changed.
    const saved = await saveAndReload(page, a, p.id);
    const done = pairOf(slidesOf(saved)[PAIR]!);
    expect(done.text.text).toBe('Tea after the service');
    expect(done.text.style).toEqual(style);
    expect(done.shape.id).toBe(shape.id);
    expect(done.text.origin).toEqual(text.origin);
    for (const [i, s] of slidesOf(saved).entries()) if (i !== PAIR) expect(s).toEqual(slides[i]);
    const others = (s: SlideRec) => s.objects.filter((o) => o.id !== shape.id && o.id !== text.id);
    expect(others(slidesOf(saved)[PAIR]!)).toEqual(others(slides[PAIR]!));
  } finally {
    hub.kill();
  }
});
