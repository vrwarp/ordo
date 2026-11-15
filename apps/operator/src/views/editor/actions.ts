import {
  type Box,
  cellBodyOf,
  cellTextObject,
  type ImageCrop,
  type ImageObject,
  deleteCol,
  deleteRow,
  insertCol,
  insertRow,
  placeCells,
  type Presentation,
  type Rgba,
  setCellFill,
  TABLE_LIMITS,
  type SlideObject,
  setCell,
  type TableData,
  type TextObject,
} from '@ordo/domain';
import {
  change,
  currentObjects,
  currentSlide,
  selectObject,
  selectObjects,
  inlineTarget,
  selectCell,
  selectSlide,
  setTextRange,
  startInlineEditing,
  stopInlineEditing,
  type TextTarget,
  useEditor,
} from './editorStore.ts';
import {
  addRefusalText,
  applyStyleToSimilar,
  canAdd,
  type BackgroundMedia,
  type BackgroundScope,
  clearSlideBackground,
  deleteObjects,
  duplicateObjects,
  editText,
  type FindOptions,
  findReplace,
  formatRange,
  groupBox,
  hideSlide,
  htmlToRichText,
  MAX_OBJECTS,
  MAX_SECTION_SLIDES,
  moveObjects,
  type ObjectSanitizer,
  newSlideLike,
  type ParaPatch,
  parseObjectsFromHtml,
  pasteObjects,
  pasteRichText,
  type PictureFlip,
  type PictureMask,
  type PictureSize,
  refitText,
  reorderObjects,
  replaceBackground,
  replaceBackgroundOf,
  replacePicture,
  resizeRange,
  type RichTextSlice,
  richTextToHtml,
  type RunPatch,
  runOverrides,
  serializeObjectsToHtml,
  setCrop,
  setFlip,
  setMask,
  setParas,
  sliceRichText,
  textOnSlide,
  transformGroup,
  ungroup,
  useAsBackground,
  withObject,
  withSlide,
} from './ops/index.ts';
import type { SlideRect } from './CanvasGuides.tsx';
import { addObject, getSlide, type ZOrder } from './ops.ts';
import { type AlignTo, alignedBox, placeObjects, placementArea } from './placement.ts';
// F: the PowerPoint card's slide ops (pure, beside the card's other readers).
import { showObjects, showPicture } from '../../lib/pptxImport.ts';
import { toast } from '../../state/toasts.ts';

/*
 * The M4 ops wired into the editor store (M4.md): each action applies one op to the open presentation through
 * `change()`, so it is one undo step (200 deep; coalesced with the next one of the same key within 800 ms
 * where a key is given), it marks the draft unsaved and saves with the presentation (`save()`: a PUT with
 * the base rev, 409 and 423 handled there), and it records nothing when the op changes nothing (the ops
 * return their input then). Actions read the open slide and the selection from the store. Like `change()`,
 * they do not check the read-only lock: the panels disable their controls when the presentation is locked.
 *
 * Each item owns its block; add actions to your own block only.
 */

/** The open slide's id, or undefined when nothing is open. */
function openSlide(): string | undefined {
  const s = useEditor.getState();
  return s.draft ? s.slideId : undefined;
}

/**
 * Apply an object-level op to one object of the open slide. A locked object (PowerPoint art, SmartArt, table
 * grids) is left alone: its text, geometry and picture are read-only (design/27 §11 "Locked objects").
 */
function onObject(objectId: string, fn: (o: SlideObject) => SlideObject, key?: string): void {
  const slideId = openSlide();
  if (!slideId) return;
  change((p) => withObject(p, slideId, objectId, (o) => (o.locked ? o : fn(o))), key);
}

/** A text op's target: a text object's id, or a `TextTarget` (with `cell`, that cell of a table). */
export type TextTargetArg = string | TextTarget;

/** The target named by `t`. */
export const targetOf = (t: TextTargetArg): TextTarget => (typeof t === 'string' ? { objectId: t } : t);

/**
 * `fn` applied to cell `cell` of table `o` as the cell's text object view (`cellTextObject`) and written back
 * through `setCell` (design/15 "Table editing"): so every text op (typing, a format, paragraph styles, a paste)
 * edits a cell as it edits a text box. `o` itself when it is no table, `fn` changes nothing, or the cell's or
 * the table's bounds refuse the result (`setCell`).
 */
export function editCell(o: SlideObject, cell: number, fn: (t: TextObject) => TextObject): SlideObject {
  if (o.type !== 'shape' || !o.table) return o;
  const view = cellTextObject(o, cell);
  if (!view) return o;
  const next = fn(view);
  return next === view ? o : setCell(o, cell, cellBodyOf(next));
}

