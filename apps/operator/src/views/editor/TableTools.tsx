import { cellTextObject, placeCells, type ShapeObject, type TableFill } from '@ordo/domain';
import { AlignIcon, VAlignIcon } from '../../components/AlignIcons.tsx';
import { PaintPill, type PaintValue } from '../../components/ColorPicker.tsx';
import { Menu } from '../../components/Menu.tsx';
import { useCoarsePointer } from '../../components/pointer.ts';
import {
  armPlainPaste,
  canRowCol,
  consumePlainPaste,
  copyTextSelection,
  cutTextSelection,
  distributeTableCols,
  distributeTableRows,
  fillCells,
  formatSelection,
  handleTextPaste,
  mergeTableCells,
  pasteTableFromClipboard,
  ROW_COL_OPS,
  type RowColOp,
  rowCol,
  setCellStyle,
  setTableBandedRows,
  setTableHeaderRow,
  splitTableCell,
  typeText,
} from './actions.ts';
import { composing, historyKey } from './editorKeys.ts';
import { redo, selectCell, setTextRange, type TextTarget, undo, useEditor } from './editorStore.ts';
import { barState, shortcutOf, togglePatch } from './FormatBar.tsx';
import { restoreFieldSelection } from './fieldSelection.ts';
import type { ObjectBarContext } from './objectBars.ts';
import type { ObjectSectionContext } from './objectSections.ts';
import {
  canMergeCells,
  canSplitCell,
  hasBandedRows,
  hasHeaderRow,
  rangeScopeLabel,
  type TableRange,
} from './ops/table.ts';
import { selectionStyle } from './ops/text.ts';
import { TableBordersButton } from './TableBordersPopover.tsx';
import { TextFloatingControls } from './TextControls.tsx';

/*
 * A table's tools (design/15 "Table editing"): the floating bar's table bar (registered in objectBars.ts) and
 * the Object panel's Table section (in objectSections.ts, in place of the shape section): the selected cell's
 * (or cell range's) text format, 'Cell fill' (none, solid, linear or radial gradient), 'Borders' matrix,
 * Merge/Split, 'Rows & columns' (with Distribute columns / rows), vertical alignment, cell padding, and
 * starter style toggles (Header row, Alternating row bands).
 */

type Table = ShapeObject & Required<Pick<ShapeObject, 'table'>>;

const isTable = (o: unknown): o is Table =>
  !!o && (o as ShapeObject).type === 'shape' && !!(o as ShapeObject).table;

/** 'Row 2, column 3' of a cell (its first row and column, 1-based), or 'Cell' for one past the grid. */
export function cellLabel(o: Table, cell: number): string {
  const a = placeCells(o.table).anchors[cell];
  return a ? `Row ${a.row + 1}, column ${a.col + 1}` : 'Cell';
}

/** The selected cell of table `o` (undefined: the whole table, or another object is selected). */
function useCell(o: { id: string }): number | undefined {
  return useEditor((s) => (s.objectId === o.id ? s.cell : undefined));
}

/** The selected rectangular cell range of table `o`, if any. */
function useCellRange(o: { id: string }): TableRange | undefined {
  return useEditor((s) => (s.objectId === o.id ? s.cellRange : undefined));
}

/** The fill a cell shows in the pill: solid, gradient, or none. */
function cellPaint(o: Table, cell: number | undefined): PaintValue {
  const t = o.table;
  const k = t.cells[cell ?? 0]?.fill;
  const f = k === undefined ? undefined : t.fills?.[k];
  if (!f) return { kind: 'none' };
  if (f.gradient) return { kind: 'gradient', gradient: f.gradient };
  return { kind: 'solid', color: f.color };
}

function paintToTableFill(next: PaintValue): TableFill | null {
  if (next.kind === 'none') return null;
  if (next.kind === 'gradient') {
    const firstColor = next.gradient.stops[0]?.color ?? { r: 30, g: 58, b: 95, a: 1 };
    return { color: firstColor, gradient: next.gradient };
  }
  return { color: next.color };
}

/** 'Cell fill': the selected cell or range's fill, or with none selected every cell's. */
function CellFill({
  o,
  cell,
  cellRange,
  off,
  compact,
}: {
  o: Table;
  cell?: number;
  cellRange?: TableRange;
  off: boolean;
  compact?: boolean;
}) {
  return (
    <PaintPill
      value={cellPaint(o, cell)}
      modes={['none', 'solid', 'linear', 'radial']}
      disabled={off}
      compact={compact}
      ariaLabel="Cell fill"
      onChange={(next) => fillCells(o.id, cell, paintToTableFill(next), cellRange)}
    />
  );
}

