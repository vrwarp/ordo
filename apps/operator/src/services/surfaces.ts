import type { LiveState } from '@ordo/domain';
import {
  type DeckInfo,
  defaultDeckPages,
  isModifierOnly,
  KeyboardDriver,
  MidiDriver,
  type MidiInputInfo,
  type MidiOutputInfo,
  normalizeCombo,
  StreamDeckDriver,
} from '@ordo/surfaces';
import { create } from 'zustand';
import { HoldGuard } from '../lib/confirm.ts';
import { deckView } from '../lib/deckView.ts';
import { saveSettings } from '../state/library.ts';
import { useLibrary } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import type { Controller } from './controller.ts';
import { log } from './log.ts';

export type SurfacesStore = {
  deck: DeckInfo | null;
  midiEnabled: boolean;
  midiReady: boolean;
  midiInputs: MidiInputInfo[];
  midiOutputs: MidiOutputInfo[];
  lastMidiMessage: { kind: string; channel: number; number: number; value: number; time: number } | null;
  keyboardActive: boolean;
};
export const useSurfaces = create<SurfacesStore>(() => ({
  deck: null,
  midiEnabled: false,
  midiReady: false,
  midiInputs: [],
  midiOutputs: [],
  lastMidiMessage: null,
  keyboardActive: false,
}));

/** Hold the clear-all key this long to clear without the second press (prd/02). */
export const CLEAR_HOLD_MS = 1000;

function inTextField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? '') ||
      (typeof t.closest === 'function' && !!t.closest('[data-keys="off"]')))
  );
}

/** Wires the keyboard, Stream Deck and MIDI drivers to the controller's single dispatch. */
export class Surfaces {
  readonly keyboard: KeyboardDriver;
  readonly deck: StreamDeckDriver;
  readonly midi: MidiDriver;
  private unsub: (() => void)[] = [];
  private attached = false;
  private lastView = '';
  private hold = new HoldGuard(CLEAR_HOLD_MS);
  /**
   * Clear all "or hold": the keydown (handled by the KeyboardDriver) arms the double-press confirm; holding
   * the key for CLEAR_HOLD_MS sends the confirming press. Auto-repeat keydowns are ignored by the driver.
   */
  private onHoldDown = (e: KeyboardEvent) => {
    if (e.repeat || e.isComposing || isModifierOnly(e) || inTextField(e)) return;
    const a = useLibrary.getState().data.settings.keymap[normalizeCombo(e)];
    if (a?.id !== 'clearAll') return;
    this.hold.down(() => {
      if (useLive.getState().clearAllUntil !== undefined) this.ctl.dispatch({ id: 'clearAll' }, 'keyboard');
    });
  };
  private onHoldUp = () => this.hold.up();

  private ctl: Controller;
  constructor(ctl: Controller) {
    this.ctl = ctl;
    const s = useLibrary.getState().data.settings;
    this.keyboard = new KeyboardDriver(s.keymap, ctl.dispatch);
    this.deck = new StreamDeckDriver(ctl.dispatch);
    this.midi = new MidiDriver(ctl.dispatch);
    this.midi.setMappings(s.surfaces.midi);
    // Key images are drawn in the core worker; HID writes stay here (WebHID needs the window).
    this.deck.renderer = ctl.core.deckRenderer;
    this.deck.onError = (d) => this.fault(`stream deck: ${d}`);
    this.midi.onError = (d) => this.fault(`midi: ${d}`);
    this.midi.onInputs = (inputs) => useSurfaces.setState({ midiInputs: inputs });
    this.midi.onOutputs = (outputs) => useSurfaces.setState({ midiOutputs: outputs });
    this.midi.onMessage = (msg) => useSurfaces.setState({ lastMidiMessage: { ...msg, time: Date.now() } });
    this.unsub.push(
      useLibrary.subscribe((st, prev) => {
        const a = st.data.settings;
        const b = prev.data.settings;
        if (a.keymap !== b.keymap) this.keyboard.setMap(a.keymap);
        if (a.surfaces.midi !== b.surfaces.midi) this.midi.setMappings(a.surfaces.midi);
        if (a.surfaces.midiEnabled !== b.surfaces.midiEnabled) {
          if (a.surfaces.midiEnabled) void this.startMidi();
          else this.stopMidi();
        }
        if (a.surfaces.streamDeckPages !== b.surfaces.streamDeckPages) this.applyDeckPages();
        if (a.audio.masterDb !== b.audio.masterDb) this.pushView(useLive.getState().state);
      }),
      useLive.subscribe((st, prev) => {
        if (st.state !== prev.state || st.hubConnected !== prev.hubConnected) this.pushView(st.state);
        if (st.state.live !== prev.state.live && st.state.live !== undefined) {
          const liveCue = st.state.cues[st.state.live];
          if (liveCue?.midiCues?.length) {
            this.midi.sendCues(liveCue.midiCues);
          }
        }
      }),
    );
  }

