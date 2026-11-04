/**
 * Run an importer in a worker thread with a small heap (`resourceLimits`), so a test can assert that a
 * hostile input is handled in bounded memory: if the parser allocated in proportion to the input, the
 * worker would die of an out-of-memory error instead of returning.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export type BoundedOutcome =
  | { ok: true; value: unknown; ms: number }
  | { ok: false; error: string; ms: number };

function tsxLoader(): string {
  const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
  return pathToFileURL(join(dirname(pkg), 'dist', 'loader.mjs')).href;
}

/**
 * `script` is the body of an async function with `mod` (the imported module) and `input` in scope; its
 * return value is posted back. `ms` is the time the call took inside the worker (not the worker's start).
 */
export function runBounded(
  modulePath: string,
  script: string,
  input: unknown,
  heapMb: number,
  transfer: ArrayBuffer[] = [],
): Promise<BoundedOutcome> {
  const src = `
    import { parentPort, workerData } from 'node:worker_threads';
    const mod = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    const input = workerData;
    const t0 = performance.now();
    try {
      const value = await (async () => { ${script} })();
      parentPort.postMessage({ ok: true, value, ms: performance.now() - t0 });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: String(e?.message ?? e), ms: performance.now() - t0 });
    }`;
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(`data:text/javascript,${encodeURIComponent(src)}`), {
      workerData: input,
      transferList: transfer,
      execArgv: ['--import', tsxLoader()],
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 16 },
    });
    w.once('message', (m: BoundedOutcome) => {
      resolve(m);
      void w.terminate();
    });
    w.once('error', reject);
    w.once('exit', (code) => reject(new Error(`worker exited (${code}) without an answer`)));
  });
}
