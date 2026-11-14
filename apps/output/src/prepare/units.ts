import { pinUnit, prepareSlideUnits, unpinUnit } from '@ordo/renderer';
import { type PrepareHost, type PrepareStep, registerPrepareStep } from './index.ts';

/*
 * Geometry units made before the draw (design/27 §12-13, M9 decisions "Slow-to-draw elements", Runtime: draw it,
 * never drop it): each object the slide's drawing budget sends to its legacy copy is drawn whole into a unit in
 * the job's turns (`@ordo/renderer` `prepareSlideUnits`: one draw call a step, each turn about `SLICE_MS`), so
 * the synchronous draw that follows copies it 1:1 instead of drawing the legacy copy. After 'geometry files':
 * a unit draws the geometry those files hold. A unit made for an armed or warmed cue is in the cache when the
 * cue goes live, so that GO does no unit work; a jump to a cue neither armed nor warmed waits for its units as
 * for its table layouts, bounded by `UNIT_WAIT_MS` and `UNIT_JOB_BYTES` (the rest draw as their legacy copies
 * this time). Effect units (r2b) replace that wait: a GO never waits, and a late unit fades in.
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

const holds = new WeakMap<PrepareHost, Set<string>>();

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
  const keys = new Set<string>();
  holds.set(host, keys);
  let released = false;
  return {
    keys,
    release() {
      if (released) return;
      released = true;
      holds.delete(host);
      for (const k of keys) unpinUnit(k);
    },
  };
}

export const geometryUnits: PrepareStep = {
  name: 'geometry units',
  async run(job, host) {
    // The slide itself: the next slide a look shows is drawn in its lyric bands, never as authored.
    const slide = job.slides[0];
    if (!enabled || !slide) return undefined;
    const keys = holds.get(host);
    await prepareSlideUnits(
      slide,
      job.scale,
      job.look,
      { slice: (fn) => host.slice(fn), check: () => host.check() },
      keys
        ? {
            pin: (k) => {
              if (keys.has(k)) return;
              keys.add(k);
              pinUnit(k);
            },
          }
        : {},
    );
    return undefined;
  },
};

registerPrepareStep(geometryUnits);
