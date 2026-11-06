/**
 * The native PowerPoint import through the real job path (design/27 §2, §5 "Two-phase save", §11, §12;
 * M3 item B): crafted decks are zipped, stored like an upload and imported by the `pptx-native` job on the
 * real CPU pool, with item C's picture preparation.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Presentation, type Slide } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { digestOf } from '@ordo/pptx-scene/emit.ts';
import {
  body,
  buildDeck,
  type DeckSpec,
  imageRel,
  NS_A,
  NS_P,
  NS_R,
  para,
  partText,
  pic,
  pictureBg,
  run,
  solidBg,
  sp,
} from '@ordo/pptx-scene/test-util.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobCtx, JobQueue } from '../src/jobs.ts';
import { CpuPool, WorkerStartError } from '../src/pool.ts';
import { type NativeJobEnv, nativeJob } from '../src/pptx/nativeJob.ts';
import {
  PPTX_LIMITS,
  type PptxLoPayload,
  type PptxNativeFallback,
  type PptxNativePayload,
  type PptxNativeResult,
  type SceneTaskInput,
} from '../src/pptx/shared.ts';
import { ffmpeg } from './fixtures.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

const IN = 914_400;
const enc = new TextEncoder();
const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

let hub: TestHub;
let dir: string;
let photo: Uint8Array;
let photoAlpha: Uint8Array;

beforeAll(async () => {
  hub = await startHub();
  dir = tempDir('ordo-pptx-');
  mkdirSync(join(dir, 'media'), { recursive: true });
  const color = (name: string, c: string, extra: string[] = []) =>
    ffmpeg(join(dir, 'media'), name, [
      '-f',
      'lavfi',
      '-i',
      `color=c=${c}:s=320x180`,
      '-frames:v',
      '1',
      ...extra,
    ]);
  photo = await readFile(color('photo.png', 'red'));
  photoAlpha = await readFile(color('alpha.png', 'blue', ['-pix_fmt', 'rgba']));
}, 60_000);
afterAll(async () => {
  await hub?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A text box with one run. */
const textBox = (id: number, text: string, y = 1, ph?: string) =>
  sp({ id, x: IN, y: y * IN, cx: 6 * IN, cy: IN, ...(ph ? { ph } : {}), txBody: body(para(run(text))) });

/** A chart frame (residual: the slide is hybrid). */
const chart = (id: number) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `<p:xfrm><a:off x="${4 * IN}" y="${IN}"/><a:ext cx="${3 * IN}" cy="${2 * IN}"/></p:xfrm>` +
  `<a:graphic><a:graphicData uri="${CHART}"/></a:graphic></p:graphicFrame>`;

/** `p:extLst` with `p14:sectionLst`: each section's slides by their place in the deck (0-based). */
function withSections(parts: Map<string, Uint8Array>, sections: [string, number[]][]): void {
  const list = sections
    .map(
      ([name, slides], i) =>
        `<p14:section name="${name}" id="{0000000${i}-0000-0000-0000-000000000000}"><p14:sldIdLst>${slides
          .map((s) => `<p14:sldId id="${256 + s}"/>`)
          .join('')}</p14:sldIdLst></p14:section>`,
    )
    .join('');
  const xml = partText(parts, 'ppt/presentation.xml').replace(
    '</p:presentation>',
    `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="${P14}">${list}</p14:sectionLst></p:ext></p:extLst></p:presentation>`,
  );
  parts.set('ppt/presentation.xml', enc.encode(xml));
}

/** A notes slide whose body placeholder holds `text`, related to slide `n` (1-based). */
const notesRel = (n: number) => ({
  id: 'rId8',
  type: 'notesSlide',
  target: `../notesSlides/notesSlide${n}.xml`,
});
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

/** Import a deck through the job; the job and the saved presentation. */
async function importDeck(
  parts: Map<string, Uint8Array>,
  name = 'Sunday Service.pptx',
  options: { extendBackgrounds?: boolean } = {},
): Promise<{ job: Job; result: PptxNativeResult; p: Presentation; hash: string }> {
  const file = await zipDeck(parts, dir, `${Math.random().toString(36).slice(2)}.pptx`);
  const hash = await storeDeck(hub, file);
  const queued = hub.imports.pptx.queueNative(hash, name, options);
  const job = await waitJob(hub, queued.id);
  if (job.state !== 'done') throw new Error(`import failed: ${job.error}\n${job.log.join('\n')}`);
  const result = job.result as PptxNativeResult;
  return { job, result, p: hub.lib.presentations.must(result.presentationId), hash };
}

