import type { AssetToRender, FromRender, ToRender } from '@ordo/renderer/messages.ts';
import { RenderEngine } from '@ordo/renderer/engine.ts';
import { SRC_BITMAP } from '@ordo/renderer/stacks.ts';

/**
 * Render worker: owns the OffscreenCanvas and the RenderEngine. Bitmaps arrive from the asset worker on
 * a MessagePort; video frames, flips and clock updates from the main thread.
 */

const scope = self as unknown as {
  postMessage(m: FromRender, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToRender>) => void) | null;
  requestAnimationFrame?: (cb: (ts: number) => void) => number;
};

let engine: RenderEngine | null = null;
let canvasWaiter: ((c: OffscreenCanvas) => void) | null = null;
let early: ToRender[] = [];

function post(m: FromRender, transfer: Transferable[] = []): void {
  scope.postMessage(m, transfer);
}

const raf =
  typeof scope.requestAnimationFrame === 'function'
    ? (cb: (ts: number) => void) => scope.requestAnimationFrame!(cb)
    : (cb: (ts: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number;

const wallNow = () => performance.timeOrigin + performance.now();

function observeLongTasks(): void {
  try {
    const po = new PerformanceObserver((list) => {
      if (engine) engine.longTasks += list.getEntries().length;
    });
    po.observe({ type: 'longtask', buffered: false });
  } catch {
    /* long task timing is not available in workers on every platform */
  }
}

async function init(m: Extract<ToRender, { t: 'init' }>): Promise<void> {
  const e = new RenderEngine(
    {
      canvas: m.canvas,
      width: m.width,
      height: m.height,
      testPixel: m.testPixel,
      forceCanvas2d: m.forceCanvas2d,
      clear: m.clear,
      clockOffset: m.clockOffset,
    },
    {
      raf,
      wallNow,
      onHeld: (layers) => post({ t: 'held', layers }),
      onSnapshot: (bitmap) => post({ t: 'snapshot', bitmap }, [bitmap]),
      onLost: (reason) => post({ t: 'lost', reason }),
      onRestored: (compositor) => post({ t: 'restored', compositor }),
      requestCanvas: () =>
        new Promise<OffscreenCanvas>((resolve) => {
          canvasWaiter = resolve;
          post({ t: 'needCanvas' });
        }),
    },
  );
  m.assetPort.onmessage = (ev: MessageEvent<AssetToRender>) => {
    const a = ev.data;
    if (a.t === 'content')
      e.offer(a.layer, { key: a.key, kind: SRC_BITMAP, bitmap: a.bitmap, cueIndex: a.cueIndex });
  };
  try {
    const r = await e.start();
    engine = e;
    post({ t: 'ready', compositor: r.kind, note: r.note });
  } catch (err) {
    post({ t: 'fatal', error: (err as Error).message });
    return;
  }
  for (const x of early) handle(x);
  early = [];
  setInterval(() => e.flushHeld(), 40);
  setInterval(() => post({ t: 'telemetry', tel: e.telemetry() }), 250);
  observeLongTasks();
}

function handle(m: ToRender): void {
  const e = engine;
  if (!e) {
    if (m.t === 'vframe') m.frame.close();
    else early.push(m);
    return;
  }
  switch (m.t) {
    case 'clock':
      e.setClockOffset(m.offset);
      return;
    case 'clear':
      e.setClear(m.color);
      return;
    case 'content':
      e.offer(m.layer, {
        key: m.key,
        kind: m.kind,
        videoSlot: m.videoSlot,
        fit: m.fit,
        cueIndex: m.cueIndex,
      });
      return;
    case 'flip':
      e.flip(m.layer, m.key, m.at, m.fadeMs, m.cueIndex);
      return;
    case 'vframe':
      e.setVideoFrame(m.slot, m.frame);
      return;
    case 'vclear':
      e.setVideoFrame(m.slot, null);
      return;
    case 'snapshot':
      e.setSnapshot(m.everyMs, m.width, m.height);
      return;
    case 'frames':
      post({ t: 'frames', frames: e.clock.frames() });
      return;
    case 'init':
    case 'canvas':
      return;
  }
}

scope.onmessage = (ev) => {
  const m = ev.data;
  if (m.t === 'canvas') {
    canvasWaiter?.(m.canvas);
    canvasWaiter = null;
    return;
  }
  if (m.t === 'init') void init(m);
  else handle(m);
};
