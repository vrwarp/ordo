import { describe, expect, it } from 'vitest';
import { MISSING_KINDS, missingEntry, missingKind, missingKinds, missingLabel } from './missing.ts';

/** `Slide.pptx.missing` entries (design/27 M9): closed kinds, growable subtypes. */
describe('missing elements', () => {
  it('reads the kind of an entry; an unknown or malformed one is an element', () => {
    expect(missingKind('chart:surface')).toBe('chart');
    expect(missingKind('ole')).toBe('ole');
    for (const bad of ['hologram', 'hologram:chart', '', ':chart', 'Chart', 7, null, '__proto__'])
      expect(missingKind(bad)).toBe('element');
  });

  it('writes an entry with a cleaned subtype within 40 characters', () => {
    expect(missingEntry('chart', 'surface')).toBe('chart:surface');
    expect(missingEntry('smartart')).toBe('smartart');
    expect(missingEntry('chart', 'of<script>Pie')).toBe('chart:ofscriptPie');
    expect(missingEntry('metafile', 'x'.repeat(100))).toHaveLength(40);
    expect(missingEntry('ole', '')).toBe('ole');
  });

  it('lists the distinct kinds of a stored list, and labels each', () => {
    expect(missingKinds(['chart:surface', 'chart:radar', 'ole', 'nope'])).toEqual([
      'chart',
      'ole',
      'element',
    ]);
    expect(missingKinds('ole')).toEqual([]);
    expect(missingKinds(Array(100).fill('ole'))).toEqual(['ole']);
    for (const k of MISSING_KINDS) expect(missingLabel(k)).toMatch(/^[a-z]/);
  });
});
