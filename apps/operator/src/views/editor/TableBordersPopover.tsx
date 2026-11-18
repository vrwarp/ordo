import type { Rgba, TableData, TableLineStyle } from '@ordo/domain';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ColorPill } from '../../components/ColorPicker.tsx';
import { usePopupOf } from '../../components/popupOf.ts';
import { applyTableBorders } from './actions.ts';
import { type BorderTarget, inspectBorders, type TableRange } from './ops/table.ts';

const POPOVER_W = 248;
const VIEWPORT_PAD = 10;

const BORDER_TARGETS: readonly { id: BorderTarget; label: string }[] = [
  { id: 'all', label: 'All borders' },
  { id: 'outer', label: 'Outer borders' },
  { id: 'inner', label: 'Inner borders' },
  { id: 'none', label: 'Clear borders' },
  { id: 'top', label: 'Top border' },
  { id: 'bottom', label: 'Bottom border' },
  { id: 'left', label: 'Left border' },
  { id: 'right', label: 'Right border' },
];

const DASH_MODES: readonly { id: 'solid' | 'dash' | 'dot'; label: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'dash', label: 'Dashed' },
  { id: 'dot', label: 'Dotted' },
];

function BorderIcon({ target }: { target: BorderTarget }) {
  const dim = 'rgba(255,255,255,0.22)';
  const on = 'currentColor';
  const top = target === 'all' || target === 'outer' || target === 'top';
  const bottom = target === 'all' || target === 'outer' || target === 'bottom';
  const left = target === 'all' || target === 'outer' || target === 'left';
  const right = target === 'all' || target === 'outer' || target === 'right';
  const inner = target === 'all' || target === 'inner';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <line x1="2" y1="2.5" x2="14" y2="2.5" stroke={top ? on : dim} strokeWidth={top ? 1.8 : 1} />
      <line x1="2" y1="13.5" x2="14" y2="13.5" stroke={bottom ? on : dim} strokeWidth={bottom ? 1.8 : 1} />
      <line x1="2.5" y1="2" x2="2.5" y2="14" stroke={left ? on : dim} strokeWidth={left ? 1.8 : 1} />
      <line x1="13.5" y1="2" x2="13.5" y2="14" stroke={right ? on : dim} strokeWidth={right ? 1.8 : 1} />
      <line x1="2.5" y1="8" x2="13.5" y2="8" stroke={inner ? on : dim} strokeWidth={inner ? 1.5 : 1} />
      <line x1="8" y1="2.5" x2="8" y2="13.5" stroke={inner ? on : dim} strokeWidth={inner ? 1.5 : 1} />
    </svg>
  );
}

export function TableBordersButton({
  objectId,
  table,
  range,
  disabled,
  compact,
}: {
  objectId: string;
  table: TableData;
  range?: TableRange;
  disabled: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeTarget, setActiveTarget] = useState<BorderTarget>('all');
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const inspected = inspectBorders(table, range);
  const [color, setColor] = useState<Rgba>(inspected.color);
  const [width, setWidth] = useState<number>(inspected.width);
  const [dash, setDash] = useState<'solid' | 'dash' | 'dot'>(
    inspected.dash === 'dash' ? 'dash' : inspected.dash === 'dot' ? 'dot' : 'solid',
  );

  // Sync displayed border properties when opening the popover.
  useEffect(() => {
    if (!open) return;
    const cur = inspectBorders(table, range);
    setColor(cur.color);
    setWidth(cur.width);
    setDash(cur.dash === 'dash' ? 'dash' : cur.dash === 'dot' ? 'dot' : 'solid');
  }, [open, table, range]);

  usePopupOf(popRef, btnRef.current, open, () => setOpen(false));

  useLayoutEffect(() => {
    if (!open || !btnRef.current || typeof window === 'undefined') return;
    const place = () => {
      const r = btnRef.current!.getBoundingClientRect();
      const left = Math.max(VIEWPORT_PAD, Math.min(r.left, window.innerWidth - POPOVER_W - VIEWPORT_PAD));
      const popH = popRef.current?.offsetHeight || 220;
      const spaceBelow = window.innerHeight - r.bottom - VIEWPORT_PAD;
      const top =
        spaceBelow >= popH || spaceBelow >= r.top
          ? Math.min(r.bottom + 6, window.innerHeight - popH - VIEWPORT_PAD)
          : Math.max(VIEWPORT_PAD, r.top - popH - 6);
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
      // Don't close when interacting with the nested ColorPopover portalled to body.
      if (t instanceof Element && t.closest('.color-popover')) return;
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

  const buildStyle = (c: Rgba, w: number, d: 'solid' | 'dash' | 'dot'): TableLineStyle => ({
    color: c,
    width: w,
    ...(d === 'solid' ? {} : { dash: d }),
  });

  const apply = (target: BorderTarget, c = color, w = width, d = dash) => {
    setActiveTarget(target);
    applyTableBorders(objectId, range, target, target === 'none' ? null : buildStyle(c, w, d));
  };

  const stepWidth = (delta: number) => {
    const next = Math.max(0.5, Math.min(8, Math.round((width + delta) * 2) / 2));
    setWidth(next);
    if (activeTarget !== 'none') apply(activeTarget, color, next, dash);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`small ghost${open ? ' on' : ''}`}
        disabled={disabled}
        aria-label="Borders"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Table borders"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <BorderIcon target="all" />
        {!compact && <span>Borders</span>}
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popRef}
            className="tbl-borders-pop"
            role="dialog"
            aria-label="Table borders"
            style={{ top: pos.top, left: pos.left, width: POPOVER_W }}
          >
            <div className="tbl-pop-head">
              <span className="tbl-pop-title">Borders</span>
              <span className="muted small">{range ? 'Selection' : 'Table'}</span>
            </div>
            <div className="tbl-border-matrix" role="group" aria-label="Border edges">
              {BORDER_TARGETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`small ghost tbl-border-btn${activeTarget === item.id ? ' on' : ''}`}
                  aria-label={item.label}
                  title={item.label}
                  onClick={() => apply(item.id)}
                >
                  <BorderIcon target={item.id} />
                </button>
              ))}
            </div>
            <div className="tbl-border-controls">
              <ColorPill
                value={color}
                compact
                ariaLabel="Border color"
                onChange={(c) => {
                  setColor(c);
                  if (activeTarget !== 'none') apply(activeTarget, c, width, dash);
                }}
              />
              <div className="stepper-box compact" aria-label="Border width">
                <button type="button" aria-label="Decrease border width" onClick={() => stepWidth(-0.5)}>
                  −
                </button>
                <span className="mono small" style={{ minWidth: 34, textAlign: 'center', fontWeight: 600 }}>
                  {width}px
                </span>
                <button type="button" aria-label="Increase border width" onClick={() => stepWidth(0.5)}>
                  +
                </button>
              </div>
            </div>
            <div className="ed-seg-bar" role="group" aria-label="Border line style">
              {DASH_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`small${dash === m.id ? ' on' : ' ghost'}`}
                  aria-pressed={dash === m.id}
                  onClick={() => {
                    setDash(m.id);
                    if (activeTarget !== 'none') apply(activeTarget, color, width, m.id);
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
