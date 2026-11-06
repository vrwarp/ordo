import { describe, expect, it } from 'vitest';
import { Media, MediaTrim } from './schemas.ts';

/** Media.trim (design/27 §8 "Hub"): the kept part of the original, baked into the delivery at ingest. */

const file = { hash: 'a'.repeat(64), bytes: 10, mime: 'video/x-ms-wmv', path: 'media/aa/a.wmv' };
const media = {
  id: 'clip',
  name: 'clip',
  kind: 'video',
  original: file,
  state: 'ready',
};

describe('Media.trim', () => {
  it('is optional, and kept when present', () => {
    expect(Media.parse(media).trim).toBeUndefined();
    expect(Media.parse({ ...media, trim: { startMs: 1500, endMs: 4000 } }).trim).toEqual({
      startMs: 1500,
      endMs: 4000,
    });
  });

  it('refuses negative, fractional and unbounded times', () => {
    expect(MediaTrim.safeParse({ startMs: -1, endMs: 10 }).success).toBe(false);
    expect(MediaTrim.safeParse({ startMs: 0.5, endMs: 10 }).success).toBe(false);
    expect(MediaTrim.safeParse({ startMs: 0, endMs: 1e12 }).success).toBe(false);
    expect(MediaTrim.safeParse({ startMs: 0 }).success).toBe(false);
    expect(Media.safeParse({ ...media, trim: { startMs: -1, endMs: 10 } }).success).toBe(false);
  });
});
