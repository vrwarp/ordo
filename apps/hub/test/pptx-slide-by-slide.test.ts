/**
 * Slide-by-slide reading on the hub (design/29 B6, the owner's 1 GB of 2026-11-20): the import reads a deck's structure whole and
 * each pool call's slide parts from the stored file just before the call, so a deck declaring 700 MiB of slide XML imports within
 * the memory of a call; the steps that read a deck whole (the render copy of the LibreOffice follow-up, the slide listing, the text
 * repair) keep their own 256 MiB bound and refuse a bigger deck with one clear line.
 */
import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipDeclared } from '@ordo/importers/zip-declared.test-util.ts';
import { SLIDE_HEAD_BYTES } from '@ordo/pptx-scene/deck.ts';
import { body, buildDeck, para, run, sp } from '@ordo/pptx-scene/test-util.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobCtx } from '../src/jobs.ts';
import { CpuPool } from '../src/pool.ts';
import {
  declaredXml,
  readDeckXml,
  readSlideParts,
  SLIDE_PART,
  XmlTotalError,
} from '../src/pptx/deckParts.ts';
import { deckListing, extractDeck } from '../src/pptx/fallback.ts';
import { type NativeJobEnv, nativeJob } from '../src/pptx/nativeJob.ts';
import {
  type PptxNativePayload,
  type PptxNativeResult,
  PPTX_LIMITS,
  type SceneTaskInput,
} from '../src/pptx/shared.ts';
import { readDeckText } from '../src/pptx/textRepair.ts';
import { writeBigDeck } from './big-deck.test-util.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, zipDeck } from './pptx-helpers.ts';

const MiB = 1024 * 1024;
const IN = 914_400;
const ctl = () => new AbortController().signal;
const textBox = (id: number, text: string) =>
  sp({ id, x: IN, y: IN, cx: 4 * IN, cy: IN, txBody: body(para(run(text))) });
/** The sentence of W17 (design/29 section 3) for the import's bound: 1 GB. */
const W17 =
  'ordo could not read this file: it holds more slide data than ordo reads (1 GB at most). Nothing was imported. In PowerPoint, save very detailed artwork as pictures and import again.';
/** What a step that reads a deck whole says of a deck past its 256 MiB. */
const WHOLE = /holds \d+ MB of slide data, more than this step reads at once \(256 MB at most\)/;

