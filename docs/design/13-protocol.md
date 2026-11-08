# Design 13: Protocol

Defined in `packages/protocol` as Zod schemas. JSON text frames. Every message has
`{ t: string, v: 1, ...payload }`. The same message types are used on the hub WebSocket
and on the fallback bus (`postMessage`), so outputs have one receive path.

## Client to hub

| `t`              | From             | Payload                                     | Notes                                              |
| ---------------- | ---------------- | ------------------------------------------- | -------------------------------------------------- |
| `hello`          | all              | `{ role, outputId?, appVersion, lastSeq? }` | First message. Hub replies `welcome`               |
| `time.ping`      | all              | `{ c: clientSentMs }`                       | Hub replies `time.pong { c, s: hubMs }`            |
| `live.event`     | operator         | `{ id, event: LiveEvent, clientSeq }`       | A reducer event. Hub applies, journals, broadcasts |
| `live.resync`    | any              | `{}`                                        | Ask for a full state                               |
| `health`         | output, stage    | `OutputHealth` minus `lastSeenHub`          | Once per second                                    |
| `cache.progress` | output, operator | `{ ready, total }`                          | During service cache fill                          |
| `rtc.signal`     | operator, output | `{ to: outputId                             | 'operator', sdp?, ice? }`                          | Program-view signalling |
| `surface.event`  | operator         | `{ device, control, value }`                | Optional telemetry of surface presses              |

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
