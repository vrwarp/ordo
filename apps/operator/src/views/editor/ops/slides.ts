import {
  type ImageObject,
  type Media,
  type Presentation,
  replaceText,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextPara,
  type TextRun,
  type TextStyle,
  withoutBackdropObjects,
} from '@ordo/domain';
import { cloneSlide, findSlide, getSlide, lyricObject, markOverride } from '../ops.ts';
import { withEverySlide, withSlide } from './common.ts';
import { type PictureSize, replacePicture } from './pictures.ts';

/*
 * Slide and presentation ops (M4 item E; design/27 §11 items 6-11). Each is one undo step through the
 * actions in `../actions.ts` and returns `p` itself when nothing changes.
 */

/** The schema's bound on a text object's text (`MAX.text`): a replacement that would pass it is not made. */
export const MAX_TEXT = 20_000;
/** The schema's bound on a text object's paragraph styles (`TextObject.paras`). */
export const MAX_PARAS = 5000;
/** The schema's bound on a section's slides (`Section.slides`): 'New slide like this' stops there. */
export const MAX_SECTION_SLIDES = 5000;

/** Find options: `case` matches case; `wholeWord` matches only whole words (Unicode letters and digits). */
export type FindOptions = { case?: boolean; wholeWord?: boolean };

/** One match: a text object of a slide and the offsets of the matched text in its `text`. */
export type TextMatch = { slideId: string; objectId: string; start: number; end: number };

/** A character that is part of a word for 'Whole words': a letter, a combining mark or a digit. */
const WORD = /^[\p{L}\p{M}\p{N}]/u;
/** The pattern characters a `u` RegExp needs escaped (the syntax characters; any other escape is an error). */
const SYNTAX = /[\\^$.*+?()[\]{}|/]/g;
/** The spaces a typed space also finds: PowerPoint text keeps no-break spaces ('Dieu !', '12 May'). */
const SPACES = '[ \\u00a0\\u202f]';

function matcher(find: string, opts: FindOptions): RegExp {
  const src = Array.from(find, (c) => (c === ' ' ? SPACES : c.replace(SYNTAX, '\\$&'))).join('');
  return new RegExp(src, opts.case ? 'gu' : 'giu');
}

/** The code point that ends at offset `i` of `s` ('' at the start). */
function before(s: string, i: number): string {
  if (i <= 0) return '';
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s.slice(i - 1, i);
}

/** The code point that starts at offset `i` of `s` ('' at the end). */
function after(s: string, i: number): string {
  const c = s.codePointAt(i);
  return c === undefined ? '' : String.fromCodePoint(c);
}

/**
 * The matches of `find` in `text`, as [start, end) offsets, left to right and never overlapping. Case is
 * folded unless `opts.case` (Unicode simple folding, so offsets stay the text's); a space in `find` also
 * finds a no-break space; `opts.wholeWord` keeps a match only when the characters around it are not letters,
 * marks or digits ('love' is not found in 'loved', '3:16' not in '13:16'). An empty `find` matches nothing.
 */
export function matchesIn(text: string, find: string, opts: FindOptions = {}): [number, number][] {
  if (!find || !text) return [];
  const re = matcher(find, opts);
  const out: [number, number][] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (end === start) {
      re.lastIndex = start + Math.max(1, after(text, start).length);
      continue;
    }
    if (opts.wholeWord && (WORD.test(before(text, start)) || WORD.test(after(text, end)))) {
      // Try again from the next character: 'Sun' in 'Sunday Sun' is the second one.
      re.lastIndex = start + Math.max(1, after(text, start).length);
      continue;
    }
    out.push([start, end]);
  }
  return out;
}

/** Text objects the find dialog searches: every unlocked one (a locked object's text is read-only). */
const searchable = (o: SlideObject): o is TextObject => o.type === 'text' && !o.locked;

/**
 * Every match of `find` in the presentation's text objects, in authoring order, hidden slides included
 * (the dialog's '3 matches on 2 slides'). Matches are in `TextObject.text`, what the textarea shows, so the
 * automatic numbers `readableText` writes are not matched. Locked objects are not searched (their text is
 * read-only). An empty `find` matches nothing. At most `limit` matches are returned (the dialog lists a
 * bounded number; a pathological deck must not build millions of rows).
 */
