import type { Cue } from '@ordo/domain';

/** Cues of one playlist item grouped by arrangement position (a section), in cue order. */
export type CueGroup = { pos: number; label: string; short: string; cues: Cue[] };

export function groupCues(cues: Cue[]): CueGroup[] {
  const out: CueGroup[] = [];
  for (const c of cues) {
    const pos = c.arrangementPos ?? -1;
    let g = out.find((x) => x.pos === pos);
    if (!g) {
      g = { pos, label: c.sectionLabel ?? c.label, short: c.sectionShort ?? '', cues: [] };
      out.push(g);
    }
    g.cues.push(c);
  }
  return out;
}

/**
 * The cue a section click goes to: the first cue of that section in the item on screen. The grid sends
 * `go(cueIndex)` with it, never `goToSection(i)`, because the reducer resolves section indices against
 * the live item and the item shown may be another one (review item 4).
 */
export function sectionGoTarget(group: CueGroup): number | undefined {
  return group.cues[0]?.index;
}
