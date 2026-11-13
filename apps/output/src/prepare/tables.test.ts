import { DEFAULT_LYRIC_STYLE, LOOK_MAIN, type Look, type Slide, type TableCell } from '@ordo/domain';
import { LEGACY_FONT_ENV, clampSlide, clearTableCache, layoutTable } from '@ordo/renderer';
import { testMeasurer } from '@ordo/renderer/text/test-util.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { type PrepareHost, prepareSteps } from './index.ts';
import { TABLE_SLICE_MS, setTableMeasurer, tableLayouts } from './tables.ts';

/*
 * The table prepare step (design/27 M9 tables): a slide's tables laid out in slices of the job's turns before
 * the synchronous draw, which then lays out nothing.
 */

afterEach(() => {
  setTableMeasurer(undefined);
  clearTableCache();
});

function tableSlide(cells: number, text: (i: number) => string): Slide {
  const C = 8;
  const R = Math.ceil(cells / C);
  const list: TableCell[] = [...Array(R * C)].map((_, i) => ({ text: text(i) }));
  return {
    id: 's',
    objects: [
      {
        id: 't',
        type: 'shape',
        box: { x: 0, y: 0, w: 1600, h: R * 40, rotation: 0 },
        shape: 'rect',
        opacity: 1,
        radius: 0,
        table: {
          cols: Array(C).fill(200),
          rows: Array(R).fill(40),
          cells: list,
          base: { ...DEFAULT_LYRIC_STYLE, fontSizePx: 20, lineModel: 'office' },
        },
      },
    ],
  } as Slide;
}

/** A host that runs slices at once and counts them. */
function host(log: { slices: number; checks: number }): PrepareHost {
  return {
    read: async () => undefined,
    slice: async (fn) => {
      log.slices++;
      return fn();
    },
    check: () => {
      log.checks++;
    },
  };
}

/** A measurer that spends about `ms` on each string it measures (as a slow machine would). */
function slowMeasurer(ms: number) {
  const m = testMeasurer();
  return {
    m,
    slow: {
      width: (...a: Parameters<typeof m.width>) => {
        const t = performance.now();
        while (performance.now() - t < ms) {
          /* spend the time */
        }
        return m.width(...a);
      },
    },
  };
}

describe('the table prepare step (M9)', () => {
  it('is registered after the geometry files', () => {
    expect(prepareSteps().map((s) => s.name)).toEqual(['geometry files', 'table layouts']);
  });

  it(`lays a large table out in slices of about ${TABLE_SLICE_MS} ms, and the draw then lays out nothing`, async () => {
    const { m, slow } = slowMeasurer(0.25);
    setTableMeasurer(slow);
    const slide = tableSlide(160, (i) => `cell ${i} of the bulletin`);
    const log = { slices: 0, checks: 0 };
    const t0 = performance.now();
    expect(await tableLayouts.run({ slides: [slide], scale: 1 }, host(log))).toBeUndefined();
    const ms = performance.now() - t0;
    // Hundreds of strings at 0.25 ms each: several slices, each about the slice's length.
    expect(log.slices).toBeGreaterThan(3);
    expect(ms / log.slices).toBeLessThan(TABLE_SLICE_MS * 3);
    expect(log.checks).toBe(log.slices);
    const calls = m.calls;
    const o = clampSlide(slide).objects[0]!;
    expect(layoutTable(slow, o as never, LEGACY_FONT_ENV)).toBeDefined();
    expect(m.calls).toBe(calls);
  });

  it('does nothing for slides without tables or a look that does not draw them', async () => {
    setTableMeasurer(testMeasurer());
    const log = { slices: 0, checks: 0 };
    await tableLayouts.run({ slides: [{ id: 'e', objects: [] } as Slide], scale: 1 }, host(log));
    const lyricOnly: Look = {
      ...LOOK_MAIN,
      layers: { ...LOOK_MAIN.layers, slide: { mode: 'hidden' } },
    } as Look;
    await tableLayouts.run({ slides: [tableSlide(8, () => 'x')], scale: 1, look: lyricOnly }, host(log));
    expect(log).toEqual({ slices: 0, checks: 0 });
  });

  it('stops at a cancelled job', async () => {
    setTableMeasurer(testMeasurer());
    const cancelled: PrepareHost = {
      ...host({ slices: 0, checks: 0 }),
      check: () => {
        throw new Error('cancelled');
      },
    };
    await expect(
      tableLayouts.run({ slides: [tableSlide(8, () => 'x')], scale: 1 }, cancelled),
    ).rejects.toThrow('cancelled');
  });
});
