/**
 * The library's font faces for the `pptx-scene` pool task (design/27 §15 M6 tables): a table row is as tall
 * as its text, measured with the faces the outputs' font resolver draws it with (`@ordo/pptx-scene`
 * `ParseOptions.fontFace`). The job lists the library's face files (`sceneFontFiles`); the worker reads a
 * file only when a table asks for its family (`libraryFaces`), at most `FACE_LIMITS.files` files and
 * `FACE_LIMITS.bytes` per task, each through `metricTables` (TTF, OTF, WOFF, WOFF2) and `metricsOfTables`.
 *
 * As the resolver does, a family is its library faces only: `@ordo/pptx-scene` asks for the metric
 * substitute (Carlito for Calibri, ...) and ordo's default face by name next. Faces of one family, weight and
 * slant (Google Fonts' unicode-range subsets) are tried in turn for each character; their line metrics are
 * the first face's, and a pair is kerned by a face that has both characters. `FACE_LIMITS.bytes` counts
 * what a face keeps (its tables, decompressed) or its file, whichever is more.
 */
import { readFileSync, statSync } from 'node:fs';
import type { Font } from '@ordo/domain';
import { type FaceMetrics, type FaceSource, metricsOfTables } from '@ordo/pptx-scene';
import { metricTables } from '../fonts/sfnt.ts';

/** A library face for the worker: family, weight, italic, the file's absolute path. */
export type SceneFontFile = [family: string, weight: number, italic: boolean, file: string];

export const FACE_LIMITS = {
  /** Faces listed in a task's input. */
  listed: 2_000,
  /** Files read per task. */
  files: 64,
  /** One font file read at most. */
  fileBytes: 32 * 1024 * 1024,
  /** Bytes read per task. */
  bytes: 256 * 1024 * 1024,
} as const;

/** The library's faces as the task's input (`SceneTaskInput.fonts`), at most `FACE_LIMITS.listed`. */
export function sceneFontFiles(fonts: readonly Font[], abs: (path: string) => string): SceneFontFile[] {
  const out: SceneFontFile[] = [];
  for (const f of fonts) {
    if (out.length >= FACE_LIMITS.listed) break;
    out.push([f.family.slice(0, 300), f.weight, f.style === 'italic', abs(f.file.path)]);
  }
  return out;
}

/** A `FaceSource` over the listed files (see the module header). */
export function libraryFaces(files: readonly SceneFontFile[]): FaceSource {
  const byFamily = new Map<string, SceneFontFile[]>();
  for (const f of files.slice(0, FACE_LIMITS.listed)) {
    const k = f[0].trim().toLowerCase();
    let list = byFamily.get(k);
    if (!list) byFamily.set(k, (list = []));
    list.push(f);
  }
  const read = new Map<string, FaceMetrics | undefined>();
  let filesRead = 0;
  let bytesRead = 0;
  const metricsOf = (file: string): FaceMetrics | undefined => {
    if (read.has(file)) return read.get(file);
    let v: FaceMetrics | undefined;
    try {
      const size = statSync(file).size;
      if (
        filesRead < FACE_LIMITS.files &&
        size <= FACE_LIMITS.fileBytes &&
        bytesRead + size <= FACE_LIMITS.bytes
      ) {
        filesRead++;
        const tables = metricTables(readFileSync(file));
        // What the task keeps: the tables (copies, `metricTables`), a WOFF2's decompressed ones larger than
        // its file; the file itself when that is more.
        let held = 0;
        for (const t of tables.values()) held += t.length;
        bytesRead += Math.max(size, held);
        v = metricsOfTables((tag) => tables.get(tag));
      }
    } catch {
      v = undefined; // a file that cannot be read is no face
    }
    read.set(file, v);
    return v;
  };
  return (family, bold, italic) => {
    const list = byFamily.get(family.trim().toLowerCase());
    if (!list?.length) return undefined;
    const want = bold ? 700 : 400;
    // The slant asked for if the family has it, then the weight nearest the one asked for.
    const slant = list.some((f) => f[2] === italic) ? list.filter((f) => f[2] === italic) : list;
    let best = Number.POSITIVE_INFINITY;
    for (const f of slant) best = Math.min(best, Math.abs(f[1] - want));
    const faces = slant
      .filter((f) => Math.abs(f[1] - want) === best)
      .map((f) => metricsOf(f[3]))
      .filter((m): m is FaceMetrics => m !== undefined);
    if (!faces.length) return undefined;
    if (faces.length === 1) return faces[0];
    // Subsets of one face: a character from the first that has it; the line metrics are the first face's
    // (the subsets of one family share them), and a pair's kerning is that of a face that has both.
    const first = faces[0]!;
    return {
      advance: (cp) => {
        for (const m of faces) {
          const a = m.advance(cp);
          if (a !== undefined) return a;
        }
        return undefined;
      },
      ...(first.lineHeight !== undefined ? { lineHeight: first.lineHeight } : {}),
      ...(first.ascent !== undefined ? { ascent: first.ascent } : {}),
      ...(first.descent !== undefined ? { descent: first.descent } : {}),
      kern: (l, r) => {
        for (const m of faces)
          if (m.advance(l) !== undefined && m.advance(r) !== undefined) return m.kern?.(l, r) ?? 0;
        return 0;
      },
    };
  };
}
