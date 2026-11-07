/**
 * JPEG EXIF orientation for the harness's page (`native-page.ts`): PowerPoint lays a picture out as its
 * pixels are stored and ignores an EXIF orientation, which Chromium's `createImageBitmap` applies whatever
 * `imageOrientation` says (Chromium 153: 'none' is the spec's old name of 'from-image'). The hub removes the
 * orientation when it prepares a picture (`apps/hub/src/pptx/pictures.ts`); the harness does the same before
 * it decodes, so a phone photo turned 90° in its `p:pic` is not turned a second time.
 */

/** Segments walked before giving up (as the hub's header scan). */
const MAX_SEGMENTS = 4_096;

/**
 * `bytes` with a JPEG's EXIF orientation (IFD0 tag 0x0112) set to 1 (as stored), in a copy; `bytes` itself
 * when it is not a JPEG or has no orientation other than 1.
 */
export function withoutExifOrientation(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  let pos = 2;
  for (let i = 0; i < MAX_SEGMENTS && pos + 4 <= bytes.length; i++) {
    if (bytes[pos] !== 0xff) return bytes;
    const mk = bytes[pos + 1]!;
    if (mk === 0xff) {
      pos += 1;
      continue;
    }
    // Start of scan or end of image: no orientation before the pixels.
    if (mk === 0xda || mk === 0xd9) return bytes;
    const len = (bytes[pos + 2]! << 8) | bytes[pos + 3]!;
    if (len < 2) return bytes;
    if (mk === 0xe1) {
      const at = orientationAt(bytes, pos + 4, pos + 2 + len);
      if (at !== undefined) {
        // The value is 2-8 in its byte order: its non-zero byte says which one is low.
        const out = bytes.slice();
        const big = out[at] === 0;
        out[at] = big ? 0 : 1;
        out[at + 1] = big ? 1 : 0;
        return out;
      }
    }
    pos += 2 + len;
  }
  return bytes;
}

/** The offset of the orientation's 2-byte value in an APP1 payload [from, to), when it is 2-8. */
function orientationAt(b: Uint8Array, from: number, to: number): number | undefined {
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0];
  if (to > b.length || to - from < 14) return undefined;
  for (let i = 0; i < 6; i++) if (b[from + i] !== exif[i]) return undefined;
  const t = from + 6;
  const le = b[t] === 0x49 && b[t + 1] === 0x49;
  if (!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) return undefined;
  const u16 = (p: number) => (le ? b[p]! | (b[p + 1]! << 8) : (b[p]! << 8) | b[p + 1]!);
  const u32 = (p: number) =>
    le
      ? (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0
      : ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
  if (u16(t + 2) !== 42) return undefined;
  const ifd = t + u32(t + 4);
  if (ifd + 2 > to) return undefined;
  const n = Math.min(u16(ifd), 1024);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > to) return undefined;
    if (u16(e) !== 0x0112) continue;
    if (u16(e + 2) !== 3) return undefined;
    const v = u16(e + 8);
    return v >= 2 && v <= 8 ? e + 8 : undefined;
  }
  return undefined;
}
