/**
 * The editor draws an object whole where the slide's drawing budget would draw its lighter copy (design/15
 * "Canvas drawing"; views/editor/wholeDraw.ts). The rule is a function of the slide's objects, its budget, the
 * selection and the state of the last plan, so everything decidable is tested here without a canvas: which
 * objects go whole, when, in what order and how many at a time; the canvas wiring is the end-to-end specs'
 * (e2e/editor-whole.spec.ts).
 */
import { type Slide, type SlideObject, slideContent } from '@ordo/domain';
import { drawnEffectArea, slideBudget } from '@ordo/renderer';
import { EFFECT_COST } from '@ordo/renderer/geom/cost.ts';
import { recordingCtx } from '@ordo/renderer/text/test-util.ts';
import { effectsSlide, PANEL_SHADOW, softFrame } from '@ordo/renderer/units.effects.test-util.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeCacheRect } from '../src/views/editor/SlideCanvas.tsx';
import {
  drawWhole,
  planWhole,
  readSwitch,
  sameDrawn,
  WHOLE_BOUND,
  WHOLE_DENSITY_SLACK,
  WHOLE_MAX_PX,
  WHOLE_TICK_TIMEOUT_MS,
  WholeScheduler,
  WholeState,
  type WholeEnv,
  wholeDensity,
} from '../src/views/editor/wholeDraw.ts';
import {
  noteWholeDraw,
  resetWholeStatus,
  WHOLE_LAST_KEPT,
  wholeStatus,
} from '../src/views/editor/wholeState.ts';

const ctx = recordingCtx();

/** The canvas's cache rectangle of an object (`nodeCacheRect` as SlideCanvas passes it). */
const cacheRect: WholeEnv['cacheRect'] = (o, density) => nodeCacheRect(o, undefined, density, ctx, o.box.h);

function env(over: Partial<WholeEnv> = {}): WholeEnv {
  return { coarse: false, live: false, light: false, slide: 's1', density: 1, cacheRect, ...over };
}

const objectsOf = (slide: Slide): SlideObject[] => slideContent(slide).objects;
const byId = (objects: readonly SlideObject[], id: string): SlideObject => objects.find((o) => o.id === id)!;
/** The slide of 12 shadowed panels over a soft frame: the budget draws p9, p10 and p11 without their shadow. */
const effects = () => objectsOf(effectsSlide());
const LATE = ['p9', 'p10', 'p11'];

/** The device px of an object's whole cache at a density. */
function rectPx(o: SlideObject, density: number): number {
  const r = cacheRect(o, density)!;
  return r.width * r.height * density * density;
}

/** A plan, then every pending turn taken (what the scheduler does, one object a tick), a plan after each. */
function settle(
  objects: readonly SlideObject[],
  budget: ReadonlyMap<SlideObject, SlideObject>,
  primary: string | undefined,
  state: WholeState,
  e: WholeEnv,
) {
  let plan = planWhole(objects, budget, { primary }, state, e);
  for (let i = 0; i < 100 && plan.pending.length; i++) {
    state.step();
    plan = planWhole(objects, budget, { primary }, state, e);
  }
  return plan;
}

beforeEach(() => resetWholeStatus());

