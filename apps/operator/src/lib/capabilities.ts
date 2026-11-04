import { create } from 'zustand';

/**
 * What this browser can do, detected once (design/15 "iPad editing"). Running a live service needs the
 * venue PC's Chromium: the Window Management API (outputs on their screens), fullscreen popups, WebHID
 * (Stream Deck). A browser without all of those (iPadOS Safari, a phone) gets the edit profile: the
 * library, playlists, the editor and the look previews, never the live view, output windows or keys.
 * Gated by capability and input type, never by the user agent.
 */
export type Capabilities = {
  hid: boolean;
  midi: boolean;
  windowManagement: boolean;
  /** A window opened by a gesture can go fullscreen (not a touch-first tablet or phone). */
  fullscreenPopups: boolean;
  sinkId: boolean;
  opfs: boolean;
  webgpu: boolean;
  /** The primary pointer is coarse and there is no hover (a finger, not a mouse). */
  coarsePointer: boolean;
  /** Installed to the home screen (display-mode standalone, or iOS `navigator.standalone`). */
  standalone: boolean;
};

export type Profile = 'full' | 'edit';

/** The globals detection reads; tests feed fakes. */
export type CapabilityEnv = {
  navigator?: unknown;
  window?: unknown;
  document?: unknown;
  matchMedia?: (query: string) => { matches: boolean };
  mediaElementProto?: unknown;
  elementProto?: unknown;
};

function has(obj: unknown, key: string): boolean {
  return !!obj && typeof obj === 'object' && key in (obj as object);
}

function fn(obj: unknown, key: string): boolean {
  return has(obj, key) && typeof (obj as Record<string, unknown>)[key] === 'function';
}

function media(env: CapabilityEnv, q: string): boolean {
  try {
    return !!env.matchMedia?.(q).matches;
  } catch {
    return false;
  }
}

export function detectCapabilities(env: CapabilityEnv): Capabilities {
  const nav = env.navigator;
  const storage = has(nav, 'storage') ? (nav as { storage: unknown }).storage : undefined;
  const coarsePointer = media(env, '(pointer: coarse)') && media(env, '(hover: none)');
  const fullscreenApi =
    has(env.document, 'fullscreenEnabled') &&
    (env.document as { fullscreenEnabled: unknown }).fullscreenEnabled === true &&
    fn(env.elementProto, 'requestFullscreen');
  return {
    hid: has(nav, 'hid'),
    midi: fn(nav, 'requestMIDIAccess'),
    windowManagement: fn(env.window, 'getScreenDetails'),
    // A touch-first device opens popups as tabs and has no screens to put them on fullscreen.
    fullscreenPopups: fullscreenApi && !coarsePointer,
    sinkId: fn(env.mediaElementProto, 'setSinkId'),
    opfs: fn(storage, 'getDirectory'),
    webgpu: has(nav, 'gpu'),
    coarsePointer,
    standalone:
      media(env, '(display-mode: standalone)') ||
      (has(nav, 'standalone') && (nav as { standalone: unknown }).standalone === true),
  };
}

/**
 * The device's profile: `full` only where outputs can be placed on screens (Window Management) or a
 * Stream Deck can be plugged in (WebHID), both Chromium-only; `edit` otherwise, when the session role is
 * `edit`, or when forced for testing. The Fullscreen API is deliberately not enough: iPadOS Safari has it,
 * and reports a fine pointer with hover as soon as a trackpad or mouse is attached (a Magic Keyboard), so
 * a rule built on it would turn the worship lead's iPad into an operator.
 */
export function profileFor(
  caps: Capabilities,
  role: 'operate' | 'edit' | null | undefined,
  forced?: Profile | null,
): Profile {
  if (role === 'edit') return 'edit';
  if (forced === 'edit' || forced === 'full') return forced;
  return caps.windowManagement || caps.hid ? 'full' : 'edit';
}

/** `?profile=edit|full` in the URL, or localStorage `ordo.profile` (tests and support only). */
export function forcedProfile(search: string, stored: string | null): Profile | null {
  const q = new URLSearchParams(search).get('profile');
  const v = q ?? stored;
  return v === 'edit' || v === 'full' ? v : null;
}

function browserEnv(): CapabilityEnv {
  if (typeof window === 'undefined') return {};
  return {
    navigator,
    window,
    document,
    matchMedia: typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined,
    mediaElementProto: typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype : undefined,
    elementProto: typeof Element !== 'undefined' ? Element.prototype : undefined,
  };
}

function readForced(): Profile | null {
  if (typeof location === 'undefined') return null;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('ordo.profile');
  } catch {
    /* storage unavailable */
  }
  return forcedProfile(location.search, stored);
}

type CapState = { caps: Capabilities; forced: Profile | null };

/** Detected once at startup; the store exists so views re-render the same way as other read models. */
export const useCapabilities = create<CapState>(() => ({
  caps: detectCapabilities(browserEnv()),
  forced: readForced(),
}));

export function capabilities(): Capabilities {
  return useCapabilities.getState().caps;
}

/** The profile for a role on this device (non-reactive). */
export function deviceProfile(role: 'operate' | 'edit' | null | undefined): Profile {
  const s = useCapabilities.getState();
  return profileFor(s.caps, role, s.forced);
}

/** Hook form of deviceProfile. */
export function useProfile(role: 'operate' | 'edit' | null | undefined): Profile {
  const caps = useCapabilities((s) => s.caps);
  const forced = useCapabilities((s) => s.forced);
  return profileFor(caps, role, forced);
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { __ordo?: Record<string, unknown> };
  w.__ordo = {
    ...(w.__ordo ?? {}),
    get capabilities() {
      const s = useCapabilities.getState();
      return { ...s.caps, deviceProfile: profileFor(s.caps, 'operate', s.forced) };
    },
  };
}

const PERSIST_KEY = 'ordo.persistRequested';

/**
 * Ask once per device for persistent storage (Safari may grant it to an installed web app, which keeps
 * the library copy from the 7-day eviction of script-written storage). Resolves to the grant, or
 * undefined when not asked (already asked, or no StorageManager).
 */
export async function requestPersistentStorage(
  nav: { storage?: { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> } } = navigator,
  store: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : undefined,
): Promise<boolean | undefined> {
  const persist = nav.storage?.persist;
  if (typeof persist !== 'function') return undefined;
  try {
    if (store?.getItem(PERSIST_KEY)) return undefined;
  } catch {
    /* storage unavailable: ask anyway */
  }
  let granted = false;
  try {
    granted = (await nav.storage?.persisted?.()) || (await persist.call(nav.storage));
  } catch {
    granted = false;
  }
  // Remember a grant only: a refusal (a Safari tab refuses without asking) is cheap to retry on the
  // next load, and the same origin may qualify later (installed, or used more).
  if (granted) {
    try {
      store?.setItem(PERSIST_KEY, String(Date.now()));
    } catch {
      /* storage unavailable */
    }
  }
  return granted;
}
