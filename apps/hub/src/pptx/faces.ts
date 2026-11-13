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
import { FACE_LIMITS, faceSourceOf, type LibraryFace } from '@ordo/importers/pptx-faces.ts';
import { type FaceMetrics, type FaceSource, metricsOfTables } from '@ordo/pptx-scene';
import { metricTables } from '../fonts/sfnt.ts';

// The selection rule is the import core's (`@ordo/importers` `pptx-faces.ts`), which the operator's import
// worker shares; reading the files lazily from disk is the hub's.
export { FACE_LIMITS };

/** A library face for the worker: family, weight, italic, the file's absolute path. */
export type SceneFontFile = [family: string, weight: number, italic: boolean, file: string];

/** The library's faces as the task's input (`SceneTaskInput.fonts`), at most `FACE_LIMITS.listed`. */
export function sceneFontFiles(fonts: readonly Font[], abs: (path: string) => string): SceneFontFile[] {
  const out: SceneFontFile[] = [];
  for (const f of fonts) {
    if (out.length >= FACE_LIMITS.listed) break;
    out.push([f.family.slice(0, 300), f.weight, f.style === 'italic', abs(f.file.path)]);
  }
  return out;
}

/** A `FaceSource` over the listed files, each read when a table first asks for its face (see the header). */
export function libraryFaces(files: readonly SceneFontFile[]): FaceSource {
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
  const faces: LibraryFace[] = files
    .slice(0, FACE_LIMITS.listed)
    .map(([family, weight, italic, file]) => ({ family, weight, italic, metrics: () => metricsOf(file) }));
  return faceSourceOf(faces);
}
