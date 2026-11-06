/**
 * Resource bounds of the PowerPoint text extractor (review 2026-11-04 finding 6): a 205 KB file whose slide
 * holds a 200 MB text node used to run 84 s to an out-of-memory; parts are now refused on their declared
 * size before inflating, a header that lies is stopped while inflating, the XML read per file is bounded,
 * and shape and tag counts are checked before parsing. The hostile cases run in a worker with a small heap.
 */
import { fileURLToPath } from 'node:url';
import { createDeflateRaw, crc32 } from 'node:zlib';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { runBounded } from './bounded-run.test-util.ts';
import { extractPptxText, PPTX_MAX_SHAPES_PER_SLIDE } from './pptx.ts';
import { IMPORT_LIMITS } from './sanitize.ts';

const PPTX = fileURLToPath(new URL('./pptx.ts', import.meta.url));
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PRES = (n: number) =>
  `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`;
const RELS = (n: number) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`;
const HEAD = `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>`;
const TAIL = '</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>';

type Part = { name: string; chunks: () => Iterable<Uint8Array>; declare?: number };

/** Deflate a part from chunks without ever holding it whole; returns body, CRC and true size. */
async function deflate(chunks: Iterable<Uint8Array>): Promise<{ body: Buffer; crc: number; size: number }> {
  const z = createDeflateRaw({ level: 9 });
  const out: Buffer[] = [];
  z.on('data', (b: Buffer) => out.push(b));
  const end = new Promise((r) => z.on('end', r));
  let crc = 0;
  let size = 0;
  for (const c of chunks) {
    crc = crc32(c, crc);
    size += c.length;
    if (!z.write(c)) await new Promise((r) => z.once('drain', r));
  }
  z.end();
  await end;
  return { body: Buffer.concat(out), crc, size };
}

/** A zip of deflated parts; `declare` overrides the uncompressed size written in both headers. */
async function buildZip(parts: Part[]): Promise<Uint8Array> {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const p of parts) {
    const { body, crc, size } = await deflate(p.chunks());
    const name = Buffer.from(p.name);
    const usize = p.declare ?? size;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    local.push(lh, name, body);
    central.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...local, cd, eocd]));
}

const enc = new TextEncoder();
const once = (s: string) => () => [enc.encode(s)];
/** A slide whose one text run is `mb` MB of the letter A, produced 1 MB at a time. */
function hugeRun(mb: number): () => Iterable<Uint8Array> {
  const block = new Uint8Array(1024 * 1024).fill(0x41);
  return function* () {
    yield enc.encode(HEAD);
    for (let i = 0; i < mb; i++) yield block;
    yield enc.encode(TAIL);
  };
}
/** A slide whose shape name attribute is `mb` MB long (cheap to parse, so many fit in a test). */
function hugeName(mb: number): () => Iterable<Uint8Array> {
  const block = new Uint8Array(1024 * 1024).fill(0x41);
  return function* () {
    yield enc.encode(
      `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="`,
    );
    for (let i = 0; i < mb; i++) yield block;
    yield enc.encode('"/></p:nvSpPr></p:sp></p:spTree></p:cSld></p:sld>');
  };
}
function deck(slides: Part[]): Promise<Uint8Array> {
  return buildZip([
    { name: 'ppt/presentation.xml', chunks: once(PRES(slides.length)) },
    { name: 'ppt/_rels/presentation.xml.rels', chunks: once(RELS(slides.length)) },
    ...slides,
  ]);
}

async function extractBounded(buf: Uint8Array, heapMb = 96) {
  const copy = buf.slice();
  return runBounded(
    PPTX,
    'const r = await mod.extractPptxText(new Uint8Array(input)); return { slides: r.slides.length, skipped: r.skipped ?? [] };',
    copy.buffer,
    heapMb,
    [copy.buffer as ArrayBuffer],
  );
}