/** `fn` on the text of `target`: a text object of the open slide, or a table's cell (locked objects left alone). */
function onText(target: TextTargetArg, fn: (o: TextObject) => TextObject, key?: string): void {
  const { objectId, cell } = targetOf(target);
  if (cell === undefined) onObject(objectId, (o) => (o.type === 'text' ? fn(o) : o), key);
  else onObject(objectId, (o) => editCell(o, cell, fn), key);
}

/** The undo key of an edit of `kind` on a target: per object, and per cell for a table (`cell:<id>:<i>`). */
function targetKey(kind: string, t: TextTarget): string {
  return t.cell === undefined ? `${kind}:${t.objectId}` : `${kind}:${t.objectId}:${t.cell}`;
}
const onImage = (objectId: string, fn: (o: ImageObject) => ImageObject, key?: string) =>
  onObject(objectId, (o) => (o.type === 'image' ? fn(o) : o), key);

// ---- A: text ops -------------------------------------------------------------------------------------

/**
 * The textarea's edit of a text object or a table's cell (typing coalesces per object, and per cell:
 * `cell:<id>:<i>`).
 */
export function typeText(target: TextTargetArg, next: string, caret?: number): void {
  const t = targetOf(target);
  onText(
    t,
    (o) => editText(o, next, caret),
    t.cell === undefined ? targetKey('text', t) : targetKey('cell', t),
  );
}

/**
 * A format op on a text object of the open slide (locked objects left alone). On the lyric object of a
 * presentation with a theme it also marks the theme override paths `overrides` on the slide (`runs.color`,
 * `runs.sizeScale`, ...: ops/text.ts `runOverrides`), so the next theme keeps what the volunteer formatted
 * (design/27 §11 "Themes"), as the Object panel marks `style.*` for the box style.
 */
function onFormat(
  target: TextTargetArg,
  fn: (o: TextObject) => TextObject,
  overrides: string[],
  key?: string,
) {
  const t = targetOf(target);
  // A table is never the lyric box: a cell marks no theme override.
  if (t.cell !== undefined) return onText(t, fn, key);
  const slideId = openSlide();
  if (!slideId) return;
  change(
    (p) => withSlide(p, slideId, (s) => textOnSlide(s, t.objectId, fn, p.themeId ? overrides : [])),
    key,
  );
}

/** The format bar: format the selection `[start, end)` of a text object or a table's cell. */
export function formatSelection(target: TextTargetArg, start: number, end: number, patch: RunPatch): void {
  onFormat(target, (o) => formatRange(o, start, end, patch), runOverrides(patch));
}

/** The format bar's Size ±: scale the selection's sizes (repeated clicks coalesce). */
export function resizeSelection(target: TextTargetArg, start: number, end: number, factor: number): void {
  onFormat(
    target,
    (o) => resizeRange(o, start, end, factor),
    runOverrides({ sizeScale: factor }),
    targetKey('size', targetOf(target)),
  );
}

/**
 * The box style of a table's cell (the table bar's font, size, bold, colour and alignment with no characters
 * selected): `fn` of the cell view's style, written to the cell's style entry. `key` coalesces repeated changes
 * of one field into one step (`style:<id>:<i>:<field>`).
 */
export function setCellStyle(
  target: TextTarget,
  fn: (s: TextObject['style']) => TextObject['style'],
  key?: string,
) {
  if (target.cell === undefined) return;
  onText(
    target,
    (o) => {
      const style = fn(o.style);
      return style === o.style ? o : { ...o, style };
    },
    key ? `style:${target.objectId}:${target.cell}:${key}` : undefined,
  );
}

/**
 * The paragraph strip: style the paragraphs the selection touches. `key` coalesces a field changed step by
 * step (a number field's arrows), e.g. `spaceBeforePx`.
 */
export function setParagraphs(
  target: TextTargetArg,
  start: number,
  end: number,
  patch: ParaPatch,
  key?: string,
): void {
  const t = targetOf(target);
  onText(t, (o) => setParas(o, start, end, patch), key ? `${targetKey('paras', t)}:${key}` : undefined);
}

/** 'Re-fit text'. */
export function refit(objectId: string): void {
  onText(objectId, refitText);
}

// ---- A (tables): moving between a table's cells ---------------------------------------------------------

/**
 * The cell after cell `i` (before it, `back`) in reading order: `TableData.cells` order, which is where the
 * cells sit row by row (`placeCells`), cells past the grid skipped. Undefined past the last (first) cell.
 */
