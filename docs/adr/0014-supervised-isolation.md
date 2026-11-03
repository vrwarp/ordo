# ADR 0014: Supervised isolation of subsystems

Status: Accepted for phases A and B; proposed for C to E ([design/25](../design/25-isolation-and-hardening.md)).

## Context
The 2026-11-03 review showed that the prototype's failures came from subsystems sharing a thread or a
lifetime: the output's networking, storage, state and video all ran on its main thread; the operator's live
state ran under React; the hub ran imports on the same event loop as the live service; and bad data could
travel from an upload to the frame loop with checks only at the first hop.

## Decision
1. Every window's main thread hosts only what the platform requires (DOM, media elements, window handles,
   gestures). All other work runs in workers with their own heaps, connected by `MessageChannel` ports.
2. Every worker and child process has a supervisor that watches a heartbeat and restarts it from persisted
   state within a restart budget. A window whose invariants fail reloads itself and repaints the last cue
   from IndexedDB before it has a connection.
3. The operator-to-output fallback bus runs over `MessagePort`s handed over at window open, so neither
   main thread is on the path.
4. Data is validated with strict, bounded schemas at every boundary (HTTP, WebSocket, files, journal,
   imports, settings) and clamped at the point of use (render plan). A record that fails is quarantined with
   a visible indicator; nothing retries without a budget.
5. The hub runs the live service and the library in separate processes under a supervisor.

## Consequences
- The output window gains a link worker and a tiny supervisor; `apps/output/src/app.ts` is split along
  the host/worker line.
- The operator gains a core worker; React renders a posted view model.
- `packages/protocol` grows the worker-to-worker message types; `packages/client` becomes worker-safe
  (no `window` or `document` references outside the host layer).
- Deployment adds a second Node process in the container and two reverse-proxy path rules.
- Testing adds chaos scenarios and parser fuzzing to the suites.
