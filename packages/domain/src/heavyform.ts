import { PICTURE_COUNTS, standInOf } from './prerender.ts';
import {
  PRERENDER_LIMITS,
  PRERENDER_WHY,
  type PrerenderWhy,
  type Slide,
  type SlideObject,
  type SlidePrerender,
  type TextObject,
} from './schemas.ts';
import { jsonBytes } from './size.ts';
import {
  type SlideFile,
  SlideFileRefusal,
  slideFileOf,
  slideUsesAll,
  STAND_IN_BYTES_MAX,
  TEXT_DRAWN_MAX,
  usesTooMany,
} from './slidefile.ts';

/*
 * The full form of a heavy slide (design/29 §1.2, import-files step 1, Q54): a slide of more than 1,000 objects is kept
 * whole in a slide file (the head and the pages), and the presentation carries only its bounded STAND-IN with a
 * record that names the file. `heavyForm` makes both, or says why it cannot:
 *
 *  - the CALLER decided that the slide is eligible and why it is heavy (`why`: what `easyPlan` said; a function such as
 *    `isMotion` cannot cross the hub's pool and the rule must not be copied here), so an empty `why` is nothing to do;
 *  - a slide the file cannot hold (`objects` past 20,000, `bytes` past 16 MiB, one `object` larger than a page, a head
 *    naming more `uses` than the head row keeps, a stand-in that cannot fit its 192 KiB) is REFUSED with a named reason
 *    and a plain stand-in WITHOUT a record: a record without a file is what an inline whole slide looks like, and a
 *    baker would draw a picture of the stand-in as if it were the slide (the importer writes the marker
 *    `PRERENDER_REFUSED_MISSING`, C-IF2);
 *  - the stand-in is `standInOf` bounded for the screens' sake (`boundStandIn`): no text box over what a screen draws
 *    and the import keeps of one, at most 200 objects, at most `STAND_IN_BYTES_MAX` of JSON;
 *  - `live` is an argument, not a rule: this release always passes `[]` (no slide with a moving anchor is eligible),
 *    and Q24.a gives a slide a live set without a change here (H1); nothing in this file branches on an anchor, a plate
 *    or a picture kind.
 *
 * Pure: the hub's pool runs it for one slide at a time (a 16 MiB slide is up to two seconds of canonical JSON and
 * hashing in plain JavaScript: never on the library loop), and the tests run it directly. It never throws.
 * Every writer of a stand-in that has a file must call `staleStandIns` (`slidefile.ts`): the editor's `change()` and
 * `save()` and the hub's `PUT /presentations/:id` do, and a hub writer that changes a stand-in's objects must too.
 */

/** Why a slide was refused a file: the three of `slideFileOf`, and the three of this module. */
export type HeavyRefusal = 'objects' | 'bytes' | 'object' | 'uses' | 'standin' | 'invalid';

/** A slide that got its file: the file, the bounded stand-in with its record, and what the file draws. */
export type HeavyOk = {
  ok: true;
  /** The head and the pages as the content store keeps them (`slideFileOf`). */
  file: SlideFile;
  /** The slide as the presentation stores it: its `prerender` names `file.name` and `file.bytes`. */
  standIn: Slide;
  /** What the file draws, WHOLE (the head row's `uses`); the record on the stand-in keeps the first `PRERENDER_LIMITS`. */
  uses: { media: string[]; files: string[]; fonts: string[] };
  /** Words were cut to fit the stand-in's 200 objects or its 192 KiB: the caller writes the note (design/29 W5). */
  cut: boolean;
};
/** A slide the file cannot hold: its reason, a sentence for the report, and a plain stand-in with NO record. */
export type HeavyRefused = { ok: false; reason: HeavyRefusal; message: string; standIn: Slide };
/** No reason was given: nothing is written. */
export type HeavyNothing = { ok: false; reason: 'nothing-to-do'; message: string };
export type HeavyResult = HeavyOk | HeavyRefused | HeavyNothing;

export type HeavyOptions = {
  /** What `easyPlan` said (`bytes`, `count`); empty means the slide needs no file. */
  why: readonly PrerenderWhy[];
  /** The live set kept whole in the stand-in and recorded (always `[]` in this release: H1). */
  live?: readonly string[];
};

