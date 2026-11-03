import { type MidiMapping, newId } from '@ordo/domain';
import type { Action, Dispatch } from './types.ts';

export type MidiInputInfo = { id: string; name: string };

/** A parsed channel-voice message, or null for anything else (clock, sysex, aftertouch...). */
export type MidiMessage = {
  kind: 'noteOn' | 'noteOff' | 'cc';
  channel: number;
  number: number;
  value: number;
};

export function parseMidi(data: Uint8Array): MidiMessage | null {
  if (data.length < 3) return null;
  const status = data[0]!;
  if (status < 0x80 || status >= 0xf0) return null;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const number = data[1]! & 0x7f;
  const value = data[2]! & 0x7f;
  if (type === 0x90) return { kind: value === 0 ? 'noteOff' : 'noteOn', channel, number, value };
  if (type === 0x80) return { kind: 'noteOff', channel, number, value };
  if (type === 0xb0) return { kind: 'cc', channel, number, value };
  return null;
}

function deviceMatches(m: MidiMapping, deviceName: string): boolean {
  return !m.deviceName || m.deviceName.trim().toLowerCase() === deviceName.trim().toLowerCase();
}

/** Pure matcher used by the MIDI driver; exported for tests. Edge-triggered for CC. */
export function matchMidi(
  mappings: MidiMapping[],
  deviceName: string,
  data: Uint8Array,
  lastCc: Map<string, number>,
): Action[] {
  const msg = parseMidi(data);
  if (!msg || msg.kind === 'noteOff') return [];
  const out: Action[] = [];
  let prev = 0;
  if (msg.kind === 'cc') {
    const key = `${deviceName}|${msg.channel}|${msg.number}`;
    prev = lastCc.get(key) ?? 0;
    lastCc.set(key, msg.value);
  }
  for (const m of mappings) {
    if (m.number !== msg.number) continue;
    if (m.channel !== undefined && m.channel !== msg.channel) continue;
    if (!deviceMatches(m, deviceName)) continue;
    const threshold = m.threshold ?? 64;
    if (m.kind === 'note' && msg.kind === 'noteOn') {
      if (msg.value >= Math.max(1, threshold)) out.push(actionOf(m));
    } else if (m.kind === 'cc' && msg.kind === 'cc') {
      const t = Math.max(1, threshold);
      if (prev < t && msg.value >= t) out.push(actionOf(m));
    }
  }
  return out;
}

function actionOf(m: MidiMapping): Action {
  return m.action.arg === undefined ? { id: m.action.id } : { id: m.action.id, arg: m.action.arg };
}

/** The mapping a learn session captures from one message, or null if the message does not qualify. */
export function learnFrom(
  action: Action,
  deviceName: string,
  data: Uint8Array,
  lastCc: Map<string, number>,
): MidiMapping | null {
  const msg = parseMidi(data);
  if (!msg) return null;
  if (msg.kind === 'noteOn') {
    return {
      id: newId(),
      deviceName,
      kind: 'note',
      number: msg.number,
      channel: msg.channel,
      threshold: 1,
      action,
    };
  }
  if (msg.kind === 'cc') {
    const key = `${deviceName}|${msg.channel}|${msg.number}`;
    const prev = lastCc.get(key) ?? 0;
    lastCc.set(key, msg.value);
    // Wait for an upward press so a released pedal (value 0) is not captured.
    if (prev < 64 && msg.value >= 64) {
      return {
        id: newId(),
        deviceName,
        kind: 'cc',
        number: msg.number,
        channel: msg.channel,
        threshold: 64,
        action,
      };
    }
  }
  return null;
}

type Learning = {
  action: Action;
  resolve: (m: MidiMapping | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class MidiDriver {
  private access: MIDIAccess | null = null;
  private mappings: MidiMapping[] = [];
  private lastCc = new Map<string, number>();
  private bound = new Map<string, MIDIInput>();
  private learning: Learning | null = null;
  /** Called when the input list changes. */
  onInputs?: (inputs: MidiInputInfo[]) => void;

  constructor(private dispatch: Dispatch) {}

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  async start(): Promise<boolean> {
    if (this.access) return true;
    if (!MidiDriver.supported) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      console.warn('[midi] access denied', e);
      return false;
    }
    this.access.onstatechange = () => this.bindInputs();
    this.bindInputs();
    return true;
  }

  inputs(): MidiInputInfo[] {
    if (!this.access) return [];
    const out: MidiInputInfo[] = [];
    this.access.inputs.forEach((input) => {
      if (input.state === 'connected') out.push({ id: input.id, name: input.name ?? input.id });
    });
    return out;
  }

  setMappings(m: MidiMapping[]): void {
    this.mappings = m;
  }

  /** Resolve with a mapping for the next qualifying message, or null after `timeoutMs`. */
  learn(action: Action, timeoutMs = 5000): Promise<MidiMapping | null> {
    this.cancelLearn();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.learning?.timer === timer) this.learning = null;
        resolve(null);
      }, timeoutMs);
      this.learning = { action, resolve, timer };
    });
  }

  cancelLearn(): void {
    const l = this.learning;
    if (!l) return;
    this.learning = null;
    clearTimeout(l.timer);
    l.resolve(null);
  }

  dispose(): void {
    this.cancelLearn();
    for (const input of this.bound.values()) input.onmidimessage = null;
    this.bound.clear();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
  }

  /** Feed a message as if it came from `deviceName` (used by the driver and tests). */
  handle(deviceName: string, data: Uint8Array): void {
    const l = this.learning;
    if (l) {
      const m = learnFrom(l.action, deviceName, data, this.lastCc);
      if (m) {
        this.learning = null;
        clearTimeout(l.timer);
        l.resolve(m);
      }
      return;
    }
    for (const a of matchMidi(this.mappings, deviceName, data, this.lastCc)) this.fire(a);
  }

  protected fire(a: Action): void {
    this.dispatch(a, 'midi');
  }

  private bindInputs() {
    const access = this.access;
    if (!access) return;
    const seen = new Set<string>();
    access.inputs.forEach((input) => {
      seen.add(input.id);
      if (input.state !== 'connected') return;
      if (this.bound.get(input.id) === input && input.onmidimessage) return;
      const name = input.name ?? input.id;
      input.onmidimessage = (ev: MIDIMessageEvent) => {
        if (ev.data) this.handle(name, ev.data);
      };
      this.bound.set(input.id, input);
    });
    for (const [id, input] of this.bound) {
      if (!seen.has(id) || input.state !== 'connected') {
        input.onmidimessage = null;
        this.bound.delete(id);
      }
    }
    this.onInputs?.(this.inputs());
  }
}