describe('what is a candidate and what goes whole (W1, W6)', () => {
  it('(a) the objects the budget changes are the candidates: the selected one goes whole at once, the rest one a turn in z-order', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    // The fixture: the budget changes exactly p9, p10 and p11 (units.effects.test.ts pins it for the renderer).
    expect(objects.filter((o) => budget.has(o)).map((o) => o.id)).toEqual(LATE);
    const state = new WholeState();
    const plan = planWhole(objects, budget, { primary: 'p10' }, state, env());
    expect(plan.status).toMatchObject({ wanted: 3, drawn: 1, pending: 2, blocked: 0 });
    expect(plan.pending).toEqual(['p9', 'p11']);
    // The selected one is whole in the plan that found it (no flash of the copy); the others are the copy.
    expect(drawWhole(byId(objects, 'p10'), budget, env(), state)).toBeUndefined();
    for (const id of ['p9', 'p11']) {
      const o = byId(objects, id);
      expect(drawWhole(o, budget, env(), state)).toBe(budget.get(o));
    }
    // One object a turn, in z-order.
    expect(state.step()).toBe(true);
    expect(drawWhole(byId(objects, 'p9'), budget, env(), state)).toBeUndefined();
    expect(drawWhole(byId(objects, 'p11'), budget, env(), state)).toBe(budget.get(byId(objects, 'p11')));
    expect(state.step()).toBe(false);
    for (const id of LATE) expect(drawWhole(byId(objects, id), budget, env(), state)).toBeUndefined();
    const done = planWhole(objects, budget, { primary: 'p10' }, state, env());
    expect(done.status).toMatchObject({ wanted: 3, drawn: 3, pending: 0, blocked: 0 });
    expect(done.pending).toEqual([]);
  });

  it('(a) with nothing selected every candidate waits for its turn, in z-order', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const state = new WholeState();
    const plan = planWhole(objects, budget, {}, state, env());
    expect(plan.status).toMatchObject({ wanted: 3, drawn: 0, pending: 3 });
    expect(plan.pending).toEqual(LATE);
    const order: string[] = [];
    for (let more = true; more; ) {
      more = state.step();
      order.push([...state.committed.keys()].at(-1)!);
    }
    expect(order).toEqual(LATE);
  });

  it('an object the budget keeps is never touched: text, plain shapes, the kept shadows draw as they are', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const state = new WholeState();
    settle(objects, budget, undefined, state, env());
    for (const o of objects.filter((o) => !budget.has(o))) {
      expect(state.committed.has(o.id)).toBe(false);
      expect(drawWhole(o, budget, env(), state)).toBeUndefined();
    }
    expect([...state.committed.keys()]).toEqual(LATE);
  });
});

describe('when it is allowed (W2, W9)', () => {
  it.each<[string, Partial<WholeEnv>]>([
    ['a coarse pointer', { coarse: true }],
    ['a live service', { live: true }],
    ['?editor=light', { light: true }],
  ])(
    '(b) %s admits nothing, not even the selected object, and every object keeps its copy',
    (_name, over) => {
      const objects = effects();
      const budget = slideBudget(objects);
      const state = new WholeState();
      const e = env(over);
      const plan = planWhole(objects, budget, { primary: 'p10' }, state, e);
      expect(plan.status).toMatchObject({ wanted: 3, drawn: 0, pending: 0, blocked: 3 });
      expect(plan.pending).toEqual([]);
      expect(state.step()).toBe(false);
      for (const id of LATE) {
        const o = byId(objects, id);
        expect(drawWhole(o, budget, e, state)).toBe(budget.get(o));
      }
      // The status says why.
      expect(plan.status).toMatchObject({
        coarse: !!over.coarse,
        live: !!over.live,
        light: !!over.light,
      });
    },
  );

  it('(h) a service going live keeps the whole drawings that are unchanged, and draws a changed one as its copy', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const state = new WholeState();
    settle(objects, budget, undefined, state, env());
    expect(state.committed.size).toBe(3);
    // Go live: nothing is demoted (no burst of drawing at the moment of Go live).
    const live = env({ live: true });
    const kept = planWhole(objects, budget, { primary: 'p10' }, state, live);
    expect(kept.status).toMatchObject({ wanted: 3, drawn: 3, pending: 0, blocked: 0, live: true });
    for (const id of LATE) expect(drawWhole(byId(objects, id), budget, live, state)).toBeUndefined();
    // A change meanwhile draws the copy, even for the selected object.
    const edited = objects.map(
      (o) => (o.id === 'p10' ? { ...o, shadow: { ...PANEL_SHADOW, blur: 20 } } : o) as SlideObject,
    );
    const budget2 = slideBudget(edited);
    const during = planWhole(edited, budget2, { primary: 'p10' }, state, live);
    expect(during.status).toMatchObject({ wanted: 3, drawn: 2, pending: 0, blocked: 1 });
    const p10 = byId(edited, 'p10');
    expect(drawWhole(p10, budget2, live, state)).toBe(budget2.get(p10));
    // End service: the changed one is queued again.
    const after = planWhole(edited, budget2, { primary: undefined }, state, env());
    expect(after.pending).toEqual(['p10']);
    expect(after.status).toMatchObject({ drawn: 2, pending: 1, blocked: 0, live: false });
  });

  it('(h) a slide opened while live is drawn whole, in z-order, once the service ends', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const state = new WholeState();
    const live = planWhole(objects, budget, { primary: 'p11' }, state, env({ live: true }));
    expect(live.status).toMatchObject({ drawn: 0, blocked: 3, pending: 0 });
    const ended = planWhole(objects, budget, { primary: undefined }, state, env({ live: false }));
    expect(ended.pending).toEqual(LATE);
    expect(ended.status).toMatchObject({ blocked: 0, pending: 3 });
  });

  it('(i) a different slide clears the state: the same ids on another slide are candidates again', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const state = new WholeState();
    settle(objects, budget, undefined, state, env({ slide: 'one' }));
    expect(state.committed.size).toBe(3);
    // Another slide whose objects carry the same ids (ids repeat across slides).
    const other = objectsOf(effectsSlide());
    const budget2 = slideBudget(other);
    const plan = planWhole(other, budget2, {}, state, env({ slide: 'two' }));
    expect(plan.status).toMatchObject({ wanted: 3, drawn: 0, pending: 3 });
    for (const id of LATE) {
      const o = byId(other, id);
      expect(drawWhole(o, budget2, env({ slide: 'two' }), state)).toBe(budget2.get(o));
    }
  });
});

