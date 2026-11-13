import { expect, test } from '@playwright/test';
import { m9Table } from '../packages/domain/src/m9.test-util.ts';
import { PORT } from './helpers.ts';
import { hubApi } from './linkhelpers.ts';
import type { Pixels } from './png.ts';
import {
  apiJson,
  cacheReady,
  capture,
  liveEvent,
  type OutputRec,
  roleWindow,
  settledOn,
} from './pptxlive.ts';

/**
 * A slide whose only text is in an M9 table (or a chart) has no Bottom-Third strap: the Lobby and the
 * Bottom-Third Stream show nothing for it, never the table's cells as a band of tab-separated words
 * (`strapText`, design/27 §15 M9). A slide with text of its own still shows its band.
 */

const OUT = 'test-results/bottom-third-m9';
const white = { r: 255, g: 255, b: 255, a: 1 };

/**
 * Pixels of the frame's lower 60 % that are not black: where a band is drawn, below the window's
 * "Enter full screen" prompt (top right, captured in every screenshot).
 */
function lit(img: Pixels): number {
  let n = 0;
  for (let y = Math.floor(img.height * 0.4); y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i]! + img.data[i + 1]! + img.data[i + 2]! > 60) n++;
    }
  return n;
}

test("the lobby and the stream show no band for a table's text", async ({ context }) => {
  test.setTimeout(180_000);
  const a = await hubApi(PORT);
  const text = (id: string, t: string) => ({
    id,
    type: 'text',
    box: { x: 160, y: 300, w: 1600, h: 400, rotation: 0 },
    text: t,
    style: { fontFamily: 'Inter', fontSizePx: 60, color: white },
    opacity: 1,
  });
  const p = await apiJson<{ id: string }>(a, 'presentations', {
    post: {
      title: 'Order of service',
      kind: 'slides',
      sections: [
        {
          id: 'sec',
          label: 'Order',
          short: 'O',
          slides: [
            { id: 'welcome', objects: [text('w', 'Welcome to worship')] },
            {
              id: 'order',
              objects: [
                {
                  id: 'table',
                  type: 'shape',
                  box: { x: 120, y: 160, w: 1320, h: 410, rotation: 0 },
                  shape: 'rect',
                  fill: white,
                  opacity: 1,
                  radius: 0,
                  table: m9Table(),
                },
              ],
            },
          ],
        },
      ],
    },
  });
  const pl = await apiJson<{ id: string }>(a, 'playlists', {
    post: {
      name: `Strap ${Date.now()}`,
      items: [{ id: 'order', kind: 'presentation', presentationId: p.id }],
    },
  });
  // The Lobby and Stream looks show the text of every presentation (by default only songs').
  const looks = await apiJson<{ id: string; layers: { slide: Record<string, unknown> } }[]>(
    a,
    'settings/looks',
  );
  await apiJson(a, 'settings/looks', {
    put: looks.map((l) =>
      l.id === 'look-lower-third' || l.id === 'look-stream'
        ? { ...l, layers: { ...l.layers, slide: { ...l.layers.slide, nonSong: 'text' } } }
        : l,
    ),
  });
  const live = await apiJson<{ state: { mode: string } }>(a, 'live');
  if (live.state.mode === 'live') await liveEvent(a, { k: 'endService', at: Date.now() });
  await liveEvent(a, { k: 'goLive', playlistId: pl.id });

  const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
  const lobbyRec = outs.find((o) => o.lookId === 'look-lower-third');
  const streamRec = outs.find((o) => o.lookId === 'look-stream');
  expect(lobbyRec, 'a Lobby output').toBeDefined();
  expect(streamRec, 'a Bottom-Third Stream output').toBeDefined();
  const size = { width: 960, height: 540 };
  const lobby = await roleWindow(context, PORT, lobbyRec!, size, 'renderer=2d');
  const stream = await roleWindow(context, PORT, streamRec!, size, 'renderer=2d');
  for (const w of [lobby, stream]) await cacheReady(w);

  // The welcome slide: its band shows on both.
  await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
  for (const [w, name] of [
    [lobby, 'lobby'],
    [stream, 'stream'],
  ] as const) {
    await settledOn(w, 0);
    const shot = await capture(w, `${OUT}-${name}-welcome.png`);
    expect(lit(shot), `${name}: the welcome band`).toBeGreaterThan(500);
  }
  // The order of service, a table only: nothing on either (before M9's strap rule its cells showed as a
  // band). An output that draws nothing for a slide holds no slide picture for its cue (and presents no new
  // frame to screenshot), so its state says it: the cue is live, the slide layer empty.
  await liveEvent(a, { k: 'go', cueIndex: 1, at: Date.now() });
  type OutState = { slideCue?: number; held: { live: string }[] };
  const held = (w: typeof lobby) =>
    w.evaluate(() => (window as unknown as { __ordo: { state(): OutState } }).__ordo.state());
  for (const [w, name] of [
    [lobby, 'lobby'],
    [stream, 'stream'],
  ] as const) {
    await w.bringToFront();
    await expect
      .poll(
        async () => {
          const st = await held(w);
          return st.slideCue === 1 ? st.held[1]?.live : 'not yet';
        },
        { timeout: 20_000, message: `${name}: the table slide is live and draws nothing` },
      )
      .toBe('');
    await w.waitForTimeout(1000);
    expect((await held(w)).held[1]?.live, `${name}: still nothing`).toBe('');
  }
  await liveEvent(a, { k: 'endService', at: Date.now() });
});
