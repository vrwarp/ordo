import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { pro7Type } from '../packages/importers/src/proto.ts';
import { portOf } from './ports.ts';
import {
  editorHub,
  editorState,
  frames,
  openEditor,
  type PresentationRec,
  slidesOf,
} from './editorhelpers.ts';
import { uploadMedia } from './helpers.ts';
import type { HubProcess } from './hubproc.ts';
import { hubApi } from './linkhelpers.ts';
import { decodePng, type Pixels } from './png.ts';
import { ffmpeg } from './pptxdecks.ts';
import {
  apiJson,
  at,
  cacheReady,
  capture,
  liveEvent,
  type OutputRec,
  roleWindow,
  settledOn,
} from './pptxlive.ts';

/**
 * A ProPresenter song as a church brings it in (design/20 "ProPresenter"): one `.pro` picked from the NAS,
 * its picture from its folder, on its presentation's background colour. The picture keeps its round
 * corners with its shadow (design/27 §7.1 "Picture effects"), and the editor's background replace shows the
 * new picture instead of a slide still covered by the colour it was imported on (the backdrop,
 * `origin.role: 'bg'`). Its port: e2e/ports.ts row 'pro7-import'.
 */
const PORT = portOf('pro7-import');
const OUT = 'test-results/pro7-import';

const BLUE = { red: 0.1, green: 0.2, blue: 0.55, alpha: 1 };
/** The picture element: a rounded rectangle with a drop shadow down and to the right. */
const PICTURE = { x: 660, y: 120, w: 600, h: 400 };

function rtf(text: string): Uint8Array {
  return new TextEncoder().encode(
    `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2639\n{\\fonttbl\\f0\\fnil\\fcharset0 Helvetica;}\n` +
      `{\\colortbl;\\red255\\green255\\blue255;}\n\\pard\\qc\\f0\\fs120 \\cf1 ${text}}`,
  );
}

/** A song of one slide: a lyric under a rounded, shadowed picture of `Media/hall.png`, on a blue background. */
function song(): Uint8Array {
  const t = pro7Type('rv.data.Presentation');
  const slide = {
    size: { width: 1920, height: 1080 },
    elements: [
      {
        element: {
          uuid: { string: 'E-LYRIC' },
          name: 'Lyric',
          bounds: { origin: { x: 160, y: 700 }, size: { width: 1600, height: 260 } },
          opacity: 1,
          text: { rtfData: rtf('Holy, holy, holy') },
        },
      },
      {
        element: {
          uuid: { string: 'E-HALL' },
          name: 'Hall',
          bounds: { origin: { x: PICTURE.x, y: PICTURE.y }, size: { width: PICTURE.w, height: PICTURE.h } },
          opacity: 1,
          path: { shape: { type: 'TYPE_ROUNDED_RECTANGLE', roundedRectangle: { roundness: 0.4 } } },
          shadow: { enable: true, angle: 315, offset: 24, radius: 12, opacity: 1, color: { alpha: 1 } },
          fill: {
            enable: true,
            media: {
              url: { absoluteString: 'file:///Users/worship/Documents/ProPresenter/Media/hall.png' },
              image: { drawing: { scaleBehavior: 'SCALE_BEHAVIOR_STRETCH' } },
            },
          },
          text: { rtfData: rtf('') },
        },
      },
    ],
  };
  return t
    .encode(
      t.fromObject({
        uuid: { string: 'P-HOLY' },
        name: 'Holy Holy Holy',
        background: { isEnabled: true, color: BLUE },
        cues: [
          {
            uuid: { string: 'C-1' },
            isEnabled: true,
            actions: [
              {
                uuid: { string: 'A-1' },
                type: 'ACTION_TYPE_PRESENTATION_SLIDE',
                isEnabled: true,
                slide: { presentation: { baseSlide: slide } },
              },
            ],
          },
        ],
      }),
    )
    .finish();
}

/** The editor's canvas as drawn, and the colour at a logical slide point. */
async function canvas(page: Page, file: string): Promise<(x: number, y: number) => [number, number, number]> {
  await frames(page);
  const png = await page.locator('.canvasbox .konvajs-content').first().screenshot({ path: file });
  const img: Pixels = decodePng(png);
  return (x, y) => {
    const px = Math.min(img.width - 1, Math.round((x * img.width) / 1920));
    const py = Math.min(img.height - 1, Math.round((y * img.height) / 1080));
    const o = (py * img.width + px) * 4;
    return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!];
  };
}

const near = (c: [number, number, number], want: [number, number, number], tol = 40) =>
  c.every((v, i) => Math.abs(v - want[i]!) <= tol);

