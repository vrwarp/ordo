# Design 23: Testing and verification

## Layers

| Layer       | Tool                                                                                              | Scope                                                                                                                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | Vitest                                                                                            | `packages/domain` (parsers, arrangement expansion, layout maths), `packages/live-state` (reducer determinism, property tests with fast-check), `packages/protocol` (schema round-trips), `packages/importers` (fixtures), hub services with an in-memory SQLite                                                    |
| Integration | Vitest + a real hub                                                                               | HTTP API with auth and roles, WebSocket sequencing, media jobs with tiny fixture files: `apps/hub/test` starts the hub in the test process on an ephemeral `127.0.0.1` port with a temporary data directory; `processes.test.ts` runs the real two-process hub (supervisor, live and library children) from source |
| End to end  | Playwright, headless Chromium with SwiftShader (`--use-angle=swiftshader --enable-unsafe-webgpu`) | Operator, two outputs and the stage on their own origins served by a real hub over HTTP (below); GO and flip timing, clears, looks, degraded mode, relaunch, and the chaos specs                                                                                                                                   |
| Soak        | `tools/soak` (Playwright, real GPU on the venue PC or a dev machine)                              | 60+ minutes of the live playlist with motion backgrounds, GO every 10 s; asserts zero missed frames and zero long tasks from telemetry                                                                                                                                                                             |
| Visual      | Playwright screenshots of outputs vs golden PNGs                                                  | Text rasterizer and looks; per-pixel tolerance for anti-aliasing                                                                                                                                                                                                                                                   |

## The compositor under test

Chromium is launched with `--enable-unsafe-webgpu --use-angle=swiftshader --use-vulkan=swiftshader
--enable-features=Vulkan`. With Vulkan SwiftShader the WebGPU device survives in headless Chromium.
SwiftShader is a software adapter (`GPUAdapterInfo.isFallbackAdapter`), which an output treats as no
WebGPU (design/27 §7.2): an output window gets the Canvas 2D compositor unless its URL has
`?renderer=webgpu`, which keeps the real WebGPU compositor (health reports `compositor: 'webgpu'`, no
device loss); `?renderer=2d` forces Canvas 2D on any machine. Frame timing under software Vulkan is not
meaningful (missed frames are expected); correctness of flips, looks, holds and chaos recovery is.
Lateness bounds are asserted only with `ORDO_E2E_REAL_GPU=1`.

## Multi-origin in tests

Each app runs on its own origin, as in production, but over plain HTTP on `*.localhost`: the hub under
test listens on `127.0.0.1:<port>` with `ORDO_DOMAIN=localhost` and routes by host name, so the operator
is `http://op.localhost:<port>`, the outputs `http://out<n>.localhost:<port>` and the stage
`http://stage.localhost:<port>`; the API is reached as `http://localhost:<port>/api/v1`. Chromium resolves
every `*.localhost` name to the loopback address by itself (no `--host-resolver-rules`, no hosts file) and
treats `localhost` origins as secure contexts, so service workers, OPFS, WebGPU, `crossOriginIsolated`
and the Cache API work without a certificate. Other browsers do not resolve `*.localhost`; the suite is
Chromium only.

- `playwright.config.ts` starts the hub from `apps/hub/dist` (build first) on `ORDO_E2E_PORT` (default
  8090) with data in `.e2e-data`, sign-in by `ORDO_DEV_PIN=246810`, `ORDO_TZ=UTC`. Specs share it and run
  one at a time (`workers: 1`).
- Specs that kill or restart the hub own a hub process (`e2e/hubproc.ts`, `HubProcess.fresh(port)`) on their
  own ports, with data under `ORDO_E2E_DATA_ROOT` or `test-results/.e2e-data-<port>`; `ORDO_E2E_HUB_CMD`
  runs the hub from source instead of the build. `ORDO_CHAOS_OUTPUT_PORT` and `ORDO_CHAOS_OPERATOR_PORT`
  move the chaos specs' ports so concurrent runs do not collide.
- Windows are opened by URL with their output token (`openRoleWindow`), or launched from the operator
  (`window.open`) where the fallback bus needs an opener.

## Timing assertions

Every output exposes `window.__ordo.telemetry()` (health counters, frame times) and `__ordo.state()`
(what it holds). With `?test=1` the render worker writes the slide cue it shows into the top-left pixel of
the frame (a blue marker with the cue in red and green), so a screenshot of one pixel says which cue is on screen
(`testPixelCue`). Telemetry also carries `slideFlip: { cue, at }`: the cue the renderer draws and the hub
time of the frame that first drew it, taken in the render worker's frame loop.

