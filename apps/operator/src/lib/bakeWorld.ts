import {
  BAKE_ROLES,
  type BakeInput,
  type BakeRole,
  type BakeVerdict,
  bakeEngine,
  browserEnv,
  canBake,
  useCapabilities,
} from './capabilities.ts';

/*
 * What the bake gate reads of this browser (design/15 "Pictures of heavy slides"): `lib/capabilities.ts` is in the first
 * load of every layout and holds only the decision (`canBake`) and the engine probe; the reading of the real browser
 * lives here, behind the boot's lazy chunk, so a phone's first load does not carry it.
 */

/** `?bake=off` in the URL, or localStorage `ordo.bake` = `off` (support only). */
export function forcedBakeOff(search: string, stored: string | null): boolean {
  return (new URLSearchParams(search).get('bake') ?? stored) === 'off';
}

/** What this page reads of its own browser for `canBake` (the hub, the layout and the session are the caller's). */
export type BakeWorld = Pick<
  BakeInput,
  'caps' | 'engine' | 'secure' | 'offscreen' | 'worker' | 'memoryGb' | 'forcedOff'
>;

/** Read the real browser: capabilities, the engine probe, secure context, `OffscreenCanvas`, `Worker`, device memory, `?bake=off`. */
export function readBakeWorld(): BakeWorld {
  const env = browserEnv();
  let stored: string | null = null;
  try {
    stored = typeof localStorage === 'undefined' ? null : localStorage.getItem('ordo.bake');
  } catch {
    /* storage unavailable */
  }
  const mem =
    typeof navigator !== 'undefined' ? (navigator as { deviceMemory?: unknown }).deviceMemory : undefined;
  return {
    caps: useCapabilities.getState().caps,
    engine: bakeEngine(env),
    secure: typeof isSecureContext !== 'undefined' && isSecureContext === true,
    offscreen: typeof OffscreenCanvas !== 'undefined',
    worker: typeof Worker !== 'undefined',
    memoryGb: typeof mem === 'number' && Number.isFinite(mem) && mem > 0 ? mem : undefined,
    forcedOff: typeof location === 'undefined' ? false : forcedBakeOff(location.search, stored),
  };
}

/**
 * The gate of THIS device, from the real environment: `parts` is what the capability module cannot know without
 * importing the hub's capabilities store and the layout (the initial bundle keeps both lazy): the layout and phone
 * class, whether this is the demo, the hub's `prerender.state` and the session's role.
 */
export function bakeGate(
  parts: Pick<BakeInput, 'layout' | 'phone' | 'demo' | 'hub' | 'role'>,
  world: BakeWorld = readBakeWorld(),
  roles: readonly BakeRole[] = BAKE_ROLES,
): BakeVerdict {
  return canBake({ ...world, ...parts }, roles);
}
