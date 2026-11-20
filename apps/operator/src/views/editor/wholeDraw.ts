import type { SlideObject } from '@ordo/domain';
import { drawnCost, drawnEffectArea } from '@ordo/renderer';
import { EFFECT_COST, GEOM_COST } from '@ordo/renderer/geom/cost.ts';
import { useEffect, useReducer, useRef } from 'react';
import { useLive } from '../../state/live.ts';
import { setWholeLighter, setWholeStatus, type WholeStatus } from './wholeState.ts';

/*
 * The editor draws an object whole where the slide's drawing budget would draw its lighter copy (design/15
 * "Canvas drawing", design/27 §12-13). The budget (`slideBudget`) keeps a slide within what a screen can draw
 * in a frame: an object past it is drawn as its legacy copy (a shape without its stored geometry, gradient or
 * dash; a shape or a picture without its shadow, glow or soft edge). The screens draw such objects whole
 * from units, in time they have; the editor, which has the time between two keys, draws them whole into the
 * node cache the canvas already keeps for every object, one object a turn in idle time and the selected one at
 * once, and never while a service is live (a GO never waits for drawing, on any computer: the browser cannot
 * tell the computer that runs the service from one that edits).
 *
 * This module is the rule, as functions of the slide's objects, its budget, the selection and the state of the
 * last plan: `planWhole` (what goes whole now and what waits), `drawWhole` (what a node draws), `WholeState`
 * (what is whole now) and `WholeScheduler` (one turn at a time). The canvas hook that wires them
 * (`useWholeDraw`, below) is thin. prerender-editor (design/29 §4) reads `drawWhole` and `planWhole` to draw a
 * full big slide.
 */

/** What one whole draw may cost: the original object's drawing estimate and effect area (W3). */
export const WHOLE_BOUND = { est: GEOM_COST.geometry, effects: EFFECT_COST.slide } as const;
/** Device px the whole drawings' caches hold in all: 4 x the canvas's `NODE_CACHE_MAX_PX` (W5). */
export const WHOLE_MAX_PX = 32_000_000;
/** How far the canvas's density may move before a whole drawing is made again, as a fraction (W8). */
export const WHOLE_DENSITY_SLACK = 0.1;
/** The longest wait for an idle moment, in ms, before the next whole drawing is made anyway (W6). */
export const WHOLE_TICK_TIMEOUT_MS = 200;
/** The wait before the next turn where the browser has no `requestIdleCallback` (Safari), in ms. */
const WHOLE_TICK_FALLBACK_MS = 16;

/** What the plan needs to know of the canvas and the device. */
export interface WholeEnv {
  /** The primary pointer is coarse (a phone, a tablet): the lighter drawing stays (W2). */
  readonly coarse: boolean;
  /** A service is live on the hub: nothing new is drawn (W2, W9). */
  readonly live: boolean;
  /** The technician's switch `?editor=light` (W2). */
  readonly light: boolean;
  /** The slide's key: the state is kept per slide, object ids repeat across slides (W10). */
  readonly slide: string;
  /** Device px per logical px the canvas draws at (the stage scale x devicePixelRatio). */
  readonly density: number;
  /** The device px the whole drawings' caches may hold in all; default `WHOLE_MAX_PX`. */
  readonly maxPx?: number;
  /**
   * The rectangle the object's node would be cached over at a density, or undefined where it is not to be
   * cached (the canvas passes `nodeCacheRect(o, undefined, density, undefined, drawnHeight(o))`: past
   * `NODE_CACHE_MAX_PX` it is undefined, W4).
   */
  readonly cacheRect: (o: SlideObject, density: number) => { width: number; height: number } | undefined;
}

/** An object drawn whole now: as it was when it was made, at the density it was made at. */
export interface WholeNode {
  readonly o: SlideObject;
  readonly density: number;
  /** Device px of its cache rectangle at that density. */
  readonly px: number;
}

/** What waits for a turn: an object not yet whole, or a whole one to be made again at a new density. */
interface Work extends WholeNode {
  readonly id: string;
}