/** One 'Rows & columns' op, then the cell it leaves selected. */
function runRowCol(o: Table, op: RowColOp, cell: number | undefined): void {
  const next = rowCol(o.id, op, cell);
  if (next !== undefined) selectCell(o.id, next);
}

/** The floating bar of a table: cell/range text format, Cell fill, Borders, Merge/Split, Rows & columns. */
export function TableBar({ o, off, range, tailActions }: ObjectBarContext) {
  const cell = useCell(o);
  const cellRange = useCellRange(o);
  if (!isTable(o)) return null;

  const canMerge = canMergeCells(o.table, cellRange);
  const canSplit = !canMerge && canSplitCell(o.table, cell);
  const multiCell = !!cellRange && (cellRange.r1 > cellRange.r0 || cellRange.c1 > cellRange.c0);
  const scopeText = rangeScopeLabel(o.table, cell, cellRange);

  const scopePill = multiCell ? (
    <button
      type="button"
      className="ed-scope-pill selection"
      title="Clear cell range selection"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => selectCell(o.id, undefined)}
    >
      {scopeText} ×
    </button>
  ) : (
    <span className="ed-scope-pill">{scopeText}</span>
  );

  const tools = (
    <>
      <CellFill o={o} cell={cell} cellRange={cellRange} off={off} compact />
      {(cell === undefined || !!cellRange) && (
        <TableBordersButton objectId={o.id} table={o.table} range={cellRange} disabled={off} compact />
      )}
      {canMerge && cellRange && (
        <button
          type="button"
          className="small ghost"
          disabled={off}
          title="Merge selected cells"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => mergeTableCells(o.id, cellRange)}
        >
          Merge
        </button>
      )}
      {canSplit && cell !== undefined && (
        <button
          type="button"
          className="small ghost"
          disabled={off}
          title="Split merged cell"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => splitTableCell(o.id, cell)}
        >
          Split
        </button>
      )}
      <Menu
        label="Rows & columns"
        disabled={off}
        items={[
          ...ROW_COL_OPS.map(([op, label]) => ({
            label,
            disabled: !canRowCol(o.table, op, cell),
            onSelect: () => runRowCol(o, op, cell),
          })),
          {
            label: 'Distribute columns',
            disabled: o.table.cols.length < 2,
            onSelect: () => distributeTableCols(o.id, cellRange),
          },
          {
            label: 'Distribute rows',
            disabled: o.table.rows.length < 2,
            onSelect: () => distributeTableRows(o.id, cellRange),
          },
        ]}
      />
    </>
  );

  const view = cell === undefined ? undefined : cellTextObject(o, cell);
  if (view && cell !== undefined) {
    const target: TextTarget = { objectId: o.id, cell };
    return (
      <TextFloatingControls
        o={view}
        range={multiCell ? { start: 0, end: 0 } : range}
        off={off}
        cell
        target={target}
        setStyle={(fn, key) => setCellStyle(target, fn, key, cellRange)}
        lead={scopePill}
        tailActions={
          <>
            <span className="ed-fbar-sep" />
            {tools}
            {tailActions}
          </>
        }
      />
    );
  }
  return (
    <div className="ed-floating-inner">
      {scopePill}
      {tools}
      {tailActions}
    </div>
  );
}

/** A control a finger can press (design/15 "Touch": 44 px). */
const TOUCH = { minWidth: 44 } as const;

const HORZ_ALIGNS = ['left', 'center', 'right'] as const;
const VERT_ALIGNS = ['top', 'middle', 'bottom'] as const;

/**
 * The Object panel's Table section (in place of the shape section): the selected cell's text (the field the
 * canvas's inline editing types through while the panel is open, `#ordo-text-editor`) and its format,
 * Cell fill (solid + gradient), Borders, Alignment & Padding, Table Options (Header row, Alternating bands),
 * Merge/Split, Distribute, and Rows & columns as buttons.
 */
