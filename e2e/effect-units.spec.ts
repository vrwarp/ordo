import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import type { ShapeObject } from '../packages/domain/src/index.ts';
import { convertDeck, NativeRenderer } from '../tools/pptx-fidelity/src/native.ts';
import { hubApi } from './linkhelpers.ts';
import { decodePng, type Pixels } from './png.ts';
import { LONE_CHAIN_BOX, loneLineArtDeck } from './pptxdecks.ts';
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
 * Effect units end to end (r2b effect units, design/14 "Effect units"): what the slide's drawing budget would draw
 * as a lesser legacy copy is drawn on the Audience screens from a unit made beforehand.
 * - Effects past the budget (row 0): a slide through the hub API of one full-frame soft-edged shape (8 of the
 *   effect budget's 10) and 12 shadowed panels, the last three past `EFFECT_COST.slide`, their units about 0.37 of
 *   a frame. Audience 1 at 1920 (WebGPU) and Audience 2 at 3840 (Canvas 2D) show each past-budget panel's shadow
 *   (the frame's colour darkened just beside it; 62a1c3a drew those three without) and the soft edge.
 * - Hostile lone line art (row 1): `loneLineArtDeck` (one thin chain past `GEOM_COST.slide` on its own) through the
 *   real upload route to a hub without LibreOffice: the Audience screens ink the chain's box as the fidelity
 *   harness's page does, within 0.05 (62a1c3a drew its legacy line: nothing, and so did the harness).
 */
const OUT = 'test-results/effect-units';
/** The soft-edged frame's colour, and how much darker a shadow makes it at least (levels, every channel). */
const FRAME = { r: 250, g: 236, b: 200 } as const;
const SHADOW_DARKER = 20;
const INK_TOLERANCE = 0.05;

const shadow = { dx: 6, dy: 6, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.55 } };
const panel = (id: string, x: number, y: number, w: number, h: number): ShapeObject => ({
  id,
  type: 'shape',
  box: { x, y, w, h, rotation: 0 },
  shape: 'rect',
  fill: { r: 40, g: 110, b: 190, a: 1 },
  opacity: 1,
  radius: 0,
  geom: { preset: 'roundRect' },
  shadow,
});
/** The three panels past the effect budget (each about 0.124 of a slide area of layer), free of other shadows. */
const LATE = [
  { id: 'late-1', x: 1100, y: 90, w: 680, h: 320 },
  { id: 'late-2', x: 1100, y: 440, w: 680, h: 320 },
  { id: 'late-3', x: 250, y: 700, w: 680, h: 280 },
] as const;
/** Where each late panel's shadow shows, past its right edge, in logical px (the frame's opaque interior). */
const SHADOW_AT = LATE.map((p) => ({ id: p.id, x: p.x + p.w + 4, y: p.y + p.h / 2 + 20 }));

function effectsSlide() {
  const soft: ShapeObject = {
    id: 'soft',
    type: 'shape',
    box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
    shape: 'rect',
    fill: { ...FRAME, a: 1 },
    opacity: 1,
    radius: 0,
    geom: { preset: 'rect' },
    softEdge: 60,
  };
  // Nine stacked panels within the budget (8 + 9 x 0.21), then the three past it.
  const kept = Array.from({ length: 9 }, (_, i) => panel(`kept-${i}`, 100, 100, 800, 480));
  return { id: 'effects', objects: [soft, ...kept, ...LATE.map((p) => panel(p.id, p.x, p.y, p.w, p.h))] };
}

/** The pixel at a logical point of a capture (RGBA). */
function at(img: Pixels, x: number, y: number): [number, number, number] {
  const o = (Math.round(y * (img.height / 1080)) * img.width + Math.round(x * (img.width / 1920))) * 4;
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
}

/** The share of pixels in a logical box darker than `dark` in every channel. */
function blackShare(img: Pixels, box: { x: number; y: number; w: number; h: number }, dark = 96): number {
  const sx = img.width / 1920;
  const sy = img.height / 1080;
  let n = 0;
  let black = 0;
  for (let y = Math.ceil(box.y * sy); y < Math.floor((box.y + box.h) * sy); y++)
    for (let x = Math.ceil(box.x * sx); x < Math.floor((box.x + box.w) * sx); x++) {
      const o = (y * img.width + x) * 4;
      n++;
      if (img.data[o]! < dark && img.data[o + 1]! < dark && img.data[o + 2]! < dark) black++;
    }
  return n ? black / n : 0;
}

test('shadows past the effect budget and the soft edge are drawn on the Audience screens', async ({
  context,
}) => {
  test.setTimeout(300_000);
  const port = portOf('effect-units', 0);
  const out = join(OUT, 'effects');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const hub = await pptxHub(port);
  try {
    const a = await hubApi(port);
    const p = await apiJson<{ id: string }>(a, 'presentations', {
      post: {
        title: 'Effects past the budget',
        kind: 'slides',
        sections: [{ id: 'sec', label: 'Effects', short: 'E', slides: [effectsSlide()] }],
      },
    });
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: { name: 'Effects', items: [{ id: 'deck', kind: 'presentation', presentationId: p.id }] },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const byHost = (n: number) => outs.find((o) => o.hostIndex === n && o.kind !== 'stage')!;
    const hd = await roleWindow(context, port, byHost(1), { width: 1920, height: 1080 }, 'renderer=webgpu');
    const uhd = await roleWindow(context, port, byHost(2), { width: 3840, height: 2160 }, 'renderer=2d');
    for (const w of [hd, uhd]) await cacheReady(w);
    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
    const lines: string[] = [];
    for (const [w, name] of [
      [hd, '1080p'],
      [uhd, '4k'],
    ] as const) {
      await settledOn(w, 0);
      const file = join(out, `cue0-${name}.png`);
      let darker: number[] = [];
      let edge = 0;
      // The units are made at arm: poll for the settled frame.
      await expect
        .poll(
          async () => {
            const img = await capture(w, file);
            darker = SHADOW_AT.map((s) =>
              Math.min(...at(img, s.x, s.y).map((v, k) => [FRAME.r, FRAME.g, FRAME.b][k]! - v)),
            );
            const [r] = at(img, 3, 540);
            edge = FRAME.r - r;
            return darker.every((d) => d >= SHADOW_DARKER) && edge >= SHADOW_DARKER;
          },
          { timeout: 20_000, intervals: [300, 700, 1500] },
        )
        .toBe(true)
        .catch(() => undefined);
      lines.push(`${name}: late shadows darker by ${darker.join(', ')}; soft edge darker by ${edge}`);
      for (const [i, d] of darker.entries())
        expect(d, `${name}: ${SHADOW_AT[i]!.id}'s shadow (62a1c3a drew it without)`).toBeGreaterThanOrEqual(
          SHADOW_DARKER,
        );
      expect(edge, `${name}: the frame's soft edge`).toBeGreaterThanOrEqual(SHADOW_DARKER);
    }
    console.log(`effects on the Audience screens: ${lines.join('; ')}`);
    for (const w of [hd, uhd]) expect((await telemetryOf(w)).error ?? '').toBe('');
  } finally {
    hub.kill();
  }
});

test('hostile lone line art is drawn on the Audience screens, as the harness draws it', async ({
  context,
}) => {
  test.setTimeout(360_000);
  const port = portOf('effect-units', 1);
  const out = join(OUT, 'chain');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const deckFile = loneLineArtDeck(join(out, 'deck'));
  const harnessDir = join(out, 'harness');
  mkdirSync(harnessDir, { recursive: true });
  const converted = await convertDeck(deckFile, harnessDir);
  expect(converted.error).toBeUndefined();
  const before = process.env.ORDO_LIBREOFFICE;
  process.env.ORDO_LIBREOFFICE = 'off';
  const hub = await pptxHub(port);
  if (before === undefined) delete process.env.ORDO_LIBREOFFICE;
  else process.env.ORDO_LIBREOFFICE = before;
  try {
    const a = await hubApi(port);
    const job = await importPptx(a, deckFile);
    type Presentation = { id: string; sections: { slides: { pptx?: { class: string } }[] }[] };
    const p = await apiJson<Presentation>(a, `presentations/${job.result!.presentationId}`);
    expect(p.sections.flatMap((s) => s.slides).map((s) => s.pptx?.class)).toEqual(['native']);
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: { name: 'Chain', items: [{ id: 'deck', kind: 'presentation', presentationId: p.id }] },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const byHost = (n: number) => outs.find((o) => o.hostIndex === n && o.kind !== 'stage')!;
    const hd = await roleWindow(context, port, byHost(1), { width: 1920, height: 1080 }, 'renderer=webgpu');
    const uhd = await roleWindow(context, port, byHost(2), { width: 3840, height: 2160 }, 'renderer=2d');
    for (const w of [hd, uhd]) await cacheReady(w);

    const renderer = await NativeRenderer.start(chromium.executablePath());
    let rendered: Awaited<ReturnType<NativeRenderer['renderDeck']>>;
    try {
      rendered = await renderer.renderDeck(converted, harnessDir, { repeats: 0 });
    } finally {
      await renderer.close();
    }
    expect(rendered.slides.map((s) => s.error ?? 'ok')).toEqual(['ok']);
    const page = blackShare(
      decodePng(readFileSync(join(harnessDir, rendered.slides[0]!.png!))),
      LONE_CHAIN_BOX,
    );
    // The harness draws it too (62a1c3a's harness drew the legacy line as the outputs did: nothing).
    expect(page, "the harness's page inks the chain").toBeGreaterThan(0.01);

    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
    const lines: string[] = [];
    for (const [w, name] of [
      [hd, '1080p'],
      [uhd, '4k'],
    ] as const) {
      await settledOn(w, 0);
      const file = join(out, `cue0-${name}.png`);
      let share = 0;
      await expect
        .poll(
          async () => {
            share = blackShare(await capture(w, file), LONE_CHAIN_BOX);
            return Math.abs(share - page) <= INK_TOLERANCE;
          },
          { timeout: 20_000, intervals: [300, 700, 1500] },
        )
        .toBe(true)
        .catch(() => undefined);
      lines.push(`${name}: ink ${share.toFixed(3)} (harness ${page.toFixed(3)})`);
      expect(
        Math.abs(share - page),
        `${name}: the chain's ink against the harness's page`,
      ).toBeLessThanOrEqual(INK_TOLERANCE);
    }
    console.log(`lone line art on the Audience screens: ${lines.join('; ')}`);
    for (const w of [hd, uhd]) expect((await telemetryOf(w)).error ?? '').toBe('');
  } finally {
    hub.kill();
  }
});
