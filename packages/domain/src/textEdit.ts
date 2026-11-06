import type { TextObject, TextPara, TextRun } from './schemas.ts';

/*
 * Editing the plain text of a text object without losing its formatting (design/27 §11 item 1). `runs`
 * annotate `text` by UTF-16 offsets and `paras[i]` styles the i-th '\n' piece, so every change to the text
 * shifts, trims or splits them in the same step:
 * - inserted text takes the style of the character before it (or after it, at offset 0);
 * - runs inside a deleted range are trimmed, and dropped when nothing of them is left;
 * - paragraph styles are inserted or removed with the '\n' count: a new line copies the style of the
 *   paragraph it splits, and paragraphs merged by a deletion keep the first one's style, unless that one
 *   was deleted whole (deleting a line keeps the next line's style);
 * - the box style is untouched, so `fitScale` is kept: the engine keeps it while the text still fits
 *   (§6 step 10) and only 'Re-fit text' clears it.
 * An object without `runs` and `paras` gets its new text and nothing else, so a legacy object never turns
 * rich by being edited.
 */

/** The fields an edit reads and rewrites. */
export type RichText = Pick<TextObject, 'text' | 'runs' | 'paras'>;

/** Paragraph styles an edit keeps at most (the schema's bound). */
const MAX_PARAS = 5000;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** Whether offset `i` of `s` is not inside a surrogate pair. */
const boundary = (s: string, i: number) =>
  i <= 0 || i >= s.length || !(isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i)));
/** Whether offset `i` of `s` starts a paragraph. */
const paraStart = (s: string, i: number) => i === 0 || s.charCodeAt(i - 1) === 0x0a;

