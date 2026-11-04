import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  autoScrollSpeed,
  finishMove,
  indicatorFor,
  LONG_PRESS_MS,
  type Point,
  pressDecision,
  type Rect,
  targetIndex,
} from './sortableMath.ts';

/**
 * Touch-safe reordering on pointer events (HTML5 drag and drop does not work under a finger). A drag
 * starts from an item's visible handle: on touch after a 300 ms hold (a quick swipe still scrolls the
 * list), with a mouse after a few pixels. While dragging, the item follows the pointer, a line marks the
 * drop slot, the list auto-scrolls near its edges, and Escape (or a cancelled touch) puts it back.
 * With `mouseFromItem`, a mouse drag may also start anywhere on the item (desktop parity with the old
 * draggable rows). Keyboard users and anyone who prefers buttons use the move up/down buttons every
 * list using this keeps next to it.
 *
 * Markup contract: the list root takes `ref`; every measured item takes `item(i)` (in DOM order, indices
 * 0..n-1); draggable items take `handle(i)` on their handle and optionally `mouseArea(i)`; `cls(i)`
 * gives the drag classes (sort-dragging, sort-before, sort-after) for styling.
 */
export type SortableOptions = {
  group: string;
  axis: 'y' | 'xy';
  onMove: (from: number, to: number) => void;
  disabled?: boolean;
};

type Press = {
  index: number;
  pointerId: number;
  pointerType: string;
  t0: number;
  start: Point;
  last: Point;
  started: boolean;
  timer?: ReturnType<typeof setTimeout>;
  raf?: number;
  els?: HTMLElement[];
  rects?: Rect[];
  scroller?: HTMLElement;
  scroll0?: Point;
  to?: number;
  cleanup: () => void;
};

