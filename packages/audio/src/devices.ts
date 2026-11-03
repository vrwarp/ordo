import type { AudioDevice, SinkAudioContext } from './engine.ts';

/**
 * Channel count of an output device: open a temporary AudioContext on it and read
 * `destination.maxChannelCount`. Undefined when that is not possible.
 */
export async function probeChannels(deviceId: string): Promise<number | undefined> {
  if (typeof AudioContext === 'undefined') return undefined;
  let ctx: SinkAudioContext | undefined;
  try {
    const opts: Record<string, unknown> = { latencyHint: 'playback' };
    if (deviceId && deviceId !== 'default') opts.sinkId = deviceId;
    ctx = new AudioContext(opts as AudioContextOptions) as SinkAudioContext;
    if (deviceId && deviceId !== 'default' && String(ctx.sinkId ?? '') !== deviceId && ctx.setSinkId) {
      await ctx.setSinkId(deviceId);
    }
    const n = ctx.destination.maxChannelCount;
    return n > 0 ? n : undefined;
  } catch {
    return undefined;
  } finally {
    if (ctx) void ctx.close().catch(() => {});
  }
}

/** List audio output devices. Labels need a prior microphone permission grant (call `unlockDeviceLabels`). */
export async function listAudioOutputs(opts: { probe?: boolean } = {}): Promise<AudioDevice[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  const outs = all.filter((d) => d.kind === 'audiooutput');
  const seen = new Set<string>();
  const list: AudioDevice[] = [];
  for (const [i, d] of outs.entries()) {
    const id = d.deviceId;
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({ deviceId: id, label: d.label || (id === 'default' ? 'System default' : `Output ${i + 1}`) });
  }
  if (opts.probe !== false) {
    // Sequential: opening many contexts at once can fail on some drivers.
    for (const dev of list) {
      if (!dev.deviceId && list.length > 1) continue;
      dev.channels = await probeChannels(dev.deviceId);
    }
  }
  return list;
}

/** Ask for microphone permission once so device labels are visible; stops the stream immediately. */
export async function unlockDeviceLabels(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some((d) => d.kind === 'audiooutput' && d.label)) return true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    return true;
  } catch {
    return false;
  }
}
