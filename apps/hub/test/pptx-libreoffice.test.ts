/**
 * M3 item D through LibreOffice (design/27 §5, §15 M3 "a deck with a chart over a photo background"): the
 * `pptx-lo` follow-up on a crafted deck, the deferral while the presentation is live and 'Show PowerPoint
 * picture'. Needs soffice, pdftoppm and ffmpeg on the PATH (CI installs them); skipped without soffice.
 *
 * Version 1 is built here the way the native job saves it (item B), and pictures are stored through a
 * stand-in for item C's `addReadyPicture`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ImageObject, type Media, newId, type Playlist, Presentation, type Slide } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { convertDeck } from '@ordo/pptx-scene';
import { digestOf } from '@ordo/pptx-scene/emit.ts';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  chartFrame,
  chartXml,
  imageRel,
  PNG_1X1,
  para,
  pic,
  pictureBg,
  run,
  solid,
  sp,
  withPart,
} from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PPTX_MIME } from '../src/imports.ts';
import { PPTX_JOBS, type PptxDeps, type PptxLoSlide } from '../src/pptx/shared.ts';
import { EDIT_PIN, login, OPERATE_PIN, startHub, type TestHub, tempDir } from './helpers.ts';

// Item C's `addReadyPicture` is a stub on this branch: store the picture as a ready image.
vi.mock('../src/pptx/pictures.ts', async (load) => {
  const real = await load<typeof import('../src/pptx/pictures.ts')>();
  return {
    ...real,
    addReadyPicture: async (
      deps: PptxDeps,
      p: { path: string; ext: string; mime: string; width: number; height: number; hasAlpha: boolean },
      o: { name: string; tags: string[] },
    ): Promise<Media> => {
      const original = await deps.store.put(p.path, { ext: p.ext, mime: p.mime });
      const m = deps.lib.media.insert({
        id: newId(),
        rev: 1,
        name: o.name,
        tags: o.tags,
        kind: 'image',
        original,
        state: 'ready',
        width: p.width,
        height: p.height,
        hasAlpha: p.hasAlpha,
        loop: false,
        isBackground: false,
      });
      deps.lib.emit([{ kind: 'media', id: m.id, rev: m.rev, entity: m }]);
      return m;
    },
  };
});

function has(tool: string, flag: string): boolean {
  try {
    execFileSync(tool, [flag], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
const tools = has('soffice', '--version') && has('pdftoppm', '-v') && has('ffmpeg', '-version');

/** A small EMF: a red rectangle in the middle of an otherwise empty 20 x 10 mm frame. */
function emf(): Uint8Array {
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
  // EMR_HEADER: bounds (device px), frame (0.01 mm), signature, version, size, records, handles.
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
  // EMR_CREATEBRUSHINDIRECT (solid red), EMR_SELECTOBJECT, EMR_RECTANGLE, EMR_EOF.
  for (const v of [39, 24, 1, 0, 0x0000ff, 0]) u32(v);
  for (const v of [37, 12, 1]) u32(v);
  u32(43);
  u32(24);
  for (const v of [16, 8, 48, 24]) i32(v);
  for (const v of [14, 20, 0, 16, 20]) u32(v);
  return b;
}

const IN = 914_400 / 2; // half an inch: 72 logical px on a 16:9 slide

/** A PNG photo (a gradient), written without any image library. */
function photo(w: number, h: number): Uint8Array {
  const dir = tempDir('ordo-photo-');
  const raw = join(dir, 'p.rgb');
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) buf.set([(x * 255) / w, (y * 255) / h, 160], (y * w + x) * 3);
  writeFileSync(raw, buf);
  const out = join(dir, 'p.png');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-s',
    `${w}x${h}`,
    '-i',
    raw,
    out,
  ]);
  return readFileSync(out);
}

/** The RGBA pixels of a stored picture (decoded by ffmpeg). */
function pixels(hub: TestHub, media: Media): { w: number; h: number; at(x: number, y: number): number[] } {
  const out = join(tempDir('ordo-px-'), 'p.rgba');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    hub.store.abs(media.original.path),
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    out,
  ]);
  const b = readFileSync(out);
  const w = media.width!;
  const h = media.height!;
  return { w, h, at: (x, y) => [...b.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)] };
}

/**
 * The crafted deck: 0 a title over the photo; 1 hidden, a green box and a caption; 2 and 3 a chart over the
 * photo with a title below the art range and a blue box clear of the chart above it.
 */
