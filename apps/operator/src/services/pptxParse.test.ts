import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportIn, ImportOut } from '../workers/import.worker.ts';
import { logLines } from './log.ts';
import {
  clientScene,
  type ParseRequest,
  resetImportParse,
  SCENE_MAX_BYTES,
  useImportParse,
  type WorkerFactory,
} from './pptxParse.ts';

/** The worker's parse, replaced: what it is asked for is what this file reads (the scene itself is the importers' own). */
const parsed = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@ordo/importers/pptx-client.ts', () => ({
  parsePptxScene: async (...args: unknown[]) => {
    parsed.calls.push(args);
    return { scene: { listed: [{}] }, ms: 1 };
  },
}));
vi.mock('@ordo/importers/pptx-faces.ts', () => ({ loadDeckFaces: async () => undefined }));

type Fake = ReturnType<WorkerFactory> & { posted: ImportIn[]; terminated: boolean; send(m: ImportOut): void };

function fake(answer?: (w: Fake, m: ImportIn) => void): { factory: WorkerFactory; workers: Fake[] } {
  const workers: Fake[] = [];
  const factory: WorkerFactory = () => {
    const w: Fake = {
      posted: [],
      terminated: false,
      onmessage: null,
      onerror: null,
      postMessage(m: ImportIn) {
        w.posted.push(m);
        answer?.(w, m);
      },
      terminate() {
        w.terminated = true;
      },
      send(m: ImportOut) {
        w.onmessage?.call(w as unknown as Worker, { data: m } as MessageEvent<ImportOut>);
      },
    } as Fake;
    workers.push(w);
    return w;
  };
  return { factory, workers };
}

const req = (o: Partial<ParseRequest> = {}): ParseRequest => ({
  file: new Blob(['deck']),
  name: 'Sunday.pptx',
  extendBackgrounds: true,
  libreoffice: false,
  fonts: [
    {
      id: 'f',
      family: 'Carlito',
      weight: 400,
      style: 'normal',
      file: { hash: 'a'.repeat(64), bytes: 1, mime: 'font/ttf', path: 'fonts/x.ttf' },
      source: 'bundled',
    },
  ],
  live: false,
  ...o,
});

beforeEach(() => resetImportParse());

