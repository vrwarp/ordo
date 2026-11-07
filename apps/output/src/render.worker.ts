import { isControl, startHeartbeat } from '@ordo/client';
import type { AssetToRender, FromRender, ToRender } from '@ordo/renderer/messages.ts';
import { RenderEngine } from '@ordo/renderer/engine.ts';
import { SRC_BITMAP, SRC_SCENE, type StackContent } from '@ordo/renderer/stacks.ts';

/**
 * Render worker: owns the OffscreenCanvas and the RenderEngine. From the main thread it receives only its
 * canvas, video frames and the snapshot period; flips, content and clock updates arrive from the link
 * worker on a port, bitmaps from the asset worker on another port (both handed over with `ports`, again
 * after any worker restart). Supervised: heartbeat every 250 ms; a restarted render worker gets a fresh
 * canvas and is re-armed by the link worker while the host's hold canvas shows the last frame.
 */

const scope = self as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToRender>) => void) | null;
  requestAnimationFrame?: (cb: (ts: number) => void) => number;
};

// A fast heartbeat: the host covers the screen within about 250 ms of this worker dying (a dead
// worker's canvas can turn white).
startHeartbeat(scope, 50);

let engine: RenderEngine | null = null;
let canvasWaiter: ((c: OffscreenCanvas) => void) | null = null;
let early: ToRender[] = [];
let earlyOffers: { layer: number; c: StackContent<ImageBitmap> }[] = [];
let linkPort: MessagePort | null = null;
let assetPort: MessagePort | null = null;

/** To the main thread (canvas, snapshots, lifecycle). */
function postMain(m: FromRender, transfer: Transferable[] = []): void {
  scope.postMessage(m, transfer);
}

/** To the link worker (held keys, telemetry, lifecycle). */
function postLink(m: FromRender): void {
  try {
    linkPort?.postMessage(m);
  } catch {
    /* port closed: a new one arrives with the next `ports` */
  }
}

function lifecycle(m: FromRender): void {
  postMain(m);
  postLink(m);
}

const raf =
  typeof scope.requestAnimationFrame === 'function'
    ? (cb: (ts: number) => void) => scope.requestAnimationFrame!(cb)
    : (cb: (ts: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number;

const wallNow = () => performance.timeOrigin + performance.now();

let readyMsg: FromRender | null = null;

async function init(m: Extract<ToRender, { t: 'init' }>): Promise<void> {
  const e = new RenderEngine(
    {
      canvas: m.canvas,
      width: m.width,
      height: m.height,
      testPixel: m.testPixel,
      forceCanvas2d: m.forceCanvas2d,
      allowFallbackAdapter: m.allowFallbackAdapter,
      clear: m.clear,
      clockOffset: m.clockOffset,
    },
    {
      raf,
      wallNow,
      onHeld: (layers) => postLink({ t: 'held', layers }),
      onSnapshot: (bitmap, cue) => postMain({ t: 'snapshot', bitmap, cue }, [bitmap]),
      onLost: (reason) => lifecycle({ t: 'lost', reason }),
      onRestored: (compositor) => lifecycle({ t: 'restored', compositor }),
      requestCanvas: () =>
        new Promise<OffscreenCanvas>((resolve) => {
          canvasWaiter = resolve;
          postMain({ t: 'needCanvas' });
        }),
      canvasUnused: () => postMain({ t: 'canvasUnused' }),
    },
  );
  if (m.assetPort) attachAsset(m.assetPort);
  try {
    const r = await e.start();
    engine = e;
    readyMsg = { t: 'ready', compositor: r.kind, note: r.note };
    lifecycle(readyMsg);
  } catch (err) {
    lifecycle({ t: 'fatal', error: (err as Error).message });
    return;
  }
  for (const o of earlyOffers) e.offer(o.layer, o.c);
  earlyOffers = [];
  for (const x of early) handle(x);
  early = [];
  setInterval(() => e.flushHeld(), 40);
  // Long tasks are not observable in workers (no PerformanceObserver 'longtask' entries): the engine's
  // FrameClock reports rAF stalls of 50 ms or more as the worker's long-task count instead.
  setInterval(() => postLink({ t: 'telemetry', tel: e.telemetry() }), 250);
}

function attachAsset(port: MessagePort): void {
  try {
    assetPort?.close();
  } catch {
    /* closed */
  }
  assetPort = port;
  port.onmessage = (ev: MessageEvent<AssetToRender>) => {
    const a = ev.data;
    if (a.t !== 'content') return;
    const c: StackContent<ImageBitmap> =
      a.kind === SRC_SCENE
        ? {
            key: a.key,
            kind: SRC_SCENE,
            bitmap: a.bitmap,
            x: a.x,
            y: a.y,
            cueIndex: a.cueIndex,
            refresh: a.refresh,
            over: a.over ?? null,
            overX: a.overX,
            overY: a.overY,
            plane: a.plane,
            videoSlot: a.videoSlot,
            videoGen: a.videoGen,
          }
        : {
            key: a.key,
            kind: SRC_BITMAP,
            bitmap: a.bitmap,
            x: a.x,
            y: a.y,
            opaque: a.opaque,
            cueIndex: a.cueIndex,
            refresh: a.refresh,
          };
    if (engine) engine.offer(a.layer, c);
    else earlyOffers.push({ layer: a.layer, c });
  };
}

function attachLink(port: MessagePort): void {
  try {
    linkPort?.close();
  } catch {
    /* closed */
  }
  linkPort = port;
  port.onmessage = (ev: MessageEvent<ToRender>) => handle(ev.data);
  // A restarted link worker that connects after the engine started still needs to know it is ready, and
  // what this renderer holds (held keys are otherwise reported only when they change).
  if (readyMsg && engine) {
    postLink({ t: 'telemetry', tel: engine.telemetry() });
    postLink({ t: 'held', layers: engine.heldKeys() });
  }
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
      e.setVideoFrame(m.slot, m.frame, m.gen, m.startedAt, m.loopMs);
      return;
    case 'vclear':
      e.setVideoFrame(m.slot, null);
      return;
    case 'snapshot':
      e.setSnapshot(m.everyMs, m.width, m.height);
      return;
    case 'frames':
      postLink({ t: 'frames', frames: e.clock.frames() });
      return;
    case 'tick':
    case 'init':
    case 'canvas':
    case 'ports':
      return;
  }
}

scope.onmessage = (ev) => {
  const m = ev.data;
  if (isControl(m)) return;
  switch (m.t) {
    case 'canvas':
      canvasWaiter?.(m.canvas);
      canvasWaiter = null;
      return;
    case 'ports':
      attachAsset(m.asset);
      attachLink(m.link);
      return;
    case 'init':
      void init(m);
      return;
    default:
      handle(m);
  }
};