function newlines(s: string, start = 0, end = s.length): number {
  let n = 0;
  for (let i = s.indexOf('\n', start); i >= 0 && i < end; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * `o` with its text set to `next`, its runs and paragraph styles following the change. The change is
 * found as the common prefix and suffix of the two texts; `caret` (the caret after the change, as a
 * textarea's `selectionEnd` gives it) places a change that could sit in several places, such as a typed
 * letter that repeats its neighbour or an Enter between two lines. Without it, such a change goes to a
 * paragraph start when it holds a line break and can sit there, else to the rightmost place.
 */
export function editText<T extends RichText>(o: T, next: string, caret?: number): T {
  const old = o.text;
  if (next === old) return o;
  if (o.runs === undefined && o.paras === undefined) return { ...o, text: next };
  const max = Math.min(old.length, next.length);
  let p = 0;
  while (p < max && old.charCodeAt(p) === next.charCodeAt(p)) p++;
  if (!boundary(old, p) || !boundary(next, p)) p--;
  let s = 0;
  while (s < max - p && old.charCodeAt(old.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  while (s > 0 && (!boundary(old, old.length - s) || !boundary(next, next.length - s))) s--;
  // old[p, p + del) becomes next[p, p + ins).
  const del = old.length - s - p;
  const ins = next.length - s - p;
  if (!del) p = place(old, next, p, ins, true, caret);
  else if (!ins) p = place(old, next, p, del, false, caret);
  return replaceText(o, p, p + del, next.slice(p, p + ins));
}

/**
 * Where a pure insertion (`insert`) or deletion of `n` units goes when it could slide. `p` is the rightmost
 * place; the changed units are at [p, p + n) of the new text for an insertion, of the old one for a deletion.
 */
function place(old: string, next: string, p: number, n: number, insert: boolean, caret: number | undefined) {
  const str = insert ? next : old;
  let lo = p;
  while (lo > 0 && str.charCodeAt(lo - 1) === str.charCodeAt(lo - 1 + n)) lo--;
  if (lo === p) return p;
  const ok = (at: number) => boundary(old, at) && boundary(next, at) && boundary(str, at + n);
  if (caret !== undefined && Number.isFinite(caret)) {
    const at = insert ? Math.round(caret) - n : Math.round(caret);
    if (at >= lo && at <= p && ok(at)) return at;
  }
  // A change with a line break goes to a paragraph start when it can (a deleted line, not its neighbour's
  // end and its own start); any other change stays rightmost, where typing usually happens.
  if (str.slice(p, p + n).includes('\n'))
    for (let at = p; at >= lo; at--) if (ok(at) && paraStart(old, at)) return at;
  return p;
}

/**
 * `o` with text[start, end) replaced by `insert`, its runs and paragraph styles following the change (the
 * rules at the top of this file). Offsets are clamped to the text.
 */
export function replaceText<T extends RichText>(o: T, start: number, end: number, insert: string): T {
  const old = o.text;
  const p = clampInt(start, 0, old.length);
  const q = clampInt(end, p, old.length);
  if (p === q && !insert) return o;
  const text = old.slice(0, p) + insert + old.slice(q);
  const out: T = { ...o, text };
  if (o.runs !== undefined) out.runs = shiftRuns(o.runs, old, p, q, insert.length);
  if (o.paras !== undefined) out.paras = shiftParas(o.paras, old, p, q, insert);
  return out;
}

/** `a` followed by a line break and `b`: `b`'s runs and paragraph styles move after `a`'s. */
export function joinText<T extends RichText>(a: T, b: RichText): T {
  const text = `${a.text}\n${b.text}`;
  const out: T = { ...a, text };
  if (a.runs === undefined && a.paras === undefined && b.runs === undefined && b.paras === undefined)
    return out;
  const at = a.text.length + 1;
  const runs = [
    ...validRuns(a.runs ?? [], a.text.length),
    ...validRuns(b.runs ?? [], b.text.length).map((r) => ({ ...r, start: r.start + at, end: r.end + at })),
  ];
  if (a.runs !== undefined || b.runs !== undefined) out.runs = runs.slice(0, 2000);
  if (a.paras !== undefined || b.paras !== undefined) {
    const count = newlines(a.text) + 1;
    const head = Array.from({ length: count }, (_, i) => a.paras?.[i] ?? null);
    out.paras = trimParas([...head, ...(b.paras ?? [])]);
  }
  return out;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;
}

/** Runs that are well formed for a text of `len` units (as the renderer's clamp keeps them): sorted, non-overlapping, inside. */
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

/** Runs after text[p, q) of `old` is replaced by `ins` units. */
function shiftRuns(runs: readonly TextRun[], old: string, p: number, q: number, ins: number): TextRun[] {
  const valid = validRuns(runs, old.length);
  const delta = ins - (q - p);
  // The run whose style inserted text takes: the one over the character before it, else (at offset 0) the
  // one over the first character after the deleted range.
  let owner = -1;
  if (ins > 0) {
    const at = p > 0 ? p - 1 : q < old.length ? q : -1;
    if (at >= 0) owner = valid.findIndex((r) => r.start <= at && at < r.end);
  }
  const out: TextRun[] = [];
  valid.forEach((r, i) => {
    let start: number;
    let end: number;
    if (i === owner) {
      start = Math.min(r.start, p);
      end = r.end >= q ? r.end + delta : p + ins;
    } else {
      // The part outside the deleted range, which closes up after the inserted text.
      start = r.start < p ? r.start : r.start >= q ? r.start + delta : p + ins;
      end = r.end <= p ? r.end : r.end >= q ? r.end + delta : p;
    }
    if (end > start) out.push(start === r.start && end === r.end ? r : { ...r, start, end });
  });
  return out;
}

/** Paragraph styles after text[p, q) of `old` is replaced by `insert`. */
function shiftParas(
  paras: readonly (TextPara | null)[],
  old: string,
  p: number,
  q: number,
  insert: string,
): (TextPara | null)[] {
  const removed = newlines(old, p, q);
  const added = newlines(insert);
  if (!removed && !added) return paras as (TextPara | null)[];
  const k = newlines(old, 0, p); // the paragraph the change starts in
  const at = (i: number) => paras[i] ?? null;
  const copy = (s: TextPara | null) => (s ? { ...s } : null);
  const first = at(k);
  const last = at(k + removed);
  let pieces: (TextPara | null)[];
  if (!added) {
    // Paragraphs k..k+removed become one. It keeps paragraph k's style unless paragraph k was deleted whole
    // (the deletion starts at its start and nothing is typed in its place).
    pieces = [paraStart(old, p) && !insert ? last : first];
  } else {
    // The first piece keeps paragraph k's start, new lines copy the paragraph they split, the last piece
    // ends with paragraph k+removed's end.
    pieces = [first];
    for (let i = 1; i < added; i++) pieces.push(copy(first));
    pieces.push(removed ? last : copy(first));
  }
  if (paras.length <= k && pieces.every((x) => x === null)) return paras as (TextPara | null)[];
  const head = Array.from({ length: Math.min(k, MAX_PARAS) }, (_, i) => at(i));
  return trimParas([...head, ...pieces, ...paras.slice(k + removed + 1)]);
}

/** Paragraph styles without trailing nulls (they mean the box defaults, as missing entries do), bounded. */
function trimParas(paras: (TextPara | null)[]): (TextPara | null)[] {
  let n = Math.min(paras.length, MAX_PARAS);
  while (n > 0 && paras[n - 1] == null) n--;
  return n === paras.length ? paras : paras.slice(0, n);
}