/** The pptx-lo payloads queued for a presentation. */
function loJobs(presentationId: string): PptxLoPayload[] {
  return hub.lib.db
    .prepare(`SELECT payload FROM jobs WHERE kind = 'pptx-lo' ORDER BY created_at`)
    .all()
    .map((r) => JSON.parse((r as { payload: string }).payload) as PptxLoPayload)
    .filter((pl) => pl.presentationId === presentationId);
}

describe('pptx-native: a synthetic service deck', () => {
  it('imports editable slides with notes, sections, hidden slides, transitions, pictures and provenance', async () => {
    const spec: DeckSpec = {
      slides: [
        {
          shapes:
            textBox(2, 'Welcome', 0.5, 'type="title"') +
            textBox(3, 'Grace and peace to you', 2, 'type="body" idx="1"'),
          rels: [notesRel(1)],
          after:
            '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
            `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${P14}" Requires="p14">` +
            '<p:transition spd="slow" p14:dur="2000" advTm="5000"><p:fade/></p:transition></mc:Choice>' +
            '<mc:Fallback><p:transition spd="slow" advTm="5000"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>',
        },
        { hidden: true, shapes: textBox(2, 'Backup slide') },
        {
          shapes:
            pic({ id: 2, x: IN, y: IN, cx: 4 * IN, cy: 2.25 * IN, rId: 'rId2' }) + textBox(3, 'Psalm 23', 4),
          rels: [imageRel('rId2', 'image1.png')],
          after:
            '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition><p:push dir="u"/></p:transition>',
        },
        { shapes: textBox(2, 'Giving', 0.5) + chart(3) },
      ],
      media: { 'ppt/media/image1.png': photo },
    };
    const parts = buildDeck(spec);
    withSections(parts, [
      ['Welcome', [0, 1]],
      ['Word', [2, 3]],
    ]);
    withNotes(parts, 1, 'Remember to greet the visitors');
    const { result, p, hash } = await importDeck(parts);

    expect(result).toMatchObject({ slides: 4, native: 3, hybrid: 1, picture: 0, compact: 0, pending: 1 });
    expect(p.title).toBe('Sunday Service');
    expect(p.kind).toBe('slides');
    // Sections in order, the Default arrangement over them.
    expect(p.sections.map((s) => [s.label, s.slides.length])).toEqual([
      ['Welcome', 2],
      ['Word', 2],
    ]);
    expect(p.arrangements).toEqual([
      { id: expect.any(String), name: 'Default', sectionIds: p.sections.map((s) => s.id) },
    ]);
    const [s1, s2, s3, s4] = slidesOf(p) as [Slide, Slide, Slide, Slide];
    // Editable objects, the lyric box, notes, the transition and timing.
    const texts = (s: Slide) => s.objects.flatMap((o) => (o.type === 'text' ? [o.text] : []));
    expect(texts(s1)).toEqual(['Welcome', 'Grace and peace to you']);
    expect(s1.objects.find((o) => o.id === s1.lyricObjectId)).toMatchObject({
      text: 'Grace and peace to you',
    });
    expect(s1.notes).toBe('Remember to greet the visitors');
    expect(s1.transition).toEqual({ kind: 'crossfade', ms: 2000 });
    expect(s1.durationMs).toBe(5000);
    // The hidden slide stays in place, flagged, without a shown index.
    expect(s2.hidden).toBe(true);
    expect(s2.pptx).toMatchObject({ index: 1, class: 'native' });
    expect(s2.pptx!.shown).toBeUndefined();
    expect(s3.pptx).toMatchObject({ index: 2, shown: 1 });
    // Another effect is a crossfade, noted.
    expect(s3.transition).toEqual({ kind: 'crossfade', ms: 700 });
    expect(s3.pptx!.notes).toContain('a push transition is shown as a crossfade');
    // The picture is stored ready, tagged 'pptx', and the image object points at it.
    const img = s3.objects.find((o) => o.type === 'image');
    expect(img?.type).toBe('image');
    const media = hub.lib.media.must(img!.type === 'image' ? img!.mediaId : '');
    expect(media).toMatchObject({ kind: 'image', state: 'ready', tags: ['pptx'] });
    // Provenance: the deck, the place, the converter version and the digest of the objects as stored.
    for (const [i, s] of [s1, s2, s3, s4].entries()) {
      expect(s.pptx).toMatchObject({ fileId: hash, index: i, version: 1 });
      expect(s.pptx!.digest).toBe(digestOf(s.objects));
    }
    // The chart slide is hybrid: its native objects now, LibreOffice art later.
    expect(s4.pptx).toMatchObject({ class: 'hybrid', pending: true });
    expect(texts(s4)).toEqual(['Giving']);
    expect(s1.pptx!.pending).toBeUndefined();
    expect(p.source).toMatchObject({
      kind: 'pptx',
      fileId: hash,
      native: {
        version: 1,
        slides: 4,
        native: 3,
        hybrid: 1,
        picture: 0,
        slideRect: { x: 0, y: 0, w: 1920, h: 1080 },
      },
    });
    expect(p.source!.log).toMatch(/4 slide\(s\): 3 native, 1 hybrid, 0 picture/);
    // The stored presentation is valid as it is.
    expect(Presentation.safeParse(p).success).toBe(true);
    // The LibreOffice follow-up is queued for the hybrid slide only, with version 1's digest.
    const [lo] = loJobs(p.id);
    expect(result.loJobId).toBeDefined();
    expect(lo).toMatchObject({
      presentationId: p.id,
      hash,
      version: 1,
      slides: [{ slideId: s4.id, index: 3, shown: 2, class: 'hybrid', digest: s4.pptx!.digest }],
    });
  });
});