describe('the bounds (W3, W4, W5)', () => {
  /** The effects slide and a shape that is past the slide's whole effect budget by itself. */
  function withHuge(): { objects: SlideObject[]; huge: SlideObject } {
    const huge = {
      ...softFrame(),
      id: 'huge',
      softEdge: 60,
      shadow: { ...PANEL_SHADOW, blur: 300 },
      glow: { radius: 300, color: { r: 255, g: 255, b: 0, a: 0.6 } },
    } as SlideObject;
    return { objects: [...effects(), huge], huge };
  }

  it('(c) an object whose own effects pass the slide’s whole budget keeps its copy, counted as too much to draw', () => {
    const { objects, huge } = withHuge();
    const budget = slideBudget(objects);
    expect(budget.has(huge)).toBe(true);
    expect(drawnEffectArea(huge)).toBeGreaterThan(WHOLE_BOUND.effects);
    expect(WHOLE_BOUND.effects).toBe(EFFECT_COST.slide);
    const state = new WholeState();
    const plan = settle(objects, budget, 'huge', state, env());
    expect(plan.status).toMatchObject({ wanted: 4, drawn: 3, pending: 0, blocked: 0 });
    expect(plan.status.skipped).toEqual({ bound: 1, cache: 0, total: 0 });
    // Even selected: the copy.
    expect(drawWhole(huge, budget, env(), state)).toBe(budget.get(huge));
  });

  /** A full-slide shape with a shadow, after the panels: the budget draws it without the shadow. */
  function withFull(): { objects: SlideObject[]; full: SlideObject } {
    const full = { ...softFrame(), id: 'full', softEdge: undefined, shadow: PANEL_SHADOW } as SlideObject;
    return { objects: [...effects(), full], full };
  }

  it('(d) an object too big to cache at this zoom keeps its copy, and goes whole when the zoom is lower', () => {
    const { objects, full } = withFull();
    const budget = slideBudget(objects);
    expect(budget.has(full)).toBe(true);
    // At 4 device px per logical px the full-slide cache is past the canvas's 8-million-pixel node cache.
    expect(cacheRect(full, 4)).toBeUndefined();
    expect(cacheRect(full, 1)).toBeDefined();
    const state = new WholeState();
    const zoomed = settle(objects, budget, 'full', state, env({ density: 4 }));
    expect(zoomed.status.skipped.cache).toBe(1);
    expect(zoomed.status.wanted).toBe(4);
    expect(drawWhole(full, budget, env({ density: 4 }), state)).toBe(budget.get(full));
    // Zoomed out, the same object goes whole (the selected one at once).
    const out = planWhole(objects, budget, { primary: 'full' }, state, env({ density: 1 }));
    expect(out.status.skipped.cache).toBe(0);
    expect(drawWhole(full, budget, env({ density: 1 }), state)).toBeUndefined();
  });

  it('(d) a whole drawing that no longer fits the cache at a higher zoom goes back to the copy', () => {
    const { objects, full } = withFull();
    const budget = slideBudget(objects);
    const state = new WholeState();
    settle(objects, budget, 'full', state, env({ density: 1 }));
    expect(drawWhole(full, budget, env({ density: 1 }), state)).toBeUndefined();
    const plan = planWhole(objects, budget, { primary: 'full' }, state, env({ density: 4 }));
    expect(plan.status.skipped.cache).toBe(1);
    expect(drawWhole(full, budget, env({ density: 4 }), state)).toBe(budget.get(full));
  });

  it('(e) the whole drawings’ caches stay within the total: later objects keep the copy, counted by total', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const one = rectPx(byId(objects, 'p9'), 1);
    expect(WHOLE_MAX_PX).toBe(32_000_000);
    const e = env({ maxPx: Math.floor(one * 1.5) });
    const state = new WholeState();
    const plan = settle(objects, budget, undefined, state, e);
    expect(plan.status).toMatchObject({ wanted: 3, drawn: 1, pending: 0 });
    expect(plan.status.skipped).toEqual({ bound: 0, cache: 0, total: 2 });
    expect(plan.status.px).toBe(one);
    expect(drawWhole(byId(objects, 'p9'), budget, e, state)).toBeUndefined();
    for (const id of ['p10', 'p11']) {
      const o = byId(objects, id);
      expect(drawWhole(o, budget, e, state)).toBe(budget.get(o));
    }
  });

  it('(e) the selected object is counted first: it gets the room before the objects under it', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const one = rectPx(byId(objects, 'p9'), 1);
    const e = env({ maxPx: Math.floor(one * 1.5) });
    const state = new WholeState();
    const plan = settle(objects, budget, 'p11', state, e);
    expect([...state.committed.keys()]).toEqual(['p11']);
    expect(plan.status.skipped.total).toBe(2);
  });
});

