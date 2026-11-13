/**
 * Which image files have no transparency (design/27 §7.1 opaque-first, M7): a background or media picture
 * cover-fitted over the frame from such a file is opaque, so the render worker draws it without blending and
 * skips the clear and every layer under it. Read from the file's first bytes, never from the decoded pixels
 * (a scan of a 4K bitmap would cost more than it saves):
 * - JPEG has no alpha;
 * - PNG is opaque when its colour type is greyscale (0), truecolour (2) or palette (3) and no tRNS chunk
 *   precedes IDAT;
 * - anything else (WebP, GIF, an unreadable header) counts as possibly transparent.
 */

/** Bytes of a file's head read to decide (PNG chunks before IDAT are small; a large iCCP still fits). */
export const OPAQUE_HEAD_BYTES = 64 * 1024;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u32 = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const tag = (b: Uint8Array, i: number) => String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!);

/** Whether a file whose first bytes are `head` decodes to an image without transparency. */
export function opaqueImage(head: Uint8Array): boolean {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
  if (head.length < 33 || !PNG_SIG.every((v, i) => head[i] === v)) return false;
  if (tag(head, 12) !== 'IHDR') return false;
  const colourType = head[25];
  if (colourType !== 0 && colourType !== 2 && colourType !== 3) return false;
  // Chunks after IHDR (8 signature + 25 IHDR bytes): length, type, data, CRC.
  let i = 33;
  while (i + 8 <= head.length) {
    const len = u32(head, i);
    const t = tag(head, i + 4);
    if (t === 'tRNS') return false;
    if (t === 'IDAT' || t === 'IEND') return true;
    i += 12 + len;
  }
  return false; // the head ended before the first IDAT: undecided, so not opaque
}

/** Opacity by file hash, noted when a file is read for decoding; bounded (oldest dropped first). */
export class OpaqueFiles {
  private known = new Map<string, boolean>();

  private readonly max: number;
  constructor(max = 4096) {
    this.max = max;
  }

  async note(hash: string, blob: Blob): Promise<void> {
    let opaque = false;
    try {
      opaque = opaqueImage(new Uint8Array(await blob.slice(0, OPAQUE_HEAD_BYTES).arrayBuffer()));
    } catch {
      opaque = false;
    }
    this.known.delete(hash);
    this.known.set(hash, opaque);
    while (this.known.size > this.max) {
      const first = this.known.keys().next().value;
      if (first === undefined) break;
      this.known.delete(first);
    }
  }

  /** True only for a file noted as opaque. */
  opaque(hash: string): boolean {
    return this.known.get(hash) === true;
  }
}
