import { z } from 'zod';
import { drawnMediaIds } from './content.ts';
import { drawnShapeFileRefs, extraFontFamilies } from './m9-readers.ts';
import { canonicalJson } from './palette.ts';
import { slideMediaIds } from './resolve.ts';
import { ContentHash, Id, isGeomFileRef, type Presentation, Slide, SlideObject } from './schemas.ts';
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

/**
 * What an INLINE slide holds: the schema bound of `Slide.objects` (`schemas.ts`, `.max(1000)`). A slide past it is kept
 * whole in a slide file (Q54) with a bounded stand-in inline. Equal to the converter's whole-slide bound
 * (`WHOLE_OBJECTS_MAX`, `@ordo/pptx-scene`); a test pins it to the schema.
 */
export const INLINE_OBJECTS_MAX = 1000;
/** What a slide file holds in all: `SLIDE_FILE_LIMITS.objects`, also the bake clamp's and the underlay frame's bound. */
export const FILE_OBJECTS_MAX = SLIDE_FILE_LIMITS.objects;
/** The most JSON a stand-in may take (Q54: "a small plain copy"): the presentation never carries more than this per file-form slide. */
export const STAND_IN_BYTES_MAX = 192 * KiB;
/**
 * The characters of one text object a screen draws and an import keeps (`CLAMP.maxTextChars`, `IMPORT_LIMITS.text`,
 * `PICTURE_COUNTS.characters`): `standInOf` merges text up to the schema's 20,000, so a stand-in made for a file-form
 * slide splits its pieces here (`heavyForm`), or a screen and a stored copy would lose the tail of each. Pinned equal
 * to the three by tests.
 */
export const TEXT_DRAWN_MAX = 10_000;

// The schemas are made by functions called /* @__PURE__ */, so a bundle that imports this module for
// `slideFileOf` alone (goLive's path in the operator's core worker, which a phone loads) leaves them out.
const pageSchema = () =>
  z
    .object({ v: z.literal(1), objects: z.array(SlideObject).max(SLIDE_FILE_LIMITS.pageObjects) })
    .refine((p) => utf8Bytes(canonicalJson(p)) <= SLIDE_FILE_LIMITS.pageBytes, {
      message: `a slide page is at most ${SLIDE_FILE_LIMITS.pageBytes} bytes`,
    });
const headSchema = () =>
  z.object({
    v: z.literal(1),
    pages: z.array(ContentHash).max(SLIDE_FILE_LIMITS.pages),
    count: z.number().int().min(0).max(SLIDE_FILE_LIMITS.objects),
    lyricObjectId: Id.optional(),
    imported: Slide.shape.imported,
  });

/** A page: objects of the full slide, in z order (bottom first), at most 500 and 256 KiB of canonical JSON. */
export const SlideFilePage = /* @__PURE__ */ pageSchema();
export type SlideFilePage = z.infer<typeof SlideFilePage>;

/**
 * A head: its pages in order, the slide's object count, and the fields of the full slide that draw besides its
 * objects (the lyric box's id, an imported page picture).
 */
export const SlideFileHead = /* @__PURE__ */ headSchema();
export type SlideFileHead = z.infer<typeof SlideFileHead>;

// `Slide` with the object bound of a slide file: every other field is Slide's, so a field refused stays refused.
const fullSlideSchema = () =>
  Slide.extend({ objects: z.array(SlideObject).max(FILE_OBJECTS_MAX).default([]) });
/**
 * A full slide: a `Slide` of up to 20,000 objects, the form a slide file holds (an inline `Slide` holds 1,000). Made by a
 * function called pure for the reason the page and head schemas are. Parsed by the hub's pool for a slide of an import
 * (`heavyForm`); never stored inline.
 */
export const FullSlide = /* @__PURE__ */ fullSlideSchema();
export type FullSlide = z.infer<typeof FullSlide>;

/** Why `slideFileOf` refused a slide: too many objects, too many bytes, or one object larger than a page. */
export type SlideFileRefusalCode = 'objects' | 'bytes' | 'object';

