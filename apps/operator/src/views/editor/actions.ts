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
  type Slide,
  type SlideObject,
  setCell,
  type TableData,
  type TableFill,
  type TableLineStyle,
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
  selectCellRange,
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
  type BorderTarget,
  canAdd,
  canMergeCells,
  canMoveCol,
  canMoveRow,
  canSplitCell,
  cellsInRange,
  type BackgroundMedia,
  type BackgroundScope,
  clearSlideBackground,
  clearTableCells,
  deleteObjects,
  distributeCols,
  distributeRows,
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
  mergeCells,
  moveCol,
  moveObjects,
  moveRow,
  normalizeRange,
  type ObjectSanitizer,
  newSlideLike,
  type ParaPatch,
  parseObjectsFromHtml,
  parseSlidesFromHtml,
  parseTableClipboard,
  pasteMatrixIntoTable,
  pasteObjects,
  pasteRichText,
  pasteSlides,
  type PictureFlip,
  type PictureMask,
  type PictureSize,
  rangeOfCells,
  refitText,
  reorderObjects,
  replaceBackground,
  replaceBackgroundOf,
  replacePicture,
  resizeColDivider,
  resizeRange,
  resizeRowDivider,
  type RichTextSlice,
  richTextToHtml,
  type RunPatch,
  runOverrides,
  serializeObjectsToHtml,
  serializeSlidesToHtml,
  serializeTableCellsToClipboard,
  setCellsPaint,
  setCellsStyle,
  setCrop,
  setFlip,
  setMask,
  setParas,
  setTableBorders,
  sliceRichText,
  splitCell,
  type TableRange,
  targetCellIndices,
  textOnSlide,
  toggleBandedRows,
  toggleHeaderRow,
  transformGroup,
  ungroup,
  useAsBackground,
  withObject,
  withSlide,
} from './ops/index.ts';
import type { SlideRect } from './CanvasGuides.tsx';
import { addObject, deleteSlide, getSlide, type ZOrder } from './ops.ts';
import { type AlignTo, alignedBox, placeObjects, placementArea } from './placement.ts';
import { cellsByPlace, fitTable } from './tableFit.ts';
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
 * edits a cell as it edits a text box. A table whose rows are fixed (imported) grows the cell's row by what
 * the edit made its text need more (`tableFit.ts` `fitTable`). `o` itself when it is no table, `fn` changes
 * nothing, or the cell's or the table's bounds refuse the result (`setCell`).
 */