const isText = (o: SlideObject): o is TextObject => o?.type === 'text';

/**
 * `text` cut into pieces of at most `max` characters, at a line break where one is near, never between the halves of
 * a surrogate pair: `prerender.ts`'s own rule with another bound.
 */
function splitAt(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    const c = rest.charCodeAt(cut - 1);
    if (cut === max && c >= 0xd800 && c <= 0xdbff) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(rest[cut] === '\n' ? cut + 1 : cut);
  }
  out.push(rest);
  return out;
}

/** The area of an object's box, for the order in which pictures are dropped (the smallest first). */
const areaOf = (o: SlideObject): number => {
  const w = Number(o?.box?.w);
  const h = Number(o?.box?.h);
  return Number.isFinite(w) && Number.isFinite(h) ? Math.abs(w * h) : 0;
};

/**
 * The stand-in bounded for the screens (D15, D6). A screen draws 10,000 characters of a text box and the import keeps
 * that many, but `standInOf` merges words into plain boxes of up to 20,000, so:
 *
 *  1. every non-live text box over `TEXT_DRAWN_MAX` is laid out again, every word kept: the boxes `standInOf` kept whole
 *     stay (a long one is split into boxes of at most 10,000 in the same place, ids `<id>.<n>`), the merged words are
 *     split at 10,000, and when that would pass the 200 objects a screen draws, whole boxes from the END are merged
 *     into the plain words instead (a plain box costs nothing in words, only its formatting, which a stand-in does not
 *     keep anyway); only when even that does not fit are the pieces from the END cut;
 *  2. while the stand-in's JSON passes `STAND_IN_BYTES_MAX`, the text boxes from the END are cut (the first text box's
 *     first piece and the background always stay), then the smallest pictures are dropped.
 *
 * `wholeIds` names the boxes that are the full slide's own (ids of the full slide: the ones `standInOf` kept whole);
 * every other text box is words `standInOf` merged. Absent, every text box is whole. The live objects are never split,
 * merged or cut. `cut` says that a word or a picture was left out; a stand-in that cannot fit even so comes back
 * `undefined` (the caller refuses the slide, reason `standin`). The same object when nothing needed doing.
 * Pure; never throws for a slide.
 */
export function boundStandIn(
  standIn: Slide,
  live: readonly string[] = [],
  wholeIds?: ReadonlySet<string>,
): { slide: Slide; cut: boolean } | undefined {
  const liveIds = new Set(live);
  const objects: SlideObject[] = Array.isArray(standIn.objects) ? standIn.objects : [];
  const unit = (o: SlideObject): o is TextObject =>
    isText(o) && !liveIds.has(o.id) && typeof o.text === 'string';
  let slide: Slide = standIn;
  let cut = false;
  let guarded: Set<SlideObject> = new Set();
  if (objects.some((o) => unit(o) && o.text.length > TEXT_DRAWN_MAX)) {
    const laid = layoutText(standIn, objects, unit, liveIds, wholeIds);
    slide = laid.slide;
    cut = laid.cut;
    guarded = laid.guarded;
  } else {
    const first = objects.find(unit);
    if (first) guarded.add(first);
  }
  // the bytes: the text from the end, then the smallest pictures
  let bytes = jsonBytes(slide);
  if (bytes > STAND_IN_BYTES_MAX) {
    const list = slide.objects;
    const drop = new Set<SlideObject>();
    const over = () => bytes > STAND_IN_BYTES_MAX;
    for (let i = list.length - 1; i >= 0 && over(); i--) {
      const o = list[i]!;
      if (!unit(o) || guarded.has(o)) continue;
      drop.add(o);
      bytes -= jsonBytes(o) + 1;
    }
    if (over()) {
      const pictures = list
        .map((o, i) => ({ o, i }))
        .filter(({ o }) => o?.type === 'image' && !liveIds.has(o.id))
        .sort((a, b) => areaOf(a.o) - areaOf(b.o) || b.i - a.i);
      for (const { o } of pictures) {
        if (!over()) break;
        drop.add(o);
        bytes -= jsonBytes(o) + 1;
      }
    }
    if (over()) return undefined;
    slide = { ...slide, objects: list.filter((o) => !drop.has(o)) };
    cut = true;
    // the exact bytes, not the estimate (an object's own commas leave it a byte or two off)
    if (jsonBytes(slide) > STAND_IN_BYTES_MAX) return undefined;
  }
  const lyric = standIn.lyricObjectId;
  if (lyric && !slide.objects.some((o) => o.id === lyric)) {
    const { lyricObjectId: _l, ...rest } = slide;
    slide = rest as Slide;
  }
  return { slide, cut };
}

