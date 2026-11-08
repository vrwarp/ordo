/**
 * The Object panel's shape fields (design/27 §11 "Mapping" and "Locked objects", §15 M6 "Editor shape fields";
 * `views/editor/ObjectShapeFields.tsx`): the pure patches each control sends, the read-only geometry, and the
 * props-only views, rendered to markup and driven through their element tree (each control's handler called
 * with a value, the patch it hands the panel's `set` applied to the shape), plus the panel itself.
 */
import { type Gradient, Presentation, type Rgba, ShapeObject, type SlideObject } from '@ordo/domain';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clearGeomFiles, putGeomFile } from '@ordo/renderer/geom/index.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { Check, ColorField, NumberField, Select } from '../src/components/fields.tsx';
import { openPresentation, useEditor } from '../src/views/editor/editorStore.ts';
import { ObjectPanel } from '../src/views/editor/ObjectPanel.tsx';
import {
  addStop,
  arrowSize,
  DEFAULT_ANGLE,
  DEFAULT_FILL,
  DEFAULT_SHAPE_SHADOW,
  fillKind,
  geomInfo,
  hasOpenOutline,
  MAX_STOPS,
  newGradient,
  openPathData,
  removeStop,
  type SetObject,
  ShapeFillFields,
  ShapeGeometryField,
  ShapeLineFields,
  ShapeShadowField,
  shapeName,
  withAngle,
  withDash,
  withEnd,
  withFill,
  withFillKind,
  withGradient,
  withShadow,
  withStop,
} from '../src/views/editor/ObjectShapeFields.tsx';

// ---- fixtures ------------------------------------------------------------------------------------------

const red: Rgba = { r: 200, g: 40, b: 40, a: 1 };
const blue: Rgba = { r: 20, g: 60, b: 220, a: 1 };
const gold: Rgba = { r: 240, g: 200, b: 40, a: 0.5 };
const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const shape = (o: Partial<ShapeObject> = {}): ShapeObject =>
  ShapeObject.parse({
    id: 's1',
    type: 'shape',
    box: { x: 100, y: 100, w: 400, h: 300 },
    shape: 'rect',
    ...o,
  });
const twoStops = (kind: 'linear' | 'radial' = 'linear'): Gradient => ({
  kind,
  ...(kind === 'linear' ? { angle: 45 } : {}),
  stops: [
    { at: 0, color: red },
    { at: 1, color: blue },
  ],
});
const star = (adj?: [string, number][]) => shape({ geom: { preset: 'star5', ...(adj ? { adj } : {}) } });

/** A shape survives the schema unchanged (every field the editor writes is stored as written). */
const stored = (o: ShapeObject) => expect(ShapeObject.parse(o)).toEqual(o);

/** What an older build keeps: the schema of before M6 strips the M6 keys (design/27 §3.2). */
const LEGACY_KEYS = ['id', 'type', 'box', 'shape', 'fill', 'stroke', 'opacity', 'radius', 'origin', 'locked'];
const legacy = (o: ShapeObject) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => LEGACY_KEYS.includes(k)));

// ---- the element tree of a props-only view ---------------------------------------------------------------

type El = ReactElement<Record<string, unknown>>;
const LEAVES = new Set<unknown>([Check, ColorField, NumberField, Select]);

/** Every element a view renders, its own sub-views expanded; the field components are leaves. */
function elements(node: ReactNode): El[] {
  const out: El[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as El;
    if (typeof el.type === 'function' && !LEAVES.has(el.type)) {
      visit((el.type as (p: unknown) => ReactNode)(el.props));
      return;
    }
    out.push(el);
    visit(el.props.children);
  };
  visit(node);
  return out;
}

/** A recording `set`: each call's patch and coalescing key. */
function recorder() {
  const calls: { fn: (x: SlideObject) => SlideObject; key?: string }[] = [];
  const set: SetObject = (fn, key) => {
    calls.push({ fn, key });
  };
  return { calls, set };
}

