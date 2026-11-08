import type { Font } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { fontLoads } from './messages.ts';

const face = (unicodeRange?: string): Font => ({
  id: 'f',
  family: 'Noto Sans Hebrew',
  weight: 400,
  style: 'normal',
  file: { hash: 'a'.repeat(64), bytes: 1, mime: 'font/ttf', path: 'fonts/a.ttf' },
  source: 'bundled',
  ...(unicodeRange ? { unicodeRange } : {}),
});

describe('fontLoads', () => {
  it('passes a face unicode-range on to the drawers (design/27 §10)', () => {
    expect(fontLoads([face('U+591-5F4,U+FB1D-FB4F')])).toEqual([
      {
        family: 'Noto Sans Hebrew',
        weight: 400,
        style: 'normal',
        hash: 'a'.repeat(64),
        unicodeRange: 'U+591-5F4,U+FB1D-FB4F',
      },
    ]);
    expect(fontLoads([face()])[0]).not.toHaveProperty('unicodeRange');
  });
});
