import { DECOR_LIMITS, type DecorData, type DecorPart, GEOM_FILE_MAX_BYTES } from '@ordo/domain';
import { clampDecorParts } from './clamp.ts';

/*
 * Decoration files (design/27 M9, `DecorData.ref` → `DecorFile`; decor-render): the read files' store, small and
 * loaded with the renderer's index, as the geometry files' store is (`geom/stored.ts`), so the outputs' prepare
 * step and the editor canvas read a slide's decoration files without loading the drawer's own module
 * (`decor/index.ts`, loaded per kind by `loadShapeDrawers`). The drawer reads the parts from here.
 *
 * - **Put** (`putDecorFile`): a file's parsed JSON, its parts clamped as inline parts are (`clampDecorParts`,
 *   against the largest palette: a part naming a paint its decoration lacks is skipped where it is drawn);
 *   nothing drawable left is not kept.
 * - **Read** (`readDecorFiles`): the files a slide names that are not read yet, through the caller's reader
 *   (JSON text; undefined or a throw: unavailable for now; null or over `GEOM_FILE_MAX_BYTES`: invalid), reads
 *   of one ref shared, one text parsed once in the first caller's step (the asset worker's lane turn), a ref
 *   whose read failed not asked for again within `DECOR_FILE_RETRY_MS`.
 * - **Kept** in least-recently-read order, at most `DECOR_FILES_MAX` files and `DECOR_FILES_CHARS` characters of
 *   path text.
 */

/** Decoration files kept read: at most this many, and this many characters of path text in all (LRU). */
export const DECOR_FILES_MAX = 2_048;
export const DECOR_FILES_CHARS = 32 * 1024 * 1024;
/** A file that could not be read is asked for again only after this long. */
export const DECOR_FILE_RETRY_MS = 10_000;

const files = new Map<string, { parts: DecorPart[]; chars: number }>();
let fileChars = 0;
/** Counts the files read (a decoration's built shapes and cost are worked out again when one is). */
let filesRead = 0;
/** A file's text as read, or why there is none. */
type FileText = { text: string } | { why: 'missing' | 'invalid' };
const reading = new Map<string, Promise<FileText>>();
const failedAt = new Map<string, number>();
/** What parsing a text read gave, for the other callers sharing its read. */
const parsed = new WeakMap<FileText, DecorFileRead>();

/** Changes whenever a decoration file is read (or the files are forgotten). */
export function decorFilesVersion(): number {
  return filesRead;
}

/** What became of one file of `readDecorFiles`: read, unavailable (try again later) or not a decoration. */
export type DecorFileRead = 'read' | 'missing' | 'invalid';

/**
 * Keep a decoration file's content (`DecorFile`: `{ parts }`, parsed JSON) under its ref, its parts clamped as
 * inline parts are (see the header). False when nothing drawable is left of it.
 */
export function putDecorFile(ref: string, data: unknown): boolean {
  if (typeof ref !== 'string' || !ref || ref.length > 100) return false;
  let parts: DecorPart[];
  try {
    const raw = data && typeof data === 'object' ? (data as { parts?: unknown }).parts : undefined;
    parts = clampDecorParts(raw, DECOR_LIMITS.paints);
  } catch {
    // An accessor that throws (a hostile value's getter): nothing is kept.
    return false;
  }
  if (!parts.length) return false;
  let chars = 0;
  for (const p of parts) chars += p.d.length;
  const old = files.get(ref);
  if (old) {
    files.delete(ref);
    fileChars -= old.chars;
  }
  files.set(ref, { parts, chars });
  fileChars += chars;
  filesRead++;
  failedAt.delete(ref);
  for (const [k, v] of files) {
    if (files.size <= DECOR_FILES_MAX && fileChars <= DECOR_FILES_CHARS) break;
    if (k === ref) continue;
    files.delete(k);
    fileChars -= v.chars;
  }
  return true;
}

/** The parts of a read decoration file, or undefined. */
export function decorFileParts(ref: unknown): readonly DecorPart[] | undefined {
  return typeof ref === 'string' ? files.get(ref)?.parts : undefined;
}

/** Whether a decoration names a file that is not read (it draws its inline parts, usually none, for now). */
export function decorPending(d: unknown): boolean {
  const ref = d && typeof d === 'object' ? (d as { ref?: unknown }).ref : undefined;
  return typeof ref === 'string' && ref !== '' && !files.has(ref);
}

/** The parts a clamped decoration draws now: its read file's, else its own. */
export function decorParts(d: DecorData): readonly DecorPart[] {
  return (d.ref !== undefined && files.get(d.ref)?.parts) || d.parts;
}

/** Forget every read decoration file (tests). */
export function clearDecorFiles(): void {
  files.clear();
  fileChars = 0;
  filesRead++;
  reading.clear();
  failedAt.clear();
}

/** Runs a synchronous step (a decoration file's parse) and hands back its result: at once by default. */
export type DecorFileStep = <T>(fn: () => T) => Promise<T>;
const atOnce: DecorFileStep = async (fn) => fn();

/**
 * Read the decoration files `refs` names that are not read yet (see the header). Resolves with the outcome of
 * each ref that is not read (empty when every one is). A step that throws (a cancelled job) rejects that caller
 * only; the text stays to be parsed by the next.
 */
export async function readDecorFiles(
  refs: Iterable<string>,
  read: (ref: string) => Promise<string | null | undefined>,
  now: () => number = Date.now,
  step: DecorFileStep = atOnce,
): Promise<Map<string, DecorFileRead>> {
  const out = new Map<string, DecorFileRead>();
  const waits: Promise<void>[] = [];
  const asked = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== 'string' || !ref || files.has(ref) || asked.has(ref)) continue;
    asked.add(ref);
    let p = reading.get(ref);
    if (!p) {
      const t = failedAt.get(ref);
      if (t !== undefined && now() - t < DECOR_FILE_RETRY_MS) {
        out.set(ref, 'missing');
        continue;
      }
      p = readText(ref, read).then((r) => {
        reading.delete(ref);
        if ('why' in r) failedAt.set(ref, now());
        return r;
      });
      reading.set(ref, p);
    }
    waits.push(
      p.then(async (got) => {
        if ('why' in got) {
          out.set(ref, got.why);
          return;
        }
        const parse = (): DecorFileRead => {
          if (files.has(ref)) return 'read';
          let r = parsed.get(got);
          if (!r) parsed.set(got, (r = parseDecorFile(ref, got.text)));
          return r;
        };
        const r = files.has(ref) ? 'read' : await step(parse);
        if (r === 'read') return;
        failedAt.set(ref, now());
        out.set(ref, r);
      }),
    );
  }
  await Promise.all(waits);
  return out;
}

/** A file's text, or why there is none ('invalid': null or too large). */
async function readText(
  ref: string,
  read: (ref: string) => Promise<string | null | undefined>,
): Promise<FileText> {
  let text: string | null | undefined;
  try {
    text = await read(ref);
  } catch {
    return { why: 'missing' };
  }
  if (text === null) return { why: 'invalid' };
  if (typeof text !== 'string') return { why: 'missing' };
  if (text.length > GEOM_FILE_MAX_BYTES) return { why: 'invalid' };
  return { text };
}

/** Parse a file's text and keep it (`putDecorFile`). */
function parseDecorFile(ref: string, text: string): DecorFileRead {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return 'invalid';
  }
  return putDecorFile(ref, data) ? 'read' : 'invalid';
}