describe('pptx-native: backgrounds', () => {
  const bgDeck = (bytes: Uint8Array, slides = 3) =>
    buildDeck({
      slides: Array.from({ length: slides }, (_, i) => ({ shapes: textBox(2, `Slide ${i + 1}`) })),
      master: { bg: pictureBg('rId9'), rels: [imageRel('rId9', 'bg.png')] },
      media: { 'ppt/media/bg.png': bytes },
    });

  it('promotes a 16:9 picture background shared by every slide to the presentation', async () => {
    const { p } = await importDeck(bgDeck(photo));
    expect(p.backgroundMediaId).toBeDefined();
    expect(hub.lib.media.must(p.backgroundMediaId!).tags).toEqual(['pptx']);
    for (const s of slidesOf(p)) {
      expect(s.backgroundMediaId).toBeUndefined();
      expect(s.objects.map((o) => o.type)).toEqual(['text']);
    }
  });

  it('lays a background picture with alpha on white instead of promoting it', async () => {
    const { p } = await importDeck(bgDeck(photoAlpha, 1));
    expect(p.backgroundMediaId).toBeUndefined();
    const [s] = slidesOf(p) as [Slide];
    expect(s.backgroundMediaId).toBeUndefined();
    const [white, image] = s.objects;
    const full = { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 };
    expect(white).toMatchObject({
      type: 'shape',
      shape: 'rect',
      fill: { r: 255, g: 255, b: 255, a: 1 },
      box: full,
    });
    expect(image).toMatchObject({ type: 'image', fit: 'stretch', box: full });
    // The converter lays it on white itself (item A: the PNG header tells the alpha), so the job's own
    // backstop for a stored picture with alpha has nothing to add.
    expect(s.pptx!.digest).toBe(digestOf(s.objects));
  });

  it("extends plain backgrounds to 16:9 unless the option is off, and records a 4:3 deck's area", async () => {
    const deck = () =>
      buildDeck({
        size: { cx: 9_144_000, cy: 6_858_000 },
        slides: [{ bg: solidBg('003366'), shapes: textBox(2, 'Hi') }],
      });
    const on = await importDeck(deck());
    const off = await importDeck(deck(), '4x3.pptx', { extendBackgrounds: false });
    const bottom = (p: Presentation) => slidesOf(p)[0]!.objects[0]!;
    expect(bottom(on.p)).toMatchObject({ type: 'shape', box: { x: 0, y: 0, w: 1920, h: 1080 } });
    expect(bottom(off.p)).toMatchObject({ type: 'shape', box: { x: 240, y: 0, w: 1440, h: 1080 } });
    expect(off.p.source!.native!.slideRect).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
  });
});