`e2e/outputs.spec.ts` waits until both outputs have the next cue armed, sends GO, and for each of three
GOs asserts that the two outputs' `slideFlip.at` are within 100 ms of each other and at most 100 ms after
the GO's scheduled `at` (and not before it, less one frame). Those are the SwiftShader bounds: software
rendering on a shared machine gives irregular frames (measured here: skew 0.3 to 13.6 ms, rarely 55 ms).
With `ORDO_E2E_REAL_GPU=1`, for a run on a real GPU without the SwiftShader flag, the bounds are one frame
(17 ms) between outputs and 50 ms after the scheduled time. Lateness against the key press itself is not
asserted end to end; the soak test reports late flips per output from the outputs' own counters.

## Chaos tests

The design/25 faults are injected into the real apps by Playwright specs (`e2e/chaos-*.spec.ts`, the
`link-*` specs and `degraded.spec.ts`). Windows expose test hooks with `?test=1`
(`__ordo.chaos.killWorker`, `inject`, `badState`); hub processes are killed by pid. Where the audience
could see a fault, the spec samples the screen about every 100 ms from the fault until recovery plus
500 ms (the test pixel, a pixel of the picture, the cue the window says it holds) and compares each sample
with the value before the fault: a check only after recovery would miss a black frame in between.

