/**
 * The hub's script faces from its own computer (design/27 §15 "Korean and other scripts' cells", sub-wave 1c
 * rule H): where the font library has no face for a script drawn glyph by glyph (Han, Hiragana, Katakana,
 * Hangul: `@ordo/pptx-scene` tables.ts `GLYPH_SCRIPTS`, the only scripts `FaceSource.script` is asked for), a
 * table cell in it is measured with the face this computer's font configuration gives for a letter of the
 * script: the face LibreOffice and a browser on this computer fall back to (probed: LibreOffice 24.2 draws
 * Hangul, Han and Kana in the face `fc-match :charset=<letter>` names, its lines that face's height apart).
 * Measuring only: nothing is stored or drawn with it; the outputs draw with their own faces. The library's face
 * always wins (`faces.ts`); no face found is today's estimate.
 *
 * - **Once, at start, awaited** (`SystemFaces`): the resolution starts when the hub starts (`ImportService`),
 *   one `fc-match` per script, in parallel, never on a request and never for a deck; `ready` settles within
 *   `SYSTEM_FACES_MS` (10 s) whatever happens (then: no system face, logged), and every job that builds a
 *   `pptx-scene` input (imports, re-imports, Reset slide: `nativeJob.ts` `batchCall`) and the client-scene
 *   check (`clientScene.ts`) awaits it, so a deck imported during start-up is stored as one imported later.
 * - **fc-match by absolute path** (`FC_MATCH_PATHS`), never through PATH (a hub without LibreOffice may have only
 *   the lite tools there); `execFile`, 10 s, the letter's code point the only argument that varies.
 * - **Checked**: a face is kept only when its file fits `FACE_LIMITS.fileBytes` and it maps the letter, read
 *   with `@ordo/pptx-scene`'s `sfntMetrics(bytes, index)`, which reads a TrueType collection at its index
 *   (WenQuanYi Zen Hei is one; the hub's own `fonts/sfnt.ts` `metricTables` refuses collections).
 * - **An explicit dependency** (`HubConfig.systemFaces`): production asks fontconfig; the hub's test helpers
 *   give none (`noSystemFaces`), so a hub test means the same on every computer; a test injects its own.
 *
 * The project's hub image has no CJK face (fonts-noto-core): there nothing is found and the cells are measured
 * by estimate, as before (owner question Q1c-2).
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { Font } from '@ordo/domain';
import { SCRIPT_FALLBACK_FONTS } from '@ordo/domain/defaults.ts';
import { FACE_LIMITS } from '@ordo/importers/pptx-faces.ts';
import { sfntMetrics } from '@ordo/pptx-scene';
import { errorMessage } from '../errors.ts';
import { logSafe } from './report.ts';

/** The scripts a system face is looked for, each with the letter fontconfig is asked to cover. */
export const SYSTEM_FACE_SCRIPTS: Readonly<Record<string, number>> = {
  Hani: 0x4e00,
  Hira: 0x3042,
  Kana: 0x30a2,
  Hang: 0xac00,
};

/** The scripts' names in the job log. */
export const SCRIPT_NAMES: Readonly<Record<string, string>> = {
  Hani: 'Han',
  Hira: 'Hiragana',
  Kana: 'Katakana',
  Hang: 'Hangul',
};

/** A face found for a script: the script, the font file's absolute path, its index in a collection. */
export type SystemScriptFace = [script: string, file: string, index: number];

/** fc-match, looked for at these absolute paths in turn (never through PATH). */
export const FC_MATCH_PATHS: readonly string[] = [
  '/usr/bin/fc-match',
  '/usr/local/bin/fc-match',
  '/opt/homebrew/bin/fc-match',
];

/** One fc-match may take this long, and the whole resolution too: then no system face, logged. */
export const SYSTEM_FACES_MS = 10_000;

/** One script's face as this computer's font configuration gives it, or undefined. Never rejects. */
export type SystemFaceLookup = (
  script: string,
  letter: number,
) => Promise<{ file: string; index: number } | undefined>;

/** No system face (the hub's test helpers' default). */
export const noSystemFaces: SystemFaceLookup = async () => undefined;

/**
 * fontconfig's face for a letter (`fc-match -f '%{file}\t%{index}' :charset=<hex>`), fc-match found at the
 * first of `paths` that is an executable file (`FC_MATCH_PATHS`). Undefined when there is no fc-match, it
 * fails or takes longer than `timeoutMs`, or its answer is not an absolute file and an index.
 */
