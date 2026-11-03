/**
 * Audio engine (design/18). The audio-master output window creates one AudioEngine; the operator creates a
 * PreviewPlayer.
 */
export {
  AudioEngine,
  browserDeps,
  resolveDevice,
  RAMP_S,
  DEVICE_POLL_MS,
  type AudioDeps,
  type AudioDevice,
  type AudioStatus,
  type ContextOptions,
  type SinkAudioContext,
  type SourceHandle,
  type SourceOptions,
} from './engine.ts';
export { listAudioOutputs, probeChannels, unlockDeviceLabels } from './devices.ts';
export { PreviewPlayer } from './preview.ts';
export {
  dbToGain,
  gainToDb,
  loudnessGainDb,
  masterGain,
  meterBallistics,
  peakOf,
  planRoute,
  sourceGain,
  type RoutePlan,
} from './math.ts';
