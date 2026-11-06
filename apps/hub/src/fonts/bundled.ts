/**
 * The fonts ordo bundles (design/27 §10): metric-compatible substitutes for the common Office families, the
 * script fallback faces every output receives whatever the playlist, and Inter, ordo's default font.
 *
 * - The faces come from Debian packages the image installs (Dockerfile): fonts-crosextra-carlito,
 *   fonts-crosextra-caladea, fonts-liberation2, fonts-noto-core and fonts-inter, all under the SIL Open
 *   Font License 1.1 (LICENSES.md here records each face, its package and copyright; the image keeps the
 *   packages' copyright files). LibreOffice draws the art and picture slides with the same files, so its
 *   metrics match ordo's.
 * - At start the hub registers them from `ORDO_FONTS_DIR` (the image sets /usr/share/fonts) as library
 *   `Font` rows with `source: 'bundled'`, idempotently by SHA-256: an unchanged file changes nothing, a
 *   changed one (a newer image) replaces the row's file. A face the library already has from an upload or
 *   Google Fonts (same family, weight, style and range) is left alone: the venue's own face wins. Bundled
 *   rows of faces no longer listed here are removed. Nothing is downloaded.
 * - The family names are the ones the converter's `fallbackFonts` and `SCRIPT_FALLBACK_FONTS` name.
 * - Script faces carry their script's `unicodeRange`, so a script fallback listed before a deck's own family
 *   never draws that family's Latin text. Noto Sans has none: it is also a family people pick for Latin.
 * - Not bundled: Liberation Sans Narrow (only Liberation 1.x has it, under the GPL with a font exception),
 *   Gelasio and the Noto CJK families (Google Fonts, on demand; goLive ships CJK faces only with text that
 *   needs them, `isOnDemandFontFamily`).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type Font, isOnDemandFontFamily, type Look, referencedFontFamilies } from '@ordo/domain';
import type { Logger } from 'pino';
import type { Change, Library } from '../library.ts';
import { sniff, type Store } from '../store.ts';

/** What a face is for: ordo's default font, a metric substitute, or a script fallback. */
export type BundledRole = 'default' | 'substitute' | 'script';

export type BundledFace = {
  /** The library family: what text styles, `fallbackFonts` and `SCRIPT_FALLBACK_FONTS` name. */
  family: string;
  weight: 400 | 700;
  style: 'normal' | 'italic';
  /**
   * Where Debian (and Ubuntu) install it, relative to the fonts directory, preferred first. When none
   * exists, the first path's file name is looked up anywhere below the directory (other layouts, tests).
   */
  paths: readonly string[];
  role: BundledRole;
  /** The Office families it stands in for (substitutes) or the scripts it covers (ISO 15924 codes). */
  covers: readonly string[];
  /** CSS unicode-range of a script face (canonical form, as `normalizeUnicodeRange` writes it). */
  unicodeRange?: string;
  /** The Debian package that installs it (Dockerfile; LICENSES.md). */
  pkg: string;
};

/** Zero-width joiners and marks, and the dotted circle shown under a lone combining mark. */
const JOINERS = 'U+200C-200F,U+25CC';

/** Script ranges of the script faces (`BundledFace.unicodeRange`), canonical (sorted, merged). */
export const SCRIPT_RANGES = {
  Hebr: `U+591-5F4,${JOINERS},U+FB1D-FB4F`,
  Arab: `U+600-6FF,U+750-77F,U+8A0-8FF,${JOINERS},U+FB50-FDFF,U+FE70-FEFF`,
  Deva: `U+900-97F,U+1CD0-1CFF,${JOINERS},U+A830-A839,U+A8E0-A8FF`,
  Taml: `U+B82-BFA,${JOINERS}`,
  Thai: `U+E01-E5B,${JOINERS}`,
  Mymr: `U+1000-109F,${JOINERS},U+A9E0-A9FE,U+AA60-AA7F`,
} as const;

const STYLES = [
  ['Regular', 400, 'normal'],
  ['Italic', 400, 'italic'],
  ['Bold', 700, 'normal'],
  ['BoldItalic', 700, 'italic'],
] as const;

/** The four faces of a family (or the first `n`: regular and bold) from its file name stem. */
function faces(
  family: string,
  dirs: readonly string[],
  stem: string,
  ext: 'ttf' | 'otf',
  o: { role: BundledRole; covers: readonly string[]; pkg: string; unicodeRange?: string; upright?: boolean },
): BundledFace[] {
  return STYLES.filter(([, , style]) => !o.upright || style === 'normal').map(([name, weight, style]) => ({
    family,
    weight,
    style,
    paths: dirs.map((d) => `${d}/${stem}-${name}.${ext}`),
    role: o.role,
    covers: o.covers,
    pkg: o.pkg,
    ...(o.unicodeRange ? { unicodeRange: o.unicodeRange } : {}),
  }));
}