export function nextCell(
  t: Pick<TableData, 'rows' | 'cols' | 'cells'>,
  i: number,
  back: boolean,
): number | undefined {
  const { anchors } = placeCells(t);
  for (let k = back ? i - 1 : i + 1; k >= 0 && k < anchors.length; k += back ? -1 : 1)
    if (anchors[k]) return k;
  return undefined;
}

/**
 * Tab (Shift+Tab, `back`) from cell `cell` of table `objectId` on the open slide: the next (previous) cell.
 * Tab in the last cell adds a row under the last one (`insertRow`, the last row's look, one undo step) when
 * `grow`, and goes to its first cell, as PowerPoint does. The cell to select, or undefined (no such table, the
 * first cell with Shift+Tab, a locked table, or a row past `TABLE_LIMITS`).
 */
export function tabCell(objectId: string, cell: number, back: boolean, grow = true): number | undefined {
  const o = currentSlide()?.objects.find((x) => x.id === objectId);
  if (o?.type !== 'shape' || !o.table) return undefined;
  const n = nextCell(o.table, cell, back);
  if (n !== undefined || back || !grow || o.locked) return n;
  const { R } = placeCells(o.table);
  let made: number | undefined;
  onObject(objectId, (x) => {
    if (x.type !== 'shape' || !x.table) return x;
    const y = insertRow(x, R, R - 1);
    if (y === x || !y.table) return x;
    const p = placeCells(y.table);
    const first = p.slots[R * p.C];
    made = first !== undefined && first >= 0 ? first : undefined;
    return y;
  });
  return made;
}

/**
 * The canvas's keys on the selected table (EditorView's window handler, where the slide has the keys; design/15
 * "Table editing"): Enter edits the selected cell (the first one when none is), its caret at the end of its
 * text; Tab and Shift+Tab select the next or previous cell (a new row past the last, unless `readOnly`);
 * Escape goes from a cell back to the whole table; Delete and Backspace empty the selected cell's text (the
 * table stays: Delete with the whole table selected deletes it, as for any object). Whether the key was one.
 */
export function tableKey(e: { key: string; shiftKey: boolean }, o: SlideObject, readOnly: boolean): boolean {
  if (o.type !== 'shape' || !o.table) return false;
  const st = useEditor.getState();
  const cell = st.objectId === o.id ? st.cell : undefined;
  const first = nextCell(o.table, -1, false) ?? 0;
  switch (e.key) {
    case 'Enter': {
      if (readOnly || o.locked) return false;
      const at = cell ?? first;
      const len = cellTextObject(o, at)?.text.length ?? 0;
      selectCell(o.id, at);
      startInlineEditing(o.id, { start: len, end: len, caret: len }, at);
      return true;
    }
    case 'Tab': {
      const next =
        cell === undefined
          ? e.shiftKey
            ? nextCell(o.table, o.table.cells.length, true)
            : first
          : tabCell(o.id, cell, e.shiftKey, !readOnly);
      if (next !== undefined) selectCell(o.id, next);
      return true;
    }
    case 'Escape':
      if (cell === undefined) return false;
      stopInlineEditing();
      selectCell(o.id, undefined);
      return true;
    case 'Delete':
    case 'Backspace':
      if (cell === undefined) return false;
      if (!readOnly) typeText({ objectId: o.id, cell }, '', 0);
      setTextRange({ start: 0, end: 0 });
      return true;
    default:
      return false;
  }
}

/**
 * What the canvas edits inline, as the text object the clipboard actions read (a text box, or a table cell's
 * view, `cellTextObject`) with its target; undefined when nothing is edited.
 */
export function inlineText(): { view: TextObject; target: TextTarget } | undefined {
  const t = inlineTarget();
  if (!t) return undefined;
  const o = currentSlide()?.objects.find((x) => x.id === t.objectId);
  if (!o) return undefined;
  if (t.cell === undefined) return o.type === 'text' ? { view: o, target: t } : undefined;
  const view = o.type === 'shape' ? cellTextObject(o, t.cell) : undefined;
  return view ? { view, target: t } : undefined;
}

// ---- A (tables): fills, rows and columns -----------------------------------------------------------

/**
 * 'Cell fill' (the table bar and panel): cell `cell` of table `objectId` filled with `color`, or with no fill
 * (null); with no cell selected, every cell. One undo step (`setCellFill`); none when every one of the cells
 * already has that solid fill (a paint picker sends its colour again on Enter or a tab).
 */
export function fillCells(objectId: string, cell: number | undefined, color: Rgba | null): void {
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table) return o;
    const t = o.table;
    const which = cell === undefined ? t.cells.map((_, i) => i) : [cell];
    const has = (i: number) => {
      const k = t.cells[i]?.fill;
      const f = k === undefined ? undefined : t.fills?.[k];
      if (!color) return !f;
      return !!f && !f.gradient && JSON.stringify(f.color) === JSON.stringify(color);
    };
    return which.every(has) ? o : setCellFill(o, which, color);
  });
}

