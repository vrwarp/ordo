import type { LiveState, ResolvedPlaylist } from '@ordo/domain';
import type { LiveStateMsg } from '@ordo/protocol';
import { describe, expect, it } from 'vitest';
import { HeldCopy, joinState } from './copies.ts';

const copy = (name = 'a') => ({ playlist: { id: 'pl', name }, presentations: {} }) as unknown as ResolvedPlaylist;
const msg = (state: Partial<LiveState>, resolvedId?: string): LiveStateMsg => ({
  t: 'live.state',
  v: 1,
  seq: 3,
  state: { seq: 3, mode: 'live', cues: [], ...state } as LiveState,
  ...(resolvedId ? { resolvedId } : {}),
});

describe('HeldCopy', () => {
  it('holds one copy: hold and seed replace it, get answers only for its id, clear forgets it', () => {
    const h = new HeldCopy();
    expect(h.id).toBeUndefined();
    expect(h.get('a')).toBeUndefined();
    const a = copy('a');
    h.hold('a', a);
    expect(h.get('a')).toBe(a);
    expect(h.get('b')).toBeUndefined();
    const b = copy('b');
    h.seed('b', b);
    expect(h.get('a')).toBeUndefined();
    expect(h.get('b')).toBe(b);
    expect(h.id).toBe('b');
    h.clear();
    expect(h.id).toBeUndefined();
    expect(h.value).toBeUndefined();
  });
});

describe('joinState', () => {
  it('a state that carries its copy, an idle state and an older shape come back as they are', () => {
    const h = new HeldCopy();
    const whole = msg({ resolved: copy() }, 'a');
    expect(joinState(whole, h)).toEqual({ state: whole.state });
    expect((joinState(whole, h) as { state: LiveState }).state).toBe(whole.state);
    const idle = msg({ mode: 'idle' });
    expect((joinState(idle, h) as { state: LiveState }).state).toBe(idle.state);
    const older = msg({});
    expect((joinState(older, h) as { state: LiveState }).state).toBe(older.state);
  });

  it('a by-name state is joined to the held object itself, every time (identity is kept)', () => {
    const h = new HeldCopy();
    const held = copy();
    h.hold('a', held);
    const first = joinState(msg({}, 'a'), h) as { state: LiveState };
    const second = joinState(msg({ seq: 9 }, 'a'), h) as { state: LiveState };
    expect(first.state.resolved).toBe(held);
    expect(second.state.resolved).toBe(held);
    expect(second.state.seq).toBe(9);
  });

  it('a by-name state whose id is not held is "need", never applied', () => {
    const h = new HeldCopy();
    expect(joinState(msg({}, 'a'), h)).toBe('need');
    h.hold('b', copy('b'));
    expect(joinState(msg({}, 'a'), h)).toBe('need');
    h.clear();
    expect(joinState(msg({}, 'b'), h)).toBe('need');
  });
});