const CROSEXTRA = ['truetype/crosextra'];
const LIBERATION = ['truetype/liberation2', 'truetype/liberation'];
const NOTO = ['truetype/noto'];

/** Every bundled face (design/27 §10 table). */
export const BUNDLED_FACES: readonly BundledFace[] = [
  ...faces('Inter', ['opentype/inter'], 'Inter', 'otf', { role: 'default', covers: [], pkg: 'fonts-inter' }),
  ...faces('Carlito', CROSEXTRA, 'Carlito', 'ttf', {
    role: 'substitute',
    covers: ['Calibri', 'Calibri Light'],
    pkg: 'fonts-crosextra-carlito',
  }),
  ...faces('Caladea', CROSEXTRA, 'Caladea', 'ttf', {
    role: 'substitute',
    covers: ['Cambria'],
    pkg: 'fonts-crosextra-caladea',
  }),
  ...faces('Liberation Sans', LIBERATION, 'LiberationSans', 'ttf', {
    role: 'substitute',
    covers: ['Arial', 'Helvetica'],
    pkg: 'fonts-liberation2',
  }),
  ...faces('Liberation Serif', LIBERATION, 'LiberationSerif', 'ttf', {
    role: 'substitute',
    covers: ['Times New Roman', 'Times'],
    pkg: 'fonts-liberation2',
  }),
  ...faces('Liberation Mono', LIBERATION, 'LiberationMono', 'ttf', {
    role: 'substitute',
    covers: ['Courier New', 'Courier'],
    pkg: 'fonts-liberation2',
  }),
  ...faces('Noto Sans', NOTO, 'NotoSans', 'ttf', {
    role: 'script',
    covers: ['Latn', 'Grek', 'Cyrl'],
    pkg: 'fonts-noto-core',
  }),
  ...faces('Noto Sans Hebrew', NOTO, 'NotoSansHebrew', 'ttf', {
    role: 'script',
    covers: ['Hebr'],
    pkg: 'fonts-noto-core',
    unicodeRange: SCRIPT_RANGES.Hebr,
    upright: true,
  }),
  ...faces('Noto Naskh Arabic', NOTO, 'NotoNaskhArabic', 'ttf', {
    role: 'script',
    covers: ['Arab'],
    pkg: 'fonts-noto-core',
    unicodeRange: SCRIPT_RANGES.Arab,
    upright: true,
  }),
  ...faces('Noto Sans Devanagari', NOTO, 'NotoSansDevanagari', 'ttf', {
    role: 'script',
    covers: ['Deva'],
    pkg: 'fonts-noto-core',
    unicodeRange: SCRIPT_RANGES.Deva,
    upright: true,
  }),
  ...faces('Noto Sans Tamil', NOTO, 'NotoSansTamil', 'ttf', {
    role: 'script',
    covers: ['Taml'],
    pkg: 'fonts-noto-core',
    unicodeRange: SCRIPT_RANGES.Taml,
    upright: true,
  }),
  ...faces('Noto Sans Thai', NOTO, 'NotoSansThai', 'ttf', {
    role: 'script',
    covers: ['Thai'],
    pkg: 'fonts-noto-core',
    unicodeRange: SCRIPT_RANGES.Thai,
    upright: true,
  }),
  ...faces('Noto Sans Myanmar', NOTO, 'NotoSansMyanmar', 'ttf', {
    role: 'script',
    covers: ['Mymr'],
    pkg: 'fonts-noto-core',
    unicodeRange: SCRIPT_RANGES.Mymr,
    upright: true,
  }),
];

/** The bundled family standing in for an Office family (case-insensitive), or undefined. */
export function bundledSubstitute(family: string): string | undefined {
  const k = family.trim().toLowerCase();
  return BUNDLED_FACES.find((f) => f.role === 'substitute' && f.covers.some((c) => c.toLowerCase() === k))
    ?.family;
}

/**
 * The fonts an output receives through its config, whatever the playlist (design/27 §10): every library
 * face (so Inter, the substitutes and the script fallbacks are cached on every output, which never falls back
 * to its operating system's fonts glyph by glyph) except the CJK fallback families, which goLive ships only
 * with text that needs them, unless a look's text style names them.
 */
export function outputFonts(fonts: readonly Font[], looks: readonly Look[] = []): Font[] {
  const named = new Set([...referencedFontFamilies([], [...looks])].map((f) => f.trim().toLowerCase()));
  return fonts.filter((f) => !isOnDemandFontFamily(f.family) || named.has(f.family.trim().toLowerCase()));
}

/** Largest bundled file read (the upload limit). */
const MAX_FONT_BYTES = 50 * 1024 * 1024;
/** Bounds of the file-name search below the fonts directory. */
const SEARCH = { depth: 6, entries: 50_000 };

