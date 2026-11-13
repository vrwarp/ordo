import { m9Chart, m9Decor, m9Table } from '@ordo/domain/m9.test-util.ts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadShapeDrawers,
  registerShapeDrawer,
  registerShapeDrawerLoader,
  shapeDrawerRegistered,
  shapeDrawersWanted,
} from './shape.ts';

/*
 * M9 drawers loaded per object kind (the operator's bundle budget): a kind's module is imported the first time
 * a slide holds that kind, once, and a failed import is tried again later; the renderer's index registers the
 * table's loader, so importing the renderer does not load the table drawer.
 */

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

const shape = (extra: Record<string, unknown>) => ({
  id: 's',
  type: 'shape',
  box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 },
  shape: 'rect',
  opacity: 1,
  radius: 0,
  ...extra,
});

describe('loading drawers per object kind', () => {
  it('wants only the kinds a slide holds whose drawer is not registered but can be loaded', () => {
    offs.push(registerShapeDrawerLoader('chart', async () => {}));
    offs.push(registerShapeDrawerLoader('decor', async () => {}));
    const objects = [shape({ chart: m9Chart() }), shape({ decor: m9Decor() }), shape({ chart: m9Chart() })];
    expect(shapeDrawersWanted(objects)).toEqual(['chart', 'decor']);
    offs.push(registerShapeDrawer('decor', () => true));
    expect(shapeDrawersWanted(objects)).toEqual(['chart']);
    // Text, pictures, plain shapes and damaged entries want nothing.
    expect(shapeDrawersWanted([{ type: 'text', chart: 1 }, null, 7, shape({})])).toEqual([]);
  });

  it('imports a kind once, registers it, and tells the caller to draw again', async () => {
    let imports = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    offs.push(
      registerShapeDrawerLoader('chart', async () => {
        imports++;
        await gate;
        offs.push(registerShapeDrawer('chart', () => true));
      }),
    );
    const objects = [shape({ chart: m9Chart() })];
    const a = loadShapeDrawers(objects);
    const b = loadShapeDrawers(objects);
    release();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(imports).toBe(1);
    expect(shapeDrawerRegistered('chart')).toBe(true);
    // Nothing left to load.
    expect(await loadShapeDrawers(objects)).toBe(false);
    expect(imports).toBe(1);
  });

  it('tries a failed import again next time; the shapes keep their legacy look meanwhile', async () => {
    let tries = 0;
    offs.push(
      registerShapeDrawerLoader('decor', async () => {
        tries++;
        if (tries === 1) throw new Error('offline');
        offs.push(registerShapeDrawer('decor', () => true));
      }),
    );
    const objects = [shape({ decor: m9Decor() })];
    expect(await loadShapeDrawers(objects)).toBe(false);
    expect(shapeDrawerRegistered('decor')).toBe(false);
    expect(await loadShapeDrawers(objects)).toBe(true);
    expect(tries).toBe(2);
  });

  it("registers the table's loader with the renderer, and the table module registers the drawer", async () => {
    await import('./index.ts');
    const objects = [shape({ table: m9Table() })];
    if (!shapeDrawerRegistered('table')) {
      expect(shapeDrawersWanted(objects)).toEqual(['table']);
      expect(await loadShapeDrawers(objects)).toBe(true);
    }
    expect(shapeDrawerRegistered('table')).toBe(true);
    expect(shapeDrawersWanted(objects)).toEqual([]);
  });
});