/**
 * Step 1 of `boundStandIn`: the text boxes laid out again within `TEXT_DRAWN_MAX` characters a box and the 200 objects
 * of a screen. The first `w` text boxes are kept (the leading ones `standInOf` kept whole, fewer when the objects must be
 * saved; a long one is split in place) and the words of every later one are the plain boxes `standInOf` makes, split at
 * `TEXT_DRAWN_MAX`; the largest `w` that fits is chosen, and at least one box is kept.
 */
function layoutText(
  standIn: Slide,
  objects: SlideObject[],
  unit: (o: SlideObject) => o is TextObject,
  liveIds: ReadonlySet<string>,
  wholeIds: ReadonlySet<string> | undefined,
): { slide: Slide; cut: boolean; guarded: Set<SlideObject> } {
  const cap = PICTURE_COUNTS.objects;
  const units: { o: TextObject; at: number }[] = [];
  objects.forEach((o, at) => {
    if (unit(o)) units.push({ o, at });
  });
  const others = objects.length - units.length;
  let w0 = 0;
  while (w0 < units.length && (!wholeIds || wholeIds.has(units[w0]!.o.id))) w0++;
  w0 = Math.min(units.length, Math.max(1, w0));
  const piecesOf = (t: string) => (t.length <= TEXT_DRAWN_MAX ? 1 : splitAt(t, TEXT_DRAWN_MAX).length);
  const mergedText = (w: number) =>
    units
      .slice(w)
      .map((u) => u.o.text)
      .join('\n');
  // The largest `w` whose boxes and merged words fit the objects of a screen; failing that, the one with the fewest.
  let kept = others;
  const keptCost: number[] = [others];
  for (const u of units) keptCost.push((kept += piecesOf(u.o.text)));
  let best = { w: w0, cost: Number.POSITIVE_INFINITY };
  for (let w = w0; w >= 1; w--) {
    let cost = keptCost[w]!;
    if (w < units.length) {
      const chars = units.slice(w).reduce((n, u) => n + u.o.text.length + 1, -1);
      // The words need at least this many boxes: when even that passes the cap there is no need to lay them out.
      const least = cost + Math.ceil(chars / TEXT_DRAWN_MAX);
      if (least > cap) {
        if (least < best.cost) best = { w, cost: least };
        continue;
      }
      cost += splitAt(mergedText(w), TEXT_DRAWN_MAX).length;
    }
    if (cost < best.cost) best = { w, cost };
    if (cost <= cap) break;
  }
  const w = best.w;
  // New ids may not take an id of the full slide, a live object or a box that stays.
  const used = new Set<string>([...(wholeIds ?? []), ...liveIds]);
  for (const o of objects) used.add(String(o?.id));
  // The merged boxes are made again, so their old ids are free.
  for (const u of units.slice(w)) if (!wholeIds?.has(u.o.id)) used.delete(u.o.id);
  const freeId = (base: string, sep: string, n: number) => {
    let id = `${base.slice(0, 180)}${sep}${n}`;
    for (let i = 2; used.has(id); i++) id = `${base.slice(0, 170)}${sep}${n}.${i}`;
    used.add(id);
    return id;
  };
  // A piece is a plain box: runs and paragraph styles hold offsets into the whole text.
  const plainBox = (like: TextObject, id: string, text: string): TextObject => {
    const { runs: _r, paras: _p, ...plain } = like;
    return { ...plain, id, text } as TextObject;
  };
  const unitOf = new Map<SlideObject, number>(units.map((u, k) => [u.o, k]));
  const out: SlideObject[] = [];
  const created = new Set<SlideObject>();
  const guarded = new Set<SlideObject>();
  for (const o of objects) {
    const k = unitOf.get(o);
    if (k === undefined) {
      out.push(o);
      continue;
    }
    if (k < w) {
      const text = units[k]!.o.text;
      if (text.length <= TEXT_DRAWN_MAX) {
        out.push(o);
        if (k === 0) guarded.add(o);
        continue;
      }
      splitAt(text, TEXT_DRAWN_MAX).forEach((piece, j) => {
        const box = plainBox(units[k]!.o, j === 0 ? units[k]!.o.id : freeId(units[k]!.o.id, '.', j), piece);
        out.push(box);
        created.add(box);
        if (k === 0 && j === 0) guarded.add(box);
      });
      continue;
    }
    if (k > w) continue;
    // The merged words, in boxes of at most TEXT_DRAWN_MAX, each at the box of the text it starts in.
    const from = units.slice(w);
    let at = 0;
    splitAt(mergedText(w), TEXT_DRAWN_MAX).forEach((piece, n) => {
      let source = from[0]!;
      let pos = 0;
      for (const u of from) {
        if (pos > at) break;
        source = u;
        pos += u.o.text.length + 1;
      }
      at += piece.length + 1;
      const box = plainBox(source.o, freeId(source.o.id, '~', n + 1), piece);
      out.push(box);
      created.add(box);
    });
  }
  // What a screen draws at once: the pieces from the END go first, never the first box's.
  let cut = false;
  for (let i = out.length - 1; i >= 0 && out.length > cap; i--) {
    const o = out[i]!;
    if (!created.has(o) || guarded.has(o)) continue;
    out.splice(i, 1);
    cut = true;
  }
  return { slide: { ...standIn, objects: out }, cut, guarded };
}

