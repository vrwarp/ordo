/**
 * Dense decks through the `pptx-native` job (design/29 B6: the hub reads up to 1 GiB of slide XML slide by slide, refused from the
 * file's own directory before any byte is read, in pool calls bounded by bytes): an 80 MB deck of traced artwork imports where the
 * base refused it whole, a deck that only DECLARES 1.25 GiB is refused with W17 and nothing inflated, the calls of a deck are cut
 * by bytes as well as by slides. The reading itself is pptx-slide-by-slide.test.ts's.
 */
import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PPTX_CLIENT_LIMITS } from '@ordo/importers/pptx-client.ts';
import { zipDeclared } from '@ordo/importers/zip-declared.test-util.ts';
import { buildDeck, denseShapes } from '@ordo/pptx-scene/test-util.ts';
import { MAX_PACKED_ELEMENTS_PER_PART } from '@ordo/pptx-scene/xml.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declaredXmlBytes } from '../src/pptx/deckParts.ts';
import { batchEnds, PPTX_LIMITS } from '../src/pptx/shared.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

const MiB = 1024 * 1024;
/** W17 (design/29 section 3) with the number this hub enforces. */
const W17 =
  'ordo could not read this file: it holds more slide data than ordo reads (1 GB at most). Nothing was imported. In PowerPoint, save very detailed artwork as pictures and import again.';

