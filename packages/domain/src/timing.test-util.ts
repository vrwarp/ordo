/**
 * Wall-clock bounds in unit tests (design/23 "Timing bounds"). A test may bound how long a parser, a layout or
 * an import takes, to show it stays linear on hostile input and never runs away. The bound is the budget on a
 * developer machine; CI's 2-core runner is about three times slower for CPU-bound work, so `budgetMs(5_000)` is
 * 15 s there. `ORDO_TEST_TIME_SCALE` sets the factor by hand (a machine shared with other jobs).
 *
 * Frame and task budgets (§13's 50 ms task, a 16 ms frame) are not unit-test bounds: the benches
 * (`packages/renderer/bench`) and the fidelity harness gate them, where the machine is known.
 *
 * A bound on a linear-time proof of a reader reads `cpuMs` instead of the clock (below), with the same `budgetMs` number.
 */
export const TIME_SCALE = timeScale();

/** `ms` on this machine: scaled on CI (×3) or by `ORDO_TEST_TIME_SCALE`. */
export function budgetMs(ms: number): number {
  return ms * TIME_SCALE;
}

/**
 * The CPU time this process has used so far, in ms (user and system, every thread). A test that bounds how long a parser takes, to
 * show it stays linear on hostile input, reads this instead of the wall clock: the wall clock grows with the machine's load and
 * with `nice` (a run here shares four cores and runs at niceness 19), the work done does not. The bound keeps the number the
 * wall-clock one had (`budgetMs`): time spent waiting for a core is not counted, nothing else changes. (Where there is no
 * `process`, a browser page, it reads the wall clock.)
 */
export function cpuMs(): number {
  if (typeof process === 'undefined' || typeof process.cpuUsage !== 'function') return performance.now();
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

function timeScale(): number {
  const env = typeof process === 'undefined' ? {} : process.env;
  const forced = Number(env.ORDO_TEST_TIME_SCALE);
  if (Number.isFinite(forced) && forced > 0) return forced;
  return env.CI ? 3 : 1;
}
