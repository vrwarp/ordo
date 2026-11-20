/**
 * A zip written by hand whose entries DECLARE sizes they do not have: for the tests that prove a reader refuses a deck
 * from its central directory before it reads a byte (the bytes of every entry are garbage, so a reader that inflated any
 * of them would fail with an inflate error instead of the refusal the test expects).
 */
export type DeclaredEntry = {
  name: string;
  /** The declared uncompressed size (the central directory's and the local header's). */
  declared: number;
  /** The stored bytes (default: 64 bytes that are not a deflate stream). */
  data?: Uint8Array;
};

export function zipDeclared(entries: readonly DeclaredEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const body = e.data ?? new Uint8Array(64).fill(0xff);
    const local = new Uint8Array(30 + name.length + body.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(8, 8, true);
    v.setUint32(18, body.length, true);
    v.setUint32(22, e.declared, true);
    v.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const c = new Uint8Array(46 + name.length);
    const w = new DataView(c.buffer);
    w.setUint32(0, 0x02014b50, true);
    w.setUint16(10, 8, true);
    w.setUint32(20, body.length, true);
    w.setUint32(24, e.declared, true);
    w.setUint16(28, name.length, true);
    w.setUint32(42, offset, true);
    c.set(name, 46);
    locals.push(local);
    central.push(c);
    offset += local.length;
  }
  const cdLen = central.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(offset + cdLen + 22);
  let at = 0;
  for (const part of [...locals, ...central]) {
    out.set(part, at);
    at += part.length;
  }
  const ev = new DataView(out.buffer, at);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, offset, true);
  return out;
}
