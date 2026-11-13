import type { SlideDrawCost } from './geombudget.ts';

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
  /**
   * The raster times the `raster` alarm read (`HealthInputs.rasterAlarm`: the slides whose content fits the
   * budget): what an alarm's text quotes. Absent when the caller does not tell the slides apart, or when it
   * equals `rasterMs` (no heavy slide in the window).
   */
  rasterAlarmMs?: TimingSummary;
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

  readonly size: number;
  constructor(size = 64) {
    this.size = size;
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
 * The share of the raster p95 budget past which a slide's drawing estimate makes it heavy (`heavySlide`).
 */
const HEAVY_SHARE = 0.8;

/**
 * What a slide job's raster costs by its content, for the estimate (`rasterEstimateMs`): what its objects draw
 * (`slideJobCost`), and the effect sprites the draw had to make (`effectsMade`, from `effects.ts` `effectWork`
 * across the draw; absent: none, as when they are cached).
 */
export type RasterCost = Pick<SlideDrawCost, 'units'> &
  Partial<Omit<SlideDrawCost, 'units'>> & {
    readonly effectsMade?: { readonly full: number; readonly reduced: number };
  };

/**
 * The raster estimate's constants at 1080p (`hd`) and at 4K (`uhd`), ms: `frame` a fresh full-frame bitmap with a
 * first raster's own costs; `units` per million drawing units (`GEOM_COST`); `effects` per slide area of effect
 * layers copied or enlarged from the cache; `textEffects` per slide area of glyphs drawn blurred (a shadow or a
 * glow); `chars` per thousand characters laid out and drawn; `pictures` per slide area of prepared pictures
 * copied 1:1, `sourcePictures` of pictures drawn from their source (resampled); `madeFull` and `madeReduced`
 * per slide area of effect canvases a draw makes (composites and bodies at full resolution; blur layers and masks
 * at their reduced one: `effects.ts` `effectWork`), which only a draw that finds them uncached pays.
 *
 * Fitted (M6 merge re-review; design/27 §13) on the bench container over 500 slides of 31 converted decks: the
 * re-review's 22 worship decks (traced decorations, gradients, shadows, soft edges) with 7 ordinary shard decks
 * and 2 sermon decks, each slide drawn as the asset worker draws it, first in deck order with the sprite cache
 * emptied at the deck's start (what health's window holds: each slide key is drawn once) and then warm, by
 * non-negative least squares over both; then divided by 1.31, the container's slowdown that day against the M6
 * review's (job-warm intercepts 14.3 / 3.7 ms against its 10.9 / 2.8), so that they are the bench machine's.
 * Measured over estimated, first rasters: p50 0.89, p90 1.44 at 1080p; 0.99, 1.24 at 4K. `pictures` at 1080p
 * and `sourcePictures` are picture.ts's measurements (0.7 ms a full slide copied at 1080p; 4.5 and 20 ms resampled
 * at 1080p and 4K): too few such slides to fit. The text's glyph area unblurred fitted to 0 at both sizes.
 */
export const RASTER_ESTIMATE = {
  hd: {
    frame: 4.1,
    units: 9.9,
    effects: 0,
    textEffects: 3.3,
    chars: 5.1,
    pictures: 0.7,
    sourcePictures: 4.5,
    madeFull: 11.1,
    madeReduced: 27,
  },
  uhd: {
    frame: 13.3,
    units: 25.6,
    effects: 3.8,
    textEffects: 18.1,
    chars: 10.8,
    pictures: 2.5,
    sourcePictures: 20,
    madeFull: 35,
    madeReduced: 62.2,
  },
} as const;

type EstimateTerm = keyof (typeof RASTER_ESTIMATE)['hd'];

/** A non-negative finite input (else 0). */
const amount = (v: number | undefined): number =>
  Number.isFinite(v) && (v as number) > 0 ? (v as number) : 0;

/**
 * What the drawing estimate of a slide's content predicts its raster takes at `width` x `height` on the bench
 * machine, ms (design/27 §12 drawing cost, §13): `RASTER_ESTIMATE`'s terms over the content (`RasterCost`), the
 * 1080p and 4K constants interpolated by pixel count between (the 1080p ones below it). A slide of traced
 * decorations at the drawing budget (1.23M units) predicts about 16 ms at 1080p and 45 ms at 4K; a full-slide
 * photo with a title about 5 / 16 ms; the first draw of a slide area of shadowed shapes, its layers and
 * composite made, about 45 ms more at 4K than the draws after it.
 */
export function rasterEstimateMs(cost: RasterCost, width: number, height: number): number {
  const px = Math.max(1, width) * Math.max(1, height);
  const t = Math.min(1, Math.max(0, (px - PX_1080) / (PX_4K - PX_1080)));
  const c = (k: EstimateTerm) => RASTER_ESTIMATE.hd[k] + (RASTER_ESTIMATE.uhd[k] - RASTER_ESTIMATE.hd[k]) * t;
  const made = cost.effectsMade;
  return (
    c('frame') +
    (c('units') * amount(cost.units)) / 1e6 +
    c('effects') * amount(cost.effects) +
    c('textEffects') * amount(cost.textEffects) +
    (c('chars') * amount(cost.chars)) / 1e3 +
    c('pictures') * amount(cost.pictures) +
    c('sourcePictures') * amount(cost.sourcePictures) +
    c('madeFull') * amount(made?.full) +
    c('madeReduced') * amount(made?.reduced)
  );
}

/**
 * The effect sprites a draw made, in slide areas at `scale` device px per logical px: the difference of
 * `effects.ts` `effectWork` before and after it.
 */
export function effectsMade(
  before: { readonly full: number; readonly reduced: number },
  after: { readonly full: number; readonly reduced: number },
  scale: number,
): { full: number; reduced: number } {
  const area = Math.max(1e-9, scale * scale * PX_1080);
  return {
    full: amount(after.full - before.full) / area,
    reduced: amount(after.reduced - before.reduced) / area,
  };
}

/**
 * Whether a slide's content is past the raster budget by its drawing estimate (`rasterEstimateMs` over
 * `HEAVY_SHARE` of `PerfBudgets.rasterP95Ms` at this size): a slide the drawing budget keeps whole may take up
 * to the 50 ms of an asset-worker task (design/27 §13's named exception: traced decorations of 100 shapes or
 * more, effect sprites made the first time, large shadowed text). Its time is reported, but the `raster`
 * alarm, which tells the operator the computer is slow, leaves it out.
 */
export function heavySlide(cost: RasterCost, width: number, height: number): boolean {
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
type PerfPart =
  | 'rasterMs'
  | 'rasterHeavy'
  | 'rasterAlarmMs'
  | 'uploadMs'
  | 'wholeUploads'
  | 'budgets'
  | 'alarms';

function perf(i: HealthInputs): Pick<HealthReport, PerfPart> {
  const out: Pick<HealthReport, PerfPart> = {};
  if (i.raster) out.rasterMs = i.raster;
  if (i.rasterHeavy) out.rasterHeavy = i.rasterHeavy;
  // What the alarm reads, when it is not every slide's.
  if (i.rasterHeavy && i.rasterAlarm) out.rasterAlarmMs = i.rasterAlarm;
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
