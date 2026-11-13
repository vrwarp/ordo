/**
 * The library's font faces for a PowerPoint parse (design/27 §15 M6 tables; the regroup's import core): a
 * table row is as tall as its text, measured with the faces the outputs' font resolver draws it with
 * (`@ordo/pptx-scene` `ParseOptions.fontFace`). One selection rule for the hub's pool task (`apps/hub/src/
 * pptx/faces.ts`, which reads face files lazily from disk) and the operator's import worker (which fetches
 * the faces a deck needs before it parses, `facesForDeck`), so both measure a table alike.
 *
 * - **Selection** (`faceSourceOf`): as the resolver does, a family is its library faces only: the converter
 *   asks for the metric substitute (Carlito for Calibri, ...), the script fallbacks and ordo's default face by
 *   name next. The slant asked for if the family has it, then the weight nearest the one asked for; faces of
 *   one family, weight and slant (Google Fonts' unicode-range subsets) are tried in turn for each character,
 *   their line metrics the first face's, a pair kerned by a face that has both characters.
 * - **What a deck needs** (`deckFaceNeeds`): only tables are measured today, so only a deck with a table
 *   needs faces: the families its parts name (`typeface` attributes of runs, themes and tables), their metric
 *   substitutes, the script fallbacks of the scripts its text uses (`SCRIPT_FALLBACK_FONTS`) and ordo's default
 *   face. Bounded: `FACE_LIMITS`.
 */
import { DEFAULT_FONT, SCRIPT_FALLBACK_FONTS } from '@ordo/domain/defaults.ts';
import { textScripts } from '@ordo/domain/readable.ts';
import type { FaceMetrics, FaceSource } from '@ordo/pptx-scene';
import { substituteOf } from '@ordo/pptx-scene/fontmap.ts';
import { metricsOfTables, tablesAt } from '@ordo/pptx-scene/metrics.ts';

export const FACE_LIMITS = {
  /** Faces listed in a task's input. */
  listed: 2_000,
  /** Files read per task (the hub's pool task, the browser's parse). */
  files: 64,
  /** One font file read at most. */
  fileBytes: 32 * 1024 * 1024,
  /** Bytes read per task. */
  bytes: 256 * 1024 * 1024,
} as const;

/** One library face: family, weight, italic, and its metrics when asked for (undefined: not readable). */
export type LibraryFace = {
  family: string;
  weight: number;
  italic: boolean;
  metrics: () => FaceMetrics | undefined;
};

/** A `FaceSource` over library faces (see the module comment). */
export function faceSourceOf(faces: readonly LibraryFace[]): FaceSource {
  const byFamily = new Map<string, LibraryFace[]>();
  for (const f of faces.slice(0, FACE_LIMITS.listed)) {
    const k = f.family.trim().toLowerCase();
    let list = byFamily.get(k);
    if (!list) byFamily.set(k, (list = []));
    list.push(f);
  }
  return (family, bold, italic) => {
    const list = byFamily.get(family.trim().toLowerCase());
    if (!list?.length) return undefined;
    const want = bold ? 700 : 400;
    // The slant asked for if the family has it, then the weight nearest the one asked for.
    const slant = list.some((f) => f.italic === italic) ? list.filter((f) => f.italic === italic) : list;
    let best = Number.POSITIVE_INFINITY;
    for (const f of slant) best = Math.min(best, Math.abs(f.weight - want));
    const found = slant
      .filter((f) => Math.abs(f.weight - want) === best)
      .map((f) => f.metrics())
      .filter((m): m is FaceMetrics => m !== undefined);
    if (!found.length) return undefined;
    if (found.length === 1) return found[0];
    // Subsets of one face: a character from the first that has it; the line metrics are the first face's
    // (the subsets of one family share them), and a pair's kerning is that of a face that has both.
    const first = found[0]!;
    return {
      advance: (cp) => {
        for (const m of found) {
          const a = m.advance(cp);
          if (a !== undefined) return a;
        }
        return undefined;
      },
      ...(first.lineHeight !== undefined ? { lineHeight: first.lineHeight } : {}),
      ...(first.ascent !== undefined ? { ascent: first.ascent } : {}),
      ...(first.descent !== undefined ? { descent: first.descent } : {}),
      kern: (l, r) => {
        for (const m of found)
          if (m.advance(l) !== undefined && m.advance(r) !== undefined) return m.kern?.(l, r) ?? 0;
        return 0;
      },
    };
  };
}

/** XML parts a deck's text and fonts are named in. */
const TEXT_PART =
  /^ppt\/(slides|slideLayouts|slideMasters|theme|tableStyles|notesSlides)\b.*\.xml$|^ppt\/tableStyles\.xml$/i;
/** `typeface="…"` of `a:latin`, `a:ea`, `a:cs`, `a:sym`, `a:font` (themes) and `a:buFont`. */
const TYPEFACE = /\btypeface="([^"]{1,200})"/g;
const TABLE = /<a:tbl[\s>]/;
/** Text runs' contents (for the scripts the deck writes in). */
const RUN_TEXT = /<a:t>([^<]{1,5000})<\/a:t>/g;
/** Families and characters looked at, at most. */
const MAX_FAMILIES = 256;
const MAX_TEXT_CHARS = 2_000_000;

