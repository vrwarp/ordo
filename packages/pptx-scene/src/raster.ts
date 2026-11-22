/**
 * Shapes drawn into pictures at import (the owner's Q53, Q53.f, Q53.e and Q56.d of 2026-11-21; design/29 decision
 * 4, changed by the owner; the planner side of sub-wave 3's `shape-raster`): a custom-path shape (`a:custGeom`)
 * with MORE THAN `RASTER_POINTS` points, or one past a geometry limit of the converter, is drawn once into a
 * picture by the hub's own browser running ordo's own renderer, and the slide stores an ordinary locked picture
 * where the shapes were. NO LIMIT IS RAISED: the stored 8 paths x 4,096 points a shape and the converter's 65,536
 * points a slide stay what they are (hostile-input limits); the only new numbers are the ones below, and the one
 * that bounds what is READ for the picture (`RASTER_READ`) is used by the recipe builder alone.
 *
 * This file holds what every raster file shares and nothing that touches the walk, the emitter or a deck:
 *
 * - the constants (C-SR1) and THE CAPABILITY LIST `RASTER_MAY_HOLD`, the one place that says what a picture may
 *   hold (the owner's Q53.i: the effects stay as today in this first version, a yes-to-draw answer flips
 *   entries of this one object);
 * - `rawPointCost`: the converter's point cost of a custom geometry counted over the commands the file holds, BEFORE
 *   any cut, with an OWN copy of the cost table (the converter's is private to `geom.ts`, which this file does not
 *   import; a test pins the copy against the public `customPaths`);
 * - the RECIPE: the TypeScript type of what the hub's page draws, its canonical bytes and its hash, written to the
 *   one wire format of the maker's contract C-RM1 (raster-maker owns the text, the hub's validator
 *   `checkRecipe` and the golden vector; this file is the other end and never restates the format), and the
 *   placeholder media id a recipe's picture has until the hub stores it.
 *
 * Pure: no DOM, no clock, no Node API. SHA-256 and base64 are written here because the package may not import
 * `node:crypto` (it runs in the operator's browser and on the hub's pool alike).
 */
import type { ShapeObject, TextObject } from '@ordo/domain';
import { pathCommands, type XNode } from './xml.ts';

// ── The constants (C-SR1) ───────────────────────────────────────────────────────────────────────────────────

/**
 * A custom-path shape with MORE than this many points (the converter's units: moveTo, lnTo and close 1, quadBezTo
 * 2, cubicBezTo 3, arcTo 12; counted over the raw commands of every `a:path`, before any cut) is a picture
 * candidate. 128 itself is not (one slide-89 shape has exactly 128); an arc counts 12, so eleven arcs (132) are.
 * One constant: the census sweep (64 / 128 / 256 / 512) moves it, with CONVERTER_VERSION and a Re-import prompt.
 */
export const RASTER_POINTS = 128;

/** The drawing version of the hash: a change of how a recipe is drawn (the page, the wide draw) moves it. */
export const RASTER_VERSION = 1;

/** Pictures one slide holds at most (a screen draws 16, a cue holds six 4K frames: the converter plans 12). */
export const RASTER_MAX_PICTURES = 4;

/** Device px per logical px: the 3840 density of the sheets (`SHEET_DENSITY`) and of the maker's recipe. */
export const RASTER_DENSITY = 2;

/** The most device pixels the pictures of one slide hold: three 3840x2160 frames of a cue's six (192 MiB). */
export const RASTER_SLIDE_PIXELS = 24_883_200;

/**
 * What is READ for a picture, never stored and never drawn live: the converter reads at most 32,768 points of
 * one shape for a slide (`GEOM_LIMITS`), and at most this many for the recipe of a picture. Equal to the
 * maker's recipe validator caps (`RECIPE_MAX_POINTS_MEMBER`, `RECIPE_MAX_POINTS`, its contract C-RM1).
 */
export const RASTER_READ = { pointsShape: 262_144, pointsSlide: 1_048_576 } as const;

/** Characters of pictured words kept a slide (`Slide.pptx.artText`: search and the cue label; Q68). */
export const RASTER_WORDS_MAX = 4_000;

/**
 * The caps of one run, each AT OR BELOW the recipe validator's (C-RM1: 2,048 members, 64 paths a member,
 * 262,144 points a member, 1,048,576 points a recipe, 256 text members, one 3840x2160 frame, 32 MiB of JSON); a
 * test copies the validator's numbers and fails when a planner cap is above one.
 */
