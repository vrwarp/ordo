/**
 * Entry names and archive bounds every zip reader of the importers shares (`zip.ts`, `zip-stream.ts`,
 * `zip-bounded.ts`): no dependency, so a Web Worker that reads a deck does not load JSZip for them.
 */
export const ZIP_MAX_ENTRIES = 200_000;
export const ZIP_MAX_TOTAL_BYTES = 8 * 1024 ** 3;

/** Paths from macOS archives and filesystems that are never content. */
export function isJunk(path: string): boolean {
  return (
    path.startsWith('__MACOSX/') ||
    path.includes('/__MACOSX/') ||
    /(^|\/)\.DS_Store$/.test(path) ||
    /(^|\/)\._[^/]*$/.test(path) ||
    /(^|\/)Thumbs\.db$/i.test(path)
  );
}

/**
 * Normalize a zip entry name, rejecting `..` traversal. An absolute name (ProPresenter's own bundle
 * exports store media under the exporting Mac's full path, `/Users/me/.../bg.png`) is made relative.
 */
export function safeEntryPath(name: string): string {
  const unified = name
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^[a-zA-Z]:\/+/, '');
  const parts: string[] = [];
  for (const part of unified.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new Error(`zip entry escapes the archive root: ${name}`);
    parts.push(part);
  }
  return parts.join('/');
}
