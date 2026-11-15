import { drawnMediaIds, slideContent } from './content.ts';
import { DEFAULT_FONT, DEFAULT_LYRIC_STYLE, SCRIPT_FALLBACK_FONTS } from './defaults.ts';
import { drawnShapeFileRefs, extraFontFamilies, extraText, tableText } from './m9-readers.ts';
import { canonicalJson } from './palette.ts';
import { fallbackFontScripts, slideMediaIds } from './resolve.ts';
import {
  type DrawAs,
  isGeomFileRef,
  PRERENDER_LIMITS,
  PRERENDER_WHY,
  type PrerenderWhy,
  type Slide,
  type SlideObject,
  type SlidePrerender,
  type TextObject,
} from './schemas.ts';
import { sha256Text } from './sha256.ts';
import { jsonBytes, minimalSlide, SIZE_BUDGETS } from './size.ts';
import { type SlideFile, SlideFileRefusal, slideFileOf } from './slidefile.ts';

/*
 * Pre-rendered slides (design/29 §1): the model every party shares, with no drawing in it. A slide that is big
 * (`bytes`), moved out of line for its presentation's size (`tail`), too crowded for a screen to draw at once
 * (`count`) or set to Pre-rendered by hand (`chosen`) keeps its full form in a slide file (`slidefile.ts`); the
 * presentation stores its stand-in (`standInOf`); a desktop draws a picture of what does not move
 * (`drawnPart`), keyed by everything it depends on (`prerenderKey`), and the screens show it under the live set
 * (`liveSet`). Every writer of a pre-rendered slide goes through `withFullSlide`. Pure: the editor, the bake
 * worker, the import worker and the hub's pool share it, and the hub cannot import `@ordo/renderer`, so what
 * needs the renderer (the cost reasons, an object's exact reach) is passed in.
 */

/**
 * The one pre-render switch (design/29 §4, the r2b plan §5). Every pre-render path reads it: the import plan
 * (`prerender` in `M9_HELD_BACK`, tied to it by prerender-import's test), the editor's Drawing card (hidden while
 * off, so no slide gets `why: 'chosen'`), the bake triggers (after a save, at Go live), the outputs' picture
 * form (off: the slide is drawn live) and the operator's `prerender.use`. Each path is tested both ways in the
 * track that builds it. It stays false until sub-wave 4's gate passes (fidelity, memory, census, e2e on both
 * kinds of hub); its integrator lifts it in one commit. Nothing writes `Slide.prerender` while it is off.
 */
export const PRERENDER_ON = false;

/**
 * The renderer's drawing version of pictures: part of every key, so a renderer that draws a pre-rendered slide
 * differently makes every picture stale at once (stand-bys cover the gap, `standbyId`). The renderer's digest
 * test over its drawing sources forces the bump (design/29 §1.2).
 */
export const PRERENDER_VERSION = 1;

/** The frame every picture is drawn at, and the reference every plan is judged at (design/29 §1.1). */
export const PRERENDER_FRAME = { width: 3840, height: 2160, scale: 2 } as const;

/**
 * The live-raster counts past which a screen would cut a slide drawn live (design/29 §1.1 `count`): the
 * renderer's `CLAMP` (`maxObjects`, `maxImagesPerSlide`, `maxTextChars`, `maxRunFamilies`, `maxSizeScales`),
 * kept equal to it by `packages/renderer/src/prerender-counts.test.ts`, never copied by hand elsewhere.
 */
export const PICTURE_COUNTS = {
  objects: 200,
  pictures: 16,
  /** Characters of one box drawn live (not the lyric box, which stays live). */
  characters: 10_000,
  /** Distinct run and bullet families of one box. */
  families: 16,
  /** Distinct run size scales of one box. */
  sizeScales: 64,
} as const;

/** Anchors a live set keeps (design/29 §1.5, W24): past them step-by-step text goes into the picture. */
export const LIVE_ANCHORS_MAX = 200;
/** Playing pictures a live set keeps (W24): past them a picture shows its still in the picture. */
export const LIVE_PLAYING_MAX = 16;
/** A tail slide without its own switch gets a picture only past this estimate at 4K (owner question 10). */
export const TAIL_PICTURE_MS = 300;
/** Characters of one stand-in box: the schema's bound on a text object (`schemas.ts` MAX.text). */
export const STAND_IN_TEXT_MAX = 20_000;

