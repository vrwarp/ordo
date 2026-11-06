import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import {
  OP,
  PIN,
  goLive,
  json,
  openRoleWindow,
  operatorApi,
  outputs,
  shownSlideCue,
  telemetry,
  uploadMedia,
  waitCacheReady,
} from './helpers.ts';
import { type Pixels, decodePng } from './png.ts';

/**
 * Video and sound playing in place inside a slide (design/27 §7.2, §8, §14.12; M5 exit criteria that do
 * not need PowerPoint import), end to end: an authored deck goes live on two audience outputs, Audience 1
 * on WebGPU (SwiftShader, `?renderer=webgpu`) and the audio master, Audience 2 on Canvas 2D and not the
 * audio master.
 *
 * Playlist (cue indices in brackets):
 * - "Media deck": [0] a boxed autoplay looping clip (a 6 s hue sweep, red to cyan) turned 8°, rounded corners,
 *   fit cover (the source is cropped to the 2:1 box), under an overlapping title band; [1] a click-start
 *   magenta clip with onEnd 'advance'; [2] a text slide; [3] an autoplay blue clip.
 * - "Loop A" [4-7]: a 4-slide loop whose first slide's sound plays across 3 shown slides.
 * - "Loop B" [8-11]: a 4-slide loop whose first slide's music plays across all 4 (it must not restart when
 *   the loop wraps).
 * - "Late" [12]: a slide whose clip is still transcoding at Go live; its poster is a picture.
 */

/** design/23: one frame between outputs on a real GPU (ORDO_E2E_REAL_GPU=1), 100 ms under SwiftShader. */
const SKEW_MS = process.env.ORDO_E2E_REAL_GPU === '1' ? 17 : 100;
const W = 1920;
const H = 1080;
const GREY = { r: 40, g: 40, b: 40, a: 1 };
/** The boxed clip of the first slide (logical px; turned clockwise about its centre). */
const BOX = { x: 360, y: 220, w: 1200, h: 600, rotation: 8 };
/** The title band over the top of the clip. */
const TITLE = { x: 200, y: 140, w: 1520, h: 160, rotation: 0 };

/** Logical px of a point in the box's own frame (box-local px from its top-left, before the turn). */
function inBox(lx: number, ly: number): [number, number] {
  const th = (BOX.rotation * Math.PI) / 180;
  const dx = lx - BOX.w / 2;
  const dy = ly - BOX.h / 2;
  return [
    BOX.x + BOX.w / 2 + dx * Math.cos(th) - dy * Math.sin(th),
    BOX.y + BOX.h / 2 + dx * Math.sin(th) + dy * Math.cos(th),
  ];
}

type RGB = [number, number, number];
const isGrey = (p: RGB) => p.every((v) => Math.abs(v - 40) <= 22);
const isBand = (p: RGB) => p.every((v) => v >= 200);
/** A frame of the hue sweep (red, yellow, green, cyan): saturated, green never far below blue. */
const isSweep = (p: RGB) => Math.max(...p) - Math.min(...p) >= 80 && p[1] + 40 >= p[2];
/** The magenta or blue clips: blue far above green. */
const isOtherClip = (p: RGB) => p[2] - p[1] > 100;
const isMagenta = (p: RGB) => p[0] > 150 && p[2] > 150 && p[1] < 90;
const isOrange = (p: RGB) => p[0] > 200 && p[1] > 90 && p[1] < 180 && p[2] < 70;
const dist = (a: RGB, b: RGB) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

// ---- fixtures ------------------------------------------------------------------------------------------

const DIR = 'test-results/fixtures-slide-media';

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
}

