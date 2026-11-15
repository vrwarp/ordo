import { describe, expect, it } from 'vitest';
import { leftBusIn } from './linklog.ts';

/**
 * link-fallback-leave.spec.ts times the outputs' exit from the fallback bus by their own log (`leftBusIn`), not
 * by when the test hears back from Chrome: the reading must find the right line and put it on the right day.
 */
describe('leftBusIn: when an output window left its bus, from its link log', () => {
  const t = (iso: string) => Date.parse(iso);
  // An output's log over the spec: the hub dies, the operator takes over, its tab closes, the hub returns.
  const log = [
    '18:10:20.104 bus: hub (hub connected)',
    '18:10:27.310 bus: none (hub disconnected)',
    '18:10:27.902 bus: fallback (operator hello)',
    '18:10:34.556 opener window closed',
    '18:10:34.556 bus: none (opener closed)',
    '18:10:41.020 bus: hub (hub connected)',
  ];

  it('reads the first bus: none line at or after the time given, as epoch ms, with its reason', () => {
    expect(leftBusIn(log, t('2026-11-14T18:10:34.500Z'))).toEqual({
      at: t('2026-11-14T18:10:34.556Z'),
      reason: 'opener closed',
    });
    expect(leftBusIn(log, t('2026-11-14T18:10:34.556Z'))?.at).toBe(t('2026-11-14T18:10:34.556Z'));
  });

  it('skips the lines stamped before it, and other buses', () => {
    expect(leftBusIn(log, t('2026-11-14T18:10:20.000Z'))?.reason).toBe('hub disconnected');
    expect(leftBusIn(log, t('2026-11-14T18:10:34.557Z'))).toBeUndefined();
    expect(
      leftBusIn(['18:10:27.902 bus: fallback (operator hello)', 'bus: none (no stamp)'], 0),
    ).toBeUndefined();
    expect(leftBusIn([], t('2026-11-14T18:10:34.500Z'))).toBeUndefined();
  });

  it('reads the stamps on the day nearest the time given, across midnight UTC either way', () => {
    // Left just after midnight, the close just before it: the next day.
    expect(leftBusIn(['00:00:00.150 bus: none (opener closed)'], t('2026-11-14T23:59:59.900Z'))).toEqual({
      at: t('2026-11-15T00:00:00.150Z'),
      reason: 'opener closed',
    });
    // A line from just before midnight is before a close just after it: not taken.
    expect(
      leftBusIn(['23:59:59.900 bus: none (hub disconnected)'], t('2026-11-15T00:00:00.100Z')),
    ).toBeUndefined();
    expect(
      leftBusIn(
        ['23:59:59.900 bus: none (hub disconnected)', '00:00:00.300 bus: none (operator says hub up)'],
        t('2026-11-15T00:00:00.100Z'),
      ),
    ).toEqual({ at: t('2026-11-15T00:00:00.300Z'), reason: 'operator says hub up' });
  });
});
