import { type Box, placeCells, type ShapeObject, TABLE_LIMITS } from '@ordo/domain';
import type { TableLayout } from '@ordo/renderer/table/layout.ts';
import { useEffect, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { canRowCol, moveTableCol, moveTableRow, resizeTableCol, resizeTableRow, rowCol } from './actions.ts';
import { buildTableRailContextMenu } from './editorContextMenu.ts';
import { selectCellRange } from './editorStore.ts';
import { canMoveCol, canMoveRow, normalizeRange, type TableRange } from './ops/table.ts';

type TableShape = ShapeObject & Required<Pick<ShapeObject, 'table'>>;

type DividerDrag =
  | { axis: 'col'; edge: number; startClient: number; deltaSlide: number; colPx: number; colPct: number }
  | { axis: 'row'; edge: number; startClient: number; deltaSlide: number; rowPx: number };

type ReorderDrag = {
  axis: 'col' | 'row';
  from: number;
  to: number;
  startClient: number;
  moved: boolean;
};

/**
 * Fine-pointer (`!coarse`) canvas-native manipulation rails for a selected table (CUJ 2):
 * - Top column & left row grip rails (`⠿`): click to select entire column/row; drag to reorder.
 * - Right `+` and bottom `+ Add row` outer append pills.
 * - Internal column & row divider drag handles with live `--accent` guide line and dimension badge.
 */
export function TableCanvasOverlay({
  o,
  layout,
  scale,
  cellRange,
  liveBox,
}: {
  o: TableShape;
  layout: TableLayout;
  scale: number;
  cellRange?: TableRange;
  /** Live slide-space box while a Konva drag or Transformer resize is in progress. */
  liveBox?: Box;
}) {
  const [dividerDrag, setDividerDrag] = useState<DividerDrag | null>(null);
  const [reorderDrag, setReorderDrag] = useState<ReorderDrag | null>(null);

  const t = o.table;
  const R = layout.rowY.length - 1;
  const C = layout.colX.length - 1;
  const bx = liveBox?.x ?? o.box.x;
  const by = liveBox?.y ?? o.box.y;
  const bw = liveBox?.w ?? layout.width;
  const bh = liveBox?.h ?? layout.height;
  const scaleX = scale * (layout.width > 0 ? bw / layout.width : 1);
  const scaleY = scale * (layout.height > 0 ? bh / layout.height : 1);

  // Handle active divider drag on window pointermove / pointerup.
  useEffect(() => {
    if (!dividerDrag) return;
    const onMove = (e: PointerEvent) => {
      if (dividerDrag.axis === 'col') {
        const deltaSlide = (e.clientX - dividerDrag.startClient) / scale;
        const x0 = Math.min(layout.colX[dividerDrag.edge - 1]!, layout.colX[dividerDrag.edge]!);
        const x1 = Math.max(layout.colX[dividerDrag.edge - 1]!, layout.colX[dividerDrag.edge]!);
        const origW = x1 - x0;
        const nextW = Math.max(48, origW + (t.rtl ? -deltaSlide : deltaSlide));
        const pct = bw > 0 ? Math.round((nextW / bw) * 100) : 0;
        setDividerDrag((cur) =>
          cur && cur.axis === 'col' ? { ...cur, deltaSlide, colPx: Math.round(nextW), colPct: pct } : cur,
        );
      } else {
        const deltaSlide = (e.clientY - dividerDrag.startClient) / scale;
        const origH = layout.rowY[dividerDrag.edge]! - layout.rowY[dividerDrag.edge - 1]!;
        const nextH = Math.max(32, origH + deltaSlide);
        setDividerDrag((cur) =>
          cur && cur.axis === 'row' ? { ...cur, deltaSlide, rowPx: Math.round(nextH) } : cur,
        );
      }
    };
    const onUp = () => {
      if (dividerDrag.axis === 'col' && Math.abs(dividerDrag.deltaSlide) >= 1) {
        resizeTableCol(o.id, dividerDrag.edge, dividerDrag.deltaSlide);
      } else if (dividerDrag.axis === 'row' && Math.abs(dividerDrag.deltaSlide) >= 1) {
        resizeTableRow(o.id, dividerDrag.edge, dividerDrag.deltaSlide);
      }
      setDividerDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dividerDrag, layout, o.id, scale, bw, t.rtl]);

  // Handle active column/row grip reorder drag on window pointermove / pointerup.
  useEffect(() => {
    if (!reorderDrag) return;
    const onMove = (e: PointerEvent) => {
      const dist =
        reorderDrag.axis === 'col'
          ? Math.abs(e.clientX - reorderDrag.startClient)
          : Math.abs(e.clientY - reorderDrag.startClient);
      if (!reorderDrag.moved && dist < 5) return;
      const stageEl = document.querySelector('.canvasbox canvas');
      const rect = stageEl?.getBoundingClientRect();
      if (!rect) return;
      if (reorderDrag.axis === 'col') {
        const localX = (e.clientX - rect.left) / scale - bx;
        let target = reorderDrag.from;
        for (let c = 0; c < C; c++) {
          const x0 = Math.min(layout.colX[c]!, layout.colX[c + 1]!);
          const x1 = Math.max(layout.colX[c]!, layout.colX[c + 1]!);
          if (localX >= x0 && localX <= x1) {
            target = c;
            break;
          }
        }
        setReorderDrag((cur) => (cur ? { ...cur, moved: true, to: target } : cur));
      } else {
        const localY = (e.clientY - rect.top) / scale - by;
        let target = reorderDrag.from;
        for (let r = 0; r < R; r++) {
          if (localY >= layout.rowY[r]! && localY <= layout.rowY[r + 1]!) {
            target = r;
            break;
          }
        }
        setReorderDrag((cur) => (cur ? { ...cur, moved: true, to: target } : cur));
      }
    };
    const onUp = () => {
      if (reorderDrag.moved && reorderDrag.to !== reorderDrag.from) {
        if (reorderDrag.axis === 'col') moveTableCol(o.id, reorderDrag.from, reorderDrag.to);
        else moveTableRow(o.id, reorderDrag.from, reorderDrag.to);
      } else {
        // Click (no drag): select entire column or row.
        const p = placeCells(t);
        if (reorderDrag.axis === 'col') {
          const range = normalizeRange(t, { r0: 0, c0: reorderDrag.from, r1: p.R - 1, c1: reorderDrag.from });
          const anchor = p.slots[range.r0 * p.C + range.c0] ?? 0;
          selectCellRange(o.id, Math.max(anchor, 0), range);
        } else {
          const range = normalizeRange(t, { r0: reorderDrag.from, c0: 0, r1: reorderDrag.from, c1: p.C - 1 });
          const anchor = p.slots[range.r0 * p.C + range.c0] ?? 0;
          selectCellRange(o.id, Math.max(anchor, 0), range);
        }
      }
      setReorderDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [reorderDrag, layout, o.id, scale, bx, by, C, R, t]);

  if (R <= 0 || C <= 0) return null;

  const canAddRow = canRowCol(t, 'rowBelow', undefined) && R < TABLE_LIMITS.rows;
  const canAddCol = canRowCol(t, 'colRight', undefined) && C < TABLE_LIMITS.cols;

  const leftPx = bx * scale;
  const topPx = by * scale;
  const widthPx = bw * scale;
  const heightPx = bh * scale;
  const colIndices = Array.from({ length: C }, (_, i) => i);
  const rowIndices = Array.from({ length: R }, (_, i) => i);

  return (
    <div
      className="tbl-canvas-overlay"
      style={{ left: leftPx, top: topPx, width: widthPx, height: heightPx }}
      aria-label="Table direct manipulation controls"
    >
      {/* Top column grip rails */}
      {colIndices.map((c) => {
        const x0 = Math.min(layout.colX[c]!, layout.colX[c + 1]!) * scaleX;
        const x1 = Math.max(layout.colX[c]!, layout.colX[c + 1]!) * scaleX;
        const active =
          !!cellRange &&
          cellRange.r0 === 0 &&
          cellRange.r1 === R - 1 &&
          c >= cellRange.c0 &&
          c <= cellRange.c1;
        const canDrag =
          C > 1 && (canMoveCol(t, c, Math.max(0, c - 1)) || canMoveCol(t, c, Math.min(C - 1, c + 1)));
        return (
          <button
            key={`col-${c}`}
            type="button"
            className={`tbl-grip-rail tbl-grip-col${active ? ' active' : ''}`}
            style={{ left: x0 + 2, width: Math.max(12, x1 - x0 - 4) }}
            aria-label={`Select or reorder column ${c + 1}`}
            title={canDrag ? `Click to select column ${c + 1}, drag to reorder` : `Select column ${c + 1}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              setReorderDrag({ axis: 'col', from: c, to: c, startClient: e.clientX, moved: false });
            }}
            onContextMenu={(e) => {
              e.stopPropagation();
              openContextMenu(
                e,
                buildTableRailContextMenu({ o, axis: 'col', index: c, readOnly: !!o.locked }),
                {
                  ariaLabel: `Column ${c + 1} actions`,
                },
              );
            }}
          >
            <span className="tbl-grip-dots" aria-hidden="true">
              ⠿
            </span>
          </button>
        );
      })}

      {/* Left row grip rails */}
      {rowIndices.map((r) => {
        const y0 = layout.rowY[r]! * scaleY;
        const y1 = layout.rowY[r + 1]! * scaleY;
        const active =
          !!cellRange &&
          cellRange.c0 === 0 &&
          cellRange.c1 === C - 1 &&
          r >= cellRange.r0 &&
          r <= cellRange.r1;
        const canDrag =
          R > 1 && (canMoveRow(t, r, Math.max(0, r - 1)) || canMoveRow(t, r, Math.min(R - 1, r + 1)));
        return (
          <button
            key={`row-${r}`}
            type="button"
            className={`tbl-grip-rail tbl-grip-row${active ? ' active' : ''}`}
            style={{ top: y0 + 2, height: Math.max(12, y1 - y0 - 4) }}
            aria-label={`Select or reorder row ${r + 1}`}
            title={canDrag ? `Click to select row ${r + 1}, drag to reorder` : `Select row ${r + 1}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              setReorderDrag({ axis: 'row', from: r, to: r, startClient: e.clientY, moved: false });
            }}
            onContextMenu={(e) => {
              e.stopPropagation();
              openContextMenu(
                e,
                buildTableRailContextMenu({ o, axis: 'row', index: r, readOnly: !!o.locked }),
                {
                  ariaLabel: `Row ${r + 1} actions`,
                },
              );
            }}
          >
            <span className="tbl-grip-dots" aria-hidden="true">
              ⠿
            </span>
          </button>
        );
      })}

      {/* Internal column divider drag handles */}
      {Array.from({ length: Math.max(0, C - 1) }, (_, idx) => {
        const edge = idx + 1;
        const prevW = Math.abs(layout.colX[edge]! - layout.colX[edge - 1]!) * scaleX;
        const nextW = Math.abs(layout.colX[edge + 1]! - layout.colX[edge]!) * scaleX;
        if (Math.min(prevW, nextW) < 16) return null;
        const x = layout.colX[edge]! * scaleX;
        const dragging = dividerDrag?.axis === 'col' && dividerDrag.edge === edge;
        const liveX = dragging ? x + dividerDrag.deltaSlide * scale : x;
        return (
          <div
            key={`cdiv-${edge}`}
            className={`tbl-divider tbl-divider-col${dragging ? ' dragging' : ''}`}
            style={{ left: liveX - 5 }}
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize column ${edge}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              const x0 = Math.min(layout.colX[edge - 1]!, layout.colX[edge]!);
              const x1 = Math.max(layout.colX[edge - 1]!, layout.colX[edge]!);
              const origW = x1 - x0;
              setDividerDrag({
                axis: 'col',
                edge,
                startClient: e.clientX,
                deltaSlide: 0,
                colPx: Math.round(origW),
                colPct: bw > 0 ? Math.round((origW / bw) * 100) : 0,
              });
            }}
          >
            {dragging && (
              <span className="tbl-divider-badge">
                {dividerDrag.colPx}px ({dividerDrag.colPct}%)
              </span>
            )}
          </div>
        );
      })}

      {/* Internal row divider drag handles */}
      {Array.from({ length: Math.max(0, R - 1) }, (_, idx) => {
        const edge = idx + 1;
        const prevH = Math.abs(layout.rowY[edge]! - layout.rowY[edge - 1]!) * scaleY;
        const nextH = Math.abs(layout.rowY[edge + 1]! - layout.rowY[edge]!) * scaleY;
        if (Math.min(prevH, nextH) < 16) return null;
        const y = layout.rowY[edge]! * scaleY;
        const dragging = dividerDrag?.axis === 'row' && dividerDrag.edge === edge;
        const liveY = dragging ? y + dividerDrag.deltaSlide * scale : y;
        return (
          <div
            key={`rdiv-${edge}`}
            className={`tbl-divider tbl-divider-row${dragging ? ' dragging' : ''}`}
            style={{ top: liveY - 5 }}
            role="separator"
            aria-orientation="horizontal"
            aria-label={`Resize row ${edge}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              const origH = layout.rowY[edge]! - layout.rowY[edge - 1]!;
              setDividerDrag({
                axis: 'row',
                edge,
                startClient: e.clientY,
                deltaSlide: 0,
                rowPx: Math.round(origH),
              });
            }}
          >
            {dragging && <span className="tbl-divider-badge">{dividerDrag.rowPx}px</span>}
          </div>
        );
      })}

      {/* Reorder drop indicator line */}
      {reorderDrag?.moved && reorderDrag.to !== reorderDrag.from && (
        <div
          className={`tbl-drop-guide ${reorderDrag.axis === 'col' ? 'col' : 'row'}`}
          style={
            reorderDrag.axis === 'col'
              ? {
                  left:
                    (reorderDrag.to > reorderDrag.from
                      ? Math.max(layout.colX[reorderDrag.to]!, layout.colX[reorderDrag.to + 1]!)
                      : Math.min(layout.colX[reorderDrag.to]!, layout.colX[reorderDrag.to + 1]!)) * scaleX,
                }
              : {
                  top:
                    (reorderDrag.to > reorderDrag.from
                      ? layout.rowY[reorderDrag.to + 1]!
                      : layout.rowY[reorderDrag.to]!) * scaleY,
                }
          }
        />
      )}

      {/* Right outer + append column rail */}
      {canAddCol && (
        <button
          type="button"
          className="tbl-append-col"
          aria-label="Add column"
          title="Add column to right"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            rowCol(o.id, 'colRight', undefined);
          }}
        >
          +
        </button>
      )}

      {/* Bottom outer + Add row rail */}
      {canAddRow && (
        <button
          type="button"
          className="tbl-append-row"
          aria-label="Add row"
          title="Add row below"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            rowCol(o.id, 'rowBelow', undefined);
          }}
        >
          + Add row
        </button>
      )}
    </div>
  );
}
