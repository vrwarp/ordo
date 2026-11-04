import { describe, expect, it } from 'vitest';
import { RELOAD_MAX, RELOAD_WINDOW_MS, planReload } from './reload.ts';

describe('crash-only reload budget', () => {
  it('reloads within the budget and remembers when', () => {
    expect(planReload(null, 1000, 'x')).toEqual({ action: 'reload', recent: [1000] });
    expect(planReload('garbage', 1000, 'x')).toEqual({ action: 'reload', recent: [1000] });
  });

  it('past the budget restarts the named worker instead (a stuck renderer is not left frozen)', () => {
    const now = 5 * 60_000;
    const spent = JSON.stringify(Array.from({ length: RELOAD_MAX }, (_, i) => now - 1000 * (i + 1)));
    const p = planReload(spent, now, 'no frame presented for 3 s while live (twice)', 'render');
    expect(p).toMatchObject({ action: 'restart', worker: 'render' });
    expect(p.action === 'restart' && p.text).toMatch(/restarted the render worker instead/);
    expect(planReload(spent, now, 'invariants')).toMatchObject({ action: 'refuse' });
    // A new app version always reloads; old entries leave the window.
    expect(planReload(spent, now, 'new app version').action).toBe('reload');
    expect(planReload(spent, now + RELOAD_WINDOW_MS, 'x').action).toBe('reload');
  });
});
