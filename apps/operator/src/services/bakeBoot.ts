import type { BakeVerdict } from '../lib/capabilities.ts';
import { loadHubCaps, useHubCapsStore } from '../lib/hubCaps.ts';
import type { BakeActions } from '../state/bake.ts';
import type { BakeService } from './bake.ts';
import { realGate } from './bakeGate.ts';
import { useLive } from '../state/live.ts';
import { bakeTestMode } from './bakeTest.ts';

/**
 * The bake service's way into the first load (design/25 "Operator window", design/29 section 1.4): small on purpose,
 * because everything the service is (the plan, the status store's writers, the job's messages) is a lazy chunk that
 * only a desktop computer with the hub's switch on ever fetches. This module decides that from the gate, loads the
 * chunk once, starts the service, passes the press of Go live to it, and gives the editor and the Go-live check the
 * actions of the contract (`BakeActions`, state/bake.ts). It holds no state of the pictures: those are the store's.
 */

/** A press of Go live seen while the chunk was still on its way is passed on if it is this fresh, ms. */
export const FRESH_PRESS_MS = 60_000;

export type BakeBootDeps = {
  gate(): BakeVerdict;
  /** Fetches the service's chunk (`import('./bake.ts')`). */
  load(): Promise<BakeService>;
  now(): number;
  testMode(): boolean;
  /** The hub's capabilities arriving or changing (the gate may turn ready). */
  onCaps(fn: () => void): () => void;
  /** Reads the hub's capabilities (`GET /capabilities`; `force`: even when the last answer is fresh). Never rejects. */
  loadCaps(force: boolean): Promise<unknown>;
  /** The hub link coming back: the hub may have been replaced, so its capabilities are read again. */
  onReconnect(fn: () => void): () => void;
  /** `window`, where there is one (test mode puts `window.__ordo.bake` on it). */
  win?: { __ordo?: Record<string, unknown> };
};

/** The gate's word for a verdict (state/bake.ts BAKE_GATES): what the store says once the service is loaded. */
const gateWord = (v: BakeVerdict) => (v.ok ? 'ready' : v.why);

