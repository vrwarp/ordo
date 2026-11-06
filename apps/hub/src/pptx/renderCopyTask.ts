/**
 * Worker side of the `pptx-render-copy` pool task (design/27 §5 "Render copy"; M3 item D): build the
 * minimal deck LibreOffice prints with `@ordo/pptx-scene` `buildRenderCopy`, add the spilled media it keeps
 * and write it as a .pptx to `input.out`. Imported by `cpu.worker.ts` only.
 *
 * Replaces the main-thread `pptxForRendering` for the native import's follow-up and for the 'Pictures
 * (LibreOffice)' import option alike. With `texts`, the text boxes of those slides are read too (picture-class
 * slides get them in version 2, keyed by slide, in the uniform contain mapping of the native import).
 *
 * The zip is written as a stream: XML parts deflated, pictures stored (they are compressed already) and
 * copied from their spilled files in chunks, so a deck's pictures never sit in the worker's heap.
 */
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';
import type { ExtractedText } from '@ordo/domain';
import { convertDeck } from '@ordo/pptx-scene';
import { readDeck } from '@ordo/pptx-scene/deck.ts';
import { openPackage } from '@ordo/pptx-scene/opc.ts';
import { buildRenderCopy, metafileSize, type RenderCopyPage } from '@ordo/pptx-scene/rendercopy.ts';
import { pictureSize } from '@ordo/pptx-scene/picture.ts';
import type { RenderCopyTaskInput, RenderCopyTaskOutput } from './shared.ts';

/** Bytes read from a spilled picture to learn its size. */
const HEAD_BYTES = 64 * 1024;
/** Text boxes kept per slide (`Slide.imported.textBoxes`). */
const MAX_TEXT_BOXES = 1_000;

export async function renderCopyTask(input: RenderCopyTaskInput): Promise<RenderCopyTaskOutput> {
  const pages = input.allShown ? shownPages(input.parts) : input.pages;
  if (input.plan) {
    // Which pictures the copy keeps (their sizes do not change which): the job spills only those.
    const plan = buildRenderCopy(input.parts, pages);
    return {
      pages: plan.pages,
      bytes: 0,
      outlines: plan.outlines,
      notes: [],
      slideSize: plan.slideSize,
      need: [...new Set(plan.media.map(([, part]) => part))],
    };
  }
  const files = new Map(input.media);
  const heads = new Map<string, Uint8Array>();
  for (const page of pages)
    if (page.mode === 'picture' && files.has(page.part) && !heads.has(page.part))
      heads.set(page.part, await head(files.get(page.part)!));
  const copy = buildRenderCopy(input.parts, pages, {
    pictureSize: (part) => {
      const b = heads.get(part);
      return b ? (metafileSize(b) ?? pictureSize(b)) : undefined;
    },
  });
  const entries: ZipEntry[] = [...copy.parts].map(([name, bytes]) => ({ name, bytes }));
  let missing = 0;
  for (const [name, part] of copy.media) {
    const file = files.get(part);
    if (file) entries.push({ name, file });
    else missing++;
  }
  const notes = [...copy.notes];
  if (missing) notes.push(`${missing} picture(s) of the deck were not extracted and are left out`);
  const bytes = await writeZip(input.out, entries);
  const out: RenderCopyTaskOutput = {
    pages: copy.pages,
    bytes,
    outlines: copy.outlines,
    notes,
    slideSize: copy.slideSize,
  };
  if (input.texts?.length) out.texts = textBoxes(input.parts, input.texts);
  return out;
}

/** Every shown slide, whole, in the deck's order: what LibreOffice prints of the deck itself. */
function shownPages(parts: Map<string, Uint8Array>): RenderCopyPage[] {
  const deck = readDeck(openPackage(parts));
  return deck.slides.filter((r) => !r.hidden).map((r) => ({ index: r.index, mode: 'whole' as const }));
}

