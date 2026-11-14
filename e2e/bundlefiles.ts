import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { forbiddenEntry, normalizeSource } from '../apps/operator/src/pageSets.ts';

/**
 * The operator's built files by what they hold (design/28 §8): each file of apps/operator/dist/assets (or of
 * `ORDO_APPS_DIR`'s operator build, the build the specs' hubs serve) with its sources from its `.map` and its
 * raw and gzip sizes, so a spec names sources ("views/settings/"), never a hashed file name.
 */
export type BuiltFile = { file: string; sources: string[]; raw: number; gzip: number };

export function operatorAssets(): string {
  return join(process.env.ORDO_APPS_DIR ?? 'apps', 'operator', 'dist', 'assets');
}

let cache: { dir: string; files: Map<string, BuiltFile> } | undefined;

/** Every built asset, keyed by file name. */
export function builtFiles(dir = operatorAssets()): Map<string, BuiltFile> {
  if (cache?.dir === dir) return cache.files;
  const files = new Map<string, BuiltFile>();
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.map')) continue;
    const body = readFileSync(join(dir, file));
    const map = join(dir, `${file}.map`);
    let sources: string[] = [];
    if (existsSync(map)) {
      try {
        sources = ((JSON.parse(readFileSync(map, 'utf8')).sources ?? []) as unknown[]).map((s) =>
          normalizeSource(String(s)),
        );
      } catch {
        sources = [];
      }
    }
    files.set(file, { file, sources, raw: body.length, gzip: gzipSync(body).length });
  }
  cache = { dir, files };
  return files;
}

/** The built asset a request URL fetched, if it is one (`.../assets/<file>`, query and hash aside). */
export function assetOf(url: string): BuiltFile | undefined {
  const m = /\/assets\/([^/?#]+)/.exec(new URL(url).pathname);
  return m ? builtFiles().get(decodeURIComponent(m[1]!)) : undefined;
}

/** Whether a built file holds a source: `needle` is a path suffix or folder (`views/settings/`). */
export function holds(f: BuiltFile, needle: string): boolean {
  return f.sources.some((s) => s.includes(needle));
}

/** The COMPACT_FORBIDDEN sources a built file holds, as `<entry> (<source>)`. */
export function forbiddenIn(f: BuiltFile): string[] {
  const out: string[] = [];
  for (const s of f.sources) {
    const e = forbiddenEntry(s);
    if (e) out.push(`${e} (${s})`);
  }
  return out;
}
