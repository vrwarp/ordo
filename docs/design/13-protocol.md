# Design 13: Protocol

Defined in `packages/protocol` as Zod schemas. JSON text frames. Every message has
`{ t: string, v: 1, ...payload }`. The same message types are used on the hub WebSocket
and on the fallback bus (`postMessage`), so outputs have one receive path.

The live events of pre-rendered slides (`prerender.add`, `prerender.use`) are designed in
[design/29](29-prerender-and-limits.md) §1.7 and §1.11 and listed under "Pre-render messages" below.

## Client to hub

| `t`              | From             | Payload                                            | Notes                                              |
| ---------------- | ---------------- | -------------------------------------------------- | -------------------------------------------------- |
| `hello`          | all              | `{ role, outputId?, view?, appVersion, lastSeq? }` | First message. Hub replies `welcome`               |
| `time.ping`      | all              | `{ c: clientSentMs }`                              | Hub replies `time.pong { c, s: hubMs }`            |
| `live.event`     | operator         | `{ id, event: LiveEvent, clientSeq }`              | A reducer event. Hub applies, journals, broadcasts |
| `live.resync`    | any              | `{}`                                               | Ask for a full state                               |
| `health`         | output, stage    | `OutputHealth` minus `lastSeenHub`                 | Once per second                                    |
| `cache.progress` | output, operator | `{ ready, total }`                                 | During service cache fill                          |
| `rtc.signal`     | operator, output | `{ to: outputId                                    | 'operator', sdp?, ice? }`                          | Program-view signalling |
| `surface.event`  | operator         | `{ device, control, value }`                       | Optional telemetry of surface presses              |

`hello`'s `view: 'lectern'` marks a Pulpit Lectern on the stage output's link (design/16 "Pulpit Lectern"): the hub
then neither lets it replace the output's own window nor replaces it with one.

### Per-message caps (design/28 P0)

A socket of a capped session (a phone: role `edit`, cap `light` or `view`) is checked per message
(`apps/hub/src/caps.ts`, a table over every message type, so a new type does not compile until it is
listed): it may send `hello` (as `edit`; `operate` gets `bye forbidden` as for every edit socket) and
`time.ping`. A `live.event` gets `live.ack { rejected: 'forbidden: cap' }`; every other message above its cap
(`live.adopt`, `live.resync`, `health`, `rtc.signal`, `preview`) is dropped without an answer. It receives
`welcome` (unchanged: no cap field in P0), `time.pong`, `bye`, `live.ack` and, until P1's `library.poke`, the
stripped `library.delta` an edit socket gets; never `live.state`, `live.delta`, `health.summary`,
`rtc.signal` or `preview`. Operate, output, stage and uncapped edit sockets run none of these checks.

## Hub to client

| `t`              | Payload                                         | Notes                                                                                              |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `welcome`        | `{ hubMs, seq, role, outputs: OutputRegistry }` | Followed by `live.state`                                                                           |
| `live.state`     | `{ seq, state: LiveState }`                     | Full state; sent on connect, resync, overflow                                                      |
| `live.delta`     | `{ seq, fromSeq, event: LiveEvent, at: hubMs }` | One applied event. Clients apply via the shared reducer; a gap in `fromSeq` triggers `live.resync` |
| `live.ack`       | `{ id, seq                                      | rejected: reason }`                                                                                | Reply to the operator's `live.event`  |
| `library.delta`  | `{ seq, changes: [{ kind, id, rev, entity       | deleted }] }`                                                                                      | Library changes for cache maintenance |
| `cache.manifest` | `ManifestRef`                                   | New live manifest                                                                                  |
| `health.summary` | `{ outputs: Record<Id, OutputHealth> }`         | To the operator, once per second                                                                   |
| `rtc.signal`     | as above                                        | Relayed                                                                                            |
| `time.pong`      | `{ c, s }`                                      |                                                                                                    |
| `bye`            | `{ reason }`                                    | Before the hub closes a socket                                                                     |

## Live events (reducer input)