export const RASTER_RUN = {
  members: 2_048,
  paths: 64,
  pointsMember: 262_144,
  points: 1_048_576,
  texts: 256,
  pixels: 8_294_400,
  bytes: 33_554_432,
  /** Bounds of elements a run skips over (drawn above the picture), kept to test later members against. */
  skipped: 256,
} as const;

/** Bytes of recipes one pool call may build, and one import (the hub accounts both; past them candidates stay as today). */
export const RASTER_RECIPE_BYTES = { call: 33_554_432, import: 134_217_728 } as const;

/** Candidates one slide plans pictures for at most (the rest stay as today with a named reason). */
export const RASTER_CANDIDATES_MAX = 20_000;

/** What makes the picture: the hub's headless browser running ordo's renderer ('page'), or the PDF route ('pdf'). */
export type RasterMaker = 'page' | 'pdf';

/** What a picture may hold, by kind (D20, the owner's Q53.i). */
export interface RasterMayHold {
  /** Text drawn into the picture: counts only when the maker is 'page' (ordo's own text engine). */
  text: boolean;
  shadow: boolean;
  glow: boolean;
  softEdge: boolean;
  /** A gradient whose stops differ in transparency. */
  alphaGradient: boolean;
  /** A picture fill on a wide mask: no path through the screens' own code, stays false whatever the owner says. */
  pictureFill: boolean;
  /** A 3-D look: stays false whatever the owner says. */
  threeD: boolean;
  /** A pattern fill: stays false whatever the owner says. */
  pattern: boolean;
}

/**
 * THE CAPABILITY LIST: ONE object, read by the planner's eligibility rule and by nothing else. Q53.i is still
 * asked (default NO): shapes with a shadow, glow, soft edge or a see-through gradient stay as today in this
 * first version; a yes-to-draw answer flips those four entries here (the maker's spike measured their cost) with a
 * converter-version bump and a Re-import prompt, and `raster-record.test.ts` fails until the version moves.
 */
export const RASTER_MAY_HOLD: Readonly<RasterMayHold> = Object.freeze({
  text: true,
  shadow: false,
  glow: false,
  softEdge: false,
  alphaGradient: false,
  pictureFill: false,
  threeD: false,
  pattern: false,
});

// ── Counting points ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a command of a path costs, in the converter's own units (`geom.ts` `COST`, which is private to it: this is a
 * copy, pinned against the public `customPaths` by `raster.test.ts`), keyed by the element's local name. A
 * null-prototype table: the names are a deck's.
 *
 * `xml.guard.test.ts` keeps every source but `xml.ts`, `geom.ts` and `walk.ts` from NAMING a path's commands, because
 * a path read in the packed form has no children to walk: the only way to read one is `pathCommands`, which this
 * file and `raster-emit.ts` use. The prefix is a constant and the names below are local, so no command is named here
 * in the form the guard looks for.
 */
const NS = 'a:';
const COST: Readonly<Record<string, number>> = Object.assign(Object.create(null), {
  moveTo: 1,
  lnTo: 1,
  close: 1,
  quadBezTo: 2,
  cubicBezTo: 3,
  arcTo: 12,
});

/** The converter's point cost of a path command by its element name (`undefined` for any other element). */
export function commandCost(name: string): number | undefined {
  return name.startsWith(NS) ? COST[name.slice(NS.length)] : undefined;
}

/** The path list of a custom geometry, found by its local name (see above). */
export function pathListOf(node: XNode): XNode | undefined {
  const want = `${NS}pathLst`;
  return node.children.find((c) => c.name === want);
}

/** Children of one list looked at, as a multiple of the cap (the converter's `SCAN_FACTOR`). */
const SCAN_FACTOR = 4;

/** The cost of a custom geometry's commands as the file holds them. */
export interface RawCost {
  /** The converter's point cost, summed over every command of every `a:path`; at most `cap + 1` when `capped`. */
  points: number;
  /** The sum passed the cap: counting stopped (the shape is past the reading bound). */
  capped: boolean;
  /** `a:path` elements seen (a shape past 8 is past a stored limit; past the recipe's 64 it cannot be drawn). */
  paths: number;
}

const memo = new WeakMap<XNode, RawCost>();

/**
 * The raw point cost of an `a:custGeom` (see `RASTER_POINTS`): the sum of the cost of every command of every
 * `a:path` of its path list, read through the package's XML helpers (`pathCommands`: a packed path has no
 * children). Counting stops once the sum passes `cap` (default `RASTER_READ.pointsShape`) and says so: a hostile
 * shape of 10^7 points costs one pass to the bound. Memoised per node for the default cap (an inherited geometry
 * is counted once per deck). Never throws: a node with no path list costs 0.
 */
