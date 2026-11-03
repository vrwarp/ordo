# Design 25: Isolation and hardening against bad data and unknown bugs

Status: proposed, with a phased plan. Companion ADR: [0014](../adr/0014-supervised-isolation.md).

## Why

The review of 2026-11-03 found no structural fault, but its twelve blocking items share a shape: a
subsystem failed in a way nobody had predicted, and the failure spread because the subsystem shared a
thread or a lifetime with something that must not stop. Outputs stuck on a bus because the only exit was
a message from a page that no longer existed. A liveness check that counted sends instead of time. A cache
wiped by an idle manifest. Each was found by testing one scenario; the next one will be a scenario nobody
tested.

The defence against that is not more scenarios. It is to arrange the system so that any single piece can
be wrong, slow or dead without taking the audience screens with it, and so that bad data stops at a
boundary instead of flowing to the frame loop. Two principles, applied everywhere:

1. **A main thread hosts; it does not compute.** Every window's main thread owns only what the platform
   forces onto it (DOM, media elements, window handles, user gestures, permissions). Everything else runs
   in a worker with its own heap, its own event loop, and a supervisor that restarts it.
2. **Data is validated where it enters and clamped where it is used.** Every message, file and record is
   checked at its boundary against a strict schema, and every consumer treats what it receives as hostile:
   bounded, defaulted and quarantined on failure.

## Where the main threads stand today

| Window | On the main thread today | Should remain on the main thread |
| --- | --- | --- |
| Output | WebSocket and clock sync, live-state mirror and reducer, OPFS service-cache fill (3 parallel downloads buffered as blobs), IndexedDB save of the full live state, props scheduling and Intl formatting, video elements and `requestVideoFrameCallback`, health assembly, program-view canvas, diagnostics overlay | Video and audio elements, the transferred canvas, fullscreen, wake lock, keyboard, receiving `postMessage` from the opener |
| Operator | React UI, WebSocket, optimistic reducer, fallback-bus host (window handles), service-cache fill into the Cache API, library IndexedDB, keyboard, Stream Deck and MIDI drivers, WebRTC receivers | React rendering, keyboard, HID and MIDI (require the window), `window.open` and window handles, WebRTC receivers |
| Stage | React, WebSocket, mirror, fonts, timers | React rendering |
| Hub | HTTP, WebSocket, live service, SQLite, job orchestration, ProPresenter import (synchronous, CPU-bound), font parsing, PPTX XML parsing | HTTP and WebSocket endpoints, the live service |

The output's render and asset workers already follow principle 1. The rest does not.

## Target architecture

### Output window

```
main thread (host)                        link worker                     render worker        asset worker
──────────────────                        ───────────                     ─────────────        ────────────
video/audio elements, canvas transfer,    WebSocket + clock sync,         WebGPU/2D frame      text raster,
fullscreen, wake lock, keys,              live mirror (reducer),          loop, stacks,        image decode,
MessagePort relay from the opener,        fallback-bus client, OPFS       flips, telemetry     fonts, props
rVFC → VideoFrame transfer,               fill (streamed), IndexedDB
supervisor of the three workers           persistence, health assembly,
                                          cue planning, arm orchestration
```

- **Link worker** (new): everything that is not DOM moves here. It talks to the render and asset workers
  directly through `MessageChannel` ports handed over by the main thread at startup, so arming a cue never
  crosses the main thread. The main thread receives only "play this video now", "load this file into a
  video element", "go fullscreen", and sends back "video frame", "video ended", "key pressed".
- **Supervisor** (new, main thread, tiny): creates the three workers, holds their ports, and watches a
  heartbeat from each. A worker that misses heartbeats for 2 s or posts an `error` is terminated and
  re-created from scratch; the re-created worker rebuilds from the persisted state (IndexedDB for the live
  state, OPFS for files) and re-arms. The render worker's rebuild is the existing device-loss path. While a
  worker restarts, the last frame stays on screen through the existing 2D hold canvas.
- **Main-thread watchdog**: the link worker measures the time since the main thread's last 250 ms tick and
  reports it in health as `mainThreadStallMs`. A stalled main thread cannot be fixed from inside the
  window; the operator shows it and can relaunch. This closes the one gap a supervisor cannot cover.
- **Crash-only restart**: if the link worker's invariants fail (no frame presented for 3 s while live, a
  reducer exception on a delta, OPFS unusable), the window reloads itself. A reload paints the last cue
  from IndexedDB before it has a connection, so a crash costs one frame hold, not a black screen.