/** The table bar's and panel's 'Rows & columns' ops. */
export type RowColOp = 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'deleteRow' | 'deleteCol';

/** The rows and columns menu, in its order, with what each says. */
export const ROW_COL_OPS: readonly [RowColOp, string][] = [
  ['rowAbove', 'Row above'],
  ['rowBelow', 'Row below'],
  ['colLeft', 'Column left'],
  ['colRight', 'Column right'],
  ['deleteRow', 'Delete row'],
  ['deleteCol', 'Delete column'],
];

/**
 * Whether `op` can be made on table `t` from cell `cell` (none: the whole table): a row or column added within
 * `TABLE_LIMITS` (rows, columns, grid slots); a row or column deleted from a selected cell, never the last one.
 */
export function canRowCol(
  t: Pick<TableData, 'rows' | 'cols' | 'cells'>,
  op: RowColOp,
  cell?: number,
): boolean {
  const { R, C, anchors } = placeCells(t);
  if (!R || !C) return false;
  switch (op) {
    case 'rowAbove':
    case 'rowBelow':
      return R + 1 <= TABLE_LIMITS.rows && (R + 1) * C <= TABLE_LIMITS.grid;
    case 'colLeft':
    case 'colRight':
      return C + 1 <= TABLE_LIMITS.cols && R * (C + 1) <= TABLE_LIMITS.grid;
    case 'deleteRow':
      return cell !== undefined && !!anchors[cell] && R > 1;
    case 'deleteCol':
      return cell !== undefined && !!anchors[cell] && C > 1;
  }
}

/**
 * 'Rows & columns' on table `objectId` (design/15 "Table editing"): from cell `cell` (its first row and column;
 * a merged cell's span grows over an inserted line), or without one at the table's top, bottom, left or right
 * edge. One undo step (`insertRow`, `deleteRow`, `insertCol`, `deleteCol`: a new line copies the look of the one
 * beside it). The cell to select afterwards (the same cell where it moved, its neighbour when its line was
 * deleted), or undefined when nothing changed or no cell was selected.
 */
export function rowCol(objectId: string, op: RowColOp, cell?: number): number | undefined {
  const o = currentSlide()?.objects.find((x) => x.id === objectId);
  if (o?.type !== 'shape' || !o.table || o.locked || !canRowCol(o.table, op, cell)) return undefined;
  const { R, C, anchors } = placeCells(o.table);
  const a = cell === undefined ? undefined : anchors[cell];
  let next: number | undefined;
  onObject(objectId, (x) => {
    if (x.type !== 'shape' || !x.table) return x;
    let y = x;
    let at: { row: number; col: number } | undefined = a && { row: a.row, col: a.col };
    if (op === 'rowAbove') {
      y = a ? insertRow(x, a.row, a.row) : insertRow(x, 0, 0);
      if (at) at.row++;
    } else if (op === 'rowBelow')
      y = a ? insertRow(x, a.row + a.rows, a.row + a.rows - 1) : insertRow(x, R, R - 1);
    else if (op === 'colLeft') {
      y = a ? insertCol(x, a.col, a.col) : insertCol(x, 0, 0);
      if (at) at.col++;
    } else if (op === 'colRight')
      y = a ? insertCol(x, a.col + a.cols, a.col + a.cols - 1) : insertCol(x, C, C - 1);
    else if (op === 'deleteRow' && a) {
      y = deleteRow(x, a.row);
      at = { row: Math.min(a.row, R - 2), col: a.col };
    } else if (op === 'deleteCol' && a) {
      y = deleteCol(x, a.col);
      at = { row: a.row, col: Math.min(a.col, C - 2) };
    }
    if (y === x || !y.table) return x;
    if (at) {
      const p = placeCells(y.table);
      const k = p.slots[at.row * p.C + at.col];
      next = k !== undefined && k >= 0 ? k : undefined;
    }
    return y;
  });
  return next;
}

// ---- Rich clipboard (text & slide objects) ----------------------------------------------------------

let lastRichTextClip: { slice: RichTextSlice; plain: string } | null = null;
let lastObjectClip: {
  objects: SlideObject[];
  sourceSlideId?: string;
  lastSlideId?: string;
  pasteCount: number;
  plain: string;
  html: string;
} | null = null;