type Verdict = 'ok' | 'bound' | 'cache';

/** The state of the plans of one slide: what is whole now and what waits. */
export class WholeState {
  /** The key of the slide it holds (undefined: none yet). */
  slide: string | undefined;
  /** The objects drawn whole now, by id. */
  readonly committed = new Map<string, WholeNode>();
  /** What the last plan left waiting, in the order it is made: the selected object, then z-order. */
  work: Work[] = [];
  /** Forget everything (another slide). */
  clear(): void {
    this.committed.clear();
    this.work = [];
  }

  /**
   * Take the next turn: make the first waiting object whole (its cache is made by the canvas in the render
   * this causes). Returns whether more wait. The turn is taken off the queue first, so a turn that fails
   * leaves the queue shorter, never stuck.
   */
  step(): boolean {
    const w = this.work.shift();
    if (w) this.committed.set(w.id, { o: w.o, density: w.density, px: w.px });
    return this.work.length > 0;
  }
}

/** What a plan decided. */
export interface WholePlan {
  /** The ids waiting for a turn, in the order they are taken. */
  readonly pending: readonly string[];
  /** The counts the editor reports (`window.__ordo.editor().whole`). */
  readonly status: Omit<WholeStatus, 'lastMs'>;
  /**
   * The candidates the editor keeps drawing as the lighter copy for a lasting reason: not allowed (a service is
   * live, a coarse pointer, `?editor=light`), or past a bound (too detailed, too big at this zoom, too much in
   * all). Not those waiting for their turn: they are whole in a moment, and the selected one is never among
   * them. The note under the Object panel reads it (OQ-LE2); its length is `blocked + skipped.*`.
   */
  readonly simple: readonly string[];
}

// ---- stability (W7) ------------------------------------------------------------------------------------

/** Fields that are not what an object draws: who it is, where it came from, whether it is locked. */
const NOT_DRAWN = new Set(['id', 'origin', 'locked']);
/** Two values equal by identity, or, if they are plain data, by what they hold (to a depth no stored field has). */
function sameValue(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (depth > 8) return false;
  const array = Array.isArray(a);
  if (array !== Array.isArray(b)) return false;
  if (array) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!sameValue(x[i], y[i], depth + 1)) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if (!sameValue(x[k], y[k], depth + 1)) return false;
  return true;
}

/**
 * Whether two objects draw the same in their own frame (W7): every field but the id, the origin and the lock
 * is the same, and the box is the same size; where it is and how it is turned is not what a node's cache
 * holds (the cache is over the box at the origin, unrotated, and the node turns and places it). Equal by
 * identity or, for plain data, by what it holds: a save replaces the draft with the hub's copy of the same
 * slide, and that must not draw every whole object again.
 */
export function sameDrawn(a: SlideObject, b: SlideObject): boolean {
  if (a === b) return true;
  const x = a as unknown as Record<string, unknown>;
  const y = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (NOT_DRAWN.has(k)) continue;
    if (k === 'box') {
      const p = a.box;
      const q = b.box;
      if (!p || !q || !Object.is(p.w, q.w) || !Object.is(p.h, q.h)) return false;
      continue;
    }
    if (!sameValue(x[k], y[k], 0)) return false;
  }
  return true;
}

// ---- the switch (W2) -----------------------------------------------------------------------------------

/**
 * The technician's switch `?editor=light` on the operator's URL (beside `?profile=edit|full`,
 * lib/capabilities.ts `forcedProfile`): the editor keeps the budget's lighter copies. `search` is the URL's
 * query (default: this page's, read in a try: a page without a location, or one that throws, is not light).
 */
export function readSwitch(search?: string): boolean {
  try {
    const q = search ?? (typeof location === 'undefined' ? '' : location.search);
    return new URLSearchParams(q).get('editor') === 'light';
  } catch {
    return false;
  }
}

// ---- the plan ------------------------------------------------------------------------------------------

/** Whether a cache made at `made` is too far from the canvas's density now (W8). */
function drifted(made: number, now: number): boolean {
  return !(Math.abs(now / made - 1) <= WHOLE_DENSITY_SLACK);
}

