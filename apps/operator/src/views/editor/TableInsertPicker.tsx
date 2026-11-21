import type { ShapeObject, Theme } from '@ordo/domain';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePopupOf } from '../../components/popupOf.ts';
import { toast } from '../../state/toasts.ts';
import { newTable, parseTableClipboard } from './ops/table.ts';

const GRID_COLS = 8;
const GRID_ROWS = 6;
const POPOVER_W = 244;
const VIEWPORT_PAD = 10;

export function TableInsertPicker({
  theme,
  disabled,
  onInsert,
}: {
  theme: Theme;
  disabled: boolean;
  onInsert: (table: ShapeObject) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 4, c: 4 });
  const [headerRow, setHeaderRow] = useState(true);
  const [bandedRows, setBandedRows] = useState(true);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  usePopupOf(popRef, btnRef.current, open, () => setOpen(false));

  useLayoutEffect(() => {
    if (!open || !btnRef.current || typeof window === 'undefined') return;
    const place = () => {
      const r = btnRef.current!.getBoundingClientRect();
      const left = Math.max(VIEWPORT_PAD, Math.min(r.left, window.innerWidth - POPOVER_W - VIEWPORT_PAD));
      const top = Math.min(r.bottom + 6, window.innerHeight - 280);
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const commit = (rows: number, cols: number) => {
    onInsert(newTable(theme, { rows, cols, headerRow, bandedRows }));
    setOpen(false);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const matrix = parseTableClipboard('', text);
      if (!matrix) {
        toast('Copy a range from Sheets, Excel, or tab-separated text first.', 'warn');
        return;
      }
      onInsert(newTable(theme, { cells: matrix, headerRow, bandedRows }));
      setOpen(false);
      toast(
        `Inserted ${matrix.length}×${Math.max(...matrix.map((r) => r.length))} table from clipboard`,
        'ok',
      );
    } catch {
      toast('Clipboard access blocked — paste directly onto the slide or a table cell with Ctrl+V.', 'warn');
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`small ghost${open ? ' on' : ''}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Insert a table"
        onClick={() => setOpen((v) => !v)}
      >
        + Table
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popRef}
            className="tbl-insert-pop"
            role="dialog"
            aria-label="Insert table"
            style={{ top: pos.top, left: pos.left, width: POPOVER_W }}
          >
            <div className="tbl-pop-head">
              <span className="tbl-pop-title">Insert Table</span>
              <span className="tbl-dim-badge" aria-live="polite">
                {hover.c} × {hover.r}
              </span>
            </div>
            <div
              className="tbl-grid-picker"
              role="grid"
              aria-label="Table size picker"
              onMouseLeave={() => setHover({ r: 4, c: 4 })}
            >
              {Array.from({ length: GRID_ROWS }, (_, rIdx) => {
                const r = rIdx + 1;
                return (
                  <div key={r} role="row" className="tbl-grid-row">
                    {Array.from({ length: GRID_COLS }, (_, cIdx) => {
                      const c = cIdx + 1;
                      const active = r <= hover.r && c <= hover.c;
                      return (
                        <button
                          key={c}
                          type="button"
                          role="gridcell"
                          className={`tbl-grid-cell${active ? ' active' : ''}`}
                          aria-label={`${c} by ${r} table`}
                          onMouseEnter={() => setHover({ r, c })}
                          onFocus={() => setHover({ r, c })}
                          onClick={() => commit(r, c)}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="tbl-pop-options">
              <label className="tbl-check-row">
                <input type="checkbox" checked={headerRow} onChange={(e) => setHeaderRow(e.target.checked)} />
                <span>Header row</span>
              </label>
              <label className="tbl-check-row">
                <input
                  type="checkbox"
                  checked={bandedRows}
                  onChange={(e) => setBandedRows(e.target.checked)}
                />
                <span>Alternating row bands</span>
              </label>
            </div>
            <div className="tbl-pop-footer">
              <button
                type="button"
                className="small ghost tbl-paste-btn"
                onClick={() => void pasteFromClipboard()}
              >
                Paste TSV / Sheets…
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