let dir: string;
let hub: TestHub;
beforeAll(async () => {
  dir = tempDir('ordo-slide-by-slide-');
  // No LibreOffice: what is measured is the native import (the follow-up of a big deck is a job of minutes).
  hub = await startHub({ libreoffice: { mode: 'off', exe: '' } });
}, 60_000);
afterAll(async () => {
  await hub?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A deck of `n` slides whose slide part is about 150 KB (past the 64 KiB a listing reads of each slide). */
const fatDeck = (n: number) =>
  buildDeck({
    slides: Array.from({ length: n }, (_, i) => ({
      shapes: textBox(2, `Slide ${i + 1} ${'grace '.repeat(25_000)}`),
    })),
  });

describe('readDeckXml reads slide by slide when asked (deferred), and readSlideParts reads the slides of a call', () => {
  it('keeps the structure whole and each slide to its first 64 KiB, listing the slide parts with their declared sizes', async () => {
    const parts = fatDeck(3);
    const file = await zipDeck(parts, dir, 'fat3.pptx');
    const real = parts.get('ppt/slides/slide2.xml')!;
    expect(real.length).toBeGreaterThan(SLIDE_HEAD_BYTES);
    const xml = await readDeckXml(file, dir, ctl(), { slides: 'deferred' });
    expect(xml.parts.get('ppt/slides/slide2.xml')!.length).toBe(SLIDE_HEAD_BYTES);
    expect(
      Buffer.from(xml.parts.get('ppt/slides/slide2.xml')!).equals(
        Buffer.from(real.subarray(0, SLIDE_HEAD_BYTES)),
      ),
    ).toBe(true);
    expect([...(xml.deferred ?? [])].map(([k, v]) => [k, v])).toEqual(
      [1, 2, 3].map((n) => [`ppt/slides/slide${n}.xml`, parts.get(`ppt/slides/slide${n}.xml`)!.length]),
    );
    // The structure is whole: the presentation, its relationships and the slide relationships.
    for (const k of [
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
    ])
      expect(Buffer.from(xml.parts.get(k)!).equals(Buffer.from(parts.get(k)!))).toBe(true);
    // Whole mode (the default) is unchanged: every slide whole and nothing deferred.
    const whole = await readDeckXml(file, dir, ctl());
    expect(whole.parts.get('ppt/slides/slide2.xml')!.length).toBe(real.length);
    expect(whole.deferred).toBeUndefined();
  });

  it('reads the slide parts it is asked for, whole, and no others', async () => {
    const parts = fatDeck(3);
    const file = await zipDeck(parts, dir, 'fat3b.pptx');
    const got = await readSlideParts(file, dir, ctl(), ['ppt/slides/slide3.xml', 'ppt/slides/slide1.xml']);
    expect([...got.keys()].sort()).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide3.xml']);
    expect(
      Buffer.from(got.get('ppt/slides/slide3.xml')!).equals(Buffer.from(parts.get('ppt/slides/slide3.xml')!)),
    ).toBe(true);
    expect(SLIDE_PART.test('ppt/slides/slide3.xml')).toBe(true);
    expect(SLIDE_PART.test('ppt/slides/_rels/slide3.xml.rels')).toBe(false);
  });
});

describe('the bounds: 1 GB of slide XML for an import, 256 MB for what is read whole, 256 MB of structure', () => {
  const garbage = (n: number, each: number, prefix = 'ppt/slides/slide') =>
    zipDeclared(Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i + 1}.xml`, declared: each })));

  it('has 1 GiB for an import and 256 MiB for a whole read', () => {
    expect(PPTX_LIMITS.xmlTotalBytes).toBe(1024 * MiB);
    expect(PPTX_LIMITS.xmlWholeBytes).toBe(256 * MiB);
  });

  it('refuses a deck that declares 1.25 GiB of XML with W17 ("1 GB"), from its directory: nothing is read', async () => {
    const file = join(dir, 'declared-1250.pptx');
    await writeFile(file, garbage(40, 32 * MiB));
    const e = await readDeckXml(file, dir, ctl(), { slides: 'deferred' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(XmlTotalError);
    expect((e as XmlTotalError).message).toBe(W17);
    expect((e as XmlTotalError).bound).toBe('import');
  });

  it('does not refuse a deck that declares exactly 1 GiB: it is read (and its garbage entries fail as garbage, not as too large)', async () => {
    const file = join(dir, 'declared-1024.pptx');
    await writeFile(file, garbage(32, 32 * MiB));
    expect((await declaredXml(file, ctl())).total).toBe(1024 * MiB);
    const e = await readDeckXml(file, dir, ctl(), { slides: 'deferred' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(XmlTotalError);
  });

  it('refuses a deck whose structure (everything but the slides) declares more than 256 MiB, in plain words', async () => {
    const file = join(dir, 'declared-structure.pptx');
    // Nine layouts of 32 MiB (288 MiB), and no slide at all.
    await writeFile(file, garbage(9, 32 * MiB, 'ppt/slideLayouts/slideLayout'));
    const e = await readDeckXml(file, dir, ctl(), { slides: 'deferred' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(XmlTotalError);
    expect((e as XmlTotalError).bound).toBe('structure');
    expect((e as XmlTotalError).message).toMatch(/designs, charts and drawings.*\(256 MB at most\)/);
  });

  it('counts the declared XML by kind: slides apart from the structure, parts past the part cap in neither', async () => {
    const file = join(dir, 'declared-kinds.pptx');
    await writeFile(
      file,
      zipDeclared([
        { name: 'ppt/slides/slide1.xml', declared: 10 * MiB },
        { name: 'ppt/slides/_rels/slide1.xml.rels', declared: 1000 },
        { name: 'ppt/slides/slide2.xml', declared: 40 * MiB },
        { name: 'ppt/slideLayouts/slideLayout1.xml', declared: 3 * MiB },
        { name: 'ppt/media/image1.png', declared: 500 * MiB },
      ]),
    );
    const d = await declaredXml(file, ctl());
    expect(d.total).toBe(13 * MiB + 1000);
    expect(d.structure).toBe(3 * MiB + 1000);
    expect([...d.slides]).toEqual([['ppt/slides/slide1.xml', 10 * MiB]]);
  });
});

describe('the steps that read a deck whole refuse a deck of 700 MiB with one clear line, reading nothing', () => {
  let file: string;
  beforeAll(async () => {
    // Twenty-eight slide parts of 25 MiB: a valid directory whose bytes are garbage, so a reader that inflated any of them fails
    // differently from the refusal.
    file = join(dir, 'declared-700.pptx');
    await writeFile(
      file,
      zipDeclared(
        Array.from({ length: 28 }, (_, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, declared: 25 * MiB })),
      ),
    );
  });

  it('readDeckXml (whole)', async () => {
    const e = await readDeckXml(file, dir, ctl()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(XmlTotalError);
    expect((e as XmlTotalError).bound).toBe('whole');
    expect((e as XmlTotalError).message).toMatch(WHOLE);
    expect((e as XmlTotalError).message).toContain('700 MB');
  });

  it('the render copy of the LibreOffice follow-up (extractDeck)', async () => {
    await expect(extractDeck(file, dir, ctl(), { pages: [] })).rejects.toThrow(WHOLE);
  });

  it('the slide listing of the PowerPoint-PDF reference (deckListing)', async () => {
    await expect(deckListing(file, dir, ctl())).rejects.toThrow(WHOLE);
  });

  it('the text repair (readDeckText)', async () => {
    await expect(readDeckText(file, dir, ctl())).rejects.toThrow(WHOLE);
  });
});

/** The job's handler directly, over a pool the test can see into. */
async function runHandler(hash: string, env: NativeJobEnv, deps = hub.imports.pptx.deps, signal = ctl()) {
  const lines: string[] = [];
  const ctx: JobCtx<PptxNativePayload> = {
    id: 'direct',
    payload: { hash, name: 'Big.pptx' },
    signal,
    log: (m) => lines.push(m),
    progress: () => {},
    setPayload: (p) => {
      ctx.payload = p;
    },
  };
  const out = (await nativeJob(deps, env)(ctx)) as PptxNativeResult;
  return { out, lines };
}

describe('a deck of 700 MiB of slide XML imports, in calls of at most 64 MiB of slides', () => {
  const pool = new CpuPool(1);
  afterAll(() => pool.close());
  it('imports 22 slides of 31.8 MiB (700 MiB declared, past the old 256 MiB), done, every slide with its text', async () => {
    const parts = buildDeck({
      slides: Array.from({ length: 22 }, (_, i) => ({ shapes: textBox(2, `Slide ${i + 1}`) })),
    });
    const file = join(dir, 'huge700.pptx');
    const { xmlBytes } = await writeBigDeck(file, parts, { padBytes: Math.floor(31.8 * MiB), padSlides: 22 });
    expect(xmlBytes).toBeGreaterThan(700 * MiB);
    const hash = await storeDeck(hub, file);
    rmSync(file, { force: true });
    // Every pool call's own bytes, as the call's input holds them: a slide the call converts is whole, every other slide a stub.
    const calls: { range: [number, number]; scan: boolean; bytes: number; whole: number }[] = [];
    const spy: NativeJobEnv['pool'] = {
      run: ((kind: 'pptx-scene', input: SceneTaskInput, opts: { transfer?: ArrayBuffer[] }) => {
        let bytes = 0;
        let whole = 0;
        for (const v of input.parts.values()) bytes += v.byteLength;
        for (const [k, v] of input.parts)
          if (/^ppt\/slides\/slide\d+\.xml$/.test(k) && v.byteLength > 1000) whole++;
        calls.push({ range: [input.range.from, input.range.to], scan: !!input.scan, bytes, whole });
        return pool.run(kind, input, opts);
      }) as CpuPool['run'],
    };
    const { out, lines } = await runHandler(hash, { pool: spy });
    expect(lines.join('\n')).not.toContain('of slide XML');
    expect(out).toMatchObject({ slides: 22, picture: 0, pending: 0 });
    const p = hub.lib.presentations.must(out.presentationId);
    expect(slidesOf(p).map((s) => s.objects.flatMap((o) => (o.type === 'text' ? [o.text] : [])))).toEqual(
      Array.from({ length: 22 }, (_, i) => [`Slide ${i + 1}`]),
    );
    // The scan holds each slide's head (64 KiB at most), never a slide: well under the 256 MiB the old whole read would have kept.
    const scan = calls.find((c) => c.scan)!;
    expect(scan.bytes).toBeLessThan(22 * SLIDE_HEAD_BYTES + 1 * MiB);
    // A call holds the slides it converts and no more: at most 64 MiB of slide XML, or one slide alone (31.8 MiB).
    const conv = calls.filter((c) => !c.scan);
    expect(conv.length).toBeGreaterThanOrEqual(11);
    for (const c of conv) expect(c.bytes).toBeLessThanOrEqual(PPTX_LIMITS.batchXmlBytes + 1 * MiB);
  }, 600_000);
});

describe('what a failed call leaves to the rescue is read again, not kept', () => {
  const pool = new CpuPool(1);
  afterAll(() => pool.close());
  const stored = async () =>
    storeDeck(
      hub,
      await zipDeck(
        buildDeck({
          slides: Array.from({ length: 6 }, (_, i) => ({ shapes: textBox(2, `Slide ${i + 1}`) })),
        }),
        dir,
        `six-${Math.random().toString(36).slice(2)}.pptx`,
      ),
    );

  it('reads each call’s slide parts just before the call, and the failed slide again for its rescue', async () => {
    const hash = await stored();
    const read: string[][] = [];
    const calls: { from: number; to: number; rescue: boolean; hasSlide3: boolean }[] = [];
    const spy: NativeJobEnv['pool'] = {
      run: ((kind: 'pptx-scene', input: SceneTaskInput, opts: { transfer?: ArrayBuffer[] }) => {
        calls.push({
          from: input.range.from,
          to: input.range.to,
          rescue: !!input.rescue,
          hasSlide3: (input.parts.get('ppt/slides/slide3.xml')?.byteLength ?? 0) > 1000,
        });
        // Slide 3 never converts (as a slide that exhausts the worker): its call and its retry fail; its rescue does not.
        return !input.scan && !input.rescue && input.range.from <= 2 && input.range.to > 2
          ? Promise.reject(new Error('pptx-scene task timed out after 120 s'))
          : pool.run(kind, input, opts);
      }) as CpuPool['run'],
    };
    const { out } = await runHandler(hash, {
      pool: spy,
      limits: { batchSlides: 2 },
      readSlideParts: async (deck, scratch, signal, names) => {
        const n = [...names];
        read.push(n);
        return readSlideParts(deck, scratch, signal, n);
      },
    });
    expect(out).toMatchObject({ slides: 6, native: 5, hybrid: 1, picture: 0 });
    // The calls' reads: slides 1-2, then 3-4 (failed), 3 and 4 each alone, then 5-6; and the rescue of slide 3 reads it again.
    const names = read.map((r) => r.map((x) => x.replace(/^ppt\/slides\/slide(\d+)\.xml$/, '$1')).join(','));
    expect(names.filter((n) => n === '3')).toHaveLength(1);
    expect(read.flat().filter((x) => x === 'ppt/slides/slide3.xml').length).toBeGreaterThanOrEqual(2);
    const rescue = calls.find((c) => c.rescue)!;
    expect(rescue).toMatchObject({ from: 2, to: 3, hasSlide3: true });
    const p = hub.lib.presentations.must(out.presentationId);
    const s3 = slidesOf(p)[2]!;
    expect(s3.objects.flatMap((o) => (o.type === 'text' ? [o.text] : []))).toEqual(['Slide 3']);
    expect(s3.pptx).toMatchObject({ class: 'hybrid', missing: ['slide'] });
  });
});

describe('a deck past what the whole-deck steps read (256 MiB) is imported without a LibreOffice follow-up, and says so', () => {
  it('lists what ordo cannot draw instead of waiting for a follow-up that cannot run, on a hub with LibreOffice', async () => {
    const withLo = await startHub();
    try {
      const parts = buildDeck({
        slides: Array.from({ length: 9 }, (_, i) => ({ shapes: textBox(2, `Slide ${i + 1}`) })),
      });
      const file = join(dir, 'over256.pptx');
      await writeBigDeck(file, parts, { padBytes: Math.floor(31.8 * MiB), padSlides: 9 });
      const hash = await storeDeck(withLo, file);
      rmSync(file, { force: true });
      const { out, lines } = await runHandler(hash, {}, withLo.imports.pptx.deps);
      expect(out).toMatchObject({ slides: 9, pending: 0 });
      expect(out.loJobId).toBeUndefined();
      expect(lines.join('\n')).toMatch(/more slide data than the 256 MB that LibreOffice's follow-up/);
    } finally {
      await withLo.cleanup();
    }
  }, 300_000);
});
