/**
 * Health aggregation for an output window: counters from the render worker plus main-thread state,
 * shaped like the protocol's OutputHealth (kept structural so this package does not depend on protocol).
 */

export type CompositorKind = 'webgpu' | '2d' | 'none';

export type RenderTelemetry = {
  presented: number;
  missed: number;
  lateFlips: number;
  longTasks: number;
  gpuLost: number;
  fps: number;
  frameMs: number;
  compositor: CompositorKind;
  error?: string;
  /** The slide cue the frame shows (-1 none) and the hub time of the frame that first drew it. */
  slideCue?: number;
  slideFlipAt?: number;
  /** GPU memory of the compositor's layer and scene textures, MB (design/27 §13 budget); absent on 2D. */
  gpuMB?: number;
  /**
   * The longest per-frame upload time over the last 128 frames that uploaded, ms of the render worker's CPU
   * time in the copies (design/27 §13 `uploadMs`; GPU time is measured by bench/gpu-venue.ts); absent on 2D.
   */
  uploadMs?: number;
};

export const EMPTY_TELEMETRY: RenderTelemetry = {
  presented: 0,
  missed: 0,
  lateFlips: 0,
  longTasks: 0,
  gpuLost: 0,
  fps: 0,
  frameMs: 1000 / 60,
  compositor: 'none',
};

export type HealthInputs = {
  render: RenderTelemetry;
  mainLongTasks: number;
  live?: number;
  armed?: number;
  arm: ArmStatus;
  cache: { ready: number; total: number };
  videoDropped: number;
  audio?: 'ok' | 'lost' | 'none';
  meters?: number[];
  mediaPositionMs?: number;
  mediaDurationMs?: number;
  errors: string[];
  appVersion?: string;
};

export type HealthReport = {
  presented: number;
  missed: number;
  longTasks: number;
  lateFlips: number;
  armed?: number;
  armedOk?: boolean;
  armError?: string;
  live?: number;
  cache: { ready: number; total: number };
  gpuLost: number;
  videoDropped: number;
  fps?: number;
  audio?: 'ok' | 'lost' | 'none';
  meters?: number[];
  mediaPositionMs?: number;
  mediaDurationMs?: number;
  error?: string;
  appVersion?: string;
  gpuMB?: number;
};

export type ArmStatus = { ok: boolean; pending: string[]; error?: string };

/**
 * Whether every required key is held by the render worker. A key that failed to prepare makes the
 * status not ok with its error; keys still being prepared are pending (not ok, no error).
 */
export function armStatus(
  required: Iterable<string>,
  held: ReadonlySet<string>,
  errors: ReadonlyMap<string, string>,
): ArmStatus {
  const pending: string[] = [];
  let error: string | undefined;
  for (const k of required) {
    if (!k || held.has(k)) continue;
    const e = errors.get(k);
    if (e && !error) error = e;
    pending.push(k);
  }
  return { ok: pending.length === 0, pending, error };
}

export function buildHealth(i: HealthInputs): HealthReport {
  const errs = [...i.errors];
  if (i.render.error) errs.unshift(i.render.error);
  const error = errs.length ? [...new Set(errs)].join('; ').slice(0, 400) : undefined;
  return {
    presented: i.render.presented,
    missed: i.render.missed,
    longTasks: i.render.longTasks + i.mainLongTasks,
    lateFlips: i.render.lateFlips,
    armed: i.armed,
    armedOk: i.armed === undefined ? undefined : i.arm.ok,
    armError: i.arm.error,
    live: i.live,
    cache: { ready: i.cache.ready, total: i.cache.total },
    gpuLost: i.render.gpuLost,
    videoDropped: i.videoDropped,
    fps: Math.round(i.render.fps * 10) / 10,
    audio: i.audio,
    meters: i.meters?.length ? i.meters.map((m) => Math.round(m * 1000) / 1000) : undefined,
    mediaPositionMs: i.mediaPositionMs === undefined ? undefined : Math.round(i.mediaPositionMs),
    mediaDurationMs: i.mediaDurationMs === undefined ? undefined : Math.round(i.mediaDurationMs),
    error,
    appVersion: i.appVersion,
    ...(i.render.gpuMB !== undefined ? { gpuMB: i.render.gpuMB } : {}),
  };
}

/**
 * Accumulates `droppedVideoFrames` across elements whose source changes (each new src restarts the
 * element's counter).
 */
export class DroppedFrames {
  private src = new Map<string, string>();
  private last = new Map<string, number>();
  private carried = 0;

  /** Report an element's current counter; `srcId` changes when the element loads a new file. */
  sample(elementId: string, srcId: string, dropped: number): void {
    if (this.src.get(elementId) !== srcId) {
      this.carried += this.last.get(elementId) ?? 0;
      this.src.set(elementId, srcId);
      this.last.set(elementId, 0);
    }
    this.last.set(elementId, Math.max(this.last.get(elementId) ?? 0, dropped));
  }

  get total(): number {
    let t = this.carried;
    for (const v of this.last.values()) t += v;
    return t;
  }
}
