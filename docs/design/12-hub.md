# Design 12: Hub

`apps/hub`: Node 22, TypeScript, Fastify for HTTP, `ws` for WebSocket, better-sqlite3 in
WAL mode, a job queue for media work, all in one container behind DSM's reverse proxy.

## Responsibilities

1. Serve the four browser apps as static files, with per-origin routing by `Host`.
2. Library CRUD with revisions and search deltas.
3. Live state: run the shared reducer, journal events, broadcast deltas, hold the clock.
4. Media pipeline: ingest, hash, transcode, poster, loudness, PPTX and PDF rendering, Google Fonts fetch.
5. Service cache manifests.
6. Auth: PIN sessions, output tokens, rate limiting.
7. Backups and restore.
8. Health, logs, diagnostics export.

## HTTP API

All under `https://hub.<venue>.synology.me/api/v1`. JSON bodies validated with the
`packages/domain` schemas. Errors are `{ error: { code, message } }`.

| Method and path                                                                                                        | Role                                                 | Purpose                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /auth/pin`                                                                                                       | none                                                 | Exchange a PIN for a session cookie; returns the role                                                |
| `POST /auth/logout`                                                                                                    | any                                                  | End session                                                                                          |
| `GET /library/snapshot?since=<seq>`                                                                                    | edit, operate                                        | Full snapshot or deltas of presentations, playlists, media, fonts, themes, looks, outputs            |
| `GET                                                                                                                   | POST                                                 | PUT                                                                                                  | DELETE /presentations[/:id]` | edit | CRUD; PUT requires `rev` and returns 409 on mismatch |
| `GET /presentations/:id/revisions`, `POST /presentations/:id/restore/:rev`                                             | edit                                                 | Version history                                                                                      |
| `GET                                                                                                                   | POST                                                 | PUT                                                                                                  | DELETE /playlists[/:id]`     | edit | CRUD; live playlist returns 423 Locked on PUT        |
| `POST /media` (multipart, resumable via `Upload-Offset`)                                                               | edit                                                 | Upload; returns media in `uploaded` state                                                            |
| `GET /media/:id`, `PUT /media/:id`, `DELETE /media/:id`                                                                | edit                                                 | Metadata                                                                                             |
| `GET /files/:hash`                                                                                                     | output token or any role                             | Content-addressed file delivery with long cache headers and range support                            |
| `POST /fonts/upload`, `POST /fonts/google { family }`, `GET /fonts`                                                    | edit                                                 | Fonts                                                                                                |
| `POST /import/pro7` (zip or NAS path), `POST /import/songselect` (file or text), `POST /import/document` (pptx or pdf) | edit                                                 | Import jobs; return a job id                                                                         |
| `GET /jobs/:id`                                                                                                        | edit                                                 | Job state and log                                                                                    |
| `GET                                                                                                                   | PUT /settings/{looks,outputs,audio,keymap,surfaces}` | operate                                                                                              | Settings                     |
| `POST /outputs/:id/token/rotate`                                                                                       | operate                                              | New output token                                                                                     |
| `GET /live`                                                                                                            | operate, output                                      | Current live state (full)                                                                            |
| `POST /live/events`                                                                                                    | operate                                              | Submit live events over HTTP (used by surfaces' HTTP bridge and tests); WebSocket is the normal path |
| `GET /cache/manifest`                                                                                                  | operate, output                                      | The live service cache manifest                                                                      |
| `GET /health`, `GET /diagnostics/export`                                                                               | operate                                              | Hub health; zip of logs, journal tail, settings                                                      |
| `POST /backup/run`, `GET /backup/list`                                                                                 | operate                                              | Backups                                                                                              |

## WebSocket

`wss://hub.<venue>.synology.me/ws`. Authenticated by the session cookie (operator,
stage) or `?token=` (outputs). Message schemas in `packages/protocol`
([design/13](13-protocol.md)). One socket per window.

Broadcast fan-out keeps per-socket queues; if an output's queue exceeds 100 messages the
hub sends a full `live.state` instead of deltas and resets the queue.

Command validation on the hub (`live.ts`):

- Event schemas are strict (unknown keys are rejected, not stripped) and bounded: `at` is a
  finite non-negative number, `cueIndex`/`sectionIndex` are small non-negative integers,
  `ttlMs` is at most a day.
- An operator `at` outside `[now − 500 ms, now + 2 s]` of the hub clock is replaced by
  `now + 33 ms` and logged: a bad clock-offset estimate must never seek a video or skew a
  timer.
- `media.ended` and `audio.ended` are believed only from the audio-master output
  (`outputs[].audioMaster`, exactly one, enforced by `PUT /settings/outputs`); other
  outputs and the stage display are rejected. With no master configured any output is
  believed.
- `preview` (prd/03 "Send to preview") is relayed from the operator to the one output named
  in `to`, with `from: "operator"` stamped, exactly like `rtc.signal`.

`GET /library/snapshot?since=<seq>` answers with `{ seq, since, changes[] }` from the
`library_changes` log (the last 20,000 seqs) when it still covers `since`; otherwise, and
when `since` is absent, with the full snapshot.

Shutdown (`SIGTERM`): stop the backup timer, abort jobs (their child processes get
`SIGKILL` through the abort signal), snapshot the live state, send `bye` on every socket
and terminate the sockets without waiting for a close handshake, close HTTP. Every step is
bounded, so the process exits within about 2 s even with a frozen client; `main.ts` keeps a
5 s backstop.

## Storage

SQLite file at `/data/ordo.db`, WAL mode, `synchronous=NORMAL`. Tables: `presentations`,
`presentation_revisions`, `playlists`, `media`, `files`, `fonts`, `themes`, `looks`,
`outputs`, `settings`, `sessions`, `auth_attempts`, `jobs`, `live_journal (seq, at,
event_json)`, `live_snapshot (singleton)`. Migrations with a simple numbered-SQL runner;
every migration is idempotent and tested.

