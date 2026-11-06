import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { convertDeck, NativeRenderer } from '../tools/pptx-fidelity/src/native.ts';
import { hubApi, login } from './linkhelpers.ts';
import { decodePng } from './png.ts';
import {
  apiJson,
  at,
  cacheReady,
  capture,
  diffShare,
  importPptx,
  liveEvent,
  type OutputRec,
  pptxHub,
  roleWindow,
  settledOn,
  ssim,
  telemetryOf,
} from './pptxlive.ts';
import { TEXT_DECK, textDeck, VERSE_TEXT, VERSES } from './pptxdecks.ts';

/**
 * A PowerPoint deck imported as editable slides, end to end (design/27 §14.12; §15 M3 exit): a synthetic
 * probe deck (`pptxdecks.ts` `textDeck`) goes through the real upload route, goes live, and
 * - Audience 1 at 1920x1080 (WebGPU) and Audience 2 at 3840x2160 (Canvas 2D) draw three of its slides as
 *   the fidelity harness's native page draws them (tools/pptx-fidelity, SSIM ≥ 0.99, greyscale 960x540);
 * - the stage, the Lobby (lower-third) and Stream looks, the cue labels and the library search show the
 *   slide text with its verse numbers;
 * - its hidden slide keeps a flagged cue: Next and Prev skip it, a double-click in the slide grid shows it,
 *   and every slide keeps its own notes and text.
 *
 * Playlist (cues): [0-4] the deck (cue 2 the hidden slide); [5-6] "Reference", typed in ordo: the verse
 * text as plain text, and the same text without its verse numbers (the band comparisons). Port 8396.
 */
const PORT = 8396;
const OUT = 'test-results/pptx-native';

type Slide = {
  id: string;
  hidden?: boolean;
  notes?: string;
  lyricObjectId?: string;
  objects: { id: string; type: string; text?: string }[];
  pptx?: { index: number; shown?: number; class: string };
};
type Presentation = { id: string; title: string; kind: string; sections: { slides: Slide[] }[] };
type Cue = { index: number; label: string; hidden?: boolean; slideId?: string };
type Live = { live?: number; cues: Cue[] };

