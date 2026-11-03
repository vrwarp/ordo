# ADR 0003: Origin isolation with opener kept

## Context

Process isolation between operator and outputs is the core reliability mechanism. The
founding document used `noopener` and BroadcastChannel for degraded mode; BroadcastChannel
cannot cross origins, so that degraded mode cannot work with per-role origins. The venue
requires the service to continue when the hub is unreachable.

## Decision

Each role has its own origin served with `Origin-Agent-Cluster: ?1`. Outputs and the
stage are opened by the operator with `window.open` keeping the opener. Across
origin-keyed agent clusters, cross-origin windows have no synchronous access to each
other; only `postMessage`, `closed`, `close()` and navigation. The opener handle is used
only for the fallback bus when the hub is unreachable, and for Relaunch.

## Reasons

- Chrome assigns origin-keyed agent clusters to separate processes where resources allow,
  independent of the opener relationship; isolation is preserved.
- A per-PC fallback bus with no hub is impossible without a window handle.

## Consequences

- The operator origin sends `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
- Outputs verify `event.origin` and `event.source === window.opener` before accepting
  fallback messages.
- An operator reload loses handles; Relaunch by stable window name recovers them.