```ts
type LiveEvent =
  | { k: 'goLive'; playlistId: Id; resolved: ResolvedPlaylist; manifest: ManifestRef }
  | { k: 'endService' }
  | { k: 'select'; cueIndex: number } // arms
  | { k: 'go'; cueIndex: number; at: number } // at = hub ms, ~2 frames ahead
  | { k: 'next' }
  | { k: 'prev' }
  | { k: 'nextItem' }
  | { k: 'prevItem' }
  | { k: 'clear'; layer: 'slide' | 'lowerThird' | 'props' | 'media' | 'background' | 'all'; at: number }
  | { k: 'logo'; at: number }
  | { k: 'lowerThird'; text?: string; presentationId?: Id; at: number }
  | { k: 'media.play' | 'media.pause' | 'media.restart'; at: number }
  | { k: 'media.ended'; cueIndex: number } // from the audio master output
  | { k: 'timer.start' | 'timer.stop' | 'timer.reset'; timerId: Id; at: number }
  | { k: 'message.send'; id: Id; text: string; ttlMs?: number }
  | { k: 'message.dismiss'; id: Id }
  | { k: 'output.register'; output: Output }
  | { k: 'output.health'; outputId: Id; health: OutputHealth }
  | { k: 'output.armed'; outputId: Id; cueIndex: number; ok: boolean; error?: string };
```

`next` and `prev` are resolved by the reducer into `select` plus `go` using the state's
`armed` cue: if the next cue is already armed on every connected output, `next` becomes
`go(next, at)` immediately; otherwise it becomes `select(next)` and the operator app
re-issues `go` when all `output.armed` arrive. The operator's optimistic reducer applies
the same rule, so the UI shows the amber wait state consistently.

`at` timestamps are hub milliseconds. The operator computes `at = hubNow() + 2 *
frameMs` (33 ms at 60 Hz). Outputs flip at the first vsync whose predicted presentation
time is at or after `at`; if `at` is already past (late delivery), they flip on the next
vsync and report the lateness in `health`.

## Prepare before goLive

Design/29 §2.3 M8. Going live has two steps, so a mid-service Go live never holds GO, Next or Clear:

1. `POST /api/v1/live/prepare` (operate role; the live process answers it) with `LivePrepareReq`
   `{ playlistId, saved?, seen? }`. The hub fetches the playlist's copy from its library and checks it in a
   worker thread (design/12 "Going live prepared beside the running service"). The answer is a
   `LivePrepareRes` `{ playlistId, state: 'preparing' | 'ready' | 'failed', pct, reason?, savedAt?, bytes? }`:
   `pct` is 0-90 while the copy arrives (by its announced length), 90 while it is checked, 100 when done;
   `savedAt` is when the hub's saved copy of the playlist was taken, if it has one; `reason` is the goLive's
   refusal. The request is a long poll: it is answered when the prepare ends, or (with `seen`, the `pct` the
   caller last saw) when the progress moves, and otherwise after `LIVE_PREPARE_WAIT_MS` (400 ms). Asking
   again while a prepare is under way joins it. A poll that carries `seen` continues the Go live it watched:
   a prepare that ended since the last answer (within 10 s) is answered with its result, never restarted
   (the operator waits up to 150 ms between polls, so a prepare often ends between two of them). A first
   request (no `seen`) after a prepare that ended starts a fresh one. At most two prepares are in flight
   (`PREPARES_IN_FLIGHT_MAX`): a third playlist's fails at once with W67 (design/29 §3), "Another service is
   still getting ready to go live. Try Go live again in a moment.", and only the latest prepare's ready copy
   is kept. `saved: true` goes live from the hub's saved copy instead of waiting for the library (W41's
   button): the fetch under way is abandoned, and the goLive carries the existing cached-copy `degraded` entry.
2. Once `ready` (or `failed`), the operator sends the ordinary `{ k: 'goLive', playlistId }` command. It
   uses the prepared copy (once, within 10 s), applies at once with one parse, and is refused with the
   prepare's `reason` if it failed.

A goLive sent without step 1 (an older operator, `/actions`, a script) is prepared the same way before it
enters the command queue; commands sent after it then apply to the running service until it is ready.
goLives keep their order among themselves. End service keeps its order with them: a goLive sent before it
and still being prepared is cancelled (its fetch abandoned) and refused with "Go live cancelled by End
service" (`GOLIVE_ENDED_REASON`; the operator shows no dialog for it), so the screens never go live again
after the service was ended; a goLive sent after End service prepares afresh. No WebSocket message is added: the operator learns the progress
from the long poll (`packages/protocol` `LIVE_PREPARE_PATH`, `LivePrepareReq`, `LivePrepareRes`).

