import { expect, type Page, test } from '@playwright/test';
import type { Slide } from '../../packages/domain/src/index.ts';
import { effectsSlide } from '../../packages/renderer/src/units.effects.test-util.ts';
import { editorReady, editorState, frames } from '../editorhelpers.ts';
import { decodePng, type Pixels } from '../png.ts';
import { portOf } from '../ports.ts';
import { json, signInByTapping, startHub, tabletSlot } from './ipadhelpers.ts';

/**
 * A tablet keeps the editor's lighter drawing (design/15 "Canvas drawing", views/editor/wholeDraw.ts): its pointer
 * is coarse, so the objects the slide's drawing budget draws as a lighter copy stay the copy, as before. The
 * 12-panel slide of units.effects.test-util.ts (the last three panels' shadows are past the effect budget) is opened
 * next to the same slide without those three shadows, in the three tablet projects (webkit-ipad,
 * webkit-ipad-portrait, chromium-tablet): the canvas's status says why nothing is drawn whole (coarse, three
 * blocked, none pending) and the picture is the reference's at the two points below the late panels. A pin: the
 * lighter drawing is what a tablet has always had; the case fails if the canvas ever draws whole on a coarse pointer.
 */
const LATE = ['p9', 'p10', 'p11'];
/** Slide points below the late panels' bottom edges (logical px of the 1920x1080 slide). */
const POINTS = [
  { x: 1700, y: 985 },
  { x: 1300, y: 985 },
];
/** The same slide with no late shadow: the capture is within this many levels of the reference. */
const SAME = 8;

/** The mean colour of a 5 x 5 block of device px at a slide point. */
function colourAt(img: Pixels, p: { x: number; y: number }): [number, number, number] {
  const cx = Math.round((p.x / 1920) * img.width);
  const cy = Math.round((p.y / 1080) * img.height);
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = cy - 2; y <= cy + 2; y++)
    for (let x = cx - 2; x <= cx + 2; x++) {
      const o = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) sum[c]! += img.data[o + c]!;
      n++;
    }
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}

/** How many levels `img` differs from `ref` at the point, in the channel that differs most. */
function differsBy(img: Pixels, ref: Pixels, p: { x: number; y: number }): number {
  const a = colourAt(img, p);
  const b = colourAt(ref, p);
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

async function capture(page: Page): Promise<Pixels> {
  return decodePng(await page.locator('.canvasbox .konvajs-content').screenshot());
}

/** The canvas has drawn the slide: its first panel's colour is there (a blank stage is black). */
async function drawn(page: Page): Promise<Pixels> {
  let img!: Pixels;
  await expect
    .poll(async () => {
      img = await capture(page);
      return colourAt(img, { x: 440, y: 280 }).some((v) => v > 30);
    })
    .toBe(true);
  return img;
}

const reference = (): Slide => {
  const s = effectsSlide();
  return {
    ...s,
    objects: s.objects.map((o) =>
      LATE.includes(o.id) ? { ...o, shadow: undefined } : o,
    ) as Slide['objects'],
  };
};

test('a tablet keeps the lighter drawing: no late shadow is drawn whole', async ({ page }) => {
  test.setTimeout(240_000);
  const { hub, api, url } = await startHub(portOf('ipad-editor-whole', tabletSlot()));
  try {
    const make = (title: string, slide: Slide) =>
      json<{ id: string }>(
        api.post('presentations', {
          data: {
            title,
            kind: 'slides',
            sections: [{ id: 'sec', label: 'Slides', short: 'S', slides: [slide] }],
          },
        }),
      );
    const full = (await make('Effects', effectsSlide())).id;
    const none = (await make('Effects without the late shadows', reference())).id;
    await signInByTapping(page, url);
    const open = async (id: string) => {
      await page.evaluate((pid) => {
        location.hash = `#/edit/${encodeURIComponent(pid)}`;
      }, id);
      await editorReady(page, id);
    };

    await open(none);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await frames(page);
    const ref = await drawn(page);

    await open(full);
    // The canvas says why nothing is drawn whole: the pointer is coarse, the three late panels are blocked (a
    // build before the whole drawing has no status: the picture alone then says it, which is what this pins).
    await expect
      .poll(
        async () => {
          const w = (await editorState(page)).whole;
          return w === undefined || (w.coarse && w.drawn === 0 && w.pending === 0 && w.blocked >= 3);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await frames(page);
    const img = await drawn(page);
    for (const p of POINTS)
      expect(differsBy(img, ref, p), `no late shadow at ${p.x},${p.y} on a tablet`).toBeLessThanOrEqual(SAME);
  } finally {
    hub.kill();
  }
});