export function editCell(o: SlideObject, cell: number, fn: (t: TextObject) => TextObject): SlideObject {
  if (o.type !== 'shape' || !o.table) return o;
  const view = cellTextObject(o, cell);
  if (!view) return o;
  const next = fn(view);
  return next === view ? o : fitTable(o, setCell(o, cell, cellBodyOf(next)));
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
 * The box style of a table's cell (or selected cell range when `range` is given): `fn` of each cell view's
 * style, written to the cell's style entry. `key` coalesces repeated changes of one field into one step.
 */
export function setCellStyle(
  target: TextTarget,
  fn: (s: TextObject['style']) => TextObject['style'],
  key?: string,
  range?: TableRange,
) {
  const st = useEditor.getState();
  const activeRange = range ?? (st.objectId === target.objectId ? st.cellRange : undefined);
  if (activeRange) {
    onObject(
      target.objectId,
      (o) => {
        if (o.type !== 'shape' || !o.table) return o;
        const cells = targetCellIndices(o.table, target.cell, activeRange);
        const next = setCellsStyle(o, cells, fn);
        return next === o ? o : fitTable(o, next);
      },
      key ? `style:${target.objectId}:range:${key}` : undefined,
    );
    return;
  }
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
 * The cell beside `cell` as drawn, for an arrow key (a right-to-left table draws its first column on the
 * right), past a merged cell's whole span; undefined at the table's edge.
 */
export function cellBeside(
  t: Pick<TableData, 'rows' | 'cols' | 'cells' | 'rtl'>,
  cell: number,
  key: string,
): number | undefined {
  const { R, C, anchors, slots } = placeCells(t);
  const a = anchors[cell];
  if (!a) return undefined;
  const drawnDc = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
  const dc = t.rtl ? -drawnDc : drawnDc;
  const dr = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
  if (!dc && !dr) return undefined;
  const row = dr < 0 ? a.row - 1 : dr > 0 ? a.row + a.rows : a.row;
  const col = dc < 0 ? a.col - 1 : dc > 0 ? a.col + a.cols : a.col;
  if (row < 0 || row >= R || col < 0 || col >= C) return undefined;
  const k = slots[row * C + col];
  return k !== undefined && k >= 0 ? k : undefined;
}

/**
 * The canvas's keys on the selected table (EditorView's window handler, where the slide has the keys; design/15
 * "Table editing"): Enter edits the selected cell (the first one when none is), its caret at the end of its
 * text; with a cell selected (not edited), Tab and Shift+Tab select the next or previous cell in reading order
 * and the arrow keys the cell beside it as drawn (at an edge the cell stays selected); past the last or first
 * cell, and with the whole table selected, Tab is not the table's, so focus leaves the canvas (a row is added
 * only while a cell is being edited, SlideCanvas's text field). Escape goes from a cell back to the whole
 * table; Delete and Backspace empty the selected cell's text (the table stays: Delete with the whole table
 * selected deletes it, as for any object). Whether the key was one.
 */
export function tableKey(e: { key: string; shiftKey: boolean }, o: SlideObject, readOnly: boolean): boolean {
  if (o.type !== 'shape' || !o.table) return false;
  const st = useEditor.getState();
  const cell = st.objectId === o.id ? st.cell : undefined;
  const cellRange = st.objectId === o.id ? st.cellRange : undefined;
  const first = nextCell(o.table, -1, false) ?? 0;
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      if (cell === undefined) return false;
      if (e.shiftKey) {
        const cur = cellRange ?? rangeOfCells(o.table, cell);
        if (!cur) return true;
        const p = placeCells(o.table);
        const anchor = p.anchors[cell];
        if (!anchor) return true;
        const drawnDc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        const dc = o.table.rtl ? -drawnDc : drawnDc;
        const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        const next: TableRange = { ...cur };
        if (dr < 0) {
          if (next.r1 > anchor.row + anchor.rows - 1) next.r1 = Math.max(anchor.row, next.r1 - 1);
          else next.r0 = Math.max(0, next.r0 - 1);
        } else if (dr > 0) {
          if (next.r0 < anchor.row) next.r0 = Math.min(anchor.row, next.r0 + 1);
          else next.r1 = Math.min(p.R - 1, next.r1 + 1);
        }
        if (dc < 0) {
          if (next.c1 > anchor.col + anchor.cols - 1) next.c1 = Math.max(anchor.col, next.c1 - 1);
          else next.c0 = Math.max(0, next.c0 - 1);
        } else if (dc > 0) {
          if (next.c0 < anchor.col) next.c0 = Math.min(anchor.col, next.c0 + 1);
          else next.c1 = Math.min(p.C - 1, next.c1 + 1);
        }
        selectCellRange(o.id, cell, normalizeRange(o.table, next));
        return true;
      }
      const next = cellBeside(o.table, cell, e.key);
      if (next !== undefined) selectCell(o.id, next);
      return true;
    }
    case 'Enter': {
      if (readOnly || o.locked) return false;
      const at = cell ?? first;
      const len = cellTextObject(o, at)?.text.length ?? 0;
      selectCell(o.id, at);
      startInlineEditing(o.id, { start: len, end: len, caret: len }, at);
      return true;
    }
    case 'Tab': {
      if (cell === undefined) return false;
      const next = nextCell(o.table, cell, e.shiftKey);
      if (next === undefined) return false;
      selectCell(o.id, next);
      return true;
    }
    case 'Escape':
      if (cell === undefined && !cellRange) return false;
      stopInlineEditing();
      selectCell(o.id, undefined);
      return true;
    case 'Delete':
    case 'Backspace':
      if (cell === undefined && !cellRange) return false;
      if (!readOnly) {
        if (cellRange) {
          const targets = cellsInRange(o.table, normalizeRange(o.table, cellRange));
          onObject(o.id, (x) => {
            if (x.type !== 'shape' || !x.table) return x;
            let cur = x;
            for (const idx of targets) {
              const view = cellTextObject(cur, idx);
              if (view?.text) cur = setCell(cur, idx, { text: '', style: view.style });
            }
            return cur === x ? x : fitTable(x, cur);
          });
        } else if (cell !== undefined) {
          typeText({ objectId: o.id, cell }, '', 0);
        }
      }
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

function isTableFill(v: Rgba | TableFill): v is TableFill {
  return 'color' in v;
}

/**
 * 'Cell fill' (the table bar and panel): cell `cell` (or `range`) of table `objectId` filled with a solid
 * colour (`Rgba`), a solid/gradient `TableFill`, or no fill (`null`); with no cell or range selected, every
 * cell. One undo step; none when every target cell already has that fill.
 */
export function fillCells(
  objectId: string,
  cell: number | undefined,
  paint: Rgba | TableFill | null,
  range?: TableRange,
): void {
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table) return o;
    const t = o.table;
    const st = useEditor.getState();
    const activeRange = range ?? (st.objectId === objectId ? st.cellRange : undefined);
    const which = targetCellIndices(t, cell, activeRange);
    if (!paint) return setCellsPaint(o, which, null);
    if (isTableFill(paint)) return setCellsPaint(o, which, paint);
    const has = (i: number) => {
      const k = t.cells[i]?.fill;
      const f = k === undefined ? undefined : t.fills?.[k];
      return !!f && !f.gradient && JSON.stringify(f.color) === JSON.stringify(paint);
    };
    return which.every(has) ? o : setCellFill(o, which, paint);
  });
}

