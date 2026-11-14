import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type BrowserContext, expect, test } from '@playwright/test';
import { hubApi } from './linkhelpers.ts';
import { GUARD, guardColor, guardDeck } from './pptxdecks.ts';
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
 * The slide budgets' guard on both kinds of hub (design/27 §15 M9 "The guard per kind of hub", lo-forms; the
 * owner's decision of 2026-11-13): a title over 24 distinct full-slide pictures (`pptxdecks.ts` `guardDeck`),
 * past the render clamp's 16 with no picture sheets, so the guard leaves the topmost pictures out. Each deck
 * goes through the upload route to a hub of its own:
 * - **with LibreOffice** (port 0 of the 'pptx-guard' row): the left-out pictures are LibreOffice's art
 *   (`budget:pictures`); once version 2 is in, the slide waits for nothing, lists nothing missing, carries the
 *   art, and the Audience screen shows the topmost picture's colour. Before lo-forms the guard culled them on
 *   this hub too: listed missing, the 16th picture on screen.
 * - **without LibreOffice** (port 1 of the row, `ORDO_LIBREOFFICE=off`): as before, the
 *   guard keeps the 16 the clamp draws and the import report lists the rest ('decoration'); no follow-up.
 */
const PORT = portOf('pptx-guard', 0);
const NOLO_PORT = portOf('pptx-guard', 1);
const OUT = 'test-results/pptx-guard';
/** Channel difference allowed between a picture's colour and what the screen draws. */
const TOL = 12;
/** A point of the slide below its title, where only the topmost drawn picture shows (logical px). */
const SPOT: [number, number] = [960, 760];

type Job = {
  id: string;
  kind: string;
  state: string;
  log: string[];
  result?: { presentationId: string; missing?: number; pending?: number };
};
type Obj = { id: string; type: string; mediaId?: string; text?: string; origin?: { role?: string } };
type StoredSlide = {
  id: string;
  objects: Obj[];
  pptx?: { class?: string; missing?: string[]; pending?: boolean };
};
type Presentation = { id: string; sections: { slides: StoredSlide[] }[] };

const close = (got: RGB, want: [number, number, number]) =>
  got.every((v, k) => Math.abs(v - want[k]!) <= TOL);

/** Every job of the hub done (the import and its follow-ups: version 2 where a slide waits for LibreOffice). */
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

/** The stored slide of the guard deck. */
async function storedSlide(a: APIRequestContext, id: string): Promise<StoredSlide> {
  const p = await apiJson<Presentation>(a, `presentations/${id}`);
  const slides = p.sections.flatMap((s) => s.slides);
  expect(slides).toHaveLength(1);
  return slides[0]!;
}

/** The presentation live on Audience 1 (1920 x 1080, Canvas 2D): the colour it shows below the title. */
async function audienceColor(
  a: APIRequestContext,
  context: BrowserContext,
  port: number,
  presentationId: string,
  want: [number, number, number],
  name: string,
): Promise<void> {
  const pl = await apiJson<{ id: string }>(a, 'playlists', {
    post: { name: 'Pictures', items: [{ id: 'deck', kind: 'presentation', presentationId }] },
  });
  await liveEvent(a, { k: 'goLive', playlistId: pl.id });
  const outs = await apiJson<OutputRec[]>(a, 'settings/outputs');
  const audience = outs.find((o) => o.hostIndex === 1 && o.kind !== 'stage')!;
  const w = await roleWindow(context, port, audience, { width: 1920, height: 1080 }, 'renderer=2d');
  try {
    await cacheReady(w);
    await liveEvent(a, { k: 'go', cueIndex: 0, at: Date.now() });
    await settledOn(w, 0);
    let got: RGB = [0, 0, 0];
    await expect
      .poll(
        async () => {
          got = at(await capture(w, join(OUT, `${name}-audience.png`)), SPOT);
          return close(got, want);
        },
        { timeout: 30_000, message: `Audience shows ${want.join(',')}` },
      )
      .toBe(true);
    expect((await telemetryOf(w)).error ?? '').toBe('');
  } finally {
    await w.close();
  }
}

