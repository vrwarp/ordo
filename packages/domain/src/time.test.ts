import { describe, expect, it } from 'vitest';
import { formatDuration, nextTimeOfDay } from './time.ts';

describe('time helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-5)).toBe('00:00');
  });
  it('finds the next time of day in a zone', () => {
    const now = Date.UTC(2026, 10, 1, 9, 30, 0); // 09:30 UTC
    expect(nextTimeOfDay('10:00', 'UTC', now) - now).toBe(30 * 60_000);
    // 09:00 passed 30 minutes ago: still today (within an hour), so negative remaining
    expect(nextTimeOfDay('09:00', 'UTC', now) - now).toBe(-30 * 60_000);
    // 08:00 passed 90 minutes ago: tomorrow
    expect(nextTimeOfDay('08:00', 'UTC', now) - now).toBe((24 * 60 - 90) * 60_000);
  });
});
