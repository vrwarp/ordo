/**
 * The keys of pre-rendered slides, computed by the hub when a presentation is saved (design/29 §1.3). Stub: no rows.
 */
import type { Presentation } from '@ordo/domain';
import type { Logger } from 'pino';
import type { Library, PrerenderKeyRow } from './library.ts';
import type { CpuPool } from './pool.ts';
import type { Store } from './store.ts';

export type KeysOptions = {
  live: () => 'idle' | 'live';
  log: Logger;
  startDelayMs?: number;
};

export class PrerenderKeys {
  constructor(_lib: Library, _store: Store, _pool: () => Pick<CpuPool, 'run'>, _opts: KeysOptions) {}
  async keysFor(_p: Presentation): Promise<PrerenderKeyRow[]> {
    return [];
  }
  start(): void {}
  stop(): void {}
  onLiveMode(_mode: 'idle' | 'live'): void {}
  async idle(): Promise<void> {}
}