/** Render `view(o)`, call the handler `pick` finds with `value`, and return the shape it patches to. */
function drive(
  view: (p: { o: ShapeObject; disabled: boolean; set: SetObject }) => ReactNode,
  o: ShapeObject,
  pick: (els: El[]) => El | undefined,
  value?: unknown,
): { out: ShapeObject; key?: string } {
  const { calls, set } = recorder();
  const el = pick(elements(view({ o, disabled: false, set })));
  if (!el) throw new Error('no such control');
  const handler = (el.props.onChange ?? el.props.onClick) as (v: unknown) => void;
  handler(value);
  expect(calls).toHaveLength(1);
  return { out: calls[0]!.fn(o) as ShapeObject, key: calls[0]!.key };
}

const byLabel = (label: string) => (els: El[]) => els.find((e) => e.props.label === label);
const html = (el: ReactElement) => renderToStaticMarkup(el);
const noop: SetObject = () => undefined;

// ---- fill --------------------------------------------------------------------------------------------------

describe('fill: none, solid or a gradient, the legacy fill kept as the first stop', () => {
  it('the Fill toggle adds the default colour, keeps a fill there is, and drops the colour and gradient', () => {
    expect(withFill(shape(), true).fill).toEqual(DEFAULT_FILL);
    const filled = shape({ fill: red });
    expect(withFill(filled, true)).toBe(filled);
    const off = withFill(shape({ fill: red, gradient: twoStops() }), false);
    expect('fill' in off || 'gradient' in off).toBe(false);
    expect(fillKind(off)).toBe('none');
    stored(off);
  });

  it('a gradient starts from the solid colour, top to bottom, with the legacy fill its first stop', () => {
    const lin = withFillKind(shape({ fill: red }), 'linear');
    expect(lin.gradient).toEqual(newGradient(red, 'linear'));
    expect(lin.gradient?.angle).toBe(DEFAULT_ANGLE);
    expect(lin.gradient?.stops.map((s) => s.at)).toEqual([0, 1]);
    expect(lin.gradient?.stops[1]?.color).toEqual({ r: 120, g: 24, b: 24, a: 1 });
    expect(lin.fill).toEqual(red);
    expect(fillKind(lin)).toBe('linear');
    stored(lin);
    // An older build strips the gradient and draws the first stop's colour.
    expect(ShapeObject.parse(legacy(lin)).fill).toEqual(red);
  });

  it('linear ↔ radial keeps the stops, solid keeps the first stop, the same kind changes nothing', () => {
    const lin = shape({ fill: red, gradient: twoStops() });
    const rad = withFillKind(lin, 'radial');
    expect(rad.gradient?.kind).toBe('radial');
    expect(rad.gradient?.stops).toEqual(lin.gradient?.stops);
    expect(fillKind(rad)).toBe('radial');
    const solid = withFillKind(rad, 'solid');
    expect('gradient' in solid).toBe(false);
    expect(solid.fill).toEqual(red);
    expect(withFillKind(lin, 'linear')).toBe(lin);
    expect(withFillKind(shape(), 'solid').fill).toEqual(DEFAULT_FILL);
  });

  it('stops stay sorted by position and the legacy fill follows the first one', () => {
    const o = shape({ fill: red, gradient: twoStops() });
    // The blue end dragged in front of the red one: blue is now the first stop and the legacy colour.
    const moved = withGradient(o, withStop(withStop(o.gradient!, 0, { at: 0.2 }), 1, { at: 0.1 }));
    expect(moved.gradient?.stops).toEqual([
      { at: 0.1, color: blue },
      { at: 0.2, color: red },
    ]);
    expect(moved.fill).toEqual(blue);
    stored(moved);
    const recoloured = withGradient(o, withStop(o.gradient!, 0, { color: gold }));
    expect(recoloured.fill).toEqual(gold);
  });

  it('a stop position is clamped to the gradient', () => {
    const g = twoStops();
    expect(withStop(g, 1, { at: 1.5 }).stops[1]?.at).toBe(1);
    expect(withStop(g, 1, { at: -2 }).stops[1]?.at).toBe(0);
    expect(withStop(g, 1, { at: Number.NaN }).stops[1]?.at).toBe(0);
  });

  it('a new stop goes in the middle of the widest gap, in the colour there; at most 16, at least 2', () => {
    const g: Gradient = {
      kind: 'linear',
      stops: [
        { at: 0, color: red },
        { at: 0.2, color: white },
        { at: 1, color: blue },
      ],
    };
    const more = addStop(g);
    expect(more.stops.map((s) => s.at)).toEqual([0, 0.2, 0.6, 1]);
    expect(more.stops[2]?.color).toEqual({ r: 138, g: 158, b: 238, a: 1 });
    let full = g;
    while (full.stops.length < MAX_STOPS) full = addStop(full);
    expect(addStop(full)).toBe(full);
    stored(withGradient(shape(), full));
    expect(removeStop(g, 1).stops.map((s) => s.at)).toEqual([0, 1]);
    const pair = twoStops();
    expect(removeStop(pair, 0)).toBe(pair);
  });

  it('the angle is kept within the schema bounds', () => {
    expect(withAngle(twoStops(), 135).angle).toBe(135);
    expect(withAngle(twoStops(), 1e9).angle).toBe(36_000);
    expect(withAngle(twoStops(), Number.NaN).angle).toBe(0);
  });
});

