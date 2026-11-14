import { useLayoutEffect, useSyncExternalStore } from 'react';
import { deviceProfile, type Profile } from './capabilities.ts';

/**
 * The layout class (design/28 decision 3, §3.1): `compact` when the device's capability profile is not
 * `full` and the viewport is small (under 700 CSS px wide or under 500 tall), `regular` otherwise. It picks
 * components and CSS only; the venue PC (capability profile `full`) never gets it, however small its window
 * and whatever PIN signed in. The input is the device's capability profile (`deviceProfile('operate')`), not
 * the session's profile (`useProfile(role)`): the edit role gives every device the edit profile, so a venue PC
 * signed in with the edit PIN at 600x900 must stay regular.
 */
export type Layout = 'compact' | 'regular';

/** The viewport the compact layout is for (design/28 §3.1). */
export const COMPACT_QUERY = '(max-width: 699px), (max-height: 499px)';

export function layoutFor(capabilityProfile: Profile, compactViewport: boolean): Layout {
  return capabilityProfile !== 'full' && compactViewport ? 'compact' : 'regular';
}

/**
 * The layout after a viewport change: regular -> compact waits while the editor is open (an iPad Split View
 * narrowing never unmounts an editor with unsaved edits; it switches at the next navigation, owner question
 * 9); compact -> regular happens at once.
 */
export function nextLayout(prev: Layout, wanted: Layout, routeName: string): Layout {
  if (prev === 'regular' && wanted === 'compact' && routeName === 'edit') return 'regular';
  return wanted;
}

/** A screen's size in CSS px (`window.screen`); tests feed plain objects. */
export type ScreenSize = { readonly width: number; readonly height: number };

/**
 * A phone (design/28 §3.2 "How a phone gets light"): an edit-capability device whose shorter **screen** side
 * is under 600 CSS px. The screen, never the viewport: Safari's "Request Desktop Website" gives a phone a
 * 980 px layout viewport, and an iPad in a narrow Split View is still a tablet. An unfolded foldable is a
 * tablet. A screen that reports no size is not a phone.
 */
