# Design 15: Operator app

`apps/operator`: React 19, TypeScript, Vite, served from `op.<venue>.synology.me`. It
contains the operator view, the editor, settings and imports. It never creates a WebGPU
device.

## Structure: a host and a core worker (design/25, phase C)

```
main thread (host)                                core worker (src/core/core.worker.ts)
──────────────────                                ─────────────────────────────────────
React UI rendering the view model,                HubConnection (socket + clock), LiveCore (optimistic
Zustand read models (useLive, useLibrary),        state, pending re-submission, fallback authority with
keydown → post action (and the clear-all hold),   its 5 s grace, loop auto-advance), FallbackHost fed with
Stream Deck HID I/O, MIDI, window.open and        MessagePorts, actionToEvent with the GO lead, health
window handles, the MessagePort handoff,          aggregation, library store (snapshot + library.delta +
WebRTC program views, the supervisor of the       IndexedDB copy) and search index, service-cache fill and
core and thumbnail workers, the outbox            fallback file serving, Stream Deck key images
                                                  (OffscreenCanvas), error budgets, state persistence
```

- `src/core/protocol.ts` is the only contract between the two. The core posts a **view model in
  slices** and only the slices that changed: `live` (the live state without `resolved`, authority,
  reconcile, pending count, hub connection, own cache, clock), `resolved` (posted once per new
  resolved playlist and referenced by revision), `health`, `budgets`, `stats` (main-thread stall,
  bus endpoints). The library is posted once in full, then as patches of changed entities (by
  reference identity in the worker). The main thread re-assembles `state.resolved` from its cached
  copy, so React memoization by identity keeps working.
- `src/services/controller.ts` is the main-thread facade with the API the views always used
  (`go`, `select`, `clear`, `goLive`, `dispatch`, `hub.send` …). It turns calls into posted
  actions and applies the view model to `useLive`. Window, audio-gain and launch actions stay on
  the main thread (they need a gesture, a window handle or a settings PUT); everything else goes to
  the core.
- Local library writes after a successful API call (`upsertLocal`, `removeLocal`, `saveSettings`)
  update the read model at once and are forwarded to the core, which does not echo them back. A write
  that arrives before the core has posted its library in full (the 1.5 s after a core restart) does
  not move the posting baseline: the first full post carries it, and the IndexedDB copy, when it
  arrives, is applied underneath the writes already made instead of replacing them.
- Library search runs in the core (`useSearch`); while the core restarts the same index runs on the
  read model.

### GO latency

The `keydown` handler maps the key and posts `{ t: 'action', aid, action }`; the core computes the
event (`actionToEvent` with the GO lead), applies it optimistically and writes it to the socket in
the same task. Nothing on the path waits for React. Every action carries an id (`aid`) that becomes
the command id, so a re-sent action is de-duplicated by the hub.

### Supervision and recovery

`CoreClient` (`src/core/client.ts`) runs the core under the `Supervisor` from `@ordo/client`
(heartbeat 250 ms, dead after 1.5 s, at most five restarts a minute) and the thumbnail worker under
the same supervisor (dead after 5 s). On a core restart:

1. The new core restores from IndexedDB (`core` key, validated with `isLiveStateShape` and
   `checkInvariants`): the confirmed hub state, the unconfirmed commands (re-proposed and re-sent
   with their ids on the next full state), the ids of actions already applied, and the authority.
   A core that was the fallback authority less than two minutes ago resumes it at once. Only states
   that pass the invariants are ever persisted: when the live state breaks them (the core then asks
   for a restart), the last good snapshot stays on disk (with a fresh time, so the authority still
   resumes), and the restarted core continues from it.
2. The host re-offers a fresh port (and relay) to every known window.
3. The host re-sends every action the old core did not acknowledge. The core acknowledges an action
   only after the snapshot that contains it is written, so a crash between a keypress and the hub
   send loses nothing and applies nothing twice.
4. The top bar shows "Recovering…" while a restart is in progress, or while the core misses
   heartbeats (over 750 ms) and this thread has been ticking on time.

The supervisor ignores missing heartbeats after a stall of its own thread (the heartbeats are
queued behind the late check), so a long React commit never restarts a healthy core; the
"Recovering…" indicator applies the same correction (`src/lib/recovering.ts`), so it does not flash
after a long main-thread task.

### Session expiry

