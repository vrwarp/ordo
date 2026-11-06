import { ActionId, type StreamDeckKey, type StreamDeckPage } from '@ordo/domain';

/** What the Stream Deck shows; derived from live state by the operator app. */
export type DeckView = {
  sections: { short: string; label: string; pos: number }[];
  liveSectionPos?: number;
  nextItems: string[];
  black: boolean;
  logo: boolean;
  /** Whether the play/pause key's target (F8's, live-state mediaPlayTarget) is playing. */
  mediaPlaying: boolean;
  /** The live slide's click-start sound waits for the play key, which starts it before anything else. */
  slideSoundWaiting?: boolean;
  liveLabel?: string;
  connected: boolean;
  masterDb?: number;
};

/**
 * Page navigation keys: a key without an action whose label is `Page:<name>` jumps to that page;
 * `Page:next` (shown as "More") cycles through pages.
 */
export const PAGE_KEY_PREFIX = 'Page:';

export function pageTarget(key: StreamDeckKey | undefined): string | undefined {
  if (!key || key.action || key.dynamic) return undefined;
  const l = key.label ?? '';
  return l.startsWith(PAGE_KEY_PREFIX) ? l.slice(PAGE_KEY_PREFIX.length).trim() || 'next' : undefined;
}

/** Index of the page a page key leads to. */
export function resolvePageTarget(pages: StreamDeckPage[], current: number, target: string): number {
  if (pages.length === 0) return 0;
  // A stale index (pages replaced by a shorter stored list) must not point past the end.
  current = Number.isInteger(current) ? Math.max(0, Math.min(pages.length - 1, current)) : 0;
  if (target === 'next') return (current + 1) % pages.length;
  if (target === 'prev') return (current - 1 + pages.length) % pages.length;
  const i = pages.findIndex((p) => p.name.toLowerCase() === target.toLowerCase());
  return i >= 0 ? i : current;
}

type K = StreamDeckKey;
const a = (id: ActionId, label: string, arg?: number | string): K =>
  arg === undefined ? { action: { id }, label } : { action: { id, arg }, label };
const section = (i: number): K => ({ dynamic: 'section', dynamicIndex: i });
const nextItem = (i: number): K => ({ dynamic: 'nextItem', dynamicIndex: i });
const more: K = { label: `${PAGE_KEY_PREFIX}next` };

function page(name: string, keys: (K | undefined)[]): StreamDeckPage {
  const rec: Record<string, K> = {};
  keys.forEach((k, i) => {
    if (k) rec[String(i)] = k;
  });
  return { name, keys: rec };
}

const PREV = a('prev', 'Prev');
const GO = a('go', 'GO');
const NEXT = a('next', 'Next');
const CLEAR_SLIDE = a('clearSlide', 'Clear slide');
const CLEAR_ALL = a('clearAll', 'Clear all');
const CLEAR_L3 = a('clearLowerThird', 'Clear L3');
const CLEAR_PROPS = a('clearProps', 'Clear props');
const CLEAR_MEDIA = a('clearMedia', 'Clear media');
const LOGO = a('logo', 'Logo');
const PLAY = a('mediaPlayPause', 'Play');
const RESTART = a('mediaRestart', 'Restart');
const MUTE = a('audioMute', 'Mute');
const UP = a('audioMasterUp', 'Vol +');
const DOWN = a('audioMasterDown', 'Vol −');
const FADE = a('audioFadeOut', 'Fade out');
const msg = (i: number) => a('messagePreset', `Msg ${i + 1}`, i);
const DISMISS = a('messageDismiss', 'Dismiss msg');
const T_START = a('timerStart', 'Timer start');
const T_STOP = a('timerStop', 'Timer stop');
const T_RESET = a('timerReset', 'Timer reset');
const PREV_ITEM = a('prevItem', 'Prev item');
const NEXT_ITEM = a('nextItem', 'Next item');

