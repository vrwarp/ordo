import { type DecorData, type DecorPaint, type DecorPart, DECOR_LIMITS, cleanPathData } from '@ordo/domain';
import { clampColor, finite, sanitizeGradient } from '../sanitize.ts';

/*
 * `ShapeObject.decor` of an imported shape (design/27 M9) within the schema's bounds: at most 64 paints and
 * 256 parts, every path string re-tokenised (`cleanPathData`, as stored paths are) and a part left empty or
 * naming no paint dropped, numbers finite and bounded. Undefined when no paint is left.
 */

const COORD = 100_000;

function paint(p: DecorPaint): DecorPaint {
  const out: DecorPaint = { ...p };
  if (p.fill) out.fill = clampColor(p.fill);
  if (p.gradient) {
    const g = sanitizeGradient(p.gradient);
    if (g) out.gradient = g;
    else delete out.gradient;
  }
  if (p.stroke) out.stroke = { width: finite(p.stroke.width, 0, 0, 500), color: clampColor(p.stroke.color) };
  if (p.shadow)
    out.shadow = {
      dx: finite(p.shadow.dx, 0, -500, 500),
      dy: finite(p.shadow.dy, 0, -500, 500),
      blur: finite(p.shadow.blur, 0, 0, 500),
      color: clampColor(p.shadow.color),
    };
  return out;
}

function part(p: DecorPart, paints: number): DecorPart | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const d = cleanPathData(p.d);
  if (!d || !Number.isInteger(p.p) || p.p < 0 || p.p >= paints) return undefined;
  const { s, cont, frame, ...rest } = p;
  const out: DecorPart = { ...rest, d };
  if (s === 1) out.s = 1;
  if (cont === true) out.cont = true;
  if (typeof p.stroke !== 'boolean') delete out.stroke;
  if (Array.isArray(frame) && frame.length === 5 && frame.every((v) => Number.isFinite(v)))
    out.frame = [
      finite(frame[0], 0, -COORD, COORD),
      finite(frame[1], 0, -COORD, COORD),
      finite(frame[2], 0, 0, COORD),
      finite(frame[3], 0, 0, COORD),
      finite(frame[4], 0, -360, 360),
    ];
  return out;
}

/** A decoration file's name as stored (`DecorData.ref`): 1-100 printable characters, else undefined. */
function ref(v: unknown): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  return typeof v === 'string' && v.length >= 1 && v.length <= 100 && !/[\u0000-\u001f\u007f]/.test(v)
    ? v
    : undefined;
}

export function sanitizeDecor(d: DecorData): DecorData | undefined {
  if (!d || typeof d !== 'object' || !Array.isArray(d.paints)) return undefined;
  const paints = d.paints
    .filter((p) => p && typeof p === 'object')
    .slice(0, DECOR_LIMITS.paints)
    .map(paint);
  if (!paints.length) return undefined;
  const parts: DecorPart[] = [];
  for (const p of Array.isArray(d.parts) ? d.parts : []) {
    if (parts.length >= DECOR_LIMITS.parts) break;
    const kept = part(p, paints.length);
    if (kept) parts.push(kept);
  }
  const out: DecorData = { ...d, w: finite(d.w, 0, 0, 1e9), h: finite(d.h, 0, 0, 1e9), paints, parts };
  const r = ref(d.ref);
  if (r) out.ref = r;
  else delete out.ref;
  return out;
}
