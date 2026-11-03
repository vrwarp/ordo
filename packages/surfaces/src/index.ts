/**
 * Control surfaces (design/19). STUB for the drivers: signatures are the contract; implementations are
 * filled in later. `normalizeCombo` and `KeyboardDriver` are complete.
 */
import type { ActionId, KeyMap, MidiMapping, StreamDeckPage } from '@ordo/domain';

export type Action = { id: ActionId; arg?: number | string };
export type Dispatch = (a: Action, source: 'keyboard' | 'streamdeck' | 'midi' | 'ui') => void;

/** Normalize a keyboard event to a combo string like `Ctrl+Shift+L`, `Space`, `F2`, `Digit1`, `ArrowRight`. */
export function normalizeCombo(
  e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.code || e.key;
  if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
  parts.push(key);
  return parts.join('+');
}

/** Keyboard driver: keydown on window, no debounce; ignores events from text inputs. */
export class KeyboardDriver {
  private handler = (e: KeyboardEvent) => this.onKey(e);
  constructor(
    private map: KeyMap,
    private dispatch: Dispatch,
  ) {}
  setMap(map: KeyMap): void {
    this.map = map;
  }
  attach(target: Window = window): void {
    target.addEventListener('keydown', this.handler);
  }
  detach(target: Window = window): void {
    target.removeEventListener('keydown', this.handler);
  }
  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.repeat && !/^Arrow|Space/.test(e.code)) return;
    const combo = normalizeCombo(e);
    const a = this.map[combo];
    if (!a) return;
    e.preventDefault();
    this.dispatch({ id: a.id, arg: a.arg }, 'keyboard');
  }
}

/** What the Stream Deck shows; derived from live state by the operator app. */
export type DeckView = {
  sections: { short: string; label: string; pos: number }[];
  liveSectionPos?: number;
  nextItems: string[];
  black: boolean;
  logo: boolean;
  mediaPlaying: boolean;
  liveLabel?: string;
  connected: boolean;
  masterDb?: number;
};

export type DeckInfo = { model: string; keys: number; columns: number; dials: number };

export class StreamDeckDriver {
  constructor(private dispatch: Dispatch) {}
  /** Prompt the user to pick a device (needs a user gesture). */
  async connect(): Promise<DeckInfo | null> {
    return null;
  }
  /** Reopen previously granted devices without a prompt. */
  async autoConnect(): Promise<DeckInfo | null> {
    return null;
  }
  get info(): DeckInfo | null {
    return null;
  }
  setPages(_pages: StreamDeckPage[]): void {}
  setPage(_index: number): void {}
  setView(_view: DeckView): void {}
  dispose(): void {}
  protected fire(a: Action): void {
    this.dispatch(a, 'streamdeck');
  }
}

/** Default pages for a deck with `keys` keys. */
export function defaultDeckPages(_keys: number): StreamDeckPage[] {
  return [];
}

export type MidiInputInfo = { id: string; name: string };

export class MidiDriver {
  constructor(private dispatch: Dispatch) {}
  async start(): Promise<boolean> {
    return false;
  }
  inputs(): MidiInputInfo[] {
    return [];
  }
  setMappings(_m: MidiMapping[]): void {}
  /** Resolve with a mapping for the next qualifying message, or null after `timeoutMs`. */
  learn(_action: Action, _timeoutMs = 5000): Promise<MidiMapping | null> {
    return Promise.resolve(null);
  }
  dispose(): void {}
  protected fire(a: Action): void {
    this.dispatch(a, 'midi');
  }
}

/** Pure matcher used by the MIDI driver; exported for tests. Edge-triggered for CC. */
export function matchMidi(
  _mappings: MidiMapping[],
  _deviceName: string,
  _data: Uint8Array,
  _lastCc: Map<string, number>,
): Action[] {
  return [];
}
