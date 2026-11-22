import type { KeyboardEvent } from 'react';
import { historyKey } from './editorKeys.ts';
import { redo, undo } from './editorStore.ts';

export type NoteFormatAction = 'highlight' | 'bullet' | 'cue';

export type NoteEditResult = {
  next: string;
  selStart: number;
  selEnd: number;
};

const BULLET_PREFIX_RE = /^([-*•]\s+)/u;

function toggleInlineWrap(
  current: string,
  start: number,
  end: number,
  open: string,
  close: string,
): NoteEditResult {
  const picked = current.slice(start, end);
  const openLen = open.length;
  const closeLen = close.length;

  // Case 1: Selection itself includes the surrounding delimiters (e.g. `**foo**` or `[foo]`).
  if (picked.length >= openLen + closeLen && picked.startsWith(open) && picked.endsWith(close)) {
    const inner = picked.slice(openLen, picked.length - closeLen);
    return {
      next: `${current.slice(0, start)}${inner}${current.slice(end)}`,
      selStart: start,
      selEnd: start + inner.length,
    };
  }

  // Case 2: Selection (or collapsed caret) sits directly inside surrounding delimiters
  // (e.g. clicking Highlight/Cue twice, or toggling off empty `**|**` / `[|]`).
  if (
    start >= openLen &&
    current.slice(start - openLen, start) === open &&
    current.slice(end, end + closeLen) === close
  ) {
    return {
      next: `${current.slice(0, start - openLen)}${picked}${current.slice(end + closeLen)}`,
      selStart: start - openLen,
      selEnd: end - openLen,
    };
  }

  // Case 3: Wrap selection, or insert empty delimiters with caret inside when collapsed.
  return {
    next: `${current.slice(0, start)}${open}${picked}${close}${current.slice(end)}`,
    selStart: start + openLen,
    selEnd: start + openLen + picked.length,
  };
}

/**
 * Pure transformation for speaker-note toolbar toggle actions (`★ Highlight`, `• Bullet`, `[Cue]`):
 * - `highlight`: toggles `**...**` on selection, or inserts `**|**` with caret inside when collapsed.
 * - `cue`: toggles `[...]` on selection, or inserts `[|]` with caret inside when collapsed.
 * - `bullet`: toggles `• ` on current/selected lines while preserving caret/selection offsets.
 */
export function computeNoteFormatting(
  current: string,
  start: number,
  end: number,
  action: NoteFormatAction,
): NoteEditResult {
  if (action === 'highlight') {
    return toggleInlineWrap(current, start, end, '**', '**');
  }
  if (action === 'cue') {
    return toggleInlineWrap(current, start, end, '[', ']');
  }

  // `bullet`: toggle `• ` on every line touched by [start, end]
  const lineStart = current.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineEndIdx = current.indexOf('\n', end);
  const lineEnd = lineEndIdx < 0 ? current.length : lineEndIdx;
  const block = current.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const allBulleted = lines.every((l) => BULLET_PREFIX_RE.test(l));

  let firstDelta = 0;
  let totalDelta = 0;
  const updatedLines = lines.map((l, idx) => {
    if (allBulleted) {
      const m = BULLET_PREFIX_RE.exec(l);
      const removed = m ? m[1]!.length : 0;
      if (idx === 0) firstDelta = -removed;
      totalDelta -= removed;
      return l.slice(removed);
    }
    if (BULLET_PREFIX_RE.test(l)) {
      return l;
    }
    if (idx === 0) firstDelta = 2;
    totalDelta += 2;
    return `• ${l}`;
  });

  const updated = updatedLines.join('\n');
  const next = `${current.slice(0, lineStart)}${updated}${current.slice(lineEnd)}`;
  const selStart = Math.max(lineStart, start + firstDelta);
  const selEnd = Math.max(selStart, end + totalDelta);
  return { next, selStart, selEnd };
}

/**
 * Pressing Enter inside a bulleted line:
 * - On an empty bullet (`• |`), removes the bullet prefix to exit the list.
 * - On a non-empty bullet (`• item|`), inserts `\n• ` and places the caret after the new bullet.
 * Returns `null` when the current line is not a bullet list item (so default Enter runs).
 */
