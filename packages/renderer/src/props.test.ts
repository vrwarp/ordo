import { describe, expect, it } from 'vitest';
import { LOOK_MAIN, LOOK_STAGE, LOOK_STREAM } from '@ordo/domain';
import { countdownText, elapsedTimer, propBox, propsModel, topMessage } from './props.ts';
import { liveState } from './fixtures.test-util.ts';

// 2026-11-01 09:59:30 UTC
const NOW = Date.UTC(2026, 10, 1, 9, 59, 30);
const ctx = { now: NOW, timeZone: 'UTC', clock24h: true };

function withCountdown(label?: string) {
  const s = liveState();
  return {
    ...s,
    timers: {
      cd: {
        id: 'cd',
        spec: { kind: 'countdownTo' as const, timeOfDay: '10:30', label },
        running: true,
        startedAt: NOW - 60_000,
      },
    },
    props: { ...s.props, countdownTimerId: 'cd' },
  };
}

describe('props text', () => {
  it('formats the countdown in the venue time zone, rounding up to whole seconds', () => {
    expect(countdownText(withCountdown(), ctx)?.text).toBe('30:30');
    expect(countdownText(withCountdown(), { ...ctx, now: NOW + 500 })?.text).toBe('30:30');
    expect(countdownText(withCountdown(), { ...ctx, now: NOW + 1000 })?.text).toBe('30:29');
    // Past the target the countdown holds at zero instead of jumping to tomorrow.
    expect(countdownText(withCountdown(), { ...ctx, now: NOW + 40 * 60_000 })?.text).toBe('00:00');
    // In another zone 10:30 local is a different instant.
    const ny = countdownText(withCountdown(), { ...ctx, timeZone: 'America/New_York' });
    expect(ny?.text).not.toBe('30:30');
  });

  it('shows countdown and its label on the main look', () => {
    const m = propsModel(withCountdown('Service starts soon'), LOOK_MAIN, ctx);
    expect(m.items.map((i) => [i.id, i.text])).toEqual([
      ['countdown', '30:30'],
      ['countdownLabel', 'Service starts soon'],
    ]);
    expect(m.key).toContain('countdown=30:30');
    // The stream look has no props.
    expect(propsModel(withCountdown(), LOOK_STREAM, ctx).key).toBe('');
  });

  it('re-keys only when the text changes', () => {
    const s = withCountdown();
    const a = propsModel(s, LOOK_MAIN, ctx).key;
    expect(propsModel(s, LOOK_MAIN, { ...ctx, now: NOW + 400 }).key).toBe(a);
    expect(propsModel(s, LOOK_MAIN, { ...ctx, now: NOW + 1000 }).key).not.toBe(a);
  });

  it('stage look: clock, elapsed timer and the newest unexpired message', () => {
    const s = {
      ...liveState(),
      timers: {
        e: { id: 'e', spec: { kind: 'elapsed' as const }, running: true, startedAt: NOW - 125_000 },
      },
      messages: [
        { id: 'm2', text: 'Expired', sentAt: NOW - 20_000, expiresAt: NOW - 1 },
        { id: 'm1', text: 'Wrap up', sentAt: NOW - 30_000 },
      ],
    };
    const m = propsModel(s, LOOK_STAGE, ctx);
    const byId = Object.fromEntries(m.items.map((i) => [i.id, i.text]));
    expect(byId.elapsed).toBe('02:05');
    expect(byId.message).toBe('Wrap up');
    expect(byId.clock).toBe('09:59');
    expect(topMessage(s, NOW)).toBe('Wrap up');
  });

  it('elapsed timer prefers the latest running one, else a stopped one with time', () => {
    const s = liveState();
    s.timers = {
      a: { id: 'a', spec: { kind: 'elapsed' }, running: false, elapsedMs: 5000 },
      b: { id: 'b', spec: { kind: 'elapsed' }, running: true, startedAt: 10 },
      c: { id: 'c', spec: { kind: 'elapsed' }, running: true, startedAt: 20 },
    };
    expect(elapsedTimer(s)?.id).toBe('c');
    delete s.timers.b;
    delete s.timers.c;
    expect(elapsedTimer(s)?.id).toBe('a');
  });

  it('logo prop only when the look allows it and the logo action is on', () => {
    const s = { ...liveState(), props: { logo: true, at: 5, seq: 2 } };
    const m = propsModel(s, LOOK_MAIN, { ...ctx, logoMediaId: 'logo' });
    expect(m.logo?.mediaId).toBe('logo');
    expect(m.key).toContain('L:logo');
    expect(propsModel(s, LOOK_STAGE, { ...ctx, logoMediaId: 'logo' }).logo).toBeUndefined();
    expect(propsModel({ ...s, black: true }, LOOK_MAIN, { ...ctx, logoMediaId: 'logo' }).key).toBe('');
  });

  it('look styles override default prop boxes', () => {
    const look = {
      ...LOOK_MAIN,
      layers: {
        ...LOOK_MAIN.layers,
        props: {
          ...LOOK_MAIN.layers.props,
          style: { clock: { ...propBox('clock', LOOK_MAIN), fontSizePx: 99 } },
        },
      },
    };
    expect(propBox('clock', look).fontSizePx).toBe(99);
    expect(propBox('elapsed', look).fontSizePx).toBe(64);
  });
});