/**
 * The faces every picture may fall back to beyond the library's: the default face and the script fallbacks
 * (`DEFAULT_FONT`, `SCRIPT_FALLBACK_FONTS`). Part of every key, so a release that changes either makes the
 * pictures stale. A literal (computed by `fallbackFacesDigest`, kept equal by prerender.test.ts) so importing
 * this module computes nothing.
 */
export const FALLBACK_FACES_DIGEST = '0cb7b305465ad20ad005fccdc3561040ab45703010f933c709868df4fc011db2';

/** What `FALLBACK_FACES_DIGEST` is: the SHA-256 of the default face and the script fallbacks. */
export function fallbackFacesDigest(): string {
  return sha256Text(canonicalJson({ default: DEFAULT_FONT, scripts: SCRIPT_FALLBACK_FONTS }));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const objectsOf = (s: Pick<Slide, 'objects'>): SlideObject[] => (Array.isArray(s?.objects) ? s.objects : []);
const idOf = (o: unknown): string => (isObj(o) && typeof o.id === 'string' ? o.id : '');
const famKey = (f: unknown): string => (typeof f === 'string' ? f.trim().toLowerCase() : '');

// ---------------------------------------------------------------------------------------------------------
// Which slides get a picture (design/29 §1.1)

/** A bound `pictureUnits` found passed: a count of `PICTURE_COUNTS`, `bytes`, or a cost reason passed in. */
export type PictureOver = keyof typeof PICTURE_COUNTS | 'bytes' | (string & {});

/** Which slides get a picture, and why. */
export type PicturePlan = {
  /** The reasons a writer stores (`Slide.prerender.why`): `bytes`, `count`, or none. */
  why: ('bytes' | 'count')[];
  /** Each bound passed, for the import report and the slide card (W1, W4). */
  over: PictureOver[];
  counts: {
    objects: number;
    pictures: number;
    bytes: number;
    /** The largest of the boxes (the lyric box aside). */
    characters: number;
    families: number;
    sizeScales: number;
  };
};

/**
 * The cost reasons of a slide (`@ordo/renderer` `costReasons`: prepared pictures past 192 MiB, a geometry no
 * single task can draw), asked at the reference frame: the converter and the editor pass the renderer's in, the
 * hub stores what the writer sends. Each reason returned makes the slide `count`.
 */
export type CostReasons = (slide: Slide, at: typeof PRERENDER_FRAME) => readonly string[];

/**
 * Which slides get a picture (design/29 §1.1): `bytes` stored over 64 KiB (the caller measures the slide after
 * the lossless grid step), `count` past a live count (`PICTURE_COUNTS`) or a cost reason. Judged at the fixed
 * 3840 reference whatever the caller's screen, so every view plans the same. `tail` and `chosen` are the
 * import plan's and the editor's, not found here.
 */
export function pictureUnits(slide: Slide, cost?: CostReasons): PicturePlan {
  const drawn = slideContent(slide).objects;
  const pictures = new Set<string>();
  let characters = 0;
  let families = 0;
  let sizeScales = 0;
  for (const o of drawn) {
    if (!isObj(o)) continue;
    if (o.type === 'image' && typeof o.mediaId === 'string') pictures.add(o.mediaId);
    if (o.type !== 'text') continue;
    if (o.id !== slide.lyricObjectId && typeof o.text === 'string')
      characters = Math.max(characters, o.text.length);
    const fams = new Set<string>();
    const scales = new Set<number>();
    for (const r of Array.isArray(o.runs) ? o.runs : []) {
      const k = famKey(r?.fontFamily);
      if (k) fams.add(k);
      if (typeof r?.sizeScale === 'number') scales.add(r.sizeScale);
    }
    for (const p of Array.isArray(o.paras) ? o.paras : []) {
      const k = famKey(p?.bullet?.fontFamily);
      if (k) fams.add(k);
    }
    families = Math.max(families, fams.size);
    sizeScales = Math.max(sizeScales, scales.size);
  }
  const counts = {
    objects: drawn.length,
    pictures: pictures.size,
    bytes: jsonBytes(slide),
    characters,
    families,
    sizeScales,
  };
  const over: PictureOver[] = [];
  if (counts.bytes > SIZE_BUDGETS.slideMax) over.push('bytes');
  for (const k of Object.keys(PICTURE_COUNTS) as (keyof typeof PICTURE_COUNTS)[])
    if (counts[k] > PICTURE_COUNTS[k]) over.push(k);
  for (const r of cost?.(slide, PRERENDER_FRAME) ?? [])
    if (typeof r === 'string' && r && !over.includes(r)) over.push(r);
  const why: PicturePlan['why'] = [];
  if (over.includes('bytes')) why.push('bytes');
  if (over.some((r) => r !== 'bytes')) why.push('count');
  return { why, over, counts };
}

// ---------------------------------------------------------------------------------------------------------
// What stays live above the picture (design/29 §1.5)

/** An axis-aligned rect in logical px. */
export type Rect = { x: number; y: number; w: number; h: number };
/** Where an object can draw: the renderer's `objectBounds` where it is at hand, else `objectReach`. */
export type Reach = (o: SlideObject) => Rect;

const fin = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/** The axis-aligned bounds of a box turned about its centre. */
function rotatedBounds(b: unknown): Rect {
  const box = isObj(b) ? b : {};
  const w = fin(box.w, 0, 1e6, 0);
  const h = fin(box.h, 0, 1e6, 0);
  const cx = fin(box.x, -1e6, 1e6, 0) + w / 2;
  const cy = fin(box.y, -1e6, 1e6, 0) + h / 2;
  const th = (fin(box.rotation, -36_000, 36_000, 0) * Math.PI) / 180;
  const c = Math.abs(Math.cos(th));
  const s = Math.abs(Math.sin(th));
  const hw = (w * c + h * s) / 2;
  const hh = (w * s + h * c) / 2;
  return { x: cx - hw, y: cy - hh, w: 2 * hw, h: 2 * hh };
}

/** How far a shadow, outline, glow or stroke of `x` reaches past its box (the renderer's `effectMargin` rule). */
function effectMargin(x: unknown): number {
  if (!isObj(x)) return 0;
  let m = 0;
  const sh = x.shadow;
  if (isObj(sh))
    m = Math.max(
      m,
      Math.max(Math.abs(fin(sh.dx, -1e4, 1e4, 0)), Math.abs(fin(sh.dy, -1e4, 1e4, 0))) +
        2 * fin(sh.blur, 0, 1e4, 0),
    );
  if (isObj(x.outline)) m = Math.max(m, fin(x.outline.width, 0, 1e4, 0));
  if (isObj(x.glow)) m = Math.max(m, 2 * fin(x.glow.radius, 0, 1e4, 0));
  if (isObj(x.stroke)) m = Math.max(m, fin(x.stroke.width, 0, 1e4, 0));
  return m;
}

/**
 * Where an object can draw, without the renderer: its turned box widened by its effects' reach and a pixel of
 * anti-aliasing. A geometry's own overflow (a callout's tail) needs the renderer's `objectBounds`, which the
 * converter and the editor pass as `liveSet`'s reach.
 */
export function objectReach(o: SlideObject): Rect {
  const r = rotatedBounds((o as { box?: unknown })?.box);
  const m = Math.max(effectMargin(o), o?.type === 'text' ? effectMargin(o.style) : 0) + 1;
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Whether a text object has build steps: a paragraph laid out but not yet shown (`TextPara.hidden`). */
function hasSteps(o: SlideObject): boolean {
  return o.type === 'text' && Array.isArray(o.paras) && o.paras.some((p) => p?.hidden === true);
}

/**
 * A slide's anchors, bottom first (design/29 §1.5): the lyric box, text with build steps and pictures that
 * play (an in-slide video, a motion background in the slide), at most `LIVE_PLAYING_MAX` playing and
 * `LIVE_ANCHORS_MAX` in all (past them, W24: a picture shows its still, a step-by-step text all its steps).
 */
export function liveAnchors(slide: Pick<Slide, 'objects' | 'lyricObjectId'> & Partial<Slide>): string[] {
  const out: string[] = [];
  let playing = 0;
  for (const o of objectsOf(slide)) {
    if (!isObj(o) || out.length >= LIVE_ANCHORS_MAX) continue;
    const id = idOf(o);
    if (!id) continue;
    if (id === slide.lyricObjectId) out.push(id);
    else if (o.type === 'image' && isObj(o.play)) {
      if (playing < LIVE_PLAYING_MAX) {
        playing++;
        out.push(id);
      }
    } else if (hasSteps(o)) out.push(id);
  }
  return out;
}

/** The anchors among `anchors` with what lies above them and overlaps them; undefined past `PRERENDER_LIMITS.live`. */
function closure(
  objects: readonly SlideObject[],
  anchors: ReadonlySet<string>,
  reach: Reach,
): string[] | undefined {
  const live: string[] = [];
  const rects: Rect[] = [];
  for (const o of objects) {
    const id = idOf(o);
    if (!id) continue;
    const anchor = anchors.has(id);
    if (!anchor && !rects.length) continue;
    const r = reach(o);
    if (anchor || rects.some((x) => overlaps(r, x))) {
      if (live.length >= PRERENDER_LIMITS.live) return undefined;
      live.push(id);
      rects.push(r);
    }
  }
  return live;
}

/**
 * The live set (design/29 §1.5): the anchors plus every object above an anchor that overlaps it or overlaps an
 * object already live, with shadows and glows in its reach (`splitScene`'s rule, renderer `scene.ts`); bottom
 * first. Everything else is in the picture, under it: exact for source-over drawing. Past
 * `PRERENDER_LIMITS.live` ids the step-by-step texts, then the playing pictures, then the lyric box are drawn
 * into the picture instead, until it fits.
 */
export function liveSet(
  slide: Pick<Slide, 'objects' | 'lyricObjectId'> & Partial<Slide>,
  reach: Reach = objectReach,
): string[] {
  const objects = objectsOf(slide);
  const anchors = liveAnchors(slide);
  if (!anchors.length) return [];
  const byId = new Map(objects.map((o) => [idOf(o), o]));
  const lyric = anchors.filter((id) => id === slide.lyricObjectId);
  const playing = anchors.filter((id) => byId.get(id)?.type === 'image');
  for (const tier of [anchors, [...lyric, ...playing], lyric]) {
    if (!tier.length) continue;
    const live = closure(objects, new Set(tier), reach);
    if (live) return live;
  }
  return [];
}

// ---------------------------------------------------------------------------------------------------------
// The stand-in (design/29 §1.2)

/** A text object holding `text` in the plain style of `like`, at its box. */
function plainBox(id: string, like: SlideObject, text: string): TextObject {
  const base = like.type === 'shape' ? like.table?.base : undefined;
  const style: TextObject['style'] | undefined =
    like.type === 'text' ? like.style : isObj(base) ? (base as TextObject['style']) : undefined;
  return {
    id,
    type: 'text',
    box: like.box,
    text,
    style: style ?? { ...DEFAULT_LYRIC_STYLE, fontWeight: 400, fontSizePx: 24, align: 'left', valign: 'top' },
    opacity: 1,
  };
}

/** `text` cut into pieces of at most `STAND_IN_TEXT_MAX` characters, at a line break where one is near. */
function splitText(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > STAND_IN_TEXT_MAX) {
    let cut = rest.lastIndexOf('\n', STAND_IN_TEXT_MAX);
    if (cut < STAND_IN_TEXT_MAX / 2) cut = STAND_IN_TEXT_MAX;
    // Never between the halves of a surrogate pair.
    const c = rest.charCodeAt(cut - 1);
    if (cut === STAND_IN_TEXT_MAX && c >= 0xd800 && c <= 0xdbff) cut--;
    out.push(rest.slice(0, cut));
    rest = rest.slice(rest[cut] === '\n' ? cut + 1 : cut);
  }
  out.push(rest);
  return out;
}

/** The text of a simplified object a stand-in would merge (a text box's, a table's cells'). */
const textOf = (o: SlideObject): string =>
  o.type === 'text' ? o.text : o.type === 'shape' ? tableText(o.table) : '';

/** The area of an object's box. */
const areaOf = (o: SlideObject): number => fin(o?.box?.w, 0, 1e6, 0) * fin(o?.box?.h, 0, 1e6, 0);

/**
 * The stand-in of a full slide (design/29 §1.2): the live objects whole, then the simplified rest
 * (`minimalSlide`: text and tables plain, pictures as they are, the background as its colour), capped to what a
 * screen draws at once (`PICTURE_COUNTS` objects and pictures): live first, then text, then pictures by area,
 * kept in z order. Text that does not fit is merged into plain boxes of at most 20,000 characters within the cap
 * (only past that is it cut, W5). Every other field is the full slide's: notes, cues, timing, provenance. What an
 * older build draws, what every reader reads (search, cue labels, Stage, lyric-only looks, Bottom-Third Stream)
 * and what a screen draws with neither the file nor the picture. `prerender.live` is set to `live`.
 */
export function standInOf(full: Slide, live: readonly string[]): Slide {
  const objects = objectsOf(full);
  const liveIds = new Set(live);
  const rest = objects.filter((o) => !liveIds.has(idOf(o)));
  // `minimalSlide` keeps ids and order: walk its result against the rest to know each one's z position.
  const minimal = objectsOf(minimalSlide({ ...full, objects: rest }));
  type Kept = { z: number; o: SlideObject; kind: 'live' | 'bg' | 'text' | 'picture' };
  const all: Kept[] = [];
  const zOf = new Map<SlideObject, number>(objects.map((o, z) => [o, z]));
  for (const o of objects) if (liveIds.has(idOf(o))) all.push({ z: zOf.get(o)!, o, kind: 'live' });
  let j = 0;
  for (const m of minimal) {
    while (j < rest.length && idOf(rest[j]) !== idOf(m)) j++;
    const z = j < rest.length ? zOf.get(rest[j]!)! : objects.length;
    j++;
    const kind =
      m.type === 'image' ? 'picture' : m.type === 'text' || (m.type === 'shape' && m.table) ? 'text' : 'bg';
    all.push({ z, o: m, kind });
  }
  const chosen: Kept[] = [];
  const media = new Set<string>();
  const room = () => PICTURE_COUNTS.objects - chosen.length;
  const fitsMedia = (o: SlideObject) =>
    o.type !== 'image' || media.has(o.mediaId) || media.size < PICTURE_COUNTS.pictures;
  const take = (k: Kept) => {
    chosen.push(k);
    if (k.o.type === 'image') media.add(k.o.mediaId);
  };
  for (const k of all.filter((k) => k.kind === 'bg')) if (room() > 0) take(k);
  // The live objects: the anchors first (the lyric box, the playing pictures), then the rest bottom first.
  const anchors = new Set(liveAnchors(full));
  const liveKept = all.filter((k) => k.kind === 'live');
  for (const k of [
    ...liveKept.filter((k) => anchors.has(idOf(k.o))),
    ...liveKept.filter((k) => !anchors.has(idOf(k.o))),
  ])
    if (room() > 0 && fitsMedia(k.o)) take(k);
  // Text: whole boxes while they fit, the rest merged into plain boxes of at most 20,000 characters.
  const texts = all.filter((k) => k.kind === 'text').sort((a, b) => a.z - b.z);
  const boxesFor = (from: number) => {
    let n = 0;
    for (let i = from; i < texts.length; i++) n += textOf(texts[i]!.o).length + 1;
    return n ? Math.ceil(n / STAND_IN_TEXT_MAX) : 0;
  };
  let whole = Math.min(texts.length, room());
  while (whole > 0 && whole + boxesFor(whole) > room()) whole--;
  for (const k of texts.slice(0, whole)) take(k);
  const merged = texts.slice(whole);
  if (merged.length) {
    const joined = merged.map((k) => textOf(k.o)).join('\n');
    const used = new Set(objects.map(idOf));
    const pieces = splitText(joined).slice(0, Math.max(0, room()));
    let at = 0;
    pieces.forEach((piece, n) => {
      // Each piece sits at the box of the first object whose text it starts in.
      let first = merged[0]!;
      let pos = 0;
      for (const k of merged) {
        if (pos > at) break;
        first = k;
        pos += textOf(k.o).length + 1;
      }
      at += piece.length + 1;
      const base = `${idOf(first.o).slice(0, 180)}~${n + 1}`;
      let id = base;
      for (let i = 2; used.has(id); i++) id = `${base}.${i}`;
      used.add(id);
      take({ z: first.z + n / (pieces.length + 1), o: plainBox(id, first.o, piece), kind: 'text' });
    });
  }
  // Pictures by area, the largest first, within the distinct-picture cap.
  const pics = all.filter((k) => k.kind === 'picture').sort((a, b) => areaOf(b.o) - areaOf(a.o) || a.z - b.z);
  for (const k of pics) if (room() > 0 && fitsMedia(k.o)) take(k);
  const out = chosen.sort((a, b) => a.z - b.z).map((k) => k.o);
  const kept = new Set(out.map(idOf));
  const { lyricObjectId, prerender, ...restFields } = full;
  const record: SlidePrerender = { ...(prerender ?? { why: [] }), live: [...live] };
  return {
    ...restFields,
    objects: out,
    ...(lyricObjectId && kept.has(lyricObjectId) ? { lyricObjectId } : {}),
    prerender: record,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The picture's key (design/29 §1.2)

/** Fields of an object that never change what it draws: left out of the drawn part. */
const UNDRAWN = new Set(['id', 'origin', 'locked']);

/** What the picture draws: the slide's picture under its objects (`slideContent`), and the objects not live. */
export type DrawnPart = { picture?: string; objects: Record<string, unknown>[] };

/**
 * The drawn part of a full slide (design/29 §1.2): its picture (`slideContent`: a reference picture or an
 * imported page) and the objects the picture draws, bottom first, without the live set and without each
 * object's id, origin and lock, which never change a pixel.
 */
export function drawnPart(full: Slide, live: readonly string[] = full.prerender?.live ?? []): DrawnPart {
  const c = slideContent(full);
  const liveIds = new Set(live);
  const objects: Record<string, unknown>[] = [];
  for (const o of c.objects) {
    if (!isObj(o) || liveIds.has(idOf(o))) continue;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!UNDRAWN.has(k)) out[k] = v;
    objects.push(out);
  }
  return { ...(c.pictureMediaId ? { picture: c.pictureMediaId } : {}), objects };
}

/** What a picture's key is computed from besides the slide: the library's files and faces. */
export type PictureInputs = {
  /** The file a drawn picture decodes (`stillFile(media).hash`: an image's delivery, a video's poster). */
  mediaFile(mediaId: string): string | undefined;
  /** The library's faces, bundled ones included (`Font` rows). */
  fonts: readonly { family: string; file: { hash: string } }[];
  /** The font scope of the faces (`familyKey`): '' today. */
  scope?: string;
  /** false: the variant without the slide's backdrops, for a background override (question 5). */
  backdrops?: boolean;
};

/** A picture's source (design/29 §1.2), canonical JSON of which (with the version) is hashed into its key. */
export type PictureSource = {
  kind: 'slide';
  frame: [number, number];
  /** SHA-256 of the drawn part's canonical JSON. */
  slide: string;
  live: string[];
  backdrops: boolean;
  /** The file each drawn picture decodes; null when the library lacks it. */
  media: Record<string, string | null>;
  /** Every face of the resolution chain of the picture's text: by family (lower case), sorted; null if none. */
  fonts: { scope: string; faces: Record<string, string[] | null> };
  fallback: string;
};

/** The families the picture's text resolves through: its own, `fallbackFonts`, script fallbacks, the default. */
function chainFamilies(objects: readonly Record<string, unknown>[]): Set<string> {
  const fams = new Set<string>();
  const add = (f: unknown) => {
    const k = famKey(f);
    if (k) fams.add(k);
  };
  const scripts = new Set<string>();
  const scan = (t: string) => {
    if (!t) return;
    const found = fallbackFontScripts(t);
    const kanaOrHangul = found.has('Hira') || found.has('Kana') || found.has('Hang');
    for (const code of found) if (code !== 'Hani' || !kanaOrHangul) scripts.add(code);
  };
  let text = false;
  for (const o of objects) {
    if (o.type === 'text') {
      text = true;
      const style = isObj(o.style) ? o.style : {};
      add(style.fontFamily);
      for (const f of Array.isArray(style.fallbackFonts) ? style.fallbackFonts : []) add(f);
      for (const r of Array.isArray(o.runs) ? o.runs : []) add(isObj(r) ? r.fontFamily : undefined);
      for (const p of Array.isArray(o.paras) ? o.paras : [])
        add(isObj(p) && isObj(p.bullet) ? p.bullet.fontFamily : undefined);
      scan(typeof o.text === 'string' ? o.text : '');
    } else {
      const extra = extraFontFamilies(o as SlideObject);
      if (extra.length) text = true;
      for (const f of extra) add(f);
      scan(extraText(o as SlideObject));
    }
  }
  for (const code of scripts) for (const f of SCRIPT_FALLBACK_FONTS[code] ?? []) add(f);
  if (text) add(DEFAULT_FONT);
  return fams;
}

/**
 * The source of a picture of `full` with `live` drawn above it (design/29 §1.2): the drawn part's digest (from
 * the full slide's pages or inline, never the head's hash, so ids, origins and locks never change it), the live
 * set, the backdrops variant, the file each drawn picture decodes, every face of the resolution chain and the
 * fallback faces' digest.
 */
export function pictureSource(full: Slide, live: readonly string[], inputs: PictureInputs): PictureSource {
  const part = drawnPart(full, live);
  const media: Record<string, string | null> = {};
  const addMedia = (id: unknown) => {
    if (typeof id === 'string' && id && !(id in media)) media[id] = inputs.mediaFile(id) ?? null;
  };
  addMedia(part.picture);
  for (const o of part.objects) if (o.type === 'image') addMedia(o.mediaId);
  const faces: Record<string, string[] | null> = {};
  for (const fam of chainFamilies(part.objects)) {
    const hashes = new Set<string>();
    for (const f of inputs.fonts)
      if (famKey(f?.family) === fam && typeof f.file?.hash === 'string') hashes.add(f.file.hash);
    faces[fam] = hashes.size ? [...hashes].sort() : null;
  }
  return {
    kind: 'slide',
    frame: [PRERENDER_FRAME.width, PRERENDER_FRAME.height],
    slide: sha256Text(canonicalJson(part)),
    live: [...live],
    backdrops: inputs.backdrops !== false,
    media,
    fonts: { scope: inputs.scope ?? '', faces },
    fallback: FALLBACK_FACES_DIGEST,
  };
}

/** A picture's key: the SHA-256 of `{ v: PRERENDER_VERSION, source }` (design/29 §1.2). Never stored on a slide. */
export function prerenderKey(source: PictureSource, version: number = PRERENDER_VERSION): string {
  return sha256Text(canonicalJson({ v: version, source }));
}

/**
 * A picture's stand-by id (design/29 §1.2): its slide, live set, backdrops and media files, without fonts or the
 * renderer's version, so a picture made before a font upload or by an older renderer stands in (W39) while the
 * new one is made; a replaced picture file has none (owner question 11).
 */
export function standbyId(source: PictureSource): string {
  const { slide, live, backdrops, media } = source;
  return sha256Text(canonicalJson({ slide, live, backdrops, media }));
}

// ---------------------------------------------------------------------------------------------------------
// Draw as (design/29 §1.2)

/**
 * Whether a slide is drawn from its picture or live: `slide.draw ?? meta.draw ?? 'picture'` for a pre-rendered
 * slide, except that a `tail` slide without its own switch is drawn live from its file unless its estimate at
 * 4K (passed in) passes 0.3 s (owner question 10); a slide without a record is live unless set to Pre-rendered.
 */
export function resolveDraw(
  slide: Pick<Slide, 'draw' | 'prerender'> & Partial<Slide>,
  meta?: { draw?: DrawAs },
  opts: { estimateMs?: number } = {},
): DrawAs {
  if (!slide.prerender) return slide.draw === 'picture' ? 'picture' : 'live';
  if (slide.draw) return slide.draw;
  const why = slide.prerender.why;
  const tailOnly = why.includes('tail') && !why.some((w) => w !== 'tail');
  if (tailOnly && !((opts.estimateMs ?? 0) > TAIL_PICTURE_MS)) return 'live';
  return meta?.draw ?? 'picture';
}

// ---------------------------------------------------------------------------------------------------------
// Every writer through the full slide (design/29 §1.8)

/** What `withFullSlide` needs besides the slide: the library (for the key), the reach and the cost reasons. */
export type FullSlideInputs = PictureInputs & { reach?: Reach; cost?: CostReasons };

/** A full slide written: the slide, what the presentation stores, its file and its picture's key. */
export type FullSlideResult = {
  /** The full slide after the operation. */
  full: Slide;
  /** What the presentation stores: the stand-in, or the slide itself when it is stored inline whole. */
  standIn: Slide;
  /** The slide file to upload (pages the hub lacks first, then the head); absent when stored inline. */
  pages?: SlideFile;
  /** The picture's key and stand-by id; absent when the slide gets no picture. */
  key?: string;
  standbyId?: string;
  /** Why the full form was refused (W18): the slide keeps only its stand-in, with no file and no picture. */
  refused?: string;
};

/** What the file draws (`Slide.prerender.uses`), within its bounds; the hub rewrites it from its own record. */
function usesOf(full: Slide): NonNullable<SlidePrerender['uses']> {
  const media = new Set<string>([...drawnMediaIds(full), ...slideMediaIds(full)]);
  const files = drawnShapeFileRefs(full).filter(isGeomFileRef);
  const fonts = new Set<string>();
  for (const o of objectsOf(full)) {
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
  return {
    media: [...media].slice(0, PRERENDER_LIMITS.media),
    files: files.slice(0, PRERENDER_LIMITS.files),
    fonts: [...fonts].slice(0, PRERENDER_LIMITS.fonts),
  };
}

/**
 * The one way every writer changes a pre-rendered slide (design/29 §1.8, §1.12): `fn` changes the full slide
 * (loaded from its file by the caller: `slideFromFile`), and the result is planned again (`pictureUnits`; `tail`
 * kept; `chosen` when it is set to Pre-rendered and needs none), written into new pages, and its stand-in and
 * key rebuilt. A slide that no longer needs a picture is stored inline whole; a `chosen` one inline with its
 * record; one the content store cannot hold keeps only its stand-in (W18). An operation that changes only what
 * the file does not hold (notes, cues, timing) changes neither the pages nor the key. Pure.
 */
export function withFullSlide(
  full: Slide,
  fn: (slide: Slide) => Slide,
  inputs: FullSlideInputs,
): FullSlideResult {
  const next = fn(full);
  const plan = pictureUnits(next, inputs.cost);
  const reasons = new Set<PrerenderWhy>(plan.why);
  if (full.prerender?.why.includes('tail') || next.prerender?.why.includes('tail')) reasons.add('tail');
  if (!reasons.size && next.draw === 'picture') reasons.add('chosen');
  const why = PRERENDER_WHY.filter((w) => reasons.has(w));
  if (!why.length) {
    const { prerender: _, ...inline } = next;
    return { full: next, standIn: inline };
  }
  const live = liveSet(next, inputs.reach);
  const key = () => {
    const src = pictureSource(next, live, inputs);
    return { key: prerenderKey(src), standbyId: standbyId(src) };
  };
  if (why.length === 1 && why[0] === 'chosen')
    return { full: next, standIn: { ...next, prerender: { why, live } }, ...key() };
  let pages: SlideFile;
  try {
    pages = slideFileOf(next);
  } catch (e) {
    if (!(e instanceof SlideFileRefusal)) throw e;
    const standIn = standInOf({ ...next, prerender: { why: ['bytes'], live } }, live);
    return { full: next, standIn: { ...standIn, prerender: { why: ['bytes'], live } }, refused: e.message };
  }
  const record: SlidePrerender = {
    why,
    file: { ref: pages.name, bytes: pages.bytes },
    live,
    uses: usesOf(next),
  };
  const standIn = standInOf({ ...next, prerender: record }, live);
  return { full: next, standIn, pages, ...key() };
}