/**
 * What an object costs to draw whole and over what it would be cached (`drawnCost` and `drawnEffectArea` are
 * memoised per object by the renderer; the cache rectangle is a few multiplications).
 */
function rate(o: SlideObject, env: WholeEnv): { verdict: Verdict; px: number } {
  // The ORIGINAL object's drawing (W3): the copy is what the budget leaves of it.
  if (drawnCost(o).est > WHOLE_BOUND.est || drawnEffectArea(o) > WHOLE_BOUND.effects)
    return { verdict: 'bound', px: 0 };
  const r = env.cacheRect(o, env.density);
  return r
    ? { verdict: 'ok', px: r.width * r.height * env.density * env.density }
    : { verdict: 'cache', px: 0 };
}

/**
 * Decide what is drawn whole now and what waits, for the slide's `objects` as its `budget` draws them
 * (`slideBudget`), with `selection.primary` the selected object, `state` the plans so far and `env` the canvas
 * and the device. Changes `state` (the objects drawn whole now) and is idempotent: the same inputs again change
 * nothing. Records the counts for `window.__ordo.editor().whole` (`setWholeStatus`).
 *
 * - W1 A candidate is an object the budget changes (text, tables, pictures and shapes it keeps are never
 *   touched).
 * - W2 Allowed only if the pointer is fine, no service is live and `?editor=light` is off. Where it is not,
 *   nothing new is made whole, and nothing is rated (no drawing work at all: W9).
 * - W3-W5 Not whole: an object whose own drawing is past `WHOLE_BOUND`, one that cannot be cached at this
 *   density (past the canvas's node cache: it would be drawn again at every redraw of the layer), and one
 *   that would take the whole drawings' caches past `maxPx`; each keeps its copy and is counted.
 * - W6 The selected candidate is made whole in this plan (an edit never shows the copy for a frame); the rest
 *   wait for a turn (`WholeState.step`, one at a time, in z-order).
 * - W7 A move or a turn keeps a whole object whole (`sameDrawn`); a changed drawing makes it the copy until it
 *   is made again (the selected object in the same plan, the others in their turn).
 * - W8 A whole object keeps its cache while the canvas's density stays within `WHOLE_DENSITY_SLACK` of the
 *   one it was made at; past it, it is made again in its turn and meanwhile keeps drawing from the old cache.
 * - W9 While not allowed, a whole object that has not changed keeps its cache; one that changed draws the copy.
 * - W10 The state is per slide (`env.slide`).
 */
