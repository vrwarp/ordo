import {
  DECOR_LIMITS,
  type DecorData,
  type DecorPaint,
  type DecorPart,
  type LineDash,
  type PathFillMode,
  type Shadow,
} from '@ordo/domain';
import { formatPathData, type PathData, parsePathData, pathDataPoints } from '@ordo/domain/pathdata.ts';
import { CLAMP, clampColor, clampGradient, num } from '../clamp.ts';

/*
 * `ShapeObject.decor` as the decoration drawer draws it (design/27 M9, decor-render; the schema's `DecorData`
 * and `DECOR_LIMITS`): re-read field by field, as `clamp.ts` reads every other drawn field, never trusting
 * what a hostile or newer file holds. The render plan's own clamp (`clamp/decor.ts`, in every drawer's bundle)
 * only re-validates the field against the schema to tell the dispatch that a decoration is there; this full
 * clamp lives with the drawer (its lazy chunk, `decor/index.ts`) and the decoration files' store, and runs
 * before anything of a decoration is built, drawn, rated or bounded. Undefined when nothing drawable is left:
 * the decoration then draws nothing, as its legacy line without a stroke and an older build do.
 *
 * - `w` and `h`: finite and positive (the space the parts are in), at most 1e9.
 * - Paints: at most 64, each a colour, a gradient (`clampGradient`: 2-16 sorted stops), an outline (width
 *   within `CLAMP.maxEffectPx`), a dash (known names, 'solid' left out) and a shadow (`CLAMP.maxEffectPx`).
 * - Parts: at most 256, each path string re-tokenised (`cleanPathData`: M L Q C Z and numbers, at most 4,096
 *   points and 40,000 characters); a part left empty, or whose paint index is out of the palette, is dropped;
 *   fill modes outside the closed list are 'norm' (left out); `frame` kept only as five finite numbers.
 * - Points: at most `DECOR_LIMITS.points` (16,384) over all parts; the source shape whose parts would pass it
 *   is dropped with every part after it, so no shape is drawn cut in half.
 * - `ref` (a decoration file): kept when it is 1-100 characters without control characters.
 * The shadow cap (`DECOR_LIMITS.shadowed`, 24 source shapes) is applied where the shapes are built
 * (`draw.ts` `decorShapes`): a paint is shared, so a later shape loses its shadow there, not its paint.
 * Never throws.
 */

const LINE_DASHES: ReadonlySet<string> = new Set<LineDash>([
  'dot',
  'dash',
  'dashDot',
  'longDash',
  'longDashDot',
  'longDashDotDot',
  'sysDot',
  'sysDash',
  'sysDashDot',
  'sysDashDotDot',
]);

const FILL_MODES: ReadonlySet<string> = new Set<PathFillMode>([
  'none',
  'lighten',
  'lightenLess',
  'darken',
  'darkenLess',
]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A box or frame coordinate (the schema's `coord` / `length` bounds). */
const COORD = 100_000;

function clampShadow(v: Record<string, unknown>): Shadow {
  return {
    dx: num(v.dx, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0),
    dy: num(v.dy, -CLAMP.maxEffectPx, CLAMP.maxEffectPx, 0),
    blur: num(v.blur, 0, CLAMP.maxEffectPx, 0),
    color: clampColor(v.color, { r: 0, g: 0, b: 0, a: 1 }),
  };
}

/** One paint, each field only when present and usable (an empty paint draws nothing). */
export function clampDecorPaint(v: unknown): DecorPaint {
  if (!isObj(v)) return {};
  const out: DecorPaint = {};
  if (v.fill !== undefined && v.fill !== null) out.fill = clampColor(v.fill);
  const gradient = clampGradient(v.gradient);
  if (gradient) out.gradient = gradient;
  if (isObj(v.stroke))
    out.stroke = {
      width: num(v.stroke.width, 0, CLAMP.maxEffectPx, 1),
      color: clampColor(v.stroke.color),
    };
  if (typeof v.dash === 'string' && LINE_DASHES.has(v.dash)) out.dash = v.dash as LineDash;
  if (isObj(v.shadow)) out.shadow = clampShadow(v.shadow);
  return out;
}

/**
 * What each clamped part's string was read as (`parsePathData`), so the drawer builds its paths without reading
 * the string again (a decoration at its caps is 16,384 points: about 7 ms a read at 4K under load).
 */
const parsedParts = new WeakMap<DecorPart, PathData>();

/** The parsed path of a part the clamp made, if it made it. */
export function parsedPart(p: DecorPart): PathData | undefined {
  return parsedParts.get(p);
}

/** A gradient frame: five finite numbers (x, y, w, h within the coordinate bounds, rotation ±360). */
function clampFrame(v: unknown): DecorPart['frame'] {
  if (!Array.isArray(v) || v.length !== 5) return undefined;
  if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined;
  return [
    num(v[0], -COORD, COORD, 0),
    num(v[1], -COORD, COORD, 0),
    num(v[2], 0, COORD, 0),
    num(v[3], 0, COORD, 0),
    num(v[4], -360, 360, 0),
  ];
}

/** A decoration file's name: 1-100 characters without control characters. */
function clampRef(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v || v.length > 100) return undefined;
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) < 32 || v.charCodeAt(i) === 127) return undefined;
  return v;
}

