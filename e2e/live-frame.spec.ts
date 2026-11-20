import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import type { ShapeObject, SlideObject } from '../packages/domain/src/index.ts';
import { uploadMedia } from './helpers.ts';
import { hubApi } from './linkhelpers.ts';
import type { Pixels } from './png.ts';
import { portOf } from './ports.ts';
import {
  apiJson,
  at,
  cacheReady,
  capture,
  diffShare,
  liveEvent,
  type OutputRec,
  pptxHub,
  roleWindow,
  settledOn,
  telemetryOf,
} from './pptxlive.ts';

/**
 * The underlay frame end to end (r2b sub-wave 2, design 29 R1, design/14 "The underlay frame"): a slide with more
 * than 200 shapes or more than 16 pictures, and effects past one frame of units, are drawn whole on the Audience
 * screens: what lies under the live raster is made in slices as one frame, copied under it, and fades in when it
 * is late. One hub without LibreOffice, a slide of 340 squares, 24 pictures and four text boxes through the hub
 * API (the schema allows 1,000 objects).
 * - (A) crowded: both Audience windows (1920 and 3840) show every square, picture and text box the slide holds
 *   (the base kept the first 200 objects: its squares 0-199 and nothing else);
 * - (B) late: a jump to it shows the direct part at once (its text boxes and top pictures), the frame fading in
 *   once it is made (turns slowed by the test hook `?unitTurnMs=`), counted late;
 * - (C) switches: `?frame=off` and `?effects=base` give the cut drawing back;
 * - (D) effects: twelve shadowed panels past one frame of units on a soft-edged frame: every shadow shows;
 * - (E) no regression: an ordinary slide of the same deck is drawn identically with the frame on and off, and
 *   a GO onto it makes no frame.
 * Audience 1 is a WebGPU window and Audience 2 a Canvas 2D one, as e2e/effect-units.spec.ts opens them: a window
 * of Canvas 2D alone presents no frames on a still slide and Playwright's capture then waits on it (minutes, here),
 * while a WebGPU window keeps the browser's compositor producing them (a capture takes 4-10 s on this machine).
 */
const OUT = 'test-results/live-frame';
const LEAD_MS = 33;

/** The 20 x 17 grid: square `i`'s box, and its own colour (no square is another's). */
const cell = (i: number) => ({ x: 20 + (i % 20) * 90, y: 20 + Math.floor(i / 20) * 60, w: 80, h: 50 });
const squareColour = (i: number) => ({
  r: 30 + ((i * 7) % 150),
  g: 40 + ((i * 13) % 150),
  b: 50 + ((i * 29) % 150),
});
const centre = (i: number): [number, number] => [cell(i).x + 40, cell(i).y + 25];
/** Pictures 0-19 lie over the squares 320-339 (row 16), 20-23 over squares 300-303 (row 15): flat colours. */
const PICTURES = 24;
const pictureCell = (p: number) => cell(p < 20 ? 320 + p : 300 + (p - 20));
const pictureColour = (p: number) => ({ r: 250, g: 20 + p * 9, b: 240 - p * 5 });
const pictureCentre = (p: number): [number, number] => [pictureCell(p).x + 40, pictureCell(p).y + 25];
/** Four text boxes in white over squares of rows 5-8 (colours stay under 190: only the text is near white). */
const TEXTS = [
  { id: 'tx0', text: 'Holy', x: 100, y: 330, w: 800, h: 110 },
  { id: 'tx1', text: 'Holy', x: 1000, y: 330, w: 800, h: 110 },
  { id: 'tx2', text: 'Holy', x: 100, y: 520, w: 800, h: 110 },
  { id: 'tx3', text: 'Holy', x: 1000, y: 520, w: 800, h: 110 },
] as const;

/** An 8-bit RGB PNG of one flat colour, 16 x 16 (distinct bytes, so distinct files). */
function flatPng(c: { r: number; g: number; b: number }): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: 16 }, () => [c.r, c.g, c.b]).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: 16 }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const white = { r: 255, g: 255, b: 255, a: 1 };
const lyric = (size: number) => ({
  fontFamily: 'Inter',
  fontSizePx: size,
  fontWeight: 700,
  fontStyle: 'normal',
  color: white,
  align: 'center',
  valign: 'middle',
  lineHeight: 1.1,
  letterSpacing: 0,
  padding: 8,
  transform: 'none',
});

