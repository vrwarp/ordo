import { describe, expect, it } from 'vitest';
import { COMPACT_FORBIDDEN, forbiddenEntry } from '../src/pageSets.ts';

/*
 * What a phone must never download (apps/operator/src/pageSets.ts, design/28 §3.1): the compact list names the
 * renderer's geometry tables, so a later import of one by a phone-reachable module fails the bundle check
 * (tools/bundle-report.mjs, run by CI) instead of growing the compact first load.
 */

const PRESETS = 'packages/renderer/src/geom/presets.gen.ts';
const WARPS = 'packages/renderer/src/geom/textwarps.gen.ts';

describe('the compact path’s forbidden list', () => {
  it('names the 187-preset table, as a path and as a source map lists it', () => {
    expect(forbiddenEntry(PRESETS)).toBe(PRESETS);
    expect(forbiddenEntry(`../../${PRESETS}`)).toBe(PRESETS);
  });

  it('names the 40-warp table, as a path and as a source map lists it (a leading ../ is dropped)', () => {
    expect(COMPACT_FORBIDDEN).toContain(WARPS);
    expect(forbiddenEntry(WARPS)).toBe(WARPS);
    expect(forbiddenEntry(`../../${WARPS}`)).toBe(WARPS);
    expect(forbiddenEntry(`./${WARPS}`)).toBe(WARPS);
  });

  it('forbids whole paths only: a path that merely contains the name is not forbidden', () => {
    expect(forbiddenEntry(`${WARPS}x.map`)).toBeUndefined();
    expect(forbiddenEntry('packages/renderer/src/geom/textwarps.gen.tsx.map')).toBeUndefined();
    expect(forbiddenEntry('other/textwarps.gen.ts')).toBeUndefined();
    expect(forbiddenEntry('packages/renderer/src/geom/textwarp.ts')).toBeUndefined();
  });
});
