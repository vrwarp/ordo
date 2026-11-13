import type { StreamDeckKey, StreamDeckPage } from '@ordo/domain';
import {
  getStreamDecks,
  requestStreamDecks,
  type StreamDeckWeb,
  VENDOR_ID,
} from '@elgato-stream-deck/webhid';
import {
  BLANK_FACE,
  type DeckView,
  type KeyFace,
  defaultDeckPages,
  sanitizeDeckPages,
  faceKey,
  keyFace,
  lcdText,
  pageTarget,
  resolvePageTarget,
} from './deck-model.ts';
import { createSurface, drawKey, drawStrip, pixels, type Surface } from './deck-render.ts';
import type { Action, Dispatch } from './types.ts';

export type DeckInfo = { model: string; keys: number; columns: number; dials: number };

const EMPTY_VIEW: DeckView = {
  sections: [],
  nextItems: [],
  black: false,
  logo: false,
  mediaPlaying: false,
  connected: false,
};

/** Keys that need a second press within 2 s (the operator store enforces it; the deck shows the hint). */
const CONFIRM_MS = 2000;
const CONFIRM_ACTIONS = new Set(['clearAll']);

type ButtonCtl = {
  type: 'button';
  index: number;
  feedbackType: string;
  pixelSize?: { width: number; height: number };
};
type EncoderCtl = { type: 'encoder'; index: number };
type LcdCtl = { type: 'lcd-segment'; id: number; pixelSize: { width: number; height: number } };

/** Map a Plus dial gesture to actions. Exported for tests. */
export function dialActions(dial: number, gesture: 'press' | number): Action[] | 'pageNext' | 'pageHome' {
  const repeat = (id: Action['id'], n: number): Action[] =>
    Array.from({ length: Math.min(5, Math.abs(n)) }, () => ({ id }));
  if (gesture === 'press') {
    if (dial === 0) return [{ id: 'audioMute' }];
    if (dial === 1) return [{ id: 'go' }];
    if (dial === 2) return [{ id: 'next' }];
    return 'pageHome';
  }
  if (gesture === 0) return [];
  if (dial === 0) return repeat(gesture > 0 ? 'audioMasterUp' : 'audioMasterDown', gesture);
  if (dial === 1) return repeat(gesture > 0 ? 'nextItem' : 'prevItem', gesture);
  if (dial === 2) return repeat(gesture > 0 ? 'next' : 'prev', gesture);
  return 'pageNext';
}

/**
 * Renders key images somewhere else (the operator's core worker, design/25), so a busy main thread does not
 * draw them. Null means "draw locally".
 */
export type DeckRenderer = {
  key(face: KeyFace, width: number, height: number): Promise<Uint8ClampedArray | null>;
  strip(title: string, sub: string, width: number, height: number): Promise<Uint8ClampedArray | null>;
};

export class StreamDeckDriver {
  private deck: StreamDeckWeb | null = null;
  private _info: DeckInfo | null = null;
  private buttons: ButtonCtl[] = [];
  private lcd: LcdCtl | null = null;
  private customPages: StreamDeckPage[] = [];
  private pages: StreamDeckPage[] = [];
  private pageIndex = 0;
  private view: DeckView = EMPTY_VIEW;
  private drawn = new Map<number, string>();
  private stripDrawn = '';
  private surfaces = new Map<string, Surface>();
  private confirmUntil = new Map<number, number>();
  private drawChain: Promise<void> = Promise.resolve();
  private drawQueued = false;
  private hidAttached = false;
  private disposed = false;
  private connecting: Promise<DeckInfo | null> | null = null;
  /** Called when a deck connects or disconnects. */
  onChange?: (info: DeckInfo | null) => void;
  /** Called when the page changes from the deck. */
  onPage?: (index: number, name: string) => void;
  /** Called on device and drawing errors (error budgets). */
  onError?: (detail: string) => void;
  /** Optional off-thread key image renderer; local drawing is the fallback. */
  renderer?: DeckRenderer;