/** Paste a `RichTextSlice` into `[start, end)` of a text object or a table's cell; returns the new caret offset. */
export function pasteRichSelection(
  to: TextTargetArg,
  start: number,
  end: number,
  slice: RichTextSlice,
): number {
  let caret = Math.min(start, end) + slice.text.length;
  const slideId = openSlide();
  if (!slideId) return caret;
  const { objectId, cell } = targetOf(to);
  if (cell !== undefined) {
    change((p) =>
      withObject(p, slideId, objectId, (o) =>
        o.locked
          ? o
          : editCell(o, cell, (v) => {
              const r = pasteRichText(v, start, end, slice);
              caret = r.caret;
              return r.object;
            }),
      ),
    );
    return caret;
  }
  change((p) =>
    withSlide(p, slideId, (s) => {
      const target = s.objects.find((x) => x.id === objectId);
      if (target?.type !== 'text' || target.locked) return s;
      const r = pasteRichText(target, start, end, slice);
      caret = r.caret;
      return textOnSlide(s, objectId, () => r.object, p.themeId ? r.overrides : []);
    }),
  );
  return caret;
}

/** Copy `[start, end)` of `o` as rich text + HTML; returns the copied slice or null if empty. */
export function copyTextSelection(
  o: TextObject,
  start: number,
  end: number,
  clipboardData?: DataTransfer | null,
): RichTextSlice | null {
  const slice = sliceRichText(o, start, end);
  if (!slice.text) return null;
  lastRichTextClip = { slice, plain: slice.text };
  lastObjectClip = null;
  if (clipboardData) {
    try {
      clipboardData.setData('text/plain', slice.text);
      clipboardData.setData('text/html', richTextToHtml(slice, o.style));
    } catch {
      // Ignore synthetic DataTransfer restrictions in tests.
    }
  }
  return slice;
}

/**
 * Cut `[start, end)` of `o` (a text object, or a table cell's view with its `target`) as rich text + HTML;
 * returns the new caret offset or null if empty.
 */
export function cutTextSelection(
  o: TextObject,
  start: number,
  end: number,
  clipboardData?: DataTransfer | null,
  target: TextTargetArg = o.id,
): number | null {
  const slice = copyTextSelection(o, start, end, clipboardData);
  if (!slice) return null;
  return pasteRichSelection(target, start, end, { text: '' });
}

/**
 * Paste rich or plain text from `clipboardData` (or in-memory fallback) into `[start, end)` of `o` (a text
 * object, or a table cell's view with its `target`); returns the new caret offset, or null if nothing was
 * pasted.
 */
export function handleTextPaste(
  o: TextObject,
  start: number,
  end: number,
  clipboardData?: DataTransfer | null,
  target: TextTargetArg = o.id,
): number | null {
  const html = clipboardData?.getData('text/html') ?? '';
  const plain = clipboardData?.getData('text/plain') ?? '';
  if (html) {
    const rich = htmlToRichText(html, o.style);
    if (rich) return pasteRichSelection(target, start, end, rich);
  }
  if (lastRichTextClip && (!plain || plain === lastRichTextClip.plain)) {
    return pasteRichSelection(target, start, end, lastRichTextClip.slice);
  }
  if (plain) {
    return pasteRichSelection(target, start, end, { text: plain });
  }
  return null;
}

// ---- B: group ops (on the store's selection, `objectIds`) -------------------------------------------

function onSelection(
  fn: (p: Presentation, slideId: string, ids: string[]) => Presentation,
  key?: string,
): void {
  const s = useEditor.getState();
  const slideId = openSlide();
  if (!slideId || !s.objectIds.length) return;
  const ids = [...s.objectIds];
  change((p) => fn(p, slideId, ids), key);
}

/** Move the selection (a drag, or nudges, which coalesce). */
export function moveSelection(dx: number, dy: number): void {
  const ids = useEditor.getState().objectIds;
  onSelection((p, slideId, sel) => moveObjects(p, slideId, sel, dx, dy), `nudge:${ids.join(',')}`);
}

/** A drag of the selection on the canvas: one undo step per drag (nudges coalesce, drags do not). */
export function dragSelection(dx: number, dy: number): void {
  onSelection((p, slideId, ids) => moveObjects(p, slideId, ids, dx, dy));
}

/** The Transformer over the selection: its box went from `from` to `to`. */
export function transformSelection(from: Box, to: Box): void {
  onSelection((p, slideId, ids) => transformGroup(p, slideId, ids, from, to));
}

/**
 * The Object panel's box editor on a multi-object selection: the group box (`groupBox`) set to `to`, every
 * member scaled and moved with it (a `to.rotation` turns them about its centre).
 */
export function setSelectionBox(to: Box): void {
  const from = groupBox(currentObjects());
  if (from) transformSelection(from, to);
}

