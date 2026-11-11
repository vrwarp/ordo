import { afterEach, describe, expect, it } from 'vitest';
import { LocalWindowTracker, registerWindowProbe } from './probe.ts';

describe('LocalWindowTracker and registerWindowProbe', () => {
  let cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups = [];
  });

  it('detects registered window via probe and ping/pong', async () => {
    const tracker = new LocalWindowTracker();
    cleanups.push(() => tracker.dispose());

    // Initially output-1 is not known
    expect(tracker.isConfirmedLocal('output-1')).toBe(false);

    // Register output-1
    const unreg = registerWindowProbe('output-1', 'output');
    cleanups.push(unreg);

    // Probe output-1
    const found = await tracker.probe(['output-1'], 50);
    expect(found.has('output-1')).toBe(true);
    expect(tracker.isConfirmedLocal('output-1')).toBe(true);
    expect(tracker.confirmedLocalIds().has('output-1')).toBe(true);

    // Unregistered output does not appear
    expect(tracker.isConfirmedLocal('output-remote')).toBe(false);
    const remoteFound = await tracker.probe(['output-remote'], 50);
    expect(remoteFound.has('output-remote')).toBe(false);
  });

  it('removes window when unregistered (closed)', async () => {
    const tracker = new LocalWindowTracker();
    cleanups.push(() => tracker.dispose());

    const unreg = registerWindowProbe('output-2', 'output');
    await tracker.probe(['output-2'], 50);
    expect(tracker.isConfirmedLocal('output-2')).toBe(true);

    unreg();
    // Allow closed message to propagate
    await new Promise((r) => setTimeout(r, 20));

    expect(tracker.isConfirmedLocal('output-2')).toBe(false);
  });
});
