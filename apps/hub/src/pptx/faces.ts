/**
 * The library's font faces for the `pptx-scene` pool task (design/27 §15 M6 tables): a table's cells are
 * measured (and, since M9 tables-conv, their lines spaced) with the faces the outputs' font resolver draws
 * them with (`@ordo/pptx-scene` `ParseOptions.fontFace`). The job lists the library's face files
 * (`sceneFontFiles`); the worker reads a file only when a table asks for its family (`libraryFaces`), at most
 * `FACE_LIMITS.files` files and `FACE_LIMITS.bytes` per task, each through `metricTables` (TTF, OTF, WOFF,
 * WOFF2) and `metricsOfTables`.
 *
 * As the resolver does, a family is its library faces only: `@ordo/pptx-scene` asks for the metric
 * substitute (Carlito for Calibri, ...) and ordo's default face by name next, and for a script none of a
 * run's faces has the script's face (`FaceSource.script`: the first of its fallback families the library has,
 * the import core's one rule, so the browser's parse spaces a Korean cell as this task does). Faces of one
 * family, weight and slant (Google Fonts' unicode-range subsets) are tried in turn for each character; their
 * line metrics are the first face's, and a pair is kerned by a face that has both characters.
 * `FACE_LIMITS.bytes` counts what a face keeps (its tables, decompressed) or its file, whichever is more.
 *
 * Sub-wave 1c (rule H, `systemFaces.ts`): for a script the library has no face for, `script(code)` answers this
 * computer's face for it when the hub found one at start (`SceneTaskInput.systemScriptFaces`): read with
 * `@ordo/pptx-scene`'s `sfntMetrics` at its collection index, once per pool worker (cached), counted in each
 * task's `FACE_LIMITS`, and used only when it maps the script's letter. The library's face always wins.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Font } from '@ordo/domain';
import { FACE_LIMITS, faceSourceOf, type LibraryFace } from '@ordo/importers/pptx-faces.ts';
import { type FaceMetrics, type FaceSource, metricsOfTables, sfntMetrics } from '@ordo/pptx-scene';
import { metricTables } from '../fonts/sfnt.ts';
import { mapsScript, SYSTEM_FACE_SCRIPTS, type SystemScriptFace } from './systemFaces.ts';

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

/**
 * This computer's script faces read in this pool worker (rule H), by file, index, size and change time: a
 * collection of 17 MB is read once per worker, not once per batch.
 */
const systemRead = new Map<string, FaceMetrics | undefined>();
/** System faces a worker keeps read at most (a hub resolves one per script: four). */
const SYSTEM_READ_MAX = 8;

/**
 * A `FaceSource` over the listed files, each read when a table first asks for its face (see the header), and,
 * for a script the library has no face for, this computer's face for it (`system`, rule H); each system face
 * a table was measured with is added to `used` (`'Hang wqy-zenhei.ttc'`).
 */
export function libraryFaces(
  files: readonly SceneFontFile[],
  system: readonly SystemScriptFace[] = [],
  used?: Set<string>,
): FaceSource {
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
  const source = faceSourceOf(faces);
  if (!system.length) return source;
  // Rule H: this computer's face for a script the library has none for, read once per worker, counted in
  // this task's limits, used only when it maps the script's common letters (`mapsScript`, as at start).
  const counted = new Set<string>();
  const systemOf = (code: string): FaceMetrics | undefined => {
    const letter = SYSTEM_FACE_SCRIPTS[code];
    const entry = system.find(([s]) => s === code);
    if (letter === undefined || !entry) return undefined;
    const [, file, index] = entry;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > FACE_LIMITS.fileBytes) return undefined;
      const key = `${file}\0${index}\0${st.size}\0${st.mtimeMs}`;
      if (!counted.has(key) && (filesRead >= FACE_LIMITS.files || bytesRead + st.size > FACE_LIMITS.bytes))
        return undefined;
      let m = systemRead.get(key);
      if (!systemRead.has(key)) {
        m = sfntMetrics(new Uint8Array(readFileSync(file)), index);
        if (systemRead.size >= SYSTEM_READ_MAX) systemRead.clear();
        systemRead.set(key, m);
      }
      if (!counted.has(key)) {
        counted.add(key);
        filesRead++;
        bytesRead += st.size;
      }
      if (!mapsScript(m, code)) return undefined;
      used?.add(`${code} ${basename(file)}`);
      return m;
    } catch {
      return undefined; // a file that cannot be read is no face
    }
  };
  const library = source.script;
  source.script = (code) => library?.(code) ?? systemOf(code);
  return source;
}
