/**
 * Store.appendPart, one PATCH of a resumable upload (apps/hub/src/store.ts; PATCH /media/uploads/:id in
 * routes.ts). The .part holds the upload's acknowledged bytes, and the upload's row counts them (its offset).
 * When a PATCH fails (a chunk past the declared size, or a client that drops its connection), pipeline rejects
 * at once, while a chunk the write stream already took can still be being written on the thread pool. If the
 * .part is cut back to the offset before that write returns, the write lands after the cut: the .part then holds
 * bytes the offset does not count, and the next PATCH appends after them, so the media file is wrong. Store
 * .receive had the same race for its clean-up (storeReceive.test.ts).
 *
 * The first two tests hold each write of the write stream back for a while, as a busy thread pool would, so the
 * write is surely in flight when the PATCH fails; both failed before the fix. The third refuses many PATCHes at
 * the machine's own pace; a probe of that left nothing wrong before the fix either (0 of 3,000), so it guards
 * the ordinary case and the first two prove the race.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Library } from '../src/library.ts';
import { Store } from '../src/store.ts';

/** How long each write of a write stream is held back before it reaches the file (0: not held). */
const held = vi.hoisted(() => ({ ms: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  type Op = (...args: unknown[]) => void;
  const later =
    (op: Op): Op =>
    (...args) => {
      if (held.ms) setTimeout(() => op(...args), held.ms);
      else op(...args);
    };
  return {
    ...fs,
    createWriteStream: (path: string, opts?: object) =>
      fs.createWriteStream(path, {
        ...opts,
        fs: {
          open: fs.open,
          close: fs.close,
          write: later(fs.write as unknown as Op),
          writev: later(fs.writev as unknown as Op),
        },
      } as Parameters<typeof fs.createWriteStream>[1]),
  };
});

const dir = mkdtempSync(join(tmpdir(), 'ordo-append-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  held.ms = 0;
});

const OFFSET = 4096;
const SIZE = 64 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeStore(): Promise<Store> {
  const store = new Store(dir, {} as Library);
  await store.init();
  return store;
}
/** A .part that already holds OFFSET acknowledged bytes (1s). */
function part(name: string): string {
  const path = join(dir, 'uploads', `${name}.part`);
  writeFileSync(path, Buffer.alloc(OFFSET, 1));
  return path;
}

describe('Store.appendPart when a PATCH fails', () => {
  it('cuts the .part back to its offset after a chunk past the declared size, even with a write in flight', async () => {
    const store = await makeStore();
    const path = part('over');
    held.ms = 150;
    // A small chunk the write stream takes at once (and starts writing), then one past the declared size.
    const body = (async function* () {
      yield Buffer.alloc(500, 2);
      await sleep(40);
      yield Buffer.alloc(SIZE, 3);
    })();
    const e = await store.appendPart(path, OFFSET, SIZE - OFFSET, body).catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe('too_large');
    // Give the held write time to land, wherever it lands.
    await sleep(300);
    expect(statSync(path).size).toBe(OFFSET);

    // The next PATCH starts at the offset, and the .part is exactly the acknowledged bytes plus it.
    held.ms = 0;
    const rest = Buffer.alloc(SIZE - OFFSET, 4);
    expect(await store.appendPart(path, OFFSET, SIZE - OFFSET, Readable.from([rest]))).toBe(rest.length);
    expect(readFileSync(path).equals(Buffer.concat([Buffer.alloc(OFFSET, 1), rest]))).toBe(true);
  });

  it('cuts the .part back to its offset when the client drops its connection with a write in flight', async () => {
    const store = await makeStore();
    const path = part('abort');
    held.ms = 150;
    const body = new Readable({ read() {} });
    body.push(Buffer.alloc(500, 2));
    setTimeout(() => body.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })), 40);
    const e = await store.appendPart(path, OFFSET, SIZE - OFFSET, body).catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe('ECONNRESET');
    await sleep(300);
    expect(statSync(path).size).toBe(OFFSET);
  });

  it('keeps the .part at its offset over many refused PATCHes, at the pace of the machine', async () => {
    const store = await makeStore();
    const N = 2_000;
    let wrong = 0;
    for (let i = 0; i < N; i++) {
      const path = part(`many-${i % 20}`);
      const body = new Readable({ read() {} });
      body.push(Buffer.alloc(1_000 + (i % 7) * 1_000, 2));
      if (i % 2) setImmediate(() => body.destroy(new Error('aborted')));
      else setImmediate(() => body.push(Buffer.alloc(SIZE, 3)));
      await store.appendPart(path, OFFSET, SIZE - OFFSET, body).catch(() => undefined);
      if (statSync(path).size !== OFFSET) wrong++;
    }
    await sleep(100);
    expect(wrong).toBe(0);
  }, 60_000);
});