/** Merge the selected cell range into one spanned cell and select the resulting cell. */
export function mergeTableCells(objectId: string, range: TableRange): number | undefined {
  let mergedIdx: number | undefined;
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table || !canMergeCells(o.table, range)) return o;
    const norm = normalizeRange(o.table, range);
    const next = mergeCells(o, norm);
    if (next === o || !next.table) return o;
    const p = placeCells(next.table);
    const k = p.slots[norm.r0 * p.C + norm.c0];
    mergedIdx = k !== undefined && k >= 0 ? k : undefined;
    return fitTable(o, next);
  });
  if (mergedIdx !== undefined) selectCell(objectId, mergedIdx);
  return mergedIdx;
}

/** Split a merged cell back into 1×1 cells and select the split range. */
export function splitTableCell(objectId: string, cell: number): TableRange | undefined {
  let splitRange: TableRange | undefined;
  let topLeftCell: number | undefined;
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table || !canSplitCell(o.table, cell)) return o;
    const a = placeCells(o.table).anchors[cell]!;
    const next = splitCell(o, cell);
    if (next === o || !next.table) return o;
    splitRange = { r0: a.row, c0: a.col, r1: a.row + a.rows - 1, c1: a.col + a.cols - 1 };
    const p = placeCells(next.table);
    const k = p.slots[a.row * p.C + a.col];
    topLeftCell = k !== undefined && k >= 0 ? k : undefined;
    return fitTable(o, next);
  });
  if (splitRange && topLeftCell !== undefined) selectCellRange(objectId, topLeftCell, splitRange);
  return splitRange;
}

/** Apply border styling to targeted edges of `range` (or whole table). */
export function applyTableBorders(
  objectId: string,
  range: TableRange | undefined,
  target: BorderTarget,
  style: TableLineStyle | null,
): void {
  onObject(objectId, (o) => (o.type === 'shape' && o.table ? setTableBorders(o, range, target, style) : o));
}

/** Resize internal column divider `edgeIndex` by `deltaPx` slide pixels. */
export function resizeTableCol(objectId: string, edgeIndex: number, deltaPx: number): void {
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table) return o;
    const next = resizeColDivider(o, edgeIndex, deltaPx);
    return next === o ? o : fitTable(o, next);
  });
}

/** Resize internal row divider `edgeIndex` by `deltaPx` slide pixels. */
export function resizeTableRow(objectId: string, edgeIndex: number, deltaPx: number): void {
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table) return o;
    const next = resizeRowDivider(o, edgeIndex, deltaPx);
    return next === o ? o : fitTable(o, next);
  });
}

/** Equalize column widths across `range` (or the whole table). */
export function distributeTableCols(objectId: string, range?: TableRange): void {
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table) return o;
    const next = distributeCols(o, range);
    return next === o ? o : fitTable(o, next);
  });
}

/** Equalize row heights across `range` (or the whole table). */
export function distributeTableRows(objectId: string, range?: TableRange): void {
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table) return o;
    const next = distributeRows(o, range);
    return next === o ? o : fitTable(o, next);
  });
}

/** Reorder row `from` to index `to` and keep the moved row selected. */
export function moveTableRow(objectId: string, from: number, to: number): boolean {
  let moved = false;
  let nextRange: TableRange | undefined;
  let anchor: number | undefined;
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table || !canMoveRow(o.table, from, to)) return o;
    const next = moveRow(o, from, to);
    if (next === o || !next.table) return o;
    moved = true;
    const p = placeCells(next.table);
    nextRange = { r0: to, c0: 0, r1: to, c1: p.C - 1 };
    const k = p.slots[to * p.C];
    anchor = k !== undefined && k >= 0 ? k : 0;
    return next;
  });
  if (moved && nextRange && anchor !== undefined) selectCellRange(objectId, anchor, nextRange);
  return moved;
}

/** Reorder column `from` to index `to` and keep the moved column selected. */
export function moveTableCol(objectId: string, from: number, to: number): boolean {
  let moved = false;
  let nextRange: TableRange | undefined;
  let anchor: number | undefined;
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table || !canMoveCol(o.table, from, to)) return o;
    const next = moveCol(o, from, to);
    if (next === o || !next.table) return o;
    moved = true;
    const p = placeCells(next.table);
    nextRange = { r0: 0, c0: to, r1: p.R - 1, c1: to };
    const k = p.slots[to];
    anchor = k !== undefined && k >= 0 ? k : 0;
    return next;
  });
  if (moved && nextRange && anchor !== undefined) selectCellRange(objectId, anchor, nextRange);
  return moved;
}

