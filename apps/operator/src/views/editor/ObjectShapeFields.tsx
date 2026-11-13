import type { ArrowEnd, Gradient, LineDash, Rgba, Shadow, ShapeObject, SlideObject } from '@ordo/domain';
import {
  BUILTIN_COUNT,
  CLOSED_TOLERANCE,
  evalGuides,
  geomPathOpen,
  PRESET_GEOMS,
  presetGeometry,
  resolvedGeom,
} from '@ordo/renderer/geom/index.ts';
import { ColorPill, PaintPill, type PaintValue } from '../../components/ColorPicker.tsx';
import { Select } from '../../components/fields.tsx';

/*
 * The Object panel's shape fields for PowerPoint shapes (design/27 §3.1 ShapeObject M6 fields, §11 "Mapping":
 * fill, stroke, dash, arrowheads and box; geometry locked until adjust handles exist; §15 M6 "Editor shape
 * fields"). `ObjectPanel` mounts them inside its Shape section and keeps the fields every build has: the Stroke
 * toggle with its width and colour, the corner radius and opacity.
 * - Geometry: the legacy rect/ellipse/line picker, or a stored PowerPoint geometry shown read-only: the preset's
 *   name with each adjust value (the stored one, else the preset's default), or a freeform's path count.
 * - Fill: none, a solid colour, or a linear (stops and angle) or radial (stops) gradient. Every gradient edit
 *   also writes the legacy `fill` as the first stop's colour, which is what an older build draws (§3.2).
 * - Line: the dash, and an arrowhead at each end of an open outline (the only outlines that draw them).
 * - Shadow on or off (PowerPoint's outer shadow, offset to the bottom right).
 * The patches are pure functions of the shape; the components are props-only views (`o`, `disabled`, and the
 * panel's `set`), so a locked object (design/27 §11 "Locked objects") or the live lock passes `disabled`.
 */

/** ObjectPanel's update of the selected object: one change, coalesced with others of the same `key`. */
export type SetObject = (fn: (x: SlideObject) => SlideObject, key?: string) => void;

type Props = { o: ShapeObject; disabled: boolean; set: SetObject };

/** Apply a shape patch through the panel's `set` (an object of another type is left alone). */
function patch(set: SetObject, fn: (s: ShapeObject) => ShapeObject, key?: string): void {
  set((x) => (x.type === 'shape' ? fn(x) : x), key);
}

// ---- fill ------------------------------------------------------------------------------------------------

/** The fill a new shape fill starts with (the panel's long-standing default). */
export const DEFAULT_FILL: Rgba = { r: 40, g: 90, b: 200, a: 1 };
/** Gradient stops per fill: the schema's bounds. */
export const MIN_STOPS = 2;
export const MAX_STOPS = 16;
/** A new linear gradient runs top to bottom (OOXML `a:lin ang` 90°). */
export const DEFAULT_ANGLE = 90;

export type FillKind = 'none' | 'solid' | 'linear' | 'radial';

export const FILL_KINDS: { value: Exclude<FillKind, 'none'>; label: string }[] = [
  { value: 'solid', label: 'Solid colour' },
  { value: 'linear', label: 'Linear gradient' },
  { value: 'radial', label: 'Radial gradient' },
];

/** What fills the shape: a gradient wins over `fill`, as every drawer of the M6 fields paints it. */
export function fillKind(o: ShapeObject): FillKind {
  if (o.gradient) return o.gradient.kind === 'radial' ? 'radial' : 'linear';
  return o.fill ? 'solid' : 'none';
}

/** The Fill toggle: off drops the colour and the gradient; on keeps a fill there is, else the default. */
export function withFill(o: ShapeObject, on: boolean): ShapeObject {
  if (on) return o.fill || o.gradient ? o : { ...o, fill: DEFAULT_FILL };
  const { fill: _fill, gradient: _gradient, ...rest } = o;
  return rest;
}

