import {
  editText as editRichText,
  type Rgba,
  type Slide,
  type TextObject,
  type TextPara,
  type TextRun,
  type TextStyle,
} from '@ordo/domain';
import { CLAMP } from '@ordo/renderer';

/*
 * Text ops (M4 item A; design/27 §11 items 1-4, "Themes"; §14 item 9). Pure functions over one TextObject:
 * the editor applies them through the actions in `../actions.ts` (one undo step each). Each returns `o`
 * itself when it changes nothing.
 *
 * Invariants every op keeps (the property tests: 10,000 random edits and formats):
 * - `runs` sorted by start, non-overlapping, each 0 <= start < end <= text.length, at most 2,000;
 * - characters outside the range an op touches keep their style;
 * - `paras` has at most one entry per paragraph (`text.split('\n')`) and no trailing nulls;
 * - an object without `runs` and `paras` gets neither from a text edit (a legacy object never turns rich by
 *   being typed in; formatting it does make it rich).
 *
 * Values are bounded as the schema bounds them (a size scale of 0.01-50, a baseline of -1..1, colour
 * channels, the paragraph spacings), so whatever the format bar sends, the save never fails validation.
 *
 * Theme override paths for runs (design/27 §11 "Themes"; `themedRuns`): a slide's `overrides` may hold
 * `runs.<field>` for each of `VISUAL_RUN_FIELDS` (`runs.color`, `runs.fontFamily`, `runs.sizeScale`,
 * `runs.letterSpacing`, `runs.outline`, `runs.shadow`, `runs.highlight`), or `runs` for all of them. The
 * format actions mark them (`runOverrides`, `textOnSlide`) when they set that field on the lyric object of a
 * presentation with a theme, so the next theme keeps the volunteer's colours and sizes there; the runs'
 * structural fields and `paras` are never dropped, so they need no path.
 */

/** A selection in a text object, as the textarea gives it: UTF-16 offsets [start, end). */
export type TextRange = { start: number; end: number };

/** The character formatting a run can carry: every TextRun field but its range. */
export type RunStyle = Omit<TextRun, 'start' | 'end'>;

/**
 * A formatting change for `formatRange`. A key with a value sets that field on every character of the range;
 * a key present with `undefined` removes the override there, so those characters take the box style again.
 * `outline: null` and `shadow: null` set "none", as in a run.
 */
export type RunPatch = { [K in keyof RunStyle]?: RunStyle[K] | undefined };

/** Every field a run can set. */
export const RUN_FIELDS = [
  'fontFamily',
  'fontWeight',
  'fontStyle',
  'sizeScale',
  'color',
  'highlight',
  'underline',
  'strike',
  'baseline',
  'letterSpacing',
  'caps',
  'outline',
  'shadow',
  'lang',
] as const satisfies readonly (keyof RunStyle)[];

/**
 * The run fields a theme replaces (design/27 §11 "Themes"): `applyTheme` drops these overrides from the lyric
 * object's runs unless the slide overrides them. The others are structural and survive a theme change:
 * weight, style, underline, strike, baseline (verse superscripts), caps, and the language.
 */
export const VISUAL_RUN_FIELDS = [
  'fontFamily',
  'color',
  'sizeScale',
  'letterSpacing',
  'outline',
  'shadow',
  'highlight',
] as const satisfies readonly (keyof RunStyle)[];

/** 'Clear formatting': every run field removed from the range, so it takes the box style. */
export const CLEAR_FORMATTING: RunPatch = Object.fromEntries(RUN_FIELDS.map((k) => [k, undefined]));

/** Runs one text object keeps at most (the schema's bound). */
const MAX_RUNS = 2000;
/** Paragraph styles one text object keeps at most (the schema's bound). */
const MAX_PARAS = 5000;
/** Slide overrides at most (the schema's bound). */
const MAX_OVERRIDES = 1000;

