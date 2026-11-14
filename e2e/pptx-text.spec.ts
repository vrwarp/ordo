import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { opOrigin, type PresentationRec, slidesOf } from './editorhelpers.ts';
import { hubApi, login } from './linkhelpers.ts';
import type { Pixels } from './png.ts';
import { pictureTextDeck } from './pptxdecks.ts';
import { portOf } from './ports.ts';
import {
  apiJson,
  cacheReady,
  capture,
  importPptx,
  liveEvent,
  type OutputRec,
  pptxHub,
  roleWindow,
  settledOn,
  telemetryOf,
} from './pptxlive.ts';

/**
 * PowerPoint text as an imported slide shows it on Audience (design/27 §4 "Picture-filled text"): a 200 pt
 * 'HIH' filled with a picture (`a:blipFill` in the run's properties), outlined in dark red, with a 3-D bevel,
 * imported both ways a volunteer imports a deck: dropped on the Import tab (parsed in the operator's import
 * worker) and through the hub's route (parsed by the hub). Both store the letters in the text colour (black
 * here) with their outline, and Audience 1 (1920x1080, WebGPU) draws the I's stem black: before text-fix the
 * letters were hollow, only their outline drawn. text-conv adds its vertical text case here.
 * Own hub without LibreOffice (`ORDO_LIBREOFFICE=off`, as a lite hub runs) on its row of `ports.ts`
 * ('pptx-text').
 */
const PORT = portOf('pptx-text');
const OUT = 'test-results/pptx-text';
/** The I's stem is within this of black in every channel (it was the white ground before). */
const BLACK_TOL = 40;

type TextRec = {
  type: string;
  text?: string;
  style?: { color: { r: number; g: number; b: number; a: number }; outline?: { width: number } };
  runs?: { color?: { a: number } }[];
};
type Job = { id: string; kind: string; state: string; log: string[]; result?: { presentationId: string } };

/** The ink of a capture (any channel darker than 200): its bounding box in device px. */
function inkBox(px: Pixels): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = px.width;
  let y0 = px.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      const i = (y * px.width + x) * 4;
      if (Math.min(px.data[i]!, px.data[i + 1]!, px.data[i + 2]!) < 200) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  return { x0, y0, x1, y1 };
}

/** The brightest channel over a 5x5 patch at (cx, cy): 0 is black. */
function patchMax(px: Pixels, cx: number, cy: number): number {
  let m = 0;
  for (let y = cy - 2; y <= cy + 2; y++)
    for (let x = cx - 2; x <= cx + 2; x++) {
      const i = (y * px.width + x) * 4;
      m = Math.max(m, px.data[i]!, px.data[i + 1]!, px.data[i + 2]!);
    }
  return m;
}

/** Dark red outline pixels (red over 90, green and blue under 60). */
function outlinePixels(px: Pixels): number {
  let n = 0;
  for (let i = 0; i < px.data.length; i += 4)
    if (px.data[i]! > 90 && px.data[i + 1]! < 60 && px.data[i + 2]! < 60) n++;
  return n;
}

test('picture-filled text imported in the browser and by the hub draws its letters filled on Audience', async ({
  context,
  page,
}) => {
  test.setTimeout(300_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = pictureTextDeck(join(OUT, 'deck'));

  const before = process.env.ORDO_LIBREOFFICE;
  process.env.ORDO_LIBREOFFICE = 'off';
  const hub = await pptxHub(PORT);
  if (before === undefined) delete process.env.ORDO_LIBREOFFICE;
  else process.env.ORDO_LIBREOFFICE = before;
  try {
    const a = await hubApi(PORT);

    // ---- The Import tab: the deck is parsed in the operator's import worker, the hub checks its scene.
    await login(page, opOrigin(PORT));
    await page.evaluate(() => {
      location.hash = '#/library/import';
    });
    await page.locator('input[name="pptx-import-mode"][value="native"]').check();
    await page.locator('input[type=file][accept*=".pptx"]').setInputFiles(deck);
    await expect(
      page
        .locator('[data-pptx-import]')
        .first()
        .getByText(/^done$/),
    ).toBeVisible({
      timeout: 120_000,
    });
    const jobs = (await (await a.get('jobs')).json()) as Job[] | { jobs: Job[] };
    const tabJob = (Array.isArray(jobs) ? jobs : jobs.jobs).find((j) => j.kind === 'pptx-native')!;
    const full = await apiJson<Job>(a, `jobs/${tabJob.id}`);
    expect(full.log.join('\n')).toMatch(/parsed in the browser: the hub checked its scene/);
    const fromBrowser = await apiJson<PresentationRec>(a, `presentations/${full.result!.presentationId}`);

    // ---- The hub's route: the hub parses the deck itself.
    const hubJob = await importPptx(a, deck);
    const fromHub = await apiJson<PresentationRec>(a, `presentations/${hubJob.result!.presentationId}`);

    // Both store the letters opaque, in the text colour (tx1: black), their dark red outline kept.
    for (const [name, p] of [
      ['browser', fromBrowser],
      ['hub', fromHub],
    ] as const) {
      const [s] = slidesOf(p);
      expect(s!.pptx?.class, name).toBe('native');
      const t = s!.objects.find((o) => o.type === 'text') as TextRec | undefined;
      expect(t?.text, name).toBe('HIH');
      expect(t!.style!.color, name).toEqual({ r: 0, g: 0, b: 0, a: 1 });
      expect(t!.style!.outline?.width, name).toBeGreaterThan(0);
      for (const r of t!.runs ?? []) expect(r.color?.a ?? 1, name).toBe(1);
    }

    // ---- Audience 1 at 1920x1080 on WebGPU: the I's stem is black (hollow: the white ground showed).
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: {
        name: 'Picture text',
        items: [
          { id: 'browser', kind: 'presentation', presentationId: fromBrowser.id },
          { id: 'hub', kind: 'presentation', presentationId: fromHub.id },
        ],
      },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const audience = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
    const w = await roleWindow(context, PORT, audience, { width: 1920, height: 1080 }, 'renderer=webgpu');
    await cacheReady(w);
    await expect.poll(async () => (await telemetryOf(w)).compositor).toBe('webgpu');
    for (const [cue, name] of [
      [0, 'browser'],
      [1, 'hub'],
    ] as const) {
      await liveEvent(a, { k: 'go', cueIndex: cue, at: Date.now() });
      await settledOn(w, cue);
      let stem = 255;
      let box = { x0: 0, y0: 0, x1: -1, y1: -1 };
      let red = 0;
      await expect
        .poll(
          async () => {
            const px = await capture(w, join(OUT, `audience-${name}.png`));
            box = inkBox(px);
            // 'HIH' is centred and symmetric: the middle of its ink is the middle of the I's stem.
            stem = patchMax(px, Math.round((box.x0 + box.x1) / 2), Math.round((box.y0 + box.y1) / 2));
            red = outlinePixels(px);
            return stem;
          },
          { timeout: 20_000, intervals: [300, 600, 1000] },
        )
        .toBeLessThanOrEqual(BLACK_TOL);
      console.log(
        `${name}: ink ${box.x0}-${box.x1} x ${box.y0}-${box.y1}, I stem ${stem}/255, outline pixels ${red}`,
      );
      // The letters are 200 pt (about 280 px tall at 1920) and keep their outline.
      expect(box.y1 - box.y0, name).toBeGreaterThan(200);
      expect(red, `${name}: the dark red outline is drawn`).toBeGreaterThan(1000);
    }
  } finally {
    hub.kill();
  }
});
