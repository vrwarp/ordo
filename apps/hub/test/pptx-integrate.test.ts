/**
 * The M3 items together (design/27 §15 M3 "Exit"; apps/hub/src/pptx/README.md): crafted decks through the
 * route or the `pptx-native` job (item B) with real picture preparation (item C), then the LibreOffice
 * follow-up (item D) as the native job queued it, and the previous release's schema reading what was saved
 * (design/27 §14.7). The LibreOffice cases need soffice, pdftoppm and ffmpeg on the PATH (CI installs
 * them); they are skipped without soffice.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type ImageObject,
  jsonBytes,
  LOOK_MAIN,
  type Media,
  newId,
  Presentation,
  presentationBytes,
  previewSlice,
  SIZE_BUDGETS,
  type Slide,
  type SlideObject,
} from '@ordo/domain';
import * as prev from '@ordo/domain/schemas.prev.test-util.ts';
import type { Job } from '@ordo/protocol';
import { digestOf } from '@ordo/pptx-scene/emit.ts';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  chartFrame,
  chartXml,
  imageRel,
  NS_A,
  NS_P,
  NS_R,
  para,
  pic,
  pictureBg,
  run,
  solid,
  solidBg,
  sp,
  withPart,
} from '@ordo/pptx-scene/test-util.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drawSlide2D } from '../../../packages/renderer/src/text2d.ts';
import type { PptxDeps, PptxNativeResult } from '../src/pptx/shared.ts';
import { ffmpeg } from './fixtures.ts';
import { EDIT_PIN, login, startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

function has(tool: string, flag: string): boolean {
  try {
    execFileSync(tool, [flag], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
const tools = has('soffice', '--version') && has('pdftoppm', '-v') && has('ffmpeg', '-version');

const IN = 914_400;
const enc = new TextEncoder();
const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
/** A 4:3 slide (10 x 7.5 in): 1440 x 1080 logical px from x = 240. */
const SIZE_4X3 = { cx: 9_144_000, cy: 6_858_000 };
const S43 = 1080 / SIZE_4X3.cy;
const X43 = (1920 - SIZE_4X3.cx * S43) / 2;

let hub: TestHub;
let dir: string;
let photo: Uint8Array;
const pictures: Record<string, Uint8Array> = {};
/** The presentations saved here, read by the previous release's schema at the end. */
const saved: { name: string; p: Presentation }[] = [];

