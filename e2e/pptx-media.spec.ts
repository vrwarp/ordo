import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { hubApi, login } from './linkhelpers.ts';
import { portOf } from './ports.ts';
import { BOXED_ROT, LOOP_SLIDES, loopDeck, MEDIA_SLIDES, mediaDeck, probeMedia } from './pptxdecks.ts';
import {
  apiJson,
  at,
  cacheReady,
  capture,
  cueOn,
  diffShare,
  importPptx,
  liveEvent,
  type OutputRec,
  pptxHub,
  type RGB,
  roleWindow,
  telemetryOf,
} from './pptxlive.ts';

/**
 * PowerPoint video and sound playing in place, imported (design/27 §8, §14.12; the §15 M5 exit with
 * PowerPoint decks, and the M3 wave 2 clip items): two synthetic probe decks (`pptxdecks.ts`) go through the
 * real upload route and live on two outputs, Audience 1 on WebGPU (`?renderer=webgpu`) and the audio
 * master, Audience 2 on Canvas 2D.
 *
 * Playlist (cues): "Probe media" [0-11] (`MEDIA_SLIDES`): [0] a boxed autoplay looping MP4, turned 8°,
 * cropped (its black outer tenths cut away) and rounded, under an overlapping title; [1] a click-start
 * video; [2] a text slide; [3] a looping muted full-slide motion background; [4] a numSld=3 sound, [5] a
 * hidden slide, [6-8] text slides; [9] a clip that is not a video; [10] a clip whose processing fails;
 * [11] a looping clip trimmed by p14:trim to its middle two seconds. "Probe loop" [12-15]: a 4-slide
 * looping announcement deck with music across its slides. Its port: e2e/ports.ts row
 * 'pptx-media'.
 */
const PORT = portOf('pptx-media');
const OUT = 'test-results/pptx-media';
const SKEW_MS = process.env.ORDO_E2E_REAL_GPU === '1' ? 17 : 100;

/** The boxed clip (logical px): 7.5 x 3.75 in at (2.25, 1.375) in, 144 px per inch; turned about its centre. */
const BOX = { x: 324, y: 198, w: 1080, h: 540 };
function inBox(lx: number, ly: number): [number, number] {
  const th = (BOXED_ROT * Math.PI) / 180;
  const dx = lx - BOX.w / 2;
  const dy = ly - BOX.h / 2;
  return [
    BOX.x + BOX.w / 2 + dx * Math.cos(th) - dy * Math.sin(th),
    BOX.y + BOX.h / 2 + dx * Math.sin(th) + dy * Math.cos(th),
  ];
}

const near = (p: RGB, q: RGB, d = 24) => p.every((v, i) => Math.abs(v - q[i]!) <= d);
const isGrey = (p: RGB) => near(p, [0x28, 0x28, 0x28], 22);
const isBand = (p: RGB) => p.every((v) => v >= 200);
const isOrange = (p: RGB) => p[0] > 200 && p[1] > 90 && p[1] < 180 && p[2] < 70;
const isMagenta = (p: RGB) => p[0] > 150 && p[2] > 150 && p[1] < 90;
/** A frame of the hue sweep (red, yellow, green, cyan): saturated, green never far below blue. */
const isSweep = (p: RGB) => Math.max(...p) - Math.min(...p) >= 80 && p[1] + 40 >= p[2];
const isBlack = (p: RGB) => p.every((v) => v < 40);
const dist = (a: RGB, b: RGB) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
const QUARTERS: Record<string, RGB> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
};
const quarterOf = (p: RGB) => Object.entries(QUARTERS).find(([, q]) => dist(p, q) <= 70)?.[0];