/** The song and its picture on the NAS (the hub's import root), imported from its path; a red picture uploaded. */
async function importSong(
  a: APIRequestContext,
  hub: HubProcess,
): Promise<{ id: string; p: PresentationRec; series: { id: string } }> {
  const folder = resolve(hub.dataDir, 'import', 'Sunday');
  mkdirSync(join(folder, 'Media'), { recursive: true });
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x22aa44:s=600x400',
    '-frames:v',
    '1',
    join(folder, 'Media', 'hall.png'),
  ]);
  writeFileSync(join(folder, 'Holy Holy Holy.pro'), song());
  const red = join(OUT, 'series-red.png');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xdd2222:s=1920x1080', '-frames:v', '1', red]);
  const series = await uploadMedia(a, red, 'image/png', true);

  const queued = await apiJson<{ id: string }>(a, 'import/pro7', {
    post: { path: join(folder, 'Holy Holy Holy.pro') },
  });
  type Job = { state: string; log: string[]; result?: { presentationId?: string; media?: number } };
  let job: Job | undefined;
  await expect
    .poll(
      async () => {
        job = await apiJson<Job>(a, `jobs/${queued.id}`);
        return job.state;
      },
      { timeout: 60_000 },
    )
    .toMatch(/^(done|failed)$/);
  expect(job!.state, job!.log.join('\n')).toBe('done');
  // The picture beside the song came with it ("Media found alongside is uploaded").
  expect(job!.result?.media, job!.log.join('\n')).toBe(1);
  const id = job!.result!.presentationId!;
  const p = await apiJson<PresentationRec>(a, `presentations/${id}`);
  // The picture's media job (its delivery file) is done before the song goes live.
  for (const o of slidesOf(p)[0]!.objects as { type: string; mediaId?: string }[])
    if (o.type === 'image' && o.mediaId)
      await expect
        .poll(async () => (await apiJson<{ state: string }>(a, `media/${o.mediaId}`)).state, {
          timeout: 60_000,
        })
        .toBe('ready');
  return { id, p, series };
}

const BLUE_PX: [number, number, number] = [26, 51, 140];
const GREEN_PX: [number, number, number] = [34, 170, 68];
const RED_PX: [number, number, number] = [221, 34, 34];

test.describe.configure({ mode: 'serial' });

test('a ProPresenter song from the NAS: its picture from its folder, round with its shadow, its colour replaceable', async ({
  page,
}) => {
  test.setTimeout(240_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const { id, p, series } = await importSong(a, hub);
    // The presentation's colour is the slide's backdrop; the picture keeps its corner radius and shadow.
    const [backdrop, picture] = slidesOf(p)[0]!.objects as {
      type: string;
      origin?: { role?: string };
      radius?: number;
      shadow?: unknown;
    }[];
    expect(backdrop).toMatchObject({ type: 'shape', origin: { src: 'pro7', role: 'bg' } });
    expect(picture).toMatchObject({ type: 'image', radius: 80 });
    expect(picture!.shadow).toBeDefined();
    await openEditor(page, PORT, id);
    const before = await canvas(page, join(OUT, 'imported.png'));
    const blue = BLUE_PX;
    expect(near(before(40, 40), blue), `${before(40, 40)}`).toBe(true);
    expect(near(before(PICTURE.x + PICTURE.w / 2, PICTURE.y + PICTURE.h / 2), GREEN_PX)).toBe(true);
    // The round corner: outside the corner's arc the slide shows, not the picture (#20 drew it square).
    const corner = before(PICTURE.x + 6, PICTURE.y + 6);
    expect(near(corner, GREEN_PX), `${corner}`).toBe(false);
    // The shadow, down and to the right of the picture, darkens the blue.
    const shade = before(PICTURE.x + PICTURE.w + 10, PICTURE.y + PICTURE.h / 2);
    expect(shade[2], `${shade}`).toBeLessThan(blue[2] - 30);

    // Replace the slide's background: the new picture shows where the imported colour was.
    await page.getByRole('button', { name: 'Slide', exact: true }).click();
    const section = page.locator('[data-slide-background]');
    await section.getByRole('button', { name: 'Replace…' }).click();
    await page.getByRole('dialog').locator('.thumb', { hasText: 'series-red' }).click();
    await expect
      .poll(async () => slidesOf((await editorState(page)).draft!)[0]!.backgroundMediaId)
      .toBe(series.id);
    const replaced = slidesOf((await editorState(page)).draft!)[0]!.objects as { type: string }[];
    expect(replaced.map((o) => o.type)).toEqual(['image', 'text']);
    await expect
      .poll(async () => near((await canvas(page, join(OUT, 'replaced.png')))(40, 40), RED_PX))
      .toBe(true);
  } finally {
    hub.kill();
  }
});

test("a Background override for this service shows on the song's slides, its picture still round and shadowed", async ({
  context,
}) => {
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
  const hub = await editorHub(PORT);
  try {
    const a = await hubApi(PORT);
    const { id, series } = await importSong(a, hub);
    // The item's Background override: the series picture for this service.
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: {
        name: 'Sunday',
        items: [{ id: 'song', kind: 'presentation', presentationId: id, backgroundMediaId: series.id }],
      },
    });
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const audience = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
    const w = await roleWindow(context, PORT, audience, { width: 1920, height: 1080 }, 'renderer=2d');
    await cacheReady(w);
    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
    await settledOn(w, 0);
    const shot = await capture(w, join(OUT, 'override.png'));
    // The override shows where the song's colour was (its backdrop is not drawn over it).
    expect(near(at(shot, [40, 40]), RED_PX), `${at(shot, [40, 40])}`).toBe(true);
    // The picture, prepared by the output with its round corners and its shadow over the override.
    expect(near(at(shot, [PICTURE.x + PICTURE.w / 2, PICTURE.y + PICTURE.h / 2]), GREEN_PX)).toBe(true);
    const corner = at(shot, [PICTURE.x + 6, PICTURE.y + 6]);
    expect(near(corner, RED_PX), `${corner}`).toBe(true);
    const shade = at(shot, [PICTURE.x + PICTURE.w + 10, PICTURE.y + PICTURE.h / 2]);
    expect(shade[0], `${shade}`).toBeLessThan(RED_PX[0] - 60);
  } finally {
    hub.kill();
  }
});
