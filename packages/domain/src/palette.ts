/*
 * Palettes of stored objects (design/27 M9): a table's cell styles, run styles, fills and line styles, a
 * chart's fills, lines and texts, a decoration's paints. Equal values share one entry, found by their
 * canonical JSON through a `Map` (no deck string ever becomes an object key), and an index read back from a
 * stored object is used only when it names an entry (`paletteIndex`).
 */

/** Nesting deeper than this is written as null: palette values are flat records, never deep. */
const MAX_DEPTH = 16;

/**
 * JSON with object keys sorted, so two equal values give one string whatever order their keys were set in.
 * Members that JSON leaves out (undefined, functions, symbols) are left out; numbers that are not finite are
 * null, as in JSON; nesting past 16 levels is null. Never throws.
 */
export function canonicalJson(v: unknown): string {
  return canon(v, 0);
}

function canon(v: unknown, depth: number): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'number':
      return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'object':
      break;
    default:
      return 'null';
  }
  if (depth >= MAX_DEPTH) return 'null';
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const x of v) {
      const t = typeof x;
      parts.push(x === undefined || t === 'function' || t === 'symbol' ? 'null' : canon(x, depth + 1));
    }
    return `[${parts.join(',')}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const x = o[k];
    const t = typeof x;
    if (x === undefined || t === 'function' || t === 'symbol') continue;
    parts.push(`${JSON.stringify(k)}:${canon(x, depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * A palette being built: `add` gives the index of a value equal to one added before, else appends it, up to
 * `max` entries. Past `max` a new value gets no index (undefined), and the caller decides (the base style,
 * no fill, the nearest entry it kept).
 */
export class Palette<T> {
  readonly entries: T[] = [];
  readonly #index = new Map<string, number>();
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  /** The index of `v`'s entry, added when new and the palette is not full; undefined when it is full. */
  add(v: T): number | undefined {
    const key = canonicalJson(v);
    const hit = this.#index.get(key);
    if (hit !== undefined) return hit;
    if (this.entries.length >= this.max) return undefined;
    const i = this.entries.length;
    this.entries.push(v);
    this.#index.set(key, i);
    return i;
  }

  /** The index of a value equal to `v` already in the palette, else undefined (nothing is added). */
  indexOf(v: T): number | undefined {
    return this.#index.get(canonicalJson(v));
  }

  get size(): number {
    return this.entries.length;
  }
}

/**
 * A stored palette index made safe to use: an integer within `0 .. length − 1`, else undefined (the reader
 * falls back as if none were stored: the base style, no fill, no line). `length` is the palette's actual
 * length, not the schema's bound.
 */
export function paletteIndex(i: unknown, length: number): number | undefined {
  return typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < length ? i : undefined;
}