/** The plain stand-in of a slide the file refused: no record, so nothing mistakes it for an inline whole slide. */
function plainStandIn(full: Slide): Slide {
  try {
    const { prerender: _p, ...rest } = standInOf(full, []);
    return rest as Slide;
  } catch {
    return { id: typeof full?.id === 'string' ? full.id : 'slide', objects: [] } as Slide;
  }
}

function refuse(full: Slide, reason: HeavyRefusal, message: string): HeavyRefused {
  return { ok: false, reason, message, standIn: plainStandIn(full) };
}

/** The first `n` of a list: what the record on the stand-in keeps of the head row's whole lists (`PRERENDER_LIMITS`). */
const first = <T>(list: readonly T[], n: number): T[] => list.slice(0, n);

/**
 * The full form of one heavy slide: its slide file, its bounded stand-in with the record that names the file, and what
 * the file draws; or a refusal with a named reason and a plain stand-in without a record. See the header of this file.
 */
export function heavyForm(full: Slide, opts: HeavyOptions): HeavyResult {
  try {
    const why = [
      ...new Set((Array.isArray(opts?.why) ? opts.why : []).filter((w) => PRERENDER_WHY.includes(w))),
    ];
    if (!why.length)
      return {
        ok: false,
        reason: 'nothing-to-do',
        message: 'the slide has no reason to be kept in a slide file',
      };
    const live = first(Array.isArray(opts.live) ? opts.live : [], PRERENDER_LIMITS.live);
    let file: SlideFile;
    try {
      file = slideFileOf(full);
    } catch (e) {
      if (e instanceof SlideFileRefusal && e.code) return refuse(full, e.code, e.message);
      throw e;
    }
    const uses = slideUsesAll(full);
    const many = usesTooMany(uses);
    if (many) return refuse(full, 'uses', many);
    const record: SlidePrerender = {
      why,
      file: { ref: file.name, bytes: file.bytes },
      live,
      uses: {
        media: first(uses.media, PRERENDER_LIMITS.media),
        files: first(uses.files, PRERENDER_LIMITS.files),
        fonts: first(uses.fonts, PRERENDER_LIMITS.fonts),
      },
    };
    const bounded = boundStandIn(
      standInOf({ ...full, prerender: record }, live),
      live,
      new Set((Array.isArray(full.objects) ? full.objects : []).map((o) => String(o?.id))),
    );
    if (!bounded)
      return refuse(
        full,
        'standin',
        `the simple copy of the slide would pass ${STAND_IN_BYTES_MAX / 1024} KiB even with its words cut`,
      );
    return { ok: true, file, standIn: bounded.slide, uses, cut: bounded.cut };
  } catch (e) {
    return refuse(
      full,
      'invalid',
      `the slide could not be read: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300),
    );
  }
}