type Api = Awaited<ReturnType<typeof hubApi>>;

/** The crowded slide: 340 squares, 24 pictures over some of them, four text boxes on top. */
function crowdedSlide(mediaIds: string[]) {
  const squares: SlideObject[] = Array.from({ length: 340 }, (_, i) => ({
    id: `sq${i}`,
    type: 'shape',
    box: { ...cell(i), rotation: 0 },
    shape: 'rect',
    fill: { ...squareColour(i), a: 1 },
    opacity: 1,
    radius: 0,
  }));
  const pictures: SlideObject[] = mediaIds.map((mediaId, p) => ({
    id: `pic${p}`,
    type: 'image',
    box: { ...pictureCell(p), rotation: 0 },
    mediaId,
    fit: 'stretch',
    opacity: 1,
    radius: 0,
  }));
  const texts: SlideObject[] = TEXTS.map((t) => ({
    id: t.id,
    type: 'text',
    box: { x: t.x, y: t.y, w: t.w, h: t.h, rotation: 0 },
    text: t.text,
    style: lyric(96),
    opacity: 1,
  })) as SlideObject[];
  return { id: 'crowded', objects: [...squares, ...pictures, ...texts] };
}

/** An ordinary slide of the same deck: 30 squares, three pictures, a text box. */
function ordinarySlide(mediaIds: string[]) {
  const squares: SlideObject[] = Array.from({ length: 30 }, (_, i) => ({
    id: `o-sq${i}`,
    type: 'shape',
    box: { ...cell(i), rotation: 0 },
    shape: 'rect',
    fill: { ...squareColour(i + 400), a: 1 },
    opacity: 1,
    radius: 0,
  }));
  const pictures: SlideObject[] = mediaIds.slice(0, 3).map((mediaId, p) => ({
    id: `o-pic${p}`,
    type: 'image',
    box: { x: 200 + p * 500, y: 500, w: 400, h: 250, rotation: 0 },
    mediaId,
    fit: 'stretch',
    opacity: 1,
    radius: 0,
  }));
  const text: SlideObject = {
    id: 'o-text',
    type: 'text',
    box: { x: 300, y: 800, w: 1300, h: 150, rotation: 0 },
    text: 'How sweet the sound',
    style: lyric(100),
    opacity: 1,
  } as SlideObject;
  return { id: 'ordinary', objects: [...squares, ...pictures, text] };
}

/** The soft-edged frame, nine panels within the effect budget, twelve large shadows past one frame of units. */
const FRAME = { r: 250, g: 236, b: 200 } as const;
const SHADOW_DARKER = 20;
const panel = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  blur: number,
  a: number,
): ShapeObject => ({
  id,
  type: 'shape',
  box: { x, y, w, h, rotation: 0 },
  shape: 'rect',
  fill: { r: 40, g: 110, b: 190, a: 1 },
  opacity: 1,
  radius: 0,
  geom: { preset: 'roundRect' },
  shadow: { dx: blur > 20 ? 8 : 6, dy: blur > 20 ? 8 : 6, blur, color: { r: 0, g: 0, b: 0, a } },
});
const LATE = Array.from({ length: 12 }, (_, i) => ({
  id: `late-${i}`,
  x: 950 + (i % 3) * 290,
  y: 80 + Math.floor(i / 3) * 250,
  w: 250,
  h: 150,
}));
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
  const kept = Array.from({ length: 9 }, (_, i) => panel(`kept-${i}`, 100, 100, 800, 480, 12, 0.55));
  const late = LATE.map((p) => panel(p.id, p.x, p.y, p.w, p.h, 130, 0.7));
  return { id: 'effects', objects: [soft, ...kept, ...late] };
}

const near = (a: [number, number, number], b: { r: number; g: number; b: number }, tol: number) =>
  Math.abs(a[0] - b.r) <= tol && Math.abs(a[1] - b.g) <= tol && Math.abs(a[2] - b.b) <= tol;

/** The share of near-white pixels of a logical box: text ink over the dark squares. */
function whiteShare(img: Pixels, b: { x: number; y: number; w: number; h: number }): number {
  const sx = img.width / 1920;
  const sy = img.height / 1080;
  let n = 0;
  let ink = 0;
  for (let y = Math.ceil(b.y * sy); y < Math.floor((b.y + b.h) * sy); y++)
    for (let x = Math.ceil(b.x * sx); x < Math.floor((b.x + b.w) * sx); x++) {
      const o = (y * img.width + x) * 4;
      n++;
      if (img.data[o]! > 235 && img.data[o + 1]! > 235 && img.data[o + 2]! > 235) ink++;
    }
  return n ? ink / n : 0;
}