/** What a deck needs measured (see the module comment): undefined when it has no table. */
export function deckFaceNeeds(parts: ReadonlyMap<string, Uint8Array>): Set<string> | undefined {
  const decoder = new TextDecoder();
  let tables = false;
  const families = new Set<string>();
  let text = '';
  for (const [path, bytes] of parts) {
    if (!bytes.length || !TEXT_PART.test(path)) continue;
    const xml = decoder.decode(bytes);
    if (!tables && /^ppt\/slides\//i.test(path) && TABLE.test(xml)) tables = true;
    for (const m of xml.matchAll(TYPEFACE)) {
      const f = m[1]!.trim();
      // Theme references (+mj-lt, +mn-ea …) name no family: the theme's own typefaces are listed anyway.
      if (f && !f.startsWith('+') && families.size < MAX_FAMILIES) families.add(f);
    }
    if (text.length < MAX_TEXT_CHARS && /^ppt\/slides\//i.test(path))
      for (const m of xml.matchAll(RUN_TEXT)) {
        text += m[1]!;
        if (text.length >= MAX_TEXT_CHARS) break;
      }
  }
  if (!tables) return undefined;
  const out = new Set<string>();
  for (const f of families) {
    out.add(f);
    const sub = substituteOf(f);
    if (sub) out.add(sub);
  }
  for (const code of textScripts(text)) for (const f of SCRIPT_FALLBACK_FONTS[code] ?? []) out.add(f);
  out.add(DEFAULT_FONT);
  return out;
}

/** A library face the operator can fetch: its family, weight, slant and file URL. */
export type FaceFile = { family: string; weight: number; italic: boolean; url: string };

/**
 * The faces of `library` a deck needs (`needs`, lower-cased compare), at most `FACE_LIMITS.files`, in
 * library order.
 */
export function facesForDeck(needs: ReadonlySet<string>, library: readonly FaceFile[]): FaceFile[] {
  const want = new Set([...needs].map((f) => f.trim().toLowerCase()));
  const out: FaceFile[] = [];
  for (const f of library.slice(0, FACE_LIMITS.listed)) {
    if (!want.has(f.family.trim().toLowerCase())) continue;
    out.push(f);
    if (out.length >= FACE_LIMITS.files) break;
  }
  return out;
}

/** Whether `bytes` are a font file the browser's parse reads itself (TrueType or OpenType, a collection). */
export function sfntReadable(bytes: Uint8Array): boolean {
  const tag = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  return tag === '\u0000\u0001\u0000\u0000' || tag === 'OTTO' || tag === 'true' || tag === 'ttcf';
}

/**
 * The largest table a face is measured with, as the hub reads one (`apps/hub/src/fonts/sfnt.ts`
 * `FONT_LIMITS.maxTableBytes`): an `OS/2`, `GPOS` or `kern` table past it is left out (the face is measured
 * without it), a larger required table makes the face unreadable. The same on both sides, so a large CJK
 * face kerns alike.
 */
export const FACE_TABLE_MAX_BYTES = 4 * 1024 * 1024;
const OPTIONAL_TABLES = new Set(['OS/2', 'GPOS', 'kern']);

/** A TrueType or OpenType face's metrics (the first face of a collection) as the hub reads them. */
export function sfntFaceMetrics(bytes: Uint8Array): FaceMetrics | undefined {
  try {
    if (!sfntReadable(bytes)) return undefined;
    const ttc = bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66;
    const at = ttc ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12) : 0;
    const t = tablesAt(bytes, at);
    if (!t) return undefined;
    for (const tag of ['head', 'hhea', 'hmtx', 'cmap'])
      if ((t(tag)?.length ?? 0) > FACE_TABLE_MAX_BYTES) return undefined;
    return metricsOfTables((tag) => {
      const v = t(tag);
      return v && OPTIONAL_TABLES.has(tag) && v.length > FACE_TABLE_MAX_BYTES ? undefined : v;
    });
  } catch {
    return undefined;
  }
}

/** Thrown when a deck's table needs a face the browser's parse cannot read: the hub parses that deck. */
export class FaceUnreadable extends Error {}

/**
 * The faces a deck needs (`deckFaceNeeds`), fetched (`get`: the operator's import worker fetches the library's
 * files from the hub) and read as the hub reads them (`sfntFaceMetrics`), within `FACE_LIMITS`: a
 * `FaceSource`, or undefined for a deck without a table. A needed face that is not TrueType or OpenType (a
 * WOFF or WOFF2 file, which the hub decompresses and a browser cannot measure from) throws `FaceUnreadable`,
 * so that deck is parsed on the hub and measured as there; a face that cannot be fetched is missing, as a
 * file the hub cannot read.
 */
export async function loadDeckFaces(
  parts: ReadonlyMap<string, Uint8Array>,
  library: readonly FaceFile[],
  get: (url: string) => Promise<Uint8Array | undefined>,
): Promise<FaceSource | undefined> {
  const needs = deckFaceNeeds(parts);
  if (!needs) return undefined;
  const faces: LibraryFace[] = [];
  let bytes = 0;
  for (const f of facesForDeck(needs, library)) {
    let b: Uint8Array | undefined;
    try {
      b = await get(f.url);
    } catch {
      b = undefined;
    }
    if (!b || b.length > FACE_LIMITS.fileBytes || bytes + b.length > FACE_LIMITS.bytes) continue;
    bytes += b.length;
    if (!sfntReadable(b))
      throw new FaceUnreadable(
        `a table uses ${f.family.slice(0, 100)}, whose font file only the hub can measure`,
      );
    const m = sfntFaceMetrics(b);
    faces.push({ family: f.family, weight: f.weight, italic: f.italic, metrics: () => m });
  }
  return faceSourceOf(faces);
}
