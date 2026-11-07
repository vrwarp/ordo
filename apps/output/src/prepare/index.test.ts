import type { Slide } from '@ordo/domain';
import { clearGeomFiles, geomFile } from '@ordo/renderer/geom/stored.ts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  geometryFiles,
  jobSlides,
  type PrepareHost,
  type PrepareStep,
  prepareSlides,
  prepareSteps,
  registerPrepareStep,
} from './index.ts';

/**
 * The slide prepare steps (design/27 M9 render-seams): one registry for the outputs' asset worker and the
 * operator's thumbnail worker; the geometry files are its built-in step.
 */

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
});

describe('prepare steps (M9 render-seams)', () => {
  it('reads the geometry files the slides draw through its host, and reports those not there yet', async () => {
    expect(prepareSteps()).toEqual([geometryFiles]);
    const log: string[] = [];
    const job = {
      slides: jobSlides({ slide: slide([REF]), nextSlide: slide([MISSING, 'pptxgeom:1']) }),
      scale: 1,
    };
    expect(job.slides).toHaveLength(2);
    expect(await prepareSlides(job, host({ [REF]: file }, log))).toEqual([MISSING]);
    // Parsed in a slice of the job; placeholders (not hub names) are never read.
    expect(log).toEqual(['check', 'read a', 'read b', 'slice', 'check']);
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
    expect(prepareSteps().map((s) => s.name)).toEqual(['geometry files', 'tables', 'vectors']);
    const missing = await prepareSlides({ slides: [slide([])], scale: 2 }, host({}));
    expect(order).toEqual(['tables 1 2', 'tables slice', 'vectors 1 2', 'vectors slice']);
    expect(missing).toEqual(['x', 'y', 'z']);
    // A step of the same name replaces the registered one in its place; removal leaves the rest.
    const again = step('tables', []);
    const off = registerPrepareStep(again);
    expect(prepareSteps().map((s) => s.name)).toEqual(['geometry files', 'tables', 'vectors']);
    expect(prepareSteps()[1]).toBe(again);
    off();
    expect(prepareSteps().map((s) => s.name)).toEqual(['geometry files', 'vectors']);
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
