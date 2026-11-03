/**
 * Audio engine API (design/18). STUB: signatures are the contract; the implementation is filled in later.
 * The audio-master output window creates one AudioEngine; the operator creates a PreviewPlayer.
 */
import type { AudioSettings } from '@ordo/domain';

export type AudioDevice = { deviceId: string; label: string; channels?: number };
export type AudioStatus = 'ok' | 'lost' | 'none';
export type SourceHandle = { readonly id: number };
export type SourceOptions = { pairId?: string; gainDb?: number; loudnessLufs?: number };

/** List audio output devices. Labels need a prior microphone permission grant (call `unlockDeviceLabels`). */
export async function listAudioOutputs(): Promise<AudioDevice[]> {
  return [];
}

/** Ask for microphone permission once so device labels are visible; stops the stream immediately. */
export async function unlockDeviceLabels(): Promise<boolean> {
  return false;
}

export class AudioEngine {
  status: AudioStatus = 'none';
  constructor(_settings: AudioSettings) {}
  /** Create the AudioContext on the house device. Must be called after a user gesture or with autoplay allowed. */
  async start(): Promise<void> {}
  setSettings(_settings: AudioSettings): void {}
  /** Route a media element through the engine to a stereo pair. Returns a handle for detach/updates. */
  attach(_el: HTMLMediaElement, _opts: SourceOptions = {}): SourceHandle {
    return { id: 0 };
  }
  update(_h: SourceHandle, _opts: SourceOptions): void {}
  detach(_h: SourceHandle): void {}
  setMasterDb(_db: number): void {}
  setMuted(_muted: boolean): void {}
  /** Ramp master to silence over `ms`, then restore gain (sources keep playing unless stopped by caller). */
  async fadeOut(_ms = 500): Promise<void> {}
  /** Peak level per configured pair, 0..1. */
  meters(): number[] {
    return [];
  }
  dispose(): void {}
}

/** Operator-side audition on a separate device; never touches the house device. */
export class PreviewPlayer {
  constructor(_deviceId?: string) {}
  setDevice(_deviceId?: string): void {}
  async play(_url: string, _gainDb = 0): Promise<void> {}
  stop(): void {}
  get playing(): boolean {
    return false;
  }
}

/** dB to linear gain. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** Gain in dB that brings a source measured at `lufs` to `target` LUFS, clamped to ±12 dB. */
export function loudnessGainDb(lufs: number | undefined, target = -16): number {
  if (lufs === undefined || !Number.isFinite(lufs)) return 0;
  return Math.max(-12, Math.min(12, target - lufs));
}