function scrollParent(el: HTMLElement | null): HTMLElement {
  for (let n = el; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

const INTERACTIVE = 'input, textarea, select, button, a, [contenteditable="true"], [data-sort-handle]';

export function useSortable(o: SortableOptions) {
  const root = useRef<HTMLElement | null>(null);
  const opts = useRef(o);
  opts.current = o;
  const press = useRef<Press | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  const end = useCallback((cancelled: boolean) => {
    const p = press.current;
    if (!p) return;
    press.current = null;
    p.cleanup();
    if (!p.started) return;
    for (const el of p.els ?? []) el.style.transform = '';
    document.body.classList.remove('sorting');
    setDrag(null);
    if (p.pointerType === 'mouse') {
      // The mouseup after a drag must not also click (select) the item under it.
      const swallow = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    }
    const r = finishMove(p.index, p.to ?? p.index, cancelled);
    if (r) opts.current.onMove(r.from, r.to);
  }, []);

  const update = useCallback(() => {
    const p = press.current;
    if (!p?.started || !p.rects || !p.scroller || !p.scroll0) return;
    const pt = {
      x: p.last.x + (p.scroller.scrollLeft - p.scroll0.x),
      y: p.last.y + (p.scroller.scrollTop - p.scroll0.y),
    };
    const el = p.els?.[p.index];
    if (el) {
      const dx = opts.current.axis === 'y' ? 0 : pt.x - p.start.x;
      el.style.transform = `translate(${dx}px, ${pt.y - p.start.y}px)`;
    }
    const to = targetIndex(p.rects, pt, p.index, opts.current.axis);
    if (to !== p.to) {
      p.to = to;
      setDrag({ from: p.index, to });
    }
  }, []);

  const begin = useCallback(
    (index: number) => {
      const startPress = press.current;
      if (!startPress || startPress.started) return;
      const sc = scrollParent(root.current);
      const els = root.current
        ? [...root.current.querySelectorAll<HTMLElement>(`[data-sort-item="${opts.current.group}"]`)]
        : [];
      if (!els[index]) {
        end(true);
        return;
      }
      startPress.started = true;
      startPress.els = els;
      startPress.rects = els.map((el) => el.getBoundingClientRect());
      startPress.scroller = sc;
      startPress.scroll0 = { x: sc.scrollLeft, y: sc.scrollTop };
      startPress.to = index;
      document.body.classList.add('sorting');
      setDrag({ from: index, to: index });
      const tick = () => {
        const q = press.current;
        if (!q?.started || !q.scroller) return;
        const r = q.scroller.getBoundingClientRect();
        const top = Math.max(0, r.top);
        const bottom = Math.min(window.innerHeight, r.bottom);
        const v = autoScrollSpeed(q.last.y, top, bottom);
        if (v) {
          const before = q.scroller.scrollTop;
          q.scroller.scrollTop = before + v;
          if (q.scroller.scrollTop !== before) update();
        }
        q.raf = requestAnimationFrame(tick);
      };
      startPress.raf = requestAnimationFrame(tick);
      update();
    },
    [end, update],
  );

  const down = useCallback(
    (e: ReactPointerEvent, index: number, fromHandle: boolean) => {
      if (opts.current.disabled || press.current) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!fromHandle) {
        if (e.pointerType !== 'mouse') return;
        const t = e.target as HTMLElement;
        if (t.closest(INTERACTIVE) && !t.closest('[data-sort-grab]')) return;
      } else if (e.pointerType === 'mouse') e.preventDefault(); // no text selection from the handle
      const id = e.pointerId;
      const onMove = (ev: PointerEvent) => {
        const p = press.current;
        if (!p || ev.pointerId !== id) return;
        p.last = { x: ev.clientX, y: ev.clientY };
        if (p.started) {
          ev.preventDefault();
          update();
          return;
        }
        const d = Math.hypot(ev.clientX - p.start.x, ev.clientY - p.start.y);
        const decision = pressDecision(p.pointerType, performance.now() - p.t0, d);
        if (decision === 'start') begin(index);
        else if (decision === 'abort') end(true);
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId === id) end(false);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === id) end(true);
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape' && press.current?.started) {
          ev.preventDefault();
          ev.stopPropagation();
          end(true);
        }
      };
      // iOS: a long press would otherwise open the callout / start a text selection.
      const onContext = (ev: Event) => {
        if (press.current?.started || press.current?.pointerType !== 'mouse') ev.preventDefault();
      };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('contextmenu', onContext);
      // A native drag (an image or a link inside the item) would take the pointer away: no HTML5 drag here.
      const onNativeDrag = (ev: Event) => ev.preventDefault();
      window.addEventListener('dragstart', onNativeDrag, true);
      const p: Press = {
        index,
        pointerId: id,
        pointerType: e.pointerType || 'mouse',
        t0: performance.now(),
        start: { x: e.clientX, y: e.clientY },
        last: { x: e.clientX, y: e.clientY },
        started: false,
        cleanup: () => {
          clearTimeout(p.timer);
          if (p.raf) cancelAnimationFrame(p.raf);
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('keydown', onKey, true);
          window.removeEventListener('contextmenu', onContext);
          window.removeEventListener('dragstart', onNativeDrag, true);
        },
      };
      press.current = p;
      if (p.pointerType !== 'mouse')
        p.timer = setTimeout(() => {
          const q = press.current;
          if (q !== p || q.started) return;
          const d = Math.hypot(q.last.x - q.start.x, q.last.y - q.start.y);
          if (pressDecision(q.pointerType, LONG_PRESS_MS, d) === 'start') begin(index);
          else end(true);
        }, LONG_PRESS_MS);
    },
    [begin, end, update],
  );

  // Never leave listeners behind if the list unmounts mid-drag.
  useEffect(() => () => end(true), [end]);

  const ind = drag ? indicatorFor(drag.from, drag.to) : null;
  return {
    drag,
    ref: (el: HTMLElement | null) => {
      root.current = el;
    },
    item: (_i: number) => ({ 'data-sort-item': o.group }),
    handle: (i: number) => ({
      'data-sort-handle': o.group,
      onPointerDown: (e: ReactPointerEvent) => down(e, i, true),
    }),
    mouseArea: (i: number) => ({ onPointerDown: (e: ReactPointerEvent) => down(e, i, false) }),
    cls: (i: number) =>
      [
        drag?.from === i ? 'sort-dragging' : '',
        ind?.index === i ? `sort-${ind.side}` : '',
        o.axis === 'xy' ? 'sort-x' : '',
      ]
        .filter(Boolean)
        .join(' '),
  };
}

/** The visible grip a finger (or mouse) drags an item by. */
export function DragHandle(props: { label: string; disabled?: boolean } & Record<string, unknown>) {
  const { label, disabled, ...rest } = props;
  if (disabled) return null;
  return (
    <span className="sort-handle" aria-hidden="true" title={label} {...rest}>
      ⠿
    </span>
  );
}
