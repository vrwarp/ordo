/**
 * The press of Go live and the bake service's hold (design/29 section 1.4). The Controller posts the Go live to the
 * core FIRST and then asks the bake service to stop its picture making, in the same tick; nothing the hold does (a
 * throw) may stop the GO or hide it from the operator. The service is replaced by a function the test registers on
 * `onGoLivePress`; the core worker is a fake that records what the Controller posts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MainToCore } from '../src/core/protocol.ts';
import { logLines } from '../src/services/log.ts';
import { onGoLivePress } from '../src/services/bakeHold.ts';
import { Controller } from '../src/services/controller.ts';

class FakeWorker extends EventTarget {
  posted: MainToCore[] = [];
  postMessage(m: MainToCore): void {
    this.posted.push(m);
  }
  terminate(): void {
    // nothing to stop
  }
  reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

let worker: FakeWorker;
let ctl: Controller;

const calls = (): string[] =>
  worker.posted.filter((m): m is Extract<MainToCore, { t: 'call' }> => m.t === 'call').map((m) => m.name);

beforeEach(() => {
  worker = new FakeWorker();
  ctl = new Controller('operate', () => worker as unknown as Worker);
  worker.reply({ t: 'ready', generation: 0 });
});

afterEach(() => {
  onGoLivePress(undefined);
  ctl.stop();
});

describe('the press of Go live reaches the hub whatever the bake service does', () => {
  const presses: [string, string, () => void][] = [
    ['goLive', 'goLive', () => ctl.goLive('p1')],
    ['goLiveFromSaved', 'goLiveSaved', () => ctl.goLiveFromSaved('p1')],
    ['goLiveLocal', 'goLiveLocal', () => ctl.goLiveLocal('p1')],
  ];

  for (const [method, call, press] of presses) {
    it(`${method}: a hold that throws does not stop the GO, and the error is logged`, () => {
      onGoLivePress(() => {
        throw new Error('hold broke');
      });
      expect(() => press()).not.toThrow();
      expect(calls()).toEqual([call]);
      expect(logLines().some((l) => l.level === 'error' && l.text.includes('hold broke'))).toBe(true);
    });

    it(`${method}: the GO is already posted when the hold runs (a slow hold cannot delay it)`, () => {
      let seen: string[] | undefined;
      onGoLivePress(() => {
        seen = calls();
      });
      press();
      expect(seen).toEqual([call]);
    });
  }

  it('a hold that is present and well behaved is still called once per press', () => {
    let held = 0;
    onGoLivePress(() => {
      held++;
    });
    ctl.goLive('p1');
    ctl.goLiveLocal('p1');
    ctl.goLiveFromSaved('p1');
    expect(held).toBe(3);
    expect(calls()).toEqual(['goLive', 'goLiveLocal', 'goLiveSaved']);
  });
});
