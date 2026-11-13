# Milestones

Three milestones, each gated by a measured rehearsal at the venue. The first live
service follows M3. Tasks are sized for one Claude Code session each and cite the
documents they implement. Order within a milestone is a dependency order.

## M1: Lyrics and video on the main screen

Goal: a volunteer runs a worship set (songs with motion backgrounds, one video) on the
audience screens from the operator view, with zero dropped frames measured.

Gate: 60-minute soak on the venue PC passes; a 30-minute rehearsal with a volunteer using
Space and arrows; WAN unplug test passes.

| #    | Task                                                                                                                                                                                                           | Implements                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1.1  | Verify hostnames and wildcard certificate on the NAS; record the result and apply the fallback if needed                                                                                                       | design/22                      |
| 1.2  | Monorepo scaffold: pnpm workspace, TypeScript, Biome, Vitest, Playwright, CI workflow with lint, typecheck, test                                                                                               | design/24, design/23           |
| 1.3  | `packages/domain`: entity schemas, arrangement expansion, lyric parser (plain text and SongSelect text), unit tests                                                                                            | design/11, design/20           |
| 1.4  | `packages/live-state`: reducer with goLive, select, go, next, prev, clear, logo, output register and armed; property tests                                                                                     | design/11, design/13, adr/0006 |
| 1.5  | `packages/protocol`: message schemas, version, sequence rules; round-trip tests                                                                                                                                | design/13                      |
| 1.6  | `apps/hub` core: Fastify, host routing, SQLite with migrations, library CRUD with revisions, snapshot and deltas, PIN auth with both roles, rate limiting, route role check                                    | design/12, design/21           |
| 1.7  | `apps/hub` live: WebSocket, time sync, event journal, delta broadcast, resync, health summary                                                                                                                  | design/12, design/13           |
| 1.8  | `apps/hub` media: upload, hashing, ffprobe, H.264 transcode, poster, job queue, `/files/:hash` with ranges                                                                                                     | design/12, adr/0009            |
| 1.9  | `packages/cache` and manifest: hub manifest on goLive, OPFS fill in outputs, Cache API fill in operator, progress reporting, integrity check                                                                   | design/17, adr/0007            |
| 1.10 | `packages/renderer` core: WebGPU device, pipelines compiled at startup, pre-allocated buffers, layer stacks, crossfade, frame loop with telemetry, zero-allocation lint rule                                   | design/14                      |
| 1.11 | Text rasterizer in the asset worker: word wrap, outline, shadow, fill, fonts from cache; golden-image tests                                                                                                    | design/14, adr/0004            |
| 1.12 | `apps/output`: main thread shell, workers, hello and token auth, arm sequence for slides and images, GO at scheduled frame, health, Wake Lock, fullscreen on screen, device-loss recovery with last-frame hold | design/14                      |
| 1.13 | Video source: `<video>` preload on arm, rVFC to the worker, external texture path, loop and onEnd, droppedVideoFrames telemetry                                                                                | design/14, adr/0005            |
| 1.14 | `apps/operator` shell: login, store with optimistic reducer, IndexedDB library, WebSocket bus, top bar with health dots                                                                                        | design/15                      |
| 1.15 | Operator view: playlist pane, slide grid with sections and arrangements, thumbnails worker, keyboard map, GO flow with pre-arm of next, layer bar with clear slide and clear all                               | prd/02, design/15              |
| 1.16 | Launch and Relaunch outputs with Window Management API and saved screens; stable window names                                                                                                                  | design/15                      |
| 1.17 | Main look and look settings page (data-driven renderer config)                                                                                                                                                 | prd/04, design/14              |
| 1.18 | Media library UI: upload with progress, state, background flag, picker in playlist                                                                                                                             | prd/05                         |
| 1.19 | New song from paste; minimal presentation editing (title, sections, slide text) to get content in before the full editor                                                                                       | prd/03                         |
| 1.20 | Service Worker app-shell precache per origin                                                                                                                                                                   | design/17                      |
| 1.21 | Fallback bus: postMessage hello and ready, operator-as-authority, adoption on hub return; Playwright degraded-mode test                                                                                        | design/17, adr/0003            |
| 1.22 | Playwright multi-origin harness: operator plus two outputs, GO skew assertion, clears, relaunch                                                                                                                | design/23                      |
| 1.23 | `tools/soak`: runner and report                                                                                                                                                                                | design/23                      |
| 1.24 | Docker image, Compose file, DSM reverse proxy guide, PC setup guide, hosts entries, Chrome policies, printable checklist v1                                                                                    | design/22                      |
| 1.25 | Release workflow to Docker Hub on tags; deploy v0.1 to the NAS; rehearsal                                                                                                                                      | design/22                      |

