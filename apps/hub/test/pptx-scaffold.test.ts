/**
 * M3 scaffold (apps/hub/src/pptx/README.md): the pptx jobs are registered on their classes and the pool
 * tasks reach the worker. Items B-D replace the stub expectations as they implement them.
 */
import { buildDeck, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import { afterAll, describe, expect, it } from 'vitest';
import type { JobQueue } from '../src/jobs.ts';
import { CpuPool, TASK_TIMEOUT_MS } from '../src/pool.ts';
import { PptxImports } from '../src/pptx/index.ts';
import { PPTX_JOB_CLASS, PPTX_JOBS, type PptxDeps } from '../src/pptx/shared.ts';

describe('pptx jobs', () => {
  it('registers every kind and queues each on its class', () => {
    const registered: string[] = [];
    const queued: [string, unknown, string][] = [];
    const jobs = {
      register: (kind: string) => registered.push(kind),
      enqueue: (kind: string, payload: unknown, cls: string) => {
        queued.push([kind, payload, cls]);
        return { id: 'j', kind } as never;
      },
    } as unknown as JobQueue;
    const pptx = new PptxImports({ jobs, locked: () => false } as unknown as PptxDeps);
    expect(registered.sort()).toEqual(Object.values(PPTX_JOBS).sort());
    pptx.queueNative('hash', 'Sunday.pptx', { extendBackgrounds: false });
    pptx.queueReference('p1', 'hash');
    expect(queued).toEqual([
      ['pptx-native', { hash: 'hash', name: 'Sunday.pptx', options: { extendBackgrounds: false } }, 'light'],
      ['pptx-reference', { presentationId: 'p1', hash: 'hash' }, 'heavy'],
    ]);
    expect(PPTX_JOB_CLASS['pptx-lo']).toBe('heavy');
  });
});

describe('pptx pool tasks', () => {
  const pool = new CpuPool(1);
  afterAll(() => pool.close());

  it('have timeouts', () => {
    for (const k of ['pptx-scene', 'pptx-render-copy', 'pptx-art'] as const)
      expect(TASK_TIMEOUT_MS[k]).toBeGreaterThan(0);
  });

  it('pptx-scene converts a batch of slides on the worker', async () => {
    const box = (color: string) => sp({ id: 2, x: 0, y: 0, cx: 914_400, cy: 914_400, fill: solid(color) });
    const parts = buildDeck({ slides: [{ shapes: box('FF0000') }, { shapes: box('00FF00') }] });
    const out = await pool.run('pptx-scene', {
      parts,
      pictureSizes: [],
      range: { from: 1, to: 2 },
      options: {},
    });
    expect(out.result.listed).toHaveLength(2);
    expect(out.result.slides.map((s) => s.index)).toEqual([1]);
    expect(out.result.slides[0]!.slide.objects.length).toBeGreaterThan(0);
    expect(out.heapMb).toBeGreaterThan(0);
  });

  it('pptx-render-copy and pptx-art reach their stubs', async () => {
    await expect(
      pool.run('pptx-render-copy', { parts: new Map(), media: [], pages: [], out: '/nonexistent/copy.pptx' }),
    ).rejects.toThrow(/not implemented yet \(M3 item D\)/);
    const img = { width: 1, height: 1, channels: 4 as const, data: new Uint8Array(4) };
    await expect(
      pool.run('pptx-art', { white: img, black: img, box: { x: 0, y: 0, w: 1, h: 1 } }),
    ).rejects.toThrow(/not implemented yet \(M3 item D\)/);
  });
});
