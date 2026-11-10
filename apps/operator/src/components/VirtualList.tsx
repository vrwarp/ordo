import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

/** Fixed or dynamic row-height virtualized list: renders only visible rows plus overscan. */
export function VirtualList<T>(props: {
  items: T[];
  rowHeight: number | ((item: T, index: number) => number);
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

  const isDynamic = typeof rowHeight === 'function';

  const { offsets, heights, totalHeight } = useMemo(() => {
    if (typeof rowHeight === 'function') {
      const offs: number[] = [];
      const hts: number[] = [];
      let tot = 0;
      for (let i = 0; i < items.length; i++) {
        offs.push(tot);
        const h = rowHeight(items[i]!, i);
        hts.push(h);
        tot += h;
      }
      return { offsets: offs, heights: hts, totalHeight: tot };
    }
    return {
      offsets: [] as number[],
      heights: [] as number[],
      totalHeight: items.length * rowHeight,
    };
  }, [items, rowHeight]);

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
    const y = isDynamic ? (offsets[scrollToIndex] ?? 0) : scrollToIndex * (rowHeight as number);
    const h = isDynamic ? (heights[scrollToIndex] ?? 0) : (rowHeight as number);
    if (y < el.scrollTop || y + h > el.scrollTop + el.clientHeight)
      el.scrollTop = Math.max(0, y - el.clientHeight / 3);
  }, [scrollToIndex, rowHeight, isDynamic, offsets, heights]);

  const over = props.overscan ?? 6;
  let first = 0;
  let last = items.length;

  if (isDynamic) {
    let firstIdx = 0;
    while (firstIdx < items.length && (offsets[firstIdx] ?? 0) + (heights[firstIdx] ?? 0) < top) {
      firstIdx++;
    }
    let lastIdx = firstIdx;
    while (lastIdx < items.length && (offsets[lastIdx] ?? 0) < top + height) {
      lastIdx++;
    }
    first = Math.max(0, firstIdx - over);
    last = Math.min(items.length, lastIdx + over);
  } else {
    const fixedH = rowHeight as number;
    first = Math.max(0, Math.floor(top / fixedH) - over);
    last = Math.min(items.length, Math.ceil((top + height) / fixedH) + over);
  }

  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const it = items[i]!;
    const rowTop = isDynamic ? offsets[i]! : i * (rowHeight as number);
    const rowH = isDynamic ? heights[i]! : (rowHeight as number);
    rows.push(
      <div
        key={props.keyOf ? props.keyOf(it, i) : i}
        className={`vrow ${props.rowClass?.(it, i) ?? ''}`}
        style={{ top: rowTop, height: rowH }}
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
      <div style={{ height: totalHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}