/** Fill `keys` slots from a priority list, keeping the last slot for the page key. */
function fit(list: (K | undefined)[], keys: number): (K | undefined)[] {
  if (keys <= 1) return [list[0]];
  const out = list.slice(0, keys - 1);
  while (out.length < keys - 1) out.push(undefined);
  out.push(more);
  return out;
}

/** Default pages (Live, Stage, Audio) for a deck with `keys` keys: 6 (Mini), 8 (Plus/Neo), 15, 32 (XL). */
export function defaultDeckPages(keys: number): StreamDeckPage[] {
  if (keys <= 0) return [];
  if (keys === 6) {
    return [
      page('Live', [PREV, GO, NEXT, CLEAR_SLIDE, CLEAR_ALL, more]),
      page('Stage', [msg(0), msg(1), DISMISS, T_START, T_STOP, more]),
      page('Audio', [MUTE, DOWN, UP, FADE, PLAY, more]),
    ];
  }
  if (keys === 8) {
    return [
      page('Live', [PREV, GO, NEXT, LOGO, CLEAR_SLIDE, CLEAR_L3, CLEAR_ALL, more]),
      page('Stage', [msg(0), msg(1), msg(2), DISMISS, T_START, T_STOP, T_RESET, more]),
      page('Audio', [MUTE, DOWN, UP, FADE, PLAY, RESTART, CLEAR_MEDIA, more]),
    ];
  }
  if (keys === 15) {
    return [
      page('Live', [
        PREV,
        GO,
        NEXT,
        CLEAR_SLIDE,
        CLEAR_ALL,
        section(0),
        section(1),
        section(2),
        section(3),
        CLEAR_L3,
        nextItem(0),
        nextItem(1),
        nextItem(2),
        LOGO,
        more,
      ]),
      page('Stage', [
        msg(0),
        msg(1),
        msg(2),
        msg(3),
        msg(4),
        DISMISS,
        T_START,
        T_STOP,
        T_RESET,
        CLEAR_PROPS,
        PREV_ITEM,
        NEXT_ITEM,
        undefined,
        undefined,
        more,
      ]),
      page('Audio', [
        MUTE,
        DOWN,
        UP,
        FADE,
        undefined,
        PLAY,
        RESTART,
        CLEAR_MEDIA,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        more,
      ]),
    ];
  }
  if (keys === 32) {
    const live: (K | undefined)[] = [
      PREV,
      GO,
      NEXT,
      CLEAR_SLIDE,
      CLEAR_L3,
      CLEAR_PROPS,
      CLEAR_MEDIA,
      CLEAR_ALL,
      ...Array.from({ length: 8 }, (_, i) => section(i)),
      section(8),
      section(9),
      section(10),
      section(11),
      nextItem(0),
      nextItem(1),
      nextItem(2),
      LOGO,
      PLAY,
      RESTART,
      MUTE,
      FADE,
      msg(0),
      msg(1),
      DISMISS,
      more,
    ];
    const stage: (K | undefined)[] = [
      ...Array.from({ length: 8 }, (_, i) => msg(i)),
      DISMISS,
      T_START,
      T_STOP,
      T_RESET,
      CLEAR_PROPS,
      LOGO,
      PREV_ITEM,
      NEXT_ITEM,
    ];
    const audio: (K | undefined)[] = [MUTE, DOWN, UP, FADE, undefined, PLAY, RESTART, CLEAR_MEDIA];
    return [page('Live', live), page('Stage', fit(stage, 32)), page('Audio', fit(audio, 32))];
  }
  // Other sizes (Pedal, Studio, Neo variants...): priority order.
  return [
    page(
      'Live',
      fit([GO, NEXT, PREV, CLEAR_SLIDE, CLEAR_ALL, LOGO, CLEAR_L3, PLAY, section(0), section(1)], keys),
    ),
    page('Stage', fit([msg(0), msg(1), msg(2), DISMISS, T_START, T_STOP, T_RESET], keys)),
    page('Audio', fit([MUTE, DOWN, UP, FADE, PLAY, RESTART], keys)),
  ];
}