function clip(name: string, video: string, secs: number, freq: number): string {
  const out = `${DIR}/${name}.mp4`;
  ffmpeg([
    ...['-f', 'lavfi', '-i', video],
    ...['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`],
    ...['-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out],
  ]);
  return out;
}

function makeFixtures() {
  mkdirSync(DIR, { recursive: true });
  const tone = (name: string, freq: number, secs: number) => {
    const out = `${DIR}/${name}.wav`;
    ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`, out]);
    return out;
  };
  const poster = `${DIR}/poster.png`;
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xff8000:s=640x360', '-frames:v', '1', poster]);
  return {
    sweep: clip('sweep', 'color=c=red:s=640x360:r=30:d=6,hue=h=30*t', 6, 330),
    magenta: clip('magenta', 'color=c=magenta:s=640x360:r=30:d=2', 2, 550),
    blue: clip('blue', 'color=c=blue:s=640x360:r=30:d=3', 3, 660),
    late: clip('late', 'color=c=white:s=640x360:r=30:d=2', 2, 770),
    blocker: clip('blocker', 'testsrc2=s=1280x720:r=30:d=12', 12, 880),
    tone: tone('tone', 440, 20),
    music: tone('music', 523, 30),
    poster,
  };
}

/** Upload without waiting for processing (the job queue keeps running it). */
async function postMedia(api: APIRequestContext, path: string, mime: string): Promise<{ id: string }> {
  const m = await json<{ id: string } | { id: string }[]>(
    api.post('media', {
      multipart: {
        file: { name: path.split('/').pop()!, mimeType: mime, buffer: readFileSync(path) },
        isBackground: 'false',
      },
    }),
  );
  return Array.isArray(m) ? m[0]! : m;
}

const deliveryHash = async (api: APIRequestContext, id: string) =>
  (await json<{ delivery?: { hash: string } }>(api.get(`media/${id}`))).delivery!.hash;

// ---- slides --------------------------------------------------------------------------------------------

const backdrop = (id: string) => ({
  id,
  type: 'shape',
  box: { x: 0, y: 0, w: W, h: H, rotation: 0 },
  shape: 'rect',
  fill: GREY,
});

const text = (
  id: string,
  t: string,
  box = { x: 160, y: 420, w: 1600, h: 240, rotation: 0 },
  dark = false,
) => ({
  id,
  type: 'text',
  box,
  text: t,
  style: {
    fontFamily: 'DejaVu Sans',
    fontWeight: 700,
    fontSizePx: 90,
    color: dark ? { r: 20, g: 20, b: 20, a: 1 } : { r: 255, g: 255, b: 255, a: 1 },
    align: 'left',
    valign: 'middle',
    padding: 40,
  },
});

/** A title: a light band with dark text, in one box. */
const title = (id: string, t: string, box: typeof TITLE) => [
  { id: `${id}-band`, type: 'shape', box, shape: 'rect', fill: { r: 235, g: 235, b: 235, a: 1 } },
  text(id, t, box, true),
];

const video = (id: string, mediaId: string, play: Record<string, unknown>, box: object, extra = {}) => ({
  id,
  type: 'image',
  box,
  mediaId,
  fit: 'cover',
  opacity: 1,
  radius: 0,
  play: { mediaId, ...play },
  ...extra,
});

const FULL = { x: 160, y: 90, w: 1600, h: 900, rotation: 0 };

// ---- outputs -------------------------------------------------------------------------------------------

type Slot = { id: number; key: string; paused: boolean; t: number; muted: boolean; ready: boolean };

/** The output's media slots (0-3 video, 4-5 audio): what each element holds and does. */
async function slots(p: Page): Promise<Slot[]> {
  return p.evaluate(() => {
    const host = (
      window as unknown as {
        __ordo: {
          host: { slots: { id: number; key: string; ready: boolean; el: HTMLMediaElement }[] };
        };
      }
    ).__ordo.host;
    return host.slots.map((s) => ({
      id: s.id,
      key: s.key,
      paused: s.el.paused,
      t: s.el.currentTime,
      muted: s.el.muted,
      ready: s.ready,
    }));
  });
}

/** The slide cue an output shows (it draws only while in front). */
async function cueOn(p: Page): Promise<number | null> {
  await p.bringToFront();
  return shownSlideCue(p);
}

const slotOf = async (p: Page, key: string) => (await slots(p)).find((s) => s.key === key);

/** A screenshot of the output (rAF runs only in the page in front). */
async function frame(p: Page, save?: string): Promise<Pixels> {
  await p.bringToFront();
  await p.waitForTimeout(250);
  const png = await p.screenshot();
  if (save) writeFileSync(`${DIR}/${save}.png`, png);
  return decodePng(png);
}

/** The colour at a logical point (the output fills the 16:9 viewport). */
function at(img: Pixels, [lx, ly]: [number, number]): RGB {
  const x = Math.min(img.width - 1, Math.round((lx * img.width) / W));
  const y = Math.min(img.height - 1, Math.round((ly * img.height) / H));
  const o = (y * img.width + x) * 4;
  return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
}

type Live = {
  live?: number;
  armed?: number;
  layers: {
    media: { content: null | { mediaId: string; objectId?: string; state: string; startedAt: number } };
  };
  audio: {
    content: null | {
      mediaId: string;
      cueIndex: number;
      state: string;
      startedAt: number;
      slideOwned?: boolean;
      untilCue?: number;
    };
  };
  resolved?: { degraded?: { reason: string; slideId?: string }[] };
};

const live = async (api: APIRequestContext) => (await json<{ state: Live }>(api.get('live'))).state;

let evN = 0;
async function event(api: APIRequestContext, e: Record<string, unknown>): Promise<void> {
  await json(api.post('live/events', { data: { id: `sm-${Date.now()}-${evN++}`, event: e } }));
}
const go = (api: APIRequestContext, cueIndex: number) => event(api, { k: 'go', cueIndex, at: Date.now() });
const select = (api: APIRequestContext, cueIndex: number) => event(api, { k: 'select', cueIndex });

test.describe('video and sound playing in place in a slide', () => {
  test('boxed clips, click start, onEnd advance, slide sounds and late clips on WebGPU and Canvas 2D', async ({
    context,
  }) => {
    test.setTimeout(420_000);
    const api = await operatorApi();
    const fx = makeFixtures();
    const [sweep, magenta, blue, tone, music, poster] = [
      await uploadMedia(api, fx.sweep, 'video/mp4'),
      await uploadMedia(api, fx.magenta, 'video/mp4'),
      await uploadMedia(api, fx.blue, 'video/mp4'),
      await uploadMedia(api, fx.tone, 'audio/wav'),
      await uploadMedia(api, fx.music, 'audio/wav'),
      await uploadMedia(api, fx.poster, 'image/png'),
    ];

    // The editor's shape: the poster is the clip itself (an ImageObject showing a video draws its poster).
    const deck = await json<{ id: string }>(
      api.post('presentations', {
        data: {
          title: 'Media deck',
          kind: 'slides',
          sections: [
            {
              id: 'main',
              label: 'Main',
              short: 'M',
              slides: [
                {
                  id: 'boxed',
                  objects: [
                    backdrop('bg1'),
                    video('clip', sweep.id, { start: 'auto', loop: true }, BOX, { radius: 80 }),
                    ...title('title', 'Welcome', TITLE),
                  ],
                },
                {
                  id: 'click',
                  objects: [
                    backdrop('bg2'),
                    video('clip2', magenta.id, { start: 'click', loop: false, onEnd: 'advance' }, FULL),
                  ],
                },
                { id: 'after', objects: [backdrop('bg3'), text('t3', 'After the clip')] },
                {
                  id: 'blue',
                  objects: [backdrop('bg4'), video('clip4', blue.id, { start: 'auto', loop: true }, FULL)],
                },
              ],
            },
          ],
        },
      }),
    );
    const loopDeck = (title: string, mediaId: string, slides: number) =>
      json<{ id: string }>(
        api.post('presentations', {
          data: {
            title,
            kind: 'loop',
            loop: { defaultSlideMs: 2000 },
            sections: [
              {
                id: 'loop',
                label: 'Loop',
                short: 'L',
                slides: [1, 2, 3, 4].map((n) => ({
                  id: `${title.replace(/\W/g, '')}-${n}`,
                  objects: [backdrop(`b${n}`), text(`t${n}`, `${title} ${n}`)],
                  ...(n === 1 ? { audio: { mediaId, start: 'auto', loop: true, slides } } : {}),
                })),
              },
            ],
          },
        }),
      );
    const loopA = await loopDeck('Loop A', tone.id, 3);
    const loopB = await loopDeck('Loop B', music.id, 4);

    // A clip still transcoding at Go live: queued behind a longer one on the heavy (concurrency 1) queue.
    await postMedia(api, fx.blocker, 'video/mp4');
    const late = await postMedia(api, fx.late, 'video/mp4');
    const lateDeck = await json<{ id: string }>(
      api.post('presentations', {
        data: {
          title: 'Late',
          kind: 'slides',
          sections: [
            {
              id: 'late',
              label: 'Late',
              short: 'L',
              slides: [
                {
                  id: 'late-slide',
                  objects: [
                    backdrop('bg5'),
                    { ...video('clip5', late.id, { start: 'auto' }, FULL), mediaId: poster.id },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    const pl = await json<{ id: string }>(
      api.post('playlists', {
        data: {
          name: `Slide media ${Date.now()}`,
          items: [deck, loopA, loopB, lateDeck].map((p, i) => ({
            id: `item-${i}`,
            kind: 'presentation',
            presentationId: p.id,
          })),
        },
      }),
    );
    expect((await json<{ state: string }>(api.get(`media/${late.id}`))).state).not.toBe('ready');
    await goLive(api, pl.id);

    // ---- Go live: the late clip is left out with a degraded note; nothing is refused.
    const lateNote = (await live(api)).resolved?.degraded?.find((d) => d.slideId === 'late-slide');
    expect(lateNote?.reason).toMatch(/still processing; showing its poster; Go live again once it is ready/);

    const outs = await outputs(api);
    const a1 = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
    const a2 = outs.find((o) => o.hostIndex === 2 && o.kind !== 'stage')!;
    expect(a1.audioMaster, 'Audience 1 is the audio master').toBe(true);
    expect(a2.audioMaster ?? false, 'Audience 2 is not').toBe(false);
    const gpu = await openRoleWindow(context, a1, 'test=1&renderer=webgpu');
    const c2d = await openRoleWindow(context, a2, 'test=1&renderer=2d');
    const both = [gpu, c2d];
    for (const p of both) await waitCacheReady(p);
    const compositor = async (p: Page) => ((await telemetry(p)) as { compositor?: string }).compositor;
    await expect.poll(() => compositor(gpu)).toBe('webgpu');
    await expect.poll(() => compositor(c2d)).toBe('2d');

    const hash = {
      sweep: await deliveryHash(api, sweep.id),
      magenta: await deliveryHash(api, magenta.id),
      blue: await deliveryHash(api, blue.id),
    };
    const key = (cue: number, id: string, h: string) => `md|${cue}|${id}|${h}`;
    const sweepKey = key(0, sweep.id, hash.sweep);
    const magentaKey = key(1, magenta.id, hash.magenta);
    const blueKey = key(3, blue.id, hash.blue);

    // ---- [0] the boxed autoplay clip.
    // A GO is on time when the cue is armed on every output (prepared ahead), as in outputs.spec.ts.
    for (const p of both)
      await expect
        .poll(
          async () => {
            const t = (await telemetry(p)) as { armed?: number; armedOk?: boolean };
            return t.armed === 0 && t.armedOk === true && !!(await slotOf(p, sweepKey))?.ready;
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    await go(api, 0);
    // Start skew (design/27 §13 "Sync", design/23 bounds): where each output's element is in the clip
    // against the hub's start time, sampled back to back before the clip's first loop wrap.
    await expect.poll(async () => (await live(api)).layers.media.content?.startedAt ?? 0).toBeGreaterThan(0);
    const clipStart = (await live(api)).layers.media.content!.startedAt;
    await gpu.waitForTimeout(Math.max(0, clipStart + 1200 - Date.now()));
    const offsets: number[] = [];
    for (const p of both)
      offsets.push(
        await p.evaluate(
          ([k, start]) => {
            const host = (
              window as unknown as { __ordo: { host: { slots: { key: string; el: HTMLMediaElement }[] } } }
            ).__ordo.host;
            return host.slots.find((s) => s.key === k)!.el.currentTime * 1000 - (Date.now() - start);
          },
          [sweepKey, clipStart] as const,
        ),
      );
    for (const p of both) {
      await expect.poll(() => cueOn(p), { timeout: 20_000 }).toBe(0);
      // Every output plays the clip, muted unless the audio master, and preloads the next slide's clip
      // paused on its first frame.
      await expect.poll(async () => (await slotOf(p, sweepKey))?.paused, { timeout: 20_000 }).toBe(false);
      await expect
        .poll(
          async () => {
            const s = await slotOf(p, magentaKey);
            return !!s && s.ready && s.paused && s.t < 0.1;
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    }
    expect((await slotOf(c2d, sweepKey))?.muted).toBe(true);

    // The slide flip of the two outputs (each draws only while in front, so read after the fact).
    const flips: number[] = [];
    for (const p of both) {
      await p.bringToFront();
      await expect
        .poll(async () => ((await telemetry(p)) as { slideFlip?: { cue: number } }).slideFlip?.cue, {
          timeout: 10_000,
        })
        .toBe(0);
      flips.push(((await telemetry(p)) as { slideFlip?: { at: number } }).slideFlip!.at);
    }
    const flipSkew = Math.abs(flips[0]! - flips[1]!);
    const startSkew = Math.abs(offsets[0]! - offsets[1]!);
    console.log(
      `slide flip skew ${flipSkew.toFixed(1)} ms; clip media time 1.2 s after its start against the hub ` +
        `clock: WebGPU ${offsets[0]!.toFixed(0)} ms, Canvas 2D ${offsets[1]!.toFixed(0)} ms (skew ${startSkew.toFixed(0)} ms)`,
    );
    expect(flipSkew, 'the outputs flip the clip slide together').toBeLessThanOrEqual(SKEW_MS);
    expect(startSkew, 'the outputs start the clip together').toBeLessThanOrEqual(SKEW_MS);
    const gpuState = await gpu.evaluate(() =>
      (window as unknown as { __ordo: { state(): { scenes?: Record<string, string> } } }).__ordo.state(),
    );
    console.log('scenes on the WebGPU output:', JSON.stringify(gpuState.scenes));

    // Pixels: the clip plays in its turned, rounded box, under the title band, over the backdrop.
    const probe = {
      centre: inBox(600, 300),
      corner: inBox(70, 530),
      outsideRound: inBox(8, 592),
      underTitle: inBox(700, 40),
      outsideTurn: [380, 800] as [number, number],
      backdrop: [100, 1000] as [number, number],
    };
    for (const p of both) {
      const name = p === gpu ? 'WebGPU' : 'Canvas 2D';
      const centres: RGB[] = [];
      for (let i = 0; i < 5; i++) {
        const img = await frame(p, i === 0 ? `boxed-${p === gpu ? 'webgpu' : '2d'}` : undefined);
        const c = at(img, probe.centre);
        centres.push(c);
        expect(isSweep(c), `${name}: the clip in its box (${c})`).toBe(true);
        expect(isSweep(at(img, probe.corner)), `${name}: inside the rounded corner`).toBe(true);
        expect(isGrey(at(img, probe.outsideRound)), `${name}: outside the rounded corner`).toBe(true);
        expect(isBand(at(img, probe.underTitle)), `${name}: the title band is over the clip`).toBe(true);
        expect(isGrey(at(img, probe.outsideTurn)), `${name}: outside the turned box`).toBe(true);
        expect(isGrey(at(img, probe.backdrop)), `${name}: backdrop`).toBe(true);
        await p.waitForTimeout(250);
      }
      const moving = centres.some((c) => dist(c, centres[0]!) > 40);
      expect(moving, `${name}: the clip is playing (${centres.map((c) => c.join(',')).join(' | ')})`).toBe(
        true,
      );
    }

    // ---- Clear media during the in-slide clip, then arm other slides' clips: the live slide shows its
    // poster, never the next clip, even when the next clip is loaded into the slot the cleared one used.
    await select(api, 3);
    for (const p of both)
      await expect.poll(async () => !!(await slotOf(p, blueKey))?.ready, { timeout: 20_000 }).toBe(true);
    const sweepSlot = (await slotOf(gpu, sweepKey))!.id;
    await json(api.post('actions', { data: { id: 'clearMedia' } }));
    await expect.poll(async () => (await live(api)).layers.media.content).toBeNull();
    await gpu.waitForTimeout(800);
    await select(api, 1);
    for (const p of both)
      await expect.poll(async () => !!(await slotOf(p, magentaKey))?.ready, { timeout: 20_000 }).toBe(true);
    console.log(
      `after Clear media the magenta clip loaded into slot ${(await slotOf(gpu, magentaKey))?.id}; ` +
        `the cleared clip was in slot ${sweepSlot}`,
    );
    for (const p of both) {
      const name = p === gpu ? 'WebGPU' : 'Canvas 2D';
      const seen: RGB[] = [];
      for (let i = 0; i < 6; i++) {
        const c = at(await frame(p), probe.centre);
        seen.push(c);
        expect(isOtherClip(c), `${name}: another clip in the live slide (${c})`).toBe(false);
        expect(isSweep(c), `${name}: the poster (${c})`).toBe(true);
        await p.waitForTimeout(200);
      }
      expect(
        seen.every((c) => dist(c, seen[0]!) <= 24),
        `${name}: a still poster (${seen.map((c) => c.join(',')).join(' | ')})`,
      ).toBe(true);
      // The poster is the clip's frame at 1 s (hue 30°: an orange red), never black.
      expect(seen[0]![0] > 150 && seen[0]![1] > 20, `${name}: poster colour ${seen[0]}`).toBe(true);
    }

    // ---- [1] the click-start clip: live paused on its first frame; F8 plays, Shift+F8 restarts, and its
    // end advances the service (reported by the audio master).
    const op = await context.newPage();
    await op.goto(`${OP}/`);
    await op.locator('input.pin').fill(PIN);
    await op.getByRole('button', { name: 'OK' }).click();
    await expect(op.getByRole('button', { name: 'Launch outputs' })).toBeVisible({ timeout: 30_000 });
    await op.evaluate(() => {
      location.hash = '#/live';
    });
    await expect(op.getByText('Media deck').first()).toBeVisible({ timeout: 20_000 });

    await go(api, 1);
    await expect.poll(async () => (await live(api)).layers.media.content?.state).toBe('paused');
    for (const p of both) {
      const name = p === gpu ? 'WebGPU' : 'Canvas 2D';
      await expect.poll(() => cueOn(p), { timeout: 20_000 }).toBe(1);
      await expect
        .poll(async () => isMagenta(at(await frame(p), [960, 540])), {
          timeout: 15_000,
          message: `${name}: the click clip's first frame shows while paused`,
        })
        .toBe(true);
      const s = await slotOf(p, magentaKey);
      expect(s?.paused).toBe(true);
    }
    await op.bringToFront();
    await op.keyboard.press('F8');
    await expect.poll(async () => (await live(api)).layers.media.content?.state).toBe('playing');
    for (const p of both)
      await expect.poll(async () => (await slotOf(p, magentaKey))?.paused, { timeout: 10_000 }).toBe(false);
    await expect
      .poll(async () => (await slotOf(gpu, magentaKey))?.t ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0.6);
    const startedAt = (await live(api)).layers.media.content!.startedAt;
    const before = (await slotOf(gpu, magentaKey))!.t;
    await op.bringToFront();
    await op.keyboard.press('Shift+F8');
    await expect
      .poll(async () => (await live(api)).layers.media.content?.startedAt ?? 0)
      .toBeGreaterThan(startedAt);
    await expect
      .poll(async () => (await slotOf(gpu, magentaKey))?.t ?? 9, { timeout: 5_000 })
      .toBeLessThan(before - 0.3);
    // The clip ends about 2 s after the restart; onEnd 'advance' moves the service to [2].
    await expect.poll(async () => (await live(api)).live, { timeout: 15_000 }).toBe(2);
    await expect.poll(async () => (await live(api)).layers.media.content).toBeNull();

    // ---- Loop A [4-7]: the sound plays across 3 shown slides and stops on the 4th.
    type Sample = { live?: number; audio: Live['audio']['content']; at: number };
    /** Sample the live state until `done`; `each` runs after every sample. */
    const watch = async (
      done: (s: Sample[]) => boolean,
      each: (s: Sample) => Promise<void>,
      timeout: number,
    ): Promise<Sample[]> => {
      const out: Sample[] = [];
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const st = await live(api);
        const sample = { live: st.live, audio: st.audio.content, at: Date.now() };
        out.push(sample);
        await each(sample);
        if (done(out)) return out;
        await new Promise((r) => setTimeout(r, 120));
      }
      throw new Error(`timed out on cues ${out.map((x) => x.live).join(',')}`);
    };
    const audioSlot = async (p: Page) => (await slots(p)).find((s) => s.id >= 4 && s.key && !s.paused);

    await go(api, 4);
    await expect.poll(async () => !!(await audioSlot(gpu)), { timeout: 10_000 }).toBe(true);
    expect(await audioSlot(c2d), 'only the audio master plays the slide sound').toBeUndefined();
    let on7At = 0;
    let audibleOn7: boolean | undefined;
    const a = await watch(
      (s) => on7At > 0 && s.at(-1)!.live === 4,
      async (s) => {
        if (s.live !== 7) return;
        if (!on7At) on7At = s.at;
        // The element pauses once the audio layer's fade is over.
        if (audibleOn7 === undefined && s.at - on7At > 900) audibleOn7 = !!(await audioSlot(gpu));
      },
      30_000,
    );
    const firstPass = a.slice(
      0,
      a.findIndex((x) => x.live === 7),
    );
    expect(new Set(firstPass.map((s) => s.live))).toEqual(new Set([4, 5, 6]));
    for (const s of firstPass)
      expect(s.audio).toMatchObject({ mediaId: tone.id, slideOwned: true, untilCue: 6, state: 'playing' });
    expect(new Set(firstPass.map((s) => s.audio?.startedAt)).size, 'one play across slides 1-3').toBe(1);
    for (const s of a) if (s.live === 7) expect(s.audio, 'the sound stopped on the 4th slide').toBeNull();
    expect(audibleOn7, "the master's sound element stopped on the 4th slide").toBe(false);
    // Back on the first slide after the wrap, its sound starts again: a new play, as in PowerPoint.
    await expect
      .poll(async () => (await live(api)).audio.content?.startedAt ?? 0)
      .toBeGreaterThan(firstPass[0]!.audio!.startedAt);

    // ---- Loop B [8-11]: music across all 4 slides does not restart when the loop wraps.
    await go(api, 8);
    await expect.poll(async () => !!(await audioSlot(gpu)), { timeout: 10_000 }).toBe(true);
    let seen11 = false;
    const b = await watch(
      (s) => seen11 && s.at(-1)!.live === 9,
      async (s) => {
        if (s.live === 11) seen11 = true;
      },
      30_000,
    );
    expect(new Set(b.map((s) => s.live))).toEqual(new Set([8, 9, 10, 11]));
    for (const s of b)
      expect(s.audio).toMatchObject({ mediaId: music.id, slideOwned: true, untilCue: 11, state: 'playing' });
    expect(new Set(b.map((s) => s.audio?.startedAt)).size, 'one play across the wrap').toBe(1);
    const musicT = (await audioSlot(gpu))?.t ?? 0;
    const elapsed = (Date.now() - b[0]!.audio!.startedAt) / 1000;
    expect(
      musicT,
      `the music element was not restarted (${musicT} s, ${elapsed} s since its start)`,
    ).toBeGreaterThan(elapsed - 2);

    // ---- [12] the clip still transcoding at Go live: its slide shows the poster and plays nothing.
    await go(api, 12);
    await expect.poll(async () => (await live(api)).live).toBe(12);
    expect((await live(api)).layers.media.content).toBeNull();
    for (const p of both) {
      const name = p === gpu ? 'WebGPU' : 'Canvas 2D';
      await expect.poll(() => cueOn(p), { timeout: 20_000 }).toBe(12);
      await expect
        .poll(async () => isOrange(at(await frame(p), [960, 540])), {
          timeout: 15_000,
          message: `${name}: the late clip's poster`,
        })
        .toBe(true);
    }

    for (const p of both) {
      const t = await telemetry(p);
      expect(t.error ?? '', 'no output error').toBe('');
    }
  });
});