### Operator window

```
main thread (host)                               core worker
──────────────────                               ───────────
React UI (renders a view model),                 WebSocket + clock, optimistic live state,
keyboard/HID/MIDI event forwarding,              library store and search index, fallback-bus
window.open + MessagePort handoff,               authority (via ports), service-cache fill,
WebRTC program-view receivers,                   thumbnail scheduling, Stream Deck image rendering,
supervisor of the core worker                    health aggregation, action dispatch
```

- **Core worker** (new): the live state, library and buses leave the main thread. React subscribes to a
  view model the worker posts (a diff-friendly snapshot per change), and sends actions. A long React commit,
  a large playlist render, or a slow editor canvas can no longer delay a GO or a fallback heartbeat.
- **Fallback bus over MessagePorts** (changed): when the operator opens an output it posts a fresh
  `MessagePort` to that window through `postMessage` (ports are transferable across origins). Both ends
  forward their port into their workers. From then on the operator's core worker and the output's link
  worker talk directly: neither main thread is on the path, so neither can stall the bus. Window handles
  are used only to open and close windows. The design/17 behaviour is unchanged; only the transport moves.
- **Keyboard on main, by necessity**: `keydown` must be handled on the main thread, but the handler does
  one thing: post the action to the core worker. Under a stalled main thread the key is late either way;
  Stream Deck and MIDI have the same constraint. This is why `mainThreadStallMs` is reported for the
  operator too, and why the checklist tells the volunteer to use the Stream Deck as the second route.

### Stage window

Same shape as the output in miniature: a link worker owning the socket, mirror, fonts and timers; the main
thread renders DOM from a view model. Low priority: the stage is not an audience screen.

### Hub

```
supervisor (tini + a small Node parent)
  ├── live process: WebSocket, live service, journal, time       (restart budget: 1 s, state from snapshot)
  └── library process: HTTP API, SQLite, media jobs, imports
        ├── worker_threads pool: ProPresenter decode, RTF, PPTX XML, font parsing
        └── child processes: ffmpeg, pdftoppm, soffice (timeouts, memory limits, cgroup)
```

- **Two processes** (new): the live service is the only part the service depends on at 10:00 on Sunday.
  Moving it out of the process that runs imports and transcodes means an out-of-memory import, a native
  module crash in SQLite, or a runaway LibreOffice cannot kill it. The live process keeps its journal in
  its own SQLite file and reads the library over a local socket only at goLive. The DSM reverse proxy
  routes `/ws`, `/api/v1/live` and `/api/v1/cache` to it; everything else to the library process.
- **Worker threads for CPU work** (new, partly in the current fix pass): no request handler decodes a
  library or parses a PPTX on the event loop.
- **Restart budget**: the supervisor restarts a crashed child within a second, at most five times a minute,
  then stays down and reports. Live clients fall back to the operator as designed, so a live-process restart
  is a sub-second blip with no visible change.

## Bad data: validate at entry, clamp at use, quarantine on failure

| Boundary | Today | Target |
| --- | --- | --- |
| HTTP bodies | Zod, strict on most routes | Zod `.strict()` everywhere with bounds (string lengths, array sizes, numeric ranges); unknown keys rejected |
| WebSocket from clients | Zod on every message | Plus per-socket rate limits and payload size caps; `at` clamped (fix pass) |
| WebSocket to clients | Trusted, cast | Structural check of `live.state` on receipt; a reducer exception on a delta triggers resync, never a crash (fix pass) |
| goLive resolution | Checks media readiness | Deep-validates every presentation against the schema; a slide that fails is replaced by an empty slide and logged, the cue is marked `degraded` in health, the service still goes live |
| Files | Hash and MIME sniff on upload | Plus decode-time limits: image dimensions, video duration and resolution, font table sizes; a file that fails to decode is marked and never retried in a loop |
| Render plan | Draws what it is given | Clamps: boxes to ±2× the canvas, text to 10,000 characters, font size to [4, 1000] px, objects per slide to 200, bitmap bytes per cue; a text object with an unknown font renders in the fallback font and reports it |
| Journal and snapshots on disk | Parsed and trusted | Validated on restore; a corrupt snapshot falls back to the last good one, a corrupt journal row ends replay with a warning instead of an exception |
| Imports | Logged gaps | Every imported entity passes the same schema as the API; the importer cannot write anything the editor could not |
| Settings | Validated on PUT | Plus invariants (exactly one audio master, unique host indices, looks referenced by outputs exist) and defaults for missing keys on read |