  async start(): Promise<void> {
    try {
      const info = await this.deck.autoConnect();
      if (info) this.onDeck(info);
    } catch (e) {
      this.fault(`stream deck: ${String(e)}`);
    }
    const s = useLibrary.getState().data.settings;
    if (s.surfaces.midiEnabled) {
      await this.startMidi();
    }
  }

  async enableMidi(): Promise<boolean> {
    const ok = await this.startMidi();
    if (ok) {
      const cur = useLibrary.getState().data.settings;
      if (!cur.surfaces.midiEnabled) {
        await saveSettings('surfaces', { ...cur.surfaces, midiEnabled: true }).catch((e) =>
          this.fault(`save midiEnabled: ${String(e)}`),
        );
      }
    }
    return ok;
  }

  async disableMidi(): Promise<void> {
    this.stopMidi();
    const cur = useLibrary.getState().data.settings;
    if (cur.surfaces.midiEnabled) {
      await saveSettings('surfaces', { ...cur.surfaces, midiEnabled: false }).catch((e) =>
        this.fault(`save midiEnabled: ${String(e)}`),
      );
    }
  }

  private stopMidi(): void {
    this.midi.dispose();
    useSurfaces.setState({ midiEnabled: false, midiReady: false, midiInputs: [], midiOutputs: [] });
  }

  private async startMidi(): Promise<boolean> {
    try {
      const ok = await this.midi.start();
      useSurfaces.setState({
        midiEnabled: ok,
        midiReady: ok,
        midiInputs: ok ? this.midi.inputs() : [],
        midiOutputs: ok ? this.midi.outputs() : [],
      });
      return ok;
    } catch (e) {
      this.fault(`midi: ${String(e)}`);
      useSurfaces.setState({ midiEnabled: false, midiReady: false, midiInputs: [], midiOutputs: [] });
      return false;
    }
  }

  /** A Stream Deck or MIDI error: logged and counted against the surfaces budget (design/25). */
  private fault(detail: string): void {
    log('warn', detail);
    const r = this.ctl.core.budgets.record('surface', detail);
    if (r.exceeded) log('error', `error budget exceeded: surface (${r.count} in the window)`);
  }

  /** Keys act only on operator screens; the editor and key recorder turn them off. */
  setKeyboard(on: boolean): void {
    if (on === this.attached) return;
    this.attached = on;
    if (on) {
      this.keyboard.attach(window);
      window.addEventListener('keydown', this.onHoldDown);
      window.addEventListener('keyup', this.onHoldUp);
      window.addEventListener('blur', this.onHoldUp);
    } else {
      this.keyboard.detach(window);
      window.removeEventListener('keydown', this.onHoldDown);
      window.removeEventListener('keyup', this.onHoldUp);
      window.removeEventListener('blur', this.onHoldUp);
      this.hold.cancel();
    }
    useSurfaces.setState({ keyboardActive: on });
  }

  async connectDeck(): Promise<DeckInfo | null> {
    const info = await this.deck.connect();
    if (info) this.onDeck(info);
    return info;
  }

  refreshMidi(): void {
    useSurfaces.setState({ midiInputs: this.midi.inputs(), midiOutputs: this.midi.outputs() });
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