| Spec                          | Kills or breaks                                                                                                                                                                                                                                                                     | Asserts                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chaos-output.spec.ts`        | The output's link, render and asset workers (one at a time, and the render worker right after a GO); a cached OPFS file corrupted (wrong size, and same size so it fails to decode); malformed deltas; the link worker while a clip ends; the file route for 14 s on a fresh output | The screen holds its cue and picture through every restart (sampled), the next GO flips; corrupt files are removed, fetched again and re-armed; a malformed delta resyncs; a clip that ends while the link worker is dead still advances the service; a transient file outage quarantines nothing and `armedOk` is never true for a cue not held                         |
| `chaos-operator.spec.ts`      | The operator's core worker mid-service, while the operator is the fallback authority, and while it hands the service back to the hub; the main thread blocked; the hub; the session                                                                                                 | The outputs' screens hold (sampled); GO works again within about 3 s and no command is lost; a main-thread block delays neither a Stream Deck GO nor the fallback heartbeat; ports are offered once in hub mode and GO reaches the outputs port to port with the hub dead; the hub ends up with the operator's state; an expired session is not a hub loss               |
| `chaos-hub.spec.ts`           | The two-process hub: library process killed, live process killed, live process frozen (SIGSTOP, the stall watchdog), the newest live snapshot corrupted with the journal removed, an oversize and a flooding WebSocket, the library crashed past its restart budget                 | The output holds its cue and picture through every outage (sampled); the live API keeps answering while the library is down and it is back within 5 s; the live process resumes from its snapshot (or the previous valid one); the bad sockets are closed and the others carry on; a library past its budget stays down, is reported as `failed`, and live keeps working |
| `chaos-stage.spec.ts`         | The stage's link worker (on the hub and on the operator's fallback bus); a malformed delta; a state that breaks the live-state invariants; the hub                                                                                                                                  | The lyrics stay on screen while the worker restarts and the next GO reaches the stage; the malformed delta and the bad state are not drawn and resync; on the fallback bus the stage follows the operator across the restart                                                                                                                                             |
| `link-blip.spec.ts`           | The operator's socket for under the 5 s fallback grace (TCP proxy)                                                                                                                                                                                                                  | A command sent just before the blip is re-sent with its id and applied once; the view does not snap back                                                                                                                                                                                                                                                                 |
| `link-silent-hub.spec.ts`     | The hub's TCP connections frozen, no close (TCP proxy)                                                                                                                                                                                                                              | The silent hub is noticed within about 12 s while live and the operator is the authority a 5 s grace later                                                                                                                                                                                                                                                               |
| `link-fallback-leave.spec.ts` | The operator tab that put the outputs on the fallback bus                                                                                                                                                                                                                           | The outputs return to the hub when it is back; a new operator tab's Relaunch takes the windows over                                                                                                                                                                                                                                                                      |
| `degraded.spec.ts`            | The hub, during a service                                                                                                                                                                                                                                                           | The operator runs the service from the PC, the outputs follow over the fallback bus, and the hub adopts the operator's state when it returns                                                                                                                                                                                                                             |

Not covered end to end (verified by unit tests or by hand): storage quota exhausted, a revoked GPU, a slow
or failing IndexedDB, the hub stall watchdog on the library process.

## Fuzzing

Every parser of untrusted input has a fast-check property suite next to its unit tests (`*.fuzz.test.ts`,
part of `pnpm test`). The acceptance criterion is the one in design/25: never throws (or, for archives and
documents, rejects with an `Error`), finishes in linear time, and returns output within bounds; round trips
where they exist. Each defect a fuzzer found has a named regression test in the same file.

| Parser                                                                                   | File                                             | Inputs                                                                                                                                                                                                                                                                                                                        | Properties                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseLyrics`, `parseSectionLabel`, `songFromParsed`                                     | `packages/domain/src/lyrics.fuzz.test.ts`        | Structured lines (labels, repeat markers, ChordPro directives, chords, CCLI footers), arbitrary UTF-16 incl. lone surrogates, control chars, CRLF/CR, BOM                                                                                                                                                                     | Sections non-empty with trimmed bounded lines; labels unique and ≤ 40 chars; order references existing sections; metadata ≤ 300 chars; tempo finite; label → normal form round-trips; the built presentation expands to dense cues                                    |
| ChordPro directives                                                                      | (same file)                                      | `{name}` / `{name: value}` for every known and unknown directive                                                                                                                                                                                                                                                              | As above; long whitespace runs stay linear                                                                                                                                                                                                                            |
| `expandCues`, `arrangedSections`, `sectionsOfItem`                                       | `packages/domain/src/cues.fuzz.test.ts`          | Random playlists referencing missing presentations, sections, arrangements and media; NaN/negative loop durations                                                                                                                                                                                                             | Cue indices dense and ordered; every slide cue resolves to its slide; labels ≤ 80 chars and well-formed UTF-16; loop delays in [0.5 s, 1 h]                                                                                                                           |
| `hexToRgba`, `rgbaHex`, `rgbaCss`, `nearColor`                                           | (same file)                                      | Any string, NaN/infinite channels                                                                                                                                                                                                                                                                                             | Channels integers 0..255, alpha 0..1, `#rrggbb` round trip, valid CSS                                                                                                                                                                                                 |
| `parseSongFile`                                                                          | `packages/importers/src/songselect.fuzz.test.ts` | Arbitrary text, BOM + CRLF, UTF-16 decoded as Latin-1                                                                                                                                                                                                                                                                         | Passes the `Presentation` schema; arrangements reference existing sections                                                                                                                                                                                            |
| `parseRtf`, `splitFontName`                                                              | `packages/importers/src/rtf.fuzz.test.ts`        | Random bytes, RTF token soup, mutations of real ProPresenter (Cocoa) RTF                                                                                                                                                                                                                                                      | Size in (0, 1000] pt, colours 0..255, stroke bounded, font name ≤ 200, no lone surrogates, linear on whitespace; `\binN` data skipped; text bounded while reading (100 MB of `\par` in a 200 MB heap, `rtf.limits.test.ts`)                                           |
| `importPro7`                                                                             | `packages/importers/src/pro7.fuzz.test.ts`       | Random bytes; protobuf messages built with the vendored schema from randomized fields (NaN/∞ doubles, huge strings, dangling UUIDs); bit flips; truncation; 2,000-deep nesting                                                                                                                                                | Every presentation and playlist passes the domain schema; boxes, sizes, opacity, colours finite and clamped (`sanitize.ts`); playlist items reference imported presentations and media                                                                                |
| `extractPptxText`                                                                        | `packages/importers/src/pptx.fuzz.test.ts`       | Random bytes, random slide XML, mutated real slide XML, archives missing parts, zero/negative slide sizes, entity expansion, 20,000-deep groups; a 205 KB file with a 200 MB text node, a header that understates its size, more than 64 MB of XML, 5,001 shapes, a run flood (`pptx.limits.test.ts`, in a 96 to 128 MB heap) | Random bytes are rejected (asserted); otherwise resolves with finite boxes within ±2× the canvas and bounded font sizes, or rejects with an `Error` (never a `RangeError`); ≤ 2,000 slides; parts over 8 MB refused before or while inflating, in well under a second |
| `extractZip` (streaming zip reader)                                                      | `packages/importers/src/zip-stream.fuzz.test.ts` | Random bytes, hand-built archives with traversal names, truncation, bit flips, zip64 records and extra fields with sizes up to 2^64                                                                                                                                                                                           | Random bytes are rejected (asserted); otherwise extracts or rejects with an `Error` naming the problem (never a bare abort); paths never escape; no single allocation larger than the file (or the 64 KB tail); deflate bombs rejected                                |
| `fillCache`                                                                              | `packages/cache/src/fill.fuzz.test.ts`           | Flaky fetcher (failures, delays, non-Blob results), store throwing on `has`/`put`, NaN sizes, zero/NaN concurrency                                                                                                                                                                                                            | Always settles; every unique file ends in `ready` or `failed` exactly once; concurrency respected; attempts ≤ retries + 1; progress monotonic                                                                                                                         |
| `parseMidi`, `matchMidi`, `learnFrom`                                                    | `packages/surfaces/src/surfaces.fuzz.test.ts`    | Random byte strings, loose stored mappings                                                                                                                                                                                                                                                                                    | Channel 1..16, numbers ≤ 127, only mapped actions; a CC fires exactly once per upward threshold crossing                                                                                                                                                              |
| `normalizeCombo`, `isModifierOnly`                                                       | (same file)                                      | Random `code`/`key` (missing, empty, `+`, binary)                                                                                                                                                                                                                                                                             | Non-empty, bounded, deterministic combo whose last part is non-empty                                                                                                                                                                                                  |
| Stream Deck pages from stored JSON (`sanitizeDeckPages`, `keyFace`, `resolvePageTarget`) | (same file)                                      | Arbitrary JSON                                                                                                                                                                                                                                                                                                                | Well-formed pages; faces and page navigation never throw; page index in range                                                                                                                                                                                         |
| Audio maths (`sourceGain`, `masterGain`, `planRoute`, `meterBallistics`)                 | `packages/audio/src/math.fuzz.test.ts`           | NaN/∞ dB, LUFS, channel pairs, samples, timings                                                                                                                                                                                                                                                                               | Gains finite and ≥ 0, routes inside the device, meters in 0..1                                                                                                                                                                                                        |