Quarantine is the key behaviour: a cue, file or slide that fails is marked bad and skipped, with a
visible indicator for the operator, and the system continues. Nothing retries without a budget.

## Unknown bugs: supervision, budgets, chaos

- **Supervision trees**: every worker and child process has an owner that restarts it from persisted
  state, with a restart budget. Erlang's lesson applies: do not handle the error you did not predict, let
  the piece die and restart it clean.
- **Heartbeats everywhere**: worker to supervisor (250 ms), output to operator (1 s health), operator to
  output over the bus (2 s, fix pass), client to hub (3 s while live, fix pass). Every heartbeat has a
  timeout and a defined reaction. No component waits forever for a message.
- **Error budgets**: counters per subsystem (arm failures, reducer rejections, socket drops, worker
  restarts). A budget exceeded within a minute stops retrying and surfaces a red state, instead of a
  tight loop that burns the NAS or the GPU.
- **Invariant checks as code**: the link worker asserts after every state change (live cue is in range,
  armed is live+1 or undefined, the held keys match the plan). A failed assertion triggers resync, then
  restart, never silent drift.
- **Fuzzing**: property tests already cover the reducer; extend them to the lyric parser, the ProPresenter
  decoder (random bytes and mutated fixtures), the RTF reader, the PPTX extractor and the render planner
  (random slides within and beyond the clamps). The acceptance criterion is "never throws, output within
  bounds".
- **Chaos in end-to-end tests**: kill a worker, corrupt an OPFS file, send a malformed delta, freeze a
  socket, exhaust storage quota, revoke the GPU; assert the audience screen never goes black and the
  operator sees the right indicator. The current suite does this for hub death only.
- **Observability on the volunteer's screen**: the diagnostics panel shows per-window restart counts,
  stall times and error budgets, and the printed checklist maps each red state to one action.

## What this does not solve

- A stalled **output main thread** still delays video `play()` and fullscreen. Mitigation: it does almost
  nothing, and the stall is reported so the operator can relaunch.
- **GPU process** loss affects every window at once. Mitigation: the existing rebuild path and the 2D
  compositor; and the architecture already allows a mini PC per display.
- **Chrome itself** crashing. Mitigation: outputs restore from IndexedDB on relaunch in seconds; the
  checklist has the ProPresenter switch.
- Bugs in the **shared reducer** affect every window identically. Mitigation: it is pure, small, property
  tested and fuzzed; and the operator's view is reconciled against the hub's.

## Phased plan

| Phase | Work | Value |
| --- | --- | --- |
| A (fix pass, in progress) | Liveness by time, outputs leave fallback autonomously, heartbeats on the fallback bus, pending re-submission, `mainThreadStallMs`, reducer guards in the mirror, `at` clamp, import in a worker thread, bounded schemas | Removes the known failure modes; starts the boundary validation |
| B | Output **link worker** and **supervisor**; fallback bus over **MessagePorts**; crash-only restart; render-plan clamps; goLive deep validation with quarantine | The audience path no longer shares a thread with networking, storage or state; bad slides cannot reach the frame loop |
| C | Operator **core worker** with a view model; keyboard forwarding; error budgets and the diagnostics panel; chaos tests | The operator UI cannot delay the live service; failures are visible and bounded |
| D | Hub **two-process split** with a supervisor; worker-thread pool; validated restore | A library or media failure cannot stop the live service |
| E | Stage link worker; fuzzing of every parser; invariant assertions | Completes the pattern |

Phase B is the one that matters for Sunday; it should land before the first live service. Phases C to E
can follow rehearsals.

## Trade-offs

- More moving parts: three workers per output and ports between them. Mitigated by one typed message
  layer (`packages/protocol` already) and by the supervisor being the only place that knows the topology.
- Debugging across workers is harder than a single thread. Mitigated by the per-window log ring (now in
  health) and the diagnostics export.
- MessagePort between windows needs the handoff at open time; a window opened by anything other than the
  operator (a manual URL) has no port and works hub-only, which is the existing limitation for outputs on
  other machines.
- Two hub processes complicate deployment slightly: one container, two Node processes under tini, two
  reverse-proxy path rules. The alternative, one process with worker threads, keeps most of the benefit for
  CPU work but not for crashes; the split is the honest answer to "unknown unknowns".
