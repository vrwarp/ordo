/*
 * The recipe of a picture of a run of shapes (the owner's Q53 and Q56.d; design 29 decision 4): the JSON text that
 * says what the hub's headless Chromium page draws. THE WIRE FORMAT IS ONE WRITTEN CONTRACT (C-RM1, owned by
 * this file's track; the planner's TypeScript type and its hash function in packages/pptx-scene are the other
 * end) and this file is its VALIDATOR: a pure function, no DOM and no Node API, that refuses a hostile recipe
 * before anything is drawn. It runs twice: in node, in `renderRecipe`, BEFORE the browser is started (a
 * hostile recipe never starts a browser), and again inside the page on load (the page never trusts the driver).
 *
 *   { v: 1, w, h, box: { x, y, w, h }, density: 2, members: [ { shape, geom: { paths: [ PATH ] }, text?, families? } ] }
 *
 * `w` x `h` are device px (integers, 1 to 7,680, at most one 3840x2160 frame); `box` is the run's union box in
 * slide logical px with `box.w x density = w` and `box.h x density = h` exactly; members are in z order, bottom
 * first, and are never sorted. A PATH is `{ cmds, pts, fill, stroke, cont? }`: `cmds` is the base64 of one byte
 * per built-path command (0 move, 1 line, 3 quad, 4 cubic, 5 close), `pts` the base64 of little-endian
 * float32 x y pairs in command order in the member's box space (the layout of `GeomPath.pts`), `cont: true`
 * says the path continues the one before it. Canonical bytes and the hash (SHA-256 over 'ordo-raster', a line
 * feed, the drawing version, a line feed and the canonical bytes) are the planner's; the golden vector in
 * apps/hub/test/data/raster-recipe-v1.json pins both ends.
 *
 * Bounds: every cap below; a number out of its bound, a key not listed, a command byte not in the set, a `pts`
 * of the wrong length or with a value that is not finite or past 1e9, a first path with `cont`: refused. The
 * reason is at most 200 characters and holds no recipe text. Never stored, never on a GO path.
 */

/** The recipe format versions the page accepts (not RASTER_VERSION, the drawing version of the hash). */
export const RECIPE_VERSIONS: readonly number[] = [1];
/** The recipe file's most bytes. */
export const RECIPE_MAX_BYTES = 33_554_432;
/** Members of one recipe. */
export const RECIPE_MAX_MEMBERS = 2_048;
/** Paths of one member. */
export const RECIPE_MAX_PATHS = 64;
/** Points of one member and of a whole recipe, in the renderer's cost units (move, line, close 1; quad 2; cubic 3). */
export const RECIPE_MAX_POINTS_MEMBER = 262_144;
export const RECIPE_MAX_POINTS = 1_048_576;
/** One 3840x2160 frame. */
export const RECIPE_MAX_PIXELS = 8_294_400;
export const RECIPE_MAX_SIDE = 7_680;
/** Text-bearing members, and the most JSON bytes of one text object. */
export const RECIPE_MAX_TEXT_MEMBERS = 256;
export const RECIPE_MAX_TEXT_BYTES = 262_144;
/** Device px per logical px (the planner's RASTER_DENSITY, the sheets' SHEET_DENSITY). */
export const RECIPE_DENSITY = 2;
/** Largest coordinate magnitude of a built path (the renderer's COORD_LIMIT). */
export const RECIPE_COORD_LIMIT = 1e9;
/** The run's box and a member's box stay within this. */
export const RECIPE_BOX_LIMIT = 1_000_000;
/** The most font families a member names, and their length. */
export const RECIPE_MAX_FAMILIES = 32;
export const RECIPE_MAX_FAMILY_CHARS = 256;
/** A refusal's reason is at most this many characters. */
export const RECIPE_REASON_CHARS = 200;

/** The built-path command codes (renderer geom/ops.ts CMD_MOVE .. CMD_CLOSE; the arc, 2, never appears). */
const CMD_MOVE = 0;
const CMD_LINE = 1;
const CMD_QUAD = 3;
const CMD_CUBIC = 4;
const CMD_CLOSE = 5;
/** The renderer's PATH_FILLS names. */
export const RECIPE_FILLS: readonly string[] = [
  'norm',
  'none',
  'lighten',
  'lightenLess',
  'darken',
  'darkenLess',
];

/** A library face as the page reads it: the renderer's `FontFile` and the file it is read from (C-RM2). */
export interface RasterFont {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** SHA-256 of the file: what the drawers read it by. */
  hash: string;
  /** CSS unicode-range of a subset face. */
  unicodeRange?: string;
  /** A file: URL the page reads the face from. */
  url: string;
}

