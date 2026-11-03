import { describe, expect, it } from 'vitest';
import { nextUpdateAttempt, parseAttempts, UPDATE_RETRY_CAP, updatePhaseOnLoad } from '../src/lib/update.ts';

describe('version-mismatch reload cap (review item 28)', () => {
  it('counts attempts and stops after the cap', () => {
    expect(nextUpdateAttempt(0)).toEqual({ attempt: 1, exhausted: false });
    expect(nextUpdateAttempt(UPDATE_RETRY_CAP - 1)).toEqual({ attempt: UPDATE_RETRY_CAP, exhausted: false });
    expect(nextUpdateAttempt(UPDATE_RETRY_CAP)).toEqual({ attempt: UPDATE_RETRY_CAP + 1, exhausted: true });
  });

  it('shows the failure screen on load once the cap was reached, so no connection starts', () => {
    expect(updatePhaseOnLoad(0)).toBe('idle');
    expect(updatePhaseOnLoad(UPDATE_RETRY_CAP - 1)).toBe('idle');
    expect(updatePhaseOnLoad(UPDATE_RETRY_CAP)).toBe('failed');
  });

  it('reads the stored count defensively', () => {
    expect(parseAttempts(null)).toBe(0);
    expect(parseAttempts('x')).toBe(0);
    expect(parseAttempts('-2')).toBe(0);
    expect(parseAttempts('2.7')).toBe(2);
  });
});