function deck(): Map<string, Uint8Array> {
  const chartSlide = {
    bg: pictureBg('rId2'),
    rels: [imageRel('rId2', 'photo.png'), { id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }],
    shapes:
      sp({
        id: 2,
        x: IN,
        y: 0,
        cx: 20 * IN,
        cy: 2 * IN,
        txBody: body(para(run('Giving', 'sz="4000"', solid('FFFFFF')))),
      }) +
      chartFrame({ id: 4, x: 2 * IN, y: 2 * IN, cx: 16 * IN, cy: 12 * IN, rId: 'rId3' }) +
      sp({ id: 7, x: 22 * IN, y: 2 * IN, cx: 2 * IN, cy: 2 * IN, fill: solid('0000FF') }),
  };
  const parts = buildDeck({
    slides: [
      {
        bg: pictureBg('rId2'),
        rels: [imageRel('rId2', 'photo.png')],
        shapes: sp({ id: 2, x: IN, y: IN, cx: 10 * IN, cy: 2 * IN, txBody: body(para(run('Welcome'))) }),
      },
      {
        hidden: true,
        shapes:
          sp({ id: 2, x: 0, y: 0, cx: 4 * IN, cy: 4 * IN, fill: solid('00FF00') }) +
          sp({
            id: 3,
            x: 6 * IN,
            y: 6 * IN,
            cx: 10 * IN,
            cy: 2 * IN,
            txBody: body(para(run('Hidden notes'))),
          }),
      },
      chartSlide,
      chartSlide,
    ],
    media: { 'ppt/media/photo.png': photo(320, 180) },
  });
  return withPart(parts, 'ppt/charts/chart1.xml', chartXml([3, 5, 2], 'C00000'), CHART_CONTENT_TYPE);
}

/** Store the deck and save version 1 as the native job would; returns it with the follow-up's slides. */
async function version1(hub: TestHub, parts: Map<string, Uint8Array>, classes: Record<number, 'picture'>) {
  const zip = new JSZip();
  for (const [k, v] of parts) zip.file(k, v);
  const file = join(tempDir('ordo-deck-'), 'deck.pptx');
  writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const ref = await hub.store.put(file, { ext: 'pptx', mime: PPTX_MIME });
  const photoFile = join(tempDir('ordo-photo-'), 'photo.png');
  writeFileSync(photoFile, parts.get('ppt/media/photo.png') ?? PNG_1X1);
  const photoRef = await hub.store.put(photoFile, { ext: 'png', mime: 'image/png' });
  const photoMedia = hub.lib.media.insert({
    id: newId(),
    rev: 1,
    name: 'photo',
    tags: ['pptx'],
    kind: 'image',
    original: photoRef,
    state: 'ready',
    width: 320,
    height: 180,
    hasAlpha: false,
    loop: false,
    isBackground: false,
  });
  const out = convertDeck(parts, { mediaId: () => photoMedia.id, newId });
  const lo: PptxLoSlide[] = [];
  const slides: Slide[] = out.slides.map((e) => {
    const cls = classes[e.index] ?? e.classification.class;
    const slide: Slide = {
      ...e.slide,
      ...(cls === 'picture' ? { objects: [] } : {}),
      ...(e.hidden ? { hidden: true } : {}),
      pptx: {
        fileId: ref.hash,
        index: e.index,
        ...(e.shown !== undefined ? { shown: e.shown } : {}),
        class: cls,
        version: 1,
        ...(cls !== 'native' || e.metafiles?.length ? { pending: true } : {}),
      },
    };
    return slide;
  });
  const sid = newId();
  const p = Presentation.parse({
    id: newId(),
    rev: 1,
    title: 'Giving',
    kind: 'slides',
    meta: { tags: [] },
    sections: [{ id: sid, label: 'Slides', short: 'S', slides }],
    arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
    source: { kind: 'pptx', fileId: ref.hash },
    archived: false,
  });
  for (const sl of p.sections[0]!.slides) {
    sl.pptx!.digest = digestOf(sl.objects);
    const e = out.slides.find((x) => x.index === sl.pptx!.index)!;
    if (sl.pptx!.pending)
      lo.push({
        slideId: sl.id,
        index: e.index,
        ...(e.shown !== undefined ? { shown: e.shown } : {}),
        class: sl.pptx!.class,
        ...(e.art && sl.pptx!.class === 'hybrid' ? { art: e.art } : {}),
        ...(e.metafiles?.length && sl.pptx!.class !== 'picture' ? { metafileObjects: e.metafiles } : {}),
        digest: sl.pptx!.digest,
      });
  }
  const saved = hub.lib.savePresentation(p, { create: true, by: 'pptx-import' });
  return { saved, lo, hash: ref.hash, photo: photoMedia };
}

