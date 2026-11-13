/**
 * The PaintPopover's paint and gradient-stop edits (design/15 "Paint picker"; components/paintStops.ts), as
 * pure functions: what each tab, the ramp, the pins, the % field and the + / × buttons store, and which stop
 * the sliders stay on afterwards. #24 moved these edits into the popover (the Object panel's stop rows went
 * away with editorShapes.test.ts's driven stop tests); they are tested here instead. Also the sliders' sync
 * (`syncHsv`), whose identity on an unchanged colour is what keeps the popover from rendering forever on
 * 'None' (r24 b3).
 */
import { Gradient, type Rgba } from '@ordo/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { rgbaToHsv } from '../src/components/colorMath.ts';
import {
  activeColorOf,
  addStop,
  clampStop,
  DEFAULT_LINEAR_ANGLE,
  DEFAULT_SOLID,
  MAX_GRAD_STOPS,
  MIN_GRAD_STOPS,
  moveStop,
  type PaintValue,
  paintMode,
  removeStop,
  sampleGradient,
  setStopColor,
  shadeColor,
  sortedGradient,
  sortStopsKeeping,
  stopPosition,
  switchPaintMode,
  syncHsv,
} from '../src/components/paintStops.ts';

const red: Rgba = { r: 200, g: 40, b: 40, a: 1 };
const blue: Rgba = { r: 20, g: 60, b: 220, a: 1 };
const gold: Rgba = { r: 240, g: 200, b: 40, a: 0.5 };
const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };

const lin = (stops: [number, Rgba][], extra: Partial<Gradient> = {}): Gradient => ({
  kind: 'linear',
  angle: 45,
  stops: stops.map(([at, color]) => ({ at, color })),
  ...extra,
});
const ats = (g: Gradient) => g.stops.map((s) => s.at);