test('an imported PowerPoint deck draws like the harness, shows its text everywhere and skips its hidden slide', async ({
  context,
}) => {
  test.setTimeout(420_000);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deckFile = await textDeck(join(OUT, 'deck'));

  // ---- The fidelity harness's drawing of the same deck (its native page, tools/pptx-fidelity).
  const harnessDir = join(OUT, 'harness');
  mkdirSync(harnessDir, { recursive: true });
  const converted = await convertDeck(deckFile, harnessDir);
  expect(converted.error).toBeUndefined();
  const renderer = await NativeRenderer.start(chromium.executablePath());
  let rendered: Awaited<ReturnType<NativeRenderer['renderDeck']>>;
  try {
    rendered = await renderer.renderDeck(converted, harnessDir, 0);
  } finally {
    await renderer.close();
  }
  expect(rendered.slides.map((s) => s.error ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'ok']);
  const harnessPng = (shown: number) => join(harnessDir, rendered.slides[shown]!.png!);

  const hub = await pptxHub(PORT);
  try {
    const a = await hubApi(PORT);
    // ---- Import through the route, as the import screen sends it.
    const job = await importPptx(a, deckFile);
    const p = await apiJson<Presentation>(a, `presentations/${job.result!.presentationId}`);
    const slides = p.sections.flatMap((s) => s.slides);
    expect(slides).toHaveLength(TEXT_DECK.length);

    // Notes, text and the hidden flag stay with their own slide (design/27 §15 M3 exit, §9).
    for (const [i, want] of TEXT_DECK.entries()) {
      const s = slides[i]!;
      expect(s.pptx?.index, `slide ${i + 1}`).toBe(i);
      expect(s.pptx?.class).toBe('native');
      expect(s.hidden === true, `slide ${i + 1} hidden`).toBe(want.hidden === true);
      expect(s.notes, `slide ${i + 1} notes`).toBe(want.notes);
      const texts = s.objects.filter((o) => o.type === 'text').map((o) => o.text);
      expect(texts, `slide ${i + 1} text`).toContain(want.text);
    }
    expect(slides.map((s) => s.pptx?.shown)).toEqual([0, 1, undefined, 2, 3]);
    const verse = slides[1]!;
    expect(verse.objects.find((o) => o.id === verse.lyricObjectId)?.text).toBe(VERSE_TEXT);

    // The verse text typed in ordo, with and without its verse numbers (the band comparisons).
    const plain = (id: string, text: string) => ({
      id,
      objects: [
        {
          id: `${id}-t`,
          type: 'text',
          box: { x: 160, y: 200, w: 1600, h: 600, rotation: 0 },
          text,
          style: { fontFamily: 'Inter', fontSizePx: 60, color: { r: 255, g: 255, b: 255, a: 1 } },
        },
      ],
    });
    const ref = await apiJson<{ id: string }>(a, 'presentations', {
      post: {
        title: 'Reference',
        kind: 'slides',
        sections: [
          {
            id: 'ref',
            label: 'Reference',
            short: 'R',
            slides: [
              plain('ref-verse', VERSE_TEXT),
              plain('ref-bare', VERSES.map(([, t]) => t.trim()).join('\n')),
            ],
          },
        ],
      },
    });
    const pl = await apiJson<{ id: string }>(a, 'playlists', {
      post: {
        name: 'Imported deck',
        items: [
          { id: 'deck', kind: 'presentation', presentationId: p.id },
          { id: 'ref', kind: 'presentation', presentationId: ref.id },
        ],
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
    await liveEvent(a, { k: 'goLive', playlistId: pl.id });

    const live = async () => (await apiJson<{ state: Live }>(a, 'live')).state;
    const st = await live();
    expect(st.cues).toHaveLength(7);
    // Cue labels: the slide text with its verse numbers; the hidden slide's cue is flagged.
    // (cut at 60 characters, its lines joined with ' / ')
    expect(st.cues[1]!.label).toBe(`${VERSE_TEXT.replace(/\n/g, ' / ').slice(0, 59)}…`);
    expect(st.cues.map((c) => c.hidden === true)).toEqual([false, false, true, false, false, false, false]);
    expect(st.cues[2]!.label).toBe(TEXT_DECK[2]!.text);

    // ---- Outputs: Audience 1 at 1080p on WebGPU, Audience 2 at 4K on Canvas 2D, Lobby, Stream, Stage.
    const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
    const byHost = (n: number) => outs.find((o) => o.hostIndex === n && o.kind !== 'stage')!;
    const hd = await roleWindow(context, PORT, byHost(1), { width: 1920, height: 1080 }, 'renderer=webgpu');
    const uhd = await roleWindow(context, PORT, byHost(2), { width: 3840, height: 2160 }, 'renderer=2d');
    const lobby = await roleWindow(context, PORT, byHost(3), { width: 1920, height: 1080 }, 'renderer=2d');
    const stream = await roleWindow(context, PORT, byHost(4), { width: 1920, height: 1080 }, 'renderer=2d');
    const stage = await roleWindow(context, PORT, outs.find((o) => o.kind === 'stage')!, {
      width: 1920,
      height: 1080,
    });
    const audience = [hd, uhd];
    for (const w of [hd, uhd, lobby, stream]) await cacheReady(w);
    await expect.poll(async () => (await telemetryOf(hd)).compositor).toBe('webgpu');
    await expect.poll(async () => (await telemetryOf(uhd)).compositor).toBe('2d');

    // ---- (1) Three imported slides against the harness: cues 0, 1 and 3 are shown slides 0, 1 and 2.
    const scores: string[] = [];
    for (const [cue, shown] of [
      [0, 0],
      [1, 1],
      [3, 2],
    ] as const) {
      await liveEvent(a, { k: 'go', cueIndex: cue, at: Date.now() });
      for (const [w, name] of [
        [hd, '1080p'],
        [uhd, '4k'],
      ] as const) {
        await settledOn(w, cue);
        const file = join(OUT, `cue${cue}-${name}.png`);
        await capture(w, file);
        const s = ssim(file, harnessPng(shown));
        scores.push(`cue ${cue} ${name} ${s.toFixed(4)}`);
        expect(s, `cue ${cue} at ${name} against the harness`).toBeGreaterThanOrEqual(0.99);
      }
    }
    console.log(`SSIM against the harness's native page: ${scores.join(', ')}`);

    // ---- (2) The text readers on the verse slide.
    await liveEvent(a, { k: 'go', cueIndex: 1, at: Date.now() });
    for (const w of audience) await settledOn(w, 1);
    // Stage: the lyric text with its verse numbers; the next slide is the one Next goes to.
    await stage.bringToFront();
    for (const [n, t] of VERSES) await expect(stage.locator('.current')).toContainText(`${n}${t}`);
    await expect(stage.locator('.next')).toContainText(TEXT_DECK[3]!.text);
    // Lobby and Stream draw exactly the verse text with its numbers: the same pixels as the text typed in
    // ordo (cue 5), and visibly other pixels than the text without its numbers (cue 6).
    const bands: Record<string, Record<number, string>> = { lobby: {}, stream: {} };
    for (const cue of [1, 5, 6]) {
      if (cue !== 1) await liveEvent(a, { k: 'go', cueIndex: cue, at: Date.now() });
      for (const [w, name] of [
        [lobby, 'lobby'],
        [stream, 'stream'],
      ] as const) {
        await settledOn(w, cue);
        const file = join(OUT, `${name}-cue${cue}.png`);
        await capture(w, file);
        bands[name]![cue] = file;
      }
    }
    const px = (f: string) => decodePng(readFileSync(f));
    for (const name of ['lobby', 'stream'] as const) {
      const imported = px(bands[name]![1]!);
      const same = diffShare(imported, px(bands[name]![5]!));
      const bare = diffShare(imported, px(bands[name]![6]!));
      console.log(
        `${name}: ${(same * 100).toFixed(3)}% of pixels differ from the typed verse text, ` +
          `${(bare * 100).toFixed(3)}% from the text without verse numbers`,
      );
      expect(same, `${name}: the imported slide's band is the verse text with its numbers`).toBeLessThan(
        0.0005,
      );
      expect(bare, `${name}: a band without the verse numbers looks different`).toBeGreaterThan(0.002);
    }

    // ---- The operator: cue labels in the slide grid, Next, Prev and a double-click on the hidden slide.
    // The slide grid shows the live item.
    await liveEvent(a, { k: 'go', cueIndex: 1, at: Date.now() });
    await expect.poll(async () => (await live()).live).toBe(1);
    const op = await context.newPage();
    await login(op, `http://op.localhost:${PORT}`);
    await op.evaluate(() => {
      location.hash = '#/live';
    });
    const grid = op.locator('.thumb');
    await expect(grid.filter({ hasText: '16 For God so loved the world' }).first()).toBeVisible({
      timeout: 20_000,
    });
    const hiddenThumb = op.locator('.thumb.hidden-slide');
    await expect(hiddenThumb).toHaveCount(1);
    await expect(hiddenThumb).toHaveAttribute('title', TEXT_DECK[2]!.text);

    const press = async (key: string) => {
      await op.bringToFront();
      await op.keyboard.press(key);
    };
    // (3) Next skips the hidden slide; Prev skips it back; a double-click shows it.
    await press('Space');
    await expect.poll(async () => (await live()).live).toBe(3);
    for (const w of audience) await settledOn(w, 3);
    await stage.bringToFront();
    await expect(stage.locator('.current')).toContainText(TEXT_DECK[3]!.text);
    await press('ArrowLeft');
    await expect.poll(async () => (await live()).live).toBe(1);
    await op.bringToFront();
    await hiddenThumb.dblclick();
    await expect.poll(async () => (await live()).live).toBe(2);
    for (const w of audience) await settledOn(w, 2);
    await stage.bringToFront();
    await expect(stage.locator('.current')).toContainText(TEXT_DECK[2]!.text);
    // The hidden slide on screen is the hidden slide's own drawing (its yellow text on dark grey).
    const shot = await capture(hd, join(OUT, 'hidden-1080p.png'));
    expect(
      at(shot, [40, 1040]).every((v) => Math.abs(v - 0x3a) <= 12),
      'the hidden slide background',
    ).toBe(true);
    await press('Space');
    await expect.poll(async () => (await live()).live).toBe(3);
    // The cue each slide's notes and text belong to: the live slide is still the deck's slide 4.
    const now = await live();
    expect(now.cues[3]!.slideId).toBe(slides[3]!.id);
    expect(slides[3]!.notes).toBe(TEXT_DECK[3]!.notes);

    // ---- Search: the library finds the deck by its text, verse numbers included.
    await op.evaluate(() => {
      location.hash = '#/library';
    });
    const search = op.getByPlaceholder(/Search \d+ presentations/);
    await expect(search).toBeVisible({ timeout: 15_000 });
    const found = op.locator('.vlist .vrow').filter({ hasText: p.title });
    for (const q of ['16 for God so loved', 'Son. 17 For God', 'second service']) {
      await search.fill(q);
      await expect(found, `search "${q}"`).toHaveCount(1);
    }
    await search.fill('18 For God');
    await expect(found).toHaveCount(0);

    for (const w of [hd, uhd, lobby, stream]) expect((await telemetryOf(w)).error ?? '').toBe('');
  } finally {
    hub.kill();
  }
});
