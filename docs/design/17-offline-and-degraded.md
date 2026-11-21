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

Each window reports `cache.progress`. The top bar shows the minimum across windows. An output's
fill never loops: files that fail back off between fills, a full disk is given up on after a few fills
and shown red in health, and a manifest change cancels only the downloads whose file left it
([design/14](14-output-renderer.md) "Render-plan clamps and quarantine"). A file the output cannot get
yet (an outage, a slow NAS at service start) keeps its cue retrying with backoff and is never
quarantined.
The apps themselves are served by a Service Worker per origin that precaches the app
shell on first load and serves it cache-first, so a reload with the hub down still
loads the app. The operator's worker precaches by device class, chosen once at startup:
`./sw.js` (the venue PC, iPads, Android tablets) every built file, `./sw.js?set=compact`
(a phone, registered after load and idle) only what a phone opens, without the editor, the
live view, Setup, the settings pages or the import worker (design/28 §3.1).

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

Trigger: the operator's WebSocket closes, or goes 9 s without a `time.pong` while a service is live (pinged
every 3 s; 30 s when idle), and does not reconnect within the 5 s grace. Liveness is judged once a second by
the time since the last pong. A check that runs more than 2 s late (the operator's own thread was blocked: a
long task, a garbage collection) does not judge: pongs may be queued behind it, so it pings and judges one
ping period later, at most 12 s after the last pong; a dead hub is still lost within 12 s. A hub that answers with `bye unauthorized` or
`forbidden` (an expired session) is not lost: the grace is not armed, the outputs stay on the hub,
and the operator signs in again ([design/15](15-operator-app.md), Session expiry). Outputs enter degraded mode when
their own socket closes and they receive a `fallback.hello` from the operator. A refusal that arrives while
the operator is already the authority keeps it the authority until the sign-in; its hellos and heartbeats
then carry `hubRefused`, and a window on the bus takes nothing from the hub meanwhile, not even a state at
its own sequence: an output leaves the bus once the hub's sequence reaches the one it applied, which
assumes the hand-back of "Hub returns" below, and that cannot happen before the sign-in.

### Fallback bus

- Transport (design/25): the authority is the operator's **core worker**. When the operator opens or
  re-acquires a window it hands it a `MessagePort` (`offerPort`; the window accepts it only from
  `window.opener` at the operator origin) and transfers its own end into the core worker. From then on
  the core worker and the output's link worker talk directly; neither main thread is on the path, so
  a long task in either page delays neither the heartbeat nor a delta. Ports are offered again after
  a reload (the hub reports the window reconnected), on request, and at most every 10 s while the
  window never spoke on its current port, the port is closed, the bus runs over the relay, or, while
  the operator is the authority, a proven port has been silent for 10 s. A proven port that is merely
  quiet in hub mode (where windows have nothing to say on the bus) is left alone. The window keeps the
  newest.
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
second 5 s grace) when it held it less than two minutes ago (a state that broke the invariants is
never persisted, so it resumes from the last good one); the host hands it fresh ports to every
window, which are re-introduced with `fallback.hello`. Outputs that went 5 s without a heartbeat in the
meantime left the bus and hold their frame; the hello brings them back. Key presses made during the
restart wait in the host's outbox and are applied once.

When the operator page itself goes away the host posts `fallback.hub { hubUp: true }` to every window
over the relay on `pagehide`, so the outputs leave the bus at once instead of after the 5 s silence.

### Output link restart during degraded mode

The output's bus client lives in its link worker. If that worker dies, the screen keeps its frame (the
render worker is untouched); the host restarts it within about 4 s, the new worker restores the live
state from IndexedDB (written on every applied state, coalesced) and the files from OPFS, and asks the
opener for a fresh port (`ordo.port.request`); until one arrives, the host relays `window.postMessage`
from the opener to the new worker. A clip or audio cue that ended while no link worker was alive is
still reported to the authority (hub or operator) by the new one, from the host's slot status and its
replay of unacknowledged media events, so `onEnd: advance` still advances. A newly accepted port is
answered at once with `fallback.ready`, so the operator proves it even while the hub is the authority.
The host detects a closed operator tab (`window.opener` closed or nulled by Chrome) on every 250 ms
tick, releases its relay and tells the link worker, which leaves the bus at once.

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

### What a screen keeps of the running service