/** Delete the selection. */
export function deleteSelection(): void {
  onSelection((p, slideId, ids) => deleteObjects(p, slideId, ids));
  const s = useEditor.getState();
  if (s.draft) selectObjects(s.objectIds);
}

/** Duplicate the selection; the copies become the selection (the primary's copy the primary). */
export function duplicateSelection(): void {
  const { objectIds, objectId } = useEditor.getState();
  if (refused(currentObjects())) return;
  let copies: string[] = [];
  let tried = false;
  onSelection((p, slideId, ids) => {
    tried = true;
    const r = duplicateObjects(p, slideId, ids);
    copies = r.ids;
    return r.p;
  });
  if (copies.length) selectObjects(copies, objectId ? copies[objectIds.indexOf(objectId)] : undefined);
  else if (tried && currentObjects().length)
    toast(`A slide holds at most ${MAX_OBJECTS} objects: the copy was not made.`, 'warn');
}

/** Z-order the selection as one block. */
export function reorderSelection(z: ZOrder): void {
  onSelection((p, slideId, ids) => reorderObjects(p, slideId, ids, z));
}

/** 'Ungroup' the selection. */
export function ungroupSelection(): void {
  onSelection((p, slideId, ids) => ungroup(p, slideId, ids));
}

/**
 * 'Align to slide' and 'Screen placement' on the selection as one block (placement.ts `placeObjects`: its
 * bounds as drawn, inside the deck's area, turns kept, one undo step): the Object panel's align bar and
 * cards, and the floating bar's Align menu for a selection of several objects. A themed song's lyric box
 * marks its `box` override.
 */
export function placeSelection(target: (from: Box, area: SlideRect) => Box): void {
  const { draft } = useEditor.getState();
  const slideId = openSlide();
  const objects = currentObjects();
  if (!draft || !slideId || !objects.length) return;
  const slide = getSlide(draft, slideId);
  const lyricId =
    draft.kind === 'song'
      ? (slide?.lyricObjectId ?? slide?.objects.find((x) => x.type === 'text')?.id)
      : undefined;
  const area = placementArea(draft);
  change((p) => placeObjects(p, slideId, objects, (from) => target(from, area), lyricId));
}

/** The selection aligned to an edge or the centre of the slide (the deck's area). */
export function alignSelection(to: AlignTo): void {
  placeSelection((from, area) => alignedBox(from, area, to));
}

/** Copy the selected slide objects to the clipboard (in-memory + system `text/html`). */
export function copySelection(clipboardData?: DataTransfer | null): boolean {
  const objs = currentObjects();
  const slideId = openSlide();
  if (!objs.length || !slideId) return false;
  const { html, text } = serializeObjectsToHtml(objs, slideId);
  lastObjectClip = {
    objects: structuredClone(objs) as SlideObject[],
    sourceSlideId: slideId,
    lastSlideId: slideId,
    pasteCount: 0,
    plain: text,
    html,
  };
  lastRichTextClip = null;
  if (clipboardData) {
    try {
      clipboardData.setData('text/plain', text);
      clipboardData.setData('text/html', html);
    } catch {
      // Ignore synthetic DataTransfer restrictions.
    }
  }
  return true;
}

/** Write the most recently copied/cut slide objects into `clipboardData` (used when `cut` fires after `keydown`). */
export function writeLastObjectClip(clipboardData?: DataTransfer | null): boolean {
  if (!lastObjectClip || !clipboardData) return false;
  try {
    clipboardData.setData('text/plain', lastObjectClip.plain);
    clipboardData.setData('text/html', lastObjectClip.html);
    return true;
  } catch {
    return false;
  }
}

/** Cut the selected slide objects (copy + delete in one action). */
export function cutSelection(clipboardData?: DataTransfer | null): boolean {
  if (!copySelection(clipboardData)) return false;
  if (lastObjectClip) lastObjectClip.pasteCount = -1;
  deleteSelection();
  return true;
}

/** Whether there are copied slide objects available in memory. */
export function hasCopiedObjects(): boolean {
  return !!lastObjectClip && lastObjectClip.objects.length > 0;
}

