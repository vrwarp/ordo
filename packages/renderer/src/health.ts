import { GEOM_COST } from './geom/cost.ts';

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
   * The longest per-frame upload time in budgeted strips over the last minute (at most 128 uploading
   * frames), ms of the render worker's CPU time in the copies (design/27 §13 `uploadMs`; GPU time is
   * measured by bench/gpu-venue.ts); absent on 2D.
   */
  uploadMs?: number;
  /**
   * Frames that uploaded content on screen whole by design (a `refresh` of the live slide, recovery after
   * a device loss), and the longest of the last minute in ms: reported apart, never an alarm.
   */
  wholeUploads?: { count: number; maxMs: number };
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
  /** Slide raster times of the asset worker (`TimingWindow` over the last slides drawn). */
  raster?: TimingSummary;
  /**
   * The raster times the `raster` alarm reads: those of the slides whose content fits the raster budget
   * (`heavySlide` false; undefined while there are none). Without the key, the alarm reads `raster`.
   */
  rasterAlarm?: TimingSummary;
  /** Slides of `raster` whose content is past the raster budget (`heavySlide`): reported, not alarmed. */
  rasterHeavy?: number;
  /** The output's size in device px: the performance budgets scale with it (`perfBudgets`). */
  size?: { width: number; height: number };
  /** Characters drawn that no face this output has covers (`GlyphCoverage`), with their scripts. */
  fontCoverage?: { chars: string; count: number; scripts: string[] };
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
  /** Slide raster p50, p95 and max over the last `n` slides the asset worker drew, ms. */
  rasterMs?: TimingSummary;
  /**
   * How many of those slides the drawing estimate puts past the raster budget at this size (`heavySlide`):
   * their times are in `rasterMs`, but the `raster` alarm leaves them out. Absent when none is.
   */
  rasterHeavy?: number;
  uploadMs?: number;
  wholeUploads?: { count: number; maxMs: number };
  /** This output's performance budgets at its size (design/27 §13). */
  budgets?: PerfBudgets;
  /** Budgets passed now (`PerfAlarm`); absent when every measured figure is within its budget. */
  alarms?: PerfAlarm[];
  fontCoverage?: { chars: string; count: number; scripts: string[] };
};

/** Nearest-rank percentiles of a window of timings, ms (0.01 ms resolution). */
export type TimingSummary = { n: number; p50: number; p95: number; max: number };

/**
 * The last `size` timings of one kind (the link keeps one for slide rasters): `add` on every result,
 * `summary` once per health report. Non-finite and negative values count as 0.
 */
export class TimingWindow {
  private readonly ring: Float64Array;
  private count = 0;
  private at = 0;

  constructor(readonly size = 64) {
    this.ring = new Float64Array(Math.max(1, Math.floor(size)));
  }

  add(ms: number): void {
    this.ring[this.at] = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.at = (this.at + 1) % this.ring.length;
    if (this.count < this.ring.length) this.count++;
  }

  /** Timings in the window (at most `size`). */
  get n(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
    this.at = 0;
  }

  /** Undefined while the window is empty. */
  summary(): TimingSummary | undefined {
    if (!this.count) return undefined;
    const s = Array.from(this.ring.subarray(0, this.count)).sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
    const r = (x: number) => Math.round(x * 100) / 100;
    return { n: this.count, p50: r(q(0.5)), p95: r(q(0.95)), max: r(s[s.length - 1]!) };
  }
}

/** The performance budgets of design/27 §13 that health checks, for one output size. */
export type PerfBudgets = {
  /** Slide raster p95 in the asset worker, ms: 10 at 1080p (and below), 30 at 4K, by pixel count between. */
  rasterP95Ms: number;
  /** Texture upload per frame, ms (the render worker's CPU time in the copies): 4 at every size. */
  uploadMs: number;
  /**
   * GPU memory of the layer and scene textures, MB: 400 at 4K (five layers of two textures, 331.8 MB,
   * plus the two over textures of a scene, 66.4 MB), scaled by pixel count to the next MB (100 at 1080p,
   * where they take 99.5). For display beside `gpuMB` only: `gpuMB` is ordo's own fixed allocation (a
   * function of the output's size and of the scenes' over textures), which this budget is derived from,
   * so it is no alarm; the GPU's real pressure (video, the swap chain, other programs, an iGPU's shared
   * memory) is not observable from a page.
   */
  gpuMB: number;
};

const PX_1080 = 1920 * 1080;
const PX_4K = 3840 * 2160;

export function perfBudgets(width: number, height: number): PerfBudgets {
  const px = Math.max(1, width) * Math.max(1, height);
  const t = Math.min(1, Math.max(0, (px - PX_1080) / (PX_4K - PX_1080)));
  return {
    rasterP95Ms: Math.round((10 + 20 * t) * 10) / 10,
    uploadMs: 4,
    gpuMB: Math.ceil((400 * px) / PX_4K),
  };
}