/** Toggle starter header row styling on row 0. */
export function setTableHeaderRow(objectId: string, on: boolean): void {
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table) return o;
    const next = toggleHeaderRow(o, on);
    return next === o ? o : fitTable(o, next);
  });
}

/** Toggle starter alternating row bands across body rows. */
export function setTableBandedRows(objectId: string, on: boolean): void {
  onObject(objectId, (o) => (o.type === 'shape' && o.table ? toggleBandedRows(o, on) : o));
}

/**
 * Paste tabular clipboard data (TSV or HTML `<table>`) into table `objectId` starting at `cell`,
 * auto-growing rows/columns as needed in a single undo step and surfacing a toast. Returns true if pasted.
 */
export function pasteTableFromClipboard(
  objectId: string,
  cell: number | undefined,
  html: string,
  plain: string,
): boolean {
  const matrix = parseTableClipboard(html, plain);
  if (!matrix) return false;
  const startCell = cell ?? 0;
  let pastedRange: TableRange | undefined;
  let rowsAdded = 0;
  let colsAdded = 0;
  let anchorCell: number | undefined;
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table) return o;
    const res = pasteMatrixIntoTable(o, startCell, matrix);
    if (!res) return o;
    pastedRange = res.range;
    rowsAdded = res.rowsAdded;
    colsAdded = res.colsAdded;
    const p = placeCells(res.object.table!);
    const k = p.slots[res.range.r0 * p.C + res.range.c0];
    anchorCell = k !== undefined && k >= 0 ? k : startCell;
    return fitTable(o, res.object);
  });
  if (!pastedRange || anchorCell === undefined) return false;
  selectCellRange(objectId, anchorCell, pastedRange);
  const rCount = matrix.length;
  const cCount = Math.max(...matrix.map((r) => r.length));
  const extra: string[] = [];
  if (rowsAdded > 0) extra.push(`${rowsAdded} ${rowsAdded === 1 ? 'row' : 'rows'} added`);
  if (colsAdded > 0) extra.push(`${colsAdded} ${colsAdded === 1 ? 'column' : 'columns'} added`);
  const suffix = extra.length ? ` · ${extra.join(', ')}` : '';
  toast(`Pasted ${rCount}×${cCount} from clipboard${suffix}`, 'ok');
  return true;
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
 * edge. Left and right are as drawn: a right-to-left table draws its first column on the right, so there
 * 'Column left' adds the column after the cell's last one. One undo step (`insertRow`, `deleteRow`,
 * `insertCol`, `deleteCol`: a new line copies the look of the one beside it). The cell to select afterwards
 * (the same cell where it moved, its neighbour when its line was deleted), or undefined when nothing changed
 * or no cell was selected.
 */
export function rowCol(objectId: string, drawnOp: RowColOp, cell?: number): number | undefined {
  const o = currentSlide()?.objects.find((x) => x.id === objectId);
  if (o?.type !== 'shape' || !o.table || o.locked || !canRowCol(o.table, drawnOp, cell)) return undefined;
  const op: RowColOp = !o.table.rtl
    ? drawnOp
    : drawnOp === 'colLeft'
      ? 'colRight'
      : drawnOp === 'colRight'
        ? 'colLeft'
        : drawnOp;
  const { R, C, anchors } = placeCells(o.table);
  const a = cell === undefined ? undefined : anchors[cell];
  let next: number | undefined;
  onObject(objectId, (x) => {
    if (x.type !== 'shape' || !x.table) return x;
    let y = x;
    let at: { row: number; col: number } | undefined = a && { row: a.row, col: a.col };
    // The line added or deleted, for the cells' places across it (tableFit.ts `cellsByPlace`).
    let line: [axis: 'row' | 'col', at: number, added: boolean] = ['row', 0, true];
    if (op === 'rowAbove') {
      line = ['row', a ? a.row : 0, true];
      y = a ? insertRow(x, a.row, a.row) : insertRow(x, 0, 0);
      if (at) at.row++;
    } else if (op === 'rowBelow') {
      line = ['row', a ? a.row + a.rows : R, true];
      y = a ? insertRow(x, a.row + a.rows, a.row + a.rows - 1) : insertRow(x, R, R - 1);
    } else if (op === 'colLeft') {
      line = ['col', a ? a.col : 0, true];
      y = a ? insertCol(x, a.col, a.col) : insertCol(x, 0, 0);
      if (at) at.col++;
    } else if (op === 'colRight') {
      line = ['col', a ? a.col + a.cols : C, true];
      y = a ? insertCol(x, a.col + a.cols, a.col + a.cols - 1) : insertCol(x, C, C - 1);
    } else if (op === 'deleteRow' && a) {
      line = ['row', a.row, false];
      y = deleteRow(x, a.row);
      at = { row: Math.min(a.row, R - 2), col: a.col };
    } else if (op === 'deleteCol' && a) {
      line = ['col', a.col, false];
      y = deleteCol(x, a.col);
      at = { row: a.row, col: Math.min(a.col, C - 2) };
    }
    if (y === x || !y.table) return x;
    if (at) {
      const p = placeCells(y.table);
      const k = p.slots[at.row * p.C + at.col];
      next = k !== undefined && k >= 0 ? k : undefined;
    }
    // Columns rescaled to the table's width (keepWidth) wrap text more, and a merged cell over a deleted row
    // loses that row: a fixed-row table's rows grow by what its text falls short more (tableFit.ts), each
    // cell paired with itself by its place.
    return fitTable(x, y, cellsByPlace(x.table, y.table, ...line));
  });
  return next;
}