Files under `/data/media/<hh>/<hash>.<ext>`, `/data/fonts/`, `/data/uploads/` (temporary),
`/data/backups/`.

## Media pipeline

A single in-process job queue (one video job at a time, two light jobs concurrently;
the NAS CPU is shared with other services). Jobs are persisted in `jobs` so a restart
resumes them.

| Job               | Tool                                                                                                                                                                           | Output                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `probe`           | `ffprobe`                                                                                                                                                                      | duration, dimensions, alpha, audio channels |
| `transcode-video` | `ffmpeg -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -g 60 -movflags +faststart -c:a aac -b:a 256k` scaled to fit 1920x1080, fps capped at 60                          | delivery MP4                                |
| `transcode-alpha` | `ffmpeg -c:v libvpx-vp9 -pix_fmt yuva420p`                                                                                                                                     | delivery WebM with alpha                    |
| `gif`             | ffmpeg: animated GIF to H.264 loop (opaque) or VP9 alpha (transparent); still GIF to PNG                                                                                       | delivery file                               |
| `poster`          | ffmpeg frame at 1 s, 640x360 JPEG                                                                                                                                              | poster                                      |
| `audio`           | ffmpeg loudnorm measurement, AAC 256k delivery                                                                                                                                 | delivery and LUFS                           |
| `pdf-render`      | `pdftoppm -r 144 -png` then scale to 1920x1080                                                                                                                                 | one PNG media per page                      |
| `pptx-render`     | `soffice --headless --convert-to pdf` then `pdf-render`                                                                                                                        | PNGs                                        |
| `pptx-text`       | unzip `ppt/slides/slideN.xml`, read `<a:t>` runs and `<a:off>/<a:ext>` in EMU, convert to logical px                                                                           | ExtractedText[] per slide                   |
| `pro7-import`     | `packages/importers` (protobuf decode) in a `worker_threads` worker; zip uploads are streamed from disk, media entries spilled to `tmp/`, documents capped at 256 MB in memory | presentations, playlists, media uploads     |
| `font-google`     | fetch the family's CSS from Google Fonts with a desktop UA, download referenced woff2 files, store as `Font` rows                                                              | fonts                                       |

The Docker image includes `ffmpeg`, `poppler-utils` and LibreOffice (`libreoffice-impress`
with a minimal font set plus the venue's uploaded fonts mounted so PPTX renders use them).

Import jobs are resumable: `pro7-import` records every media id, presentation id and
playlist id it wrote in its job payload and skips them when the job is re-queued after a
crash or restart; `document` records the stored page images the same way. ProPresenter
presentations and playlists are saved under their ProPresenter UUIDs, so importing the same
library twice updates the earlier copies instead of duplicating them. `POST /import/pro7`
and `POST /import/document` answer 423 while a playlist is live. `tmp/` is wiped at
startup: everything in it belongs to a job that is re-queued anyway.

## Service cache manifest

On `goLive`, the hub walks the resolved playlist: every presentation's media (backgrounds,
images), every media item's delivery and poster, every font referenced by any text style
or look, the logo, holding slides, and the look definitions. It writes
`{ seq, files: [{ hash, bytes, mime }], presentations: [...], looks: [...] }` and
announces it. The manifest is immutable for the live session.

## Auth

- PIN hashes with Argon2id. Sessions in SQLite with role, device fingerprint
  (user agent hash), expiry. Cookie `ordo_session`, `HttpOnly; Secure; SameSite=Lax;
  Domain=.<venue>.synology.me` so one login covers the operator and stage origins.
- Output tokens: 32 random bytes base64url, stored hashed, one per output, carried as
  `?token=` on the output URL and the WebSocket.
- Rate limiter keyed by forwarded client IP for `/auth/pin`.
- Role checks are route-level decorators; tests assert every route declares one.

## Backups

A nightly job at 03:00 venue time (`settings.general.timeZone`, the same zone countdowns
use; `ORDO_TZ` only seeds it on first run and stands in if it is unusable): `VACUUM INTO
/data/backups/ordo-<date>.db`, plus a `media-manifest-<date>.json` listing hashes and paths
(media files are already immutable and deduplicated, so the manifest plus the media
directory is the backup). The timer is armed strictly after the current run with a minimum
delay of a minute, and a run is skipped when today's file already exists (a restart after
03:00). Retention 30 days; the `ordo-pre-restore-*.db` copies that `restore` keeps are
capped at the newest three. `ordo-hub restore <date>` stops the service, swaps the
database, and verifies every manifest hash exists.

## Logging and diagnostics

Pino JSON logs to stdout (Docker captures). A ring buffer of the last 2,000 lines is
exported by `/diagnostics/export` together with the last 500 journal events, settings
without secrets, and the health table.

## Configuration

Environment variables: `ORDO_DOMAIN` (`<venue>.synology.me`), `ORDO_DATA=/data`,
`ORDO_TRUSTED_PROXY` (DSM's address), `ORDO_TZ`, `ORDO_PORT=8080`,
`ORDO_ALLOWED_HOSTS` (optional extra host names). First run with no PINs serves a setup
page on the operator origin that sets both PINs; the setup page is disabled once PINs
exist.

The hub answers only for hosts it knows: `ORDO_DOMAIN` and any label under it, `localhost`
and its labels, `127.0.0.1`/`::1`, and `ORDO_ALLOWED_HOSTS`; anything else gets `421` on
HTTP and on the WebSocket upgrade. Behind the trusted proxy the browser's host arrives in
`X-Forwarded-Host`, which the hub uses for the allow-list, app routing and the CSP
`connect-src`; from any other peer the header is ignored.