/** What of the crowded slide a capture shows. */
function shown(img: Pixels) {
  const sq = (i: number) => near(at(img, centre(i)), squareColour(i), 6);
  const pic = (p: number) => near(at(img, pictureCentre(p)), pictureColour(p), 10);
  return {
    // the bottom of the order: the frame's
    square0: sq(0),
    square199: sq(199),
    picture0: pic(0),
    // the squares the base cut away (it kept the first 200 objects) and the pictures
    square200: sq(200),
    square250: sq(250),
    square299: sq(299),
    picture7: pic(7),
    picture8: pic(8),
    picture23: pic(23),
    texts: TEXTS.map((t) => whiteShare(img, t)).every((s) => s > 0.004),
  };
}
const ALL = {
  square0: true,
  square199: true,
  picture0: true,
  square200: true,
  square250: true,
  square299: true,
  picture7: true,
  picture8: true,
  picture23: true,
  texts: true,
};
/** What the base drew: the first 200 objects only (squares 0-199). */
const CUT = {
  square0: true,
  square199: true,
  picture0: false,
  square200: false,
  square250: false,
  square299: false,
  picture7: false,
  picture8: false,
  picture23: false,
  texts: false,
};

type State = { units: { made: number; late: number; framesMade: number }; log: string[] };
const stateOf = (p: Page) =>
  p.evaluate(() => (window as unknown as { __ordo: { state(): unknown } }).__ordo.state()) as Promise<State>;

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

test.describe.configure({ mode: 'serial' });

let hub: Awaited<ReturnType<typeof pptxHub>>;
let a: Api;
let audience1: OutputRec;
let audience2: OutputRec;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const port = portOf('live-frame', 0);
  hub = await hubWithoutLibreOffice(port);
  a = await hubApi(port);
  // 24 distinct small pictures, each a flat colour of its own.
  const mediaIds: string[] = [];
  for (let p = 0; p < PICTURES; p++) {
    const file = join(OUT, `pic${p}.png`);
    writeFileSync(file, flatPng(pictureColour(p)));
    mediaIds.push((await uploadMedia(a, file, 'image/png')).id);
  }
  const deck = (title: string, slide: { id: string; objects: SlideObject[] }) =>
    apiJson<{ id: string }>(a, 'presentations', {
      post: { title, kind: 'slides', sections: [{ id: 'sec', label: title, short: 'S', slides: [slide] }] },
    });
  const crowded = await deck('Crowded', crowdedSlide(mediaIds));
  const ordinary = await deck('Ordinary', ordinarySlide(mediaIds));
  const effects = await deck('Effects', effectsSlide());
  const ordinary2 = await deck('Ordinary again', { ...ordinarySlide(mediaIds), id: 'ordinary2' });
  const pl = await apiJson<{ id: string }>(a, 'playlists', {
    post: {
      name: 'Live frame',
      items: [
        { id: 'c', kind: 'presentation', presentationId: crowded.id },
        { id: 'o', kind: 'presentation', presentationId: ordinary.id },
        { id: 'e', kind: 'presentation', presentationId: effects.id },
        { id: 'o2', kind: 'presentation', presentationId: ordinary2.id },
      ],
    },
  });
  await liveEvent(a, { k: 'goLive', playlistId: pl.id });
  const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
  audience1 = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
  audience2 = outs.find((o) => o.hostIndex === 2 && o.kind !== 'stage')!;
});

test.afterAll(() => {
  hub?.kill();
});

/** GO to `cue` and wait for the output to show it (its first frame, not the frame's late part). */
async function go(w: Page, cue: number): Promise<void> {
  await w.bringToFront();
  await liveEvent(a, { k: 'go', cueIndex: cue, at: Date.now() + LEAD_MS });
  await settledOn(w, cue);
}

/** Capture until `ok(img)` holds (or `ms` pass); the last capture. */
async function until(w: Page, file: string, ok: (img: Pixels) => boolean, ms = 30_000): Promise<Pixels> {
  let img = await capture(w, file);
  const t0 = Date.now();
  while (!ok(img) && Date.now() - t0 < ms) {
    await w.waitForTimeout(300);
    img = await capture(w, file);
  }
  return img;
}