export function isPhone(capabilityProfile: Profile, screen: ScreenSize | undefined | null): boolean {
  if (capabilityProfile !== 'edit' || !screen) return false;
  const w = Number(screen.width);
  const h = Number(screen.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  return Math.min(w, h) < 600;
}

/** The cap a sign-in from this device asks for (design/28 §3.2): `light` on a phone, none elsewhere. */
export function signInCap(
  capabilityProfile: Profile,
  screen: ScreenSize | undefined | null,
): 'light' | undefined {
  return isPhone(capabilityProfile, screen) ? 'light' : undefined;
}

/** This browser's screen, or undefined outside one. */
export function deviceScreen(): ScreenSize | undefined {
  return typeof screen === 'undefined' ? undefined : screen;
}

// The phone class of this page, decided once (thisIsPhone).
let phoneClass: boolean | undefined;

/**
 * This device is a phone, decided at its first call and kept for the page's life: the capability profile and
 * the screen of a device do not change at run time, and where a browser's `screen` follows the window (an
 * emulated device; WebKit under Playwright) a tablet whose window shrinks, as under a software keyboard, must
 * not turn into a phone (it would be restricted at once and its open editor sent to the previews). `decide` is
 * for tests.
 */
export function thisIsPhone(
  decide: () => boolean = () => isPhone(deviceProfile('operate'), deviceScreen()),
): boolean {
  phoneClass ??= decide();
  return phoneClass;
}

// The current layout: written by useLayout (once per render of App) and main.tsx before the first render,
// read by components (useCurrentLayout) and services (currentLayout). 'regular' until something decides.
const state: { layout: Layout; decided: boolean } = { layout: 'regular', decided: false };
const listeners = new Set<() => void>();

function subscribeLayout(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The current layout (non-reactive). */
export function currentLayout(): Layout {
  return state.layout;
}

/** Hook form of currentLayout. */
export function useCurrentLayout(): Layout {
  return useSyncExternalStore(subscribeLayout, currentLayout, currentLayout);
}

/** Run `fn` whenever the layout changes. Returns the unsubscribe. */
export function onLayoutChange(fn: (layout: Layout) => void): () => void {
  return subscribeLayout(() => fn(state.layout));
}

/**
 * Record a layout decision: the store, and `html[data-layout="compact"]` on the compact layout only (the
 * attribute is removed on the regular layout, so the venue PC's markup gains nothing).
 */
export function applyLayout(layout: Layout, doc: Document | undefined = globalDocument()): void {
  state.decided = true;
  if (doc) {
    const root = doc.documentElement;
    if (layout === 'compact') {
      if (root.dataset.layout !== 'compact') root.dataset.layout = 'compact';
    } else if (root.hasAttribute('data-layout')) root.removeAttribute('data-layout');
  }
  if (state.layout === layout) return;
  state.layout = layout;
  for (const fn of [...listeners]) fn();
}

function globalDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

type MediaList = { matches: boolean; addEventListener?: unknown; addListener?: unknown };
type MatchMedia = (query: string) => MediaList;

function globalMatchMedia(): MatchMedia | undefined {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? (q) => window.matchMedia(q)
    : undefined;
}

/** The compact viewport query answers true (false without matchMedia). */
export function compactViewport(mm: MatchMedia | undefined = globalMatchMedia()): boolean {
  try {
    return !!mm?.(COMPACT_QUERY).matches;
  } catch {
    return false;
  }
}

function subscribeViewport(fn: () => void): () => void {
  const mm = globalMatchMedia();
  let mql: MediaQueryList | undefined;
  try {
    mql = mm?.(COMPACT_QUERY) as MediaQueryList | undefined;
  } catch {
    mql = undefined;
  }
  if (!mql) return () => undefined;
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', fn);
    return () => mql.removeEventListener('change', fn);
  }
  // Safari before 14.
  const legacy = mql as unknown as {
    addListener?: (f: () => void) => void;
    removeListener?: (f: () => void) => void;
  };
  legacy.addListener?.(fn);
  return () => legacy.removeListener?.(fn);
}

/** The layout before any session (main.tsx, before the first render): the same rule as useLayout. */
export function startLayout(
  capabilityProfile: Profile = deviceProfile('operate'),
  mm: MatchMedia | undefined = globalMatchMedia(),
): Layout {
  return layoutFor(capabilityProfile, compactViewport(mm));
}

/**
 * The layout of this page, called once at the top of App with the device's capability profile
 * (`deviceProfile('operate')`) and the route's name: it follows the viewport (matchMedia change events),
 * defers regular -> compact while the editor is open (nextLayout), and publishes the result to the store and
 * the document before paint.
 */
export function useLayout(capabilityProfile: Profile, routeName: string): Layout {
  const compact = useSyncExternalStore(subscribeViewport, compactViewport, () => false);
  const prev = useCurrentLayout();
  const wanted = layoutFor(capabilityProfile, compact);
  // The first decision (no main.tsx start, a test) takes the wanted layout as is: deferring is for changes.
  const layout = state.decided ? nextLayout(prev, wanted, routeName) : wanted;
  useLayoutEffect(() => applyLayout(layout), [layout]);
  return layout;
}

/** Forget the decision (tests only). */
export function resetLayoutForTests(): void {
  state.layout = 'regular';
  state.decided = false;
  phoneClass = undefined;
  listeners.clear();
}

if (typeof window !== 'undefined') {
  // Added to the object that is there, never spread into a new one (the getters of lib/capabilities.ts
  // stay live; views/editor/inspect.ts does the same).
  const w = window as unknown as { __ordo?: Record<string, unknown> };
  w.__ordo ??= {};
  Object.defineProperty(w.__ordo, 'layout', {
    configurable: true,
    enumerable: true,
    get: () => state.layout,
  });
}
