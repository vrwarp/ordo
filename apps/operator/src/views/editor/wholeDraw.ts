import type { SlideObject } from '@ordo/domain';
import { EFFECT_COST, GEOM_COST } from '@ordo/renderer/geom/cost.ts';
import { setWholeStatus, type WholeStatus } from './wholeState.ts';

/*
 * The editor draws an object whole where the slide's drawing budget would draw its lighter copy (design/15
 * "Canvas drawing"). A stub: today's behaviour (the budget's copy for every object, nothing queued).
 */

/** What one whole draw may cost: the original object's drawing estimate and effect area. */
export const WHOLE_BOUND = { est: GEOM_COST.geometry, effects: EFFECT_COST.slide } as const;
/** Device px the whole drawings' caches hold in all (4 x the canvas's `NODE_CACHE_MAX_PX`). */
export const WHOLE_MAX_PX = 32_000_000;
/** How far the canvas's density may move before a whole drawing is made again (a fraction). */
export const WHOLE_DENSITY_SLACK = 0.1;
/** The longest wait for an idle moment, in ms, before the next whole drawing is made anyway. */
export const WHOLE_TICK_TIMEOUT_MS = 200;

export interface WholeEnv {
  readonly coarse: boolean;
  readonly live: boolean;
  readonly light: boolean;
  readonly slide: string;
  readonly density: number;
  readonly version?: number;
  readonly maxPx?: number;
  readonly cacheRect: (o: SlideObject, density: number) => { width: number; height: number } | undefined;
}

export interface WholeNode {
  readonly o: SlideObject;
  readonly density: number;
  readonly px: number;
}

export class WholeState {
  slide: string | undefined;
  readonly committed = new Map<string, WholeNode>();
  work: { id: string }[] = [];
  step(): boolean {
    return false;
  }
}

export interface WholePlan {
  readonly pending: readonly string[];
  readonly status: Omit<WholeStatus, 'lastMs'>;
}

export function sameDrawn(_a: SlideObject, _b: SlideObject): boolean {
  return false;
}

export function readSwitch(_search?: string): boolean {
  return false;
}

export function planWhole(
  _objects: readonly SlideObject[],
  _budget: ReadonlyMap<SlideObject, SlideObject>,
  _selection: { readonly primary?: string },
  _state: WholeState,
  env: WholeEnv,
): WholePlan {
  const status = {
    wanted: 0,
    drawn: 0,
    pending: 0,
    blocked: 0,
    px: 0,
    skipped: { bound: 0, cache: 0, total: 0 },
    stale: 0,
    live: env.live,
    coarse: env.coarse,
    light: env.light,
  };
  setWholeStatus(status);
  return { pending: [], status };
}

/** The density an object's node is cached at (stub: always the canvas's). */
export function wholeDensity(_o: SlideObject, env: WholeEnv, _state: WholeState): number {
  return env.density;
}

export function drawWhole(
  o: SlideObject,
  budget: ReadonlyMap<SlideObject, SlideObject>,
  _env: WholeEnv,
  _state: WholeState,
): SlideObject | undefined {
  return budget.get(o);
}

export interface TickHost {
  readonly idle?: (cb: () => void, opts: { timeout: number }) => unknown;
  readonly cancelIdle?: (handle: unknown) => void;
  readonly timer: (cb: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export class WholeScheduler {
  constructor(_step: () => void, _after?: () => void, _host?: TickHost) {}
  request(): void {}
  cancel(): void {}
  get waiting(): boolean {
    return false;
  }
}