## M2: All looks, stage, lower thirds, audio, editor

Goal: every screen at the venue is driven by ordo, with the full editor and audio routing.

Gate: 60-minute soak with all outputs; rehearsal including stage messages, timers,
lobby and stream looks, video with audio to the house pair; OBS keying verified.

| #    | Task                                                                                                                                         | Implements                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 2.1  | Lyric-only looks: lower third band, stream look with key colour, non-song rule; next-slide band                                              | prd/04, adr/0011            |
| 2.2  | `apps/stage`: layout from the Stage look, clock, timers, messages, health, fallback bus                                                      | design/16                   |
| 2.3  | Timers and messages in the reducer, operator stage tools, props rasterization once per second                                                | prd/02, design/14           |
| 2.4  | Countdown-to-service cue on main and lobby looks; logo prop; elapsed timer started by a playlist timer item                                  | prd/02, prd/04              |
| 2.5  | Announcement loop presentations with auto-advance, shown pre-service on Audience screens (lobby and stream show none of it since #17)        | prd/03, prd/04              |
| 2.6  | `packages/audio`: context with sinkId, channel matrix, pairs, item gain, loudness, master, meters, device loss; settings page                | design/18, prd/06, adr/0008 |
| 2.7  | Audio cues in playlists; operator preview on a separate device                                                                               | prd/06                      |
| 2.8  | Full slide editor: canvas, objects (text, image, shape), property panel, themes with overrides, guides, undo, revisions UI, live lock banner | prd/03, design/15           |
| 2.9  | Fonts: upload, Google Fonts fetch on the hub, font picker, fonts in manifest and worker FontFaceSet                                          | prd/05, design/20           |
| 2.10 | Program view over WebRTC with hub signalling                                                                                                 | design/13, design/15        |
| 2.11 | Alpha WebM and GIF conversion jobs; audio file jobs                                                                                          | design/12                   |
| 2.12 | Diagnostics panel and export; checklist v2                                                                                                   | prd/08, design/12           |
| 2.13 | Visual golden tests for every look; soak with all outputs; deploy v0.2; rehearsal                                                            | design/23                   |

## M3: Control surfaces, imports, remote preparation

Goal: the venue's ProPresenter library is in ordo, the worship lead prepares from home,
the operator uses the Stream Deck and the foot switch, and the public hub is hardened.

Gate: soak passes; full rehearsal run by a volunteer alone from the checklist with the
developer absent from the booth; external scan of the public hostname shows only the
login page and lockout behaviour; first live service scheduled.

| #    | Task                                                                                                                                 | Implements           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| 3.1  | `packages/surfaces` action vocabulary and keyboard driver refactor; HTTP bridge                                                      | design/19            |
| 3.2  | Stream Deck driver: WebHID pairing, pages, key rendering worker, live state keys, Plus dials; mapping editor                         | prd/07, design/19    |
| 3.3  | MIDI driver with learn and thresholds; mapping editor                                                                                | prd/07, design/19    |
| 3.4  | ProPresenter 7 importer: proto vendoring, RTF reader, media location and upload, playlists, import log UI                            | design/20, adr/0012  |
| 3.5  | SongSelect ChordPro and text file import; chords stored per line                                                                     | design/20            |
| 3.6  | PPTX and PDF jobs: LibreOffice and pdftoppm in the image, text extraction, make-editable command                                     | design/20, design/12 |
| 3.7  | Remote preparation hardening: session lifetimes, remembered device, concurrent edit warning, upload resume, output token rotation UI | prd/09, design/21    |
| 3.8  | Backups: nightly job, list and restore command, retention; Hyper Backup note                                                         | design/12            |
| 3.9  | Scripture data model fields and a provider interface stub with tests (no provider yet)                                               | design/11            |
| 3.10 | Security review: headers, CSP, dependency audit in CI, external scan; fix findings                                                   | design/21            |
| 3.11 | Import the venue library on the NAS; worship lead builds a real service from home                                                    | prd/05, prd/09       |
| 3.12 | Deploy v0.3; volunteer-alone rehearsal; first live service go or no-go review against prd/01 success criteria                        | prd/01               |

## After the first service

Candidates, not commitments: WebCodecs decode path if telemetry warrants; Planning
Center; Bible provider; phones for the week (viewing the library and light changes, phases
P0 to P3 of [design/28](design/28-mobile.md)); a phone remote (design/28 §11 "Not now");
outputs on separate machines; auto-shrink and RTL text; per-object builds; cloud sync and
user accounts.

## PowerPoint without LibreOffice (design/27 M9)

M9 ships in pull requests on main, each published at once as the edge image and the Pages demo:

- `APP_VERSION` is 0.6.0 for M9's first pull request (waves 0-1 and the slide budgets); the build a venue rolls
  back to is 0.5.0, whose schema the compatibility tests read M9's slides with (design/27 §3.2).
- The PowerPoint parse runs in the operator (the client path) with the hub's own parse as the fallback; both
  convert with the same version and fields, and M9's exit is measured on the client path.
- `M9_WRITES` (`@ordo/pptx-scene` `version.ts`, for the hub and the client parse) is the kill switch: a field the converter writes stays out of it
  until its drawer is on main, and can be taken out again without a release of the drawers. Decorations and
  picture sheets stay out until `decor-render` (design/27 §15 M9 "rollout").

## Implementation status

All tasks in M1, M2 and M3 are implemented in this repository, with these exceptions and open items:

| Item                                                     | Status                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1 Verify hostnames and wildcard certificate on the NAS | Venue task; deploy/README.md describes it                                                                                                                                                                                                                                                                    |
| 1.25, 2.13, 3.12 Rehearsals and venue soak runs          | Venue tasks; the soak tool is ready                                                                                                                                                                                                                                                                          |
| WebGPU compositor on real hardware                       | Implemented; the build container has no GPU, so only the Canvas 2D path was observed rendering                                                                                                                                                                                                               |
| Docker image                                             | Dockerfile written and its runtime layout verified with `pnpm deploy`; not built here (no Docker daemon). CI builds it                                                                                                                                                                                       |
| Editor "send to preview" to an idle output               | Built (the hub's `preview` relay, `PreviewControl.tsx`; `apps/operator/test/preview.test.ts`, `apps/hub/test/review-fixes.test.ts`), then removed from the editor UI by the owner's editor rework (#7), deliberately: the look previews and the Previews page show a slide under every look instead (prd/03) |
| Per-window log lines in the operator diagnostics         | Done: outputs and the stage send their last 20 log lines in `health.recentLog`; the diagnostics panel lists them per window                                                                                                                                                                                  |
| Golden-image tests of the text rasterizer                | `pnpm --filter @ordo/renderer golden` (Playwright + OffscreenCanvas, design/23); runs in CI                                                                                                                                                                                                                  |
| Memory caps on ffmpeg, LibreOffice and pdftoppm          | Timeouts only; set a container memory limit (deploy/compose.yaml)                                                                                                                                                                                                                                            |

3.4 grew past its first scope: ProPresenter visual fidelity (#20: shapes, gradients, masks, crops, line masks,
picture shadows and feathers; PR #23: one effects path for shapes and pictures) is gated in CI by a font-free
synthetic ratchet of 18 slides that fails on a drop or a missing deck (`tools/pro7-fidelity`, design/23);
agreement with a real library is measured locally with `--sample-dir`.