/**
 * The textarea's edit (design/27 §11 item 1): `o` with its text set to `next`, its runs and paragraph styles
 * following the change (`@ordo/domain` `editText`, placed by `caret`, the textarea's `selectionEnd`): retyped
 * text takes the style of the text it replaces, a typo fix inside a bold coloured word stays bold and
 * coloured, Enter copies the paragraph's style.
 *
 * The box style is never touched, so `style.fitScale` is kept, and with it the text size: the engine draws
 * the stored scale while the edited text still fits at it, and fits smaller when it does not (§6 step 10:
 * the result can only be smaller, so an edit never makes text jump larger, and deleting the extra text
 * brings the stored size back). A box drawn with a face other than the one PowerPoint fitted is fitted from
 * full size after every edit until the family is uploaded (§10, `storedFitHolds`). Only 'Re-fit text'
 * (`refitText`) clears `fitScale`.
 */
export function editText(o: TextObject, next: string, caret?: number): TextObject {
  return editRichText(o, next, caret);
}

/**
 * Format text[start, end) (design/27 §11 item 2): `patch` applied to every character of the range. Runs are
 * split at the range's ends and normalised: sorted, non-overlapping, inside the text, at most 2,000 (past
 * that the change is refused and `o` returned), equal neighbours merged, runs that set nothing dropped. An
 * empty range changes nothing. Bold is `fontWeight: 700` (normal `undefined`, or 400 over a bold box),
 * superscript `baseline: 0.3`, subscript `-0.25`.
 *
 * Offsets are clamped to the text and never cut a surrogate pair. Values are bounded as the schema bounds
 * them; a value that is not one (a size scale of zero, a colour that is not RGBA) is left out of the patch.
 * `sizeScale: 1` and `baseline: 0` are the box's own size and baseline, so they remove the override. A
 * selection across lines formats its line breaks too, which is what sizes an empty line (its end mark).
 */
export function formatRange(o: TextObject, start: number, end: number, patch: RunPatch): TextObject {
  const p = cleanRunPatch(patch);
  if (!Object.keys(p).length) return o;
  const [a, b] = span(o.text, start, end);
  if (a >= b) return o;
  return withRuns(o, a, b, (f) => patched(f, p));
}

/**
 * The format bar's Size ± for text[start, end): every character's size (`sizeScale`, relative to the box's
 * `fontSizePx`, so the box Size control still scales every run) multiplied by `factor`, within the clamp's
 * bounds (an effective size of 2-1,000 px, design/27 §3.2); a size equal to the box's drops `sizeScale`.
 * Scales are kept to four decimals, so Size + then Size − comes back to the box's size exactly.
 */
export function resizeRange(o: TextObject, start: number, end: number, factor: number): TextObject {
  if (!fin(factor) || factor <= 0 || factor === 1) return o;
  const [a, b] = span(o.text, start, end);
  if (a >= b) return o;
  const box = o.style.fontSizePx;
  const hi = Math.min(50, box > 0 ? CLAMP.maxFontPx / box : 50);
  const lo = Math.min(hi, Math.max(0.01, box > 0 ? CLAMP.minRunFontPx / box : 0.01));
  return withRuns(o, a, b, (f) => {
    const cur = f.sizeScale ?? 1;
    const next = clampN(Math.round(cur * factor * 10_000) / 10_000, lo, hi);
    if (Math.abs(next - 1) < 1e-9) return f.sizeScale === undefined ? f : without(f, 'sizeScale');
    return next === cur ? f : { ...f, sizeScale: next };
  });
}

/** What the format bar shows for a selection. */
export type SelectionStyle = {
  /**
   * The formatting the selection has: a field is present when every character of the range agrees, with
   * the box style counting for characters no run sets. For an empty range (a caret): the style text typed
   * there would take (`editText`'s rule).
   */
  style: RunStyle;
  /** The fields whose values differ across the range (shown as mixed). */
  mixed: (keyof RunStyle)[];
};

/**
 * The formatting of text[start, end), for the format bar's pressed states and values. Values are resolved
 * as the engine resolves them (renderer `itemize.ts` `resolveRunStyle`): a field a run does not set takes
 * the box's value (`fontFamily`, `fontWeight`, `fontStyle`, `color`, `letterSpacing`, `underline`,
 * `outline` and `shadow`, `null` for none, `lang`), or for fields the box has not, the default: `sizeScale`
 * 1, `baseline` 0, `strike` false, `caps` 'none' ('all' under an uppercase box); no highlight and no
 * language leave `highlight` and `lang` out. Line breaks are left out of a selection that holds other
 * characters (they are not drawn), so a bold line selected with its line break shows as bold.
 */
