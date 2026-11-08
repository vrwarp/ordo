import { isCoarsePointer } from './pointer.ts';

/**
 * Keep the field being edited inside the visual viewport on a touch device. The iPad's software keyboard
 * shrinks the visual viewport (not the layout viewport), so a field low in a scrolling panel ends up under
 * it. On focus, and whenever the visual viewport resizes or pans while a field has focus, the field's
 * nearest scrolling ancestor scrolls just enough to bring it back into view.
 */

export type Span = { top: number; bottom: number };

/**
 * How far (px, positive = scroll content up) a scroller must move so `rect` sits inside `view` with
 * `margin` to spare. A field taller than the view is aligned to its top. Zero when already visible.
 */
export function revealDelta(rect: Span, view: { top: number; height: number }, margin = 12): number {
  const top = view.top + margin;
  const bottom = view.top + view.height - margin;
  if (bottom <= top) return 0;
  if (rect.top < top) return rect.top - top;
  if (rect.bottom > bottom) return Math.min(rect.bottom - bottom, rect.top - top);
  return 0;
}

/** The visual viewport in layout-viewport coordinates (what getBoundingClientRect is measured in). */
export function visualView(): { top: number; height: number } {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  return vv ? { top: vv.offsetTop, height: vv.height } : { top: 0, height: window.innerHeight };
}

const EDITABLE = /^(TEXTAREA|SELECT)$/;
function isEditable(el: Element | null): el is HTMLElement {
  if (!el) return false;
  if (EDITABLE.test(el.tagName)) return true;
  if (el.tagName !== 'INPUT') return (el as HTMLElement).isContentEditable;
  const t = (el as HTMLInputElement).type;
  return !/^(checkbox|radio|range|color|button|submit|reset|file|image)$/.test(t);
}

function scroller(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/** Scroll `el` into the visual viewport; returns the distance it could not be moved (0 when visible). */
export function reveal(el: HTMLElement): number {
  const d = revealDelta(el.getBoundingClientRect(), visualView());
  if (!d) return 0;
  let left = d;
  for (let sc = scroller(el); sc && Math.abs(left) > 1; sc = scroller(sc)) {
    const before = sc.scrollTop;
    sc.scrollTop = before + left;
    left -= sc.scrollTop - before;
  }
  return left;
}

/** Install on a root element; returns the uninstaller. Inert unless the primary pointer is coarse. */
export function installKeepVisible(root: HTMLElement): () => void {
  let active: HTMLElement | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const check = () => {
    if (active && document.activeElement === active) reveal(active);
  };
  const onFocus = (e: FocusEvent) => {
    if (!isCoarsePointer() || !isEditable(e.target as Element)) return;
    active = e.target as HTMLElement;
    for (const t of timers.splice(0)) clearTimeout(t);
    // Now, and again after the keyboard has animated in (iPadOS takes ~250-350 ms).
    check();
    timers.push(setTimeout(check, 120), setTimeout(check, 400));
  };
  const onBlur = () => {
    active = null;
  };
  const vv = window.visualViewport;
  root.addEventListener('focusin', onFocus);
  root.addEventListener('focusout', onBlur);
  vv?.addEventListener('resize', check);
  vv?.addEventListener('scroll', check);
  window.addEventListener('resize', check);
  return () => {
    for (const t of timers) clearTimeout(t);
    root.removeEventListener('focusin', onFocus);
    root.removeEventListener('focusout', onBlur);
    vv?.removeEventListener('resize', check);
    vv?.removeEventListener('scroll', check);
    window.removeEventListener('resize', check);
  };
}
