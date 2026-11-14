import type { ShapeObject, Slide } from '@ordo/domain';
import { m9Decor } from '@ordo/domain/m9.test-util.ts';
import { clearDecorFiles, decorFileParts } from '@ordo/renderer/decor/files.ts';
import { RecPath } from '@ordo/renderer/geom/path2d.test-util.ts';
import { clearGeomFiles, geomFile } from '@ordo/renderer/geom/stored.ts';
import {
  registerShapeDrawer,
  registerShapeDrawerLoader,
  shapeDrawerRegistered,
} from '@ordo/renderer/shape.ts';
import { drawShape } from '@ordo/renderer/text2d.ts';
import { traceCtx } from '@ordo/renderer/trace.test-util.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  decorationFiles,
  geometryFiles,
  shapeDrawers,
  jobSlides,
  type PrepareHost,
  type PrepareStep,
  prepareSlides,
  prepareSteps,
  registerPrepareStep,
} from './index.ts';

/**
 * The slide prepare steps (design/27 M9 render-seams): one registry for the outputs' asset worker and the
 * operator's thumbnail worker; the shape drawers, the geometry files and the decoration files are its built-in
 * steps.
 */

beforeAll(() => vi.stubGlobal('Path2D', RecPath));
afterAll(() => vi.unstubAllGlobals());

const REF = 'a'.repeat(64);
const MISSING = 'b'.repeat(64);
const file = JSON.stringify({ paths: [{ d: 'M 0 0 L 10 0 L 10 10 Z', w: 10, h: 10 }] });
const slide = (refs: string[]): Slide =>
  ({
    id: 's',
    objects: refs.map((ref, i) => ({
      id: `g${i}`,
      type: 'shape',
      box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
      shape: 'rect',
      opacity: 1,
      radius: 0,
      geom: { ref },
    })),
  }) as Slide;

function host(files: Record<string, string>, log: string[] = []): PrepareHost {
  return {
    read: async (hash) => {
      log.push(`read ${hash.slice(0, 1)}`);
      return files[hash] === undefined ? undefined : new Blob([files[hash]!]);
    },
    slice: async (fn) => {
      log.push('slice');
      return fn();
    },
    check: () => log.push('check'),
  };
}

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  clearGeomFiles();
  clearDecorFiles();
});

describe('prepare steps (M9 render-seams)', () => {
  it('reads the geometry files the slides draw through its host, and reports those not there yet', async () => {
    expect(prepareSteps()).toEqual([shapeDrawers, geometryFiles, decorationFiles]);
    const log: string[] = [];
    const job = {
      slides: jobSlides({ slide: slide([REF]), nextSlide: slide([MISSING, 'pptxgeom:1']) }),
      scale: 1,
    };
    expect(job.slides).toHaveLength(2);
    expect(await prepareSlides(job, host({ [REF]: file }, log))).toEqual([MISSING]);
    // Parsed in a slice of the job; placeholders (not hub names) are never read. (The first check is the
    // shape drawers step's turn: no M9 kind to load; the last, the decoration files step's: none named.)
    expect(log).toEqual(['check', 'check', 'read a', 'read b', 'slice', 'check', 'check']);
    expect(geomFile(REF)).toBeDefined();
    expect(await prepareSlides({ slides: [slide([])], scale: 1 }, host({}))).toEqual([]);
  });

  it('runs registered steps after the built-in ones, in order, each missing hash once', async () => {
    const order: string[] = [];
    const step = (name: string, missing: string[]): PrepareStep => ({
      name,
      run: async (job, h) => {
        order.push(`${name} ${job.slides.length} ${job.scale}`);
        await h.slice(() => order.push(`${name} slice`));
        return missing;
      },
    });
    offs.push(registerPrepareStep(step('tables', ['x', 'y'])));
    offs.push(registerPrepareStep(step('vectors', ['y', 'z'])));
    expect(prepareSteps().map((s) => s.name)).toEqual([
      'shape drawers',
      'geometry files',
      'decoration files',
      'tables',
      'vectors',
    ]);
    const missing = await prepareSlides({ slides: [slide([])], scale: 2 }, host({}));
    expect(order).toEqual(['tables 1 2', 'tables slice', 'vectors 1 2', 'vectors slice']);
    expect(missing).toEqual(['x', 'y', 'z']);
    // A step of the same name replaces the registered one in its place; removal leaves the rest.
    const again = step('tables', []);
    const off = registerPrepareStep(again);
    expect(prepareSteps().map((s) => s.name)).toEqual([
      'shape drawers',
      'geometry files',
      'decoration files',
      'tables',
      'vectors',
    ]);
    expect(prepareSteps()[3]).toBe(again);
    off();
    expect(prepareSteps().map((s) => s.name)).toEqual([
      'shape drawers',
      'geometry files',
      'decoration files',
      'vectors',
    ]);
  });

  it('stops at a cancelled job (the host’s check throws) before the next step', async () => {
    let ran = false;
    offs.push(
      registerPrepareStep({
        name: 'late',
        run: async () => {
          ran = true;
          return undefined;
        },
      }),
    );
    let calls = 0;
    const cancelled: PrepareHost = {
      ...host({}),
      check: () => {
        if (++calls > 1) throw new Error('cancelled');
      },
    };
    await expect(prepareSlides({ slides: [slide([])], scale: 1 }, cancelled)).rejects.toThrow('cancelled');
    expect(ran).toBe(false);
  });
});

