import { type MidiCue, type MidiCueType, type MidiMapping, newId } from '@ordo/domain';
import { formatMidiBytesHex, formatQuickQ } from './quickq.ts';
import type { Action, Dispatch } from './types.ts';

export type MidiInputInfo = { id: string; name: string };
export type MidiOutputInfo = { id: string; name: string };

/** A parsed channel-voice message, or null for anything else (clock, sysex, aftertouch...). */
export type MidiMessage = {
  kind: 'noteOn' | 'noteOff' | 'cc' | 'programChange';
  channel: number;
  number: number;
  value: number;
};

/** Structured bidirectional MIDI log entry for debugging and live monitoring. */
export type MidiActivityEvent = {
  id: number;
  time: number;
  direction: 'in' | 'out';
  device: string;
  hex: string;
  message: MidiMessage;
  quickq: string | null;
  status: 'sent' | 'dropped' | 'matched' | 'unmatched';
  /** Matched action(s) for IN, or source/drop reason for OUT. */
  detail?: string;
  /** True when an incoming message echoes a message we just sent within 50 ms. */
  loopWarning?: boolean;
};

const LOOP_WINDOW_MS = 50;

export function parseMidi(data: Uint8Array): MidiMessage | null {
  if (data.length < 2) return null;
  const status = data[0]!;
  if (status < 0x80 || status >= 0xf0) return null;
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  const number = data[1]! & 0x7f;
  if (type === 0xc0) {
    return { kind: 'programChange', channel, number, value: number };
  }
  if (data.length < 3) return null;
  const value = data[2]! & 0x7f;
  if (type === 0x90) return { kind: value === 0 ? 'noteOff' : 'noteOn', channel, number, value };
  if (type === 0x80) return { kind: 'noteOff', channel, number, value };
  if (type === 0xb0) return { kind: 'cc', channel, number, value };
  return null;
}

function deviceMatches(m: MidiMapping, deviceName: string): boolean {
  return !m.deviceName || m.deviceName.trim().toLowerCase() === deviceName.trim().toLowerCase();
}

