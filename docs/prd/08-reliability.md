# PRD 08: Reliability

The prototype replaces ProPresenter on the venue PC with ProPresenter still installed as a
hot fallback. Reliability requirements are therefore measurable, not aspirational.

## Frame budget

- Every output presents one frame per display vsync. Missed vsync count over a service
  must be zero. Outputs measure this themselves with `requestAnimationFrame` timing and
  the WebGPU presentation loop, and report once per second.
- No long task over 50 ms on any output main thread or render worker during a service.
- GO: every output flips on the same scheduled frame; cross-output skew under one frame.
- Pre-roll: nothing loads, decodes, compiles or allocates on GO. All of that happens on
  arm. The render loop allocates no objects.

## Continuity

| Fault                                                          | Required behaviour                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WAN drops                                                      | Nothing changes. The hub is on the LAN. Public hostnames already resolved stay usable; reconnects work because the operator PC holds a hosts-file entry for the hub names (install step) in addition to the browser-side fallback                                                                     |
| Hub unreachable (NAS down, DSM restart, reverse proxy failure) | Operator and outputs continue from the service cache. The operator becomes the bus through the fallback channel ([design/17](../design/17-offline-and-degraded.md)). All cues, clears, timers and messages keep working on this PC. Stage tablets elsewhere would be lost; the venue has none         |
| Hub down before the service                                    | Go live asks, then runs the service from the operator PC with its copy of the library and the files downloaded with _Download for offline use_ (design/17). The operator chooses when to download                                                                                                     |
| Hub returns during a service the PC started                    | Nothing changes: the PC keeps the service to End service; the outputs do not follow the hub meanwhile                                                                                                                                                                                                 |
| Hub returns                                                    | Operator reconciles: hub adopts the operator's live state. No visible change on outputs                                                                                                                                                                                                               |
| An output crashes or its GPU device is lost                    | Other outputs are unaffected (separate processes). The output rebuilds and re-arms; the operator sees a red dot then green. Relaunch outputs fixes anything the output cannot                                                                                                                         |
| Operator tab crashes or is reloaded                            | Outputs keep showing the live cue. Operator reloads from the hub (or from local cache if the hub is down), restores selection, and re-acquires the output windows it launched by their names on the next click (the fallback link button does it at once); Relaunch takes over any it could not reach |
| Chrome quits                                                   | Reopening Chrome and clicking Launch outputs restores the service in under 15 s                                                                                                                                                                                                                       |
| Audio device unplugged                                         | Picture continues, audio resumes on reconnect                                                                                                                                                                                                                                                         |
| Disk full on the NAS                                           | Live state continues (in memory); uploads fail with a clear error                                                                                                                                                                                                                                     |

## Service cache

- When a playlist goes live, the hub publishes a manifest of every asset the playlist
  needs: media delivery files, posters, fonts, theme assets, logo, holding slides.
- Outputs cache everything in OPFS; the operator caches the manifest, playlist, and all
  presentations in IndexedDB and media in the Cache API. The operator's top bar shows
  progress and blocks nothing; the operator may start before 100 % but sees amber.
- Cached assets are addressed by content hash so re-caching is incremental.
- A cache integrity check runs at Launch outputs (and Relaunch): once every launched window has
  reported and its fill has stopped moving, the operator sees "Service cache: n missing on <output>"
  with the counts, or a confirmation that every window holds the whole manifest. The result also
  appears in the Diagnostics panel. Nothing is checked while no playlist is live.

## Recovery UX

- Relaunch outputs: one action, under 10 s, keeps last frame where possible.
- Health dots and a Diagnostics panel with per-output counters and the last 50 log
  lines from each window (carried in the window's health report), exportable as a file for
  bug reports together with the operator's own log.
- A printed one-page runbook, generated from the docs, with: start of service steps, what
  each health colour means, Relaunch, and the ProPresenter switch procedure (close the
  ordo output windows with Ctrl+Shift+Q or Relaunch, open ProPresenter, which already has
  the same playlist prepared).

## Measurement before a live service

- A soak test runs the full live playlist automatically for at least 60 minutes with
  motion backgrounds and a GO every 10 s, and must report zero missed frames and zero
  long tasks on every output ([design/23](../design/23-testing.md)).
- The rehearsal before each milestone gate runs with telemetry recorded and reviewed.

## Acceptance

- Unplug the NAS's network cable mid-rehearsal: the service continues, the operator sees
  amber, and reconnection is silent when the cable returns.
- Kill one output process from Task Manager: the other outputs do not miss a frame, the
  killed one returns via Relaunch outputs.
