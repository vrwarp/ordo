/**
 * What this hub's server tools allow (design/27 M9 "LibreOffice optional"; the hub's `GET /capabilities`):
 * the import screen, the import card and the editor's PowerPoint card offer only what works. LibreOffice is
 * optional on the hub, so 'Pictures (LibreOffice)', LibreOffice reference pictures ('Show original') and the
 * LibreOffice art of what ordo cannot draw may be missing; PDF import and PowerPoint's own PDF as reference
 * pictures need poppler-utils.
 *
 * - Parsed with the protocol's `.catch` defaults: an unknown field or a bad value never breaks the screen.
 * - A 404 is a hub from before M9, which always had LibreOffice (`LEGACY_CAPABILITIES`).
 * - A network error keeps the last answer (an image swap changes it: `useHubCaps` asks again on every
 *   reconnect of the hub link, and whenever a screen that needs it opens).
 * - Undefined until the first answer: options that need a tool stay hidden until the hub says it has it.
 */
import { ApiFailure, api } from '@ordo/client';
import { HubCapabilities, LEGACY_CAPABILITIES } from '@ordo/protocol';
import { useEffect } from 'react';
import { create } from 'zustand';
import { useLive } from '../state/live.ts';

export type HubCapsState = {
  /** The hub's last answer; undefined until the first one. */
  caps?: HubCapabilities;
  /** When it was read (ms), for the refresh interval. */
  at?: number;
};

export const useHubCapsStore = create<HubCapsState>(() => ({}));

/** A `GET /capabilities` body as the operator reads it: every field defaulted when unknown or bad. */
export function parseHubCaps(body: unknown): HubCapabilities {
  const r = HubCapabilities.safeParse(body);
  return r.success ? r.data : HubCapabilities.parse({});
}

/** What reading the capabilities needs: replaced in tests. */
export type CapsDeps = { get(path: string): Promise<unknown>; now?(): number };

/** Answers younger than this are kept when a screen asks again (a reconnect always asks). */
const FRESH_MS = 15_000;
let inFlight: Promise<HubCapabilities | undefined> | undefined;

/**
 * Ask the hub (`force`: even when the last answer is fresh). Resolves to the capabilities now known; never
 * rejects. A 404 means a hub before M9; any other failure keeps the last answer.
 */
export function loadHubCaps(
  deps: CapsDeps = { get: (p) => api<unknown>(p) },
  force = false,
): Promise<HubCapabilities | undefined> {
  const now = deps.now ?? Date.now;
  const s = useHubCapsStore.getState();
  if (!force && s.caps && s.at !== undefined && now() - s.at < FRESH_MS) return Promise.resolve(s.caps);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const caps = parseHubCaps(await deps.get('/capabilities'));
      useHubCapsStore.setState({ caps, at: now() });
      // Just after the hub started it may still be asking LibreOffice its version: ask again shortly.
      if (caps.libreoffice.state === 'checking') useHubCapsStore.setState({ at: now() - FRESH_MS + 3_000 });
      return caps;
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) {
        useHubCapsStore.setState({ caps: LEGACY_CAPABILITIES, at: now() });
        return LEGACY_CAPABILITIES;
      }
      return useHubCapsStore.getState().caps;
    } finally {
      inFlight = undefined;
    }
  })();
  return inFlight;
}

/**
 * The hub's capabilities for a screen: read when it opens (unless fresh) and again on every reconnect of the
 * hub link (the hub may have been replaced by an image without LibreOffice). Undefined until known.
 */
export function useHubCaps(): HubCapabilities | undefined {
  const caps = useHubCapsStore((s) => s.caps);
  const connected = useLive((s) => s.hubConnected);
  useEffect(() => {
    void loadHubCaps(undefined, connected);
  }, [connected]);
  return caps;
}