export function selectionStyle(o: TextObject, start: number, end: number): SelectionStyle {
  const [a, b] = span(o.text, start, end);
  const runs = validRuns(o.runs ?? [], o.text.length);
  if (a === b) {
    const at = ownerOffset(o.text, a);
    const run = at < 0 ? undefined : runs.find((r) => r.start <= at && at < r.end);
    return { style: resolved(o.style, run ? fieldsOf(run) : {}), mixed: [] };
  }
  const all = pieces(runs, a, b);
  const shown = all.filter((x) => /[^\n]/.test(o.text.slice(x.start, x.end)));
  const use = shown.length ? shown : all;
  const first = resolved(o.style, use[0]!.fields);
  const mixed = new Set<keyof RunStyle>();
  for (let i = 1; i < use.length; i++) {
    const s = resolved(o.style, use[i]!.fields);
    for (const k of RUN_FIELDS) if (!same(first[k], s[k])) mixed.add(k);
  }
  const style: Record<string, unknown> = {};
  for (const k of RUN_FIELDS) if (!mixed.has(k) && first[k] !== undefined) style[k] = first[k];
  return { style: style as RunStyle, mixed: RUN_FIELDS.filter((k) => mixed.has(k)) };
}

/**
 * A paragraph style change for `setParas`: a key with a value sets it on every paragraph touched; a key
 * present with `undefined` removes it (the box default). `bullet: null` is PowerPoint's buNone (explicitly
 * no bullet); `bullet: { char: '•' }` a character bullet, `{ auto: 'arabicPeriod', startAt: 17 }` numbering.
 */
export type ParaPatch = { [K in keyof TextPara]?: TextPara[K] | undefined };

/** Every field a paragraph style can set but `soft` (structure, not style: the text's own a:br lines). */
const PARA_FIELDS = [
  'align',
  'level',
  'indentPx',
  'firstLinePx',
  'spaceBeforePx',
  'spaceAfterPx',
  'lineSpacing',
  'lineSpacingPx',
  'bullet',
  'rtl',
  'hidden',
] as const satisfies readonly (keyof TextPara)[];

/**
 * The paragraphs a selection touches, as indices of `text.split('\n')`: a caret touches its own paragraph, a
 * selection every paragraph it holds a character of (one that ends just after a line break, as a
 * triple-click selects a line, does not touch the next). A soft line (`soft`, PowerPoint's a:br) is part of
 * the paragraph before it, so the range grows to whole PowerPoint paragraphs: their first line and every
 * soft line after the last one.
 */
export function parasTouched(
  o: Pick<TextObject, 'text' | 'paras'>,
  start: number,
  end: number,
): {
  first: number;
  last: number;
} {
  const len = o.text.length;
  const a = Math.max(0, Math.min(len, Math.min(start, end)));
  const b = Math.max(0, Math.min(len, Math.max(start, end)));
  let first = 0;
  for (let i = o.text.indexOf('\n'); i >= 0 && i < a; i = o.text.indexOf('\n', i + 1)) first++;
  let last = first;
  const stop = b > a ? b - 1 : a;
  for (let i = o.text.indexOf('\n', a); i >= 0 && i < stop; i = o.text.indexOf('\n', i + 1)) last++;
  const soft = (i: number) => i > 0 && o.paras?.[i]?.soft === true;
  const count = o.text.split('\n').length;
  while (first > 0 && soft(first)) first--;
  while (last + 1 < count && soft(last + 1)) last++;
  return { first, last };
}

/**
 * The paragraph strip (design/27 §11 item 3): `patch` applied to every paragraph text[start, end] touches
 * (`parasTouched`): align (left, centre, right, justify), bullets, numbering with its type and 'Start at',
 * level and indent, space before and after, line spacing, direction (`rtl`; Auto removes it). A soft line
 * keeps `soft` and takes the change with its paragraph. Entries are created as needed (null before them)
 * and trailing nulls trimmed; an object that had no `paras` gets them.
 *
 * A soft line takes the change by losing its own value of each field the patch names, so it inherits its
 * paragraph's new one (itemize.ts resolves a soft line over its paragraph). `soft` itself is never set or
 * removed here. `lineSpacing` (× single) and `lineSpacingPx` (exact) are alternatives: setting one removes
 * the other unless the patch names it too (the exact pitch would win otherwise). Values are bounded as the
 * schema bounds them; an entry left with nothing is null.
 */