/** A gradient from one colour to a darker shade of it. */
export function newGradient(color: Rgba, kind: 'linear' | 'radial'): Gradient {
  const stops = [
    { at: 0, color },
    { at: 1, color: shade(color, 0.6) },
  ];
  return kind === 'linear' ? { kind, angle: DEFAULT_ANGLE, stops } : { kind, stops };
}

/**
 * Switch between a solid colour and a gradient. Solid keeps the colour shown (the first stop); a gradient
 * starts from the solid colour, and switching linear ↔ radial keeps the stops (an angle or focus stays stored
 * for switching back; the other kind ignores it).
 */
export function withFillKind(o: ShapeObject, kind: Exclude<FillKind, 'none'>): ShapeObject {
  if (kind === fillKind(o)) return o;
  if (kind === 'solid') {
    const { gradient, ...rest } = o;
    return { ...rest, fill: gradient?.stops[0]?.color ?? o.fill ?? DEFAULT_FILL };
  }
  return withGradient(o, o.gradient ? { ...o.gradient, kind } : newGradient(o.fill ?? DEFAULT_FILL, kind));
}

/** Stops in order of position, ties in their given order (the schema's "stops are sorted by `at`"). */
export function sortStops(stops: Gradient['stops']): Gradient['stops'] {
  return [...stops].sort((a, b) => a.at - b.at);
}

/** Store a gradient, its stops sorted, with the legacy `fill` its first stop's colour (design/27 §3.2). */
export function withGradient(o: ShapeObject, g: Gradient): ShapeObject {
  const stops = sortStops(g.stops);
  return { ...o, gradient: { ...g, stops }, fill: stops[0]!.color };
}

/** One stop changed; a position is a share of the gradient, 0..1. */
export function withStop(g: Gradient, i: number, p: { at?: number; color?: Rgba }): Gradient {
  const at = p.at === undefined ? undefined : Math.min(1, Math.max(0, Number.isFinite(p.at) ? p.at : 0));
  return {
    ...g,
    stops: g.stops.map((s, j) => (j === i ? { at: at ?? s.at, color: p.color ?? s.color } : s)),
  };
}

/** A new stop in the middle of the widest gap, in the colour the gradient has there (at most MAX_STOPS). */
export function addStop(g: Gradient): Gradient {
  if (g.stops.length >= MAX_STOPS) return g;
  const stops = sortStops(g.stops);
  let at = 0;
  let widest = -1;
  for (let i = 0; i + 1 < stops.length; i++) {
    const gap = stops[i + 1]!.at - stops[i]!.at;
    if (gap > widest) {
      widest = gap;
      at = i;
    }
  }
  const a = stops[at]!;
  const b = stops[at + 1] ?? a;
  const stop = { at: (a.at + b.at) / 2, color: mix(a.color, b.color, 0.5) };
  return { ...g, stops: [...stops.slice(0, at + 1), stop, ...stops.slice(at + 1)] };
}

/** One stop removed (a gradient keeps at least MIN_STOPS). */
export function removeStop(g: Gradient, i: number): Gradient {
  if (g.stops.length <= MIN_STOPS) return g;
  return { ...g, stops: g.stops.filter((_, j) => j !== i) };
}

/** A linear gradient's angle in degrees, clockwise from left → right (the schema's bounds). */
export function withAngle(g: Gradient, angle: number): Gradient {
  return { ...g, angle: Math.min(36_000, Math.max(-36_000, Number.isFinite(angle) ? angle : 0)) };
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t);
  return {
    r: ch(a.r, b.r),
    g: ch(a.g, b.g),
    b: ch(a.b, b.b),
    a: Math.round((a.a + (b.a - a.a) * t) * 1000) / 1000,
  };
}

function shade(c: Rgba, f: number): Rgba {
  return { r: Math.round(c.r * f), g: Math.round(c.g * f), b: Math.round(c.b * f), a: c.a };
}

// ---- line ------------------------------------------------------------------------------------------------