// ---- line ---------------------------------------------------------------------------------------------------

describe('line: dash and arrowheads', () => {
  it('a dash is stored; solid stores none, so a plain shape keeps its legacy drawing', () => {
    const dashed = withDash(shape({ stroke: { width: 4, color: white } }), 'longDashDot');
    expect(dashed.dash).toBe('longDashDot');
    stored(dashed);
    expect(withDash(dashed, 'longDashDot')).toBe(dashed);
    expect('dash' in withDash(dashed, 'solid')).toBe(false);
  });

  it('an arrowhead per end: a size sets width and length, none removes the end and then the ends', () => {
    const line = shape({ shape: 'line', stroke: { width: 4, color: white } });
    const one = withEnd(line, 'tail', { type: 'triangle' });
    expect(one.ends).toEqual({ tail: { type: 'triangle' } });
    expect(arrowSize(one.ends?.tail)).toBe('med');
    const big = withEnd(one, 'tail', { size: 'lg' });
    expect(big.ends).toEqual({ tail: { type: 'triangle', w: 'lg', len: 'lg' } });
    const both = withEnd(big, 'head', { type: 'oval' });
    expect(both.ends).toEqual({ head: { type: 'oval' }, tail: { type: 'triangle', w: 'lg', len: 'lg' } });
    stored(both);
    expect(withEnd(both, 'tail', { type: 'none' }).ends).toEqual({ head: { type: 'oval' } });
    const none = withEnd(withEnd(both, 'tail', { type: 'none' }), 'head', { type: 'none' });
    expect('ends' in none).toBe(false);
    expect(arrowSize({ type: 'stealth', w: 'sm', len: 'lg' })).toBe('mixed');
    expect(arrowSize(undefined)).toBe('med');
  });

  it('arrowheads are offered on open outlines only', () => {
    expect(hasOpenOutline(shape())).toBe(false);
    expect(hasOpenOutline(shape({ shape: 'ellipse' }))).toBe(false);
    expect(hasOpenOutline(shape({ shape: 'line' }))).toBe(true);
    // A cloud's inner arcs are an open, stroke-only path: arrowheads draw there in LibreOffice too.
    for (const preset of ['arc', 'bracketPair', 'leftBrace', 'straightConnector1', 'bentConnector3', 'cloud'])
      expect(hasOpenOutline(shape({ geom: { preset } })), preset).toBe(true);
    for (const preset of ['star5', 'roundRect', 'rightArrow', 'hexagon'])
      expect(hasOpenOutline(shape({ geom: { preset } })), preset).toBe(false);
    const path = (d: string, stroke?: boolean) =>
      shape({ geom: { paths: [{ d, w: 100, h: 100, ...(stroke === undefined ? {} : { stroke }) }] } });
    expect(hasOpenOutline(path('M0 0 L100 100'))).toBe(true);
    expect(hasOpenOutline(path('M0 0 L100 0 L100 100 Z'))).toBe(false);
    expect(hasOpenOutline(path('M0 0 L100 100', false))).toBe(false);
    // A closed outline stored in pieces (`cont`, cut inside a sub-path) is read whole.
    const pieces = (...ds: string[]) =>
      shape({ geom: { paths: ds.map((d, i) => ({ d, w: 100, h: 100, ...(i ? { cont: true } : {}) })) } });
    expect(hasOpenOutline(pieces('M0 0 L100 0', 'L100 100 Z'))).toBe(false);
    expect(hasOpenOutline(pieces('M0 0 L100 0', 'L100 100'))).toBe(true);
    // An imported arrowhead stays editable on any outline.
    expect(hasOpenOutline(shape({ ends: { tail: { type: 'arrow' } } }))).toBe(true);
  });

  it('path data is open when a sub-path with a segment is not closed', () => {
    expect(openPathData('M0 0L1 1ZM2 2L3 3')).toBe(true);
    expect(openPathData('M0 0L1 1M2 2L3 3Z')).toBe(true);
    expect(openPathData('M0 0C1 1 2 2 3 3Q4 4 5 5Z')).toBe(false);
    expect(openPathData('M1e2 0 L2E2 5.5e-1 Z')).toBe(false);
    expect(openPathData('M0 0 M5 5')).toBe(false);
    expect(openPathData('')).toBe(false);
  });
});