export function setParas(o: TextObject, start: number, end: number, patch: ParaPatch): TextObject {
  const p = cleanParaPatch(patch);
  const keys = Object.keys(p) as (keyof ParaPatch)[];
  if (!keys.length) return o;
  const { first, last: lastTouched } = parasTouched(o, start, end);
  const last = Math.min(lastTouched, MAX_PARAS - 1);
  const old = o.paras ?? [];
  const paras: (TextPara | null)[] = Array.from({ length: Math.max(old.length, last + 1) }, (_, i) =>
    i < old.length ? (old[i] ?? null) : null,
  );
  for (let i = first; i <= last; i++) {
    const cur = paras[i] ?? null;
    if (i > first && cur?.soft === true) {
      const own: Record<string, unknown> = { ...cur };
      for (const k of keys) delete own[k];
      paras[i] = own as TextPara;
    } else {
      const own: Record<string, unknown> = { ...(cur ?? {}) };
      for (const k of keys) {
        if (p[k] === undefined) delete own[k];
        else own[k] = p[k];
      }
      paras[i] = Object.keys(own).length ? (own as TextPara) : null;
    }
  }
  let n = paras.length;
  while (n > 0 && paras[n - 1] == null) n--;
  const out = paras.slice(0, n);
  const width = Math.max(out.length, old.length);
  let changed = false;
  for (let i = 0; i < width && !changed; i++) changed = !same(out[i] ?? null, old[i] ?? null);
  if (!changed) return o;
  return { ...o, paras: out };
}

/** What the paragraph strip shows for the paragraphs a selection touches. */
export type SelectionParas = {
  /** A field is present when every paragraph touched agrees (a null entry counts as the box defaults). */
  para: TextPara;
  mixed: (keyof TextPara)[];
};

/**
 * The paragraph styles of the paragraphs text[start, end] touches, for the strip's values. Each line is
 * resolved as the engine resolves it (a soft line over its paragraph), with the box defaults for what no
 * entry sets: `align` the box's (justify for a justified box), `level`, `indentPx`, `firstLinePx`,
 * `spaceBeforePx` and `spaceAfterPx` 0. The others are left out when unset: `lineSpacing` and
 * `lineSpacingPx` (the box's line height), `bullet` (none: an explicit `null` and no entry alike), `rtl`
 * (Auto) and `hidden`. `soft` is never reported.
 */
export function selectionParas(o: TextObject, start: number, end: number): SelectionParas {
  const { first, last } = parasTouched(o, start, end);
  const box: Record<string, unknown> = {
    align: o.style.justify ? 'justify' : o.style.align,
    level: 0,
    indentPx: 0,
    firstLinePx: 0,
    spaceBeforePx: 0,
    spaceAfterPx: 0,
  };
  const shown = (eff: Record<string, unknown>): Record<string, unknown> => {
    const s: Record<string, unknown> = {};
    for (const k of PARA_FIELDS) {
      const v = eff[k] ?? box[k];
      if (v !== undefined && v !== null && !(k === 'hidden' && v === false)) s[k] = v;
    }
    return s;
  };
  let head: Record<string, unknown> = {};
  let res: Record<string, unknown> | undefined;
  const mixed = new Set<keyof TextPara>();
  for (let i = first; i <= last; i++) {
    const own = o.paras?.[i] ?? null;
    const { soft: _, ...rest } = (own ?? {}) as TextPara;
    const eff: Record<string, unknown> = i > first && own?.soft === true ? { ...head, ...rest } : rest;
    if (!(i > first && own?.soft === true)) head = eff;
    const s = shown(eff);
    if (!res) res = s;
    else for (const k of PARA_FIELDS) if (!same(res[k], s[k])) mixed.add(k);
  }
  const para: Record<string, unknown> = {};
  for (const k of PARA_FIELDS) if (!mixed.has(k) && res?.[k] !== undefined) para[k] = res[k];
  return { para: para as TextPara, mixed: PARA_FIELDS.filter((k) => mixed.has(k)) };
}