## Pre-render messages

Wave r2b (design/29 §1.7, §1.11): two live events for pre-rendered slides, built in sub-wave 1 and used from
sub-wave 3 on (nothing sends them while `PRERENDER_ON` is false).

```ts
type LiveEvent +=
  | { k: 'prerender.add'; presentationId: Id; slideId: Id; key: ContentHash; size: 3840 | 1920; file: ContentHash }
  | { k: 'prerender.use'; presentationId: Id; slideId: Id };
type LiveState += {
  prerendered?: PrerenderPicture[]; // newest last, ≤ PRERENDERED_MAX (4,096); the oldest go
  drawOverride?: { presentationId: Id; slideId: Id }[]; // ≤ DRAW_OVERRIDE_MAX (1,000)
};
```

- `prerender.add` is the hub's only: a picture of a key of the live service (`resolved.prerenderKeys`) accepted
  during it (the go-live bake). The hub applies it through `LiveService.apply` and every client reduces it from
  `live.delta`; `LiveCommand`, what a client's `live.event` and `POST /live/events` carry, leaves it out, so a
  client sending one is refused at the parse (`HUB_ONLY_EVENTS`). The reducer keeps it in `state.prerendered`
  (one entry per slide, key and size; a key outside the key set, a slide outside the service or an idle state is
  a no-op) and never changes `resolved`.
- `prerender.use` is the operator's "Use the picture for this slide during this service" (operate role, refused
  from edit, output and Stage sockets as every command is): a slide set to Live draws from its picture until
  End service, kept in `state.drawOverride`. It changes nothing in the presentation (locked while live), is
  journaled like every event and travels with the hand-back state.
- Both end with the service: `endService` and the next `goLive` start without them.

## Sequence rules

- `seq` is the hub's. Clients track `appliedSeq`. A delta with `fromSeq !== appliedSeq`
  is a gap: the client requests `live.resync` and ignores deltas until the full state
  arrives.
- Operator optimistic events carry `clientSeq`; the operator keeps a pending list and
  rebases pending events on top of each hub delta. Rejections roll back the one event.

## Fallback bus

Same messages over `window.postMessage` with a `targetOrigin` of the output's origin.
The operator acts as the hub: it stamps `seq` continuing from the last hub `seq`, and
`at` values use `Date.now()` (shared OS clock). When the hub returns, the operator sends
`live.event { k: 'adopt', state }` which the hub accepts only if its own `mode` is `live`
with the same playlist and its `seq` is lower; otherwise the operator resyncs from the
hub and surfaces a warning. Details in [design/17](17-offline-and-degraded.md).

## Output health: units

`OutputHealth` (`health`, and the hub's `health.summary` to the operator) carries three counters of an output's
units, the slow parts of a slide drawn ahead in slices (design/14 "Late units"; wave r2b), all optional so an older
hub's parse strips them:

| Field            | Meaning                                                                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unitsMade`      | units the window's asset worker has made since it started                                                                                                                                                                                 |
| `unitsLate`      | slides the window showed before all their units were ready, whose late parts faded in a moment later (counted once a showing); the operator shows W49 "Parts of 2 slides appeared a moment late on this screen." (design 29 §3) as a note |
| `unitCacheBytes` | bytes the asset worker's unit cache holds now (at most 192 MiB; warm-up stops at two thirds)                                                                                                                                              |

## Versioning

`v` is the protocol version. Hub and apps are deployed together from one image, so a
mismatch means a stale tab: the hub replies `bye { reason: 'version' }` and the app
reloads itself.

`APP_VERSION` (`packages/protocol/src/index.ts`) is what `hello` carries, and that reload
is the only guard against a tab left open across an upgrade. Every client runs the hub's
reducer, cue expansion, schemas and planner on the same states, so any change to what they
compute from the same state, event, message or stored document bumps it (M5 wave 1 went to
0.2.0: the slide's own video on the media layer and slide-owned audio).
`packages/protocol/src/version.test.ts` fingerprints those shared sources (comments and
layout ignored) and fails until the change records its digest, with a new version when the
meaning changed.

## Program view signalling

Operator sends `rtc.signal` to each output with an SDP offer for a receive-only video
transceiver; outputs answer with a track from `canvas.captureStream(10)` scaled to
320x180 through a second small canvas. ICE candidates are host candidates only (one PC).
Data path never touches the hub.