/**
 * Parts as drawn (see the header), against a palette of `paints` entries: re-tokenised, in range, within the
 * part and point caps. Also what a decoration file's parts are clamped by (`files.ts` `putDecorFile`).
 */
export function clampDecorParts(v: unknown, paints: number): DecorPart[] {
  const out: DecorPart[] = [];
  if (!Array.isArray(v)) return out;
  let points = 0;
  /** Where the source shape being read starts in `out`. */
  let shapeAt = 0;
  const n = Math.min(v.length, DECOR_LIMITS.parts);
  for (let i = 0; i < n; i++) {
    const p = v[i];
    if (!isObj(p)) continue;
    const ix = p.p;
    if (typeof ix !== 'number' || !Number.isInteger(ix) || ix < 0 || ix >= paints) continue;
    let parsed = parsePathData(p.d);
    if (!parsed.cmds) continue;
    // The string written back from what was read (`cleanPathData`), never the stored one; drawn as that
    // string reads, so a decoration draws the same before and after it is stored (a stored string is clean
    // already, and read once).
    const d = formatPathData(parsed);
    if (!d) continue;
    if (d !== p.d) parsed = parsePathData(d);
    // A source shape starts where `decorShapes` starts one: at a marked part, the first, or a change of paint.
    const first = p.s === 1 || out.length === 0 || out[out.length - 1]!.p !== ix;
    if (first) shapeAt = out.length;
    const k = pathDataPoints(parsed);
    if (points + k > DECOR_LIMITS.points) {
      // The shape this part belongs to is not drawn, nor anything after it.
      out.length = shapeAt;
      break;
    }
    points += k;
    // `s` and `stroke` as given: the first part and a change of paint start a shape unmarked too, and a part
    // is stroked unless `stroke` is false.
    const part: DecorPart = { d, p: ix };
    if (p.s === 1) part.s = 1;
    if (typeof p.fill === 'string' && FILL_MODES.has(p.fill)) part.fill = p.fill as PathFillMode;
    if (typeof p.stroke === 'boolean') part.stroke = p.stroke;
    if (p.cont === true && !first) part.cont = true;
    const frame = clampFrame(p.frame);
    if (frame) part.frame = frame;
    parsedParts.set(part, parsed);
    out.push(part);
  }
  return out;
}

/**
 * `ShapeObject.decor` as drawn (see the header): undefined when nothing drawable is left (the decoration draws
 * nothing). Never throws.
 */
export function clampDecorData(v: unknown): DecorData | undefined {
  if (!isObj(v)) return undefined;
  try {
    const w = num(v.w, 0, 1e9, 0);
    const h = num(v.h, 0, 1e9, 0);
    if (!(w > 0 && h > 0)) return undefined;
    if (!Array.isArray(v.paints) || !v.paints.length) return undefined;
    const paints = v.paints.slice(0, DECOR_LIMITS.paints).map(clampDecorPaint);
    const parts = clampDecorParts(v.parts, paints.length);
    const ref = clampRef(v.ref);
    if (!parts.length && !ref) return undefined;
    return { w, h, paints, parts, ...(ref ? { ref } : {}) };
  } catch {
    // An accessor that throws (a hostile value's getter): the legacy drawing.
    return undefined;
  }
}