/** The dashes of `LineDash` (OOXML prstDash); the 'Dense' ones are the sys* patterns, with gaps of one width. */
export const DASHES: { value: LineDash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dot', label: 'Dot' },
  { value: 'dash', label: 'Dash' },
  { value: 'dashDot', label: 'Dash dot' },
  { value: 'longDash', label: 'Long dash' },
  { value: 'longDashDot', label: 'Long dash dot' },
  { value: 'longDashDotDot', label: 'Long dash dot dot' },
  { value: 'sysDot', label: 'Dense dot' },
  { value: 'sysDash', label: 'Dense dash' },
  { value: 'sysDashDot', label: 'Dense dash dot' },
  { value: 'sysDashDotDot', label: 'Dense dash dot dot' },
];

/** A solid line stores no dash, so a plain shape keeps its legacy drawing. */
export function withDash(o: ShapeObject, dash: LineDash): ShapeObject {
  if (dash !== 'solid') return o.dash === dash ? o : { ...o, dash };
  const { dash: _dash, ...rest } = o;
  return rest;
}

export type ArrowType = ArrowEnd['type'];
export type ArrowSize = NonNullable<ArrowEnd['w']>;
/** OOXML headEnd sits at an open path's start, tailEnd at its end. */
export type EndSide = 'head' | 'tail';

export const ARROW_TYPES: { value: ArrowType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'stealth', label: 'Stealth' },
  { value: 'arrow', label: 'Open arrow' },
  { value: 'oval', label: 'Oval' },
  { value: 'diamond', label: 'Diamond' },
];

export const ARROW_SIZES: { value: ArrowSize; label: string }[] = [
  { value: 'sm', label: 'Small' },
  { value: 'med', label: 'Medium' },
  { value: 'lg', label: 'Large' },
];

/** An arrowhead's size: its width and length when they agree (absent is 'med'), else 'mixed' (as imported). */
export function arrowSize(end: ArrowEnd | undefined): ArrowSize | 'mixed' {
  const w = end?.w ?? 'med';
  return w === (end?.len ?? 'med') ? w : 'mixed';
}

/**
 * One end's arrowhead changed. A size sets the width and the length together; 'none' removes the end (with
 * its size), and a shape with no arrowhead left stores no `ends`.
 */
export function withEnd(
  o: ShapeObject,
  side: EndSide,
  p: { type?: ArrowType; size?: ArrowSize },
): ShapeObject {
  const cur: ArrowEnd = o.ends?.[side] ?? { type: 'none' };
  const next: ArrowEnd = { ...cur, ...(p.type ? { type: p.type } : {}) };
  if (p.size) {
    next.w = p.size;
    next.len = p.size;
  }
  const ends = { ...o.ends, [side]: next };
  if (next.type === 'none') delete ends[side];
  if (ends.head || ends.tail) return { ...o, ends };
  const { ends: _ends, ...rest } = o;
  return rest;
}

const openPaths = new WeakMap<object, boolean>();

/**
 * Whether stored path data (`ShapeGeom.paths[i].d`: M L Q C Z and numbers) has an open sub-path: one with a
 * segment that is not closed by Z. The drawer also counts a sub-path that ends where it started as closed;
 * this only decides whether the arrowhead fields are offered.
 */
export function openPathData(d: string): boolean {
  const M = 0x6d;
  const Z = 0x7a;
  let segments = 0;
  for (let i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i) | 0x20; // a letter in lower case; digits, signs and separators stay apart
    if (c === M) {
      if (segments > 0) return true;
    } else if (c !== Z) {
      if (c === 0x6c || c === 0x71 || c === 0x63) segments++; // l, q, c
      continue;
    }
    segments = 0;
  }
  return segments > 0;
}

/**
 * Whether the shape's outline has an open part, where arrowheads draw (closed outlines never get them, in
 * PowerPoint, LibreOffice or ordo): a legacy line, a preset with an open stroked path (arcs, brackets,
 * connectors), stored paths with an open sub-path, or a shape that already has an arrowhead.
 */
