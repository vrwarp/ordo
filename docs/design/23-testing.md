# Design 23: Testing and verification

## Layers

| Layer       | Tool                                                                                              | Scope                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | Vitest                                                                                            | `packages/domain` (parsers, arrangement expansion, layout maths), `packages/live-state` (reducer determinism, property tests with fast-check), `packages/protocol` (schema round-trips), `packages/importers` (fixtures), hub services with an in-memory SQLite                                                                      |
| Integration | Vitest + a real hub                                                                               | HTTP API with auth and roles, WebSocket sequencing, media jobs with tiny fixture files: `apps/hub/test` starts the hub in the test process on an ephemeral `127.0.0.1` port with a temporary data directory; `processes.test.ts` runs the real two-process hub (supervisor, live and library children) from source                   |
| End to end  | Playwright, headless Chromium with SwiftShader (`--use-angle=swiftshader --enable-unsafe-webgpu`) | Operator, two outputs and the stage on their own origins served by a real hub over HTTP (below); GO and flip timing, clears, looks, degraded mode, relaunch, and the chaos specs                                                                                                                                                     |
| Soak        | `tools/soak` (Playwright, real GPU on the venue PC or a dev machine)                              | 60+ minutes of the live playlist with motion backgrounds, GO every 10 s; asserts zero missed frames and zero long tasks from telemetry                                                                                                                                                                                               |
| Visual      | Playwright screenshots of outputs vs golden PNGs                                                  | Text rasterizer and looks; per-pixel tolerance for anti-aliasing                                                                                                                                                                                                                                                                     |
| Fidelity    | `tools/pro7-fidelity` (Playwright, headless Chromium `@ordo/renderer`)                            | ProPresenter 7 visual fidelity: scores imported `.pro` slides against reference PNGs using dual-plate RGBA SSIM (`--export-compat`), generates diagnostic strips and clusters, and enforces CI non-regression ratchet against baseline; the golden-pptx census ratchet holds every public deck's slide classes (`census-ratchet.ts`) |

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
  own ports, with data under `ORDO_E2E_DATA_ROOT` or `test-results/.e2e-data-<port>` and the hub's log lines in
  `test-results/hub-<port>.log` (appended across the spec's restarts, so CI's uploaded test-results carry
  them; `ORDO_E2E_HUB_STDOUT=1` prints them instead); `ORDO_E2E_HUB_CMD` runs the hub from source instead of
  the build. `ORDO_CHAOS_OUTPUT_PORT` and `ORDO_CHAOS_OPERATOR_PORT`
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

Wall-clock bounds in unit tests (a parser, a layout or an import "within 5 s" on hostile input) show that the
work stays linear and never runs away; they are not performance budgets. A bound is written as the budget
on a developer machine through `budgetMs` (`packages/domain/src/timing.test-util.ts`): three times that on
CI (`CI` set), whose 2-core runner is about three times slower for CPU-bound work, or the factor in
`ORDO_TEST_TIME_SCALE` on a machine shared with other jobs. Bounds that test the product's own timeouts (a
library that did not answer within its wait, a socket closed within its grace) are not scaled. Frame and
task budgets (design/27 §13: a 50 ms asset-worker task) are gated by the benches, on a known machine, not
by vitest: `bench:slides --check` for slide rasters and `bench:tables` for the table object's prepare
slices and draw (median of five runs under 50 ms); the vitest side of those (`table.browser.test.ts`)
bounds only a runaway at ten times the task. The raster bench (`bench --check`) makes each case's geometry
units before its jobs, as the asset worker's prepare step does, each slice a task of its own, and prints a
`units <width>` row under the case (units made, MiB, the time to make them all, the longest slice): every slice
is held to the 50 ms task, and the line-art case (`line art past the slide budget (units)`, `bench/cases/units.ts`)
to 16 ms at 3840; its slide's draw is reported, not checked (what it draws live is the drawing budget's, whose
estimate rates hole-dense line art at about half its time: design/27 §13 "Geometry units"). On the bench machine
its unit (17.4 MiB at 3840) is made in 73 to 78 ms over 6 slices, the longest 15.3 to 15.4 ms, and the slide
draws in 65 to 66 ms (p95) at 3840. The cold arm of a slide with units, the wait of a jump to it until effect
units, is the fidelity harness's `coldMs` (its pictures, its geometry units and the first draw,
`tools/pptx-fidelity/README.md`): the leaf template's first slide is held to 500 ms at 3840 (245 ms, the median
of five runs under the bench lock).