/** Paste `objects` onto the open slide, selecting the newly created copies. */
export function pasteCopiedObjects(
  objects?: readonly SlideObject[],
  sourceSlideId?: string,
  pasteCount?: number,
  targetSlideId?: string,
): string[] {
  const slideId = targetSlideId ?? openSlide();
  if (!slideId) return [];
  const srcObjs = objects ?? lastObjectClip?.objects;
  if (!srcObjs?.length) return [];
  if (refused(srcObjs, slideId)) return [];
  const srcSlide = sourceSlideId ?? lastObjectClip?.sourceSlideId;
  let count = pasteCount;
  if (count === undefined) {
    if (lastObjectClip && srcObjs === lastObjectClip.objects) {
      lastObjectClip.pasteCount++;
      count = lastObjectClip.pasteCount;
    } else {
      count = 1;
    }
  }
  const sameSlide = !srcSlide || srcSlide === slideId;
  const step = !sameSlide && count <= 1 ? 0 : Math.max(0, Math.min(count, 10)) * 20;
  let copies: string[] = [];
  let full = false;
  change((p) => {
    const r = pasteObjects(p, slideId, srcObjs, { dx: step, dy: step });
    copies = r.ids;
    full = !!r.full;
    return r.p;
  });
  if (copies.length) {
    selectObjects(copies, copies[copies.length - 1]);
  } else if (full) {
    toast(`A slide holds at most ${MAX_OBJECTS} objects: the paste was not made.`, 'warn');
  }
  return copies;
}

/**
 * The importers' sanitize dispatch (`@ordo/importers` `sanitizeObject`) for objects pasted from the system
 * clipboard, loaded with the first such paste: it lives in the importer's own chunk, not the editor's.
 */
let sanitizer: Promise<ObjectSanitizer> | undefined;
export function loadObjectSanitizer(): Promise<ObjectSanitizer> {
  sanitizer ??= import('@ordo/importers/sanitize.ts').then((m) => m.sanitizeObject);
  return sanitizer;
}

/**
 * Check `clipboardData` (or the in-memory object clipboard) for copied Ordo slide objects and paste them onto
 * the open slide. Null when the clipboard holds no slide objects (the caller then pastes its text). Else a
 * promise of the pasted ids: objects from the system clipboard (`data-ordo-objects`) are pasted once the
 * sanitizer has loaded, and only those that pass it (`parseObjectsFromHtml`); ordo's own in-memory copy at
 * once.
 */
export function tryPasteObjectsFromClipboard(clipboardData?: DataTransfer | null): Promise<string[]> | null {
  const slideId = openSlide();
  const html = clipboardData?.getData('text/html') ?? '';
  const plain = clipboardData?.getData('text/plain') ?? '';
  const nextCount = (srcSlideId?: string) => {
    if (!lastObjectClip) return slideId && srcSlideId && slideId !== srcSlideId ? 0 : 1;
    if (slideId && slideId !== lastObjectClip.lastSlideId) {
      lastObjectClip.lastSlideId = slideId;
      lastObjectClip.pasteCount = slideId !== (srcSlideId ?? lastObjectClip.sourceSlideId) ? 0 : 1;
      return lastObjectClip.pasteCount;
    }
    lastObjectClip.pasteCount++;
    return lastObjectClip.pasteCount;
  };
  if (html) {
    // The schema check now (it decides whether this is an object paste); the sanitizer once loaded.
    const parsed = parseObjectsFromHtml(html);
    if (parsed) {
      const count = lastObjectClip && lastObjectClip.plain === plain ? nextCount(parsed.sourceSlideId) : 1;
      return loadObjectSanitizer().then(
        (sanitize) => {
          const clean = parseObjectsFromHtml(html, sanitize);
          if (clean?.left) toast(leftOutText(clean.left, clean.objects.length), 'warn', 8000);
          if (!clean?.objects.length) return [];
          return pasteCopiedObjects(clean.objects, clean.sourceSlideId, count, slideId);
        },
        () => {
          toast('The pasted objects could not be read: nothing was added.', 'warn', 8000);
          return [];
        },
      );
    }
  }
  if (lastObjectClip && (!plain || plain === lastObjectClip.plain) && !html) {
    const count = nextCount(lastObjectClip.sourceSlideId);
    return Promise.resolve(pasteCopiedObjects(lastObjectClip.objects, lastObjectClip.sourceSlideId, count));
  }
  return null;
}

/**
 * What the editor says when objects pasted from the system clipboard were left out (`parseObjectsFromHtml`
 * `left`): they did not pass the slide object schema, the sanitizer or the render clamp (design/21).
 */
export function leftOutText(left: number, kept: number): string {
  const what = left === 1 ? '1 pasted object' : `${left} pasted objects`;
  return kept
    ? `${what} could not be used on a slide and ${left === 1 ? 'was' : 'were'} left out; the rest was pasted.`
    : `${what} could not be used on a slide: nothing was added.`;
}

/**
 * Whether adding `objects` to the open slide (or `slideId`) is refused (`canAdd`: the screens draw at most
 * 200 objects and 16 pictures of a slide); a refusal is said in a toast.
 */