describe('pptx-native: classes, budgets and timing', () => {
  it('makes a looping show with every slide timed a loop presentation', async () => {
    const timed = (ms: number) => ({
      shapes: textBox(2, `${ms}`),
      after: `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition advTm="${ms}"><p:fade/></p:transition>`,
    });
    const parts = buildDeck({
      slides: [timed(8000), timed(8000), timed(4000), { ...timed(0), hidden: true }],
    });
    const rels = partText(parts, 'ppt/_rels/presentation.xml.rels').replace(
      '</Relationships>',
      `<Relationship Id="rId90" Type="${NS_R}/presProps" Target="presProps.xml"/></Relationships>`,
    );
    parts.set('ppt/_rels/presentation.xml.rels', enc.encode(rels));
    parts.set(
      'ppt/presProps.xml',
      enc.encode(`<p:presentationPr ${NS}><p:showPr loop="1"/></p:presentationPr>`),
    );
    const { p } = await importDeck(parts);
    expect(p.kind).toBe('loop');
    expect(p.loop).toEqual({ defaultSlideMs: 8000 });
    expect(slidesOf(p).map((s) => s.durationMs)).toEqual([8000, 8000, 4000, undefined]);
  });

  it('stores picture-class and unreadable slides without objects, their text for search, pending LibreOffice', async () => {
    const many = Array.from({ length: 160 }, (_, i) => textBox(10 + i, `Item ${i}`, (i % 6) * 0.9)).join('');
    const parts = buildDeck({
      slides: [{ shapes: many }, { shapes: textBox(2, 'Fine') }, { shapes: textBox(2, 'Bad') }],
    });
    parts.set('ppt/slides/slide3.xml', enc.encode('<!DOCTYPE x [<!ENTITY a "aaaa">]><p:sld/>'));
    const { result, p } = await importDeck(parts);
    expect(result).toMatchObject({ slides: 3, native: 1, picture: 2, pending: 2 });
    const [budget, fine, bad] = slidesOf(p) as [Slide, Slide, Slide];
    expect(budget.objects).toEqual([]);
    expect(budget.lyricObjectId).toBeUndefined();
    expect(budget.pptx).toMatchObject({ class: 'picture', pending: true });
    expect(budget.pptx!.artText).toMatch(/^Item 0\nItem 1\n/);
    expect(fine.pptx!.class).toBe('native');
    expect(bad.objects).toEqual([]);
    expect(bad.pptx).toMatchObject({ class: 'picture', pending: true });
    expect(bad.pptx!.notes!.join(' ')).toMatch(/could not be read/);
    expect(loJobs(p.id)[0]!.slides.map((s) => [s.index, s.class])).toEqual([
      [0, 'picture'],
      [2, 'picture'],
    ]);
  });

  it('makes a slide over 64 KB a compact picture slide, logged and counted', async () => {
    const big = Array.from({ length: 8 }, (_, i) =>
      textBox(2 + i, `${'Grace '.repeat(1500)}${i}`, i * 0.6),
    ).join('');
    const { result, p } = await importDeck(
      buildDeck({ slides: [{ shapes: textBox(2, 'Small') }, { shapes: big }] }),
    );
    expect(result).toMatchObject({ native: 1, picture: 1, compact: 1, pending: 1 });
    expect(result.notes.join('\n')).toMatch(/slide 2 is over 64 KB/);
    const [, s2] = slidesOf(p) as [Slide, Slide];
    expect(s2.objects).toEqual([]);
    expect(s2.pptx!.artText!.length).toBeGreaterThan(1000);
    expect(p.source!.log).toMatch(/\[warn\] slide 2 is over 64 KB/);
  });
});