Design/29 §2.3 M2, A22 (live-by-ref). An output, the stage and the operator's core no longer clone the whole
state on every GO. A GO writes a small record: the state without its copy and cue list and the copy's id. The copy
and the cue list are saved ONCE per service, in pieces (one record per presentation, the cue list, the head, and
last a marker that names them), a task of their own after the window presented a frame (at the latest 5 s after the
copy arrived), never inside the task that applies a message; a newer service aborts an older save and removes its
records. A restart joins what the marker names and paints only a complete copy whose id is the small record's; it
then tells the hub which copy it holds, so the hub sends the state by name. A copy that did not come from the hub
(the bus, the operator's own resolve) is saved whole as before and never held. A save that fails (a full disk) is
one diagnostic line; a restart then waits for the hub, as a window with no cache does. So does a restart in the seconds
between the GO that named a new copy and the save of its pieces (a window's record names the copy at once, its pieces
follow a frame or at the latest 5 s later): the window waits for the hub, and a screen whose hub is also down then paints
nothing, where writing the whole state in that window would put the clone of the whole service (4 to 37 ms at 6 to 20
MiB) back on the GO that follows a take-over. The operator's core keeps, in that case, the commands the hub had not
confirmed and the ids of the actions it had processed (only the state is dropped), and as the authority it writes its
record whole until the copy is saved.

### Hub returns

1. The operator reconnects and receives `welcome { seq }`.
2. If the hub's `mode` is `live` with the same playlist and its `seq` is lower than the
   operator's, the operator sends `live.event { k: 'adopt', state }`; the hub replaces
   its state, journals the adoption, and broadcasts a full `live.state`. Outputs apply it
   (no visible change: it equals what they have) and switch back to the hub bus.
3. If the hub was restarted and is `idle`, the operator sends `adopt` as well; the hub
   accepts because it has no live session.

   The operator measures `adopt` first (design/27 §3.4). The hub closes a socket whose
   message is over 16 MiB, so above 15 MiB it is never sent: the operator keeps the service
   and holds it to End service, exactly like a service it started without the hub (below),
   and says so. At End service it ends the hub's older copy of the same playlist by adopting
   its own idle state (a few hundred bytes); a hub that went on to another playlist is
   followed. Since design/29 D13 no goLive carries a takeover warning any more (A10): above
   32 MiB it is refused (W58), and past the GO-lead size it carries W59's line ("Going live
   beside the running service" below); a service between 15 and 32 MiB is held after an
   outage as described here until handback-ref (design/29 M3) removes the limit.
4. If the hub has a different live playlist (another operator went live meanwhile), the
   operator shows a conflict dialog: keep local (adopt with `force`) or take the hub's.

## Going live beside the running service

The take-over's own apply holds the hub's live loop only for the parse of the prepared copy and two small writes (the
copy is written by name, once: design/12 "The running service by reference").

Design/29 §2.3 M8. Pressing Go live while a service runs (to pick up a fixed slide, or the next service)
never holds the running one: the hub prepares the new playlist beside it (design/13 "Prepare before goLive",
design/12), and until it is ready the screens keep showing the current service and GO, Next and Clear keep
applying to it on time. The operator's toast (W41, design/29 §3) shows the progress: "Getting 'Sunday
service' ready to go live (40 %). The screens keep showing the current service until then." (the second
sentence only while a service is live). While a service is live and the prepare has taken 5 s, the toast
offers the hub's saved copy, if it has one: "Go live from the copy saved 3 days ago". Pressing it goes live
from that copy at once, and the goLive carries the existing note ("Went live from the copy of this playlist
saved 3 days ago …"). The library's copy may take up to 30 s while it keeps arriving (no bytes for 1.5 s ends
it, and then the saved copy is used as before). End service pressed while a Go live is prepared cancels
that Go live. With the hub unreachable, Go live is sent at once and follows "Going live without the hub".

A service too large is refused before anything changes on the screens (W58, above 32 MiB); one past the
size whose first save on a screen passes the GO lead goes live with W59's critical line in the degraded
list ("Going live with this service takes a few seconds on the screens. Go live before the service
starts."). Both sizes are defaults until a venue PC confirms them (design/29 D13, owner question 14).

## Going live without the hub

The gap the fallback bus leaves: the hub is down **before** the service (the NAS failed overnight). The
fallback bus carries a service that is already live; a goLive needs the playlist resolved into its frozen
copy, which only the hub did. Now the operator PC can do it too, when the operator asks.

### Preparing: Download for offline use

The playlist editor on the venue PC (operate PIN, full profile) has **Download for offline use**. It
resolves the playlist from the operator's copy of the library (the same `resolvePlaylist` the hub runs,
`packages/domain/src/goLive.ts`) and fills the operator's file cache (Cache API; the operator app asks the
browser for persistent storage on every profile, so the files are not evicted under pressure) with every
media file and font the service uses, and the shape files and pre-rendered slides' files the slides draw (listed
by name: the PC has no file index, design/29 §1.7). The operator chooses when: the evening before, a week before, or on
arrival. The status line says whether every file is on this PC; it re-checks when the playlist changes.
The library itself (playlists, presentations, settings) is already kept on the PC by the core worker.

### Going live