/**
 * A full slide the content store cannot hold (W18), or a file that does not assemble. The three refusals of
 * `slideFileOf` carry a `code`, so a caller names the reason without reading the message; the ones of
 * `slideFromFile` (parts that are not the head's) carry none.
 */
export class SlideFileRefusal extends Error {
  readonly code?: SlideFileRefusalCode;
  constructor(message: string, code?: SlideFileRefusalCode) {
    super(message);
    this.code = code;
  }
}

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
      'objects',
    );
  const pages: SlideFile['pages'] = [];
  let total = 0;
  const close = (run: SlideObject[]) => {
    const page: SlideFilePage = { v: 1, objects: run };
    const json = canonicalJson(page);
    const bytes = utf8Bytes(json);
    total += bytes;
    if (total > SLIDE_FILE_LIMITS.bytes)
      throw new SlideFileRefusal(`a slide's file is at most 16 MiB (this one passes it)`, 'bytes');
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
          'object',
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

/**
 * What a head row may name (store-2 step 3b, the Q54 data-safety items): the full lists of a slide of up to 20,000
 * objects, which is what a slide file may hold (`SLIDE_FILE_LIMITS.objects`): one media id a picture object, plus its
 * slide picture and its sound; one shape file a shape; and font families up to what 20,000 boxes of a crowded
 * deck could name at most in practice. A head naming more of any list is REFUSED with a named reason, never cut: a cut
 * list leaves a file the collector does not see as named and a picture whose key leaves a file out. Not the record's
 * bounds: `Slide.prerender.uses` keeps `PRERENDER_LIMITS` (1,000 / 1,000 / 64), the schema drops the whole record
 * past them, so the record is sliced where it is written (`Library.withSlideFiles`).
 */
export const HEAD_USES_MAX = { media: 20_002, files: 20_000, fonts: 2_048 } as const;

/**
 * Every media id, shape-file ref and font family a full slide names, whole: `slideUses` (prerender.ts) with no
 * cut, for the head row the hub keeps (`slide_heads.uses`), which its collector, its keys job and its goLive
 * read. Where nothing is past `PRERENDER_LIMITS` the lists equal `slideUses`'s.
 */
export function slideUsesAll(full: Slide): { media: string[]; files: string[]; fonts: string[] } {
  const media = new Set<string>([...drawnMediaIds(full), ...slideMediaIds(full)]);
  const files = drawnShapeFileRefs(full).filter(isGeomFileRef);
  const fonts = new Set<string>();
  for (const o of Array.isArray(full?.objects) ? full.objects : []) {
    if (o.type === 'text') {
      for (const f of [
        o.style?.fontFamily,
        ...(o.style?.fallbackFonts ?? []),
        ...(o.runs ?? []).map((r) => r.fontFamily),
      ])
        if (typeof f === 'string' && f.trim()) fonts.add(f);
      for (const p of o.paras ?? []) if (p?.bullet?.fontFamily) fonts.add(p.bullet.fontFamily);
    } else for (const f of extraFontFamilies(o)) fonts.add(f);
  }
  return { media: [...media], files, fonts: [...fonts] };
}

/** The first list of `uses` that is past `HEAD_USES_MAX`, as a sentence for a refusal; undefined when none is. */
export function usesTooMany(uses: {
  media: readonly string[];
  files: readonly string[];
  fonts: readonly string[];
}): string | undefined {
  for (const [what, list, max] of [
    ['media items', uses.media, HEAD_USES_MAX.media],
    ['shape files', uses.files, HEAD_USES_MAX.files],
    ['font families', uses.fonts, HEAD_USES_MAX.fonts],
  ] as const)
    if (list.length > max)
      return `a slide names more ${what} (${list.length}) than the hub keeps for one (${max})`;
  return undefined;
}

/** The slides of a presentation that are kept as a slide file: their stand-in names a file in `prerender.file`. */
export function fileFormSlides(p: Pick<Presentation, 'sections'> | undefined): Slide[] {
  const out: Slide[] = [];
  for (const sec of p?.sections ?? []) for (const s of sec?.slides ?? []) if (s?.prerender?.file) out.push(s);
  return out;
}

/** Whether a presentation has a slide kept as a slide file (a cheap scan: no comparison). */
export function hasFileForm(p: Pick<Presentation, 'sections'> | undefined): boolean {
  for (const sec of p?.sections ?? []) for (const s of sec?.slides ?? []) if (s?.prerender?.file) return true;
  return false;
}

/** Equal as JSON: key order and keys holding `undefined` do not count. Iterative, so no depth of input can overflow the stack. */
function sameJson(a: unknown, b: unknown): boolean {
  const stack: [unknown, unknown][] = [[a, b]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x === y || (typeof x === 'number' && typeof y === 'number' && Number.isNaN(x) && Number.isNaN(y)))
      continue;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
    if (Array.isArray(x) !== Array.isArray(y)) return false;
    if (Array.isArray(x)) {
      const ys = y as unknown[];
      if (x.length !== ys.length) return false;
      for (let i = 0; i < x.length; i++) stack.push([x[i], ys[i]]);
      continue;
    }
    const xo = x as Record<string, unknown>;
    const yo = y as Record<string, unknown>;
    const xk = Object.keys(xo).filter((k) => xo[k] !== undefined);
    const yk = Object.keys(yo).filter((k) => yo[k] !== undefined);
    if (xk.length !== yk.length) return false;
    for (const k of xk) {
      if (yo[k] === undefined) return false;
      stack.push([xo[k], yo[k]]);
    }
  }
  return true;
}

