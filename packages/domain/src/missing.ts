/*
 * What a slide leaves out (design/27 M9, `Slide.pptx.missing`): PowerPoint elements that nothing draws,
 * neither ordo, the deck's own fallback picture nor LibreOffice (which a hub may not have). Stored as strings,
 * '<kind>' or '<kind>:<subtype>' ('chart:surface', 'ole', 'smartart'), so the list can grow without widening
 * a stored enum: a reader maps a kind it does not know to 'element', and an older build strips the field.
 */

/** The kinds of missing elements, the only first parts a writer uses. */
export const MISSING_KINDS = [
  'chart',
  'smartart',
  'ole',
  'metafile',
  'math',
  'ink',
  'decoration',
  'element',
  'slide',
] as const;
export type MissingKind = (typeof MISSING_KINDS)[number];

/** The stored bounds of `Slide.pptx.missing` (the schema's): entries per slide and characters per entry. */
export const MISSING_LIMITS = { entries: 16, chars: 40 } as const;

const KINDS: ReadonlySet<string> = new Set(MISSING_KINDS);

/** The kind of a stored entry ('chart:surface' → 'chart'); anything unknown or malformed is 'element'. */
export function missingKind(entry: unknown): MissingKind {
  if (typeof entry !== 'string') return 'element';
  const colon = entry.indexOf(':');
  const kind = colon < 0 ? entry : entry.slice(0, colon);
  return KINDS.has(kind) ? (kind as MissingKind) : 'element';
}

/**
 * The entry a writer stores for an element of `kind`: '<kind>', or '<kind>:<subtype>' with the subtype cut to
 * letters, digits, '-' and '_' and the whole within `MISSING_LIMITS.chars`. Deck strings (a chart type's
 * name) only ever reach the subtype through this.
 */
export function missingEntry(kind: MissingKind, subtype?: string): string {
  const sub = typeof subtype === 'string' ? subtype.replace(/[^A-Za-z0-9_-]/g, '') : '';
  const out = sub ? `${kind}:${sub}` : kind;
  return out.slice(0, MISSING_LIMITS.chars);
}

/** The distinct kinds of a stored list, in first-seen order (at most `MISSING_LIMITS.entries` read). */
export function missingKinds(list: unknown): MissingKind[] {
  if (!Array.isArray(list)) return [];
  const out: MissingKind[] = [];
  for (let i = 0; i < list.length && i < MISSING_LIMITS.entries; i++) {
    const k = missingKind(list[i]);
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

const LABELS: ReadonlyMap<MissingKind, string> = new Map<MissingKind, string>([
  ['chart', 'a chart'],
  ['smartart', 'a SmartArt graphic'],
  ['ole', 'an embedded object'],
  ['metafile', 'a vector picture'],
  ['math', 'an equation'],
  ['ink', 'ink'],
  ['decoration', 'decoration shapes'],
  ['element', 'an element'],
  ['slide', 'the slide itself'],
]);

/** What people read for a kind ('a chart', 'a SmartArt graphic'): the operator's notes and goLive's reason. */
export function missingLabel(kind: MissingKind): string {
  return LABELS.get(kind) ?? 'an element';
}
