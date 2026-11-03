import { type ReactNode, useEffect, useRef, useState } from 'react';

/** Fixed-row-height virtualized list: renders only visible rows plus overscan. */
export function VirtualList<T>(props: {
  items: T[];
  rowHeight: number;
  render: (item: T, index: number) => ReactNode;
  className?: string;
  style?: React.CSSProperties;
  overscan?: number;
  rowClass?: (item: T, index: number) => string;
  onRowClick?: (item: T, index: number) => void;
  onRowDoubleClick?: (item: T, index: number) => void;
  keyOf?: (item: T, index: number) => string;
  scrollToIndex?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const { rowHeight, items, scrollToIndex } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || scrollToIndex === undefined || scrollToIndex < 0) return;
    const y = scrollToIndex * rowHeight;
    if (y < el.scrollTop || y + rowHeight > el.scrollTop + el.clientHeight)
      el.scrollTop = Math.max(0, y - el.clientHeight / 3);
  }, [scrollToIndex, rowHeight]);
  const over = props.overscan ?? 6;
  const first = Math.max(0, Math.floor(top / rowHeight) - over);
  const last = Math.min(items.length, Math.ceil((top + height) / rowHeight) + over);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const it = items[i]!;
    rows.push(
      <div
        key={props.keyOf ? props.keyOf(it, i) : i}
        className={`vrow ${props.rowClass?.(it, i) ?? ''}`}
        style={{ top: i * rowHeight, height: rowHeight }}
        onClick={props.onRowClick ? () => props.onRowClick!(it, i) : undefined}
        onDoubleClick={props.onRowDoubleClick ? () => props.onRowDoubleClick!(it, i) : undefined}
      >
        {props.render(it, i)}
      </div>,
    );
  }
  return (
    <div
      ref={ref}
      className={`vlist ${props.className ?? ''}`}
      style={props.style}
      onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}