describe('paintStops: positions and order', () => {
  it('clamps an index into the stops (0 for none, NaN or fractions)', () => {
    const g = lin([
      [0, red],
      [1, blue],
    ]);
    expect(clampStop(g.stops, -3)).toBe(0);
    expect(clampStop(g.stops, 9)).toBe(1);
    expect(clampStop(g.stops, 1.7)).toBe(1);
    expect(clampStop(g.stops, Number.NaN)).toBe(0);
    expect(clampStop([], 4)).toBe(0);
  });

  it('keeps a position on the ramp, to 3 decimals', () => {
    expect(stopPosition(-0.2)).toBe(0);
    expect(stopPosition(1.4)).toBe(1);
    expect(stopPosition(0.12345)).toBe(0.123);
    expect(stopPosition(Number.NaN)).toBe(0);
    expect(stopPosition(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('sorts stops by position, keeping ties in order and following the active stop', () => {
    const stops = lin([
      [0.8, red],
      [0.2, blue],
      [0.2, gold],
      [0, white],
    ]).stops;
    const s = sortStopsKeeping(stops, 0);
    expect(s.stops.map((x) => x.at)).toEqual([0, 0.2, 0.2, 0.8]);
    expect(s.stops.map((x) => x.color)).toEqual([white, blue, gold, red]);
    expect(s.active).toBe(3);
    expect(sortStopsKeeping(stops, 2).active).toBe(2);
    expect(stops.map((x) => x.at)).toEqual([0.8, 0.2, 0.2, 0]);
  });

  it('samples the gradient between and beyond its stops', () => {
    const stops = lin([
      [0.25, { r: 0, g: 0, b: 0, a: 0 }],
      [0.75, { r: 200, g: 100, b: 50, a: 1 }],
    ]).stops;
    expect(sampleGradient(stops, 0)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(sampleGradient(stops, 0.5)).toEqual({ r: 100, g: 50, b: 25, a: 0.5 });
    expect(sampleGradient(stops, 1)).toEqual({ r: 200, g: 100, b: 50, a: 1 });
    expect(sampleGradient([], 0.5)).toEqual(DEFAULT_SOLID);
  });
});

describe('paintStops: stop edits', () => {
  it('adds a stop where the ramp is clicked, in the colour the gradient has there, and makes it active', () => {
    const g = lin([
      [0, { r: 0, g: 0, b: 0, a: 1 }],
      [1, { r: 200, g: 100, b: 0, a: 1 }],
    ]);
    const e = addStop(g, 0, 0.25);
    expect(ats(e.gradient)).toEqual([0, 0.25, 1]);
    expect(e.gradient.stops[1]!.color).toEqual({ r: 50, g: 25, b: 0, a: 1 });
    expect(e.active).toBe(1);
    expect(e.gradient.angle).toBe(45);
    expect(ats(g)).toEqual([0, 1]);
  });

  it('adds a stop with + in the middle of the widest gap', () => {
    const g = lin([
      [0, red],
      [0.2, blue],
      [1, gold],
    ]);
    const e = addStop(g, 0);
    expect(ats(e.gradient)).toEqual([0, 0.2, 0.6, 1]);
    expect(e.active).toBe(2);
  });

  it('keeps the schema bounds: no stop past MAX_GRAD_STOPS, none removed below MIN_GRAD_STOPS', () => {
    let g = lin([
      [0, red],
      [1, blue],
    ]);
    for (let i = 0; i < 40; i++) g = addStop(g, 0).gradient;
    expect(g.stops).toHaveLength(MAX_GRAD_STOPS);
    const full = addStop(g, 3, 0.5);
    expect(full.gradient).toBe(g);
    expect(full.active).toBe(3);
    expect(Gradient.safeParse(g).success).toBe(true);

    const pair = lin([
      [0, red],
      [1, blue],
    ]);
    expect(MIN_GRAD_STOPS).toBe(2);
    const r = removeStop(pair, 1);
    expect(r.gradient).toBe(pair);
    expect(r.active).toBe(1);
  });

  it('moves a stop past its neighbours: the stops re-sort and the moved stop stays active', () => {
    const g = lin([
      [0, red],
      [0.5, blue],
      [1, gold],
    ]);
    const past = moveStop(g, 0, 0.75);
    expect(ats(past.gradient)).toEqual([0.5, 0.75, 1]);
    expect(past.gradient.stops[past.active]!.color).toEqual(red);
    expect(past.active).toBe(1);
    // A drag keeps feeding the active index back in (ColorPicker's pin drag): it keeps moving the same stop.
    const further = moveStop(past.gradient, past.active, 1.3);
    expect(ats(further.gradient)).toEqual([0.5, 1, 1]);
    expect(further.gradient.stops[further.active]!.color).toEqual(red);
    const back = moveStop(further.gradient, further.active, 0.1);
    expect(ats(back.gradient)).toEqual([0.1, 0.5, 1]);
    expect(back.gradient.stops[back.active]!.color).toEqual(red);
    expect(back.active).toBe(0);
  });

  it('removes the active stop and activates its neighbour', () => {
    const g = lin([
      [0, red],
      [0.4, blue],
      [0.6, gold],
      [1, white],
    ]);
    const mid = removeStop(g, 1);
    expect(mid.gradient.stops.map((s) => s.color)).toEqual([red, gold, white]);
    expect(mid.active).toBe(1);
    const last = removeStop(g, 3);
    expect(ats(last.gradient)).toEqual([0, 0.4, 0.6]);
    expect(last.active).toBe(2);
  });

  it('recolours one stop, its position and the order kept', () => {
    const g = lin([
      [0, red],
      [1, blue],
    ]);
    const next = setStopColor(g, 1, gold);
    expect(next.stops).toEqual([
      { at: 0, color: red },
      { at: 1, color: gold },
    ]);
    expect(next.angle).toBe(45);
  });

  it('stores an angle or kind edit with its stops sorted and the active stop followed', () => {
    const g = lin([
      [0.9, red],
      [0.1, blue],
    ]);
    const s = sortedGradient({ ...g, angle: 135 }, 0);
    expect(ats(s.gradient)).toEqual([0.1, 0.9]);
    expect(s.gradient.angle).toBe(135);
    expect(s.active).toBe(1);
  });
});

describe('paintStops: mode tabs', () => {
  const none: PaintValue = { kind: 'none' };
  const solid: PaintValue = { kind: 'solid', color: red };
  const radial: PaintValue = {
    kind: 'gradient',
    gradient: {
      kind: 'radial',
      scaled: true,
      center: { x: 0.2, y: 0.8 },
      stops: [
        { at: 0, color: gold },
        { at: 1, color: blue },
      ],
    },
  };

  it('names the mode of a value', () => {
    expect(paintMode(none)).toBe('none');
    expect(paintMode(solid)).toBe('solid');
    expect(paintMode(radial)).toBe('radial');
  });

  it('None drops the paint; the same tab changes nothing', () => {
    expect(switchPaintMode(solid, 'none', 0).value).toEqual({ kind: 'none' });
    const same = switchPaintMode(radial, 'radial', 1);
    expect(same.value).toBe(radial);
    expect(same.active).toBe(1);
  });

  it('Solid keeps the colour shown: the active stop of a gradient', () => {
    expect(switchPaintMode(radial, 'solid', 1).value).toEqual({ kind: 'solid', color: blue });
    expect(switchPaintMode(radial, 'solid', 0).value).toEqual({ kind: 'solid', color: gold });
    expect(switchPaintMode(none, 'solid', 0).value).toEqual({ kind: 'solid', color: DEFAULT_SOLID });
    expect(switchPaintMode(none, 'solid', 0, white).value).toEqual({ kind: 'solid', color: white });
  });

  it('Linear ↔ Radial keeps the stops, the focus and the scaling, and the active stop', () => {
    const toLinear = switchPaintMode(radial, 'linear', 1);
    expect(toLinear.active).toBe(1);
    expect(toLinear.value).toEqual({
      kind: 'gradient',
      gradient: {
        kind: 'linear',
        angle: DEFAULT_LINEAR_ANGLE,
        scaled: true,
        center: { x: 0.2, y: 0.8 },
        stops: radial.kind === 'gradient' ? radial.gradient.stops : [],
      },
    });
    const angled: PaintValue = {
      kind: 'gradient',
      gradient: { ...(toLinear.value as { gradient: Gradient }).gradient, angle: 30 },
    };
    const back = switchPaintMode(angled, 'radial', 0);
    expect(back.value).toEqual({
      kind: 'gradient',
      gradient: {
        kind: 'radial',
        angle: 30,
        scaled: true,
        center: { x: 0.2, y: 0.8 },
        stops: radial.kind === 'gradient' ? radial.gradient.stops : [],
      },
    });
    // The angle survives a round trip through radial.
    const again = switchPaintMode(back.value, 'linear', 0).value;
    expect(again.kind === 'gradient' && again.gradient.angle).toBe(30);
  });

  it('a gradient from a colour (or None) runs from it to a darker shade, the first stop active', () => {
    const fromSolid = switchPaintMode(solid, 'linear', 3);
    expect(fromSolid.active).toBe(0);
    expect(fromSolid.value).toEqual({
      kind: 'gradient',
      gradient: {
        kind: 'linear',
        angle: DEFAULT_LINEAR_ANGLE,
        stops: [
          { at: 0, color: red },
          { at: 1, color: shadeColor(red, 0.55) },
        ],
      },
    });
    const fromNone = switchPaintMode(none, 'radial', 0).value;
    expect(fromNone.kind === 'gradient' && fromNone.gradient.stops[0]!.color).toEqual(DEFAULT_SOLID);
    expect(fromNone.kind === 'gradient' && fromNone.gradient.kind).toBe('radial');
  });

  it('shows the solid colour, the active stop, else the fallback', () => {
    expect(activeColorOf(solid, 0)).toBe(red);
    expect(activeColorOf(radial, 5)).toBe(blue);
    expect(activeColorOf(none, 0)).toBe(DEFAULT_SOLID);
    expect(activeColorOf(none, 0, white)).toBe(white);
  });
});

describe('paintStops: slider sync (r24 b3)', () => {
  it('returns the previous state itself when the colour shown has not changed', () => {
    const prev = rgbaToHsv(DEFAULT_SOLID);
    // Every render on 'None' hands the sync a colour equal to the last one (before #24's fix, a new object
    // each time): an unchanged colour must give back the same state, so React bails out of the render.
    expect(syncHsv(prev, { ...DEFAULT_SOLID })).toBe(prev);
    expect(syncHsv(prev, DEFAULT_SOLID)).toBe(prev);
  });

  it('follows a new colour, keeping the hue for a grey or black', () => {
    const prev = rgbaToHsv(red);
    const next = syncHsv(prev, blue);
    expect(next).not.toBe(prev);
    expect(next).toEqual(rgbaToHsv(blue));
    const grey = syncHsv(prev, { r: 128, g: 128, b: 128, a: 1 });
    expect(grey.h).toBe(prev.h);
    expect(grey.s).toBe(0);
    const black = syncHsv(prev, { r: 0, g: 0, b: 0, a: 0.5 });
    expect(black.h).toBe(prev.h);
    expect(black.a).toBe(0.5);
    expect(syncHsv(grey, { r: 128, g: 128, b: 128, a: 1 })).toBe(grey);
  });

  it('keeps the default colour one frozen object (a default parameter of one identity)', () => {
    expect(Object.isFrozen(DEFAULT_SOLID)).toBe(true);
  });
});

describe('paintStops: hostile values never throw and keep the schema', () => {
  const rgba = fc.record({
    r: fc.integer({ min: 0, max: 255 }),
    g: fc.integer({ min: 0, max: 255 }),
    b: fc.integer({ min: 0, max: 255 }),
    a: fc.double({ min: 0, max: 1, noNaN: true }),
  });
  const gradient = fc.record({
    kind: fc.constantFrom('linear' as const, 'radial' as const),
    angle: fc.option(fc.integer({ min: -36_000, max: 36_000 }), { nil: undefined }),
    stops: fc.array(fc.record({ at: fc.double({ min: 0, max: 1, noNaN: true }), color: rgba }), {
      minLength: 2,
      maxLength: 16,
    }),
  });
  const anyNumber = fc.oneof(fc.double(), fc.integer({ min: -50, max: 50 }));

  it('every edit of a valid gradient stores a valid gradient with an active stop inside it', () => {
    fc.assert(
      fc.property(gradient, anyNumber, anyNumber, (g0, i, at) => {
        const g = { ...g0, stops: sortStopsKeeping(g0.stops, 0).stops };
        for (const e of [
          addStop(g, i, at),
          addStop(g, i),
          moveStop(g, i, at),
          removeStop(g, i),
          sortedGradient(g, i),
        ]) {
          expect(Gradient.safeParse(e.gradient).success).toBe(true);
          expect(e.active).toBeGreaterThanOrEqual(0);
          expect(e.active).toBeLessThan(e.gradient.stops.length);
          const sorted = ats(e.gradient);
          expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
        }
        for (const m of ['none', 'solid', 'linear', 'radial'] as const) {
          const out = switchPaintMode({ kind: 'gradient', gradient: g }, m, i);
          if (out.value.kind === 'gradient')
            expect(Gradient.safeParse(out.value.gradient).success).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
