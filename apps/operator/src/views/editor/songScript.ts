import { newId, type Presentation, type Slide, type TextObject, type Theme } from '@ordo/domain';
import { getSlide, lyricObject, splitSlidePieces, type TextPiece, updateSlide } from './ops.ts';
import { editText } from './ops/text.ts';

/*
 * The Lyric Script (SongReflowEditor.tsx; design/15 "Lyric Script"): each slide's words in a field. The field
 * shows the slide's lyric object's own stored text and writes through `editText`, never `firstText` with
 * `{ ...o, text }`: `firstText` writes automatic numbers and bullets into the text for bands and labels
 * (`readableText`), so storing it back added the labels again at every keystroke ('1. 1. Amazing grace') and
 * left bold and italic on other letters. The splits (Split at Cursor, Alt+Enter, Auto-Split, '---' and Enter)
 * cut that same raw text, at the real caret, through the domain's slide split (`splitSlidePieces`), so runs
 * and paragraph styles stay on their letters on both sides.
 */

/** The text object a slide's words live in: its lyric object, else its first text object. */
export function scriptTarget(sl: Slide): TextObject | undefined {
  return lyricObject(sl);
}

/** What a slide's Lyric Script field shows: the lyric object's own text, as stored. */
export function scriptText(sl: Slide): string {
  return scriptTarget(sl)?.text ?? '';
}

/**
 * The slide with its words set to `text` as the field typed them (`caret`: the field's `selectionEnd`). The
 * lyric object's runs and paragraph styles follow the edit (`editText`); a slide without a text object gets
 * a lyric object in the theme's lyric box. The slide itself when nothing changes.
 */
export function withScriptText(sl: Slide, text: string, theme: Theme, caret?: number): Slide {
  const target = scriptTarget(sl);
  if (target) {
    const next = editText(target, text, caret);
    if (next === target) return sl;
    return { ...sl, objects: sl.objects.map((o) => (o.id === target.id ? next : o)) };
  }
  if (!text) return sl;
  const id = newId();
  return {
    ...sl,
    lyricObjectId: id,
    objects: [
      ...sl.objects,
      { id, type: 'text', box: { ...theme.lyricBox }, style: { ...theme.text }, text, opacity: 1 },
    ],
  };
}

/** `p` with slide `slideId`'s words typed (`withScriptText`); `p` itself when nothing changes (no undo step). */
export function typeScript(p: Presentation, slideId: string, text: string, theme: Theme, caret?: number) {
  const s = getSlide(p, slideId);
  if (!s) return p;
  const next = withScriptText(s, text, theme, caret);
  return next === s ? p : updateSlide(p, slideId, () => next);
}

const isNl = (t: string, i: number) => t.charCodeAt(i) === 0x0a || t.charCodeAt(i) === 0x0d;

/** `[start, end)` without the line breaks at its ends. */
function trimmed(t: string, start: number, end: number): TextPiece {
  let a = start;
  let b = end;
  while (a < b && isNl(t, a)) a++;
  while (b > a && isNl(t, b - 1)) b--;
  return [a, b];
}

/**
 * Where Split at Cursor and Alt+Enter cut `text` with the caret at `caret`: the words before it and after it,
 * without the line breaks at the cut. A caret at the end (only line breaks after it) gives an empty next
 * slide, as '---' and Enter does; a caret at the start (only line breaks before it) gives nothing, and so does
 * no caret: never a cut in the middle of a word the volunteer did not choose.
 */
export function caretPieces(text: string, caret: number | undefined): TextPiece[] | null {
  if (caret === undefined || !Number.isInteger(caret)) return null;
  const at = Math.max(0, Math.min(text.length, caret));
  const before = trimmed(text, 0, at);
  if (before[1] <= before[0]) return null;
  const after = trimmed(text, at, text.length);
  return [before, after[1] > after[0] ? after : [text.length, text.length]];
}

/** The non-empty lines of `text`, as `[start, end)` (what the stream tag counts). */
export function scriptLines(text: string): TextPiece[] {
  const out: TextPiece[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text.charCodeAt(i) !== 0x0a) continue;
    if (text.slice(start, i).trim()) out.push([start, i]);
    start = i + 1;
  }
  return out;
}

/** Auto-Split (2 lines): the non-empty lines of `text` two by two; null with two lines or fewer. */
export function twoLinePieces(text: string): TextPiece[] | null {
  const lines = scriptLines(text);
  if (lines.length <= 2) return null;
  const out: TextPiece[] = [];
  for (let i = 0; i < lines.length; i += 2) out.push([lines[i]![0], (lines[i + 1] ?? lines[i]!)[1]]);
  return out;
}

/** A '---' line ended by Enter: where the '---' and Enter split starts a new slide. */
const MARKER = /(?:^|\n)---\r?\n/g;

/**
 * The pieces of `text` between '---' lines that ended with Enter (the typed split), without the line breaks
 * at their ends; null when it holds none. An empty piece is an empty slide ('---' and Enter at the end).
 */
export function markerPieces(text: string): TextPiece[] | null {
  const out: TextPiece[] = [];
  let from = 0;
  for (const m of text.matchAll(MARKER)) {
    out.push(trimmed(text, from, m.index));
    from = m.index + m[0].length;
  }
  if (!out.length) return null;
  const last = trimmed(text, from, text.length);
  out.push(last[1] > last[0] ? last : [text.length, text.length]);
  return out;
}

/**
 * Split slide `slideId` at `pieces` of its lyric text (`splitSlidePieces`). With `typed`, the field's new
 * value is stored first (`typeScript`, placed by `caret`) and the pieces are the '---' splits of what it
 * then holds. The presentation and the new slides' ids (none when nothing was split).
 */
export function splitScript(
  p: Presentation,
  slideId: string,
  pieces: (text: string) => TextPiece[] | null,
  theme: Theme,
  typed?: { text: string; caret?: number },
): { p: Presentation; ids: string[] } {
  const q = typed ? typeScript(p, slideId, typed.text, theme, typed.caret) : p;
  const s = getSlide(q, slideId);
  const cuts = s ? pieces(scriptText(s)) : null;
  if (!cuts || cuts.length < 2) return { p, ids: [] };
  const out = splitSlidePieces(q, slideId, cuts);
  return out.ids.length ? out : { p, ids: [] };
}