/**
 * 'Re-fit text' (design/27 §11 items 1 and 4): `style.fitScale` removed, so a shrink-to-fit box is fitted
 * again from full size by the engine. The only op that clears it (a theme replacing the box style drops it
 * too: `themedRuns`).
 */
export function refitText(o: TextObject): TextObject {
  if (o.style.fitScale === undefined) return o;
  const { fitScale: _, ...style } = o.style;
  return { ...o, style: style as TextStyle };
}

/**
 * The runs and paragraph styles of a lyric object after `applyTheme` replaced its box style (design/27 §11
 * "Themes"): each run's visual overrides (`VISUAL_RUN_FIELDS`) are dropped unless the slide's `overrides`
 * keep them; structural formatting and `paras` stay, so verse superscripts, emphasis and numbering survive
 * a theme change. `../ops.ts` `applyTheme` calls it for every lyric object.
 *
 * The override paths (top of this file): `runs.<field>` keeps that field in every run, `runs` keeps them
 * all. Runs left with nothing are dropped and equal neighbours merged; `runs` stays (possibly empty), so
 * the object stays with the rich engine.
 *
 * The stored autofit scale (`style.fitScale`, PowerPoint's for the box it imported) is dropped as well
 * unless `style.fitScale` is overridden: the theme gave the text another box, size or face, and the old
 * scale would draw the theme's text smaller than the theme asks while it fits. The engine fits the box
 * again from full size.
 */
export function themedRuns(o: TextObject, overrides: readonly string[]): TextObject {
  const drop = overrides.includes('runs')
    ? []
    : VISUAL_RUN_FIELDS.filter((k) => !overrides.includes(`runs.${k}`));
  let runs = o.runs;
  if (runs && drop.length) {
    let changed = false;
    const stripped = runs.map((r) => {
      if (!drop.some((k) => r[k] !== undefined)) return r;
      changed = true;
      const c: Record<string, unknown> = { ...r };
      for (const k of drop) delete c[k];
      return c as TextRun;
    });
    if (changed) runs = normalize(validRuns(stripped, o.text.length));
  }
  let style = o.style;
  if (style.fitScale !== undefined && !overrides.includes('style.fitScale')) {
    const { fitScale: _, ...rest } = style;
    style = rest as TextStyle;
  }
  if (runs === o.runs && style === o.style) return o;
  return { ...o, runs, style };
}

/**
 * The theme override paths a format change marks on a themed lyric object (`runs.<field>` for each visual
 * field `patch` sets to a value; removing one needs no path: the theme drops it anyway). `resizeRange` sets
 * `sizeScale`: `runOverrides({ sizeScale: factor })`.
 */
export function runOverrides(patch: RunPatch): string[] {
  return VISUAL_RUN_FIELDS.filter((k) => k in patch && patch[k] !== undefined).map((k) => `runs.${k}`);
}

/**
 * `fn` applied to text object `objectId` of slide `s` (a locked object is left alone: design/27 §11 "Locked
 * objects"); when it changed and it is the slide's lyric object (its `lyricObjectId`, else its first text
 * object, as `applyTheme` picks it), the theme override paths `overrides` are added to the slide (pass none
 * when the presentation has no theme). `s` itself when nothing changes.
 */
export function textOnSlide(
  s: Slide,
  objectId: string,
  fn: (o: TextObject) => TextObject,
  overrides: readonly string[] = [],
): Slide {
  const i = s.objects.findIndex((x) => x.id === objectId);
  const o = s.objects[i];
  if (o?.type !== 'text' || o.locked) return s;
  const next = fn(o);
  if (next === o) return s;
  const objects = [...s.objects];
  objects[i] = next;
  const out: Slide = { ...s, objects };
  if (!overrides.length || lyricId(s) !== objectId) return out;
  const cur = s.overrides ?? [];
  const add = overrides.filter((x, k) => !cur.includes(x) && overrides.indexOf(x) === k);
  if (!add.length || cur.length + add.length > MAX_OVERRIDES) return out;
  return { ...out, overrides: [...cur, ...add] };
}