/** Run the job's handler directly (no queue), with its own pool or a spy over it. */
async function runHandler(
  payload: PptxNativePayload,
  env: NativeJobEnv,
  deps = hub.imports.pptx.deps,
): Promise<{ out: PptxNativeResult | PptxNativeFallback; lines: string[]; payload: PptxNativePayload }> {
  const lines: string[] = [];
  const ctx: JobCtx<PptxNativePayload> = {
    id: 'direct',
    payload,
    signal: new AbortController().signal,
    log: (m) => lines.push(m),
    progress: () => {},
    setPayload: (p) => {
      ctx.payload = p;
    },
  };
  const out = (await nativeJob(deps, env)(ctx)) as PptxNativeResult | PptxNativeFallback;
  return { out, lines, payload: ctx.payload };
}

describe('pptx-native: the presentation budget', () => {
  it('keeps a long deck within 4 MiB: the tail becomes compact picture slides, logged and counted', async () => {
    // 360 slides of about 10 KB each: 3 pool batches, and the running total passes 3 MiB near slide 300.
    const slides = Array.from({ length: 360 }, (_, i) => ({
      shapes: textBox(2, `Slide ${i + 1} ${'Lorem ipsum dolor sit amet. '.repeat(340)}`),
    }));
    const { result, p } = await importDeck(buildDeck({ slides }), 'Long.pptx');
    expect(result.slides).toBe(360);
    expect(result.compact).toBeGreaterThan(30);
    expect(result.native + result.picture).toBe(360);
    expect(result.picture).toBe(result.compact);
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(4 * 1024 * 1024);
    const all = slidesOf(p);
    const firstCompact = all.findIndex((s) => s.pptx!.class === 'picture');
    // Only the tail is compact; each keeps its text for search.
    expect(all.slice(firstCompact).every((s) => s.pptx!.class === 'picture' && s.objects.length === 0)).toBe(
      true,
    );
    expect(all.at(-1)!.pptx!.artText).toMatch(/^Slide 360 Lorem/);
    expect(result.notes.join('\n')).toMatch(new RegExp(`slide ${firstCompact + 1} and later are compact`));
  }, 60_000);
});