export function rawPointCost(node: XNode | undefined, cap: number = RASTER_READ.pointsShape): RawCost {
  if (!node) return { points: 0, capped: false, paths: 0 };
  const dflt = cap === RASTER_READ.pointsShape;
  if (dflt) {
    const hit = memo.get(node);
    if (hit) return hit;
  }
  let points = 0;
  let paths = 0;
  let capped = false;
  const list = pathListOf(node)?.children ?? [];
  walk: for (const p of list) {
    if (p.name !== `${NS}path`) continue;
    paths++;
    let seen = 0;
    for (const c of pathCommands(p)) {
      if (seen++ >= SCAN_FACTOR * cap) break;
      const cost = commandCost(c.name);
      if (cost === undefined) continue;
      points += cost;
      if (points > cap) {
        capped = true;
        break walk;
      }
    }
  }
  const out: RawCost = { points, capped, paths };
  if (dflt) memo.set(node, out);
  return out;
}

// ── The recipe (the type of C-RM1) ──────────────────────────────────────────────────────────────────────────

/** The renderer's path fill modes (`PATH_FILLS`). */
export type RasterFill = 'norm' | 'none' | 'lighten' | 'lightenLess' | 'darken' | 'darkenLess';

/** One built path: its commands and points as base64 (C-RM1), in the member's box space. */
export interface RasterPath {
  /** Standard base64 of one byte per command: 0 move, 1 line, 3 quad, 4 cubic, 5 close. */
  cmds: string;
  /** Standard base64 of little-endian float32 x y pairs in command order. */
  pts: string;
  fill: RasterFill;
  stroke: boolean;
  /** The path continues the one before it (the page joins them before drawing). */
  cont?: true;
}

/** The stored shape the emitter would write for a member, without its geometry, id, origin and locked. */
export type RasterShape = Omit<ShapeObject, 'id' | 'geom' | 'origin' | 'locked'>;
/** The stored text object of a text-bearing member, without its id, origin and locked. */
export type RasterText = Omit<TextObject, 'id' | 'origin' | 'locked'>;

/** One shape of a run, in z order. */
export interface RasterMember {
  shape: RasterShape;
  geom: { paths: RasterPath[] };
  /** Only when the maker is 'page'. */
  text?: RasterText;
  /** The font families the text needs (at most 32 of 1 to 256 characters). */
  families?: string[];
}

/** What the hub's page draws into one picture (the maker's C-RM1; never stored, never sent to a screen). */
export interface RasterRecipe {
  /** The recipe FORMAT version (not `RASTER_VERSION`). */
  v: 1;
  /** The canvas in device px. */
  w: number;
  h: number;
  /** The run's union box in slide logical px: `w` = `box.w` x `density`, `h` = `box.h` x `density`. */
  box: { x: number; y: number; w: number; h: number };
  density: typeof RASTER_DENSITY;
  members: RasterMember[];
}

