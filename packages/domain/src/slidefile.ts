import { z } from 'zod';
import { canonicalJson } from './palette.ts';
import { ContentHash, Id, Slide, SlideObject } from './schemas.ts';
import { sha256Text } from './sha256.ts';
import { utf8Bytes } from './size.ts';

/*
 * Slide files (design/29 §1.2 "The slide file"): the full form of a pre-rendered slide, kept out of line in the
 * hub's content store so no presentation carries it and no reader parses it at once. A **head** names the
 * **pages** that hold the slide's objects in z order, a few hundred kilobytes each: an output reads one page a
 * lane turn (about 1 ms), and a save uploads only the pages that changed. Every part is named by the SHA-256 of
 * its canonical JSON (`slideFileName`), immutable and shared by revisions; `Slide.prerender.file.ref` is the
 * head's name. Only what the slide draws is in the file (its objects, the lyric box's id, an imported page
 * picture); notes, timing, transition, cues, sound and provenance stay on the stand-in.
 *
 * Pages are cut every 500 objects, and a 500-object run whose JSON passes 256 KiB is cut further where it
 * would: so an object changed in place changes its own page and the head, and the pages before and after it
 * keep their names. Pure: the hub's pool, the editor and the import worker share it (prerender-store,
 * prerender-editor, prerender-import).
 */

const KiB = 1024;
const MiB = 1024 * KiB;

/** Bounds of a slide file (design/29 §1.2, §2.2 A7: hostile input; set from measure 3). */
export const SLIDE_FILE_LIMITS = {
  /** Objects a page: about 1 ms of `JSON.parse` and clamp on an output's asset worker. */
  pageObjects: 500,
  /** Bytes of a page's canonical JSON. */
  pageBytes: 256 * KiB,
  /** Objects a slide (an inline slide keeps `objects.max(1000)`). */
  objects: 20_000,
  /** Bytes of a slide's pages together. */
  bytes: 16 * MiB,
  /**
   * Pages a head names: two pages side by side always pass 256 KiB together, else the cut would have joined
   * them, so 16 MiB never needs more than 2 × 64 + 1.
   */
  pages: 129,
} as const;

/** A page: objects of the full slide, in z order (bottom first), at most 500 and 256 KiB of canonical JSON. */
export const SlideFilePage = z
  .object({ v: z.literal(1), objects: z.array(SlideObject).max(SLIDE_FILE_LIMITS.pageObjects) })
  .refine((p) => utf8Bytes(canonicalJson(p)) <= SLIDE_FILE_LIMITS.pageBytes, {
    message: `a slide page is at most ${SLIDE_FILE_LIMITS.pageBytes} bytes`,
  });
export type SlideFilePage = z.infer<typeof SlideFilePage>;

/**
 * A head: its pages in order, the slide's object count, and the fields of the full slide that draw besides its
 * objects (the lyric box's id, an imported page picture).
 */
export const SlideFileHead = z.object({
  v: z.literal(1),
  pages: z.array(ContentHash).max(SLIDE_FILE_LIMITS.pages),
  count: z.number().int().min(0).max(SLIDE_FILE_LIMITS.objects),
  lyricObjectId: Id.optional(),
  imported: Slide.shape.imported,
});
export type SlideFileHead = z.infer<typeof SlideFileHead>;

/** A full slide the content store cannot hold (W18), or a file that does not assemble. */
export class SlideFileRefusal extends Error {}

/** The content-store name of a head or a page: the SHA-256 of its canonical JSON. */
export function slideFileName(part: SlideFileHead | SlideFilePage): string {
  return sha256Text(canonicalJson(part));
}

/** A slide file as written: the head and its name, the pages with theirs, and the bytes of all of them. */
export type SlideFile = {
  head: SlideFileHead;
  /** The head's name: `Slide.prerender.file.ref`. */
  name: string;
  pages: { name: string; page: SlideFilePage; bytes: number }[];
  /** Bytes of the head and the pages together: `Slide.prerender.file.bytes`. */
  bytes: number;
};