Every Go live button goes through `startService`. With the hub connected nothing changes. Without it the
operator is asked (_Go live without the hub?_): the dialog resolves the playlist locally and lists files
that are not on this PC (text slides show regardless). On confirm the core:

1. resolves the playlist with `localDigest` (a synchronous FNV-based id; the hub keeps SHA-256);
2. becomes the authority (`activateFallback`) and **holds** the service;
3. applies `goLive { resolved }` with the shared reducer and broadcasts it over the fallback bus.

Output windows get the service and its files over the fallback bus (`fallback.file`), as in degraded mode.
When the PC starts with the NAS already down, every page loads from its service worker: the operator
starts offline with the last role used on this PC, and Launch outputs opens windows that load from their
own caches and remember their configuration.

### The hold: the hub never takes over a service in progress

A service the PC started is held to its end. The hub never had it, and handing a running service to it
mid-song is a risk with no benefit, so:

- the operator ignores the hub's state while held: no `live.adopt`, no conflict dialog, one notice that
  the hub is back and takes over after End service;
- `fallback.hello` and the 2 s heartbeat carry `hold: true`; a held output window ignores the hub's state
  and deltas whatever their sequence (an idle hub's seq is usually higher), keeps its picture if the
  operator falls silent instead of following the hub, and remembers the hold across a reload (at most 8
  hours, so a window is never stuck);
- the hold survives an operator core restart and page reload (`CoreSnapshot.held`) for the same 8 hours;
  older, the operator follows the hub and nothing starts unasked.

**End service** releases the hold. With the hub connected the operator asks for its state; both idle, the
authority returns to the hub with nothing transferred, and the windows are told `hubUp`. With the hub
still away the PC stays the authority (and may go live locally again) until the hub returns.

Services the hub started keep the existing behaviour below (_Hub returns_).

## A GO never waits for drawing

<!-- r2b:units-live -->
Owner decision 2026-11-13 ("fill in when ready with a fade"). An output flips a GO on its scheduled frame with
what it has: a slide whose slow parts (geometry units now; effect units and decorations from effect-units) are
not ready is shown at once without them, their simple stand-ins drawn this time, and they fade in over 0.3 s as
soon as they are made (design/14 "Late units"). Nothing that can take more than one task runs on a GO's path:
- a jump to a slide that was not prepared draws it in its own live job without waiting for units; a GO while the
  slide's arm or warm job is still preparing it hurries that job (it stops waiting at its next turn);
- the late parts are made below the live and armed cues' work, and drawn again in place with a cross-fade at
  most once per 0.3 s a slide, never ahead of a GO's raster; a GO during that fade ends it and flips at once;
- the live playlist's slides are prepared ahead, in cue order, up to two thirds of the unit cache, and every GO
  pauses that work for its own.

Health counts the slides shown with late parts (`unitsLate`; the operator's note W49 "Parts of 2 slides appeared
a moment late on this screen."). For a venue that wants the earlier behaviour, the output URL switches
`?late=next` (late parts at the slide's next draw, no fade), `?warm=off` (no warm-up) and `?effects=base`
(62a1c3a's drawing of effects and decorations) sit beside `?renderer=2d` (`apps/output/src/switches.ts`). Tests:
`e2e/units-live.spec.ts` (a GO to a slide not prepared, a GO 50 ms after its arm, the warm-up ahead), the asset
worker, link-core, stacks and compositor tests.
<!-- /r2b:units-live -->

## Outputs on other machines

Not at this venue. An output elsewhere has no opener and cannot join the fallback bus; it
would freeze on its last cue until the hub returns. Documented limit.

## Tests

- Playwright: start a service, block the hub's WebSocket route, verify GO still flips
  every output within one frame, unblock, verify adoption with no visible change.
- Playwright: reload the operator while degraded, Relaunch, verify continuity.
- Playwright (`e2e/local-golive.spec.ts`): download a playlist, kill the hub, go live from the PC, verify
  the background from the downloaded files; restart the hub mid-service and verify it is neither given
  the service nor followed; End service hands back. Second test: the PC starts with the hub already down
  (pages from service workers, library from cache), goes live and launches outputs from cache.
- Unit: `apps/operator/test/liveCore.test.ts` (held service), `packages/client/src/link.test.ts` and
  `fallback.test.ts` (hold on the bus), `packages/domain/src/goLive.test.ts` (shared resolver).
- Playwright (`e2e/chaos-operator.spec.ts`): kill the operator's core worker mid-service (GO pressed
  meanwhile reaches the hub exactly once); block the operator's main thread for 2.5 s while a GO is
  dispatched inside the core (it reaches the hub in about 100 ms) and for 7 s while degraded (the
  outputs stay on the fallback bus); with the hub dead, GO reaches the outputs and every window's bus
  runs over its direct port.