beforeAll(async () => {
  hub = await startHub();
  dir = tempDir('ordo-pptx-integrate-');
  const color = (name: string, c: string, size = '320x180') =>
    ffmpeg(dir, name, ['-f', 'lavfi', '-i', `color=c=${c}:s=${size}`, '-frames:v', '1']);
  photo = await readFile(color('photo.png', '0x3060A0'));
  for (const c of ['red', 'lime', 'blue', 'yellow'])
    pictures[c] = await readFile(color(`${c}.png`, c, '64x64'));
}, 60_000);
afterAll(async () => {
  await hub?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Import a deck through the native job; the job's result and the saved presentation. */
async function importDeck(
  parts: Map<string, Uint8Array>,
  name: string,
  options: { extendBackgrounds?: boolean } = {},
): Promise<{ result: PptxNativeResult; p: Presentation; hash: string; job: Job }> {
  const file = await zipDeck(parts, dir, `${newId()}.pptx`);
  const hash = await storeDeck(hub, file);
  const job = await waitJob(hub, hub.imports.pptx.queueNative(hash, name, options).id, 120_000);
  if (job.state !== 'done') throw new Error(`import failed: ${job.error}\n${job.log.join('\n')}`);
  const result = job.result as PptxNativeResult;
  return { result, p: hub.lib.presentations.must(result.presentationId), hash, job };
}

/** A notes slide whose body placeholder holds `text`, for slide `n` (1-based). */
function withNotes(parts: Map<string, Uint8Array>, n: number, text: string): void {
  parts.set(
    `ppt/notesSlides/notesSlide${n}.xml`,
    enc.encode(
      `<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>` +
        `<p:txBody><a:bodyPr/>${para(run(text))}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    ),
  );
}
const notesRel = (n: number) => ({
  id: 'rId8',
  type: 'notesSlide',
  target: `../notesSlides/notesSlide${n}.xml`,
});

const texts = (s: Slide) => s.objects.flatMap((o) => (o.type === 'text' ? [o.text] : []));
const textBox = (id: number, text: string, x = IN, y = IN) =>
  sp({ id, x, y, cx: 4 * IN, cy: IN, txBody: body(para(run(text))) });

/** Decoded RGBA pixels of a stored picture. */
function pixels(media: Media): { w: number; h: number; at(x: number, y: number): number[] } {
  const out = join(tempDir('ordo-px-'), 'p.rgba');
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', hub.store.abs(media.original.path), '-f', 'rawvideo'].concat([
      '-pix_fmt',
      'rgba',
      out,
    ]),
  );
  const b = readFileSync(out);
  // A 4K page is 32 MB of pixels: never left behind.
  rmSync(dirname(out), { recursive: true, force: true });
  const w = media.width!;
  const h = media.height!;
  return { w, h, at: (x, y) => [...b.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)] };
}

/** The pixel bounds of the opaque pixels `match` accepts (inclusive), or undefined. */
function bounds(
  px: ReturnType<typeof pixels>,
  match: (rgba: number[]) => boolean,
): { x0: number; y0: number; x1: number; y1: number } | undefined {
  let b: { x0: number; y0: number; x1: number; y1: number } | undefined;
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < px.w; x++) {
      const c = px.at(x, y);
      if (c[3]! < 200 || !match(c)) continue;
      if (!b) b = { x0: x, y0: y, x1: x, y1: y };
      else {
        b.x0 = Math.min(b.x0, x);
        b.y0 = Math.min(b.y0, y);
        b.x1 = Math.max(b.x1, x);
        b.y1 = Math.max(b.y1, y);
      }
    }
  return b;
}
const isRed = ([r, g, b]: number[]) => r! > 150 && g! < 60 && b! < 60;
const isGreen = ([r, g, b]: number[]) => g! > 200 && r! < 60 && b! < 60;
const isBlue = ([r, g, b]: number[]) => b! > 200 && r! < 60 && g! < 60;

/** A box in EMU on the 4:3 slide as logical px. */
const logical43 = (x: number, y: number, cx: number, cy: number) => ({
  x: X43 + x * S43,
  y: y * S43,
  w: cx * S43,
  h: cy * S43,
});

/** Edges of pixel bounds on a picture drawn over `box` (logical px), against an expected box. */
function edgeErrors(
  b: { x0: number; y0: number; x1: number; y1: number },
  px: { w: number; h: number },
  box: { x: number; y: number; w: number; h: number },
  want: { x: number; y: number; w: number; h: number },
): number[] {
  const kx = box.w / px.w;
  const ky = box.h / px.h;
  return [
    box.x + b.x0 * kx - want.x,
    box.y + b.y0 * ky - want.y,
    box.x + (b.x1 + 1) * kx - (want.x + want.w),
    box.y + (b.y1 + 1) * ky - (want.y + want.h),
  ].map(Math.abs);
}

/**
 * Hold the LibreOffice follow-ups as if their presentations were live-locked (ADR 0007): every one until
 * `release`, and those of `keep` for good.
 */
function holdFollowUps(): { release(keep?: string): void } {
  const deps = hub.imports.pptx.deps as { locked: PptxDeps['locked'] };
  const real = deps.locked;
  deps.locked = () => true;
  return {
    release(keep) {
      deps.locked = keep === undefined ? real : (id) => id === keep || real(id);
    },
  };
}

async function waitDeferred(id: string): Promise<void> {
  const t0 = Date.now();
  while (!hub.jobs.deferred().some((d) => d.id === id)) {
    if (Date.now() - t0 > 60_000) throw new Error(`job ${id} not deferred: ${hub.jobs.get(id).state}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!tools)('a chart over a photo background (design/27 §15 M3 exit)', () => {
  it('only that slide is hybrid; version 2 adds a transparent art in its place; an edit made in between survives', async () => {
    const chartSlide = {
      bg: pictureBg('rId2'),
      rels: [imageRel('rId2', 'photo.png'), { id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }],
      shapes:
        textBox(2, 'Giving', IN, 0) +
        chartFrame({ id: 4, x: 2 * IN, y: 1.5 * IN, cx: 8 * IN, cy: 4.5 * IN, rId: 'rId3' }) +
        sp({ id: 7, x: 11 * IN, y: 1.5 * IN, cx: IN, cy: IN, fill: solid('0000FF') }),
    };
    const photoSlide = (text: string) => ({
      bg: pictureBg('rId2'),
      rels: [imageRel('rId2', 'photo.png')],
      shapes: textBox(2, text),
    });
    const parts = withPart(
      buildDeck({
        slides: [photoSlide('Welcome'), chartSlide, photoSlide('Amazing grace')],
        media: { 'ppt/media/photo.png': photo },
      }),
      'ppt/charts/chart1.xml',
      chartXml([3, 5, 2], 'C00000'),
      CHART_CONTENT_TYPE,
    );
    const file = await zipDeck(parts, dir, 'giving.pptx');
    const ed = await login(hub.url, EDIT_PIN);
    const hold = holdFollowUps();
    let result: PptxNativeResult;
    try {
      // Through the route: editable slides are the default (item H).
      const fd = new FormData();
      fd.append('file', new Blob([readFileSync(file)]), 'Giving.pptx');
      const queued = await ed.json<Job>('/import/document', { method: 'POST', body: fd });
      expect(queued.kind).toBe('pptx-native');
      const job = await waitJob(hub, queued.id);
      expect(job.error).toBeUndefined();
      result = job.result as PptxNativeResult;
      expect(result).toMatchObject({ slides: 3, native: 2, hybrid: 1, picture: 0, pending: 1 });
      await waitDeferred(result.loJobId!);
    } finally {
      hold.release();
    }
    const v1 = hub.lib.presentations.must(result.presentationId);
    // The photo is every slide's background: the presentation's, so 'Replace on all slides' swaps it.
    expect(v1.backgroundMediaId).toBeDefined();
    const bg = hub.lib.media.must(v1.backgroundMediaId!);
    expect(bg).toMatchObject({ kind: 'image', state: 'ready', tags: ['pptx'] });
    const [a1, a2, a3] = slidesOf(v1) as [Slide, Slide, Slide];
    for (const s of [a1, a2, a3]) expect(s.backgroundMediaId).toBeUndefined();
    expect(a2.pptx).toMatchObject({ class: 'hybrid', pending: true });
    expect(a1.pptx!.class).toBe('native');
    expect(a3.pptx!.class).toBe('native');
    // Version 1 of the hybrid slide: its native objects; the chart waits for LibreOffice.
    expect(a2.objects.map((o) => o.type)).toEqual(['text', 'shape']);

    // An edit made while LibreOffice works.
    const edited = structuredClone(v1);
    const t3 = edited.sections[0]!.slides[2]!.objects.find((o) => o.type === 'text')!;
    if (t3.type === 'text') t3.text = 'Amazing grace, how sweet';
    await ed.json(`/presentations/${v1.id}`, { method: 'PUT', json: edited });

    hub.jobs.undefer(result.loJobId!);
    const lo = await waitJob(hub, result.loJobId!, 120_000);
    expect(lo.error).toBeUndefined();
    expect(lo.result).toMatchObject({ art: 1, edited: 0 });
    const v2 = hub.lib.presentations.must(v1.id);
    expect(v2.rev).toBe(v1.rev + 2); // the edit, then version 2
    const [b1, b2, b3] = slidesOf(v2) as [Slide, Slide, Slide];
    expect(texts(b3)).toEqual(['Amazing grace, how sweet']);
    expect(b1).toEqual(a1);
    expect(b2.pptx!.pending).toBeUndefined();
    expect(v2.backgroundMediaId).toBe(v1.backgroundMediaId);
    // The art in the chart's place: over the title, under the blue box.
    expect(b2.objects.map((o) => o.id)).toEqual([a2.objects[0]!.id, b2.objects[1]!.id, a2.objects[1]!.id]);
    const art = b2.objects[1] as ImageObject;
    expect(art).toMatchObject({ type: 'image', fit: 'stretch' });
    const media = hub.lib.media.must(art.mediaId);
    expect(media).toMatchObject({ kind: 'image', state: 'ready', hasAlpha: true });
    // Transparent around the bars: the photo background is not in it.
    const px = pixels(media);
    expect(px.at(2, 2)[3]).toBe(0);
    let red = 0;
    for (let y = 0; y < px.h; y += 5) for (let x = 0; x < px.w; x += 5) if (isRed(px.at(x, y))) red++;
    expect(red).toBeGreaterThan(50);
    expect(b2.pptx!.digest).toBe(digestOf(b2.objects));
    saved.push({ name: 'chart over photo', p: v2 });
  }, 180_000);

  it('converts a metafile the converter set aside and puts it back in its place in version 2', async () => {
    // A small EMF: a red rectangle in the middle of a 20 x 10 mm frame.
    const b = Buffer.alloc(168);
    let o = 0;
    const u32 = (v: number) => {
      b.writeUInt32LE(v >>> 0, o);
      o += 4;
    };
    const i32 = (v: number) => {
      b.writeInt32LE(v, o);
      o += 4;
    };
    u32(1);
    u32(88);
    for (const v of [16, 8, 48, 24]) i32(v);
    for (const v of [0, 0, 2000, 1000]) i32(v);
    u32(0x464d4520);
    u32(0x10000);
    u32(168);
    u32(5);
    b.writeUInt16LE(2, o);
    o += 4;
    u32(0);
    u32(0);
    u32(0);
    for (const v of [1024, 768, 320, 240]) i32(v);
    for (const v of [39, 24, 1, 0, 0x0000ff, 0]) u32(v);
    for (const v of [37, 12, 1]) u32(v);
    u32(43);
    u32(24);
    for (const v of [16, 8, 48, 24]) i32(v);
    for (const v of [14, 20, 0, 16, 20]) u32(v);
    const parts = buildDeck({
      slides: [
        {
          rels: [imageRel('rId2', 'chart.emf')],
          shapes:
            pic({ id: 3, x: IN, y: IN, cx: 4 * IN, cy: 2 * IN, rId: 'rId2' }) +
            sp({ id: 4, x: 0, y: 0, cx: 3 * IN, cy: IN, txBody: body(para(run('Results'))) }),
        },
      ],
      media: { 'ppt/media/chart.emf': b },
    });
    const { result, p } = await importDeck(parts, 'Results.pptx');
    expect(result).toMatchObject({ native: 1, pending: 1 });
    const [s] = slidesOf(p) as [Slide];
    // Version 1 leaves the metafile out: the background and the caption stay.
    expect(s.objects.map((x) => x.type)).toEqual(['shape', 'text']);
    expect(s.pptx).toMatchObject({ class: 'native', pending: true });
    const lo = await waitJob(hub, result.loJobId!, 120_000);
    expect(lo.result).toMatchObject({ metafiles: 1 });
    const after = slidesOf(hub.lib.presentations.must(p.id))[0]!;
    expect(after.pptx!.pending).toBeUndefined();
    // Back over the background and under the caption, at the picture's box.
    expect(after.objects.map((x) => x.type)).toEqual(['shape', 'image', 'text']);
    expect([after.objects[0]!.id, after.objects[2]!.id]).toEqual(s.objects.map((x) => x.id));
    const img = after.objects[1] as ImageObject;
    expect(img.box.x).toBeCloseTo(IN * (1920 / 12_192_000), 3);
    // Marked as the import's, like every object it wrote: hidden under a PowerPoint picture (design/27 §5).
    expect(after.objects.map((x) => x.origin?.src)).toEqual(['pptx', 'pptx', 'pptx']);
    const m = hub.lib.media.must(img.mediaId);
    expect(m).toMatchObject({ hasAlpha: true, state: 'ready' });
    const px = pixels(m);
    expect(isRed(px.at(Math.round(px.w / 2), Math.round(px.h / 2)))).toBe(true);
  }, 180_000);
});

describe.skipIf(!tools)('a 4:3 deck (design/27 §4, §15 M3 exit)', () => {
  it('keeps its bars empty on native, hybrid and crowded slides and aligns with LibreOffice within 2 px', async () => {
    const chartRel = (n: number) => ({ id: `rId${n}`, type: 'chart', target: `../charts/chart${n}.xml` });
    // Slide 3 holds more objects than a native slide may (150), each with text. It was a picture slide (a
    // LibreOffice page); since M9 the slide budgets keep it native (`decor-conv`: what passes them is left
    // out and listed) and the ladder fits it within 64 KB (`ladder`): no slide is a picture any more.
    let crowd = '';
    for (let i = 0; i < 160; i++)
      crowd += sp({
        id: 100 + i,
        x: (i % 20) * 0.4 * IN + 0.5 * IN,
        y: 6 * IN + Math.floor(i / 20) * 0.1 * IN,
        cx: 0.2 * IN,
        cy: 0.05 * IN,
        fill: solid('808080'),
        txBody: body(para(run('.', 'sz="100"'))),
      });
    const red = [IN, IN, 3 * IN, 2 * IN] as const;
    const green = [2 * IN, 3 * IN, 2 * IN, 2 * IN] as const;
    const blue = [5 * IN, 2 * IN, 2 * IN, 1.5 * IN] as const;
    const parts = buildDeck({
      size: SIZE_4X3,
      slides: [
        {
          bg: solidBg('FFFFFF'),
          shapes:
            sp({ id: 2, x: red[0], y: red[1], cx: red[2], cy: red[3], fill: solid('FF0000') }) +
            textBox(3, 'Native', 5 * IN, 5 * IN),
        },
        {
          bg: solidBg('FFFFFF'),
          rels: [chartRel(3), chartRel(4)],
          // The green box lies between two charts and under the second: it goes into the art.
          shapes:
            chartFrame({ id: 4, x: 5 * IN, y: 0.5 * IN, cx: 3 * IN, cy: 2.5 * IN, rId: 'rId3' }) +
            sp({ id: 5, x: green[0], y: green[1], cx: green[2], cy: green[3], fill: solid('00FF00') }) +
            chartFrame({ id: 6, x: 3.9 * IN, y: 4.9 * IN, cx: 3 * IN, cy: 2 * IN, rId: 'rId4' }),
        },
        {
          bg: solidBg('FFFFFF'),
          shapes:
            sp({ id: 2, x: blue[0], y: blue[1], cx: blue[2], cy: blue[3], fill: solid('0000FF') }) +
            textBox(3, 'Page three', IN, 4 * IN) +
            crowd,
        },
      ],
    });
    withPart(parts, 'ppt/charts/chart3.xml', chartXml([3, 5, 2], 'C00000'), CHART_CONTENT_TYPE);
    withPart(parts, 'ppt/charts/chart4.xml', chartXml([2, 4], 'C00000'), CHART_CONTENT_TYPE);
    const { result, p } = await importDeck(parts, 'Four by three.pptx', { extendBackgrounds: false });
    expect(result).toMatchObject({ native: 1, hybrid: 2, picture: 0, compact: 0, pending: 1 });
    const area = { x: 240, y: 0, w: 1440, h: 1080 };
    expect(p.source!.native!.slideRect).toEqual(area);
    const inArea = (o: SlideObject) =>
      o.box.x >= area.x - 0.5 &&
      o.box.y >= -0.5 &&
      o.box.x + o.box.w <= area.x + area.w + 0.5 &&
      o.box.y + o.box.h <= area.h + 0.5;
    const [n1, h2, p3] = slidesOf(p) as [Slide, Slide, Slide];
    // Version 1: the native slide within the slide area, its red box where the frame maps it.
    expect(n1.objects.every(inArea)).toBe(true);
    const redBox = n1.objects.find((o) => o.type === 'shape' && o.fill?.r === 255 && o.fill.g === 0)!.box;
    const want = logical43(...red);
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(redBox[k]).toBeCloseTo(want[k], 6);
    expect(h2.objects.every(inArea)).toBe(true);
    // The crowded slide: drawn natively within the slide area, what its budgets left out listed, never pending.
    expect(p3.objects.length).toBeGreaterThan(0);
    expect(p3.objects.every(inArea)).toBe(true);
    expect(p3.pptx).toMatchObject({ class: 'hybrid', missing: ['decoration'] });
    expect(p3.pptx!.pending).toBeUndefined();
    expect(p3.objects.some((o) => o.type === 'text' && o.text === 'Page three')).toBe(true);

    const lo = await waitJob(hub, result.loJobId!, 180_000);
    expect(lo.error).toBeUndefined();
    expect(lo.result).toMatchObject({ art: 1, pages: 0 });
    const v2 = hub.lib.presentations.must(p.id);
    const [, h2b] = slidesOf(v2) as [Slide, Slide, Slide];
    // Hybrid: the art inside the slide area, and the green box in it where PowerPoint puts it.
    expect(h2b.objects.every(inArea)).toBe(true);
    const art = h2b.objects.find((o): o is ImageObject => o.type === 'image')!;
    const artPx = pixels(hub.lib.media.must(art.mediaId));
    const g = bounds(artPx, isGreen);
    expect(g).toBeDefined();
    const gErr = edgeErrors(g!, artPx, art.box, logical43(...green));
    expect(Math.max(...gErr)).toBeLessThanOrEqual(2);

    // LibreOffice's picture of the native slide ('Show original': nothing switched) puts the red box where
    // ordo draws it.
    const ed = await login(hub.url, EDIT_PIN);
    const ref = await ed.json<Job>(`/presentations/${p.id}/pptx-reference`, {
      method: 'POST',
      json: { showPicture: [] },
    });
    const refDone = await waitJob(hub, ref.id, 180_000);
    expect(refDone.error).toBeUndefined();
    const v3 = slidesOf(hub.lib.presentations.must(p.id));
    expect(v3.map((s) => s.pptx!.show)).toEqual([undefined, undefined, undefined]);
    const refPx = pixels(hub.lib.media.must(v3[0]!.pptx!.refMediaId!));
    const rErr = edgeErrors(bounds(refPx, isRed)!, refPx, area, redBox);
    expect(Math.max(...rErr)).toBeLessThanOrEqual(2);
    // LibreOffice's picture of the crowded slide (what its page was): at the slide's aspect (contain-fit leaves
    // the bars empty), the blue box where PowerPoint puts it.
    const crowded = hub.lib.media.must(v3[2]!.pptx!.refMediaId!);
    expect([crowded.width, crowded.height]).toEqual([2880, 2160]);
    const crowdedPx = pixels(crowded);
    const bErr = edgeErrors(bounds(crowdedPx, isBlue)!, crowdedPx, area, logical43(...blue));
    expect(Math.max(...bErr)).toBeLessThanOrEqual(2);
    const fmt = (e: number[]) => e.map((v) => v.toFixed(2)).join('/');
    console.info(
      `4:3 edge errors (left/top/right/bottom, logical px): native ${fmt(rErr)}, art ${fmt(gErr)}, crowded ${fmt(bErr)}`,
    );
    saved.push({ name: '4:3', p: hub.lib.presentations.must(p.id) });
  }, 300_000);
});

describe('a deck with a hidden slide (design/27 §4, §15 M3 exit)', () => {
  it('keeps notes, pictures and text with their own slide; Next skips it live, a click shows it', async () => {
    const colours = ['red', 'lime', 'blue', 'yellow'] as const;
    const parts = buildDeck({
      slides: colours.map((c, i) => ({
        ...(i === 1 ? { hidden: true } : {}),
        rels: [imageRel('rId2', `${c}.png`), notesRel(i + 1)],
        shapes:
          pic({ id: 2, x: IN, y: IN, cx: 2 * IN, cy: 2 * IN, rId: 'rId2' }) + textBox(3, `Text ${c}`, 4 * IN),
      })),
      media: Object.fromEntries(colours.map((c) => [`ppt/media/${c}.png`, pictures[c]!])),
    });
    for (const [i, c] of colours.entries()) withNotes(parts, i + 1, `Notes ${c}`);
    const { result, p } = await importDeck(parts, 'Hidden.pptx');
    expect(result).toMatchObject({ slides: 4, native: 4 });
    const slides = slidesOf(p);
    const probe: Record<string, (rgba: number[]) => boolean> = {
      red: isRed,
      lime: isGreen,
      blue: isBlue,
      yellow: ([r, g, b]) => r! > 200 && g! > 200 && b! < 60,
    };
    slides.forEach((s, i) => {
      const c = colours[i]!;
      expect(s.hidden ?? false).toBe(i === 1);
      expect(s.pptx).toMatchObject({ index: i, ...(i === 1 ? {} : { shown: i < 1 ? i : i - 1 }) });
      expect(s.notes).toBe(`Notes ${c}`);
      expect(texts(s)).toEqual([`Text ${c}`]);
      expect(s.objects.find((o) => o.id === s.lyricObjectId)).toMatchObject({ text: `Text ${c}` });
      const img = s.objects.find((o): o is ImageObject => o.type === 'image')!;
      const px = pixels(hub.lib.media.must(img.mediaId));
      expect(probe[c]!(px.at(8, 8))).toBe(true);
    });
    saved.push({ name: 'hidden slide', p });

    // Live (design/27 §9): Next skips the hidden slide, a click (a GO with its index) shows it.
    const pl = hub.lib.playlists.insert({
      id: newId(),
      rev: 1,
      name: 'Hidden',
      items: [{ id: newId(), kind: 'presentation', presentationId: p.id }],
    });
    const live = hub.live;
    const shows = () => live.state.layers.slide.content?.slideId;
    try {
      live.submit({ k: 'goLive', playlistId: pl.id }, { role: 'operate' });
      expect(live.state.cues.map((c) => c.hidden ?? false)).toEqual([false, true, false, false]);
      expect(live.state.armed).toBe(0);
      live.submit({ k: 'next', at: Date.now() }, { role: 'operate' });
      expect([shows(), live.state.armed]).toEqual([slides[0]!.id, 2]);
      live.submit({ k: 'next', at: Date.now() }, { role: 'operate' });
      expect(shows()).toBe(slides[2]!.id);
      live.submit({ k: 'prev', at: Date.now() }, { role: 'operate' });
      expect(shows()).toBe(slides[0]!.id);
      live.submit({ k: 'go', cueIndex: 1, at: Date.now() }, { role: 'operate' });
      expect(shows()).toBe(slides[1]!.id);
      expect(live.state.armed).toBe(2);
    } finally {
      live.submit({ k: 'endService', at: Date.now() }, { role: 'operate' });
    }

    // 'Show PowerPoint picture' draws the hidden slide too (a click shows it): its own picture, its colour.
    const ed = await login(hub.url, EDIT_PIN);
    const ref = await ed.json<Job>(`/presentations/${p.id}/pptx-reference`, { method: 'POST' });
    const refDone = await waitJob(hub, ref.id, 180_000);
    expect(refDone.error).toBeUndefined();
    expect(refDone.result).toMatchObject({ pictures: 4, slides: 4 });
    const withRefs = slidesOf(hub.lib.presentations.must(p.id));
    withRefs.forEach((s, i) => {
      expect(s.pptx).toMatchObject({ show: 'picture', refMediaId: expect.any(String) });
      // The picture's centre: 2 in from the left of 13.33 in, 2 in from the top of 7.5 in.
      const px = pixels(hub.lib.media.must(s.pptx!.refMediaId!));
      expect(probe[colours[i]!]!(px.at(Math.round(px.w * 0.15), Math.round(px.h * 0.267)))).toBe(true);
    });
    expect(hub.lib.media.must(withRefs[1]!.pptx!.refMediaId!).name).toBe(
      'Hidden – hidden slide 2 (PowerPoint)',
    );
  }, 240_000);
});

describe('the size budgets through the job (design/27 §3.4, §14.10)', () => {
  /**
   * Import a 2,000-slide deck. Since M9's budget ladder the tail is never a picture: its slides are stored
   * minimal (their text, pictures and background), so nothing waits for LibreOffice.
   */
  async function importLong(slide: (i: number) => string, name: string) {
    const slides = Array.from({ length: 2000 }, (_, i) => ({ shapes: slide(i) }));
    const t0 = performance.now();
    const { result, p } = await importDeck(buildDeck({ slides }), name);
    const all = slidesOf(p);
    let largest = 0;
    for (const s of all) largest = Math.max(largest, jsonBytes(previewSlice(p, s.id)));
    const first = all.findIndex((s) => s.pptx!.notes?.some((n) => /reached its size budget/.test(n)));
    console.info(
      `${name}: ${Math.round(performance.now() - t0)} ms, ${presentationBytes(p)} bytes, ${result.simplified} simplified from slide ${first + 1}, largest preview ${largest} bytes`,
    );
    expect(result.slides).toBe(2000);
    expect(result).toMatchObject({ picture: 0, compact: 0, pending: 0 });
    expect(result.loJobId).toBeUndefined();
    expect(presentationBytes(p)).toBeLessThanOrEqual(SIZE_BUDGETS.presentationMax);
    expect(largest).toBeLessThan(SIZE_BUDGETS.previewMax);
    // Only the tail is minimal: no shape, every text box still there.
    for (const s of all.slice(first)) {
      expect(s.objects.some((o) => o.type === 'shape')).toBe(false);
      expect(s.objects.filter((o) => o.type === 'text').length).toBeGreaterThan(0);
    }
    return { result, p, first };
  }

  it('keeps a 2,000-slide sermon-like deck within 4 MiB: the tail minimal, the preview of any slide under 1 MiB', async () => {
    const verse =
      'For God so loved the world, that he gave his only begotten Son, that whosoever believeth. ';
    const { result, p, first } = await importLong(
      (i) =>
        textBox(2, `Point ${i + 1}`, IN, 0) +
        textBox(3, `${i + 1} ${verse.repeat(4)}`) +
        [0, 1, 2, 3]
          .map((k) => sp({ id: 10 + k, x: k * IN, y: 6 * IN, cx: IN, cy: 0.2 * IN, fill: solid('336699') }))
          .join(''),
      'Sermon series.pptx',
    );
    expect(result.simplified).toBe(2000 - first);
    // A minimal slide keeps its text as objects, so it is larger than the compact picture slide of before M9
    // (whose tail began past slide 500): the all-minimal deck is near 4 MiB, and the tail starts earlier.
    expect(first).toBeGreaterThan(250);
    // Every lyric stays editable: the last slide's text is whole.
    const last = slidesOf(p).at(-1)!;
    expect(last.objects.flatMap((o) => (o.type === 'text' ? [o.text] : []))).toEqual([
      'Point 2000',
      `2000 ${verse.repeat(4)}`,
    ]);
    expect(last.pptx).toMatchObject({ class: 'hybrid', missing: ['decoration'] });
  }, 300_000);

  it('keeps even a deck too large when minimal within 4 MiB: the text of its tail is cut', async () => {
    const line = 'Holy, holy, holy, Lord God almighty, early in the morning our song shall rise to thee. ';
    const { result, p, first } = await importLong(
      (i) => textBox(2, `Slide ${i + 1}`, IN, 0) + textBox(3, `${i + 1} ${line.repeat(30)}`),
      'Hymnal.pptx',
    );
    expect(first).toBe(0);
    expect(result.simplified).toBe(2000);
    expect(result.notes.join('\n')).toMatch(/cut to 200 characters/);
    const s6 = slidesOf(p)[5]!.objects.flatMap((o) => (o.type === 'text' ? [o.text] : []));
    expect(s6[0]).toBe('Slide 6');
    expect(s6[1]).toMatch(/^6 Holy/);
    expect(s6[1]!.length).toBe(200);
  }, 300_000);
});

/** A 2D context that records the drawing calls (no DOM in the test). */
function recordingCtx(): { ctx: CanvasRenderingContext2D; ops: string[] } {
  const ops: string[] = [];
  const state: Record<string, unknown> = { canvas: { width: 1920, height: 1080 } };
  const ctx = new Proxy(state, {
    get(t, k) {
      if (typeof k !== 'string') return undefined;
      if (k in t) return t[k];
      if (k === 'measureText')
        return (s: string) => ({
          width: s.length * 10,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
          fontBoundingBoxAscent: 8,
          fontBoundingBoxDescent: 2,
        });
      if (k.startsWith('create')) return () => ({ addColorStop() {} });
      if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return (..._a: unknown[]) => {
        ops.push(k);
      };
    },
    set(t, k, v) {
      if (typeof k === 'string') t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

describe('the rolled-back schema (design/27 §3.2, §14.7)', () => {
  it('the previous release (0.5.0) reads every imported presentation, M9 stripped, and its slides still draw', () => {
    expect(saved.map((s) => s.name)).toEqual(
      tools ? ['chart over photo', '4:3', 'hidden slide'] : ['hidden slide'],
    );
    const img = { width: 64, height: 64 } as unknown as CanvasImageSource;
    for (const { name, p } of saved) {
      const r = prev.Presentation.safeParse(p);
      expect(r.success, name).toBe(true);
      const old = r.data!;
      // Not quarantined: the source stays a PowerPoint import with its native record (0.5.0 has M3's).
      expect(old.source).toEqual(p.source);
      const before = slidesOf(p);
      old.sections
        .flatMap((s) => s.slides)
        .forEach((s, i) => {
          // 0.5.0 keeps the provenance, hidden and transition; M9's missing list and object fields go.
          expect(s.pptx ?? {}, `${name} ${i}`).not.toHaveProperty('missing');
          for (const o of s.objects)
            for (const k of [
              'table',
              'chart',
              'decor',
              'look3d',
              'warp',
              'writing',
              'centerBlock',
              'vectorFonts',
            ])
              expect(o, `${name} ${i}`).not.toHaveProperty(k);
          // Every object survives (legacy values only), and the slide still draws.
          expect(s.objects.map((o) => o.id)).toEqual(before[i]!.objects.map((o) => o.id));
          const { ctx, ops } = recordingCtx();
          drawSlide2D(ctx, s as Slide, { scale: 1, look: LOOK_MAIN, images: () => img });
          const drawn = ops.filter(
            (o) => o === 'fill' || o === 'fillRect' || o === 'drawImage' || o === 'fillText',
          );
          expect(drawn.length, `${name} slide ${i + 1}`).toBeGreaterThan(0);
        });
      // What an older build saves back is still valid now.
      expect(Presentation.safeParse(old).success).toBe(true);
    }
  });
});
