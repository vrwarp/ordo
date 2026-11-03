import JSZip from 'jszip';

export const ZIP_MAX_ENTRIES = 20_000;
export const ZIP_MAX_TOTAL_BYTES = 8 * 1024 ** 3;

/** Paths from macOS archives and filesystems that are never content. */
function isJunk(path: string): boolean {
  return (
    path.startsWith('__MACOSX/') ||
    path.includes('/__MACOSX/') ||
    /(^|\/)\.DS_Store$/.test(path) ||
    /(^|\/)\._[^/]*$/.test(path) ||
    /(^|\/)Thumbs\.db$/i.test(path)
  );
}

/** Normalize a zip entry name, rejecting absolute paths and `..` traversal. */
export function safeEntryPath(name: string): string {
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:\//.test(unified)) {
    throw new Error(`zip entry has an absolute path: ${name}`);
  }
  const parts: string[] = [];
  for (const part of unified.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new Error(`zip entry escapes the archive root: ${name}`);
    parts.push(part);
  }
  return parts.join('/');
}

function declaredSize(file: JSZip.JSZipObject): number {
  const data = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === 'number' ? data.uncompressedSize : 0;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
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
  const zip = await JSZip.loadAsync(buf, { checkCRC32: false, createFolders: false });
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
    if (depth < 2 && /\.proplaylist$/i.test(path) && isZip(bytes)) {
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
