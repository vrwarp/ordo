import { describe, expect, it } from 'vitest';
import { LOOK_MAIN, LOOK_STAGE, LOOK_STREAM } from '@ordo/domain';
import { countdownText, elapsedTimer, propBox, propsModel, topMessage, videoRemainingText } from './props.ts';
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
    // On audience look, it auto-hides after holding 00:00 for 3.5 seconds.
    expect(countdownText(withCountdown(), { ...ctx, now: NOW + 40 * 60_000 }, LOOK_MAIN)).toBeNull();
    // On stage look, it holds 00:00 so platform sees it.
    expect(countdownText(withCountdown(), { ...ctx, now: NOW + 40 * 60_000 }, LOOK_STAGE)?.text).toBe(
      '00:00',
    );
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

describe('video remaining time on the stage look (prd/04)', () => {
  const playing = (state: 'playing' | 'paused' | 'ended', loop = false) => {
    const s = liveState();
    return {
      ...s,
      layers: {
        ...s.layers,
        media: {
          content: {
            kind: 'media' as const,
            cueIndex: 4,
            mediaId: 'vid',
            mediaKind: 'video' as const,
            loop,
            onEnd: 'hold' as const,
            state,
            startedAt: NOW - 12_500,
            positionMs: 30_000,
          },
          at: NOW - 12_500,
          seq: 2,
        },
      },
    };
  };

  it('counts down from the media duration while playing, holds while paused, nothing when ended or looping', () => {
    expect(videoRemainingText(playing('playing'), NOW)).toBe('00:48'); // 60 s - 12.5 s, rounded up
    expect(videoRemainingText(playing('playing'), NOW + 500)).toBe('00:47');
    expect(videoRemainingText(playing('paused'), NOW)).toBe('00:30');
    expect(videoRemainingText(playing('ended'), NOW)).toBeUndefined();
    expect(videoRemainingText(playing('playing', true), NOW)).toBeUndefined();
    expect(videoRemainingText(playing('playing'), NOW + 10 * 60_000)).toBe('00:00');
  });

  it('is a prop of the stage look only and re-keys each second', () => {
    const s = playing('playing');
    const stage = propsModel(s, LOOK_STAGE, ctx);
    expect(stage.items.find((i) => i.id === 'videoRemaining')?.text).toBe('00:48');
    expect(stage.key).toContain('videoRemaining=00:48');
    expect(propsModel(s, LOOK_STAGE, { ...ctx, now: NOW + 1000 }).key).toContain('videoRemaining=00:47');
    expect(propsModel(s, LOOK_MAIN, ctx).items.some((i) => i.id === 'videoRemaining')).toBe(false);
    expect(propBox('videoRemaining', LOOK_STAGE).box.y).toBeGreaterThan(900);
  });
});

describe('countdown presets and corners', () => {
  const withPreset = (
    countdownPreset: 'cornerCircle' | 'cornerPill' | 'centerHero',
    countdownCorner?: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight',
  ) => ({
    ...LOOK_MAIN,
    layers: {
      ...LOOK_MAIN.layers,
      props: { ...LOOK_MAIN.layers.props, countdownPreset, countdownCorner },
    },
  });

  it('defaults non-stage looks to cornerCircle in the bottom-right with a progress ring', () => {
    const m = propsModel(withCountdown('Service starts'), LOOK_MAIN, ctx);
    expect(m.ring).toBeDefined();
    expect(m.ring?.box).toEqual({ x: 1672, y: 832, w: 200, h: 200, rotation: 0 });
    expect(m.ring?.progress).toBeGreaterThan(0.9);
    expect(m.ring?.progress).toBeLessThanOrEqual(1);
    const cd = m.items.find((i) => i.id === 'countdown');
    expect(cd?.box.x).toBeGreaterThan(1600);
    expect(cd?.box.y).toBeGreaterThan(800);
  });

  it('places cornerCircle and cornerPill in the requested corner and compacts cornerPill without a label', () => {
    const tlCircle = propsModel(withCountdown(), withPreset('cornerCircle', 'topLeft'), ctx);
    expect(tlCircle.ring?.box).toEqual({ x: 48, y: 48, w: 200, h: 200, rotation: 0 });

    const trPillWithLabel = propsModel(
      withCountdown('Starting soon'),
      withPreset('cornerPill', 'topRight'),
      ctx,
    );
    expect(trPillWithLabel.ring).toBeUndefined();
    const cdWithLabel = trPillWithLabel.items.find((i) => i.id === 'countdown');
    expect(cdWithLabel?.box).toEqual({ x: 1452, y: 48, w: 420, h: 72, rotation: 0 });
    expect(cdWithLabel?.style.fill).toBeDefined();

    const blPillCompact = propsModel(withCountdown(), withPreset('cornerPill', 'bottomLeft'), ctx);
    const cdCompact = blPillCompact.items.find((i) => i.id === 'countdown');
    expect(cdCompact?.box).toEqual({ x: 48, y: 960, w: 200, h: 72, rotation: 0 });
    expect(cdCompact?.style.align).toBe('center');
  });

  it('supports centerHero and keeps stage looks on the top strip', () => {
    const hero = propsModel(withCountdown(), withPreset('centerHero'), ctx);
    expect(hero.ring).toBeUndefined();
    expect(hero.items.find((i) => i.id === 'countdown')?.style.fontSizePx).toBe(180);

    const stage = propsModel(withCountdown(), LOOK_STAGE, ctx);
    expect(stage.ring).toBeUndefined();
    expect(stage.items.find((i) => i.id === 'countdown')?.box).toEqual({
      x: 660,
      y: 16,
      w: 600,
      h: 110,
      rotation: 0,
    });
  });
});
