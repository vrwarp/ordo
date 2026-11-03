# Design 17: Offline continuation and degraded mode

Requirement: from the moment a playlist goes live, the service continues on the
presentation PC if the WAN drops and if the hub becomes unreachable.

## Service cache

Filled on `goLive` from the manifest ([design/12](12-hub.md)).

| Window   | Store                                                                           | Contents                                                                    |
| -------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Outputs  | OPFS, keyed by hash                                                             | Every file in the manifest; fonts loaded into `FontFaceSet`                 |
| Operator | IndexedDB (library snapshot, resolved playlist, manifest) and Cache API (files) | Everything needed to re-render thumbnails and to serve the outputs if asked |
| Stage    | Cache API                                                                       | Fonts and look                                                              |

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

- Transport (design/25): the authority is the operator's **core worker**. When the operator opens or
  re-acquires a window it hands it a `MessagePort` (`offerPort`; the window accepts it only from
  `window.opener` at the operator origin) and transfers its own end into the core worker. From then on
  the core worker and the output's link worker talk directly; neither main thread is on the path, so
  a long task in either page delays neither the heartbeat nor a delta. Ports are offered again after
  a reload, on request, and while a window's bus is silent; the window keeps the newest.
- Legacy path: the operator's main thread also relays `window.postMessage` to the core for each window.
  Until a window has spoken on its current port, the core posts to both channels (duplicates are
  harmless: the mirror drops a delta it already applied; hellos and heartbeats are idempotent). Once
  the window answers on the port, the port alone is used, unless it falls silent for 5 s while the
  relay hears the window. Diagnostics shows the channel per window ("direct port" / "window relay").
- The operator posts `fallback.hello { seq }` to each window. Over the relay the output verifies
  `event.origin === operatorOrigin` and `event.source === window.opener` before accepting any message;
  over a port, trust was established at the handoff. It replies `fallback.ready { appliedSeq }`.
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

### Operator core restart during degraded mode

If the core worker dies while it is the authority, the supervisor restarts it within about 1.5 s. The
new core restores the operator's own state from IndexedDB and resumes the authority at once (no
second 5 s grace) when it held it less than two minutes ago; the host hands it fresh ports to every
window, which are re-introduced with `fallback.hello`. Outputs that went 5 s without a heartbeat in the
meantime left the bus and hold their frame; the hello brings them back. Key presses made during the
restart wait in the host's outbox and are applied once.

When the operator page itself goes away the host posts `fallback.hub { hubUp: true }` to every window
over the relay on `pagehide`, so the outputs leave the bus at once instead of after the 5 s silence.

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
- Playwright (`e2e/chaos-operator.spec.ts`): kill the operator's core worker mid-service (GO pressed
  meanwhile reaches the hub exactly once); block the operator's main thread for 2.5 s while a GO is
  dispatched inside the core (it reaches the hub in about 100 ms) and for 7 s while degraded (the
  outputs stay on the fallback bus); with the hub dead, GO reaches the outputs and every window's bus
  runs over its direct port.
