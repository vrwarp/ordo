import { editText as editRichText, type TextObject, type TextPara, type TextRun } from '@ordo/domain';

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

/**
 * The textarea's edit (design/27 §11 item 1): `o` with its text set to `next`, its runs and paragraph styles
 * following the change (`@ordo/domain` `editText`, placed by `caret`, the textarea's `selectionEnd`): retyped
 * text takes the style of the text it replaces, a typo fix inside a bold coloured word stays bold and
 * coloured, Enter copies the paragraph's style.
 *
 * Keeps `style.fitScale` while the edited text still fits at that scale, so a one-character fix never
 * changes the text size; text that no longer fits shrinks further (§6 step 10: the result can only be
 * smaller). A box drawn with a face other than the one PowerPoint fitted is fitted from full size after every
 * edit until the family is uploaded (§10). Only 'Re-fit text' (`refitText`) clears `fitScale`.
 *
 * Scaffold: the domain edit, which leaves the box style and so `fitScale` untouched. Item A adds the fit
 * rule and its tests.
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
 * Scaffold: returns `o`. Item A.
 */
export function formatRange(o: TextObject, _start: number, _end: number, _patch: RunPatch): TextObject {
  return o;
}

/**
 * The format bar's Size ± for text[start, end): every character's size (`sizeScale`, relative to the box's
 * `fontSizePx`, so the box Size control still scales every run) multiplied by `factor`, within the clamp's
 * bounds (an effective size of 2-1,000 px, design/27 §3.2); a size equal to the box's drops `sizeScale`.
 *
 * Scaffold: returns `o`. Item A.
 */
export function resizeRange(o: TextObject, _start: number, _end: number, _factor: number): TextObject {
  return o;
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
 * The formatting of text[start, end), for the format bar's pressed states and values.
 *
 * Scaffold: nothing known. Item A.
 */
export function selectionStyle(_o: TextObject, _start: number, _end: number): SelectionStyle {
  return { style: {}, mixed: [] };
}

/**
 * A paragraph style change for `setParas`: a key with a value sets it on every paragraph touched; a key
 * present with `undefined` removes it (the box default). `bullet: null` is PowerPoint's buNone (explicitly
 * no bullet); `bullet: { char: '•' }` a character bullet, `{ auto: 'arabicPeriod', startAt: 17 }` numbering.
 */
export type ParaPatch = { [K in keyof TextPara]?: TextPara[K] | undefined };

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
 * Scaffold: returns `o`. Item A.
 */
export function setParas(o: TextObject, _start: number, _end: number, _patch: ParaPatch): TextObject {
  return o;
}

/** What the paragraph strip shows for the paragraphs a selection touches. */
export type SelectionParas = {
  /** A field is present when every paragraph touched agrees (a null entry counts as the box defaults). */
  para: TextPara;
  mixed: (keyof TextPara)[];
};

/**
 * The paragraph styles of the paragraphs text[start, end] touches, for the strip's values.
 *
 * Scaffold: nothing known. Item A.
 */
export function selectionParas(_o: TextObject, _start: number, _end: number): SelectionParas {
  return { para: {}, mixed: [] };
}

/**
 * 'Re-fit text' (design/27 §11 items 1 and 4): `style.fitScale` removed, so a shrink-to-fit box is fitted
 * again from full size by the engine. The only op that clears it.
 *
 * Scaffold: returns `o`. Item A (the button is item C's).
 */
export function refitText(o: TextObject): TextObject {
  return o;
}

/**
 * The runs and paragraph styles of a lyric object after `applyTheme` replaced its box style (design/27 §11
 * "Themes"): each run's visual overrides (`VISUAL_RUN_FIELDS`) are dropped unless the slide's `overrides`
 * keep them; structural formatting and `paras` stay, so verse superscripts, emphasis and numbering survive
 * a theme change. `../ops.ts` `applyTheme` calls it for every lyric object.
 *
 * Scaffold: returns `o` (today's behaviour: runs untouched). Item A.
 */
export function themedRuns(o: TextObject, _overrides: readonly string[]): TextObject {
  return o;
}
