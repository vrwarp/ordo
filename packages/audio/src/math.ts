import type { AudioPair } from '@ordo/domain';

/** dB to linear gain. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** Linear gain to dB (-Infinity for 0). */
export function gainToDb(gain: number): number {
  return gain <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(gain);
}

/** Gain in dB that brings a source measured at `lufs` to `target` LUFS, clamped to ±12 dB. */
export function loudnessGainDb(lufs: number | undefined, target = -16): number {
  if (lufs === undefined || !Number.isFinite(lufs)) return 0;
  return Math.max(-12, Math.min(12, target - lufs));
}

/** Linear gain for a source: item gain plus loudness normalisation, capped at +24 dB overall. */
export function sourceGain(opts: { gainDb?: number; loudnessLufs?: number }): number {
  const db = (Number.isFinite(opts.gainDb) ? opts.gainDb! : 0) + loudnessGainDb(opts.loudnessLufs);
  return dbToGain(Math.min(24, db));
}

/** Master gain: 0 when muted. */
export function masterGain(masterDb: number, muted: boolean): number {
  if (muted) return 0;
  return dbToGain(Math.max(-96, Math.min(12, Number.isFinite(masterDb) ? masterDb : 0)));
}

export type RoutePlan = {
  /** 0-based merger inputs for the left and right channel. */
  left: number;
  right: number;
  pairId?: string;
  /** True when the requested pair was unknown or outside the device's channel count. */
  fallback: boolean;
};

/**
 * Decide which physical channels (merger inputs) a source plays on. Pair channels are 0-based channel
 * indices as stored in settings (`DEFAULT_AUDIO`: House L/R = 0/1; the UI shows them 1-based). Unknown pairs fall back to the default pair, then to channels 1/2. A pair beyond the device's
 * channel count falls back too, never wrapping onto other channels.
 */
export function planRoute(
  pairs: readonly AudioPair[],
  pairId: string | undefined,
  defaultPairId: string | undefined,
  channels: number,
): RoutePlan {
  const valid = (p: AudioPair | undefined): p is AudioPair =>
    !!p &&
    Number.isInteger(p.left) &&
    Number.isInteger(p.right) &&
    p.left >= 0 &&
    p.right >= 0 &&
    p.left < channels &&
    p.right < channels;
  const want = pairId ? pairs.find((p) => p.id === pairId) : undefined;
  if (valid(want)) return { left: want.left, right: want.right, pairId: want.id, fallback: false };
  const def = defaultPairId ? pairs.find((p) => p.id === defaultPairId) : undefined;
  const requested = pairId !== undefined;
  if (valid(def)) return { left: def.left, right: def.right, pairId: def.id, fallback: requested };
  if (channels >= 2) return { left: 0, right: 1, fallback: requested || !!defaultPairId };
  return { left: 0, right: 0, fallback: true };
}

/** Peak absolute sample value of a block, clamped to 0..1. Allocation-free. */
export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  return Math.min(peak, 1);
}

/**
 * Meter ballistics: instant attack, exponential release. `dtMs` since the previous reading; the meter falls
 * by 20 dB per `releaseMs` (default 300 ms, a PPM-like decay).
 */
export function meterBallistics(previous: number, peak: number, dtMs: number, releaseMs = 300): number {
  if (peak >= previous) return peak;
  const fall = dbToGain(-20 * (Math.max(0, dtMs) / releaseMs));
  const decayed = previous * fall;
  return Math.max(decayed, peak);
}
