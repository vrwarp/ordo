# Design 16: Stage display

`apps/stage`: React, DOM and CSS only, served from `stage.<venue>.synology.me`, opened by
the operator on the stage screen (token in URL like an output). No WebGPU, no media.

## Content

| Region    | Content                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Top left  | Clock, 24 h or 12 h per settings, updated every second                                                                                                                               |
| Top right | Elapsed timer when running (label and `mm:ss`), countdown to service when active                                                                                                     |
| Centre    | Current slide lyric text, large, with the section label; next slide text below at 60 % size and reduced opacity. Non-song slides show their first text box (a picture slide its own extracted text, design/27 §11) or the presentation title |
| Bottom    | Operator message, high contrast, with a 1 s fade in and out; multiple messages stack newest first                                                                                    |

Layout values come from the Stage look's `PropsRule.style` boxes so the operator can
adjust sizes without code. Fonts load from the service cache through the Cache API.

Slide text is shown as people read it (`readableText`, design/27 §3.2): automatic verse
numbers and bullets of imported text boxes are written in front of their paragraphs.

## Behaviour

- Applies `live.delta` with the shared reducer (in the link worker, below); the page renders the view model derived from `LiveState`.
- Flips at `at` using the same clock offset as outputs, with `setTimeout` to the
  scheduled time; a one-frame error is acceptable on the stage screen.
- Reports `health` with `presented` and `missed` derived from rAF, so the operator sees
  the stage screen as a dot too.
- Holds a Wake Lock, hides the cursor, fullscreen on its assigned screen.
- Works over the fallback bus like an output.

## Threads (design/25, phase E)

The stage has the output's shape in miniature: the main thread hosts, a supervised **link worker**
computes.

```
main thread (host, host.ts)                     link worker (link.worker.ts + link-core.ts)
───────────────────────────                     ───────────────────────────────────────────
React renders the posted StageView,             OutputLink (role 'stage'): WebSocket, clock sync,
text fitting and message fades,                 live mirror and reducer, fallback-bus client,
FontFace → document.fonts,                      config (API) and its IndexedDB copy,
rAF frame stats, long tasks,                    state persistence (IndexedDB, debounced),
wake lock, fullscreen, service worker,          fonts from the Cache API service cache,
window.opener (closed check, postMessage        flip timing, clock text, timers, message expiry,
relay), acceptPorts, Supervisor                 invariant checks, health and the log ring
```

- **View model** (`protocol.ts`, `view.ts`): the worker posts a `StageView` whenever what the stage
  draws changes: current and next text, section label and position, clock text, countdown, elapsed and
  media-remaining timers, active messages, the layout from the Stage look, the bus and the hub clock
  offset. It re-evaluates on every quarter second (aligned so the clock flips on the second) and at each
  message expiry, and posts only when the view differs. The main thread never reads the live state.
- **Fonts**: a worker's `FontFaceSet` does not reach the DOM, so the worker fills the Cache API service
  cache (hub, else the operator over the fallback bus), reads each needed font's bytes and transfers them
  to the host, which adds a `FontFace` to `document.fonts` and acknowledges. The host keeps the set of
  loaded hashes across worker restarts.
- **Supervision**: `Supervisor` from `@ordo/client` watches the worker's 250 ms heartbeat; a worker that
  misses 2 s of heartbeats, throws, or reports fatal is terminated and started again (budget 5 a minute).
  While it restarts the last `StageView` stays on screen. A worker that exhausts its budget reloads the
  page (at most 3 reloads a minute).
- **Offline start**: the worker reads the last config and live state from IndexedDB (`ordo-stage`)
  before it connects and paints them, so a reload or a worker restart with the hub down still shows the
  last lyrics. A cached state that violates the invariants is not painted.
- **Fallback bus**: the host relays `window.postMessage` from the opener to the worker over a
  `MessageChannel` (`MuxEndpoint`, as in the output), and transfers any port the operator hands over
  (`acceptPorts`) straight into the worker. After a worker restart the host asks the opener for a fresh
  port (`requestPort`); the relay carries the bus meanwhile. The host checks `window.opener.closed`
  every second and forwards it (`FallbackClient.openerClosed`), since a worker cannot see the opener.
- **Invariants as code**: after every applied state the worker runs `checkInvariants`. A violation keeps
  the last good view on screen and asks for a full state (hub `live.resync`, or `fallback.ready` on the
  bus); if the full state that answers still violates, the worker asks the host to reload the window. A
  delta or state the mirror rejects (malformed, sequence gap) also resyncs, through `OutputLink`'s resync
  budget: at most 10 full-state requests a minute. Past that (a bus that keeps answering with a malformed
  state) the stage keeps the last good view, logs it once, reports `live state: no valid state after 10
  resyncs in a minute ...` as the health error and asks once a minute until a state applies again. The
  output's link has the same budget.
- **Health**: the worker assembles `OutputHealth` every second from its own counters and the host's
  stats (frames, fps, long tasks, the supervisor's worker table). Main-thread watchdog, as in the output
  (design/14): the host posts a `tick` every 250 ms; the worker keeps the longest gap between ticks since
  its last health, counting the gap still open when it sends (a main thread stalled right now has sent
  nothing), reports it as `mainThreadStallMs` and starts again. A healthy stage reports about 250 ms (the
  tick period plus timer jitter); a main thread blocked for 900 ms reports 900 ms in the next health and
  250 ms again after it. (It used to be the time since the host's 1 s stats message, read by the worker's
  own 1 s timer: the phase difference of two timers, 43 to 318 ms on a healthy stage.)
- **Superseded / new version**: a `bye` from the hub is handled in the worker; `version` asks the host to
  reload, `superseded` stops the worker and the host closes the window.
- **Diagnostics and tests**: `ordoStage.telemetry()` / `ordoStage.view()` in the console. With `?test=1`,
  `window.__ordo` exposes `telemetry()`, `view()` and `chaos` (`killWorker('link')`, `inject('delta' |
  'state', msg)`, `badState()`); `e2e/chaos-stage.spec.ts` kills the worker (hub and fallback bus) and
  feeds malformed and invariant-violating messages.