export function planWhole(
  objects: readonly SlideObject[],
  budget: ReadonlyMap<SlideObject, SlideObject>,
  selection: { readonly primary?: string },
  state: WholeState,
  env: WholeEnv,
): WholePlan {
  if (state.slide !== env.slide) {
    state.clear();
    state.slide = env.slide;
  }
  const allowed = !env.coarse && !env.live && !env.light;
  const maxPx = env.maxPx ?? WHOLE_MAX_PX;
  const density = env.density;

  // The candidates, in z-order, once each.
  const cands: SlideObject[] = [];
  const ids = new Set<string>();
  for (const o of objects) {
    if (!budget.has(o) || ids.has(o.id)) continue;
    ids.add(o.id);
    cands.push(o);
  }
  // What is no longer a candidate (the object is gone, or the budget no longer changes it) is forgotten.
  for (const id of [...state.committed.keys()]) if (!ids.has(id)) state.committed.delete(id);

  // A changed drawing is the copy again (W7); the same drawing is remembered as the object now at hand.
  for (const o of cands) {
    const c = state.committed.get(o.id);
    if (!c) continue;
    if (!sameDrawn(c.o, o)) state.committed.delete(o.id);
    else if (c.o !== o) state.committed.set(o.id, { o, density: c.density, px: c.px });
  }

  // The selected candidate first, then z-order.
  const primary = selection.primary;
  const first = primary === undefined ? undefined : cands.find((o) => o.id === primary);
  const order = first ? [first, ...cands.filter((o) => o !== first)] : cands;

  let held = 0; // device px the caches hold or are about to
  let drawnPx = 0;
  for (const c of state.committed.values()) {
    held += c.px;
    drawnPx += c.px;
  }
  const status = {
    wanted: cands.length,
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
  const work: Work[] = [];
  const simple: string[] = [];

  for (const o of order) {
    const c = state.committed.get(o.id);
    // Whole at about this density: nothing to do.
    if (c && !drifted(c.density, density)) {
      status.drawn++;
      continue;
    }
    // Not allowed: a whole object keeps its cache (W9), the others are blocked; nothing is rated.
    if (!allowed) {
      if (c) status.stale++;
      if (c) status.drawn++;
      else {
        status.blocked++;
        simple.push(o.id);
      }
      continue;
    }
    const r = rate(o, env);
    const was = c?.px ?? 0;
    const why = r.verdict !== 'ok' ? r.verdict : held - was + r.px > maxPx ? 'total' : undefined;
    if (why) {
      // Too much for the canvas now (W3-W5): the copy, until the zoom or the slide allows more.
      if (c) {
        state.committed.delete(o.id);
        held -= was;
        drawnPx -= was;
      }
      status.skipped[why]++;
      simple.push(o.id);
      continue;
    }
    held += r.px - was;
    if (!c && o.id === primary) {
      // The selected object is whole in this plan: an edit never shows the copy for a frame (W6).
      state.committed.set(o.id, { o, density, px: r.px });
      drawnPx += r.px;
      status.drawn++;
      continue;
    }
    if (c) {
      status.drawn++;
      status.stale++;
    } else status.pending++;
    work.push({ id: o.id, o, density, px: r.px });
  }
  state.work = work;
  status.px = drawnPx;
  setWholeStatus(status);
  return { pending: work.map((w) => w.id), status, simple };
}

/**
 * What a node draws for `o`: undefined where `o` itself (it is whole now and has not changed in what it
 * draws), else the budget's copy (undefined too where the budget changes nothing). Read after `planWhole`.
 */
export function drawWhole(
  o: SlideObject,
  budget: ReadonlyMap<SlideObject, SlideObject>,
  _env: WholeEnv,
  state: WholeState,
): SlideObject | undefined {
  const c = state.committed.get(o.id);
  if (c && (c.o === o || sameDrawn(c.o, o))) return undefined;
  return budget.get(o);
}

/**
 * The density an object's node is cached at (W8): the one it was made whole at, else the canvas's. A whole
 * node keeps its cache (and does not draw again) while the canvas's density stays within the slack.
 */
export function wholeDensity(o: SlideObject, env: WholeEnv, state: WholeState): number {
  return state.committed.get(o.id)?.density ?? env.density;
}

// ---- the turns (W6) ------------------------------------------------------------------------------------

/**
 * One turn at a time: `request()` asks for a turn at the next idle moment (`requestIdleCallback` with a
 * `WHOLE_TICK_TIMEOUT_MS` timeout, else 16 ms on a timer), once however often it is asked; the turn runs
 * `step`, then `after` (the canvas draws what the turn made whole), and no other turn is asked for until the
 * next `request()`, which the canvas makes after that draw, so a turn is never started before the last
 * one's frame. A turn that throws never stops the queue.
 */
export class WholeScheduler {
  private handle: { idle: boolean; h: unknown } | undefined;
  private readonly step: () => void;
  private readonly after: (() => void) | undefined;

  constructor(step: () => void, after?: () => void) {
    this.step = step;
    this.after = after;
  }

  /** A turn is waiting for its moment. */
  get waiting(): boolean {
    return this.handle !== undefined;
  }

  request(): void {
    if (this.handle) return;
    const g = globalThis as {
      requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => unknown;
    };
    const run = () => {
      this.handle = undefined;
      try {
        this.step();
      } catch {
        // A failed turn is not the queue's end: the next one is asked for after the draw below.
      }
      try {
        this.after?.();
      } catch {
        // The canvas is gone: nothing to draw.
      }
    };
    this.handle = g.requestIdleCallback
      ? { idle: true, h: g.requestIdleCallback(run, { timeout: WHOLE_TICK_TIMEOUT_MS }) }
      : { idle: false, h: setTimeout(run, WHOLE_TICK_FALLBACK_MS) };
  }

  cancel(): void {
    const w = this.handle;
    this.handle = undefined;
    if (!w) return;
    if (w.idle) (globalThis as { cancelIdleCallback?: (h: unknown) => void }).cancelIdleCallback?.(w.h);
    else clearTimeout(w.h as ReturnType<typeof setTimeout>);
  }
}

// ---- the canvas hook -----------------------------------------------------------------------------------

/** `?editor=light`, read once when the first canvas asks (the page's URL does not change under the editor). */
let light: boolean | undefined;

/** What the canvas tells the hook; the rest (a service is live, the switch) the hook reads itself. */
export interface WholeDrawOptions {
  /** The primary selected object's id. */
  readonly selectedId?: string;
  /** Device px per logical px the canvas draws at. */
  readonly density: number;
  /** The primary pointer is coarse. */
  readonly coarse: boolean;
  /** The slide's key (the presentation's and the slide's id): the state is kept per slide. */
  readonly slideId: string;
  /** `nodeCacheRect` as the canvas calls it for a node (W4). */
  readonly cacheRect: WholeEnv['cacheRect'];
}

/** What the canvas draws for each object and the density it caches it at. */
export interface WholeDraw {
  /** What the node draws instead of `o` (the budget's copy), undefined where it draws `o` itself. */
  drawAs(o: SlideObject): SlideObject | undefined;
  /** Device px per logical px the node's cache is made at. */
  density(o: SlideObject): number;
  /** The node is drawn whole (its cache is the whole drawing, timed by `noteWholeDraw`). */
  isWhole(o: SlideObject): boolean;
}

/**
 * The canvas's whole drawing (design/15 "Canvas drawing"): plans in the render (`planWhole`, idempotent),
 * takes one waiting object's turn at each idle moment (`WholeScheduler`) and draws the canvas again once per
 * turn, never a turn before the last one's frame (the next turn is asked for after the commit). Where a
 * service is live (the hub's `useLive`: any service, on any computer), the pointer is coarse or
 * `?editor=light` is on, it asks for no turn at all and adds no timer.
 */
export function useWholeDraw(
  objects: readonly SlideObject[],
  budget: ReadonlyMap<SlideObject, SlideObject>,
  opts: WholeDrawOptions,
): WholeDraw {
  const live = useLive((s) => s.state.mode === 'live');
  light ??= readSwitch();
  const [, draw] = useReducer((n: number) => n + 1, 0);
  const state = useRef<WholeState | undefined>(undefined);
  state.current ??= new WholeState();
  const turns = useRef<WholeScheduler | undefined>(undefined);
  turns.current ??= new WholeScheduler(
    () => state.current?.step(),
    () => draw(),
  );
  const env: WholeEnv = {
    coarse: opts.coarse,
    live,
    light,
    slide: opts.slideId,
    density: opts.density,
    cacheRect: opts.cacheRect,
  };
  const plan = planWhole(objects, budget, { primary: opts.selectedId }, state.current, env);
  const waiting = plan.pending.length > 0;
  // After every commit: the Object panel's note is told which objects keep the copy (OQ-LE2), and the next turn
  // is asked for only now, once the last one's object has been drawn.
  useEffect(() => {
    setWholeLighter(opts.slideId, plan.simple);
    if (waiting) turns.current?.request();
    else turns.current?.cancel();
  });
  useEffect(
    () => () => {
      turns.current?.cancel();
      setWholeLighter(undefined, []);
    },
    [],
  );
  const s = state.current;
  return {
    drawAs: (o) => drawWhole(o, budget, env, s),
    density: (o) => wholeDensity(o, env, s),
    isWhole: (o) => budget.has(o) && drawWhole(o, budget, env, s) === undefined,
  };
}