// ---- Rich clipboard (text, table cells, slide objects & slides) -------------------------------------

type ClipKind = 'text' | 'object' | 'slide' | 'cells';

let lastClipKind: ClipKind | null = null;
let lastRichTextClip: { slice: RichTextSlice; plain: string } | null = null;
let lastObjectClip: {
  objects: SlideObject[];
  sourceSlideId?: string;
  lastSlideId?: string;
  pasteCount: number;
  plain: string;
  html: string;
  wroteSystem: boolean;
  externalPossible: boolean;
} | null = null;
let lastSlideClip: {
  slides: Slide[];
  sourcePresentationId?: string;
  plain: string;
  html: string;
  wroteSystem: boolean;
  externalPossible: boolean;
} | null = null;
let lastTableCellClip: {
  plain: string;
  html: string;
  rows: number;
  cols: number;
  wroteSystem: boolean;
  externalPossible: boolean;
} | null = null;

/**
 * Mark in-memory clips that were not written to the OS clipboard as potentially superseded by an
 * external copy when the user leaves the editor window (`window` `blur`).
 */
export function markExternalClipboard(): void {
  if (lastObjectClip && !lastObjectClip.wroteSystem) lastObjectClip.externalPossible = true;
  if (lastSlideClip && !lastSlideClip.wroteSystem) lastSlideClip.externalPossible = true;
  if (lastTableCellClip && !lastTableCellClip.wroteSystem) lastTableCellClip.externalPossible = true;
}

let plainPasteUntil = 0;

/** Arm plain-text paste (`Ctrl/Cmd+Shift+V`) for the immediately following `paste` event. */
export function armPlainPaste(): void {
  plainPasteUntil = Date.now() + 500;
}

/** Whether plain-text paste was just armed by `Ctrl/Cmd+Shift+V`; consumes the flag. */
export function consumePlainPaste(): boolean {
  if (!plainPasteUntil) return false;
  const active = Date.now() <= plainPasteUntil;
  plainPasteUntil = 0;
  return active;
}

/**
 * Write `html` + `plain` into `clipboardData` when available, or attempt an async `navigator.clipboard`
 * write (so copies from `keydown` / UI buttons reach the system clipboard even when browsers like Safari
 * suppress `copy` events on collapsed selections). Returns `true` if `clipboardData` was written synchronously.
 */
function writeClipboard(
  html: string,
  plain: string,
  clipboardData?: DataTransfer | null,
  onAsyncWritten?: () => void,
): boolean {
  if (clipboardData) {
    try {
      clipboardData.setData('text/plain', plain);
      clipboardData.setData('text/html', html);
      return true;
    } catch {
      // Ignore synthetic DataTransfer restrictions in tests.
    }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    if (typeof navigator.clipboard.write === 'function' && typeof ClipboardItem !== 'undefined') {
      try {
        const item = new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        });
        void navigator.clipboard.write([item]).then(
          () => onAsyncWritten?.(),
          () => {
            void navigator.clipboard?.writeText?.(plain).catch(() => {});
          },
        );
      } catch {
        // Ignore insecure-context or browser restrictions.
      }
    } else if (typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard.writeText(plain).catch(() => {});
    }
  }
  return false;
}

/**
 * Read HTML, plain text, and any image file from the system clipboard via the async Clipboard API
 * (used by UI Paste buttons and context menus where no `ClipboardEvent` exists). Returns `null` when
 * the API is unavailable or permission is denied.
 */