describe('an edit does not flash the copy (W7)', () => {
  it('(f) a move or a turn of a whole object keeps it whole; a changed shadow demotes it and re-admits the selected one in the same plan', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const state = new WholeState();
    settle(objects, budget, 'p11', state, env());
    expect(state.committed.size).toBe(3);

    const moved = objects.map(
      (o) =>
        (o.id === 'p11'
          ? { ...o, box: { ...o.box, x: o.box.x + 1, y: o.box.y - 3, rotation: 7 } }
          : o) as SlideObject,
    );
    const movedBudget = slideBudget(moved);
    expect(movedBudget.has(byId(moved, 'p11'))).toBe(true);
    const keep = planWhole(moved, movedBudget, { primary: 'p11' }, state, env());
    expect(keep.status).toMatchObject({ drawn: 3, pending: 0 });
    expect(drawWhole(byId(moved, 'p11'), movedBudget, env(), state)).toBeUndefined();

    // A changed size is a changed drawing.
    const wider = moved.map(
      (o) => (o.id === 'p11' ? { ...o, box: { ...o.box, w: o.box.w + 20 } } : o) as SlideObject,
    );
    expect(sameDrawn(byId(moved, 'p11'), byId(wider, 'p11'))).toBe(false);

    // A changed shadow: the selected one is whole again in the same plan; an unselected one waits for a turn.
    const edited = moved.map(
      (o) =>
        (o.id === 'p11' || o.id === 'p9' ? { ...o, shadow: { ...PANEL_SHADOW, dx: 14 } } : o) as SlideObject,
    );
    const editedBudget = slideBudget(edited);
    const plan = planWhole(edited, editedBudget, { primary: 'p11' }, state, env());
    expect(drawWhole(byId(edited, 'p11'), editedBudget, env(), state)).toBeUndefined();
    const p9 = byId(edited, 'p9');
    expect(drawWhole(p9, editedBudget, env(), state)).toBe(editedBudget.get(p9));
    expect(plan.pending).toEqual(['p9']);
    expect(plan.status).toMatchObject({ drawn: 2, pending: 1 });
    // The committed copy of p11 is the edited object, so the next edit that changes nothing keeps it.
    expect(state.committed.get('p11')!.o).toBe(byId(edited, 'p11'));
  });

  it('(f) an object the hub sent again with the same content is the same drawing (a save replaces the draft)', () => {
    const objects = effects();
    const again = JSON.parse(JSON.stringify(objects)) as SlideObject[];
    for (const id of LATE) expect(sameDrawn(byId(objects, id), byId(again, id))).toBe(true);
    const changed = {
      ...byId(again, 'p9'),
      shadow: { ...PANEL_SHADOW, color: { r: 1, g: 2, b: 3, a: 1 } },
    } as SlideObject;
    expect(sameDrawn(byId(objects, 'p9'), changed)).toBe(false);
  });

  it('sameDrawn leaves out the id, the origin, the lock and the box’s place and turn only', () => {
    const o = byId(effects(), 'p9');
    const x = (patch: Record<string, unknown>) => ({ ...o, ...patch }) as SlideObject;
    expect(sameDrawn(o, x({ id: 'other', origin: 'import', locked: true }))).toBe(true);
    expect(sameDrawn(o, x({ box: { ...o.box, x: 5, y: 9, rotation: 40 } }))).toBe(true);
    expect(sameDrawn(o, x({ box: { ...o.box, w: o.box.w + 1 } }))).toBe(false);
    expect(sameDrawn(o, x({ box: { ...o.box, h: o.box.h - 1 } }))).toBe(false);
    expect(sameDrawn(o, x({ opacity: 0.5 }))).toBe(false);
    expect(sameDrawn(o, x({ shadow: undefined }))).toBe(false);
    expect(sameDrawn(o, x({ type: 'text' }))).toBe(false);
  });
});

