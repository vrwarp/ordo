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

## Fuzzing

Every parser of untrusted input has a fast-check property suite next to its unit tests (`*.fuzz.test.ts`,
part of `pnpm test`). The acceptance criterion is the one in design/25: never throws (or, for archives and
documents, rejects with an `Error`), finishes in linear time, and returns output within bounds; round trips
where they exist. Each defect a fuzzer found has a named regression test in the same file.

| Parser                                                                                   | File                                             | Inputs                                                                                                                                                                         | Properties                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseLyrics`, `parseSectionLabel`, `songFromParsed`                                     | `packages/domain/src/lyrics.fuzz.test.ts`        | Structured lines (labels, repeat markers, ChordPro directives, chords, CCLI footers), arbitrary UTF-16 incl. lone surrogates, control chars, CRLF/CR, BOM                      | Sections non-empty with trimmed bounded lines; labels unique and ≤ 40 chars; order references existing sections; metadata ≤ 300 chars; tempo finite; label → normal form round-trips; the built presentation expands to dense cues |
| ChordPro directives                                                                      | (same file)                                      | `{name}` / `{name: value}` for every known and unknown directive                                                                                                               | As above; long whitespace runs stay linear                                                                                                                                                                                         |
| `expandCues`, `arrangedSections`, `sectionsOfItem`                                       | `packages/domain/src/cues.fuzz.test.ts`          | Random playlists referencing missing presentations, sections, arrangements and media; NaN/negative loop durations                                                              | Cue indices dense and ordered; every slide cue resolves to its slide; labels ≤ 80 chars and well-formed UTF-16; loop delays in [0.5 s, 1 h]                                                                                        |
| `hexToRgba`, `rgbaHex`, `rgbaCss`, `nearColor`                                           | (same file)                                      | Any string, NaN/infinite channels                                                                                                                                              | Channels integers 0..255, alpha 0..1, `#rrggbb` round trip, valid CSS                                                                                                                                                              |
| `parseSongFile`                                                                          | `packages/importers/src/songselect.fuzz.test.ts` | Arbitrary text, BOM + CRLF, UTF-16 decoded as Latin-1                                                                                                                          | Passes the `Presentation` schema; arrangements reference existing sections                                                                                                                                                         |
| `parseRtf`, `splitFontName`                                                              | `packages/importers/src/rtf.fuzz.test.ts`        | Random bytes, RTF token soup, mutations of real ProPresenter (Cocoa) RTF                                                                                                       | Size in (0, 1000] pt, colours 0..255, stroke bounded, font name ≤ 200, no lone surrogates, linear on whitespace                                                                                                                    |
| `importPro7`                                                                             | `packages/importers/src/pro7.fuzz.test.ts`       | Random bytes; protobuf messages built with the vendored schema from randomized fields (NaN/∞ doubles, huge strings, dangling UUIDs); bit flips; truncation; 2,000-deep nesting | Every presentation and playlist passes the domain schema; boxes, sizes, opacity, colours finite and clamped (`sanitize.ts`); playlist items reference imported presentations and media                                             |
| `extractPptxText`                                                                        | `packages/importers/src/pptx.fuzz.test.ts`       | Random bytes, random slide XML, mutated real slide XML, archives missing parts, zero/negative slide sizes, entity expansion, 20,000-deep groups                                | Resolves with finite boxes within ±2× the canvas and bounded font sizes, or rejects with an `Error` (never a `RangeError`); ≤ 2,000 slides                                                                                         |
| `extractZip` (streaming zip reader)                                                      | `packages/importers/src/zip-stream.fuzz.test.ts` | Random bytes, hand-built archives with traversal names, truncation, bit flips, zip64 records and extra fields with sizes up to 2^64                                            | Extracts or rejects with an `Error`; paths never escape; no single allocation larger than the file (or the 64 KB tail); deflate bombs rejected                                                                                     |
| `fillCache`                                                                              | `packages/cache/src/fill.fuzz.test.ts`           | Flaky fetcher (failures, delays, non-Blob results), store throwing on `has`/`put`, NaN sizes, zero/NaN concurrency                                                             | Always settles; every unique file ends in `ready` or `failed` exactly once; concurrency respected; attempts ≤ retries + 1; progress monotonic                                                                                      |
| `parseMidi`, `matchMidi`, `learnFrom`                                                    | `packages/surfaces/src/surfaces.fuzz.test.ts`    | Random byte strings, loose stored mappings                                                                                                                                     | Channel 1..16, numbers ≤ 127, only mapped actions; a CC fires exactly once per upward threshold crossing                                                                                                                           |
| `normalizeCombo`, `isModifierOnly`                                                       | (same file)                                      | Random `code`/`key` (missing, empty, `+`, binary)                                                                                                                              | Non-empty, bounded, deterministic combo whose last part is non-empty                                                                                                                                                               |
| Stream Deck pages from stored JSON (`sanitizeDeckPages`, `keyFace`, `resolvePageTarget`) | (same file)                                      | Arbitrary JSON                                                                                                                                                                 | Well-formed pages; faces and page navigation never throw; page index in range                                                                                                                                                      |
| Audio maths (`sourceGain`, `masterGain`, `planRoute`, `meterBallistics`)                 | `packages/audio/src/math.fuzz.test.ts`           | NaN/∞ dB, LUFS, channel pairs, samples, timings                                                                                                                                | Gains finite and ≥ 0, routes inside the device, meters in 0..1                                                                                                                                                                     |

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
stored Stream Deck pages without `keys` (crash) and stale page indices; meters stuck at `NaN`.

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
