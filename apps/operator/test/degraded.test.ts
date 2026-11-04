import { describe, expect, it } from 'vitest';
import type { Cue, ResolvedPlaylist } from '@ordo/domain';
import { degradedKey, summarizeDegraded } from '../src/lib/degraded.ts';

const cues = [
  { index: 0, itemId: 'i', itemIndex: 0, kind: 'slide', label: 'Amazing grace', sectionLabel: 'Verse 1' },
  { index: 1, itemId: 'i', itemIndex: 0, kind: 'slide', label: 'How sweet' },
] as Cue[];
const resolved = (degraded?: ResolvedPlaylist['degraded']) =>
  ({ manifestId: 'm1', degraded }) as ResolvedPlaylist;

describe('degraded summary', () => {
  it('is empty when nothing was quarantined', () => {
    expect(summarizeDegraded(resolved(), cues)).toEqual({ service: [], cues: [] });
    expect(degradedKey(resolved())).toBe('');
    expect(degradedKey(undefined)).toBe('');
  });

  it('separates service warnings from slides, collapses duplicates, labels cues', () => {
    const r = resolved([
      { cueIndex: 1, reason: 'bad box' },
      { cueIndex: -1, reason: 'cached copy from 09:12 UTC' },
      { cueIndex: -1, reason: 'cached copy from 09:12 UTC' },
      { cueIndex: 0, reason: 'bad text' },
      { cueIndex: 9, reason: 'unknown cue' },
    ]);
    const s = summarizeDegraded(r, cues);
    expect(s.service).toEqual(['cached copy from 09:12 UTC']);
    expect(s.cues.map((c) => c.label)).toEqual(['Verse 1: Amazing grace', 'How sweet', 'cue 10']);
    expect(degradedKey(r)).toBe('m1:5');
  });

  it('caps the cue list for display', () => {
    const r = resolved(Array.from({ length: 50 }, (_, i) => ({ cueIndex: i, reason: 'x' })));
    expect(summarizeDegraded(r, [], 20).cues).toHaveLength(20);
  });
});