describe('the zoom (W8)', () => {
  it('(g) a density within the slack keeps the committed density; past it the node is made again one a turn and keeps its old density meanwhile', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const state = new WholeState();
    settle(objects, budget, undefined, state, env({ density: 1 }));
    expect(WHOLE_DENSITY_SLACK).toBe(0.1);
    // Within the slack: nothing to do, the cache stays at 1.
    const near = env({ density: 1.08 });
    const stay = planWhole(objects, budget, {}, state, near);
    expect(stay.pending).toEqual([]);
    expect(stay.status).toMatchObject({ drawn: 3, stale: 0 });
    for (const id of LATE) expect(wholeDensity(byId(objects, id), near, state)).toBe(1);
    // Past it: each whole node waits for its turn and keeps drawing from its old cache.
    const far = env({ density: 1.5 });
    const plan = planWhole(objects, budget, {}, state, far);
    expect(plan.pending).toEqual(LATE);
    expect(plan.status).toMatchObject({ drawn: 3, stale: 3, pending: 0 });
    for (const id of LATE) {
      expect(drawWhole(byId(objects, id), budget, far, state)).toBeUndefined();
      expect(wholeDensity(byId(objects, id), far, state)).toBe(1);
    }
    // One a turn, in z-order.
    expect(state.step()).toBe(true);
    expect(wholeDensity(byId(objects, 'p9'), far, state)).toBe(1.5);
    expect(wholeDensity(byId(objects, 'p10'), far, state)).toBe(1);
    expect(wholeDensity(byId(objects, 'p11'), far, state)).toBe(1);
    expect(state.step()).toBe(true);
    expect(state.step()).toBe(false);
    const done = planWhole(objects, budget, {}, state, far);
    expect(done.status).toMatchObject({ drawn: 3, stale: 0 });
    expect(done.pending).toEqual([]);
  });

  it('a node that is not whole is cached at the canvas’s density, as before', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const state = new WholeState();
    const e = env({ density: 1.37 });
    planWhole(objects, budget, {}, state, e);
    expect(wholeDensity(byId(objects, 'p0'), e, state)).toBe(1.37);
    expect(wholeDensity(byId(objects, 'p9'), e, state)).toBe(1.37);
  });

  it('while a service is live a node whose zoom changed keeps its old cache and nothing is made', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const state = new WholeState();
    settle(objects, budget, undefined, state, env({ density: 1 }));
    const live = env({ live: true, density: 2 });
    const plan = planWhole(objects, budget, {}, state, live);
    expect(plan.pending).toEqual([]);
    expect(state.step()).toBe(false);
    for (const id of LATE) expect(wholeDensity(byId(objects, id), live, state)).toBe(1);
  });
});