type Img = { id: string; type: string; mediaId?: string; play?: Record<string, unknown> };
type Slide = {
  id: string;
  hidden?: boolean;
  objects: Img[];
  audio?: { mediaId: string; slides?: number; loop?: boolean };
  backgroundMediaId?: string;
  durationMs?: number;
};
type Presentation = {
  id: string;
  rev: number;
  kind: string;
  sections: { slides: Slide[] }[];
  source?: { log?: string };
};
type Media = {
  id: string;
  name: string;
  kind: string;
  state: string;
  durationMs?: number;
  trim?: { startMs: number; endMs: number };
  delivery?: { hash: string };
};
type Live = {
  live?: number;
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

type Slot = { id: number; key: string; paused: boolean; t: number; muted: boolean; ready: boolean };
async function slots(p: Page): Promise<Slot[]> {
  return p.evaluate(() => {
    const host = (
      window as unknown as {
        __ordo: { host: { slots: { id: number; key: string; ready: boolean; el: HTMLMediaElement }[] } };
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
const slotOf = async (p: Page, key: string) => (await slots(p)).find((s) => s.key === key);

test('PowerPoint clips and sounds import, go live and play in place on WebGPU and Canvas 2D', async ({
  context,
}) => {
  test.setTimeout(600_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const m = probeMedia(join(OUT, 'media'));
  const mediaFile = mediaDeck(OUT, m);
  const loopFile = loopDeck(OUT, m);

  const hub = await pptxHub(PORT);
  try {
    const a = await hubApi(PORT);
    const get = <T>(path: string) => apiJson<T>(a, path);
    const live = async () => (await get<{ state: Live }>('live')).state;
    const event = (e: Record<string, unknown>) => liveEvent(a, e);
    const go = (cueIndex: number) => event({ k: 'go', cueIndex, at: Date.now() });
    const action = async (id: string) => expect((await a.post('actions', { data: { id } })).ok()).toBe(true);

    // ---- Import both decks through the route.
    const mediaJob = await importPptx(a, mediaFile);
    const loopJob = await importPptx(a, loopFile);
    const deck = await get<Presentation>(`presentations/${mediaJob.result!.presentationId}`);
    const loop = await get<Presentation>(`presentations/${loopJob.result!.presentationId}`);
    const slides = deck.sections.flatMap((s) => s.slides);
    expect(slides).toHaveLength(MEDIA_SLIDES.length);
    const playOf = (s: Slide) => s.objects.find((o) => o.play)?.play as { mediaId: string } | undefined;

    // (5) A clip that is not a video gives a [warn] line and keeps its poster; the import goes on.
    const log = mediaJob.log.join('\n');
    expect(log).toMatch(/\[warn\] slide 10: the video could not be imported \(.*\): its poster is shown/);
    expect(deck.source?.log).toMatch(/\[warn\] slide 10: the video could not be imported/);
    const notClip = slides[9]!;
    expect(playOf(notClip)).toBeUndefined();
    expect(notClip.objects.some((o) => o.type === 'image')).toBe(true);

    // What each slide plays (design/27 §8 "p:timing mapping").
    const boxed = playOf(slides[0]!)!;
    expect(boxed).toMatchObject({ start: 'auto', loop: true });
    const click = playOf(slides[1]!)!;
    expect(click).toMatchObject({ start: 'click' });
    expect(slides[3]!.backgroundMediaId).toBeDefined();
    expect(slides[4]!.audio).toMatchObject({ slides: 3 });
    expect(slides[5]!.hidden).toBe(true);
    const broken = playOf(slides[10]!)!;
    const trimmed = playOf(slides[11]!)!;
    expect(trimmed).toMatchObject({ loop: true });
    // An announcement loop (the loop census of 2026-11-13 keeps PowerPoint's looping shows loops): its import
    // log says so, and the import report offers 'Treat as slides' (e2e/pptx-loop.spec.ts).
    expect(loop.kind).toBe('loop');
    expect(loop.source?.log).toMatch(/PowerPoint plays this deck as a loop with every slide timed/);
    const loopSlides = loop.sections.flatMap((s) => s.slides);
    expect(loopSlides.map((s) => s.durationMs)).toEqual([2000, 2000, 2000, 2000]);
    expect(loopSlides[0]!.audio).toMatchObject({ loop: true, slides: 999 });

    // The clips' media jobs run after the import (never awaited by it): wait for them.
    const clipIds = [
      boxed.mediaId,
      click.mediaId,
      slides[3]!.backgroundMediaId!,
      slides[4]!.audio!.mediaId,
      broken.mediaId,
      trimmed.mediaId,
      loopSlides[0]!.audio!.mediaId,
    ];
    const media: Record<string, Media> = {};
    for (const id of clipIds) {
      await expect
        .poll(async () => (await get<Media>(`media/${id}`)).state, { timeout: 180_000 })
        .toMatch(/^(ready|failed)$/);
      media[id] = await get<Media>(`media/${id}`);
    }
    expect(media[broken.mediaId]!.state).toBe('failed');
    for (const id of clipIds.filter((x) => x !== broken.mediaId)) expect(media[id]!.state, id).toBe('ready');
    // (6) The trim is baked: the clip keeps 1 s to 3 s of the 4 s quarters.
    const tm = media[trimmed.mediaId]!;
    expect(tm.trim).toEqual({ startMs: 1000, endMs: 3000 });
    expect(tm.durationMs).toBeGreaterThan(1800);
    expect(tm.durationMs).toBeLessThan(2200);
    expect(media[boxed.mediaId]!.name).toBe('Probe media – slide 1 video');

    // onEnd 'advance' is the operator's choice in the video panel (PowerPoint has no such setting).
    const clickSlide = deck.sections[0]!.slides[1]!;
    for (const o of clickSlide.objects) if (o.play) o.play = { ...o.play, onEnd: 'advance' };
    await apiJson(a, `presentations/${deck.id}`, { put: deck });

    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: {
        name: 'Imported media',
        items: [
          { id: 'media', kind: 'presentation', presentationId: deck.id },
          { id: 'loop', kind: 'presentation', presentationId: loop.id },
        ],
      },
    });
    await event({ k: 'goLive', playlistId: pl.id });

    // (5) The clip whose processing failed: left out with a degraded note, its slide shows the poster.
    const degraded = (await live()).resolved?.degraded ?? [];
    expect(degraded.find((d) => d.slideId === slides[10]!.id)?.reason).toMatch(
      /"Probe media – slide 11 video" \(slide video\) failed; showing its poster/,
    );

    const outs = await get<OutputRec[]>('settings/outputs');
    const a1 = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
    const a2 = outs.find((o) => o.hostIndex === 2 && o.kind !== 'stage')!;
    expect(a1.audioMaster).toBe(true);
    expect(a2.audioMaster ?? false).toBe(false);
    const size = { width: 1280, height: 720 };
    const gpu = await roleWindow(context, PORT, a1, size, 'test=1&renderer=webgpu');
    const c2d = await roleWindow(context, PORT, a2, size, 'test=1&renderer=2d');
    const stage = await roleWindow(context, PORT, outs.find((o) => o.kind === 'stage')!, size);
    const both = [gpu, c2d];
    for (const p of both) await cacheReady(p);
    await expect.poll(async () => (await telemetryOf(gpu)).compositor).toBe('webgpu');
    await expect.poll(async () => (await telemetryOf(c2d)).compositor).toBe('2d');
    const name = (p: Page) => (p === gpu ? 'WebGPU' : 'Canvas 2D');
    const frame = (p: Page, save?: string) => capture(p, join(OUT, `${save ?? 'frame'}-${name(p)}.png`));

    const key = (cue: number, id: string) => `md|${cue}|${id}|${media[id]!.delivery!.hash}`;
    const boxedKey = key(0, boxed.mediaId);
    const clickKey = key(1, click.mediaId);

    // ---- [0] The boxed autoplay clip, armed on both outputs before the GO.
    for (const p of both)
      await expect
        .poll(
          async () => {
            const t = (await telemetryOf(p)) as { armed?: number; armedOk?: boolean };
            return t.armed === 0 && t.armedOk === true && !!(await slotOf(p, boxedKey))?.ready;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    await go(0);
    await expect.poll(async () => (await live()).layers.media.content?.startedAt ?? 0).toBeGreaterThan(0);
    const clipStart = (await live()).layers.media.content!.startedAt;
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
          [boxedKey, clipStart] as const,
        ),
      );
    for (const p of both) {
      await expect.poll(() => cueOn(p), { timeout: 20_000 }).toBe(0);
      await expect.poll(async () => (await slotOf(p, boxedKey))?.paused, { timeout: 20_000 }).toBe(false);
      // The next slide's clip is preloaded on every output, paused on its first frame.
      await expect
        .poll(
          async () => {
            const s = await slotOf(p, clickKey);
            return !!s && s.ready && s.paused && s.t < 0.1;
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    }
    expect((await slotOf(c2d, boxedKey))?.muted, 'only the audio master is heard').toBe(true);
    const flips: number[] = [];
    for (const p of both) {
      await p.bringToFront();
      await expect
        .poll(async () => ((await telemetryOf(p)) as { slideFlip?: { cue: number } }).slideFlip?.cue, {
          timeout: 10_000,
        })
        .toBe(0);
      flips.push(((await telemetryOf(p)) as { slideFlip?: { at: number } }).slideFlip!.at);
    }
    const flipSkew = Math.abs(flips[0]! - flips[1]!);
    const startSkew = Math.abs(offsets[0]! - offsets[1]!);
    console.log(
      `slide flip skew ${flipSkew.toFixed(1)} ms; clip media time 1.2 s after its start: WebGPU ` +
        `${offsets[0]!.toFixed(0)} ms, Canvas 2D ${offsets[1]!.toFixed(0)} ms (skew ${startSkew.toFixed(0)} ms)`,
    );
    expect(flipSkew).toBeLessThanOrEqual(SKEW_MS);
    expect(startSkew).toBeLessThanOrEqual(SKEW_MS);

    // Pixels: the clip plays in its turned, cropped, rounded box, under the title band, over the slide.
    const probe = {
      centre: inBox(540, 300),
      // The source's black outer tenths are cropped away: the box's edge shows the sweep.
      cropEdge: inBox(30, 300),
      corner: inBox(45, 495),
      outsideRound: inBox(8, 532),
      // Under the title band, left of its centred text (whose glyphs the rich engine places as LibreOffice does).
      underTitle: inBox(150, 30),
      outsideTurn: [340, 730] as [number, number],
      slide: [100, 1000] as [number, number],
    };
    for (const p of both) {
      const n = name(p);
      const centres: RGB[] = [];
      for (let i = 0; i < 5; i++) {
        const img = await frame(p, i === 0 ? 'boxed' : undefined);
        const c = at(img, probe.centre);
        centres.push(c);
        expect(isSweep(c), `${n}: the clip in its box (${c})`).toBe(true);
        const edge = at(img, probe.cropEdge);
        expect(isSweep(edge) && !isBlack(edge), `${n}: the crop (${edge})`).toBe(true);
        expect(isSweep(at(img, probe.corner)), `${n}: inside the rounded corner`).toBe(true);
        expect(isGrey(at(img, probe.outsideRound)), `${n}: outside the rounded corner`).toBe(true);
        expect(isBand(at(img, probe.underTitle)), `${n}: the title is over the clip`).toBe(true);
        expect(isGrey(at(img, probe.outsideTurn)), `${n}: outside the turned box`).toBe(true);
        expect(isGrey(at(img, probe.slide)), `${n}: the slide`).toBe(true);
        await p.waitForTimeout(250);
      }
      expect(
        centres.some((c) => dist(c, centres[0]!) > 40),
        `${n}: the clip plays`,
      ).toBe(true);
    }

    // ---- Clear media during the in-slide clip, then arm the next slide's clip: the live slide shows its
    // poster, never the next clip.
    await action('clearMedia');
    await expect.poll(async () => (await live()).layers.media.content).toBeNull();
    await gpu.waitForTimeout(800);
    await event({ k: 'select', cueIndex: 1 });
    for (const p of both)
      await expect.poll(async () => !!(await slotOf(p, clickKey))?.ready, { timeout: 20_000 }).toBe(true);
    for (const p of both) {
      const seen: RGB[] = [];
      for (let i = 0; i < 5; i++) {
        const c = at(await frame(p), probe.centre);
        seen.push(c);
        expect(isMagenta(c), `${name(p)}: the next clip in the live slide (${c})`).toBe(false);
        expect(isOrange(c), `${name(p)}: the poster (${c})`).toBe(true);
        await p.waitForTimeout(200);
      }
    }

    // ---- [1] The click-start clip: live paused on its first frame; F8 plays it, Shift+F8 restarts it, its
    // end advances the service (onEnd 'advance', reported by the audio master); the stage counts it down.
    const op = await context.newPage();
    await login(op, `http://op.localhost:${PORT}`);
    await op.evaluate(() => {
      location.hash = '#/live';
    });
    // (5) The operator's banner says why the failed clip's slide shows its poster, never that it was
    // replaced with an empty slide.
    const why = op.locator('[data-degraded-kind="media"]');
    await expect(why).toContainText('went live without media that is not ready', { timeout: 20_000 });
    await expect(why).toContainText(
      '"Probe media – slide 11 video" (slide video) failed; showing its poster',
    );
    await expect(op.locator('[data-degraded-kind="empty"]')).toHaveCount(0);
    await expect(op.locator('[data-degraded]')).not.toContainText('replaced with an empty slide');
    await expect(op.getByText('Probe media').first()).toBeVisible({ timeout: 20_000 });
    await go(1);
    await expect.poll(async () => (await live()).layers.media.content?.state).toBe('paused');
    for (const p of both) {
      await expect.poll(() => cueOn(p), { timeout: 20_000 }).toBe(1);
      await expect
        .poll(async () => isMagenta(at(await frame(p), [960, 540])), { timeout: 15_000 })
        .toBe(true);
      expect((await slotOf(p, clickKey))?.paused).toBe(true);
    }
    await op.bringToFront();
    await op.locator('body').click();
    const playBtn = op.getByRole('button', { name: '▶' });
    if (await playBtn.isVisible()) {
      await playBtn.click();
    } else {
      await op.keyboard.press('F8');
    }
    await expect.poll(async () => (await live()).layers.media.content?.state).toBe('playing');
    for (const p of both)
      await expect.poll(async () => (await slotOf(p, clickKey))?.paused, { timeout: 10_000 }).toBe(false);
    await expect
      .poll(async () => (await slotOf(gpu, clickKey))?.t ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0.6);
    const startedAt = (await live()).layers.media.content!.startedAt;
    const before = (await slotOf(gpu, clickKey))!.t;
    await op.bringToFront();
    await op.locator('body').click();
    const restartBtn = op.getByRole('button', { name: '⟲' });
    if (await restartBtn.isVisible()) {
      await restartBtn.click();
    } else {
      await op.keyboard.press('Shift+F8');
    }
    await expect
      .poll(async () => (await live()).layers.media.content?.startedAt ?? 0)
      .toBeGreaterThan(startedAt);
    await expect
      .poll(async () => (await slotOf(gpu, clickKey))?.t ?? 9, { timeout: 5_000 })
      .toBeLessThan(before - 0.3);
    await stage.bringToFront();
    await expect(stage.locator('.media-remaining')).toContainText('Probe media – slide 2 video');
    await expect(stage.locator('.media-remaining')).toContainText(/00:0[1-5]/);
    await expect.poll(async () => (await live()).live, { timeout: 15_000 }).toBe(2);
    await expect.poll(async () => (await live()).layers.media.content).toBeNull();

    // ---- [3] The motion background: a muted looping video behind the slide's text, moving.
    await go(3);
    for (const p of both) {
      await expect.poll(() => cueOn(p), { timeout: 20_000 }).toBe(3);
      const shots = [];
      for (let i = 0; i < 3; i++) {
        shots.push(await frame(p, `motion-${i}`));
        await p.waitForTimeout(400);
      }
      const blue = at(shots[0]!, [200, 1000]);
      expect(blue[2] > 150 && blue[0] < 40, `${name(p)}: the blue motion background (${blue})`).toBe(true);
      const moved = diffShare(shots[0]!, shots[2]!);
      expect(moved, `${name(p)}: it moves (${(moved * 100).toFixed(2)}% of pixels changed)`).toBeGreaterThan(
        0.005,
      );
    }
    const bgId = slides[3]!.backgroundMediaId!;
    await expect
      .poll(async () => (await slots(gpu)).some((s) => s.key.includes(bgId) && !s.paused), {
        timeout: 10_000,
      })
      .toBe(true);
    expect(
      (await slots(gpu)).find((s) => s.key.includes(bgId))?.muted,
      'the motion background is muted',
    ).toBe(true);

    // ---- [4-8] The numSld=3 sound plays across three shown slides (the hidden one is skipped) and stops on
    // the next.
    const sound = slides[4]!.audio!.mediaId;
    await go(4);
    await expect.poll(async () => (await live()).audio.content?.mediaId).toBe(sound);
    const first = (await live()).audio.content!;
    expect(first).toMatchObject({ slideOwned: true, untilCue: 7, state: 'playing' });
    const playsOn = async (cue: number) =>
      expect((await live()).audio.content, `the sound plays on at cue ${cue}`).toMatchObject({
        mediaId: sound,
        startedAt: first.startedAt,
        state: 'playing',
      });
    await action('next');
    await expect.poll(async () => (await live()).live).toBe(6);
    await playsOn(6);
    // The hidden slide inside the range, shown by a GO with its cue: the sound plays on through it.
    await go(5);
    await expect.poll(async () => (await live()).live).toBe(5);
    await playsOn(5);
    for (const cue of [6, 7]) {
      await action('next');
      await expect.poll(async () => (await live()).live).toBe(cue);
      await playsOn(cue);
    }
    await action('next');
    await expect.poll(async () => (await live()).live).toBe(8);
    await expect.poll(async () => (await live()).audio.content).toBeNull();

    // ---- [9] The clip that is not a video, and [10] the clip that failed: posters, nothing plays.
    for (const cue of [9, 10]) {
      await go(cue);
      await expect.poll(async () => (await live()).live).toBe(cue);
      expect((await live()).layers.media.content).toBeNull();
      for (const p of both) {
        await expect.poll(() => cueOn(p), { timeout: 20_000 }).toBe(cue);
        await expect
          .poll(async () => isOrange(at(await frame(p), [960, 540])), {
            timeout: 15_000,
            message: `${name(p)}: the poster of cue ${cue}`,
          })
          .toBe(true);
      }
    }

    // ---- [11] (6) The trimmed looping clip loops between its trim points: only its green and blue seconds
    // show, never the red first or the yellow last, and its element wraps before 2.2 s.
    const trimKey = key(11, trimmed.mediaId);
    await go(11);
    for (const p of both) await expect.poll(() => cueOn(p), { timeout: 20_000 }).toBe(11);
    await expect.poll(async () => (await slotOf(gpu, trimKey))?.paused, { timeout: 20_000 }).toBe(false);
    const { PNG } = await import('./png.ts');
    for (const p of both) {
      const n = name(p);
      await p.bringToFront();
      // The element's time, sampled densely: it never passes the kept 2 s, and it wraps.
      const times: number[] = [];
      for (let i = 0; i < 60; i++) {
        times.push((await slotOf(p, trimKey))?.t ?? -1);
        await p.waitForTimeout(50);
      }
      // What the screen shows: one pixel at the centre per screenshot (a screenshot of a playing output
      // under SwiftShader takes over a second, so these sample the loop at drifting phases).
      const vp = p.viewportSize()!;
      const quarters = new Map<string, number>();
      for (let i = 0; i < 8; i++) {
        const px = PNG.firstPixel(
          await p.screenshot({ clip: { x: vp.width / 2, y: vp.height / 2, width: 1, height: 1 } }),
        );
        const q = quarterOf([px.r, px.g, px.b]) ?? 'other';
        quarters.set(q, (quarters.get(q) ?? 0) + 1);
      }
      console.log(
        `${n}: trimmed loop frames ${[...quarters].map(([k, v]) => `${k} ${v}`).join(', ')}; element times ${times
          .map((t) => t.toFixed(2))
          .join(' ')}`,
      );
      expect(quarters.get('red') ?? 0, `${n}: the trimmed-off first second never shows`).toBe(0);
      expect(quarters.get('yellow') ?? 0, `${n}: the trimmed-off last second never shows`).toBe(0);
      expect(quarters.get('green') ?? 0, `${n}: the second second shows`).toBeGreaterThan(0);
      expect(quarters.get('blue') ?? 0, `${n}: the third second shows`).toBeGreaterThan(0);
      expect(Math.max(...times), `${n}: the element plays only the kept 2 s`).toBeLessThan(2.2);
      expect(
        times.some((t, i) => i > 0 && t < times[i - 1]! - 1),
        `${n}: the clip wrapped`,
      ).toBe(true);
    }

    // ---- [12-15] The announcement loop: the music plays across all four slides and does not restart when
    // the loop wraps.
    const music = loopSlides[0]!.audio!.mediaId;
    await go(12);
    await expect.poll(async () => (await live()).audio.content?.mediaId).toBe(music);
    const audioSlot = async (p: Page) => (await slots(p)).find((s) => s.id >= 4 && s.key && !s.paused);
    await expect.poll(async () => !!(await audioSlot(gpu)), { timeout: 10_000 }).toBe(true);
    expect(await audioSlot(c2d), 'only the audio master plays the music').toBeUndefined();
    const samples: { live?: number; startedAt?: number; untilCue?: number }[] = [];
    let seenLast = false;
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const st = await live();
      samples.push({
        live: st.live,
        startedAt: st.audio.content?.startedAt,
        untilCue: st.audio.content?.untilCue,
      });
      if (st.live === 15) seenLast = true;
      if (seenLast && st.live === 13) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(new Set(samples.map((s) => s.live))).toEqual(new Set([12, 13, 14, 15]));
    expect(new Set(samples.map((s) => s.startedAt)).size, 'one play across the wrap').toBe(1);
    expect(samples.every((s) => s.untilCue === 15)).toBe(true);
    const musicT = (await audioSlot(gpu))?.t ?? 0;
    const elapsed = (Date.now() - samples[0]!.startedAt!) / 1000;
    expect(
      musicT,
      `the music element was not restarted (${musicT} s, ${elapsed} s since its start)`,
    ).toBeGreaterThan(elapsed - 2);
    expect(LOOP_SLIDES).toHaveLength(4);

    for (const p of both) expect((await telemetryOf(p)).error ?? '').toBe('');
  } finally {
    hub.kill();
  }
});