test('(A) a crowded slide is drawn whole on both Audience screens', async ({ context }) => {
  test.setTimeout(300_000);
  const port = portOf('live-frame', 0);
  const hd = await roleWindow(context, port, audience1, { width: 1920, height: 1080 }, 'renderer=webgpu');
  const uhd = await roleWindow(context, port, audience2, { width: 3840, height: 2160 }, 'renderer=2d');
  for (const w of [hd, uhd]) await cacheReady(w);
  await go(hd, 0);
  await go(uhd, 0);
  const lines: string[] = [];
  for (const [w, name] of [
    [hd, '1080p'],
    [uhd, '4k'],
  ] as const) {
    const img = await until(
      w,
      join(OUT, `crowded-${name}.png`),
      (i) => JSON.stringify(shown(i)) === JSON.stringify(ALL),
    );
    const got = shown(img);
    lines.push(`${name}: ${JSON.stringify(got)}`);
    // Nothing that the base showed is lost, and everything it cut away is drawn.
    expect(got, `${name}: every square, picture and text box of the slide`).toEqual(ALL);
    expect((await stateOf(w)).units.framesMade, `${name}: the frame was made here`).toBeGreaterThanOrEqual(1);
    expect((await telemetryOf(w)).error ?? '').toBe('');
  }
  console.log(`crowded slide on the Audience screens: ${lines.join('; ')}`);
  await hd.close();
  await uhd.close();
});

test('(B) a jump to it shows its direct part at once and the frame fades in once made', async ({
  context,
}) => {
  test.setTimeout(420_000);
  const port = portOf('live-frame', 0);
  // The service is on cue 1 when the window opens, so cue 0 is neither live, armed nor warmed in it (a window opened on
  // cue 0 makes its frame at once, and the jump back would find it).
  await liveEvent(a, { k: 'go', cueIndex: 1, at: Date.now() });
  const w = await roleWindow(
    context,
    port,
    audience1,
    { width: 1920, height: 1080 },
    'test=1&renderer=webgpu&warm=off&unitTurnMs=500',
  );
  await cacheReady(w);
  // Cue 1 live (cue 2 armed): the jump to cue 0 is neither armed nor warmed.
  await go(w, 1);
  await w.waitForTimeout(500);
  await w.bringToFront();
  const t0 = Date.now();
  await liveEvent(a, { k: 'go', cueIndex: 0, at: t0 + LEAD_MS });
  await settledOn(w, 0);
  // At once: the text boxes and the top pictures (the direct part) ...
  const first = await until(
    w,
    join(OUT, 'late-first.png'),
    (i) => shown(i).texts && shown(i).picture23,
    8_000,
  );
  const f = shown(first);
  const firstAt = Date.now() - t0;
  expect(f.texts, 'the four text boxes at once').toBe(true);
  expect(f.picture23, 'the top picture at once').toBe(true);
  // ... while the frame (the bottom of the order) is still being made: the turns are slowed to 0.5 s (a frame is some 40 turns).
  expect(f.square0, 'the frame is not copied yet: its first square is absent').toBe(false);
  expect(f.picture0, 'the frame is not copied yet: its first picture is absent').toBe(false);
  // Then it fades in.
  const full = await until(
    w,
    join(OUT, 'late-full.png'),
    (i) => JSON.stringify(shown(i)) === JSON.stringify(ALL),
    240_000,
  );
  const doneAt = Date.now() - t0;
  console.log(`jump: direct part after ${firstAt} ms, frame faded in after ${doneAt} ms (turns of 0.5 s)`);
  expect(shown(full), 'the frame is in').toEqual(ALL);
  const st = await stateOf(w);
  // The slide was shown with its frame left to the late job, as its own log line says (cue 0 is `|0|`).
  const lateLine = st.log.find((l) => /\|0\|cro.*shown with \d+ part\(s\) drawn late/.test(l));
  console.log(
    `units: late ${st.units.late}, made ${st.units.made}, frames ${st.units.framesMade}; ${lateLine ?? 'no late line'}`,
  );
  expect(lateLine, 'the slide was shown with its frame drawn late').toBeDefined();
  expect(st.units.framesMade, 'the frame was made by this window').toBeGreaterThanOrEqual(1);
  expect((await telemetryOf(w)).error ?? '').toBe('');
  await w.close();
});