/** Pure matcher used by the MIDI driver; exported for tests. Supports static and dynamic velocity/value parameters. */
export function matchMidi(
  mappings: MidiMapping[],
  deviceName: string,
  data: Uint8Array,
  lastCc: Map<string, number>,
): Action[] {
  const msg = parseMidi(data);
  if (!msg) return [];
  const out: Action[] = [];
  let prev = 0;
  if (msg.kind === 'cc') {
    const key = `${deviceName}|${msg.channel}|${msg.number}`;
    prev = lastCc.get(key) ?? 0;
    lastCc.set(key, msg.value);
  }
  for (const m of mappings) {
    if (m.channel !== undefined && m.channel !== msg.channel) continue;
    if (!deviceMatches(m, deviceName)) continue;
    const paramSource = m.paramSource ?? 'static';
    const threshold = m.threshold ?? 64;

    if (m.kind === 'note' && msg.kind === 'noteOn') {
      if (m.number !== msg.number) continue;
      if (paramSource === 'velocity') {
        if (msg.value >= 1) out.push({ id: m.action.id, arg: msg.value });
      } else {
        if (msg.value >= Math.max(1, threshold)) out.push(actionOf(m));
      }
    } else if (m.kind === 'noteOff' && msg.kind === 'noteOff') {
      if (m.number !== msg.number) continue;
      if (paramSource === 'velocity') {
        out.push({ id: m.action.id, arg: msg.value });
      } else {
        out.push(actionOf(m));
      }
    } else if (m.kind === 'cc' && msg.kind === 'cc') {
      if (m.number !== msg.number) continue;
      if (paramSource === 'ccValue') {
        if (msg.value !== prev) out.push({ id: m.action.id, arg: msg.value });
      } else {
        const t = Math.max(1, threshold);
        if (prev < t && msg.value >= t) out.push(actionOf(m));
      }
    } else if (m.kind === 'programChange' && msg.kind === 'programChange') {
      if (m.number !== msg.number) continue;
      if (paramSource === 'velocity' || paramSource === 'ccValue') {
        out.push({ id: m.action.id, arg: msg.number + 1 });
      } else {
        out.push(actionOf(m));
      }
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
  opts?: { acceptNoteOff?: boolean },
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
  if (msg.kind === 'noteOff' && opts?.acceptNoteOff) {
    return {
      id: newId(),
      deviceName,
      kind: 'noteOff',
      number: msg.number,
      channel: msg.channel,
      threshold: 0,
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
  if (msg.kind === 'programChange') {
    return {
      id: newId(),
      deviceName,
      kind: 'programChange',
      number: msg.number,
      channel: msg.channel,
      threshold: 0,
      action,
    };
  }
  return null;
}

type Learning = {
  action: Action;
  acceptNoteOff?: boolean;
  resolve: (m: MidiMapping | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type MidiAccessErrorInfo = {
  kind: 'denied' | 'platform' | 'unsupported' | 'unknown';
  message: string;
  hint: string;
};

/** Classify a `navigator.requestMIDIAccess()` rejection into a clear, actionable message. */
export function formatMidiAccessError(err: unknown): MidiAccessErrorInfo {
  const name =
    err instanceof Error
      ? err.name
      : typeof err === 'object' && err !== null && 'name' in err
        ? String((err as { name: unknown }).name)
        : '';
  const raw = err instanceof Error ? err.message : String(err);
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      kind: 'denied',
      message: 'Web MIDI permission was denied by the browser.',
      hint: 'Allow MIDI devices for this site in the browser address bar and try again.',
    };
  }
  if (name === 'InvalidStateError' || /platform dependent initialization failed/i.test(raw)) {
    return {
      kind: 'platform',
      message: 'OS MIDI subsystem failed to initialize.',
      hint: 'Browser permission is granted, but the OS MIDI service failed (Chromium caches this until restart). On macOS, open Audio MIDI Setup → MIDI Studio or run "killall MIDIServer"; on Linux, check /dev/snd/seq. Then fully quit and relaunch the browser.',
    };
  }
  if (name === 'NotSupportedError') {
    return {
      kind: 'unsupported',
      message: 'Web MIDI is not supported by this browser.',
      hint: 'Use Chrome or Edge on desktop for Web MIDI.',
    };
  }
  return {
    kind: 'unknown',
    message: raw || 'Web MIDI could not be initialized.',
    hint: 'Check your MIDI interface and restart the browser.',
  };
}

export class MidiDriver {
  private access: MIDIAccess | null = null;
  private mappings: MidiMapping[] = [];
  private defaultOutput: string | undefined = undefined;
  private lastCc = new Map<string, number>();
  private bound = new Map<string, MIDIInput>();
  private learning: Learning | null = null;
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  private recentOut: { key: string; time: number }[] = [];
  private nextActivityId = 1;
  /** Last error from `start()`, cleared on success or `dispose()`. */
  lastError: MidiAccessErrorInfo | null = null;
  /** Called when the input list changes. */
  onInputs?: (inputs: MidiInputInfo[]) => void;
  /** Called when the output list changes. */
  onOutputs?: (outputs: MidiOutputInfo[]) => void;
  /** Called on every parsed incoming message (live monitor). */
  onMessage?: (msg: MidiMessage, deviceName: string) => void;
  /** Called on every incoming or outgoing MIDI event (bidirectional monitor). */
  onActivity?: (event: MidiActivityEvent) => void;
  /** Called on access errors (error budgets). */
  onError?: (detail: string) => void;

  private dispatch: Dispatch;
  constructor(dispatch: Dispatch) {
    this.dispatch = dispatch;
  }

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  async start(): Promise<boolean> {
    if (this.access) return true;
    if (!MidiDriver.supported) {
      this.lastError = {
        kind: 'unsupported',
        message: 'Web MIDI is not supported by this browser.',
        hint: 'Use Chrome or Edge on desktop for Web MIDI.',
      };
      return false;
    }
    this.lastError = null;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      const info = formatMidiAccessError(e);
      this.lastError = info;
      console.warn(`[midi] ${info.kind}: ${info.message}`, e);
      this.onError?.(`${info.kind}: ${info.message} (${String(e)})`);
      return false;
    }
    this.access.onstatechange = () => {
      this.bindInputs();
      this.notifyOutputs();
    };
    this.bindInputs();
    this.notifyOutputs();
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

  outputs(): MidiOutputInfo[] {
    if (!this.access) return [];
    const out: MidiOutputInfo[] = [];
    this.access.outputs.forEach((output) => {
      if (output.state === 'connected') out.push({ id: output.id, name: output.name ?? output.id });
    });
    return out;
  }

  setMappings(m: MidiMapping[]): void {
    this.mappings = m;
  }

  setDefaultOutput(deviceName?: string): void {
    this.defaultOutput = deviceName?.trim() || undefined;
  }

  /**
   * Send a MIDI message to a specific output device, the configured default output, or all connected outputs.
   * Returns true if sent to at least one connected output, false if dropped.
   */
  send(
    message: {
      type: MidiCueType;
      channel?: number;
      number: number;
      value?: number;
    },
    destinationDevice?: string,
    sourceLabel?: string,
  ): boolean {
    const channel = Math.max(1, Math.min(16, message.channel ?? 1));
    const ch = (channel - 1) & 0x0f;
    const num = Math.max(0, Math.min(127, message.number));
    const val = Math.max(0, Math.min(127, message.value ?? 127));
    let bytes: number[];
    switch (message.type) {
      case 'noteOn':
        bytes = [0x90 | ch, num, val];
        break;
      case 'noteOff':
        bytes = [0x80 | ch, num, val];
        break;
      case 'cc':
        bytes = [0xb0 | ch, num, val];
        break;
      case 'programChange':
        bytes = [0xc0 | ch, num];
        break;
      default:
        return false;
    }
    const data = new Uint8Array(bytes);
    const parsed: MidiMessage =
      message.type === 'programChange'
        ? { kind: 'programChange', channel, number: num, value: num }
        : message.type === 'noteOn' && val === 0
          ? { kind: 'noteOff', channel, number: num, value: 0 }
          : { kind: message.type, channel, number: num, value: val };
    const hex = formatMidiBytesHex(data);
    const quickq = formatQuickQ(parsed);
    const target = destinationDevice?.trim() || this.defaultOutput || undefined;
    const prefix = sourceLabel ? `${sourceLabel} — ` : '';

    if (!this.access) {
      this.emitActivity({
        direction: 'out',
        device: target ?? 'All outputs',
        hex,
        message: parsed,
        quickq,
        status: 'dropped',
        detail: `${prefix}Web MIDI disabled`,
      });
      return false;
    }

    const now = Date.now();
    let sentCount = 0;
    this.access.outputs.forEach((out) => {
      if (out.state !== 'connected') return;
      if (!target || out.name?.trim().toLowerCase() === target.toLowerCase() || out.id === target) {
        try {
          out.send(data);
          sentCount += 1;
          this.recordRecentOut(parsed, now);
          this.emitActivity({
            direction: 'out',
            device: out.name ?? out.id,
            hex,
            message: parsed,
            quickq,
            status: 'sent',
            detail: sourceLabel,
          });
        } catch (e) {
          const msg = `send error: ${String(e)}`;
          this.onError?.(msg);
          this.emitActivity({
            direction: 'out',
            device: out.name ?? out.id,
            hex,
            message: parsed,
            quickq,
            status: 'dropped',
            detail: `${prefix}${msg}`,
          });
        }
      }
    });

    if (sentCount === 0) {
      this.emitActivity({
        direction: 'out',
        device: target ?? 'All outputs',
        hex,
        message: parsed,
        quickq,
        status: 'dropped',
        detail: target ? `${prefix}output "${target}" not connected` : `${prefix}no MIDI outputs connected`,
      });
      return false;
    }
    return true;
  }

  /** Cancel any pending delayed cues scheduled by `sendCues`. */
  cancelPendingCues(): void {
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers.clear();
  }

  /** Send one or more slide/macro cues, observing any specified delayMs. */
  sendCues(cues?: MidiCue[], sourceLabel?: string): void {
    if (!cues?.length) return;
    for (const cue of cues) {
      if (cue.delayMs && cue.delayMs > 0) {
        const timer = setTimeout(() => {
          this.pendingTimers.delete(timer);
          this.send(
            {
              type: cue.type,
              channel: cue.channel,
              number: cue.number,
              value: cue.value,
            },
            cue.deviceName,
            sourceLabel,
          );
        }, cue.delayMs);
        this.pendingTimers.add(timer);
      } else {
        this.send(
          {
            type: cue.type,
            channel: cue.channel,
            number: cue.number,
            value: cue.value,
          },
          cue.deviceName,
          sourceLabel,
        );
      }
    }
  }

  /** Resolve with a mapping for the next qualifying message, or null after `timeoutMs`. */
  learn(action: Action, timeoutMs = 5000, opts?: { acceptNoteOff?: boolean }): Promise<MidiMapping | null> {
    this.cancelLearn();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.learning?.timer === timer) this.learning = null;
        resolve(null);
      }, timeoutMs);
      this.learning = { action, acceptNoteOff: opts?.acceptNoteOff, resolve, timer };
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
    this.cancelPendingCues();
    this.recentOut = [];
    for (const input of this.bound.values()) input.onmidimessage = null;
    this.bound.clear();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
  }

  /** Feed a message as if it came from `deviceName` (used by the driver and tests). */
  handle(deviceName: string, data: Uint8Array): void {
    const parsed = parseMidi(data);
    if (parsed) this.onMessage?.(parsed, deviceName);
    const hex = formatMidiBytesHex(data);
    const loopWarning = parsed ? this.detectLoop(parsed, Date.now()) : false;

    const l = this.learning;
    if (l) {
      const m = learnFrom(l.action, deviceName, data, this.lastCc, {
        acceptNoteOff: l.acceptNoteOff,
      });
      if (parsed) {
        this.emitActivity({
          direction: 'in',
          device: deviceName,
          hex,
          message: parsed,
          quickq: formatQuickQ(parsed),
          status: m ? 'matched' : 'unmatched',
          detail: m ? `learned → ${l.action.id}` : 'learning (ignored)',
          loopWarning: loopWarning || undefined,
        });
      }
      if (m) {
        this.learning = null;
        clearTimeout(l.timer);
        l.resolve(m);
      }
      return;
    }

    const actions = matchMidi(this.mappings, deviceName, data, this.lastCc);
    if (parsed) {
      this.emitActivity({
        direction: 'in',
        device: deviceName,
        hex,
        message: parsed,
        quickq: formatQuickQ(parsed),
        status: actions.length ? 'matched' : 'unmatched',
        detail: actions.length
          ? actions.map((a) => (a.arg !== undefined ? `${a.id}(${a.arg})` : a.id)).join(', ')
          : undefined,
        loopWarning: loopWarning || undefined,
      });
    }
    for (const a of actions) this.fire(a);
  }

  protected fire(a: Action): void {
    this.dispatch(a, 'midi');
  }

  private emitActivity(ev: Omit<MidiActivityEvent, 'id' | 'time'>): void {
    this.onActivity?.({
      ...ev,
      id: this.nextActivityId++,
      time: Date.now(),
    });
  }

  private recordRecentOut(msg: MidiMessage, now: number): void {
    const key = `${msg.kind}|${msg.channel}|${msg.number}`;
    this.recentOut = this.recentOut.filter((r) => now - r.time <= LOOP_WINDOW_MS * 4);
    this.recentOut.push({ key, time: now });
  }

  private detectLoop(msg: MidiMessage, now: number): boolean {
    const key = `${msg.kind}|${msg.channel}|${msg.number}`;
    this.recentOut = this.recentOut.filter((r) => now - r.time <= LOOP_WINDOW_MS * 4);
    return this.recentOut.some((r) => r.key === key && now - r.time <= LOOP_WINDOW_MS);
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

  private notifyOutputs() {
    this.onOutputs?.(this.outputs());
  }
}
