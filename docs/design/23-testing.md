# Design 23: Testing and verification

## Layers

| Layer       | Tool                                                                                                        | Scope                                                                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Vitest                                                                                                      | `packages/domain` (parsers, arrangement expansion, layout maths), `packages/live-state` (reducer determinism, property tests with fast-check), `packages/protocol` (schema round-trips), `packages/importers` (fixtures), hub services with an in-memory SQLite |
| Integration | Vitest + a real hub process                                                                                 | HTTP API with auth and roles, WebSocket sequencing, media jobs with tiny fixture files                                                                                                                                                                          |
| End to end  | Playwright, headless Chromium with `--enable-unsafe-webgpu --use-angle=swiftshader` in CI, real GPU locally | Operator + 2 outputs + stage in one browser context with separate origins served by the hub under test; GO timing, clears, looks, degraded mode, relaunch                                                                                                       |
| Soak        | `tools/soak` (Playwright, real GPU on the venue PC or a dev machine)                                        | 60+ minutes of the live playlist with motion backgrounds, GO every 10 s; asserts zero missed frames and zero long tasks from telemetry                                                                                                                          |
| Visual      | Playwright screenshots of outputs vs golden PNGs                                                            | Text rasterizer and looks; per-pixel tolerance for anti-aliasing                                                                                                                                                                                                |

## Multi-origin in tests

The hub under test serves the apps on `127.0.0.1` with host-based routing; tests map
`op.ordo.test`, `out1.ordo.test`, `stage.ordo.test` and `hub.ordo.test` through
Playwright's `--host-resolver-rules` to `127.0.0.1`. Secure-context APIs need HTTPS or a
`localhost` exemption, so tests run the hub with a self-signed certificate and Playwright
`ignoreHTTPSErrors`.

## Timing assertions

Outputs expose `window.__ordo.telemetry()` returning the health counters and a ring of
the last 600 frame timestamps. E2E tests assert, after a GO, that both outputs' first
frame showing the new cue (detected by a cue id written into a 1x1 pixel in the corner
of the frame in test builds) are within 17 ms of each other and within 50 ms of the key
press.

## Soak test

`pnpm soak --playlist <id> --minutes 60 --hub https://hub.<venue>.synology.me` logs in
with the operate PIN, goes live, launches outputs on the machine it runs on, drives GO
every 10 s through the HTTP bridge, collects health each second, and writes
`soak-<date>.json` plus a Markdown summary: per output, frames presented, missed, long
tasks, late flips, GPU losses, video dropped frames; pass or fail. The rehearsal gate in
[milestones.md](../milestones.md) requires a passing report from the venue PC.

## Golden images

`pnpm --filter @ordo/renderer golden` bundles `packages/renderer/golden/page.ts` with
esbuild, runs it in headless Chromium through Playwright, renders known slides (authored
main slide, lyric slides on every look, lower third, stream key, props, image fits) through
the output rasterizer on an `OffscreenCanvas`, and compares each to
`golden/expected/<case>.png`: a pixel differs when any channel is more than 40 apart, and a
case fails when more than 0.4 % of its pixels differ. Text uses DejaVu Sans injected from
the system (recorded in `expected/meta.json`) so the result does not depend on installed
fonts; on a machine without it the run is skipped. `--update` rewrites the expected images;
a failing case writes `<case>.actual.png` next to the expected one.

## CI

GitHub Actions on every push and PR: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm e2e` (SwiftShader; timing assertions relaxed to 100 ms in CI and marked), the golden
images, Docker build. Tags build and push the image. Playwright traces are uploaded on failure.

## Test content

Fixtures are synthetic: generated lyrics, a 10 s test pattern video in each format, a
PPTX and a PDF with known text boxes, a minimal ProPresenter 7 file built from the proto
schema. No venue content in the repo.
