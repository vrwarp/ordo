import { DEMO } from '@ordo/client';
import { BAKE_ROLES, type BakeVerdict } from '../lib/capabilities.ts';
import { bakeGate, readBakeWorld } from '../lib/bakeWorld.ts';
import { useHubCapsStore } from '../lib/hubCaps.ts';
import { currentLayout, thisIsPhone } from '../lib/layout.ts';
import { currentRole } from '../state/session.ts';

/**
 * `canBake` for this computer, now: the layout, the phone and demo checks, the hub's own switch (from `/capabilities`)
 * and this session's role, read from the real stores and the real browser. It is a module of its own, small, so the
 * boot (services/bakeBoot.ts, in the first load) can decide whether the bake service's chunk is wanted at all
 * without loading it: a phone, the demo and a capped session never fetch it (Q24.b).
 */
export function realGate(): BakeVerdict {
  return bakeGate(
    {
      layout: currentLayout(),
      phone: thisIsPhone(),
      demo: DEMO,
      hub: useHubCapsStore.getState().caps?.prerender?.state,
      role: currentRole(),
    },
    readBakeWorld(),
    BAKE_ROLES,
  );
}
