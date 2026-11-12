import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { extractZip } from '@ordo/importers/zip-stream.ts';
import { run } from '../../../apps/hub/src/media/tools.ts';

export type SampleDeckEntry = {
  name: string;
  proPath: string;
  proBytes: Uint8Array;
  refDir: string;
  refPngPaths: string[];
};

export type ExtractedSampleBundle = {
  files: Map<string, Uint8Array>;
  onDisk: Map<string, string>;
  decks: SampleDeckEntry[];
};

type ManifestEntry = {
  path: string;
  spilled: boolean;
  diskPath?: string;
};

type BundleManifest = {
  zipPath: string;
  size: number;
  mtimeMs: number;
  entries: ManifestEntry[];
};

function normalizeStem(name: string): string {
  return name
    .replace(/\.pro$/i, '')
    .replace(/[:/]/g, '_')
    .trim()
    .toLowerCase();
}

const STATIC_RASTER_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

export async function prepareMediaPoster(
  mediaFilePath: string,
  cacheDir: string,
  opts?: { timeSec?: number },
): Promise<string> {
  if (STATIC_RASTER_EXT.test(mediaFilePath)) {
    return mediaFilePath;
  }
  if (!VIDEO_EXT.test(mediaFilePath)) {
    return mediaFilePath;
  }

  const timeSec = opts?.timeSec ?? 0;
  const hash = createHash('sha256').update(`${mediaFilePath}@${timeSec}`).digest('hex');
  const postersDir = join(cacheDir, 'posters');
  const outPng = join(postersDir, `${hash}.png`);

  try {
    const st = await stat(outPng);
    if (st.size > 0) return outPng;
  } catch {
    // cached poster doesn't exist yet
  }

  await mkdir(postersDir, { recursive: true });

  let ok = false;
  try {
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(timeSec),
        '-i',
        mediaFilePath,
        '-frames:v',
        '1',
        '-y',
        outPng,
      ],
      { timeoutMs: 60_000 },
    );
    const st = await stat(outPng);
    if (st.size > 0) ok = true;
  } catch {
    // Retry at 0
  }

  if (!ok && timeSec > 0) {
    await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-ss', '0', '-i', mediaFilePath, '-frames:v', '1', '-y', outPng],
      { timeoutMs: 60_000 },
    );
  }

  return outPng;
}

export async function loadSampleBundle(sampleDir: string, cacheDir: string): Promise<ExtractedSampleBundle> {
  const dirEntries = await readdir(sampleDir, { withFileTypes: true });
  const bundleFile = dirEntries.find((d) => d.isFile() && /\.(proplaylist|probundle)$/i.test(d.name));
  if (!bundleFile) {
    throw new Error(`No .proPlaylist or .probundle file found in ${sampleDir}`);
  }

  const zipPath = join(sampleDir, bundleFile.name);
  const zipStat = await stat(zipPath);

  const bundleDir = join(cacheDir, 'bundle');
  const docsDir = join(bundleDir, 'docs');
  const manifestPath = join(bundleDir, '.manifest.json');
  await mkdir(bundleDir, { recursive: true });

  const files = new Map<string, Uint8Array>();
  const onDisk = new Map<string, string>();

  let loadedFromCache = false;
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as BundleManifest;
    if (
      manifest.zipPath === zipPath &&
      manifest.size === zipStat.size &&
      manifest.mtimeMs === zipStat.mtimeMs
    ) {
      for (const ent of manifest.entries) {
        if (ent.spilled) {
          files.set(ent.path, new Uint8Array(0));
          if (ent.diskPath) onDisk.set(ent.path, ent.diskPath);
        } else {
          const bytes = ent.diskPath ? await readFile(ent.diskPath) : new Uint8Array(0);
          files.set(ent.path, bytes);
        }
      }
      loadedFromCache = true;
    }
  } catch {
    // cache miss or corrupt manifest
  }

  if (!loadedFromCache) {
    files.clear();
    onDisk.clear();
    await mkdir(docsDir, { recursive: true });

    const extracted = await extractZip(zipPath, {
      dir: bundleDir,
      spill: (path: string) => {
        const lower = path.toLowerCase();
        return !lower.endsWith('.pro') && basename(lower) !== 'data';
      },
    });

    const manifestEntries: ManifestEntry[] = [];
    let docIdx = 0;

    for (const [path, bytes] of extracted.files) {
      const diskPath = extracted.onDisk.get(path);
      if (diskPath) {
        // Spilled entry
        files.set(path, new Uint8Array(0));
        onDisk.set(path, diskPath);
        manifestEntries.push({ path, spilled: true, diskPath });
      } else {
        // In-memory entry (.pro or data): save to docsDir for quick re-loading
        const savedDocPath = join(docsDir, `doc-${++docIdx}.bin`);
        await writeFile(savedDocPath, bytes);
        files.set(path, bytes);
        manifestEntries.push({ path, spilled: false, diskPath: savedDocPath });
      }
    }

    const manifest: BundleManifest = {
      zipPath,
      size: zipStat.size,
      mtimeMs: zipStat.mtimeMs,
      entries: manifestEntries,
    };
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  }

  // Match each .pro entry in files to its sibling reference folder in sampleDir
  const subdirs = dirEntries.filter((d) => d.isDirectory());
  const dirByNorm = new Map<string, string>();
  for (const d of subdirs) {
    dirByNorm.set(normalizeStem(d.name), d.name);
  }

  const decks: SampleDeckEntry[] = [];
  for (const [proPath, proBytes] of files) {
    if (!proPath.toLowerCase().endsWith('.pro')) continue;
    const proStem = basename(proPath).replace(/\.pro$/i, '');
    const proNorm = normalizeStem(proStem);
    const matchedDirName = dirByNorm.get(proNorm);
    if (!matchedDirName) continue;

    const refDir = join(sampleDir, matchedDirName);
    const refEntries = await readdir(refDir, { withFileTypes: true });
    const refPngPaths = refEntries
      .filter((e) => e.isFile() && /^\d+\.png$/i.test(e.name))
      .map((e) => join(refDir, e.name))
      .sort((a, b) => {
        const numA = Number.parseInt(basename(a).replace(/\.png$/i, ''), 10);
        const numB = Number.parseInt(basename(b).replace(/\.png$/i, ''), 10);
        return numA - numB;
      });

    decks.push({
      name: proStem,
      proPath,
      proBytes,
      refDir,
      refPngPaths,
    });
  }

  decks.sort((a, b) => a.name.localeCompare(b.name));

  return { files, onDisk, decks };
}