export async function readSystemClipboard(): Promise<{
  html: string;
  plain: string;
  imageFile: File | null;
} | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return null;
  if (typeof navigator.clipboard.read === 'function') {
    try {
      const items = await navigator.clipboard.read();
      let html = '';
      let plain = '';
      let imageFile: File | null = null;
      for (const item of items) {
        const imgType = item.types.find((t) => t.startsWith('image/'));
        if (imgType && !imageFile) {
          const blob = await item.getType(imgType);
          const ext = imgType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
          imageFile = new File([blob], `pasted-${Date.now()}.${ext}`, { type: imgType });
        }
        if (item.types.includes('text/html') && !html) {
          html = await (await item.getType('text/html')).text();
        }
        if (item.types.includes('text/plain') && !plain) {
          plain = await (await item.getType('text/plain')).text();
        }
      }
      return { html, plain, imageFile };
    } catch {
      // Fall through to readText.
    }
  }
  if (typeof navigator.clipboard.readText === 'function') {
    try {
      const plain = await navigator.clipboard.readText();
      return { html: '', plain, imageFile: null };
    } catch {
      return null;
    }
  }
  return null;
}

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
  lastClipKind = 'text';
  lastRichTextClip = { slice, plain: slice.text };
  lastObjectClip = null;
  lastSlideClip = null;
  lastTableCellClip = null;
  writeClipboard(richTextToHtml(slice, o.style), slice.text, clipboardData);
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
 * pasted. When `plainOnly` is true (`Ctrl/Cmd+Shift+V`), formatting is stripped so text inherits the target style.
 */