describe('the status (W11)', () => {
  it('counts every candidate once: wanted = drawn + pending + blocked + the three skips', () => {
    const huge = {
      ...softFrame(),
      id: 'huge',
      softEdge: 60,
      shadow: { ...PANEL_SHADOW, blur: 300 },
      glow: { radius: 300, color: { r: 255, g: 255, b: 0, a: 0.6 } },
    } as SlideObject;
    const full = { ...softFrame(), id: 'full', softEdge: undefined, shadow: PANEL_SHADOW } as SlideObject;
    const objects = [...effects(), huge, full];
    const budget = slideBudget(objects);
    const one = rectPx(byId(objects, 'p9'), 3);
    const state = new WholeState();
    const e = env({ density: 3, maxPx: Math.floor(one * 1.5) });
    let plan = planWhole(objects, budget, { primary: 'p9' }, state, e);
    const sum = (s: typeof plan.status) =>
      s.drawn + s.pending + s.blocked + s.skipped.bound + s.skipped.cache + s.skipped.total;
    expect(plan.status.wanted).toBe(budget.size);
    expect(sum(plan.status)).toBe(plan.status.wanted);
    plan = settle(objects, budget, 'p9', state, e);
    expect(sum(plan.status)).toBe(plan.status.wanted);
    expect(plan.status.skipped.bound).toBe(1);
    expect(plan.status.skipped.total).toBeGreaterThan(0);
    // Not allowed: everything not drawn is blocked.
    plan = planWhole(objects, budget, {}, new WholeState(), env({ live: true }));
    expect(plan.status.blocked).toBe(plan.status.wanted);
    expect(sum(plan.status)).toBe(plan.status.wanted);
  });

  it('is what window.__ordo.editor().whole reads, with the times of the last whole draws', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    const state = new WholeState();
    const plan = settle(objects, budget, undefined, state, env({ density: 2 }));
    const s = wholeStatus();
    expect(s).toMatchObject({ ...plan.status, lastMs: [] });
    expect(s.px).toBe(LATE.reduce((n, id) => n + rectPx(byId(objects, id), 2), 0));
    noteWholeDraw('p9', 12.5);
    noteWholeDraw('p10', 14);
    expect(wholeStatus().lastMs).toEqual([
      { id: 'p9', ms: 12.5 },
      { id: 'p10', ms: 14 },
    ]);
    // A later plan keeps the times.
    planWhole(objects, budget, {}, state, env({ density: 2 }));
    expect(wholeStatus().lastMs).toHaveLength(2);
    // Only the last WHOLE_LAST_KEPT are kept.
    for (let i = 0; i < WHOLE_LAST_KEPT + 10; i++) noteWholeDraw(`o${i}`, i);
    const kept = wholeStatus().lastMs;
    expect(kept).toHaveLength(WHOLE_LAST_KEPT);
    expect(kept.at(-1)).toEqual({ id: `o${WHOLE_LAST_KEPT + 9}`, ms: WHOLE_LAST_KEPT + 9 });
  });

  it('says why nothing is drawn: coarse, live and light', () => {
    const objects = effects();
    const budget = slideBudget(objects);
    planWhole(objects, budget, {}, new WholeState(), env({ coarse: true, live: true, light: true }));
    expect(wholeStatus()).toMatchObject({ coarse: true, live: true, light: true, blocked: 3, drawn: 0 });
  });
});

