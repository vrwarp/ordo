import type { LiveState } from '@ordo/domain';
import {
  type DeckInfo,
  defaultDeckPages,
  KeyboardDriver,
  MidiDriver,
  type MidiInputInfo,
  StreamDeckDriver,
} from '@ordo/surfaces';
import { create } from 'zustand';
import { deckView } from '../lib/deckView.ts';
import { useLibrary } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import type { Controller } from './controller.ts';
import { log } from './log.ts';

export type SurfacesStore = {
  deck: DeckInfo | null;
  midiReady: boolean;
  midiInputs: MidiInputInfo[];
  keyboardActive: boolean;
};
export const useSurfaces = create<SurfacesStore>(() => ({
  deck: null,
  midiReady: false,
  midiInputs: [],
  keyboardActive: false,
}));

/** Wires the keyboard, Stream Deck and MIDI drivers to the controller's single dispatch. */
export class Surfaces {
  readonly keyboard: KeyboardDriver;
  readonly deck: StreamDeckDriver;
  readonly midi: MidiDriver;
  private unsub: (() => void)[] = [];
  private attached = false;
  private lastView = '';

  constructor(ctl: Controller) {
    const s = useLibrary.getState().data.settings;
    this.keyboard = new KeyboardDriver(s.keymap, ctl.dispatch);
    this.deck = new StreamDeckDriver(ctl.dispatch);
    this.midi = new MidiDriver(ctl.dispatch);
    this.midi.setMappings(s.surfaces.midi);
    this.unsub.push(
      useLibrary.subscribe((st, prev) => {
        const a = st.data.settings;
        const b = prev.data.settings;
        if (a.keymap !== b.keymap) this.keyboard.setMap(a.keymap);
        if (a.surfaces.midi !== b.surfaces.midi) this.midi.setMappings(a.surfaces.midi);
        if (a.surfaces.streamDeckPages !== b.surfaces.streamDeckPages) this.applyDeckPages();
        if (a.audio.masterDb !== b.audio.masterDb) this.pushView(useLive.getState().state);
      }),
      useLive.subscribe((st, prev) => {
        if (st.state !== prev.state || st.hubConnected !== prev.hubConnected) this.pushView(st.state);
      }),
    );
  }

  async start(): Promise<void> {
    try {
      const info = await this.deck.autoConnect();
      if (info) this.onDeck(info);
    } catch (e) {
      log('warn', `stream deck: ${String(e)}`);
    }
    try {
      const ok = await this.midi.start();
      useSurfaces.setState({ midiReady: ok, midiInputs: ok ? this.midi.inputs() : [] });
    } catch (e) {
      log('warn', `midi: ${String(e)}`);
    }
  }

  /** Keys act only on operator screens; the editor and key recorder turn them off. */
  setKeyboard(on: boolean): void {
    if (on === this.attached) return;
    this.attached = on;
    if (on) this.keyboard.attach(window);
    else this.keyboard.detach(window);
    useSurfaces.setState({ keyboardActive: on });
  }

  async connectDeck(): Promise<DeckInfo | null> {
    const info = await this.deck.connect();
    if (info) this.onDeck(info);
    return info;
  }

  refreshMidi(): void {
    useSurfaces.setState({ midiInputs: this.midi.inputs() });
  }

  private onDeck(info: DeckInfo): void {
    useSurfaces.setState({ deck: info });
    this.applyDeckPages();
    this.lastView = '';
    this.pushView(useLive.getState().state);
  }

  private applyDeckPages(): void {
    const info = this.deck.info ?? useSurfaces.getState().deck;
    const pages = useLibrary.getState().data.settings.surfaces.streamDeckPages;
    this.deck.setPages(pages.length ? pages : defaultDeckPages(info?.keys ?? 15));
  }

  private pushView(s: LiveState): void {
    const v = deckView(
      s,
      useLive.getState().hubConnected || useLive.getState().authority === 'fallback',
      useLibrary.getState().data.settings.audio.masterDb,
    );
    const key = JSON.stringify(v);
    if (key === this.lastView) return;
    this.lastView = key;
    this.deck.setView(v);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.setKeyboard(false);
    this.deck.dispose();
    this.midi.dispose();
  }
}

let current: Surfaces | undefined;
export function surfaces(): Surfaces | undefined {
  return current;
}
export function installSurfaces(ctl: Controller): Surfaces {
  current?.dispose();
  current = new Surfaces(ctl);
  void current.start();
  return current;
}