function refused(objects: readonly SlideObject[], slideId = openSlide()): boolean {
  const s = useEditor.getState();
  const slide = s.draft && slideId ? getSlide(s.draft, slideId) : undefined;
  const why = slide ? canAdd(slide, objects) : null;
  if (why) toast(addRefusalText(why), 'warn', 8000);
  return !!why;
}

/**
 * Add `o` on top of slide `slideId` and select it (the toolbar's Text, Image and shapes, a pasted picture or
 * text), unless the slide already holds what the screens can draw (`canAdd`). Whether it was added.
 */
export function addToSlide(slideId: string, o: SlideObject): boolean {
  if (refused([o], slideId)) return false;
  change((p) => addObject(p, slideId, o));
  const s = useEditor.getState();
  if (s.draft && s.slideId === slideId) selectObject(o.id);
  return true;
}

/** Whether `o` can be added to slide `slideId` (`canAdd`), saying why not in a toast. */
export function mayAdd(slideId: string, o: SlideObject): boolean {
  return !refused([o], slideId);
}

// ---- D: picture ops ----------------------------------------------------------------------------------

/** Crop a picture (the crop handles' drags coalesce per object). */
export function cropPicture(objectId: string, crop: ImageCrop | undefined): void {
  onImage(objectId, (o) => setCrop(o, crop), `crop:${objectId}`);
}

export function maskPicture(objectId: string, mask: PictureMask | undefined): void {
  onImage(objectId, (o) => setMask(o, mask));
}

export function flipPicture(objectId: string, flip: PictureFlip): void {
  onImage(objectId, (o) => setFlip(o, flip));
}

/** 'Replace' a picture (aspect-preserving re-crop). */
export function replacePictureWith(objectId: string, media: PictureSize): void {
  onImage(objectId, (o) => replacePicture(o, media));
}

// ---- F: the PowerPoint card ---------------------------------------------------------------------------

/**
 * 'Show the PowerPoint picture on the screens' / 'Show the objects instead' (`Slide.pptx.show`; the picture
 * must exist, `refMediaId`). The re-import and the reference pictures are hub jobs (`pptxJobs.ts`).
 */
export function setSlideShows(slideId: string, what: 'picture' | 'objects'): void {
  change((p) => withSlide(p, slideId, what === 'picture' ? showPicture : showObjects));
}

// ---- E: slide and presentation ops -------------------------------------------------------------------

/** Find and replace across the presentation; how many matches were replaced. */
export function findAndReplace(find: string, repl: string, opts: FindOptions = {}): number {
  let replaced = 0;
  change((p) => {
    const r = findReplace(p, find, repl, opts);
    replaced = r.replaced;
    return r.p;
  });
  return replaced;
}

export function setSlideHidden(slideId: string, hidden: boolean): void {
  change((p) => hideSlide(p, slideId, hidden));
}

/** 'Replace background…' on a slide, on it alone or on every slide using the same picture. */
export function replaceBackgroundWith(slideId: string, media: BackgroundMedia, scope: BackgroundScope): void {
  change((p) => replaceBackground(p, slideId, media, scope));
}

/** The slide's own background removed ('None', or 'Use the default' when the presentation has one). */
export function removeSlideBackground(slideId: string): void {
  change((p) => clearSlideBackground(p, slideId));
}

/** The Presentation panel's 'Replace on all slides…': picture `old` (or no picture) replaced everywhere. */
export function replaceDeckBackground(old: string | undefined, media: BackgroundMedia): void {
  change((p) => replaceBackgroundOf(p, old, media));
}

/** 'Apply to similar boxes'; how many boxes changed. */
export function applyToSimilar(objectId: string): number {
  const slideId = openSlide();
  if (!slideId) return 0;
  let changed = 0;
  change((p) => {
    const r = applyStyleToSimilar(p, slideId, objectId);
    changed = r.changed;
    return r.p;
  });
  return changed;
}

/** 'New slide like this'; the new slide is opened. */
export function addSlideLike(slideId: string): void {
  let id: string | undefined;
  let full = false;
  change((p) => {
    const r = newSlideLike(p, slideId);
    id = r.id;
    full = !!r.full;
    return r.p;
  });
  if (id) selectSlide(id);
  else if (full)
    toast(`A section holds at most ${MAX_SECTION_SLIDES} slides: the new slide was not added.`, 'warn');
}

/** 'Use as background' for a full-slide picture of the open slide; the picture, now gone, is deselected. */
export function pictureToBackground(objectId: string): void {
  const slideId = openSlide();
  if (!slideId) return;
  const before = useEditor.getState().draft;
  change((p) => useAsBackground(p, slideId, objectId));
  const s = useEditor.getState();
  if (s.draft !== before) selectObjects(s.objectIds.filter((id) => id !== objectId));
}
