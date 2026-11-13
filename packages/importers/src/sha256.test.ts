import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Sha256, sha256Blob, sha256Hex } from './sha256.ts';

describe('sha256', () => {
  it('computes sha256 matching node crypto on various inputs', () => {
    const inputs = [
      '',
      'a',
      'abc',
      'message digest',
      'The quick brown fox jumps over the lazy dog',
      'x'.repeat(1000),
    ];
    for (const str of inputs) {
      const expected = createHash('sha256').update(str).digest('hex');
      expect(sha256Hex(str)).toBe(expected);
      expect(sha256Hex(new TextEncoder().encode(str))).toBe(expected);
    }
  });
});

describe('Sha256 in pieces', () => {
  it('hashes any split of the input as one piece, and a Blob as its bytes', async () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed;
    };
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 70_000]) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = rand() & 0xff;
      const expected = createHash('sha256').update(data).digest('hex');
      expect(sha256Hex(data)).toBe(expected);
      const h = new Sha256();
      let at = 0;
      while (at < n) {
        const take = Math.min(n - at, 1 + (rand() % 97));
        h.update(data.subarray(at, at + take));
        at += take;
      }
      expect(Buffer.from(h.digest()).toString('hex')).toBe(expected);
      expect(await sha256Blob(new Blob([data]))).toBe(expected);
    }
  });

  it('refuses a second digest', () => {
    const h = new Sha256();
    h.digest();
    expect(() => h.digest()).toThrow();
    expect(() => h.update(new Uint8Array(1))).toThrow();
  });
});
