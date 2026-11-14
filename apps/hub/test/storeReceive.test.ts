/**
 * Store.receive refused past its limit leaves no file in uploads/ (apps/hub/src/store.ts). The write stream
 * opens its .part on the thread pool; a stream refused at its first chunk fails before that open is done, and
 * the cleanup's `rm` could then run on another pool thread first, so the open created the file after it was
 * removed. Seen in the merged PR #27 head's `pnpm test` under load (pptx-no-libreoffice.test.ts: an empty .part
 * left by "an upload past a route's own limit"); a probe of the same pattern left 3-7 files per 10,000 refusals
 * before the fix, 0 after. Many refusals in a row, so the race shows when it is there.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import type { Library } from '../src/library.ts';
import { Store } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'ordo-receive-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Store.receive past its limit', () => {
  it('leaves no .part behind, however soon the stream is refused', async () => {
    const store = new Store(dir, {} as Library);
    await store.init();
    const N = 10_000;
    let refused = 0;
    for (let i = 0; i < N; i++) {
      const e = await store.receive(Readable.from([Buffer.alloc(3_000)]), 2_048).catch((x: unknown) => x);
      if ((e as { code?: string }).code === 'too_large') refused++;
    }
    expect(refused).toBe(N);
    // A late open would create its file after the refusal: give any such open time to land.
    await new Promise((r) => setTimeout(r, 300));
    expect(readdirSync(store.uploads)).toEqual([]);
  }, 60_000);
});
