import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { convertDeck, NativeRenderer } from '../tools/pptx-fidelity/src/native.ts';
import { hubApi } from './linkhelpers.ts';
import { decodePng, type Pixels } from './png.ts';
import { LINE_ART_BLACK_BOX, lineArtDeck, lineArtInk } from './pptxdecks.ts';
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
  ssim,
  telemetryOf,
} from './pptxlive.ts';

/**
 * Line art past the slide's drawing budget, end to end (design/27 §12-13 "Geometry units", M9 decisions
 * "Slow-to-draw elements", Runtime: draw it, never drop it). A synthetic deck (`pptxdecks.ts` `lineArtDeck`: a
 * white and a navy line art under a black one, each a custom geometry of 320 holes and 4,164 points a path,
 * together past `GEOM_COST.slide`) goes through the real upload route to a hub without LibreOffice and goes live.
 * Audience 1 at 1920x1080 (WebGPU) and Audience 2 at 3840x2160 (Canvas 2D) draw the black line art whole, from
 * its geometry unit:
 * - the black share of its box is its ink coverage within 0.05 (a legacy rect is all black, about 1.0; a legacy
 *   line draws nothing, 0);
 * - the slide is the fidelity harness's native page's drawing (SSIM at least 0.99, greyscale 960x540).
 * Its own hub on ORDO_E2E_LINEART_PORT (default 8410).
 */
const PORT = Number(process.env.ORDO_E2E_LINEART_PORT ?? 8410);
const OUT = 'test-results/pptx-lineart';
const FLOOR = 0.99;
/** The black share of the black line art's box may differ from its ink coverage by this much (edges, overlap). */
const INK_TOLERANCE = 0.05;

/** The share of pixels in a logical box of the picture darker than `dark` in every channel. */
function blackShare(img: Pixels, box: { x: number; y: number; w: number; h: number }, dark = 48): number {
  const sx = img.width / 1920;
  const sy = img.height / 1080;
  // Inset by 1 % of the box: the frame's edge pixels are anti-aliased.
  const x0 = Math.ceil((box.x + box.w * 0.01) * sx);
  const y0 = Math.ceil((box.y + box.h * 0.01) * sy);
  const x1 = Math.floor((box.x + box.w * 0.99) * sx);
  const y1 = Math.floor((box.y + box.h * 0.99) * sy);
  let n = 0;
  let black = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      n++;
      if (img.data[o]! < dark && img.data[o + 1]! < dark && img.data[o + 2]! < dark) black++;
    }
  return n ? black / n : 0;
}

type Presentation = { id: string; sections: { slides: { id: string; pptx?: { class: string } }[] }[] };

test('line art past the slide budget is drawn whole on the Audience screens, as the harness draws it', async ({
  context,
}) => {
  test.setTimeout(360_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deckFile = lineArtDeck(join(OUT, 'deck'));
  const ink = lineArtInk();

  // The harness's reading of the same deck (tools/pptx-fidelity), drawn once the outputs are up.
  const harnessDir = join(OUT, 'harness');
  mkdirSync(harnessDir, { recursive: true });
  const converted = await convertDeck(deckFile, harnessDir);
  expect(converted.error).toBeUndefined();

  // A hub without LibreOffice: the deck's slide is the converter's drawing, as on the lite image.
  const before = process.env.ORDO_LIBREOFFICE;
  process.env.ORDO_LIBREOFFICE = 'off';
  const hub = await pptxHub(PORT);
  if (before === undefined) delete process.env.ORDO_LIBREOFFICE;
  else process.env.ORDO_LIBREOFFICE = before;
  try {
    const a = await hubApi(PORT);
    const job = await importPptx(a, deckFile);
    const p = await apiJson<Presentation>(a, `presentations/${job.result!.presentationId}`);
    const slides = p.sections.flatMap((s) => s.slides);
    expect(slides).toHaveLength(1);
    expect(slides[0]!.pptx?.class).toBe('native');
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: { name: 'Line art', items: [{ id: 'deck', kind: 'presentation', presentationId: p.id }] },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });

    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const byHost = (n: number) => outs.find((o) => o.hostIndex === n && o.kind !== 'stage')!;
    const hd = await roleWindow(context, PORT, byHost(1), { width: 1920, height: 1080 }, 'renderer=webgpu');
    const uhd = await roleWindow(context, PORT, byHost(2), { width: 3840, height: 2160 }, 'renderer=2d');
    for (const w of [hd, uhd]) await cacheReady(w);
    await expect.poll(async () => (await telemetryOf(hd)).compositor).toBe('webgpu');
    await expect.poll(async () => (await telemetryOf(uhd)).compositor).toBe('2d');

    const renderer = await NativeRenderer.start(chromium.executablePath());
    let rendered: Awaited<ReturnType<NativeRenderer['renderDeck']>>;
    try {
      rendered = await renderer.renderDeck(converted, harnessDir, { repeats: 0 });
    } finally {
      await renderer.close();
    }
    expect(rendered.slides.map((s) => s.error ?? 'ok')).toEqual(['ok']);
    const harnessPng = join(harnessDir, rendered.slides[0]!.png!);
    const harnessShare = blackShare(decodePng(readFileSync(harnessPng)), LINE_ART_BLACK_BOX);
    console.log(`black line art: ink ${ink.toFixed(3)}, the harness's page ${harnessShare.toFixed(3)}`);
    expect(Math.abs(harnessShare - ink), "the harness's page draws the line art whole").toBeLessThanOrEqual(
      INK_TOLERANCE,
    );

    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
    const scores: string[] = [];
    for (const [w, name] of [
      [hd, '1080p'],
      [uhd, '4k'],
    ] as const) {
      await settledOn(w, 0);
      const file = join(OUT, `cue0-${name}.png`);
      let share = 1;
      let s = 0;
      // A unit is made at arm and copied at GO: poll for the settled frame.
      await expect
        .poll(
          async () => {
            const img = await capture(w, file);
            share = blackShare(img, LINE_ART_BLACK_BOX);
            s = ssim(file, harnessPng);
            return Math.abs(share - ink) <= INK_TOLERANCE && s >= FLOOR;
          },
          { timeout: 20_000, intervals: [300, 700, 1500] },
        )
        .toBe(true)
        .catch(() => undefined);
      scores.push(`${name}: black share ${share.toFixed(3)} (ink ${ink.toFixed(3)}), SSIM ${s.toFixed(4)}`);
      expect(
        Math.abs(share - ink),
        `${name}: the black share of the line art's box is its ink`,
      ).toBeLessThanOrEqual(INK_TOLERANCE);
      expect(s, `${name}: SSIM against the harness's page`).toBeGreaterThanOrEqual(FLOOR);
    }
    console.log(`line art on the Audience screens: ${scores.join('; ')}`);
    for (const w of [hd, uhd]) expect((await telemetryOf(w)).error ?? '').toBe('');
  } finally {
    hub.kill();
  }
});
