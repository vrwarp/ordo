import { describe, expect, it } from 'vitest';
import { estimateOffset, parseClientMessage } from './index.ts';

describe('protocol', () => {
  it('validates client messages', () => {
    const ok = parseClientMessage(
      JSON.stringify({ t: 'live.event', v: 1, id: 'a', event: { k: 'next', at: 5 } }),
    );
    expect('error' in ok).toBe(false);
    const goLive = parseClientMessage(
      JSON.stringify({ t: 'live.event', v: 1, id: 'a', event: { k: 'goLive', playlistId: 'p' } }),
    );
    expect('error' in goLive).toBe(false);
    const bad = parseClientMessage(JSON.stringify({ t: 'live.event', v: 1, id: 'a', event: { k: 'nope' } }));
    expect('error' in bad).toBe(true);
    expect('error' in parseClientMessage('{')).toBe(true);
  });
  it('estimates clock offset from the minimum round trip', () => {
    const r = estimateOffset([
      { c: 0, s: 1010, r: 40 },
      { c: 100, s: 1105, r: 110 },
    ]);
    expect(r).toEqual({ offset: 1105 + 5 - 110, rtt: 10 });
  });
});