describe('the shape drawers step (M9 drawers loaded per object kind)', () => {
  const table = (id: string) => ({
    id,
    objects: [
      {
        id: 't',
        type: 'shape',
        box: { x: 0, y: 0, w: 100, h: 50, rotation: 0 },
        shape: 'rect',
        opacity: 1,
        radius: 0,
        table: { cols: [100], rows: [50], cells: [{ text: 'Hi' }], base: {} },
      },
    ],
  });

  it("loads a table's drawer before the draw, only for a look that draws the slide as authored", async () => {
    const loaded: string[] = [];
    let registered = false;
    offs.push(
      registerShapeDrawerLoader('chart', async () => {
        loaded.push('chart');
        offs.push(registerShapeDrawer('chart', () => true));
        registered = true;
      }),
    );
    const chart = {
      id: 'c',
      objects: [{ ...table('x').objects[0]!, table: undefined, chart: { kind: 'bar' } }],
    } as unknown as Slide;
    // A lyric-only look draws no chart: nothing is loaded.
    const lyricOnly = { layers: { slide: { mode: 'lyricOnly' } } } as never;
    await shapeDrawers.run({ slides: [chart], scale: 1, look: lyricOnly }, host({}));
    expect(loaded).toEqual([]);
    await shapeDrawers.run({ slides: [table('a') as unknown as Slide, chart], scale: 1 }, host({}));
    expect(loaded).toEqual(['chart']);
    expect(registered).toBe(true);
    expect(shapeDrawerRegistered('table')).toBe(true);
    // Loaded once: a later slide with the same kinds loads nothing.
    await shapeDrawers.run({ slides: [chart], scale: 1 }, host({}));
    expect(loaded).toEqual(['chart']);
  });
});

describe('the decoration files step (M9 decorations)', () => {
  const DECOR = 'd'.repeat(64);
  const decorated: Slide = {
    id: 'decorated',
    objects: [
      {
        id: 'decor',
        type: 'shape',
        box: { x: 0, y: 0, w: 1920, h: 48, rotation: 0 },
        shape: 'line',
        opacity: 1,
        radius: 0,
        decor: { ...m9Decor(), parts: [], ref: DECOR },
        locked: true,
      } as ShapeObject,
    ],
  };
  const fills = (s: Slide) => {
    const ctx = traceCtx(960, 540);
    for (const o of s.objects) if (o.type === 'shape') drawShape(ctx, o, 0.5);
    return ctx.trace.filter((e) => e[0] === 'call' && e[1] === 'fill').length;
  };

  it('reports a decoration file not there yet, then reads it and the slide draws its parts', async () => {
    const job = { slides: [decorated], scale: 0.5 };
    const log: string[] = [];
    // The drawer's own module is loaded by the shape drawers step; the file is not there yet: reported
    // missing (the link draws the slide again once it is cached), and the decoration draws nothing meanwhile.
    expect(await prepareSlides(job, host({}, log))).toEqual([DECOR]);
    expect(shapeDrawerRegistered('decor')).toBe(true);
    expect(log).toContain('read d');
    expect(decorFileParts(DECOR)).toBeUndefined();
    expect(fills(decorated)).toBe(0);
    // Once cached it is read, parsed in a turn of the job, and the slide draws its 40 filled parts. (Read
    // again at once: a file reported missing is asked for again only after the retry time, so a fresh store.)
    clearDecorFiles();
    const file = JSON.stringify({ parts: m9Decor().parts });
    const again: string[] = [];
    expect(await decorationFiles.run(job, host({ [DECOR]: file }, again))).toEqual([]);
    expect(again).toEqual(['read d', 'slice', 'check']);
    expect(decorFileParts(DECOR)).toHaveLength(m9Decor().parts.length);
    expect(fills(decorated)).toBe(40);
    // A placeholder (not a hub name) is never read; a file that is not a decoration is not kept.
    const placeholder = {
      ...decorated,
      objects: [{ ...decorated.objects[0]!, decor: { ...m9Decor(), parts: [], ref: 'pptxdecor:1' } }],
    } as Slide;
    const none: string[] = [];
    expect(await decorationFiles.run({ slides: [placeholder], scale: 1 }, host({}, none))).toBeUndefined();
    expect(none).toEqual([]);
    clearDecorFiles();
    expect(await decorationFiles.run(job, host({ [DECOR]: '{"paths":[]}' }))).toEqual([]);
    expect(decorFileParts(DECOR)).toBeUndefined();
  });
});