let hub: TestHub;
let dir: string;
beforeAll(async () => {
  // No LibreOffice: the follow-up of a hybrid slide (its art, for a deck of 80 MB of XML) is a job of minutes that would outlive
  // the test and replace the slides it reads; what is measured here is the native import.
  hub = await startHub({ libreoffice: { mode: 'off', exe: '' } });
  dir = tempDir('ordo-pptx-dense-');
}, 60_000);
afterAll(async () => {
  await hub?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function importFile(file: string, ms = 120_000) {
  const hash = await storeDeck(hub, file);
  return waitJob(hub, hub.imports.pptx.queueNative(hash, 'Dense.pptx').id, ms);
}

describe('the hub reads up to 1 GiB of slide XML (design/29 B6)', () => {
  it('separates the hub\u2019s total (1 GiB; 256 MiB for what is read whole) from the browser\u2019s (64 MiB, which hands a bigger deck to the hub)', () => {
    expect(PPTX_LIMITS.xmlTotalBytes).toBe(1024 * MiB);
    expect(PPTX_LIMITS.xmlWholeBytes).toBe(256 * MiB);
    expect(PPTX_CLIENT_LIMITS.xmlTotalBytes).toBe(64 * MiB);
  });

  it('imports a deck of 20 slides of 4 MiB of traced artwork (80 MB of XML, past the base 64 MiB)', async () => {
    // 50 discs of 1,900 points a slide: about 4.2 MB of compact path XML, twenty times.
    const shapes = denseShapes({ shapes: 50, points: 1900 });
    expect(shapes.length).toBeGreaterThan(4 * MiB);
    const parts = buildDeck({ slides: Array.from({ length: 20 }, () => ({ shapes })) });
    let xml = 0;
    for (const [k, v] of parts) if (/\.xml$/.test(k)) xml += v.length;
    expect(xml).toBeGreaterThan(80 * MiB);
    const job = await importFile(await zipDeck(parts, dir, 'eighty.pptx'));
    expect(job.error).toBeUndefined();
    expect(job.state).toBe('done');
    expect(job.log.join('\n')).not.toContain('of slide XML');
    const p = hub.lib.presentations.must((job.result as { presentationId: string }).presentationId);
    expect(slidesOf(p)).toHaveLength(20);
  }, 240_000);

  it('refuses a deck that declares 1.25 GiB of XML with W17 from its directory, reading none of it', async () => {
    // Forty entries of 32 MiB (the part cap) in a valid central directory whose bytes are garbage: a reader that inflated any
    // entry fails with an inflate error, not with W17.
    const entries = Array.from({ length: 40 }, (_, i) => ({
      name: `ppt/slides/slide${i + 1}.xml`,
      declared: 32 * MiB,
    }));
    const file = join(dir, 'declared-1250.pptx');
    await writeFile(file, zipDeclared(entries));
    expect(await declaredXmlBytes(file, new AbortController().signal)).toBe(1280 * MiB);
    const job = await importFile(file, 30_000);
    expect(job.state).toBe('failed');
    expect(job.error).toBe(W17);
    expect(job.log.join('\n')).not.toMatch(/inflate|invalid|zip entries/i);
  });

  it('counts only the XML a read would keep: parts over the part cap, pictures and fonts are not in the declared total', async () => {
    const entries = [
      { name: 'ppt/slides/slide1.xml', declared: 10 * MiB },
      { name: 'ppt/slides/_rels/slide1.xml.rels', declared: 1000 },
      { name: 'ppt/slides/slide2.xml', declared: 40 * MiB },
      { name: 'ppt/media/image1.png', declared: 500 * MiB },
      { name: 'ppt/fonts/font1.fntdata', declared: 300 * MiB },
      { name: 'docProps/core.xml', declared: 200 * MiB },
    ];
    const file = join(dir, 'declared-mixed.pptx');
    await writeFile(file, zipDeclared(entries));
    expect(await declaredXmlBytes(file, new AbortController().signal)).toBe(10 * MiB + 1000);
  });
});

describe('hostile parts at and past the reader\u2019s element bound, through the real pool (design/29 X1, B4)', () => {
  const junk = (n: number) => '<a:b/>'.repeat(n);

  it('imports a deck whose slide, layout and master each hold 399,900 elements: done, never failed whole', async () => {
    // Three parts at the bound pinned together: the measured case that sets the bound (445 MB of the pool's 512 MB heap).
    const n = MAX_PACKED_ELEMENTS_PER_PART - 100;
    const parts = buildDeck({
      slides: [{ shapes: junk(n) }],
      layouts: [{ shapes: junk(n) }],
      master: { shapes: junk(n) },
    });
    const job = await importFile(await zipDeck(parts, dir, 'three-at-bound.pptx'), 180_000);
    expect(job.error).toBeUndefined();
    expect(job.state).toBe('done');
    const p = hub.lib.presentations.must((job.result as { presentationId: string }).presentationId);
    expect(slidesOf(p)).toHaveLength(1);
  }, 240_000);

  it('refuses parts past the bound at once and ends done: the slide keeps only what it can, the designs are said (W9)', async () => {
    const n = MAX_PACKED_ELEMENTS_PER_PART + 100;
    const parts = buildDeck({
      slides: [{ shapes: junk(n) }],
      layouts: [{ shapes: junk(n) }],
      master: { shapes: junk(n) },
    });
    const job = await importFile(await zipDeck(parts, dir, 'three-past-bound.pptx'), 180_000);
    expect(job.error).toBeUndefined();
    expect(job.state).toBe('done');
    expect(job.log.join('\n')).toContain(
      'Slide 1 has too much drawing detail for ordo to read, so only its text was imported.',
    );
  }, 240_000);
});

describe('the calls of a deck are cut by bytes as well as by slides (batchEnds)', () => {
  const MAX = PPTX_LIMITS.batchXmlBytes;

  it('keeps the fixed cuts of 150 slides when no call is heavy: no other deck changes', () => {
    expect(PPTX_LIMITS.batchSlides).toBe(150);
    expect(batchEnds(Array(1).fill(5000), 150, MAX)).toEqual([1]);
    expect(batchEnds(Array(150).fill(5000), 150, MAX)).toEqual([150]);
    expect(batchEnds(Array(151).fill(5000), 150, MAX)).toEqual([150, 151]);
    expect(batchEnds(Array(2000).fill(30_000), 150, MAX)).toEqual(
      [...Array(13)].map((_, i) => 150 * (i + 1)).concat([2000]),
    );
    expect(batchEnds([], 150, MAX)).toEqual([]);
  });

  it('puts at most 64 MiB of slide XML in a call, unless one slide alone passes it, and always makes progress', () => {
    expect(MAX).toBe(64 * MiB);
    // 40 + 40 > 64: one each; 30 + 30 = 60 fit and the third waits; a slide of 100 MiB is a call of its own.
    expect(batchEnds([40 * MiB, 40 * MiB, 40 * MiB], 150, MAX)).toEqual([1, 2, 3]);
    expect(batchEnds([30 * MiB, 30 * MiB, 30 * MiB], 150, MAX)).toEqual([2, 3]);
    expect(batchEnds([1000, 100 * MiB, 1000, 1000], 150, MAX)).toEqual([1, 2, 4]);
    expect(batchEnds([MAX, 1], 150, MAX)).toEqual([1, 2]);
    expect(batchEnds([MAX - 1, 1, 1], 150, MAX)).toEqual([2, 3]);
    // Slides of zero bytes (a missing part) still count as slides and still end a call at 150.
    expect(batchEnds(Array(300).fill(0), 150, MAX)).toEqual([150, 300]);
  });

  it('holds for 300 random decks: each call within both bounds (or alone), no call can take the next slide, the last end is the deck', () => {
    let seed = 20_261_120;
    const rand = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 4_294_967_296;
    };
    for (let k = 0; k < 300; k++) {
      const n = Math.floor(rand() * 400);
      const sizes = Array.from({ length: n }, () =>
        rand() < 0.1 ? Math.floor(rand() * 90 * MiB) : Math.floor(rand() * 2 * MiB),
      );
      const ends = batchEnds(sizes, 150, MAX);
      expect(ends[ends.length - 1] ?? 0).toBe(n);
      let from = 0;
      for (const to of ends) {
        expect(to).toBeGreaterThan(from);
        const bytes = sizes.slice(from, to).reduce((a, b) => a + b, 0);
        expect(to - from).toBeLessThanOrEqual(150);
        if (to - from > 1) expect(bytes).toBeLessThanOrEqual(MAX);
        if (to < n) expect(to - from === 150 || bytes + sizes[to]! > MAX).toBe(true);
        from = to;
      }
    }
  });
});
