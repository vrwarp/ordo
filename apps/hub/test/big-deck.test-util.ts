/**
 * A real .pptx that DECLARES a great deal of slide XML and is small on disk, for the tests of the hub's slide-by-slide reading (design/29
 * B6, 1 GB): every slide is the deck's own slide followed by a long XML comment (the padding the tokenizer skips in one step), written
 * as a deflate stream of a few KB. Nothing here is a third party's deck; the file is generated at test time and deleted by the test.
 */
import { open } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';

const enc = new TextEncoder();

/**
 * Write `file`: the deck `parts` (see `buildDeck`), with `padBytes` of XML comment inside each slide part of `padSlides` (a count: the first
 * ones), streamed entry by entry (one padded slide in memory at a time). Returns the XML bytes the deck declares (parts of 32 MiB at most).
 */
export async function writeBigDeck(
  file: string,
  parts: ReadonlyMap<string, Uint8Array>,
  o: { padBytes: number; padSlides: number },
): Promise<{ xmlBytes: number }> {
  const fh = await open(file, 'w');
  const central: Uint8Array[] = [];
  let offset = 0;
  let xmlBytes = 0;
  const write = async (b: Uint8Array) => {
    await fh.write(b);
    offset += b.length;
  };
  const entry = async (name: string, data: Uint8Array) => {
    const nm = enc.encode(name);
    const packed = deflateRawSync(data, { level: 1 });
    const local = new Uint8Array(30 + nm.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(8, 8, true);
    v.setUint32(14, crc32(data), true);
    v.setUint32(18, packed.length, true);
    v.setUint32(22, data.length, true);
    v.setUint16(26, nm.length, true);
    local.set(nm, 30);
    const c = new Uint8Array(46 + nm.length);
    const w = new DataView(c.buffer);
    w.setUint32(0, 0x02014b50, true);
    w.setUint16(4, 20, true);
    w.setUint16(6, 20, true);
    w.setUint16(10, 8, true);
    w.setUint32(16, crc32(data), true);
    w.setUint32(20, packed.length, true);
    w.setUint32(24, data.length, true);
    w.setUint16(28, nm.length, true);
    w.setUint32(42, offset, true);
    c.set(nm, 46);
    central.push(c);
    await write(local);
    await write(packed);
  };
  try {
    let padded = 0;
    for (const [name, data] of parts) {
      if (/\.xml$/i.test(name) || /\.rels$/i.test(name)) xmlBytes += data.length;
      if (/^ppt\/slides\/slide\d+\.xml$/.test(name) && padded < o.padSlides) {
        padded++;
        const text = new TextDecoder().decode(data);
        const at = text.indexOf('<p:spTree>') + '<p:spTree>'.length;
        const head = enc.encode(`${text.slice(0, at)}<!--`);
        const tail = enc.encode(`-->${text.slice(at)}`);
        const all = new Uint8Array(head.length + o.padBytes + tail.length);
        all.set(head, 0);
        all.fill(0x78, head.length, head.length + o.padBytes);
        all.set(tail, head.length + o.padBytes);
        xmlBytes += all.length - data.length;
        await entry(name, all);
      } else await entry(name, data);
    }
    const start = offset;
    let cdLen = 0;
    for (const c of central) {
      await write(c);
      cdLen += c.length;
    }
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdLen, true);
    ev.setUint32(16, start, true);
    await write(end);
  } finally {
    await fh.close();
  }
  return { xmlBytes };
}
