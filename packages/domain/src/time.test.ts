import { describe, expect, it } from 'vitest';
import { formatDuration, nextTimeOfDay, zonedToMs } from './time.ts';

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

  it('strictlyAfter never returns a time in the past or within the lead', () => {
    const now = Date.UTC(2026, 10, 1, 3, 0, 30); // 03:00:30 UTC
    expect(nextTimeOfDay('03:00', 'UTC', now, { strictlyAfter: true }) - now).toBe(24 * 3600_000 - 30_000);
    const nearly = Date.UTC(2026, 10, 1, 2, 59, 50);
    expect(nextTimeOfDay('03:00', 'UTC', nearly, { strictlyAfter: true }) - nearly).toBe(24 * 3600_000 + 10_000);
  });

  it('is correct across DST changes', () => {
    // Europe/Berlin springs forward 2026-03-29 02:00 CET -> 03:00 CEST. From 01:30 CET, 10:00 CEST is 7.5 h away.
    const berlin = zonedToMs('Europe/Berlin', 2026, 3, 29, 1, 30);
    expect(nextTimeOfDay('10:00', 'Europe/Berlin', berlin) - berlin).toBe(7.5 * 3600_000);
    // From Saturday 23:30 CET, Sunday 10:00 CEST is 9.5 h away (one hour vanishes).
    const sat = zonedToMs('Europe/Berlin', 2026, 3, 28, 23, 30);
    expect(nextTimeOfDay('10:00', 'Europe/Berlin', sat) - sat).toBe(9.5 * 3600_000);
    // America/New_York falls back 2026-11-01 02:00 EDT -> 01:00 EST. From Saturday 23:00 EDT, Sunday 09:00 EST is 11 h away.
    const ny = zonedToMs('America/New_York', 2026, 10, 31, 23, 0);
    expect(nextTimeOfDay('09:00', 'America/New_York', ny) - ny).toBe(11 * 3600_000);
    // Backup scheduling: from 22:00 PDT on 2026-10-31, the next 03:00 PST is 6 h away.
    const la = zonedToMs('America/Los_Angeles', 2026, 10, 31, 22, 0);
    expect(nextTimeOfDay('03:00', 'America/Los_Angeles', la, { strictlyAfter: true }) - la).toBe(6 * 3600_000);
  });

  it('handles month boundaries', () => {
    const now = zonedToMs('UTC', 2026, 1, 31, 23, 0);
    expect(nextTimeOfDay('01:00', 'UTC', now) - now).toBe(2 * 3600_000);
  });
});