export function hasOpenOutline(o: ShapeObject): boolean {
  if (o.ends?.head || o.ends?.tail) return true;
  // A geometry stored in a file (`ShapeGeom.ref`) is read as the canvas draws it.
  const g = resolvedGeom(o.geom);
  if (!g) return o.shape === 'line';
  if (g.preset !== undefined && PRESET_GEOMS.has(g.preset)) {
    const built = presetGeometry(g.preset, Math.abs(o.box.w), Math.abs(o.box.h), g.adj);
    const tol = CLOSED_TOLERANCE * Math.max(built?.w ?? 0, built?.h ?? 0);
    return !!built?.paths.some((p) => p.stroke && geomPathOpen(p, tol));
  }
  if (g.paths?.length) {
    const paths = g.paths;
    return paths.some((p, i) => {
      // A path stored in pieces (`cont`) is one outline, read whole with its first piece.
      if (p.stroke === false || (i > 0 && p.cont)) return false;
      let open = openPaths.get(p);
      if (open === undefined) {
        let d = typeof p.d === 'string' ? p.d : '';
        for (let j = i + 1; j < paths.length && paths[j]!.cont; j++) d += ` ${paths[j]!.d}`;
        open = openPathData(d);
        openPaths.set(p, open);
      }
      return open;
    });
  }
  return o.shape === 'line';
}

// ---- shadow ----------------------------------------------------------------------------------------------

/**
 * PowerPoint's 'Offset: Bottom Right' outer shadow in logical px (144 px per inch, so 1 pt = 2 px): 3 pt
 * away at 45°, blurred 4 pt, black at 40 %.
 */
export const DEFAULT_SHAPE_SHADOW: Shadow = {
  dx: 4.243,
  dy: 4.243,
  blur: 8,
  color: { r: 0, g: 0, b: 0, a: 0.4 },
};

/** The Shadow toggle: on keeps a shadow there is (an imported one), else PowerPoint's default. */
export function withShadow(o: ShapeObject, on: boolean): ShapeObject {
  if (on) return o.shadow ? o : { ...o, shadow: DEFAULT_SHAPE_SHADOW };
  const { shadow: _shadow, ...rest } = o;
  return rest;
}

// ---- geometry (read-only) --------------------------------------------------------------------------------

export type GeomInfo =
  | {
      kind: 'preset';
      name: string;
      /** Each adjust value of the preset in avLst order: the stored one, else the preset's default. */
      adjust: { name: string; value: number; stored: boolean }[];
      /** Stored pairs that name no adjust value of the preset (the drawer ignores them). */
      unused: [string, number][];
    }
  | { kind: 'custom'; paths: number }
  | { kind: 'unknown'; name: string };

/**
 * What the stored geometry is (`ShapeGeom`: a known preset wins over paths; an unknown preset with no paths
 * draws the legacy shape), or undefined for a plain shape. Adjust values are evaluated as the drawer
 * evaluates them, at the box (a stored pair replaces the first adjust value of its name).
 */
export function geomInfo(o: ShapeObject): GeomInfo | undefined {
  const g = resolvedGeom(o.geom);
  if (!g) return undefined;
  const compiled = g.preset !== undefined ? PRESET_GEOMS.get(g.preset) : undefined;
  if (g.preset !== undefined && compiled) {
    const adj = g.adj ?? [];
    const vals = evalGuides(compiled, { w: Math.abs(o.box.w), h: Math.abs(o.box.h) }, adj);
    const base = BUILTIN_COUNT + compiled.k.length;
    const names = compiled.a;
    return {
      kind: 'preset',
      name: g.preset,
      adjust: names
        .map((name, i) => ({ name, value: vals[base + i] ?? 0, stored: adj.some(([n]) => n === name) }))
        .filter((a) => a.name !== ''),
      unused: adj.filter(([n]) => !names.includes(n)).map(([n, v]): [string, number] => [n, v]),
    };
  }
  if (g.paths?.length) return { kind: 'custom', paths: g.paths.filter((p, i) => i === 0 || !p.cont).length };
  // Its geometry file not read yet: a freeform all the same.
  if (g.ref !== undefined) return { kind: 'custom', paths: 1 };
  return { kind: 'unknown', name: g.preset ?? '' };
}

