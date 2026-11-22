import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type BrowserContext, expect, test } from '@playwright/test';
import { hubApi } from './linkhelpers.ts';
import {
  WHOLE,
  wholeCentre,
  wholeColor,
  wholeDeck,
  wholeText,
  probeMedia,
  type ProbeMedia,
} from './pptxdecks.ts';
import { portOf } from './ports.ts';
import {
  apiJson,
  at,
  cacheReady,
  capture,
  importPptx,
  liveEvent,
  type OutputRec,
  pptxHub,
  type RGB,
  roleWindow,
  settledOn,
  telemetryOf,
} from './pptxlive.ts';

/**
 * Heavy slides come in whole (design/29 1.9, 1.10; Q24.b, the first pre-render release): a deck of an ordinary slide, a slide of 300
 * pictures, a slide of about 108 KB of text and a slide with a video behind 40 pictures (`pptxdecks.ts` `wholeDeck`) goes through the
 * upload route to hubs of their own, started with `ORDO_PRERENDER=on`:
 * - **with LibreOffice** (port 0 of the 'pptx-prerender-import' row) and **without** (port 1, `ORDO_LIBREOFFICE=off`): the picture
 *   slide keeps all 300 pictures and the text slide all of its text, each with the pre-render record the editor and the go-live
 *   check read; the ordinary slide has none; the video slide is stored as before (a video anchors a slide: no record, the guard's
 *   pictures); the import says how many slides it kept whole; nothing waits for LibreOffice or is listed missing for them; the
 *   go-live check names the two kept-whole slides as slides without a picture yet (W33) and the Audience screen draws the
 *   slide itself meanwhile (through the render clamp: a part of the 300 pictures, no error; the picture, a later track, draws all);
 * - **off** (`ORDO_PRERENDER=off`, port 0 again): the same deck stores what it stored before this release: no record, the guard's pictures.
 */
const PORT = portOf('pptx-prerender-import', 0);
const NOLO_PORT = portOf('pptx-prerender-import', 1);
const OUT = 'test-results/pptx-prerender-import';
/** Channel difference allowed between a picture's colour and what the screen draws. */
const TOL = 12;
/** Pictures of the slide the Audience must draw at least (the render clamp's share of the 300 until a picture is made). */
const MIN_DRAWN = 8;

type Job = {
  id: string;
  kind: string;
  state: string;
  log: string[];
  result?: { presentationId: string; whole?: number; missing?: number; pending?: number };
};
type Obj = {
  id: string;
  type: string;
  mediaId?: string;
  text?: string;
  origin?: { role?: string };
};
type StoredSlide = {
  id: string;
  backgroundMediaId?: string;
  objects: Obj[];
  prerender?: { why: string[]; live: string[]; file?: string };
  pptx?: { class?: string; missing?: string[]; pending?: boolean };
};
type Presentation = { id: string; sections: { slides: StoredSlide[] }[]; source?: { log?: string } };

const close = (got: RGB, want: [number, number, number]) =>
  got.every((v, k) => Math.abs(v - want[k]!) <= TOL);
const images = (s: StoredSlide) => s.objects.filter((o) => o.type === 'image' && o.origin?.role !== 'art');
const distinct = (s: StoredSlide) => new Set(images(s).map((o) => o.mediaId)).size;

let media: ProbeMedia;
let deck: string;
test.beforeAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  media = probeMedia(join(OUT, 'media'));
  deck = wholeDeck(join(OUT, 'deck'), media);
});

