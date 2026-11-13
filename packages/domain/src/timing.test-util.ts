/**
 * Wall-clock bounds in unit tests (design/23 "Timing bounds"). A test may bound how long a parser, a layout or
 * an import takes, to show it stays linear on hostile input and never runs away. The bound is the budget on a
 * developer machine; CI's 2-core runner is about three times slower for CPU-bound work, so `budgetMs(5_000)` is
 * 15 s there. `ORDO_TEST_TIME_SCALE` sets the factor by hand (a machine shared with other jobs).
 *
 * Frame and task budgets (§13's 50 ms task, a 16 ms frame) are not unit-test bounds: the benches
 * (`packages/renderer/bench`) and the fidelity harness gate them, where the machine is known.
 */
export const TIME_SCALE = timeScale();

/** `ms` on this machine: scaled on CI (×3) or by `ORDO_TEST_TIME_SCALE`. */
export function budgetMs(ms: number): number {
  return ms * TIME_SCALE;
}

function timeScale(): number {
  const env = typeof process === 'undefined' ? {} : process.env;
  const forced = Number(env.ORDO_TEST_TIME_SCALE);
  if (Number.isFinite(forced) && forced > 0) return forced;
  return env.CI ? 3 : 1;
}
