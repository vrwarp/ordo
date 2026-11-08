/**
 * The worker of `convertDeckIsolated` (`native.ts`): converts the decks it is sent, one at a time, and
 * posts each `NativeDeck` back. Its heap limit and timeout are set by the parent, so a hostile deck costs
 * one worker, not the run.
 */
import { parentPort } from 'node:worker_threads';
import { type ConvertOptions, convertDeck } from './native.ts';

parentPort?.on('message', (job: { deckFile: string; dir: string; opts?: ConvertOptions }) => {
  void convertDeck(job.deckFile, job.dir, job.opts).then((out) => parentPort?.postMessage(out));
});