/** A hub on `port` with these variables in its environment only (the worker's own stay as they were). */
async function hubWith(port: number, env: Record<string, string>) {
  const before = Object.keys(env).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, env);
  try {
    return await pptxHub(port);
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every job of the hub done (the import and its follow-ups). */
async function settled(a: APIRequestContext): Promise<Job[]> {
  let jobs: Job[] = [];
  await expect
    .poll(
      async () => {
        const r = (await (await a.get('jobs')).json()) as Job[] | { jobs: Job[] };
        jobs = Array.isArray(r) ? r : r.jobs;
        return jobs.length > 0 && jobs.every((j) => j.state === 'done' || j.state === 'failed');
      },
      { timeout: 240_000 },
    )
    .toBe(true);
  return jobs;
}

async function slidesOfDeck(
  a: APIRequestContext,
  id: string,
): Promise<{ slides: StoredSlide[]; log: string }> {
  const p = await apiJson<Presentation>(a, `presentations/${id}`);
  const slides = p.sections.flatMap((s) => s.slides);
  expect(slides).toHaveLength(WHOLE.slides.length);
  return { slides, log: p.source?.log ?? '' };
}

/**
 * The deck live on Audience 1 (1920 x 1080, Canvas 2D), cue `cue` shown: what the go-live check listed (W33) and how many of the
 * picture slide's 300 pictures the screen draws. Until a picture of a kept-whole slide is made (the bake, a later track) the screens
 * draw the slide themselves through the render clamp (`CLAMP.maxObjects` 200, `maxImagesPerSlide` 16): a part of the pictures, no error.
 */
async function audienceDraws(
  a: APIRequestContext,
  context: BrowserContext,
  port: number,
  presentationId: string,
  cue: number,
  name: string,
): Promise<{ degraded: string[]; drawn: number }> {
  const pl = await apiJson<{ id: string }>(a, 'playlists', {
    post: { name: 'Whole slides', items: [{ id: 'deck', kind: 'presentation', presentationId }] },
  });
  await liveEvent(a, { k: 'goLive', playlistId: pl.id });
  // What the go-live check lists for the deck (design/29 1.7, W33): read from the live state the hub resolved.
  let degraded: string[] = [];
  await expect
    .poll(
      async () => {
        const st = (
          (await (await a.get('live')).json()) as {
            state: { resolved?: { degraded?: { reason: string }[] } };
          }
        ).state;
        if (!st.resolved) return false;
        degraded = (st.resolved.degraded ?? []).map((d) => d.reason);
        return true;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
  const audience = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
  const w = await roleWindow(context, port, audience, { width: 1920, height: 1080 }, 'renderer=2d');
  let drawn = 0;
  try {
    await cacheReady(w);
    await liveEvent(a, { k: 'go', cueIndex: cue, at: Date.now() });
    await settledOn(w, cue);
    await expect
      .poll(
        async () => {
          const shot = await capture(w, join(OUT, `${name}-audience.png`));
          drawn = 0;
          for (let i = 0; i < WHOLE.pictures; i++)
            if (close(at(shot, wholeCentre(i)), wholeColor(i))) drawn++;
          return drawn;
        },
        { timeout: 30_000, message: 'pictures of the slide the Audience draws' },
      )
      .toBeGreaterThanOrEqual(MIN_DRAWN);
    expect((await telemetryOf(w)).error ?? '').toBe('');
  } finally {
    await w.close();
  }
  return { degraded, drawn };
}

/** The go-live check names the two slides kept whole as slides without a picture yet (W33): the screens draw them live until a picture is made. */
function expectPictureLine(degraded: string[]): void {
  const line = degraded.find((r) => r.includes(' no picture yet. '));
  expect(line, `W33 among ${JSON.stringify(degraded)}`).toBeDefined();
  expect(line).toMatch(/^2 slides of ".*" have no picture yet\./);
}

/** The four slides of the deck as a hub that keeps heavy slides whole stores them. */
function expectWhole({ slides, log }: { slides: StoredSlide[]; log: string }, job: Job): void {
  const [ordinary, pictures, text, video] = slides as [StoredSlide, StoredSlide, StoredSlide, StoredSlide];
  expect(ordinary.prerender, 'an ordinary slide has no record').toBeUndefined();
  // 300 pictures: all of them, with a record that says why.
  expect(images(pictures)).toHaveLength(WHOLE.pictures);
  expect(pictures.prerender?.why).toContain('count');
  expect(pictures.prerender?.live).toEqual([]);
  expect(pictures.pptx?.pending, 'nothing waits for LibreOffice').toBeUndefined();
  expect(pictures.pptx?.missing ?? [], 'nothing is listed missing').toEqual([]);
  // 12 boxes of 9,000 characters: every character, with a record.
  const boxes = text.objects.filter((o) => o.type === 'text' && (o.text ?? '').length >= WHOLE.textChars - 1);
  expect(boxes).toHaveLength(WHOLE.textBoxes);
  // Each box is its own words, whole: the first eight characters tell the twelve apart.
  expect(new Set(boxes.map((o) => (o.text ?? '').slice(0, 8)))).toEqual(
    new Set(Array.from({ length: WHOLE.textBoxes }, (_, b) => wholeText(b).slice(0, 8))),
  );
  expect(text.prerender?.why).toContain('bytes');
  expect(text.pptx?.missing ?? []).toEqual([]);
  // The video anchors its slide (a looping muted clip over the whole slide is its motion background): today's plan, no record.
  expect(video.prerender, 'a video keeps a slide out').toBeUndefined();
  expect(video.backgroundMediaId, 'the clip stays as the slide\u2019s motion background').toBeTruthy();
  expect(distinct(video)).toBeLessThanOrEqual(16);
  // The import says it: two slides kept whole.
  expect(job.result?.whole).toBe(2);
  expect(log).toMatch(/2 slides are very detailed and were kept whole/);
}

test('on a hub with LibreOffice the heavy slides come in whole, with their records, and the Audience draws past 200 objects', async ({
  context,
}) => {
  test.setTimeout(480_000);
  const hub = await hubWith(PORT, { ORDO_PRERENDER: 'on' });
  try {
    const a = await hubApi(PORT);
    const caps = await apiJson<{ libreoffice: { state: string }; prerender?: { state?: string } }>(
      a,
      'capabilities',
    );
    expect(caps.libreoffice.state, 'this hub has LibreOffice').not.toBe('off');
    expect(caps.prerender?.state).toBe('on');
    const job = await importPptx(a, deck);
    const jobs = await settled(a);
    expect(jobs.filter((j) => j.state === 'failed')).toEqual([]);
    const stored = await slidesOfDeck(a, job.result!.presentationId);
    expectWhole(stored, job as Job);
    const { degraded, drawn } = await audienceDraws(a, context, PORT, job.result!.presentationId, 1, 'lo');
    expectPictureLine(degraded);
    test
      .info()
      .annotations.push({ type: 'pictures drawn by the Audience (of 300)', description: String(drawn) });
  } finally {
    hub.kill();
  }
});

test('on a hub without LibreOffice it is the same: the converter keeps them whole, nothing is listed missing', async ({
  context,
}) => {
  test.setTimeout(480_000);
  const hub = await hubWith(NOLO_PORT, { ORDO_PRERENDER: 'on', ORDO_LIBREOFFICE: 'off' });
  try {
    const a = await hubApi(NOLO_PORT);
    const caps = await apiJson<{ libreoffice: { state: string }; prerender?: { state?: string } }>(
      a,
      'capabilities',
    );
    expect(caps.libreoffice.state).toBe('off');
    expect(caps.prerender?.state).toBe('on');
    const job = await importPptx(a, deck);
    const jobs = await settled(a);
    expect(jobs.filter((j) => j.kind === 'pptx-lo')).toHaveLength(0);
    const stored = await slidesOfDeck(a, job.result!.presentationId);
    expectWhole(stored, job as Job);
    const { degraded, drawn } = await audienceDraws(
      a,
      context,
      NOLO_PORT,
      job.result!.presentationId,
      1,
      'nolo',
    );
    expectPictureLine(degraded);
    test
      .info()
      .annotations.push({ type: 'pictures drawn by the Audience (of 300)', description: String(drawn) });
  } finally {
    hub.kill();
  }
});

test('a hub with ORDO_PRERENDER=off keeps today’s output: no record, the guard’s pictures, nothing kept whole', async () => {
  test.setTimeout(480_000);
  const hub = await hubWith(PORT, { ORDO_PRERENDER: 'off' });
  try {
    const a = await hubApi(PORT);
    const caps = await apiJson<{ prerender?: { state?: string } }>(a, 'capabilities');
    expect(caps.prerender?.state).toBe('off');
    const job = await importPptx(a, deck);
    await settled(a);
    const { slides, log } = await slidesOfDeck(a, job.result!.presentationId);
    for (const s of slides) expect(s.prerender, 'no record on an off hub').toBeUndefined();
    expect(log).not.toMatch(/kept whole/);
    // The picture slide is cut to the guard's pictures (15 with the art LibreOffice draws, 16 without): never the 300.
    expect(distinct(slides[1]!)).toBeLessThanOrEqual(16);
    expect(images(slides[1]!).length).toBeLessThan(WHOLE.pictures);
    expect((job as Job).result?.whole ?? 0).toBe(0);
  } finally {
    hub.kill();
  }
});
