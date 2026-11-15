import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { hubApi } from './linkhelpers.ts';
import { LINE_ART_BLACK_BOX, lineArtDeck, lineArtInk } from './pptxdecks.ts';
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
  telemetryOf,
} from './pptxlive.ts';
import type { Pixels } from './png.ts';

/**
 * A GO never waits for drawing (design/14 "Late units", design/17 "A GO never waits for drawing"; owner decision
 * 2026-11-13, wave r2b units-live), end to end. Line art past the slide's drawing budget (`pptxdecks.ts`
 * `lineArtDeck`, through the real upload route to a hub without LibreOffice) needs a geometry unit; the output's
 * unit turns are slowed (`?unitTurnMs=`, test mode only) so the unit takes a known while to make.
 * - Row 0, an Audience window at 1920 x 1080 (Canvas 2D: this container's WebGPU is SwiftShader, whose strip
 *   uploads alone take a frame or more of a full-frame picture; `?warm=off` so nothing is made ahead): a GO to a cue neither
 *   armed nor warmed flips on its frame (no late flip; within the 33 ms lead plus one frame) with the line art's
 *   stand-in, and the line art fades in within 1 s of the GO; a GO 50 ms after its cue was armed (the arm still
 *   making the unit) flips the same way, the arm hurried.
 * - Row 1: after Go live, the units of the next three cues are made before they are armed (`__ordo.state()`).
 * At 62a1c3a the jump waits for its unit (a late flip) and nothing is warmed ahead.
 */
const OUT = 'test-results/units-live';
/** The GO lead the operator gives a GO (ms). */
const LEAD_MS = 33;
/** The black share of the black line art's box may differ from its ink coverage by this much (edges, overlap). */
const INK_TOLERANCE = 0.05;
/** Each turn of unit making waits this long (ms) on the test outputs. */
const TURN_MS = 40;

type Presentation = { id: string; sections: { slides: { id: string; pptx?: { class: string } }[] }[] };
type UnitsState = {
  units: {
    made: number;
    late: number;
    warmed: number[];
    lateDrawn: Record<string, number>;
  };
  keys: { live: Record<string, string>; armed: Record<string, string> };
  held: { live: string; armed: string }[];
  inflight: string[];
  log: string[];
};
type Tel = Awaited<ReturnType<typeof telemetryOf>> & {
  lateFlips?: number;
  slideFlip?: { cue: number; at: number };
};

