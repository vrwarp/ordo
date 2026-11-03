# Design 10: Architecture

## Shape

Four kinds of process and one direction of data flow, as in the founding document, with
the fallback bus added for hub loss.

```
                         Synology NAS (Docker)
   ┌───────────────────────────────────────────────────────────┐
   │  DSM reverse proxy (TLS, *.<venue>.synology.me)           │
   │        │                                                  │
   │  ordo-hub (Node 22, TypeScript)                           │
   │   ├─ HTTP API + static apps        ├─ SQLite (library,    │
   │   ├─ WebSocket (live state, time)  │   live state journal)│
   │   └─ media pipeline (ffmpeg,       └─ media/ fonts/       │
   │       LibreOffice, pdftoppm)            backups/          │
   └───────────────────────────────────────────────────────────┘
                 ▲ WebSocket (state down, health up)   ▲ HTTPS (assets)
                 │                                     │
   Presentation PC, Chrome ────────────────────────────┼──────────────────
   ┌───────────────────┐   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │ Operator window   │   │ Output 1     │  │ Output 2…n   │  │ Stage        │
   │ op.<venue>…       │   │ out1.<venue>…│  │ outN.<venue>…│  │ stage.<venue>│
   │ React, no WebGPU  │   │ WebGPU +     │  │              │  │ DOM/CSS      │
   │ IndexedDB cache   │   │ workers, OPFS│  │              │  │              │
   └────────┬──────────┘   └──────▲───────┘  └──────▲───────┘  └──────▲───────┘
            │ postMessage fallback bus (only when hub is unreachable)  │
            └───────────────────────┴─────────────────┴────────────────┘
                 All windows share Chrome's one GPU process (the remaining coupling)
```

## Origins and processes

Each role gets its own origin so Chrome can put it in its own renderer process:

| Role                | Hostname                     | Process isolation reason                                               |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| Operator and editor | `op.<venue>.synology.me`     | Heavy UI, search index, editor; must never share a heap with an output |
| Output k (k = 1..6) | `out<k>.<venue>.synology.me` | Each output isolated from the others and from the operator             |
| Stage               | `stage.<venue>.synology.me`  | Separate, lightweight                                                  |
| Hub API             | `hub.<venue>.synology.me`    | Cookie scope for sessions; WebSocket endpoint                          |

Every page is served with `Origin-Agent-Cluster: ?1` so each origin is an origin-keyed
agent cluster and Chrome isolates them by process. Outputs are opened by the operator
with `window.open(url, name)` keeping the opener relationship: across origin-keyed
clusters there is no synchronous access either way, only `postMessage`, so isolation is
preserved while the opener handle gives the fallback bus (ADR 0003). This deviates from the
founding document's `noopener` and is why.

Hostnames are listed in DSM's reverse proxy one by one (DSM has no wildcard source
rule), all pointing at the hub container. Six output hostnames are pre-registered to
cover the venue with headroom.

## Apps and packages

pnpm workspace, TypeScript everywhere, Vite for the browser apps.

| Path                  | What                                                                                                  | Runtime           |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ----------------- |
| `apps/hub`            | Hub service: Fastify HTTP, `ws` WebSocket, better-sqlite3, media jobs                                 | Node 22 in Docker |
| `apps/operator`       | Operator view and editor, React 19                                                                    | Chrome            |
| `apps/output`         | Output window: a thin main thread, render worker, asset worker                                        | Chrome            |
| `apps/stage`          | Stage display, React, DOM/CSS only                                                                    | Chrome            |
| `packages/domain`     | Entity types and Zod schemas, arrangement expansion, lyric parser, slide layout maths                 | Shared            |
| `packages/protocol`   | WebSocket and fallback-bus message schemas, versioning                                                | Shared            |
| `packages/live-state` | The live-state reducer: pure function of (state, event) used identically by hub, operator and outputs | Shared            |
| `packages/renderer`   | WebGPU compositor, layer stacks, transitions, text rasterizer, video sources                          | Chrome (worker)   |
| `packages/cache`      | Service cache: manifest handling, OPFS and Cache API storage, integrity                               | Chrome            |
| `packages/audio`      | Web Audio engine: device selection, channel matrix, sources, meters                                   | Chrome            |
| `packages/surfaces`   | Action vocabulary, keyboard map, Stream Deck (WebHID), Web MIDI with learn                            | Chrome            |
| `packages/importers`  | ProPresenter 7 (protobuf), SongSelect text and ChordPro, PPTX text extraction                         | Node and Chrome   |
| `packages/ui`         | Shared React components and theme                                                                     | Chrome            |
| `tools/soak`          | Soak test runner and telemetry report                                                                 | Node + Playwright |

