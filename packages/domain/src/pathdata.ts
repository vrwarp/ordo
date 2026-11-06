/*
 * Path data of a stored geometry (`ShapeGeom.paths[i].d`, design/27 §3.1, §12): only the absolute commands
 * M, L, Q, C and Z with plain decimal numbers. The deck is untrusted, so the importer's sanitizer and the
 * render plan's clamp both re-tokenise every path string with `cleanPathData` before anything draws it, and
 * the drawers build their paths from `parsePathData`, never from the string itself.
 *
 * Grammar: a command letter, then its numbers (M and L take one x y pair, Q two, C three, Z none), separated
 * by whitespace or commas; more pairs after M are lines, after L, Q and C more of the same command (SVG). A
 * number is `[+-]digits[.digits][e[+-]digits]` (also `.5`, `5.`); NaN, Infinity, hex and every other token are
 * not numbers. Parsing stops at the first character that does not fit, keeping the commands before it;
 * a command missing numbers is dropped. Coordinates are clamped to ±PATH_DATA_LIMITS.coord.
 */

export const PATH_DATA_LIMITS = {
  /** Points per path: M, L and Z count 1, Q 2, C 3 (the geometry engine's GEOM_LIMITS.points). */
  points: 4096,
  /** Paths per geometry (ShapeGeom.paths). */
  paths: 8,
  /** Characters of one path string (the schema's bound); `cleanPathData` keeps whole commands within it. */
  chars: 40_000,
  /** Largest coordinate magnitude (the geometry engine's COORD_LIMIT). */
  coord: 1e9,
} as const;

/** A parsed path: one letter per command (M L Q C Z) and its coordinates, x y pairs in order. */
export type PathData = { cmds: string; pts: number[] };

const ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
const POINTS: Readonly<Record<string, number>> = { M: 1, L: 1, Q: 2, C: 3, Z: 1 };

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44;
}

/** The end of the number starting at `i`, or -1 when none starts there. */
function numberEnd(d: string, i: number): number {
  let j = i;
  const c0 = d.charCodeAt(j);
  if (c0 === 43 || c0 === 45) j++;
  let digits = 0;
  while (isDigit(d.charCodeAt(j))) {
    j++;
    digits++;
  }
  if (d.charCodeAt(j) === 46) {
    j++;
    while (isDigit(d.charCodeAt(j))) {
      j++;
      digits++;
    }
  }
  if (digits === 0) return -1;
  const e = d.charCodeAt(j);
  if (e === 101 || e === 69) {
    let k = j + 1;
    const s = d.charCodeAt(k);
    if (s === 43 || s === 45) k++;
    if (isDigit(d.charCodeAt(k))) {
      while (isDigit(d.charCodeAt(k))) k++;
      j = k;
    }
  }
  return j;
}

function coordOf(v: number): number {
  const L = PATH_DATA_LIMITS.coord;
  if (!(v > -L)) return v <= -L ? -L : 0;
  return v > L ? L : v + 0;
}

/**
 * Parse path data (any value: a non-string is an empty path) into commands and coordinates, at most
 * `maxPoints` points (a command that would pass it ends the path). Never throws; linear in the input.
 */
export function parsePathData(d: unknown, maxPoints: number = PATH_DATA_LIMITS.points): PathData {
  let cmds = '';
  const pts: number[] = [];
  if (typeof d !== 'string') return { cmds, pts };
  const s = d.length > PATH_DATA_LIMITS.chars * 4 ? d.slice(0, PATH_DATA_LIMITS.chars * 4) : d;
  const limit = Math.max(0, Math.min(Math.floor(maxPoints) || 0, PATH_DATA_LIMITS.points));
  let points = 0;
  let cmd = '';
  const args: number[] = [];
  let i = 0;
  const n = s.length;
  /** Emit `cmd` with `args` when complete; false when the point budget is spent. */
  const emit = (): boolean => {
    const p = POINTS[cmd]!;
    if (points + p > limit) return false;
    points += p;
    cmds += cmd;
    for (const a of args) pts.push(a);
    args.length = 0;
    if (cmd === 'M') cmd = 'L';
    return true;
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (isSpace(c)) {
      i++;
      continue;
    }
    const ch = s[i]!;
    if (ARITY[ch] !== undefined) {
      if (args.length) break; // a command with too few numbers: stop here
      cmd = ch;
      i++;
      if (cmd === 'Z' && !emit()) break;
      continue;
    }
    const end = numberEnd(s, i);
    if (end < 0 || cmd === '' || cmd === 'Z') break;
    args.push(coordOf(Number(s.slice(i, end))));
    i = end;
    if (args.length === ARITY[cmd] && !emit()) {
      args.length = 0;
      break;
    }
  }
  return { cmds, pts };
}

/** A coordinate as path data writes it (shortest round trip; -0 is 0). */
function numText(v: number): string {
  return String(v + 0);
}

/** Path data as a string: `M x y L x y Q … C … Z`, whole commands only, within `maxChars`. */
export function formatPathData(p: PathData, maxChars: number = PATH_DATA_LIMITS.chars): string {
  let out = '';
  let at = 0;
  for (const cmd of p.cmds) {
    const k = ARITY[cmd];
    if (k === undefined) break;
    let part = cmd;
    for (let j = 0; j < k; j++) part += ` ${numText(p.pts[at + j] ?? 0)}`;
    const next = out ? `${out} ${part}` : part;
    if (next.length > maxChars) break;
    out = next;
    at += k;
  }
  return out;
}

/** `d` re-tokenised (`parsePathData`, then `formatPathData`): what every reader of a stored path draws. */
export function cleanPathData(d: unknown): string {
  return formatPathData(parsePathData(d));
}

/** Points of a parsed path, counted as PATH_DATA_LIMITS counts them. */
export function pathDataPoints(p: PathData): number {
  let n = 0;
  for (const c of p.cmds) n += POINTS[c] ?? 0;
  return n;
}