/** The standard base64 (RFC 4648, with padding) of bytes. */
export function base64(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    chunk += A[b0 >> 2]! + A[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
    chunk += b1 === undefined ? '=' : A[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
    chunk += b2 === undefined ? '=' : A[b2 & 63]!;
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

/**
 * A built path as the recipe writes it (C-RM1): its command codes as one byte each and its points as
 * little-endian float32, both as base64. Non-finite points become 0 (the builder already cleans them; the
 * validator refuses what is left out of bounds).
 */
export function encodePath(cmds: ArrayLike<number>, pts: ArrayLike<number>): { cmds: string; pts: string } {
  const c = new Uint8Array(cmds.length);
  for (let i = 0; i < cmds.length; i++) c[i] = cmds[i]! & 0xff;
  const p = new Uint8Array(pts.length * 4);
  const view = new DataView(p.buffer);
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i]!;
    view.setFloat32(i * 4, Number.isFinite(v) ? v : 0, true);
  }
  return { cmds: base64(c), pts: base64(p) };
}

// ── Canonical bytes and the hash ────────────────────────────────────────────────────────────────────────────

const MAX_DEPTH = 64;

/**
 * The canonical JSON text of a value (C-RM1): every object's keys in ascending order of their UTF-16 code units,
 * no whitespace, a number as `JSON.stringify` writes it (a finite one; minus zero as 0; a number that is not finite
 * as `null`, which the validator refuses), a string as `JSON.stringify` writes it, a key whose value is
 * `undefined` left out, array order kept (member and path order are z order and never sorted).
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  const put = (v: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) throw new RangeError('a recipe nests deeper than it should');
    if (v === null || v === undefined) out.push('null');
    else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
    else if (typeof v === 'number') out.push(Number.isFinite(v) ? JSON.stringify(v) : 'null');
    else if (typeof v === 'string') out.push(JSON.stringify(v));
    else if (Array.isArray(v)) {
      out.push('[');
      for (let i = 0; i < v.length; i++) {
        if (i) out.push(',');
        put(v[i], depth + 1);
      }
      out.push(']');
    } else if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      out.push('{');
      keys.forEach((k, i) => {
        if (i) out.push(',');
        out.push(JSON.stringify(k), ':');
        put(o[k], depth + 1);
      });
      out.push('}');
    } else out.push('null');
  };
  put(value, 0);
  return out.join('');
}

/** The canonical bytes of a recipe (UTF-8 of `canonicalJson`): what its hash covers and what the hub's file holds. */
export function canonicalBytes(recipe: RasterRecipe): Uint8Array {
  return new TextEncoder().encode(canonicalJson(recipe));
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/** SHA-256 of bytes (FIPS 180-4), 32 bytes. */
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const total = data.length;
  // The padded message: the data, 0x80, zeros, and the bit length as 64 bits.
  const padded = new Uint8Array(((total + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[total] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(total / 0x20000000) >>> 0);
  view.setUint32(padded.length - 4, (total * 8) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
    h[5] = (h[5]! + f) | 0;
    h[6] = (h[6]! + g) | 0;
    h[7] = (h[7]! + hh) | 0;
  }
  const out = new Uint8Array(32);
  const o = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) o.setUint32(i * 4, h[i]!);
  return out;
}

/** Lower-case hex of bytes. */
export function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}

/**
 * The hash of canonical recipe bytes (C-RM1): SHA-256 over the ASCII text 'ordo-raster', a line feed, the decimal
 * `RASTER_VERSION`, a line feed, then the canonical bytes. THE MAKER IS NOT PART OF IT: the hash is the identity of
 * the recipe, so one recipe is one media item whichever tool drew it.
 */
export function hashOfBytes(canonical: Uint8Array): string {
  const head = new TextEncoder().encode(`ordo-raster\n${RASTER_VERSION}\n`);
  const all = new Uint8Array(head.length + canonical.length);
  all.set(head);
  all.set(canonical, head.length);
  return hex(sha256(all));
}

/** The hash of a recipe: 64 lower-case hex characters. */
export function recipeHash(recipe: RasterRecipe): string {
  return hashOfBytes(canonicalBytes(recipe));
}

/**
 * The placeholder media id a recipe's picture has until the hub stores it (D8): `pptxmedia:raster` and the first 16
 * hex characters of the hash. Inside the converter's own prefix so that the importers' remap maps it, and
 * content-derived so a re-import of an unchanged deck gives the same slide digest.
 */
export const RASTER_PREFIX = 'pptxmedia:raster';
export function rasterPlaceholder(hash: string): string {
  return RASTER_PREFIX + hash.slice(0, 16);
}

// ── Member references (C-SR17) ──────────────────────────────────────────────────────────────────────────────

/** A member named so that a later step finds it again in the deck: an `ElementRef` (`ir.ts`) without the type import. */
export interface RasterRef {
  from: 'slide' | 'layout' | 'master';
  shapeId: number;
  /** Ids repeat in real decks: the place among the elements of `from` with this id, bottom first, from 0. */
  nth: number;
}

/** References kept in the provenance at most; past it the field is left out (the hash and the converter version are the handle). */
export const RASTER_REFS_MAX = 32;

/**
 * The members' references as `[shapeId, nth, count]` RUNS: `count` consecutive members (in z order) whose shape ids
 * ascend by one from `shapeId` and which share `nth`. Undefined when more than `RASTER_REFS_MAX` runs are needed.
 * The source (`from`) is the run's: a picture's members come from one.
 */
export function encodeRefs(refs: readonly RasterRef[]): [number, number, number][] | undefined {
  const out: [number, number, number][] = [];
  for (const r of refs) {
    const last = out[out.length - 1];
    if (last && r.nth === last[1] && r.shapeId === last[0] + last[2] && last[2] < RASTER_RUN.members)
      last[2]++;
    else {
      if (out.length >= RASTER_REFS_MAX) return undefined;
      out.push([r.shapeId, r.nth, 1]);
    }
  }
  return out;
}