describe('the browser parse of a PowerPoint import (design/27 §2)', () => {
  it('returns the scene the worker parsed, with the options and faces, and frees the worker', async () => {
    const scene = new TextEncoder().encode('{"version":2}');
    const progress: number[] = [];
    const { factory, workers } = fake((w) => {
      w.send({ t: 'progress', pct: 0.5 });
      w.send({ t: 'done', scene: scene.buffer as ArrayBuffer, ms: 12, slides: 3 });
    });
    const blob = await clientScene(req({ onProgress: (p) => progress.push(p) }), { worker: factory });
    expect(await blob?.text()).toBe('{"version":2}');
    expect(blob?.type).toBe('application/json');
    expect(progress).toEqual([0.5]);
    expect(workers[0]!.posted[0]).toMatchObject({ t: 'parse', extendBackgrounds: true, libreoffice: false });
    expect(workers[0]!.posted[0]!.faces).toEqual([
      { family: 'Carlito', weight: 400, italic: false, url: expect.stringContaining('a'.repeat(64)) },
    ]);
    expect(workers[0]!.terminated).toBe(true);
    expect(useImportParse.getState()).toMatchObject({ parsed: 1, hub: { live: 0, timeout: 0, failed: 0 } });
  });

  it('starts no worker while a playlist is live: the hub parses the deck', async () => {
    const { factory, workers } = fake();
    expect(await clientScene(req({ live: true }), { worker: factory })).toBeUndefined();
    expect(workers).toHaveLength(0);
    expect(useImportParse.getState().hub.live).toBe(1);
    expect(logLines().at(-1)?.text).toMatch(/Sunday\.pptx: the hub parses it \(a playlist was live\)/);
  });

  it('terminates a worker past its deadline and leaves the deck to the hub', async () => {
    const { factory, workers } = fake();
    const t0 = performance.now();
    expect(await clientScene(req(), { worker: factory, deadlineMs: 50 })).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    expect(workers[0]!.terminated).toBe(true);
    expect(useImportParse.getState().hub.timeout).toBe(1);
    // A late answer changes nothing.
    workers[0]!.send({ t: 'done', scene: new ArrayBuffer(1), ms: 1, slides: 1 });
    expect(useImportParse.getState().parsed).toBe(0);
  });

  it('leaves the deck to the hub when the parse fails, the worker dies or cannot start', async () => {
    const failing = fake((w) => w.send({ t: 'error', message: 'zip entries overlap' }));
    expect(await clientScene(req(), { worker: failing.factory })).toBeUndefined();
    const dying = fake((w) => w.onerror?.call(w as unknown as Worker, { message: 'boom' } as ErrorEvent));
    expect(await clientScene(req(), { worker: dying.factory })).toBeUndefined();
    const none: WorkerFactory = () => {
      throw new Error('no workers here');
    };
    expect(await clientScene(req(), { worker: none })).toBeUndefined();
    // A scene larger than the hub takes is not uploaded: the hub would drop it.
    const huge = fake((w) =>
      w.send({ t: 'done', scene: { byteLength: SCENE_MAX_BYTES + 1 } as ArrayBuffer, ms: 1, slides: 1 }),
    );
    expect(await clientScene(req(), { worker: huge.factory })).toBeUndefined();
    expect(useImportParse.getState().hub).toEqual({ live: 0, timeout: 0, failed: 3, unavailable: 1 });
    expect(failing.workers[0]!.terminated && dying.workers[0]!.terminated).toBe(true);
    expect(logLines().some((l) => /could not read it: zip entries overlap/.test(l.text))).toBe(true);
  });

  it('leaves a deck past the browser\u2019s 64 MB of slide XML to the hub, as a failure of its own reason (the total is deliberately not raised)', async () => {
    const big = fake((w) => w.send({ t: 'error', message: 'The deck holds more than 64 MB of slide XML' }));
    expect(await clientScene(req(), { worker: big.factory })).toBeUndefined();
    expect(useImportParse.getState().hub).toEqual({ live: 0, timeout: 0, failed: 1, unavailable: 0 });
    expect(big.workers[0]!.terminated).toBe(true);
    expect(
      logLines().some((l) => /could not read it: The deck holds more than 64 MB of slide XML/.test(l.text)),
    ).toBe(true);
  });
});

describe('the whole-slide option through the four hops (Q24.b, C-IW4): the import tab, the request, the worker message, the parse', () => {
  it('puts wholeSlides in the worker message when the request has it, and false when it does not', async () => {
    for (const [wholeSlides, expected] of [
      [true, true],
      [false, false],
      [undefined, false],
    ] as const) {
      const { factory, workers } = fake((w) => {
        w.send({ t: 'done', scene: new ArrayBuffer(2), ms: 1, slides: 1 });
      });
      await clientScene(req(wholeSlides === undefined ? {} : { wholeSlides }), { worker: factory });
      expect(workers[0]!.posted[0], String(wholeSlides)).toMatchObject({
        t: 'parse',
        extendBackgrounds: true,
        libreoffice: false,
        wholeSlides: expected,
      });
    }
  });

  describe('the import worker', () => {
    const posted: unknown[] = [];
    const self = { postMessage: (m: unknown) => void posted.push(m), onmessage: undefined as unknown };
    afterEach(() => {
      vi.unstubAllGlobals();
      posted.length = 0;
      parsed.calls.length = 0;
    });
    /** The worker as the browser starts it: its `self` stubbed, its handler called with one parse message. */
    async function post(message: Partial<ImportIn>) {
      vi.stubGlobal('self', self);
      vi.resetModules();
      await import('../workers/import.worker.ts');
      const handler = self.onmessage as (ev: { data: ImportIn }) => Promise<void>;
      await handler({
        data: {
          t: 'parse',
          file: new Blob([]),
          extendBackgrounds: true,
          libreoffice: true,
          faces: [],
          ...message,
        },
      });
    }

    it('hands the option to the parse of the deck: true when the message says so, nothing otherwise', async () => {
      await post({ wholeSlides: true });
      expect(posted.at(-1)).toMatchObject({ t: 'done' });
      expect(parsed.calls[0]![1]).toMatchObject({
        extendBackgrounds: true,
        libreoffice: true,
        wholeSlides: true,
      });
      await post({});
      expect(parsed.calls[1]![1]).not.toMatchObject({ wholeSlides: true });
    });
  });
});