const keyOf = (f: { family: string; weight: number; style: string; unicodeRange?: string }) =>
  `${f.family}\u0000${f.weight}\u0000${f.style}\u0000${f.unicodeRange ?? ''}`;

const label = (f: BundledFace) => `${f.family} ${f.weight}${f.style === 'italic' ? ' italic' : ''}`;

export type BundledResult = {
  /** Rows written: new faces and faces whose file changed. */
  registered: number;
  unchanged: number;
  /** Faces the library already has from an upload or Google Fonts (left as they are). */
  kept: number;
  /** Bundled rows removed because their face is no longer bundled. */
  removed: number;
  /** Faces whose file is not installed below the directory ('Family 400 italic'). */
  missing: string[];
};

/** Is `p` a regular file within the size bound? */
async function usable(p: string): Promise<boolean> {
  const s = await stat(p).catch(() => undefined);
  return !!s?.isFile() && s.size > 0 && s.size <= MAX_FONT_BYTES;
}

/** File names (lower case) below `dir` → first path, breadth first, bounded; symlinked folders not followed. */
async function indexByName(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let level = [dir];
  let seen = 0;
  for (let depth = 0; depth < SEARCH.depth && level.length; depth++) {
    const next: string[] = [];
    for (const d of level.sort()) {
      const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (++seen > SEARCH.entries) return out;
        const p = join(d, e.name);
        if (e.isDirectory()) next.push(p);
        else if (e.isFile() || e.isSymbolicLink()) {
          const k = e.name.toLowerCase();
          if (!out.has(k)) out.set(k, p);
        }
      }
    }
    level = next;
  }
  return out;
}

/** The installed file of each face, or undefined. */
async function locate(dir: string, list: readonly BundledFace[]): Promise<(string | undefined)[]> {
  const found: (string | undefined)[] = [];
  let index: Map<string, string> | undefined;
  for (const face of list) {
    let hit: string | undefined;
    for (const rel of face.paths) {
      const p = join(dir, rel);
      if (await usable(p)) {
        hit = p;
        break;
      }
    }
    if (!hit && face.paths[0]) {
      index ??= await indexByName(dir);
      const p = index.get(basename(face.paths[0]).toLowerCase());
      if (p && (await usable(p))) hit = p;
    }
    found.push(hit);
  }
  return found;
}

/**
 * Register the bundled faces installed below `dir` as library fonts (see the file comment). Idempotent;
 * never throws for a missing or unreadable file (it is reported in `missing`).
 */
export async function registerBundledFonts(
  dir: string,
  deps: { lib: Library; store: Store; log: Logger },
  list: readonly BundledFace[] = BUNDLED_FACES,
): Promise<BundledResult> {
  const { lib, store, log } = deps;
  const result: BundledResult = { registered: 0, unchanged: 0, kept: 0, removed: 0, missing: [] };
  const rows = new Map(lib.listFonts().map((f) => [keyOf(f), f]));
  const changes: Change[] = [];
  const release: string[] = [];
  const paths = await locate(dir, list);
  for (const [i, face] of list.entries()) {
    const path = paths[i];
    const row = rows.get(keyOf(face));
    if (row && row.source !== 'bundled') {
      result.kept++;
      continue;
    }
    let buf: Buffer | undefined;
    if (path) buf = await readFile(path).catch(() => undefined);
    const kind = buf ? sniff(buf) : undefined;
    if (!buf || kind?.kind !== 'font') {
      result.missing.push(label(face));
      continue;
    }
    const hash = createHash('sha256').update(buf).digest('hex');
    if (row?.file.hash === hash) {
      result.unchanged++;
      continue;
    }
    const file = await store.put(path!, {
      ext: kind.ext,
      mime: kind.mime,
      dir: 'fonts',
      hash,
      bytes: buf.length,
      copy: true,
    });
    const font = lib.upsertFont({
      family: face.family,
      weight: face.weight,
      style: face.style,
      file,
      source: 'bundled',
      ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
    });
    changes.push({ kind: 'font', id: font.id, entity: font });
    if (row) release.push(row.file.hash);
    result.registered++;
  }
  const listed = new Set(list.map(keyOf));
  for (const row of rows.values()) {
    if (row.source !== 'bundled' || listed.has(keyOf(row))) continue;
    lib.deleteFont(row.id);
    changes.push({ kind: 'font', id: row.id, deleted: true });
    release.push(row.file.hash);
    result.removed++;
  }
  if (changes.length) lib.emit(changes);
  for (const h of release) await store.release(h);
  log.info(
    {
      dir,
      registered: result.registered,
      unchanged: result.unchanged,
      kept: result.kept,
      removed: result.removed,
      missing: result.missing.length,
    },
    'bundled fonts',
  );
  if (result.missing.length)
    log.warn({ missing: result.missing.slice(0, 50) }, 'bundled fonts not installed');
  return result;
}
