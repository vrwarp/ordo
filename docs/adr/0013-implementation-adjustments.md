# ADR 0013: Adjustments made while implementing the prototype

Status: Accepted. Amends the design documents where they differ; each item names the document it amends.

## Every host serves the API (design/10, design/12, design/21)

`/api/v1/*` and `/ws` are served on every role host (`op`, `outN`, `stage`, `hub`, and plain `localhost`), so
each app calls its own origin. No CORS, and the session cookie is host-only on the operator origin. Output and
stage windows authenticate with their token (`x-ordo-token` header or `?token=`). The `hub.<domain>` name is
kept only as an alias.

## Output health is not reducer state (design/11, design/13)

`output.register`, `output.health` and `output.armed` were dropped from the live reducer. Health travels as
`health` messages once per second and the hub aggregates it into `health.summary`. The journal stays small, and
sequence numbers count only real live changes.

## Local multi-origin development (design/23, design/24)

Chrome resolves `*.localhost` to loopback and treats it as a secure context. With `ORDO_DOMAIN=localhost`,
`http://op.localhost:8080` and `http://out1.localhost:8080` are real separate origins, as at the venue. The
end-to-end tests use this, so they exercise process isolation and the postMessage fallback bus.

## Fullscreen popups (design/15)

Outputs are opened with `window.open(url, name, 'popup,fullscreen,left,top,width,height')`, Chrome's fullscreen
popup, which works with the Window Management permission. `getScreenDetails()` is abandoned after 4 s while a
permission prompt is pending, and outputs open on the current screen instead. Re-acquiring windows after an
operator reload happens only when this browser session launched outputs before, and never in the same gesture
as Launch or Relaunch, because that raced the launch and lost the windows.

## One full-frame bitmap per slide layer (design/14)

The asset worker rasterizes the whole slide layer of a cue, under a given look, into one output-resolution
bitmap with the shared `text2d.ts` code. The render worker composites five layers of pre-built textures. This
keeps the GPU side trivial and makes lyric-only, stage and stream looks the same code path.

## Canvas 2D compositor as a safety net (ADR 0001)

WebGPU stays the primary path. If no adapter is available, the adapter is a software fallback
(`isFallbackAdapter`, SwiftShader), or the device is lost three times within a minute, the render worker
switches to a Canvas 2D compositor that draws the same bitmaps. Every switch is drawn on a fresh canvas, since a
canvas keeps its first context kind. After a fallback WebGPU is tried again on a slow timer (60 s, doubling to
15 min), except after three losses, which keep Canvas 2D for the session. The output keeps showing correct
content and reports the compositor in health. This does not replace verifying WebGPU on the venue PC: the venue
measurement (`pnpm --filter @ordo/renderer bench:venue`, design/14 "Measuring on venue machines") records the
adapter Chrome gives the output and whether it is a software one.

## Service worker caching (design/17)

Navigations are network-first with a 4 s timeout and fall back to the cached shell. Assets are cache-first. A
pure cache-first `index.html` would never pick up a new deploy.

## ProPresenter 7 schema (ADR 0012)

The community proto definitions (greyshirtguy/ProPresenter7-Proto, pinned commit recorded in
`packages/importers/proto/`) are vendored as a generated JSON descriptor, so the bundled hub needs no `.proto`
files at runtime. ProPresenter playlists reference documents by path, and the importer matches them by path,
suffix and name.

## Audio channel numbering (design/18)

Pairs store 0-based channel indices. The settings UI shows them 1-based. Device ids differ per origin in
Chrome, so the house and preview device labels are stored with the ids, and the output window matches by label.

## Performance budgets in health (design/14, design/27 §13)

Health carries the output's measured costs (`rasterMs` p50/p95 of slide draws, `uploadMs`, `gpuMB`), the
budgets for its size (`budgets`) and the budgets passed (`alarms`), and the characters it drew that no face it
has covers (`fontCoverage`). The output computes budgets and alarms itself, because only it knows its size; the
hub stores what it receives and the operator only reads it. Alarm names are plain strings in the protocol, not
an enum, so an alarm a newer output adds never makes an older hub reject the whole report. The operator words
each issue twice: a label for the volunteer at the desk, without figures, and a detail with the figures for
the tech (`apps/operator/src/lib/health.ts`).
