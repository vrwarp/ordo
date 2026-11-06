import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRESET_GEOMS } from '../../../../packages/renderer/src/geom/presets.gen.ts';
import { EXCEPTIONS } from './exceptions.ts';
import {
  baselineOf,
  type GreyPicture,
  INK_BELOW,
  inkBounds,
  MAX_DROP,
  MIN_SSIM,
  type PresetBaseline,
  REGION_MARGIN,
  scoreRegion,
  union,
  verdict,
} from './score.ts';

function picture(w: number, h: number, ink: [number, number][]): GreyPicture {
  const px = new Uint8Array(w * h).fill(255);
  for (const [x, y] of ink) px[y * w + x] = 0;
  return { w, h, px };
}

describe('scored region', () => {
  const cell = { x: 10, y: 10, w: 50, h: 40 };

  it('bounds the drawn pixels of a cell only', () => {
    const pic = picture(100, 100, [
      [12, 20],
      [40, 45],
      [70, 70], // outside the cell
    ]);
    expect(inkBounds(pic, cell)).toEqual({ x: 12, y: 20, w: 29, h: 26 });
    expect(inkBounds(picture(100, 100, [[70, 70]]), cell)).toBeUndefined();
    // Near-white anti-aliasing is background.
    const faint = picture(100, 100, []);
    faint.px[20 * 100 + 20] = INK_BELOW;
    expect(inkBounds(faint, cell)).toBeUndefined();
  });

  it('is the box and both drawings, grown by the margin, inside the cell', () => {
    const box = { x: 30, y: 25, w: 10, h: 10 };
    const ref = picture(100, 100, [[20, 28]]);
    const cand = picture(100, 100, [[35, 47]]);
    expect(scoreRegion(cell, box, ref, cand)).toEqual({
      x: 20 - REGION_MARGIN,
      y: 25 - REGION_MARGIN,
      w: 40 - 20 + 2 * REGION_MARGIN,
      h: 50 - (25 - REGION_MARGIN), // down to the cell's bottom (cand reaches 47, + margin > 50)
    });
    const empty = picture(100, 100, []);
    expect(scoreRegion(cell, box, empty, empty)).toEqual({
      x: 30 - REGION_MARGIN,
      y: 25 - REGION_MARGIN,
      w: 10 + 2 * REGION_MARGIN,
      h: 10 + 2 * REGION_MARGIN,
    });
    expect(union([undefined])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('verdict', () => {
  const base: PresetBaseline = {
    minSsim: MIN_SSIM,
    maxDrop: MAX_DROP,
    presets: { a: 0.99, b: 0.9, c: 0.97 },
  };

  it('passes a run at the baseline with its listed exceptions', () => {
    const v = verdict(
      new Map([
        ['a', 0.99],
        ['b', 0.9],
        ['c', 0.965],
      ]),
      base,
      { b: 'why' },
    );
    expect(v).toEqual({ failures: [], notes: [] });
  });

  it('fails an unlisted preset under the bar, a drop, a preset not scored and a stale listing', () => {
    const v = verdict(
      new Map([
        ['a', 0.97],
        ['b', 0.9],
        ['x', 0.5],
      ]),
      base,
      { b: 'why', gone: 'why' },
    );
    expect(v.failures).toEqual([
      expect.stringMatching(/^a: SSIM 0\.9700 dropped from 0\.9900/),
      expect.stringMatching(/^x: SSIM 0\.5000 is under 0\.95 and not listed/),
      'c: in the baseline but not scored',
      'gone: listed in exceptions.ts but not a scored preset',
    ]);
    expect(v.notes).toEqual(['x: not in the baseline yet (0.5000)']);
  });

  it('notes a listed preset that now passes, and counts NaN as under the bar', () => {
    const v = verdict(
      new Map([
        ['b', 0.96],
        ['n', Number.NaN],
      ]),
      undefined,
      { b: 'why' },
    );
    expect(v.notes).toEqual([expect.stringMatching(/^b: SSIM 0\.9600 now passes/)]);
    expect(v.failures).toEqual([expect.stringMatching(/^n: SSIM NaN is under/)]);
  });

  it('records a baseline by name, at 4 decimals', () => {
    expect(
      baselineOf(
        new Map([
          ['z', 0.123456],
          ['a', 0.99995],
        ]),
      ),
    ).toEqual({ minSsim: MIN_SSIM, maxDrop: MAX_DROP, presets: { a: 1, z: 0.1235 } });
  });
});

describe('committed baseline and exceptions', () => {
  const baseline = JSON.parse(
    readFileSync(new URL('./baseline.json', import.meta.url), 'utf8'),
  ) as PresetBaseline & { libreoffice: string };

  it('scores every preset', () => {
    expect(Object.keys(baseline.presets).sort()).toEqual([...PRESET_GEOMS.keys()].sort());
    expect(baseline.libreoffice).toMatch(/^LibreOffice \d+\.\d+/);
    for (const s of Object.values(baseline.presets)) expect(s).toBeGreaterThan(0);
  });

  it('lists exactly the presets under the bar, each with its reason', () => {
    const under = Object.entries(baseline.presets)
      .filter(([, s]) => s < MIN_SSIM)
      .map(([n]) => n)
      .sort();
    expect(Object.keys(EXCEPTIONS).sort()).toEqual(under);
    for (const reason of Object.values(EXCEPTIONS)) expect(reason.length).toBeGreaterThan(40);
    const scores = new Map(Object.entries(baseline.presets));
    expect(verdict(scores, baseline, EXCEPTIONS)).toEqual({ failures: [], notes: [] });
  });
});