Defects found and fixed by these suites (each with a regression test): a `Chorus x99999999` label pushing
99,999,999 entries into the arrangement (hang); quadratic regex backtracking on long whitespace runs in the
lyric parser (`/\s+$/`, the directive regex), the RTF reader and the PPTX text join; unbounded titles,
lines and section numbers; NaN/∞ tempo; negative or huge `\uc` and sign-only `\fs-` in RTF (text taken
from the wrong place, NaN sizes); RTF colours out of range and lone surrogates; NaN/∞ geometry, opacity,
sizes and durations from ProPresenter doubles; unbounded media path suffix search; uncaught playlist
errors; zero slide size and runaway group scale in PPTX; a zip64 extra field shorter than the fields it
replaces (`RangeError`); `fillCache` rejecting when the store throws on lookup and doing nothing with zero
concurrency; colour helpers producing `NaN` / `#NaNNaNNaN`; split surrogate pairs in cue labels; loop
slides with NaN or zero durations; `normalizeCombo` throwing without `code`/`key` and producing `Ctrl++`;
stored Stream Deck pages without `keys` (crash) and stale page indices; meters stuck at `NaN`. From the
2026-11-04 review: a 205 KB PowerPoint inflating a 200 MB text node (84 s to an out-of-memory), 300,000
shapes on a slide, 100 MB of RTF `\par` costing 618 MB, and the zip reader reporting its own errors as
"The operation was aborted".

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

`pnpm --filter @ordo/renderer golden:compositor` is the compositor golden (design/27 §14.5). It has
no expected images: in a worker in headless Chromium (WebGPU on SwiftShader, the flags above), two
real render engines draw the same layer stacks, one with the WebGPU compositor and one with Canvas
2D, and a CPU reference composes them with `planeSample` (`packages/renderer/src/scene.ts`). Cases
cover scene stacks (a video in its box with masks, crops, rotation, flips and an over), crossfade
midpoints of every source pair, a stale slot generation and a slot without a frame (both must show
the poster, never black), and the legacy bitmap and video paths. WebGPU must match Canvas 2D within
40 per channel on all but 0.4 % of the pixels and the reference within 8 on all but 0.05 %.
Failing cases write their three images to `test-results/compositor-golden/` (`--images` writes
every case).

## CI

GitHub Actions on every pull request and merge to main (and by hand): `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm e2e` (SwiftShader, so the 100 ms timing bounds above), the golden images, Docker build. Tags build and push the image. Playwright traces are uploaded on failure.

## Test content

Fixtures are synthetic: generated lyrics, a 10 s test pattern video in each format, a
PPTX and a PDF with known text boxes, a minimal ProPresenter 7 file built from the proto
schema. No venue content in the repo.
