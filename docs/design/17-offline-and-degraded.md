# Design 17: Offline continuation and degraded mode

Requirement: from the moment a playlist goes live, the service continues on the
presentation PC if the WAN drops and if the hub becomes unreachable.

## Service cache

Filled on `goLive` from the manifest ([design/12](12-hub.md)).

| Window | Store | Contents |
| --- | --- | --- |
| Outputs | OPFS, keyed by hash | Every file in the manifest; fonts loaded into `FontFaceSet` |
| Operator | IndexedDB (library snapshot, resolved playlist, manifest) and Cache API (files) | Everything needed to re-render thumbnails and to serve the outputs if asked |
| Stage | Cache API | Fonts and look |

Each window reports `cache.progress`. The top bar shows the minimum across windows.
The apps themselves are served by a Service Worker per origin that precaches the app
shell on first load and serves it cache-first, so a reload with the hub down still
loads the app.

## WAN loss

No component on the PC talks to the internet during a service. The public hostnames
resolve through the venue router; with the WAN down, DNS answers may fail once the OS
cache expires. Two defences, both required:

1. Install step: a hosts-file entry on the presentation PC mapping `hub`, `op`,
   `out1`..`out6` and `stage` names to the NAS LAN address. Verified by the install
   checklist. This is the primary defence and makes WAN loss a non-event.
2. The degraded mode below covers the case where the hosts entry is missing or the NAS
   itself is down.

## Hub loss: degraded mode

Trigger: the operator's WebSocket closes or misses three consecutive `time.pong`s
(30 s), or fails to reconnect within 5 s of a close. Outputs enter degraded mode when
their own socket closes and they receive a `fallback.hello` from the operator.

### Fallback bus

- The operator holds the `WindowProxy` handles from `window.open` (ADR 0003). It posts
  `fallback.hello { seq }` to each handle with the output's origin as `targetOrigin`.
- Outputs verify `event.origin === operatorOrigin` and `event.source === window.opener`
  before accepting any message, then reply `fallback.ready { appliedSeq }` via
  `event.source.postMessage`.
- From then on the operator emits the same `live.delta` messages it would have received
  from the hub, with `seq` continuing from the last hub seq, computed by its own reducer
  (no longer optimistic: it is the authority).
- `at` timestamps use `Date.now()`; all windows share the OS clock. Outputs switch their
  `hubNow()` to `Date.now()` when in fallback.
- Health keeps flowing from outputs to the operator over the same channel so the dots
  stay live.
- Assets: outputs already hold the manifest in OPFS. If an output needs a file it lacks
  (a relaunch after an incomplete fill), it asks the operator via
  `fallback.file { hash }` and receives the blob from the operator's Cache API.

### Operator reload during degraded mode

The opener handles are lost. Relaunch outputs reopens windows by stable name; Chrome
returns the existing windows and navigates them; the new pages receive `fallback.hello`
from the new operator and re-arm from the operator's state. The screens show the last
frame throughout because the old document's canvas stays visible until the new document
paints (the output app paints its first frame from the cached live cue before anything
else).

### Timers, messages, media

All are reducer state and work unchanged. Media `ended` events flow over the fallback bus
from the audio master output.

### Hub returns

1. The operator reconnects and receives `welcome { seq }`.
2. If the hub's `mode` is `live` with the same playlist and its `seq` is lower than the
   operator's, the operator sends `live.event { k: 'adopt', state }`; the hub replaces
   its state, journals the adoption, and broadcasts a full `live.state`. Outputs apply it
   (no visible change: it equals what they have) and switch back to the hub bus.
3. If the hub was restarted and is `idle`, the operator sends `adopt` as well; the hub
   accepts because it has no live session.
4. If the hub has a different live playlist (another operator went live meanwhile), the
   operator shows a conflict dialog: keep local (adopt with `force`) or take the hub's.

## Outputs on other machines

Not at this venue. An output elsewhere has no opener and cannot join the fallback bus; it
would freeze on its last cue until the hub returns. Documented limit.

## Tests

- Playwright: start a service, block the hub's WebSocket route, verify GO still flips
  every output within one frame, unblock, verify adoption with no visible change.
- Playwright: reload the operator while degraded, Relaunch, verify continuity.