describe('pptx-native: pool batches, budgets and fallbacks', () => {
  const pool = new CpuPool(1);
  afterAll(() => pool.close());
  /** A pool call: the parts it was given, and which of them held a whole slide (not a stub). */
  type Call = {
    range: { from: number; to: number };
    scan: boolean;
    keys: string[];
    slides: string[];
    transfer: number;
  };
  const spy = (calls: Call[], fail?: (input: SceneTaskInput) => Error | undefined): NativeJobEnv['pool'] => ({
    run: ((kind: 'pptx-scene', input: SceneTaskInput, opts: { transfer?: ArrayBuffer[] }) => {
      const slides = [...input.parts]
        .filter(
          ([k, v]) =>
            /^ppt\/slides\/slide\d+\.xml$/.test(k) && new TextDecoder().decode(v).includes('<p:cSld'),
        )
        .map(([k]) => k)
        .sort();
      calls.push({
        range: input.range,
        scan: !!input.scan,
        keys: [...input.parts.keys()],
        slides,
        transfer: opts.transfer?.length ?? 0,
      });
      const err = fail?.(input);
      return err ? Promise.reject(err) : pool.run(kind, input, opts);
    }) as CpuPool['run'],
  });
  /** `n` slides 'Slide 1' …, the third hidden, the first with notes. */
  const deckOf = (n: number) => {
    const parts = buildDeck({
      slides: Array.from({ length: n }, (_, i) => ({
        shapes: textBox(2, `Slide ${i + 1}`),
        ...(i === 0 ? { rels: [notesRel(1)] } : {}),
        ...(i === 2 ? { hidden: true } : {}),
      })),
    });
    withNotes(parts, 1, 'Opening prayer');
    return parts;
  };
  const stored = async (parts: Map<string, Uint8Array>) =>
    storeDeck(hub, await zipDeck(parts, dir, `${Math.random().toString(36).slice(2)}.pptx`));

  it('converts in batches: slide parts transferred, shared parts copied, notes read once by the scan', async () => {
    expect(PPTX_LIMITS.batchSlides).toBe(150);
    const calls: Call[] = [];
    const hash = await stored(deckOf(10));
    const { out } = await runHandler(
      { hash, name: 'Ten.pptx' },
      { pool: spy(calls), limits: { batchSlides: 4 } },
    );
    expect(calls.map((c) => [c.scan, c.range.from, c.range.to])).toEqual([
      [true, 0, 0],
      [false, 0, 4],
      [false, 4, 8],
      [false, 8, 10],
    ]);
    // The scan reads every part; a batch gets its own slides and the shared parts, never the notes.
    expect(calls[0]!.keys).toContain('ppt/notesSlides/notesSlide1.xml');
    expect(calls[0]!.slides).toHaveLength(10);
    expect(calls[2]!.slides).toEqual([
      'ppt/slides/slide5.xml',
      'ppt/slides/slide6.xml',
      'ppt/slides/slide7.xml',
      'ppt/slides/slide8.xml',
    ]);
    // The other slides are listed as stubs with their show flag only, so indexes and shown places match.
    expect(calls[2]!.keys.filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))).toHaveLength(10);
    expect(calls[2]!.keys).not.toContain('ppt/slides/_rels/slide1.xml.rels');
    for (const c of calls.slice(1)) {
      expect(c.keys).not.toContain('ppt/notesSlides/notesSlide1.xml');
      expect(c.keys).toContain('ppt/slideMasters/slideMaster1.xml');
      // Each slide and its relationships part are transferred.
      expect(c.transfer).toBe(2 * (c.range.to - c.range.from));
    }
    const r = out as PptxNativeResult;
    expect(r).toMatchObject({ slides: 10, native: 10, picture: 0, pending: 0 });
    const p = hub.lib.presentations.must(r.presentationId);
    const all = slidesOf(p);
    // Every batch converted its own slides, at their places in the deck (the hidden third included).
    expect(all.map((s) => s.objects.flatMap((o) => (o.type === 'text' ? [o.text] : [])))).toEqual(
      Array.from({ length: 10 }, (_, i) => [`Slide ${i + 1}`]),
    );
    expect(all.map((s) => [s.pptx!.index, s.pptx!.shown ?? null])).toEqual([
      [0, 0],
      [1, 1],
      [2, null],
      [3, 2],
      [4, 3],
      [5, 4],
      [6, 5],
      [7, 6],
      [8, 7],
      [9, 8],
    ]);
    expect(all[2]!.hidden).toBe(true);
    expect(all[0]!.notes).toBe('Opening prayer');
  });

  it('makes the slides of a failed batch picture class, the rest of the deck native', async () => {
    const hash = await stored(deckOf(6));
    const calls: Call[] = [];
    const timeout = (input: SceneTaskInput) =>
      input.range.from === 0 && !input.scan ? new Error('pptx-scene task timed out after 120 s') : undefined;
    const { out, lines } = await runHandler(
      { hash, name: 'Six.pptx' },
      { pool: spy(calls, timeout), limits: { batchSlides: 2 } },
    );
    const r = out as PptxNativeResult;
    expect(calls.filter((c) => !c.scan)).toHaveLength(3);
    expect(r).toMatchObject({ slides: 6, native: 4, picture: 2, pending: 2 });
    expect(lines.join('\n')).toMatch(
      /\[warn\] slides 1-2 could not be converted \(pptx-scene task timed out/,
    );
    const p = hub.lib.presentations.must(r.presentationId);
    const [s1, s2, s3] = slidesOf(p) as [Slide, Slide, Slide];
    for (const s of [s1, s2])
      expect(s).toMatchObject({ objects: [], pptx: { class: 'picture', pending: true } });
    expect(s3.pptx!.class).toBe('native');
    // Notes come from the scan, so an unconverted slide keeps them.
    expect(s1.notes).toBe('Opening prayer');
    expect(loJobs(p.id)[0]!.slides.map((s) => s.index)).toEqual([0, 1]);
  });

  it('makes the slides past the pool-time budget picture class', async () => {
    const hash = await stored(deckOf(4));
    const calls: Call[] = [];
    const { out, lines } = await runHandler(
      { hash, name: 'Four.pptx' },
      { pool: spy(calls), limits: { batchSlides: 2, importPoolMs: 0 } },
    );
    // The scan spent the budget: no batch was sent.
    expect(calls.map((c) => c.scan)).toEqual([true]);
    expect(out).toMatchObject({ slides: 4, native: 0, picture: 4, pending: 4 });
    expect(lines.filter((l) => /were not converted: the import used its/.test(l))).toHaveLength(2);
  });

  it('sends the deck to the LibreOffice picture import when the pool cannot start, never parsing inline', async () => {
    const hash = await stored(deckOf(2));
    const queued: [string, unknown, string][] = [];
    const jobs = {
      enqueue: (kind: string, payload: unknown, cls: string) => {
        queued.push([kind, payload, cls]);
        return { id: 'doc-job' };
      },
    } as unknown as JobQueue;
    const deps = { ...hub.imports.pptx.deps, jobs };
    const noPool = { run: () => Promise.reject(new WorkerStartError('cpu worker exited with code 1')) };
    const before = hub.lib.presentations.list().length;
    const { out, payload } = await runHandler({ hash, name: 'Two.pptx' }, { pool: noPool as never }, deps);
    expect(out).toEqual({
      fallback: 'libreoffice',
      jobId: 'doc-job',
      reason: 'cpu worker exited with code 1',
    });
    expect(queued).toEqual([['document', { hash, name: 'Two.pptx', ext: 'pptx' }, 'heavy']]);
    expect(hub.lib.presentations.list()).toHaveLength(before);
    // A re-run does not queue it twice.
    const again = await runHandler(payload, { pool: noPool as never }, deps);
    expect(again.out).toMatchObject({ fallback: 'libreoffice', jobId: 'doc-job' });
    expect(queued).toHaveLength(1);
  });

  it('resumes: stored pictures are reused, and a saved version 1 is never saved twice', async () => {
    const parts = buildDeck({
      slides: [
        {
          shapes: pic({ id: 2, x: 0, y: 0, cx: 4 * IN, cy: 2.25 * IN, rId: 'rId2' }),
          rels: [imageRel('rId2', 'image1.png')],
        },
        { shapes: textBox(2, 'B') },
      ],
      media: { 'ppt/media/image1.png': photo },
    });
    const hash = await stored(parts);
    const first = await runHandler({ hash, name: 'Resume.pptx' }, { pool });
    const r1 = first.out as PptxNativeResult;
    const imageOf = (id: string) => {
      const o = slidesOf(hub.lib.presentations.must(id))[0]!.objects.find((x) => x.type === 'image');
      return o?.type === 'image' ? o.mediaId : undefined;
    };
    const mediaId = imageOf(r1.presentationId);
    expect(first.payload.done!.media).toEqual([['ppt/media/image1.png', mediaId]]);
    expect(first.payload.done!.presentationId).toBe(r1.presentationId);
    // This deck's media only: the LibreOffice follow-ups of earlier imports store theirs in the background.
    const ownMedia = () => hub.lib.media.list().filter((m) => m.name.startsWith('Resume'));
    const mediaCount = ownMedia().length;
    const presCount = hub.lib.presentations.list().length;

    // Re-queued after version 1 was saved: nothing is saved again.
    const again = await runHandler(first.payload, { pool });
    expect((again.out as PptxNativeResult).presentationId).toBe(r1.presentationId);
    expect(again.lines.join('\n')).toMatch(/resumed: version 1 was already saved/);
    expect(hub.lib.presentations.list()).toHaveLength(presCount);

    // Re-queued after the pictures were stored but before the save (simulated by removing the presentation):
    // the same id is saved, the stored picture reused.
    hub.lib.presentations.delete(r1.presentationId);
    const resumed = await runHandler(first.payload, { pool });
    expect((resumed.out as PptxNativeResult).presentationId).toBe(r1.presentationId);
    expect(imageOf(r1.presentationId)).toBe(mediaId);
    expect(ownMedia()).toHaveLength(mediaCount);
    expect(hub.lib.presentations.list()).toHaveLength(presCount);
  });
});
