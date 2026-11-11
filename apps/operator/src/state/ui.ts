import { create } from 'zustand';

/** Per-device UI state, persisted to localStorage (design/15). */
export type UiState = {
  selectedPlaylistId?: string;
  /** Playlist item shown in the slide grid (index into the playlist). */
  viewItemIndex?: number;
  /** Explicit programmatic scroll target requested by user action (e.g. clicking playlist item). */
  scrollToItem?: { index: number; req: number };
  /** Follow the live item in the slide grid. */
  followLive: boolean;
  /** Single click on a slide goes live (ProPresenter style) instead of arming it. */
  clickToGo: boolean;
  thumbSize: number;
  libraryFolderId?: string | null;
  showDiagnostics: boolean;
  /** Master gain before mute, to restore on unmute. */
  unmuteDb?: number;
  recentMessages: string[];
  messageTtlMs: number;
};

const KEY = 'ordo.op.ui';
const defaults: UiState = {
  followLive: true,
  clickToGo: false,
  thumbSize: 200,
  showDiagnostics: false,
  recentMessages: [],
  messageTtlMs: 0,
};

function load(): UiState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<UiState>) };
  } catch {
    /* ignore */
  }
  return defaults;
}

export const useUi = create<UiState>(() => load());

let saveTimer: ReturnType<typeof setTimeout> | undefined;
useUi.subscribe((s) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const { scrollToItem: _, ...persistable } = s;
      localStorage.setItem(KEY, JSON.stringify(persistable));
    } catch {
      /* ignore */
    }
  }, 200);
});

export function setUi(patch: Partial<UiState>): void {
  useUi.setState(patch);
}

let scrollReqId = 0;
export function requestScrollToPlaylistItem(index: number): void {
  useUi.setState({
    viewItemIndex: index,
    followLive: false,
    scrollToItem: { index, req: ++scrollReqId },
  });
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { __ordo?: Record<string, unknown> };
  w.__ordo ??= {};
  w.__ordo.ui = useUi;
  w.__ordo.setUi = setUi;
}

export function rememberMessage(text: string): void {
  const t = text.trim();
  if (!t) return;
  useUi.setState((s) => ({ recentMessages: [t, ...s.recentMessages.filter((x) => x !== t)].slice(0, 5) }));
}
