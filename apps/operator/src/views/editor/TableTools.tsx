import { cellTextObject, placeCells, type ShapeObject, type TextStyle } from '@ordo/domain';
import { ColorPill, PaintPill, type PaintValue } from '../../components/ColorPicker.tsx';
import { NumberField, Select } from '../../components/fields.tsx';
import { FontPicker } from '../../components/FontPicker.tsx';
import { Menu } from '../../components/Menu.tsx';
import {
  canRowCol,
  copyTextSelection,
  cutTextSelection,
  fillCells,
  formatSelection,
  handleTextPaste,
  ROW_COL_OPS,
  type RowColOp,
  rowCol,
  setCellStyle,
  typeText,
} from './actions.ts';
import { composing, historyKey } from './editorKeys.ts';
import { redo, selectCell, setTextRange, type TextTarget, undo, useEditor } from './editorStore.ts';
import { barState, shortcutOf, togglePatch } from './FormatBar.tsx';
import { restoreFieldSelection } from './fieldSelection.ts';
import type { ObjectBarContext } from './objectBars.ts';
import type { ObjectSectionContext } from './objectSections.ts';
import { selectionStyle } from './ops/text.ts';
import { TextFloatingControls } from './TextControls.tsx';

/*
 * A table's tools (design/15 "Table editing"): the floating bar's table bar (registered in objectBars.ts) and
 * the Object panel's Table section (in objectSections.ts, in place of the shape section): the selected cell's
 * text format, 'Cell fill' (solid or none; the whole table's cells with no cell selected) and 'Rows & columns'
 * (Row above, Row below, Column left, Column right, Delete row, Delete column; disabled past `TABLE_LIMITS`, at
 * the last row or column, and for a delete with no cell selected). A cell has no uppercase, contrast or
 * shrink-to-fit (a cell style holds none of them). Not here: merging and splitting cells, borders, column
 * widths, table styles (tables-object.md §4.6).
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

/** The fill a cell shows in the pill: its fill's colour (a gradient fill by its colour), else none. */
function cellPaint(o: Table, cell: number | undefined): PaintValue {
  const t = o.table;
  const k = t.cells[cell ?? 0]?.fill;
  const f = k === undefined ? undefined : t.fills?.[k];
  return f ? { kind: 'solid', color: f.color } : { kind: 'none' };
}

/** 'Cell fill': the selected cell's, or with none selected every cell's. */
function CellFill({ o, cell, off, compact }: { o: Table; cell?: number; off: boolean; compact?: boolean }) {
  return (
    <PaintPill
      value={cellPaint(o, cell)}
      modes={['none', 'solid']}
      disabled={off}
      compact={compact}
      ariaLabel="Cell fill"
      onChange={(next) => fillCells(o.id, cell, next.kind === 'solid' ? next.color : null)}
    />
  );
}

/** One 'Rows & columns' op, then the cell it leaves selected. */
function runRowCol(o: Table, op: RowColOp, cell: number | undefined): void {
  const next = rowCol(o.id, op, cell);
  if (next !== undefined) selectCell(o.id, next);
}

