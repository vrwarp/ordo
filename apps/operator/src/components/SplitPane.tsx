import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

export type SplitPanel = {
  id: string;
  /** Initial pixel size. Omit (or pass undefined) for the flexible `1fr` center panel. */
  size?: number;
  min?: number;
  max?: number;
  className?: string;
  content: ReactNode;
};

const STORAGE_PREFIX = 'ordo.split.';

function readStored(storageKey: string): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeStored(storageKey: string, sizes: Record<string, number>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_PREFIX + storageKey, JSON.stringify(sizes));
  } catch {
    // Ignore quota / privacy mode failures.
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Flush docked split-pane container with draggable 1 px dividers (design/30 §3.4).
 * Persists user-resized panel widths/heights in localStorage and resets to defaults on double-click.
 */
export function SplitPane({
  storageKey,
  direction = 'horizontal',
  panels,
  className,
  style,
}: {
  storageKey: string;
  direction?: 'horizontal' | 'vertical';
  panels: readonly SplitPanel[];
  className?: string;
  style?: CSSProperties;
}) {
  const [sizes, setSizes] = useState<Record<string, number>>(() => readStored(storageKey));
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  useEffect(() => {
    setSizes(readStored(storageKey));
  }, [storageKey]);

  const sizeOf = useCallback(
    (p: SplitPanel): number | undefined => {
      if (p.size === undefined) return undefined;
      const saved = sizes[p.id];
      const val = typeof saved === 'number' && Number.isFinite(saved) ? saved : p.size;
      return clamp(val, p.min ?? 120, p.max ?? 1200);
    },
    [sizes],
  );

  const resetDivider = (left: SplitPanel, right: SplitPanel) => {
    setSizes((prev) => {
      const next = { ...prev };
      delete next[left.id];
      delete next[right.id];
      writeStored(storageKey, next);
      return next;
    });
  };

  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>, idx: number) => {
    const left = panels[idx];
    const right = panels[idx + 1];
    if (!left || !right) return;
    // Determine which side owns the fixed pixel size.
    const leftFixed = left.size !== undefined;
    const rightFixed = right.size !== undefined;
    if (!leftFixed && !rightFixed) return;

    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    setDraggingIdx(idx);

    const startPos = direction === 'horizontal' ? e.clientX : e.clientY;
    const startLeft = leftFixed ? (sizeOf(left) ?? left.size!) : 0;
    const startRight = rightFixed ? (sizeOf(right) ?? right.size!) : 0;

    const onMove = (ev: PointerEvent) => {
      const delta = (direction === 'horizontal' ? ev.clientX : ev.clientY) - startPos;
      setSizes((prev) => {
        const next = { ...prev };
        if (leftFixed && !rightFixed) {
          next[left.id] = Math.round(clamp(startLeft + delta, left.min ?? 120, left.max ?? 1200));
        } else if (!leftFixed && rightFixed) {
          next[right.id] = Math.round(clamp(startRight - delta, right.min ?? 120, right.max ?? 1200));
        } else {
          const total = startLeft + startRight;
          const nextL = Math.round(
            clamp(
              startLeft + delta,
              Math.max(left.min ?? 120, total - (right.max ?? 1200)),
              Math.min(left.max ?? 1200, total - (right.min ?? 120)),
            ),
          );
          next[left.id] = nextL;
          next[right.id] = total - nextL;
        }
        return next;
      });
    };

    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      setDraggingIdx(null);
      writeStored(storageKey, sizesRef.current);
    };

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  const isH = direction === 'horizontal';

  return (
    <div
      className={`split-pane ${isH ? 'split-h' : 'split-v'}${draggingIdx !== null ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      {panels.map((p, i) => {
        const px = sizeOf(p);
        const panelStyle: CSSProperties =
          px !== undefined
            ? { flex: `0 0 ${px}px`, [isH ? 'width' : 'height']: px, minWidth: 0, minHeight: 0 }
            : { flex: '1 1 0%', minWidth: 0, minHeight: 0 };
        const nextPanel = panels[i + 1];
        return (
          <div key={p.id} style={{ display: 'contents' }}>
            <div className={`split-cell${p.className ? ` ${p.className}` : ''}`} style={panelStyle}>
              {p.content}
            </div>
            {nextPanel && (
              <div
                role="separator"
                aria-orientation={isH ? 'vertical' : 'horizontal'}
                aria-label={`Resize ${p.id} and ${nextPanel.id}`}
                title="Drag to resize · Double-click to reset"
                className={`split-divider ${isH ? 'split-divider-h' : 'split-divider-v'}${draggingIdx === i ? ' active' : ''}`}
                onPointerDown={(e) => onDividerDown(e, i)}
                onDoubleClick={() => resetDivider(p, nextPanel)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
