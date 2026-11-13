/**
 * The import core's one SHA-256 (pure TypeScript): synchronous in any environment (browser, Web Worker,
 * Node.js), where `crypto.subtle` is async and missing in insecure contexts (plain http on a LAN). Shape files
 * are named with it (`pptx-geoms.ts`) on the hub and on the client alike. `Sha256` hashes in pieces, so a
 * deck is hashed as it is read (`sha256Blob`) without a second copy of it.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** An incremental SHA-256: `update` with the bytes in order, then `digest` once. */
export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly w = new Uint32Array(64);
  private fill = 0;
  private length = 0;
  private done = false;

  update(data: Uint8Array): this {
    if (this.done) throw new Error('sha256: digest was taken');
    this.length += data.length;
    let i = 0;
    if (this.fill) {
      const take = Math.min(64 - this.fill, data.length);
      this.block.set(data.subarray(0, take), this.fill);
      this.fill += take;
      i = take;
      if (this.fill < 64) return this;
      this.compress(this.block, 0);
      this.fill = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.fill = data.length - i;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.done) throw new Error('sha256: digest was taken');
    this.done = true;
    const bits = BigInt(this.length) * 8n;
    const tail = new Uint8Array(this.fill + 9 <= 64 ? 64 : 128);
    tail.set(this.block.subarray(0, this.fill));
    tail[this.fill] = 0x80;
    new DataView(tail.buffer).setBigUint64(tail.length - 8, bits, false);
    for (let i = 0; i < tail.length; i += 64) this.compress(tail, i);
    const out = new Uint8Array(32);
    const v = new DataView(out.buffer);
    for (let j = 0; j < 8; j++) v.setUint32(j * 4, this.h[j]!, false);
    return out;
  }

  private compress(b: Uint8Array, at: number): void {
    const w = this.w;
    for (let j = 0; j < 16; j++) {
      const o = at + j * 4;
      w[j] = ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15]!, 7) ^ rotr(w[j - 15]!, 18) ^ (w[j - 15]! >>> 3);
      const s1 = rotr(w[j - 2]!, 17) ^ rotr(w[j - 2]!, 19) ^ (w[j - 2]! >>> 10);
      w[j] = (w[j - 16]! + s0 + w[j - 7]! + s1) >>> 0;
    }
    const h = this.h;
    let a = h[0]!;
    let bb = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let j = 0; j < 64; j++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[j]! + w[j]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = bb;
      bb = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + bb) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Sha256().update(data).digest();
}

export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(sha256Bytes(bytes));
}

/** Bytes hashed per read by `sha256Blob`. */
const BLOB_CHUNK = 4 * 1024 * 1024;

/** The SHA-256 (hex) of a `Blob` or bytes, read in pieces (a deck is never copied whole for it). */
export async function sha256Blob(input: Blob | Uint8Array): Promise<string> {
  const h = new Sha256();
  if (input instanceof Uint8Array) return hex(h.update(input).digest());
  for (let at = 0; at < input.size; at += BLOB_CHUNK)
    h.update(new Uint8Array(await input.slice(at, Math.min(input.size, at + BLOB_CHUNK)).arrayBuffer()));
  return hex(h.digest());
}