A `bye` with reason `unauthorized` or `forbidden` (an expired or revoked session, a sign-out
elsewhere) is not a hub loss: the hub is up and the outputs, which authenticate with their own
tokens, stay on it. `HubConnection` emits `auth` once and backs its reconnects off to 30 s, doubling
to 2 minutes; the core neither arms nor runs the fallback grace while refused, posts `hub` `auth` to
the host and sets `hubRefused` in the live slice (the top bar says "Session ended: sign in again
(outputs stay on the hub)"; `src/lib/hubStatus.ts` picks the line). The host calls
`refreshSession()`; with no role left, the app keeps the shell, the output windows and the core
mounted and shows the sign-in view over them, with one persistent banner (no toast per attempt;
operator keys are off meanwhile). After a successful sign-in the host posts `hub.resume` and the
core reconnects at once and rejoins as the hub's client.

A refusal while the operator is already the fallback authority (the hub came back after the
fallback took over, and this operator's session had expired meanwhile) keeps it the authority until
the hand-back after sign-in: the outputs stay on the fallback bus and never jump back to the hub's
older state. In that state the UI must not block the service: the top bar reads "Running from this
PC — session ended; sign in to hand back to the hub", the sign-in is a non-modal card in the corner
of the live view (`.signin-overlay.nonmodal`) whose banner says the same, the PIN field is not
auto-focused (a focused text field would take the GO key), and the keyboard, Stream Deck and MIDI
keep working (`keysOn` stays true while `authority === 'fallback'`), so a volunteer advances slides
during worship and signs in between songs. Once signed in, the hub accepts the socket, the core
adopts the operator's state at the hub (the "Hub back: handing over…" line wins over the refusal
text) and the outputs return to the hub bus. Covered end to end by `e2e/chaos-operator.spec.ts`.

### Main-thread watchdog

The host posts a tick every 250 ms; the core measures the gap (`mainThreadStallMs`, peak over the
last minute) and logs stalls over 1 s. A stall delays keys (they are handled on the main thread by
necessity) but neither the hub socket, the fallback heartbeat, nor a GO from a path that does not
touch the main thread. The top bar shows "UI stalled" with the peak, and the checklist tells the
volunteer to use the Stream Deck as the second route.

### Error budgets

Counted per subsystem (`src/lib/budgets.ts`): socket drops, command rejections, fallback
activations and cache-fill failures in the core; core restarts and Stream Deck/MIDI errors on the
host. An exceeded budget turns the top bar red with exactly one action (Reconnect, Resync, Reload
operator, Diagnostics, Retry download, Reconnect Stream Deck); a cache fill whose budget is spent
stops retrying until the operator asks, and the operator's own cache numbers then describe the new
manifest (nothing filled), not the previous service's finished fill. The printed checklist lists each red state with its action.

## State

- `live` (`useLive`): read model of the core's live slice plus host-side isolation state
  (recovering, workers, budgets, core stats).
- `library` (`useLibrary`): read model of the core's library store; the core keeps the IndexedDB
  copy and applies `library.delta`.
- `ui`: selection, panels, dialogs. Persisted to `localStorage` per device.
- The hub bus and the fallback bus both live in the core ([design/17](17-offline-and-degraded.md)).

Every action in the UI dispatches an `Action` from `packages/surfaces`; actions map to
reducer events. Keyboard, Stream Deck and MIDI dispatch the same actions.

## Operator view components

| Component      | Notes                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TopBar`       | Connection, WAN, cache, output dots, clock, Launch and Relaunch                                                                                        |
| `PlaylistPane` | Virtualized list; drag to reorder when not live                                                                                                        |
| `SlideGrid`    | Sections as headed groups following the arrangement; thumbnails from the thumbnail worker; live and armed markers; click to select, double-click to GO |
| `ProgramView`  | One `<video>` per output fed by WebRTC; health overlay                                                                                                 |
| `StageTools`   | Message box, recent messages, timers                                                                                                                   |
| `LayerBar`     | Five chips with clear buttons; media transport and remaining time; audio meters                                                                        |

Thumbnails: a supervised worker runs the shared text rasterizer and a 2D compositor at 320x180,
cached by (slide rev, look). The main thread never rasterizes; a restarted thumbnail worker gets the
fonts again and re-renders the jobs that were in flight. Stream Deck key images are drawn in the core
worker on an OffscreenCanvas; only the HID writes stay on the main thread.

## Keyboard

A single `keydown` listener on `window` with the key map from settings. Handled keys call
`preventDefault`. Text inputs opt out by focus. The handler only maps the key and posts the action
to the core worker (plus the clear-all hold timer); the core applies it optimistically and sends it.

## Launching outputs

1. The operator clicks Launch outputs (a user gesture).
2. The app requests `window.getScreenDetails()` (Window Management API permission,
   remembered per origin). For each enabled output it finds the screen matching the saved
   `ScreenRef` by label, then by position; unmatched outputs open on the primary screen
   and show a placement dialog.
3. `window.open(outputUrl + '?token=…', 'ordo-out-' + k, 'popup,left=…,top=…,width=…,height=…')`
   with the screen's bounds. The handle stays on the main thread (open, close, focus only).
   The host calls `offerPort(win, origin, outputId)` and transfers its end into the core, which
   registers it with the fallback host; it offers again 1.5, 4 and 8 s later (the first offer may
   reach `about:blank`), whenever the window asks (`ordo.port.request`), when the hub reports the
   window reconnected, and every 10 s while the window's bus is silent. A legacy relay over
   `window.postMessage` is handed to the core alongside, for a window that never takes a port.
4. The output, on load, calls `requestFullscreen({ screen })` for its screen. Chrome
   allows this on a window opened by a gesture.
5. Relaunch closes every handle, waits 500 ms, and repeats.
6. Stage opens the same way with the stage origin.

Window names are stable so a reload of the operator can re-acquire windows by opening
the same name (Chrome returns the existing window for a matching name, re-navigating it;
outputs tolerate a navigation by re-arming from the hub state).

## Program view

Receive-only `RTCPeerConnection` per output with host ICE only. Each `<video>` is muted,
`playsInline`, 320x180. Reconnects when the output reconnects.

## Editor

- Canvas-based editor with `react-konva` for selection, transforms and guides; the
  visual preview inside the editor uses the shared rasterizer for text so WYSIWYG holds.
- Property panel bound to the selected object's schema.
- Saves via `PUT /presentations/:id` with `rev`; 409 shows the reload dialog.
- Disabled with a banner when the presentation is referenced by the live playlist.

## Settings

Outputs and looks, audio devices and pairs, key map, Stream Deck pages, MIDI mappings,
PINs, output tokens, backups, diagnostics export. Each page is a form over the matching
`/settings/*` resource.

## Service checklist

A printable page (`/checklist`) generated from the current settings: launch steps, health
colours, Relaunch, and the ProPresenter switch procedure.
