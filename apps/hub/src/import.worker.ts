/**
 * Worker thread for the CPU-bound ProPresenter decode (design/20): `importPro7` walks every document
 * synchronously, which would stall the hub event loop (and with it ping/pong liveness) for seconds on a
 * large library. Built as its own bundle entry (dist/import.worker.js); run from source under tsx in dev.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { importPro7 } from '@ordo/importers';

const files = (workerData as { files: Map<string, Uint8Array> }).files;
try {
  parentPort?.postMessage({ ok: true, result: importPro7(files) });
} catch (e) {
  parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