export function findText(
  p: Presentation,
  find: string,
  opts: FindOptions = {},
  limit = Number.POSITIVE_INFINITY,
): TextMatch[] {
  const out: TextMatch[] = [];
  if (!find) return out;
  for (const sec of p.sections)
    for (const s of sec.slides)
      for (const o of s.objects) {
        if (!searchable(o)) continue;
        for (const [start, end] of matchesIn(o.text, find, opts)) {
          if (out.length >= limit) return out;
          out.push({ slideId: s.id, objectId: o.id, start, end });
        }
      }
  return out;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** Whether offset `i` of `s` is not inside a surrogate pair. */
const boundary = (s: string, i: number) =>
  i <= 0 || i >= s.length || !(isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i)));

/**
 * What of `m` really changes into `r`: their common start and end trimmed (never inside a surrogate pair),
 * as `[k, m.length - j)` of `m` becoming `r.slice(k, r.length - j)`. Typing the change in the text field
 * (`editText`'s prefix and suffix) changes the same characters, so both keep the same styles.
 */
export function changedPart(m: string, r: string): { k: number; j: number } {
  const max = Math.min(m.length, r.length);
  let k = 0;
  while (k < max && m.charCodeAt(k) === r.charCodeAt(k)) k++;
  if (!boundary(m, k) || !boundary(r, k)) k--;
  let j = 0;
  while (j < max - k && m.charCodeAt(m.length - 1 - j) === r.charCodeAt(r.length - 1 - j)) j++;
  while (j > 0 && (!boundary(m, m.length - j) || !boundary(r, r.length - j))) j--;
  return { k, j };
}

/**
 * `o` with every match of `find` replaced by `repl`, from the last to the first so the offsets stay valid.
 * Each match is replaced as typing the same change in the text field would (the rule `editText` applies):
 * only the part of the match that differs from `repl` is replaced (`changedPart`: 'on Sunday' → 'on
 * Saturday' replaces 'un' with 'atur'), and that part takes the style of the first character it replaces,
 * so a bold red date stays bold and red and the words around it keep their own style; an insertion takes
 * the style of the text before it. Runs and paragraph styles shift with the text and the box style (its
 * `fitScale` too) is untouched. A match already equal to `repl` is left alone; a result past `MAX_TEXT` is
 * refused (`o` and 0).
 */
function replaceIn(
  o: TextObject,
  find: string,
  repl: string,
  opts: FindOptions,
): { o: TextObject; n: number } {
  const ms = matchesIn(o.text, find, opts);
  if (!ms.length) return { o, n: 0 };
  let len = o.text.length;
  for (const [a, b] of ms) len += repl.length - (b - a);
  if (len > MAX_TEXT) return { o, n: 0 };
  let cur = o;
  let n = 0;
  for (let i = ms.length - 1; i >= 0; i--) {
    const [a, b] = ms[i]!;
    const m = cur.text.slice(a, b);
    if (m === repl) continue;
    const { k, j } = changedPart(m, repl);
    cur = replaceText(cur, a + k, b - j, repl.slice(k, repl.length - j));
    n++;
  }
  return { o: cur, n };
}

/**
 * Find and replace across the presentation (design/27 §11 item 8): every match of `findText` replaced by
 * `repl` as typing the change would replace it (`editText`'s rule), so formatting stays (the changed part
 * takes the style of the text it replaces: a bold date stays bold, the plain words around it stay plain). One change, one undo step; `replaced` counts the matches that
 * changed (a match already equal to `repl` is not counted). Locked objects are left alone, and an object
 * whose text would pass the schema's bound (`MAX_TEXT`) keeps its text.
 */