/** The share of pixels in a logical box of the picture darker than `dark` in every channel. */
function blackShare(img: Pixels, box: { x: number; y: number; w: number; h: number }, dark = 48): number {
  const sx = img.width / 1920;
  const sy = img.height / 1080;
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

/** The cue a slide key draws (`sl|<look>|<sig>|<cue>|...`), -1 for none. */
const cueOfKey = (key: string | undefined) => Number(/^sl\|[^|]*\|[^|]*\|(\d+)\|/.exec(key ?? '')?.[1] ?? -1);

const stateOf = (p: Page) =>
  p.evaluate(() =>
    (window as unknown as { __ordo: { state(): unknown } }).__ordo.state(),
  ) as Promise<UnitsState>;

/** A slides presentation of plain text slides (no units), one per title. */
async function textDeck(a: Awaited<ReturnType<typeof hubApi>>, titles: string[]): Promise<string> {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const p = await apiJson<{ id: string }>(a, 'presentations', {
    post: {
      title: `Words ${Date.now()}`,
      kind: 'slides',
      sections: [
        {
          id: 'sec',
          label: 'Words',
          short: 'W',
          slides: titles.map((t, i) => ({
            id: `w${i}`,
            objects: [
              {
                id: `t${i}`,
                type: 'text',
                box: { x: 160, y: 400, w: 1600, h: 200, rotation: 0 },
                text: t,
                style: { fontFamily: 'Inter', fontSizePx: 72, color: white },
                opacity: 1,
              },
            ],
          })),
        },
      ],
    },
  });
  return p.id;
}

/** Import the line-art deck's `variant` and check it arrived as one native slide. */
async function lineArt(a: Awaited<ReturnType<typeof hubApi>>, variant: number): Promise<string> {
  const job = await importPptx(a, lineArtDeck(join(OUT, `deck-${variant}`), variant));
  const p = await apiJson<Presentation>(a, `presentations/${job.result!.presentationId}`);
  const slides = p.sections.flatMap((s) => s.slides);
  expect(slides).toHaveLength(1);
  expect(slides[0]!.pptx?.class).toBe('native');
  return p.id;
}

/** A hub without LibreOffice on `port` (the deck's slide is the converter's drawing, as on the lite image). */
async function hubWithoutLibreOffice(port: number) {
  const before = process.env.ORDO_LIBREOFFICE;
  process.env.ORDO_LIBREOFFICE = 'off';
  try {
    return await pptxHub(port);
  } finally {
    if (before === undefined) delete process.env.ORDO_LIBREOFFICE;
    else process.env.ORDO_LIBREOFFICE = before;
  }
}

/**
 * GO to `cue` at its lead and wait until the output shows it: the lateness of its flip (the frame that drew it
 * against the GO's time, ms) and the late flips counted meanwhile.
 */
async function go(a: Awaited<ReturnType<typeof hubApi>>, w: Page, cue: number) {
  await w.bringToFront();
  const late0 = ((await telemetryOf(w)) as Tel).lateFlips ?? 0;
  const at = Date.now() + LEAD_MS;
  await liveEvent(a, { k: 'go', cueIndex: cue, at });
  return flipped(w, cue, at, late0);
}

/** Wait until the output shows `cue`, GOed for hub time `at`: its flip's lateness and the late flips since `late0`. */
async function flipped(w: Page, cue: number, at: number, late0: number) {
  let flip = { cue: -1, at: 0 };
  await expect
    .poll(
      async () => {
        flip = ((await telemetryOf(w)) as Tel).slideFlip ?? flip;
        return flip.cue;
      },
      { timeout: 10_000, intervals: [20, 50, 100] },
    )
    .toBe(cue);
  const late = (((await telemetryOf(w)) as Tel).lateFlips ?? 0) - late0;
  return { at, flipLate: flip.at - at, lateFlips: late };
}

/** Wait until the renderer holds the armed cue's slide (its arm is done). */
async function armedHeld(w: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const st = await stateOf(w);
        const k = st.keys.armed.slide ?? '';
        return k !== '' && st.held[1]?.armed === k;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Wait until the slide of `cue` was drawn again with its late parts; when (Date ms). */
async function lateDrawn(w: Page, cue: number, timeout = 5000): Promise<number> {
  let at = 0;
  await expect
    .poll(
      async () => {
        const st = await stateOf(w);
        const key = st.keys.live.slide ?? '';
        at = st.units.lateDrawn[key] ?? 0;
        return cueOfKey(key) === cue && at > 0;
      },
      { timeout, intervals: [20, 50, 100] },
    )
    .toBe(true);
  return at;
}

test('a GO to a slide not prepared, or 50 ms after its arm, flips at once and its line art fades in', async ({
  context,
}) => {
  test.setTimeout(360_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const ink = lineArtInk();
  const hub = await hubWithoutLibreOffice(portOf('units-live', 0));
  try {
    const a = await hubApi(portOf('units-live', 0));
    const words = await textDeck(a, ['Welcome']);
    // The variants share their geometry files (the same paths, moved): the armed cue 1 reads them, so the jump's
    // own drawing is what the slide budget holds it to; their units are each their own.
    const art0 = await lineArt(a, 0);
    const prayer = await textDeck(a, ['Prayer']);
    const artA = await lineArt(a, 1);
    const artB = await lineArt(a, 2);
    // Cues: 0 words, 1 line art 0, 2 words, 3 line art A, 4-5 words, 6 line art B.
    const more = await textDeck(a, ['Offering', 'Blessing']);
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: {
        name: 'Units live',
        items: [
          { id: 'w', kind: 'presentation', presentationId: words },
          { id: 'z', kind: 'presentation', presentationId: art0 },
          { id: 'p', kind: 'presentation', presentationId: prayer },
          { id: 'a', kind: 'presentation', presentationId: artA },
          { id: 'm', kind: 'presentation', presentationId: more },
          { id: 'b', kind: 'presentation', presentationId: artB },
        ],
      },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const audience = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
    const w = await roleWindow(
      context,
      portOf('units-live', 0),
      audience,
      { width: 1920, height: 1080 },
      `test=1&renderer=2d&warm=off&unitTurnMs=${TURN_MS}`,
    );
    await cacheReady(w);
    await expect.poll(async () => (await telemetryOf(w)).compositor).toBe('2d');

    // 1. Cue 0 live (armed 1, warmed 2), then a jump to cue 3: neither armed nor warmed.
    await armedHeld(w);
    await go(a, w, 0);
    await armedHeld(w);
    await w.waitForTimeout(500);
    const jump = await go(a, w, 3);
    console.log(`jump: flip ${jump.flipLate.toFixed(1)} ms after its GO time, late flips ${jump.lateFlips}`);
    expect(jump.lateFlips, 'the jump flips on its frame (no late flip)').toBe(0);
    expect(jump.flipLate, 'within the lead plus one frame').toBeLessThanOrEqual(17);
    const drawnA = await lateDrawn(w, 3);
    // The re-draw reached the renderer; its fade is 300 ms.
    const fadedA = drawnA + 300 - (jump.at - LEAD_MS);
    console.log(`jump: line art faded in ${fadedA} ms after the GO`);
    expect(fadedA, 'the line art fades in within 1 s of the GO').toBeLessThanOrEqual(1000);
    await w.waitForTimeout(400);
    const img = await capture(w, join(OUT, 'jump-after.png'));
    expect(
      Math.abs(blackShare(img, LINE_ART_BLACK_BOX) - ink),
      'the line art is drawn whole',
    ).toBeLessThanOrEqual(INK_TOLERANCE);
    expect((await stateOf(w)).units.late).toBeGreaterThanOrEqual(1);

    // 2. A jump to cue 5 arms cue 6 (line art B, never warmed: cue 5 was not live before); a GO 50 ms after
    //    that arm, while it is still making the unit, hurries it.
    const late0 = ((await telemetryOf(w)) as Tel).lateFlips ?? 0;
    await liveEvent(a, { k: 'go', cueIndex: 5, at: Date.now() + LEAD_MS });
    await w.waitForTimeout(50);
    const atB = Date.now() + LEAD_MS;
    await liveEvent(a, { k: 'go', cueIndex: 6, at: atB });
    const soon = await flipped(w, 6, atB, late0);
    expect((await stateOf(w)).log.join('\n')).not.toMatch(/quarantined/);
    console.log(
      `GO 50 ms after the arm: flip ${soon.flipLate.toFixed(1)} ms after its GO time, late flips ${soon.lateFlips}`,
    );
    expect(soon.lateFlips, 'the GO after the arm flips on its frame').toBe(0);
    expect(soon.flipLate, 'within the lead plus one frame').toBeLessThanOrEqual(17);
    const drawnB = await lateDrawn(w, 6);
    expect(drawnB + 300 - (soon.at - LEAD_MS), 'its line art fades in within 1 s').toBeLessThanOrEqual(1000);
    expect((await telemetryOf(w)).error ?? '').toBe('');
    // The output's switches reached its asset worker (`?warm=off`, test mode's `?unitTurnMs`).
    expect((await stateOf(w)).log.join('\n')).toMatch(/drawing switches: .*warm=false.*unitTurnMs=40/);
  } finally {
    hub.kill();
  }
});

test('after Go live the units of the next three cues are made before they are armed', async ({ context }) => {
  test.setTimeout(360_000);
  const dir = join(OUT, 'warm');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const hub = await hubWithoutLibreOffice(portOf('units-live', 1));
  try {
    const a = await hubApi(portOf('units-live', 1));
    const words = await textDeck(a, ['Welcome']);
    const items: { id: string; kind: 'presentation'; presentationId: string }[] = [
      { id: 'w', kind: 'presentation', presentationId: words },
    ];
    for (let v = 3; v <= 6; v++)
      items.push({ id: `a${v}`, kind: 'presentation', presentationId: await lineArt(a, v) });
    const pl = await apiJson<{ id: string }>(a, 'playlists', { post: { name: 'Warm', items } });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const audience = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
    const w = await roleWindow(
      context,
      portOf('units-live', 1),
      audience,
      { width: 1920, height: 1080 },
      'renderer=2d',
    );
    await cacheReady(w);
    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() + LEAD_MS });
    await expect.poll(async () => cueOfKey((await stateOf(w)).keys.live.slide)).toBe(0);
    // Cue 0 live, 1 armed, 2 warmed by its warm job: cues 1, 2 and 3 (and on) are warmed ahead in cue order.
    await expect
      .poll(async () => (await stateOf(w)).units.warmed, { timeout: 60_000, intervals: [200, 500, 1000] })
      .toEqual(expect.arrayContaining([1, 2, 3]));
    const st = await stateOf(w);
    // Cue 3 is neither armed nor warmed by the cue jobs: only the warm-up made its unit.
    expect(cueOfKey(st.keys.armed.slide)).toBe(1);
    expect(st.units.warmed.indexOf(1)).toBeLessThan(st.units.warmed.indexOf(3));
    expect(st.units.made).toBeGreaterThanOrEqual(3);
    // A GO to cue 3 then makes no unit late.
    const late0 = st.units.late;
    await liveEvent(a, { k: 'go', cueIndex: 3, at: Date.now() + LEAD_MS });
    await expect.poll(async () => cueOfKey((await stateOf(w)).keys.live.slide)).toBe(3);
    await w.waitForTimeout(500);
    expect((await stateOf(w)).units.late).toBe(late0);
  } finally {
    hub.kill();
  }
});