// ---- helpers --------------------------------------------------------------------------------------------

/** The slide's lyric object id, as `../ops.ts` `lyricObject` picks it. */
function lyricId(s: Slide): string | undefined {
  const o = s.lyricObjectId ? s.objects.find((x) => x.id === s.lyricObjectId) : undefined;
  if (o?.type === 'text') return o.id;
  return s.objects.find((x) => x.type === 'text')?.id;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** Whether offset `i` of `s` is inside a surrogate pair. */
const inPair = (s: string, i: number) =>
  i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i));

/** [start, end) clamped to the text, ordered, and widened so it never cuts a surrogate pair. */
function span(text: string, start: number, end: number): [number, number] {
  const c = (v: number) => (fin(v) ? clampN(Math.round(v), 0, text.length) : 0);
  let a = Math.min(c(start), c(end));
  let b = Math.max(c(start), c(end));
  if (inPair(text, a)) a--;
  if (inPair(text, b)) b++;
  return [a, b];
}

/** Deep equality of run and paragraph values (numbers, strings, booleans, null, plain objects). */
function same(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false;
  const a = x as Record<string, unknown>;
  const b = y as Record<string, unknown>;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
}

/** A run's formatting: its RUN_FIELDS that are set. */
function fieldsOf(r: TextRun): RunStyle {
  const f: Record<string, unknown> = {};
  for (const k of RUN_FIELDS) if (r[k] !== undefined) f[k] = r[k];
  return f as RunStyle;
}

function without(f: RunStyle, k: keyof RunStyle): RunStyle {
  const c = { ...f };
  delete c[k];
  return c;
}

/** Runs well formed for a text of `len` units (as the domain edit and the renderer's clamp keep them). */
function validRuns(runs: readonly TextRun[], len: number): TextRun[] {
  const out: TextRun[] = [];
  let at = 0;
  for (const r of runs) {
    if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end)) continue;
    if (r.start < at || r.start >= len || r.end <= r.start) continue;
    out.push(r.end > len ? { ...r, end: len } : r);
    at = Math.min(r.end, len);
  }
  return out;
}

/** Runs without the ones that set nothing, equal neighbours merged. */
function normalize(runs: readonly TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r of runs) {
    if (r.end <= r.start || !RUN_FIELDS.some((k) => r[k] !== undefined)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.end === r.start && RUN_FIELDS.every((k) => same(prev[k], r[k])))
      out[out.length - 1] = { ...prev, end: r.end };
    else out.push(r);
  }
  return out;
}

/** The formatting of every piece of [a, b): the runs over it, cut to it, and the gaps between them ({}). */
function pieces(runs: readonly TextRun[], a: number, b: number) {
  const out: { start: number; end: number; fields: RunStyle }[] = [];
  let at = a;
  for (const r of runs) {
    if (r.end <= a) continue;
    if (r.start >= b) break;
    const s = Math.max(r.start, a);
    const e = Math.min(r.end, b);
    if (s > at) out.push({ start: at, end: s, fields: {} });
    out.push({ start: s, end: e, fields: fieldsOf(r) });
    at = e;
  }
  if (at < b) out.push({ start: at, end: b, fields: {} });
  return out;
}

/**
 * `o` with `fn` applied to the formatting of every character of [a, b) (`fn` returns its argument itself
 * when that piece does not change). Runs are split at a and b and normalised; `o` itself when no piece
 * changes or the result would pass the runs bound.
 */
function withRuns(o: TextObject, a: number, b: number, fn: (f: RunStyle) => RunStyle): TextObject {
  const runs = validRuns(o.runs ?? [], o.text.length);
  const out: TextRun[] = [];
  let changed = false;
  let at = a;
  const inside = (s: number, e: number, f: RunStyle) => {
    const g = fn(f);
    if (g !== f) changed = true;
    out.push({ ...g, start: s, end: e });
  };
  for (const r of runs) {
    if (r.end <= a) {
      out.push(r);
      continue;
    }
    if (r.start >= b) {
      if (at < b) inside(at, b, {});
      at = b;
      out.push(r);
      continue;
    }
    if (r.start < a) out.push({ ...r, end: a });
    const s = Math.max(r.start, a);
    const e = Math.min(r.end, b);
    if (s > at) inside(at, s, {});
    inside(s, e, fieldsOf(r));
    at = e;
    if (r.end > b) out.push({ ...r, start: b });
  }
  if (at < b) inside(at, b, {});
  if (!changed) return o;
  const next = normalize(out);
  if (next.length > MAX_RUNS) return o;
  return { ...o, runs: next };
}