export interface RecipeBoxWire {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RecipePathWire {
  cmds: string;
  pts: string;
  fill: string;
  stroke: boolean;
  cont?: true;
}

export interface RecipeMemberWire {
  /** The stored ShapeObject without its geometry, id, origin and locked (slide logical px). */
  shape: Record<string, unknown>;
  geom: { paths: RecipePathWire[] };
  /** The stored TextObject of a text-bearing member (slide logical px). */
  text?: Record<string, unknown>;
  families?: string[];
}

export interface RecipeWire {
  v: number;
  w: number;
  h: number;
  box: RecipeBoxWire;
  density: number;
  members: RecipeMemberWire[];
}

export type RecipeCheck =
  | { ok: true; recipe: RecipeWire; points: number; bytes: number }
  | { ok: false; reason: string };

class Refused extends Error {}

function refuse(reason: string): never {
  throw new Refused(reason);
}

/** A plain JSON object (not null, not an array). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) refuse(`${where}: a key that is not part of the format`);
}

function finite(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) refuse(`${where} is not a finite number`);
  if (v < min || v > max) refuse(`${where} is out of bounds`);
  return v;
}

function integer(v: unknown, where: string, min: number, max: number): number {
  const n = finite(v, where, min, max);
  if (!Number.isInteger(n)) refuse(`${where} is not a whole number`);
  return n;
}

/** UTF-8 length of a string, without a TextEncoder (a lone surrogate counts as 3, as the replacement does). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The bytes of a standard base64 string with padding; refuses anything else. */
function base64Bytes(s: unknown, where: string, maxBytes: number): Uint8Array {
  if (typeof s !== 'string') refuse(`${where} is not text`);
  if (s.length % 4 !== 0 || !BASE64.test(s)) refuse(`${where} is not base64`);
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const n = (s.length / 4) * 3 - pad;
  if (n > maxBytes) refuse(`${where} is too long`);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** What a command byte adds: [coordinate pairs, cost units]. */
function commandCost(code: number): readonly [number, number] | undefined {
  if (code === CMD_MOVE || code === CMD_LINE) return [1, 1];
  if (code === CMD_QUAD) return [2, 2];
  if (code === CMD_CUBIC) return [3, 3];
  if (code === CMD_CLOSE) return [0, 1];
  return undefined;
}

/** Checks one path; returns its cost units. */
function checkPath(p: unknown, first: boolean, where: string, budget: number): number {
  if (!isObject(p)) refuse(`${where} is not an object`);
  onlyKeys(p, ['cmds', 'pts', 'fill', 'stroke', 'cont'], where);
  if (!RECIPE_FILLS.includes(p.fill as string)) refuse(`${where}: an unknown fill mode`);
  if (typeof p.stroke !== 'boolean') refuse(`${where}: stroke is not true or false`);
  if ('cont' in p) {
    if (p.cont !== true) refuse(`${where}: cont is not true`);
    if (first) refuse(`${where}: the first path of a member continues nothing`);
  }
  // At most one byte per cost unit of the member's budget (a command costs at least 1).
  const cmds = base64Bytes(p.cmds, `${where}: cmds`, budget);
  let pairs = 0;
  let cost = 0;
  for (let i = 0; i < cmds.length; i++) {
    const c = commandCost(cmds[i]!);
    if (!c) refuse(`${where}: a command that is not move, line, quad, cubic or close`);
    pairs += c[0];
    cost += c[1];
  }
  if (cost > budget) refuse(`${where} has too many points`);
  const pts = base64Bytes(p.pts, `${where}: pts`, pairs * 8);
  if (pts.length !== pairs * 8) refuse(`${where}: pts does not match the commands`);
  const view = new DataView(pts.buffer, pts.byteOffset, pts.byteLength);
  for (let i = 0; i < pts.length; i += 4) {
    const v = view.getFloat32(i, true);
    if (!Number.isFinite(v) || Math.abs(v) > RECIPE_COORD_LIMIT)
      refuse(`${where}: a coordinate is not finite or is out of bounds`);
  }
  return cost;
}

function checkShapeBox(box: unknown, where: string): void {
  if (!isObject(box)) refuse(`${where} has no box`);
  finite(box.x, `${where} box.x`, -RECIPE_BOX_LIMIT, RECIPE_BOX_LIMIT);
  finite(box.y, `${where} box.y`, -RECIPE_BOX_LIMIT, RECIPE_BOX_LIMIT);
  finite(box.w, `${where} box.w`, 0, RECIPE_BOX_LIMIT);
  finite(box.h, `${where} box.h`, 0, RECIPE_BOX_LIMIT);
  if (box.rotation !== undefined) finite(box.rotation, `${where} box.rotation`, -1_000_000, 1_000_000);
}

function checkMember(m: unknown, i: number): { cost: number; text: boolean } {
  const where = `member ${i}`;
  if (!isObject(m)) refuse(`${where} is not an object`);
  onlyKeys(m, ['shape', 'geom', 'text', 'families'], where);
  const shape = m.shape;
  if (!isObject(shape)) refuse(`${where} has no shape`);
  if (shape.type !== 'shape') refuse(`${where}: shape.type is not 'shape'`);
  if ('geom' in shape) refuse(`${where}: the shape carries its own geometry`);
  checkShapeBox(shape.box, `${where} shape`);
  if (!isObject(m.geom)) refuse(`${where} has no geometry`);
  onlyKeys(m.geom, ['paths'], `${where} geom`);
  const paths = m.geom.paths;
  if (!Array.isArray(paths)) refuse(`${where}: geom.paths is not a list`);
  if (paths.length > RECIPE_MAX_PATHS) refuse(`${where} has more than ${RECIPE_MAX_PATHS} paths`);
  let cost = 0;
  for (let k = 0; k < paths.length; k++)
    cost += checkPath(paths[k], k === 0, `${where} path ${k}`, RECIPE_MAX_POINTS_MEMBER - cost);
  let text = false;
  if ('text' in m) {
    const t = m.text;
    if (!isObject(t)) refuse(`${where}: text is not an object`);
    if (t.type !== 'text') refuse(`${where}: text.type is not 'text'`);
    checkShapeBox(t.box, `${where} text`);
    if (utf8Length(JSON.stringify(t)) > RECIPE_MAX_TEXT_BYTES)
      refuse(`${where}: the text object is over ${RECIPE_MAX_TEXT_BYTES} bytes`);
    text = true;
  }
  if ('families' in m) {
    const f = m.families;
    if (!Array.isArray(f) || f.length > RECIPE_MAX_FAMILIES)
      refuse(`${where}: families is not a list of at most ${RECIPE_MAX_FAMILIES}`);
    for (const name of f)
      if (typeof name !== 'string' || name.length < 1 || name.length > RECIPE_MAX_FAMILY_CHARS)
        refuse(`${where}: a family name is not 1 to ${RECIPE_MAX_FAMILY_CHARS} characters`);
  }
  return { cost, text };
}

/**
 * Checks a recipe (the file's text or bytes, or a parsed object) against every bound of the format.
 * `bytes` is the file's size (the JSON text's length for a parsed object). Never throws.
 */
export function checkRecipe(input: string | Uint8Array | unknown): RecipeCheck {
  try {
    let value: unknown;
    let bytes: number;
    if (typeof input === 'string' || input instanceof Uint8Array) {
      bytes = typeof input === 'string' ? utf8Length(input) : input.length;
      if (bytes > RECIPE_MAX_BYTES) refuse('the recipe file is too large');
      const text =
        typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
      try {
        value = JSON.parse(text);
      } catch {
        refuse('the recipe is not JSON');
      }
    } else {
      value = input;
      let text: string;
      try {
        text = JSON.stringify(value) ?? '';
      } catch {
        refuse('the recipe cannot be written as JSON');
      }
      bytes = utf8Length(text);
      if (bytes > RECIPE_MAX_BYTES) refuse('the recipe file is too large');
    }
    if (!isObject(value)) refuse('the recipe is not an object');
    onlyKeys(value, ['v', 'w', 'h', 'box', 'density', 'members'], 'the recipe');
    if (typeof value.v !== 'number' || !RECIPE_VERSIONS.includes(value.v))
      refuse('the recipe format version is not one this page reads');
    const w = integer(value.w, 'w', 1, RECIPE_MAX_SIDE);
    const h = integer(value.h, 'h', 1, RECIPE_MAX_SIDE);
    if (w * h > RECIPE_MAX_PIXELS) refuse('the picture is larger than one 3840x2160 frame');
    if (value.density !== RECIPE_DENSITY) refuse(`density is not ${RECIPE_DENSITY}`);
    const box = value.box;
    if (!isObject(box)) refuse('the recipe has no box');
    onlyKeys(box, ['x', 'y', 'w', 'h'], 'box');
    finite(box.x, 'box.x', -RECIPE_BOX_LIMIT, RECIPE_BOX_LIMIT);
    finite(box.y, 'box.y', -RECIPE_BOX_LIMIT, RECIPE_BOX_LIMIT);
    const bw = finite(box.w, 'box.w', Number.MIN_VALUE, RECIPE_BOX_LIMIT);
    const bh = finite(box.h, 'box.h', Number.MIN_VALUE, RECIPE_BOX_LIMIT);
    if (bw * RECIPE_DENSITY !== w || bh * RECIPE_DENSITY !== h)
      refuse('box size times density is not w and h');
    const members = value.members;
    if (!Array.isArray(members) || members.length < 1) refuse('the recipe has no members');
    if (members.length > RECIPE_MAX_MEMBERS) refuse(`the recipe has more than ${RECIPE_MAX_MEMBERS} members`);
    let points = 0;
    let texts = 0;
    for (let i = 0; i < members.length; i++) {
      const r = checkMember(members[i], i);
      points += r.cost;
      if (points > RECIPE_MAX_POINTS) refuse(`the recipe has more than ${RECIPE_MAX_POINTS} points`);
      if (r.text && ++texts > RECIPE_MAX_TEXT_MEMBERS)
        refuse(`the recipe has more than ${RECIPE_MAX_TEXT_MEMBERS} text members`);
    }
    return { ok: true, recipe: value as unknown as RecipeWire, points, bytes };
  } catch (e) {
    const reason = e instanceof Refused ? e.message : 'the recipe could not be read';
    return { ok: false, reason: reason.slice(0, RECIPE_REASON_CHARS) };
  }
}