// ---- shadow -------------------------------------------------------------------------------------------------

describe('shadow on or off', () => {
  it('on is PowerPoint’s bottom-right outer shadow, an imported shadow is kept, off removes it', () => {
    const on = withShadow(shape(), true);
    expect(on.shadow).toEqual(DEFAULT_SHAPE_SHADOW);
    expect(Math.hypot(on.shadow!.dx, on.shadow!.dy)).toBeCloseTo(6, 2); // 3 pt at 2 px per pt
    stored(on);
    const imported = shape({ shadow: { dx: -3, dy: 9, blur: 2, color: gold } });
    expect(withShadow(imported, true)).toBe(imported);
    expect('shadow' in withShadow(imported, false)).toBe(false);
  });
});

// ---- geometry ---------------------------------------------------------------------------------------------

describe('geometry: read-only, the preset with its adjust values', () => {
  it('a preset lists its adjust values, defaults evaluated as the drawer evaluates them', () => {
    const info = geomInfo(star());
    expect(info).toEqual({
      kind: 'preset',
      name: 'star5',
      adjust: [
        { name: 'adj', value: 19098, stored: false },
        { name: 'hf', value: 105146, stored: false },
        { name: 'vf', value: 110557, stored: false },
      ],
      unused: [],
    });
    expect(shapeName(star())).toBe('star5');
  });

  it('stored pairs replace the defaults; pairs the preset does not know are listed apart', () => {
    const info = geomInfo(
      shape({
        geom: {
          preset: 'roundRect',
          adj: [
            ['adj', 25000],
            ['zz', 7],
          ],
        },
      }),
    );
    expect(info).toEqual({
      kind: 'preset',
      name: 'roundRect',
      adjust: [{ name: 'adj', value: 25000, stored: true }],
      unused: [['zz', 7]],
    });
  });

  it('paths are a freeform; an unknown preset without paths draws the legacy shape', () => {
    const free = shape({
      geom: {
        paths: [
          { d: 'M0 0L1 1Z', w: 1, h: 1 },
          { d: 'M0 0L1 0Z', w: 1, h: 1 },
        ],
      },
    });
    expect(geomInfo(free)).toEqual({ kind: 'custom', paths: 2 });
    // The pieces of one path (`cont`) are one path.
    const chained = shape({
      geom: { paths: [free.geom!.paths![0]!, { ...free.geom!.paths![1]!, cont: true }] },
    });
    expect(geomInfo(chained)).toEqual({ kind: 'custom', paths: 1 });
    expect(shapeName(free)).toBe('freeform');
    const unknownWithPaths = shape({ geom: { preset: 'notAShape', paths: free.geom!.paths } });
    expect(geomInfo(unknownWithPaths)?.kind).toBe('custom');
    const unknown = shape({ shape: 'ellipse', geom: { preset: 'notAShape' } });
    expect(geomInfo(unknown)).toEqual({ kind: 'unknown', name: 'notAShape' });
    expect(shapeName(unknown)).toBe('ellipse');
    expect(geomInfo(shape())).toBeUndefined();
    expect(shapeName(shape({ shape: 'line' }))).toBe('line');
  });

  it('a geometry in a file (ShapeGeom.ref) is a freeform, read as the canvas draws it once its file is read', () => {
    clearGeomFiles();
    const ref = 'e'.repeat(64);
    const stored = shape({ geom: { ref } });
    expect(geomInfo(stored)).toEqual({ kind: 'custom', paths: 1 });
    expect(shapeName(stored)).toBe('freeform');
    expect(hasOpenOutline(stored)).toBe(false);
    putGeomFile(ref, {
      paths: [
        { d: 'M0 0L1 1', w: 1, h: 1 },
        { d: 'M0 0L1 0Z', w: 1, h: 1 },
      ],
    });
    expect(geomInfo(stored)).toEqual({ kind: 'custom', paths: 2 });
    expect(hasOpenOutline(stored)).toBe(true);
    clearGeomFiles();
  });
});