export function computeBulletEnter(current: string, start: number, end: number): NoteEditResult | null {
  if (start !== end) return null;
  const lineStart = current.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineEndIdx = current.indexOf('\n', start);
  const lineEnd = lineEndIdx < 0 ? current.length : lineEndIdx;
  const line = current.slice(lineStart, lineEnd);
  const m = BULLET_PREFIX_RE.exec(line);
  if (!m) return null;

  const prefix = m[1]!;
  if (start < lineStart + prefix.length) return null;

  const body = line.slice(prefix.length);
  if (!body.trim()) {
    return {
      next: `${current.slice(0, lineStart)}${current.slice(lineEnd)}`,
      selStart: lineStart,
      selEnd: lineStart,
    };
  }

  const insert = `\n${prefix}`;
  const next = `${current.slice(0, start)}${insert}${current.slice(end)}`;
  const caret = start + insert.length;
  return { next, selStart: caret, selEnd: caret };
}

/**
 * Pressing Backspace when the caret sits right after a bullet prefix (`• |`) removes the entire
 * bullet prefix in one keypress instead of leaving a stray `•`.
 */
export function computeBulletBackspace(current: string, start: number, end: number): NoteEditResult | null {
  if (start !== end) return null;
  const lineStart = current.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const line = current.slice(lineStart, start);
  const m = BULLET_PREFIX_RE.exec(line);
  if (!m || m[1]!.length !== line.length) return null;
  return {
    next: `${current.slice(0, lineStart)}${current.slice(start)}`,
    selStart: lineStart,
    selEnd: lineStart,
  };
}

/** Apply a `NoteEditResult` to a `<textarea>` and restore focus/selection on the next frame. */
export function commitNoteEdit(
  el: HTMLTextAreaElement | null,
  edit: NoteEditResult,
  commit: (next: string, discrete?: boolean) => void,
  discrete = true,
): void {
  commit(edit.next, discrete);
  if (el) {
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(edit.selStart, edit.selEnd);
    });
  }
}

export function applyNoteFormatting(
  el: HTMLTextAreaElement | null,
  current: string,
  action: NoteFormatAction,
  commit: (next: string, discrete?: boolean) => void,
): void {
  const start = el ? el.selectionStart : current.length;
  const end = el ? el.selectionEnd : current.length;
  const edit = computeNoteFormatting(current, start, end, action);
  commitNoteEdit(el, edit, commit, true);
}

/**
 * Shared keydown handler for speaker-notes textareas:
 * - Routes Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z / Ctrl+Y to Ordo's `editorStore` undo/redo so programmatic
 *   toolbar edits never desync with the browser's native `<textarea>` undo stack.
 * - Cmd/Ctrl+B toggles `**highlight**`.
 * - Enter on a bullet line continues (or exits) the bullet list.
 * - Backspace right after `• ` removes the whole bullet prefix in one keypress.
 */
export function handleSpeakerNoteKeyDown(
  e: KeyboardEvent<HTMLTextAreaElement>,
  opts: {
    el: HTMLTextAreaElement | null;
    notes: string;
    readOnly: boolean;
    commit: (next: string, discrete?: boolean) => void;
    onEscape?: () => void;
    onStepSlide?: (delta: -1 | 1) => void;
  },
): void {
  const { el, notes, readOnly, commit, onEscape, onStepSlide } = opts;

  const step = historyKey(e.nativeEvent);
  if (step) {
    e.preventDefault();
    if (!readOnly) (step === 'undo' ? undo : redo)();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    if (!readOnly) applyNoteFormatting(el, notes, 'highlight', commit);
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !readOnly && el) {
    const edit = computeBulletEnter(notes, el.selectionStart, el.selectionEnd);
    if (edit) {
      e.preventDefault();
      commitNoteEdit(el, edit, commit, true);
      return;
    }
  }

  if (e.key === 'Backspace' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !readOnly && el) {
    const edit = computeBulletBackspace(notes, el.selectionStart, el.selectionEnd);
    if (edit) {
      e.preventDefault();
      commitNoteEdit(el, edit, commit, true);
      return;
    }
  }

  if (e.key === 'Escape' && onEscape) {
    e.preventDefault();
    onEscape();
    return;
  }

  if (e.altKey && onStepSlide && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    onStepSlide(e.key === 'ArrowDown' ? 1 : -1);
  }
}