export function findReplace(
  p: Presentation,
  find: string,
  repl: string,
  opts: FindOptions = {},
): { p: Presentation; replaced: number } {
  if (!find) return { p, replaced: 0 };
  let replaced = 0;
  const next = withEverySlide(p, (s) => {
    let changed = false;
    const objects = s.objects.map((o) => {
      if (!searchable(o)) return o;
      const r = replaceIn(o, find, repl, opts);
      if (r.o === o) return o;
      changed = true;
      replaced += r.n;
      return r.o;
    });
    return changed ? { ...s, objects } : s;
  });
  return { p: next, replaced };
}

/**
 * Hide or unhide a slide (design/27 §9, §11 item 9): `Slide.hidden` set, or removed when false. Its cue is
 * flagged hidden: Next, Prev, auto-advance and onEnd skip it; a click in the slide grid shows it. The editor
 * dims it in the slide list.
 */
export function hideSlide(p: Presentation, slideId: string, hidden: boolean): Presentation {
  return withSlide(p, slideId, (s) => {
    if (!!s.hidden === hidden) return s;
    if (hidden) return { ...s, hidden: true };
    const { hidden: _hidden, ...rest } = s;
    return rest;
  });
}

// ---- backgrounds ---------------------------------------------------------------------------------------

/** 'Replace background on this slide' or 'on all slides using it'. */
export type BackgroundScope = 'slide' | 'all';

/**
 * A new background: a picture, or a video (`kind: 'video'`, 'Use video as motion background', design/27
 * §11 item 7). A `Media` record is one.
 */
export type BackgroundMedia = PictureSize & { kind?: Media['kind'] };

/** Where a slide's background picture is: a bottom `role: 'bg'` picture, its own, or the presentation's. */
export type SlideBackground = {
  mediaId: string;
  from: 'object' | 'slide' | 'presentation';
  /** The picture object, for `from: 'object'`. */
  objectId?: string;
};

/** A PowerPoint background picture (`origin.role: 'bg'`) the ops may replace: unlocked, not a video. */
const isBgPicture = (o: SlideObject): o is ImageObject =>
  o.type === 'image' && o.origin?.role === 'bg' && !o.locked && !o.play;

/**
 * The background picture a slide shows: its bottom `role: 'bg'` picture (the import's background of a 4:3
 * deck, or a picture that may be transparent, laid on white), drawn over any `backgroundMediaId`; else its
 * own `backgroundMediaId`; else the presentation's. Undefined when it has none (a solid or gradient
 * PowerPoint background, a `role: 'bg'` shape, or nothing).
 */
export function slideBackground(p: Presentation, s: Slide): SlideBackground | undefined {
  const o = s.objects.find(isBgPicture);
  if (o) return { mediaId: o.mediaId, from: 'object', objectId: o.id };
  if (s.backgroundMediaId) return { mediaId: s.backgroundMediaId, from: 'slide' };
  if (p.backgroundMediaId) return { mediaId: p.backgroundMediaId, from: 'presentation' };
  return undefined;
}

/**
 * The slides that show `mediaId` as their background (`slideBackground`), or with `undefined` the slides
 * that show none: the 'All 12 slides using it' of the scope choice.
 */
export function slidesUsingBackground(p: Presentation, mediaId: string | undefined): string[] {
  const out: string[] = [];
  for (const sec of p.sections)
    for (const s of sec.slides) if (slideBackground(p, s)?.mediaId === mediaId) out.push(s.id);
  return out;
}

/**
 * The presentation's own background for 'Replace on all slides': its `backgroundMediaId`, else the picture
 * most of its slides show (an imported 4:3 deck has one per slide), else none. Ties go to the first slide's.
 */
export function deckBackground(p: Presentation): string | undefined {
  if (p.backgroundMediaId) return p.backgroundMediaId;
  const count = new Map<string, number>();
  let best: string | undefined;
  for (const sec of p.sections)
    for (const s of sec.slides) {
      const id = slideBackground(p, s)?.mediaId;
      if (!id) continue;
      const n = (count.get(id) ?? 0) + 1;
      count.set(id, n);
      if (!best || n > count.get(best)!) best = id;
    }
  return best;
}

/**
 * `objects` without the solid or gradient background at their bottom (`role: 'bg'` shapes: a PowerPoint
 * slide's background fill, a ProPresenter slide's own colour or its presentation's background; the
 * domain's `withoutBackdropObjects`, which the screens use over a Background override too).
 */