export function handleTextPaste(
  o: TextObject,
  start: number,
  end: number,
  clipboardData?: DataTransfer | null,
  target: TextTargetArg = o.id,
  plainOnly = false,
): number | null {
  const html = clipboardData?.getData('text/html') ?? '';
  const plain = clipboardData?.getData('text/plain') ?? '';
  if (plainOnly) {
    const text = plain || (lastClipKind === 'text' ? lastRichTextClip?.plain : '') || '';
    if (text) return pasteRichSelection(target, start, end, { text });
    return null;
  }
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

export type ClipboardReadable = Pick<DataTransfer, 'getData'>;

/** Copy the selected slide objects to the clipboard (in-memory + system `text/html`). */
export function copySelection(clipboardData?: DataTransfer | null): boolean {
  const objs = currentObjects();
  const slideId = openSlide();
  if (!objs.length || !slideId) return false;
  const { html, text } = serializeObjectsToHtml(objs, slideId);
  const clip = {
    objects: structuredClone(objs) as SlideObject[],
    sourceSlideId: slideId,
    lastSlideId: slideId,
    pasteCount: 0,
    plain: text,
    html,
    wroteSystem: false,
    externalPossible: false,
  };
  lastClipKind = 'object';
  lastObjectClip = clip;
  lastRichTextClip = null;
  lastSlideClip = null;
  lastTableCellClip = null;
  clip.wroteSystem = writeClipboard(html, text, clipboardData, () => {
    if (lastObjectClip === clip) clip.wroteSystem = true;
  });
  return true;
}

/** Write the most recently copied/cut slide objects into `clipboardData` (used when `cut` fires after `keydown`). */
export function writeLastObjectClip(clipboardData?: DataTransfer | null): boolean {
  if (lastClipKind !== 'object' || !lastObjectClip || !clipboardData) return false;
  try {
    clipboardData.setData('text/plain', lastObjectClip.plain);
    clipboardData.setData('text/html', lastObjectClip.html);
    lastObjectClip.wroteSystem = true;
    lastObjectClip.externalPossible = false;
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
export function tryPasteObjectsFromClipboard(
  clipboardData?: ClipboardReadable | null,
): Promise<string[]> | null {
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
    // Don't shadow an explicit Ordo slide or rich-text payload on the system clipboard.
    if (html.includes('data-ordo-slides') || html.includes('data-ordo-rich')) return null;
  }
  const canUseMemory =
    lastClipKind === 'object' &&
    lastObjectClip &&
    ((!plain && !html) ||
      (plain === lastObjectClip.plain && !html) ||
      (!lastObjectClip.wroteSystem && !lastObjectClip.externalPossible));
  if (canUseMemory && lastObjectClip) {
    const count = nextCount(lastObjectClip.sourceSlideId);
    return Promise.resolve(pasteCopiedObjects(lastObjectClip.objects, lastObjectClip.sourceSlideId, count));
  }
  return null;
}

// ---- Table cell / range clipboard -------------------------------------------------------------------

/**
 * Copy the currently selected table cell or cell range (outside inline editing) as TSV + HTML `<table>`.
 * Returns `false` if no table cell/range is selected.
 */
export function copyTableCellSelection(clipboardData?: DataTransfer | null): boolean {
  const st = useEditor.getState();
  const selObj = currentObjects().length === 1 ? currentObjects()[0] : undefined;
  if (selObj?.type !== 'shape' || !selObj.table) return false;
  if (st.cell === undefined && !st.cellRange) return false;
  const ser = serializeTableCellsToClipboard(selObj, st.cell, st.cellRange);
  if (!ser) return false;
  const clip = {
    plain: ser.text,
    html: ser.html,
    rows: ser.rows,
    cols: ser.cols,
    wroteSystem: false,
    externalPossible: false,
  };
  lastClipKind = 'cells';
  lastTableCellClip = clip;
  lastObjectClip = null;
  lastSlideClip = null;
  lastRichTextClip = null;
  clip.wroteSystem = writeClipboard(ser.html, ser.text, clipboardData, () => {
    if (lastTableCellClip === clip) clip.wroteSystem = true;
  });
  return true;
}

/** Write the most recently copied/cut table cells into `clipboardData` when `copy`/`cut` fires after `keydown`. */
export function writeLastTableCellClip(clipboardData?: DataTransfer | null): boolean {
  if (lastClipKind !== 'cells' || !lastTableCellClip || !clipboardData) return false;
  try {
    clipboardData.setData('text/plain', lastTableCellClip.plain);
    clipboardData.setData('text/html', lastTableCellClip.html);
    lastTableCellClip.wroteSystem = true;
    lastTableCellClip.externalPossible = false;
    return true;
  } catch {
    return false;
  }
}

/** Cut the currently selected table cell or cell range (copy + clear text in one undo step). */
export function cutTableCellSelection(clipboardData?: DataTransfer | null): boolean {
  const st = useEditor.getState();
  const selObj = currentObjects().length === 1 ? currentObjects()[0] : undefined;
  if (selObj?.type !== 'shape' || !selObj.table || selObj.locked) return false;
  if (!copyTableCellSelection(clipboardData)) return false;
  onObject(selObj.id, (o) =>
    o.type === 'shape' && o.table ? fitTable(o, clearTableCells(o, st.cell, st.cellRange)) : o,
  );
  return true;
}

/**
 * Paste clipboard content into a selected table cell or cell range (outside inline editing):
 * - Multi-cell TSV/HTML pastes via `pasteTableFromClipboard`.
 * - Single-cell text (or in-memory copied table cell) pastes directly into the selected cell(s) instead of
 *   creating a stray TextObject on top of the table.
 */
export function pasteIntoSelectedTableCell(
  objectId: string,
  cell: number | undefined,
  cellRange: TableRange | undefined,
  clipboardData?: ClipboardReadable | null,
  plainOnly = false,
): boolean {
  let html = clipboardData?.getData('text/html') ?? '';
  let plain = clipboardData?.getData('text/plain') ?? '';
  if (
    lastClipKind === 'cells' &&
    lastTableCellClip &&
    ((!plain && !html) || (!lastTableCellClip.wroteSystem && !lastTableCellClip.externalPossible))
  ) {
    html = lastTableCellClip.html;
    plain = lastTableCellClip.plain;
  }
  if (html && (html.includes('data-ordo-objects') || html.includes('data-ordo-slides'))) return false;
  if (pasteTableFromClipboard(objectId, cell, plainOnly ? '' : html, plain)) return true;
  if (cell === undefined && !cellRange) return false;
  const st = useEditor.getState();
  const slide = st.draft && st.slideId ? getSlide(st.draft, st.slideId) : undefined;
  const tbl = slide?.objects.find((x) => x.id === objectId);
  if (tbl?.type !== 'shape' || !tbl.table || tbl.locked) return false;
  const baseView = cell !== undefined ? cellTextObject(tbl, cell) : undefined;
  const slice = plainOnly
    ? plain
      ? { text: plain }
      : null
    : (html && htmlToRichText(html, baseView?.style)) || (plain ? { text: plain } : null);
  if (!slice?.text) return false;
  const targets = targetCellIndices(tbl.table, cell, cellRange);
  if (!targets.length) return false;
  onObject(objectId, (o) => {
    if (o.type !== 'shape' || !o.table) return o;
    let cur: SlideObject = o;
    for (const idx of targets) {
      cur = editCell(cur, idx, (v) => pasteRichText(v, 0, v.text.length, slice).object);
    }
    return fitTable(o, cur);
  });
  return true;
}

// ---- Slide clipboard --------------------------------------------------------------------------------

/** Copy the active slide (or `slideId`) to the clipboard (in-memory + system `data-ordo-slides`). */
export function copySlideSelection(clipboardData?: DataTransfer | null, slideId?: string): boolean {
  const st = useEditor.getState();
  const id = slideId ?? openSlide();
  const slide = st.draft && id ? getSlide(st.draft, id) : undefined;
  if (!slide || !st.draft) return false;
  const { html, text } = serializeSlidesToHtml([slide], st.draft.id);
  const clip = {
    slides: [structuredClone(slide) as Slide],
    sourcePresentationId: st.draft.id,
    plain: text,
    html,
    wroteSystem: false,
    externalPossible: false,
  };
  lastClipKind = 'slide';
  lastSlideClip = clip;
  lastObjectClip = null;
  lastRichTextClip = null;
  lastTableCellClip = null;
  clip.wroteSystem = writeClipboard(html, text, clipboardData, () => {
    if (lastSlideClip === clip) clip.wroteSystem = true;
  });
  return true;
}

/** Write the most recently copied/cut slide into `clipboardData` (used when `cut` fires after `keydown`). */
export function writeLastSlideClip(clipboardData?: DataTransfer | null): boolean {
  if (lastClipKind !== 'slide' || !lastSlideClip || !clipboardData) return false;
  try {
    clipboardData.setData('text/plain', lastSlideClip.plain);
    clipboardData.setData('text/html', lastSlideClip.html);
    lastSlideClip.wroteSystem = true;
    lastSlideClip.externalPossible = false;
    return true;
  } catch {
    return false;
  }
}

/** Cut the active slide (or `slideId`): copies it and removes it unless it is the only slide in the deck. */
export function cutSlideSelection(clipboardData?: DataTransfer | null, slideId?: string): boolean {
  const st = useEditor.getState();
  const id = slideId ?? openSlide();
  if (!st.draft || !id) return false;
  const allSlides = st.draft.sections.flatMap((sec) => sec.slides);
  if (allSlides.length <= 1) {
    toast('Cannot cut the only slide in the presentation.', 'warn');
    return false;
  }
  if (!copySlideSelection(clipboardData, id)) return false;
  const idx = allSlides.findIndex((s) => s.id === id);
  const nextSlide = allSlides[idx + 1] ?? allSlides[idx - 1];
  change((p) => deleteSlide(p, id));
  if (nextSlide) selectSlide(nextSlide.id);
  return true;
}

/** Whether there are copied slides available in memory. */
export function hasCopiedSlides(): boolean {
  return !!lastSlideClip && lastSlideClip.slides.length > 0;
}

/** Paste `slides` into the open presentation after `afterSlideId`, selecting the first pasted slide. */
export function pasteCopiedSlides(slides?: readonly Slide[], afterSlideId?: string): string[] {
  const st = useEditor.getState();
  if (!st.draft) return [];
  const srcSlides = slides ?? lastSlideClip?.slides;
  if (!srcSlides?.length) return [];
  const targetAfter = afterSlideId ?? openSlide();
  let ids: string[] = [];
  let full = false;
  change((p) => {
    const r = pasteSlides(p, targetAfter, srcSlides);
    ids = r.ids;
    full = !!r.full;
    return r.p;
  });
  if (ids.length) {
    selectSlide(ids[0]);
  } else if (full) {
    toast(`A section holds at most ${MAX_SECTION_SLIDES} slides: the paste was not made.`, 'warn');
  }
  return ids;
}

/**
 * Check `clipboardData` (or the in-memory slide clipboard) for copied Ordo slides and paste them after
 * the active slide. Null when the clipboard holds no slides.
 */
export function tryPasteSlidesFromClipboard(
  clipboardData?: ClipboardReadable | null,
  afterSlideId?: string,
): Promise<string[]> | null {
  const html = clipboardData?.getData('text/html') ?? '';
  const plain = clipboardData?.getData('text/plain') ?? '';
  if (html) {
    const parsed = parseSlidesFromHtml(html);
    if (parsed) {
      return loadObjectSanitizer().then(
        (sanitize) => {
          const clean = parseSlidesFromHtml(html, sanitize);
          if (clean?.leftObjects) {
            toast(leftOutText(clean.leftObjects, 1), 'warn', 8000);
          }
          if (!clean?.slides.length) {
            toast('The pasted slides could not be read: nothing was added.', 'warn', 8000);
            return [];
          }
          return pasteCopiedSlides(clean.slides, afterSlideId);
        },
        () => {
          toast('The pasted slides could not be read: nothing was added.', 'warn', 8000);
          return [];
        },
      );
    }
    if (html.includes('data-ordo-objects') || html.includes('data-ordo-rich')) return null;
  }
  const canUseMemory =
    lastClipKind === 'slide' &&
    lastSlideClip &&
    ((!plain && !html) ||
      (plain === lastSlideClip.plain && !html) ||
      (!lastSlideClip.wroteSystem && !lastSlideClip.externalPossible));
  if (canUseMemory && lastSlideClip) {
    return Promise.resolve(pasteCopiedSlides(lastSlideClip.slides, afterSlideId));
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
