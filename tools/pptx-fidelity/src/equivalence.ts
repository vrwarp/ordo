/**
 * Hub-vs-client equivalence (the regroup's import core, design/27 §2 "Where the deck is parsed"): one deck
 * imported twice through a real hub, once with the scene the browser's parse makes (`--client-scene`,
 * `parsePptxScene` in Node, as the operator's import worker runs it) and once parsed by the hub itself, must
 * store the same presentation modulo ids and times. `comparable` takes out what two imports of one deck may
 * differ in by design (ids, renamed consistently in order of appearance; media ids, by the file they name;
 * times, revision, `source.log`, whose lines say where the deck was parsed, and the slides' digests over their
 * objects' ids); `diffJson` lists every other
 * difference by its path.
 */

/** Keys whose string values are ids (renamed `#n` in order of first appearance). */
const ID_KEYS = new Set(['id', 'lyricObjectId', 'before', 'slideId', 'objectId', 'presentationId']);
/** Keys whose string values are media ids (replaced by the file they name). */
const MEDIA_KEYS = new Set(['mediaId', 'backgroundMediaId', 'imageMediaId', 'refMediaId', 'posterMediaId']);
/**
 * Keys left out: times, the revision, the import log, and a slide's import digest (`Slide.pptx.digest`, a
 * hash over its objects with their ids, so two imports never share it).
 */
const SKIP_KEYS = new Set(['createdAt', 'updatedAt', 'rev', 'log', 'digest']);

/** A presentation without what two imports of one deck may differ in (see the module comment). */
export function comparable(p: unknown, fileOf: (mediaId: string) => string | undefined): unknown {
  const ids = new Map<string, string>();
  const walk = (v: unknown, key: string | undefined, depth: number): unknown => {
    if (depth > 64) return '…';
    if (Array.isArray(v)) {
      // Id lists (`sectionIds`, `replaces`) are ids too.
      if (key && /Ids$|^replaces$/.test(key)) return v.map((x) => (typeof x === 'string' ? rename(x) : x));
      return v.map((x) => walk(x, key, depth + 1));
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        if (SKIP_KEYS.has(k)) continue;
        out[k] = walk((v as Record<string, unknown>)[k], k, depth + 1);
      }
      return out;
    }
    if (typeof v !== 'string' || key === undefined) return v;
    if (MEDIA_KEYS.has(key)) return `file:${fileOf(v) ?? `?${v.slice(0, 8)}`}`;
    if (ID_KEYS.has(key)) return rename(v);
    return v;
  };
  const rename = (v: string) => {
    if (!ids.has(v)) ids.set(v, `#${ids.size}`);
    return ids.get(v)!;
  };
  return walk(p, undefined, 0);
}

/** One difference: its path and both values (each cut to 200 characters as JSON). */
export type Difference = { path: string; hub: string; client: string };

const show = (v: unknown) => {
  const s = v === undefined ? 'undefined' : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
};

/** Every difference between `a` (the hub's) and `b` (the client's), at most `max`, by path. */
export function diffJson(a: unknown, b: unknown, max = 200): Difference[] {
  const out: Difference[] = [];
  const go = (x: unknown, y: unknown, path: string) => {
    if (out.length >= max) return;
    if (Object.is(x, y)) return;
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length)
        out.push({ path: `${path}.length`, hub: show(x.length), client: show(y.length) });
      for (let i = 0; i < Math.min(x.length, y.length); i++) go(x[i], y[i], `${path}[${i}]`);
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of [...keys].sort())
        go((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`);
      return;
    }
    if (typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x)))
      return;
    out.push({ path, hub: show(x), client: show(y) });
  };
  go(a, b, '$');
  return out;
}