`e2e/slide-media.spec.ts` covers video and sound playing in place in a slide (design/27 §14.12) on two
outputs: Audience 1 on WebGPU (`?renderer=webgpu`) and the audio master, Audience 2 on Canvas 2D. It probes
the pixels of a turned, rounded clip box under a title band (clip inside the mask, backdrop outside it, the
title over the clip, the clip moving), asserts the slide flip and the clip's start skew between the outputs
with the bounds above, checks that the next slide's clip is preloaded paused on both, that after Clear
media a clip loaded into the cleared slot never shows in the live slide (its poster does), click start with
F8 and Shift+F8 pressed in the operator, onEnd 'advance', a slide sound over 3 shown slides of a 4-slide
loop, music that does not restart when its loop wraps, a clip still transcoding at Go live and a clip
whose processing failed (degraded notes, posters).

`e2e/pptx-native.spec.ts` and `e2e/pptx-media.spec.ts` cover PowerPoint decks imported as editable
slides (design/27 §14.12), each on a hub of its own with the bundled fonts (`ORDO_FONTS_DIR`). The decks
are synthetic probes written by `e2e/pptxdecks.ts` (pptxgenjs, and crafted OOXML with `p:timing` and
ffmpeg test clips), sent through `POST /import/document`. `pptx-native` draws the deck with the fidelity
harness's native page (`tools/pptx-fidelity` `convertDeck` and `NativeRenderer`), given the outputs' own
font files (`outputFaces`: their config's library fonts, so both sides draw with the same files whatever
the machine's fontconfig would pick), and asks three slides captured from Audience 1 at 1920x1080 (WebGPU)
and Audience 2 at 3840x2160 (Canvas 2D) for SSIM ≥ 0.99 against it, without the outputs' "Enter full
screen" prompt (`capture` hides `.fs-prompt`; a test window is never full screen). The verse slide has a
floor of its own, 0.96 (`CUE1_FLOOR`): on the CI runner the outputs draw its text about 0.4 % narrower than
the harness (a size or advance difference, glyph shapes identical; 1.000 in the dev container), and the
spec logs each text line's width on both sides until it is gone; it checks the stage text, the Lobby and Stream bands against the same text typed in ordo
(set as the deck sets it, its verse numbers raised, so both bands go through the rich engine; and against
the text without its verse numbers, which must differ), cue labels, library search, and the
hidden slide (Next and Prev skip it, a double-click in the grid shows it). `pptx-media` plays the M5 exit
with PowerPoint decks: a boxed autoplay clip turned, cropped and rounded under a title, a click-start clip
(F8, Shift+F8, onEnd 'advance' set in ordo, the stage's remaining time), a muted motion background, a
`numSld=3` sound across a hidden slide, a clip that is not a video (`[warn]`, poster), a clip whose
processing fails (degraded note, poster, and the operator's banner giving that reason rather than an
empty slide), a looping clip trimmed by `p14:trim`, and a looping
announcement deck whose music does not restart on the wrap. `e2e/pptx-import-tab.spec.ts` runs the path
operators take (design/27 §2 "Where the deck is parsed"): a deck with a table, a picture and a clip dropped on
the Import tab in Editable mode is parsed in the import worker and built by the hub from its scene, equal to
the hub's own parse of the same deck; while a playlist is live the browser does not parse. The Pages demo's
spec imports a public golden deck the same way, without LibreOffice.

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
| `degraded.spec.ts`            | The hub, during a service                                                                                                                                                                                                                                                           | The operator runs the service from the PC, the outputs follow over the fallback bus, and the hub adopts the operator's state when it returns; one GO pressed as soon as the hub has the service back moves the hub and both outputs exactly one cue (pressed once, never retried; a lost or doubled GO fails)                                                            |

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
| `BoundedZip`, `parsePptxScene` (the browser's reader and parse)                          | `packages/importers/src/zip-bounded.test.ts`     | Mutated archives, hand-built zips that understate a part's size (a 64 MB bomb declared 1 KB), overlapping entries, traversal names, encrypted entries, a directory claiming 65,534 entries, 9 parts of 7.5 MB; mutated bytes of a public deck                                                                                 | Never throws anything but an `Error`; a bomb stops after its first inflated chunk, with bounded memory; overlapping entries and XML past 64 MB refused; a parse ends with a scene or an `Error`                                                                       |
| `checkClientScene` (the hub's check of a browser's scene)                                | `apps/hub/test/pptx-client-scene.test.ts`        | A real scene with up to four fields replaced by hostile values (null, `__proto__`, 700-character strings, NaN, 1e308, nested junk); part names past 512 characters; a listing out of order; duplicate slides; forged shape files                                                                                              | Never throws; a scene or a refusal; part names past the bound refused before any payload; a forged shape file dropped                                                                                                                                                 |
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
main slide, lyric slides on every look, lower third, stream key, props, image fits, and the
rich text cases of design/27 §14 item 4 in `golden/rich-cases.ts`) through the output
rasterizer on an `OffscreenCanvas`, and compares each to `golden/expected/<case>.png`: a
pixel differs when any channel is more than 40 apart, and a case fails when more than 0.4 %
of its pixels differ. The legacy cases are drawn a second time with the font resolver
installed (design/27 §10) against the same images, and the line-break invariance check
draws every rich case at 320, 960, 1920 and 3840 px wide and fails unless the drawn strings,
logical positions and fonts are identical. A case can be compared with another case's PNG (`SAME_AS` in `golden/page.ts`):
the same slide drawn by another drawer must look the same. `image-shape` (pictures masked and mirrored)
and `edited-slide` (a slide as the M4 editor leaves an imported church slide, rich text and pictures) are
drawn as the thumbnail worker draws them, as the outputs do with prepared pictures (`-prepared`,
`-output`) and as the editor's canvas does (`-editor`: Konva node transforms and the cached text rasters).

Text uses faces injected from the system so the result does not depend on installed fonts:
DejaVu Sans ('Golden': Latin, Hebrew, Arabic), FreeSerif ('Golden Serif': Tamil) and
IPAGothic ('Golden CJK'). `expected/meta.json` lists the files (path and SHA-256) the
expected images were made with, and a comparison loads exactly those, so another font on
the machine cannot change the faces (the rasteriser's hinting still can). When one is missing the
run is skipped; in CI (`CI` set, or `--strict`) a skip, or a case without an expected image, fails
the run. `--update` rewrites the expected images; a failing case writes `<case>.actual.png` next to
the expected one (git ignores it).

The expected images belong to one pinned image, `mcr.microsoft.com/playwright:v1.63.0-noble` with the
repository's font packages: CI's "Goldens (pinned container)" job draws and compares them there (with
`late-font` and `golden:compositor`), and no other run is authoritative. Text drawn elsewhere differs in
hinting and anti-aliasing with an identical layout (a local run of main fails 28 cases by up to 8 % of
their pixels), so expected images are never made on a developer machine. Every failing case, and every
case without an expected image, is also written to `test-results/golden/`: `<case>.actual.png`,
`<case>.expected.png` and `<case>.diff.png` (red where a pixel is past the tolerance); a case compared
with another case's image writes `<case>.against-<other>.png`, a legacy case drawn with the font resolver
`<case>.resolver.png`. CI uploads that directory as the artifact `golden-images` when the job fails. An
intended change, or a new case, is adopted from it:

```
gh run download <run-id> --name golden-images --dir /tmp/golden-images
tools/golden-from-artifact.sh /tmp/golden-images [case ...]   # <case>.actual.png -> expected/<case>.png
```

The same run on a developer machine, in the same container (Docker; the working tree is copied in, so
uncommitted changes count; the pictures land in `./test-results/golden`):

```
tools/golden-docker.sh                      # golden --strict, late-font, golden:compositor
tools/golden-docker.sh golden               # one step
tools/golden-from-artifact.sh test-results  # adopt what it drew
```

It runs, in `mcr.microsoft.com/playwright:v1.63.0-noble` with `CI=true`, `apt-get install` of the font
list of `ci.yml`'s goldens job, `pnpm install --frozen-lockfile`, then `pnpm --filter @ordo/renderer
golden --strict` and the other two steps.

`pnpm --filter @ordo/renderer golden:compositor` is the compositor golden (design/27 §14.5). It has
no expected images: in a worker in headless Chromium (WebGPU on SwiftShader, the flags above), two
real render engines draw the same layer stacks, one with the WebGPU compositor and one with Canvas
2D, and a CPU reference composes them with `planeSample` (`packages/renderer/src/scene.ts`). Cases
cover scene stacks (a video in its box with masks, crops, rotation, flips and an over), crossfade
midpoints of every source pair, a stale slot generation and a slot without a frame (both must show
the poster, never black), the legacy bitmap and video paths, and since M7 tight sprites at their
offsets, crossfades between a full-frame and a tight layer, scenes with a tight base and over,
opaque layers (the replace pipeline, a layer that hides everything under it), and strip uploads:
with a budget of 24 rows a frame, every frame while new content uploads must be the previous
picture whole and the flip must wait for the last strip. WebGPU must match Canvas 2D within
40 per channel on all but 0.4 % of the pixels and the reference within 8 on all but 0.05 %.
Failing cases write their three images to `test-results/compositor-golden/` (`--images` writes
every case), which the `golden-images` artifact carries too. `sprite.browser.test.ts` (vitest, headless Chromium) draws bands, rich and legacy
text, shapes, the lower third, props and scene parts as tight sprites and full-frame and requires
each sprite placed at its offset to be the full-frame picture.

## ProPresenter 7 visual fidelity

`tools/pro7-fidelity` (`@ordo/pro7-fidelity`) evaluates visual import fidelity between ProPresenter 7
and Ordo. A headless Chromium harness bundles `@ordo/renderer` via esbuild and scores imported `.pro`
slides against reference PNGs using dual-plate RGBA SSIM (a white plate and a black plate to isolate RGB
colour differences from alpha transparency; slides with opaque backgrounds score against a single plate).
With `--export-compat`, each cue's background is isolated to match ProPresenter's slide-for-slide bundle
exports without altering live background continuation.

The harness produces:
- Diagnostic artifacts under `--out <dir>`: a Markdown summary (`report.md`) with deck breakdowns and
  overall mean SSIM, a machine-readable summary (`summary.json`), and 4-panel diagnostic comparison
  strips (reference PNG, Ordo render, SSIM heatmap, and diff mask) for the lowest-scoring slides under
  `worst/`.
- Feature-loss clustering grouping slides by root causes (e.g. background fill, strap line masks,
  custom shape geometry, crop, or text styling).
- Monotonic non-regression ratcheting against `tools/pro7-fidelity/pro7-baseline.json` via `--baseline`
  and `--ratchet` (failing the run if any deck drops by more than 0.2 % or any slide drops by more
  than 0.5 %, and, since PR #23, if a baseline deck or slide the run was meant to score is missing from it:
  a deck that stops importing or rendering used to pass silently; a run is meant to score the baseline's
  decks of the kinds it ran, `--corpus` synthetic and `--sample-dir` sample, within its `--decks` and
  `--slides` filters). A 19-slide synthetic probe suite (`--corpus`) across 5 decks covers core fills and
  gradients, preset and custom cubic bezier shapes, 315° gradients, media crops and ellipse image masks
  (`pro7-synth-core`, `pro7-synth-shapes`, `pro7-synth-masks-and-crops`), text boxes with a fill and with a
  border and full-width line masks in a colour and a gradient (`pro7-synth-text-and-masks`), and rounded
  pictures, picture shadows, feathers and the three together, and a feathered full-frame photo under a
  shadowed, feathered one, both kept within the slide's effect budget (`pro7-synth-picture-effects`,
  `corpus-effects.ts`; 0.9987, and 0.9198 with a prepared picture's soft edge weighed as a shape's): 12 of the
  22 feature tags. It is enforced in CI on every run. The suite is
  font-free: text is drawn in the colour of the box or strap behind it (or is one dot), and a line mask is
  made taller than the slide, so only box and strap geometry count whatever face fontconfig picks. Its
  references are computed from ordo's own drawing conventions (a stroke centred on the outline, a strap
  the box width plus its offsets, LibreOffice's shadow σ = blur/√6 and eroded, blurred soft edge), so it
  is a regression check of the importer and the renderer, not a measure of agreement with ProPresenter;
  that is the sample run's job. Local evaluation can additionally run against real exported
  `.proPlaylist` bundles via `--sample-dir <dir>`.

## The golden-pptx census ratchet

`pnpm --filter @ordo/pptx-fidelity census:ratchet` (`tools/pptx-fidelity/src/census-ratchet.ts`) runs the
census (`census.ts`) over the committed public corpus `golden-pptx/` (112 decks, 1,071 shown slides; about
15 s here, under a minute on CI) and compares each shown slide's class, its class in the hub and its reasons
with `tools/pptx-fidelity/golden-census-baseline.json`. A slide whose class gets worse (native < hybrid <
picture), natively or in the hub, a shown slide that is gone, and a deck that is missing or no longer reads
fail the run; better classes, other reasons on the same class and new decks or slides are reported, and a PR
that improves a class records it (`-- --write`) so it cannot slip back. It needs no LibreOffice and no
browser.

## CI

GitHub Actions on every pull request and merge to main (and by hand), `.github/workflows/ci.yml`, in four
jobs that run side by side so none takes more than about 35 minutes (one job took 30 to 45 minutes before):

| Job                            | Runs                                                                                                                                                                                                           | Limit  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Lint, types, unit tests, build | `pnpm lint`, `pnpm typecheck` (tests, specs and tools included), `pnpm test` (`CI` set: timing bounds ×3, golden runs strict), `pnpm build`, `pnpm build:pages`, `pnpm audit` (advisory)                       | 25 min |
| End-to-end (2 shards)          | `pnpm build`, `build:pages`, Playwright Chromium and WebKit, `pnpm e2e --shard=<n>/2` with `ORDO_CI=1` (retries 1, SwiftShader, so the 100 ms timing bounds above); uploads `playwright-report-<n>` on failure | 35 min |
| Goldens (pinned container)     | in `mcr.microsoft.com/playwright:v1.63.0-noble` with the font list: `golden --strict`, `late-font`, `golden:compositor`; uploads `golden-images` on failure ("Golden images" above)                            | 20 min |
| Fidelity ratchets              | the ProPresenter 7 synthetic ratchet and the golden-pptx census ratchet; uploads their results on failure                                                                                                      | 20 min |

The end-to-end, goldens and fidelity jobs install the image's font packages (Carlito, Caladea, Liberation 2,
Noto core, Inter) next to ffmpeg, poppler and LibreOffice Impress where they need them; the goldens and
fidelity jobs add the golden faces (DejaVu, FreeSerif, IPAGothic). Docker images are built by
`docker-pr.yml` and published by `docker-publish.yml`; tags build and push the image. Not run in CI: the
benches (`bench:*`, whose 50 ms and frame gates need a known machine) and the PowerPoint fidelity harness
against LibreOffice (design/27 §14 item 2).

## Test content

Fixtures are synthetic: generated lyrics, a 10 s test pattern video in each format, a
PPTX and a PDF with known text boxes, a minimal ProPresenter 7 file built from the proto
schema. No venue content in the repo, with one deliberate exception: `golden-pptx/`, a corpus of 112
public decks (church sermons, worship lyrics, announcements and file-format test decks) downloaded from
the web with their sources and a takedown notice in its README, used by the census ratchet. Private
decks a venue shares for testing never enter the repository.