// ---- the views --------------------------------------------------------------------------------------------

describe('the views', () => {
  it('a plain shape offers the legacy shape picker; a PowerPoint geometry is shown, not edited', () => {
    const plain = html(createElement(ShapeGeometryField, { o: shape(), disabled: false, set: noop }));
    expect(plain).toContain('<select');
    expect(plain.match(/<option /g)).toHaveLength(3);
    const preset = html(
      createElement(ShapeGeometryField, { o: star([['adj', 30000]]), disabled: false, set: noop }),
    );
    expect(preset).not.toMatch(/<select|<input/);
    expect(preset).toContain('data-shape-geom="preset"');
    expect(preset).toContain('Geometry (from PowerPoint, read-only)');
    expect(preset).toMatch(/data-preset="true">star5</);
    expect(preset).toMatch(/data-adj="adj"><span class="mono">adj<\/span> 30000<\/span>/);
    expect(preset).toMatch(
      /data-adj="hf"><span class="mono">hf<\/span> 105146<span class="muted"> \(default\)/,
    );
    const { out } = drive(ShapeGeometryField, shape(), byLabel('Shape'), 'ellipse');
    expect(out.shape).toBe('ellipse');
  });

  it('solid fill: the toggle, the fill type and the colour; a gradient: angle, stops and their buttons', () => {
    const solid = html(
      createElement(ShapeFillFields, { o: shape({ fill: red }), disabled: false, set: noop }),
    );
    expect(solid).toMatch(/<input type="checkbox" checked=""/);
    expect(solid).toContain('<option value="solid" selected="">Solid colour</option>');
    expect(solid).toContain('value="#c82828"');
    expect(solid).not.toContain('data-gradient');
    const none = html(createElement(ShapeFillFields, { o: shape(), disabled: false, set: noop }));
    expect(none).not.toMatch(/<select|type="color"/);

    const lin = shape({ fill: red, gradient: twoStops() });
    const g = html(createElement(ShapeFillFields, { o: lin, disabled: false, set: noop }));
    expect(g).toContain('data-gradient="linear"');
    expect(g).toContain('<span>Angle</span>');
    expect(g).toContain('value="45"');
    expect(g.match(/data-stop="/g)).toHaveLength(2);
    expect(g).not.toContain('value="#c82828" disabled');
    // Two stops cannot lose one; sixteen cannot gain one.
    expect(g.match(/<button[^>]*aria-label="Remove stop \d"[^>]*disabled=""/g)).toHaveLength(2);
    expect(g).toMatch(/<button type="button" class="small">Add stop<\/button>/);
    let full = lin.gradient!;
    while (full.stops.length < MAX_STOPS) full = addStop(full);
    const f = html(
      createElement(ShapeFillFields, { o: withGradient(lin, full), disabled: false, set: noop }),
    );
    expect(f).toMatch(/<button type="button" class="small" disabled="">Add stop<\/button>/);
    const rad = html(
      createElement(ShapeFillFields, { o: withFillKind(lin, 'radial'), disabled: false, set: noop }),
    );
    expect(rad).toContain('data-gradient="radial"');
    expect(rad).not.toContain('Angle');
  });

  it('each fill control sends its patch (colour drags coalesce per stop)', () => {
    const lin = shape({ fill: red, gradient: twoStops() });
    expect(drive(ShapeFillFields, shape({ fill: red }), byLabel('Fill'), false).out.fill).toBeUndefined();
    expect(
      drive(ShapeFillFields, shape({ fill: red }), byLabel('Fill type'), 'radial').out.gradient?.kind,
    ).toBe('radial');
    const colour = drive(
      ShapeFillFields,
      shape({ fill: red }),
      (els) => els.find((e) => e.type === ColorField),
      blue,
    );
    expect(colour.out.fill).toEqual(blue);
    expect(colour.key).toBe('shape:s1:fill');
    expect(drive(ShapeFillFields, lin, byLabel('Angle'), 180).out.gradient?.angle).toBe(180);
    const stopColour = drive(
      ShapeFillFields,
      lin,
      (els) => els.filter((e) => e.type === ColorField)[1],
      gold,
    );
    expect(stopColour.out.gradient?.stops[1]?.color).toEqual(gold);
    expect(stopColour.key).toBe('shape:s1:stop:1');
    const pos = drive(ShapeFillFields, lin, (els) => els.filter((e) => e.type === NumberField)[2], 25);
    expect(pos.out.gradient?.stops.map((s) => s.at)).toEqual([0, 0.25]);
    const added = drive(ShapeFillFields, lin, (els) => els.find((e) => e.props.children === 'Add stop'));
    expect(added.out.gradient?.stops).toHaveLength(3);
    const three = withGradient(lin, addStop(lin.gradient!));
    const removed = drive(ShapeFillFields, three, (els) =>
      els.find((e) => e.props['aria-label'] === 'Remove stop 1'),
    );
    expect(removed.out.gradient?.stops.map((s) => s.at)).toEqual([0.5, 1]);
    expect(removed.out.fill).toEqual(removed.out.gradient?.stops[0]?.color);
  });

  it('the dash, and arrowheads with their sizes on an open line only', () => {
    const line = shape({
      shape: 'line',
      stroke: { width: 4, color: white },
      ends: { tail: { type: 'triangle' } },
    });
    const h = html(createElement(ShapeLineFields, { o: line, disabled: false, set: noop }));
    expect(h).toContain('<span>Dash</span>');
    expect(h.match(/<option value="/g)?.length).toBe(11 + 6 + 6 + 3);
    expect(h).toContain('data-arrow="head"');
    expect(h).toContain('<span>Start arrowhead</span>');
    expect(h).toContain('<span>End arrowhead</span>');
    expect(h.match(/<span>Size<\/span>/g)).toHaveLength(1); // the tail's; the head has none
    const rect = html(
      createElement(ShapeLineFields, {
        o: shape({ stroke: { width: 4, color: white } }),
        disabled: false,
        set: noop,
      }),
    );
    expect(rect).not.toContain('arrowhead');
    const mixed = withEnd(line, 'tail', { type: 'stealth' });
    mixed.ends!.tail!.w = 'sm';
    const m = html(createElement(ShapeLineFields, { o: mixed, disabled: false, set: noop }));
    expect(m).toContain('<option value="mixed" selected="">sm wide, med long</option>');

    expect(drive(ShapeLineFields, line, byLabel('Dash'), 'sysDot').out.dash).toBe('sysDot');
    expect(drive(ShapeLineFields, line, byLabel('Start arrowhead'), 'diamond').out.ends?.head).toEqual({
      type: 'diamond',
    });
    expect(drive(ShapeLineFields, line, byLabel('Size'), 'sm').out.ends?.tail).toEqual({
      type: 'triangle',
      w: 'sm',
      len: 'sm',
    });
    expect(drive(ShapeLineFields, line, byLabel('End arrowhead'), 'none').out.ends).toBeUndefined();
    // Choosing the imported mixed size again changes nothing.
    const { calls, set } = recorder();
    const size = elements(ShapeLineFields({ o: mixed, disabled: false, set })).find(
      (e) => e.props.label === 'Size',
    );
    (size!.props.onChange as (v: string) => void)('mixed');
    expect(calls).toHaveLength(0);
  });

  it('the shadow toggle', () => {
    const h = html(createElement(ShapeShadowField, { o: shape(), disabled: false, set: noop }));
    expect(h).toContain('<span>Shadow</span>');
    expect(h).not.toContain('checked');
    expect(drive(ShapeShadowField, shape(), byLabel('Shadow'), true).out.shadow).toEqual(
      DEFAULT_SHAPE_SHADOW,
    );
  });

  it('disabled disables every control', () => {
    const o = shape({
      fill: red,
      gradient: twoStops(),
      shape: 'line',
      stroke: { width: 4, color: white },
      ends: { head: { type: 'arrow' } },
    });
    const h = [ShapeGeometryField, ShapeFillFields, ShapeLineFields, ShapeShadowField]
      .map((v) => html(createElement(v, { o: { ...o, shape: 'rect' as const }, disabled: true, set: noop })))
      .join('');
    const controls = h.match(/<(input|select|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(10);
    for (const c of controls) expect(c).toContain('disabled=""');
  });
});

// ---- the Object panel ---------------------------------------------------------------------------------------

/** Server rendering reads a zustand store's initial state, so the panel test seeds it there too. */
function seed<T extends object>(
  store: { getInitialState: () => T; setState: (p: Partial<T>) => void },
  p: Partial<T>,
) {
  Object.assign(store.getInitialState(), p);
  store.setState(p);
}

describe('the Object panel', () => {
  const pptx = shape({
    id: 'star',
    geom: { preset: 'star5' },
    fill: red,
    gradient: twoStops(),
    stroke: { width: 3, color: white },
    dash: 'dash',
    shadow: DEFAULT_SHAPE_SHADOW,
    origin: { src: 'pptx', shapeId: 4, role: 'shape' },
  });
  const deck = (o: ShapeObject) =>
    Presentation.parse({
      id: 'deck',
      title: 'Deck',
      kind: 'slides',
      sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 'sl', objects: [o] }] }],
    });
  const panel = (o: ShapeObject, readOnly = false) => {
    openPresentation(deck(o));
    seed(useEditor, { draft: useEditor.getState().draft, slideId: 'sl', objectId: o.id });
    return html(createElement(ObjectPanel, { o, readOnly }));
  };
  beforeEach(() => seed(useEditor, { draft: undefined, slideId: undefined, objectId: undefined }));

  it('shows a PowerPoint shape: its preset, gradient, line style and shadow, and no corner radius', () => {
    const h = panel(pptx);
    expect(h).toContain('<b class="grow">Shape (star5)</b>');
    expect(h).toContain('data-shape-geom="preset"');
    expect(h).not.toContain('<span>Shape</span>'); // the legacy picker is replaced by the geometry
    expect(h).toContain('data-gradient="linear"');
    expect(h).toContain('<option value="dash" selected="">Dash</option>');
    expect(h).toMatch(/<input type="checkbox" checked=""[^>]*\/><span>Shadow<\/span>/);
    expect(h).not.toContain('Corner radius');
    expect(h).not.toContain('arrowhead');
    // Unlocked: only the two stops' Remove buttons are disabled (a gradient keeps two stops).
    const section = h.slice(h.indexOf('<h4>Shape</h4>'));
    const off = section.match(/<(input|select|button)\b[^>]*disabled=""[^>]*>/g) ?? [];
    expect(off).toHaveLength(2);
    for (const c of off) expect(c).toMatch(/aria-label="Remove stop \d"/);
  });

  it('a locked shape (and the live lock) leaves every shape field read-only, the box editable', () => {
    for (const [o, readOnly] of [
      [{ ...pptx, locked: true }, false],
      [pptx, true],
    ] as const) {
      const h = panel(o, readOnly);
      const section = h.slice(h.indexOf('<h4>Shape</h4>'));
      const controls = section.match(/<(input|select|button)\b[^>]*>/g) ?? [];
      expect(controls.length).toBeGreaterThan(10);
      for (const c of controls) expect(c).toContain('disabled=""');
      if (!readOnly) {
        // The box's own fields (M4: a locked object keeps its box; opacity and the rest are read-only).
        const at = h.indexOf('Position and size');
        const box = h.slice(at, h.indexOf('</fieldset>', at));
        expect(box.match(/<input\b[^>]*>/g)?.length).toBeGreaterThanOrEqual(4);
        expect(box).not.toContain('disabled=""');
      }
    }
  });

  it('a plain rect keeps the legacy fields: shape picker, solid fill, stroke and corner radius', () => {
    const h = panel(shape({ fill: red, stroke: { width: 2, color: white } }));
    expect(h).toContain('<b class="grow">Shape (rect)</b>');
    expect(h).toContain('<span>Shape</span>');
    expect(h).toContain('<option value="solid" selected="">Solid colour</option>');
    expect(h).toContain('<span>Corner radius</span>');
    expect(h).toContain('<span>Dash</span>');
    expect(h).not.toContain('disabled=""');
  });
});