const slidesOf = (p: Presentation) => p.sections.flatMap((s) => s.slides);

describe.skipIf(!tools)('pptx-lo through LibreOffice', () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  });
  afterAll(() => hub.cleanup());

  it('adds a transparent chart art over the native photo background; an edit made in between survives', async () => {
    const { saved, lo, hash, photo } = await version1(hub, deck(), { 1: 'picture' });
    expect(lo.map((s) => [s.index, s.class])).toEqual([
      [1, 'picture'],
      [2, 'hybrid'],
      [3, 'hybrid'],
    ]);
    // Someone edits slide 4 before LibreOffice has run.
    const edited = structuredClone(saved);
    const mine = { ...(slidesOf(saved)[3]!.objects[0] as object), id: newId() } as Slide['objects'][number];
    edited.sections[0]!.slides[3]!.objects.push(mine);
    const v1b = hub.lib.savePresentation(edited, { expectedRev: saved.rev, by: 'editor' });
    const before = slidesOf(v1b);

    const job = hub.jobs.enqueue(
      PPTX_JOBS.lo,
      { presentationId: saved.id, hash, version: 1, slides: lo },
      'heavy',
    );
    await hub.jobs.idle();
    const done = hub.jobs.get(job.id);
    expect(done.error).toBeUndefined();
    expect(done.state).toBe('done');
    expect(done.result).toMatchObject({ art: 2, pages: 1, edited: 1 });

    const v2 = hub.lib.presentations.must(saved.id);
    expect(v2.rev).toBe(v1b.rev + 1); // one revision
    const after = slidesOf(v2);
    for (const sl of after) expect(sl.pptx?.pending).toBeUndefined();

    // Slide 3: the title below, the art in the chart's place, the blue box above; the photo stays native.
    const s3 = after[2]!;
    expect(s3.backgroundMediaId).toBe(photo.id);
    const ids = before[2]!.objects.map((o) => o.id);
    expect(s3.objects.map((o) => o.id)).toEqual([ids[0], s3.objects[1]!.id, ids[1]]);
    const art = s3.objects[1] as ImageObject;
    expect(art).toMatchObject({ type: 'image', fit: 'stretch' });
    // Inside the chart's frame (144..1296 x 144..1008 logical px, with the cut margin).
    expect(art.box.x).toBeGreaterThanOrEqual(144 - 24);
    expect(art.box.x + art.box.w).toBeLessThanOrEqual(1296 + 24);
    expect(art.box.y).toBeGreaterThanOrEqual(144 - 24);
    expect(art.box.y + art.box.h).toBeLessThanOrEqual(1008 + 24);
    const media = hub.lib.media.must(art.mediaId);
    expect(media).toMatchObject({ kind: 'image', state: 'ready', hasAlpha: true, tags: ['pptx'] });
    expect(Math.abs(media.width! / art.box.w - 2)).toBeLessThan(0.01); // 2 page px per logical px
    // Transparent between the bars, opaque red on them (the plot area has no fill).
    const px = pixels(hub, media);
    let clear = 0;
    let red = 0;
    for (let y = 0; y < px.h; y += 7)
      for (let x = 0; x < px.w; x += 7) {
        const [r, g, b, a] = px.at(x, y);
        if (a === 0) clear++;
        else if (a === 255 && r! > 170 && g! < 40 && b! < 40) red++;
      }
    expect(clear).toBeGreaterThan(50);
    expect(red).toBeGreaterThan(50);
    // Nothing of the forced backgrounds (white, yellow) survives.
    for (let y = 0; y < px.h; y += 13)
      for (let x = 0; x < px.w; x += 13) {
        const [r, g, , a] = px.at(x, y);
        if (a! > 0) expect(r! > 250 && g! > 250).toBe(false);
      }

    // Slide 4 was edited: every object kept, the art on top, a note.
    const s4 = after[3]!;
    expect(s4.objects.slice(0, -1).map((o) => o.id)).toEqual(before[3]!.objects.map((o) => o.id));
    expect(s4.objects.at(-1)).toMatchObject({ type: 'image', fit: 'stretch' });
    expect(s4.pptx!.notes).toContain('edited since the import: the PowerPoint art was added on top');

    // Slide 2 is hidden and picture class: its own page (not the next shown slide's), with its text.
    const s2 = after[1]!;
    expect(s2.hidden).toBe(true);
    expect(s2.imported).toMatchObject({ fileId: hash, page: 2, textAligned: true });
    expect(s2.imported!.textBoxes!.map((t) => t.text)).toEqual(['Hidden notes']);
    const page = hub.lib.media.must(s2.imported!.imageMediaId);
    expect([page.width, page.height, page.hasAlpha]).toEqual([3840, 2160, false]);
    const pp = pixels(hub, page);
    expect(pp.at(100, 100).slice(0, 3)).toEqual([0, 255, 0]);
    expect(pp.at(3000, 1800).slice(0, 3)).toEqual([255, 255, 255]);

    // A re-run (a restart after the save) stores nothing twice and changes nothing.
    const count = hub.lib.media.list().length;
    const again = hub.jobs.enqueue(
      PPTX_JOBS.lo,
      { presentationId: saved.id, hash, version: 1, slides: lo },
      'heavy',
    );
    await hub.jobs.idle();
    expect(hub.jobs.get(again.id).state).toBe('done');
    expect(hub.lib.media.list().length).toBe(count);
    expect(hub.lib.presentations.must(saved.id).rev).toBe(v2.rev);
  }, 120_000);

  it('waits while the presentation is live, then patches it; Show PowerPoint picture is refused meanwhile', async () => {
    const parts = deck();
    const { saved, lo, hash } = await version1(hub, parts, {});
    const op = await login(hub.url, OPERATE_PIN);
    const ed = await login(hub.url, EDIT_PIN);
    const pl = await ed.json<Playlist>('/playlists', {
      method: 'POST',
      json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: saved.id }] },
    });
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    expect((await ed.fetch(`/presentations/${saved.id}/pptx-reference`, { method: 'POST' })).status).toBe(
      423,
    );

    const job = hub.jobs.enqueue(
      PPTX_JOBS.lo,
      { presentationId: saved.id, hash, version: 1, slides: lo },
      'heavy',
    );
    await hub.jobs.idle();
    const waiting = hub.jobs.get(job.id);
    expect(waiting.state).toBe('queued');
    expect(waiting.log.at(-1)).toMatch(
      /waiting: the presentation is live; LibreOffice will try again in 30 s/,
    );
    expect(hub.jobs.deferred().map((d) => d.id)).toContain(job.id);
    expect(hub.lib.presentations.must(saved.id).rev).toBe(saved.rev);

    await op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });
    hub.jobs.undefer(job.id);
    await new Promise((r) => setTimeout(r, 20));
    await hub.jobs.idle();
    expect(hub.jobs.get(job.id)).toMatchObject({ state: 'done' });
    const v2 = hub.lib.presentations.must(saved.id);
    expect(v2.rev).toBe(saved.rev + 1);
    expect(slidesOf(v2)[2]!.objects.some((o) => o.type === 'image' && o.fit === 'stretch')).toBe(true);

    // 'Show PowerPoint picture': every shown slide once, shown as the picture.
    const res = await ed.fetch(`/presentations/${saved.id}/pptx-reference`, { method: 'POST' });
    expect(res.status).toBe(202);
    const ref = (await res.json()) as Job;
    await hub.jobs.idle();
    expect(hub.jobs.get(ref.id)).toMatchObject({ state: 'done', result: { slides: 3 } });
    const v3 = slidesOf(hub.lib.presentations.must(saved.id));
    expect(v3.map((s) => s.pptx?.show)).toEqual(['picture', undefined, 'picture', 'picture']);
    expect(v3[1]!.pptx?.refMediaId).toBeUndefined(); // hidden
    const pic = hub.lib.media.must(v3[0]!.pptx!.refMediaId!);
    expect([pic.width, pic.height]).toEqual([3840, 2160]);
    expect(v3[2]!.pptx!.refMediaId).not.toBe(v3[3]!.pptx!.refMediaId);
  }, 120_000);

  it('converts a metafile picture to a transparent PNG and puts it back in its place', async () => {
    const parts = buildDeck({
      slides: [
        {
          rels: [imageRel('rId2', 'chart.emf')],
          shapes:
            pic({ id: 3, x: 2 * IN, y: 2 * IN, cx: 8 * IN, cy: 4 * IN, rId: 'rId2' }) +
            sp({ id: 4, x: 0, y: 0, cx: 6 * IN, cy: 2 * IN, txBody: body(para(run('Results'))) }),
        },
      ],
      media: { 'ppt/media/chart.emf': emf() },
    });
    const { saved, hash, lo } = await version1(hub, parts, {});
    // Version 1 leaves the metafile out; the converter set its object aside, under the caption.
    const sl = slidesOf(saved)[0]!;
    expect(sl.objects.map((o) => o.type)).toEqual(['shape', 'text']);
    expect(lo).toHaveLength(1);
    const meta = lo[0]!.metafileObjects![0]!;
    expect(meta).toMatchObject({
      part: 'ppt/media/chart.emf',
      before: sl.objects[1]!.id,
      object: { type: 'image' },
    });
    const v1 = saved;
    const job = hub.jobs.enqueue(
      PPTX_JOBS.lo,
      { presentationId: v1.id, hash, version: 1, slides: lo },
      'heavy',
    );
    await hub.jobs.idle();
    expect(hub.jobs.get(job.id)).toMatchObject({ state: 'done', result: { metafiles: 1 } });
    const after = slidesOf(hub.lib.presentations.must(v1.id))[0]!;
    expect(after.pptx!.pending).toBeUndefined();
    const back = after.objects[1] as ImageObject;
    expect(back).toMatchObject({ type: 'image', box: meta.object.box, fit: 'stretch' });
    expect(after.objects[2]!.id).toBe(sl.objects[1]!.id);
    const media = hub.lib.media.must(back.mediaId);
    expect(media).toMatchObject({ hasAlpha: true });
    expect(media.width! / media.height!).toBeCloseTo(2, 1); // the metafile's own aspect
    const px = pixels(hub, media);
    expect(px.at(2, 2)[3]).toBe(0);
    const [r, g, b, a] = px.at(Math.round(px.w / 2), Math.round(px.h / 2));
    expect([a, r! > 200, g! < 40, b! < 40]).toEqual([255, true, true, true]);
  }, 120_000);

  it('keeps text of automatic colour dark in the art (LibreOffice turns it white on dark pages)', async () => {
    // Vertical text (residual until M8) with no colour anywhere: LibreOffice's automatic colour.
    const parts = buildDeck({
      slides: [
        {
          shapes: sp({
            id: 2,
            x: 2 * IN,
            y: 2 * IN,
            cx: 4 * IN,
            cy: 10 * IN,
            txBody: body(para(run('Sermon notes', 'sz="6000"')), 'vert="vert"'),
          }),
        },
      ],
    });
    const { saved, lo, hash } = await version1(hub, parts, {});
    expect(lo.map((s) => s.class)).toEqual(['hybrid']);
    const job = hub.jobs.enqueue(
      PPTX_JOBS.lo,
      { presentationId: saved.id, hash, version: 1, slides: lo },
      'heavy',
    );
    await hub.jobs.idle();
    expect(hub.jobs.get(job.id)).toMatchObject({ state: 'done', result: { art: 1 } });
    const art = slidesOf(hub.lib.presentations.must(saved.id))[0]!.objects.find(
      (o): o is ImageObject => o.type === 'image',
    )!;
    const px = pixels(hub, hub.lib.media.must(art.mediaId));
    let dark = 0;
    let light = 0;
    for (let y = 0; y < px.h; y += 2)
      for (let x = 0; x < px.w; x += 2) {
        const [r, g, b, a] = px.at(x, y);
        if (a! < 250) continue;
        if (r! + g! + b! < 150) dark++;
        if (r! + g! + b! > 600) light++;
      }
    expect(dark).toBeGreaterThan(100);
    expect(light).toBe(0);
  }, 120_000);

  it("prints the 'Pictures (LibreOffice)' import from the render copy", async () => {
    const zip = new JSZip();
    for (const [k, v] of deck()) zip.file(k, v);
    const ed = await login(hub.url, EDIT_PIN);
    const fd = new FormData();
    fd.append('file', new Blob([await zip.generateAsync({ type: 'arraybuffer' })]), 'Giving.pptx');
    const job = await ed.json<Job>('/import/document', { method: 'POST', body: fd });
    await hub.jobs.idle();
    const done = hub.jobs.get(job.id);
    expect(done.error).toBeUndefined();
    expect(done.state).toBe('done');
    // The three shown slides; the hidden one is not printed.
    expect(done.result).toMatchObject({ pages: 3 });
  }, 120_000);
});
