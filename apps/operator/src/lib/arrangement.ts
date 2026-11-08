import { type Arrangement, newId, type Presentation } from '@ordo/domain';

/** Pure arrangement editing operations. Every function returns a new arrangement. */

export function authoringArrangement(p: Presentation): Arrangement {
  return { id: newId(), name: 'Default', sectionIds: p.sections.map((s) => s.id) };
}

export function insertSection(a: Arrangement, sectionId: string, at = a.sectionIds.length): Arrangement {
  const ids = [...a.sectionIds];
  ids.splice(Math.max(0, Math.min(at, ids.length)), 0, sectionId);
  return { ...a, sectionIds: ids };
}

export function removeAt(a: Arrangement, index: number): Arrangement {
  if (index < 0 || index >= a.sectionIds.length) return a;
  const ids = [...a.sectionIds];
  ids.splice(index, 1);
  return { ...a, sectionIds: ids };
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, x!);
  return out;
}

export function moveAt(a: Arrangement, from: number, to: number): Arrangement {
  return { ...a, sectionIds: moveItem(a.sectionIds, from, to) };
}

export function duplicateAt(a: Arrangement, index: number): Arrangement {
  const id = a.sectionIds[index];
  return id === undefined ? a : insertSection(a, id, index + 1);
}

/** Drop references to sections that no longer exist. */
export function pruneArrangement(a: Arrangement, p: Pick<Presentation, 'sections'>): Arrangement {
  const ids = new Set(p.sections.map((s) => s.id));
  const sectionIds = a.sectionIds.filter((id) => ids.has(id));
  return sectionIds.length === a.sectionIds.length ? a : { ...a, sectionIds };
}

/** Short labels in arrangement order, e.g. "V1 C V2 C B C". */
export function arrangementLabel(a: Arrangement, p: Pick<Presentation, 'sections'>): string {
  const byId = new Map(p.sections.map((s) => [s.id, s]));
  return a.sectionIds
    .map((id) => byId.get(id)?.short || byId.get(id)?.label || '?')
    .filter(Boolean)
    .join(' ');
}

/**
 * Parse "V1 C V2 C B C C" back into section ids, matching short forms then labels case-insensitively.
 * Unknown tokens are reported.
 */
export function parseArrangement(
  text: string,
  p: Pick<Presentation, 'sections'>,
): { sectionIds: string[]; unknown: string[] } {
  const sectionIds: string[] = [];
  const unknown: string[] = [];
  for (const tok of text.split(/[\s,]+/).filter(Boolean)) {
    const t = tok.toLowerCase();
    const s =
      p.sections.find((x) => x.short.toLowerCase() === t) ??
      p.sections.find((x) => x.label.toLowerCase().replace(/\s+/g, '') === t);
    if (s) sectionIds.push(s.id);
    else unknown.push(tok);
  }
  return { sectionIds, unknown };
}

/** Add or replace an arrangement on a presentation. */
export function upsertArrangement(p: Presentation, a: Arrangement): Presentation {
  const i = p.arrangements.findIndex((x) => x.id === a.id);
  const arrangements = [...p.arrangements];
  if (i >= 0) arrangements[i] = a;
  else arrangements.push(a);
  return { ...p, arrangements };
}
