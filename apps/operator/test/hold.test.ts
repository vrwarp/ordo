import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DoublePressGuard, HoldGuard } from '../src/lib/confirm.ts';

describe('clear-all hold (prd/02 "press twice within 2 s, or hold")', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the hold time and tells the release to ignore its click', () => {
    const g = new HoldGuard(1000);
    let fired = 0;
    g.down(() => fired++);
    vi.advanceTimersByTime(999);
    expect(fired).toBe(0);
    expect(g.holding).toBe(true);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    expect(g.holding).toBe(false);
    expect(g.up()).toBe(true);
    // A second release reports nothing.
    expect(g.up()).toBe(false);
  });

  it('does not fire when released early', () => {
    const g = new HoldGuard(1000);
    let fired = 0;
    g.down(() => fired++);
    vi.advanceTimersByTime(500);
    expect(g.up()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(fired).toBe(0);
  });

  it('restarts the hold on a new press', () => {
    const g = new HoldGuard(1000);
    let fired = 0;
    g.down(() => fired++);
    vi.advanceTimersByTime(800);
    g.down(() => fired++);
    vi.advanceTimersByTime(800);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(200);
    expect(fired).toBe(1);
  });

  it('a held press confirms the arm made by its own keydown', () => {
    // The keydown arms the double-press guard; the hold sends the confirming press within the window.
    const dbl = new DoublePressGuard(2000);
    const hold = new HoldGuard(1000);
    const cleared: number[] = [];
    const press = () => {
      if (dbl.press(Date.now())) cleared.push(Date.now());
    };
    press(); // keydown
    expect(cleared).toEqual([]);
    hold.down(() => {
      if (dbl.pendingUntil(Date.now()) !== undefined) press();
    });
    vi.advanceTimersByTime(1000);
    expect(cleared).toHaveLength(1);
  });
});