/** `f` with `p` applied; `f` itself when every field of `p` already holds. */
function patched(f: RunStyle, p: RunPatch): RunStyle {
  let out: Record<string, unknown> | undefined;
  for (const k of Object.keys(p) as (keyof RunStyle)[]) {
    const v = p[k];
    if (v === undefined ? f[k] === undefined : same(f[k], v)) continue;
    out ??= { ...f };
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return (out as RunStyle | undefined) ?? f;
}

/**
 * The offset whose style text typed at caret `p` takes (`@ordo/domain` textEdit.ts `ownerOffset`): at a
 * paragraph's start its first character, or for an empty paragraph its end mark; else the character
 * before. -1: none (an empty text).
 */
function ownerOffset(t: string, p: number): number {
  if (p === 0 || t.charCodeAt(p - 1) === 0x0a) return p < t.length ? p : p - 1;
  return p - 1;
}

/** Every field of `f` resolved over the box style (renderer itemize.ts `resolveRunStyle`). */
function resolved(style: TextStyle, f: RunStyle): RunStyle {
  const s: RunStyle = {
    fontFamily: f.fontFamily ?? style.fontFamily,
    fontWeight: f.fontWeight ?? style.fontWeight,
    fontStyle: f.fontStyle ?? style.fontStyle,
    sizeScale: f.sizeScale ?? 1,
    color: f.color ?? style.color,
    highlight: f.highlight,
    underline: f.underline ?? style.underline ?? false,
    strike: f.strike ?? false,
    baseline: f.baseline ?? 0,
    letterSpacing: f.letterSpacing ?? style.letterSpacing,
    caps: f.caps ?? (style.transform === 'uppercase' ? 'all' : 'none'),
    outline: f.outline === null ? null : (f.outline ?? style.outline ?? null),
    shadow: f.shadow === null ? null : (f.shadow ?? style.shadow ?? null),
    lang: f.lang ?? style.lang,
  };
  return s;
}

// ---- bounded values ------------------------------------------------------------------------------------

/** Marks a patch value that is not a valid one: the key is left out of the patch. */
const BAD = Symbol('bad');
const COORD = 100_000;

function rgba(v: unknown): Rgba | typeof BAD {
  if (!v || typeof v !== 'object') return BAD;
  const c = v as Record<string, unknown>;
  if (!fin(c.r) || !fin(c.g) || !fin(c.b) || !fin(c.a)) return BAD;
  return { r: clampN(c.r, 0, 255), g: clampN(c.g, 0, 255), b: clampN(c.b, 0, 255), a: clampN(c.a, 0, 1) };
}

function outline(v: unknown): { width: number; color: Rgba } | null | typeof BAD {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return BAD;
  const c = v as Record<string, unknown>;
  const color = rgba(c.color);
  if (!fin(c.width) || color === BAD) return BAD;
  return { width: clampN(c.width, 0, COORD), color };
}

function shadow(v: unknown): NonNullable<TextRun['shadow']> | null | typeof BAD {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return BAD;
  const c = v as Record<string, unknown>;
  const color = rgba(c.color);
  if (!fin(c.dx) || !fin(c.dy) || !fin(c.blur) || color === BAD) return BAD;
  return {
    dx: clampN(c.dx, -COORD, COORD),
    dy: clampN(c.dy, -COORD, COORD),
    blur: clampN(c.blur, 0, COORD),
    color,
  };
}

const str = (v: unknown, max: number) =>
  typeof v !== 'string' ? BAD : v.trim() ? (v.length > max ? BAD : v) : undefined;

function runValue(k: keyof RunStyle, v: unknown): unknown {
  switch (k) {
    case 'fontFamily':
      return str(v, 300);
    case 'lang':
      return str(v, 35);
    case 'fontWeight':
      return fin(v) ? clampN(v, 0, 1000) : BAD;
    case 'fontStyle':
      return v === 'normal' || v === 'italic' ? v : BAD;
    case 'sizeScale':
      return !fin(v) || v <= 0 ? BAD : Math.abs(v - 1) < 1e-9 ? undefined : clampN(v, 0.01, 50);
    case 'baseline':
      return !fin(v) ? BAD : v === 0 ? undefined : clampN(v, -1, 1);
    case 'letterSpacing':
      return fin(v) ? clampN(v, -1000, 1000) : BAD;
    case 'color':
    case 'highlight':
      return rgba(v);
    case 'underline':
    case 'strike':
      return typeof v === 'boolean' ? v : BAD;
    case 'caps':
      return v === 'none' || v === 'all' || v === 'small' ? v : BAD;
    case 'outline':
      return outline(v);
    case 'shadow':
      return shadow(v);
  }
}

/** `patch` with only run fields, each bounded as the schema bounds it (invalid values left out). */
function cleanRunPatch(patch: RunPatch): RunPatch {
  const out: Record<string, unknown> = {};
  for (const k of RUN_FIELDS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    const c = v === undefined ? undefined : runValue(k, v);
    if (c !== BAD) out[k] = c;
  }
  return out as RunPatch;
}

const ALIGNS = ['left', 'center', 'right', 'justify', 'distribute'];

function bullet(v: unknown): TextPara['bullet'] | typeof BAD {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return BAD;
  const c = v as Record<string, unknown>;
  const out: NonNullable<TextPara['bullet']> = {};
  if (c.char !== undefined) {
    if (typeof c.char !== 'string' || !c.char || c.char.length > 8) return BAD;
    out.char = c.char;
  }
  if (c.auto !== undefined) {
    if (typeof c.auto !== 'string' || !c.auto || c.auto.length > 40) return BAD;
    out.auto = c.auto;
  }
  if (c.startAt !== undefined) {
    if (!fin(c.startAt)) return BAD;
    out.startAt = clampN(Math.round(c.startAt), 1, 32_767);
  }
  if (c.fontFamily !== undefined) {
    const f = str(c.fontFamily, 300);
    if (f === BAD) return BAD;
    if (f !== undefined) out.fontFamily = f;
  }
  if (c.color !== undefined) {
    const color = rgba(c.color);
    if (color === BAD) return BAD;
    out.color = color;
  }
  if (c.sizePct !== undefined) {
    if (!fin(c.sizePct)) return BAD;
    out.sizePct = clampN(c.sizePct, 0.1, 4);
  }
  return out;
}

function paraValue(k: (typeof PARA_FIELDS)[number], v: unknown): unknown {
  switch (k) {
    case 'align':
      return typeof v === 'string' && ALIGNS.includes(v) ? v : BAD;
    case 'level':
      return fin(v) ? clampN(Math.round(v), 0, 8) : BAD;
    case 'indentPx':
    case 'firstLinePx':
      return fin(v) ? clampN(v, -COORD, COORD) : BAD;
    case 'spaceBeforePx':
    case 'spaceAfterPx':
    case 'lineSpacingPx':
      return fin(v) ? clampN(v, 0, COORD) : BAD;
    case 'lineSpacing':
      return fin(v) ? clampN(v, 0, 13.2) : BAD;
    case 'bullet':
      return bullet(v);
    case 'rtl':
    case 'hidden':
      return typeof v === 'boolean' ? v : BAD;
  }
}

/**
 * `patch` with only paragraph style fields (never `soft`), each bounded as the schema bounds it; setting
 * `lineSpacing` or `lineSpacingPx` removes the other unless the patch names it.
 */
function cleanParaPatch(patch: ParaPatch): ParaPatch {
  const out: Record<string, unknown> = {};
  for (const k of PARA_FIELDS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    const c = v === undefined ? undefined : paraValue(k, v);
    if (c !== BAD) out[k] = c;
  }
  if (out.lineSpacing !== undefined && !('lineSpacingPx' in out)) out.lineSpacingPx = undefined;
  if (out.lineSpacingPx !== undefined && !('lineSpacing' in out)) out.lineSpacing = undefined;
  return out as ParaPatch;
}
