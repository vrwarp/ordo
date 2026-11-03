import { describe, expect, it } from 'vitest';
import { summarize } from './report.ts';

const s = (t: number, presented: number, missed = 0, longTasks = 0) => ({
  t,
  outputId: 'o1',
  presented,
  missed,
  longTasks,
  lateFlips: 0,
  gpuLost: 0,
  videoDropped: 0,
});

describe('soak summary', () => {
  it('sums deltas and survives counter resets', () => {
    const [r] = summarize([s(1, 0), s(2, 60), s(3, 120, 1), s(4, 30, 1), s(5, 90, 1)], { o1: 'Audience 1' });
    expect(r).toMatchObject({ name: 'Audience 1', presented: 210, missed: 1, pass: false });
  });
  it('passes a clean run', () => {
    const [r] = summarize([s(1, 0), s(2, 60), s(3, 120)], {});
    expect(r!.pass).toBe(true);
  });
});