/** How one key looks: a pure function of the key binding and the deck view. */
export type KeyFace = {
  label: string;
  sub?: string;
  /** CSS colours. */
  bg: string;
  fg: string;
  /** Outline drawn inside the key (live highlight). */
  ring?: string;
  dim?: boolean;
};

export const BLANK_FACE: KeyFace = { label: '', bg: '#000000', fg: '#000000' };

const COLORS = {
  go: '#1f8f3a',
  nav: '#2b2f36',
  clear: '#7a1d1d',
  clearAll: '#b3261e',
  section: '#1d3f7a',
  sectionLive: '#f2c200',
  next: '#33363d',
  media: '#5a2d82',
  audio: '#0f5f66',
  stage: '#7a4e12',
  page: '#16181c',
  on: '#e8eaed',
};

function actionColor(id: ActionId): string {
  switch (id) {
    case 'go':
      return COLORS.go;
    case 'clearAll':
      return COLORS.clearAll;
    case 'clearSlide':
    case 'clearLowerThird':
    case 'clearProps':
    case 'clearMedia':
    case 'clearBackground':
      return COLORS.clear;
    case 'mediaPlayPause':
    case 'mediaRestart':
      return COLORS.media;
    case 'audioMute':
    case 'audioMasterUp':
    case 'audioMasterDown':
    case 'audioFadeOut':
      return COLORS.audio;
    case 'messagePreset':
    case 'messageDismiss':
    case 'timerStart':
    case 'timerStop':
    case 'timerReset':
      return COLORS.stage;
    default:
      return COLORS.nav;
  }
}

function fmtDb(db: number | undefined): string | undefined {
  if (db === undefined || !Number.isFinite(db)) return undefined;
  return `${db > 0 ? '+' : ''}${Math.round(db * 10) / 10} dB`;
}

/**
 * Decide a key's label and colours from its binding and the deck view. `confirming` is true for 2 s after a
 * first press of a key that needs confirmation (Clear all).
 */
export function keyFace(
  key: StreamDeckKey | undefined,
  view: DeckView,
  opts: { confirming?: boolean; pages?: StreamDeckPage[]; pageIndex?: number } = {},
): KeyFace {
  if (!key) return BLANK_FACE;
  const dim = !view.connected;
  const target = pageTarget(key);
  if (target !== undefined) {
    let label = 'More';
    if (target !== 'next' && target !== 'prev') label = target;
    else if (opts.pages && opts.pages.length > 1) {
      const nextIdx = resolvePageTarget(opts.pages, opts.pageIndex ?? 0, target);
      label = opts.pages[nextIdx]?.name ?? label;
    }
    return { label, sub: 'page', bg: COLORS.page, fg: '#9aa0a6' };
  }
  if (key.dynamic === 'section') {
    const s = view.sections[key.dynamicIndex ?? 0];
    if (!s) return { ...BLANK_FACE, dim };
    const live = view.liveSectionPos !== undefined && s.pos === view.liveSectionPos;
    return live
      ? {
          label: s.short || s.label,
          sub: s.label,
          bg: COLORS.sectionLive,
          fg: '#000000',
          ring: '#ffffff',
          dim,
        }
      : { label: s.short || s.label, sub: s.label, bg: key.color ?? COLORS.section, fg: '#ffffff', dim };
  }
  if (key.dynamic === 'nextItem') {
    const i = key.dynamicIndex ?? 0;
    const title = view.nextItems[i];
    if (!title) return { ...BLANK_FACE, dim };
    return { label: title, sub: `Next ${i + 1}`, bg: key.color ?? COLORS.next, fg: '#ffffff', dim };
  }
  const action = key.action;
  if (!action) {
    return key.label ? { label: key.label, bg: key.color ?? COLORS.page, fg: '#ffffff', dim } : BLANK_FACE;
  }
  const bg = key.color ?? actionColor(action.id);
  let label = key.label ?? action.id;
  let sub: string | undefined;
  let face: KeyFace = { label, bg, fg: '#ffffff', dim };
  switch (action.id) {
    case 'go':
      if (!view.connected) sub = 'offline';
      else if (view.liveLabel) sub = view.liveLabel;
      break;
    case 'clearAll':
      if (opts.confirming) {
        label = 'Again to clear';
        face = { ...face, bg: '#ff3b30', ring: '#ffffff' };
      } else if (view.black) {
        sub = 'black';
        face = { ...face, ring: '#ff8a80' };
      }
      break;
    case 'logo':
      if (view.logo) face = { ...face, bg: COLORS.on, fg: '#000000', ring: '#ffffff' };
      sub = view.logo ? 'on' : undefined;
      break;
    case 'mediaPlayPause':
      label = view.mediaPlaying ? 'Pause' : (key.label ?? 'Play');
      if (view.mediaPlaying) face = { ...face, ring: '#d0a8ff' };
      if (view.slideSoundWaiting) sub = 'sound';
      break;
    case 'audioMasterUp':
    case 'audioMasterDown':
    case 'audioMute':
      sub = fmtDb(view.masterDb);
      break;
    default:
      break;
  }
  return { ...face, label, ...(sub ? { sub } : {}) };
}