/** The shape's name for the panel's title: the PowerPoint preset, 'freeform', or the legacy shape. */
export function shapeName(o: ShapeObject): string {
  const info = geomInfo(o);
  return info?.kind === 'preset' ? info.name : info?.kind === 'custom' ? 'freeform' : o.shape;
}

/** An adjust value as the deck stores them (integers, mostly 1/100,000 of a length or 1/60,000 of a degree). */
export function adjustText(v: number): string {
  return String(Math.round(v * 100) / 100);
}

// ---- views -----------------------------------------------------------------------------------------------

const SHAPES = ['rect', 'ellipse', 'line'] as const;

/** The legacy shape picker, or the stored PowerPoint geometry, read-only (design/27 §11). */
export function ShapeGeometryField({ o, disabled, set }: Props) {
  const info = geomInfo(o);
  if (!info)
    return (
      <Select
        label="Shape"
        value={o.shape}
        options={SHAPES}
        disabled={disabled}
        onChange={(shape) => patch(set, (s) => ({ ...s, shape }))}
      />
    );
  return (
    <div className="col" style={{ gap: 4 }} data-shape-geom={info.kind}>
      <span className="small muted">Geometry (from PowerPoint, read-only)</span>
      {info.kind === 'preset' && (
        <>
          <span className="mono" data-preset>
            {info.name}
          </span>
          {info.adjust.map((a) => (
            <span key={a.name} className="small" data-adj={a.name}>
              <span className="mono">{a.name}</span> {adjustText(a.value)}
              {!a.stored && <span className="muted"> (default)</span>}
            </span>
          ))}
          {info.unused.map(([name, v]) => (
            <span key={name} className="small muted" data-adj-unused={name}>
              <span className="mono">{name}</span> {adjustText(v)} (not used by this preset)
            </span>
          ))}
        </>
      )}
      {info.kind === 'custom' && (
        <span>
          Freeform, {info.paths} path{info.paths === 1 ? '' : 's'}
        </span>
      )}
      {info.kind === 'unknown' && (
        <span>
          <span className="mono">{info.name}</span>{' '}
          <span className="muted small">(not a known preset: drawn as {o.shape})</span>
        </span>
      )}
    </div>
  );
}

/**
 * Unified single-row Figma-style Fill property:
 * `[Fill]  [PaintPill: Solid | Linear | Radial]  [−]` (or `[+]` when fill is None).
 */
export function ShapeFillFields({ o, disabled, set }: Props) {
  const kind = fillKind(o);
  const paintVal: PaintValue = o.gradient
    ? { kind: 'gradient', gradient: o.gradient }
    : o.fill
      ? { kind: 'solid', color: o.fill }
      : { kind: 'none' };

  const applyPaint = (next: PaintValue) => {
    if (next.kind === 'none') {
      patch(set, (s) => withFill(s, false));
    } else if (next.kind === 'solid') {
      patch(
        set,
        (s) => {
          const { gradient: _g, ...rest } = s;
          return { ...rest, fill: next.color };
        },
        `shape:${o.id}:fill`,
      );
    } else {
      patch(set, (s) => withGradient(s, next.gradient), `shape:${o.id}:gradient`);
    }
  };

  return (
    <div className="prop-line" data-fill-kind={kind} data-gradient={o.gradient?.kind}>
      <span className="prop-line-label">Fill</span>
      {kind !== 'none' ? (
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <PaintPill
            value={paintVal}
            modes={['solid', 'linear', 'radial']}
            disabled={disabled}
            ariaLabel="Shape fill"
            onChange={applyPaint}
          />
          <button
            type="button"
            className="small prop-toggle-btn"
            aria-label="Remove fill"
            title="Remove fill"
            disabled={disabled}
            onClick={() => patch(set, (s) => withFill(s, false))}
          >
            −
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="small prop-toggle-btn"
          aria-label="Add fill"
          title="Add fill"
          disabled={disabled}
          onClick={() => patch(set, (s) => withFill(s, true))}
        >
          +
        </button>
      )}
    </div>
  );
}

