import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from './sha256.ts';

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