/** Stable key for change detection: redraw only keys whose face changed. */
export function faceKey(f: KeyFace): string {
  return `${f.label}|${f.sub ?? ''}|${f.bg}|${f.fg}|${f.ring ?? ''}|${f.dim ? 1 : 0}`;
}

/** Text for the Plus touch strip. */
export function lcdText(view: DeckView, pageName?: string): { title: string; sub: string } {
  const live = view.sections.find((s) => s.pos === view.liveSectionPos);
  const title = view.liveLabel ?? live?.label ?? (view.black ? 'Black' : '—');
  const parts: string[] = [];
  if (pageName) parts.push(pageName);
  const db = fmtDb(view.masterDb);
  if (db) parts.push(`Master ${db}`);
  if (view.nextItems[0]) parts.push(`Next: ${view.nextItems[0]}`);
  if (!view.connected) parts.push('offline');
  return { title, sub: parts.join('  ·  ') };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function sanitizeKey(raw: unknown): StreamDeckKey | undefined {
  if (!isObj(raw)) return undefined;
  const k: StreamDeckKey = {};
  const a = raw.action;
  if (isObj(a) && ActionId.safeParse(a.id).success) {
    const arg = a.arg;
    k.action =
      (typeof arg === 'number' && Number.isFinite(arg)) || (typeof arg === 'string' && arg.length <= 200)
        ? { id: a.id as ActionId, arg }
        : { id: a.id as ActionId };
  }
  if (raw.dynamic === 'section' || raw.dynamic === 'nextItem') k.dynamic = raw.dynamic;
  const di = raw.dynamicIndex;
  if (typeof di === 'number' && Number.isInteger(di) && di >= 0 && di <= 10_000) k.dynamicIndex = di;
  if (typeof raw.label === 'string') k.label = raw.label.slice(0, 200);
  if (typeof raw.color === 'string' && raw.color.length <= 100) k.color = raw.color;
  return k.action || k.dynamic || k.label ? k : undefined;
}

/**
 * Stream Deck pages as stored in settings are untrusted JSON (older versions, hand edits, a failed write):
 * keep what is well-formed, drop the rest. Pages without a name are named by position; slots must be key
 * indices; a key keeps only its valid fields and is dropped when nothing usable is left.
 */
export function sanitizeDeckPages(raw: unknown): StreamDeckPage[] {
  if (!Array.isArray(raw)) return [];
  const out: StreamDeckPage[] = [];
  raw.slice(0, 100).forEach((p, i) => {
    if (!isObj(p)) return;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 200) : `Page ${i + 1}`;
    const keys: Record<string, StreamDeckKey> = {};
    if (isObj(p.keys)) {
      for (const [slot, v] of Object.entries(p.keys).slice(0, 200)) {
        if (!/^\d{1,3}$/.test(slot)) continue;
        const k = sanitizeKey(v);
        if (k) keys[String(Number(slot))] = k;
      }
    }
    out.push({ name, keys });
  });
  return out;
}
