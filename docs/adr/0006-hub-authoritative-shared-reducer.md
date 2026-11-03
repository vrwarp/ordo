# ADR 0006: Hub-authoritative live state with a shared reducer

## Decision
Live state is produced by one pure reducer in `packages/live-state` run by the hub (the
authority), the operator (optimistically, rebased on hub deltas) and every output and
stage window (to apply deltas). Events are journaled by the hub with a sequence number.

## Reasons
- Determinism: every window computes the same state from the same events, so the
  fallback bus can swap the authority from hub to operator without a second code path.
- The operator UI never waits on a round trip.
- Replayable journal for diagnostics and tests.

## Consequences
- The reducer cannot read clocks or random numbers; `at` times and ids are in events.
- Property tests check that applying any event sequence in order on any client yields the
  hub's state.
