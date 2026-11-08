import { PRO7_MEDIA_PREFIX } from './pro7.ts';

/**
 * The placeholder prefix of the native PowerPoint import (`@ordo/pptx-scene` `MEDIA_PREFIX`; design/27 §1
 * `emit.ts`): `pptxmedia:<n>`, mapped to stored media by the hub's `pptx-native` job.
 */
export const PPTX_MEDIA_PREFIX = 'pptxmedia:';

/** Fields that hold media ids anywhere in presentations, slides, objects and playlist items. */
const MEDIA_FIELDS = new Set([
  'mediaId',
  'backgroundMediaId',
  'imageMediaId',
  'holdingMediaId',
  'logoMediaId',
]);

function isPlaceholder(v: unknown): v is string {
  return typeof v === 'string' && (v.startsWith(PRO7_MEDIA_PREFIX) || v.startsWith(PPTX_MEDIA_PREFIX));
}

function walk(value: unknown, map: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) {
      // An image object or media playlist item whose media was never uploaded cannot be shown: drop it.
      if (
        v &&
        typeof v === 'object' &&
        isPlaceholder((v as Record<string, unknown>).mediaId) &&
        !map.has((v as Record<string, string>).mediaId!)
      ) {
        continue;
      }
      out.push(walk(v, map));
    }
    return out;
  }
  if (value && typeof value === 'object') {
    if (value instanceof Uint8Array || value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isPlaceholder(v)) {
        const id = map.get(v);
        if (id !== undefined) out[k] = id;
        else if (!MEDIA_FIELDS.has(k)) out[k] = v;
        // unmapped placeholder in a media field: the property is removed
        continue;
      }
      out[k] = walk(v, map);
    }
    return out;
  }
  if (isPlaceholder(value)) return map.get(value) ?? value;
  return value;
}

/**
 * Deep-copy `obj`, replacing placeholder media ids (`pro7media:<path>`, `pptxmedia:<n>`) with real media ids
 * from `map`.
 * Placeholders missing from the map are removed: optional fields (`backgroundMediaId`) are dropped and
 * image objects or media playlist items that need them are removed from their arrays.
 */
export function remapMediaIds<T>(obj: T, map: Map<string, string>): T {
  return walk(obj, map) as T;
}