export function createBakeBoot(deps: BakeBootDeps) {
  let chunk: Promise<BakeService> | undefined;
  let service: BakeService | undefined;
  let pressedAt = Number.NEGATIVE_INFINITY;

  /** The service, fetched once; a chunk that failed to load may be fetched again at the next trigger. */
  function load(): Promise<BakeService> {
    if (!chunk) {
      const p: Promise<BakeService> = deps.load().then((s) => {
        service = s;
        if (deps.now() - pressedAt < FRESH_PRESS_MS) s.holdForGoLive();
        return s;
      });
      chunk = p;
      p.catch(() => {
        if (chunk === p) chunk = undefined;
      });
    }
    return chunk;
  }

  /**
   * Test mode only: `window.__ordo.bake` (C-BW8), read by the end-to-end specs and the technician:
   * `{ gate, hold, running, totals, slides, presentations, workers, timings, sweeps, requests }`, live getters over the
   * service's own `snapshot()`; before the chunk is fetched the gate is the real one (a phone says "unsupported" without
   * ever fetching the service) and the rest is empty. No picture bytes, no slide text.
   */
  function hook(): void {
    if (!deps.win || !deps.testMode()) return;
    const o: Record<string, unknown> = {};
    const field = (name: string, empty: unknown): void => {
      Object.defineProperty(o, name, {
        enumerable: true,
        get: () => (service ? (service.snapshot() as unknown as Record<string, unknown>)[name] : empty),
      });
    };
    Object.defineProperty(o, 'gate', {
      enumerable: true,
      get: () => (service ? service.snapshot().gate : gateWord(deps.gate())),
    });
    field('hold', undefined);
    field('running', undefined);
    field('totals', { heavy: 0, ready: 0, making: 0, queued: 0, failed: 0 });
    field('slides', {});
    field('presentations', {});
    field('workers', 0);
    field('timings', undefined);
    field('sweeps', 0);
    field('requests', []);
    field('lastMade', undefined);
    Object.defineProperty(o, 'loaded', { value: () => !!service });
    Object.defineProperty(o, 'actions', { value: bakeActions });
    deps.win.__ordo ??= {};
    deps.win.__ordo.bake = o;
  }

  /**
   * Starts the service on this page when the gate says this computer may make pictures, now or when the hub's
   * capabilities arrive; returns the cleanup (stops the service, ends the wait for the hub). Not called on the compact
   * layout or for a signed-out page: the gate is still the one that decides.
   */
  function installBake(): () => void {
    let cancelled = false;
    let stop: (() => void) | undefined;
    let starting = false;
    const check = (): void => {
      if (cancelled || stop || starting || !deps.gate().ok) return;
      starting = true;
      load().then(
        (s) => {
          starting = false;
          if (!cancelled && !stop) stop = s.start();
        },
        () => {
          starting = false;
        },
      );
    };
    hook();
    // Nothing else on the first screens reads the capabilities: the gate needs the hub's switch, so ask for it here.
    void deps.loadCaps(false);
    check();
    const off = deps.onCaps(check);
    const offLink = deps.onReconnect(() => {
      void deps.loadCaps(true);
    });
    return () => {
      cancelled = true;
      off();
      offLink();
      stop?.();
      stop = undefined;
    };
  }

  /** The press of Go live (the Controller's first line): a service that is running stops its bake on the spot. */
  function holdBakesForGoLive(): void {
    pressedAt = deps.now();
    service?.holdForGoLive();
  }

  const refusal = (v: BakeVerdict) =>
    v.ok
      ? undefined
      : v.why === 'off'
        ? ('off' as const)
        : v.why === 'unsupported'
          ? ('unsupported' as const)
          : ('hub' as const);

  /** The editor's and the Go-live check's way to the service (a refusal of the gate never fetches the chunk). */
  const bakeActions: BakeActions = {
    async refresh(presentationId, options) {
      const v = deps.gate();
      // a phone and the demo do nothing; a hub with its switch off still gives the editor its words ("off")
      if (!v.list && !(!v.ok && v.why === 'off')) return;
      try {
        await (await load()).refresh(presentationId, options);
      } catch {
        // the chunk could not be fetched: the editor keeps what it shows
      }
    },
    async makeNow(scope) {
      const why = refusal(deps.gate());
      if (why) return { ok: false, why };
      try {
        return await (await load()).makeNow(scope);
      } catch {
        return { ok: false, why: 'hub' };
      }
    },
    async makeAgain(presentationId, slideId) {
      if (!deps.gate().list) return { ok: false, why: 'hub' };
      try {
        return await (await load()).makeAgain(presentationId, slideId);
      } catch {
        return { ok: false, why: 'hub' };
      }
    },
    async focus(focus) {
      if (!deps.gate().ok) return;
      try {
        (await load()).focus(focus);
      } catch {
        // see refresh
      }
    },
  };

  return { installBake, holdBakesForGoLive, bakeActions, hook };
}

const real = createBakeBoot({
  gate: realGate,
  load: () => import('./bake.ts').then((m) => m.bake),
  now: () => Date.now(),
  testMode: bakeTestMode,
  onCaps: (fn) => useHubCapsStore.subscribe(fn),
  loadCaps: (force) => loadHubCaps(undefined, force),
  onReconnect: (fn) =>
    useLive.subscribe((now, prev) => {
      if (now.hubConnected && !prev.hubConnected) fn();
    }),
  win:
    typeof window === 'undefined' ? undefined : (window as unknown as { __ordo?: Record<string, unknown> }),
});

// In test mode the diagnostics exist on every layout (a phone says "unsupported" and never fetches the service).
real.hook();

export const installBake = real.installBake;
export const holdBakesForGoLive = real.holdBakesForGoLive;
export const bakeActions = real.bakeActions;