/** The floating bar of a table: the cell's text format (with a cell selected), Cell fill, Rows & columns. */
export function TableBar({ o, off, range, tailActions }: ObjectBarContext) {
  const cell = useCell(o);
  if (!isTable(o)) return null;
  const tools = (
    <>
      <CellFill o={o} cell={cell} off={off} compact />
      <Menu
        label="Rows & columns"
        disabled={off}
        items={ROW_COL_OPS.map(([op, label]) => ({
          label,
          disabled: !canRowCol(o.table, op, cell),
          onSelect: () => runRowCol(o, op, cell),
        }))}
      />
    </>
  );
  const view = cell === undefined ? undefined : cellTextObject(o, cell);
  if (view && cell !== undefined) {
    const target: TextTarget = { objectId: o.id, cell };
    return (
      <TextFloatingControls
        o={view}
        range={range}
        off={off}
        cell
        target={target}
        setStyle={(fn, key) => setCellStyle(target, fn, key)}
        lead={<span className="ed-scope-pill">{cellLabel(o, cell)}</span>}
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
      <span className="ed-scope-pill">Table</span>
      {tools}
      {tailActions}
    </div>
  );
}

/** A control a finger can press (design/15 "Touch": 44 px). */
const TOUCH = { minWidth: 44 } as const;

/**
 * The Object panel's Table section (in place of the shape section): the selected cell's text (the field the
 * canvas's inline editing types through while the panel is open, `#ordo-text-editor`) and its box format
 * (font, size, bold, italic, colour, alignment), Cell fill, and Rows & columns as buttons.
 */
export function TableSection({ o, readOnly }: ObjectSectionContext) {
  const cell = useCell(o);
  const range = useEditor((s) => s.textRange);
  if (!isTable(o)) return null;
  const view = cell === undefined ? undefined : cellTextObject(o, cell);
  const target: TextTarget | undefined = cell === undefined ? undefined : { objectId: o.id, cell };
  const setBox = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => {
    if (target && !readOnly) setCellStyle(target, (s) => ({ ...s, [k]: v }), String(k));
  };
  const s = view?.style;
  return (
    <fieldset
      className="col"
      disabled={readOnly}
      aria-label="Table"
      style={{ border: 0, borderBottom: '1px solid var(--line)', margin: 0, padding: '8px 0 12px', gap: 10 }}
    >
      <h4>Table</h4>
      {view && target && s && cell !== undefined ? (
        <>
          <span className="muted small">{cellLabel(o, cell)}</span>
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
              if (copyTextSelection(view, el.selectionStart, el.selectionEnd, e.clipboardData))
                e.preventDefault();
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
              if (caret === null) return;
              e.preventDefault();
              setTextRange({ start: caret, end: caret, caret });
              restoreFieldSelection({ start: caret, end: caret });
            }}
            onPaste={(e) => {
              if (readOnly) return;
              const el = e.currentTarget;
              const caret = handleTextPaste(
                view,
                el.selectionStart,
                el.selectionEnd,
                e.clipboardData,
                target,
              );
              if (caret === null) return;
              e.preventDefault();
              setTextRange({ start: caret, end: caret, caret });
              restoreFieldSelection({ start: caret, end: caret });
            }}
          />
          <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
            <FontPicker value={s.fontFamily} label="Font" onChange={(f) => setBox('fontFamily', f)} />
            <NumberField
              label="Size"
              value={s.fontSizePx}
              min={8}
              max={300}
              width={64}
              disabled={readOnly}
              onChange={(v) => setBox('fontSizePx', Math.max(8, Math.min(300, v)))}
            />
          </div>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              className={`small${s.fontWeight >= 600 ? ' on' : ''}`}
              style={TOUCH}
              aria-pressed={s.fontWeight >= 600}
              disabled={readOnly}
              onClick={() => setBox('fontWeight', s.fontWeight >= 600 ? 400 : 700)}
            >
              Bold
            </button>
            <button
              type="button"
              className={`small${s.fontStyle === 'italic' ? ' on' : ''}`}
              style={TOUCH}
              aria-pressed={s.fontStyle === 'italic'}
              disabled={readOnly}
              onClick={() => setBox('fontStyle', s.fontStyle === 'italic' ? 'normal' : 'italic')}
            >
              Italic
            </button>
            <ColorPill
              value={s.color}
              disabled={readOnly}
              ariaLabel="Cell text color"
              onChange={(c) => setBox('color', c)}
            />
            <Select
              label="Align"
              value={s.align}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
              ]}
              disabled={readOnly}
              onChange={(a) => setBox('align', a)}
            />
          </div>
          {range.start < range.end && (
            <span className="muted small">
              Ctrl+B, Ctrl+I and Ctrl+U format the selected words; the slide's bar has more.
            </span>
          )}
        </>
      ) : (
        <span className="muted small">Click a cell to edit its text (double-click on the slide).</span>
      )}
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <span className="muted small">Cell fill</span>
        <CellFill o={o} cell={cell} off={readOnly} />
      </div>
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
