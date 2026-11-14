/**
 * What the compact path may load (design/28 §3.1 "Code split", §7; design/24 "Bundle budget"). Plain data in
 * erasable syntax: vite.config.ts (the service worker's precache sets), the unit tests, tools/bundle-report.mjs
 * (run by Node, which strips the types) and the end-to-end specs import it. Paths are relative to
 * apps/operator, as a source map's sources are once their leading `../` are dropped (`normalizeSource`).
 */

/** Modules the compact layout loads at startup, beside the entry (P0: none; the compact shell adds its own). */
export const COMPACT_START: readonly string[] = [];

/** Modules the compact path opens later (and a phone precaches): the playlists and a presentation's previews. */
export const COMPACT_LAZY: readonly string[] = [
  'src/views/playlists/PlaylistsView.tsx',
  'src/views/editor/PreviewsView.tsx',
];

/**
 * The workers a phone needs: the core (hub connection, library copy) and the thumbnails. A worker is its own
 * file and runs off the page: the thumbnail worker draws slides with the renderer's preset geometry and the core
 * worker holds the Stream Deck key renderer, so COMPACT_FORBIDDEN applies to the page's files, and a worker the
 * compact path loads or precaches must be one of these.
 */
export const COMPACT_WORKERS: readonly string[] = ['core.worker', 'thumb.worker'];

/**
 * What a phone must never download or precache: the canvas editor, the live view, Setup and the settings
 * pages, the output and control-surface services, the renderer's preset geometry and the import worker.
 * An entry is an app path (`views/...`, `services/...`, `workers/...`: under apps/operator/src), a package
 * path (`packages/...`) or a package name (`konva`: under node_modules); one ending in `/` is a folder.
 */
export const COMPACT_FORBIDDEN: readonly string[] = [
  'views/editor/EditorView.tsx',
  'views/editor/SlideCanvas.tsx',
  'views/editor/FloatingContextBar.tsx',
  'konva',
  'react-konva',
  'views/live/LiveView.tsx',
  'views/settings/',
  'views/setup/',
  'services/outputs.ts',
  'services/surfaces.ts',
  'services/programView.ts',
  'packages/surfaces/src/',
  'packages/renderer/src/geom/presets.gen.ts',
  'workers/import.worker.ts',
];

/** A source map's source without its leading `./` and `../` (and a virtual module's NUL). */
export function normalizeSource(source: string): string {
  return source
    .replaceAll('\\', '/')
    .replace(/^\0/, '')
    .replace(/^(?:\.\.?\/)+/, '');
}

/** Whether a source (as a source map lists it, or normalized) is one COMPACT_FORBIDDEN entry names. */
export function sourceMatches(source: string, entry: string): boolean {
  const s = normalizeSource(source);
  const dir = entry.endsWith('/');
  if (!entry.includes('/')) return s.includes(`node_modules/${entry}/`);
  const path = entry.startsWith('packages/') ? entry : `src/${entry}`;
  return dir ? s.startsWith(path) : s === path;
}

/** A built worker file (`<name>.worker-<hash>.js`) and its name (`core.worker`). */
export function workerName(file: string): string | undefined {
  const m = /([\w-]+\.worker)-[\w-]+\.js$/.exec(file);
  return m?.[1];
}

/** The first COMPACT_FORBIDDEN entry a source falls under, if any. */
export function forbiddenEntry(source: string): string | undefined {
  return COMPACT_FORBIDDEN.find((e) => sourceMatches(source, e));
}
