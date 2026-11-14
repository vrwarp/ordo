import { COMPACT_LAZY, COMPACT_START, COMPACT_WORKERS } from '../pageSets.ts';

/**
 * The service worker's precache sets by device class (design/28 §3.1, design/17, ADR 0013 "Service worker
 * caching"): `all` is every built file (today's list, the venue PC, iPads and Android tablets); `compact` is
 * what a phone can open: the entry and its static imports, each lazy module of the compact path (pageSets.ts
 * COMPACT_LAZY and COMPACT_START) with its static imports, the core and thumbnail workers with the files they
 * load, and every file that is not script (index.html, the stylesheet). Pure: vite.config.ts feeds it Rollup's
 * bundle, the tests a fake one.
 */
export type SetChunk = {
  type: 'chunk';
  fileName: string;
  isEntry: boolean;
  isDynamicEntry: boolean;
  facadeModuleId: string | null;
  imports: readonly string[];
};
export type SetAsset = { type: 'asset'; fileName: string; source: string | Uint8Array };
export type SetBundle = Record<string, SetChunk | SetAsset>;

export type SetOptions = {
  /** The app's root (apps/operator): facade module ids are matched relative to it. */
  root: string;
  start?: readonly string[];
  lazy?: readonly string[];
  workers?: readonly string[];
};

const textOf = (a: SetAsset) =>
  typeof a.source === 'string' ? a.source : new TextDecoder().decode(a.source);

function rel(root: string, id: string): string {
  const r = root.replaceAll('\\', '/').replace(/\/$/, '');
  const p = id.replaceAll('\\', '/');
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : p;
}

/** Today's list: every emitted file but source maps and the worker itself, plus index.html. */
export function allFiles(bundle: SetBundle): string[] {
  const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'sw.js');
  if (!files.includes('index.html')) files.push('index.html');
  return files.sort();
}

/** The phone's list (see above). */
export function compactFiles(bundle: SetBundle, opts: SetOptions): string[] {
  const out = new Set<string>();
  const chunks = Object.values(bundle).filter((b): b is SetChunk => b.type === 'chunk');
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const closure = (c: SetChunk) => {
    const queue = [c.fileName];
    while (queue.length) {
      const f = queue.shift()!;
      if (out.has(f)) continue;
      out.add(f);
      for (const i of byName.get(f)?.imports ?? []) queue.push(i);
    }
  };
  const wanted = new Set([...(opts.start ?? COMPACT_START), ...(opts.lazy ?? COMPACT_LAZY)]);
  for (const c of chunks) {
    if (c.isEntry) closure(c);
    else if (c.isDynamicEntry && c.facadeModuleId && wanted.has(rel(opts.root, c.facadeModuleId))) closure(c);
  }
  // Workers are emitted as assets (Vite builds them on their own): a compact worker and the sibling files it
  // imports (a drawer it loads per object kind).
  const assets = new Map(
    Object.values(bundle)
      .filter((b): b is SetAsset => b.type === 'asset')
      .map((a) => [a.fileName, a]),
  );
  const workers = opts.workers ?? COMPACT_WORKERS;
  const queue = [...assets.keys()].filter((f) =>
    workers.some((w) => new RegExp(`(^|/)${w}-[\\w-]+\\.js$`).test(f)),
  );
  while (queue.length) {
    const f = queue.shift()!;
    if (out.has(f)) continue;
    out.add(f);
    const a = assets.get(f);
    if (!a || !f.endsWith('.js')) continue;
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
    for (const m of textOf(a).matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) {
      const sibling = dir + m[1];
      if (assets.has(sibling) || byName.has(sibling)) queue.push(sibling);
    }
  }
  for (const f of Object.keys(bundle))
    if (!f.endsWith('.js') && !f.endsWith('.map') && f !== 'sw.js') out.add(f);
  out.add('index.html');
  return [...out].sort();
}