function withoutBgShapes(objects: SlideObject[]): SlideObject[] {
  return withoutBackdropObjects(objects);
}

/**
 * One slide with background `old` (undefined: none) replaced by `media`:
 * - its `role: 'bg'` pictures of `old` re-cropped to the new picture (`replacePicture`: cover-cropped to the
 *   box, never distorted), or for a video removed, the video becoming the slide's `backgroundMediaId`;
 * - its own `backgroundMediaId` of `old` replaced; with `own` (scope 'slide'), a slide that shows no
 *   background picture object takes `media` as its own `backgroundMediaId`;
 * - a slide whose drawn background becomes `media` through `backgroundMediaId` (its own, or `inherited`, the
 *   presentation's after the change) loses the `role: 'bg'` shapes at its bottom, the PowerPoint solid or
 *   gradient background that would hide it.
 */
function retarget(
  s: Slide,
  old: string | undefined,
  media: BackgroundMedia,
  own: boolean,
  inherited: { before?: string; after?: string },
): Slide {
  const video = media.kind === 'video';
  let objects = s.objects;
  let removed = false;
  if (old !== undefined) {
    let changed = false;
    const out: SlideObject[] = [];
    for (const o of s.objects) {
      if (!isBgPicture(o) || o.mediaId !== old) out.push(o);
      else if (video) changed = removed = true;
      else {
        const r = replacePicture(o, media);
        if (r !== o) changed = true;
        out.push(r);
      }
    }
    if (changed) objects = out;
  }
  const picture = objects.some(isBgPicture);
  let bg = s.backgroundMediaId;
  if (old !== undefined && bg === old) bg = media.id;
  if ((own || removed) && !picture) bg = media.id;
  const drawnBefore = s.objects.some(isBgPicture) ? undefined : (s.backgroundMediaId ?? inherited.before);
  const drawnAfter = picture ? undefined : (bg ?? inherited.after);
  if (drawnAfter === media.id && drawnBefore !== media.id) objects = withoutBgShapes(objects);
  if (objects === s.objects && bg === s.backgroundMediaId) return s;
  const next: Slide = { ...s, objects };
  if (bg === undefined) delete next.backgroundMediaId;
  else next.backgroundMediaId = bg;
  return next;
}

/**
 * Replace a slide's background with `media` (design/27 §11 item 7), for sermon-series art. The slide's
 * background is `slideBackground`'s: its bottom ImageObject with `origin.role: 'bg'` (drawn over the
 * others), else its `backgroundMediaId`, else the presentation's. Scope 'all' rewrites every use of that
 * same picture (`replaceBackgroundOf`): slides' `backgroundMediaId`, `role: 'bg'` pictures and the
 * presentation's `backgroundMediaId`; 'slide' only this slide (a slide that used the presentation's
 * background gets its own `backgroundMediaId`). `role: 'bg'` pictures are re-cropped by the picture replace
 * rule (`replacePicture`), so a picture of another aspect is never distorted, and the cover-fit
 * `backgroundMediaId` never is. A slide with no background picture (a PowerPoint solid or gradient fill, a
 * bottom `role: 'bg'` shape) takes `media` as its `backgroundMediaId`, that shape removed, and with scope
 * 'all' so does every slide with none. A video (`kind: 'video'`) becomes the `backgroundMediaId` of the
 * slides it reaches, replacing their `role: 'bg'` pictures. Hybrid slides change too: their backgrounds are
 * never in the art. One undo step; `p` itself when the slide is missing or already shows `media`.
 */
export function replaceBackground(
  p: Presentation,
  slideId: string,
  media: BackgroundMedia,
  scope: BackgroundScope,
): Presentation {
  const s = getSlide(p, slideId);
  if (!s || !media.id) return p;
  const old = slideBackground(p, s)?.mediaId;
  if (old === media.id) return p;
  if (scope === 'all') return replaceBackgroundOf(p, old, media);
  const inherited = { before: p.backgroundMediaId, after: p.backgroundMediaId };
  return withSlide(p, slideId, (sl) => retarget(sl, old, media, true, inherited));
}