test('(C) ?frame=off and ?effects=base give the cut drawing back', async ({ context }) => {
  test.setTimeout(300_000);
  const port = portOf('live-frame', 0);
  for (const sw of ['frame=off', 'effects=base']) {
    const w = await roleWindow(
      context,
      port,
      audience1,
      { width: 1920, height: 1080 },
      `renderer=webgpu&${sw}`,
    );
    await cacheReady(w);
    await go(w, 0);
    await w.waitForTimeout(2_500);
    const img = await capture(w, join(OUT, `cut-${sw.replace('=', '-')}.png`));
    expect(shown(img), `${sw}: the first 200 objects only, as before the frame`).toEqual(CUT);
    expect((await stateOf(w)).units.framesMade, `${sw}: no frame was made`).toBe(0);
    expect((await stateOf(w)).log.join('\n')).toMatch(sw === 'frame=off' ? /frame=off/ : /effects=base/);
    await w.close();
  }
});

test('(D) shadows past one frame of units are all drawn', async ({ context }) => {
  test.setTimeout(300_000);
  const port = portOf('live-frame', 0);
  const hd = await roleWindow(context, port, audience1, { width: 1920, height: 1080 }, 'renderer=webgpu');
  const uhd = await roleWindow(context, port, audience2, { width: 3840, height: 2160 }, 'renderer=2d');
  for (const w of [hd, uhd]) await cacheReady(w);
  await go(hd, 2);
  await go(uhd, 2);
  const lines: string[] = [];
  for (const [w, name] of [
    [hd, '1080p'],
    [uhd, '4k'],
  ] as const) {
    const darker = (img: Pixels) =>
      LATE.map((p) => {
        const px = at(img, [p.x + p.w + 4, p.y + p.h / 2 + 20]);
        return Math.min(FRAME.r - px[0], FRAME.g - px[1], FRAME.b - px[2]);
      });
    const img = await until(
      w,
      join(OUT, `effects-${name}.png`),
      (i) => darker(i).every((d) => d >= SHADOW_DARKER),
      30_000,
    );
    const d = darker(img);
    lines.push(`${name}: shadows darker by ${d.join(', ')}`);
    for (const [i, v] of d.entries())
      expect(
        v,
        `${name}: ${LATE[i]!.id}'s shadow (the base drew the later ones without)`,
      ).toBeGreaterThanOrEqual(SHADOW_DARKER);
  }
  console.log(`effects on the Audience screens: ${lines.join('; ')}`);
  await hd.close();
  await uhd.close();
});

test('(E) an ordinary slide is drawn as it always was, with the frame on or off, and makes no frame', async ({
  context,
}) => {
  test.setTimeout(300_000);
  const port = portOf('live-frame', 0);
  const shots: Pixels[] = [];
  const delta: number[] = [];
  // The service is on cue 1 when each window opens (a window opened on cue 0, the crowded slide, makes its frame at once), the
  // effects slide of cue 2 armed (its units may need a frame of their own: counted before the GO, not by it). The GO onto cue 3,
  // an ordinary slide with nothing armed after it, is what is under test.
  await liveEvent(a, { k: 'go', cueIndex: 1, at: Date.now() });
  for (const [k, sw] of [
    [0, 'test=1&renderer=webgpu&warm=off'],
    [1, 'test=1&renderer=webgpu&warm=off&frame=off'],
  ] as const) {
    const w = await roleWindow(context, port, audience1, { width: 1920, height: 1080 }, sw);
    await cacheReady(w);
    await go(w, 1);
    await w.waitForTimeout(1_500);
    const before = (await stateOf(w)).units.framesMade;
    await go(w, 3);
    await w.waitForTimeout(1_500);
    shots.push(await capture(w, join(OUT, `ordinary-${k}.png`)));
    delta.push((await stateOf(w)).units.framesMade - before);
    expect((await telemetryOf(w)).error ?? '').toBe('');
    await w.close();
    // The next window opens on cue 1 again.
    await liveEvent(a, { k: 'go', cueIndex: 1, at: Date.now() });
  }
  expect(diffShare(shots[0]!, shots[1]!, 1), 'the same pixels with the frame on and off').toBe(0);
  expect(delta, 'a GO onto an ordinary slide makes no frame').toEqual([0, 0]);
});
