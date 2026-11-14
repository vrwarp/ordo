import { expect, test } from '@playwright/test';
import { m9Table } from '../packages/domain/src/m9.test-util.ts';
import { openEditor, openSlide } from './editorhelpers.ts';
import { PORT } from './helpers.ts';
import { hubApi } from './linkhelpers.ts';
import { decodePng, type Pixels } from './png.ts';
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
 * (`strapText`, design/27 §15 M9). A slide with text of its own still shows its band. The editor draws the
 * table with its drawer, loaded the first time a slide holds one.
 */

const OUT = 'test-results/bottom-third-m9';

/**
 * The M9 fixture table in the hub's bundled Inter: an output's page waits for every face it was sent, and a
 * family the hub does not have (the fixture's Calibri, Malgun Gothic, Georgia) would keep a screenshot waiting.
 */
function interTable() {
  const t = m9Table();
  t.base = { ...t.base, fontFamily: 'Inter' };
  t.styles = t.styles?.map(({ fontFamily: _f, fallbackFonts: _fb, ...s }) => s);
  t.runStyles = t.runStyles?.map(({ fontFamily: _f, ...s }) => s);
  return t;
}
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

test("the lobby and the stream show no band for a table's text; the editor draws the table", async ({
  context,
  page,
}) => {
  test.setTimeout(300_000);
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
                  table: interTable(),
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

  // The editor draws the table itself: the operator loads its drawer the first time a slide holds a table
  // (`loadShapeDrawers`, the M9 drawers loaded per object kind), never leaving the white rect an older build
  // draws. The table's header row is navy.
  await openEditor(page, PORT, p.id);
  await openSlide(page, 2);
  const canvas = page.locator('.canvasbox').first();
  await expect
    .poll(
      async () => {
        const shot = decodePng(await canvas.screenshot());
        let navy = 0;
        for (let i = 0; i < shot.data.length; i += 4) {
          const [r, g, b] = [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!];
          if (b > 70 && b < 200 && r < 70 && g < 110 && b > r + 40) navy++;
        }
        return navy;
      },
      { timeout: 20_000, message: 'the table header is drawn (navy), not a white rect' },
    )
    .toBeGreaterThan(400);
  // So does its thumbnail, drawn in the thumb worker by the outputs' prepare steps (`shapeDrawers`).
  const thumb = page.locator('.ed-slide-card').nth(1).locator('.ed-slide-thumb-wrap img');
  await expect
    .poll(
      () =>
        thumb.evaluate(async (img: HTMLImageElement) => {
          await img.decode().catch(() => undefined);
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const g = c.getContext('2d');
          if (!g || !c.width) return 0;
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let navy = 0;
          for (let i = 0; i < d.length; i += 4) {
            const [r, gr, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
            if (b > 70 && b < 200 && r < 70 && gr < 110 && b > r + 40) navy++;
          }
          return navy;
        }),
      { timeout: 30_000, message: "the table slide's thumbnail draws the table (navy header)" },
    )
    .toBeGreaterThan(200);
});