describe('?editor=light (W2)', () => {
  it('(j) is on for editor=light and nothing else', () => {
    expect(readSwitch('?editor=light')).toBe(true);
    expect(readSwitch('?a=1&editor=light')).toBe(true);
    expect(readSwitch('')).toBe(false);
    expect(readSwitch('?editor=whole')).toBe(false);
    expect(readSwitch('?editor=lighter')).toBe(false);
    expect(readSwitch('?editor')).toBe(false);
    expect(readSwitch('?profile=edit')).toBe(false);
  });

  it('(j) reads the page’s own URL when none is given, and a location that throws is off', () => {
    vi.stubGlobal('location', { search: '?editor=light' });
    expect(readSwitch()).toBe(true);
    vi.stubGlobal('location', {
      get search(): string {
        throw new Error('no location');
      },
    });
    expect(readSwitch()).toBe(false);
    vi.unstubAllGlobals();
    // No window at all (a test, a worker): off.
    expect(readSwitch()).toBe(false);
  });
});

/**
 * The page's idle moments, as a test drives them: `requestIdleCallback` (and its cancel) and the timers are
 * stubbed on the global object, as the scheduler reads them when it is asked for a turn.
 */
function fakeHost(withIdle = true) {
  const idle: { cb: () => void; timeout: number; cancelled: boolean }[] = [];
  const timers: { cb: () => void; ms: number; cancelled: boolean }[] = [];
  vi.stubGlobal(
    'requestIdleCallback',
    withIdle
      ? (cb: () => void, opts: { timeout: number }) => {
          const h = { cb, timeout: opts.timeout, cancelled: false };
          idle.push(h);
          return h;
        }
      : undefined,
  );
  vi.stubGlobal(
    'cancelIdleCallback',
    withIdle
      ? (h: { cancelled: boolean }) => {
          h.cancelled = true;
        }
      : undefined,
  );
  vi.stubGlobal('setTimeout', (cb: () => void, ms: number) => {
    const h = { cb, ms, cancelled: false };
    timers.push(h);
    return h;
  });
  vi.stubGlobal('clearTimeout', (h: { cancelled: boolean }) => {
    h.cancelled = true;
  });
  /** Run what is waiting, as the browser does at the next idle moment (or timer). */
  const run = () => {
    const h = [...idle, ...timers].find((x) => !x.cancelled);
    if (!h) return false;
    h.cancelled = true;
    h.cb();
    return true;
  };
  return { idle, timers, run };
}

afterEach(() => vi.unstubAllGlobals());

describe('WholeScheduler (W6)', () => {
  it('(k) takes one turn at an idle moment (with the 200 ms timeout), once however often it is asked', () => {
    const h = fakeHost();
    const step = vi.fn();
    const after = vi.fn();
    const s = new WholeScheduler(step, after);
    expect(WHOLE_TICK_TIMEOUT_MS).toBe(200);
    s.request();
    s.request();
    s.request();
    expect(h.idle).toHaveLength(1);
    expect(h.idle[0]!.timeout).toBe(200);
    expect(s.waiting).toBe(true);
    expect(step).not.toHaveBeenCalled();
    expect(h.run()).toBe(true);
    expect(step).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    // Nothing more until the next turn is asked for (after the object's frame).
    expect(s.waiting).toBe(false);
    expect(h.run()).toBe(false);
    s.request();
    expect(h.idle).toHaveLength(2);
    h.run();
    expect(step).toHaveBeenCalledTimes(2);
  });

  it('(k) without requestIdleCallback it waits 16 ms on a timer', () => {
    const h = fakeHost(false);
    const step = vi.fn();
    const s = new WholeScheduler(step);
    s.request();
    expect(h.idle).toHaveLength(0);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(16);
    h.run();
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('(k) is cancelled when the canvas goes away: the turn that was waiting never runs, and it can be asked again', () => {
    const h = fakeHost();
    const step = vi.fn();
    const s = new WholeScheduler(step);
    s.request();
    s.cancel();
    expect(s.waiting).toBe(false);
    expect(h.idle[0]!.cancelled).toBe(true);
    expect(h.run()).toBe(false);
    expect(step).not.toHaveBeenCalled();
    s.request();
    h.run();
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('(k) a turn that throws never stops the queue: the next turn is asked for and runs', () => {
    const h = fakeHost();
    const step = vi.fn().mockImplementationOnce(() => {
      throw new Error('a draw failed');
    });
    const after = vi.fn();
    const s = new WholeScheduler(step, after);
    s.request();
    expect(() => h.run()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    s.request();
    h.run();
    expect(step).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
  });
});
