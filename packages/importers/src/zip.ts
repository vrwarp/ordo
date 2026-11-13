import JSZip from 'jszip';

import { isJunk, safeEntryPath, ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL_BYTES } from './zip-path.ts';

export { safeEntryPath, ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL_BYTES } from './zip-path.ts';

function declaredSize(file: JSZip.JSZipObject): number {
  const data = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : 0;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;

/**
 * ProPresenter 7 writes every entry as Zip64 and counts its own Zip64 end records (98 bytes) in the central
 * directory size it declares, in both end records. `unzip` compensates; JSZip refuses ("Corrupted zip:
 * missing 22 bytes"). When the declared size disagrees with the central directory actually there (walked
 * header by header, the declared entry count found, ending where the next record starts), this returns a
 * copy with the real size in the end records; otherwise the buffer itself. Never guesses: any other
 * inconsistency is left for JSZip to report.
 */
export function repairCentralDirectorySize(buf: Uint8Array): Uint8Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // The end record is in the last 22 + 65535 (comment) bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return buf;
  let entries = view.getUint16(eocd + 10, true);
  let size = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true);
  let zip64 = -1;
  const loc = eocd - 20;
  if (loc >= 0 && view.getUint32(loc, true) === ZIP64_LOCATOR_SIG) {
    const at = Number(view.getBigUint64(loc + 8, true));
    if (at >= 0 && at + 56 <= buf.length && view.getUint32(at, true) === ZIP64_EOCD_SIG) {
      zip64 = at;
      entries = Number(view.getBigUint64(at + 32, true));
      size = Number(view.getBigUint64(at + 40, true));
      offset = Number(view.getBigUint64(at + 48, true));
    }
  }
  // Walk the central directory as written.
  let p = offset;
  let n = 0;
  while (n < entries && p + 46 <= buf.length && view.getUint32(p, true) === CENTRAL_SIG) {
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    n++;
  }
  const real = p - offset;
  // The directory must end exactly where the next end record begins.
  const next = zip64 >= 0 ? zip64 : eocd;
  if (n !== entries || p !== next || real === size) return buf;
  const out = buf.slice();
  const w = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (zip64 >= 0) {
    // The size lives in the Zip64 record; the classic field says "see Zip64" (all ones), so a reader takes
    // the Zip64 trailer into account when it locates the directory.
    w.setBigUint64(zip64 + 40, BigInt(real), true);
    w.setUint32(eocd + 12, 0xffffffff, true);
  } else w.setUint32(eocd + 12, real, true);
  return out;
}

interface Budget {
  entries: number;
  bytes: number;
}

async function readInto(
  buf: Uint8Array,
  prefix: string,
  out: Map<string, Uint8Array>,
  budget: Budget,
  depth: number,
): Promise<void> {
  const zip = await JSZip.loadAsync(repairCentralDirectorySize(buf), {
    checkCRC32: false,
    createFolders: false,
  });
  const files = Object.values(zip.files).filter((f) => !f.dir);
  for (const f of files) {
    const original = (f as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? f.name;
    safeEntryPath(original);
    const path = safeEntryPath(f.name);
    if (!path || isJunk(path)) continue;
    budget.entries++;
    if (budget.entries > ZIP_MAX_ENTRIES) throw new Error(`zip has more than ${ZIP_MAX_ENTRIES} entries`);
    const declared = declaredSize(f);
    if (budget.bytes + declared > ZIP_MAX_TOTAL_BYTES) throw new Error('zip expands beyond 8 GB');
    const bytes = await f.async('uint8array');
    budget.bytes += bytes.length;
    if (budget.bytes > ZIP_MAX_TOTAL_BYTES) throw new Error('zip expands beyond 8 GB');
    const full = prefix ? `${prefix}/${path}` : path;
    // ProPresenter's exported .proPlaylist bundles are zips: expand them in place so their documents and
    // media are found by the importer.
    if (depth < 2 && /\.(proplaylist|probundle)$/i.test(path) && isZip(bytes)) {
      await readInto(bytes, full, out, budget, depth + 1);
      continue;
    }
    out.set(full, bytes);
  }
}

/**
 * Read a zip into a map of normalized relative paths to bytes. Rejects path traversal, more than 20,000
 * entries or more than 8 GB of uncompressed data. Nested `.proPlaylist` bundles are expanded under
 * `<bundle path>/`.
 */
export async function readZip(buf: Uint8Array): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  await readInto(buf, '', out, { entries: 0, bytes: 0 }, 0);
  return out;
}