/**
 * 'Replace on all slides' for picture `old` (the Presentation panel's default background,
 * `deckBackground`): every use of it replaced by `media` as `replaceBackground` does with scope 'all'. With
 * `old` undefined, the slides that show no background picture take `media` (the presentation's
 * `backgroundMediaId`). `p` itself when nothing uses `old` or it is `media` already.
 */
export function replaceBackgroundOf(
  p: Presentation,
  old: string | undefined,
  media: BackgroundMedia,
): Presentation {
  if (!media.id || old === media.id) return p;
  const before = p.backgroundMediaId;
  const after = old === undefined || before === old ? media.id : before;
  const q = after === before ? p : { ...p, backgroundMediaId: after };
  const inherited = { before, after };
  return withEverySlide(q, (s) => {
    if (old === undefined && slideBackground(p, s)) return s;
    return retarget(s, old, media, false, inherited);
  });
}

/**
 * 'None' (or 'Use the default') for a slide's own background: its `backgroundMediaId` removed, so it shows
 * the presentation's again. `p` itself when it has none.
 */
export function clearSlideBackground(p: Presentation, slideId: string): Presentation {
  return withSlide(p, slideId, (s) => {
    if (s.backgroundMediaId === undefined) return s;
    const { backgroundMediaId: _bg, ...rest } = s;
    return rest;
  });
}

// ---- similar boxes -------------------------------------------------------------------------------------

/** An object of another slide that 'Apply to similar boxes' would restyle. */
export type SimilarObject = { slideId: string; objectId: string };

/**
 * What makes two boxes similar: the same PowerPoint placeholder (`origin.ph`, e.g. 'title', 'body:1'), else
 * the same master or layout shape (`role: 'deco'` and its `shapeId`). A slide's own boxes are never matched
 * by `shapeId`: PowerPoint numbers shapes per slide, so the same id on two slides is a coincidence.
 */
function similarKey(o: TextObject): string | undefined {
  const g = o.origin;
  if (!g) return undefined;
  if (g.ph) return `${g.src}\u0000ph\u0000${g.ph}`;
  if (g.role === 'deco' && g.shapeId !== undefined) return `${g.src}\u0000deco\u0000${g.shapeId}`;
  return undefined;
}

/**
 * The boxes similar to `objectId` (design/27 §11 item 10): text objects of other slides with the same
 * `origin.ph`, else the same `origin.role` and master `shapeId` (PowerPoint's placeholder and layout
 * shapes: `similarKey`). Locked objects are left out; hidden slides are included. For the confirmation
 * ('Apply to 12 boxes on 12 slides?').
 */
export function similarObjects(p: Presentation, slideId: string, objectId: string): SimilarObject[] {
  const src = getSlide(p, slideId)?.objects.find((o) => o.id === objectId);
  if (src?.type !== 'text' || src.locked) return [];
  const key = similarKey(src);
  if (!key) return [];
  const out: SimilarObject[] = [];
  for (const sec of p.sections)
    for (const s of sec.slides) {
      if (s.id === slideId) continue;
      for (const o of s.objects)
        if (o.type === 'text' && !o.locked && similarKey(o) === key)
          out.push({ slideId: s.id, objectId: o.id });
    }
  return out;
}

/** Equal as JSON values, whatever the key order (`undefined` members count as missing). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => same(v, bb[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same(ra[k], rb[k]));
}

/** Box style fields that do not move the text's lines: a box differing only in these keeps its fit. */
const LAYOUT_NEUTRAL: readonly (keyof TextStyle)[] = [
  'color',
  'outline',
  'shadow',
  'fill',
  'glow',
  'underline',
  'align',
  'valign',
  'justify',
];

function withoutKeys<T extends object>(o: T, keys: readonly string[]): Partial<T> {
  const out = { ...o } as Record<string, unknown>;
  for (const k of keys) delete out[k];
  return out as Partial<T>;
}