describe('extractPptxText resource bounds', () => {
  // A slide over the per-slide bounds loses its own text, not the deck's (a free template pack's icon
  // sheet of 6,500 vector shapes is 10 MB of XML); it is still refused before or while inflating.
  type Out = { slides: number; skipped: { index: number; reason: string }[] };

  it('skips the review slide (205 KB file, one 200 MB text node) on its declared size, fast, in a 96 MB heap', async () => {
    const buf = await deck([
      { name: 'ppt/slides/slide1.xml', chunks: hugeRun(200) },
      { name: 'ppt/slides/slide2.xml', chunks: once(`${HEAD}Amazing grace${TAIL}`) },
    ]);
    expect(buf.length).toBeLessThan(400 * 1024);
    const r = await extractBounded(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as Out;
    expect(v.slides).toBe(2);
    expect(v.skipped).toEqual([
      { index: 1, reason: expect.stringMatching(/slide1\.xml expands to over 8 MB/) },
    ]);
    expect(r.ms).toBeLessThan(500);
  }, 30_000);

  it('stops a slide whose header understates its size once it passes 8 MB', async () => {
    const buf = await deck([{ name: 'ppt/slides/slide1.xml', chunks: hugeRun(200), declare: 2000 }]);
    const r = await extractBounded(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as Out).skipped[0]!.reason).toMatch(/slide1\.xml expands to over 8 MB/);
    expect(r.ms).toBeLessThan(1000);
  }, 30_000);

  it('bounds the XML read from one file to 64 MB in total', async () => {
    const slides = Array.from({ length: 12 }, (_, i) => ({
      name: `ppt/slides/slide${i + 1}.xml`,
      chunks: hugeName(6),
    }));
    // Ten 6 MB slides are read and parsed before the bound is reached; none of them is kept.
    const r = await extractBounded(await deck(slides), 128);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/more than 64 MB of XML/);
  }, 30_000);

  it('skips a slide with more shapes than the limit before parsing it, and reads the others', async () => {
    const shape = '<p:sp><p:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>';
    const n = PPTX_MAX_SHAPES_PER_SLIDE + 1;
    const slide = `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${shape.repeat(n)}</p:spTree></p:cSld></p:sld>`;
    const t0 = performance.now();
    const r = await extractPptxText(
      await deck([
        { name: 'ppt/slides/slide1.xml', chunks: once(slide) },
        { name: 'ppt/slides/slide2.xml', chunks: once(`${HEAD}Amazing grace${TAIL}`) },
      ]),
    );
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.skipped).toEqual([{ index: 1, reason: 'slide 1 has more than 5,000 shapes' }]);
    expect(r.slides.map((s) => s.boxes.length)).toEqual([0, 1]);
    expect(r.slides[1]!.boxes[0]!.text).toBe('Amazing grace');
  });

  it('skips the review slide with 300,000 shapes (8.5 s and 1.1 GB before) fast, in a 96 MB heap', async () => {
    const shapes = enc.encode(
      '<p:sp><p:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>'.repeat(1000),
    );
    const chunks = function* () {
      yield enc.encode(`<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>`);
      for (let i = 0; i < 300; i++) yield shapes;
      yield enc.encode('</p:spTree></p:cSld></p:sld>');
    };
    const r = await extractBounded(await deck([{ name: 'ppt/slides/slide1.xml', chunks }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as Out).skipped).toHaveLength(1);
    expect(r.ms).toBeLessThan(500);
  }, 30_000);

  it('rejects a part with more tags than the limit (a run flood in one shape)', async () => {
    const slide = `${HEAD}${'</a:t></a:r><a:r><a:t>x'.repeat(130_000)}${TAIL}`;
    await expect(
      extractPptxText(await deck([{ name: 'ppt/slides/slide1.xml', chunks: once(slide) }])),
    ).rejects.toThrow(/more than 250,000 XML tags/);
  });

  it('caps text per box while walking, and a part just under 8 MB still imports', async () => {
    const buf = await deck([{ name: 'ppt/slides/slide1.xml', chunks: hugeRun(7) }]);
    const r = await extractPptxText(buf);
    const box = r.slides[0]!.boxes[0]!;
    expect(box.text.length).toBe(IMPORT_LIMITS.text);
    expect(box.text).toMatch(/^A+$/);
  });

  it('a normal deck still imports', async () => {
    const z = new JSZip();
    z.file('ppt/presentation.xml', PRES(1));
    z.file('ppt/_rels/presentation.xml.rels', RELS(1));
    z.file('ppt/slides/slide1.xml', `${HEAD}Amazing grace${TAIL}`);
    const r = await extractPptxText(await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
    expect(r.slides[0]!.boxes[0]!.text).toBe('Amazing grace');
  });
});