/**
 * The slide file of a full slide: its objects cut into pages (every 500 objects, and within a run where its
 * JSON would pass 256 KiB), each named by its canonical JSON. Throws `SlideFileRefusal` past 20,000 objects or
 * 16 MiB, or for an object no page can hold (W18: the slide then keeps only its stand-in).
 */
export function slideFileOf(full: Slide): SlideFile {
  const objects: SlideObject[] = Array.isArray(full.objects) ? full.objects : [];
  if (objects.length > SLIDE_FILE_LIMITS.objects)
    throw new SlideFileRefusal(
      `a slide keeps at most ${SLIDE_FILE_LIMITS.objects} objects (this one has ${objects.length})`,
    );
  const pages: SlideFile['pages'] = [];
  let total = 0;
  const close = (run: SlideObject[]) => {
    const page: SlideFilePage = { v: 1, objects: run };
    const json = canonicalJson(page);
    const bytes = utf8Bytes(json);
    total += bytes;
    if (total > SLIDE_FILE_LIMITS.bytes)
      throw new SlideFileRefusal(`a slide's file is at most 16 MiB (this one passes it)`);
    pages.push({ name: sha256Text(json), page, bytes });
  };
  // `{"objects":[`, `],"v":1}` and a comma between objects: what a page's JSON adds to its objects' own.
  const frame = utf8Bytes(canonicalJson({ v: 1, objects: [] }));
  for (let start = 0; start < objects.length; start += SLIDE_FILE_LIMITS.pageObjects) {
    const chunk = objects.slice(start, start + SLIDE_FILE_LIMITS.pageObjects);
    let run: SlideObject[] = [];
    let bytes = frame;
    for (const o of chunk) {
      const own = utf8Bytes(canonicalJson(o));
      if (frame + own > SLIDE_FILE_LIMITS.pageBytes)
        throw new SlideFileRefusal(
          `object ${String((o as { id?: unknown })?.id ?? '?').slice(0, 200)} is larger than a slide page (${SLIDE_FILE_LIMITS.pageBytes} bytes)`,
        );
      const add = own + (run.length ? 1 : 0);
      if (run.length && bytes + add > SLIDE_FILE_LIMITS.pageBytes) {
        close(run);
        run = [];
        bytes = frame;
        bytes += own;
      } else bytes += add;
      run.push(o);
    }
    if (run.length) close(run);
  }
  const head: SlideFileHead = {
    v: 1,
    pages: pages.map((p) => p.name),
    count: objects.length,
    ...(full.lyricObjectId ? { lyricObjectId: full.lyricObjectId } : {}),
    ...(full.imported ? { imported: full.imported } : {}),
  };
  const json = canonicalJson(head);
  return { head, name: sha256Text(json), pages, bytes: total + utf8Bytes(json) };
}

/**
 * The full slide from its stand-in and its file: the stand-in's fields (notes, cues, timing, provenance,
 * `prerender`), the head's drawn fields and the pages' objects in order. Throws `SlideFileRefusal` when the
 * pages are not the head's (missing, extra or out of order) or do not add up to its count, so a reader never
 * stitches a slide from parts of two versions.
 */
export function slideFromFile(standIn: Slide, head: SlideFileHead, pages: readonly SlideFilePage[]): Slide {
  if (pages.length !== head.pages.length)
    throw new SlideFileRefusal(`the slide file names ${head.pages.length} pages, ${pages.length} were given`);
  const objects: SlideObject[] = [];
  pages.forEach((p, i) => {
    if (slideFileName(p) !== head.pages[i]) throw new SlideFileRefusal(`page ${i + 1} is not the head's`);
    for (const o of p.objects) objects.push(o);
  });
  if (objects.length !== head.count)
    throw new SlideFileRefusal(`the slide file holds ${objects.length} objects, its head says ${head.count}`);
  const { lyricObjectId: _l, imported: _i, ...rest } = standIn;
  return {
    ...rest,
    objects,
    ...(head.lyricObjectId ? { lyricObjectId: head.lyricObjectId } : {}),
    ...(head.imported ? { imported: head.imported } : {}),
  };
}