const QUICK_DASHES: ReadonlyArray<{ dash: LineDash; glyph: string; title: string }> = [
  { dash: 'solid', glyph: '───', title: 'Solid' },
  { dash: 'dash', glyph: '- - -', title: 'Dash' },
  { dash: 'sysDot', glyph: '• • •', title: 'Dot' },
];

/** The line's dash and, on an open outline, its arrowheads (shown when Stroke is active). */
export function ShapeLineFields({ o, disabled, set }: Props) {
  const curDash = o.dash ?? 'solid';
  const openOutline = hasOpenOutline(o);
  const nonQuickDash = !QUICK_DASHES.some((q) => q.dash === curDash);

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="ed-seg-bar" role="group" aria-label="Quick dash style">
        {QUICK_DASHES.map((d) => (
          <button
            key={d.dash}
            type="button"
            className={`small${curDash === d.dash ? ' on' : ''}`}
            disabled={disabled}
            title={d.title}
            aria-label={d.title}
            onClick={() => patch(set, (s) => withDash(s, d.dash))}
          >
            {d.glyph}
          </button>
        ))}
      </div>
      <details className="ed-collapsible" open={nonQuickDash || openOutline || undefined}>
        <summary>All dash patterns</summary>
        <div style={{ paddingTop: 6 }}>
          <Select
            label="Dash"
            value={curDash}
            options={DASHES}
            disabled={disabled}
            onChange={(dash) => patch(set, (s) => withDash(s, dash))}
          />
        </div>
      </details>
      {openOutline && (
        <>
          <ArrowFields o={o} side="head" disabled={disabled} set={set} />
          <ArrowFields o={o} side="tail" disabled={disabled} set={set} />
        </>
      )}
    </div>
  );
}

function ArrowFields({ o, side, disabled, set }: Props & { side: EndSide }) {
  const end = o.ends?.[side];
  const type = end?.type ?? 'none';
  const size = arrowSize(end);
  const sizes =
    size === 'mixed'
      ? [
          ...ARROW_SIZES,
          { value: 'mixed' as const, label: `${end?.w ?? 'med'} wide, ${end?.len ?? 'med'} long` },
        ]
      : ARROW_SIZES;
  return (
    <div className="row wrap" data-arrow={side}>
      <Select
        label={side === 'head' ? 'Start arrowhead' : 'End arrowhead'}
        value={type}
        options={ARROW_TYPES}
        disabled={disabled}
        onChange={(t) => patch(set, (s) => withEnd(s, side, { type: t }))}
      />
      {type !== 'none' && (
        <Select<ArrowSize | 'mixed'>
          label="Size"
          value={size}
          options={sizes}
          disabled={disabled}
          onChange={(v) => {
            if (v !== 'mixed') patch(set, (s) => withEnd(s, side, { size: v }));
          }}
        />
      )}
    </div>
  );
}

/** Single-row Figma-style Shadow property: `+` to add outer shadow, `ColorPill + −` when active. */
export function ShapeShadowField({ o, disabled, set }: Props) {
  return (
    <div className="prop-line" data-has-shadow={!!o.shadow}>
      <span className="prop-line-label">Shadow</span>
      {o.shadow ? (
        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
          <ColorPill
            value={o.shadow.color}
            disabled={disabled}
            ariaLabel="Shadow color"
            onChange={(color) => patch(set, (s) => (s.shadow ? { ...s, shadow: { ...s.shadow, color } } : s))}
          />
          <button
            type="button"
            className="small prop-toggle-btn"
            aria-label="Remove shadow"
            title="Remove shadow"
            disabled={disabled}
            onClick={() => patch(set, (s) => withShadow(s, false))}
          >
            −
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="small prop-toggle-btn"
          aria-label="Add shadow"
          title="Add outer shadow"
          disabled={disabled}
          onClick={() => patch(set, (s) => withShadow(s, true))}
        >
          +
        </button>
      )}
    </div>
  );
}
