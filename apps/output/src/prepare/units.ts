import { pinUnit, prepareSlideUnits, unitCache, unitsOfSlide, unpinUnit } from '@ordo/renderer/units.ts';
import { type PrepareHost, type PrepareStep, registerPrepareStep } from './index.ts';

/*
 * Geometry units made before the draw (design/27 §12-13, M9 decisions "Slow-to-draw elements", Runtime: draw it,
 * never drop it): each object the slide's drawing budget sends to its legacy copy is drawn whole into a unit in
 * the job's turns (`@ordo/renderer` `prepareSlideUnits`: one draw call a step, each turn about `SLICE_MS`), so
 * the synchronous draw that follows copies it 1:1 instead of drawing the legacy copy. After 'geometry files':
 * a unit draws the geometry those files hold. A unit made for an armed or warmed cue is in the cache when the
 * cue goes live, so that GO does no unit work.
 *
 * A GO never waits for drawing (owner decision 2026-11-13, design/14 "Late units"): the asset worker tells the
 * step how a job may wait (`unitJob`, keyed by the job's host as `holdUnits` is, so `PrepareHost` is unchanged).
 * A live job (a jump to a cue neither armed nor warmed) stops before its first unit: the slide is drawn and sent
 * at once, the units not ready as their legacy copies this time, and the job says which it left (`UnitJob.left`)
 * so the worker makes them in a late job, which reports each unit made (`onUnit`) and pins them into the hold of
 * the job it continues (`holdInto`). An armed or warmed job waits as before (`UNIT_WAIT_MS`, `UNIT_SLIDE_AREAS`)
 * until a GO hurries it: its `stop` turns true, and the unit it is making is abandoned at its next turn (`Hurried`,
 * caught here: nothing of it is kept). A host with no job (the harness, the thumbnail worker, bakes) waits for
 * complete drawing as before.
 *
 * Importing this module registers the step (the asset worker and the thumbnail worker import it). The
 * thumbnail worker turns it on only for a fine pointer (`setGeometryUnits`): phones and other coarse-pointer
 * layouts keep the legacy copies and make nothing.
 */

let enabled = true;

/** Whether the step makes units in this worker (the thumbnail worker: only for a fine pointer). */
export function setGeometryUnits(on: boolean): void {
  enabled = on;
}

/** A hold's keys, and whether it was let go (a late job pinning into it then pins nothing). */
type HoldState = { keys: Set<string>; released: boolean };

const holds = new WeakMap<PrepareHost, HoldState>();
const holdStates = new WeakMap<UnitHold, HoldState>();

/** The units a job holds pinned (`holdUnits`). */
export interface UnitHold {
  /** Unpin them (once; later calls do nothing). */
  release(): void;
  /** Keys pinned so far. */
  readonly keys: ReadonlySet<string>;
}

/**
 * Pin every unit the steps run on `host` make or find (the asset worker's slide and warm jobs), until `release`:
 * a unit made at prepare is never evicted before the job's raster, nor while the job's cue is armed or warmed.
 */
export function holdUnits(host: PrepareHost): UnitHold {
  const state: HoldState = { keys: new Set<string>(), released: false };
  holds.set(host, state);
  const hold: UnitHold = {
    keys: state.keys,
    release() {
      if (state.released) return;
      state.released = true;
      holds.delete(host);
      for (const k of state.keys) unpinUnit(k);
    },
  };
  holdStates.set(hold, state);
  return hold;
}

/**
 * The steps run on `host` pin what they make or find into `hold` (a late job continues the job that left its
 * units: they stay pinned as long as that job's are, while its slide is live or armed). Once `hold` was let go,
 * nothing more is pinned (the units stay in the cache, least recently used first).
 */
export function holdInto(host: PrepareHost, hold: UnitHold): void {
  const state = holdStates.get(hold);
  if (state) holds.set(host, state);
}

/** How an output's job makes its units (the asset worker); absent, a job waits as before. */
export interface UnitJobOptions {
  /**
   * True while the job must not wait for units: a live job from the start, an armed or warm job once a GO
   * hurried it. Checked before each unit, and at each turn of the unit being made (it is then abandoned).
   */
  stop(): boolean;
  /** Each unit the job made, as it is kept (a late job reports readiness with it). */
  onUnit?(key: string): void;
  /** Awaited after each turn of unit making while the job does not stop (test mode `?unitTurnMs`). */
  afterTurn?(): Promise<void>;
}

/** What the step did for a job (`unitJob`). */
export interface UnitJob extends UnitJobOptions {
  /** Keys of the units the slide's plan copies that are not ready after the step: drawn as legacy copies. */
  left: string[];
  /** Keys of the units the step made, in order. */
  made: string[];
}

const jobs = new WeakMap<PrepareHost, UnitJob>();

/** Thrown inside a unit's making once its job stops (a GO hurried it): the unit is abandoned, nothing kept. */
class Hurried extends Error {
  constructor() {
    super('hurried');
    this.name = 'Hurried';
  }
}

/** Say how the job run on `host` makes its units (the asset worker's slide, late and warm jobs). */
export function unitJob(host: PrepareHost, opts: UnitJobOptions): UnitJob {
  const job: UnitJob = { ...opts, left: [], made: [] };
  jobs.set(host, job);
  return job;
}

export const geometryUnits: PrepareStep = {
  name: 'geometry units',
  async run(job, host) {
    // The slide itself: the next slide a look shows is drawn in its lyric bands, never as authored.
    const slide = job.slides[0];
    if (!enabled || !slide) return undefined;
    const hold = holds.get(host);
    const uj = jobs.get(host);
    // Turns of making only: the plan's turn (and a stopped job's) never waits.
    let making = false;
    const slice = <T>(fn: () => T): Promise<T> => {
      if (!uj?.afterTurn || !making) return host.slice(fn);
      return host.slice(fn).then(async (r) => {
        if (!uj.stop()) await uj.afterTurn!();
        return r;
      });
    };
    try {
      await prepareSlideUnits(
        slide,
        job.scale,
        job.look,
        {
          slice: (fn) => slice(fn),
          check: () => {
            host.check();
            if (making && uj?.stop()) throw new Hurried();
          },
          ...(host.now ? { now: () => host.now!() } : {}),
        },
        {
          ...(hold
            ? {
                pin: (k: string) => {
                  if (hold.released || hold.keys.has(k)) return;
                  hold.keys.add(k);
                  pinUnit(k);
                },
              }
            : {}),
          ...(uj
            ? {
                stop: () => {
                  // Checked before each unit: from here a turn is a unit's.
                  making = true;
                  return uj.stop();
                },
                onUnit: (k: string) => {
                  uj.made.push(k);
                  uj.onUnit?.(k);
                },
              }
            : {}),
        },
      );
    } catch (err) {
      if (!(err instanceof Hurried)) throw err;
    }
    if (uj)
      uj.left = unitsOfSlide(slide, job.scale, job.look)
        .filter((u) => !unitCache.has('unit', u.key))
        .map((u) => u.key);
    return undefined;
  },
};

registerPrepareStep(geometryUnits);
