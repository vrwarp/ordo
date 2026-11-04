import type { Cue, ResolvedPlaylist } from '@ordo/domain';

export type DegradedSummary = {
  /** Whole-service warnings (cueIndex -1): a cached copy, a skipped item, an unreadable presentation. */
  service: string[];
  /** Cues whose slide was replaced by an empty slide, with a label the operator recognises. */
  cues: { cueIndex: number; label: string; reason: string }[];
};

/**
 * What the hub quarantined at goLive (design/25), in the operator's words. Empty when nothing was degraded.
 * Duplicate service reasons are collapsed; cue entries are ordered by cue and capped for display.
 */
export function summarizeDegraded(
  resolved: ResolvedPlaylist | undefined,
  cues: Cue[],
  maxCues = 20,
): DegradedSummary {
  const list = resolved?.degraded ?? [];
  const service = [...new Set(list.filter((d) => d.cueIndex < 0).map((d) => d.reason))];
  const cueRows = list
    .filter((d) => d.cueIndex >= 0)
    .sort((a, b) => a.cueIndex - b.cueIndex)
    .slice(0, maxCues)
    .map((d) => {
      const c = cues[d.cueIndex];
      const where = c ? `${c.sectionLabel ? c.sectionLabel + ': ' : ''}${c.label}` : `cue ${d.cueIndex + 1}`;
      return { cueIndex: d.cueIndex, label: where, reason: d.reason };
    });
  return { service, cues: cueRows };
}

/** A key that changes with the service, so a dismissal applies only to the service it was made in. */
export function degradedKey(resolved: ResolvedPlaylist | undefined): string {
  if (!resolved?.degraded?.length) return '';
  return `${resolved.manifestId}:${resolved.degraded.length}`;
}