async function head(file: string): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const b = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(b, 0, HEAD_BYTES, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * The text boxes of slides (`SlideRef.index`), read with the native converter: one `ExtractedText` per text
 * object, its box in logical px (the slide contain-fitted in 1920x1080), its size the style's. Consecutive
 * slides are read in one call.
 */
export function textBoxes(
  parts: Map<string, Uint8Array>,
  indexes: readonly number[],
): [number, ExtractedText[]][] {
  const want = [...new Set(indexes)].filter((i) => Number.isInteger(i) && i >= 0).sort((a, b) => a - b);
  const out: [number, ExtractedText[]][] = [];
  for (let k = 0; k < want.length; ) {
    let end = k + 1;
    while (end < want.length && want[end] === want[end - 1]! + 1) end++;
    const from = want[k]!;
    const to = want[end - 1]! + 1;
    k = end;
    let result: ReturnType<typeof convertDeck>;
    try {
      result = convertDeck(parts, { range: { from, to } });
    } catch {
      continue; // no presentation part: no text
    }
    for (const s of result.slides) {
      const boxes: ExtractedText[] = [];
      for (const o of s.slide.objects) {
        if (o.type !== 'text' || !o.text.trim()) continue;
        boxes.push({ text: o.text, box: { ...o.box }, fontSizePx: o.style.fontSizePx });
        if (boxes.length >= MAX_TEXT_BOXES) break;
      }
      out.push([s.index, boxes]);
    }
  }
  return out;
}

// ── Zip writing ─────────────────────────────────────────────────────────────────────────────────────────

/** An entry: bytes in memory (deflated), or a file on disk (stored). */
type ZipEntry = { name: string; bytes: Uint8Array } | { name: string; file: string };

/** Zip offsets and sizes are 32-bit without ZIP64; a copy never comes near (spilled media ≤ 1 GiB). */
const ZIP_MAX = 0xffff_fff0;

/**
 * Write a zip of `entries` to `path`; returns its size. Deflated XML, stored pictures (their CRC read in a
 * first pass, then copied), no data descriptors, no ZIP64 (refused past 4 GiB or 65,535 entries).
 */
export async function writeZip(path: string, entries: readonly ZipEntry[]): Promise<number> {
  if (entries.length > 0xffff) throw new Error('too many parts for a zip without ZIP64');
  const fh = await open(path, 'w');
  let offset = 0;
  const central: Buffer[] = [];
  const write = async (b: Uint8Array) => {
    let at = 0;
    while (at < b.length) {
      const { bytesWritten } = await fh.write(b, at, b.length - at, offset + at);
      at += bytesWritten;
    }
    offset += b.length;
    if (offset > ZIP_MAX) throw new Error('the render copy is larger than 4 GiB');
  };
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8');
      let method: number;
      let crc: number;
      let size: number;
      let data: Uint8Array | undefined;
      if ('bytes' in e) {
        method = 8;
        crc = crc32(e.bytes);
        size = e.bytes.length;
        data = deflateRawSync(e.bytes, { level: 6 });
      } else {
        method = 0;
        crc = 0;
        size = 0;
        for await (const chunk of createReadStream(e.file)) {
          crc = crc32(chunk as Buffer, crc);
          size += (chunk as Buffer).length;
        }
      }
      const compressed = data ? data.length : size;
      if (size > ZIP_MAX || compressed > ZIP_MAX) throw new Error('a part is larger than 4 GiB');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0x21, 12); // 1980-01-01
      local.writeUInt32LE(crc >>> 0, 14);
      local.writeUInt32LE(compressed, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const at = offset;
      await write(local);
      await write(name);
      if (data) await write(data);
      else {
        let copied = 0;
        for await (const chunk of createReadStream((e as { file: string }).file)) {
          copied += (chunk as Buffer).length;
          if (copied > size) throw new Error('a picture changed while the copy was written');
          await write(chunk as Buffer);
        }
        if (copied !== size) throw new Error('a picture changed while the copy was written');
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(method, 10);
      c.writeUInt16LE(0, 12);
      c.writeUInt16LE(0x21, 14);
      c.writeUInt32LE(crc >>> 0, 16);
      c.writeUInt32LE(compressed, 20);
      c.writeUInt32LE(size, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt32LE(at, 42);
      central.push(c, name);
    }
    const start = offset;
    for (const b of central) await write(b);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    await write(end);
    return offset;
  } finally {
    await fh.close();
  }
}
