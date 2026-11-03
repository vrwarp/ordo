import type { BusEndpoint } from '@ordo/client';
import type { FallbackMessage } from '@ordo/protocol';
import { describe, expect, it } from 'vitest';
import { MuxEndpoint } from './bus.ts';

function fakeEp(): BusEndpoint & { sent: FallbackMessage[]; push(m: FallbackMessage): void; dead: boolean } {
  const subs = new Set<(m: FallbackMessage) => void>();
  const ep = {
    kind: 'port' as const,
    sent: [] as FallbackMessage[],
    dead: false,
    post(m: FallbackMessage) {
      ep.sent.push(m);
    },
    onMessage(fn: (m: FallbackMessage) => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    alive: () => !ep.dead,
    close() {
      ep.dead = true;
    },
    push(m: FallbackMessage) {
      for (const f of subs) f(m);
    },
  };
  return ep;
}

const hello = { t: 'fallback.hello', v: 1, seq: 1, operatorMs: 0 } as FallbackMessage;
const ready = { t: 'fallback.ready', v: 1, outputId: 'o', appliedSeq: 1 } as FallbackMessage;

describe('fallback bus endpoint of the link worker', () => {
  it('hears both carriers and answers the way the operator last spoke', () => {
    const bridge = fakeEp();
    const mux = new MuxEndpoint(bridge);
    const got: FallbackMessage[] = [];
    mux.onMessage((m) => got.push(m));
    bridge.push(hello);
    mux.post(ready);
    expect(bridge.sent).toEqual([ready]);
    expect(mux.kind).toBe('window');

    const port = fakeEp();
    mux.setPort(port);
    expect(mux.kind).toBe('port');
    mux.post(ready);
    expect(port.sent).toEqual([ready]);
    port.push(hello);
    expect(got).toHaveLength(2);
    bridge.push(hello);
    mux.post(ready);
    expect(bridge.sent).toHaveLength(2);
  });

  it('keeps the newest port and falls back to the relay when it dies', () => {
    const bridge = fakeEp();
    const mux = new MuxEndpoint(bridge);
    const a = fakeEp();
    const b = fakeEp();
    mux.setPort(a);
    mux.setPort(b);
    expect(a.dead).toBe(true);
    b.dead = true;
    mux.post(ready);
    expect(bridge.sent).toEqual([ready]);
    expect(mux.alive()).toBe(true);
  });
});