/**
 * `target`'s box style after taking `src`'s: `src`'s style without its `fitScale` (the fit of another
 * text). The target keeps its own `fitScale` while only fields that do not move lines change (colour, fill,
 * alignment, ...); otherwise it has none and the engine fits its text again. `target`'s style itself when
 * it already matches.
 */
function takeStyle(target: TextStyle, src: TextStyle): TextStyle {
  const want = withoutKeys(src, ['fitScale']) as TextStyle;
  if (same(withoutKeys(target, ['fitScale']), want)) return target;
  const neutral = [...LAYOUT_NEUTRAL, 'fitScale'];
  const keepsFit = target.fitScale && same(withoutKeys(target, neutral), withoutKeys(src, neutral));
  return keepsFit ? { ...want, fitScale: target.fitScale } : want;
}

/** The number of paragraphs of `text` (`text.split('\n').length`). */
function paraCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * `target`'s paragraph styles after taking `src`'s, by level, as a master's text styles apply
 * (design/27 §11 item 10 replaces master editing): each paragraph takes the style of `src`'s first
 * paragraph of its level (a soft line its paragraph's), keeping its own `soft` and `hidden` flags and its
 * own numbering start; a paragraph of a level `src` lacks keeps its style. `target.paras` itself when
 * nothing changes.
 */
function takeParas(target: TextObject, src: TextObject): (TextPara | null)[] | undefined {
  if (!src.paras?.length && !target.paras?.length) return target.paras;
  const byLevel = new Map<number, TextPara | null>();
  const n = paraCount(src.text);
  for (let i = 0; i < n; i++) {
    const sp = src.paras?.[i] ?? null;
    if (i > 0 && sp?.soft) continue;
    const lv = sp?.level ?? 0;
    if (!byLevel.has(lv)) byLevel.set(lv, sp);
  }
  const out: (TextPara | null)[] = [];
  let headLevel = 0;
  // The schema keeps at most `MAX_PARAS` paragraph styles (as `setParas` writes them): the paragraphs past
  // them keep none.
  const count = Math.min(paraCount(target.text), MAX_PARAS);
  for (let i = 0; i < count; i++) {
    const tp = target.paras?.[i] ?? null;
    const soft = i > 0 && tp?.soft === true;
    if (!soft) headLevel = tp?.level ?? 0;
    if (!byLevel.has(headLevel)) {
      out.push(tp);
      continue;
    }
    const { soft: _soft, hidden: _hidden, ...own } = byLevel.get(headLevel) ?? {};
    const res: TextPara = { ...own };
    if (res.bullet) {
      const { startAt: _startAt, ...bullet } = res.bullet;
      const start = tp?.bullet?.auto ? tp.bullet.startAt : undefined;
      res.bullet = bullet.auto && start !== undefined ? { ...bullet, startAt: start } : bullet;
    }
    if (soft) res.soft = true;
    if (tp?.hidden) res.hidden = true;
    out.push(Object.keys(res).length ? res : null);
  }
  let end = out.length;
  while (end > 0 && out[end - 1] == null) end--;
  const paras = out.slice(0, end);
  if (same(paras, target.paras ?? [])) return target.paras;
  return paras.length || target.paras !== undefined ? paras : undefined;
}

/**
 * 'Apply this box's style to similar boxes' (design/27 §11 item 10; it replaces master editing): every
 * `similarObjects` box takes this box's style and paragraph styles (`takeStyle`, `takeParas`), keeping its
 * own text and runs. On a themed presentation the lyric boxes that change mark the style fields they now
 * override (`style.<field>`), as the Object panel does, so the next theme keeps them. One undo step;
 * `changed` counts the boxes that changed.
 */
export function applyStyleToSimilar(
  p: Presentation,
  slideId: string,
  objectId: string,
): { p: Presentation; changed: number } {
  const src = getSlide(p, slideId)?.objects.find((o) => o.id === objectId);
  const targets = similarObjects(p, slideId, objectId);
  if (src?.type !== 'text' || !targets.length) return { p, changed: 0 };
  const bySlide = new Map<string, Set<string>>();
  for (const t of targets) {
    const ids = bySlide.get(t.slideId) ?? new Set<string>();
    ids.add(t.objectId);
    bySlide.set(t.slideId, ids);
  }
  let changed = 0;
  const next = withEverySlide(p, (s) => {
    const ids = bySlide.get(s.id);
    if (!ids) return s;
    const lyricId = p.themeId ? lyricObject(s)?.id : undefined;
    const marks: string[] = [];
    let any = false;
    const objects = s.objects.map((o) => {
      if (o.type !== 'text' || !ids.has(o.id)) return o;
      const style = takeStyle(o.style, src.style);
      const paras = takeParas(o, src);
      if (style === o.style && paras === o.paras) return o;
      any = true;
      changed++;
      if (o.id === lyricId)
        for (const k of new Set([...Object.keys(o.style), ...Object.keys(style)]) as Set<keyof TextStyle>)
          if (k !== 'fitScale' && !same(o.style[k], style[k])) marks.push(`style.${k}`);
      const out: TextObject = { ...o, style };
      if (paras === undefined) delete out.paras;
      else out.paras = paras;
      return out;
    });
    if (!any) return s;
    let sl: Slide = { ...s, objects };
    for (const m of marks) sl = markOverride(sl, m);
    return sl;
  });
  return { p: next, changed };
}

// ---- new slide like this -------------------------------------------------------------------------------

/**
 * The box style text typed into the cleared box takes: `o.style`, with the formatting of the run that styles
 * the whole first paragraph folded in where a box field holds it (family, weight, italics, size, colour,
 * spacing, underline, outline, shadow, language). A run over part of it (a raised verse number, a bold date)
 * is an accent, not the box's look, and is not kept; nor are fields a box has none of (highlight, strike,
 * raise, caps).
 */
function typedStyle(o: TextObject): TextStyle {
  const nl = o.text.indexOf('\n');
  const firstEnd = nl < 0 ? o.text.length : nl;
  const r: TextRun | undefined = o.runs?.find((x) => x.start === 0);
  if (!r || firstEnd === 0 || r.end < firstEnd) return o.style;
  const style: TextStyle = { ...o.style };
  if (r.fontFamily !== undefined) style.fontFamily = r.fontFamily;
  if (r.fontWeight !== undefined) style.fontWeight = r.fontWeight;
  if (r.fontStyle !== undefined) style.fontStyle = r.fontStyle;
  if (r.sizeScale !== undefined)
    style.fontSizePx = Math.min(5000, Math.max(1, Math.round(style.fontSizePx * r.sizeScale * 100) / 100));
  if (r.color !== undefined) style.color = r.color;
  if (r.letterSpacing !== undefined) style.letterSpacing = r.letterSpacing;
  if (r.underline !== undefined) style.underline = r.underline;
  if (r.outline === null) delete style.outline;
  else if (r.outline !== undefined) style.outline = r.outline;
  if (r.shadow === null) delete style.shadow;
  else if (r.shadow !== undefined) style.shadow = r.shadow;
  if (r.lang !== undefined) style.lang = r.lang;
  return style;
}

/** A text object of 'New slide like this': no text, its look kept for what is typed (locked ones as they are). */
function clearedText(o: SlideObject): SlideObject {
  if (o.type !== 'text' || o.locked) return o;
  const out: TextObject = { ...o, text: '', style: typedStyle(o) };
  if (o.runs !== undefined) out.runs = [];
  if (o.paras !== undefined) {
    const { soft: _soft, hidden: _hidden, ...first } = o.paras[0] ?? {};
    out.paras = Object.keys(first).length ? [first] : [];
  }
  return out;
}

/**
 * 'New slide like this' (design/27 §11 item 11): a copy of the slide right after it (`cloneSlide`: fresh ids,
 * no digest) with the text of its text objects cleared, keeping each box's style and its first paragraph's
 * style and first run's formatting (`typedStyle`), so a new verse or announcement is typed in the same look.
 * Notes are not copied, nor what described the old text: its scripture reference, its hidden flag, and its
 * PowerPoint picture (`pptx.refMediaId`, `show`), which would show the old slide over the new one. Pictures,
 * shapes and locked objects stay. `id`: the new slide (the editor selects it). A section already holding
 * `MAX_SECTION_SLIDES` slides gets none (`full`).
 */
export function newSlideLike(
  p: Presentation,
  slideId: string,
): { p: Presentation; id?: string; full?: true } {
  const pos = findSlide(p, slideId);
  if (!pos) return { p };
  // A section holds at most `MAX_SECTION_SLIDES` slides (the schema's bound): the hub would refuse the save.
  if (p.sections[pos.si]!.slides.length >= MAX_SECTION_SLIDES) return { p, full: true };
  const copy = cloneSlide(p.sections[pos.si]!.slides[pos.i]!);
  const { notes: _notes, hidden: _hidden, scripture: _scripture, ...rest } = copy;
  const slide: Slide = { ...rest, objects: copy.objects.map(clearedText) };
  if (slide.pptx) {
    const { refMediaId: _ref, show: _show, ...pptx } = slide.pptx;
    slide.pptx = pptx;
  }
  const sec = p.sections[pos.si]!;
  const slides = [...sec.slides];
  slides.splice(pos.i + 1, 0, slide);
  const sections = [...p.sections];
  sections[pos.si] = { ...sec, slides };
  return { p: { ...p, sections }, id: slide.id };
}

// ---- use as background ---------------------------------------------------------------------------------

/** The 1920x1080 frame, the whole screen (and the slide area of a 16:9 deck). */
const FRAME = { x: 0, y: 0, w: 1920, h: 1080 };
/** How far (px) a picture may fall short of the slide's edges and still count as covering it. */
const COVER_TOLERANCE = 2;

/**
 * Whether `o` is a picture that 'Use as background' takes: an unlocked ImageObject that does not play a
 * video, unrotated, whose box covers the whole 1920x1080 frame. A background is drawn cover-fit over the
 * whole frame, so on an imported deck that is not 16:9 a picture covering only its slide area
 * (`source.native.slideRect`, a 4:3 deck's pillarboxed area) is not offered: as a background it would grow
 * into the bars and lose a quarter of its height, and the slide would no longer look like the others. It
 * stays a picture, which 'Replace background' replaces without distortion all the same.
 */
export function coversSlide(_p: Presentation, o: SlideObject): o is ImageObject {
  if (o.type !== 'image' || o.locked || o.play) return false;
  const turn = ((o.box.rotation % 360) + 360) % 360;
  if (Math.min(turn, 360 - turn) > 0.01) return false;
  const r = FRAME;
  const x0 = Math.min(o.box.x, o.box.x + o.box.w);
  const x1 = Math.max(o.box.x, o.box.x + o.box.w);
  const y0 = Math.min(o.box.y, o.box.y + o.box.h);
  const y1 = Math.max(o.box.y, o.box.y + o.box.h);
  const t = COVER_TOLERANCE;
  return x0 <= r.x + t && y0 <= r.y + t && x1 >= r.x + r.w - t && y1 >= r.y + r.h - t;
}

/**
 * 'Use as background' (design/27 §11 item 6): a full-slide picture moved to the slide's
 * `backgroundMediaId` (the picture object removed), so the background pickers and `replaceBackground` handle
 * it. Only for a picture that covers the whole slide (`coversSlide`). The background is drawn cover-fit
 * under every object, so the picture's crop, mask, flip and opacity do not go with it; the PowerPoint
 * background under it (`role: 'bg'` objects below it, the white it is laid on) is removed, as it would now
 * hide it.
 */
export function useAsBackground(p: Presentation, slideId: string, objectId: string): Presentation {
  return withSlide(p, slideId, (s) => {
    const i = s.objects.findIndex((o) => o.id === objectId);
    const o = s.objects[i];
    if (!o || !coversSlide(p, o)) return s;
    const objects = s.objects.filter(
      (x, k) => k !== i && !(k < i && x.origin?.role === 'bg' && !x.locked && x.type !== 'text'),
    );
    return { ...s, objects, backgroundMediaId: o.mediaId };
  });
}
