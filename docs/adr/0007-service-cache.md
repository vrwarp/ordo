# ADR 0007: Service cache filled on go-live and editing locked while live

## Decision
Making a playlist live freezes it and the presentations it references, publishes an
immutable manifest of every asset the service needs, and fills caches on every window
before the service starts. Editing those entities is refused with 423 until End service.

## Reasons
- The service must continue without the WAN and without the hub; a complete, immutable
  set of assets is the only way to promise that.
- A frozen playlist means arming never finds a changed slide.
- The venue chose a hard lock over live edits.

## Consequences
- Fixing a typo mid-service means End service, edit, Go live again (the cache is
  content-addressed, so re-filling is near instant).
- The operator top bar must show cache completeness.