export function TableSection({ o, readOnly }: ObjectSectionContext) {
  const cell = useCell(o);
  const cellRange = useCellRange(o);
  const range = useEditor((s) => s.textRange);
  // On a tablet a tap selects the cell and a double-tap opens this panel on its text (design/15).
  const coarse = useCoarsePointer();
  if (!isTable(o)) return null;

  const view = cell === undefined ? undefined : cellTextObject(o, cell);
  const sampleView = view ?? cellTextObject(o, 0);
  const target: TextTarget = { objectId: o.id, cell };
  const styleTargetRange: TableRange | undefined =
    cellRange ??
    (cell === undefined
      ? { r0: 0, c0: 0, r1: Math.max(0, o.table.rows.length - 1), c1: Math.max(0, o.table.cols.length - 1) }
      : undefined);

  const curAlign = sampleView?.style.align ?? 'left';
  const curValign = sampleView?.style.valign ?? 'top';
  const curInset = Math.round(sampleView?.style.insets?.l ?? 10);

  const canMerge = canMergeCells(o.table, cellRange);
  const canSplit = canSplitCell(o.table, cell);
  const headerOn = hasHeaderRow(o.table);
  const bandedOn = hasBandedRows(o.table);
  const scopeText = rangeScopeLabel(o.table, cell, cellRange);

  const stepPadding = (delta: number) => {
    const next = Math.max(0, Math.min(48, curInset + delta));
    setCellStyle(
      target,
      (s) => ({ ...s, insets: { l: next, r: next, t: Math.round(next * 0.7), b: Math.round(next * 0.7) } }),
      'insets',
      styleTargetRange,
    );
  };

  return (
    <fieldset
      className="col"
      disabled={readOnly}
      aria-label="Table"
      style={{ border: 0, borderBottom: '1px solid var(--line)', margin: 0, padding: '8px 0 12px', gap: 10 }}
    >
      <h4>Table</h4>
      {view && cell !== undefined ? (
        <>
          <span className="muted small">{scopeText}</span>
          <textarea
            rows={2}
            value={view.text}
            disabled={readOnly}
            id="ordo-text-editor"
            aria-label="Cell text"
            onSelect={(e) => {
              const el = e.currentTarget;
              const caret = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd;
              setTextRange({ start: el.selectionStart, end: el.selectionEnd, caret });
            }}
            onKeyDown={(e) => {
              if (composing(e)) return;
              if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
                armPlainPaste();
                return;
              }
              const step = historyKey(e);
              if (step) {
                e.preventDefault();
                e.stopPropagation();
                if (readOnly) return;
                const el = e.currentTarget;
                const at = { start: el.selectionStart, end: el.selectionEnd };
                (step === 'undo' ? undo : redo)();
                const r = restoreFieldSelection(at);
                if (r) setTextRange(r);
                return;
              }
              const t = shortcutOf(e);
              if (!t) return;
              e.preventDefault();
              const el = e.currentTarget;
              if (readOnly || el.selectionStart === el.selectionEnd) return;
              const st = barState(view, selectionStyle(view, el.selectionStart, el.selectionEnd));
              formatSelection(target, el.selectionStart, el.selectionEnd, togglePatch(t, view, st));
            }}
            onChange={(e) => {
              const caret = e.target.selectionEnd;
              setTextRange({ start: e.target.selectionStart, end: caret, caret });
              if (!readOnly) typeText(target, e.target.value, caret);
            }}
            onCopy={(e) => {
              const el = e.currentTarget;
              if (copyTextSelection(view, el.selectionStart, el.selectionEnd, e.clipboardData)) {
                e.preventDefault();
              }
            }}
            onCut={(e) => {
              if (readOnly) return;
              const el = e.currentTarget;
              const caret = cutTextSelection(
                view,
                el.selectionStart,
                el.selectionEnd,
                e.clipboardData,
                target,
              );
              if (caret !== null) {
                e.preventDefault();
                setTextRange({ start: caret, end: caret, caret });
                restoreFieldSelection({ start: caret, end: caret });
              }
            }}
            onPaste={(e) => {
              if (readOnly) return;
              const plainOnly = consumePlainPaste();
              if (!plainOnly) {
                const html = e.clipboardData?.getData('text/html') ?? '';
                const plain = e.clipboardData?.getData('text/plain') ?? '';
                if (pasteTableFromClipboard(target.objectId, target.cell, html, plain)) {
                  e.preventDefault();
                  return;
                }
              }
              const el = e.currentTarget;
              const caret = handleTextPaste(
                view,
                el.selectionStart,
                el.selectionEnd,
                e.clipboardData,
                target,
                plainOnly,
              );
              if (caret !== null) {
                e.preventDefault();
                setTextRange({ start: caret, end: caret, caret });
                restoreFieldSelection({ start: caret, end: caret });
              }
            }}
          />
          <TextFloatingControls
            o={view}
            range={range}
            off={readOnly}
            cell
            bare
            target={target}
            setStyle={(fn, key) => setCellStyle(target, fn, key, cellRange)}
          />
        </>
      ) : (
        <span className="muted small">
          {coarse
            ? 'Tap a cell, then double-tap to type.'
            : 'Click a cell to edit its text (double-click on the slide).'}
        </span>
      )}

      {/* Cell fill & Borders */}
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <span className="muted small">Cell fill</span>
        <CellFill o={o} cell={cell} cellRange={cellRange} off={readOnly} />
        <TableBordersButton objectId={o.id} table={o.table} range={cellRange} disabled={readOnly} />
      </div>

      {/* Horizontal & Vertical Alignment */}
      <div className="col" style={{ gap: 6 }}>
        <span className="muted small">Alignment &amp; Padding</span>
        <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
          <div className="ed-seg-bar" role="group" aria-label="Horizontal alignment">
            {HORZ_ALIGNS.map((a) => (
              <button
                key={a}
                type="button"
                className={`small${curAlign === a ? ' on' : ' ghost'}`}
                aria-label={`Align ${a}`}
                aria-pressed={curAlign === a}
                style={TOUCH}
                onClick={() =>
                  setCellStyle(
                    target,
                    (s) => {
                      const { justify: _, ...rest } = s;
                      return { ...rest, align: a };
                    },
                    'align',
                    styleTargetRange,
                  )
                }
              >
                <AlignIcon align={a} />
              </button>
            ))}
          </div>
          <div className="ed-seg-bar" role="group" aria-label="Vertical alignment">
            {VERT_ALIGNS.map((v) => (
              <button
                key={v}
                type="button"
                className={`small${curValign === v ? ' on' : ' ghost'}`}
                aria-label={`Vertical align ${v}`}
                aria-pressed={curValign === v}
                style={TOUCH}
                onClick={() => setCellStyle(target, (s) => ({ ...s, valign: v }), 'valign', styleTargetRange)}
              >
                <VAlignIcon valign={v} />
              </button>
            ))}
          </div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span className="muted small">Cell padding</span>
          <div className="stepper-box compact" aria-label="Cell padding">
            <button
              type="button"
              aria-label="Decrease cell padding"
              style={TOUCH}
              onClick={() => stepPadding(-4)}
            >
              −
            </button>
            <span className="mono small" style={{ minWidth: 38, textAlign: 'center', fontWeight: 600 }}>
              {curInset}px
            </span>
            <button
              type="button"
              aria-label="Increase cell padding"
              style={TOUCH}
              onClick={() => stepPadding(4)}
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* Table starter options */}
      <div className="col" style={{ gap: 4 }}>
        <span className="muted small">Table Options</span>
        <label className="tbl-check-row">
          <input
            type="checkbox"
            checked={headerOn}
            onChange={(e) => setTableHeaderRow(o.id, e.target.checked)}
          />
          <span>Header row</span>
        </label>
        <label className="tbl-check-row">
          <input
            type="checkbox"
            checked={bandedOn}
            onChange={(e) => setTableBandedRows(o.id, e.target.checked)}
          />
          <span>Alternating row bands</span>
        </label>
      </div>

      {/* Merge / Split & Distribute */}
      <div className="row wrap" role="group" aria-label="Cell merge and distribution" style={{ gap: 6 }}>
        <button
          type="button"
          className="small"
          style={TOUCH}
          disabled={readOnly || !canMerge}
          onClick={() => cellRange && mergeTableCells(o.id, cellRange)}
        >
          Merge cells
        </button>
        <button
          type="button"
          className="small"
          style={TOUCH}
          disabled={readOnly || !canSplit}
          onClick={() => cell !== undefined && splitTableCell(o.id, cell)}
        >
          Split cell
        </button>
        <button
          type="button"
          className="small"
          style={TOUCH}
          disabled={readOnly || o.table.cols.length < 2}
          onClick={() => distributeTableCols(o.id, cellRange)}
        >
          Distribute cols
        </button>
        <button
          type="button"
          className="small"
          style={TOUCH}
          disabled={readOnly || o.table.rows.length < 2}
          onClick={() => distributeTableRows(o.id, cellRange)}
        >
          Distribute rows
        </button>
      </div>

      {/* Rows & Columns */}
      <div className="row wrap" role="group" aria-label="Rows and columns" style={{ gap: 6 }}>
        {ROW_COL_OPS.map(([op, label]) => (
          <button
            key={op}
            type="button"
            className={`small${op.startsWith('delete') ? ' danger' : ''}`}
            style={TOUCH}
            disabled={readOnly || !canRowCol(o.table, op, cell)}
            onClick={() => runRowCol(o, op, cell)}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