export function fontconfigLookup(
  o: { paths?: readonly string[]; timeoutMs?: number } = {},
): SystemFaceLookup {
  let found: Promise<string | undefined> | undefined;
  const find = async (): Promise<string | undefined> => {
    for (const p of o.paths ?? FC_MATCH_PATHS) {
      if (!isAbsolute(p)) continue;
      try {
        await access(p, constants.X_OK);
        if ((await stat(p)).isFile()) return p;
      } catch {
        /* not here */
      }
    }
    return undefined;
  };
  return async (_script, letter) => {
    found ??= find();
    const exe = await found;
    if (!exe || !Number.isInteger(letter) || letter < 0 || letter > 0x10ffff) return undefined;
    const out = await new Promise<string>((done) => {
      execFile(
        exe,
        ['-f', '%{file}\t%{index}', `:charset=${letter.toString(16)}`],
        {
          timeout: o.timeoutMs ?? SYSTEM_FACES_MS,
          maxBuffer: 64 * 1024,
          encoding: 'utf8',
          windowsHide: true,
        },
        (err, stdout) => done(err ? '' : stdout),
      );
    });
    const [file, index] = out.trim().split('\t');
    if (!file || !isAbsolute(file) || file.includes('\0')) return undefined;
    const i = Number(index ?? '0');
    return { file, index: Number.isInteger(i) && i >= 0 && i < 0x10000 ? i : 0 };
  };
}

type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

/**
 * A face kept only when its file fits `FACE_LIMITS.fileBytes` and maps `letter` (`sfntMetrics` at `index`, a
 * collection's face included). Never throws.
 */
export async function checkSystemFace(file: string, index: number, letter: number): Promise<boolean> {
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > FACE_LIMITS.fileBytes) return false;
    const m = sfntMetrics(new Uint8Array(await readFile(file)), index);
    return m?.advance(letter) !== undefined;
  } catch {
    return false;
  }
}

/** The script faces of this hub's computer, resolved once at start (see the module comment). */
export class SystemFaces {
  /** The faces found (checked); settles within `timeoutMs` of the start, never rejects. */
  readonly ready: Promise<readonly SystemScriptFace[]>;

  constructor(lookup: SystemFaceLookup, log: Log, o: { timeoutMs?: number } = {}) {
    const ms = o.timeoutMs ?? SYSTEM_FACES_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((done) => {
      timer = setTimeout(() => done('late'), ms);
      timer.unref?.();
    });
    const resolved = SystemFaces.resolve(lookup).catch((e: unknown) => {
      log.warn({ err: errorMessage(e) }, 'system faces: the lookup failed: none is used');
      return [] as SystemScriptFace[];
    });
    this.ready = Promise.race([resolved, late]).then((r) => {
      clearTimeout(timer);
      if (r === 'late') {
        log.warn(
          { ms },
          `system faces: this computer's font configuration did not answer within ${ms / 1000} s: table cells in Chinese, Japanese and Korean the font library has no face for are measured by estimate`,
        );
        return [];
      }
      log.info(
        { faces: r.map(([s, f, i]) => `${s} ${basename(f)}${i ? `#${i}` : ''}`) },
        r.length
          ? `system faces: ${r.map(([s, f]) => `${SCRIPT_NAMES[s] ?? s} ${logSafe(basename(f), 100)}`).join(', ')} (table cells in a script the font library has no face for are measured with them)`
          : 'system faces: none (table cells in Chinese, Japanese and Korean the font library has no face for are measured by estimate)',
      );
      return r;
    });
  }

  /** Each script's face, looked up in parallel and checked; the scripts in `SYSTEM_FACE_SCRIPTS`'s order. */
  private static async resolve(lookup: SystemFaceLookup): Promise<SystemScriptFace[]> {
    const found = await Promise.all(
      Object.entries(SYSTEM_FACE_SCRIPTS).map(
        async ([script, letter]): Promise<SystemScriptFace | undefined> => {
          const got = await lookup(script, letter).catch(() => undefined);
          if (!got || !isAbsolute(got.file)) return undefined;
          const index = Number.isInteger(got.index) && got.index >= 0 ? got.index : 0;
          return (await checkSystemFace(got.file, index, letter)) ? [script, got.file, index] : undefined;
        },
      ),
    );
    return found.filter((f): f is SystemScriptFace => f !== undefined);
  }
}

/**
 * The scripts of `faces` the library has no face for (none of the script's fallback families,
 * `SCRIPT_FALLBACK_FONTS`, is a library family): those a table cell is measured in with this computer's face.
 * Read from the library's list, no file opened.
 */
export function systemOnlyScripts(
  faces: readonly SystemScriptFace[],
  library: readonly Pick<Font, 'family'>[],
): string[] {
  const families = new Set(library.map((f) => f.family.trim().toLowerCase()));
  const out: string[] = [];
  for (const [script] of faces) {
    if (out.includes(script)) continue;
    const fallbacks = SCRIPT_FALLBACK_FONTS[script] ?? [];
    if (!fallbacks.some((f) => families.has(f.toLowerCase()))) out.push(script);
  }
  return out;
}