test("on a hub with LibreOffice the guard's left-out pictures are its art: the topmost picture shows, nothing listed", async ({
  context,
}) => {
  test.setTimeout(360_000);
  rmSync(join(OUT, 'lo'), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await guardDeck(join(OUT, 'lo'));
  const hub = await pptxHub(PORT);
  try {
    const a = await hubApi(PORT);
    const caps = await apiJson<{ libreoffice: { state: string } }>(a, 'capabilities');
    expect(caps.libreoffice.state, 'this hub has LibreOffice').not.toBe('off');
    const job = await importPptx(a, deck);
    const jobs = await settled(a);
    const lo = jobs.filter((j) => j.kind === 'pptx-lo');
    expect(lo, 'the LibreOffice follow-up ran once').toHaveLength(1);
    expect(lo[0]!.state, lo[0]!.log.join('\n')).toBe('done');
    const id = job.result!.presentationId;
    const s = await storedSlide(a, id);
    // Version 2: the art in, nothing waits, the import report lists nothing not drawn.
    expect(s.pptx?.class).toBe('hybrid');
    expect(s.pptx?.pending).toBeUndefined();
    expect(s.pptx?.missing ?? [], 'the import report lists nothing not drawn').toEqual([]);
    expect((job.result as Job['result'])?.missing ?? 0).toBe(0);
    expect(s.objects.filter((o) => o.type === 'image' && o.origin?.role === 'art')).toHaveLength(1);
    // Version 1 kept 15 of the pictures (the art is the clamp's 16th) and the title, which stays editable.
    expect(s.objects.filter((o) => o.type === 'image' && o.origin?.role !== 'art')).toHaveLength(15);
    expect(s.objects.some((o) => o.type === 'text' && o.text === GUARD.title)).toBe(true);
    // The topmost picture (LibreOffice's art) is what the audience sees.
    await audienceColor(a, context, PORT, id, guardColor(GUARD.pictures - 1), 'lo');
  } finally {
    hub.kill();
  }
});

test("on a hub without LibreOffice the guard's left-out pictures are listed, as before", async ({
  context,
}) => {
  test.setTimeout(240_000);
  rmSync(join(OUT, 'nolo'), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const deck = await guardDeck(join(OUT, 'nolo'));
  const before = process.env.ORDO_LIBREOFFICE;
  process.env.ORDO_LIBREOFFICE = 'off';
  let hub: Awaited<ReturnType<typeof pptxHub>>;
  try {
    hub = await pptxHub(NOLO_PORT);
  } finally {
    if (before === undefined) delete process.env.ORDO_LIBREOFFICE;
    else process.env.ORDO_LIBREOFFICE = before;
  }
  try {
    const a = await hubApi(NOLO_PORT);
    const caps = await apiJson<{ libreoffice: { state: string } }>(a, 'capabilities');
    expect(caps.libreoffice.state).toBe('off');
    const job = await importPptx(a, deck);
    const jobs = await settled(a);
    expect(jobs.filter((j) => j.kind === 'pptx-lo')).toHaveLength(0);
    const id = job.result!.presentationId;
    const s = await storedSlide(a, id);
    // The 16 the render clamp draws, the topmost eight listed: the import report names what is not drawn.
    expect(s.pptx).toMatchObject({ class: 'hybrid', missing: ['decoration'] });
    expect(s.pptx?.pending).toBeUndefined();
    expect((job.result as Job['result'])?.missing).toBe(1);
    expect(s.objects.filter((o) => o.type === 'image')).toHaveLength(16);
    expect(s.objects.some((o) => o.origin?.role === 'art')).toBe(false);
    await audienceColor(a, context, NOLO_PORT, id, guardColor(15), 'nolo');
  } finally {
    hub!.kill();
  }
});