  private dispatch: Dispatch;
  constructor(dispatch: Dispatch) {
    this.dispatch = dispatch;
  }

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'hid' in navigator;
  }

  /** Prompt the user to pick a device (needs a user gesture). */
  async connect(): Promise<DeckInfo | null> {
    if (!StreamDeckDriver.supported) return null;
    this.attachHid();
    try {
      const decks = await requestStreamDecks();
      const deck = decks[0];
      for (const d of decks.slice(1)) void d.close().catch(() => {});
      if (!deck) return this._info;
      await this.open(deck);
    } catch (e) {
      console.warn('[streamdeck] connect failed', e);
      this.onError?.(`connect failed: ${String(e)}`);
    }
    return this._info;
  }

  /** Reopen previously granted devices without a prompt. */
  async autoConnect(): Promise<DeckInfo | null> {
    if (!StreamDeckDriver.supported || this.disposed) return null;
    this.attachHid();
    if (this.deck) return this._info;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const decks = await getStreamDecks();
        const deck = decks[0];
        for (const d of decks.slice(1)) void d.close().catch(() => {});
        if (deck && !this.disposed) await this.open(deck);
        else if (deck) void deck.close().catch(() => {});
      } catch (e) {
        console.warn('[streamdeck] reopen failed', e);
        this.onError?.(`reopen failed: ${String(e)}`);
      } finally {
        this.connecting = null;
      }
      return this._info;
    })();
    return this.connecting;
  }

  get info(): DeckInfo | null {
    return this._info;
  }

  get page(): number {
    return this.pageIndex;
  }

  /** Pages from settings; an empty list means the built-in defaults for the connected model. */
  setPages(pages: StreamDeckPage[]): void {
    this.customPages = sanitizeDeckPages(pages);
    this.resolvePages();
    this.redrawAll();
  }

  setPage(index: number): void {
    const n = Math.max(0, Math.min(this.pages.length - 1, Math.trunc(index)));
    if (n === this.pageIndex) return;
    this.pageIndex = n;
    this.confirmUntil.clear();
    this.onPage?.(n, this.pages[n]?.name ?? '');
    this.redrawAll();
  }

  setView(view: DeckView): void {
    this.view = view;
    this.scheduleDraw();
  }

  dispose(): void {
    this.disposed = true;
    if (this.hidAttached && typeof navigator !== 'undefined' && navigator.hid) {
      navigator.hid.removeEventListener('connect', this.onHidConnect);
      navigator.hid.removeEventListener('disconnect', this.onHidDisconnect);
    }
    const deck = this.deck;
    this.deck = null;
    this._info = null;
    if (deck) {
      deck.removeAllListeners();
      void deck
        .clearPanel()
        .catch(() => {})
        .finally(() => void deck.close().catch(() => {}));
    }
  }

  protected fire(a: Action): void {
    this.dispatch(a, 'streamdeck');
  }

  // ---- internals ----

  private onHidConnect = (e: HIDConnectionEvent) => {
    if (e.device.vendorId !== VENDOR_ID || this.deck) return;
    void this.autoConnect();
  };

  private onHidDisconnect = (e: HIDConnectionEvent) => {
    if (e.device.vendorId !== VENDOR_ID || !this.deck) return;
    // The library does not expose its HIDDevice: check whether our deck still answers.
    const deck = this.deck;
    deck.getSerialNumber().then(
      () => {},
      () => this.lost(deck),
    );
    if (!e.device.opened) this.lost(deck);
  };

  private attachHid() {
    if (this.hidAttached || typeof navigator === 'undefined' || !navigator.hid) return;
    this.hidAttached = true;
    navigator.hid.addEventListener('connect', this.onHidConnect);
    navigator.hid.addEventListener('disconnect', this.onHidDisconnect);
  }

  private lost(deck: StreamDeckWeb) {
    if (this.deck !== deck) return;
    deck.removeAllListeners();
    void deck.close().catch(() => {});
    this.deck = null;
    this._info = null;
    this.onChange?.(null);
    // A replug fires `connect`; also retry shortly in case the event was missed.
    setTimeout(() => void this.autoConnect(), 1000);
  }

  private async open(deck: StreamDeckWeb) {
    if (this.deck && this.deck !== deck) {
      this.deck.removeAllListeners();
      void this.deck.close().catch(() => {});
    }
    this.deck = deck;
    const controls = deck.modelInfo.controls as unknown as (ButtonCtl | EncoderCtl | LcdCtl)[];
    this.buttons = controls
      .filter((c): c is ButtonCtl => c.type === 'button')
      .sort((x, y) => x.index - y.index);
    this.lcd = controls.find((c): c is LcdCtl => c.type === 'lcd-segment') ?? null;
    const encoders = controls.filter((c) => c.type === 'encoder').length;
    const columns =
      Math.max(
        0,
        ...(controls.filter((c) => c.type === 'button') as unknown as { column: number }[]).map(
          (c) => c.column,
        ),
      ) + 1;
    this._info = { model: deck.modelInfo.name, keys: this.buttons.length, columns, dials: encoders };
    deck.on('down', (control) => {
      if (control.type === 'button') this.onKey(control.index);
      else this.onDial(control.index, 'press');
    });
    deck.on('rotate', (control, amount) => this.onDial(control.index, amount));
    deck.on('lcdSwipe', (_c, from, to) => {
      if (Math.abs(to.x - from.x) < 40 || this.pages.length === 0) return;
      this.setPage(resolvePageTarget(this.pages, this.pageIndex, to.x < from.x ? 'next' : 'prev'));
    });
    deck.on('error', (err) => {
      console.warn('[streamdeck] device error', err);
      this.onError?.(`device error: ${String(err)}`);
      this.lost(deck);
    });
    this.resolvePages();
    this.drawn.clear();
    this.stripDrawn = '';
    try {
      await deck.setBrightness(80);
      await deck.clearPanel();
    } catch {
      // older firmware: ignore
    }
    this.onChange?.(this._info);
    this.scheduleDraw();
  }

  private resolvePages() {
    const keys = this._info?.keys ?? 15;
    this.pages = this.customPages.length > 0 ? this.customPages : defaultDeckPages(keys);
    if (this.pageIndex >= this.pages.length) this.pageIndex = 0;
  }

  private keyAt(index: number): StreamDeckKey | undefined {
    return this.pages[this.pageIndex]?.keys[String(index)];
  }

  private onKey(index: number) {
    const key = this.keyAt(index);
    if (!key) return;
    const target = pageTarget(key);
    if (target !== undefined) {
      this.setPage(resolvePageTarget(this.pages, this.pageIndex, target));
      return;
    }
    if (key.dynamic === 'section') {
      const i = key.dynamicIndex ?? 0;
      if (this.view.sections[i]) this.fire({ id: 'goToSection', arg: i });
      return;
    }
    if (key.dynamic === 'nextItem') {
      const i = key.dynamicIndex ?? 0;
      if (!this.view.nextItems[i]) return;
      for (let k = 0; k <= i; k++) this.fire({ id: 'nextItem' });
      return;
    }
    if (!key.action) return;
    if (CONFIRM_ACTIONS.has(key.action.id)) {
      const now = Date.now();
      if ((this.confirmUntil.get(index) ?? 0) > now) this.confirmUntil.delete(index);
      else {
        this.confirmUntil.set(index, now + CONFIRM_MS);
        setTimeout(() => {
          if ((this.confirmUntil.get(index) ?? 0) <= Date.now()) {
            this.confirmUntil.delete(index);
            this.scheduleDraw();
          }
        }, CONFIRM_MS + 20);
      }
      this.scheduleDraw();
    }
    this.fire(
      key.action.arg === undefined ? { id: key.action.id } : { id: key.action.id, arg: key.action.arg },
    );
  }

  private onDial(dial: number, gesture: 'press' | number) {
    const r = dialActions(dial, gesture);
    if (r === 'pageNext') {
      if (typeof gesture === 'number' && gesture !== 0)
        this.setPage(resolvePageTarget(this.pages, this.pageIndex, gesture > 0 ? 'next' : 'prev'));
      return;
    }
    if (r === 'pageHome') {
      this.setPage(0);
      return;
    }
    for (const a of r) this.fire(a);
  }

  private redrawAll() {
    this.drawn.clear();
    this.stripDrawn = '';
    this.scheduleDraw();
  }

  /** Coalesce redraws and serialize HID writes. */
  private scheduleDraw() {
    if (!this.deck || this.drawQueued) return;
    this.drawQueued = true;
    this.drawChain = this.drawChain.then(async () => {
      this.drawQueued = false;
      try {
        await this.draw();
      } catch (e) {
        console.warn('[streamdeck] draw failed', e);
        this.onError?.(`draw failed: ${String(e)}`);
      }
    });
  }

  private surface(w: number, h: number): Surface | null {
    const k = `${w}x${h}`;
    let s = this.surfaces.get(k);
    if (!s) {
      const created = createSurface(w, h);
      if (!created) return null;
      s = created;
      this.surfaces.set(k, s);
    }
    return s;
  }

  private async draw() {
    const deck = this.deck;
    if (!deck) return;
    const now = Date.now();
    for (const b of this.buttons) {
      if (b.feedbackType !== 'lcd' || !b.pixelSize) continue;
      const face = keyFace(this.keyAt(b.index), this.view, {
        confirming: (this.confirmUntil.get(b.index) ?? 0) > now,
        pages: this.pages,
        pageIndex: this.pageIndex,
      });
      const fk = faceKey(face);
      if (this.drawn.get(b.index) === fk) continue;
      this.drawn.set(b.index, fk);
      if (face === BLANK_FACE || (!face.label && !face.sub)) {
        await deck.clearKey(b.index);
        continue;
      }
      const remote = await this.renderer?.key(face, b.pixelSize.width, b.pixelSize.height).catch(() => null);
      if (remote) {
        await deck.fillKeyBuffer(b.index, remote, { format: 'rgba' });
        continue;
      }
      const s = this.surface(b.pixelSize.width, b.pixelSize.height);
      if (!s) {
        await deck.fillKeyColor(b.index, ...hexRgb(face.bg));
        continue;
      }
      drawKey(s, face);
      await deck.fillKeyBuffer(b.index, pixels(s), { format: 'rgba' });
    }
    if (this.lcd) {
      const { title, sub } = lcdText(this.view, this.pages[this.pageIndex]?.name);
      const k = `${title}|${sub}`;
      if (k !== this.stripDrawn) {
        this.stripDrawn = k;
        const { width, height } = this.lcd.pixelSize;
        const remote = await this.renderer?.strip(title, sub, width, height).catch(() => null);
        const s = remote ? null : this.surface(width, height);
        if (remote) await deck.fillLcd(this.lcd.id, remote, { format: 'rgba' });
        else if (s) {
          drawStrip(s, title, sub);
          await deck.fillLcd(this.lcd.id, pixels(s), { format: 'rgba' });
        }
      }
    }
  }
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [Number.parseInt(m[1]!, 16), Number.parseInt(m[2]!, 16), Number.parseInt(m[3]!, 16)];
}
