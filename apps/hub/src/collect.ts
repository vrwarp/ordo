/**
 * What stored presentations and their saved versions name (design/29 §1.3 "Collection with revisions"). Stub:
 * names nothing and scans nothing; the references index replaces it.
 */
import type { Logger } from 'pino';
import type { Library } from './library.ts';

export const refsIn = (_json: string): Set<string> => new Set();

export type BackfillOptions = {
  live: () => 'idle' | 'live';
  log: Logger;
  now?: () => number;
  yield?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  onRead?: (presentationId: string, rev: number) => void;
  sliceMs?: number;
  startDelayMs?: number;
};

export class RefBackfill {
  constructor(_lib: Library, _opts: BackfillOptions) {}
  async run(): Promise<void> {}
  start(): void {}
  stop(): void {}
  onLiveMode(_mode: 'idle' | 'live'): void {}
}