## Data flow

1. Library changes: operator or editor → HTTP API → SQLite → `library.delta` broadcast on
   WebSocket → clients update their caches.
2. Live control: operator action → local reducer (optimistic) → `live.event` to hub → hub
   runs the same reducer, journals, broadcasts `live.state` delta with a sequence number →
   every client applies it; the operator reconciles its optimistic state against the hub's.
3. Arm and GO: `arm` is a live event; outputs respond with `armed` health messages; `go`
   carries a hub time `at`; outputs flip at the first vsync at or after `at` on their
   hub-synchronised clock.
4. Health: each output sends one `health` message per second; the hub forwards a
   `health.summary` to the operator.
5. Program view: outputs stream a 320x180 10 fps capture of their canvas to the operator
   over WebRTC; signalling rides the hub WebSocket, media goes direct on the PC.
6. Hub loss: the operator detects socket loss, switches its bus to `postMessage` on its
   opener handles, and keeps emitting the same `live.state` deltas; outputs accept either
   bus with the same sequence rules ([design/17](17-offline-and-degraded.md)).

## Time

The hub is the clock. Every client runs an NTP-style exchange over the WebSocket every
10 s (four samples, take the minimum round trip) and keeps an offset to `hubNow()`. On
the LAN the error is well under one frame. In fallback mode the operator's clock is the
reference; all windows are on one PC and share the OS clock, so `Date.now()` is used
directly.

## State ownership

| State                                                                                            | Owner                      | Persisted                     |
| ------------------------------------------------------------------------------------------------ | -------------------------- | ----------------------------- |
| Library                                                                                          | Hub (SQLite)               | Yes, with revisions           |
| Live state (live playlist, live and armed cues, layer states, timers, messages, output registry) | Hub, by the shared reducer | Journal in SQLite; replayable |
| Operator UI state (selection, panels)                                                            | Operator                   | IndexedDB                     |
| Output local state (cached assets, device)                                                       | Output                     | OPFS                          |
| Settings (looks, outputs, audio, key maps, PINs)                                                 | Hub                        | Yes                           |

## What the founding document said, and what changed

| Topic           | Founding doc                            | This design                                                                                                                                                                      | ADR  |
| --------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Opening outputs | `noopener`                              | Keep opener for the fallback bus; isolation via origin-keyed agent clusters                                                                                                      | 0003 |
| Text rendering  | DOM/CSS layer on the output main thread | Rasterized at arm time into textures and composited in WebGPU; DOM layer only for diagnostics                                                                                    | 0004 |
| Video decode    | WebCodecs in a decode worker            | `<video>` element plus `requestVideoFrameCallback` on the otherwise idle output main thread for the prototype; WebCodecs ring buffer is the M2 upgrade if telemetry shows jitter | 0005 |
| TLS             | Caddy with DNS-01                       | DSM reverse proxy with the DSM-issued wildcard certificate                                                                                                                       | 0002 |
| Degraded mode   | BroadcastChannel                        | postMessage over opener handles (BroadcastChannel cannot cross origins)                                                                                                          | 0003 |