/**
 * A budget passed: `raster` (slide raster p95 over its budget once `RASTER_ALARM_MIN` slides were drawn:
 * slides may flip late), `upload` (uploadMs, the budgeted strip frames of the last minute, over its budget:
 * frames may be missed while new content uploads). GPU memory has no alarm (see `PerfBudgets.gpuMB`).
 */
export type PerfAlarm = 'raster' | 'upload';

/** Slides drawn before a raster p95 can raise the alarm (the first draws pay for compiling and caches). */
export const RASTER_ALARM_MIN = 20;

/**
 * A fresh full-frame bitmap of a 4K output, ms (sizing the surface, a new backing, the transfer: what a blank
 * full-frame job costs, 9 to 10.5 ms on the bench machine), scaled by pixel count to other sizes.
 */
const FRAME_MS_4K = 10;

/**
 * The share of the raster p95 budget past which a slide's drawing estimate makes it heavy (`heavySlide`): the
 * estimate is within about 20 % of the asset worker's warm raster time on the bench machine.
 */
const HEAVY_SHARE = 0.8;

/**
 * What the drawing estimate of a slide's content predicts its raster takes at `width` x `height` on the
 * bench machine, ms (design/27 §12 drawing cost, §13): a fresh full-frame bitmap, and its geometry's and
 * fills' units (`geombudget.ts` `slideDrawCost`, the units the slide's drawing budget charges) at
 * `GEOM_COST.nsPerUnit` at 4K, 0.4 of that at 1080p and below (the units are logical px: the edges' rows halve
 * with the output's height, the painted pixels quarter), by pixel count between. Text, pictures and cached
 * effect layers are not in it. Fitted over 343 full-frame slides of the converted worship decks (M6 merge
 * review): 10.9 ms + 32.8 ns a unit at 4K, 2.8 ms + 12.4 ns at 1080p; a traced-decoration slide of 1.23M units
 * predicts 45.7 ms at 4K (42 to 45 ms measured warm) and 16.8 ms at 1080p (17 to 20 ms).
 */
export function rasterEstimateMs(cost: { units: number }, width: number, height: number): number {
  const px = Math.max(1, width) * Math.max(1, height);
  const t = Math.min(1, Math.max(0, (px - PX_1080) / (PX_4K - PX_1080)));
  const units = Number.isFinite(cost.units) && cost.units > 0 ? cost.units : 0;
  return (FRAME_MS_4K * px) / PX_4K + units * GEOM_COST.nsPerUnit * 1e-6 * (0.4 + 0.6 * t);
}

/**
 * Whether a slide's content is past the raster budget by its drawing estimate (`rasterEstimateMs` over
 * `HEAVY_SHARE` of `PerfBudgets.rasterP95Ms` at this size): a slide the drawing budget keeps whole may take up
 * to the 50 ms of an asset-worker task (design/27 §13's named exception, the M6 merge review: traced
 * decorations of 100 shapes or more, 42 to 48 ms at 4K and 17 to 21 ms at 1080p on the bench machine). Its
 * time is reported, but the `raster` alarm, which tells the operator the computer is slow, leaves it out.
 */
export function heavySlide(cost: { units: number }, width: number, height: number): boolean {
  return rasterEstimateMs(cost, width, height) > HEAVY_SHARE * perfBudgets(width, height).rasterP95Ms;
}

export function perfAlarms(b: PerfBudgets, m: { raster?: TimingSummary; uploadMs?: number }): PerfAlarm[] {
  const out: PerfAlarm[] = [];
  if (m.raster && m.raster.n >= RASTER_ALARM_MIN && m.raster.p95 > b.rasterP95Ms) out.push('raster');
  if (m.uploadMs !== undefined && m.uploadMs > b.uploadMs) out.push('upload');
  return out;
}

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
    ...perf(i),
    ...(i.fontCoverage?.count ? { fontCoverage: i.fontCoverage } : {}),
  };
}

/** The performance part of a health report: measured figures, the budgets at this size, and the alarms. */
type PerfPart = 'rasterMs' | 'rasterHeavy' | 'uploadMs' | 'wholeUploads' | 'budgets' | 'alarms';

function perf(i: HealthInputs): Pick<HealthReport, PerfPart> {
  const out: Pick<HealthReport, PerfPart> = {};
  if (i.raster) out.rasterMs = i.raster;
  if (i.rasterHeavy) out.rasterHeavy = i.rasterHeavy;
  if (i.render.uploadMs !== undefined) out.uploadMs = Math.round(i.render.uploadMs * 100) / 100;
  const w = i.render.wholeUploads;
  if (w?.count) out.wholeUploads = { count: w.count, maxMs: Math.round(w.maxMs * 100) / 100 };
  if (!i.size) return out;
  out.budgets = perfBudgets(i.size.width, i.size.height);
  // The alarm reads the slides within the budget by their content when the caller tells them apart.
  const raster = 'rasterAlarm' in i ? i.rasterAlarm : i.raster;
  const alarms = perfAlarms(out.budgets, { raster, uploadMs: out.uploadMs });
  if (alarms.length) out.alarms = alarms;
  return out;
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