/** Whether two object lists are the same slide content: the same objects (by identity first, else as JSON) in the same order. */
function sameObjects(a: readonly SlideObject[] | undefined, b: readonly SlideObject[] | undefined): boolean {
  if (a === b) return true;
  const xs = Array.isArray(a) ? a : [];
  const ys = Array.isArray(b) ? b : [];
  if (xs.length !== ys.length) return false;
  for (let i = 0; i < xs.length; i++) if (xs[i] !== ys[i] && !sameJson(xs[i], ys[i])) return false;
  return true;
}

/**
 * The slides of `next` whose stand-in was changed beside its slide file (C-IF5): the slide has `prerender.file` in
 * both, the same `file.ref`, and different objects. Such a save would leave the file, its key and the picture as they
 * were while the stand-in drew something else, so the screens would show stale content. The editor refuses it in
 * `change()` and `save()`, the hub in `PUT /presentations/:id`; a writer of the hub that changes a stand-in's objects
 * must call it too. A slide new in `next`, one whose `file` was removed or whose ref changed (a new file was made for
 * it), and a change of a slide-level field (notes, timing, transition, hidden, MIDI cues, sound, the bottom-third
 * words: they are not objects and never leave the stand-in) are not listed. `prev` undefined (a new presentation)
 * lists nothing. Pure; iterative; the stored copies are only compared when `next` holds a file-form slide.
 */
export function staleStandIns(prev: Presentation | undefined, next: Presentation): { slideId: string }[] {
  const out: { slideId: string }[] = [];
  if (!prev || !hasFileForm(next)) return out;
  const before = new Map<string, Slide[]>();
  for (const s of fileFormSlides(prev)) {
    const list = before.get(s.id);
    if (list) list.push(s);
    else before.set(s.id, [s]);
  }
  const listed = new Set<string>();
  for (const s of fileFormSlides(next)) {
    const olds = before.get(s.id)?.filter((o) => o.prerender?.file?.ref === s.prerender?.file?.ref);
    if (!olds?.length || listed.has(s.id)) continue;
    if (olds.some((o) => o === s || sameObjects(o.objects, s.objects))) continue;
    listed.add(s.id);
    out.push({ slideId: s.id });
  }
  return out;
}
